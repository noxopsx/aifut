"""
MOTOR-NOX V1.0 Database Management and Schema Definitions.
SQLite storage with WAL mode, normalized tables, and lineage tracking.
"""

from pathlib import Path
import sqlite3
from datetime import datetime, timezone

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "database.sqlite"
MIGRATIONS_DIR = BASE_DIR / "migrations"

SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS leagues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    season TEXT NOT NULL,
    tier INTEGER DEFAULT 1,
    avg_goals REAL,
    home_factor REAL,
    away_factor REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT,
    country TEXT,
    latitude REAL,
    longitude REAL,
    altitude REAL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    abbr TEXT,
    logo_url TEXT,
    venue_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(league_id) REFERENCES leagues(id),
    FOREIGN KEY(venue_id) REFERENCES venues(id)
);

CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL,
    season TEXT NOT NULL,
    date_utc TEXT NOT NULL,
    home_team_id TEXT NOT NULL,
    away_team_id TEXT NOT NULL,
    status TEXT NOT NULL, -- 'completed', 'scheduled', 'live'
    home_goals INTEGER,
    away_goals INTEGER,
    ht_home_goals INTEGER,
    ht_away_goals INTEGER,
    venue_id TEXT,
    referee TEXT,
    round INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(league_id) REFERENCES leagues(id),
    FOREIGN KEY(home_team_id) REFERENCES teams(id),
    FOREIGN KEY(away_team_id) REFERENCES teams(id),
    FOREIGN KEY(venue_id) REFERENCES venues(id)
);

