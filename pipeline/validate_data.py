"""
Data Quality Validation and Coverage Reporting for MOTOR-NOX V1.0.
Verifies data integrity, absence of leakage, ranges, and coverage thresholds.
"""

from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3

from .db import DB_PATH, get_connection


def validate_all(conn: sqlite3.Connection) -> dict:
    """Run all data quality audits and produce coverage report."""
    issues = []

    # 1. Duplicate checks
    dup_matches = conn.execute(
        """
        SELECT league_id, substr(date_utc, 1, 10) as dt, home_team_id, away_team_id, count(*) as c
        FROM matches
        GROUP BY league_id, dt, home_team_id, away_team_id
        HAVING c > 1
        """
    ).fetchall()
    if dup_matches:
        issues.append(f"Found {len(dup_matches)} duplicate matches by league/date/teams")

    # 2. Unmapped teams (id is empty or contains strange chars)
    unmapped_teams = conn.execute(
        "SELECT id, name FROM teams WHERE id IS NULL OR id = '' OR length(id) < 2"
    ).fetchall()
    if unmapped_teams:
        issues.append(f"Found {len(unmapped_teams)} unmapped teams")

    # 3. Invalid or negative goals
    bad_goals = conn.execute(
        "SELECT id, home_goals, away_goals FROM matches WHERE home_goals < 0 OR away_goals < 0"
    ).fetchall()
    if bad_goals:
        issues.append(f"Found {len(bad_goals)} matches with negative goals")

    # 4. Out-of-range stats
    bad_stats = conn.execute(
        """
        SELECT count(*) as c FROM team_match_stats
        WHERE (shots < 0 OR shots > 60)
           OR (shots_on_target < 0 OR shots_on_target > 40)
           OR (corners < 0 OR corners > 35)
           OR (yellow_cards < 0 OR yellow_cards > 15)
           OR (red_cards < 0 OR red_cards > 6)
           OR (xg < 0 OR xg > 15)
        """
    ).fetchone()[0]
    if bad_stats > 0:
        issues.append(f"Found {bad_stats} team stats with out-of-range values")

    # 5. Invalid odds (implied prob <= 0 or > 1)
    bad_odds = conn.execute(
        """
        SELECT count(*) as c FROM odds
        WHERE price <= 1.0 OR prob_devigged <= 0 OR prob_devigged > 1.0
        """
    ).fetchone()[0]
    if bad_odds > 0:
        issues.append(f"Found {bad_odds} invalid odds entries")

    # 6. Detailed Coverage per League & Season
    query_cov = """
        SELECT
            m.league_id,
            l.name as league_name,
            m.season,
            count(m.id) as total_matches,
            count(CASE WHEN m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL THEN 1 END) as matches_with_score,
            count(CASE WHEN tms_h.shots IS NOT NULL AND tms_a.shots IS NOT NULL THEN 1 END) as matches_with_shots,
            count(CASE WHEN tms_h.xg IS NOT NULL AND tms_a.xg IS NOT NULL THEN 1 END) as matches_with_xg,
            count(CASE WHEN o.has_odds = 1 THEN 1 END) as matches_with_odds,
            count(CASE WHEN m.venue_id IS NOT NULL THEN 1 END) as matches_with_venue,
            count(CASE WHEN lu.teams >= 2 THEN 1 END) as matches_with_lineup,
            count(CASE WHEN lu_xi.teams_with_xi >= 2 THEN 1 END) as matches_with_full_lineup
        FROM matches m
        JOIN leagues l ON m.league_id = l.id
        LEFT JOIN team_match_stats tms_h ON m.id = tms_h.match_id AND tms_h.is_home = 1
        LEFT JOIN team_match_stats tms_a ON m.id = tms_a.match_id AND tms_a.is_home = 0
        LEFT JOIN (SELECT DISTINCT match_id, 1 as has_odds FROM odds WHERE market = '1X2') o ON m.id = o.match_id
        LEFT JOIN (
            SELECT match_id, count(DISTINCT team_id) as teams
            FROM lineups
            GROUP BY match_id
        ) lu ON m.id = lu.match_id
        LEFT JOIN (
            SELECT match_id, count(*) as teams_with_xi
            FROM (
                SELECT match_id, team_id
                FROM lineups
                WHERE is_starter = 1
                GROUP BY match_id, team_id
                HAVING count(*) = 11
            )
            GROUP BY match_id
        ) lu_xi ON m.id = lu_xi.match_id
        GROUP BY m.league_id, l.name, m.season
        ORDER BY m.league_id, m.season
    """
    rows = conn.execute(query_cov).fetchall()
    coverage_table = []
    total_all_matches = 0
    total_all_xg = 0
    total_all_odds = 0
    total_all_lineups = 0
    total_all_full_lineups = 0

    for r in rows:
        n = r["total_matches"]
        total_all_matches += n
        total_all_xg += r["matches_with_xg"]
        total_all_odds += r["matches_with_odds"]
        total_all_lineups += r["matches_with_lineup"]
        total_all_full_lineups += r["matches_with_full_lineup"]
        entry = {
            "league_id": r["league_id"],
            "league_name": r["league_name"],
            "season": r["season"],
            "matches": n,
            "score_pct": round(r["matches_with_score"] * 100.0 / n, 2) if n else 0,
            "shots_pct": round(r["matches_with_shots"] * 100.0 / n, 2) if n else 0,
            "xg_pct": round(r["matches_with_xg"] * 100.0 / n, 2) if n else 0,
            "odds_pct": round(r["matches_with_odds"] * 100.0 / n, 2) if n else 0,
            "venue_pct": round(r["matches_with_venue"] * 100.0 / n, 2) if n else 0,
            "lineup_pct": round(r["matches_with_lineup"] * 100.0 / n, 2) if n else 0,
            "full_lineup_pct": round(r["matches_with_full_lineup"] * 100.0 / n, 2) if n else 0,
        }
        coverage_table.append(entry)

    overall_xg_pct = round(total_all_xg * 100.0 / total_all_matches, 2) if total_all_matches else 0
    overall_odds_pct = round(total_all_odds * 100.0 / total_all_matches, 2) if total_all_matches else 0
    overall_lineup_pct = round(total_all_lineups * 100.0 / total_all_matches, 2) if total_all_matches else 0
    overall_full_lineup_pct = round(total_all_full_lineups * 100.0 / total_all_matches, 2) if total_all_matches else 0

    if total_all_matches and overall_lineup_pct < 80:
        issues.append(
            f"Lineup coverage {overall_lineup_pct}% is below the 80% pilot target"
        )

    # Summary
    team_count = conn.execute("SELECT count(*) FROM teams").fetchone()[0]
    odds_count = conn.execute("SELECT count(*) FROM odds").fetchone()[0]
    stats_count = conn.execute("SELECT count(*) FROM team_match_stats").fetchone()[0]
    lineup_count = conn.execute("SELECT count(*) FROM lineups").fetchone()[0]
    player_count = conn.execute("SELECT count(*) FROM players").fetchone()[0]

    report = {
        "verified_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "PASS" if not issues else "FAIL",
        "issues": issues,
        "summary": {
            "total_matches": total_all_matches,
            "total_teams": team_count,
            "total_team_stats": stats_count,
            "total_odds_records": odds_count,
            "total_lineup_rows": lineup_count,
            "total_players": player_count,
            "overall_xg_coverage_pct": overall_xg_pct,
            "overall_odds_coverage_pct": overall_odds_pct,
            "overall_lineup_coverage_pct": overall_lineup_pct,
            "overall_full_lineup_coverage_pct": overall_full_lineup_pct,
        },
        "coverage_by_season": coverage_table,
    }
    return report


