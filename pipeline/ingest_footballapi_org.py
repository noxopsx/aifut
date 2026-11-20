"""
MOTOR-NOX · conector de footballapi.org (plan complimentary / gratuito).

Plan gratuito verificado en https://footballapi.org/documentation/plans-and-limits:
  · Sólo la Premier League de esta temporada (eng.1).
  · 50 llamadas/día (reset 00:00 UTC), 10 llamadas/minuto.
  · Sin live scores (eso es membership de pago).
  · /v1/usage no cuenta contra la cuota.

Endpoints usados (todos dentro del plan gratuito):
  · /v1/fixtures?competition=premier-league&date_from=&date_to=
  · /v1/results/yesterday?competition=premier-league
  · /v1/competitions/premier-league/seasons/{season}/table
  · /v1/usage  (informativo, sin coste)

La clave se lee de FOOTBALLAPI_KEY o de .cache/footballapi_org/key.json.
Nunca se escribe en código, datos generados, logs, manifiesto ni UI.

Uso:
    python -m pipeline.ingest_footballapi_org --save-key
    python -m pipeline.ingest_footballapi_org --status
    python -m pipeline.ingest_footballapi_org --days 7
    python -m pipeline.ingest_footballapi_org --dry-run
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

from .api_free_common import (
    ApiClientError,
    RateLimitedJsonClient,
    _source_summary,
    empty_status,
    norm_status,
    norm_utc,
    resolve_key,
    save_key,
)
from .db import BASE_DIR, DATA_DIR, configure_stdio, get_connection, init_db, utc_now
from .fixtures_merge import operational_window, write_combined

PROVIDER = "footballapi_org"
SOURCE_NAME = "footballapi.org"
SOURCE_URL = "https://footballapi.org"
API_BASE = "https://api.footballapi.org/v1"
ENV_KEY = "FOOTBALLAPI_KEY"
CACHE_DIR = BASE_DIR / ".cache" / PROVIDER
KEY_PATH = CACHE_DIR / "key.json"

COMPETITION = "premier-league"
COMPETITION_ID = "eng.1"
COMPETITION_NAME = "Premier League"
MIN_INTERVAL = 6.2   # 10 llamadas/minuto
DAILY_LIMIT = 50
RESERVE = 5

TTL_FIXTURES = 15 * 60
TTL_RESULTS = 5 * 60
TTL_TABLE = 5 * 60

FIXTURES_JSON = DATA_DIR / "faorg_fixtures.json"
STANDINGS_JSON = DATA_DIR / "faorg_standings.json"
COMBINED_JSON = DATA_DIR / "fixtures.json"


def current_season() -> str:
    """El plan gratuito lee sólo esta temporada; la temporada es su año de inicio."""
    now = datetime.now(timezone.utc)
    return str(now.year if now.month >= 7 else now.year - 1)


# ---------------------------------------------------------------------------
# Normalización
# ---------------------------------------------------------------------------

def normalize_match(raw: dict[str, Any]) -> dict[str, Any] | None:
    kickoff = norm_utc(raw.get("kickoff_utc"))
    match_id = raw.get("match_id")
    home = raw.get("home_club_name")
    away = raw.get("away_club_name")
    if not kickoff or not match_id or not home or not away:
        return None

    status = norm_status(raw.get("match_status"))
    finished = status == "finished"
    return {
        "id": f"faorg-{match_id}",
        "source_id": str(match_id),
        "provider": PROVIDER,
        "source": PROVIDER,
        "competition_code": COMPETITION,
        "competition_id": COMPETITION_ID,
        "competition_name": str(raw.get("competition_name") or COMPETITION_NAME),
        "country": str(raw.get("country_name") or "England"),
        "season": str(raw.get("season_start_year") or current_season()),
        "kickoff_utc": kickoff,
        "home_team_id": f"faorg-{raw.get('home_club_id') or home}",
        "away_team_id": f"faorg-{raw.get('away_club_id') or away}",
        "home_team_name": str(home),
        "away_team_name": str(away),
        "status": status,
        "home_goals": int(raw["home_goals"]) if finished and raw.get("home_goals") is not None else None,
        "away_goals": int(raw["away_goals"]) if finished and raw.get("away_goals") is not None else None,
        "venue": raw.get("ground_name") or None,
        "venue_city": raw.get("city_name") or None,
        "referee": raw.get("referee_name") or None,
        "round": None,
        "quality": "observed" if status == "scheduled" else "observed_delayed",
        "source_name": SOURCE_NAME,
        "as_of": norm_utc(raw.get("updated_at") or raw.get("last_updated")),
        "raw_json": json.dumps(raw, ensure_ascii=False),
    }


def normalize_table(payload: dict[str, Any]) -> dict[str, Any] | None:
    data = payload.get("data") or {}
    rows_source = data.get("table") if isinstance(data, dict) else data
    if isinstance(data, dict) and not rows_source:
        rows_source = data.get("positions") or data.get("rows")
    if not rows_source:
        return None
    rows = []
    for entry in rows_source:
        club = entry.get("club") or entry.get("club_name") or entry.get("team") or {}
        name = club.get("name") if isinstance(club, dict) else club
        rows.append({
            "position": entry.get("position"),
            "team": name or entry.get("club_name"),
            "played": entry.get("played") or entry.get("matches_played"),
            "won": entry.get("won") or entry.get("wins"),
            "drawn": entry.get("drawn") or entry.get("draws"),
            "lost": entry.get("lost") or entry.get("losses"),
            "goals_for": entry.get("goals_for") or entry.get("gf"),
            "goals_against": entry.get("goals_against") or entry.get("ga"),
            "points": entry.get("points"),
        })
    if not rows:
        return None
    return {
        "provider": PROVIDER,
        "source": PROVIDER,
        "source_name": SOURCE_NAME,
        "quality": "observed_delayed",
        "as_of": utc_now(),
        "competition_code": COMPETITION,
        "competition_id": COMPETITION_ID,
        "season": current_season(),
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# Persistencia
# ---------------------------------------------------------------------------

def ensure_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS faorg_fixtures (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            source TEXT NOT NULL,
            competition_code TEXT,
            competition_id TEXT NOT NULL,
            competition_name TEXT,
            country TEXT,
            season TEXT,
            kickoff_utc TEXT NOT NULL,
            home_team_id TEXT NOT NULL,
            away_team_id TEXT NOT NULL,
            home_team_name TEXT NOT NULL,
            away_team_name TEXT NOT NULL,
            status TEXT NOT NULL,
            home_goals INTEGER,
            away_goals INTEGER,
            venue TEXT,
            venue_city TEXT,
            referee TEXT,
            round TEXT,
            quality TEXT,
            source_name TEXT,
            as_of TEXT,
            raw_json TEXT,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(provider, source_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_faorg_fixtures_kickoff ON faorg_fixtures(kickoff_utc)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS faorg_standings (
            provider TEXT NOT NULL,
            source TEXT NOT NULL,
            competition_code TEXT NOT NULL,
            competition_id TEXT NOT NULL,
            season TEXT,
            quality TEXT,
            source_name TEXT,
            as_of TEXT,
            rows_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (provider, competition_code, season)
        )
        """
    )
    conn.commit()


