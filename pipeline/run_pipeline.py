"""
Master pipeline runner for MOTOR-NOX V1.0.

Usage:
    python -m pipeline.run_pipeline --all
    python -m pipeline.run_pipeline --validate
    python -m pipeline.run_pipeline --weather
    python -m pipeline.run_pipeline --features
    python -m pipeline.run_pipeline --audit
    python -m pipeline.run_pipeline --models
    python -m pipeline.run_pipeline --manifest
    python -m pipeline.run_pipeline --competitions
    python -m pipeline.run_pipeline --fixtures
    python -m pipeline.run_pipeline --coverage
    python -m pipeline.run_pipeline --model-run
    python -m pipeline.run_pipeline --phase1
    python -m pipeline.run_pipeline --features --audit --models --manifest
"""

import argparse
from datetime import datetime, timezone
import sys

from .audit_features import audit_dataset, distribution_report
from .build_features import build_features
from .build_manifest import build_manifest
from .db import get_connection, init_db
from .ingest_competitions import ingest_competitions
from .ingest_fixtures import coverage_report, ingest_fixtures
from .ingest_lineups import ingest_all_lineups
from .ingest_weather import ingest_weather
from .record_model_run import record_model_run
from .validate_data import print_report, validate_all
from .venues import populate_venues


def run_full_pipeline() -> None:
    """Execute complete end-to-end data pipeline."""
    # pandas/requests solo son necesarios para las fuentes históricas
    # Football-Data/Understat. Se importan aquí para que los comandos de
    # clima, features, auditoría y manifiesto funcionen con la librería estándar.
    from .ingest_football_data import ingest_all
    from .ingest_xg import ingest_xg

    print("=" * 80)
    print("STARTING MOTOR-NOX V1.0 DATA PIPELINE")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}")
    print("=" * 80)

    print("\n[Step 1/9] Initializing SQLite schema and registering data sources...")
    init_db()

    conn = get_connection()
    try:
        print("\n[Step 2/9] Populating stadiums and geo-spatial coordinates...")
        venues_count = populate_venues(conn)
        print(f"Loaded {venues_count} venues.")

        print("\n[Step 3/9] Ingesting Football-Data.co.uk (scores, stats, closing odds)...")
        ingest_all(conn)

        print("\n[Step 4/9] Ingesting Understat expected goals (xG, xGA, deep, PPDA)...")
        ingest_xg(conn)

        print("\n[Step 5/9] Ingesting historical ESPN lineups (starters, subs, formation)...")
        lineup_totals = ingest_all_lineups(conn)
        print(
            f"Lineups: {lineup_totals['matches_with_lineups']:,} matches · "
            f"{lineup_totals['lineups']:,} rows · "
            f"{lineup_totals['unique_players']:,} players."
        )

        print("\n[Step 6/9] Ingesting Open-Meteo daily weather for every venue...")
        weather = ingest_weather(conn)
        print(
            f"Weather: {weather['rows_inserted']:,} rows · "
            f"{weather['start_date']} → {weather['end_date']} · {weather['status']}."
        )

        print("\n[Step 7/9] Building the pre-match feature store...")
        features = build_features()
        print(
            f"Features: {features['matches']:,} matches · "
            f"{features['features']} features · cobertura en data/features/coverage.json."
        )

        print("\n[Step 8/9] Auditing leakage, comparing distributions and validating data...")
        audit = audit_dataset(conn, features["version"])
        distribution = distribution_report(conn, features["version"])
        print(
            f"Leakage audit: {audit['status']} · "
            f"{audit.get('failure_count', 0)} fallos · "
            f"{audit.get('summary', {}).get('usable', 0):,} entradas usables."
        )
        print(
            f"Distribution: {distribution['model_before_after']['applied_matches']:,} partidos comparados · "
            f"{distribution['model_before_after']['meaningful_changed_pct']:.1f}% con cambio >= 0.005."
        )

        report = validate_all(conn)
        print_report(report)

        print("\n[Step 9/9] Training Section 3 models and writing the ensemble report...")
        run_models()

        print("\n[Fase 1] Catálogo de competiciones, fixtures y cobertura...")
        catalog = ingest_competitions(conn=conn)
        fixtures = ingest_fixtures(conn=conn, mode="window")
        coverage = coverage_report(conn=conn)
        print(
            f"Catálogo: {catalog.get('total')} competiciones · {catalog.get('active')} activas · "
            f"tiers {catalog.get('byTier')}."
        )
        print(
            f"Fixtures: {fixtures.get('inserted')} nuevos · {fixtures.get('updated')} actualizados · "
            f"{fixtures.get('errors')} errores."
        )
        print(
            f"Cobertura: {coverage.get('status')} · A/B {coverage.get('abCoverage', {}).get('coveragePct')}%."
        )
        record_model_run(conn=conn)

        manifest = build_manifest(conn)
        print(f"\nPipeline successfully completed! Total matches in store: {manifest['quality_audit']['summary']['total_matches']}")
    finally:
        conn.close()


