"""
MOTOR-NOX · Fase 0/1 · Registro del informe de modelos en SQLite.

Toma data/models/model_report.json y lo guarda en model_runs y model_versions
para que el baseline, las métricas y los pesos queden trazables desde la base.

Uso:
    python -m pipeline.record_model_run
    python -m pipeline.record_model_run --report data/models/model_report.json
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

from .db import DATA_DIR, configure_stdio, get_connection, init_db, utc_now

REPORT_PATH = DATA_DIR / "models" / "model_report.json"


def _compact_models(report: dict[str, Any]) -> list[dict[str, Any]]:
    compact = []
    for model in report.get("models", []):
        if not isinstance(model, dict):
            continue
        compact.append(
            {
                "id": model.get("id"),
                "label": model.get("label"),
                "family": model.get("family"),
                "features": model.get("features", []),
                "weights": model.get("weights", {}),
            }
        )
    return compact


def _metrics(report: dict[str, Any]) -> dict[str, Any]:
    headline = report.get("headline", {})
    markets = report.get("markets", {})
    return {
        "headline": {
            key: headline.get(key)
            for key in ("n", "hits", "accuracy", "logLoss", "brier", "ece", "skill", "ci")
        },
        "markets": {
            key: {
                metric: value.get(metric)
                for metric in ("n", "hits", "accuracy", "logLoss", "brier")
            }
            for key, value in markets.items()
            if isinstance(value, dict)
        },
        "split": report.get("split"),
    }


def record_model_run(
    conn: sqlite3.Connection | None = None,
    *,
    report_path: Path = REPORT_PATH,
) -> dict[str, Any]:
    close_conn = False
    if conn is None:
        init_db()
        conn = get_connection()
        close_conn = True
    try:
        if not report_path.exists():
            raise SystemExit(f"No existe {report_path}; genera el informe de modelos primero.")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        version = str(report.get("version") or "desconocida")
        generated_at = str(report.get("generatedAt") or utc_now())
        model_name = str(report.get("modelName") or "MOTOR-NOX")
        split = report.get("split") or {}
        train = split.get("train") or {}
        test = split.get("test") or {}
        feature_count = len(report.get("featureMetadata") or {})
        metrics = _metrics(report)
        features = {
            "members": (report.get("ensemble") or {}).get("members", []),
            "weights": (report.get("ensemble") or {}).get("weights", {}),
            "models": _compact_models(report),
            "feature_count": feature_count,
        }
        run_id = f"ensemble-{version}-{generated_at}"
        version_id = f"ensemble-{version}"
        metrics_json = json.dumps(metrics, ensure_ascii=False)
        features_json = json.dumps(features, ensure_ascii=False)

        with conn:
            conn.execute(
                """
                INSERT INTO model_versions (
                    id, name, version, engine, trained_at, feature_count,
                    metrics_json, active, created_at, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    trained_at = excluded.trained_at,
                    feature_count = excluded.feature_count,
                    metrics_json = excluded.metrics_json,
                    notes = excluded.notes
                """,
                (
                    version_id,
                    "MOTOR-NOX ensemble",
                    version,
                    str(report.get("engine") or "logit-ensemble"),
                    generated_at,
                    feature_count,
                    metrics_json,
                    generated_at,
                    "Informe histórico del ensamble; el motor live sigue usando Poisson + Dixon-Coles.",
                ),
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO model_runs (
                    id, model_name, version, features, train_start, train_end,
                    test_start, test_end, sample_train, sample_test, metrics, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    model_name,
                    version,
                    features_json,
                    str(train.get("from") or ""),
                    str(train.get("to") or ""),
                    str(test.get("from") or ""),
                    str(test.get("to") or ""),
                    int(train.get("matches") or 0),
                    int(test.get("matches") or 0),
                    metrics_json,
                    generated_at,
                ),
            )
        row = conn.execute("SELECT COUNT(*) AS n FROM model_runs").fetchone()
        print(
            f"Modelo registrado: {model_name} {version} · {row['n']} ejecuciones en model_runs · "
            f"{feature_count} features."
        )
        return {
            "run_id": run_id,
            "version_id": version_id,
            "version": version,
            "generated_at": generated_at,
            "model_runs": int(row["n"]),
        }
    finally:
        if close_conn:
            conn.close()


def main() -> None:
    configure_stdio()
    parser = argparse.ArgumentParser(description="MOTOR-NOX · registrar informe de modelos")
    parser.add_argument("--report", type=Path, default=REPORT_PATH)
    args = parser.parse_args()
    record_model_run(report_path=args.report)


if __name__ == "__main__":
    main()
