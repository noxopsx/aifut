"""
MOTOR-NOX · Conector de API-Football v3 (plan Free).

Integra automáticamente los partidos que el plan gratuito expone:

  · /fixtures?date=YYYY-MM-DD   -> ventana móvil de ±1 día alrededor de hoy
  · /fixtures?live=all          -> partidos en directo
  · /fixtures?league=&season=   -> backfill de temporadas 2022..2024

La clave NUNCA se escribe en código, manifiestos, datos generados, logs ni UI.
Se lee de la variable de entorno APISPORTS_KEY o de una caché local privada
(.cache/api_football/key.json, permisos 0600).

Los partidos se guardan en una tabla propia `api_fixtures` para NO alterar las
métricas de cobertura ESPN de Fase 1. Después se fusionan en data/fixtures.json
(con deduplicación) para que la app los vea sin cambios en el front-end.

Presupuesto: 100 peticiones/día. El conector consulta /status al inicio de cada
ejecución para conocer el consumo real, deja un margen de reserva y mantiene un
ledger local para no exceder el límite dentro de una misma ejecución.

Uso:
    python -m pipeline.ingest_api_football --save-key        # guarda la clave de APISPORTS_KEY
    python -m pipeline.ingest_api_football --status          # plan / límite / consumo (sin clave)
    python -m pipeline.ingest_api_football                    # día actual + en directo
    python -m pipeline.ingest_api_football --days 3           # hoy ±1 (máx. del plan Free)
    python -m pipeline.ingest_api_football --league 39 --season 2024
    python -m pipeline.ingest_api_football --dry-run
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .db import BASE_DIR, DATA_DIR, configure_stdio, get_connection, init_db, utc_now

API_BASE = "https://v3.football.api-sports.io"
FREE_DAILY_LIMIT = 100
RESERVE_REQUESTS = 5          # margen de seguridad sobre el límite diario
CACHE_DIR = BASE_DIR / ".cache" / "api_football"
RESPONSE_CACHE_DIR = CACHE_DIR / "responses"
KEY_PATH = CACHE_DIR / "key.json"
USAGE_PATH = CACHE_DIR / "usage.json"
FIXTURES_JSON = DATA_DIR / "fixtures.json"
API_FIXTURES_JSON = DATA_DIR / "api_fixtures.json"

CACHE_TTL_SHORT = 5 * 60       # 5 min para date/live (cambian durante el partido)
CACHE_TTL_LONG = 7 * 24 * 3600  # 7 días para backfill histórico

USER_AGENT = "MOTOR-NOX/1.0 (integracion de partidos; API-Football v3 plan Free)"

# ID de liga de API-Football -> ID interno de competición MOTOR-NOX.
# Sólo IDs confirmados. Las ligas no listadas se guardan como `api.<id>` con su
# nombre/país, sin tocar la tabla `competitions` (preserva catálogo y cobertura).
LEAGUE_MAP: dict[int, str] = {
    39: "eng.1",     # Premier League (confirmado)
    140: "esp.1",    # La Liga (confirmado)
    135: "ita.1",    # Serie A (confirmado)
    78: "ger.1",     # Bundesliga
    61: "fra.1",     # Ligue 1
    2: "uefa.champions",       # UEFA Champions League
    3: "uefa.europa",          # UEFA Europa League
    848: "uefa.europa.conf",   # UEFA Conference League
    203: "conmebol.libertadores",
    204: "conmebol.sudamericana",
    71: "bra.1",     # Brasileirão Série A (confirmado)
}

STATUS_SCHEDULED = {"NS", "TBD"}
STATUS_LIVE = {"1H", "HT", "2H", "ET", "BT", "INT", "PEN", "SUSP", "RAIN"}
STATUS_FINISHED = {"FT", "AET"}
STATUS_POSTPONED = {"PST"}
STATUS_CANCELLED = {"CANC"}
STATUS_SUSPENDED = {"ABD", "WO"}


class ApiError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Clave y presupuesto
# ---------------------------------------------------------------------------

def resolve_api_key() -> str:
    key = os.environ.get("APISPORTS_KEY", "").strip()
    if key:
        return key
    try:
        payload = json.loads(KEY_PATH.read_text(encoding="utf-8"))
        return str(payload.get("key", "")).strip()
    except (OSError, json.JSONDecodeError, AttributeError):
        return ""


def save_api_key() -> bool:
    """Persiste la clave de APISPORTS_KEY en caché local privada. No la imprime."""
    key = os.environ.get("APISPORTS_KEY", "").strip()
    if not key:
        print("Error: define APISPORTS_KEY antes de --save-key.", file=sys.stderr)
        return False
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    KEY_PATH.write_text(
        json.dumps({"key": key, "saved_at": utc_now()}, ensure_ascii=False),
        encoding="utf-8",
    )
    try:
        KEY_PATH.chmod(0o600)
    except OSError:
        pass  # Windows: mejor esfuerzo
    print(f"Clave guardada en caché local: {KEY_PATH}")
    return True


def _load_usage() -> dict[str, Any]:
    try:
        data = json.loads(USAGE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_usage(data: dict[str, Any]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    USAGE_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def today_key() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _local_used_today() -> int:
    return int(_load_usage().get(today_key(), 0))


def _local_increment(n: int = 1) -> None:
    data = _load_usage()
    data[today_key()] = int(data.get(today_key(), 0)) + n
    # conserva sólo los últimos 7 días
    for day in sorted(data)[:-7]:
        data.pop(day, None)
    _save_usage(data)


# ---------------------------------------------------------------------------
# Cliente HTTP con caché, reintentos y control de presupuesto
# ---------------------------------------------------------------------------

class ApiClient:
    def __init__(self, key: str, *, dry_run: bool = False) -> None:
        if not key:
            raise ApiError("Sin clave API. Define APISPORTS_KEY o ejecuta --save-key.")
        self.key = key
        self.dry_run = dry_run
        self.made_requests = 0
        self.limit_day = FREE_DAILY_LIMIT
        self.remote_current = 0
        # /status no consume cuota del plan Free: se consulta siempre en vivo
        # para que el presupuesto reportado sea autoritativo.
        status = self._request("status", {}, ttl=0, count=False)
        response = status.get("response") or {}
        subscription = response.get("subscription") or {}
        requests_info = response.get("requests") or {}
        self.limit_day = int(requests_info.get("limit_day") or FREE_DAILY_LIMIT)
        self.remote_current = int(requests_info.get("current") or 0)
        self.plan = str(subscription.get("plan") or "unknown")
        self.plan_active = bool(subscription.get("active"))

    def _cache_path(self, endpoint: str, params: dict[str, Any]) -> Path:
        raw = endpoint + "?" + urlencode(sorted((k, str(v)) for k, v in params.items()))
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
        return RESPONSE_CACHE_DIR / f"{endpoint.replace('/', '_')}_{digest}.json"

    def _request(
        self,
        endpoint: str,
        params: dict[str, Any],
        *,
        ttl: int = CACHE_TTL_SHORT,
        count: bool = True,
    ) -> dict[str, Any]:
        cache_path = self._cache_path(endpoint, params)
        if cache_path.exists() and (time.time() - cache_path.stat().st_mtime) < ttl:
            try:
                return json.loads(cache_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pass

        budget_used = max(self.remote_current + self.made_requests, _local_used_today())
        if count and budget_used + 1 > self.limit_day - RESERVE_REQUESTS:
            raise ApiError(
                f"Presupuesto diario agotado: {budget_used}/{self.limit_day} "
                f"(reserva {RESERVE_REQUESTS})."
            )

        url = f"{API_BASE}/{endpoint}"
        if params:
            url += "?" + urlencode(params)
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                request = Request(
                    url,
                    headers={
                        "x-apisports-key": self.key,
                        "Accept": "application/json",
                        "User-Agent": USER_AGENT,
                    },
                )
                with urlopen(request, timeout=45) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                if count:
                    self.made_requests += 1
                    if not self.dry_run:
                        _local_increment(1)
                errors = payload.get("errors") or {}
                if errors:
                    raise ApiError(_format_errors(errors))
                RESPONSE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(
                    json.dumps(payload, ensure_ascii=False), encoding="utf-8"
                )
                return payload
            except HTTPError as exc:
                last_error = exc
                if exc.code == 429 and attempt < 2:
                    time.sleep(2 ** (attempt + 2))
                    continue
                raise ApiError(f"HTTP {exc.code} en /{endpoint}") from exc
            except (URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(1.5 * (2 ** attempt))
                    continue
                raise ApiError(f"Error de red en /{endpoint}: {exc}") from exc
        raise ApiError(f"Error en /{endpoint}: {last_error}")

    def status_summary(self) -> dict[str, Any]:
        used = max(self.remote_current + self.made_requests, _local_used_today())
        return {
            "plan": self.plan,
            "active": self.plan_active,
            "limit_day": self.limit_day,
            "used": used,
            "remaining": max(0, self.limit_day - used),
            "reserve": RESERVE_REQUESTS,
        }

    def fixtures_by_date(self, day: date) -> list[dict[str, Any]]:
        payload = self._request("fixtures", {"date": day.isoformat()}, ttl=CACHE_TTL_SHORT)
        return list(payload.get("response") or [])

    def live_fixtures(self) -> list[dict[str, Any]]:
        payload = self._request("fixtures", {"live": "all"}, ttl=CACHE_TTL_SHORT)
        return list(payload.get("response") or [])

    def fixtures_by_league_season(self, league_id: int, season: int) -> list[dict[str, Any]]:
        payload = self._request(
            "fixtures", {"league": league_id, "season": season}, ttl=CACHE_TTL_LONG
        )
        return list(payload.get("response") or [])


def _format_errors(errors: Any) -> str:
    if isinstance(errors, dict):
        if "plan" in errors:
            return str(errors["plan"])
        return "; ".join(f"{k}: {v}" for k, v in errors.items())
    if isinstance(errors, list):
        return "; ".join(str(item) for item in errors)
    return str(errors)


# ---------------------------------------------------------------------------
# Normalización
# ---------------------------------------------------------------------------

def _norm_text(value: str | None) -> str:
    if not value:
        return ""
    text = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _norm_status(fixture: dict[str, Any]) -> str:
    short = str((fixture.get("status") or {}).get("short") or "NS").upper()
    long_text = str((fixture.get("status") or {}).get("long") or "").lower()
    if "finish" in long_text or "after extra" in long_text or "after penalty" in long_text:
        return "finished"
    if short in STATUS_FINISHED:
        return "finished"
    if short in STATUS_POSTPONED:
        return "postponed"
    if short in STATUS_CANCELLED:
        return "cancelled"
    if short in STATUS_SUSPENDED:
        return "suspended"
    if short in STATUS_LIVE:
        return "live"
    return "scheduled"


def _norm_kickoff(value: str | None) -> str | None:
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_fixture(raw: dict[str, Any]) -> dict[str, Any] | None:
    fixture = raw.get("fixture") or {}
    league = raw.get("league") or {}
    teams = raw.get("teams") or {}
    home = teams.get("home") or {}
    away = teams.get("away") or {}
    goals = raw.get("goals") or {}
    kickoff = _norm_kickoff(fixture.get("date"))
    if not kickoff or not home.get("id") or not away.get("id"):
        return None

    league_id = int(league.get("id") or 0)
    competition_id = LEAGUE_MAP.get(league_id, f"api.{league_id}")
    venue = fixture.get("venue") or {}
    status = _norm_status(fixture)
    finished = status == "finished"

    return {
        "id": f"apif-{fixture.get('id')}",
        "source_id": str(fixture.get("id")),
        "competition_id": competition_id,
        "competition_name": str(league.get("name") or f"API league {league_id}"),
        "country": str(league.get("country") or ""),
        "season": str(league.get("season") or ""),
        "kickoff_utc": kickoff,
        "home_team_id": f"apif-{home.get('id')}",
        "away_team_id": f"apif-{away.get('id')}",
        "home_team_name": str(home.get("name") or ""),
        "away_team_name": str(away.get("name") or ""),
        "status": status,
        "home_goals": int(goals["home"]) if finished and goals.get("home") is not None else None,
        "away_goals": int(goals["away"]) if finished and goals.get("away") is not None else None,
        "venue": str(venue.get("name") or "") or None,
        "venue_city": str(venue.get("city") or "") or None,
        "referee": str(fixture.get("referee") or "") or None,
        "round": str(league.get("round") or "") or None,
        "raw_json": json.dumps(raw, ensure_ascii=False),
    }


# ---------------------------------------------------------------------------
# Persistencia
# ---------------------------------------------------------------------------

def ensure_api_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS api_fixtures (
            id              TEXT PRIMARY KEY,
            source_id       TEXT NOT NULL UNIQUE,
            competition_id  TEXT NOT NULL,
            competition_name TEXT,
            country         TEXT,
            season          TEXT,
            kickoff_utc     TEXT NOT NULL,
            home_team_id    TEXT NOT NULL,
            away_team_id    TEXT NOT NULL,
            home_team_name  TEXT NOT NULL,
            away_team_name  TEXT NOT NULL,
            status          TEXT NOT NULL,
            home_goals      INTEGER,
            away_goals      INTEGER,
            venue           TEXT,
            venue_city      TEXT,
            referee         TEXT,
            round           TEXT,
            raw_json        TEXT,
            first_seen_at   TEXT NOT NULL,
            last_seen_at    TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_api_fixtures_kickoff ON api_fixtures(kickoff_utc)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_api_fixtures_comp ON api_fixtures(competition_id, kickoff_utc)"
    )
    conn.commit()


UPSERT_SQL = """
INSERT INTO api_fixtures (
    id, source_id, competition_id, competition_name, country, season,
    kickoff_utc, home_team_id, away_team_id, home_team_name, away_team_name,
    status, home_goals, away_goals, venue, venue_city, referee, round,
    raw_json, first_seen_at, last_seen_at, updated_at
) VALUES (
    :id, :source_id, :competition_id, :competition_name, :country, :season,
    :kickoff_utc, :home_team_id, :away_team_id, :home_team_name, :away_team_name,
    :status, :home_goals, :away_goals, :venue, :venue_city, :referee, :round,
    :raw_json, :first_seen_at, :last_seen_at, :updated_at
)
ON CONFLICT(source_id) DO UPDATE SET
    competition_id  = excluded.competition_id,
    competition_name= excluded.competition_name,
    country         = excluded.country,
    season          = excluded.season,
    kickoff_utc     = excluded.kickoff_utc,
    home_team_id    = excluded.home_team_id,
    away_team_id    = excluded.away_team_id,
    home_team_name  = excluded.home_team_name,
    away_team_name  = excluded.away_team_name,
    status          = excluded.status,
    home_goals      = excluded.home_goals,
    away_goals      = excluded.away_goals,
    venue           = excluded.venue,
    venue_city      = excluded.venue_city,
    referee         = excluded.referee,
    round           = excluded.round,
    raw_json        = excluded.raw_json,
    last_seen_at    = excluded.last_seen_at,
    updated_at      = excluded.updated_at
