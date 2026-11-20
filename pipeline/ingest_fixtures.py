"""
MOTOR-NOX · Fase 1 · Ingesta de fixtures.

Descarga el calendario de las competiciones activas desde el scoreboard público
de ESPN, normaliza estados y goles, y lo guarda en SQLite sin duplicados.

Ventana operativa: -1/+21 días. Backfill: temporada 2026-27 y, opcionalmente,
temporadas anteriores por competición.

Uso:
    python -m pipeline.ingest_fixtures --window
    python -m pipeline.ingest_fixtures --window --days-back 1 --days-forward 21
    python -m pipeline.ingest_fixtures --backfill --seasons 2026
    python -m pipeline.ingest_fixtures --backfill --seasons 2024,2025,2026 --competitions eng.1,esp.1
    python -m pipeline.ingest_fixtures --coverage
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from .db import (
    BASE_DIR,
    DATA_DIR,
    configure_stdio,
    get_connection,
    init_db,
    utc_now,
)
from .ingest_competitions import (
    ESPN_CORE,
    _priors,
    fetch_json,
    fetch_league_detail,
)

ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
CACHE_DIR = BASE_DIR / ".cache" / "espn_fixtures"
COVERAGE_JSON = DATA_DIR / "coverage.json"
FIXTURES_JSON = DATA_DIR / "fixtures.json"
USER_AGENT = "MOTOR-NOX/1.0 (motor de prediccion personal; datos publicos de ESPN)"

VALID_STATUSES = {"scheduled", "live", "finished", "postponed", "cancelled", "suspended"}
TERMINAL_STATUSES = {"finished", "cancelled"}

STATUS_MAP = {
    "STATUS_SCHEDULED": "scheduled",
    "STATUS_IN_PROGRESS": "live",
    "STATUS_HALFTIME": "live",
    "STATUS_END_PERIOD": "live",
    "STATUS_RAIN_DELAY": "live",
    "STATUS_DELAYED": "scheduled",
    "STATUS_FULL_TIME": "finished",
    "STATUS_FINAL": "finished",
    "STATUS_FINAL_AET": "finished",
    "STATUS_FINAL_PEN": "finished",
    "STATUS_FORFEIT": "finished",
    "STATUS_POSTPONED": "postponed",
    "STATUS_CANCELED": "cancelled",
    "STATUS_CANCELLED": "cancelled",
    "STATUS_SUSPENDED": "suspended",
    "STATUS_ABANDONED": "suspended",
}

CALENDAR_YEAR_LEAGUES = {
    "usa.1", "usa.usl.1", "usa.usl.l1", "usa.nwsl",
    "bra.1", "bra.2", "arg.1", "arg.2", "mex.1", "mex.2",
    "jpn.1", "ksa.1", "aus.1", "chn.1", "ind.1", "rsa.1",
    "crc.1", "gua.1", "hon.1", "slv.1",
    "col.1", "per.1", "par.1", "ecu.1", "ven.1", "bol.1",
    "uru.1", "chi.1", "nor.1", "swe.1", "den.1",
}

TRACKED_FIELDS = (
    "competition_id",
    "season",
    "kickoff_utc",
    "home_team_id",
    "away_team_id",
    "home_team_name",
    "away_team_name",
    "home_team_abbr",
    "away_team_abbr",
    "status",
    "home_goals",
    "away_goals",
    "venue",
    "venue_city",
    "stage",
)

KICKOFF_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


class QualityError(ValueError):
    """Un evento no cumple el contrato de calidad de fixtures."""


def normalize_utc(value: Any) -> str:
    """Convierte una fecha ESPN a ISO 8601 UTC con segundos y sufijo Z."""
    if value is None or value == "":
        raise QualityError("kickoff vacío")
    text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise QualityError(f"kickoff inválido: {text}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc).replace(microsecond=0)
    return parsed.isoformat().replace("+00:00", "Z")


def parse_score(value: Any, *, field: str) -> int | None:
    if value is None or value == "" or value == "-":
        return None
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError) as error:
        raise QualityError(f"{field} no numérico: {value}") from error
    if not number.is_integer():
        raise QualityError(f"{field} no entero: {value}")
    if number < 0:
        raise QualityError(f"{field} negativo: {value}")
    return int(number)


def status_from_espn(status_type: dict[str, Any]) -> str:
    name = str(status_type.get("name") or "").upper()
    if name in STATUS_MAP:
        return STATUS_MAP[name]
    if status_type.get("completed") is True:
        return "finished"
    state = str(status_type.get("state") or "").lower()
    if state == "pre":
        return "scheduled"
    if state == "in":
        return "live"
    if state == "post":
        return "finished"
    raise QualityError(f"estado ESPN desconocido: {name or state or '—'}")


def season_label_from_event(event: dict[str, Any], fallback: str | None = None) -> str:
    season = event.get("season") if isinstance(event.get("season"), dict) else {}
    for text in (str(season.get("slug") or ""), str(season.get("displayName") or "")):
        match = re.search(r"(\d{4}-\d{2})", text)
        if match:
            return match.group(1)
    year = season.get("year")
    if year and fallback and str(year) in str(fallback):
        return str(fallback)
    if year:
        return str(year)
    return fallback or "desconocida"


def _first_team(competitors: Iterable[dict[str, Any]], side: str) -> dict[str, Any] | None:
    for competitor in competitors:
        if str(competitor.get("homeAway") or "").lower() == side:
            return competitor
    return None


def parse_event(
    event: dict[str, Any],
    competition: dict[str, Any],
    *,
    source_url: str,
) -> dict[str, Any]:
    """Normaliza un evento ESPN al contrato de la tabla fixtures."""
    event_id = str(event.get("id") or "").strip()
    if not event_id:
        raise QualityError("evento sin id")
    competition_data = (event.get("competitions") or [{}])[0]
    status_type = (competition_data.get("status") or event.get("status") or {}).get("type") or {}
    status = status_from_espn(status_type)
    competitors = competition_data.get("competitors") or []
    home = _first_team(competitors, "home")
    away = _first_team(competitors, "away")
    if not home or not away:
        raise QualityError(f"{event_id}: faltan local o visitante")

    def team_field(competitor: dict[str, Any], key: str) -> Any:
        team = competitor.get("team") if isinstance(competitor.get("team"), dict) else {}
        return team.get(key) or competitor.get(key)

    home_team_id = str(team_field(home, "id") or "").strip()
    away_team_id = str(team_field(away, "id") or "").strip()
    home_team_name = str(team_field(home, "displayName") or team_field(home, "name") or "").strip()
    away_team_name = str(team_field(away, "displayName") or team_field(away, "name") or "").strip()
    if not home_team_id or not away_team_id:
        raise QualityError(f"{event_id}: equipo sin id")
    if not home_team_name or not away_team_name:
        raise QualityError(f"{event_id}: equipo sin nombre")
    if home_team_id == away_team_id:
        raise QualityError(f"{event_id}: local y visitante son el mismo equipo")

    home_goals = parse_score(home.get("score"), field="home_goals")
    away_goals = parse_score(away.get("score"), field="away_goals")
    if status == "finished":
        if home_goals is None or away_goals is None:
            raise QualityError(f"{event_id}: final sin goles")
    elif status in {"scheduled", "postponed", "cancelled"}:
        home_goals = None
        away_goals = None

    venue = competition_data.get("venue") if isinstance(competition_data.get("venue"), dict) else {}
    if not venue and isinstance(event.get("venue"), dict):
        venue = event["venue"]
    address = venue.get("address") if isinstance(venue.get("address"), dict) else {}
    notes = competition_data.get("notes") if isinstance(competition_data.get("notes"), list) else []
    stage = None
    for note in notes:
        if isinstance(note, dict):
            stage = note.get("headline") or note.get("text") or note.get("type")
            if stage:
                break

    return {
        "id": f"espn-{event_id}",
        "competition_id": competition["id"],
        "season": season_label_from_event(event, competition.get("current_season")),
        "kickoff_utc": normalize_utc(event.get("date")),
        "home_team_id": f"espn-{home_team_id}",
        "away_team_id": f"espn-{away_team_id}",
        "home_team_name": home_team_name,
        "away_team_name": away_team_name,
        "home_team_abbr": str(team_field(home, "abbreviation") or "") or None,
        "away_team_abbr": str(team_field(away, "abbreviation") or "") or None,
        "status": status,
        "home_goals": home_goals,
        "away_goals": away_goals,
        "venue": str(venue.get("fullName") or "") or None,
        "venue_city": str(address.get("city") or "") or None,
        "stage": str(stage) if stage else None,
        "source": "espn",
        "source_id": event_id,
        "source_url": source_url,
    }


def validate_fixture(fixture: dict[str, Any]) -> None:
    required = (
        "id", "competition_id", "season", "kickoff_utc",
        "home_team_id", "away_team_id", "home_team_name", "away_team_name",
        "status", "source", "source_id",
    )
    for key in required:
        if not fixture.get(key):
            raise QualityError(f"campo obligatorio vacío: {key}")
    if fixture["status"] not in VALID_STATUSES:
        raise QualityError(f"estado inválido: {fixture['status']}")
    if not KICKOFF_RE.match(fixture["kickoff_utc"]):
        raise QualityError(f"kickoff no UTC ISO: {fixture['kickoff_utc']}")
    if fixture["home_team_id"] == fixture["away_team_id"]:
        raise QualityError("local y visitante son el mismo equipo")
    for key in ("home_goals", "away_goals"):
        value = fixture.get(key)
        if value is not None and (not isinstance(value, int) or value < 0):
            raise QualityError(f"{key} inválido: {value}")
    if fixture["status"] == "finished" and (
        fixture.get("home_goals") is None or fixture.get("away_goals") is None
    ):
        raise QualityError("partido final sin goles")


def log_quality_event(
    conn: sqlite3.Connection,
    *,
    scope: str,
    message: str,
    severity: str = "warning",
    field: str | None = None,
    context: dict[str, Any] | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO data_quality_events (source, scope, field, severity, message, context_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "espn", scope, field, severity, message,
            json.dumps(context or {}, ensure_ascii=False), utc_now(),
        ),
    )


def _value_for_audit(value: Any) -> str | None:
    return None if value is None else str(value)


def upsert_fixture(conn: sqlite3.Connection, fixture: dict[str, Any]) -> str:
    """Inserta o actualiza sin duplicar. Devuelve inserted|updated|unchanged."""
    existing = conn.execute(
        "SELECT * FROM fixtures WHERE source = ? AND source_id = ?",
        (fixture["source"], fixture["source_id"]),
    ).fetchone()
    now = utc_now()
    if not existing:
        conn.execute(
            """
            INSERT INTO fixtures (
                id, competition_id, season, kickoff_utc,
                home_team_id, away_team_id, home_team_name, away_team_name,
                home_team_abbr, away_team_abbr, status, home_goals, away_goals,
                venue, venue_city, stage, source, source_id, source_url,
                first_seen_at, last_seen_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fixture["id"], fixture["competition_id"], fixture["season"], fixture["kickoff_utc"],
                fixture["home_team_id"], fixture["away_team_id"], fixture["home_team_name"],
                fixture["away_team_name"], fixture["home_team_abbr"], fixture["away_team_abbr"],
                fixture["status"], fixture["home_goals"], fixture["away_goals"],
                fixture["venue"], fixture["venue_city"], fixture["stage"],
                fixture["source"], fixture["source_id"], fixture["source_url"],
                now, now, now,
            ),
        )
        return "inserted"

    # Un partido final o cancelado no vuelve a programado por un payload viejo.
    guarded = dict(fixture)
    if existing["status"] in TERMINAL_STATUSES and guarded["status"] != existing["status"]:
        log_quality_event(
            conn,
            scope="fixtures",
            field="status",
            severity="warning",
            message=(
                f"{fixture['id']}: la fuente intentó cambiar {existing['status']} → "
                f"{guarded['status']}; se conserva el estado terminal."
            ),
            context={"fixture_id": fixture["id"], "source_id": fixture["source_id"]},
        )
        guarded["status"] = existing["status"]
        guarded["home_goals"] = existing["home_goals"]
        guarded["away_goals"] = existing["away_goals"]

    changes = [
        (field, existing[field], guarded[field])
        for field in TRACKED_FIELDS
        if existing[field] != guarded[field]
    ]
    if not changes:
        conn.execute(
            "UPDATE fixtures SET last_seen_at = ?, updated_at = ? WHERE id = ?",
            (now, now, existing["id"]),
        )
        return "unchanged"

    for field, old_value, new_value in changes:
        conn.execute(
            """
            INSERT INTO fixture_changes (fixture_id, field, old_value, new_value, detected_at, source)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                existing["id"], field, _value_for_audit(old_value),
                _value_for_audit(new_value), now, fixture["source"],
            ),
        )
    conn.execute(
        """
        UPDATE fixtures SET
            competition_id = ?, season = ?, kickoff_utc = ?,
            home_team_id = ?, away_team_id = ?, home_team_name = ?, away_team_name = ?,
            home_team_abbr = ?, away_team_abbr = ?, status = ?, home_goals = ?, away_goals = ?,
            venue = ?, venue_city = ?, stage = ?, source_url = ?,
            last_seen_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            guarded["competition_id"], guarded["season"], guarded["kickoff_utc"],
            guarded["home_team_id"], guarded["away_team_id"], guarded["home_team_name"],
            guarded["away_team_name"], guarded["home_team_abbr"], guarded["away_team_abbr"],
            guarded["status"], guarded["home_goals"], guarded["away_goals"],
            guarded["venue"], guarded["venue_city"], guarded["stage"], guarded["source_url"],
            now, now, existing["id"],
        ),
    )
    return "updated"


