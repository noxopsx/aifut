"""
MOTOR-NOX · conector de football-data.org v4 (plan Free).

Plan gratuito verificado en https://www.football-data.org/coverage:
12 competiciones, resultados y calendarios con retraso, clasificación,
10 peticiones/minuto. Sinlive scores, sin alineaciones, sin cuotas.

Endpoints usados (todos dentro del plan Free):
  · /v4/competitions/{code}/matches?dateFrom=&dateTo=
  · /v4/competitions/{code}/standings

La clave se lee de FOOTBALLDATA_KEY o de .cache/football_data_org/key.json.
Nunca se escribe en código, datos generados, logs, manifiesto ni UI.

Uso:
    python -m pipeline.ingest_football_data_org --save-key
    python -m pipeline.ingest_football_data_org --status
    python -m pipeline.ingest_football_data_org --days 7
    python -m pipeline.ingest_football_data_org --dry-run
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import timedelta
from pathlib import Path
from typing import Any

from .api_free_common import (
    ApiClientError,
    RateLimitedJsonClient,
    empty_status,
    norm_status,
    norm_utc,
    resolve_key,
    save_key,
)
from .db import BASE_DIR, DATA_DIR, configure_stdio, get_connection, init_db, utc_now
from .fixtures_merge import operational_window, write_combined

PROVIDER = "football_data_org"
SOURCE_NAME = "football-data.org"
SOURCE_URL = "https://www.football-data.org"
API_BASE = "https://api.football-data.org/v4"
ENV_KEY = "FOOTBALLDATA_KEY"
CACHE_DIR = BASE_DIR / ".cache" / PROVIDER
KEY_PATH = CACHE_DIR / "key.json"

MIN_INTERVAL = 6.2  # 10 peticiones/minuto del plan Free
TTL_MATCHES = 15 * 60
TTL_STANDINGS = 6 * 3600

# Códigos confirmados en la página "Football coverage → Free Tier".
FREE_COMPETITIONS: dict[str, str] = {
    "PL": "eng.1",       # Premier League (Inglaterra)
    "PD": "esp.1",       # La Liga (España)
    "SA": "ita.1",       # Serie A (Italia)
    "BL1": "ger.1",      # Bundesliga (Alemania)
    "FL1": "fra.1",      # Ligue 1 (Francia)
    "DED": "ned.1",      # Eredivisie (Países Bajos)
    "PPL": "por.1",      # Primeira Liga (Portugal)
    "ELC": "eng.2",      # Championship (Inglaterra)
    "CL": "uefa.champions",  # UEFA Champions League
    "BRA": "bra.1",      # Brasileirão Série A
    "WC": "fifa.world",  # FIFA World Cup
    "EC": "uefa.euro",   # European Championship
}

STANDING_CODES = tuple(FREE_COMPETITIONS)

FIXTURES_JSON = DATA_DIR / "free_api_fixtures.json"
STANDINGS_JSON = DATA_DIR / "free_api_standings.json"
COMBINED_JSON = DATA_DIR / "fixtures.json"


# ---------------------------------------------------------------------------
# Normalización
# ---------------------------------------------------------------------------

def normalize_match(raw: dict[str, Any], code: str) -> dict[str, Any] | None:
    match = raw.get("match") or raw
    home = match.get("homeTeam") or {}
    away = match.get("awayTeam") or {}
    kickoff = norm_utc(match.get("utcDate"))
    if not kickoff or not home.get("id") or not away.get("id"):
        return None

    status = norm_status(match.get("status"))
    full_time = (match.get("score") or {}).get("fullTime") or {}
    finished = status == "finished"
    competition = match.get("competition") or {}
    season = match.get("season") or {}

    return {
        "id": f"fdo-{match.get('id')}",
        "source_id": str(match.get("id")),
        "provider": PROVIDER,
        "source": PROVIDER,
        "competition_code": code,
        "competition_id": FREE_COMPETITIONS.get(code, f"fdo.{code}"),
        "competition_name": str(competition.get("name") or code),
        "country": str(competition.get("area", {}).get("name") or ""),
        "season": str(season.get("startDate") or "")[:4] or None,
        "kickoff_utc": kickoff,
        "home_team_id": f"fdo-{home.get('id')}",
        "away_team_id": f"fdo-{away.get('id')}",
        "home_team_name": str(home.get("name") or ""),
        "away_team_name": str(away.get("name") or ""),
        "status": status,
        "home_goals": int(full_time["home"]) if finished and full_time.get("home") is not None else None,
        "away_goals": int(full_time["away"]) if finished and full_time.get("away") is not None else None,
        "venue": str(match.get("venue") or "") or None,
        "venue_city": None,
        "referee": None,  # el plan Free no expone árbitros en /matches
        "round": str(match.get("matchday") or "") or None,
        "quality": "observed_delayed" if finished else "observed",
        "source_name": SOURCE_NAME,
        "as_of": norm_utc(match.get("lastUpdated")),
        "raw_json": json.dumps(raw, ensure_ascii=False),
    }


def normalize_standings(payload: dict[str, Any], code: str) -> dict[str, Any] | None:
    groups = payload.get("standings") or []
    if not groups:
        return None
    table = groups[0].get("table") or []
    rows = []
    for entry in table:
        team = entry.get("team") or {}
        rows.append({
            "position": entry.get("position"),
            "team": team.get("name"),
            "played": entry.get("playedGames"),
            "won": entry.get("won"),
            "drawn": entry.get("draw"),
            "lost": entry.get("lost"),
            "goals_for": entry.get("goalsFor"),
            "goals_against": entry.get("goalsAgainst"),
            "points": entry.get("points"),
        })
    if not rows:
        return None
    season = payload.get("season") or {}
    return {
        "provider": PROVIDER,
        "source": PROVIDER,
        "source_name": SOURCE_NAME,
        "quality": "observed_delayed",
        "as_of": norm_utc(groups[0].get("lastUpdated") or payload.get("lastUpdated")),
        "competition_code": code,
        "competition_id": FREE_COMPETITIONS.get(code, f"fdo.{code}"),
        "season": str(season.get("startDate") or "")[:4] or None,
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# Persistencia
# ---------------------------------------------------------------------------

def ensure_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS free_api_fixtures (
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
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_free_api_fixtures_kickoff ON free_api_fixtures(kickoff_utc)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS free_api_standings (
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
INSERT INTO free_api_fixtures (
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


def upsert(conn: sqlite3.Connection, rows: list[dict[str, Any]], standings: list[dict[str, Any]]) -> dict[str, int]:
    ensure_tables(conn)
    now = utc_now()
    inserted = updated = 0
    with conn:
        for row in rows:
            existing = conn.execute(
                "SELECT first_seen_at FROM free_api_fixtures WHERE provider = ? AND source_id = ?",
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
        for item in standings:
            conn.execute(
                """
                INSERT INTO free_api_standings (
                    provider, source, competition_code, competition_id, season,
                    quality, source_name, as_of, rows_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider, competition_code, season) DO UPDATE SET
                    quality = excluded.quality, as_of = excluded.as_of,
                    rows_json = excluded.rows_json, updated_at = excluded.updated_at
                """,
                (
                    PROVIDER, PROVIDER, item["competition_code"], item["competition_id"],
                    item.get("season"), item.get("quality"), SOURCE_NAME,
                    item.get("as_of"), json.dumps(item["rows"], ensure_ascii=False), now,
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
        FROM free_api_fixtures
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
               as_of, rows_json FROM free_api_standings
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
    payload_s = {
        "schema": "motor-nox.free-api-standings.v1",
        "generatedAt": utc_now(),
        "provider": PROVIDER,
        "source": SOURCE_NAME,
        "plan": "free",
        "count": len(standings),
        "items": standings,
    }
    STANDINGS_JSON.write_text(
        json.dumps(payload_s, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return {"fixtures": len(fixtures), "standings": len(standings)}


# ---------------------------------------------------------------------------
# Orquestación
# ---------------------------------------------------------------------------

def status_entry(result: dict[str, Any] | None = None, error: str | None = None) -> dict[str, Any]:
    from .api_free_common import _source_summary

    if error:
        return _source_summary(
            key=PROVIDER, source=SOURCE_NAME, configured=True, status="error",
            note=error,
        )
    if result and result.get("status") == "success":
        return _source_summary(
            key=PROVIDER, source=SOURCE_NAME, configured=True, status="ok",
            events=result.get("events"), quality="observed_delayed",
            as_of=result.get("as_of"), plan="free",
            budget=result.get("budget"),
            note="12 competiciones del plan Free; resultados y calendarios con retraso.",
        )
    return empty_status(
        PROVIDER, SOURCE_NAME,
        "Sin clave: define FOOTBALLDATA_KEY o ejecuta --save-key.",
    )


def ingest_football_data_org(
    *,
    conn: sqlite3.Connection | None = None,
    days: int = 7,
    standings: bool = True,
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
        auth_header="X-Auth-Token",
        cache_dir=CACHE_DIR,
        daily_limit=None,  # el plan Free only limita a 10 peticiones/minuto
        min_interval=MIN_INTERVAL,
        dry_run=dry_run,
    )
    try:
        start, end = operational_window(days)
        raw_matches: list[tuple[str, dict[str, Any]]] = []
        for code in FREE_COMPETITIONS:
            payload = client.get(
                f"/competitions/{code}/matches",
                {"dateFrom": start.isoformat(), "dateTo": end.isoformat()},
                ttl=TTL_MATCHES,
            )
            for match in payload.get("matches") or []:
                raw_matches.append((code, match))

        raw_standings: list[dict[str, Any]] = []
        if standings:
            for code in STANDING_CODES:
                payload = client.get(f"/competitions/{code}/standings", {}, ttl=TTL_STANDINGS)
                normalized = normalize_standings(payload, code)
                if normalized:
                    raw_standings.append(normalized)

        # `/v4/competitions/{code}/matches` no devuelve el `code` en el payload,
        # así que se usa el código de la petición que produjo cada partido.
        # Si el payload trae un `code` reconocible, tiene prioridad.
        rows = [
            row
            for code, raw in raw_matches
            if (row := normalize_match(raw, _code_for(raw) or code))
        ]
        unique: dict[str, dict[str, Any]] = {}
        for row in rows:
            unique[row["source_id"]] = row
        rows = list(unique.values())

        as_of = max((row["as_of"] for row in rows if row.get("as_of")), default=None)
        stats: dict[str, Any] = {
            "status": "success",
            "provider": PROVIDER,
            "events": len(rows),
            "standings": len(raw_standings),
            "plan": "free",
            "budget": client.budget_summary(),
            "window": {"from": start.isoformat(), "to": end.isoformat()},
            "as_of": as_of,
            "quality": "observed_delayed",
            "dryRun": dry_run,
        }
        if dry_run:
            return stats

        stats["persistence"] = upsert(conn, rows, raw_standings)
        stats["export"] = export_json(conn, start, end)
        merged = write_combined(conn, start, end, fixtures_path=COMBINED_JSON)
        stats["merged"] = merged["added"].get(PROVIDER, 0)
        return stats
    finally:
        if own_conn:
            conn.close()


def _code_for(raw: dict[str, Any]) -> str:
    """Devuelve el código del payload si es reconocible; si no, cadena vacía.

    Así el bucle de ingesta puede aplicar el código de la petición como fallback
    (los endpoints `/v4/competitions/{code}/matches` no lo repiten en el JSON).
    """
    match = raw.get("match") or raw
    competition = match.get("competition") or {}
    code = str(competition.get("code") or "")
    if code in FREE_COMPETITIONS:
        return code
    internal = str(competition.get("id") or "")
    for candidate, mapped in FREE_COMPETITIONS.items():
        if internal and internal == mapped:
            return candidate
    return ""


def main() -> None:
    configure_stdio()
    parser = argparse.ArgumentParser(description="MOTOR-NOX · football-data.org v4 (Free)")
    parser.add_argument("--save-key", action="store_true", help="Guarda FOOTBALLDATA_KEY en caché privada")
    parser.add_argument("--status", action="store_true", help="Muestra estado del plan sin secretos")
    parser.add_argument("--days", type=int, default=7, help="Días hacia adelante de la ventana")
    parser.add_argument("--no-standings", action="store_true", help="No descarga clasificaciones")
    parser.add_argument("--dry-run", action="store_true", help="Descarga y valida sin escribir")
    args = parser.parse_args()

    if args.save_key:
        raise SystemExit(0 if save_key(ENV_KEY, KEY_PATH, SOURCE_NAME) else 1)

    if not resolve_key(ENV_KEY, KEY_PATH):
        print("Sin clave. Define FOOTBALLDATA_KEY o ejecuta --save-key.", file=sys.stderr)
        raise SystemExit(1)

    if args.status:
        client = RateLimitedJsonClient(
            base_url=API_BASE, key=resolve_key(ENV_KEY, KEY_PATH),
            auth_header="X-Auth-Token", cache_dir=CACHE_DIR,
            min_interval=MIN_INTERVAL,
        )
        payload = client.get("/competitions", {}, ttl=3600, count=False)
        comps = payload.get("competitions") or []
        print(json.dumps({
            "source": SOURCE_NAME,
            "plan": "free",
            "competitionsAvailable": len(comps),
            "freeCodesConfigured": len(FREE_COMPETITIONS),
            "budget": client.budget_summary(),
        }, indent=2, ensure_ascii=False))
        return

    init_db()
    conn = get_connection()
    try:
        result = ingest_football_data_org(
            conn=conn, days=args.days, standings=not args.no_standings,
            dry_run=args.dry_run,
        )
    except ApiClientError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
    finally:
        conn.close()
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