"""


def upsert_fixtures(conn: sqlite3.Connection, rows: list[dict[str, Any]]) -> dict[str, int]:
    ensure_api_table(conn)
    now = utc_now()
    inserted = 0
    updated = 0
    with conn:
        for row in rows:
            existing = conn.execute(
                "SELECT 1 FROM api_fixtures WHERE source_id = ?", (row["source_id"],)
            ).fetchone()
            payload = dict(row)
            payload["first_seen_at"] = now
            payload["last_seen_at"] = now
            payload["updated_at"] = now
            if existing:
                # conserva first_seen_at
                previous = conn.execute(
                    "SELECT first_seen_at FROM api_fixtures WHERE source_id = ?",
                    (row["source_id"],),
                ).fetchone()
                payload["first_seen_at"] = previous["first_seen_at"]
                updated += 1
            else:
                inserted += 1
            conn.execute(UPSERT_SQL, payload)
    return {"inserted": inserted, "updated": updated}


# ---------------------------------------------------------------------------
# Exportación y fusión con data/fixtures.json sin tocar las métricas ESPN
# ---------------------------------------------------------------------------

def _api_export_rows(conn: sqlite3.Connection, start: date, end: date) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, source_id, competition_id, competition_name, country, season,
               kickoff_utc, home_team_id, away_team_id, home_team_name, away_team_name,
               status, home_goals, away_goals, venue, venue_city, referee, round,
               updated_at
        FROM api_fixtures
        WHERE kickoff_utc >= ? AND kickoff_utc <= ?
        ORDER BY kickoff_utc, competition_name
        """,
        (f"{start.isoformat()}T00:00:00Z", f"{end.isoformat()}T23:59:59Z"),
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        # El front-end espera estos campos con los mismos nombres que ESPN.
        item["tier"] = "A" if item["competition_id"] in {"eng.1", "esp.1"} else "C"
        item["source"] = "api_football"
        item["provider"] = "api_football"
        item["quality"] = "observed"
        item["as_of"] = item.get("updated_at")
        item["source_url"] = f"https://www.api-football.com/fixture/{item['source_id']}"
        item["venue"] = item.get("venue")
        item["venue_city"] = item.get("venue_city")
        item["stage"] = item.get("round")
        result.append(item)
    return result