def month_ttl(year_month: str) -> int:
    now = datetime.now(timezone.utc)
    current = now.strftime("%Y%m")
    if year_month == current:
        return 10 * 60
    if year_month < current:
        return 7 * 24 * 60 * 60
    return 6 * 60 * 60


def fetch_scoreboard(slug: str, year_month: str, *, refresh: bool = False) -> list[dict[str, Any]]:
    url = f"{ESPN_SITE}/{slug}/scoreboard?dates={year_month}&limit=1000"
    cache_path = CACHE_DIR / slug / f"{year_month}.json"
    data = fetch_json(
        url,
        cache_path=cache_path,
        ttl_seconds=month_ttl(year_month),
        refresh=refresh,
    )
    events = data.get("events") if isinstance(data, dict) else None
    return events if isinstance(events, list) else []


def months_between(start: date, end: date) -> list[str]:
    if end < start:
        return []
    months: list[str] = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        months.append(f"{year:04d}{month:02d}")
        month += 1
        if month == 13:
            year += 1
            month = 1
    return months


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def season_window(slug: str, year: int, detail: dict[str, Any] | None) -> tuple[date, date]:
    # /seasons/{year} devuelve startDate/endDate en la raíz; el detalle de la
    # liga los devuelve dentro de season. Soportamos ambas formas.
    payload = detail or {}
    season = payload.get("season") if isinstance(payload.get("season"), dict) else {}
    start = _parse_date(payload.get("startDate")) or _parse_date(season.get("startDate"))
    end = _parse_date(payload.get("endDate")) or _parse_date(season.get("endDate"))
    if start and end:
        return start, end
    if slug in CALENDAR_YEAR_LEAGUES:
        return date(year, 1, 1), date(year, 12, 31)
    return date(year, 8, 1), date(year + 1, 7, 31)


