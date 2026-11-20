"""
MOTOR-NOX · Fase 0 · Reconciliación de resultados y récord verificable.

Toma los resultados oficiales de los partidos pronosticados, cierra cada
forecast con su acierto y su Brier, y genera el récord que consume la web.

El récord público solo cuenta pronósticos con `published = 1`; los pronósticos
registrados pero no publicados se reportan aparte para no mezclar universos.

Uso:
    python -m pipeline.reconcile_results --results data/live_results.json
    python -m pipeline.reconcile_results --export
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .db import BASE_DIR, DATA_DIR, DB_PATH, configure_stdio, get_connection, init_db, utc_now

SCHEMA = "motor-nox.record.v1"
RECORD_JSON = DATA_DIR / "record.json"
RECORD_JS = BASE_DIR / "js" / "data" / "record.js"

STATUS_ALIASES = {
    "finished": "finished",
    "final": "finished",
    "full_time": "finished",
    "ft": "finished",
    "played": "finished",
    "postponed": "postponed",
    "suspended": "postponed",
    "cancelled": "void",
    "canceled": "void",
    "void": "void",
    "abandoned": "void",
}
SIGN_BY_RESULT = {"home": "1", "draw": "X", "away": "2"}
RESULT_LABEL = {"1": "Local", "X": "Empate", "2": "Visitante"}
BUCKETS = [
    ("≥ 80%", 0.80, 1.0000001),
    ("70–80%", 0.70, 0.80),
    ("60–70%", 0.60, 0.70),
    ("< 60%", 0.0, 0.60),
]


# ---------------------------------------------------------------------------
# Entrada de resultados
# ---------------------------------------------------------------------------
def _as_int_goals(value: Any, field: str) -> int:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"{field} inválido")
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} inválido") from error
    if number < 0 or number > 30:
        raise ValueError(f"{field} fuera de rango")
    return number


def parse_result(row: dict[str, Any]) -> dict[str, Any]:
    fixture_id = str(row.get("fixture_id") or row.get("fixtureId") or row.get("id") or "").strip()
    if not fixture_id:
        raise ValueError("falta fixture_id")
    raw_status = str(row.get("status") or ("finished" if row.get("home_goals") is not None else "")).strip().lower()
    status = STATUS_ALIASES.get(raw_status)
    if status is None:
        raise ValueError(f"estado no reconocido: {raw_status!r}")

    parsed: dict[str, Any] = {
        "fixture_id": fixture_id,
        "status": status,
        "source": row.get("source"),
        "notes": row.get("notes"),
        "home_goals": None,
        "away_goals": None,
        "result": None,
    }
    if status == "finished":
        home = _as_int_goals(row.get("home_goals", row.get("homeGoals")), "home_goals")
        away = _as_int_goals(row.get("away_goals", row.get("awayGoals")), "away_goals")
        parsed["home_goals"] = home
        parsed["away_goals"] = away
        parsed["result"] = "1" if home > away else "2" if away > home else "X"
    return parsed


def load_results(path: Path | str) -> list[dict[str, Any]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict) and isinstance(payload.get("results"), list):
        rows = payload["results"]
    else:
        raise ValueError("el archivo debe ser una lista o un objeto con 'results'")
    return [parse_result(row) for row in rows]


# ---------------------------------------------------------------------------
# Reconciliación
# ---------------------------------------------------------------------------
def _outcome_for(forecast: sqlite3.Row, result: dict[str, Any], *, source: str | None) -> dict[str, Any]:
    if result["status"] != "finished":
        return {
            "forecast_id": forecast["id"],
            "status": "postponed" if result["status"] == "postponed" else "void",
            "result": None,
            "home_goals": None,
            "away_goals": None,
            "hit": None,
            "brier": None,
            "log_loss": None,
            "source": source or result.get("source"),
            "reconciled_at": utc_now(),
            "notes": result.get("notes"),
        }

    sign = result["result"]
    pick = forecast["pick"]
    hit = int(pick == sign)
    y = {
        "home": 1.0 if sign == "1" else 0.0,
        "draw": 1.0 if sign == "X" else 0.0,
        "away": 1.0 if sign == "2" else 0.0,
    }
    brier = (
        (forecast["p_home"] - y["home"]) ** 2
        + (forecast["p_draw"] - y["draw"]) ** 2
        + (forecast["p_away"] - y["away"]) ** 2
    )
    pick_probability = {
        "1": forecast["p_home"],
        "X": forecast["p_draw"],
        "2": forecast["p_away"],
    }.get(pick, forecast["confidence"])
    log_loss = -math.log(max(float(pick_probability), 1e-12))
    return {
        "forecast_id": forecast["id"],
        "status": "hit" if hit else "miss",
        "result": sign,
        "home_goals": result["home_goals"],
        "away_goals": result["away_goals"],
        "hit": hit,
        "brier": round(brier, 12),
        "log_loss": round(log_loss, 12),
        "source": source or result.get("source"),
        "reconciled_at": utc_now(),
        "notes": result.get("notes"),
    }


def reconcile_results(
    conn: sqlite3.Connection,
    results: Iterable[dict[str, Any]],
    *,
    source: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Cierra los pronósticos con resultado. Idempotente y corregible."""
    stats: dict[str, Any] = {
        "results": 0,
        "matched": 0,
        "reconciled": 0,
        "updated": 0,
        "skipped": 0,
        "unmatched": [],
        "rejected": [],
    }
    for raw_result in results:
        stats["results"] += 1
        try:
            result = parse_result(raw_result)
        except ValueError as error:
            stats["rejected"].append({"result": raw_result, "error": str(error)})
            continue
        forecasts = list(
            conn.execute("SELECT * FROM forecasts WHERE fixture_id = ?", (result["fixture_id"],))
        )
        if not forecasts:
            stats["unmatched"].append(result["fixture_id"])
            continue
        stats["matched"] += len(forecasts)
        for forecast in forecasts:
            outcome = _outcome_for(forecast, result, source=source)
            existing = conn.execute(
                "SELECT * FROM forecast_outcomes WHERE forecast_id = ?", (forecast["id"],)
            ).fetchone()
            if existing:
                same = (
                    existing["status"] == outcome["status"]
                    and existing["result"] == outcome["result"]
                    and existing["home_goals"] == outcome["home_goals"]
                    and existing["away_goals"] == outcome["away_goals"]
                )
                if same:
                    stats["skipped"] += 1
                    continue
                if dry_run:
                    stats["updated"] += 1
                    continue
                conn.execute(
                    """
                    UPDATE forecast_outcomes
                    SET status = :status, result = :result, home_goals = :home_goals,
                        away_goals = :away_goals, hit = :hit, brier = :brier,
                        log_loss = :log_loss, source = :source,
                        reconciled_at = :reconciled_at, notes = :notes
                    WHERE forecast_id = :forecast_id
                    """,
                    outcome,
                )
                stats["updated"] += 1
                continue
            if dry_run:
                stats["reconciled"] += 1
                continue
            conn.execute(
                """
                INSERT INTO forecast_outcomes
                    (forecast_id, status, result, home_goals, away_goals, hit, brier,
                     log_loss, source, reconciled_at, notes)
                VALUES
                    (:forecast_id, :status, :result, :home_goals, :away_goals, :hit, :brier,
                     :log_loss, :source, :reconciled_at, :notes)
                """,
                outcome,
            )
            stats["reconciled"] += 1
    if not dry_run:
        conn.commit()
    return stats


