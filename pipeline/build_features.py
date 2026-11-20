"""
MOTOR-NOX V1.0 — constructor del feature store pre-partido.

Principios:
- Una fila por partido y versión de dataset.
- Cada feature lleva value, quality, source, as_of y usable_for_model.
- Solo se usan partidos anteriores al kickoff para calcular features.
- Si falta un dato, value = null y quality = "missing"; no se inventa un neutro.
- El XI del partido actual no se usa: la continuidad se calcula con los dos
  partidos anteriores. Las cuotas de cierre se guardan como referencia, pero
  no son usables como feature histórica porque Football-Data no publica hora.

Uso:
    python -m pipeline.build_features
    python -m pipeline.build_features --version features-2.2.0
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
from itertools import groupby
import json
import math
from pathlib import Path
import sqlite3
from statistics import mean
from typing import Any

from .db import DATA_DIR, get_connection, init_db
from .feature_catalog import (
    CORE_FEATURE_GROUPS,
    FEATURE_CATALOG,
    OPTIONAL_FEATURE_GROUPS,
    catalog_entry,
)
from .venues import repair_venues

DATASET_VERSION = "features-2.2.0"
FEATURE_STORE_DIR = DATA_DIR / "features"
COVERAGE_PATH = FEATURE_STORE_DIR / "coverage.json"
META_PATH = FEATURE_STORE_DIR / "dataset_meta.json"
WEB_PATH = FEATURE_STORE_DIR / "web_features.json"
DICTIONARY_PATH = DATA_DIR / "FEATURE_DICTIONARY.md"

ELO_INITIAL = 1500.0
ELO_K = 20.0
ELO_HOME_ADVANTAGE = 65.0
LEAGUE_PRIOR_GOALS = 1.35
LEAGUE_PRIOR_MATCHES = 8.0

# Tabla curada de rivalidades. El par se guarda ordenado alfabéticamente.
# No pretende ser exhaustiva: 0 significa "no listado", no "sin rivalidad".
RIVALRIES = [
    ("arsenal", "tottenham", "Derbi de North London", 0.92),
    ("manchester_city", "manchester_united", "Derbi de Manchester", 0.96),
    ("everton", "liverpool", "Derbi de Merseyside", 0.96),
    ("liverpool", "manchester_united", "Clásico del Noroeste", 0.82),
    ("chelsea", "fulham", "Derbi del Oeste de Londres", 0.62),
    ("arsenal", "chelsea", "Derbi de Londres", 0.74),
    ("chelsea", "tottenham", "Derbi de Londres", 0.72),
    ("tottenham", "west_ham", "Derbi de Londres", 0.64),
    ("chelsea", "west_ham", "Derbi de Londres", 0.62),
    ("arsenal", "west_ham", "Derbi de Londres", 0.54),
    ("brighton", "crystal_palace", "Derbi M23", 0.80),
    ("newcastle", "sunderland", "Derbi de Tyne-Wear", 0.96),
    ("atletico_madrid", "real_madrid", "Derbi de Madrid", 0.96),
    ("barcelona", "real_madrid", "El Clásico", 1.00),
    ("barcelona", "espanyol", "Derbi de Barcelona", 0.90),
    ("real_betis", "sevilla", "Derbi de Sevilla", 0.96),
    ("athletic_club", "real_sociedad", "Derbi vasco", 0.92),
    ("levante", "valencia", "Derbi de Valencia", 0.82),
    ("getafe", "rayo_vallecano", "Derbi del sur de Madrid", 0.58),
    ("atletico_madrid", "rayo_vallecano", "Derbi de Madrid", 0.60),
    ("rayo_vallecano", "real_madrid", "Derbi de Madrid", 0.58),
    ("girona", "barcelona", "Derbi catalán", 0.52),
    ("espanyol", "girona", "Derbi catalán", 0.48),
    ("valencia", "villarreal", "Derbi de la Comunidad Valenciana", 0.62),
]


def _iso(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _kickoff_date(kickoff: datetime) -> str:
    return kickoff.strftime("%Y-%m-%dT00:00:00Z")


def _entry(
    value: Any,
    quality: str,
    source: str,
    as_of: datetime | str | None = None,
    usable: bool | None = None,
    note: str | None = None,
    sample: int | None = None,
) -> dict:
    """Build a feature entry with the mandatory provenance fields."""
    if value is None:
        return {
            "value": None,
            "quality": "missing",
            "source": source,
            "as_of": _iso(as_of),
            "usable_for_model": False,
            "note": note or "Sin dato disponible.",
        }
    if quality not in {"observed", "estimated", "placeholder"}:
        raise ValueError(f"Calidad no válida: {quality}")
    if usable is None:
        usable = quality == "observed"
    entry = {
        "value": value,
        "quality": quality,
        "source": source,
        "as_of": _iso(as_of),
        "usable_for_model": bool(usable),
    }
    if note:
        entry["note"] = note
    if sample is not None:
        entry["sample"] = int(sample)
    return entry


def _rolling(history: list[dict], key: str, window: int, side: bool | None = None) -> tuple[float | None, int, datetime | None]:
    rows = [
        row for row in history
        if row.get(key) is not None and (side is None or row["is_home"] is side)
    ][-window:]
    if not rows:
        return None, 0, None
    return mean(row[key] for row in rows), len(rows), max(row["date"] for row in rows)


def _rolling_pair(history: list[dict], window: int, side: bool | None = None) -> tuple[float | None, float | None, int, datetime | None]:
    rows = [
        row for row in history
        if row.get("xg_for") is not None and row.get("xg_against") is not None
        and (side is None or row["is_home"] is side)
    ][-window:]
    if not rows:
        return None, None, 0, None
    return (
        mean(row["xg_for"] for row in rows),
        mean(row["xg_against"] for row in rows),
        len(rows),
        max(row["date"] for row in rows),
    )


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def _last_sunday(year: int, month: int) -> datetime:
    if month == 12:
        day = datetime(year, 12, 31, tzinfo=timezone.utc)
    else:
        day = datetime(year, month + 1, 1, tzinfo=timezone.utc) - timedelta(days=1)
    while day.weekday() != 6:
        day -= timedelta(days=1)
    return day.replace(hour=1, minute=0, second=0, microsecond=0)


def _dst_offset_hours(country: str, moment: datetime) -> float | None:
    """Approximate legal offset for England/Spain without the tzdata package."""
    base = {"England": 0.0, "Spain": 1.0, "Germany": 1.0, "Italy": 1.0, "France": 1.0}.get(country)
    if base is None:
        return None
    year = moment.year
    dst_start = _last_sunday(year, 3)
    dst_end = _last_sunday(year, 10)
    return base + (1.0 if dst_start <= moment < dst_end else 0.0)


def _timezone_diff_hours(home_country: str | None, away_country: str | None, kickoff: datetime) -> float | None:
    if not home_country or not away_country:
        return None
    home_offset = _dst_offset_hours(home_country, kickoff)
    away_offset = _dst_offset_hours(away_country, kickoff)
    if home_offset is None or away_offset is None:
        return None
    return abs(home_offset - away_offset)


def _jaccard(first: set[str], second: set[str]) -> float | None:
    if not first or not second:
        return None
    union = first | second
    return len(first & second) / len(union) if union else None


def _quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _distribution(values: list[float]) -> dict:
    clean = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    if not clean:
        return {"n": 0, "mean": None, "std": None, "min": None, "p25": None, "median": None, "p75": None, "max": None}
    average = mean(clean)
    variance = mean((value - average) ** 2 for value in clean) if len(clean) > 1 else 0.0
    return {
        "n": len(clean),
        "mean": round(average, 4),
        "std": round(math.sqrt(variance), 4),
        "min": round(min(clean), 4),
        "p25": round(_quantile(clean, 0.25), 4),
        "median": round(_quantile(clean, 0.5), 4),
        "p75": round(_quantile(clean, 0.75), 4),
        "max": round(max(clean), 4),
    }


class FeatureBuilder:
    def __init__(self, conn: sqlite3.Connection, version: str = DATASET_VERSION):
        self.conn = conn
        self.version = version
        self.csv_path = FEATURE_STORE_DIR / f"feature_store_{version}.csv"
        self.jsonl_path = FEATURE_STORE_DIR / f"feature_store_{version}.jsonl.gz"
        self.built_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.matches: list[sqlite3.Row] = []
        self.stats: dict[str, dict[str, sqlite3.Row]] = {}
        self.lineups: dict[str, dict[str, dict]] = {}
        self.odds: dict[str, dict[str, dict[str, list[float]]]] = {}
        self.odds_bookmakers: dict[str, set[str]] = {}
        self.weather: dict[tuple[str, str], sqlite3.Row] = {}
        self.teams: dict[str, sqlite3.Row] = {}
        self.venues: dict[str, sqlite3.Row] = {}
        self.rivalries: dict[tuple[str, str], dict] = {}

        # Estado secuencial: solo contiene partidos anteriores al que se evalúa.
        self.team_history: dict[str, list[dict]] = {}
        self.lineup_history: dict[str, list[dict]] = {}
        self.season_players: dict[tuple[str, str], set[str]] = {}
        self.last_match_date: dict[str, datetime] = {}
        self.elo: dict[tuple[str, str], float] = {}
        self.elo_available: dict[tuple[str, str], bool] = {}
        self.standings: dict[tuple[str, str], dict[str, dict]] = {}
        self.season_splits: dict[tuple[str, str, str, bool], dict] = {}
        self.league_teams: dict[tuple[str, str], set[str]] = {}
        self.league_season_total: dict[tuple[str, str], int] = {}
        self.league_season_played: dict[tuple[str, str], int] = {}
        self.last_league_season_date: dict[tuple[str, str], datetime] = {}
        self.league_goals_total: dict[str, int] = {}
        self.league_matches_total: dict[str, int] = {}
        self.league_xg_total: dict[str, float] = {}
        self.league_xg_samples: dict[str, int] = {}
        self.last_league_date: dict[str, datetime] = {}
        self.last_league_xg_date: dict[str, datetime] = {}
        self.referee_history: dict[str, list[float]] = {}

        # Agregados de cobertura.
        self.coverage: dict[str, dict] = {}
        self.feature_rows: list[tuple] = []
        self.quality_counts: dict[str, int] = {"observed": 0, "estimated": 0, "placeholder": 0, "missing": 0}

    # ------------------------------------------------------------------
    # Carga
    # ------------------------------------------------------------------
    def load(self) -> None:
        self.matches = self.conn.execute(
            """
            SELECT m.*, l.name AS league_name,
                   th.name AS home_name, ta.name AS away_name,
                   th.venue_id AS home_team_venue_id, ta.venue_id AS away_team_venue_id,
                   v.name AS venue_name, v.country AS venue_country,
                   v.latitude AS venue_latitude, v.longitude AS venue_longitude,
                   v.altitude AS venue_altitude
            FROM matches m
            JOIN leagues l ON l.id = m.league_id
            JOIN teams th ON th.id = m.home_team_id
            JOIN teams ta ON ta.id = m.away_team_id
            LEFT JOIN venues v ON v.id = m.venue_id
            ORDER BY m.date_utc, m.league_id, m.id
            """
        ).fetchall()

        self.teams = {row["id"]: row for row in self.conn.execute("SELECT * FROM teams")}
        self.venues = {row["id"]: row for row in self.conn.execute("SELECT * FROM venues")}

        for row in self.conn.execute("SELECT * FROM team_match_stats"):
            self.stats.setdefault(row["match_id"], {})[row["team_id"]] = row

        for row in self.conn.execute(
            "SELECT match_id, team_id, player_id, formation FROM lineups WHERE is_starter = 1"
        ):
            team_lineup = self.lineups.setdefault(row["match_id"], {}).setdefault(
                row["team_id"], {"xi": set(), "formation": None}
            )
            team_lineup["xi"].add(str(row["player_id"]))
            if team_lineup["formation"] is None and row["formation"]:
                team_lineup["formation"] = row["formation"]

        for row in self.conn.execute(
            "SELECT match_id, market, selection, prob_devigged, bookmaker FROM odds"
        ):
            market = self.odds.setdefault(row["match_id"], {}).setdefault(row["market"], {})
            market.setdefault(row["selection"], []).append(float(row["prob_devigged"]))
            if row["market"] == "1X2":
                self.odds_bookmakers.setdefault(row["match_id"], set()).add(row["bookmaker"])

        for row in self.conn.execute("SELECT * FROM venue_weather_daily"):
            self.weather[(row["venue_id"], row["date"])] = row

        for row in self.conn.execute("SELECT * FROM rivalries"):
            pair = tuple(sorted((row["team_a_id"], row["team_b_id"])))
            self.rivalries[pair] = {"name": row["name"], "intensity": float(row["intensity"])}

        for match in self.matches:
            key = (match["league_id"], match["season"])
            self.league_teams.setdefault(key, set()).update({match["home_team_id"], match["away_team_id"]})
            self.league_season_total[key] = self.league_season_total.get(key, 0) + 1

    def seed_rivalries(self) -> int:
        existing = {row["id"] for row in self.conn.execute("SELECT id FROM teams")}
        rows = []
        for team_a, team_b, name, intensity in RIVALRIES:
            if team_a not in existing or team_b not in existing:
                continue
            pair = tuple(sorted((team_a, team_b)))
            rows.append((pair[0], pair[1], name, intensity, "MOTOR-NOX · tabla curada"))
        with self.conn:
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO rivalries (team_a_id, team_b_id, name, intensity, source)
                VALUES (?, ?, ?, ?, ?)
                """,
                rows,
            )
        return len(rows)

    # ------------------------------------------------------------------
    # Cálculos auxiliares
    # ------------------------------------------------------------------
    def _position(self, league: str, season: str, team: str) -> int | None:
        table = self.standings.get((league, season), {})
        rows = [
            (team_id, values) for team_id, values in table.items()
            if values["played"] > 0
        ]
        rows.sort(key=lambda item: (
            -item[1]["pts"],
            -(item[1]["gf"] - item[1]["ga"]),
            -item[1]["gf"],
            item[0],
        ))
        for index, (team_id, _) in enumerate(rows, start=1):
            if team_id == team:
                return index
        return None

    def _team_venue(self, team_id: str) -> sqlite3.Row | None:
        team = self.teams.get(team_id)
        if not team or not team["venue_id"]:
            return None
        return self.venues.get(team["venue_id"])

    def _travel_km(self, from_team_id: str, to_venue_id: str | None) -> float | None:
        origin = self._team_venue(from_team_id)
        destination = self.venues.get(to_venue_id) if to_venue_id else None
        if not origin or not destination:
            return None
        if origin["id"] == destination["id"]:
            return 0.0
        if origin["latitude"] is None or origin["longitude"] is None:
            return None
        if destination["latitude"] is None or destination["longitude"] is None:
            return None
        return round(
            _haversine_km(
                float(origin["latitude"]), float(origin["longitude"]),
                float(destination["latitude"]), float(destination["longitude"]),
            ),
            2,
        )

    def _market_probs(self, match_id: str) -> dict:
        markets = self.odds.get(match_id, {})
        result = {
            "home": None, "draw": None, "away": None,
            "over25": None, "under25": None, "bookmakers": None,
        }
        one_x_two = markets.get("1X2", {})
        if one_x_two:
            raw = {
                "home": mean(one_x_two.get("1", [])) if one_x_two.get("1") else None,
                "draw": mean(one_x_two.get("X", [])) if one_x_two.get("X") else None,
                "away": mean(one_x_two.get("2", [])) if one_x_two.get("2") else None,
            }
            if all(value is not None for value in raw.values()):
                total = sum(raw.values())
                if total > 0:
                    result.update({key: value / total for key, value in raw.items()})
            result["bookmakers"] = len(self.odds_bookmakers.get(match_id, set())) or None
        over_under = markets.get("OU25", {})
        if over_under:
            if over_under.get("Over"):
                result["over25"] = mean(over_under["Over"])
            if over_under.get("Under"):
                result["under25"] = mean(over_under["Under"])
        return result

    def _add(self, features: dict, name: str, entry: dict) -> None:
        features[name] = entry
        coverage = self.coverage.setdefault(name, {
            "non_null": 0,
            "model_usable": 0,
            "observed": 0,
            "estimated": 0,
            "placeholder": 0,
            "missing": 0,
            "as_of_min": None,
            "as_of_max": None,
        })
        if entry["value"] is not None:
            coverage["non_null"] += 1
            if entry["usable_for_model"]:
                coverage["model_usable"] += 1
        quality = entry["quality"]
        coverage[quality] = coverage.get(quality, 0) + 1
        as_of = entry.get("as_of")
        if as_of:
            if coverage["as_of_min"] is None or as_of < coverage["as_of_min"]:
                coverage["as_of_min"] = as_of
            if coverage["as_of_max"] is None or as_of > coverage["as_of_max"]:
                coverage["as_of_max"] = as_of

    # ------------------------------------------------------------------
    # Feature computation
    # ------------------------------------------------------------------
    def compute(self, match: sqlite3.Row) -> dict:
        kickoff = _parse(match["date_utc"])
        if kickoff is None:
            raise ValueError(f"Fecha inválida en {match['id']}: {match['date_utc']}")
        league = match["league_id"]
        season = match["season"]
        home = match["home_team_id"]
        away = match["away_team_id"]
        date_as_of = _kickoff_date(kickoff)
        home_history = self.team_history.get(home, [])
        away_history = self.team_history.get(away, [])
        features: dict[str, dict] = {}

        # --- Contexto de liga ------------------------------------------------
        league_matches = self.league_matches_total.get(league, 0)
        league_goals = self.league_goals_total.get(league, 0)
        goals_avg = (league_goals + LEAGUE_PRIOR_GOALS * 2 * LEAGUE_PRIOR_MATCHES) / (
            2 * (league_matches + LEAGUE_PRIOR_MATCHES)
        )
        self._add(features, "league_goals_avg_prior", _entry(
            round(goals_avg, 4),
            "estimated",
            "Football-Data.co.uk · media previa de liga",
            self.last_league_date.get(league) if league_matches > 0 else None,
            usable=league_matches > 0,
            note=None if league_matches > 0 else "Sin partidos previos; se usa el prior 1.35.",
            sample=league_matches,
        ))
        xg_samples = self.league_xg_samples.get(league, 0)
        xg_total = self.league_xg_total.get(league, 0.0)
        xg_avg = (xg_total + LEAGUE_PRIOR_GOALS * LEAGUE_PRIOR_MATCHES) / (xg_samples + LEAGUE_PRIOR_MATCHES)
        self._add(features, "league_xg_avg_prior", _entry(
            round(xg_avg, 4),
            "estimated",
            "Understat · media previa de xG",
            self.last_league_xg_date.get(league) if xg_samples > 0 else None,
            usable=xg_samples > 0,
            note=None if xg_samples > 0 else "Sin xG previo; se usa el prior 1.35.",
            sample=xg_samples,
        ))

        # --- xG rolling ------------------------------------------------------
        for side, history in (("home", home_history), ("away", away_history)):
            for window in (5, 10, 20):
                for kind, key in (("for", "xg_for"), ("against", "xg_against")):
                    value, sample, as_of = _rolling(history, key, window)
                    self._add(features, f"{side}_xg_{kind}_{window}", _entry(
                        round(value, 4) if value is not None else None,
                        "estimated" if value is not None else "missing",
                        f"Understat · media móvil {window}",
                        as_of,
                        usable=value is not None,
                        note=None if value is not None else "Sin xG previo para el equipo.",
                        sample=sample,
                    ))
            for kind, key in (("for", "xg_for"), ("against", "xg_against")):
                side_flag = True if side == "home" else False
                value, sample, as_of = _rolling(history, key, 5, side=side_flag)
                venue = "home" if side == "home" else "away"
                self._add(features, f"{side}_xg_{kind}_5_{venue}", _entry(
                    round(value, 4) if value is not None else None,
                    "estimated" if value is not None else "missing",
                    f"Understat · media móvil 5 ({'local' if side_flag else 'visitante'})",
                    as_of,
                    usable=value is not None,
                    note=None if value is not None else "Sin muestra en esa sede.",
                    sample=sample,
                ))
            for window in (5, 10, 20):
                xg_for, xg_against, sample, as_of = _rolling_pair(history, window)
                diff = round(xg_for - xg_against, 4) if xg_for is not None and xg_against is not None else None
                self._add(features, f"{side}_xg_diff_{window}", _entry(
                    diff,
                    "estimated" if diff is not None else "missing",
                    f"Understat · diferencial xG {window}",
                    as_of,
                    usable=diff is not None,
                    note=None if diff is not None else "Sin xG previo para el equipo.",
                    sample=sample,
                ))

        for window in (5, 10, 20):
            home_diff = features[f"home_xg_diff_{window}"]["value"]
            away_diff = features[f"away_xg_diff_{window}"]["value"]
            value = round(home_diff - away_diff, 4) if home_diff is not None and away_diff is not None else None
            as_of = max(
                filter(None, [
                    features[f"home_xg_diff_{window}"]["as_of"],
                    features[f"away_xg_diff_{window}"]["as_of"],
                ]),
                default=None,
            )
            self._add(features, f"xg_diff_{window}", _entry(
                value,
                "estimated" if value is not None else "missing",
                f"Understat · diferencial xG {window} local−visitante",
                as_of,
                usable=value is not None,
                note=None if value is not None else "Falta xG de alguno de los equipos.",
            ))

        # --- Tiros -----------------------------------------------------------
        for side, history in (("home", home_history), ("away", away_history)):
            for kind, key in (("for", "shots_for"), ("against", "shots_against")):
                value, sample, as_of = _rolling(history, key, 10)
                self._add(features, f"{side}_shots_{kind}_10", _entry(
                    round(value, 4) if value is not None else None,
                    "observed" if value is not None else "missing",
                    "Football-Data.co.uk · media móvil 10",
                    as_of,
                    usable=value is not None,
                    note=None if value is not None else "Sin tiros previos.",
                    sample=sample,
                ))

        # --- Tiros a puerta --------------------------------------------------
        for side, history in (("home", home_history), ("away", away_history)):
            for kind, key in (("for", "sot_for"), ("against", "sot_against")):
                value, sample, as_of = _rolling(history, key, 10)
                self._add(features, f"{side}_sot_{kind}_10", _entry(
                    round(value, 4) if value is not None else None,
                    "observed" if value is not None else "missing",
                    "Football-Data.co.uk · media móvil 10",
                    as_of,
                    usable=value is not None,
                    note=None if value is not None else "Sin tiros a puerta previos.",
                    sample=sample,
                ))

        # --- PPDA ------------------------------------------------------------
        for side, history in (("home", home_history), ("away", away_history)):
            for window in (5, 10):
                value, sample, as_of = _rolling(history, "ppda", window)
                self._add(features, f"{side}_ppda_{window}", _entry(
                    round(value, 4) if value is not None else None,
                    "observed" if value is not None else "missing",
                    f"Understat · PPDA media móvil {window}",
                    as_of,
                    usable=value is not None,
                    note=None if value is not None else "Sin PPDA previo.",
                    sample=sample,
                ))

        # --- Elo -------------------------------------------------------------
        home_elo = self.elo.get((league, home), ELO_INITIAL)
        away_elo = self.elo.get((league, away), ELO_INITIAL)
        home_elo_available = self.elo_available.get((league, home), False)
        away_elo_available = self.elo_available.get((league, away), False)
        elo_as_of = self.last_league_date.get(league)
        self._add(features, "home_elo_pre", _entry(
            round(home_elo, 2),
            "estimated",
            "Cálculo propio · Elo K=20, ventaja local 65",
            elo_as_of if home_elo_available else None,
            usable=home_elo_available,
            note=None if home_elo_available else "Sin partidos previos del equipo; se usa el prior 1500.",
        ))
        self._add(features, "away_elo_pre", _entry(
            round(away_elo, 2),
            "estimated",
            "Cálculo propio · Elo K=20, ventaja local 65",
            elo_as_of if away_elo_available else None,
            usable=away_elo_available,
            note=None if away_elo_available else "Sin partidos previos del equipo; se usa el prior 1500.",
        ))
        elo_diff = round(home_elo - away_elo, 2)
        elo_diff_usable = home_elo_available and away_elo_available
        self._add(features, "elo_diff", _entry(
            elo_diff,
            "estimated",
            "Cálculo propio · Elo local−visitante",
            elo_as_of if elo_diff_usable else None,
            usable=elo_diff_usable,
            note=None if elo_diff_usable else "Algún equipo no tiene partidos previos; el diferencial incluye un prior.",
        ))

        # --- Descanso y congestión ------------------------------------------
        for side, team, history in (("home", home, home_history), ("away", away, away_history)):
            last_date = self.last_match_date.get(team)
            rest = max(0, (kickoff - last_date).days) if last_date else None
            self._add(features, f"{side}_rest_days", _entry(
                rest,
                "observed" if rest is not None else "missing",
                "Football-Data.co.uk · días desde el último partido",
                last_date,
                usable=rest is not None,
                note=None if rest is not None else "Sin partido previo del equipo.",
            ))
            for window in (14, 21):
                window_start = kickoff - timedelta(days=window)
                recent = [row for row in history if row["date"] > window_start]
                value = len(recent) if history else None
                as_of = max((row["date"] for row in recent), default=last_date)
                self._add(features, f"{side}_matches_{window}d", _entry(
                    value,
                    "observed" if value is not None else "missing",
                    f"Football-Data.co.uk · partidos de liga en {window} días",
                    as_of,
                    usable=value is not None,
                    note=(
                        None if value is not None
                        else "Sin historial previo; no se asume 0."
                    ) if window == 14 else (
                        "Solo liga; copa/Europa no disponible." if value is not None
                        else "Sin historial previo; no se asume 0."
                    ),
                    sample=len(recent) if history else None,
                ))
        for window in (14, 21):
            home_value = features[f"home_matches_{window}d"]["value"]
            away_value = features[f"away_matches_{window}d"]["value"]
            value = home_value - away_value if home_value is not None and away_value is not None else None
            as_of = max(
                filter(None, [
                    features[f"home_matches_{window}d"]["as_of"],
                    features[f"away_matches_{window}d"]["as_of"],
                ]),
                default=None,
            )
            self._add(features, f"matches_{window}d_diff", _entry(
                value,
                "observed" if value is not None else "missing",
                f"Cálculo propio · congestión {window} días local−visitante",
                as_of,
                usable=value is not None,
                note=None if value is not None else "Falta historial de algún equipo.",
            ))
        rest_home = features["home_rest_days"]["value"]
        rest_away = features["away_rest_days"]["value"]
        rest_diff = rest_home - rest_away if rest_home is not None and rest_away is not None else None
        rest_as_of = max(
            filter(None, [features["home_rest_days"]["as_of"], features["away_rest_days"]["as_of"]]),
            default=None,
        )
        self._add(features, "rest_diff", _entry(
            rest_diff,
            "observed" if rest_diff is not None else "missing",
            "Cálculo propio · descanso local−visitante",
            rest_as_of,
            usable=rest_diff is not None,
            note=None if rest_diff is not None else "Falta descanso de algún equipo.",
        ))
        for side in ("home", "away"):
            self._add(features, f"{side}_cup_europe_matches_14d", _entry(
                None,
                "missing",
                "No disponible · la base solo cubre liga",
                None,
                usable=False,
                note="Copa/Europa no está en la base histórica; no se usa un neutro.",
            ))

        # --- Viaje -----------------------------------------------------------
        home_travel = self._travel_km(home, match["venue_id"])
        away_travel = self._travel_km(away, match["venue_id"])
        self._add(features, "home_travel_km", _entry(
            home_travel,
            "observed" if home_travel is not None else "missing",
            "venues · Haversine",
            date_as_of,
            usable=home_travel is not None,
            note=None if home_travel is not None else "Falta sede o coordenadas.",
        ))
        self._add(features, "away_travel_km", _entry(
            away_travel,
            "observed" if away_travel is not None else "missing",
            "venues · Haversine",
            date_as_of,
            usable=away_travel is not None,
            note=None if away_travel is not None else "Falta sede o coordenadas.",
        ))
        travel_diff = round(away_travel - home_travel, 2) if home_travel is not None and away_travel is not None else None
        self._add(features, "travel_diff", _entry(
            travel_diff,
            "observed" if travel_diff is not None else "missing",
            "Cálculo propio · viaje visitante−local",
            date_as_of,
            usable=travel_diff is not None,
            note=None if travel_diff is not None else "Falta distancia de algún equipo.",
        ))
        home_venue_row = self.venues.get(match["venue_id"]) if match["venue_id"] else None
        home_country = home_venue_row["country"] if home_venue_row else None
        away_team_venue = self._team_venue(away)
        away_country = away_team_venue["country"] if away_team_venue else None
        tz_diff = _timezone_diff_hours(home_country, away_country, kickoff)
        self._add(features, "travel_timezone_diff_h", _entry(
            tz_diff,
            "observed" if tz_diff is not None else "missing",
            "Cálculo propio · offset horario de sedes",
            date_as_of,
            usable=tz_diff is not None,
            note=None if tz_diff is not None else "Falta país de alguna sede.",
        ))

        # --- Derbi -----------------------------------------------------------
        pair = tuple(sorted((home, away)))
        rivalry = self.rivalries.get(pair)
        self._add(features, "is_derby", _entry(
            1 if rivalry else 0,
            "observed",
            "MOTOR-NOX · tabla curada de rivalidades",
            date_as_of,
            usable=True,
            note="0 = par no listado; la tabla no es exhaustiva.",
        ))
        self._add(features, "rivalry_intensity", _entry(
            float(rivalry["intensity"]) if rivalry else 0.0,
            "observed",
            "MOTOR-NOX · tabla curada de rivalidades",
            date_as_of,
            usable=True,
            note="0 = par no listado.",
        ))
        self._add(features, "rivalry_name", _entry(
            rivalry["name"] if rivalry else None,
            "observed" if rivalry else "missing",
            "MOTOR-NOX · tabla curada de rivalidades",
            date_as_of if rivalry else None,
            usable=False,
            note=None if rivalry else "Par no listado en la tabla curada.",
        ))

        # --- Importancia -----------------------------------------------------
        home_position = self._position(league, season, home)
        away_position = self._position(league, season, away)
        home_table = self.standings.get((league, season), {}).get(home, {"played": 0, "pts": 0})
        away_table = self.standings.get((league, season), {}).get(away, {"played": 0, "pts": 0})
        home_played = home_table["played"]
        away_played = away_table["played"]
        home_ppg = round(home_table["pts"] / home_played, 4) if home_played else None
        away_ppg = round(away_table["pts"] / away_played, 4) if away_played else None
        table_as_of = self.last_league_season_date.get((league, season))
        n_teams = len(self.league_teams.get((league, season), set())) or 20
        home_title = (1 if home_position <= 4 and home_played >= 10 else 0) if home_position is not None else None
        away_title = (1 if away_position <= 4 and away_played >= 10 else 0) if away_position is not None else None
        home_relegation = (
            1 if home_position > n_teams - 3 and home_played >= 10 else 0
        ) if home_position is not None else None
        away_relegation = (
            1 if away_position > n_teams - 3 and away_played >= 10 else 0
        ) if away_position is not None else None
        position_diff = home_position - away_position if home_position is not None and away_position is not None else None

        self._add(features, "home_position", _entry(
            home_position, "observed" if home_position is not None else "missing",
            "Football-Data.co.uk · tabla previa", table_as_of,
            usable=home_position is not None,
            note=None if home_position is not None else "Sin partidos previos en la temporada.",
        ))
        self._add(features, "away_position", _entry(
            away_position, "observed" if away_position is not None else "missing",
            "Football-Data.co.uk · tabla previa", table_as_of,
            usable=away_position is not None,
            note=None if away_position is not None else "Sin partidos previos en la temporada.",
        ))
        self._add(features, "position_diff", _entry(
            position_diff, "observed" if position_diff is not None else "missing",
            "Cálculo propio · posición local−visitante", table_as_of,
            usable=position_diff is not None,
            note=None if position_diff is not None else "Falta tabla previa de algún equipo.",
        ))
        self._add(features, "home_ppg", _entry(
            home_ppg, "observed" if home_ppg is not None else "missing",
            "Football-Data.co.uk · puntos por partido", table_as_of,
            usable=home_ppg is not None,
            note=None if home_ppg is not None else "Sin partidos previos en la temporada.",
        ))
        self._add(features, "away_ppg", _entry(
            away_ppg, "observed" if away_ppg is not None else "missing",
            "Football-Data.co.uk · puntos por partido", table_as_of,
            usable=away_ppg is not None,
            note=None if away_ppg is not None else "Sin partidos previos en la temporada.",
        ))
        for side, title, relegation in (
            ("home", home_title, home_relegation),
            ("away", away_title, away_relegation),
        ):
            self._add(features, f"{side}_title_contention", _entry(
                title, "observed" if title is not None else "missing",
                "Cálculo propio · top 4 con >=10 partidos", table_as_of,
                usable=title is not None,
                note=None if title is not None else "Sin tabla previa.",
            ))
            self._add(features, f"{side}_relegation_risk", _entry(
                relegation, "observed" if relegation is not None else "missing",
                "Cálculo propio · últimos 3 con >=10 partidos", table_as_of,
                usable=relegation is not None,
                note=None if relegation is not None else "Sin tabla previa.",
            ))

        title_signal = bool(home_title or away_title)
        relegation_signal = bool(home_relegation or away_relegation)
        derby_signal = bool(rivalry)
        if title_signal or relegation_signal:
            importance = 1.15
            importance_quality = "observed"
            importance_usable = True
            importance_note = "Pelea de título o descenso."
        elif derby_signal:
            importance = 1.10
            importance_quality = "observed"
            importance_usable = True
            importance_note = "Derbi listado."
        elif home_position is not None and away_position is not None:
            importance = 1.0
            importance_quality = "observed"
            importance_usable = True
            importance_note = "Partido de importancia normal."
        else:
            importance = 1.0
            importance_quality = "estimated"
            importance_usable = False
            importance_note = "Sin tabla previa; importancia base no verificada."
        self._add(features, "match_importance", _entry(
            importance, importance_quality,
            "Cálculo propio · título/descenso/derbi",
            table_as_of or date_as_of,
            usable=importance_usable,
            note=importance_note,
        ))

        played = self.league_season_played.get((league, season), 0)
        total = self.league_season_total.get((league, season), 0)
        progress = round(played / total, 4) if total else 0.0
        self._add(features, "season_progress", _entry(
            progress, "observed",
            "Cálculo propio · partidos disputados / total",
            date_as_of,
            usable=True,
            note=None,
            sample=played,
        ))
        self._add(features, "is_final_phase", _entry(
            1 if progress >= 0.75 else 0, "observed",
            "Cálculo propio · progreso >= 75%",
            date_as_of,
            usable=True,
            note=None,
        ))

        # --- Alineaciones ----------------------------------------------------
        for side, team in (("home", home), ("away", away)):
            history = self.lineup_history.get(team, [])
            last = history[-1] if history else None
            previous = history[-2] if len(history) >= 2 else None
            continuity = _jaccard(last["xi"], previous["xi"]) if last and previous else None
            formation = last["formation"] if last else None
            squad_depth = len(self.season_players.get((team, season), set()))
            self._add(features, f"{side}_lineup_continuity", _entry(
                round(continuity, 4) if continuity is not None else None,
                "observed" if continuity is not None else "missing",
                "ESPN · Jaccard de titulares en los dos partidos anteriores",
                last["date"] if last else None,
                usable=continuity is not None,
                note=None if continuity is not None else "Se necesitan al menos dos partidos previos con XI.",
            ))
            self._add(features, f"{side}_formation_last", _entry(
                formation,
                "observed" if formation else "missing",
                "ESPN · formación del último partido",
                last["date"] if last else None,
                usable=formation is not None,
                note=None if formation else "Sin formación previa.",
            ))
            self._add(features, f"{side}_squad_depth", _entry(
                squad_depth if history else None,
                "observed" if history else "missing",
                "ESPN · titulares distintos usados en la temporada",
                last["date"] if last else None,
                usable=bool(history),
                note=None if history else "Sin alineaciones previas.",
                sample=squad_depth if history else None,
            ))
            self._add(features, f"{side}_lineup_confirmed", _entry(
                0,
                "observed",
                "ESPN · limitación temporal",
                date_as_of,
                usable=False,
                note="El XI del partido actual se conoce después del kickoff; no se usa como feature.",
            ))
            for missing_name, missing_source in (
                ("absences", "No disponible · tabla injuries vacía"),
                ("suspensions", "No disponible · sin fuente de sanciones"),
            ):
                self._add(features, f"{side}_{missing_name}", _entry(
                    None, "missing", missing_source, None,
                    usable=False,
                    note="No se inventa un neutro.",
                ))

        # --- Splits local/visitante -----------------------------------------
        for side, team, is_home in (("home", home, True), ("away", away, False)):
            split = self.season_splits.get((league, season, team, is_home), {
                "played": 0, "pts": 0, "gf": 0, "ga": 0, "last": None,
            })
            suffix = "home" if side == "home" else "away"
            self._add(features, f"{side}_{suffix}_ppg", _entry(
                round(split["pts"] / split["played"], 4) if split["played"] else None,
                "observed" if split["played"] else "missing",
                f"Football-Data.co.uk · puntos/partido {'en casa' if is_home else 'fuera'}",
                split["last"],
                usable=bool(split["played"]),
                note=None if split["played"] else "Sin partidos previos en esa sede.",
            ))
            self._add(features, f"{side}_{suffix}_gf_pg", _entry(
                round(split["gf"] / split["played"], 4) if split["played"] else None,
                "observed" if split["played"] else "missing",
                f"Football-Data.co.uk · goles a favor/partido {'en casa' if is_home else 'fuera'}",
                split["last"],
                usable=bool(split["played"]),
                note=None if split["played"] else "Sin partidos previos en esa sede.",
            ))
            self._add(features, f"{side}_{suffix}_ga_pg", _entry(
                round(split["ga"] / split["played"], 4) if split["played"] else None,
                "observed" if split["played"] else "missing",
                f"Football-Data.co.uk · goles en contra/partido {'en casa' if is_home else 'fuera'}",
                split["last"],
                usable=bool(split["played"]),
                note=None if split["played"] else "Sin partidos previos en esa sede.",
            ))

        # --- Mercado implícito ----------------------------------------------
        market = self._market_probs(match["id"])
        market_note = "Cuota de cierre; Football-Data no publica hora exacta. Referencia neutral, no feature histórica."
        for name, value in (
            ("market_home_prob", market["home"]),
            ("market_draw_prob", market["draw"]),
            ("market_away_prob", market["away"]),
            ("market_over25_prob", market["over25"]),
            ("market_under25_prob", market["under25"]),
        ):
            self._add(features, name, _entry(
                round(value, 4) if value is not None else None,
                "observed" if value is not None else "missing",
                "Football-Data.co.uk · cuotas de cierre de-vigged",
                None,
                usable=False,
                note=market_note if value is not None else "Sin cuota para el partido.",
            ))
        self._add(features, "market_btts_prob", _entry(
            None, "missing", "No disponible · Football-Data no incluye BTTS", None,
            usable=False, note="No se inventa una probabilidad de BTTS.",
        ))
        self._add(features, "market_bookmakers", _entry(
            market["bookmakers"], "observed" if market["bookmakers"] is not None else "missing",
            "Football-Data.co.uk · casas con 1X2", None,
            usable=False,
            note="Conteo de casas; no usable sin timestamp.",
        ))
        self._add(features, "market_timestamp_available", _entry(
            0, "observed", "Football-Data.co.uk · limitación temporal", None,
            usable=False,
            note="No se publica la hora exacta de la cuota de cierre.",
        ))

        # --- Valor de plantilla ---------------------------------------------
        for side in ("home", "away"):
            self._add(features, f"{side}_squad_value", _entry(
                None, "missing", "No disponible · Transfermarkt no integrado", None,
                usable=False,
                note="No se usa un valor inventado.",
            ))

        # --- Clima, altitud y árbitro ---------------------------------------
        home_venue = self.venues.get(match["venue_id"]) if match["venue_id"] else None
        away_venue = self._team_venue(away)
        altitude = float(home_venue["altitude"]) if home_venue and home_venue["altitude"] is not None else None
        away_altitude = float(away_venue["altitude"]) if away_venue and away_venue["altitude"] is not None else None
        altitude_diff = round(altitude - away_altitude, 2) if altitude is not None and away_altitude is not None else None
        self._add(features, "altitude_m", _entry(
            altitude, "observed" if altitude is not None else "missing",
            "venues · altitud de la sede", date_as_of,
            usable=altitude is not None,
            note=None if altitude is not None else "Sede sin altitud.",
        ))
        self._add(features, "away_altitude_m", _entry(
            away_altitude, "observed" if away_altitude is not None else "missing",
            "venues · altitud de la sede habitual del visitante", date_as_of,
            usable=away_altitude is not None,
            note=None if away_altitude is not None else "Sede del visitante sin altitud.",
        ))
        self._add(features, "altitude_diff", _entry(
            altitude_diff, "observed" if altitude_diff is not None else "missing",
            "Cálculo propio · altitud sede−visitante", date_as_of,
            usable=altitude_diff is not None,
            note=None if altitude_diff is not None else "Falta altitud de alguna sede.",
        ))

        weather_row = self.weather.get((match["venue_id"], kickoff.date().isoformat())) if match["venue_id"] else None
        weather_note = "Open-Meteo reanálisis diario; no es el pronóstico disponible antes del partido."
        for name, key in (
            ("weather_temp_c", "temp_c"),
            ("weather_precip_mm", "precip_mm"),
            ("weather_wind_kmh", "wind_kmh"),
            ("weather_condition", "condition"),
        ):
            value = weather_row[key] if weather_row else None
            self._add(features, name, _entry(
                value,
                "estimated" if value is not None else "missing",
                "Open-Meteo · reanálisis diario",
                date_as_of if value is not None else None,
                usable=False,
                note=weather_note if value is not None else "Sin dato meteorológico para la sede y fecha.",
            ))

        referee = match["referee"]
        referee_cards = self.referee_history.get(referee, []) if referee else []
        referee_mean = round(mean(referee_cards), 4) if referee_cards else None
        referee_as_of = date_as_of
        self._add(features, "referee_name", _entry(
            referee, "observed" if referee else "missing",
            "Football-Data.co.uk · árbitro asignado", date_as_of if referee else None,
            usable=bool(referee),
            note=None if referee else "Árbitro no disponible en LaLiga.",
        ))
        self._add(features, "referee_cards_per_match", _entry(
            referee_mean, "observed" if referee_mean is not None else "missing",
            "Football-Data.co.uk · media previa del árbitro", referee_as_of if referee else None,
            usable=referee_mean is not None,
            note=None if referee_mean is not None else "Sin partidos previos del árbitro.",
            sample=len(referee_cards) if referee else None,
        ))
        self._add(features, "referee_matches", _entry(
            len(referee_cards) if referee else None,
            "observed" if referee else "missing",
            "Football-Data.co.uk · partidos previos del árbitro", referee_as_of if referee else None,
            usable=bool(referee),
            note=None if referee else "Árbitro no disponible en LaLiga.",
            sample=len(referee_cards) if referee else None,
        ))
        self._add(features, "referee_penalties_per_match", _entry(
            None, "missing", "No disponible · Football-Data no publica penales por árbitro", None,
            usable=False, note="No se inventa un neutro.",
        ))

        return features

    # ------------------------------------------------------------------
    # Actualización secuencial
    # ------------------------------------------------------------------
    def update(self, match: sqlite3.Row) -> None:
        kickoff = _parse(match["date_utc"])
        league = match["league_id"]
        season = match["season"]
        home = match["home_team_id"]
        away = match["away_team_id"]
        home_goals = match["home_goals"]
        away_goals = match["away_goals"]
        if home_goals is None or away_goals is None:
            return
        match_stats = self.stats.get(match["id"], {})
        match_lineups = self.lineups.get(match["id"], {})

        # Elo pre-match, antes de actualizar.
        home_elo = self.elo.get((league, home), ELO_INITIAL)
        away_elo = self.elo.get((league, away), ELO_INITIAL)
        expected_home = 1 / (1 + 10 ** (-((home_elo + ELO_HOME_ADVANTAGE) - away_elo) / 400))
        if home_goals > away_goals:
            score_home = 1.0
        elif home_goals < away_goals:
            score_home = 0.0
        else:
            score_home = 0.5
        goal_diff = abs(home_goals - away_goals)
        multiplier = 1.0 if goal_diff <= 1 else 1.5 if goal_diff == 2 else 1.75 if goal_diff == 3 else 2.0
        delta = ELO_K * multiplier * (score_home - expected_home)
        home_elo_post = home_elo + delta
        away_elo_post = away_elo - delta
        self.elo[(league, home)] = home_elo_post
        self.elo[(league, away)] = away_elo_post
        self.elo_available[(league, home)] = True
        self.elo_available[(league, away)] = True
        with self.conn:
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO elo_ratings (team_id, date, match_id, elo_pre, elo_post)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (home, _iso(kickoff), match["id"], round(home_elo, 4), round(home_elo_post, 4)),
                    (away, _iso(kickoff), match["id"], round(away_elo, 4), round(away_elo_post, 4)),
                ],
            )

        for team, is_home, goals_for, goals_against, elo_post in (
            (home, True, home_goals, away_goals, home_elo_post),
            (away, False, away_goals, home_goals, away_elo_post),
        ):
            stats = match_stats.get(team)
            lineup = match_lineups.get(team, {"xi": set(), "formation": None})
            history_row = {
                "match_id": match["id"],
                "date": kickoff,
                "league_id": league,
                "season": season,
                "is_home": is_home,
                "goals_for": goals_for,
                "goals_against": goals_against,
                "xg_for": float(stats["xg"]) if stats and stats["xg"] is not None else None,
                "xg_against": float(stats["xga"]) if stats and stats["xga"] is not None else None,
                "shots_for": int(stats["shots"]) if stats and stats["shots"] is not None else None,
                "shots_against": (
                    int(match_stats[away if team == home else home]["shots"])
                    if match_stats.get(away if team == home else home) is not None
                    and match_stats[away if team == home else home]["shots"] is not None
                    else None
                ),
                "sot_for": (
                    int(stats["shots_on_target"])
                    if stats and stats["shots_on_target"] is not None
                    else None
                ),
                "sot_against": (
                    int(match_stats[away if team == home else home]["shots_on_target"])
                    if match_stats.get(away if team == home else home) is not None
                    and match_stats[away if team == home else home]["shots_on_target"] is not None
                    else None
                ),
                "ppda": float(stats["ppda"]) if stats and stats["ppda"] is not None else None,
                "opponent": away if team == home else home,
                "venue_id": match["venue_id"],
            }
            self.team_history.setdefault(team, []).append(history_row)
            self.last_match_date[team] = kickoff
            if lineup["xi"]:
                self.lineup_history.setdefault(team, []).append({
                    "date": kickoff,
                    "season": season,
                    "xi": set(lineup["xi"]),
                    "formation": lineup["formation"],
                })
                self.season_players.setdefault((team, season), set()).update(lineup["xi"])

            # Tabla de posiciones.
            table = self.standings.setdefault((league, season), {}).setdefault(
                team, {"played": 0, "pts": 0, "gf": 0, "ga": 0}
            )
            table["played"] += 1
            table["gf"] += goals_for
            table["ga"] += goals_against
            table["pts"] += 3 if goals_for > goals_against else 1 if goals_for == goals_against else 0

            # Split local/visitante de la temporada.
            split = self.season_splits.setdefault(
                (league, season, team, is_home),
                {"played": 0, "pts": 0, "gf": 0, "ga": 0, "last": None},
            )
            split["played"] += 1
            split["gf"] += goals_for
            split["ga"] += goals_against
            split["pts"] += 3 if goals_for > goals_against else 1 if goals_for == goals_against else 0
            split["last"] = kickoff

        # Totales de liga y xG.
        self.league_goals_total[league] = self.league_goals_total.get(league, 0) + home_goals + away_goals
        self.league_matches_total[league] = self.league_matches_total.get(league, 0) + 1
        self.last_league_date[league] = kickoff
        for team in (home, away):
            stats = match_stats.get(team)
            if stats and stats["xg"] is not None:
                self.league_xg_total[league] = self.league_xg_total.get(league, 0.0) + float(stats["xg"])
                self.league_xg_samples[league] = self.league_xg_samples.get(league, 0) + 1
                self.last_league_xg_date[league] = kickoff

        self.league_season_played[(league, season)] = self.league_season_played.get((league, season), 0) + 1
        self.last_league_season_date[(league, season)] = kickoff

        # Árbitro: tarjetas totales del partido.
        referee = match["referee"]
        if referee:
            cards = 0
            available = False
            for team in (home, away):
                stats = match_stats.get(team)
                if stats:
                    yellow = stats["yellow_cards"]
                    red = stats["red_cards"]
                    if yellow is not None or red is not None:
                        cards += int(yellow or 0) + int(red or 0)
                        available = True
            if available:
                self.referee_history.setdefault(referee, []).append(float(cards))

    # ------------------------------------------------------------------
    # Persistencia
    # ------------------------------------------------------------------
    def store(self, match: sqlite3.Row, features: dict) -> None:
        quality_counts = {"observed": 0, "estimated": 0, "placeholder": 0, "missing": 0}
        non_null = 0
        usable = 0
        for entry in features.values():
            quality_counts[entry["quality"]] = quality_counts.get(entry["quality"], 0) + 1
            if entry["value"] is not None:
                non_null += 1
                if entry["usable_for_model"]:
                    usable += 1
        for quality, count in quality_counts.items():
            self.quality_counts[quality] = self.quality_counts.get(quality, 0) + count
        coverage_summary = {
            "total_features": len(features),
            "non_null": non_null,
            "model_usable": usable,
        }
        self.feature_rows.append((
            match["id"],
            self.version,
            match["date_utc"],
            match["league_id"],
            match["season"],
            match["home_team_id"],
            match["away_team_id"],
            json.dumps(features, ensure_ascii=False, separators=(",", ":")),
            json.dumps(quality_counts, ensure_ascii=False, separators=(",", ":")),
            json.dumps(coverage_summary, ensure_ascii=False, separators=(",", ":")),
            self.built_at,
        ))

    def flush(self) -> None:
        with self.conn:
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO match_features
                    (match_id, dataset_version, kickoff_utc, league_id, season,
                     home_team_id, away_team_id, features_json, quality_summary,
                     coverage_summary, built_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                self.feature_rows,
            )
        self.feature_rows = []

    def build(self) -> dict:
        repair = repair_venues(self.conn)
        self.seed_rivalries()
        self.load()
        core_feature_count = sum(
            1 for name in FEATURE_CATALOG
            if catalog_entry(name)["group"] in CORE_FEATURE_GROUPS
            and catalog_entry(name)["model_usable"]
        )
        with self.conn:
            self.conn.execute(
                """
                INSERT OR REPLACE INTO feature_datasets
                    (version, built_at, match_count, feature_count, core_feature_count, source, notes, checksum)
                VALUES (?, ?, 0, ?, ?, ?, ?, NULL)
                """,
                (
                    self.version,
                    self.built_at,
                    len(FEATURE_CATALOG),
                    core_feature_count,
                    "Football-Data.co.uk + Understat + ESPN + Open-Meteo + venues",
                    "Feature store pre-partido; una fila por partido; quality/source/as_of por feature.",
                ),
            )

        # Los partidos con el mismo kickoff se calculan con el mismo estado.
        # Si se actualizara el estado tras el primero, el segundo vería como
        # "anterior" un partido que en realidad arrancó a la misma hora.
        processed = 0
        for _kickoff, grouped in groupby(self.matches, key=lambda item: item["date_utc"]):
            batch = list(grouped)
            computed = [(match, self.compute(match)) for match in batch]
            for match, features in computed:
                self.store(match, features)
            for match, _features in computed:
                self.update(match)
            processed += len(batch)
            if len(self.feature_rows) >= 200:
                self.flush()
            if processed % 500 < len(batch):
                print(f"  features: {processed:,}/{len(self.matches):,} partidos")
        self.flush()

        total = len(self.matches)
        coverage_rows = []
        for feature, metadata in FEATURE_CATALOG.items():
            stats = self.coverage.get(feature, {
                "non_null": 0, "model_usable": 0, "observed": 0,
                "estimated": 0, "placeholder": 0, "missing": total,
                "as_of_min": None, "as_of_max": None,
            })
            coverage_pct = round(stats["non_null"] * 100.0 / total, 2) if total else 0.0
            usable_pct = round(stats["model_usable"] * 100.0 / total, 2) if total else 0.0
            coverage_rows.append((
                self.version,
                feature,
                stats["non_null"],
                total,
                coverage_pct,
                stats["model_usable"],
                usable_pct,
                stats["observed"],
                stats["estimated"],
                stats["missing"],
                stats["as_of_min"],
                stats["as_of_max"],
            ))

        with self.conn:
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO feature_coverage
                    (dataset_version, feature, non_null, total, coverage_pct,
                     model_usable, model_usable_pct, quality_observed,
                     quality_estimated, quality_missing, as_of_min, as_of_max)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                coverage_rows,
            )

        self._write_exports(coverage_rows, total)
        checksum = hashlib.sha256(self.csv_path.read_bytes()).hexdigest() if self.csv_path.exists() else None
        with self.conn:
            self.conn.execute(
                "UPDATE feature_datasets SET match_count = ?, checksum = ? WHERE version = ?",
                (total, checksum, self.version),
            )

        return {
            "version": self.version,
            "built_at": self.built_at,
            "matches": total,
            "features": len(FEATURE_CATALOG),
            "repair": repair,
            "coverage": coverage_rows,
            "checksum": checksum,
        }

    def _write_exports(self, coverage_rows: list[tuple], total: int) -> None:
        FEATURE_STORE_DIR.mkdir(parents=True, exist_ok=True)
        feature_names = list(FEATURE_CATALOG.keys())

        # CSV plano: valores; vacío = null. El JSONL conserva quality/source/as_of.
        with open(self.csv_path, "w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow([
                "match_id", "kickoff_utc", "league_id", "season",
                "home_team_id", "away_team_id", *feature_names,
            ])
            for row in self.conn.execute(
                "SELECT * FROM match_features WHERE dataset_version = ? ORDER BY kickoff_utc, match_id",
                (self.version,),
            ):
                features = json.loads(row["features_json"])
                writer.writerow([
                    row["match_id"], row["kickoff_utc"], row["league_id"], row["season"],
                    row["home_team_id"], row["away_team_id"],
                    *[
                        features.get(name, {}).get("value")
                        if features.get(name, {}).get("value") is not None else ""
                        for name in feature_names
                    ],
                ])

        with gzip.open(self.jsonl_path, "wt", encoding="utf-8") as handle:
            for row in self.conn.execute(
                "SELECT * FROM match_features WHERE dataset_version = ? ORDER BY kickoff_utc, match_id",
                (self.version,),
            ):
                handle.write(json.dumps({
                    "match_id": row["match_id"],
                    "dataset_version": row["dataset_version"],
                    "kickoff_utc": row["kickoff_utc"],
                    "league_id": row["league_id"],
                    "season": row["season"],
                    "home_team_id": row["home_team_id"],
                    "away_team_id": row["away_team_id"],
                    "features": json.loads(row["features_json"]),
                }, ensure_ascii=False, separators=(",", ":")) + "\n")

        coverage_payload = self._coverage_payload(coverage_rows, total)
        COVERAGE_PATH.write_text(json.dumps(coverage_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        META_PATH.write_text(json.dumps({
            "version": self.version,
            "built_at": self.built_at,
            "matches": total,
            "features": len(FEATURE_CATALOG),
            "core_groups": CORE_FEATURE_GROUPS,
            "optional_groups": OPTIONAL_FEATURE_GROUPS,
            "quality_counts": self.quality_counts,
            "coverage_status": coverage_payload["status"],
            "files": {
                "csv": str(self.csv_path.relative_to(DATA_DIR)).replace("\\", "/"),
                "jsonl_gz": str(self.jsonl_path.relative_to(DATA_DIR)).replace("\\", "/"),
                "coverage": str(COVERAGE_PATH.relative_to(DATA_DIR)).replace("\\", "/"),
            },
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        self._write_dictionary(coverage_payload)
        self._write_web_features()

    def _coverage_payload(self, coverage_rows: list[tuple], total: int) -> dict:
        by_feature = {
            row[1]: {
                "non_null": row[2],
                "total": row[3],
                "coverage_pct": row[4],
                "model_usable_count": row[5],
                "model_usable_pct": row[6],
                "quality_observed": row[7],
                "quality_estimated": row[8],
                "quality_missing": row[9],
                "as_of_min": row[10],
                "as_of_max": row[11],
                **{key: value for key, value in catalog_entry(row[1]).items() if key in {"label", "group", "source"}},
                "catalog_model_usable": catalog_entry(row[1])["model_usable"],
            }
            for row in coverage_rows
        }
        groups = {}
        for group, description in CORE_FEATURE_GROUPS.items():
            members = [
                name for name in FEATURE_CATALOG
                if catalog_entry(name)["group"] == group and catalog_entry(name)["model_usable"]
            ]
            if not members:
                continue
            min_coverage = min(by_feature[name]["coverage_pct"] for name in members)
            min_usable = min(by_feature[name]["model_usable_pct"] for name in members)
            groups[group] = {
                "description": description,
                "features": members,
                "min_coverage_pct": min_coverage,
                "min_model_usable_pct": min_usable,
                "pass": min_coverage >= 80.0,
            }
        optional = {}
        for group, description in OPTIONAL_FEATURE_GROUPS.items():
            members = [name for name in FEATURE_CATALOG if catalog_entry(name)["group"] == group]
            if not members:
                continue
            optional[group] = {
                "description": description,
                "features": members,
                "min_coverage_pct": min(by_feature[name]["coverage_pct"] for name in members),
                "min_model_usable_pct": min(by_feature[name]["model_usable_pct"] for name in members),
            }
        status = "PASS" if all(group["pass"] for group in groups.values()) else "FAIL"
        return {
            "version": self.version,
            "generated_at": self.built_at,
            "matches": total,
            "features": len(FEATURE_CATALOG),
            "status": status,
            "target_coverage_pct": 80.0,
            "core_groups": groups,
            "optional_groups": optional,
            "by_feature": by_feature,
            "quality_counts": self.quality_counts,
        }

    def _write_dictionary(self, coverage_payload: dict) -> None:
        lines = [
            "# Diccionario de Features — MOTOR-NOX V1.0",
            "",
            f"**Versión del dataset:** `{self.version}`  ",
            f"**Generado:** {self.built_at}  ",
            f"**Partidos:** {coverage_payload['matches']:,}  ",
            f"**Features:** {coverage_payload['features']}  ",
            f"**Estado de cobertura:** **{coverage_payload['status']}** (objetivo ≥80% por grupo core)  ",
            "",
            "Cada feature del store lleva `value`, `quality`, `source`, `as_of` y `usable_for_model`.",
            "`quality` puede ser `observed`, `estimated`, `placeholder` o `missing`. Un `value: null`",
            "siempre es `missing`; no se sustituye por un neutro silencioso.",
            "",
            "## Calidad del store",
            "",
            f"- `observed`: {coverage_payload['quality_counts'].get('observed', 0):,} entradas.",
            f"- `estimated`: {coverage_payload['quality_counts'].get('estimated', 0):,} entradas.",
            f"- `placeholder`: {coverage_payload['quality_counts'].get('placeholder', 0):,} entradas.",
            f"- `missing`: {coverage_payload['quality_counts'].get('missing', 0):,} entradas.",
            "",
            "xG/xGA, Elo, medias de liga y splits/diffs de xG se marcan `estimated` aunque sean usables:",
            "son métricas calculadas, no conteos publicados. `observed` se reserva para resultados y",
            "estadísticas factuales.",
            "",
            "## Cobertura por grupo core",
            "",
            "| Grupo | Features | Cobertura mínima | Cobertura usable mínima | Estado |",
            "|---|---:|---:|---:|---|",
        ]
        for group, payload in coverage_payload["core_groups"].items():
            lines.append(
                f"| `{group}` | {len(payload['features'])} | {payload['min_coverage_pct']:.1f}% | "
                f"{payload['min_model_usable_pct']:.1f}% | {'PASS' if payload['pass'] else 'FAIL'} |"
            )
        lines.extend([
            "",
            "## Grupos opcionales / no usables",
            "",
            "| Grupo | Features | Cobertura mínima | Cobertura usable mínima | Nota |",
            "|---|---:|---:|---:|---|",
        ])
        for group, payload in coverage_payload["optional_groups"].items():
            lines.append(
                f"| `{group}` | {len(payload['features'])} | {payload['min_coverage_pct']:.1f}% | "
                f"{payload['min_model_usable_pct']:.1f}% | {OPTIONAL_FEATURE_GROUPS.get(group, '')} |"
            )
        lines.extend([
            "",
            "## Catálogo completo",
            "",
            "| Feature | Grupo | Definición | Fuente | Calidad típica | Cobertura | Cobertura usable |",
            "|---|---|---|---|---|---:|---:|",
        ])
        for name, metadata in FEATURE_CATALOG.items():
            coverage = coverage_payload["by_feature"].get(name, {})
            lines.append(
                f"| `{name}` | `{metadata['group']}` | {metadata['definition']} | {metadata['source']} | "
                f"`{metadata['quality']}` | {coverage.get('coverage_pct', 0):.1f}% | "
                f"{coverage.get('model_usable_pct', 0):.1f}% |"
            )
        lines.extend([
            "",
            "## Reglas de `as_of`",
            "",
            "- Features rolling, Elo, descanso, tabla y alineaciones: `as_of` es la fecha del último partido anterior usado.",
            "- Contexto estático (sede, altitud, rivalidad, árbitro): `as_of` es la fecha del kickoff a las 00:00 UTC.",
            "- Mercado: `as_of = null` y `usable_for_model = false` porque no se publica la hora exacta del cierre.",
            "- Clima: `quality = estimated` y `usable_for_model = false` porque es reanálisis retrospectivo, no pronóstico.",
            "- Cualquier feature usable con `value` no nulo debe cumplir `as_of < kickoff_utc`; lo verifica `pipeline.audit_features`.",
            "",
        ])
        DICTIONARY_PATH.write_text("\n".join(lines), encoding="utf-8")

    def _write_web_features(self) -> None:
        latest: dict[str, dict] = {}
        for row in self.conn.execute(
            "SELECT * FROM match_features WHERE dataset_version = ? ORDER BY kickoff_utc, match_id",
            (self.version,),
        ):
            features = json.loads(row["features_json"])
            for side, team in (("home", row["home_team_id"]), ("away", row["away_team_id"])):
                team_features = {}
                for name, entry in features.items():
                    if name.startswith(f"{side}_"):
                        team_features[name[len(side) + 1:]] = entry
                    elif not name.startswith(("home_", "away_")):
                        team_features[f"match_{name}"] = entry
                latest[team] = {
                    "team_id": team,
                    "league_id": row["league_id"],
                    "season": row["season"],
                    "last_match_id": row["match_id"],
                    "last_match_date": row["kickoff_utc"],
                    "features": team_features,
                }
        elo_post = {
            row["team_id"]: row["elo_post"]
            for row in self.conn.execute(
                """
                SELECT e.team_id, e.elo_post
                FROM elo_ratings e
                JOIN (
                    SELECT team_id, max(date) AS max_date FROM elo_ratings GROUP BY team_id
                ) latest ON latest.team_id = e.team_id AND latest.max_date = e.date
                """
            )
        }
        for team, payload in latest.items():
            if team in elo_post:
                payload["elo_post"] = round(float(elo_post[team]), 4)
        WEB_PATH.write_text(json.dumps({
            "version": self.version,
            "generated_at": self.built_at,
            "note": "Última foto pre-partido por equipo. Para partidos de una temporada posterior, comprobar last_match_date antes de usarla.",
            "by_team": latest,
        }, ensure_ascii=False, indent=2), encoding="utf-8")


def build_features(version: str = DATASET_VERSION) -> dict:
    init_db()
    conn = get_connection()
    try:
        builder = FeatureBuilder(conn, version=version)
        return builder.build()
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Construye el feature store pre-partido")
    parser.add_argument("--version", default=DATASET_VERSION, help="Versión del dataset")
    args = parser.parse_args()
    result = build_features(args.version)
    print("=" * 80)
    print(f"Feature store {result['version']} generado: {result['matches']:,} partidos, {result['features']} features")
    print(f"Checksum CSV: {result['checksum']}")
    csv_path = FEATURE_STORE_DIR / f"feature_store_{result['version']}.csv"
    jsonl_path = FEATURE_STORE_DIR / f"feature_store_{result['version']}.jsonl.gz"
    print(f"Archivos: {csv_path}, {jsonl_path}, {COVERAGE_PATH}, {DICTIONARY_PATH}")
    print("=" * 80)


if __name__ == "__main__":
    main()
