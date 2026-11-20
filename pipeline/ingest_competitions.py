"""
MOTOR-NOX · Fase 1 · Catálogo de competiciones.

Enumera las competiciones de ESPN desde su API core pública, guarda el catálogo
en SQLite y asigna tier, país, zona horaria, alias y priors de goles/localía.

Reglas de tier (las mismas del plan V2.0):
  * A: 3+ temporadas en el store histórico y xG. En este repositorio solo
    eng.1 y esp.1 cumplen hoy; XI/bajas siguen pendientes (Fase 2).
  * B: 1+ temporada de resultados (matches o fixtures) o liga live con tabla.
  * C: solo catálogo/calendario; no se publica pick.

El catálogo no altera el store histórico ni el modelo. Solo prepara la
cobertura de calendario que exige la Fase 1.

Uso:
    python -m pipeline.ingest_competitions
    python -m pipeline.ingest_competitions --refresh
    python -m pipeline.ingest_competitions --max-active 80
    python -m pipeline.ingest_competitions --limit 10 --dry-run
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .db import (
    BASE_DIR,
    DATA_DIR,
    DB_PATH,
    configure_stdio,
    get_connection,
    init_db,
    utc_now,
)

ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/soccer"
CATALOG_URL = f"{ESPN_CORE}/leagues?limit=1000"
CACHE_DIR = BASE_DIR / ".cache" / "espn_core" / "leagues"
CATALOG_CACHE = BASE_DIR / ".cache" / "espn_core" / "catalog.json"
COMPETITIONS_JSON = DATA_DIR / "competitions.json"
USER_AGENT = "MOTOR-NOX/1.0 (motor de prediccion personal; datos publicos de ESPN)"
CATALOG_TTL_SECONDS = 24 * 60 * 60
DETAIL_TTL_SECONDS = 7 * 24 * 60 * 60

# Las 14 competiciones que ya usa la cartelera live de MOTOR-NOX V1.0.
LIVE_LEAGUES = {
    "gua.1",
    "mex.1",
    "usa.1",
    "esp.1",
    "arg.1",
    "bra.1",
    "uefa.champions",
    "uefa.europa",
    "uefa.europa.conf",
    "ned.1",
    "eng.1",
    "fra.1",
    "ger.1",
    "ita.1",
}

# Prioridad editorial para activar el calendario. No es una promesa de
# precisión: solo decide qué competiciones se sincronizan cada día.
PRIORITY_ACTIVE = [
    # Tier A/B live
    *sorted(LIVE_LEAGUES),
    # Primeras divisiones adicionales
    "por.1",
    "bel.1",
    "sco.1",
    "tur.1",
    "aut.1",
    "gre.1",
    "rus.1",
    "swe.1",
    "den.1",
    "nor.1",
    "chi.1",
    "uru.1",
    "col.1",
    "per.1",
    "par.1",
    "ecu.1",
    "ven.1",
    "bol.1",
    "jpn.1",
    "ksa.1",
    "aus.1",
    "chn.1",
    "ind.1",
    "rsa.1",
    "crc.1",
    "hon.1",
    "slv.1",
    # Segundas divisiones con calendario público
    "eng.2",
    "esp.2",
    "ger.2",
    "ita.2",
    "fra.2",
    "ned.2",
    "sco.2",
    "mex.2",
    "arg.2",
    "bra.2",
    # Copas y torneos de clubes
    "eng.fa",
    "eng.league_cup",
    "esp.copa_del_rey",
    "ger.dfb_pokal",
    "ita.coppa_italia",
    "fra.coupe_de_france",
    "por.taca.portugal",
    "ned.cup",
    "arg.copa",
    "bra.copa_do_brazil",
    "conmebol.libertadores",
    "conmebol.sudamericana",
    "concacaf.champions",
    "afc.champions",
    "caf.champions",
]

SLUG_COUNTRY = {
    "uefa.champions": "Europe",
    "uefa.europa": "Europe",
    "uefa.europa.conf": "Europe",
    "uefa.super_cup": "Europe",
    "uefa.champions_qual": "Europe",
    "uefa.europa_qual": "Europe",
    "uefa.europa.conf_qual": "Europe",
    "conmebol.libertadores": "South America",
    "conmebol.sudamericana": "South America",
    "conmebol.recopa": "South America",
    "concacaf.champions": "North America",
    "concacaf.leagues.cup": "North America",
    "afc.champions": "Asia",
    "caf.champions": "Africa",
    "caf.confed": "Africa",
    "fifa.world": "World",
    "fifa.wwc": "World",
    "fifa.cwc": "World",
    "fifa.intercontinental_cup": "World",
    "usa.1": "United States",
    "usa.nwsl": "United States",
    "usa.usl.1": "United States",
    "usa.usl.l1": "United States",
    "mex.1": "Mexico",
    "mex.2": "Mexico",
    "mex.w.1": "Mexico",
}

COUNTRY_TIMEZONES = {
    "England": "Europe/London",
    "Scotland": "Europe/London",
    "Wales": "Europe/London",
    "Spain": "Europe/Madrid",
    "Italy": "Europe/Rome",
    "Germany": "Europe/Berlin",
    "France": "Europe/Paris",
    "Netherlands": "Europe/Amsterdam",
    "Portugal": "Europe/Lisbon",
    "Belgium": "Europe/Brussels",
    "Turkey": "Europe/Istanbul",
    "Austria": "Europe/Vienna",
    "Greece": "Europe/Athens",
    "Russia": "Europe/Moscow",
    "Sweden": "Europe/Stockholm",
    "Denmark": "Europe/Copenhagen",
    "Norway": "Europe/Oslo",
    "Switzerland": "Europe/Zurich",
    "Mexico": "America/Mexico_City",
    "United States": "America/New_York",
    "Canada": "America/Toronto",
    "Brazil": "America/Sao_Paulo",
    "Argentina": "America/Argentina/Buenos_Aires",
    "Chile": "America/Santiago",
    "Uruguay": "America/Montevideo",
    "Colombia": "America/Bogota",
    "Peru": "America/Lima",
    "Paraguay": "America/Asuncion",
    "Ecuador": "America/Guayaquil",
    "Venezuela": "America/Caracas",
    "Bolivia": "America/La_Paz",
    "Japan": "Asia/Tokyo",
    "Saudi Arabia": "Asia/Riyadh",
    "Australia": "Australia/Sydney",
    "China": "Asia/Shanghai",
    "India": "Asia/Kolkata",
    "South Africa": "Africa/Johannesburg",
    "Guatemala": "America/Guatemala",
    "Costa Rica": "America/Costa_Rica",
    "Honduras": "America/Tegucigalpa",
    "El Salvador": "America/El_Salvador",
    "Europe": "Europe/Zurich",
    "South America": "America/Sao_Paulo",
    "North America": "America/Mexico_City",
    "Asia": "Asia/Riyadh",
    "Africa": "Africa/Johannesburg",
    "World": "UTC",
}


def _read_cache(path: Path, ttl_seconds: int) -> Any | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    fetched_at = payload.get("fetchedAt")
    if not isinstance(fetched_at, (int, float)):
        return None
    age = time.time() - fetched_at / 1000.0
    if ttl_seconds >= 0 and age > ttl_seconds:
        return None
    return payload.get("data")


def _write_cache(path: Path, url: str, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "fetchedAt": int(time.time() * 1000),
        "url": url,
        "data": data,
    }
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def fetch_json(
    url: str,
    *,
    cache_path: Path | None = None,
    ttl_seconds: int = -1,
    refresh: bool = False,
    timeout: int = 30,
    retries: int = 3,
) -> Any:
    """Descarga JSON con caché en disco y reintentos con backoff."""
    if cache_path is not None and not refresh:
        cached = _read_cache(cache_path, ttl_seconds)
        if cached is not None:
            return cached

    last_error: Exception | None = None
    for attempt in range(retries):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.load(response)
            if cache_path is not None:
                _write_cache(cache_path, url, data)
            return data
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            if isinstance(error, urllib.error.HTTPError) and error.code in (400, 404):
                break
            time.sleep(0.8 * (2**attempt))
    raise RuntimeError(f"No se pudo descargar {url}: {last_error}")


def catalog_slugs(*, refresh: bool = False) -> list[str]:
    data = fetch_json(
        CATALOG_URL,
        cache_path=CATALOG_CACHE,
        ttl_seconds=CATALOG_TTL_SECONDS,
        refresh=refresh,
    )
    slugs: list[str] = []
    for item in data.get("items", []):
        ref = str(item.get("$ref", ""))
        if "/leagues/" not in ref:
            continue
        slug = ref.split("/leagues/", 1)[1].split("?", 1)[0].strip("/")
        if slug and slug not in slugs:
            slugs.append(slug)
    return slugs


def fetch_league_detail(slug: str, *, refresh: bool = False) -> dict[str, Any] | None:
    url = f"{ESPN_CORE}/leagues/{slug}"
    cache_path = CACHE_DIR / f"{slug}.json"
    try:
        data = fetch_json(
            url,
            cache_path=cache_path,
            ttl_seconds=DETAIL_TTL_SECONDS,
            refresh=refresh,
        )
    except RuntimeError as error:
        print(f"  aviso  {slug}: {error}", file=sys.stderr)
        return None
    return data if isinstance(data, dict) else None


def _slug_country(slug: str) -> str | None:
    if slug in SLUG_COUNTRY:
        return SLUG_COUNTRY[slug]
    prefix = slug.split(".", 1)[0]
    return {
        "eng": "England",
        "esp": "Spain",
        "ger": "Germany",
        "ita": "Italy",
        "fra": "France",
        "ned": "Netherlands",
        "por": "Portugal",
        "bel": "Belgium",
        "sco": "Scotland",
        "tur": "Turkey",
        "aut": "Austria",
        "gre": "Greece",
        "rus": "Russia",
        "swe": "Sweden",
        "den": "Denmark",
        "nor": "Norway",
        "mex": "Mexico",
        "usa": "United States",
        "bra": "Brazil",
        "arg": "Argentina",
        "chi": "Chile",
        "uru": "Uruguay",
        "col": "Colombia",
        "per": "Peru",
        "par": "Paraguay",
        "ecu": "Ecuador",
        "ven": "Venezuela",
        "bol": "Bolivia",
        "jpn": "Japan",
        "ksa": "Saudi Arabia",
        "aus": "Australia",
        "chn": "China",
        "ind": "India",
        "rsa": "South Africa",
        "gua": "Guatemala",
        "crc": "Costa Rica",
        "hon": "Honduras",
        "slv": "El Salvador",
    }.get(prefix)


def country_for(detail: dict[str, Any] | None, slug: str) -> str | None:
    if detail:
        country = detail.get("country")
        if isinstance(country, dict) and country.get("name"):
            return str(country["name"])
    return _slug_country(slug)


def timezone_for(country: str | None, slug: str) -> str:
    if country and country in COUNTRY_TIMEZONES:
        return COUNTRY_TIMEZONES[country]
    if slug.startswith("uefa."):
        return "Europe/Zurich"
    if slug.startswith("fifa."):
        return "UTC"
    return "UTC"


def _is_womens(slug: str, name: str) -> bool:
    lowered = name.lower()
    return (
        ".w." in slug
        or slug.startswith(("fifa.w", "uefa.w", "concacaf.w", "caf.w", "afc.w"))
        or "women" in lowered
        or "nwsl" in slug
    )


def _is_youth(slug: str, name: str) -> bool:
    lowered = f"{slug} {name}".lower()
    return any(token in lowered for token in ("u17", "u19", "u20", "u21", "u23", "olympic", "youth"))


def _is_college(slug: str, name: str) -> bool:
    lowered = f"{slug} {name}".lower()
    return "ncaa" in slug or "college" in lowered


def _is_national_team(slug: str, name: str) -> bool:
    lowered = f"{slug} {name}".lower()
    prefixes = (
        "fifa.world",
        "fifa.wwc",
        "fifa.worldq",
        "fifa.wcq",
        "fifa.friendly",
        "fifa.olympics",
        "uefa.nations",
        "uefa.weuro",
        "conmebol.america",
        "caf.nations",
        "afc.asian",
        "afc.cup",
        "concacaf.gold",
        "concacaf.nations",
        "concacaf.u23",
        "global.gulf_cup",
    )
    # "uefa.euro" es selecciones, pero "uefa.europa" es un torneo de clubes.
    # "fifa.cwc" e "fifa.intercontinental_cup" también son de clubes.
    if slug in {"uefa.euro", "uefa.euroq", "fifa.intercontinental.cup"}:
        return True
    return slug.startswith(prefixes) or "national" in lowered


def _is_domestic_top_flight(slug: str) -> bool:
    if not slug.endswith(".1"):
        return False
    if _is_womens(slug, ""):
        return False
    return slug.split(".")[0] in {
        "eng", "esp", "ger", "ita", "fra", "ned", "por", "bel", "sco", "tur",
        "aut", "gre", "rus", "swe", "den", "nor", "mex", "usa", "bra", "arg",
        "chi", "uru", "col", "per", "par", "ecu", "ven", "bol", "jpn", "ksa",
        "aus", "chn", "ind", "rsa", "gua", "crc", "hon", "slv",
    }


def _history_stats(conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    """Temporadas y filas de xG por competición en el store histórico."""
    stats: dict[str, dict[str, Any]] = {}
    rows = conn.execute(
        """
        SELECT m.league_id AS league_id,
               COUNT(DISTINCT m.season) AS seasons,
               COUNT(s.id) AS stat_rows,
               SUM(CASE WHEN s.xg IS NOT NULL THEN 1 ELSE 0 END) AS xg_rows
        FROM matches m
        LEFT JOIN team_match_stats s ON s.match_id = m.id
        GROUP BY m.league_id
        """
    ).fetchall()
    for row in rows:
        stats[row["league_id"]] = {
            "seasons": int(row["seasons"] or 0),
            "stat_rows": int(row["stat_rows"] or 0),
            "xg_rows": int(row["xg_rows"] or 0),
        }
    return stats


def _fixture_seasons(conn: sqlite3.Connection) -> dict[str, dict[str, int]]:
    if not _table_exists(conn, "fixtures"):
        return {}
    rows = conn.execute(
        """
        SELECT competition_id,
               COUNT(DISTINCT season) AS seasons,
               COUNT(*) AS finished
        FROM fixtures
        WHERE status = 'finished'
        GROUP BY competition_id
        """
    ).fetchall()
    return {
        row["competition_id"]: {
            "seasons": int(row["seasons"] or 0),
            "finished": int(row["finished"] or 0),
        }
        for row in rows
    }


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return bool(
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()
    )


def _priors(conn: sqlite3.Connection, slug: str) -> tuple[float | None, float | None, float | None, str]:
    """Priors propios de la competición; nunca la media global."""
    if _table_exists(conn, "matches"):
        row = conn.execute(
            """
            SELECT AVG(home_goals + away_goals) AS goals,
                   AVG(home_goals) AS home,
                   AVG(away_goals) AS away
            FROM matches
            WHERE league_id = ?
              AND home_goals IS NOT NULL
              AND away_goals IS NOT NULL
            """,
            (slug,),
        ).fetchone()
        if row and row["goals"] is not None:
            return (
                round(float(row["goals"]), 4),
                round(float(row["home"]), 4),
                round(float(row["away"]), 4),
                "matches",
            )
    if _table_exists(conn, "fixtures"):
        row = conn.execute(
            """
            SELECT AVG(home_goals + away_goals) AS goals,
                   AVG(home_goals) AS home,
                   AVG(away_goals) AS away
            FROM fixtures
            WHERE competition_id = ?
              AND status = 'finished'
              AND home_goals IS NOT NULL
              AND away_goals IS NOT NULL
            """,
            (slug,),
        ).fetchone()
        if row and row["goals"] is not None:
            return (
                round(float(row["goals"]), 4),
                round(float(row["home"]), 4),
                round(float(row["away"]), 4),
                "fixtures",
            )
    return None, None, None, "none"


def _tier_for(
    slug: str,
    *,
    history_seasons: int,
    xg_rows: int,
    fixture_seasons: int,
    fixture_finished: int,
    live: bool,
) -> tuple[str, str]:
    if history_seasons >= 3 and xg_rows > 0:
        return "A", (
            "3+ temporadas en el store histórico y xG; "
            "XI/bajas pendientes de la Fase 2"
        )
    if history_seasons >= 1 or (fixture_seasons >= 1 and fixture_finished >= 20):
        return "B", (
            f"{max(history_seasons, fixture_seasons)} temporada(s) de resultados "
            f"({fixture_finished} partidos finalizados); priors propios de la competición"
        )
    if live:
        return "B", (
            "liga live con tabla y forma de ESPN; pendiente backfill "
            "de resultados en la base"
        )
    return "C", "solo catálogo/calendario; sin histórico suficiente para pick"


def _season_label(season: dict[str, Any]) -> str | None:
    abbreviation = season.get("abbreviation")
    if abbreviation:
        return str(abbreviation)
    year = season.get("year")
    return str(year) if year else None


def _season_dates(season: dict[str, Any]) -> tuple[str | None, str | None]:
    start = season.get("startDate")
    end = season.get("endDate")
    return (str(start) if start else None, str(end) if end else None)


def _team_count(detail: dict[str, Any] | None) -> int | None:
    if not detail:
        return None
    teams = detail.get("teams")
    if isinstance(teams, list):
        return len(teams)
    if isinstance(teams, dict):
        if isinstance(teams.get("count"), int):
            return teams["count"]
        if isinstance(teams.get("items"), list):
            return len(teams["items"])
    return None


def _competition_row(
    conn: sqlite3.Connection,
    slug: str,
    detail: dict[str, Any] | None,
    history: dict[str, dict[str, Any]],
    fixture_seasons: dict[str, dict[str, int]],
) -> dict[str, Any]:
    name = str((detail or {}).get("name") or slug)
    short_name = str((detail or {}).get("shortName") or (detail or {}).get("abbreviation") or name)
    country = country_for(detail, slug)
    timezone_name = timezone_for(country, slug)
    season = (detail or {}).get("season") if isinstance((detail or {}).get("season"), dict) else {}
    season_label = _season_label(season or {})
    season_start, season_end = _season_dates(season or {})
    history_row = history.get(slug, {})
    history_seasons = int(history_row.get("seasons", 0))
    xg_rows = int(history_row.get("xg_rows", 0))
    fixture_info = fixture_seasons.get(slug, {})
    fixture_count = int(fixture_info.get("seasons", 0))
    fixture_finished = int(fixture_info.get("finished", 0))
    if _is_college(slug, name):
        tier, tier_reason = "C", "competencia universitaria; fuera del alcance del motor"
    else:
        tier, tier_reason = _tier_for(
            slug,
            history_seasons=history_seasons,
            xg_rows=xg_rows,
            fixture_seasons=fixture_count,
            fixture_finished=fixture_finished,
            live=slug in LIVE_LEAGUES,
        )
    goals_prior, home_prior, away_prior, prior_source = _priors(conn, slug)
    aliases = []
    for value in (
        (detail or {}).get("name"),
        (detail or {}).get("shortName"),
        (detail or {}).get("abbreviation"),
        (detail or {}).get("midsizeName"),
    ):
        if value and str(value) not in aliases:
            aliases.append(str(value))
    logos = (detail or {}).get("logos")
    logo_url = None
    if isinstance(logos, list) and logos and isinstance(logos[0], dict):
        logo_url = logos[0].get("href")
    is_tournament = 1 if (detail or {}).get("isTournament") else 0
    now = utc_now()
    return {
        "id": slug,
        "name": name,
        "short_name": short_name,
        "country": country,
        "timezone": timezone_name,
        "tier": tier,
        "tier_reason": tier_reason,
        "source_ids": json.dumps({"espn": slug}, ensure_ascii=False),
        "goals_prior": goals_prior,
        "home_prior": home_prior,
        "away_prior": away_prior,
        "prior_source": prior_source,
        "aliases_json": json.dumps(aliases, ensure_ascii=False),
        "logo_url": logo_url,
        "is_tournament": is_tournament,
        "active": 0,
        "availability_ready": 0,
        "created_at": now,
        "updated_at": now,
        "season": season_label,
        "season_start": season_start,
        "season_end": season_end,
        "format": "cup" if is_tournament else "league",
        "team_count": _team_count(detail),
        "history_seasons": history_seasons,
        "fixture_seasons": fixture_count,
    }


def _active_slugs(rows: list[dict[str, Any]], max_active: int) -> set[str]:
    """Selecciona el calendario activo sin convertir el catálogo en una promesa de precisión."""
    eligible = [
        row for row in rows
        if not _is_womens(row["id"], row["name"])
        and not _is_youth(row["id"], row["name"])
        and not _is_national_team(row["id"], row["name"])
        and not _is_college(row["id"], row["name"])
    ]
    priority = {slug: index for index, slug in enumerate(PRIORITY_ACTIVE)}
    eligible.sort(
        key=lambda row: (
            {"A": 0, "B": 1, "C": 2}.get(row["tier"], 3),
            0 if row["id"] in LIVE_LEAGUES else 1,
            priority.get(row["id"], 10_000),
            0 if _is_domestic_top_flight(row["id"]) else 1,
            row["name"],
        )
    )
    selected: set[str] = set()
    for row in eligible:
        if len(selected) >= max_active:
            break
        if row["tier"] in ("A", "B") or row["id"] in priority or _is_domestic_top_flight(row["id"]):
            selected.add(row["id"])
    return selected


def _upsert_competition(conn: sqlite3.Connection, row: dict[str, Any], active: bool) -> None:
    conn.execute(
        """
        INSERT INTO competitions (
            id, name, short_name, country, timezone, tier, tier_reason,
            source_ids, goals_prior, home_prior, away_prior, prior_source,
            aliases_json, logo_url, is_tournament, active, availability_ready,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            short_name = excluded.short_name,
            country = excluded.country,
            timezone = excluded.timezone,
            tier = excluded.tier,
            tier_reason = excluded.tier_reason,
            source_ids = excluded.source_ids,
            goals_prior = excluded.goals_prior,
            home_prior = excluded.home_prior,
            away_prior = excluded.away_prior,
            prior_source = excluded.prior_source,
            aliases_json = excluded.aliases_json,
            logo_url = excluded.logo_url,
            is_tournament = excluded.is_tournament,
            active = excluded.active,
            availability_ready = excluded.availability_ready,
            updated_at = excluded.updated_at
        """,
        (
            row["id"], row["name"], row["short_name"], row["country"], row["timezone"],
            row["tier"], row["tier_reason"], row["source_ids"], row["goals_prior"],
            row["home_prior"], row["away_prior"], row["prior_source"],
            row["aliases_json"], row["logo_url"], row["is_tournament"],
            1 if active else 0, row["availability_ready"],
            row["created_at"], row["updated_at"],
        ),
    )


def _upsert_season(conn: sqlite3.Connection, row: dict[str, Any]) -> None:
    if not row.get("season"):
        return
    conn.execute(
        """
        INSERT INTO seasons (
            competition_id, season, start_date, end_date, format, team_count,
            goals_prior, home_prior, away_prior, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(competition_id, season) DO UPDATE SET
            start_date = excluded.start_date,
            end_date = excluded.end_date,
            format = excluded.format,
            team_count = excluded.team_count,
            goals_prior = excluded.goals_prior,
            home_prior = excluded.home_prior,
            away_prior = excluded.away_prior,
            source = excluded.source,
            updated_at = excluded.updated_at
        """,
        (
            row["id"], row["season"], row["season_start"], row["season_end"],
            row["format"], row["team_count"], row["goals_prior"],
            row["home_prior"], row["away_prior"], "espn", row["updated_at"],
        ),
    )


def _sync_leagues_metadata(conn: sqlite3.Connection, rows: list[dict[str, Any]]) -> int:
    """Mantiene leagues.season al día para las ligas que usa el modelo histórico."""
    updated = 0
    for row in rows:
        if not row.get("season"):
            continue
        cursor = conn.execute(
            """
            UPDATE leagues
            SET season = ?,
                name = COALESCE(?, name),
                country = COALESCE(?, country)
            WHERE id = ?
              AND (season IS NOT ? OR name IS NOT ? OR country IS NOT ?)
            """,
            (
                row["season"], row["name"], row["country"], row["id"],
                row["season"], row["name"], row["country"],
            ),
        )
        updated += cursor.rowcount
    return updated


def _write_competitions_json(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT id, name, short_name, country, timezone, tier, tier_reason,
               source_ids, goals_prior, home_prior, away_prior, prior_source,
               aliases_json, logo_url, is_tournament, active, availability_ready,
               updated_at
        FROM competitions
        ORDER BY active DESC,
                 CASE tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,
                 country, name
        """
    ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item["source_ids"] = json.loads(item["source_ids"] or "{}")
        item["aliases"] = json.loads(item["aliases_json"] or "[]")
        item.pop("aliases_json", None)
        items.append(item)
    by_tier = {tier: sum(1 for item in items if item["tier"] == tier) for tier in ("A", "B", "C")}
    payload = {
        "schema": "motor-nox.competitions.v1",
        "generatedAt": utc_now(),
        "total": len(items),
        "active": sum(1 for item in items if item["active"]),
        "byTier": by_tier,
        "items": items,
    }
    COMPETITIONS_JSON.parent.mkdir(parents=True, exist_ok=True)
    COMPETITIONS_JSON.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return payload


def ingest_competitions(
    conn: sqlite3.Connection | None = None,
    *,
    refresh: bool = False,
    max_active: int = 80,
    limit: int | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    close_conn = False
    if conn is None:
        init_db()
        conn = get_connection()
        close_conn = True
    try:
        slugs = catalog_slugs(refresh=refresh)
        if limit:
            slugs = slugs[:limit]
        print(f"Catálogo ESPN: {len(slugs)} competiciones")

        details: dict[str, dict[str, Any]] = {}
        if not dry_run:
            with ThreadPoolExecutor(max_workers=8) as executor:
                futures = {executor.submit(fetch_league_detail, slug, refresh=refresh): slug for slug in slugs}
                for index, future in enumerate(as_completed(futures), start=1):
                    slug = futures[future]
                    try:
                        detail = future.result()
                    except Exception as error:  # defensive: una competición no debe tumbar el catálogo
                        print(f"  aviso  {slug}: {error}", file=sys.stderr)
                        detail = None
                    details[slug] = detail
                    if index % 25 == 0 or index == len(futures):
                        print(f"  detalles {index}/{len(futures)}")
        else:
            details = {slug: None for slug in slugs}

        history = _history_stats(conn)
        fixture_seasons = _fixture_seasons(conn)
        rows = [
            _competition_row(conn, slug, details.get(slug), history, fixture_seasons)
            for slug in slugs
        ]
        active = _active_slugs(rows, max_active)
        for row in rows:
            row["active"] = 1 if row["id"] in active else 0

        if dry_run:
            print("Dry-run: no se escribió nada.")
            for row in rows:
                print(
                    f"  {row['id']:<24} {row['tier']} active={row['active']} "
                    f"{row['country'] or '—':<18} {row['name']}"
                )
            return {
                "total": len(rows),
                "active": sum(row["active"] for row in rows),
                "byTier": {tier: sum(1 for row in rows if row["tier"] == tier) for tier in ("A", "B", "C")},
            }

        with conn:
            for row in rows:
                _upsert_competition(conn, row, bool(row["active"]))
                _upsert_season(conn, row)
            leagues_updated = _sync_leagues_metadata(conn, rows)
            payload = _write_competitions_json(conn)
            conn.execute(
                """
                INSERT INTO data_quality_events (source, scope, field, severity, message, context_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "espn", "competitions", "catalog", "info",
                    f"Catálogo sincronizado: {payload['total']} competiciones, {payload['active']} activas.",
                    json.dumps(payload["byTier"], ensure_ascii=False),
                    utc_now(),
                ),
            )
        print(
            f"Catálogo guardado: {payload['total']} competiciones · "
            f"{payload['active']} activas · tiers {payload['byTier']} · "
            f"leagues actualizadas: {leagues_updated}"
        )
        return payload
    finally:
        if close_conn:
            conn.close()


def main() -> None:
    configure_stdio()
    parser = argparse.ArgumentParser(description="MOTOR-NOX · catálogo de competiciones ESPN")
    parser.add_argument("--refresh", action="store_true", help="Ignora la caché y vuelve a descargar")
    parser.add_argument("--max-active", type=int, default=80, help="Máximo de competiciones activas (60-100)")
    parser.add_argument("--limit", type=int, default=None, help="Limita el catálogo para pruebas")
    parser.add_argument("--dry-run", action="store_true", help="No escribe en SQLite ni en data/")
    args = parser.parse_args()
    ingest_competitions(
        refresh=args.refresh,
        max_active=max(1, min(200, args.max_active)),
        limit=args.limit,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
