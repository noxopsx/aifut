#!/usr/bin/env node
/**
 * Exporta las predicciones del motor Poisson + Dixon-Coles de la UI para la
 * muestra histórica de la pipeline de modelos (Sección 3).
 *
 * Entrada:  data/models/historical_matches.json
 * Salida:   data/models/poisson_baseline.json
 *
 * El motor es el mismo `runBacktest` que usa `datos_live.mjs`, con
 * `collectRows` activado para conservar una fila por partido. La ventana es el
 * último 50% de cada liga (temporadas 4-6 del feature store), de modo que las
 * filas coinciden con la validación y el test temporales de Python.
 *
 * Uso:
 *     node pipeline/export_poisson_baseline.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktest } from "../js/model/backtest.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const inputPath = resolve(root, "data/models/historical_matches.json");
const outputPath = resolve(root, "data/models/poisson_baseline.json");

const LEAGUES = [
  {
    id: "eng.1",
    name: "Premier League",
    short: "ENG",
    homeFactor: 1.1,
    awayFactor: 0.92,
    avgCards: 4.5,
    avgCorners: 10.2,
    rho: -0.05,
  },
  {
    id: "esp.1",
    name: "LaLiga",
    short: "ESP",
    homeFactor: 1.1,
    awayFactor: 0.92,
    avgCards: 5.0,
    avgCorners: 10.5,
    rho: -0.05,
  },
];

function seasonYear(season) {
  const value = String(season || "");
  const match = value.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

async function main() {
  const payload = JSON.parse(await readFile(inputPath, "utf8"));
  const matches = Array.isArray(payload) ? payload : payload.matches;
  if (!Array.isArray(matches) || !matches.length) {
    throw new Error(`Sin partidos en ${inputPath}`);
  }

  const events = matches.map((match) => ({
    id: String(match.id ?? match.matchId),
    date: match.date ?? match.date_utc,
    leagueId: match.leagueId ?? match.league_id,
    season: seasonYear(match.season),
    seasonName: match.season,
    completed: true,
    homeId: String(match.homeId ?? match.home_team_id),
    awayId: String(match.awayId ?? match.away_team_id),
    homeName: match.homeName ?? match.home_team_id,
    awayName: match.awayName ?? match.away_team_id,
    homeAbbr: String(match.homeName ?? match.home_team_id).slice(0, 3).toUpperCase(),
    awayAbbr: String(match.awayName ?? match.away_team_id).slice(0, 3).toUpperCase(),
    homeGoals: Number(match.homeGoals ?? match.home_goals),
    awayGoals: Number(match.awayGoals ?? match.away_goals),
    venue: match.venue ?? "",
    city: match.city ?? "",
    competition: match.leagueId ?? match.league_id,
  }));

  const result = runBacktest(events, {
    leagues: LEAGUES,
    holdout: 0.5,
    minTeamMatches: 4,
    minLeagueMatches: 20,
    collectRows: true,
  });

  const output = {
    version: "1.0",
    engine: result.engine,
    engineVersion: result.engineVersion,
    method: result.method,
    holdout: result.holdout,
    generatedAt: new Date().toISOString(),
    sample: result.sample,
    summary: {
      overall: result.overall,
      hits: {
        n: result.hits.n,
        hits: result.hits.hits,
        rate: result.hits.rate,
        currentStreak: result.hits.currentStreak,
        bestStreak: result.hits.bestStreak,
        byLeague: result.hits.byLeague,
      },
      leagues: result.leagues,
      calibration: result.calibration,
      timeline: result.timeline,
      testWindows: result.testWindows,
    },
    rows: result.rows || [],
    notes: result.notes,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
  console.log(`Poisson baseline: ${output.rows.length} filas -> ${outputPath}`);
}

main().catch((error) => {
  console.error(`Error exportando Poisson baseline: ${error.stack || error.message}`);
  process.exitCode = 1;
});
