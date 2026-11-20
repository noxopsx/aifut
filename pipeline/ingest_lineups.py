"""
Historical lineup ingestion for MOTOR-NOX V1.0.

ESPN publishes the confirmed lineups for completed matches in its public
summary endpoint. This module rebuilds the event index from the team
schedules, maps every ESPN event to the normalized Football-Data match, and
stores the roster extract in SQLite.

Design notes
------------
* Only the public ESPN endpoints are used; no API key is required.
* The raw roster extract is cached per event so the backfill is resumable and
  repeated runs do not hit ESPN again.
* The event index is cached per league/season. Use ``--refresh-index`` after a
  mapping change or when a season is still in progress.
* ESPN does not expose official minutes in the summary payload. The module
  stores ``minutes_played = NULL`` and keeps the starter/substitution flags in
  the source extract. Minutes must not be inferred silently.

Usage
-----
    python -m pipeline.ingest_lineups --map-only
    python -m pipeline.ingest_lineups --league eng.1 --season 2023-24 --limit 20
    python -m pipeline.ingest_lineups --workers 6
    python -m pipeline.ingest_lineups --refresh --refresh-index
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from .db import DATA_DIR, get_connection, init_db

BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer"
RAW_DIR = DATA_DIR / "raw" / "espn_lineups"
INDEX_DIR = RAW_DIR / "_index"
INDEX_VERSION = 1
USER_AGENT = "MOTOR-NOX/2.0 (personal research; historical lineup backfill)"

LEAGUES = {
    "eng.1": "Premier League",
    "esp.1": "LaLiga",
}

SEASONS = [
    ("2020-21", 2020),
    ("2021-22", 2021),
    ("2022-23", 2022),
    ("2023-24", 2023),
    ("2024-25", 2024),
    ("2025-26", 2025),
]

# ESPN display names that do not collapse to our canonical team id with the
# generic normalizer. Keys are ASCII slugs produced by ``ascii_key``.
ESPN_TEAM_ALIASES = {
    "afc_bournemouth": "bournemouth",
    "brighton_and_hove_albion": "brighton",
    "brighton_hove_albion": "brighton",
    "tottenham_hotspur": "tottenham",
    "newcastle_united": "newcastle",
    "wolverhampton_wanderers": "wolverhampton",
    "leeds_united": "leeds",
    "leicester_city": "leicester",
    "norwich_city": "norwich",
    "luton_town": "luton",
    "ipswich_town": "ipswich",
    "west_bromwich_albion": "west_brom",
    "west_ham_united": "west_ham",
    "sheffield_united": "sheffield_united",
    "nottingham_forest": "nottingham_forest",
    "manchester_city": "manchester_city",
    "manchester_united": "manchester_united",
    "rcd_espanyol": "espanyol",
    "deportivo_alaves": "alaves",
    "real_betis": "real_betis",
    "real_sociedad": "real_sociedad",
    "real_valladolid": "real_valladolid",
    "real_oviedo": "real_oviedo",
    "rayo_vallecano": "rayo_vallecano",
    "celta_vigo": "celta_vigo",
    "athletic_club": "athletic_club",
    "atletico_madrid": "atletico_madrid",
}


def now_iso() -> str:
    """Return a timezone-aware UTC timestamp."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ascii_key(value: str | None) -> str:
    """Normalize a name for accent-insensitive matching."""
    if not value:
        return ""
    decomposed = unicodedata.normalize("NFKD", str(value))
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    stripped = stripped.lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "_", stripped).strip("_")