def write_api_fixtures_json(conn: sqlite3.Connection, start: date, end: date) -> dict[str, Any]:
    items = _api_export_rows(conn, start, end)
    by_source: dict[str, int] = {}
    for item in items:
        by_source[item["source"]] = by_source.get(item["source"], 0) + 1
    payload = {
        "schema": "motor-nox.api-fixtures.v1",
        "generatedAt": utc_now(),
        "provider": "api-football-v3",
        "plan": "free",
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "count": len(items),
        "bySource": by_source,
        "items": items,
    }
    API_FIXTURES_JSON.parent.mkdir(parents=True, exist_ok=True)
    API_FIXTURES_JSON.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return payload


def _dedup_key(item: dict[str, Any]) -> tuple[str, str, str, str]:
    kickoff = str(item.get("kickoff_utc") or "")[:10]
    return (
        str(item.get("competition_id") or ""),
        kickoff,
        _norm_text(item.get("home_team_name")),
        _norm_text(item.get("away_team_name")),
    )


def write_combined_fixtures_json(conn: sqlite3.Connection, start: date, end: date) -> dict[str, Any]:
    """Reescribe data/fixtures.json combinando todas las fuentes sin duplicados.

    Delega en `pipeline.fixtures_merge`, que conserva la tabla ESPN como base;
    por eso las métricas de cobertura de Fase 1 siguen calculándose sólo sobre
    `fixtures` y no se alteran.
    """
    from .fixtures_merge import write_combined

    result = write_combined(conn, start, end, fixtures_path=FIXTURES_JSON)
    return {
        "count": result["count"],
        "apiAdded": result["added"].get("api_football", 0),
        "sources": result["sources"],
    }


