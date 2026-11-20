"""Tests de la Fase 1: dedupe, estados, contrato y cobertura de fixtures."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path

from .db import init_db
from .ingest_fixtures import (
    QualityError,
    _quality_checks,
    coverage_report,
    normalize_utc,
    parse_event,
    season_window,
    status_from_espn,
    upsert_fixture,
    validate_fixture,
)


def competition_row() -> dict:
    return {
        "id": "test.1",
        "name": "Liga de prueba",
        "short_name": "Prueba",
        "country": "Testlandia",
        "timezone": "UTC",
        "tier": "B",
        "tier_reason": "test",
        "source_ids": '{"espn": "test.1"}',
        "goals_prior": None,
        "home_prior": None,
        "away_prior": None,
        "prior_source": "none",
        "aliases_json": "[]",
        "logo_url": None,
        "is_tournament": 0,
        "active": 1,
        "availability_ready": 0,
        "created_at": "2026-11-17T00:00:00Z",
        "updated_at": "2026-11-17T00:00:00Z",
        "season": "2026-27",
        "current_season": "2026-27",
    }


def insert_competition(conn: sqlite3.Connection) -> None:
    row = competition_row()
    conn.execute(
        """
        INSERT INTO competitions (
            id, name, short_name, country, timezone, tier, tier_reason,
            source_ids, goals_prior, home_prior, away_prior, prior_source,
            aliases_json, logo_url, is_tournament, active, availability_ready,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row["id"], row["name"], row["short_name"], row["country"], row["timezone"],
            row["tier"], row["tier_reason"], row["source_ids"], row["goals_prior"],
            row["home_prior"], row["away_prior"], row["prior_source"],
            row["aliases_json"], row["logo_url"], row["is_tournament"],
            row["active"], row["availability_ready"], row["created_at"], row["updated_at"],
        ),
    )
    conn.execute(
        """
        INSERT INTO seasons (competition_id, season, start_date, end_date, format, team_count, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (row["id"], row["season"], "2026-08-01", "2027-05-31", "league", 20, "test", row["updated_at"]),
    )


def event(
    event_id: str = "123",
    *,
    status: str = "STATUS_SCHEDULED",
    state: str = "pre",
    home_score: str = "0",
    away_score: str = "0",
    date_value: str = "2026-11-21T15:00Z",
) -> dict:
    return {
        "id": event_id,
        "date": date_value,
        "season": {"year": 2026, "slug": "2026-27-test-league"},
        "competitions": [
            {
                "status": {"type": {"name": status, "state": state, "completed": state == "post"}},
                "competitors": [
                    {
                        "homeAway": "home",
                        "score": home_score,
                        "team": {"id": "10", "displayName": "Local FC", "abbreviation": "LOC"},
                    },
                    {
                        "homeAway": "away",
                        "score": away_score,
                        "team": {"id": "20", "displayName": "Visitante FC", "abbreviation": "VIS"},
                    },
                ],
                "venue": {"fullName": "Estadio de Prueba", "address": {"city": "Ciudad"}},
                "notes": [{"headline": "Jornada 1"}],
            }
        ],
    }


class FixtureContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "test.sqlite"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        insert_competition(self.conn)
        self.competition = competition_row()

    def tearDown(self) -> None:
        self.conn.close()
        self.temp.cleanup()

    def test_normalize_utc(self) -> None:
        self.assertEqual(normalize_utc("2026-11-21T15:00Z"), "2026-11-21T15:00:00Z")
        self.assertEqual(normalize_utc("2026-11-21T15:00:00+00:00"), "2026-11-21T15:00:00Z")
        self.assertEqual(normalize_utc("2026-11-21T16:00:00+01:00"), "2026-11-21T15:00:00Z")

    def test_status_mapping(self) -> None:
        self.assertEqual(status_from_espn({"name": "STATUS_SCHEDULED"}), "scheduled")
        self.assertEqual(status_from_espn({"name": "STATUS_IN_PROGRESS"}), "live")
        self.assertEqual(status_from_espn({"name": "STATUS_FULL_TIME"}), "finished")
        self.assertEqual(status_from_espn({"name": "STATUS_POSTPONED"}), "postponed")
        self.assertEqual(status_from_espn({"name": "STATUS_CANCELED"}), "cancelled")
        self.assertEqual(status_from_espn({"name": "STATUS_SUSPENDED"}), "suspended")
        self.assertEqual(status_from_espn({"name": "STATUS_UNKNOWN", "state": "pre"}), "scheduled")

    def test_parse_scheduled_event(self) -> None:
        fixture = parse_event(event(), self.competition, source_url="https://example.test")
        validate_fixture(fixture)
        self.assertEqual(fixture["id"], "espn-123")
        self.assertEqual(fixture["season"], "2026-27")
        self.assertEqual(fixture["kickoff_utc"], "2026-11-21T15:00:00Z")
        self.assertEqual(fixture["status"], "scheduled")
        self.assertIsNone(fixture["home_goals"])
        self.assertIsNone(fixture["away_goals"])
        self.assertEqual(fixture["home_team_id"], "espn-10")
        self.assertEqual(fixture["home_team_name"], "Local FC")
        self.assertEqual(fixture["venue"], "Estadio de Prueba")
        self.assertEqual(fixture["stage"], "Jornada 1")

    def test_parse_finished_event(self) -> None:
        fixture = parse_event(
            event(status="STATUS_FULL_TIME", state="post", home_score="2", away_score="1"),
            self.competition,
            source_url="https://example.test",
        )
        validate_fixture(fixture)
        self.assertEqual(fixture["status"], "finished")
        self.assertEqual(fixture["home_goals"], 2)
        self.assertEqual(fixture["away_goals"], 1)

    def test_finished_without_score_fails(self) -> None:
        with self.assertRaises(QualityError):
            parse_event(
                event(status="STATUS_FULL_TIME", state="post", home_score="", away_score=""),
                self.competition,
                source_url="https://example.test",
            )

    def test_upsert_dedupes_and_audits_changes(self) -> None:
        fixture = parse_event(event(), self.competition, source_url="https://example.test")
        self.assertEqual(upsert_fixture(self.conn, fixture), "inserted")
        self.assertEqual(upsert_fixture(self.conn, fixture), "unchanged")
        count = self.conn.execute("SELECT COUNT(*) FROM fixtures").fetchone()[0]
        self.assertEqual(count, 1)

        changed = dict(fixture)
        changed["kickoff_utc"] = "2026-11-22T18:00:00Z"
        changed["venue"] = "Estadio Nuevo"
        self.assertEqual(upsert_fixture(self.conn, changed), "updated")
        count = self.conn.execute("SELECT COUNT(*) FROM fixtures").fetchone()[0]
        self.assertEqual(count, 1)
        changes = self.conn.execute(
            "SELECT field, old_value, new_value FROM fixture_changes ORDER BY field"
        ).fetchall()
        fields = {row["field"] for row in changes}
        self.assertIn("kickoff_utc", fields)
        self.assertIn("venue", fields)

    def test_terminal_status_is_not_downgraded(self) -> None:
        finished = parse_event(
            event(status="STATUS_FULL_TIME", state="post", home_score="3", away_score="0"),
            self.competition,
            source_url="https://example.test",
        )
        upsert_fixture(self.conn, finished)
        stale = dict(finished)
        stale["status"] = "scheduled"
        stale["home_goals"] = None
        stale["away_goals"] = None
        self.assertEqual(upsert_fixture(self.conn, stale), "unchanged")
        row = self.conn.execute("SELECT status, home_goals, away_goals FROM fixtures").fetchone()
        self.assertEqual(row["status"], "finished")
        self.assertEqual(row["home_goals"], 3)
        self.assertEqual(row["away_goals"], 0)
        warning = self.conn.execute(
            "SELECT COUNT(*) FROM data_quality_events WHERE severity = 'warning'"
        ).fetchone()[0]
        self.assertEqual(warning, 1)

    def test_quality_checks_detect_broken_rows(self) -> None:
        fixture = parse_event(event(), self.competition, source_url="https://example.test")
        upsert_fixture(self.conn, fixture)
        self.assertEqual(_quality_checks(self.conn)["duplicates"], 0)
        self.conn.execute(
            """
            INSERT INTO fixtures (
                id, competition_id, season, kickoff_utc, home_team_id, away_team_id,
                home_team_name, away_team_name, status, source, source_id,
                first_seen_at, last_seen_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "espn-broken", "test.1", "2026-27", "2026-11-23T15:00:00Z",
                "espn-30", "espn-40", "Local 2", "Visitante 2", "finished",
                "espn", "broken", "2026-11-17T00:00:00Z", "2026-11-17T00:00:00Z",
                "2026-11-17T00:00:00Z",
            ),
        )
        checks = _quality_checks(self.conn)
        self.assertEqual(checks["finished_without_score"], 1)
        self.assertEqual(checks["invalid_status"], 0)
        self.assertEqual(checks["invalid_kickoff"], 0)

    def test_coverage_report(self) -> None:
        fixture = parse_event(event(), self.competition, source_url="https://example.test")
        upsert_fixture(self.conn, fixture)
        self.conn.execute(
            """
            INSERT INTO sync_state (
                id, source, scope, last_started_at, last_finished_at, status,
                events, inserted, updated, errors, window_from, window_to, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "fixtures_window", "espn", "fixtures", "2026-11-17T00:00:00Z",
                "2026-11-17T00:00:00Z", "success", 1, 1, 0, 0,
                "2026-11-16", "2026-12-08", '{"expected_ab": 1}',
            ),
        )
        payload = coverage_report(self.conn, days=7, write=False)
        self.assertEqual(payload["competitions"]["active"], 1)
        self.assertEqual(payload["fixtures"]["total"], 1)
        self.assertEqual(payload["abCoverage"]["fixtures"], 1)
        self.assertEqual(payload["abCoverage"]["coveragePct"], 100.0)
        self.assertEqual(payload["quality"]["duplicates"], 0)

    def test_season_window_uses_top_level_dates(self) -> None:
        start, end = season_window(
            "eng.1",
            2024,
            {"startDate": "2024-08-16T00:00:00Z", "endDate": "2025-05-25T00:00:00Z"},
        )
        self.assertEqual(start, date(2024, 8, 16))
        self.assertEqual(end, date(2025, 5, 25))


if __name__ == "__main__":
    unittest.main()
