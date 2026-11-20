"""Pruebas del conector API-Football v3 (sin red)."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from .ingest_api_football import (
    LEAGUE_MAP,
    _dedup_key,
    _norm_kickoff,
    _norm_status,
    ensure_api_table,
    normalize_fixture,
    write_combined_fixtures_json,
)


SAMPLE_RAW = {
    "fixture": {
        "id": 1234567,
        "referee": "Lucas Casagrande, Brazil",
        "date": "2026-11-20T00:30:00+00:00",
        "venue": {"id": 269, "name": "Morumbi", "city": "Sao Paulo"},
        "status": {"long": "Match Finished", "short": "FT", "elapsed": 90},
    },
    "league": {"id": 71, "name": "Serie A", "country": "Brazil", "season": 2026,
               "round": "Regular Season - 35"},
    "teams": {"home": {"id": 126, "name": "Sao Paulo"},
              "away": {"id": 124, "name": "Fluminense"}},
    "goals": {"home": 0, "away": 1},
}


class NormalizationTests(unittest.TestCase):
    def test_normalize_finished_fixture(self) -> None:
        row = normalize_fixture(SAMPLE_RAW)
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["id"], "apif-1234567")
        self.assertEqual(row["source_id"], "1234567")
        self.assertEqual(row["competition_id"], "bra.1")  # ID confirmado en LEAGUE_MAP
        self.assertEqual(row["kickoff_utc"], "2026-11-20T00:30:00Z")
        self.assertEqual(row["status"], "finished")
        self.assertEqual((row["home_goals"], row["away_goals"]), (0, 1))
        self.assertEqual(row["venue"], "Morumbi")
        self.assertEqual(row["referee"], "Lucas Casagrande, Brazil")

    def test_unknown_league_falls_back(self) -> None:
        raw = json.loads(json.dumps(SAMPLE_RAW))
        raw["league"]["id"] = 99999
        row = normalize_fixture(raw)
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["competition_id"], "api.99999")
        self.assertNotIn(99999, LEAGUE_MAP)

    def test_scheduled_has_no_goals(self) -> None:
        raw = json.loads(json.dumps(SAMPLE_RAW))
        raw["fixture"]["status"] = {"long": "Not Started", "short": "NS"}
        raw["goals"] = {"home": None, "away": None}
        row = normalize_fixture(raw)
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["status"], "scheduled")
        self.assertIsNone(row["home_goals"])

    def test_missing_team_returns_none(self) -> None:
        raw = json.loads(json.dumps(SAMPLE_RAW))
        raw["teams"]["away"] = {}
        self.assertIsNone(normalize_fixture(raw))

    def test_status_mapping(self) -> None:
        cases = {
            "NS": "scheduled", "1H": "live", "HT": "live", "FT": "finished",
            "AET": "finished", "PST": "postponed", "CANC": "cancelled", "ABD": "suspended",
        }
        for short, expected in cases.items():
            self.assertEqual(
                _norm_status({"status": {"short": short, "long": ""}}), expected
            )

    def test_long_status_wins(self) -> None:
        self.assertEqual(
            _norm_status({"status": {"short": "PEN", "long": "Match Finished after penalties"}}),
            "finished",
        )

    def test_kickoff_normalization(self) -> None:
        self.assertEqual(_norm_kickoff("2026-11-20T01:30:00+01:00"), "2026-11-20T00:30:00Z")
        self.assertIsNone(_norm_kickoff(None))

    def test_dedup_key_ignores_accents(self) -> None:
        a = {"competition_id": "bra.1", "kickoff_utc": "2026-11-20T00:30:00Z",
             "home_team_name": "São Paulo", "away_team_name": "Fluminense"}
        b = {"competition_id": "bra.1", "kickoff_utc": "2026-11-20T12:00:00Z",
             "home_team_name": "Sao Paulo", "away_team_name": "Fluminense"}
        self.assertEqual(_dedup_key(a), _dedup_key(b))


class MergeTests(unittest.TestCase):
    def test_merge_dedups_and_preserves_espn(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixtures_path = Path(tmp) / "fixtures.json"
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute(
                """CREATE TABLE competitions (
                    id TEXT PRIMARY KEY, name TEXT, tier TEXT, active INTEGER)"""
            )
            conn.execute(
                """CREATE TABLE fixtures (
                    id TEXT PRIMARY KEY, competition_id TEXT, season TEXT,
                    kickoff_utc TEXT, home_team_id TEXT, away_team_id TEXT,
                    home_team_name TEXT, away_team_name TEXT, status TEXT,
                    home_goals INTEGER, away_goals INTEGER, venue TEXT,
                    venue_city TEXT, stage TEXT, source TEXT, source_id TEXT,
                    source_url TEXT, first_seen_at TEXT, last_seen_at TEXT, updated_at TEXT)"""
            )
            conn.execute(
                "INSERT INTO competitions VALUES ('bra.1','Brazilian Serie A','B',1)"
            )
            conn.execute(
                """INSERT INTO fixtures VALUES (
                    'espn-1','bra.1','2026','2026-11-20T00:30:00Z','e1','e2',
                    'São Paulo','Fluminense','finished',0,1,'Morumbi','Sao Paulo',
                    NULL,'espn','1',NULL,'now','now','now')"""
            )
            conn.commit()
            ensure_api_table(conn)
            row = normalize_fixture(SAMPLE_RAW)
            assert row is not None
            from .ingest_api_football import UPSERT_SQL

            payload = dict(row)
            payload.update(first_seen_at="now", last_seen_at="now", updated_at="now")
            conn.execute(UPSERT_SQL, payload)
            conn.commit()

            with patch("pipeline.ingest_api_football.FIXTURES_JSON", fixtures_path):
                result = write_combined_fixtures_json(
                    conn, date(2026, 11, 19), date(2026, 11, 21)
                )
            self.assertEqual(result["apiAdded"], 0, "El partido ESPN ya existe: no debe duplicarse")
            doc = json.loads(fixtures_path.read_text(encoding="utf-8"))
            self.assertEqual(doc["count"], 1)
            self.assertEqual(doc["sources"], {"espn": 1})
            # La tabla ESPN sigue intacta
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM fixtures").fetchone()[0], 1)
            conn.close()


if __name__ == "__main__":
    unittest.main()