# ---------------------------------------------------------------------------
# Récord
# ---------------------------------------------------------------------------
def _wilson_interval(hits: int, n: int, z: float = 1.959963984540054) -> list[float] | None:
    if n <= 0:
        return None
    p = hits / n
    denominator = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denominator
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return [round(max(0.0, centre - margin), 6), round(min(1.0, centre + margin), 6)]


def _normal_interval(hits: int, n: int) -> list[float] | None:
    """IC95% del plan: p ± 1,96·sqrt(p(1-p)/n). Se publica el normal."""
    if n <= 0:
        return None
    p = hits / n
    margin = 1.959963984540054 * math.sqrt(p * (1 - p) / n)
    return [round(max(0.0, p - margin), 6), round(min(1.0, p + margin), 6)]


def compute_record(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = list(
        conn.execute(
            """
            SELECT f.*, o.status AS outcome_status, o.hit AS outcome_hit,
                   o.brier AS outcome_brier, o.result AS outcome_result,
                   o.reconciled_at AS reconciled_at,
                   o.home_goals AS outcome_home, o.away_goals AS outcome_away
            FROM forecasts f
            LEFT JOIN forecast_outcomes o ON o.forecast_id = f.id
            WHERE f.source = 'live'
            ORDER BY f.kickoff_utc
            """
        )
    )
    registered = len(rows)
    published_rows = [row for row in rows if row["published"]]
    scored = [row for row in rows if row["outcome_status"] in ("hit", "miss")]
    published_scored = [row for row in scored if row["published"]]
    hits = sum(int(row["outcome_hit"] or 0) for row in published_scored)
    accuracy = hits / len(published_scored) if published_scored else None
    coverage = len(published_rows) / registered if registered else 0.0
    pending = sum(1 for row in rows if row["outcome_status"] is None)
    void = sum(1 for row in rows if row["outcome_status"] in ("void", "postponed"))

    brier_values = [float(row["outcome_brier"]) for row in published_scored if row["outcome_brier"] is not None]
    brier_all_values = [float(row["outcome_brier"]) for row in scored if row["outcome_brier"] is not None]

    thresholds = sorted({float(row["threshold"]) for row in rows if row["threshold"] is not None})
    policies = sorted({str(row["policy"]) for row in rows if row["policy"]})
    model_versions = sorted({str(row["model_version"]) for row in rows})
    last_reconciled = max(
        (row["reconciled_at"] for row in rows if row["reconciled_at"]), default=None
    )
    generated_at = utc_now()

    by_league: list[dict[str, Any]] = []
    for league_id, name in sorted(
        {(row["league_id"], row["league_name"] or row["league_id"]) for row in rows},
        key=lambda item: (-sum(1 for row in rows if row["league_id"] == item[0]), str(item[1])),
    ):
        group = [row for row in rows if row["league_id"] == league_id]
        group_published = [row for row in group if row["published"]]
        group_scored = [row for row in group if row["outcome_status"] in ("hit", "miss") and row["published"]]
        group_hits = sum(int(row["outcome_hit"] or 0) for row in group_scored)
        by_league.append(
            {
                "leagueId": league_id,
                "leagueName": name,
                "registered": len(group),
                "published": len(group_published),
                "scored": len(group_scored),
                "hits": group_hits,
                "accuracy": round(group_hits / len(group_scored), 6) if group_scored else None,
            }
        )

    buckets: list[dict[str, Any]] = []
    for label, low, high in BUCKETS:
        group = [row for row in rows if low <= float(row["confidence"]) < high]
        group_scored = [row for row in group if row["outcome_status"] in ("hit", "miss")]
        group_hits = sum(int(row["outcome_hit"] or 0) for row in group_scored)
        buckets.append(
            {
                "label": label,
                "from": low,
                "to": round(min(high, 1.0), 2),
                "registered": len(group),
                "scored": len(group_scored),
                "hits": group_hits,
                "accuracy": round(group_hits / len(group_scored), 6) if group_scored else None,
                "coverage": round(len(group) / registered, 6) if registered else 0.0,
            }
        )

    recent = []
    for row in sorted(
        [row for row in scored if row["published"]],
        key=lambda item: item["kickoff_utc"],
        reverse=True,
    )[:12]:
        recent.append(
            {
                "fixtureId": row["fixture_id"],
                "kickoff": row["kickoff_utc"],
                "league": row["league_name"] or row["league_id"],
                "home": row["home_team"],
                "away": row["away_team"],
                "pick": row["pick"],
                "confidence": round(float(row["confidence"]), 6),
                "result": row["outcome_result"],
                "hit": bool(row["outcome_hit"]),
                "brier": row["outcome_brier"],
                "homeGoals": row["outcome_home"],
                "awayGoals": row["outcome_away"],
            }
        )

    if not registered:
        empty_reason = (
            "Aún no hay pronósticos registrados. Ejecuta el productor live y el registro "
            "para guardar el primer snapshot antes del kickoff."
        )
    elif not published_rows:
        count_label = "pronóstico registrado" if registered == 1 else "pronósticos registrados"
        empty_reason = (
            f"Hay {registered} {count_label}, pero ninguno alcanzó el umbral de publicación "
            f"({', '.join(f'{threshold:.0%}' for threshold in thresholds) or 'sin umbral'}). "
            "El récord público queda vacío a propósito: no se publican picks de baja confianza."
        )
    elif not published_scored:
        empty_reason = (
            f"Hay {len(published_rows)} picks publicados y {pending} pendientes de resultado. "
            "El récord se completa cuando terminen los partidos."
        )
    else:
        empty_reason = None

    return {
        "schema": SCHEMA,
        "generatedAt": generated_at,
        "policy": policies[0] if len(policies) == 1 else ("mixta" if policies else None),
        "thresholds": thresholds,
        "modelVersions": model_versions,
        "registered": registered,
        "published": len(published_rows),
        "scored": len(scored),
        "publishedScored": len(published_scored),
        "hits": hits,
        "accuracy": round(accuracy, 6) if accuracy is not None else None,
        "coverage": round(coverage, 6),
        "ci95": _normal_interval(hits, len(published_scored)),
        "ci95Wilson": _wilson_interval(hits, len(published_scored)),
        "brier": round(sum(brier_values) / len(brier_values), 6) if brier_values else None,
        "brierAll": round(sum(brier_all_values) / len(brier_all_values), 6) if brier_all_values else None,
        "pending": pending,
        "void": void,
        "lastReconciledAt": last_reconciled,
        "byLeague": by_league,
        "buckets": buckets,
        "recent": recent,
        "emptyReason": empty_reason,
        "coverageBasis": "picks publicados / pronósticos registrados",
        "snapshotDir": "data/snapshots/forecasts",
    }


def export_record(
    record: dict[str, Any],
    *,
    json_path: Path = RECORD_JSON,
    js_path: Path = RECORD_JS,
) -> list[Path]:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    js_path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(record, ensure_ascii=False, indent=2, sort_keys=False)
    json_path.write_text(body + "\n", encoding="utf-8")
    js = (
        "// Generado por pipeline.reconcile_results. No editar a mano.\n"
        f"// generatedAt: {record['generatedAt']} · registrados: {record['registered']} · "
        f"publicados: {record['published']} · reconciliados: {record['publishedScored']}\n"
        f"export const RECORD = {body};\n"
    )
    js_path.write_text(js, encoding="utf-8")
    return [json_path, js_path]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    parser = argparse.ArgumentParser(description="Reconciliación y récord verificable MOTOR-NOX")
    parser.add_argument("--results", default=None, help="JSON con resultados oficiales")
    parser.add_argument("--db", default=str(DB_PATH))
    parser.add_argument("--source", default=None)
    parser.add_argument("--export", dest="export", action="store_true", default=True)
    parser.add_argument("--no-export", dest="export", action="store_false")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    init_db(Path(args.db))
    conn = get_connection(Path(args.db))
    try:
        stats = None
        if args.results:
            try:
                results = load_results(args.results)
            except (OSError, ValueError, json.JSONDecodeError) as error:
                print(f"No se pudo leer {args.results}: {error}", file=sys.stderr)
                return 2
            stats = reconcile_results(conn, results, source=args.source, dry_run=args.dry_run)
        record = compute_record(conn)
        if args.export and not args.dry_run:
            export_record(record)
    finally:
        conn.close()

    if args.json:
        payload = {"reconcile": stats, "record": record}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        if stats:
            print(
                f"Resultados: {stats['results']} leídos · {stats['matched']} pronósticos encontrados · "
                f"{stats['reconciled']} cerrados · {stats['updated']} corregidos · "
                f"{stats['skipped']} sin cambios · {len(stats['unmatched'])} sin pronóstico."
            )
        if record["publishedScored"]:
            print(
                f"Récord: {record['hits']}/{record['publishedScored']} aciertos · "
                f"publicados {record['published']}/{record['registered']} · "
                f"cobertura {record['coverage'] * 100:.1f}% · pendientes {record['pending']}."
            )
        else:
            print(
                f"Récord: sin picks publicados con resultado · "
                f"publicados {record['published']}/{record['registered']} · "
                f"pendientes {record['pending']} · cobertura {record['coverage'] * 100:.1f}%."
            )
        if record["emptyReason"]:
            print(f"Estado: {record['emptyReason']}")
    return 0 if not (stats and stats["rejected"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
