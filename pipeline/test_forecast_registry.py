"""Tests de aceptación de la Fase 0: registro, inmutabilidad y reconciliación."""

from __future__ import annotations

import json
import shutil
import sqlite3
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .db import BASE_DIR, get_connection, init_db
from .forecast_registry import (
    build_forecast,
    forecast_id_for,
    load_forecast_items,
    register_forecasts,
)
from .reconcile_results import compute_record, export_record, reconcile_results

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc)


def forecast_item(fixture_id: str, *, kickoff: str = "2026-11-16T20:00:00Z",
                  home: float = 0.50, draw: float = 0.30, away: float = 0.20,
                  home_team: str = "Local", away_team: str = "Visitante") -> dict:
    return {
        "fixture_id": fixture_id,
        "kickoff_utc": kickoff,
        "league_id": "test.1",
        "league_name": "Liga de prueba",
        "season": "2026-27",
        "home_team": home_team,
        "away_team": away_team,
        "probabilities": {"home": home, "draw": draw, "away": away},
        "engine_version": "test-1.0",
    }


class ForecastRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        cache_dir = BASE_DIR / ".cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        self.tmpdir = cache_dir / f"phase0_{uuid.uuid4().hex[:10]}"
        self.tmpdir.mkdir(parents=True, exist_ok=True)
        self.addCleanup(lambda: shutil.rmtree(self.tmpdir, ignore_errors=True))
        self.db_path = self.tmpdir / "test.sqlite"
        self.snapshots = self.tmpdir / "snapshots"
        init_db(self.db_path)
        self.conn = get_connection(self.db_path)
        self.addCleanup(self.conn.close)

    def register(self, items, **kwargs):
        options = {
            "model_version": "test-model-1.0",
            "threshold": 0.60,
            "source": "live",
            "now": NOW,
            "snapshot_dir": self.snapshots,
        }
        options.update(kwargs)
        return register_forecasts(self.conn, items, **options)

    def test_hash_is_deterministic(self):
        item = forecast_item("fx-1")
        first = build_forecast(
            item, model_version="test-model-1.0", threshold=0.6, source="live",
            policy="threshold>=0.60", now=NOW,
        )
        second = build_forecast(
            item, model_version="test-model-1.0", threshold=0.6, source="live",
            policy="threshold>=0.60", now=NOW,
        )
        other = build_forecast(
            forecast_item("fx-2"), model_version="test-model-1.0", threshold=0.6,
            source="live", policy="threshold>=0.60", now=NOW,
        )
        self.assertEqual(first["snapshot_hash"], second["snapshot_hash"])
        self.assertNotEqual(first["snapshot_hash"], other["snapshot_hash"])
        self.assertEqual(first["id"], forecast_id_for("fx-1", "test-model-1.0"))

    def test_rejects_probabilities_that_do_not_sum_to_one(self):
        stats = self.register([forecast_item("fx-bad", home=0.5, draw=0.2, away=0.2)])
        self.assertEqual(stats["inserted"], 0)
        self.assertEqual(len(stats["rejected"]), 1)
        self.assertIn("suman", stats["rejected"][0]["error"])

    def test_rejects_past_kickoff_for_live(self):
        stats = self.register([forecast_item("fx-past", kickoff="2026-11-14T20:00:00Z")])
        self.assertEqual(stats["inserted"], 0)
        self.assertIn("kickoff ya pasó", stats["rejected"][0]["error"])

    def test_register_is_idempotent_and_writes_snapshot(self):
        item = forecast_item("fx-1")
        first = self.register([item], threshold=0.40)
        second = self.register([item], threshold=0.40)
        self.assertEqual(first["inserted"], 1)
        self.assertEqual(second["inserted"], 0)
        self.assertEqual(second["skipped"], 1)
        count = self.conn.execute("SELECT COUNT(*) AS n FROM forecasts").fetchone()["n"]
        self.assertEqual(count, 1)
        files = list(self.snapshots.glob("*.json"))
        self.assertEqual(len(files), 1)
        snapshot = json.loads(files[0].read_text(encoding="utf-8"))
        self.assertEqual(snapshot["fixture"]["id"], "fx-1")
        self.assertEqual(snapshot["decision"]["pick"], "1")
        self.assertTrue(snapshot["decision"]["published"])

    def test_forecast_is_immutable(self):
        self.register([forecast_item("fx-1")])
        with self.assertRaises(sqlite3.DatabaseError):
            self.conn.execute("UPDATE forecasts SET pick = '2'")
        with self.assertRaises(sqlite3.DatabaseError):
            self.conn.execute("DELETE FROM forecasts")

    def test_reconcile_and_record(self):
        items = [
            forecast_item("fx-a", home=0.60, draw=0.25, away=0.15),
            forecast_item("fx-b", home=0.50, draw=0.30, away=0.20),
            forecast_item("fx-c", home=0.40, draw=0.35, away=0.25),
        ]
        self.register(items, threshold=0.60)

        results = [
            {"fixture_id": "fx-a", "status": "finished", "home_goals": 2, "away_goals": 0},
            {"fixture_id": "fx-b", "status": "finished", "home_goals": 0, "away_goals": 1},
        ]
        stats = reconcile_results(self.conn, results, source="test")
        self.assertEqual(stats["reconciled"], 2)

        record = compute_record(self.conn)
        self.assertEqual(record["registered"], 3)
        self.assertEqual(record["published"], 1)
        self.assertEqual(record["scored"], 2)
        self.assertEqual(record["publishedScored"], 1)
        self.assertEqual(record["hits"], 1)
        self.assertEqual(record["accuracy"], 1.0)
        self.assertAlmostEqual(record["coverage"], 1 / 3, places=6)
        self.assertAlmostEqual(record["brier"], 0.245, places=6)
        self.assertEqual(record["pending"], 1)
        self.assertEqual(record["ci95"], [1.0, 1.0])
        self.assertIsNone(record["emptyReason"])

        # Reconciliar dos veces no duplica ni cambia el récord.
        again = reconcile_results(self.conn, results, source="test")
        self.assertEqual(again["skipped"], 2)
        self.assertEqual(compute_record(self.conn)["hits"], 1)

        # Una corrección del resultado actualiza el outcome y el récord.
        correction = [
            {"fixture_id": "fx-a", "status": "finished", "home_goals": 0, "away_goals": 1}
        ]
        fixed = reconcile_results(self.conn, correction, source="test")
        self.assertEqual(fixed["updated"], 1)
        record = compute_record(self.conn)
        self.assertEqual(record["hits"], 0)
        self.assertEqual(record["accuracy"], 0.0)

        json_path = Path(self.tmpdir) / "record.json"
        js_path = Path(self.tmpdir) / "record.js"
        export_record(record, json_path=json_path, js_path=js_path)
        exported = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(exported["schema"], "motor-nox.record.v1")
        self.assertEqual(exported["hits"], 0)
        self.assertIn("export const RECORD", js_path.read_text(encoding="utf-8"))

    def test_postponed_result_is_void_and_not_pending(self):
        self.register([forecast_item("fx-1")], threshold=0.60)
        stats = reconcile_results(
            self.conn,
            [{"fixture_id": "fx-1", "status": "postponed"}],
            source="test",
        )
        self.assertEqual(stats["reconciled"], 1)
        record = compute_record(self.conn)
        self.assertEqual(record["publishedScored"], 0)
        self.assertEqual(record["void"], 1)
        self.assertEqual(record["pending"], 0)
        outcome = self.conn.execute("SELECT status, hit FROM forecast_outcomes").fetchone()
        self.assertEqual(outcome["status"], "postponed")
        self.assertIsNone(outcome["hit"])

    def test_load_items_accepts_wrapper(self):
        path = Path(self.tmpdir) / "forecasts.json"
        path.write_text(
            json.dumps({"forecasts": [forecast_item("fx-1")]}), encoding="utf-8"
        )
        items = load_forecast_items(path)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["fixture_id"], "fx-1")


if __name__ == "__main__":
    unittest.main()