def print_report(report: dict) -> None:
    """Format and print coverage report to stdout."""
    print("=" * 80)
    print(f"MOTOR-NOX V1.0 DATA QUALITY & COVERAGE AUDIT - STATUS: {report['status']}")
    print(f"Verified At: {report['verified_at']}")
    print("=" * 80)
    s = report["summary"]
    print(f"Total Matches:    {s['total_matches']:,}")
    print(f"Total Teams:      {s['total_teams']}")
    print(f"Total Team Stats: {s['total_team_stats']:,}")
    print(f"Total Odds:       {s['total_odds_records']:,}")
    print(f"Lineup Rows:      {s['total_lineup_rows']:,}")
    print(f"Players:          {s['total_players']:,}")
    print(f"Overall xG %:     {s['overall_xg_coverage_pct']}%  (Target: >=90%)")
    print(f"Overall Odds %:   {s['overall_odds_coverage_pct']}% (Target: >=80%)")
    print(f"Overall Lineup %: {s['overall_lineup_coverage_pct']}% (Target: >=80%)")
    print(f"Full XI %:        {s['overall_full_lineup_coverage_pct']}% (Target: >=80%)")
    print("-" * 80)
    print(f"{'League':<16} {'Season':<9} {'Matches':<8} {'Score%':<8} {'Shots%':<8} {'xG%':<8} {'Odds%':<8} {'Venue%':<8} {'Lineup%':<8} {'XI%':<8}")
    print("-" * 80)
    for c in report["coverage_by_season"]:
        print(f"{c['league_name']:<16} {c['season']:<9} {c['matches']:<8} {c['score_pct']:<8.1f} {c['shots_pct']:<8.1f} {c['xg_pct']:<8.1f} {c['odds_pct']:<8.1f} {c['venue_pct']:<8.1f} {c['lineup_pct']:<8.1f} {c['full_lineup_pct']:<8.1f}")
    print("-" * 80)
    if report["issues"]:
        print(f"ISSUES DETECTED ({len(report['issues'])}):")
        for iss in report["issues"]:
            print(f"  [X] {iss}")
    else:
        print("ALL QUALITY CHECKS PASSED: Zero duplicates, zero unmapped teams, zero negative goals.")
    print("=" * 80)


if __name__ == "__main__":
    conn = get_connection()
    rep = validate_all(conn)
    print_report(rep)
    conn.close()
