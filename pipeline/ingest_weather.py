"""
Open-Meteo daily weather ingestion for MOTOR-NOX V1.0.

The historical archive is a reanalysis product: it describes the weather that
occurred, not the forecast available before kickoff. The feature store therefore
marks it as estimated and not usable as a model feature. It remains useful as
descriptive context and as a bridge for a future pre-match forecast ingestion.

Usage:
    python -m pipeline.ingest_weather
    python -m pipeline.ingest_weather --force
    python -m pipeline.ingest_weather --start 2020-08-01 --end 2026-06-30
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .db import DATA_DIR, get_connection, init_db

RAW_WEATHER_DIR = DATA_DIR / "raw" / "open_meteo"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
USER_AGENT = "MOTOR-NOX/1.0 (feature pipeline; Open-Meteo open data)"
DAILY_FIELDS = [
    "temperature_2m_mean",
    "precipitation_sum",
    "wind_speed_10m_max",
    "weather_code",
]

# WMO weather interpretation codes used by Open-Meteo.
WMO_CONDITIONS = {
    0: "Despejado",
    1: "Mayormente despejado",
    2: "Parcialmente nublado",
    3: "Nublado",
    45: "Niebla",
    48: "Niebla con escarcha",
    51: "Llovizna ligera",
    53: "Llovizna moderada",
    55: "Llovizna densa",
    56: "Llovizna helada ligera",
    57: "Llovizna helada densa",
    61: "Lluvia ligera",
    63: "Lluvia moderada",
    65: "Lluvia fuerte",
    66: "Lluvia helada ligera",
    67: "Lluvia helada fuerte",
    71: "Nieve ligera",
    73: "Nieve moderada",
    75: "Nieve fuerte",
    77: "Granos de nieve",
    80: "Chubascos ligeros",
    81: "Chubascos moderados",
    82: "Chubascos fuertes",
    85: "Chubascos de nieve ligeros",
    86: "Chubascos de nieve fuertes",
    95: "Tormenta",
    96: "Tormenta con granizo ligero",
    99: "Tormenta con granizo fuerte",
}


def condition_from_code(code) -> str | None:
    """Translate a WMO code into a stable Spanish label."""
    if code is None:
        return None
    try:
        return WMO_CONDITIONS.get(int(code), f"Código WMO {int(code)}")
    except (TypeError, ValueError):
        return None


def _download_json(url: str, timeout: int = 60, retries: int = 4) -> dict:
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("error"):
                raise RuntimeError(payload.get("reason") or "Open-Meteo error")
            return payload
        except Exception as error:  # noqa: BLE001 - network retries are intentional
            last_error = error
            if attempt < retries:
                time.sleep(min(20, 2 ** attempt))
    raise RuntimeError(f"No se pudo descargar Open-Meteo: {last_error}")


def fetch_venue_weather(
    venue_id: str,
    latitude: float,
    longitude: float,
    start_date: str,
    end_date: str,
    force: bool = False,
) -> list[dict]:
    """Fetch (and cache) daily weather for one venue."""
    RAW_WEATHER_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = RAW_WEATHER_DIR / f"{venue_id}_{start_date}_{end_date}.json"
    if cache_path.exists() and not force:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        query = urlencode(
            {
                "latitude": latitude,
                "longitude": longitude,
                "start_date": start_date,
                "end_date": end_date,
                "daily": ",".join(DAILY_FIELDS),
                "timezone": "UTC",
            }
        )
        payload = _download_json(f"{ARCHIVE_URL}?{query}")
        cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    daily = payload.get("daily") or {}
    dates = daily.get("time") or []
    rows = []
    for index, day in enumerate(dates):
        def value(field):
            values = daily.get(field) or []
            return values[index] if index < len(values) else None

        code = value("weather_code")
        rows.append(
            {
                "venue_id": venue_id,
                "date": day,
                "temp_c": value("temperature_2m_mean"),
                "precip_mm": value("precipitation_sum"),
                "wind_kmh": value("wind_speed_10m_max"),
                "weather_code": code,
                "condition": condition_from_code(code),
            }
        )
    return rows


def ingest_weather(
    conn: sqlite3.Connection,
    start_date: str | None = None,
    end_date: str | None = None,
    force: bool = False,
) -> dict:
    """Ingest daily weather for every geolocated venue used by the matches."""
    init_db()
    bounds = conn.execute(
        "SELECT min(substr(date_utc, 1, 10)) AS start, max(substr(date_utc, 1, 10)) AS end FROM matches"
    ).fetchone()
    start_date = start_date or bounds["start"] or "2020-08-01"
    end_date = end_date or bounds["end"] or "2026-06-30"
    # The archive has a short publication delay. Never request the future.
    archive_limit = (datetime.now(timezone.utc).date() - timedelta(days=6)).isoformat()
    if end_date > archive_limit:
        end_date = archive_limit

    venues = conn.execute(
        """
        SELECT id, name, latitude, longitude
        FROM venues
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY id
        """
    ).fetchall()

    started_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    inserted = 0
    errors = []
    for index, venue in enumerate(venues, start=1):
        try:
            rows = fetch_venue_weather(
                venue["id"],
                float(venue["latitude"]),
                float(venue["longitude"]),
                start_date,
                end_date,
                force=force,
            )
            with conn:
                conn.executemany(
                    """
                    INSERT OR REPLACE INTO venue_weather_daily
                        (venue_id, date, temp_c, precip_mm, wind_kmh, weather_code, condition, source, fetched_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'open_meteo', datetime('now'))
                    """,
                    [
                        (
                            row["venue_id"],
                            row["date"],
                            row["temp_c"],
                            row["precip_mm"],
                            row["wind_kmh"],
                            row["weather_code"],
                            row["condition"],
                        )
                        for row in rows
                    ],
                )
            inserted += len(rows)
            print(f"[{index:02d}/{len(venues)}] {venue['name']}: {len(rows)} días")
        except Exception as error:  # noqa: BLE001 - one venue must not abort the run
            errors.append(f"{venue['id']}: {error}")
            print(f"[{index:02d}/{len(venues)}] {venue['name']}: ERROR {error}")
        time.sleep(1.0)

    status = "success" if not errors else "partial"
    with conn:
        conn.execute(
            """
            INSERT INTO ingestion_runs (source_id, started_at, finished_at, status, rows_inserted, errors)
            VALUES ('open_meteo', ?, datetime('now'), ?, ?, ?)
            """,
            (started_at, status, inserted, "; ".join(errors[:5])),
        )

    summary = {
        "status": status,
        "venues": len(venues),
        "rows_inserted": inserted,
        "start_date": start_date,
        "end_date": end_date,
        "errors": errors,
    }
    print(f"Open-Meteo weather ingestion: {summary}")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingesta de clima diario Open-Meteo")
    parser.add_argument("--start", default=None, help="Fecha inicial YYYY-MM-DD")
    parser.add_argument("--end", default=None, help="Fecha final YYYY-MM-DD")
    parser.add_argument("--force", action="store_true", help="Ignorar la caché local")
    args = parser.parse_args()
    conn = get_connection()
    try:
        ingest_weather(conn, start_date=args.start, end_date=args.end, force=args.force)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
