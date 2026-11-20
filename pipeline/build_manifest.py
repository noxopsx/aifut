"""
Manifest generation and data snapshotting for MOTOR-NOX V1.0.
Computes SHA256 checksums, validates lineage, and records coverage statistics.
"""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
from typing import Any

from .db import BASE_DIR, DATA_DIR, DB_PATH, get_connection
from .feature_catalog import CORE_FEATURE_GROUPS, FEATURE_CATALOG, catalog_entry
from .validate_data import validate_all

MANIFEST_PATH = DATA_DIR / "manifest.json"
SNAPSHOTS_DIR = DATA_DIR / "snapshots"


def compute_sha256(path: Path) -> str:
    """Calculate SHA256 checksum of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return bool(
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()
    )


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def build_manifest(conn: sqlite3.Connection | None = None) -> dict:
    """Generate manifest.json with data lineage, checksums, and quality metrics."""
    close_conn = False
    if conn is None:
        conn = get_connection()
        close_conn = True

    validation_report = validate_all(conn)

    # Compute checksums of all raw files. Large per-event caches are grouped so
    # the manifest stays readable while preserving an aggregate checksum.
    group_prefixes = {
        "raw/espn_lineups/": "ESPN historical lineup extracts (one JSON per event)",
        "raw/open_meteo/": "Open-Meteo daily weather extracts (one JSON per venue and date range)",
    }
    raw_files = {}
    raw_groups = {}
    all_raw = [
        p for p in (DATA_DIR / "raw").rglob("*")
        if p.is_file() and p.name != ".DS_Store"
    ]
    grouped_paths = set()
    for prefix, description in group_prefixes.items():
        members = sorted(
            p for p in all_raw
            if str(p.relative_to(DATA_DIR)).replace("\\", "/").startswith(prefix)
        )
        if not members:
            continue
        aggregate = hashlib.sha256()
        total_size = 0
        for p in members:
            rel = str(p.relative_to(DATA_DIR)).replace("\\", "/")
            file_hash = compute_sha256(p)
            aggregate.update(rel.encode("utf-8"))
            aggregate.update(b"\0")
            aggregate.update(file_hash.encode("ascii"))
            aggregate.update(b"\n")
            total_size += p.stat().st_size
            grouped_paths.add(p)
        raw_groups[prefix.rstrip("/")] = {
            "description": description,
            "files": len(members),
            "size_bytes": total_size,
            "sha256": aggregate.hexdigest(),
        }

    for p in all_raw:
        if p in grouped_paths:
            continue
        rel = str(p.relative_to(DATA_DIR)).replace("\\", "/")
        raw_files[rel] = {
            "size_bytes": p.stat().st_size,
            "sha256": compute_sha256(p),
        }

    # Database file checksum
    db_checksum = compute_sha256(DB_PATH) if DB_PATH.exists() else None

    # Load sources from DB
    sources = []
    for r in conn.execute("SELECT * FROM data_sources").fetchall():
        sources.append({
            "id": r["id"],
            "name": r["name"],
            "url": r["url"],
            "license": r["license"],
            "frequency": r["frequency"],
            "notes": r["notes"],
            "last_downloaded": r["last_downloaded"],
        })

    # Feature store lineage and audit summary. The manifest must make clear
    # whether the features are usable for modeling and whether leakage passed.
    feature_store = None
    dataset = conn.execute(
        "SELECT * FROM feature_datasets ORDER BY built_at DESC LIMIT 1"
    ).fetchone()
    if dataset:
        coverage_rows = conn.execute(
            "SELECT * FROM feature_coverage WHERE dataset_version = ?",
            (dataset["version"],),
        ).fetchall()
        coverage_by_feature = {row["feature"]: dict(row) for row in coverage_rows}
        core_groups = {}
        for group, description in CORE_FEATURE_GROUPS.items():
            members = [
                name for name in FEATURE_CATALOG
                if catalog_entry(name)["group"] == group and catalog_entry(name)["model_usable"]
            ]
            if not members:
                continue
            min_coverage = min(
                coverage_by_feature.get(name, {}).get("coverage_pct", 0.0)
                for name in members
            )
            min_usable = min(
                coverage_by_feature.get(name, {}).get("model_usable_pct", 0.0)
                for name in members
            )
            core_groups[group] = {
                "description": description,
                "features": len(members),
                "min_coverage_pct": min_coverage,
                "min_model_usable_pct": min_usable,
                "pass": min_coverage >= 80.0,
            }
        coverage_status = (
            "PASS" if core_groups and all(item["pass"] for item in core_groups.values())
            else "FAIL"
        )

        audit_path = DATA_DIR / "features" / "leakage_audit.json"
        distribution_path = DATA_DIR / "features" / "distribution_report.json"
        audit = json.loads(audit_path.read_text(encoding="utf-8")) if audit_path.exists() else {}
        distribution = (
            json.loads(distribution_path.read_text(encoding="utf-8"))
            if distribution_path.exists() else {}
        )
        feature_files = {}
        for label, path in (
            ("csv", DATA_DIR / "features" / f"feature_store_{dataset['version']}.csv"),
            ("jsonl_gz", DATA_DIR / "features" / f"feature_store_{dataset['version']}.jsonl.gz"),
            ("coverage", DATA_DIR / "features" / "coverage.json"),
            ("dataset_meta", DATA_DIR / "features" / "dataset_meta.json"),
            ("web_features", DATA_DIR / "features" / "web_features.json"),
            ("dictionary", DATA_DIR / "FEATURE_DICTIONARY.md"),
            ("leakage_audit", audit_path),
            ("distribution_report", distribution_path),
        ):
            if not path.exists():
                continue
            feature_files[label] = {
                "file": str(path.relative_to(DATA_DIR)).replace("\\", "/"),
                "size_bytes": path.stat().st_size,
                "sha256": compute_sha256(path),
            }

        feature_store = {
            "version": dataset["version"],
            "built_at": dataset["built_at"],
            "match_count": dataset["match_count"],
            "feature_count": dataset["feature_count"],
            "core_feature_count": dataset["core_feature_count"],
            "checksum": dataset["checksum"],
            "coverage_status": coverage_status,
            "target_coverage_pct": 80.0,
            "core_groups": core_groups,
            "leakage_audit": {
                "status": audit.get("status"),
                "failure_count": audit.get("failure_count"),
                "checked_at": audit.get("checked_at"),
                "rules": audit.get("rules", []),
            },
            "distribution": {
                "applied_matches": distribution.get("model_before_after", {}).get("applied_matches"),
                "meaningful_changed_pct": distribution.get("model_before_after", {}).get("meaningful_changed_pct"),
                "mean_abs_p_home_change": distribution.get("model_before_after", {}).get("mean_abs_p_home_change"),
                "raw_vs_rolling_correlation": distribution.get("raw_xg_vs_rolling", {}).get("correlation_raw_vs_rolling"),
                "paired_matches": distribution.get("raw_xg_vs_rolling", {}).get("paired_matches"),
            },
            "files": feature_files,
            "note": (
                "Una fila por partido. Cada feature lleva value, quality, source, as_of y "
                "usable_for_model. xG, Elo y medias de liga son estimated aunque sean usables. "
                "El mercado y el clima retrospectivo no son usables."
            ),
        }

    # Section 3 model artifacts. The manifest records checksums and the
    # headline test metrics so the report published to the UI is traceable.
    models = None
    model_report_path = DATA_DIR / "models" / "model_report.json"
    if model_report_path.exists():
        report = json.loads(model_report_path.read_text(encoding="utf-8"))
        model_files = {}
        for label, path in (
            ("report", model_report_path),
            ("cards", DATA_DIR / "models" / "model_cards.json"),
            ("cards_md", DATA_DIR / "models" / "MODEL_CARDS.md"),
            ("poisson_baseline", DATA_DIR / "models" / "poisson_baseline.json"),
            ("historical_matches", DATA_DIR / "models" / "historical_matches.json"),
            ("web_report", BASE_DIR / "js" / "data" / "model_report.js"),
        ):
            if not path.exists():
                continue
            model_files[label] = {
                "file": str(path.relative_to(BASE_DIR)).replace("\\", "/"),
                "size_bytes": path.stat().st_size,
                "sha256": compute_sha256(path),
            }
        headline = report.get("headline", {})
        poisson = headline.get("poisson", {})
        models = {
            "version": report.get("version"),
            "generated_at": report.get("generatedAt"),
            "model_name": report.get("modelName"),
            "title": report.get("title"),
            "split": report.get("split"),
            "headline": {
                "market": "1x2",
                "n": headline.get("n"),
                "hits": headline.get("hits"),
                "accuracy": headline.get("accuracy"),
                "log_loss": headline.get("logLoss"),
                "brier": headline.get("brier"),
                "ece": headline.get("ece"),
                "skill": headline.get("skill"),
                "ci": headline.get("ci"),
            },
            "poisson": {
                "n": poisson.get("n"),
                "hits": poisson.get("hits"),
                "accuracy": poisson.get("accuracy"),
                "log_loss": poisson.get("logLoss"),
                "brier": poisson.get("brier"),
            },
            "markets": {
                key: {
                    "n": value.get("n"),
                    "hits": value.get("hits"),
                    "accuracy": value.get("accuracy"),
                    "log_loss": value.get("logLoss"),
                    "brier": value.get("brier"),
                }
                for key, value in report.get("markets", {}).items()
            },
            "fallback": report.get("fallback", {}).get("policy"),
            "files": model_files,
            "note": (
                "El ensamble es el headline del informe; el Poisson calibrado sigue "
                "siendo el núcleo explicable y el fallback. El mercado de cierre solo "
                "se usa como referencia externa, nunca como feature."
            ),
        }

    # Fase 1: catálogo operativo de competiciones y calendario. Es independiente
    # del store histórico: aquí se mide cobertura de calendario, no precisión.
    phase1 = None
    if _table_exists(conn, "competitions"):
        tier_rows = conn.execute(
            "SELECT tier, COUNT(*) AS n, SUM(active) AS active FROM competitions GROUP BY tier"
        ).fetchall()
        by_tier = {
            row["tier"]: {"total": int(row["n"]), "active": int(row["active"] or 0)}
            for row in tier_rows
        }
        competition_total = sum(item["total"] for item in by_tier.values())
        competition_active = sum(item["active"] for item in by_tier.values())
        seasons_total = 0
        if _table_exists(conn, "seasons"):
            seasons_total = int(conn.execute("SELECT COUNT(*) AS n FROM seasons").fetchone()["n"])
        fixtures_total = 0
        by_status: dict[str, int] = {}
        with_calendar = 0
        ab_with_calendar = 0
        if _table_exists(conn, "fixtures"):
            fixtures_total = int(conn.execute("SELECT COUNT(*) AS n FROM fixtures").fetchone()["n"])
            by_status = {
                row["status"]: int(row["n"])
                for row in conn.execute(
                    "SELECT status, COUNT(*) AS n FROM fixtures GROUP BY status"
                ).fetchall()
            }
            with_calendar = int(
                conn.execute("SELECT COUNT(DISTINCT competition_id) AS n FROM fixtures").fetchone()["n"]
            )
            ab_with_calendar = int(
                conn.execute(
                    """
                    SELECT COUNT(DISTINCT f.competition_id) AS n
                    FROM fixtures f
                    JOIN competitions c ON c.id = f.competition_id
                    WHERE c.tier IN ('A', 'B')
                    """
                ).fetchone()["n"]
            )
        latest_sync = None
        if _table_exists(conn, "sync_state"):
            row = conn.execute(
                "SELECT * FROM sync_state WHERE id = 'fixtures_window' ORDER BY last_finished_at DESC LIMIT 1"
            ).fetchone()
            if row:
                latest_sync = {
                    "status": row["status"],
                    "last_finished_at": row["last_finished_at"],
                    "events": row["events"],
                    "inserted": row["inserted"],
                    "updated": row["updated"],
                    "errors": row["errors"],
                    "window_from": row["window_from"],
                    "window_to": row["window_to"],
                }
        coverage = _load_json(DATA_DIR / "coverage.json", {})
        scheduler = _load_json(BASE_DIR / ".cache" / "sync_operativo_state.json", {})
        phase1_files = {}
        for label, path in (
            ("competitions", DATA_DIR / "competitions.json"),
            ("fixtures", DATA_DIR / "fixtures.json"),
            ("apiFixtures", DATA_DIR / "api_fixtures.json"),
            ("freeApiFixtures", DATA_DIR / "free_api_fixtures.json"),
            ("freeApiStandings", DATA_DIR / "free_api_standings.json"),
            ("faorgFixtures", DATA_DIR / "faorg_fixtures.json"),
            ("faorgStandings", DATA_DIR / "faorg_standings.json"),
            ("coverage", DATA_DIR / "coverage.json"),
            ("alerts", DATA_DIR / "alerts.json"),
        ):
            if not path.exists():
                continue
            phase1_files[label] = {
                "file": str(path.relative_to(DATA_DIR)).replace("\\", "/"),
                "size_bytes": path.stat().st_size,
                "sha256": compute_sha256(path),
            }
        # Fase 2: integración de partidos desde API-Football v3 plan Free.
        # Nunca se escribe la clave aquí: sólo metadatos agregados y checksums.
        api_football = None
        api_fixtures_json = _load_json(DATA_DIR / "api_fixtures.json", {})
        api_count = 0
        if _table_exists(conn, "api_fixtures"):
            api_count = int(conn.execute("SELECT COUNT(*) AS n FROM api_fixtures").fetchone()["n"])
        scheduler_steps = (scheduler.get("stats") or {}).get("steps") or {}
        api_step = scheduler_steps.get("apiFootball") or {}
        ui_fixtures = _load_json(DATA_DIR / "fixtures.json", {})
        api_football = {
            "enabled": bool(api_step) or bool(api_fixtures_json),
            "provider": "api-football-v3",
            "plan": api_step.get("plan") or api_fixtures_json.get("plan") or "free",
            "scope": "Partidos diarios (±1 día) y en directo; backfill de temporadas 2022..2024.",
            "fixtures": api_count,
            "lastRunEvents": api_step.get("events"),
            "budget": api_step.get("budget"),
            "uiMergedFixtures": (ui_fixtures.get("sources") or {}).get("api_football", 0),
            "keyStorage": "APISPORTS_KEY (entorno) o caché local privada; nunca en código ni manifiesto",
            "note": (
                "Los partidos de API-Football se guardan en api_fixtures y se fusionan en "
                "fixtures.json con deduplicación. La cobertura A/B de Fase 1 sigue midiéndose "
                "sólo sobre la tabla fixtures (ESPN)."
            ),
        }

        # Fase 3: APIs gratuitas adicionales (football-data.org, footballapi.org).
        # `source_status.json` se genera sin claves: aquí se registran sólo
        # source / quality / as_of / events / plan / budget.
        status_payload = _load_json(DATA_DIR / "source_status.json", {})
        free_apis = {
            key: {
                "source": info.get("source"),
                "configured": info.get("configured"),
                "status": info.get("status"),
                "quality": info.get("quality"),
                "as_of": info.get("as_of"),
                "events": info.get("events"),
                "plan": info.get("plan"),
                "budget": info.get("budget"),
            }
            for key, info in (status_payload.get("providers") or {}).items()
        }

        phase1 = {
            "status": coverage.get("status", "UNKNOWN"),
            "generated_at": coverage.get("generatedAt"),
            "competitions": {
                "total": competition_total,
                "active": competition_active,
                "byTier": by_tier,
                "withCalendar": with_calendar,
                "tierABWithCalendar": ab_with_calendar,
            },
            "seasons": seasons_total,
            "fixtures": {
                "total": fixtures_total,
                "byStatus": by_status,
                "window": coverage.get("fixtures", {}),
                "lastSync": latest_sync,
            },
            "abCoverage": coverage.get("abCoverage", {}),
            "quality": coverage.get("quality", {}),
            "freshness": coverage.get("freshness", {}),
            "alerts": coverage.get("alerts", []),
            "scheduler": {
                "lastRunAt": scheduler.get("lastRunAt"),
                "status": scheduler.get("status"),
                "matchday": scheduler.get("matchday"),
                "cadenceMinutes": scheduler.get("cadenceMinutes"),
            },
            "files": phase1_files,
            "apiFootball": api_football,
            "freeApis": free_apis,
            "note": (
                "El catálogo y los fixtures son operativos y no sustituyen el store "
                "histórico del modelo. Un tier C tiene calendario, pero no pick. "
                "La cobertura se mide contra los eventos de la fuente en la ventana."
            ),
        }

    manifest = {
        "version": "2.6.0",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "description": "MOTOR-NOX V1.0 historical store (features-2.2.0) + Phase 1 competition/fixture catalog + Fase 2 API-Football v3 Free + Fase 3 football-data.org y footballapi.org (planes gratuitos)",
        "pilot_leagues": [
            {"id": "eng.1", "name": "Premier League", "country": "England", "tier": 1},
            {"id": "esp.1", "name": "LaLiga", "country": "Spain", "tier": 1},
        ],
        "seasons_covered": ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26", "2026-27"],
        "acceptance_criteria": {
            "historical_results": "100% achieved",
            "xg_coverage_pilot": ">=90% target",
            "odds_coverage_pilot": ">=80% target",
            "lineup_coverage_pilot": ">=80% target",
            "feature_coverage_core": ">=80% target",
            "feature_leakage_audit": "PASS required",
            "zero_duplicates": True,
            "zero_unmapped_teams": True,
            "zero_negative_goals": True,
            "competitions_with_calendar": ">=60 target",
            "tier_ab_competitions": ">=20 target",
            "fixtures_duplicates": 0,
            "matchday_latency_minutes": "<=15 target",
            "season_2026_27_imported": "100% target",
            "utf8_mojibake": 0,
        },
        "quality_audit": {
            "status": validation_report["status"],
            "issues": validation_report["issues"],
            "summary": validation_report["summary"],
            "coverage_by_season": validation_report["coverage_by_season"],
        },
        "feature_store": feature_store,
        "models": models,
        "phase1": phase1,
        "sources": sources,
        "database": {
            "file": "data/database.sqlite",
            "format": "SQLite3 WAL mode",
            "sha256": db_checksum,
        },
        "raw_artifacts": raw_files,
        "raw_artifact_groups": raw_groups,
        "lineup_source": "ESPN summary rosters: starters, substitutes, shirt number and formation. ESPN does not publish official minutes in this payload; minutes_played stays NULL.",
    }

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"Manifest generated successfully at: {MANIFEST_PATH}")

    if close_conn:
        conn.close()

    return manifest


if __name__ == "__main__":
    build_manifest()