UPSERT_SQL = """
INSERT INTO faorg_fixtures (
    id, source_id, provider, source, competition_code, competition_id,
    competition_name, country, season, kickoff_utc, home_team_id, away_team_id,
    home_team_name, away_team_name, status, home_goals, away_goals, venue,
    venue_city, referee, round, quality, source_name, as_of, raw_json,
    first_seen_at, last_seen_at, updated_at
) VALUES (
    :id, :source_id, :provider, :source, :competition_code, :competition_id,
    :competition_name, :country, :season, :kickoff_utc, :home_team_id, :away_team_id,
    :home_team_name, :away_team_name, :status, :home_goals, :away_goals, :venue,
    :venue_city, :referee, :round, :quality, :source_name, :as_of, :raw_json,
    :first_seen_at, :last_seen_at, :updated_at
)
ON CONFLICT(provider, source_id) DO UPDATE SET
    competition_code = excluded.competition_code,
    competition_id = excluded.competition_id,
    competition_name = excluded.competition_name,
    country = excluded.country,
    season = excluded.season,
    kickoff_utc = excluded.kickoff_utc,
    home_team_id = excluded.home_team_id,
    away_team_id = excluded.away_team_id,
    home_team_name = excluded.home_team_name,
    away_team_name = excluded.away_team_name,
    status = excluded.status,
    home_goals = excluded.home_goals,
    away_goals = excluded.away_goals,
    venue = excluded.venue,
    venue_city = excluded.venue_city,
    referee = excluded.referee,
    round = excluded.round,
    quality = excluded.quality,
    source_name = excluded.source_name,
    as_of = excluded.as_of,
    raw_json = excluded.raw_json,
    last_seen_at = excluded.last_seen_at,
    updated_at = excluded.updated_at
"""