CREATE TABLE IF NOT EXISTS team_match_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    is_home INTEGER NOT NULL,
    shots INTEGER,
    shots_on_target INTEGER,
    possession REAL,
    corners INTEGER,
    fouls INTEGER,
    yellow_cards INTEGER,
    red_cards INTEGER,
    passes INTEGER,
    ppda REAL,
    xg REAL,
    xga REAL,
    npxg REAL,
    npxga REAL,
    deep_completions INTEGER,
    source TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(match_id, team_id),
    FOREIGN KEY(match_id) REFERENCES matches(id),
    FOREIGN KEY(team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS lineups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    is_starter INTEGER NOT NULL DEFAULT 1,
    minutes_played INTEGER,
    position TEXT,
    shirt_number INTEGER,
    formation TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(match_id, team_id, player_id),
    FOREIGN KEY(match_id) REFERENCES matches(id),
    FOREIGN KEY(team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    team_id TEXT,
    position TEXT,
    age INTEGER,
    minutes INTEGER DEFAULT 0,
    xg_90 REAL DEFAULT 0,
    rating REAL,
    market_value REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS injuries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    status TEXT NOT NULL,
    description TEXT,
    source TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(id),
    FOREIGN KEY(team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS odds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    market TEXT NOT NULL, -- '1X2', 'OU25', 'BTTS'
    selection TEXT NOT NULL, -- '1', 'X', '2', 'Over', 'Under', 'Yes', 'No'
    price REAL NOT NULL,
    prob_implied REAL NOT NULL,
    prob_devigged REAL NOT NULL,
    bookmaker TEXT NOT NULL,
    timestamp TEXT,
    is_closing INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(match_id, market, selection, bookmaker, is_closing),
    FOREIGN KEY(match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS elo_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL,
    date TEXT NOT NULL,
    match_id TEXT,
    elo_pre REAL NOT NULL,
    elo_post REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(team_id, date, match_id),
    FOREIGN KEY(team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS feature_datasets (
    version TEXT PRIMARY KEY,
    built_at TEXT NOT NULL,
    match_count INTEGER NOT NULL,
    feature_count INTEGER NOT NULL,
    core_feature_count INTEGER NOT NULL,
    source TEXT NOT NULL,
    notes TEXT,
    checksum TEXT
);

-- Feature store: una fila por partido y versión de dataset. Cada feature vive
-- dentro de features_json con value, quality, source, as_of y usable_for_model.
CREATE TABLE IF NOT EXISTS match_features (
    match_id TEXT NOT NULL,
    dataset_version TEXT NOT NULL,
    kickoff_utc TEXT NOT NULL,
    league_id TEXT NOT NULL,
    season TEXT NOT NULL,
    home_team_id TEXT NOT NULL,
    away_team_id TEXT NOT NULL,
    features_json TEXT NOT NULL,
    quality_summary TEXT NOT NULL,
    coverage_summary TEXT NOT NULL,
    built_at TEXT NOT NULL,
    PRIMARY KEY (match_id, dataset_version),
    FOREIGN KEY(match_id) REFERENCES matches(id),
    FOREIGN KEY(dataset_version) REFERENCES feature_datasets(version)
);

CREATE TABLE IF NOT EXISTS feature_coverage (
    dataset_version TEXT NOT NULL,
    feature TEXT NOT NULL,
    non_null INTEGER NOT NULL,
    total INTEGER NOT NULL,
    coverage_pct REAL NOT NULL,
    model_usable INTEGER NOT NULL,
    model_usable_pct REAL NOT NULL,
    quality_observed INTEGER NOT NULL,
    quality_estimated INTEGER NOT NULL,
    quality_missing INTEGER NOT NULL,
    as_of_min TEXT,
    as_of_max TEXT,
    PRIMARY KEY (dataset_version, feature),
    FOREIGN KEY(dataset_version) REFERENCES feature_datasets(version)
);

CREATE TABLE IF NOT EXISTS rivalries (
    team_a_id TEXT NOT NULL,
    team_b_id TEXT NOT NULL,
    name TEXT NOT NULL,
    intensity REAL NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (team_a_id, team_b_id),
    FOREIGN KEY(team_a_id) REFERENCES teams(id),
    FOREIGN KEY(team_b_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS venue_weather_daily (
    venue_id TEXT NOT NULL,
    date TEXT NOT NULL,
    temp_c REAL,
    precip_mm REAL,
    wind_kmh REAL,
    weather_code INTEGER,
    condition TEXT,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (venue_id, date),
    FOREIGN KEY(venue_id) REFERENCES venues(id)
);

CREATE TABLE IF NOT EXISTS data_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    license TEXT NOT NULL,
    frequency TEXT NOT NULL,
    notes TEXT,
    last_downloaded TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL, -- 'success', 'partial', 'failed'
    rows_inserted INTEGER DEFAULT 0,
    errors TEXT,
    FOREIGN KEY(source_id) REFERENCES data_sources(id)
);

CREATE TABLE IF NOT EXISTS model_runs (
    id TEXT PRIMARY KEY,
    model_name TEXT NOT NULL,
    version TEXT NOT NULL,
    features TEXT NOT NULL,
    train_start TEXT NOT NULL,
    train_end TEXT NOT NULL,
    test_start TEXT NOT NULL,
    test_end TEXT NOT NULL,
    sample_train INTEGER NOT NULL,
    sample_test INTEGER NOT NULL,
    metrics TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for lightning queries
CREATE INDEX IF NOT EXISTS idx_matches_league_season ON matches(league_id, season);
CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date_utc);
CREATE INDEX IF NOT EXISTS idx_matches_teams ON matches(home_team_id, away_team_id);
CREATE INDEX IF NOT EXISTS idx_stats_match ON team_match_stats(match_id);
CREATE INDEX IF NOT EXISTS idx_odds_match ON odds(match_id, market);
CREATE INDEX IF NOT EXISTS idx_elo_team_date ON elo_ratings(team_id, date);
CREATE INDEX IF NOT EXISTS idx_match_features_version ON match_features(dataset_version, kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_match_features_league ON match_features(league_id, season);
CREATE INDEX IF NOT EXISTS idx_weather_date ON venue_weather_daily(date);
"""


def get_connection(db_path: Path = DB_PATH) -> sqlite3.Connection:
    """Return an SQLite connection configured with WAL mode and row factory."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    """Add a column to an existing table when the database predates it."""
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def utc_now() -> str:
    """Timestamp UTC en ISO 8601, sin microsegundos y con sufijo Z."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def configure_stdio() -> None:
    """Force UTF-8 console output on Windows so ≥, · and accents do not crash."""
    import sys

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def apply_migrations(conn: sqlite3.Connection) -> list[str]:
    """Apply pending SQL migrations in migrations/ and return their versions."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        )
        """
    )
    applied: list[str] = []
    if not MIGRATIONS_DIR.exists():
        return applied
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        version = path.stem
        if conn.execute("SELECT 1 FROM schema_migrations WHERE version = ?", (version,)).fetchone():
            continue
        conn.executescript(path.read_text(encoding="utf-8"))
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
            (version, utc_now()),
        )
        applied.append(version)
    return applied


def init_db(db_path: Path = DB_PATH) -> None:
    """Initialize database tables, apply migrations and seed metadata."""
    conn = get_connection(db_path)
    with conn:
        conn.executescript(SCHEMA_SQL)
        # Section 2 lineage: distinguish the base match stats source from the
        # provider that supplied xG/xGA and PPDA.
        ensure_column(conn, "team_match_stats", "xg_source", "TEXT")
        ensure_column(conn, "team_match_stats", "ppda_source", "TEXT")
        apply_migrations(conn)
        # Register standard data sources
        sources = [
            (
                "football_data",
                "Football-Data.co.uk",
                "https://www.football-data.co.uk",
                "Open access for research/personal use",
                "Weekly updates / Historic archives",
                "100% real match scores, full match stats (shots, on target, fouls, corners, cards), and closing market odds (B365, Pinnacle).",
            ),
            (
                "understat",
                "Understat",
                "https://understat.com",
                "Publicly available football analytics",
                "Match-day / Season archive",
                "Shot-level xG model, xGA, deep completions, PPDA.",
            ),
            (
                "espn",
                "ESPN Live API",
                "https://site.api.espn.com/apis/site/v2/sports/soccer",
                "Public ESPN scoreboard / summary",
                "Live match days",
                "Upcoming fixtures, live standings, form, venue info, player lineups.",
            ),
            (
                "open_meteo",
                "Open-Meteo",
                "https://open-meteo.com",
                "Non-commercial Open Data / CC BY 4.0",
                "On-demand historical and fixture forecast",
                "Venue temperature, weather conditions, wind, precipitation, and altitude.",
            ),
        ]
        conn.executemany(
            """
            INSERT OR REPLACE INTO data_sources (id, name, url, license, frequency, notes, last_downloaded)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            sources,
        )
    conn.close()


def normalize_team_name(name: str) -> str:
    """Map variants of team names across sources to a canonical normalized identifier."""
    if not name:
        return ""
    clean = name.strip()
    # Canonical dictionary mapping aliases to canonical slug
    aliases = {
        # Premier League
        "Arsenal": "arsenal",
        "Aston Villa": "aston_villa",
        "Bournemouth": "bournemouth",
        "AFC Bournemouth": "bournemouth",
        "Brentford": "brentford",
        "Brighton": "brighton",
        "Brighton and Hove Albion": "brighton",
        "Brighton & Hove Albion": "brighton",
        "Burnley": "burnley",
        "Chelsea": "chelsea",
        "Coventry": "coventry_city",
        "Coventry City": "coventry_city",
        "Crystal Palace": "crystal_palace",
        "Everton": "everton",
        "Fulham": "fulham",
        "Hull": "hull_city",
        "Hull City": "hull_city",
        "Ipswich": "ipswich",
        "Ipswich Town": "ipswich",
        "Leeds": "leeds",
        "Leeds United": "leeds",
        "Leicester": "leicester",
        "Leicester City": "leicester",
        "Liverpool": "liverpool",
        "Luton": "luton",
        "Luton Town": "luton",
        "Man City": "manchester_city",
        "Manchester City": "manchester_city",
        "Man United": "manchester_united",
        "Manchester United": "manchester_united",
        "Manchester Utd": "manchester_united",
        "Newcastle": "newcastle",
        "Newcastle United": "newcastle",
        "Norwich": "norwich",
        "Norwich City": "norwich",
        "Nott'm Forest": "nottingham_forest",
        "Nottingham Forest": "nottingham_forest",
        "Sheffield United": "sheffield_united",
        "Sheffield Utd": "sheffield_united",
        "Southampton": "southampton",
        "Tottenham": "tottenham",
        "Tottenham Hotspur": "tottenham",
        "Watford": "watford",
        "West Brom": "west_brom",
        "West Bromwich Albion": "west_brom",
        "West Ham": "west_ham",
        "West Ham United": "west_ham",
        "Wolves": "wolverhampton",
        "Wolverhampton Wanderers": "wolverhampton",

        # LaLiga
        "Alaves": "alaves",
        "Alavés": "alaves",
        "Deportivo Alavés": "alaves",
        "Almeria": "almeria",
        "Almería": "almeria",
        "Ath Bilbao": "athletic_club",
        "Athletic Club": "athletic_club",
        "Athletic Bilbao": "athletic_club",
        "Ath Madrid": "atletico_madrid",
        "Atlético Madrid": "atletico_madrid",
        "Atletico Madrid": "atletico_madrid",
        "Barcelona": "barcelona",
        "FC Barcelona": "barcelona",
        "Betis": "real_betis",
        "Real Betis": "real_betis",
        "Cadiz": "cadiz",
        "Cádiz": "cadiz",
        "Celta": "celta_vigo",
        "Celta Vigo": "celta_vigo",
        "Celta de Vigo": "celta_vigo",
        "Deportivo": "deportivo_la_coruna",
        "Deportivo La Coruña": "deportivo_la_coruna",
        "La Coruna": "deportivo_la_coruna",
        "La Coruña": "deportivo_la_coruna",
        "Eibar": "eibar",
        "Elche": "elche",
        "Espanol": "espanyol",
        "Espanyol": "espanyol",
        "RCD Espanyol": "espanyol",
        "Getafe": "getafe",
        "Getafe CF": "getafe",
        "Girona": "girona",
        "Girona FC": "girona",
        "Granada": "granada",
        "Granada CF": "granada",
        "Huesca": "huesca",
        "Las Palmas": "las_palmas",
        "UD Las Palmas": "las_palmas",
        "Leganes": "leganes",
        "Leganés": "leganes",
        "Levante": "levante",
        "Mallorca": "mallorca",
        "RCD Mallorca": "mallorca",
        "Malaga": "malaga",
        "Málaga": "malaga",
        "Osasuna": "osasuna",
        "CA Osasuna": "osasuna",
        "Oviedo": "real_oviedo",
        "Real Oviedo": "real_oviedo",
        "Rayo Vallecano": "rayo_vallecano",
        "Vallecano": "rayo_vallecano",
        "Real Madrid": "real_madrid",
        "Real Sociedad": "real_sociedad",
        "Santander": "racing_santander",
        "Racing Santander": "racing_santander",
        "Racing": "racing_santander",
        "Sociedad": "real_sociedad",
        "Sevilla": "sevilla",
        "Sevilla FC": "sevilla",
        "Valencia": "valencia",
        "Valencia CF": "valencia",
        "Valladolid": "real_valladolid",
        "Real Valladolid": "real_valladolid",
        "Villarreal": "villarreal",
        "Villarreal CF": "villarreal",

        # Understat (Bundesliga, Serie A, Ligue 1) -> football-data canonical slugs
        "Arminia Bielefeld": "bielefeld",
        "Bayer Leverkusen": "leverkusen",
        "Borussia Dortmund": "dortmund",
        "Borussia M.Gladbach": "mgladbach",
        "Eintracht Frankfurt": "ein_frankfurt",
        "FC Cologne": "fc_koln",
        "FC Heidenheim": "heidenheim",
        "Greuther Fuerth": "greuther_furth",
        "Hamburger SV": "hamburg",
        "Hertha Berlin": "hertha",
        "Mainz 05": "mainz",
        "RasenBallsport Leipzig": "rb_leipzig",
        "St. Pauli": "st_pauli",
        "VfB Stuttgart": "stuttgart",
        "AC Milan": "milan",
        "Parma Calcio 1913": "parma",
        "Clermont Foot": "clermont",
        "Paris Saint Germain": "paris_sg",
        "Saint-Etienne": "st_etienne",
    }
    if clean in aliases:
        return aliases[clean]
    # Fallback to slug
    norm = clean.lower().replace(" ", "_").replace("-", "_").replace("'", "")
    for ch in ["á", "é", "í", "ó", "ú", "ñ"]:
        norm = norm.replace("á", "a").replace("é", "e").replace("í", "i").replace("ó", "o").replace("ú", "u").replace("ñ", "n")
    return norm


if __name__ == "__main__":
    init_db()
    print(f"Database initialized successfully at: {DB_PATH}")