def run_models() -> bool:
    """Train Section 3 models. Requires the Poisson baseline exported by Node."""
    from .models import POISSON_PATH, build_model_report

    if not POISSON_PATH.exists():
        print(
            "Modelos omitidos: falta data/models/poisson_baseline.json. "
            "Ejecuta primero: node pipeline/export_poisson_baseline.mjs",
            file=sys.stderr,
        )
        return False
    report = build_model_report()
    headline = report["headline"]
    print(
        f"Ensamble {report['version']}: {headline['hits']}/{headline['n']} "
        f"({headline['accuracy'] * 100:.2f}%) · log-loss {headline['logLoss']:.4f} · "
        f"Brier {headline['brier']:.4f}."
    )
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="MOTOR-NOX Data Pipeline")
    parser.add_argument("--all", action="store_true", help="Run complete pipeline from scratch")
    parser.add_argument("--validate", action="store_true", help="Run validation audit on database")
    parser.add_argument("--weather", action="store_true", help="Ingest Open-Meteo daily weather")
    parser.add_argument("--features", action="store_true", help="Build the pre-match feature store")
    parser.add_argument("--audit", action="store_true", help="Run leakage and distribution audits")
    parser.add_argument("--models", action="store_true", help="Train Section 3 models and write the ensemble report")
    parser.add_argument("--manifest", action="store_true", help="Generate or update manifest.json")
    parser.add_argument("--competitions", action="store_true", help="Sync the ESPN competition catalog")
    parser.add_argument("--fixtures", action="store_true", help="Sync the -1/+21 day fixture window")
    parser.add_argument("--coverage", action="store_true", help="Recompute data/coverage.json")
    parser.add_argument("--model-run", action="store_true", help="Record model_report.json in model_runs")
    parser.add_argument("--phase1", action="store_true", help="Run catalog + fixtures + coverage")
    args = parser.parse_args()

    selected = any([
        args.all, args.validate, args.weather, args.features, args.audit, args.models,
        args.manifest, args.competitions, args.fixtures, args.coverage, args.model_run,
        args.phase1,
    ])
    if args.all or not selected:
        run_full_pipeline()
        return

    conn = get_connection()
    try:
        if args.validate:
            report = validate_all(conn)
            print_report(report)
        if args.weather:
            ingest_weather(conn)
        if args.features:
            features = build_features()
            print(
                f"Feature store {features['version']}: {features['matches']:,} partidos · "
                f"{features['features']} features."
            )
        if args.audit:
            version = conn.execute(
                "SELECT version FROM feature_datasets ORDER BY built_at DESC LIMIT 1"
            ).fetchone()
            if not version:
                print("No hay feature_datasets; ejecuta --features primero.", file=sys.stderr)
                raise SystemExit(1)
            audit = audit_dataset(conn, version["version"])
            distribution_report(conn, version["version"])
            print(f"Leakage audit: {audit['status']} · {audit.get('failure_count', 0)} fallos.")
        if args.models:
            run_models()
        if args.competitions or args.phase1:
            catalog = ingest_competitions(conn=conn)
            print(
                f"Catálogo: {catalog.get('total')} competiciones · "
                f"{catalog.get('active')} activas · tiers {catalog.get('byTier')}."
            )
        if args.fixtures or args.phase1:
            fixtures = ingest_fixtures(conn=conn, mode="window")
            print(
                f"Fixtures: {fixtures.get('inserted')} nuevos · "
                f"{fixtures.get('updated')} actualizados · {fixtures.get('errors')} errores."
            )
        if args.coverage or args.phase1:
            coverage = coverage_report(conn=conn)
            print(
                f"Cobertura: {coverage.get('status')} · "
                f"A/B {coverage.get('abCoverage', {}).get('coveragePct')}%."
            )
        if args.model_run:
            record_model_run(conn=conn)
        if args.manifest:
            build_manifest(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
