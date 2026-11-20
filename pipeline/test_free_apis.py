"""Pruebas offline de las APIs gratuitas adicionales (sin red, sin claves)."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from . import api_free_common, fixtures_merge
from .ingest_football_data_org import (
    FREE_COMPETITIONS,
    _code_for,
    normalize_match as fdo_match,
    normalize_standings as fdo_standings,
)
from .ingest_footballapi_org import (
    current_season,
    normalize_match as fa_match,
    normalize_table as fa_table,
)


FDO_RAW = {
    "match": {
        "id": 555001,
        "utcDate": "2026-11-20T19:00:00Z",
        "status": "FINISHED",
        "homeTeam": {"id": 359, "name": "Arsenal"},
        "awayTeam": {"id": 363, "name": "Chelsea"},
        "score": {"fullTime": {"home": 2, "away": 1}},
        "competition": {"name": "Premier League"},
        "season": {"startDate": "2026-08-01"},
        "venue": "Emirates Stadium",
        "matchday": 12,
        "lastUpdated": "2026-11-20T21:15:00Z",
    }
}

FA_RAW = {
    "match_id": "mt_95kf4jw9a",
    "competition": "premier-league",
    "competition_name": "Premier League",
    "country_name": "England",
    "season_start_year": 2026,
    "kickoff_utc": "2026-11-21T16:00:00Z",
    "match_status": "finished",
    "home_club_id": "cl_home123",
    "home_club_name": "Tottenham",
    "away_club_id": "cl_away123",
    "away_club_name": "Coventry",
    "home_goals": 3,
    "away_goals": 1,
    "ground_name": "Tottenham Hotspur Stadium",
    "referee_name": "Andrew Madley",
}


class TestFootballDataOrg(unittest.TestCase):
    def test_free_codes_mapped(self):
        self.assertEqual(len(FREE_COMPETITIONS), 12)
        self.assertEqual(FREE_COMPETITIONS["PL"], "eng.1")
        self.assertEqual(FREE_COMPETITIONS["EC"], "uefa.euro")

    def test_normalize_match_uses_request_code(self):
        # El payload no trae `code`: el bucle debe pasar el código de la petición.
        self.assertEqual(_code_for(FDO_RAW), "")
        row = fdo_match(FDO_RAW, _code_for(FDO_RAW) or "PL")
        self.assertIsNotNone(row)
        self.assertEqual(row["competition_id"], "eng.1")
        self.assertEqual(row["competition_code"], "PL")
        self.assertEqual(row["status"], "finished")
        self.assertEqual(row["home_goals"], 2)
        self.assertEqual(row["away_goals"], 1)
        self.assertEqual(row["quality"], "observed_delayed")
        self.assertEqual(row["as_of"], "2026-11-20T21:15:00Z")
        self.assertEqual(row["source"], "football_data_org")

    def test_payload_code_takes_priority(self):
        raw = json.loads(json.dumps(FDO_RAW))
        raw["match"]["competition"]["code"] = "PD"
        self.assertEqual(_code_for(raw), "PD")
        row = fdo_match(raw, _code_for(raw) or "PL")
        self.assertEqual(row["competition_id"], "esp.1")

    def test_normalize_standings(self):
        payload = {
            "standings": [{
                "table": [{
                    "position": 1, "team": {"name": "Arsenal"},
                    "playedGames": 12, "won": 9, "draw": 2, "lost": 1,
                    "goalsFor": 27, "goalsAgainst": 9, "points": 29,
                }],
                "lastUpdated": "2026-11-20T21:00:00Z",
            }],
            "season": {"startDate": "2026-08-01"},
        }
        table = fdo_standings(payload, "PL")
        self.assertIsNotNone(table)
        self.assertEqual(table["competition_id"], "eng.1")
        self.assertEqual(table["rows"][0]["team"], "Arsenal")
        self.assertEqual(table["quality"], "observed_delayed")


class TestFootballApiOrg(unittest.TestCase):
    def test_current_season(self):
        season = current_season()
        self.assertTrue(season.isdigit())
        self.assertGreaterEqual(int(season), 2026)

    def test_normalize_match(self):
        row = fa_match(FA_RAW)
        self.assertIsNotNone(row)
        self.assertEqual(row["competition_id"], "eng.1")
        self.assertEqual(row["source_id"], "mt_95kf4jw9a")
        self.assertEqual(row["status"], "finished")
        self.assertEqual(row["home_goals"], 3)
        self.assertEqual(row["referee"], "Andrew Madley")
        self.assertEqual(row["quality"], "observed_delayed")
        self.assertEqual(row["source"], "footballapi_org")

    def test_scheduled_match_has_null_goals(self):
        raw = dict(FA_RAW)
        raw["match_status"] = "SCHEDULED"
        row = fa_match(raw)
        self.assertEqual(row["status"], "scheduled")
        self.assertIsNone(row["home_goals"])
        self.assertEqual(row["quality"], "observed")
        self.assertIsNone(row["as_of"])

    def test_normalize_table(self):
        payload = {"data": {"table": [{
            "position": 1, "club": {"name": "Arsenal"},
            "played": 12, "won": 9, "drawn": 2, "lost": 1,
            "goals_for": 27, "goals_against": 9, "points": 29,
        }]}}
        table = fa_table(payload)
        self.assertIsNotNone(table)
        self.assertEqual(table["rows"][0]["team"], "Arsenal")


class TestSourceStatus(unittest.TestCase):
    def test_no_secrets_in_generated_files(self):
        # El estado se construye con identificadores de proveedor, nunca con la
        # clave. Verificamos que no aparecen cabeceras ni valores de clave.
        secret = "super-secreto-no-debe-aparecer-12345"
        with patch.dict("os.environ", {"FOOTBALLDATA_KEY": secret}):
            with tempfile.TemporaryDirectory() as tmp:
                status_path = Path(tmp) / "source_status.json"
                js_path = Path(tmp) / "fuentes.js"
                entry = api_free_common._source_summary(
                    key="football_data_org", source="football-data.org (Free)",
                    configured=True, status="ok", events=3, quality="observed",
                    as_of="2026-11-20T00:00:00Z",
                    note="12 competiciones del plan Free.",
                )
                with patch.object(api_free_common, "SOURCE_STATUS_PATH", status_path), \
                     patch.object(api_free_common, "SOURCES_JS_PATH", js_path):
                    api_free_common.write_source_status({"football_data_org": entry})
                for path in (status_path, js_path):
                    text = path.read_text(encoding="utf-8")
                    self.assertIn("football-data.org", text)
                    self.assertNotIn(secret, text)
                    self.assertNotIn("X-Auth-Token", text)
                    self.assertNotIn("X-API-Key", text)
                    self.assertNotIn("x-apisports-key", text)

    def test_empty_status_has_null_quality_and_as_of(self):
        status = api_free_common.empty_status("x", "Fuente X", "Sin clave.")
        self.assertEqual(status["status"], "sin-clave")
        self.assertIsNone(status["quality"])
        self.assertIsNone(status["as_of"])
        self.assertIsNone(status["events"])

    def test_resolve_key_from_env(self):
        with patch.dict("os.environ", {"FOOTBALLDATA_KEY": "  clave-test  "}):
            with tempfile.TemporaryDirectory() as tmp:
                self.assertEqual(
                    api_free_common.resolve_key("FOOTBALLDATA_KEY", Path(tmp) / "key.json"),
                    "clave-test",
                )


class TestMerge(unittest.TestCase):
    def test_combined_keeps_espn_and_adds_all_providers(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.executescript(
                """
                CREATE TABLE competitions (
                    id TEXT PRIMARY KEY, name TEXT, tier TEXT, active INTEGER
                );
                CREATE TABLE fixtures (
                    id TEXT PRIMARY KEY, competition_id TEXT, competition_name TEXT,
                    tier TEXT, season TEXT, kickoff_utc TEXT, home_team_id TEXT,
                    home_team_name TEXT, away_team_id TEXT, away_team_name TEXT,
                    status TEXT, home_goals INTEGER, away_goals INTEGER, venue TEXT,
                    venue_city TEXT, stage TEXT, source TEXT, source_id TEXT,
                    source_url TEXT, updated_at TEXT
                );
                """
            )
            conn.execute(
                "INSERT INTO competitions VALUES ('eng.1','Premier League','A',1)"
            )
            conn.execute(
                """INSERT INTO fixtures (
                    id, competition_id, competition_name, tier, kickoff_utc,
                    home_team_id, home_team_name, away_team_id, away_team_name,
                    status, updated_at
                ) VALUES ('espn-1','eng.1','Premier League','A','2026-11-21T15:00:00Z',
                          'a','Arsenal','b','Chelsea','scheduled','2026-11-20T00:00:00Z')"""
            )

            teams = {
                "api_fixtures": ("Liverpool", "Everton"),
                "free_api_fixtures": ("Newcastle", "Brighton"),
                "faorg_fixtures": ("Fulham", "Brentford"),
            }
            for table in ("api_fixtures", "free_api_fixtures", "faorg_fixtures"):
                home, away = teams[table]
                conn.execute(
                    f"""CREATE TABLE {table} (
                        id TEXT, source_id TEXT, provider TEXT, source TEXT,
                        competition_id TEXT, competition_name TEXT, season TEXT,
                        kickoff_utc TEXT, home_team_id TEXT, home_team_name TEXT,
                        away_team_id TEXT, away_team_name TEXT, status TEXT,
                        home_goals INTEGER, away_goals INTEGER, venue TEXT,
                        venue_city TEXT, round TEXT, quality TEXT, source_name TEXT,
                        as_of TEXT, updated_at TEXT
                    )"""
                )
                conn.execute(
                    f"""INSERT INTO {table} (
                        id, source_id, provider, source, competition_id, competition_name,
                        kickoff_utc, home_team_id, home_team_name, away_team_id,
                        away_team_name, status, quality
                    ) VALUES (
                        'x-{table}', 'x-{table}', 'prov', 'prov', 'eng.1', 'Premier League',
                        '2026-11-22T15:00:00Z', 'c', ?, 'd', ?,
                        'scheduled','observed'
                    )""",
                    (home, away),
                )
            conn.commit()

            target = Path(tmp) / "fixtures.json"
            result = fixtures_merge.write_combined(
                conn, date(2026, 11, 20), date(2026, 11, 23), fixtures_path=target
            )
            payload = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(result["count"], 4)
            self.assertEqual(payload["sources"]["espn"], 1)
            self.assertEqual(payload["sources"]["prov"], 3)
            for item in payload["items"]:
                self.assertIn("quality", item)
                self.assertIn("source", item)
                self.assertIn("as_of", item)
            conn.close()


if __name__ == "__main__":
    unittest.main()