def upsert(conn: sqlite3.Connection, rows: list[dict[str, Any]], table: dict[str, Any] | None) -> dict[str, int]:
    ensure_tables(conn)
    now = utc_now()
    inserted = updated = 0
    with conn:
        for row in rows:
            existing = conn.execute(
                "SELECT first_seen_at FROM faorg_fixtures WHERE provider = ? AND source_id = ?",
                (PROVIDER, row["source_id"]),
            ).fetchone()
            payload = dict(row)
            payload["first_seen_at"] = existing["first_seen_at"] if existing else now
            payload["last_seen_at"] = now
            payload["updated_at"] = now
            conn.execute(UPSERT_SQL, payload)
            if existing:
                updated += 1
            else:
                inserted += 1
        if table:
            conn.execute(
                """
                INSERT INTO faorg_standings (
                    provider, source, competition_code, competition_id, season,
                    quality, source_name, as_of, rows_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider, competition_code, season) DO UPDATE SET
                    quality = excluded.quality, as_of = excluded.as_of,
                    rows_json = excluded.rows_json, updated_at = excluded.updated_at
                """,
                (
                    PROVIDER, PROVIDER, table["competition_code"], table["competition_id"],
                    table.get("season"), table.get("quality"), SOURCE_NAME,
                    table.get("as_of"), json.dumps(table["rows"], ensure_ascii=False), now,
                ),
            )
    return {"inserted": inserted, "updated": updated}


