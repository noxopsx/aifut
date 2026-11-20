"""
MOTOR-NOX · Fase 0 · Congelar el baseline del ensamble.

Genera data/models/baseline_v1.json con las métricas del test actual y los
hashes de los artefactos que las produjeron. Sirve para comparar cada release
contra una foto inmutable: si un cambio no mejora el baseline, no se adopta.

Uso:
    python -m pipeline.freeze_baseline
    python -m pipeline.freeze_baseline --force
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from .db import BASE_DIR, DATA_DIR, utc_now

REPORT_PATH = DATA_DIR / "models" / "model_report.json"
CARDS_PATH = DATA_DIR / "models" / "model_cards.json"
DATASET_META_PATH = DATA_DIR / "features" / "dataset_meta.json"
MANIFEST_PATH = DATA_DIR / "manifest.json"
BASELINE_PATH = DATA_DIR / "models" / "baseline_v1.json"

SCHEMA = "motor-nox.baseline.v1"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_entry(path: Path, label: str) -> dict[str, Any]:
    if not path.exists():
        return {"label": label, "path": str(path.relative_to(BASE_DIR)), "exists": False}
    return {
        "label": label,
        "path": str(path.relative_to(BASE_DIR)),
        "exists": True,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_baseline(force: bool = False) -> dict[str, Any]:
    if not REPORT_PATH.exists():
        raise FileNotFoundError(
            "Falta data/models/model_report.json. Ejecuta primero: python -m pipeline.models"
        )
    if BASELINE_PATH.exists() and not force:
        raise FileExistsError(
            f"{BASELINE_PATH.relative_to(BASE_DIR)} ya existe. El baseline es inmutable; "
            "usa --force solo si estás creando una versión nueva y documentada."
        )

    report = _load_json(REPORT_PATH)
    dataset_meta = _load_json(DATASET_META_PATH) if DATASET_META_PATH.exists() else {}
    headline = report.get("headline", {})
    sample = report.get("sample", {})
    split = report.get("split", {})

    baseline = {
        "schema": SCHEMA,
        "id": "baseline_v1",
        "frozen_at": utc_now(),
        "description": (
            "Foto inmutable del ensamble MOTOR-NOX en el test temporal 2024-25 + 2025-26. "
            "Cualquier release posterior se compara contra estas métricas."
        ),
        "engine": report.get("engine"),
        "engineVersion": report.get("engineVersion"),
        "modelName": report.get("modelName"),
        "reportVersion": report.get("version"),
        "reportGeneratedAt": report.get("generatedAt"),
        "dataset": {
            "version": sample.get("feature_version") or dataset_meta.get("version"),
            "matches": dataset_meta.get("matches") or sample.get("test"),
            "features": dataset_meta.get("features"),
            "coreFeatures": dataset_meta.get("core_features"),
            "checksum": dataset_meta.get("checksum"),
        },
        "split": split,
        "sample": sample,
        "headline": {
            key: headline.get(key)
            for key in ("n", "hits", "accuracy", "logLoss", "brier", "ece", "skill", "ci")
        },
        "benchmark": report.get("benchmark"),
        "byLeague": report.get("byLeague"),
        "bySeason": report.get("bySeason"),
        "markets": report.get("markets"),
        "ensemble": report.get("ensemble"),
        "sources": [
            _source_entry(REPORT_PATH, "Informe del ensamble"),
            _source_entry(CARDS_PATH, "Model cards"),
            _source_entry(DATASET_META_PATH, "Metadatos del feature store"),
            _source_entry(MANIFEST_PATH, "Manifiesto de datos"),
        ],
        "acceptance": {
            "primary_metric": "brier",
            "rule": (
                "Un release se adopta solo si mejora el Brier del baseline sin empeorar log-loss "
                "y sin reducir la cobertura declarada."
            ),
        },
        "notes": [
            "Las métricas son del test temporal; no se recalibra ni se elige el umbral con este archivo.",
            "El baseline no se edita: para una nueva foto, crear baseline_v2.json con su propio --force.",
        ],
    }

    BASELINE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BASELINE_PATH.write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return baseline


def main(argv: list[str] | None = None) -> int:
    from .db import configure_stdio

    configure_stdio()
    parser = argparse.ArgumentParser(description="Congelar el baseline del ensamble MOTOR-NOX")
    parser.add_argument("--force", action="store_true", help="Sobrescribe baseline_v1.json")
    args = parser.parse_args(argv)
    try:
        baseline = build_baseline(force=args.force)
    except (FileNotFoundError, FileExistsError) as error:
        print(str(error), file=sys.stderr)
        return 1
    headline = baseline["headline"]
    print(
        f"Baseline congelado en {BASELINE_PATH.relative_to(BASE_DIR)}: "
        f"{headline['hits']}/{headline['n']} aciertos "
        f"({headline['accuracy'] * 100:.2f}%) · Brier {headline['brier']:.4f} · "
        f"log-loss {headline['logLoss']:.4f}."
    )
    print("Fuentes: " + ", ".join(f"{item['path']}" for item in baseline["sources"] if item["exists"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
