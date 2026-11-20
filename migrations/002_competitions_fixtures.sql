-- MOTOR-NOX · Fase 1 · Catálogo de competiciones y calendario
--
-- Objetivo: separar el catálogo operativo (competiciones, temporadas y
-- fixtures) del store histórico que alimenta al modelo. Así se puede cubrir
-- el calendario de 60+ competiciones sin fingir que todas tienen histórico
-- suficiente para publicar picks.
--
-- Reglas:
--   * competitions es el catálogo único; source_ids guarda los IDs de cada
--     proveedor en JSON (por ahora {"espn": "eng.1"}).
--   * fixtures se deduplica por (source, source_id); una actualización de
--     hora, sede o estado no crea un partido nuevo.
--   * Los cambios de hora/sede/estado quedan auditados en fixture_changes.
--   * data_quality_events registra alertas de contrato y cobertura.
--
-- Esta migración es idempotente. El runner de pipeline.db la registra en
-- schema_migrations para no volver a aplicarla.

CREATE TABLE IF NOT EXISTS competitions (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    short_name         TEXT,
    country            TEXT,
    timezone           TEXT NOT NULL,
    tier               TEXT NOT NULL CHECK (tier IN ('A', 'B', 'C')),
    tier_reason        TEXT,
    source_ids         TEXT NOT NULL,
    goals_prior        REAL,
    home_prior         REAL,
    away_prior         REAL,
    prior_source       TEXT,
    aliases_json       TEXT,
    logo_url           TEXT,
    is_tournament      INTEGER NOT NULL DEFAULT 0 CHECK (is_tournament IN (0, 1)),
    active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    availability_ready INTEGER NOT NULL DEFAULT 0 CHECK (availability_ready IN (0, 1)),
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_competitions_tier
    ON competitions(tier, active);
CREATE INDEX IF NOT EXISTS idx_competitions_country
    ON competitions(country, active);

CREATE TABLE IF NOT EXISTS seasons (
    competition_id TEXT NOT NULL,
    season         TEXT NOT NULL,
    start_date     TEXT,
    end_date       TEXT,
    format         TEXT,
    team_count     INTEGER,
    goals_prior    REAL,
    home_prior     REAL,
    away_prior     REAL,
    source         TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (competition_id, season),
    FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_seasons_dates
    ON seasons(start_date, end_date);

CREATE TABLE IF NOT EXISTS fixtures (
    id             TEXT PRIMARY KEY,
    competition_id TEXT NOT NULL,
    season         TEXT NOT NULL,
    kickoff_utc    TEXT NOT NULL,
    home_team_id   TEXT NOT NULL,
    away_team_id   TEXT NOT NULL,
    home_team_name TEXT NOT NULL,
    away_team_name TEXT NOT NULL,
    home_team_abbr TEXT,
    away_team_abbr TEXT,
    status         TEXT NOT NULL CHECK (
        status IN ('scheduled', 'live', 'finished', 'postponed', 'cancelled', 'suspended')
    ),
    home_goals     INTEGER,
    away_goals     INTEGER,
    venue          TEXT,
    venue_city     TEXT,
    stage          TEXT,
    source         TEXT NOT NULL,
    source_id      TEXT NOT NULL,
    source_url     TEXT,
    first_seen_at  TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE (source, source_id),
    FOREIGN KEY (competition_id) REFERENCES competitions(id)
);

CREATE INDEX IF NOT EXISTS idx_fixtures_competition_kickoff
    ON fixtures(competition_id, kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_fixtures_kickoff
    ON fixtures(kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_fixtures_status
    ON fixtures(status, kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_fixtures_season
    ON fixtures(competition_id, season);

CREATE TABLE IF NOT EXISTS fixture_changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fixture_id  TEXT NOT NULL,
    field       TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    detected_at TEXT NOT NULL,
    source      TEXT NOT NULL,
    FOREIGN KEY (fixture_id) REFERENCES fixtures(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fixture_changes_fixture
    ON fixture_changes(fixture_id, detected_at);

CREATE TABLE IF NOT EXISTS data_quality_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT NOT NULL,
    scope        TEXT NOT NULL,
    field        TEXT,
    severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    message      TEXT NOT NULL,
    context_json TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_events_created
    ON data_quality_events(created_at, severity);
CREATE INDEX IF NOT EXISTS idx_quality_events_scope
    ON data_quality_events(scope, created_at);

-- Estado operativo de cada sincronización. Permite medir frescura y cobertura
-- sin depender de logs de texto.
CREATE TABLE IF NOT EXISTS sync_state (
    id              TEXT PRIMARY KEY,
    source          TEXT NOT NULL,
    scope           TEXT NOT NULL,
    last_started_at TEXT,
    last_finished_at TEXT,
    status          TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
    events          INTEGER NOT NULL DEFAULT 0,
    inserted        INTEGER NOT NULL DEFAULT 0,
    updated         INTEGER NOT NULL DEFAULT 0,
    errors          INTEGER NOT NULL DEFAULT 0,
    window_from     TEXT,
    window_to       TEXT,
    details_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_state_scope
    ON sync_state(scope, last_finished_at);