def fetch_season_detail(slug: str, year: int, *, refresh: bool = False) -> dict[str, Any] | None:
    url = f"{ESPN_CORE}/leagues/{slug}/seasons/{year}"
    cache_path = CACHE_DIR / "seasons" / f"{slug}-{year}.json"
    try:
        data = fetch_json(
            url,
            cache_path=cache_path,
            ttl_seconds=30 * 24 * 60 * 60,
            refresh=refresh,
        )
    except RuntimeError:
        return None
    return data if isinstance(data, dict) else None


def load_competitions(
    conn: sqlite3.Connection,
    *,
    slugs: list[str] | None = None,
    tiers: list[str] | None = None,
    active_only: bool = True,
) -> list[dict[str, Any]]:
    where = []
    params: list[Any] = []
    if active_only:
        where.append("active = 1")
    if slugs:
        placeholders = ", ".join("?" for _ in slugs)
        where.append(f"id IN ({placeholders})")
        params.extend(slugs)
    if tiers:
        placeholders = ", ".join("?" for _ in tiers)
        where.append(f"tier IN ({placeholders})")
        params.extend(tiers)
    sql = "SELECT * FROM competitions"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY CASE tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, id"
    rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
    # Temporada actual de respaldo cuando un evento de ESPN no la trae.
    season_rows = conn.execute(
        """
        SELECT competition_id, season
        FROM seasons
        WHERE (competition_id, start_date) IN (
            SELECT competition_id, MAX(start_date) FROM seasons GROUP BY competition_id
        )
        """
    ).fetchall()
    current_season = {row["competition_id"]: row["season"] for row in season_rows}
    for row in rows:
        row["current_season"] = current_season.get(row["id"])
    return rows