def parse_utc(value: str | None) -> datetime | None:
    """Parse an ESPN or Football-Data timestamp as UTC."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def http_json(
    path: str,
    params: dict | None = None,
    timeout: int = 30,
    retries: int = 4,
) -> dict:
    """Fetch JSON from ESPN with retries and backoff."""
    url = f"{BASE_URL}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    last_error: Exception | None = None
    for attempt in range(retries):
        request = urllib.request.Request(
            url,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in (429, 500, 502, 503, 504):
                raise
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            wait = float(retry_after) if retry_after and retry_after.isdigit() else 1.5 * (attempt + 1)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            wait = 1.5 * (attempt + 1)
        time.sleep(wait)
    raise RuntimeError(f"ESPN request failed after {retries} attempts: {url}: {last_error}")


class TeamResolver:
    """Map ESPN team names to the canonical team ids used in SQLite."""

    def __init__(self, conn: sqlite3.Connection, league_id: str):
        self.league_id = league_id
        self.by_key: dict[str, str] = {}
        rows = conn.execute(
            "SELECT id, name, normalized_name FROM teams WHERE league_id = ?",
            (league_id,),
        ).fetchall()
        for row in rows:
            team_id = row["id"]
            for key in (ascii_key(team_id), ascii_key(row["name"]), ascii_key(row["normalized_name"])):
                if key:
                    self.by_key.setdefault(key, team_id)
        self.team_ids = {row["id"] for row in rows}

    def resolve(self, name: str | None) -> str | None:
        key = ascii_key(name)
        if not key:
            return None
        if key in ESPN_TEAM_ALIASES:
            candidate = ESPN_TEAM_ALIASES[key]
            return candidate if candidate in self.team_ids else None
        if key in self.by_key:
            return self.by_key[key]
        # Fall back to unique containment: "Brighton & Hove Albion" -> "brighton".
        candidates = {
            team_id
            for known_key, team_id in self.by_key.items()
            if len(known_key) >= 4 and (known_key in key or key in known_key)
        }
        if len(candidates) == 1:
            return candidates.pop()
        return None


def write_json(path: Path, payload: dict) -> None:
    """Write JSON atomically so an interrupted run cannot corrupt the cache."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    temp.replace(path)


def read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def discover_league_teams(
    league_id: str,
    seasons: list[tuple[str, int]],
    refresh: bool = False,
) -> dict:
    """Discover every ESPN team id that played in the league in the window.

    The scoreboard endpoint returns the first 100 events of a calendar year.
    Querying the second half of each season (January-March) exposes the full
    set of teams for that season, including teams that were later relegated.
    """
    # Always discover against the full supported window. A partial first run
    # must not poison the cache for later seasons.
    calendar_years = sorted({year + 1 for _, year in SEASONS})
    cache_path = INDEX_DIR / f"{league_id}_teams.json"
    if cache_path.exists() and not refresh:
        cached = read_json(cache_path)
        if (
            cached
            and cached.get("version") == INDEX_VERSION
            and cached.get("calendar_years") == calendar_years
        ):
            return cached

    teams: dict[str, dict] = {}
    for calendar_year in calendar_years:
        payload = http_json(f"{league_id}/scoreboard", {"dates": calendar_year})
        for event in payload.get("events", []):
            for competition in event.get("competitions", [])[:1]:
                for competitor in competition.get("competitors", []):
                    team = competitor.get("team") or {}
                    team_id = team.get("id")
                    if team_id:
                        teams[str(team_id)] = {
                            "id": str(team_id),
                            "name": team.get("displayName") or team.get("name"),
                            "abbreviation": team.get("abbreviation"),
                        }

    # The current team directory covers the ongoing season even when the
    # January-March query is not available yet.
    try:
        directory = http_json(f"{league_id}/teams")
        for entry in directory.get("sports", [{}])[0].get("leagues", [{}])[0].get("teams", []):
            team = entry.get("team") or {}
            team_id = team.get("id")
            if team_id:
                teams.setdefault(str(team_id), {
                    "id": str(team_id),
                    "name": team.get("displayName") or team.get("name"),
                    "abbreviation": team.get("abbreviation"),
                })
    except RuntimeError as exc:
        print(f"  warning: no se pudo leer el directorio de equipos de {league_id}: {exc}")

    payload = {
        "version": INDEX_VERSION,
        "league_id": league_id,
        "calendar_years": calendar_years,
        "generated_at": now_iso(),
        "teams": sorted(teams.values(), key=lambda item: int(item["id"]) if item["id"].isdigit() else item["id"]),
    }
    write_json(cache_path, payload)
    return payload


def fetch_schedules(
    league_id: str,
    team_ids: Iterable[str],
    season_year: int,
    workers: int,
) -> tuple[list[dict], list[str]]:
    """Fetch the league schedule for every team in one season."""
    events: dict[str, dict] = {}
    errors: list[str] = []
    tasks = list(team_ids)

    def fetch(team_id: str) -> list[dict]:
        payload = http_json(
            f"{league_id}/teams/{team_id}/schedule",
            {"season": season_year},
        )
        return payload.get("events", [])

    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {executor.submit(fetch, team_id): team_id for team_id in tasks}
        for future in as_completed(futures):
            team_id = futures[future]
            try:
                for event in future.result():
                    event_id = str(event.get("id") or "")
                    if event_id:
                        events[event_id] = event
            except Exception as exc:  # noqa: BLE001 - report and continue
                errors.append(f"team {team_id}: {exc}")

    return list(events.values()), errors


