"""
Ingestion pipeline for advanced match metrics (xG, xGA, deep completions, PPDA).
Downloads understat_metadata.parquet from pannadata release and enriches matches
and team_match_stats in SQLite.
"""

from datetime import datetime
from pathlib import Path
import sqlite3
import pandas as pd
import requests

from .db import (
    BASE_DIR,
    DATA_DIR,
    get_connection,
    normalize_team_name,
)

RAW_XG_DIR = DATA_DIR / "raw" / "understat"
PARQUET_URL = "https://github.com/peteowen1/pannadata/releases/download/understat-latest/understat_metadata.parquet"
CACHED_PARQUET = RAW_XG_DIR / "understat_metadata.parquet"

LEAGUE_MAPPING = {
    "EPL": "eng.1",
    "La liga": "esp.1",
    "Bundesliga": "ger.1",
    "Serie A": "ita.1",
    "Ligue 1": "fra.1",
}


def download_understat_parquet() -> Path:
    """Download Understat match metadata parquet if not already present."""
    RAW_XG_DIR.mkdir(parents=True, exist_ok=True)
    if CACHED_PARQUET.exists() and CACHED_PARQUET.stat().st_size > 500_000:
        return CACHED_PARQUET

    print(f"Downloading Understat metadata from {PARQUET_URL}...")
    resp = requests.get(PARQUET_URL, timeout=30)
    resp.raise_for_status()
    CACHED_PARQUET.write_bytes(resp.content)
    print(f"Downloaded {len(resp.content)} bytes to {CACHED_PARQUET}")
    return CACHED_PARQUET


def ingest_xg(conn: sqlite3.Connection) -> dict:
    """Enrich matches and team_match_stats with xG, xGA, deep, and PPDA."""
    start_time = datetime.utcnow().isoformat()
    parquet_path = download_understat_parquet()
    df = pd.read_parquet(parquet_path)

    # Filter to pilot leagues (EPL and La liga)
    df = df[df["league"].isin(["EPL", "La liga", "Bundesliga", "Serie A", "Ligue 1"])].copy()

    # Pre-index existing matches in DB by (league_id, date, home_id, away_id)
    cur = conn.execute("SELECT id, league_id, substr(date_utc, 1, 10) as dt, home_team_id, away_team_id FROM matches")
    match_lookup = {}
    for row in cur.fetchall():
        key = (row["league_id"], row["dt"], row["home_team_id"], row["away_team_id"])
        match_lookup[key] = row["id"]

    matched_count = 0
    updated_stats = 0
    errors = []

    for _, row in df.iterrows():
        try:
            league_id = LEAGUE_MAPPING.get(row["league"])
            if not league_id:
                continue

            # Understat match_date is e.g. '2023-08-11 19:00:00'
            date_raw = str(row["match_date"])[:10]
            home_raw = str(row["home_team"])
            away_raw = str(row["away_team"])
            home_id = normalize_team_name(home_raw)
            away_id = normalize_team_name(away_raw)

            match_id = match_lookup.get((league_id, date_raw, home_id, away_id))
            if not match_id:
                # Sometimes date is off by +/- 1 day due to UTC conversion, try nearby dates
                continue

            matched_count += 1
            home_xg = float(row["home_xg"]) if pd.notna(row.get("home_xg")) else None
            away_xg = float(row["away_xg"]) if pd.notna(row.get("away_xg")) else None
            home_deep = int(row["home_deep"]) if pd.notna(row.get("home_deep")) else None
            away_deep = int(row["away_deep"]) if pd.notna(row.get("away_deep")) else None
            home_ppda = float(row["home_ppda"]) if pd.notna(row.get("home_ppda")) else None
            away_ppda = float(row["away_ppda"]) if pd.notna(row.get("away_ppda")) else None

            with conn:
                # Update home stats
                conn.execute(
                    """
                    UPDATE team_match_stats
                    SET xg = ?, xga = ?, deep_completions = ?, ppda = ?
                    WHERE match_id = ? AND is_home = 1
                    """,
                    (home_xg, away_xg, home_deep, home_ppda, match_id),
                )
                # Update away stats
                conn.execute(
                    """
                    UPDATE team_match_stats
                    SET xg = ?, xga = ?, deep_completions = ?, ppda = ?
                    WHERE match_id = ? AND is_home = 0
                    """,
                    (away_xg, home_xg, away_deep, away_ppda, match_id),
                )
                updated_stats += 2

        except Exception as e:
            errors.append(f"Row error: {e}")

    # Record ingestion run
    with conn:
        conn.execute(
            """
            INSERT INTO ingestion_runs (source_id, started_at, finished_at, status, rows_inserted, errors)
            VALUES ('understat', ?, datetime('now'), ?, ?, ?)
            """,
            (start_time, "success" if not errors else "partial", matched_count, "; ".join(errors[:5])),
        )

    summary = {
        "status": "success" if not errors else "partial",
        "matches_matched": matched_count,
        "team_stats_updated": updated_stats,
        "errors_count": len(errors),
    }
    print(f"Understat xG ingestion complete: {summary}")
    return summary


if __name__ == "__main__":
    conn = get_connection()
    ingest_xg(conn)
    conn.close()
