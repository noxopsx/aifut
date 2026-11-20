#!/usr/bin/env node
/**
 * MOTOR-NOX · Fase 0 · Productor de pronósticos live.
 *
 * Lee la cartelera de js/data/, calcula el 1X2 con el motor live y escribe un
 * JSON con un snapshot por partido futuro. No publica nada por sí mismo: el
 * registro inmutable lo hace pipeline.forecast_registry.
 *
 * Uso:
 *   node pipeline/registrar_live.mjs
 *   node pipeline/registrar_live.mjs --out data/live_forecasts.json --allow-past
 */

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LEAGUE } from "../js/data/league.js";
import { MATCHES } from "../js/data/matches.js";
import { TEAMS } from "../js/data/teams.js";
import { analyzeMatch, MODEL_VERSION } from "../js/model/index.js";

const MODEL_VERSION_ID = "live-poisson-1.0";
const DEFAULT_OUT = "data/live_forecasts.json";

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, allowPast: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      args.out = argv[index + 1];
      index += 1;
    } else if (arg === "--allow-past") {
      args.allowPast = true;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Uso: node pipeline/registrar_live.mjs [--out ruta] [--allow-past] [--quiet]");
      process.exit(0);
    }
  }
  return args;
}

function pickFrom(probabilities) {
  if (probabilities.home >= probabilities.draw && probabilities.home >= probabilities.away) return "1";
  if (probabilities.away >= probabilities.draw) return "2";
  return "X";
}

function teamName(id) {
  return TEAMS[id]?.name || id;
}

function featureHash(match) {
  return createHash("sha256").update(JSON.stringify(match)).digest("hex");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const forecasts = [];
  let past = 0;
  let invalid = 0;

  for (const match of MATCHES) {
    const kickoffMs = Date.parse(match.date);
    if (!Number.isFinite(kickoffMs)) {
      invalid += 1;
      continue;
    }
    if (kickoffMs <= now && !args.allowPast) {
      past += 1;
      continue;
    }
    const analysis = analyzeMatch(match, TEAMS, LEAGUE);
    const probabilities = {
      home: analysis.probs.home,
      draw: analysis.probs.draw,
      away: analysis.probs.away,
    };
    forecasts.push({
      fixture_id: match.id,
      kickoff_utc: new Date(kickoffMs).toISOString(),
      league_id: match.leagueId || match.home?.split("-")[0] || null,
      league_name: match.competition || null,
      season: match.season || null,
      home_team: teamName(match.home),
      away_team: teamName(match.away),
      probabilities,
      pick: pickFrom(probabilities),
      confidence: Math.max(probabilities.home, probabilities.draw, probabilities.away),
      feature_hash: featureHash(match),
      source: "live",
      engine: "poisson-dixon-coles",
      engine_version: MODEL_VERSION,
      notes: kickoffMs <= now ? "kickoff pasado; solo inspección" : null,
    });
  }

  const payload = {
    schema: "motor-nox.live_forecasts.v1",
    generated_at: new Date().toISOString(),
    model_version: MODEL_VERSION_ID,
    engine: "poisson-dixon-coles",
    engine_version: MODEL_VERSION,
    source: "live",
    matches_total: MATCHES.length,
    matches_future: forecasts.length,
    matches_past: past,
    matches_invalid: invalid,
    forecasts,
  };

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  const temp = `${outPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temp, outPath);

  if (!args.quiet) {
    console.log(
      `Pronósticos live: ${forecasts.length} de ${MATCHES.length} partidos (${past} vencidos, ${invalid} inválidos).`,
    );
    console.log(`Archivo: ${outPath}`);
    if (!forecasts.length) {
      console.log(
        "Aviso: no hay partidos futuros en js/data/matches.js. Actualiza la cartelera con: node datos_live.mjs",
      );
    }
  }
}

main();