def _upsert_sync_state(
    conn: sqlite3.Connection,
    *,
    sync_id: str,
    status: str,
    started_at: str,
    finished_at: str,
    stats: dict[str, Any],
    window_from: str | None,
    window_to: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO sync_state (
            id, source, scope, last_started_at, last_finished_at, status,
            events, inserted, updated, errors, window_from, window_to, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            last_started_at = excluded.last_started_at,
            last_finished_at = excluded.last_finished_at,
            status = excluded.status,
            events = excluded.events,
            inserted = excluded.inserted,
            updated = excluded.updated,
            errors = excluded.errors,
            window_from = excluded.window_from,
            window_to = excluded.window_to,
            details_json = excluded.details_json
        """,
        (
            sync_id, "espn", "fixtures", started_at, finished_at, status,
            int(stats.get("events", 0)), int(stats.get("inserted", 0)),
            int(stats.get("updated", 0)), int(stats.get("errors", 0)),
            window_from, window_to, json.dumps(stats, ensure_ascii=False),
        ),
    )


def refresh_priors(conn: sqlite3.Connection, competition_ids: Iterable[str]) -> int:
    updated = 0
    for competition_id in competition_ids:
        goals, home, away, source = _priors(conn, competition_id)
        if source != "fixtures":
            continue
        cursor = conn.execute(
            """
            UPDATE competitions
            SET goals_prior = ?, home_prior = ?, away_prior = ?,
                prior_source = 'fixtures', updated_at = ?
            WHERE id = ?
            """,
            (goals, home, away, utc_now(), competition_id),
        )
        updated += cursor.rowcount
    return updated


def normalize_fixture_seasons(conn: sqlite3.Connection) -> dict[str, Any]:
    """Alinea fixtures.season con la etiqueta registrada en la tabla seasons.

    ESPN a veces entrega season.year (2026) en el evento aunque la temporada
    sea 2026-27. La corrección usa el rango de fechas de la temporada y, como
    respaldo, el prefijo del año. Nunca inventa una etiqueta que no exista ya
    en la tabla seasons.
    """
    seasons_by_competition: dict[str, list[dict[str, Any]]] = {}
    for row in conn.execute(
        """
        SELECT competition_id, season, start_date, end_date
        FROM seasons
        ORDER BY competition_id, start_date
        """
    ):
        seasons_by_competition.setdefault(row["competition_id"], []).append(dict(row))

    fixtures = conn.execute(
        "SELECT id, competition_id, season, kickoff_utc FROM fixtures"
    ).fetchall()
    updated = 0
    by_competition: dict[str, int] = {}
    for fixture in fixtures:
        options = seasons_by_competition.get(fixture["competition_id"], [])
        if not options:
            continue
        target: str | None = None
        kickoff = _parse_datetime(fixture["kickoff_utc"])
        if kickoff is not None:
            for option in options:
                start = _parse_datetime(option.get("start_date"))
                end = _parse_datetime(option.get("end_date"))
                if start and end and start <= kickoff <= end:
                    target = str(option["season"])
                    break
        if target is None:
            year = str(fixture["season"])
            labels = {
                str(option["season"])
                for option in options
                if str(option["season"]).startswith(f"{year}-")
            }
            if len(labels) == 1:
                target = labels.pop()
        if target is not None and target != fixture["season"]:
            conn.execute(
                "UPDATE fixtures SET season = ?, updated_at = ? WHERE id = ?",
                (target, utc_now(), fixture["id"]),
            )
            updated += 1
            by_competition[fixture["competition_id"]] = (
                by_competition.get(fixture["competition_id"], 0) + 1
            )

    if updated:
        log_quality_event(
            conn,
            scope="fixtures",
            field="season",
            severity="info",
            message=f"Temporadas normalizadas: {updated} fixtures.",
            context={"by_competition": by_competition},
        )
    return {"updated": updated, "by_competition": by_competition}


def _window_bounds(days_back: int, days_forward: int) -> tuple[date, date]:
    today = datetime.now(timezone.utc).date()
    return today - timedelta(days=max(0, days_back)), today + timedelta(days=max(0, days_forward))


def ingest_fixtures(
    conn: sqlite3.Connection | None = None,
    *,
    mode: str = "window",
    days_back: int = 1,
    days_forward: int = 21,
    seasons: list[int] | None = None,
    slugs: list[str] | None = None,
    tiers: list[str] | None = None,
    refresh: bool = False,
    dry_run: bool = False,
    max_future_months: int = 2,
) -> dict[str, Any]:
    close_conn = False
    if conn is None:
        init_db()
        conn = get_connection()
        close_conn = True
    try:
        competitions = load_competitions(conn, slugs=slugs, tiers=tiers, active_only=True)
        if not competitions:
            raise SystemExit(
                "No hay competiciones activas. Ejecuta primero: python -m pipeline.ingest_competitions"
            )

        started_at = utc_now()
        stats: dict[str, Any] = {
            "mode": mode,
            "competitions": len(competitions),
            "events": 0,
            "inserted": 0,
            "updated": 0,
            "unchanged": 0,
            "errors": 0,
            "expected_ab": 0,
            "expected_ab_by_date": {},
            "stored_ab": 0,
            "tasks": 0,
            "by_competition": {},
        }
        window_from: str | None = None
        window_to: str | None = None

        if mode == "window":
            start, end = _window_bounds(days_back, days_forward)
            window_from, window_to = start.isoformat(), end.isoformat()
            tasks: list[tuple[dict[str, Any], str]] = []
            for competition in competitions:
                for year_month in months_between(start, end):
                    tasks.append((competition, year_month))
        elif mode == "backfill":
            if not seasons:
                seasons = [datetime.now(timezone.utc).year]
            tasks = []
            today = datetime.now(timezone.utc).date()
            for competition in competitions:
                for year in seasons:
                    detail = fetch_season_detail(competition["id"], year, refresh=refresh)
                    season_start, season_end = season_window(competition["id"], year, detail)
                    if year == datetime.now(timezone.utc).year:
                        season_end = min(season_end, today + timedelta(days=31 * max_future_months))
                    for year_month in months_between(season_start, season_end):
                        tasks.append((competition, year_month))
            window_from = f"seasons:{','.join(str(year) for year in seasons)}"
            window_to = None
        else:
            raise ValueError(f"modo desconocido: {mode}")

        # Deduplica tareas (una competición puede compartir meses entre temporadas).
        unique_tasks = []
        seen: set[tuple[str, str]] = set()
        for competition, year_month in tasks:
            key = (competition["id"], year_month)
            if key in seen:
                continue
            seen.add(key)
            unique_tasks.append((competition, year_month))
        stats["tasks"] = len(unique_tasks)
        print(
            f"Fixtures · modo {mode} · {len(competitions)} competiciones · "
            f"{len(unique_tasks)} descargas de mes"
        )

        for index, (competition, year_month) in enumerate(unique_tasks, start=1):
            try:
                events = fetch_scoreboard(competition["id"], year_month, refresh=refresh)
            except Exception as error:
                stats["errors"] += 1
                log_quality_event(
                    conn,
                    scope="fixtures",
                    field="scoreboard",
                    severity="error",
                    message=f"{competition['id']} {year_month}: {error}",
                    context={"competition_id": competition["id"], "month": year_month},
                )
                continue
            competition_stats = stats["by_competition"].setdefault(
                competition["id"],
                {"events": 0, "inserted": 0, "updated": 0, "unchanged": 0, "errors": 0},
            )
            competition_stats["events"] += len(events)
            stats["events"] += len(events)
            for event in events:
                try:
                    fixture = parse_event(
                        event,
                        competition,
                        source_url=f"{ESPN_SITE}/{competition['id']}/scoreboard?dates={year_month}",
                    )
                    validate_fixture(fixture)
                    if mode == "window":
                        kickoff = datetime.fromisoformat(
                            fixture["kickoff_utc"].replace("Z", "+00:00")
                        ).date()
                        if start <= kickoff <= end and competition["tier"] in ("A", "B"):
                            stats["expected_ab"] += 1
                            day_key = kickoff.isoformat()
                            stats["expected_ab_by_date"][day_key] = (
                                stats["expected_ab_by_date"].get(day_key, 0) + 1
                            )
                    if dry_run:
                        result = "unchanged"
                    else:
                        result = upsert_fixture(conn, fixture)
                    stats[result] = stats.get(result, 0) + 1
                    competition_stats[result] = competition_stats.get(result, 0) + 1
                except QualityError as error:
                    stats["errors"] += 1
                    competition_stats["errors"] += 1
                    log_quality_event(
                        conn,
                        scope="fixtures",
                        field="event",
                        severity="error",
                        message=f"{competition['id']} {year_month}: {error}",
                        context={"competition_id": competition["id"], "month": year_month},
                    )
            if index % 25 == 0 or index == len(unique_tasks):
                print(
                    f"  {index}/{len(unique_tasks)} · eventos {stats['events']} · "
                    f"insertados {stats['inserted']} · actualizados {stats['updated']} · "
                    f"errores {stats['errors']}"
                )
            if not dry_run:
                conn.commit()

        if not dry_run:
            refresh_priors(conn, [competition["id"] for competition in competitions])
            season_stats = normalize_fixture_seasons(conn)
            stats["seasons_normalized"] = season_stats["updated"]
            if mode == "window":
                stats["stored_ab"] = conn.execute(
                    """
                    SELECT COUNT(*) AS n
                    FROM fixtures f
                    JOIN competitions c ON c.id = f.competition_id
                    WHERE c.tier IN ('A', 'B')
                      AND f.kickoff_utc >= ?
                      AND f.kickoff_utc < ?
                    """,
                    (f"{window_from}T00:00:00Z", f"{window_to}T23:59:59Z"),
                ).fetchone()["n"]
            status = "success" if stats["errors"] == 0 else ("partial" if stats["inserted"] + stats["updated"] > 0 else "failed")
            _upsert_sync_state(
                conn,
                sync_id=f"fixtures_{mode}",
                status=status,
                started_at=started_at,
                finished_at=utc_now(),
                stats=stats,
                window_from=window_from,
                window_to=window_to,
            )
            conn.commit()
        print(
            f"Fixtures guardados: {stats['inserted']} nuevos · {stats['updated']} actualizados · "
            f"{stats['unchanged']} sin cambios · {stats['errors']} errores."
        )
        return stats
    finally:
        if close_conn:
            conn.close()


def _quality_checks(conn: sqlite3.Connection) -> dict[str, Any]:
    def scalar(sql: str, params: tuple[Any, ...] = ()) -> int:
        row = conn.execute(sql, params).fetchone()
        return int(row[0] or 0) if row else 0

    duplicates = scalar(
        """
        SELECT COUNT(*) FROM (
            SELECT source, source_id FROM fixtures
            GROUP BY source, source_id HAVING COUNT(*) > 1
        )
        """
    )
    missing = scalar(
        """
        SELECT COUNT(*) FROM fixtures
        WHERE id IS NULL OR competition_id IS NULL OR season IS NULL
           OR kickoff_utc IS NULL OR home_team_id IS NULL OR away_team_id IS NULL
           OR home_team_name IS NULL OR away_team_name IS NULL
           OR status IS NULL OR source IS NULL OR source_id IS NULL
        """
    )
    finished_without_score = scalar(
        """
        SELECT COUNT(*) FROM fixtures
        WHERE status = 'finished' AND (home_goals IS NULL OR away_goals IS NULL)
        """
    )
    invalid_status = scalar(
        """
        SELECT COUNT(*) FROM fixtures
        WHERE status NOT IN ('scheduled', 'live', 'finished', 'postponed', 'cancelled', 'suspended')
        """
    )
    invalid_kickoff = scalar(
        """
        SELECT COUNT(*) FROM fixtures
        WHERE kickoff_utc NOT GLOB '????-??-??T??:??:??Z'
        """
    )
    negative_goals = scalar(
        """
        SELECT COUNT(*) FROM fixtures
        WHERE home_goals < 0 OR away_goals < 0
        """
    )
    return {
        "duplicates": duplicates,
        "missing_required": missing,
        "finished_without_score": finished_without_score,
        "invalid_status": invalid_status,
        "invalid_kickoff": invalid_kickoff,
        "negative_goals": negative_goals,
    }


def coverage_report(conn: sqlite3.Connection | None = None, *, days: int = 7, write: bool = True) -> dict[str, Any]:
    close_conn = False
    if conn is None:
        init_db()
        conn = get_connection()
        close_conn = True
    try:
        now = datetime.now(timezone.utc)
        report_today = now.date()
        window_start = report_today
        window_end = report_today + timedelta(days=days)

        latest_sync = conn.execute(
            "SELECT * FROM sync_state WHERE scope = 'fixtures' AND id = 'fixtures_window' ORDER BY last_finished_at DESC LIMIT 1"
        ).fetchone()
        details = {}
        if latest_sync and latest_sync["details_json"]:
            try:
                details = json.loads(latest_sync["details_json"])
            except json.JSONDecodeError:
                details = {}

        expected_by_date = details.get("expected_ab_by_date") or {}
        if not expected_by_date and latest_sync:
            # Sin desglose por fecha, el informe solo es comparable con la
            # ventana exacta que usó la última sincronización.
            sync_from = latest_sync["window_from"]
            sync_to = latest_sync["window_to"]
            if sync_from and sync_to and not str(sync_from).startswith("seasons:"):
                try:
                    sync_start = date.fromisoformat(str(sync_from))
                    sync_end = date.fromisoformat(str(sync_to))
                except ValueError:
                    pass
                else:
                    if sync_end >= report_today:
                        window_start = sync_start
                        window_end = sync_end

        window_from = f"{window_start.isoformat()}T00:00:00Z"
        window_to = f"{window_end.isoformat()}T23:59:59Z"

        competition_rows = conn.execute(
            """
            SELECT tier, COUNT(*) AS n, SUM(active) AS active
            FROM competitions GROUP BY tier
            """
        ).fetchall()
        by_tier = {row["tier"]: {"total": int(row["n"]), "active": int(row["active"] or 0)} for row in competition_rows}
        total_competitions = sum(item["total"] for item in by_tier.values())
        active_competitions = sum(item["active"] for item in by_tier.values())

        season_count = conn.execute("SELECT COUNT(*) AS n FROM seasons").fetchone()["n"]
        status_rows = conn.execute(
            """
            SELECT f.status, COUNT(*) AS n
            FROM fixtures f
            JOIN competitions c ON c.id = f.competition_id
            WHERE c.active = 1
            GROUP BY f.status
            """
        ).fetchall()
        by_status = {row["status"]: int(row["n"]) for row in status_rows}
        total_fixtures = sum(by_status.values())

        window_rows = conn.execute(
            """
            SELECT f.competition_id, c.name, c.tier, COUNT(*) AS n
            FROM fixtures f
            JOIN competitions c ON c.id = f.competition_id
            WHERE c.active = 1
              AND f.kickoff_utc >= ? AND f.kickoff_utc <= ?
            GROUP BY f.competition_id, c.name, c.tier
            ORDER BY c.tier, c.name
            """,
            (window_from, window_to),
        ).fetchall()
        window_fixtures = sum(int(row["n"]) for row in window_rows)
        window_competitions = len(window_rows)

        ab_rows = conn.execute(
            """
            SELECT f.competition_id, c.name, c.tier, COUNT(*) AS n
            FROM fixtures f
            JOIN competitions c ON c.id = f.competition_id
            WHERE c.tier IN ('A', 'B')
              AND c.active = 1
              AND f.kickoff_utc >= ? AND f.kickoff_utc <= ?
            GROUP BY f.competition_id, c.name, c.tier
            ORDER BY c.tier, c.name
            """,
            (window_from, window_to),
        ).fetchall()
        ab_competitions = len(ab_rows)
        ab_fixtures = sum(int(row["n"]) for row in ab_rows)

        expected_by_date = details.get("expected_ab_by_date") or {}
        expected_ab = int(details.get("expected_ab") or 0)
        if expected_by_date:
            expected_ab = sum(
                int(n) for day, n in expected_by_date.items()
                if window_start.isoformat() <= str(day) <= window_end.isoformat()
            )
        active_ab = (
            int(by_tier.get("A", {}).get("active", 0))
            + int(by_tier.get("B", {}).get("active", 0))
        )
        if expected_ab > 0:
            coverage_pct = round(min(100.0, ab_fixtures / expected_ab * 100.0), 2)
        elif latest_sync is None and active_ab > 0:
            coverage_pct = 0.0
        else:
            # Sin partidos A/B en la ventana no hay nada que cubrir.
            coverage_pct = 100.0

        quality = _quality_checks(conn)
        last_sync_at = latest_sync["last_finished_at"] if latest_sync else None
        freshness_minutes = None
        if last_sync_at:
            try:
                last_dt = datetime.fromisoformat(last_sync_at.replace("Z", "+00:00"))
                freshness_minutes = round((now - last_dt).total_seconds() / 60.0, 1)
            except ValueError:
                freshness_minutes = None
        matchday = bool(
            conn.execute(
                """
                SELECT 1
                FROM fixtures f
                JOIN competitions c ON c.id = f.competition_id
                WHERE c.active = 1
                  AND f.kickoff_utc >= ? AND f.kickoff_utc <= ?
                LIMIT 1
                """,
                (f"{report_today.isoformat()}T00:00:00Z", f"{window_end.isoformat()}T23:59:59Z"),
            ).fetchone()
        )
        freshness_limit = 15 if matchday else 360

        alerts: list[str] = []
        for key, value in quality.items():
            if value:
                alerts.append(f"{key}={value}")
        if coverage_pct < 95.0:
            alerts.append(f"cobertura A/B={coverage_pct:.1f}% < 95%")
        if freshness_minutes is not None and freshness_minutes > freshness_limit:
            alerts.append(
                f"última sincronización hace {freshness_minutes:.0f} min "
                f"(límite {'15' if matchday else '360'} min)"
            )
        status = "PASS" if not alerts else "FAIL"

        payload = {
            "schema": "motor-nox.coverage.v1",
            "generatedAt": utc_now(),
            "competitions": {
                "total": total_competitions,
                "active": active_competitions,
                "byTier": by_tier,
            },
            "seasons": int(season_count),
            "fixtures": {
                "total": total_fixtures,
                "byStatus": by_status,
                "windowDays": max(0, (window_end - window_start).days),
                "windowFrom": window_start.isoformat(),
                "windowTo": window_end.isoformat(),
                "windowFixtures": window_fixtures,
                "windowCompetitions": window_competitions,
            },
            "abCoverage": {
                "competitions": ab_competitions,
                "fixtures": ab_fixtures,
                "expected": expected_ab,
                "coveragePct": coverage_pct,
            },
            "quality": quality,
            "freshness": {
                "lastSyncAt": last_sync_at,
                "minutes": freshness_minutes,
                "limitMinutes": freshness_limit,
                "matchday": matchday,
                "status": (
                    "PASS" if freshness_minutes is not None and freshness_minutes <= freshness_limit
                    else "WARN"
                ),
            },
            "alerts": alerts,
            "status": status,
            "windowDetail": [dict(row) for row in window_rows],
        }
        if write:
            COVERAGE_JSON.parent.mkdir(parents=True, exist_ok=True)
            COVERAGE_JSON.write_text(
                json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            _write_fixtures_json(conn, report_today, window_end)
        return payload
    finally:
        if close_conn:
            conn.close()


def _write_fixtures_json(conn: sqlite3.Connection, start: date, end: date) -> None:
    # Si el conector de API-Football está disponible, genera el JSON combinado
    # (ESPN + API) con deduplicación. Las métricas de cobertura siguen basadas
    # únicamente en la tabla `fixtures` (ESPN).
    try:
        from .ingest_api_football import write_combined_fixtures_json

        write_combined_fixtures_json(conn, start, end)
        return
    except Exception:  # fallback a ESPN puro si el conector falla
        pass
    rows = conn.execute(
        """
        SELECT f.id, f.competition_id, c.name AS competition_name, c.tier,
               f.season, f.kickoff_utc, f.home_team_id, f.home_team_name,
               f.away_team_id, f.away_team_name, f.status, f.home_goals,
               f.away_goals, f.venue, f.venue_city, f.stage, f.source,
               f.source_id, f.updated_at
        FROM fixtures f
        JOIN competitions c ON c.id = f.competition_id
        WHERE c.active = 1
          AND f.kickoff_utc >= ? AND f.kickoff_utc <= ?
        ORDER BY f.kickoff_utc, c.name
        """,
        (f"{start.isoformat()}T00:00:00Z", f"{end.isoformat()}T23:59:59Z"),
    ).fetchall()
    payload = {
        "schema": "motor-nox.fixtures.v1",
        "generatedAt": utc_now(),
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "count": len(rows),
        "items": [dict(row) for row in rows],
    }
    FIXTURES_JSON.parent.mkdir(parents=True, exist_ok=True)
    FIXTURES_JSON.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    configure_stdio()
    parser = argparse.ArgumentParser(description="MOTOR-NOX · ingesta de fixtures ESPN")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--window", action="store_true", help="Ventana operativa -1/+21 días")
    mode.add_argument("--backfill", action="store_true", help="Backfill por temporadas")
    mode.add_argument("--coverage", action="store_true", help="Solo recalcula cobertura")
    mode.add_argument("--normalize-seasons", action="store_true", help="Alinea fixtures.season con la tabla seasons")
    parser.add_argument("--days-back", type=int, default=1)
    parser.add_argument("--days-forward", type=int, default=21)
    parser.add_argument("--seasons", default="", help="Años separados por coma: 2024,2025,2026")
    parser.add_argument("--competitions", default="", help="IDs separados por coma")
    parser.add_argument("--tiers", default="", help="Tiers separados por coma: A,B")
    parser.add_argument("--max-future-months", type=int, default=2)
    parser.add_argument("--refresh", action="store_true", help="Ignora la caché de ESPN")
    parser.add_argument("--dry-run", action="store_true", help="Descarga y valida, sin escribir fixtures")
    args = parser.parse_args()

    slugs = [item.strip() for item in args.competitions.split(",") if item.strip()] or None
    tiers = [item.strip().upper() for item in args.tiers.split(",") if item.strip()] or None
    seasons = [int(item.strip()) for item in args.seasons.split(",") if item.strip()] or None

    if args.coverage:
        payload = coverage_report(days=args.days_forward)
        print(
            f"Cobertura {payload['status']} · {payload['competitions']['active']} competiciones activas · "
            f"{payload['fixtures']['total']} fixtures · A/B {payload['abCoverage']['coveragePct']}% · "
            f"alertas {len(payload['alerts'])}"
        )
        return

    if args.normalize_seasons:
        init_db()
        conn = get_connection()
        try:
            result = normalize_fixture_seasons(conn)
            conn.commit()
            payload = coverage_report(conn=conn, days=args.days_forward)
            print(
                f"Temporadas normalizadas: {result['updated']} fixtures · "
                f"cobertura {payload['status']} · A/B {payload['abCoverage']['coveragePct']}%"
            )
        finally:
            conn.close()
        return

    stats = ingest_fixtures(
        mode="backfill" if args.backfill else "window",
        days_back=args.days_back,
        days_forward=args.days_forward,
        seasons=seasons,
        slugs=slugs,
        tiers=tiers,
        refresh=args.refresh,
        dry_run=args.dry_run,
        max_future_months=max(0, args.max_future_months),
    )
    if not args.dry_run:
        payload = coverage_report(days=args.days_forward)
        print(
            f"Cobertura {payload['status']} · A/B {payload['abCoverage']['coveragePct']}% · "
            f"fixtures ventana {payload['fixtures']['windowFixtures']} · "
            f"alertas {len(payload['alerts'])}"
        )
    print(json.dumps({k: v for k, v in stats.items() if k != "by_competition"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