def recover_missing_events(
    league_id: str,
    season_year: int,
    missing: list[dict],
    resolver: TeamResolver,
    mapped: list[dict],
    used_match_ids: set[str],
    used_event_ids: set[str],
) -> int:
    """Recover events that the team-schedule endpoint omits.

    A small number of fixtures (notably rescheduled matches and a few LaLiga
    games) are present in the daily scoreboard but absent from one or both
    team schedules. Querying the match date is a cheap and explicit fallback.
    """
    by_date: dict[str, list[dict]] = {}
    for item in missing:
        parsed = parse_utc(item.get("date"))
        if not parsed:
            continue
        for offset in (0, 1):
            day = (parsed + timedelta(days=offset)).strftime("%Y%m%d")
            by_date.setdefault(day, []).append(item)

    recovered = 0
    for day, candidates in by_date.items():
        try:
            payload = http_json(f"{league_id}/scoreboard", {"dates": day})
        except RuntimeError:
            continue
        for event in payload.get("events", []):
            if (event.get("season") or {}).get("year") != season_year:
                continue
            event_league = (event.get("league") or {}).get("slug")
            if event_league and event_league != league_id:
                continue
            event_id = str(event.get("id") or "")
            if not event_id or event_id in used_event_ids:
                continue
            competitions = event.get("competitions") or []
            if not competitions:
                continue
            competitors = competitions[0].get("competitors") or []
            home = next((item for item in competitors if item.get("homeAway") == "home"), None)
            away = next((item for item in competitors if item.get("homeAway") == "away"), None)
            if not home or not away:
                continue
            home_name = (home.get("team") or {}).get("displayName")
            away_name = (away.get("team") or {}).get("displayName")
            home_id = resolver.resolve(home_name)
            away_id = resolver.resolve(away_name)
            if not home_id or not away_id:
                continue
            for item in candidates:
                if item["match_id"] in used_match_ids:
                    continue
                if (home_id, away_id) != (item["home_team_id"], item["away_team_id"]):
                    continue
                mapped.append({
                    "match_id": item["match_id"],
                    "event_id": event_id,
                    "event_date": event.get("date"),
                    "match_date": item.get("date"),
                    "home_team_id": home_id,
                    "away_team_id": away_id,
                    "espn_home_id": str((home.get("team") or {}).get("id") or ""),
                    "espn_away_id": str((away.get("team") or {}).get("id") or ""),
                    "espn_home_name": home_name,
                    "espn_away_name": away_name,
                    "recovered_from": "scoreboard",
                })
                used_match_ids.add(item["match_id"])
                used_event_ids.add(event_id)
                recovered += 1
                break
    return recovered


