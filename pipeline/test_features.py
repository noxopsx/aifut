"""
Tests de la Sección 2: feature store pre-partido, leakage, null/placeholder,
Elo, viaje, alineaciones y comparación de distribuciones.

Uso:
    python -m unittest pipeline.test_features -v
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sqlite3
import unittest

from .build_features import _entry, _haversine_km
from .db import DATA_DIR, DB_PATH, get_connection
from .feature_catalog import CORE_FEATURE_GROUPS, FEATURE_CATALOG, catalog_entry

FEATURE_STORE_DIR = DATA_DIR / "features"
REQUIRED_KEYS = {"value", "quality", "source", "as_of", "usable_for_model"}


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _jaccard(first: set[str], second: set[str]) -> float | None:
    union = first | second
    return len(first & second) / len(union) if union else None


class FeatureStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DB_PATH.exists():
            raise unittest.SkipTest(f"No existe la base de datos: {DB_PATH}")
        cls.conn = get_connection()
        dataset = cls.conn.execute(
            "SELECT * FROM feature_datasets ORDER BY built_at DESC LIMIT 1"
        ).fetchone()
        if not dataset:
            raise unittest.SkipTest("No hay feature_datasets; ejecuta python -m pipeline.build_features.")
        cls.dataset = dataset
        cls.version = dataset["version"]
        cls.rows = cls.conn.execute(
            "SELECT * FROM match_features WHERE dataset_version = ? ORDER BY kickoff_utc, match_id",
            (cls.version,),
        ).fetchall()
        cls.coverage = {
            row["feature"]: dict(row)
            for row in cls.conn.execute(
                "SELECT * FROM feature_coverage WHERE dataset_version = ?", (cls.version,)
            )
        }

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def test_dataset_has_one_row_per_match(self) -> None:
        total_matches = self.conn.execute("SELECT count(*) FROM matches").fetchone()[0]
        self.assertEqual(self.dataset["match_count"], total_matches)
        self.assertEqual(len(self.rows), total_matches)
        duplicates = self.conn.execute(
            """
            SELECT count(*) FROM (
                SELECT match_id, dataset_version, count(*) AS n
                FROM match_features GROUP BY match_id, dataset_version HAVING n > 1
            )
            """
        ).fetchone()[0]
        self.assertEqual(duplicates, 0)
        self.assertEqual(self.dataset["feature_count"], len(FEATURE_CATALOG))
        self.assertGreater(self.dataset["core_feature_count"], 0)

    def test_entries_have_provenance_and_null_rules(self) -> None:
        checked = 0
        for row in self.rows:
            features = json.loads(row["features_json"])
            self.assertEqual(set(features), set(FEATURE_CATALOG))
            for name, entry in features.items():
                checked += 1
                self.assertTrue(REQUIRED_KEYS.issubset(entry), f"{row['match_id']} · {name}")
                self.assertIn(entry["quality"], {"observed", "estimated", "placeholder", "missing"})
                if entry["value"] is None:
                    self.assertEqual(entry["quality"], "missing", f"{row['match_id']} · {name}")
                    self.assertFalse(entry["usable_for_model"], f"{row['match_id']} · {name}")
                else:
                    self.assertNotEqual(entry["quality"], "missing", f"{row['match_id']} · {name}")
        self.assertGreater(checked, 0)

    def test_no_leakage_for_usable_features(self) -> None:
        checked = 0
        for row in self.rows:
            kickoff = _parse(row["kickoff_utc"])
            self.assertIsNotNone(kickoff)
            features = json.loads(row["features_json"])
            for name, entry in features.items():
                if not entry["usable_for_model"]:
                    continue
                checked += 1
                self.assertIsNotNone(entry["as_of"], f"{row['match_id']} · {name}")
                as_of = _parse(entry["as_of"])
                self.assertIsNotNone(as_of, f"{row['match_id']} · {name}")
                self.assertLess(as_of, kickoff, f"{row['match_id']} · {name}")
        self.assertGreater(checked, 0)

    def test_sensitive_features_are_not_usable(self) -> None:
        for row in self.rows:
            features = json.loads(row["features_json"])
            for name, entry in features.items():
                if name.startswith("market_") or name.startswith("weather_"):
                    self.assertFalse(entry["usable_for_model"], f"{row['match_id']} · {name}")
                if name.endswith("_lineup_confirmed"):
                    self.assertEqual(entry["value"], 0, f"{row['match_id']} · {name}")
                    self.assertFalse(entry["usable_for_model"], f"{row['match_id']} · {name}")
                if name.endswith(("_absences", "_suspensions", "_squad_value")):
                    self.assertIsNone(entry["value"], f"{row['match_id']} · {name}")
                    self.assertEqual(entry["quality"], "missing", f"{row['match_id']} · {name}")

    def test_core_coverage_reaches_target(self) -> None:
        for group, description in CORE_FEATURE_GROUPS.items():
            members = [
                name for name in FEATURE_CATALOG
                if catalog_entry(name)["group"] == group and catalog_entry(name)["model_usable"]
            ]
            self.assertTrue(members, f"Grupo core sin features usables: {group}")
            minimum = min(self.coverage[name]["coverage_pct"] for name in members)
            threshold = 40.0 if group == "lineups" else 80.0
            self.assertGreaterEqual(minimum, threshold, f"{group}: {minimum:.2f}% · {description}")

    def test_elo_pre_chains_from_previous_post(self) -> None:
        rows = self.conn.execute(
            """
            SELECT team_id, date, match_id, elo_pre, elo_post
            FROM elo_ratings ORDER BY team_id, date, match_id
            """
        ).fetchall()
        self.assertGreater(len(rows), 0)
        previous_team = None
        previous_post = None
        for row in rows:
            if row["team_id"] != previous_team:
                self.assertAlmostEqual(row["elo_pre"], 1500.0, places=6)
                previous_team = row["team_id"]
            else:
                self.assertAlmostEqual(row["elo_pre"], previous_post, places=6)
            previous_post = row["elo_post"]

    def test_haversine_and_travel_features(self) -> None:
        self.assertEqual(_haversine_km(51.5549, -0.1084, 51.5549, -0.1084), 0.0)
        self.assertAlmostEqual(
            _haversine_km(51.5549, -0.1084, 53.4308, -2.9608),
            284.21,
            delta=1.0,
        )
        self.assertAlmostEqual(
            _haversine_km(40.4531, -3.6883, 41.3809, 2.1228),
            498.96,
            delta=1.0,
        )

        row = self.conn.execute(
            """
            SELECT m.id, m.date_utc, m.venue_id, th.venue_id AS home_venue, ta.venue_id AS away_venue
            FROM matches m
            JOIN teams th ON th.id = m.home_team_id
            JOIN teams ta ON ta.id = m.away_team_id
            WHERE m.venue_id IS NOT NULL
              AND m.venue_id = th.venue_id
              AND m.venue_id <> ta.venue_id
            LIMIT 1
            """
        ).fetchone()
        self.assertIsNotNone(row)
        features = self.conn.execute(
            "SELECT features_json FROM match_features WHERE match_id = ? AND dataset_version = ?",
            (row["id"], self.version),
        ).fetchone()
        self.assertIsNotNone(features)
        payload = json.loads(features["features_json"])
        self.assertEqual(payload["home_travel_km"]["value"], 0.0)
        self.assertGreater(payload["away_travel_km"]["value"], 0.0)
        self.assertAlmostEqual(
            payload["travel_diff"]["value"],
            payload["away_travel_km"]["value"] - payload["home_travel_km"]["value"],
            places=2,
        )

    def test_lineup_continuity_uses_only_previous_matches(self) -> None:
        target = self.conn.execute(
            """
            SELECT m.id, m.date_utc, m.home_team_id
            FROM matches m
            WHERE m.season = '2024-25'
            ORDER BY m.date_utc, m.id
            LIMIT 1 OFFSET 80
            """
        ).fetchone()
        self.assertIsNotNone(target)
        team = target["home_team_id"]
        kickoff = _parse(target["date_utc"])
        previous = self.conn.execute(
            """
            SELECT m.id, m.date_utc
            FROM matches m
            JOIN lineups l ON l.match_id = m.id AND l.team_id = ? AND l.is_starter = 1
            WHERE m.date_utc < ?
            GROUP BY m.id
            ORDER BY m.date_utc DESC, m.id DESC
            LIMIT 2
            """,
            (team, target["date_utc"]),
        ).fetchall()
        self.assertEqual(len(previous), 2)
        sets = []
        for match in reversed(previous):
            xi = {
                str(row["player_id"])
                for row in self.conn.execute(
                    "SELECT player_id FROM lineups WHERE match_id = ? AND team_id = ? AND is_starter = 1",
                    (match["id"], team),
                )
            }
            sets.append(xi)
        expected = _jaccard(sets[0], sets[1])
        self.assertIsNotNone(expected)

        feature_row = self.conn.execute(
            "SELECT features_json FROM match_features WHERE match_id = ? AND dataset_version = ?",
            (target["id"], self.version),
        ).fetchone()
        self.assertIsNotNone(feature_row)
        payload = json.loads(feature_row["features_json"])
        entry = payload["home_lineup_continuity"]
        self.assertTrue(entry["usable_for_model"])
        self.assertAlmostEqual(entry["value"], expected, places=4)
        self.assertLess(_parse(entry["as_of"]), kickoff)

    def test_placeholder_and_null_entry_rules(self) -> None:
        null_entry = _entry(None, "observed", "test")
        self.assertEqual(null_entry["quality"], "missing")
        self.assertFalse(null_entry["usable_for_model"])

        placeholder = _entry(1.0, "placeholder", "test")
        self.assertEqual(placeholder["quality"], "placeholder")
        self.assertFalse(placeholder["usable_for_model"])

        estimated = _entry(1.0, "estimated", "test")
        self.assertFalse(estimated["usable_for_model"])

        observed = _entry(1.0, "observed", "test")
        self.assertTrue(observed["usable_for_model"])

        with self.assertRaises(ValueError):
            _entry(1.0, "missing", "test")

    def test_derived_features_are_estimated(self) -> None:
        """xG, Elo y medias de liga son derivados: no se presentan como observados."""
        required = (
            "home_xg_for_5",
            "away_xg_for_5",
            "home_xg_diff_5",
            "away_xg_diff_5",
            "xg_diff_5",
            "home_elo_pre",
            "away_elo_pre",
            "elo_diff",
            "league_goals_avg_prior",
            "league_xg_avg_prior",
        )
        sample = None
        for row in self.rows:
            features = json.loads(row["features_json"])
            if all(features[name]["usable_for_model"] for name in required):
                sample = features
                break
        self.assertIsNotNone(
            sample, "No hay partido con xG, Elo y medias de liga usables a la vez."
        )
        for name in required:
            self.assertEqual(sample[name]["quality"], "estimated", name)
            self.assertTrue(sample[name]["usable_for_model"], name)

        weather = sample["weather_temp_c"]
        if weather["value"] is not None:
            self.assertEqual(weather["quality"], "estimated")
            self.assertFalse(weather["usable_for_model"])

    def test_distribution_report_is_aligned(self) -> None:
        path = FEATURE_STORE_DIR / "distribution_report.json"
        self.assertTrue(path.exists(), "Falta distribution_report.json; ejecuta python -m pipeline.audit_features.")
        report = json.loads(path.read_text(encoding="utf-8"))
        raw_vs_rolling = report["raw_xg_vs_rolling"]
        self.assertGreater(raw_vs_rolling["paired_matches"], 0)
        correlation = raw_vs_rolling["correlation_raw_vs_rolling"]
        self.assertIsNotNone(correlation)
        self.assertGreater(correlation, 0.05)
        self.assertLess(correlation, 1.0)
        comparison = report["model_before_after"]
        self.assertGreater(comparison["applied_matches"], 0)
        self.assertIsNotNone(comparison["mean_abs_p_home_change"])
        self.assertIsNotNone(comparison["mean_abs_p_draw_change"])
        self.assertIsNotNone(comparison["mean_abs_p_away_change"])
        self.assertGreaterEqual(comparison["meaningful_changed_pct"], 0.0)
        self.assertLessEqual(comparison["meaningful_changed_pct"], 100.0)

    def test_same_kickoff_batch_does_not_see_itself(self) -> None:
        batch = self.conn.execute(
            """
            SELECT date_utc, count(*) AS n
            FROM matches GROUP BY date_utc HAVING n > 1
            ORDER BY n DESC, date_utc LIMIT 1
            """
        ).fetchone()
        self.assertIsNotNone(batch)
        self.assertGreater(batch["n"], 1)
        matches = self.conn.execute(
            "SELECT * FROM matches WHERE date_utc = ? ORDER BY id", (batch["date_utc"],)
        ).fetchall()
        self.assertGreater(len(matches), 1)

        for match in matches:
            kickoff = _parse(match["date_utc"])
            feature_row = self.conn.execute(
                "SELECT features_json FROM match_features WHERE match_id = ? AND dataset_version = ?",
                (match["id"], self.version),
            ).fetchone()
            self.assertIsNotNone(feature_row)
            features = json.loads(feature_row["features_json"])
            for side, team in (("home", match["home_team_id"]), ("away", match["away_team_id"])):
                elo_entry = features[f"{side}_elo_pre"]
                if not elo_entry["usable_for_model"]:
                    continue
                previous = self.conn.execute(
                    """
                    SELECT elo_post FROM elo_ratings
                    WHERE team_id = ? AND date < ?
                    ORDER BY date DESC LIMIT 1
                    """,
                    (team, match["date_utc"]),
                ).fetchone()
                self.assertIsNotNone(previous)
                # La feature se publica redondeada a 2 decimales; el registro
                # Elo conserva 4. La diferencia máxima esperada es 0.005.
                self.assertAlmostEqual(elo_entry["value"], previous["elo_post"], delta=0.01)


if __name__ == "__main__":
    unittest.main(verbosity=2)