# ---------------------------------------------------------------------------
# Orquestación
# ---------------------------------------------------------------------------

def ingest_api_football(
    *,
    conn: sqlite3.Connection | None = None,
    days: int = 1,
    league: int | None = None,
    season: int | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    key = resolve_api_key()
    if not key:
        return {"status": "skipped", "reason": "sin clave API", "events": 0}
    own_conn = conn is None
    conn = conn or get_connection()
    client = ApiClient(key, dry_run=dry_run)
    summary = client.status_summary()
    raws: list[dict[str, Any]] = []
    dates: list[date] = []

    try:
        if league is not None and season is not None:
            if season < 2022 or season > 2024:
                raise ApiError("El plan Free sólo permite temporadas 2022..2024.")
            raws.extend(client.fixtures_by_league_season(league, season))
        else:
            # Ventana móvil: el plan Free permite hoy ±1 día.
            days = max(1, min(3, int(days)))
            today = datetime.now(timezone.utc).date()
            dates = [today + timedelta(days=offset) for offset in range(-(days // 2), days // 2 + 1)]
            dates = sorted({day for day in dates})
            for day in dates:
                raws.extend(client.fixtures_by_date(day))
            raws.extend(client.live_fixtures())

        rows = []
        for raw in raws:
            normalized = normalize_fixture(raw)
            if normalized:
                rows.append(normalized)
        # dedup por source_id dentro del propio lote
        unique: dict[str, dict[str, Any]] = {}
        for row in rows:
            unique[row["source_id"]] = row
        rows = list(unique.values())

        stats: dict[str, Any] = {
            "status": "success",
            "events": len(rows),
            "plan": summary["plan"],
            "budget": client.status_summary(),
            "dates": [day.isoformat() for day in dates],
            "league": league,
            "season": season,
            "dryRun": dry_run,
        }
        if dry_run:
            stats["inserted"] = 0
            stats["updated"] = 0
            return stats

        ensure_api_table(conn)
        persistence = upsert_fixtures(conn, rows)
        stats.update(persistence)

        # Ventana operativa de exportación (coherente con ingest_fixtures --window):
        # de ayer a +21 días. Así el merge no estrecha lo que ya veía la UI.
        today = datetime.now(timezone.utc).date()
        start = today - timedelta(days=1)
        end = today + timedelta(days=21)
        stats["apiJson"] = write_api_fixtures_json(conn, start, end)["count"]
        stats["merged"] = write_combined_fixtures_json(conn, start, end)["apiAdded"]
        return stats
    finally:
        if own_conn:
            conn.close()


def main() -> None:
    configure_stdio()
    parser = argparse.ArgumentParser(description="MOTOR-NOX · integración API-Football v3 (Free)")
    parser.add_argument("--save-key", action="store_true", help="Guarda APISPORTS_KEY en caché local privada")
    parser.add_argument("--status", action="store_true", help="Muestra plan/límite/consumo (sin clave)")
    parser.add_argument("--days", type=int, default=1, help="Días de la ventana móvil (1..3)")
    parser.add_argument("--league", type=int, default=None, help="ID de liga API-Football para backfill")
    parser.add_argument("--season", type=int, default=None, help="Temporada 2022..2024 para backfill")
    parser.add_argument("--dry-run", action="store_true", help="Descarga y valida sin escribir")
    args = parser.parse_args()

    if args.save_key:
        raise SystemExit(0 if save_api_key() else 1)

    if not resolve_api_key():
        print("Sin clave API. Define APISPORTS_KEY o ejecuta --save-key.", file=sys.stderr)
        raise SystemExit(1)

    if args.status:
        client = ApiClient(resolve_api_key())
        print(json.dumps(client.status_summary(), indent=2, ensure_ascii=False))
        return

    init_db()
    conn = get_connection()
    try:
        result = ingest_api_football(
            conn=conn,
            days=args.days,
            league=args.league,
            season=args.season,
            dry_run=args.dry_run,
        )
    finally:
        conn.close()
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