def build_season_index(
    conn: sqlite3.Connection,
    league_id: str,
    season: str,
    season_year: int,
    team_ids: Iterable[str],
    resolver: TeamResolver,
    workers: int,
) -> dict:
    """Map ESPN events to normalized matches for one league/season."""
    events, schedule_errors = fetch_schedules(league_id, team_ids, season_year, workers)

    rows = conn.execute(
        """
        SELECT id, date_utc, home_team_id, away_team_id
        FROM matches
        WHERE league_id = ? AND season = ?
        """,
        (league_id, season),
    ).fetchall()
    by_pair: dict[tuple[str, str], list[sqlite3.Row]] = {}
    for row in rows:
        by_pair.setdefault((row["home_team_id"], row["away_team_id"]), []).append(row)

    mapped: list[dict] = []
    unmapped_events: list[dict] = []
    used_match_ids: set[str] = set()

    for event in events:
        if (event.get("season") or {}).get("year") != season_year:
            continue
        event_league = (event.get("league") or {}).get("slug")
        if event_league and event_league != league_id:
            continue
        competitions = event.get("competitions") or []
        if not competitions:
            continue
        competitors = competitions[0].get("competitors") or []
        home = next((item for item in competitors if item.get("homeAway") == "home"), None)
        away = next((item for item in competitors if item.get("homeAway") == "away"), None)
        if not home or not away:
            continue

        home_name = (home.get("team") or {}).get("displayName")
        away_name = (away.get("team") or {}).get("displayName")
        home_id = resolver.resolve(home_name)
        away_id = resolver.resolve(away_name)
        if not home_id or not away_id:
            unmapped_events.append({
                "event_id": str(event.get("id")),
                "date": event.get("date"),
                "home": home_name,
                "away": away_name,
                "reason": "equipo sin mapear",
            })
            continue

        candidates = by_pair.get((home_id, away_id), [])
        if not candidates:
            unmapped_events.append({
                "event_id": str(event.get("id")),
                "date": event.get("date"),
                "home": home_name,
                "away": away_name,
                "reason": "partido no encontrado en matches",
            })
            continue

        event_date = parse_utc(event.get("date"))
        best = min(
            candidates,
            key=lambda row: abs(
                ((event_date or datetime.min.replace(tzinfo=timezone.utc))
                 - (parse_utc(row["date_utc"]) or datetime.min.replace(tzinfo=timezone.utc))).total_seconds()
            ),
        )
        if best["id"] in used_match_ids:
            continue
        used_match_ids.add(best["id"])
        mapped.append({
            "match_id": best["id"],
            "event_id": str(event.get("id")),
            "event_date": event.get("date"),
            "match_date": best["date_utc"],
            "home_team_id": home_id,
            "away_team_id": away_id,
            "espn_home_id": str((home.get("team") or {}).get("id") or ""),
            "espn_away_id": str((away.get("team") or {}).get("id") or ""),
            "espn_home_name": home_name,
            "espn_away_name": away_name,
        })

    missing = [
        {
            "match_id": row["id"],
            "date": row["date_utc"],
            "home_team_id": row["home_team_id"],
            "away_team_id": row["away_team_id"],
        }
        for row in rows
        if row["id"] not in used_match_ids
    ]

    recovered = 0
    if missing:
        used_event_ids = {item["event_id"] for item in mapped}
        recovered = recover_missing_events(
            league_id,
            season_year,
            missing,
            resolver,
            mapped,
            used_match_ids,
            used_event_ids,
        )
        missing = [item for item in missing if item["match_id"] not in used_match_ids]

    return {
        "version": INDEX_VERSION,
        "league_id": league_id,
        "season": season,
        "season_year": season_year,
        "built_at": now_iso(),
        "matches_total": len(rows),
        "events_total": len(events),
        "matches_mapped": len(mapped),
        "matches_recovered": recovered,
        "matches_missing": missing,
        "events_unmapped": unmapped_events,
        "schedule_errors": schedule_errors,
        "matches": mapped,
    }


def load_or_build_index(
    conn: sqlite3.Connection,
    league_id: str,
    season: str,
    season_year: int,
    team_ids: Iterable[str],
    resolver: TeamResolver,
    workers: int,
    refresh: bool,
) -> dict:
    cache_path = INDEX_DIR / f"{league_id}_{season}.json"
    if cache_path.exists() and not refresh:
        cached = read_json(cache_path)
        if cached and cached.get("version") == INDEX_VERSION:
            return cached
    index = build_season_index(
        conn, league_id, season, season_year, team_ids, resolver, workers
    )
    write_json(cache_path, index)
    return index


def parse_summary(event_id: str, payload: dict) -> dict:
    """Keep the roster fields needed for the normalized lineup table."""
    teams = []
    for roster in payload.get("rosters") or []:
        team = roster.get("team") or {}
        players = []
        for entry in roster.get("roster") or []:
            athlete = entry.get("athlete") or {}
            player_id = athlete.get("id")
            if not player_id:
                continue
            jersey = entry.get("jersey")
            try:
                shirt_number = int(jersey) if jersey not in (None, "") else None
            except (TypeError, ValueError):
                shirt_number = None
            players.append({
                "id": str(player_id),
                "name": athlete.get("displayName") or athlete.get("fullName") or "",
                "starter": bool(entry.get("starter")),
                "shirt_number": shirt_number,
                "position": (entry.get("position") or {}).get("abbreviation"),
                "subbed_in": bool(entry.get("subbedIn")),
                "subbed_out": bool(entry.get("subbedOut")),
            })
        teams.append({
            "espn_team_id": str(team.get("id") or ""),
            "team_name": team.get("displayName") or team.get("name"),
            "formation": roster.get("formation"),
            "players": players,
        })
    return {
        "event_id": str(event_id),
        "source": "espn",
        "fetched_at": now_iso(),
        "teams": teams,
    }


