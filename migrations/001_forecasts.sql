-- MOTOR-NOX · Fase 0 · Registro verificable de pronósticos
--
-- Objetivo: que cada pronóstico publicado quede guardado antes del kickoff,
-- con hash y versión de modelo, y que su resultado se pueda reconciliar sin
-- editar el pronóstico original.
--
-- Reglas:
--   * forecasts es inmutable: los triggers bloquean UPDATE y DELETE.
--   * Un mismo partido no puede tener dos pronósticos de la misma versión.
--   * forecast_outcomes sí se puede corregir si la fuente publica un resultado
--     equivocado; la corrección queda con su propio reconciled_at.
--
-- Esta migración es idempotente. El runner de pipeline.db la registra en
-- schema_migrations para no volver a aplicarla.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_versions (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    version      TEXT NOT NULL,
    engine       TEXT,
    trained_at   TEXT,
    feature_count INTEGER,
    metrics_json TEXT,
    active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    created_at   TEXT NOT NULL,
    notes        TEXT,
    UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS forecasts (
    id             TEXT PRIMARY KEY,
    fixture_id     TEXT NOT NULL,
    league_id      TEXT,
    league_name    TEXT,
    season         TEXT,
    kickoff_utc    TEXT NOT NULL,
    home_team      TEXT NOT NULL,
    away_team      TEXT NOT NULL,
    model_version  TEXT NOT NULL,
    p_home         REAL NOT NULL CHECK (p_home >= 0 AND p_home <= 1),
    p_draw         REAL NOT NULL CHECK (p_draw >= 0 AND p_draw <= 1),
    p_away         REAL NOT NULL CHECK (p_away >= 0 AND p_away <= 1),
    pick           TEXT NOT NULL CHECK (pick IN ('1', 'X', '2', 'none')),
    confidence     REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    threshold      REAL CHECK (threshold IS NULL OR (threshold >= 0 AND threshold <= 1)),
    published      INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
    policy         TEXT NOT NULL DEFAULT 'threshold',
    source         TEXT NOT NULL DEFAULT 'live',
    feature_hash   TEXT,
    snapshot_hash  TEXT NOT NULL,
    snapshot_json  TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (fixture_id, model_version),
    FOREIGN KEY (model_version) REFERENCES model_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_forecasts_kickoff ON forecasts(kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_forecasts_published ON forecasts(published, created_at);
CREATE INDEX IF NOT EXISTS idx_forecasts_league ON forecasts(league_id, kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_forecasts_fixture ON forecasts(fixture_id);

CREATE TABLE IF NOT EXISTS forecast_outcomes (
    forecast_id   TEXT PRIMARY KEY,
    status        TEXT NOT NULL CHECK (status IN ('hit', 'miss', 'void', 'postponed')),
    result        TEXT CHECK (result IS NULL OR result IN ('1', 'X', '2')),
    home_goals    INTEGER,
    away_goals    INTEGER,
    hit           INTEGER CHECK (hit IS NULL OR hit IN (0, 1)),
    brier         REAL,
    log_loss      REAL,
    source        TEXT,
    reconciled_at TEXT NOT NULL,
    notes         TEXT,
    FOREIGN KEY (forecast_id) REFERENCES forecasts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outcomes_status ON forecast_outcomes(status, reconciled_at);

CREATE TRIGGER IF NOT EXISTS forecasts_block_update
BEFORE UPDATE ON forecasts
BEGIN
    SELECT RAISE(ABORT, 'forecasts es inmutable: registra una nueva version de modelo');
END;

CREATE TRIGGER IF NOT EXISTS forecasts_block_delete
BEFORE DELETE ON forecasts
BEGIN
    SELECT RAISE(ABORT, 'forecasts es inmutable: no se puede borrar un pronostico registrado');
END;
