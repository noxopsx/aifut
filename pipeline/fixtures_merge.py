"""
MOTOR-NOX · fusión de calendarios de todas las fuentes públicas.

La tabla `fixtures` (ESPN) es la base y la única que alimenta el informe de
cobertura de Fase 1. Los proveedores adicionales se añaden con deduplicación y
se marcan con `quality`, `source` y `as_of` (null cuando no hay dato).
"""

from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from .db import DATA_DIR, utc_now

FIXTURES_JSON = DATA_DIR / "fixtures.json"

PROVIDER_TABLES = ("api_fixtures", "free_api_fixtures", "faorg_fixtures")
TIER_A = {"eng.1", "esp.1"}

PROVIDER_SOURCE = {
    "api_football": "API-Football v3 (Free)",
    "football_data_org": "football-data.org (Free)",
    "footballapi_org": "footballapi.org (gratuito)",
    "espn": "ESPN",
}


def norm_text(value: Any) -> str:
    if not value:
        return ""
    text = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]", "", text.lower())


def dedup_key(item: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(item.get("competition_id") or ""),
        str(item.get("kickoff_utc") or "")[:10],
        norm_text(item.get("home_team_name")),
        norm_text(item.get("away_team_name")),
    )


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return bool(
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
        ).fetchone()
    )


def _provider_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _provider_items(
    conn: sqlite3.Connection, table: str, start: date, end: date
) -> list[dict[str, Any]]:
    columns = _provider_columns(conn, table)
    if not {"source_id", "kickoff_utc", "home_team_name", "away_team_name"} <= columns:
        return []
    rows = conn.execute(
        f"""
        SELECT * FROM {table}
        WHERE kickoff_utc >= ? AND kickoff_utc <= ?
        ORDER BY kickoff_utc, competition_id
        """,
        (f"{start.isoformat()}T00:00:00Z", f"{end.isoformat()}T23:59:59Z"),
    ).fetchall()
    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        provider = str(item.get("provider") or "")
        source = str(item.get("source") or provider or "")
        if not source:
            source = "api_football" if table == "api_fixtures" else "unknown"
        item["source"] = source
        item["provider"] = provider or source
        item["quality"] = item.get("quality") or "observed"
        item["as_of"] = item.get("as_of") or item.get("updated_at") or None
        item["tier"] = "A" if item.get("competition_id") in TIER_A else "C"
        item["source_name"] = PROVIDER_SOURCE.get(source, source)
        item["source_url"] = item.get("source_url") or None
        item["stage"] = item.get("stage") or item.get("round") or None
        item["venue"] = item.get("venue") or None
        item["venue_city"] = item.get("venue_city") or None
        items.append(item)
    return items


def write_combined(
    conn: sqlite3.Connection,
    start: date,
    end: date,
    *,
    fixtures_path: Path | None = None,
) -> dict[str, Any]:
    """Escribe fixtures.json combinando ESPN + todos los proveedores configurados."""
    target = fixtures_path or FIXTURES_JSON
    espn_rows = conn.execute(
        """
        SELECT f.id, f.competition_id, c.name AS competition_name, c.tier,
               f.season, f.kickoff_utc, f.home_team_id, f.home_team_name,
               f.away_team_id, f.away_team_name, f.status, f.home_goals,
               f.away_goals, f.venue, f.venue_city, f.stage, f.source,
               f.source_id, f.source_url, f.updated_at
        FROM fixtures f
        JOIN competitions c ON c.id = f.competition_id
        WHERE c.active = 1
          AND f.kickoff_utc >= ? AND f.kickoff_utc <= ?
        ORDER BY f.kickoff_utc, c.name
        """,
        (f"{start.isoformat()}T00:00:00Z", f"{end.isoformat()}T23:59:59Z"),
    ).fetchall()
    items: list[dict[str, Any]] = []
    for row in espn_rows:
        item = dict(row)
        item["source"] = "espn"
        item["quality"] = "observed"
        item["as_of"] = item.get("updated_at") or None
        item["source_name"] = PROVIDER_SOURCE["espn"]
        items.append(item)

    seen = {dedup_key(item) for item in items}
    added: dict[str, int] = {}
    for table in PROVIDER_TABLES:
        if not _table_exists(conn, table):
            continue
        try:
            provider_items = _provider_items(conn, table, start, end)
        except sqlite3.Error:
            continue
        for item in provider_items:
            key = dedup_key(item)
            if key in seen:
                continue
            seen.add(key)
            items.append(item)
            source = str(item.get("source") or "unknown")
            added[source] = added.get(source, 0) + 1

    items.sort(
        key=lambda row: (
            str(row.get("kickoff_utc") or ""),
            str(row.get("competition_name") or ""),
        )
    )
    sources: dict[str, int] = {}
    for item in items:
        source = str(item.get("source") or "unknown")
        sources[source] = sources.get(source, 0) + 1

    payload = {
        "schema": "motor-nox.fixtures.v1",
        "generatedAt": utc_now(),
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "count": len(items),
        "sources": sources,
        "items": items,
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return {"count": len(items), "added": added, "sources": sources}


def operational_window(days: int = 21) -> tuple[date, date]:
    """Ventana operativa: ayer .. hoy+N días (coherente con ingest_fixtures)."""
    today = datetime.utcnow().date()
    return today - timedelta(days=1), today + timedelta(days=max(1, days))
