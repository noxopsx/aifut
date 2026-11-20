"""
MOTOR-NOX · Fase 1 · Sincronización operativa.

Orquesta catálogo + fixtures + cobertura con lock, reintentos y alertas.
La tarea de Windows puede ejecutarlo cada 15 minutos: el script decide si
toca sincronizar (15 min en día de partido, 6 h fuera de él).

Uso:
    python -m pipeline.sync_operativo
    python -m pipeline.sync_operativo --scheduled
    python -m pipeline.sync_operativo --coverage-only
    python -m pipeline.sync_operativo --manifest --force
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .db import BASE_DIR, DATA_DIR, configure_stdio, get_connection, init_db, utc_now
from .ingest_competitions import ingest_competitions
from .ingest_fixtures import coverage_report, ingest_fixtures

LOCK_PATH = BASE_DIR / ".cache" / "sync_operativo.lock"
STATE_PATH = BASE_DIR / ".cache" / "sync_operativo_state.json"
ALERTS_PATH = DATA_DIR / "alerts.json"
LOG_PATH = BASE_DIR / "actualizacion_live.log"

MATCHDAY_MINUTES = 15
OFFDAY_MINUTES = 360
LOCK_MAX_AGE_MINUTES = 30
MAX_ALERTS = 50


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def acquire_lock() -> bool:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    if LOCK_PATH.exists():
        age_minutes = (_now().timestamp() - LOCK_PATH.stat().st_mtime) / 60.0
        if age_minutes < LOCK_MAX_AGE_MINUTES:
            print(f"Sync omitido: otro proceso tiene el lock ({age_minutes:.1f} min).")
            return False
        LOCK_PATH.unlink(missing_ok=True)
    LOCK_PATH.write_text(
        json.dumps({"pid": os.getpid(), "startedAt": utc_now()}, ensure_ascii=False),
        encoding="utf-8",
    )
    return True


def release_lock() -> None:
    LOCK_PATH.unlink(missing_ok=True)


def append_alert(message: str, *, context: dict[str, Any] | None = None) -> None:
    alerts = _read_json(ALERTS_PATH, [])
    if not isinstance(alerts, list):
        alerts = []
    alerts.append(
        {
            "at": utc_now(),
            "message": message,
            "context": context or {},
        }
    )
    _write_json(ALERTS_PATH, alerts[-MAX_ALERTS:])
    try:
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"[{utc_now()}] ALERTA {message}\n")
    except OSError:
        pass


def is_matchday(conn: sqlite3.Connection) -> bool:
    try:
        today = _now().date()
        end = today + timedelta(days=2)
        row = conn.execute(
            """
            SELECT 1 FROM fixtures
            WHERE kickoff_utc >= ? AND kickoff_utc <= ?
            LIMIT 1
            """,
            (f"{today.isoformat()}T00:00:00Z", f"{end.isoformat()}T23:59:59Z"),
        ).fetchone()
        return bool(row)
    except sqlite3.Error:
        return False


def cadence_minutes(conn: sqlite3.Connection) -> int:
    return MATCHDAY_MINUTES if is_matchday(conn) else OFFDAY_MINUTES


def should_run(conn: sqlite3.Connection, *, force: bool = False) -> tuple[bool, str]:
    if force:
        return True, "forzado"
    state = _read_json(STATE_PATH, {})
    last = _parse_dt(state.get("lastRunAt"))
    if not last:
        return True, "sin estado previo"
    interval = cadence_minutes(conn)
    age = (_now() - last).total_seconds() / 60.0
    if age < 0:
        return True, "reloj movido hacia atrás"
    if age < interval:
        return False, f"última ejecución hace {age:.1f} min; intervalo {interval} min"
    return True, f"intervalo cumplido ({age:.1f} min ≥ {interval} min)"


def _retry(label: str, action: Callable[[], Any], *, attempts: int = 3) -> Any:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return action()
        except SystemExit:
            raise
        except Exception as error:  # el scheduler debe seguir y alertar
            last_error = error
            print(f"  reintento {attempt + 1}/{attempts} · {label}: {error}", file=sys.stderr)
            time.sleep(1.5 * (2**attempt))
    raise RuntimeError(f"{label}: {last_error}")


def _record_scheduler_state(
    conn: sqlite3.Connection,
    *,
    status: str,
    started_at: str,
    stats: dict[str, Any],
    error: str | None = None,
) -> None:
    try:
        conn.execute(
            """
            INSERT INTO sync_state (
                id, source, scope, last_started_at, last_finished_at, status,
                events, inserted, updated, errors, window_from, window_to, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                last_started_at = excluded.last_started_at,
                last_finished_at = excluded.last_finished_at,
                status = excluded.status,
                events = excluded.events,
                inserted = excluded.inserted,
                updated = excluded.updated,
                errors = excluded.errors,
                details_json = excluded.details_json
            """,
            (
                "operativo", "espn", "operativo", started_at, utc_now(), status,
                int(stats.get("events", 0)), int(stats.get("inserted", 0)),
                int(stats.get("updated", 0)), 1 if error else int(stats.get("errors", 0)),
                None, None,
                json.dumps({"stats": stats, "error": error}, ensure_ascii=False),
            ),
        )
        conn.commit()
    except sqlite3.Error:
        pass


def _provider_status(
    key: str,
    source: str,
    result: dict[str, Any] | None,
    *,
    no_key_note: str,
    quality: str = "observed",
    note: str = "",
) -> dict[str, Any]:
    """Construye el estado sin secretos de un proveedor a partir de su resultado."""
    from .api_free_common import _source_summary, empty_status

    if result and result.get("status") == "success":
        return _source_summary(
            key=key, source=source, configured=True, status="ok",
            events=result.get("events"), quality=quality,
            as_of=result.get("as_of"), plan=result.get("plan") or "free",
            budget=result.get("budget"), note=note or None,
        )
    if result and result.get("status") == "error":
        return _source_summary(
            key=key, source=source, configured=True, status="error",
            note=result.get("note") or note or None,
        )
    return empty_status(key, source, no_key_note)


def _aggregate_source_status(
    espn_events: int,
    api_result: dict[str, Any] | None,
    fdorg_result: dict[str, Any] | None,
    faorg_result: dict[str, Any] | None,
) -> dict[str, Any]:
    """Publica data/source_status.json y js/data/fuentes.js (sin claves)."""
    from .api_free_common import _source_summary, write_source_status

    providers = {
        "espn": _source_summary(
            key="espn", source="ESPN", configured=True, status="ok",
            events=espn_events, quality="observed", as_of=utc_now(),
            plan="public", note="Calendario, tabla, forma y sedes públicos.",
        ),
        "api_football": _provider_status(
            "api_football", "API-Football v3 (Free)", api_result,
            no_key_note="Sin clave: define APISPORTS_KEY o ejecuta --save-key.",
            quality="observed",
            note="Plan Free: ventana móvil de ±1 día, partidos en directo y backfill 2022-2024.",
        ),
        "football_data_org": _provider_status(
            "football_data_org", "football-data.org (Free)", fdorg_result,
            no_key_note="Sin clave: define FOOTBALLDATA_KEY o ejecuta --save-key.",
            quality="observed_delayed",
            note="12 competiciones del plan Free; resultados y calendarios con retraso.",
        ),
        "footballapi_org": _provider_status(
            "footballapi_org", "footballapi.org (gratuito)", faorg_result,
            no_key_note="Sin clave: define FOOTBALLAPI_KEY o ejecuta --save-key.",
            quality="observed_delayed",
            note="Plan gratuito: sólo Premier League de esta temporada; sin live scores.",
        ),
    }
    return write_source_status(providers)


def run_once(
    conn: sqlite3.Connection,
    *,
    catalog: bool = True,
    fixtures: bool = True,
    api_football: bool = True,
    fdorg: bool = True,
    faorg: bool = True,
    manifest: bool = False,
) -> dict[str, Any]:
    started_at = utc_now()
    stats: dict[str, Any] = {"steps": {}}
    error: str | None = None
    status = "success"
    api_result: dict[str, Any] | None = None
    fdorg_result: dict[str, Any] | None = None
    faorg_result: dict[str, Any] | None = None

    if catalog:
        try:
            result = _retry(
                "catálogo",
                lambda: ingest_competitions(conn=conn, max_active=80),
            )
            stats["steps"]["competitions"] = {
                "total": result.get("total"),
                "active": result.get("active"),
                "byTier": result.get("byTier"),
            }
        except Exception as exc:
            status = "partial"
            error = str(exc)
            append_alert(f"catálogo falló: {exc}", context={"step": "competitions"})
            print(f"Catálogo falló: {exc}", file=sys.stderr)

    if fixtures:
        try:
            result = _retry(
                "fixtures",
                lambda: ingest_fixtures(conn=conn, mode="window"),
            )
            stats["steps"]["fixtures"] = {
                key: result.get(key)
                for key in ("competitions", "events", "inserted", "updated", "unchanged", "errors", "tasks")
            }
            stats["events"] = result.get("events", 0)
            stats["inserted"] = result.get("inserted", 0)
            stats["updated"] = result.get("updated", 0)
            stats["errors"] = result.get("errors", 0)
            if result.get("errors"):
                status = "partial"
                append_alert(
                    f"fixtures con {result['errors']} errores de contrato",
                    context={"step": "fixtures"},
                )
        except Exception as exc:
            status = "failed"
            error = str(exc)
            append_alert(f"fixtures falló: {exc}", context={"step": "fixtures"})
            print(f"Fixtures falló: {exc}", file=sys.stderr)

    if api_football:
        try:
            from .ingest_api_football import ingest_api_football

            api_result = _retry(
                "api-football",
                lambda: ingest_api_football(conn=conn, days=3),
            )
            api_result = dict(api_result) if isinstance(api_result, dict) else None
            stats["steps"]["apiFootball"] = {
                key: api_result.get(key)
                for key in ("status", "events", "inserted", "updated", "plan", "budget", "merged")
            }
            if api_result.get("status") == "success":
                stats["apiEvents"] = api_result.get("events", 0)
        except Exception as exc:
            # La API es una fuente adicional: un fallo no invalida el sync ESPN.
            status = "partial" if status == "success" else status
            api_result = {"status": "error", "note": str(exc), "events": 0}
            append_alert(f"api-football falló: {exc}", context={"step": "apiFootball"})
            print(f"API-Football falló: {exc}", file=sys.stderr)

    if fdorg:
        try:
            from .ingest_football_data_org import ingest_football_data_org

            fdorg_result = _retry(
                "football-data-org",
                lambda: ingest_football_data_org(conn=conn, days=21),
            )
            fdorg_result = dict(fdorg_result) if isinstance(fdorg_result, dict) else None
            stats["steps"]["footballDataOrg"] = {
                key: fdorg_result.get(key)
                for key in ("status", "events", "standings", "plan", "budget", "merged")
            } if fdorg_result else None
            if fdorg_result and fdorg_result.get("status") == "success":
                stats["fdorgEvents"] = fdorg_result.get("events", 0)
        except Exception as exc:
            status = "partial" if status == "success" else status
            fdorg_result = {"status": "error", "note": str(exc), "events": 0}
            append_alert(f"football-data.org falló: {exc}", context={"step": "footballDataOrg"})
            print(f"football-data.org falló: {exc}", file=sys.stderr)

    if faorg:
        try:
            from .ingest_footballapi_org import ingest_footballapi_org

            faorg_result = _retry(
                "footballapi-org",
                lambda: ingest_footballapi_org(conn=conn, days=21),
            )
            faorg_result = dict(faorg_result) if isinstance(faorg_result, dict) else None
            stats["steps"]["footballapiOrg"] = {
                key: faorg_result.get(key)
                for key in ("status", "events", "standings", "plan", "budget", "merged")
            } if faorg_result else None
            if faorg_result and faorg_result.get("status") == "success":
                stats["faorgEvents"] = faorg_result.get("events", 0)
        except Exception as exc:
            status = "partial" if status == "success" else status
            faorg_result = {"status": "error", "note": str(exc), "events": 0}
            append_alert(f"footballapi.org falló: {exc}", context={"step": "footballapiOrg"})
            print(f"footballapi.org falló: {exc}", file=sys.stderr)

    try:
        coverage = coverage_report(conn=conn, days=7)
        stats["steps"]["coverage"] = {
            "status": coverage.get("status"),
            "abCoveragePct": coverage.get("abCoverage", {}).get("coveragePct"),
            "fixtures": coverage.get("fixtures", {}).get("total"),
            "alerts": coverage.get("alerts", []),
        }
        if coverage.get("status") != "PASS":
            if status == "success":
                status = "partial"
            for alert in coverage.get("alerts", [])[:5]:
                append_alert(f"cobertura: {alert}", context={"step": "coverage"})
    except Exception as exc:
        status = "partial"
        error = error or str(exc)
        append_alert(f"cobertura falló: {exc}", context={"step": "coverage"})
        print(f"Cobertura falló: {exc}", file=sys.stderr)

    try:
        status_payload = _aggregate_source_status(
            int(stats.get("events", 0)), api_result, fdorg_result, faorg_result
        )
        stats["steps"]["sources"] = {
            key: value.get("status")
            for key, value in status_payload.get("providers", {}).items()
        }
    except Exception as exc:
        append_alert(f"estado de fuentes falló: {exc}", context={"step": "sources"})
        print(f"Estado de fuentes falló: {exc}", file=sys.stderr)

    if manifest:
        try:
            from .build_manifest import build_manifest

            _retry("manifest", lambda: build_manifest(conn=conn))
            stats["steps"]["manifest"] = "ok"
        except Exception as exc:
            status = "partial"
            error = error or str(exc)
            append_alert(f"manifest falló: {exc}", context={"step": "manifest"})
            print(f"Manifest falló: {exc}", file=sys.stderr)

    _record_scheduler_state(conn, status=status, started_at=started_at, stats=stats, error=error)
    state = {
        "version": "1.0",
        "lastRunAt": utc_now(),
        "status": status,
        "matchday": is_matchday(conn),
        "cadenceMinutes": cadence_minutes(conn),
        "stats": stats,
        "error": error,
    }
    _write_json(STATE_PATH, state)
    return state


def main() -> None:
    configure_stdio()
    parser = argparse.ArgumentParser(description="MOTOR-NOX · sincronización operativa")
    parser.add_argument("--scheduled", action="store_true", help="Respeta el intervalo 15 min / 6 h")
    parser.add_argument("--force", action="store_true", help="Ignora el intervalo")
    parser.add_argument("--coverage-only", action="store_true", help="Solo recalcula cobertura")
    parser.add_argument("--no-catalog", action="store_true", help="No refresca el catálogo")
    parser.add_argument("--no-fixtures", action="store_true", help="No descarga fixtures")
    parser.add_argument("--no-api", action="store_true", help="No consulta API-Football")
    parser.add_argument("--no-fdorg", action="store_true", help="No consulta football-data.org")
    parser.add_argument("--no-faorg", action="store_true", help="No consulta footballapi.org")
    parser.add_argument("--manifest", action="store_true", help="Regenera manifest.json al final")
    args = parser.parse_args()

    init_db()
    conn = get_connection()
    try:
        if args.scheduled:
            run, reason = should_run(conn, force=args.force)
            if not run:
                print(f"Sync omitido: {reason}")
                return
            print(f"Sync autorizado: {reason}")

        if args.coverage_only:
            payload = coverage_report(conn=conn, days=7)
            print(
                f"Cobertura {payload['status']} · A/B {payload['abCoverage']['coveragePct']}% · "
                f"{payload['fixtures']['total']} fixtures · alertas {len(payload['alerts'])}"
            )
            return

        if not acquire_lock():
            return
        try:
            state = run_once(
                conn,
                catalog=not args.no_catalog,
                fixtures=not args.no_fixtures,
                api_football=not args.no_api,
                fdorg=not args.no_fdorg,
                faorg=not args.no_faorg,
                manifest=args.manifest,
            )
        finally:
            release_lock()
        print(
            f"Sync {state['status']} · matchday={state['matchday']} · "
            f"cadencia={state['cadenceMinutes']} min · "
            f"eventos={state['stats'].get('events', 0)} · "
            f"nuevos={state['stats'].get('inserted', 0)} · "
            f"actualizados={state['stats'].get('updated', 0)}"
        )
        if state.get("error"):
            print(f"Error: {state['error']}", file=sys.stderr)
            raise SystemExit(1)
    except Exception as error:
        append_alert(f"scheduler falló: {error}", context={"traceback": traceback.format_exc()})
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