def fetch_lineup_extract(
    league_id: str,
    season: str,
    event_id: str,
    refresh: bool,
) -> dict:
    """Fetch one ESPN summary and cache only the roster extract."""
    cache_path = RAW_DIR / league_id / season / f"{event_id}.json"
    if cache_path.exists() and not refresh:
        cached = read_json(cache_path)
        if cached and cached.get("event_id") == str(event_id):
            return cached
    payload = http_json(f"{league_id}/summary", {"event": event_id})
    extract = parse_summary(event_id, payload)
    write_json(cache_path, extract)
    return extract


def insert_extract(
    conn: sqlite3.Connection,
    match: dict,
    extract: dict,
    resolver: TeamResolver,
) -> dict:
    """Insert one match lineup. Returns counters for the caller."""
    stats = {"lineups": 0, "players": 0, "teams": 0, "unmapped_teams": 0, "empty": 0}
    event_team_map = {
        match["espn_home_id"]: match["home_team_id"],
        match["espn_away_id"]: match["away_team_id"],
    }
    teams = extract.get("teams") or []
    if not teams:
        stats["empty"] = 1
        return stats

    for team in teams:
        team_id = event_team_map.get(str(team.get("espn_team_id") or ""))
        if not team_id:
            team_id = resolver.resolve(team.get("team_name"))
        if not team_id:
            stats["unmapped_teams"] += 1
            continue
        players = team.get("players") or []
        if not players:
            continue
        stats["teams"] += 1
        # Rebuild the team's rows so a corrected ESPN extract cannot leave
        # stale players behind.
        conn.execute(
            "DELETE FROM lineups WHERE match_id = ? AND team_id = ?",
            (match["match_id"], team_id),
        )
        for player in players:
            player_id = str(player.get("id") or "")
            if not player_id:
                continue
            conn.execute(
                """
                INSERT INTO players (id, name, team_id, position)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    team_id = excluded.team_id,
                    position = COALESCE(excluded.position, players.position)
                """,
                (
                    player_id,
                    player.get("name") or player_id,
                    team_id,
                    player.get("position"),
                ),
            )
            conn.execute(
                """
                INSERT INTO lineups (
                    match_id, team_id, player_id, is_starter,
                    minutes_played, position, shirt_number, formation
                )
                VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
                ON CONFLICT(match_id, team_id, player_id) DO UPDATE SET
                    is_starter = excluded.is_starter,
                    position = excluded.position,
                    shirt_number = excluded.shirt_number,
                    formation = excluded.formation
                """,
                (
                    match["match_id"],
                    team_id,
                    player_id,
                    1 if player.get("starter") else 0,
                    player.get("position"),
                    player.get("shirt_number"),
                    team.get("formation"),
                ),
            )
            stats["players"] += 1
            stats["lineups"] += 1
    return stats


def fetch_extracts(
    league_id: str,
    season: str,
    matches: list[dict],
    refresh: bool,
    workers: int,
) -> tuple[list[tuple[dict, dict]], list[tuple[dict, str]]]:
    """Fetch summaries concurrently and return (successes, errors)."""
    successes: list[tuple[dict, dict]] = []
    errors: list[tuple[dict, str]] = []
    total = len(matches)
    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {
            executor.submit(fetch_lineup_extract, league_id, season, match["event_id"], refresh): match
            for match in matches
        }
        for future in as_completed(futures):
            match = futures[future]
            try:
                successes.append((match, future.result()))
            except Exception as exc:  # noqa: BLE001 - report and continue
                errors.append((match, str(exc)))
            completed += 1
            if completed % 100 == 0 or completed == total:
                print(f"    resúmenes {completed}/{total} · errores {len(errors)}")
    return successes, errors


