"""
MOTOR-NOX · Fase 0 · Registro inmutable de pronósticos.

Cada pronóstico se guarda antes del kickoff con:
  * probabilidades 1X2 normalizadas,
  * decisión (pick, confianza, umbral y si se publica),
  * snapshot canónico en JSON con hash SHA-256,
  * versión de modelo y fuente.

El registro es idempotente por (fixture_id, model_version): volver a ejecutar
el productor no duplica ni reescribe nada. La tabla forecasts es inmutable;
cualquier corrección exige una nueva versión de modelo.

Uso:
    python -m pipeline.forecast_registry --input data/live_forecasts.json
    python -m pipeline.forecast_registry --input data/live_forecasts.json --dry-run
    python -m pipeline.forecast_registry --input - --model-version live-poisson-1.0
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .db import BASE_DIR, DATA_DIR, DB_PATH, configure_stdio, get_connection, init_db, utc_now

SCHEMA = "motor-nox.forecast.v1"
DEFAULT_MODEL_VERSION = "live-poisson-1.0"
DEFAULT_THRESHOLD = 0.70
SNAPSHOT_DIR = DATA_DIR / "snapshots" / "forecasts"
PICK_BY_OUTCOME = {"home": "1", "draw": "X", "away": "2"}
OUTCOME_BY_PICK = {"1": "home", "X": "draw", "2": "away"}


# ---------------------------------------------------------------------------
# Utilidades canónicas
# ---------------------------------------------------------------------------
def canonical_json(payload: Any) -> str:
    """JSON estable: claves ordenadas, sin espacios y UTF-8 sin escapar."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_kickoff(value: Any) -> datetime:
    if not value:
        raise ValueError("falta kickoff_utc")
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as error:
        raise ValueError(f"kickoff_utc inválido: {value!r}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def normalize_probabilities(probabilities: dict[str, Any]) -> dict[str, float]:
    keys = ("home", "draw", "away")
    missing = [key for key in keys if key not in probabilities]
    if missing:
        raise ValueError(f"faltan probabilidades: {', '.join(missing)}")
    values: dict[str, float] = {}
    for key in keys:
        try:
            number = float(probabilities[key])
        except (TypeError, ValueError) as error:
            raise ValueError(f"probabilidad no numérica en {key}") from error
        if not math.isfinite(number) or number < 0 or number > 1:
            raise ValueError(f"probabilidad fuera de [0, 1] en {key}: {number}")
        values[key] = number
    total = sum(values.values())
    if total <= 0:
        raise ValueError("las probabilidades suman 0")
    if abs(total - 1.0) > 0.01:
        raise ValueError(f"las probabilidades suman {total:.6f}; se exige 1 ± 0,01")
    return {key: round(value / total, 12) for key, value in values.items()}


def derive_pick(probabilities: dict[str, float]) -> str:
    """Pick determinista: empate técnico se resuelve por orden home, draw, away."""
    home, draw, away = probabilities["home"], probabilities["draw"], probabilities["away"]
    if home >= draw and home >= away:
        return "1"
    if away >= draw:
        return "2"
    return "X"


def normalize_fixture_id(value: Any) -> str:
    fixture_id = str(value or "").strip()
    if not fixture_id:
        raise ValueError("falta fixture_id")
    if len(fixture_id) > 120:
        raise ValueError("fixture_id demasiado largo")
    return fixture_id


def forecast_id_for(fixture_id: str, model_version: str) -> str:
    return "fc_" + sha256_text(f"{fixture_id}|{model_version}")[:20]


# ---------------------------------------------------------------------------
# Modelo y snapshot
# ---------------------------------------------------------------------------
def ensure_model_version(
    conn: sqlite3.Connection,
    model_version: str,
    *,
    name: str = "MOTOR-NOX live",
    engine: str = "poisson-dixon-coles",
    engine_version: str | None = None,
    metrics: dict | None = None,
    trained_at: str | None = None,
    notes: str | None = None,
) -> None:
    """Crea la fila de la versión de modelo si no existe (no la modifica)."""
    payload = dict(metrics or {})
    if engine_version:
        payload.setdefault("engineVersion", engine_version)
    conn.execute(
        """
        INSERT OR IGNORE INTO model_versions
            (id, name, version, engine, trained_at, metrics_json, created_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            model_version,
            name,
            model_version,
            engine,
            trained_at,
            canonical_json(payload) if payload else None,
            utc_now(),
            notes,
        ),
    )


def build_forecast(
    item: dict[str, Any],
    *,
    model_version: str,
    threshold: float | None,
    source: str,
    policy: str,
    publish_mode: str = "threshold",
    now: datetime | None = None,
    allow_past: bool = False,
) -> dict[str, Any]:
    """Valida un ítem de entrada y devuelve la fila + snapshot listos para insertar."""
    now = now or datetime.now(timezone.utc)
    fixture_id = normalize_fixture_id(item.get("fixture_id") or item.get("fixtureId") or item.get("id"))

    kickoff = parse_kickoff(item.get("kickoff_utc") or item.get("kickoff") or item.get("date"))
    if not allow_past and kickoff <= now:
        raise ValueError("el kickoff ya pasó: un pronóstico live debe registrarse antes del partido")

    raw_probs = item.get("probabilities") or {
        "home": item.get("p_home"),
        "draw": item.get("p_draw"),
        "away": item.get("p_away"),
    }
    probabilities = normalize_probabilities(raw_probs)
    pick = derive_pick(probabilities)
    declared_pick = item.get("pick")
    if declared_pick not in (None, ""):
        declared = str(declared_pick).strip()
        if declared not in ("1", "X", "2"):
            raise ValueError(f"pick inválido: {declared_pick!r}")
        if declared != pick:
            raise ValueError(f"pick {declared} no coincide con la probabilidad máxima ({pick})")

    home_team = str(item.get("home_team") or item.get("homeTeam") or "").strip()
    away_team = str(item.get("away_team") or item.get("awayTeam") or "").strip()
    if not home_team or not away_team:
        raise ValueError("faltan home_team o away_team")

    confidence = max(probabilities.values())
    if threshold is not None and not (0 <= float(threshold) <= 1):
        raise ValueError("threshold fuera de [0, 1]")
    threshold_value = float(threshold) if threshold is not None else None

    if source == "test":
        published = 0
    elif publish_mode == "all":
        published = 1
    elif publish_mode == "none":
        published = 0
    else:
        published = int(threshold_value is not None and confidence + 1e-12 >= threshold_value)

    created_at = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    fid = forecast_id_for(fixture_id, model_version)

    feature_hash = item.get("feature_hash")
    if feature_hash is None and isinstance(item.get("features"), (dict, list)):
        feature_hash = sha256_text(canonical_json(item["features"]))

    snapshot = {
        "schema": SCHEMA,
        "forecast_id": fid,
        "fixture": {
            "id": fixture_id,
            "league_id": item.get("league_id") or item.get("leagueId"),
            "league_name": item.get("league_name") or item.get("competition"),
            "season": item.get("season"),
            "kickoff_utc": kickoff.isoformat().replace("+00:00", "Z"),
            "home_team": home_team,
            "away_team": away_team,
        },
        "model": {
            "version": model_version,
            "engine": item.get("engine") or "poisson-dixon-coles",
            "engine_version": item.get("engine_version"),
        },
        "probabilities": probabilities,
        "decision": {
            "pick": pick,
            "confidence": round(confidence, 12),
            "threshold": threshold_value,
            "published": bool(published),
            "policy": policy,
        },
        "input": {
            "source": source,
            "feature_hash": feature_hash,
        },
        "created_at": created_at,
    }
    snapshot_json = canonical_json(snapshot)
    row = {
        "id": fid,
        "fixture_id": fixture_id,
        "league_id": snapshot["fixture"]["league_id"],
        "league_name": snapshot["fixture"]["league_name"],
        "season": snapshot["fixture"]["season"],
        "kickoff_utc": snapshot["fixture"]["kickoff_utc"],
        "home_team": home_team,
        "away_team": away_team,
        "model_version": model_version,
        "p_home": probabilities["home"],
        "p_draw": probabilities["draw"],
        "p_away": probabilities["away"],
        "pick": pick,
        "confidence": snapshot["decision"]["confidence"],
        "threshold": threshold_value,
        "published": published,
        "policy": policy,
        "source": source,
        "feature_hash": feature_hash,
        "snapshot_hash": sha256_text(snapshot_json),
        "snapshot_json": snapshot_json,
        "created_at": created_at,
    }
    return row


# ---------------------------------------------------------------------------
# Registro
# ---------------------------------------------------------------------------
def _write_snapshot(row: dict[str, Any], directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{row['id']}.json"
    if not path.exists():
        temp = path.with_suffix(".json.tmp")
        temp.write_text(row["snapshot_json"] + "\n", encoding="utf-8")
        temp.replace(path)
    return path


def register_forecasts(
    conn: sqlite3.Connection,
    items: Iterable[dict[str, Any]],
    *,
    model_version: str = DEFAULT_MODEL_VERSION,
    threshold: float | None = DEFAULT_THRESHOLD,
    source: str = "live",
    policy: str | None = None,
    publish_mode: str = "threshold",
    allow_past: bool = False,
    write_files: bool = True,
    snapshot_dir: Path = SNAPSHOT_DIR,
    dry_run: bool = False,
    now: datetime | None = None,
    model_name: str = "MOTOR-NOX live",
) -> dict[str, Any]:
    """Valida e inserta pronósticos. Devuelve un resumen reproducible."""
    if publish_mode not in ("threshold", "all", "none"):
        raise ValueError("publish_mode debe ser threshold, all o none")
    effective_policy = policy or (
        f"threshold>={threshold:.2f}" if threshold is not None and publish_mode == "threshold" else publish_mode
    )
    now = now or datetime.now(timezone.utc)
    ensure_model_version(conn, model_version, name=model_name)

    stats: dict[str, Any] = {
        "input": 0,
        "inserted": 0,
        "skipped": 0,
        "rejected": [],
        "published": 0,
        "model_version": model_version,
        "threshold": threshold,
        "source": source,
        "policy": effective_policy,
        "dry_run": dry_run,
    }

    for item in items:
        stats["input"] += 1
        try:
            row = build_forecast(
                item,
                model_version=model_version,
                threshold=threshold,
                source=source,
                policy=effective_policy,
                publish_mode=publish_mode,
                now=now,
                allow_past=allow_past,
            )
        except ValueError as error:
            stats["rejected"].append(
                {"fixture_id": item.get("fixture_id") or item.get("id"), "error": str(error)}
            )
            continue

        exists = conn.execute(
            "SELECT 1 FROM forecasts WHERE fixture_id = ? AND model_version = ?",
            (row["fixture_id"], model_version),
        ).fetchone()
        if exists:
            stats["skipped"] += 1
            continue

        if dry_run:
            stats["inserted"] += 1
            stats["published"] += row["published"]
            continue

        try:
            conn.execute(
                """
                INSERT INTO forecasts
                    (id, fixture_id, league_id, league_name, season, kickoff_utc,
                     home_team, away_team, model_version, p_home, p_draw, p_away,
                     pick, confidence, threshold, published, policy, source,
                     feature_hash, snapshot_hash, snapshot_json, created_at)
                VALUES
                    (:id, :fixture_id, :league_id, :league_name, :season, :kickoff_utc,
                     :home_team, :away_team, :model_version, :p_home, :p_draw, :p_away,
                     :pick, :confidence, :threshold, :published, :policy, :source,
                     :feature_hash, :snapshot_hash, :snapshot_json, :created_at)
                """,
                row,
            )
        except sqlite3.IntegrityError as error:
            stats["rejected"].append({"fixture_id": row["fixture_id"], "error": str(error)})
            continue

        if write_files:
            _write_snapshot(row, snapshot_dir)
        stats["inserted"] += 1
        stats["published"] += row["published"]

    if not dry_run:
        conn.commit()
    return stats


# ---------------------------------------------------------------------------
# Lectura
# ---------------------------------------------------------------------------
def load_forecast_items(path: Path | str) -> list[dict[str, Any]]:
    if str(path) == "-":
        payload = json.load(sys.stdin)
    else:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("forecasts", "items", "predictions"):
            if isinstance(payload.get(key), list):
                return payload[key]
    raise ValueError("el archivo debe ser una lista o un objeto con 'forecasts'")


def pending_forecasts(conn: sqlite3.Connection, *, published_only: bool = False) -> list[sqlite3.Row]:
    query = """
        SELECT f.*
        FROM forecasts f
        LEFT JOIN forecast_outcomes o ON o.forecast_id = f.id
        WHERE o.forecast_id IS NULL
    """
    if published_only:
        query += " AND f.published = 1"
    query += " ORDER BY f.kickoff_utc"
    return list(conn.execute(query))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _print_summary(stats: dict[str, Any]) -> None:
    rejected = len(stats["rejected"])
    print(
        "Registro: "
        f"{stats['input']} recibidos · "
        f"{stats['inserted']} insertados · "
        f"{stats['skipped']} ya existían · "
        f"{rejected} rechazados · "
        f"{stats['published']} publicados "
        f"(modelo {stats['model_version']}, umbral {stats['threshold']}, política {stats['policy']})."
    )
    for item in stats["rejected"][:10]:
        print(f"  rechazado {item['fixture_id']}: {item['error']}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    parser = argparse.ArgumentParser(description="Registro inmutable de pronósticos MOTOR-NOX")
    parser.add_argument("--input", required=True, help="JSON con pronósticos, o - para stdin")
    parser.add_argument("--db", default=str(DB_PATH), help="Ruta de la base SQLite")
    parser.add_argument("--model-version", default=DEFAULT_MODEL_VERSION)
    parser.add_argument("--model-name", default="MOTOR-NOX live")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--policy", default=None, help="Etiqueta de la política de publicación")
    parser.add_argument("--source", default="live", choices=["live", "backfill", "test"])
    parser.add_argument("--publish-mode", default="threshold", choices=["threshold", "all", "none"])
    parser.add_argument("--allow-past", action="store_true", help="Permite kickoff pasado (solo backfill/test)")
    parser.add_argument("--no-files", action="store_true", help="No escribir snapshots en data/snapshots/forecasts")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true", help="Imprime el resumen completo en JSON")
    args = parser.parse_args(argv)

    try:
        items = load_forecast_items(args.input)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"No se pudo leer {args.input}: {error}", file=sys.stderr)
        return 2

    db_path = Path(args.db)
    init_db(db_path)
    conn = get_connection(db_path)
    try:
        stats = register_forecasts(
            conn,
            items,
            model_version=args.model_version,
            model_name=args.model_name,
            threshold=args.threshold,
            policy=args.policy,
            source=args.source,
            publish_mode=args.publish_mode,
            allow_past=args.allow_past,
            write_files=not args.no_files,
            dry_run=args.dry_run,
        )
    finally:
        conn.close()

    if args.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
    else:
        _print_summary(stats)
    return 0 if not stats["rejected"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
