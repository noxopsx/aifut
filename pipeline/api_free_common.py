"""
MOTOR-NOX · utilidades compartidas para APIs gratuitas de fútbol.

Propósito:
  · Resolver claves desde entorno o caché local privada, nunca desde código.
  · Cliente HTTP con caché en disco, backoff y límite de peticiones por minuto.
  · Ledger diario local para no exceder cuotas de planes gratuitos.
  · Publicar un estado de fuentes (source / quality / as_of) sin secretos.

La clave viaja sólo en la cabecera de cada petición. Nunca se escribe en
archivos generados, logs, manifiesto, datos de la UI ni mensajes de error.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .db import BASE_DIR, DATA_DIR, utc_now

JS_DATA_DIR = BASE_DIR / "js" / "data"
SOURCE_STATUS_PATH = DATA_DIR / "source_status.json"
SOURCES_JS_PATH = JS_DATA_DIR / "fuentes.js"

USER_AGENT = "MOTOR-NOX/1.0 (integracion de APIs publicas; uso informativo)"

_RATE_LIMIT_LOCK = threading.Lock()
_LAST_REQUEST_AT: dict[str, float] = {}


class ApiClientError(RuntimeError):
    """Error de API que nunca incluye la clave ni cabeceras."""


# ---------------------------------------------------------------------------
# Clave
# ---------------------------------------------------------------------------

def resolve_key(env_name: str, cache_path: Path) -> str:
    """Lee la clave del entorno o de la caché local privada. Nunca la imprime."""
    env_value = os.environ.get(env_name, "").strip()
    if env_value:
        return env_value
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        return str(payload.get("key", "")).strip()
    except (OSError, json.JSONDecodeError, AttributeError):
        return ""


def save_key(env_name: str, cache_path: Path, label: str) -> bool:
    """Persiste la clave de entorno en caché local con permisos restrictivos."""
    key = os.environ.get(env_name, "").strip()
    if not key:
        print(f"Error: define {env_name} antes de --save-key.", file=sys.stderr)
        return False
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps({"key": key, "saved_at": utc_now()}, ensure_ascii=False),
        encoding="utf-8",
    )
    try:
        cache_path.chmod(0o600)
    except OSError:
        pass  # Windows: mejor esfuerzo
    print(f"Clave de {label} guardada en caché local: {cache_path}")
    return True


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------

def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def today_key() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def norm_utc(value: Any) -> str | None:
    """Normaliza una fecha ISO a UTC `YYYY-MM-DDTHH:MM:SSZ`; null si no válida."""
    if not value:
        return None
    try:
        text = str(value).strip()
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_status(value: Any) -> str:
    """Mapea estados heterogéneos a scheduled/live/finished/postponed/cancelled."""
    text = str(value or "").upper().replace("-", "_").replace(" ", "_")
    if any(token in text for token in ("FINISH", "CLOSED", "COMPLETE", "RESULT", "FT", "AET")):
        return "finished"
    if any(token in text for token in ("LIVE", "IN_PLAY", "PLAYING", "HALF", "PAUSED", "1H", "2H", "HT", "ET")):
        return "live"
    if any(token in text for token in ("POSTPON", "RESCHEDUL")):
        return "postponed"
    if any(token in text for token in ("CANCEL", "ABD", "SUSPEND")):
        return "cancelled"
    return "scheduled"


# ---------------------------------------------------------------------------
# Cliente HTTP
# ---------------------------------------------------------------------------

class RateLimitedJsonClient:
    """Cliente JSON con caché, ledger diario y límite de peticiones por minuto."""

    def __init__(
        self,
        *,
        base_url: str,
        key: str,
        auth_header: str,
        cache_dir: Path,
        daily_limit: int | None = None,
        reserve: int = 0,
        min_interval: float = 6.2,
        dry_run: bool = False,
    ) -> None:
        if not key:
            raise ApiClientError("Sin clave API.")
        self.base_url = base_url.rstrip("/")
        self.key = key
        self.auth_header = auth_header
        self.cache_dir = cache_dir
        self.response_cache = cache_dir / "responses"
        self.usage_path = cache_dir / "usage.json"
        self.daily_limit = daily_limit
        self.reserve = reserve
        self.min_interval = min_interval
        self.dry_run = dry_run
        self.made_requests = 0
        self.remote_remaining: int | None = None
        self.remote_quota_remaining: int | None = None
        self.plan = "free"
        self.last_error: str | None = None

    def _cache_path(self, path: str, params: dict[str, Any]) -> Path:
        raw = path + "?" + urlencode(sorted((k, str(v)) for k, v in (params or {}).items()))
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
        safe = path.strip("/").replace("/", "_") or "root"
        return self.response_cache / f"{safe}_{digest}.json"

    def _local_used(self) -> int:
        data = read_json(self.usage_path, {})
        return int(data.get(today_key(), 0)) if isinstance(data, dict) else 0

    def _local_increment(self) -> None:
        if self.dry_run:
            return
        data = read_json(self.usage_path, {})
        if not isinstance(data, dict):
            data = {}
        data[today_key()] = int(data.get(today_key(), 0)) + 1
        for day in sorted(data)[:-7]:
            data.pop(day, None)
        write_json(self.usage_path, data)

    def _throttle(self) -> None:
        namespace = str(self.cache_dir)
        with _RATE_LIMIT_LOCK:
            now = time.monotonic()
            wait = _LAST_REQUEST_AT.get(namespace, 0.0) + self.min_interval - now
            if wait > 0:
                time.sleep(wait)
            _LAST_REQUEST_AT[namespace] = time.monotonic()

    def budget_summary(self) -> dict[str, Any]:
        used = self._local_used() + self.made_requests
        summary: dict[str, Any] = {
            "used": used,
            "limit": self.daily_limit,
            "reserve": self.reserve,
            "minIntervalSeconds": self.min_interval,
        }
        if self.remote_remaining is not None:
            summary["remoteRemaining"] = self.remote_remaining
        if self.remote_quota_remaining is not None:
            summary["remoteQuotaRemaining"] = self.remote_quota_remaining
        return summary

    def get(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        *,
        ttl: int = 0,
        count: bool = True,
    ) -> dict[str, Any]:
        """GET JSON. Devuelve dict; lanza ApiClientError sin exponer la clave."""
        params = params or {}
        cache_path = self._cache_path(path, params)
        if cache_path.exists() and (time.time() - cache_path.stat().st_mtime) < ttl:
            cached = read_json(cache_path, None)
            if isinstance(cached, dict):
                return cached

        if count and self.daily_limit is not None:
            used = self._local_used() + self.made_requests
            if used + 1 > self.daily_limit - self.reserve:
                raise ApiClientError(
                    f"Presupuesto diario agotado: {used}/{self.daily_limit} (reserva {self.reserve})."
                )

        url = f"{self.base_url}/{path.lstrip('/')}"
        if params:
            url += "?" + urlencode(params)

        last_error: Exception | None = None
        for attempt in range(3):
            self._throttle()
            try:
                request = Request(
                    url,
                    headers={
                        self.auth_header: self.key,
                        "Accept": "application/json",
                        "User-Agent": USER_AGENT,
                    },
                )
                with urlopen(request, timeout=45) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                    remaining = response.headers.get("X-RateLimit-Remaining")
                    if remaining is not None:
                        try:
                            self.remote_remaining = int(remaining)
                        except (TypeError, ValueError):
                            pass
                    quota = response.headers.get("X-Quota-Remaining")
                    if quota is not None:
                        try:
                            self.remote_quota_remaining = int(quota)
                        except (TypeError, ValueError):
                            pass
                    plan = response.headers.get("X-API-Plan")
                    if plan:
                        self.plan = plan
                if count:
                    self.made_requests += 1
                    self._local_increment()
                if not isinstance(payload, dict):
                    raise ApiClientError("Respuesta inesperada (no es JSON objeto).")
                self.response_cache.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(
                    json.dumps(payload, ensure_ascii=False), encoding="utf-8"
                )
                return payload
            except HTTPError as exc:
                last_error = exc
                if exc.code in (403, 401):
                    raise ApiClientError(
                        f"Acceso denegado por el plan (HTTP {exc.code}); "
                        "sólo se usan endpoints del plan gratuito."
                    ) from None
                if exc.code == 429 and attempt < 2:
                    time.sleep(4 * (attempt + 1))
                    continue
                if 500 <= exc.code < 600 and attempt < 2:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise ApiClientError(f"HTTP {exc.code} en {path}") from None
            except (URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise ApiClientError(f"Error de red en {path}: {type(exc).__name__}") from None
        raise ApiClientError(f"Error en {path}: {type(last_error).__name__ if last_error else 'desconocido'}")


# ---------------------------------------------------------------------------
# Estado de fuentes (sin secretos)
# ---------------------------------------------------------------------------

def _source_summary(
    *,
    key: str,
    source: str,
    configured: bool,
    status: str,
    events: int | None = None,
    quality: str | None = None,
    as_of: str | None = None,
    plan: str | None = None,
    budget: dict[str, Any] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    return {
        "source": source,
        "configured": configured,
        "status": status,
        "quality": quality if configured else None,
        "as_of": as_of if configured else None,
        "events": events if configured else None,
        "plan": plan if configured else None,
        "budget": budget if configured else None,
        "note": note,
        "checkedAt": utc_now(),
        "key": key,
    }


def write_source_status(providers: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Escribe data/source_status.json y js/data/fuentes.js (sin claves)."""
    payload = {
        "schema": "motor-nox.source-status.v1",
        "generatedAt": utc_now(),
        "providers": providers,
    }
    write_json(SOURCE_STATUS_PATH, payload)
    JS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    header = "// Generado automáticamente. Sin claves ni secretos.\n"
    SOURCES_JS_PATH.write_text(
        header + "export const SOURCE_STATUS = " +
        json.dumps(payload, indent=2, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    return payload


def empty_status(key: str, source: str, note: str) -> dict[str, Any]:
    """Estado usado cuando no hay clave o el proveedor no está configurado."""
    return _source_summary(
        key=key, source=source, configured=False, status="sin-clave",
        quality=None, as_of=None, note=note,
    )