def run(
    leagues: list[str],
    seasons: list[tuple[str, int]],
    workers: int,
    limit: int | None,
    refresh: bool,
    refresh_index: bool,
    map_only: bool,
    dry_run: bool,
    conn: sqlite3.Connection | None = None,
) -> dict:
    owns_conn = conn is None
    if conn is None:
        init_db()
        conn = get_connection()
    started_at = now_iso()
    totals = {
        "matches_mapped": 0,
        "matches_processed": 0,
        "matches_with_lineups": 0,
        "lineups": 0,
        "player_rows": 0,
        "unique_players": 0,
        "unmapped_teams": 0,
        "empty_extracts": 0,
        "errors": [],
        "seasons": [],
    }

    try:
        for league_id in leagues:
            print("=" * 78)
            print(f"{league_id} · {LEAGUES.get(league_id, league_id)}")
            print("=" * 78)
            team_payload = discover_league_teams(league_id, seasons, refresh=refresh_index)
            team_ids = [team["id"] for team in team_payload.get("teams", [])]
            print(f"Equipos ESPN descubiertos: {len(team_ids)}")
            resolver = TeamResolver(conn, league_id)

            for season, season_year in seasons:
                print(f"\n[{league_id} {season}] construyendo índice de eventos...")
                index = load_or_build_index(
                    conn, league_id, season, season_year,
                    team_ids, resolver, workers, refresh_index,
                )
                total = index["matches_total"]
                mapped = index["matches_mapped"]
                pct = (mapped * 100.0 / total) if total else 0.0
                print(
                    f"  partidos {mapped}/{total} mapeados ({pct:.1f}%) · "
                    f"eventos {index['events_total']} · "
                    f"sin mapear {len(index['events_unmapped'])}"
                )
                totals["matches_mapped"] += mapped
                totals["seasons"].append({
                    "league_id": league_id,
                    "season": season,
                    "matches_total": total,
                    "matches_mapped": mapped,
                    "mapping_pct": round(pct, 2),
                    "events_total": index["events_total"],
                    "events_unmapped": len(index["events_unmapped"]),
                    "matches_missing": len(index["matches_missing"]),
                })

                if map_only:
                    continue

                matches = index["matches"]
                if limit:
                    matches = matches[:limit]
                if not matches:
                    continue

                successes, fetch_errors = fetch_extracts(
                    league_id, season, matches, refresh, workers
                )
                totals["matches_processed"] += len(matches)
                totals["errors"].extend(
                    {
                        "league_id": league_id,
                        "season": season,
                        "match_id": match["match_id"],
                        "event_id": match["event_id"],
                        "error": error,
                    }
                    for match, error in fetch_errors
                )

                season_stats = {
                    "matches": 0,
                    "lineups": 0,
                    "player_rows": 0,
                    "empty": 0,
                    "unmapped_teams": 0,
                }
                if not dry_run:
                    with conn:
                        for match, extract in successes:
                            stats = insert_extract(conn, match, extract, resolver)
                            season_stats["matches"] += 1
                            season_stats["lineups"] += stats["lineups"]
                            season_stats["player_rows"] += stats["players"]
                            season_stats["empty"] += stats["empty"]
                            season_stats["unmapped_teams"] += stats["unmapped_teams"]
                else:
                    for match, extract in successes:
                        season_stats["matches"] += 1
                        season_stats["empty"] += 0 if extract.get("teams") else 1

                totals["matches_with_lineups"] += season_stats["matches"] - season_stats["empty"]
                totals["lineups"] += season_stats["lineups"]
                totals["player_rows"] += season_stats["player_rows"]
                totals["unmapped_teams"] += season_stats["unmapped_teams"]
                totals["empty_extracts"] += season_stats["empty"]
                print(
                    f"  guardados {season_stats['matches']} partidos · "
                    f"{season_stats['lineups']:,} filas de alineación · "
                    f"{season_stats['player_rows']:,} filas de jugador · "
                    f"vacíos {season_stats['empty']} · "
                    f"equipos sin mapear {season_stats['unmapped_teams']}"
                )

        if not dry_run:
            totals["unique_players"] = conn.execute("SELECT count(*) FROM players").fetchone()[0]

        if not dry_run and not map_only and totals["matches_processed"] > 0:
            status = "success" if not totals["errors"] else "partial"
            summary = {
                "matches_mapped": totals["matches_mapped"],
                "matches_processed": totals["matches_processed"],
                "matches_with_lineups": totals["matches_with_lineups"],
                "lineups": totals["lineups"],
                "player_rows": totals["player_rows"],
                "unique_players": totals["unique_players"],
                "unmapped_teams": totals["unmapped_teams"],
                "empty_extracts": totals["empty_extracts"],
                "errors": totals["errors"][:50],
                "seasons": totals["seasons"],
            }
            with conn:
                conn.execute(
                    """
                    INSERT INTO ingestion_runs (
                        source_id, started_at, finished_at, status, rows_inserted, errors
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "espn",
                        started_at,
                        now_iso(),
                        status,
                        totals["lineups"],
                        json.dumps(summary, ensure_ascii=False),
                    ),
                )
                conn.execute(
                    "UPDATE data_sources SET last_downloaded = ? WHERE id = 'espn'",
                    (now_iso(),),
                )
    finally:
        if owns_conn:
            conn.close()

    return totals


def ingest_all_lineups(conn: sqlite3.Connection, workers: int = 6) -> dict:
    """Run the complete lineup backfill using an existing pipeline connection."""
    return run(
        leagues=list(LEAGUES),
        seasons=SEASONS,
        workers=workers,
        limit=None,
        refresh=False,
        refresh_index=False,
        map_only=False,
        dry_run=False,
        conn=conn,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill historical ESPN lineups for MOTOR-NOX V1.0"
    )
    parser.add_argument(
        "--league",
        action="append",
        choices=sorted(LEAGUES),
        help="Liga a procesar (repetible). Por defecto: las dos pilotos.",
    )
    parser.add_argument(
        "--season",
        action="append",
        help="Temporada a procesar, por ejemplo 2023-24 (repetible).",
    )
    parser.add_argument("--workers", type=int, default=6, help="Peticiones concurrentes (default: 6).")
    parser.add_argument("--limit", type=int, default=None, help="Máximo de partidos por liga/temporada (para pruebas).")
    parser.add_argument("--refresh", action="store_true", help="Ignorar la caché de resúmenes.")
    parser.add_argument("--refresh-index", action="store_true", help="Reconstruir el índice de eventos y equipos.")
    parser.add_argument("--map-only", action="store_true", help="Solo construir y reportar el índice, sin descargar resúmenes.")
    parser.add_argument("--dry-run", action="store_true", help="Descargar y validar sin escribir en SQLite.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    leagues = args.league or list(LEAGUES)
    if args.season:
        wanted = set(args.season)
        seasons = [item for item in SEASONS if item[0] in wanted]
        unknown = wanted - {item[0] for item in seasons}
        if unknown:
            print(f"Temporadas desconocidas: {', '.join(sorted(unknown))}", file=sys.stderr)
            return 2
    else:
        seasons = SEASONS

    print("MOTOR-NOX V1.0 · backfill de alineaciones históricas desde ESPN")
    print(f"Ligas: {', '.join(leagues)}")
    print(f"Temporadas: {', '.join(season for season, _ in seasons)}")
    print(f"Concurrencia: {args.workers} · caché: {RAW_DIR}")
    if args.map_only:
        print("Modo: solo índice (sin descargar resúmenes)")
    elif args.dry_run:
        print("Modo: dry-run (sin escribir en SQLite)")
    print()

    totals = run(
        leagues=leagues,
        seasons=seasons,
        workers=args.workers,
        limit=args.limit,
        refresh=args.refresh,
        refresh_index=args.refresh_index,
        map_only=args.map_only,
        dry_run=args.dry_run,
    )

    print("\n" + "=" * 78)
    print("RESUMEN")
    print("=" * 78)
    print(f"Partidos mapeados:       {totals['matches_mapped']:,}")
    print(f"Partidos procesados:     {totals['matches_processed']:,}")
    print(f"Partidos con alineación: {totals['matches_with_lineups']:,}")
    print(f"Filas de alineación:     {totals['lineups']:,}")
    print(f"Filas de jugador:        {totals['player_rows']:,}")
    print(f"Jugadores únicos en DB:  {totals['unique_players']:,}")
    print(f"Resúmenes vacíos:        {totals['empty_extracts']:,}")
    print(f"Equipos sin mapear:      {totals['unmapped_teams']:,}")
    print(f"Errores de red:          {len(totals['errors']):,}")
    if totals["errors"]:
        print("Primeros errores:")
        for error in totals["errors"][:5]:
            print(f"  - {error['match_id']} ({error['event_id']}): {error['error']}")
    print("=" * 78)
    return 0 if not totals["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