def export_json(conn: sqlite3.Connection, start, end) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT id, source_id, competition_id, competition_code, competition_name,
               country, season, kickoff_utc, home_team_id, away_team_id,
               home_team_name, away_team_name, status, home_goals, away_goals,
               venue, venue_city, referee, round, quality, source_name, as_of, updated_at
        FROM faorg_fixtures
        WHERE provider = ? AND kickoff_utc >= ? AND kickoff_utc <= ?
        ORDER BY kickoff_utc, competition_name
        """,
        (PROVIDER, f"{start.isoformat()}T00:00:00Z", f"{end.isoformat()}T23:59:59Z"),
    ).fetchall()
    fixtures = []
    for row in rows:
        item = dict(row)
        item["source"] = PROVIDER
        item["tier"] = "A" if item["competition_id"] in {"eng.1", "esp.1"} else "C"
        fixtures.append(item)
    payload = {
        "schema": "motor-nox.free-api-fixtures.v1",
        "generatedAt": utc_now(),
        "provider": PROVIDER,
        "source": SOURCE_NAME,
        "plan": "free",
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "count": len(fixtures),
        "items": fixtures,
    }
    FIXTURES_JSON.parent.mkdir(parents=True, exist_ok=True)
    FIXTURES_JSON.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    standings_rows = conn.execute(
        """
        SELECT competition_code, competition_id, season, quality, source_name,
               as_of, rows_json FROM faorg_standings
        WHERE provider = ? ORDER BY competition_code
        """,
        (PROVIDER,),
    ).fetchall()
    standings = []
    for row in standings_rows:
        item = dict(row)
        item["rows"] = json.loads(item.pop("rows_json"))
        item["source"] = PROVIDER
        standings.append(item)
    STANDINGS_JSON.write_text(
        json.dumps({
            "schema": "motor-nox.free-api-standings.v1",
            "generatedAt": utc_now(),
            "provider": PROVIDER,
            "source": SOURCE_NAME,
            "plan": "free",
            "count": len(standings),
            "items": standings,
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return {"fixtures": len(fixtures), "standings": len(standings)}


# ---------------------------------------------------------------------------
# Orquestación
# ---------------------------------------------------------------------------

def status_entry(result: dict[str, Any] | None = None, error: str | None = None) -> dict[str, Any]:
    if error:
        return _source_summary(
            key=PROVIDER, source=SOURCE_NAME, configured=True, status="error", note=error,
        )
    if result and result.get("status") == "success":
        return _source_summary(
            key=PROVIDER, source=SOURCE_NAME, configured=True, status="ok",
            events=result.get("events"), quality="observed_delayed",
            as_of=result.get("as_of"), plan="free", budget=result.get("budget"),
            note="Plan gratuito: sólo Premier League de esta temporada; sin live scores.",
        )
    return empty_status(
        PROVIDER, SOURCE_NAME,
        "Sin clave: define FOOTBALLAPI_KEY o ejecuta --save-key.",
    )


def ingest_footballapi_org(
    *,
    conn: sqlite3.Connection | None = None,
    days: int = 7,
    dry_run: bool = False,
) -> dict[str, Any]:
    key = resolve_key(ENV_KEY, KEY_PATH)
    if not key:
        return {"status": "skipped", "reason": "sin clave", "events": 0}

    own_conn = conn is None
    conn = conn or get_connection()
    client = RateLimitedJsonClient(
        base_url=API_BASE,
        key=key,
        auth_header="X-API-Key",
        cache_dir=CACHE_DIR,
        daily_limit=DAILY_LIMIT,
        reserve=RESERVE,
        min_interval=MIN_INTERVAL,
        dry_run=dry_run,
    )
    try:
        start, end = operational_window(days)
        raw: list[dict[str, Any]] = []

        fixtures = client.get(
            "/fixtures",
            {"competition": COMPETITION, "date_from": start.isoformat(), "date_to": end.isoformat()},
            ttl=TTL_FIXTURES,
        )
        raw.extend(fixtures.get("data") or [])

        results = client.get(
            "/results/yesterday",
            {"competition": COMPETITION},
            ttl=TTL_RESULTS,
        )
        raw.extend(results.get("data") or [])

        table_payload = client.get(
            f"/competitions/{COMPETITION}/seasons/{current_season()}/table",
            {},
            ttl=TTL_TABLE,
        )
        table = normalize_table(table_payload)

        usage = client.get("/usage", {}, ttl=60, count=False)
        usage_data = (usage.get("data") or {}) if isinstance(usage.get("data"), dict) else {}

        rows_by_id: dict[str, dict[str, Any]] = {}
        for item in raw:
            row = normalize_match(item)
            if row:
                rows_by_id[row["source_id"]] = row
        rows = list(rows_by_id.values())

        as_of = max((row["as_of"] for row in rows if row.get("as_of")), default=None)
        stats: dict[str, Any] = {
            "status": "success",
            "provider": PROVIDER,
            "events": len(rows),
            "standings": 1 if table else 0,
            "plan": usage_data.get("plan") or "free",
            "budget": client.budget_summary(),
            "window": {"from": start.isoformat(), "to": end.isoformat()},
            "as_of": as_of,
            "quality": "observed_delayed",
            "dryRun": dry_run,
        }
        if dry_run:
            return stats

        stats["persistence"] = upsert(conn, rows, table)
        stats["export"] = export_json(conn, start, end)
        merged = write_combined(conn, start, end, fixtures_path=COMBINED_JSON)
        stats["merged"] = merged["added"].get(PROVIDER, 0)
        return stats
    finally:
        if own_conn:
            conn.close()


def main() -> None:
    configure_stdio()
    parser = argparse.ArgumentParser(description="MOTOR-NOX · footballapi.org (plan gratuito)")
    parser.add_argument("--save-key", action="store_true", help="Guarda FOOTBALLAPI_KEY en caché privada")
    parser.add_argument("--status", action="store_true", help="Muestra estado del plan sin secretos")
    parser.add_argument("--days", type=int, default=7, help="Días hacia adelante de la ventana")
    parser.add_argument("--dry-run", action="store_true", help="Descarga y valida sin escribir")
    args = parser.parse_args()

    if args.save_key:
        raise SystemExit(0 if save_key(ENV_KEY, KEY_PATH, SOURCE_NAME) else 1)

    if not resolve_key(ENV_KEY, KEY_PATH):
        print("Sin clave. Define FOOTBALLAPI_KEY o ejecuta --save-key.", file=sys.stderr)
        raise SystemExit(1)

    if args.status:
        client = RateLimitedJsonClient(
            base_url=API_BASE, key=resolve_key(ENV_KEY, KEY_PATH),
            auth_header="X-API-Key", cache_dir=CACHE_DIR,
            min_interval=MIN_INTERVAL,
        )
        usage = client.get("/usage", {}, ttl=60, count=False)
        print(json.dumps({
            "source": SOURCE_NAME,
            "plan": "free",
            "usage": usage.get("data") or {},
        }, indent=2, ensure_ascii=False))
        return

    init_db()
    conn = get_connection()
    try:
        result = ingest_footballapi_org(conn=conn, days=args.days, dry_run=args.dry_run)
    except ApiClientError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
    finally:
        conn.close()
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
