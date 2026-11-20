"""
Ingestion pipeline for Football-Data.co.uk.
Downloads 5+ seasons of Premier League and LaLiga, saves raw CSVs in data/raw/,
and normalizes results, match stats, and de-vigged closing odds into SQLite.
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
    init_db,
    normalize_team_name,
)
from .venues import TEAM_VENUE_MAP, populate_venues

RAW_FD_DIR = DATA_DIR / "raw" / "football_data"
BASE_URL = "https://www.football-data.co.uk/mmz4281"

LEAGUES = {
    "eng.1": {
        "code": "E0",
        "name": "Premier League",
        "country": "England",
        "tier": 1,
    },
    "esp.1": {
        "code": "SP1",
        "name": "LaLiga",
        "country": "Spain",
        "tier": 1,
    },
    "ger.1": {
        "code": "D1",
        "name": "Bundesliga",
        "country": "Germany",
        "tier": 1,
    },
    "ita.1": {
        "code": "I1",
        "name": "Serie A",
        "country": "Italy",
        "tier": 1,
    },
    "fra.1": {
        "code": "F1",
        "name": "Ligue 1",
        "country": "France",
        "tier": 1,
    },
}

SEASONS = [
    ("2020-21", "2021"),
    ("2021-22", "2122"),
    ("2022-23", "2223"),
    ("2023-24", "2324"),
    ("2024-25", "2425"),
    ("2025-26", "2526"),
    ("2026-27", "2627"),
]


def download_csv(season_code: str, league_code: str) -> Path | None:
    """Download raw CSV if not already cached and return its path."""
    RAW_FD_DIR.mkdir(parents=True, exist_ok=True)
    out_path = RAW_FD_DIR / f"{league_code}_{season_code}.csv"
    if out_path.exists() and out_path.stat().st_size > 1000:
        return out_path

    url = f"{BASE_URL}/{season_code}/{league_code}.csv"
    try:
        resp = requests.get(url, timeout=15)
        if resp.status_code == 200 and len(resp.content) > 1000:
            out_path.write_bytes(resp.content)
            print(f"Downloaded {league_code} {season_code} ({len(resp.content)} bytes)")
            return out_path
        else:
            print(f"Season {season_code} {league_code} returned status {resp.status_code}")
            return None
    except Exception as e:
        print(f"Failed to download {url}: {e}")
        return None


def parse_date(date_str: str) -> str:
    """Normalize date strings (DD/MM/YYYY or DD/MM/YY) to YYYY-MM-DD."""
    if not date_str or not isinstance(date_str, str):
        return ""
    date_str = date_str.strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return date_str


def devig_3way(o1: float, ox: float, o2: float) -> tuple[float, float, float] | None:
    """Calculate proportional de-vigged probabilities for 1X2 market."""
    if not (o1 > 1 and ox > 1 and o2 > 1):
        return None
    inv = [1.0 / o1, 1.0 / ox, 1.0 / o2]
    total_inv = sum(inv)
    return (inv[0] / total_inv, inv[1] / total_inv, inv[2] / total_inv)


def devig_2way(o_over: float, o_under: float) -> tuple[float, float] | None:
    """Calculate proportional de-vigged probabilities for 2-way market."""
    if not (o_over > 1 and o_under > 1):
        return None
    inv = [1.0 / o_over, 1.0 / o_under]
    total_inv = sum(inv)
    return (inv[0] / total_inv, inv[1] / total_inv)


def ingest_all(conn: sqlite3.Connection) -> dict:
    """Run full ingestion for all target leagues and seasons."""
    init_db()
    populate_venues(conn)

    start_time = datetime.utcnow().isoformat()
    total_matches = 0
    total_odds = 0
    errors = []

    for league_id, linfo in LEAGUES.items():
        league_code = linfo["code"]
        # Ensure league exists in DB
        with conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO leagues (id, name, country, season, tier)
                VALUES (?, ?, ?, ?, ?)
                """,
                (league_id, linfo["name"], linfo["country"], "2024-25", linfo["tier"]),
            )

        for season_label, season_code in SEASONS:
            csv_path = download_csv(season_code, league_code)
            if not csv_path or not csv_path.exists():
                continue

            try:
                # Read CSV, tolerate encoding
                df = pd.read_csv(csv_path, encoding="latin1")
            except Exception as e:
                errors.append(f"Error reading {csv_path.name}: {e}")
                continue

            # Check essential columns
            required_cols = {"Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"}
            if not required_cols.issubset(df.columns):
                errors.append(f"Missing columns in {csv_path.name}")
                continue

            # Drop empty rows (scheduled or cancelled games without score)
            df = df.dropna(subset=["FTHG", "FTAG", "HomeTeam", "AwayTeam"])

            for _, row in df.iterrows():
                try:
                    home_raw = str(row["HomeTeam"]).strip()
                    away_raw = str(row["AwayTeam"]).strip()
                    home_id = normalize_team_name(home_raw)
                    away_id = normalize_team_name(away_raw)
                    if not home_id or not away_id:
                        continue

                    # Register teams
                    home_venue = TEAM_VENUE_MAP.get(home_id)
                    away_venue = TEAM_VENUE_MAP.get(away_id)
                    with conn:
                        conn.execute(
                            """
                            INSERT OR IGNORE INTO teams (id, league_id, name, normalized_name, venue_id)
                            VALUES (?, ?, ?, ?, ?)
                            """,
                            (home_id, league_id, home_raw, home_id, home_venue),
                        )
                        conn.execute(
                            """
                            INSERT OR IGNORE INTO teams (id, league_id, name, normalized_name, venue_id)
                            VALUES (?, ?, ?, ?, ?)
                            """,
                            (away_id, league_id, away_raw, away_id, away_venue),
                        )

                    date_iso = parse_date(str(row["Date"]))
                    time_str = str(row.get("Time", "00:00:00")) if pd.notna(row.get("Time")) else "00:00:00"
                    date_utc = f"{date_iso}T{time_str}" if len(time_str) >= 5 else date_iso

                    match_id = f"fd_{league_id}_{season_label}_{home_id}_{away_id}"
                    fthg = int(row["FTHG"])
                    ftag = int(row["FTAG"])
                    hthg = int(row["HTHG"]) if pd.notna(row.get("HTHG")) else None
                    htag = int(row["HTAG"]) if pd.notna(row.get("HTAG")) else None
                    referee = str(row.get("Referee", "")).strip() if pd.notna(row.get("Referee")) else None

                    # Insert match
                    with conn:
                        conn.execute(
                            """
                            INSERT OR REPLACE INTO matches (
                                id, league_id, season, date_utc, home_team_id, away_team_id,
                                status, home_goals, away_goals, ht_home_goals, ht_away_goals,
                                venue_id, referee
                            ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                match_id,
                                league_id,
                                season_label,
                                date_utc,
                                home_id,
                                away_id,
                                fthg,
                                ftag,
                                hthg,
                                htag,
                                home_venue,
                                referee,
                            ),
                        )
                        total_matches += 1

                    # Match stats
                    hs = int(row["HS"]) if pd.notna(row.get("HS")) else None
                    as_ = int(row["AS"]) if pd.notna(row.get("AS")) else None
                    hst = int(row["HST"]) if pd.notna(row.get("HST")) else None
                    ast = int(row["AST"]) if pd.notna(row.get("AST")) else None
                    hc = int(row["HC"]) if pd.notna(row.get("HC")) else None
                    ac = int(row["AC"]) if pd.notna(row.get("AC")) else None
                    hf = int(row["HF"]) if pd.notna(row.get("HF")) else None
                    af = int(row["AF"]) if pd.notna(row.get("AF")) else None
                    hy = int(row["HY"]) if pd.notna(row.get("HY")) else None
                    ay = int(row["AY"]) if pd.notna(row.get("AY")) else None
                    hr = int(row["HR"]) if pd.notna(row.get("HR")) else None
                    ar = int(row["AR"]) if pd.notna(row.get("AR")) else None

                    with conn:
                        # Home stats
                        conn.execute(
                            """
                            INSERT INTO team_match_stats (
                                match_id, team_id, is_home, shots, shots_on_target,
                                corners, fouls, yellow_cards, red_cards, source
                            ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'football_data')
                            ON CONFLICT(match_id, team_id) DO UPDATE SET
                                is_home = excluded.is_home,
                                shots = excluded.shots,
                                shots_on_target = excluded.shots_on_target,
                                corners = excluded.corners,
                                fouls = excluded.fouls,
                                yellow_cards = excluded.yellow_cards,
                                red_cards = excluded.red_cards,
                                source = coalesce(team_match_stats.source, excluded.source)
                            """,
                            (match_id, home_id, hs, hst, hc, hf, hy, hr),
                        )
                        # Away stats
                        conn.execute(
                            """
                            INSERT INTO team_match_stats (
                                match_id, team_id, is_home, shots, shots_on_target,
                                corners, fouls, yellow_cards, red_cards, source
                            ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'football_data')
                            ON CONFLICT(match_id, team_id) DO UPDATE SET
                                is_home = excluded.is_home,
                                shots = excluded.shots,
                                shots_on_target = excluded.shots_on_target,
                                corners = excluded.corners,
                                fouls = excluded.fouls,
                                yellow_cards = excluded.yellow_cards,
                                red_cards = excluded.red_cards,
                                source = coalesce(team_match_stats.source, excluded.source)
                            """,
                            (match_id, away_id, as_, ast, ac, af, ay, ar),
                        )

                    # Market closing odds: Bet365 and Pinnacle
                    odds_entries = []
                    # Bet365 1X2
                    b365h = float(row["B365H"]) if pd.notna(row.get("B365H")) else None
                    b365d = float(row["B365D"]) if pd.notna(row.get("B365D")) else None
                    b365a = float(row["B365A"]) if pd.notna(row.get("B365A")) else None
                    if b365h and b365d and b365a:
                        dev = devig_3way(b365h, b365d, b365a)
                        if dev:
                            odds_entries.extend([
                                (match_id, "1X2", "1", b365h, 1.0 / b365h, dev[0], "Bet365"),
                                (match_id, "1X2", "X", b365d, 1.0 / b365d, dev[1], "Bet365"),
                                (match_id, "1X2", "2", b365a, 1.0 / b365a, dev[2], "Bet365"),
                            ])

                    # Pinnacle 1X2 (Closing PSH/PSD/PSA or MaxCH/MaxCD/MaxCA)
                    psh = float(row["PSH"]) if pd.notna(row.get("PSH")) else None
                    psd = float(row["PSD"]) if pd.notna(row.get("PSD")) else None
                    psa = float(row["PSA"]) if pd.notna(row.get("PSA")) else None
                    if psh and psd and psa:
                        dev = devig_3way(psh, psd, psa)
                        if dev:
                            odds_entries.extend([
                                (match_id, "1X2", "1", psh, 1.0 / psh, dev[0], "Pinnacle"),
                                (match_id, "1X2", "X", psd, 1.0 / psd, dev[1], "Pinnacle"),
                                (match_id, "1X2", "2", psa, 1.0 / psa, dev[2], "Pinnacle"),
                            ])

                    # Over / Under 2.5
                    b365_over = float(row["B365>2.5"]) if pd.notna(row.get("B365>2.5")) else None
                    b365_under = float(row["B365<2.5"]) if pd.notna(row.get("B365<2.5")) else None
                    if b365_over and b365_under:
                        dev = devig_2way(b365_over, b365_under)
                        if dev:
                            odds_entries.extend([
                                (match_id, "OU25", "Over", b365_over, 1.0 / b365_over, dev[0], "Bet365"),
                                (match_id, "OU25", "Under", b365_under, 1.0 / b365_under, dev[1], "Bet365"),
                            ])

                    p_over = float(row["P>2.5"]) if pd.notna(row.get("P>2.5")) else None
                    p_under = float(row["P<2.5"]) if pd.notna(row.get("P<2.5")) else None
                    if p_over and p_under:
                        dev = devig_2way(p_over, p_under)
                        if dev:
                            odds_entries.extend([
                                (match_id, "OU25", "Over", p_over, 1.0 / p_over, dev[0], "Pinnacle"),
                                (match_id, "OU25", "Under", p_under, 1.0 / p_under, dev[1], "Pinnacle"),
                            ])

                    if odds_entries:
                        with conn:
                            conn.executemany(
                                """
                                INSERT OR REPLACE INTO odds (
                                    match_id, market, selection, price, prob_implied, prob_devigged, bookmaker, is_closing
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                                """,
                                odds_entries,
                            )
                            total_odds += len(odds_entries)

                except Exception as row_err:
                    errors.append(f"Row error: {row_err}")

    # Record ingestion run
    with conn:
        conn.execute(
            """
            INSERT INTO ingestion_runs (source_id, started_at, finished_at, status, rows_inserted, errors)
            VALUES ('football_data', ?, datetime('now'), ?, ?, ?)
            """,
            (start_time, "success" if not errors else "partial", total_matches, "; ".join(errors[:5])),
        )

    summary = {
        "status": "success" if not errors else "partial",
        "matches_ingested": total_matches,
        "odds_records": total_odds,
        "errors_count": len(errors),
    }
    print(f"Football-Data ingestion complete: {summary}")
    return summary


if __name__ == "__main__":
    conn = get_connection()
    ingest_all(conn)
    conn.close()
