#!/usr/bin/env node
/**
 * MOTOR-NOX V1.0 · actualizador de datos live
 * ===========================================
 *
 * Descarga los próximos partidos y las tablas de las principales ligas desde
 * la API pública de ESPN y genera los archivos que consume la interfaz:
 *
 *     js/data/league.js
 *     js/data/teams.js
 *     js/data/matches.js
 *     js/data/tables.js
 *
 * El motor de MOTOR-NOX sigue siendo propio. Este script NO usa probabilidades
 * de terceros: solo toma datos factuales (calendario, resultados, tabla, forma
 * y sede) y calcula ataque/defensa a partir de los goles de la tabla.
 *
 * Uso:
 *     node datos_live.mjs
 *     node datos_live.mjs --dias 7 --max 120
 *     node datos_live.mjs --dry-run
 *     node datos_live.mjs --sin-cache
 *     node datos_live.mjs --liga esp.1 --liga eng.1
 *
 * Para volver a los datos de respaldo:
 *     python mis_datos.py --restaurar
 */

import { access, appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktest } from "./js/model/backtest.js";
import { buildLatentData } from "./js/model/latent.js";
import { PLAYER_REPORT_MATCHES, aggregateTeamForm, emptyPlayerForm, summarizeMatch } from "./js/model/players.js";
import { applyShotRates } from "./js/model/observations.js";
import { splitTeams } from "./pipeline/split_teams.mjs";
import {
  blendStrength,
  buildH2H,
  computeRecentProfile,
  computeSeasonProfile,
  matchDateMs,
  normalizeScheduleEvent,
} from "./js/model/ratings.js";

const BASE_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(BASE_DIR, "js", "data");
const CACHE_DIR = join(BASE_DIR, ".cache", "espn");
const UPDATE_STATE = join(BASE_DIR, ".cache", "ultima_actualizacion.json");
const DEMO_BACKUP = join(BASE_DIR, "_respaldo_demo");
const PRE_LIVE_BACKUP = join(BASE_DIR, "_respaldo_antes_live");
const DATA_FILES = ["league.js", "teams.js", "matches.js", "tables.js", "validation.js", "latent.js"];
const ESPN_API = "https://site.api.espn.com/apis";
const USER_AGENT = "MOTOR-NOX/1.0 (motor de prediccion personal; datos publicos de ESPN)";

/**
 * Ligas soportadas. Los promedios de tarjetas y córners son referencias
 * conservadoras de cada competición: ESPN no los publica en la tabla. Se
 * marcan como estimados en el contexto y la interfaz lo advierte.
 */
const LEAGUES = [
  {
    id: "gua.1",
    name: "Liga Nacional de Guatemala",
    short: "Guatemala",
    country: "Guatemala",
    timezone: "America/Guatemala",
    avgCards: 4.2,
    avgCorners: 9.4,
    homeFactor: 1.10,
    awayFactor: 0.92,
    rho: -0.05,
  },
  {
    id: "mex.1",
    name: "Liga MX",
    short: "Liga MX",
    country: "México",
    timezone: "America/Mexico_City",
    avgCards: 4.6,
    avgCorners: 10.0,
    homeFactor: 1.11,
    awayFactor: 0.91,
    rho: -0.05,
  },
  {
    id: "usa.1",
    name: "MLS",
    short: "MLS",
    country: "Estados Unidos",
    timezone: "America/New_York",
    avgCards: 4.4,
    avgCorners: 10.2,
    homeFactor: 1.10,
    awayFactor: 0.92,
    rho: -0.05,
  },
  {
    id: "esp.1",
    name: "LaLiga",
    short: "LaLiga",
    country: "España",
    timezone: "Europe/Madrid",
    avgCards: 4.8,
    avgCorners: 9.8,
    homeFactor: 1.10,
    awayFactor: 0.92,
    rho: -0.05,
  },
  {
    id: "arg.1",
    name: "Primera División Argentina",
    short: "Argentina",
    country: "Argentina",
    timezone: "America/Argentina/Buenos_Aires",
    avgCards: 4.7,
    avgCorners: 9.6,
    homeFactor: 1.12,
    awayFactor: 0.90,
    rho: -0.05,
  },
  {
    id: "bra.1",
    name: "Brasileirão",
    short: "Brasil",
    country: "Brasil",
    timezone: "America/Sao_Paulo",
    avgCards: 4.8,
    avgCorners: 10.0,
    homeFactor: 1.11,
    awayFactor: 0.91,
    rho: -0.05,
  },
  {
    id: "uefa.champions",
    name: "UEFA Champions League",
    short: "Champions",
    country: "Europa",
    timezone: "Europe/Madrid",
    avgCards: 3.8,
    avgCorners: 10.4,
    homeFactor: 1.08,
    awayFactor: 0.94,
    rho: -0.05,
  },
  {
    id: "uefa.europa",
    name: "UEFA Europa League",
    short: "Europa League",
    country: "Europa",
    timezone: "Europe/Madrid",
    avgCards: 4.0,
    avgCorners: 10.2,
    homeFactor: 1.08,
    awayFactor: 0.94,
    rho: -0.05,
  },
  {
    id: "uefa.europa.conf",
    name: "UEFA Conference League",
    short: "Conference",
    country: "Europa",
    timezone: "Europe/Madrid",
    avgCards: 4.0,
    avgCorners: 10.0,
    homeFactor: 1.08,
    awayFactor: 0.94,
    rho: -0.05,
  },
  {
    id: "ned.1",
    name: "Eredivisie",
    short: "Eredivisie",
    country: "Países Bajos",
    timezone: "Europe/Amsterdam",
    avgCards: 4.2,
    avgCorners: 10.6,
    homeFactor: 1.10,
    awayFactor: 0.92,
    rho: -0.05,
  },
  {
    id: "eng.1",
    name: "Premier League",
    short: "Premier",
    country: "Inglaterra",
    timezone: "Europe/London",
    avgCards: 4.2,
    avgCorners: 10.8,
    homeFactor: 1.09,
    awayFactor: 0.93,
    rho: -0.05,
  },
  {
    id: "fra.1",
    name: "Ligue 1",
    short: "Ligue 1",
    country: "Francia",
    timezone: "Europe/Paris",
    avgCards: 4.4,
    avgCorners: 9.8,
    homeFactor: 1.10,
    awayFactor: 0.92,
    rho: -0.05,
  },
  {
    id: "ger.1",
    name: "Bundesliga",
    short: "Bundesliga",
    country: "Alemania",
    timezone: "Europe/Berlin",
    avgCards: 4.3,
    avgCorners: 10.4,
    homeFactor: 1.10,
    awayFactor: 0.92,
    rho: -0.05,
  },
  {
    id: "ita.1",
    name: "Serie A",
    short: "Serie A",
    country: "Italia",
    timezone: "Europe/Rome",
    avgCards: 4.7,
    avgCorners: 10.2,
    homeFactor: 1.10,
    awayFactor: 0.92,
    rho: -0.05,
  },
];

const TYPE_LABELS = {
  league: "Liga regular",
  liguilla: "Liguilla",
  round16: "Octavos de final",
  quarterfinal: "Cuartos de final",
  semifinal: "Semifinal",
  final: "Final",
  friendly: "Amistoso",
};

const FILTERS = [
  {
    id: "all",
    label: "Todos",
  },
  {
    id: "today",
    label: "Hoy",
  },
  {
    id: "tomorrow",
    label: "Mañana",
  },
  {
    id: "league",
    label: "Por liga",
  },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function slugify(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "equipo";
}

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < String(value).length; i += 1) {
    h ^= String(value).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function colorFromName(name) {
  const palette = [
    ["#2457d6", "#ffffff"],
    ["#d64545", "#ffffff"],
    ["#1f7a5a", "#ffffff"],
    ["#b7791f", "#171716"],
    ["#6b46c1", "#ffffff"],
    ["#0f766e", "#ffffff"],
    ["#be185d", "#ffffff"],
    ["#374151", "#ffffff"],
  ];
  return palette[hash(name) % palette.length];
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function dateStamp(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function seasonLabel(season) {
  if (!season) return "Temporada en curso";
  const start = season.startDate ? new Date(season.startDate) : null;
  const end = season.endDate ? new Date(season.endDate) : null;
  if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
    const startYear = start.getUTCFullYear();
    const endYear = end.getUTCFullYear();
    if (startYear !== endYear) return `${startYear}/${String(endYear).slice(-2)}`;
    return String(startYear);
  }
  if (season.year) return String(season.year);
  return "Temporada en curso";
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function cachePath(url) {
  return join(CACHE_DIR, `${hash(url)}.json`);
}

async function fetchJson(url, options = {}) {
  const { timeout = 20000, retries = 2, cache = true, ttlMs = 5 * 60 * 1000, verbose = false } = options;
  const path = cachePath(url);

  if (cache) {
    try {
      const cached = await readJson(path);
      if (cached?.fetchedAt && Date.now() - cached.fetchedAt < ttlMs) {
        if (verbose) console.log(`  cache  ${url}`);
        return cached.data;
      }
    } catch {
      // Sin caché válida: se descarga.
    }
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      if (verbose) console.log(`  fetch  ${url}`);
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Respuesta no JSON: ${text.slice(0, 160)}`);
      }
      if (cache) {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(path, JSON.stringify({ fetchedAt: Date.now(), url, data }), "utf8");
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 700 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function statsMap(entry) {
  const map = {};
  for (const stat of entry.stats || []) {
    if (stat && stat.name) map[stat.name] = stat.value;
  }
  return map;
}

async function fetchStandings(league, options) {
  const url = `${ESPN_API}/v2/sports/soccer/${league.id}/standings`;
  const data = await fetchJson(url, {
    cache: options.cache,
    ttlMs: 60 * 60 * 1000,
    verbose: options.verbose,
  });

  const entries = [];
  for (const child of data.children || []) {
    const group = child.name || "";
    for (const entry of child.standings?.entries || []) {
      if (!entry?.team) continue;
      const stats = statsMap(entry);
      const team = entry.team;
      entries.push({
        teamId: String(team.id),
        team: team.displayName || team.name || "Equipo",
        short: team.shortDisplayName || team.displayName || team.name || "Equipo",
        abbr: (team.abbreviation || "").toUpperCase(),
        logo: team.logos?.[0]?.href || team.logo || "",
        color: team.color ? `#${team.color}` : "",
        color2: team.alternateColor ? `#${team.alternateColor}` : "",
        location: team.location || "",
        group,
        pos: Number(stats.rank ?? entry.note?.rank ?? 0) || null,
        pj: Number(stats.gamesPlayed ?? 0),
        pg: Number(stats.wins ?? 0),
        pe: Number(stats.ties ?? 0),
        pp: Number(stats.losses ?? 0),
        gf: Number(stats.pointsFor ?? 0),
        gc: Number(stats.pointsAgainst ?? 0),
        dg: Number(stats.pointDifferential ?? 0),
        pts: Number(stats.points ?? 0),
        zone: entry.note?.description || "",
      });
    }
  }

  if (!entries.length) {
    throw new Error("La tabla llegó vacía.");
  }

  const totalPj = entries.reduce((sum, entry) => sum + entry.pj, 0);
  const totalGf = entries.reduce((sum, entry) => sum + entry.gf, 0);
  const avgGoals = totalPj > 0 ? totalGf / totalPj : 1.35;
  const safeAvg = Number.isFinite(avgGoals) && avgGoals > 0.3 ? avgGoals : 1.35;

  for (const entry of entries) {
    if (entry.pj > 0) {
      const attackRaw = (entry.gf / entry.pj) / safeAvg;
      const defenseRaw = (entry.gc / entry.pj) / safeAvg;
      const weight = entry.pj / (entry.pj + 6);
      entry.attack = round(clamp(1 + (attackRaw - 1) * weight, 0.55, 1.75), 3);
      entry.defense = round(clamp(1 + (defenseRaw - 1) * weight, 0.55, 1.75), 3);
    } else {
      entry.attack = 1;
      entry.defense = 1;
    }
  }

  // Orden para la tabla: grupo (si existe), posición y puntos.
  entries.sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group, "es");
    if ((a.pos ?? 99) !== (b.pos ?? 99)) return (a.pos ?? 99) - (b.pos ?? 99);
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.dg !== a.dg) return b.dg - a.dg;
    return b.gf - a.gf;
  });

  const label = seasonLabel(data.season);
  return {
    league,
    season: label,
    avgGoals: round(safeAvg, 3),
    avgCards: league.avgCards,
    avgCorners: league.avgCorners,
    homeFactor: league.homeFactor,
    awayFactor: league.awayFactor,
    rho: league.rho,
    estimatedAverages: true,
    standings: entries,
    teamsById: new Map(entries.map((entry) => [entry.teamId, entry])),
    raw: data,
  };
}

function formToArray(form) {
  if (Array.isArray(form)) {
    return form
      .map((item) => String(item).toUpperCase())
      .filter((item) => item === "W" || item === "D" || item === "L")
      .slice(-5);
  }
  const text = String(form ?? "").toUpperCase().replace(/[^WDL]/g, "");
  return text.split("").slice(-5);
}

async function fetchScoreboard(league, date, options) {
  const url = `${ESPN_API}/site/v2/sports/soccer/${league.id}/scoreboard?dates=${date}`;
  const data = await fetchJson(url, {
    cache: options.cache,
    ttlMs: 2 * 60 * 1000,
    verbose: options.verbose,
  });
  return data.events || [];
}

function seasonYears(leagueData) {
  const current = Number(leagueData.raw?.season?.year) || new Date().getUTCFullYear();
  return [current, current - 1];
}

async function fetchTeamHistory(leagueData, team, options) {
  const key = `${leagueData.league.id}:${team.espnId}`;
  const seasons = seasonYears(leagueData);
  const events = new Map();
  for (const season of seasons) {
    const url = `${ESPN_API}/site/v2/sports/soccer/${leagueData.league.id}/teams/${team.espnId}/schedule?season=${season}`;
    try {
      const data = await fetchJson(url, {
        cache: options.cache,
        ttlMs: 6 * 60 * 60 * 1000,
        verbose: options.verbose,
      });
      for (const event of data.events || []) {
        const normalized = normalizeScheduleEvent(event, leagueData.league.id);
        if (normalized) events.set(normalized.id, normalized);
      }
    } catch (error) {
      if (options.verbose) {
        console.warn(`  aviso  ${key} temporada ${season}: ${error.message}`);
      }
    }
  }
  return {
    key,
    leagueId: leagueData.league.id,
    teamId: team.espnId,
    seasons,
    events: [...events.values()].sort((a, b) => matchDateMs(a.date) - matchDateMs(b.date)),
  };
}

async function fetchHistories(teams, standings, options) {
  const byLeague = new Map(standings.map((item) => [item.league.id, item]));
  const jobs = [];
  for (const team of Object.values(teams)) {
    const leagueData = byLeague.get(team.leagueId);
    if (leagueData) jobs.push({ leagueData, team });
  }
  const results = await mapLimit(jobs, 6, async ({ leagueData, team }) => {
    try {
      return await fetchTeamHistory(leagueData, team, options);
    } catch (error) {
      console.warn(`Aviso: sin historial para ${team.name}: ${error.message}`);
      return { key: `${leagueData.league.id}:${team.espnId}`, events: [] };
    }
  });

  const byTeam = new Map();
  const events = new Map();
  for (const result of results) {
    byTeam.set(result.key, result.events || []);
    for (const event of result.events || []) events.set(event.id, event);
  }
  return {
    byTeam,
    events: [...events.values()].sort((a, b) => matchDateMs(a.date) - matchDateMs(b.date)),
    teams: results.length,
    seasons: [...new Set(results.flatMap((result) => result.seasons || []))].sort((a, b) => b - a),
  };
}

async function attachPlayerForm(teams, standings, historyData, options) {
  const byLeague = new Map(standings.map((item) => [item.league.id, item]));
  const now = Date.now();
  const jobs = new Map();
  const reportsByTeam = new Map();
  let onTargetDerived = 0;
  let shotsDerived = 0;

  for (const team of Object.values(teams)) {
    const leagueData = byLeague.get(team.leagueId);
    const teamKey = `${team.leagueId}:${team.espnId}`;
    if (!leagueData) {
      team.playerForm = emptyPlayerForm(team.name);
      continue;
    }
    const recent = (historyData.byTeam.get(teamKey) || [])
      .filter((event) => event.completed && new Date(event.date).getTime() <= now)
      .sort((a, b) => matchDateMs(b.date) - matchDateMs(a.date))
      .slice(0, PLAYER_REPORT_MATCHES);
    const keys = [];
    for (const event of recent) {
      const key = `${event.leagueId}:${event.id}`;
      keys.push(key);
      if (!jobs.has(key)) jobs.set(key, { event, leagueData });
    }
    reportsByTeam.set(teamKey, keys);
  }

  const results = await mapLimit([...jobs.values()], 6, async ({ event, leagueData }) => {
    const key = `${event.leagueId}:${event.id}`;
    const url = `${ESPN_API}/site/v2/sports/soccer/${leagueData.league.id}/summary?event=${event.id}`;
    try {
      const data = await fetchJson(url, {
        cache: options.cache,
        ttlMs: 12 * 60 * 60 * 1000,
        verbose: options.verbose,
      });
      return { key, report: summarizeMatch(data, event, leagueData.league) };
    } catch (error) {
      if (options.verbose) console.warn(`  aviso  resumen ${key}: ${error.message}`);
      return { key, report: null };
    }
  });

  const reports = new Map(results.filter((item) => item.report).map((item) => [item.key, item.report]));
  for (const team of Object.values(teams)) {
    const teamKey = `${team.leagueId}:${team.espnId}`;
    const teamReports = (reportsByTeam.get(teamKey) || [])
      .map((key) => reports.get(key)?.teams?.[team.espnId])
      .filter(Boolean);
    team.playerForm = teamReports.length
      ? aggregateTeamForm(teamReports, { teamName: team.name })
      : emptyPlayerForm(team.name);
    if (applyOnTargetRate(team)) onTargetDerived += 1;
    if (applyShotRates(team).applied) shotsDerived += 1;
  }

  return {
    teams: Object.keys(teams).length,
    matches: jobs.size,
    summaries: reports.size,
    onTargetDerived,
    onTargetPlaceholder: Object.keys(teams).length - onTargetDerived,
    shotsDerived,
    shotsPlaceholder: Object.keys(teams).length - shotsDerived,
  };
}

function restDays(history, teamId, before, fallback = 4) {
  const id = String(teamId);
  const cutoff = matchDateMs(before);
  let last = null;
  for (const match of history || []) {
    if (!match?.completed) continue;
    if (match.homeId !== id && match.awayId !== id) continue;
    const ms = matchDateMs(match.date);
    if (ms >= cutoff) continue;
    if (!last || ms > matchDateMs(last)) last = match.date;
  }
  if (!last) {
    return { days: fallback, observed: false, lastDate: null };
  }
  const days = Math.floor((cutoff - matchDateMs(last)) / 86_400_000);
  return { days: clamp(days, 2, 10), observed: true, lastDate: last };
}

function estimateTeamRates(team, leagueData) {
  const attack = Number(team.attack) || 1;
  const defense = Number(team.defense) || 1;
  const avgCorners = leagueData.avgCorners;
  const avgCards = leagueData.avgCards;
  team.cornersFor = round(clamp((avgCorners / 2) * (0.85 + 0.3 * attack), 2.5, 9.5), 2);
  team.cornersAgainst = round(clamp((avgCorners / 2) * (0.85 + 0.3 * defense), 2.5, 9.5), 2);
  team.shotsFor = round(clamp(12 * (0.85 + 0.3 * attack), 6, 22), 2);
  team.shotsAgainst = round(clamp(12 * (0.85 + 0.3 * defense), 6, 22), 2);
  team.cards = round(clamp((avgCards / 2) * (1 + 0.1 * (defense - 1)), 1, 5), 2);
  team.possession = Math.round(clamp(50 + 12 * (attack - defense), 35, 65));
}

// La tasa de tiros a puerta no viene en la tabla de ESPN. Se deriva de los
// resúmenes de los últimos partidos y se contrae hacia un prior conservador.
// Si no hay muestra suficiente, queda marcada como placeholder visible.
function applyOnTargetRate(team) {
  const summary = team.playerForm?.summary;
  const shots = Number(summary?.shots) || 0;
  const onTarget = Number(summary?.onTarget) || 0;
  const priorRate = 0.34;
  const priorShots = 30;
  if (team.playerForm?.sample > 0 && shots >= 10) {
    team.onTargetRate = round((onTarget + priorRate * priorShots) / (shots + priorShots), 4);
    team.onTargetRateSource = "derived";
    team.onTargetRateSample = {
      matches: team.playerForm.sample,
      shots,
      onTarget,
    };
    return true;
  }
  team.onTargetRate = priorRate;
  team.onTargetRateSource = "placeholder";
  team.onTargetRateSample = null;
  return false;
}

function applyHistories(matches, teams, standings, historyData) {
  const byLeague = new Map(standings.map((item) => [item.league.id, item]));
  const before = new Date().toISOString();
  let recentTeams = 0;

  for (const team of Object.values(teams)) {
    const leagueData = byLeague.get(team.leagueId);
    if (!leagueData) continue;
    const history = historyData.byTeam.get(`${team.leagueId}:${team.espnId}`) || [];
    const recent = computeRecentProfile(history, team.espnId, {
      before,
      leagueAvg: leagueData.avgGoals,
      window: 10,
      halfLifeDays: 45,
    });
    const season = computeSeasonProfile(history, team.espnId, {
      before,
      leagueAvg: leagueData.avgGoals,
      seasonYear: Number(leagueData.raw?.season?.year) || null,
      shrink: 6,
    });
    const strength = blendStrength(team.attack, team.defense, recent);
    team.seasonAttack = team.attack;
    team.seasonDefense = team.defense;
    team.attack = round(strength.attack, 3);
    team.defense = round(strength.defense, 3);
    team.strength = {
      ...strength,
      attack: team.attack,
      defense: team.defense,
    };
    team.recent = recent;
    team.seasonProfile = season;
    if (recent.form.length) team.form = recent.form;
    team.ratingSource = strength.recentWeight > 0.03
      ? "espn-standings+recent"
      : "espn-standings";
    team.estimated.history = false;
    estimateTeamRates(team, leagueData);
    if (recent.available) recentTeams += 1;
  }

  for (const match of matches) {
    const leagueData = byLeague.get(match.leagueContext?.id);
    if (!leagueData) continue;
    const home = teams[match.home];
    const away = teams[match.away];
    if (!home || !away) continue;
    const homeHistory = historyData.byTeam.get(`${home.leagueId}:${home.espnId}`) || [];
    const awayHistory = historyData.byTeam.get(`${away.leagueId}:${away.espnId}`) || [];
    const h2h = buildH2H(homeHistory, awayHistory, {
      homeId: home.espnId,
      awayId: away.espnId,
      before: match.date,
    });
    match.h2h = h2h;
    const homeRest = restDays(homeHistory, home.espnId, match.date);
    const awayRest = restDays(awayHistory, away.espnId, match.date);
    match.rest = { home: homeRest.days, away: awayRest.days };
    match.restMeta = {
      home: { observed: homeRest.observed, lastDate: homeRest.lastDate },
      away: { observed: awayRest.observed, lastDate: awayRest.lastDate },
    };
    const homeRecent = home.recent?.available ? `${home.recent.sample} partidos` : "sin muestra";
    const awayRecent = away.recent?.available ? `${away.recent.sample} partidos` : "sin muestra";
    const restNote = homeRest.observed && awayRest.observed
      ? `Descanso: ${homeRest.days} / ${awayRest.days} días desde el último partido de ESPN.`
      : "Descanso: sin dato en algún equipo; el factor se neutraliza."
    match.note = `Fuerzas: tabla de ${leagueData.league.name} (${leagueData.season}) mezclada con los últimos 10 partidos reales (${homeRecent} / ${awayRecent}) y H2H (${h2h.played}). ${restNote} Forma, sede y tiros por equipo: ESPN. Los tiros del partido próximo son una proyección con tiros observados cuando hay muestra; córners y tarjetas son estimaciones. Sin alineaciones confirmadas; el clima y el árbitro no entran en el cálculo.`;
  }

  return {
    recentTeams,
    events: historyData.events.length,
    teams: historyData.teams,
    seasons: historyData.seasons,
  };
}

function createTeam(leagueData, competitor, venue, usedAbbr, teams) {
  const team = competitor.team || {};
  const key = `${leagueData.league.id}-${team.id}`;
  if (teams[key]) return teams[key];
  const standing = leagueData.teamsById.get(String(team.id));
  const colors = colorFromName(team.displayName || team.name || key);
  let abbr = (team.abbreviation || standing?.abbr || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!abbr) abbr = (team.displayName || team.name || "EQP").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
  abbr = abbr.slice(0, 4).padEnd(2, "X");
  if (usedAbbr.has(abbr)) {
    let suffix = 2;
    while (usedAbbr.has(`${abbr.slice(0, 3)}${suffix}`) && suffix < 10) suffix += 1;
    abbr = `${abbr.slice(0, 3)}${suffix}`;
  }
  usedAbbr.add(abbr);

  const attack = standing?.attack ?? 1;
  const defense = standing?.defense ?? 1;
  const avgCorners = leagueData.avgCorners;
  const avgCards = leagueData.avgCards;
  const teamColor = team.color ? `#${team.color}` : standing?.color || colors[0];
  const teamColor2 = team.alternateColor ? `#${team.alternateColor}` : standing?.color2 || colors[1];
  const form = formToArray(competitor.form);

  return {
    id: key,
    espnId: String(team.id),
    leagueId: leagueData.league.id,
    name: team.displayName || team.name || standing?.team || "Equipo",
    short: team.shortDisplayName || team.displayName || standing?.short || "Equipo",
    abbr,
    city: "",
    country: venue?.address?.country || leagueData.league.country,
    color: teamColor,
    color2: teamColor2,
    logo: team.logo || standing?.logo || "",
    attack,
    defense,
    cornersFor: round(clamp((avgCorners / 2) * (0.85 + 0.3 * attack), 2.5, 9.5), 2),
    cornersAgainst: round(clamp((avgCorners / 2) * (0.85 + 0.3 * defense), 2.5, 9.5), 2),
    shotsFor: round(clamp(12 * (0.85 + 0.3 * attack), 6, 22), 2),
    shotsAgainst: round(clamp(12 * (0.85 + 0.3 * defense), 6, 22), 2),
    onTargetRate: 0.34,
    onTargetRateSource: "placeholder",
    onTargetRateSample: null,
    cards: round(clamp((avgCards / 2) * (1 + 0.1 * (defense - 1)), 1, 5), 2),
    possession: Math.round(clamp(50 + 12 * (attack - defense), 35, 65)),
    altitude: 0,
    form,
    players: [],
    standing: standing
      ? {
        pos: standing.pos,
        pj: standing.pj,
        pg: standing.pg,
        pe: standing.pe,
        pp: standing.pp,
        gf: standing.gf,
        gc: standing.gc,
        dg: standing.dg,
        pts: standing.pts,
        group: standing.group,
        zone: standing.zone,
      }
      : null,
    ratingSource: standing ? "espn-standings" : "neutral",
    estimated: {
      corners: true,
      shots: true,
      cards: true,
      possession: true,
      players: true,
    },
  };
}

function buildMatch(event, leagueData, teams, usedAbbr) {
  const competition = event.competitions?.[0];
  if (!competition) return null;
  const home = competition.competitors?.find((item) => item.homeAway === "home");
  const away = competition.competitors?.find((item) => item.homeAway === "away");
  if (!home?.team || !away?.team) return null;

  const venue = competition.venue || {};
  const homeTeam = createTeam(leagueData, home, venue, usedAbbr, teams);
  const awayTeam = createTeam(leagueData, away, venue, usedAbbr, teams);
  teams[homeTeam.id] = homeTeam;
  teams[awayTeam.id] = awayTeam;

  const leagueContext = {
    id: leagueData.league.id,
    name: leagueData.league.name,
    short: leagueData.league.short,
    season: leagueData.season,
    avgGoals: leagueData.avgGoals,
    homeFactor: leagueData.homeFactor,
    awayFactor: leagueData.awayFactor,
    avgCards: leagueData.avgCards,
    avgCorners: leagueData.avgCorners,
    rho: leagueData.rho,
    demo: false,
    live: true,
    source: "ESPN",
    estimatedAverages: true,
  };

  return {
    id: `espn-${event.id}`,
    home: homeTeam.id,
    away: awayTeam.id,
    type: "league",
    competition: leagueData.league.name,
    stage: TYPE_LABELS.league,
    headline: `${leagueData.league.name} · ${leagueData.season}`,
    date: event.date,
    timezone: leagueData.league.timezone,
    venue: venue.fullName || "Sede por confirmar",
    city: venue.address?.city || "",
    country: venue.address?.country || leagueData.league.country,
    neutral: false,
    altitude: 0,
    referee: {
      name: "Por confirmar",
      cardsPerMatch: leagueData.avgCards,
      penaltiesPerMatch: 0.25,
      used_for_model: false,
    },
    weather: {
      condition: "Sin dato",
      temp: null,
      wind: null,
      used_for_model: false,
    },
    rest: { home: 4, away: 4 },
    travelKm: { home: 0, away: 0 },
    motivation: { home: 1, away: 1 },
    rivalry: false,
    lineups: {
      home: { attackDelta: 0, defenseDelta: 0, absences: [], note: "Sin alineación confirmada." },
      away: { attackDelta: 0, defenseDelta: 0, absences: [], note: "Sin alineación confirmada." },
    },
    note: `Fuerzas calculadas con la tabla de ${leagueData.league.name} (${leagueData.season}). Forma reciente y sede de ESPN. Sin alineaciones confirmadas; el clima y el árbitro no entran en el cálculo.`,
    leagueContext,
    source: {
      name: "ESPN",
      url: "https://www.espn.com/soccer/",
      eventId: String(event.id),
      leagueId: leagueData.league.id,
      updated: new Date().toISOString(),
    },
    espn: {
      eventId: String(event.id),
      leagueId: leagueData.league.id,
      homeTeamId: homeTeam.espnId,
      awayTeamId: awayTeam.espnId,
      status: competition.status?.type?.name || "",
    },
  };
}

function tableForLeague(leagueData) {
  return {
    name: leagueData.league.name,
    short: leagueData.league.short,
    season: leagueData.season,
    updated: new Date().toISOString(),
    standings: leagueData.standings.map((entry) => ({
      id: entry.teamId,
      team: entry.team,
      short: entry.short,
      logo: entry.logo,
      pos: entry.pos,
      pj: entry.pj,
      pg: entry.pg,
      pe: entry.pe,
      pp: entry.pp,
      gf: entry.gf,
      gc: entry.gc,
      dg: entry.dg,
      pts: entry.pts,
      group: entry.group,
      zone: entry.zone,
    })),
  };
}

export async function buildDataset(options = {}) {
  const opts = {
    days: 7,
    max: 120,
    cache: true,
    verbose: false,
    leagueIds: [],
    history: true,
    validation: true,
    players: true,
    ...options,
  };

  const selectedLeagues = opts.leagueIds.length
    ? LEAGUES.filter((league) => opts.leagueIds.includes(league.id))
    : LEAGUES;

  if (!selectedLeagues.length) {
    throw new Error(`No hay ligas que coincidan con: ${opts.leagueIds.join(", ")}`);
  }

  const standingsResults = await mapLimit(selectedLeagues, 4, async (league) => {
    try {
      const data = await fetchStandings(league, opts);
      if (opts.verbose) {
        console.log(`  tabla  ${league.id.padEnd(18)} ${data.standings.length} equipos · ${data.avgGoals} goles/equipo`);
      }
      return data;
    } catch (error) {
      console.warn(`Aviso: no se pudo cargar la tabla de ${league.name}: ${error.message}`);
      return null;
    }
  });
  const standings = standingsResults.filter(Boolean);

  const dates = Array.from({ length: opts.days }, (_, index) => dateStamp(index));
  const jobs = [];
  for (const leagueData of standings) {
    for (const date of dates) {
      jobs.push({ leagueData, date });
    }
  }

  const scoreboardResults = await mapLimit(jobs, 4, async ({ leagueData, date }) => {
    try {
      const events = await fetchScoreboard(leagueData.league, date, opts);
      return events.map((event) => ({ event, leagueData }));
    } catch (error) {
      console.warn(`Aviso: no se pudo cargar ${leagueData.league.name} ${date}: ${error.message}`);
      return [];
    }
  });

  const now = Date.now() - 10 * 60 * 1000;
  const seen = new Set();
  const candidates = [];
  for (const item of scoreboardResults.flat()) {
    const event = item.event;
    if (!event?.id || seen.has(String(event.id))) continue;
    const competition = event.competitions?.[0];
    const state = competition?.status?.type?.state;
    const start = new Date(event.date).getTime();
    if (state !== "pre") continue;
    if (!Number.isFinite(start) || start < now) continue;
    seen.add(String(event.id));
    candidates.push(item);
  }

  candidates.sort((a, b) => new Date(a.event.date) - new Date(b.event.date));
  const selected = candidates.slice(0, opts.max);

  const teams = {};
  const usedAbbrByLeague = new Map();
  const matches = [];
  const usedLeagues = new Set();

  for (const { event, leagueData } of selected) {
    if (!usedAbbrByLeague.has(leagueData.league.id)) usedAbbrByLeague.set(leagueData.league.id, new Set());
    const match = buildMatch(event, leagueData, teams, usedAbbrByLeague.get(leagueData.league.id));
    if (match) {
      matches.push(match);
      usedLeagues.add(leagueData.league.id);
    }
  }

  const tables = {};
  for (const leagueData of standings) {
    if (usedLeagues.has(leagueData.league.id)) tables[leagueData.league.id] = tableForLeague(leagueData);
  }

  let historyMeta = null;
  let historyData = null;
  let validation = null;
  let latent = null;
  let playersMeta = null;
  if (opts.history !== false && Object.keys(teams).length) {
    if (opts.verbose) console.log("\nHistorial reciente y H2H (2 temporadas por equipo)...");
    historyData = await fetchHistories(teams, standings, opts);
    historyMeta = applyHistories(matches, teams, standings, historyData);
    if (opts.verbose) {
      console.log(`  historial  ${historyMeta.teams} equipos · ${historyMeta.events} partidos · ${historyMeta.recentTeams} con muestra reciente`);
    }
    if (opts.validation !== false && historyData.events.length) {
      if (opts.verbose) console.log("Validación walk-forward...");
      validation = runBacktest(historyData.events, {
        leagues: standings.map((item) => item.league),
      });
      if (opts.verbose) {
        console.log(`  backtest   ${validation.sample.matches} partidos evaluados · ${validation.leagues.length} ligas`);
      }
    }
    if (opts.players !== false && historyData.events.length) {
      if (opts.verbose) console.log("\nJugadores y cronología (2 partidos por equipo)...");
      playersMeta = await attachPlayerForm(teams, standings, historyData, opts);
      if (opts.verbose) {
        console.log(`  jugadores  ${playersMeta.teams} equipos · ${playersMeta.matches} partidos · ${playersMeta.summaries} resúmenes · tiros reales ${playersMeta.shotsDerived}/${playersMeta.teams}`);
      }
    }
    if (historyData.events.length) {
      if (opts.verbose) console.log("Equipos latentes y sorpresas...");
      latent = buildLatentData({
        leagues: standings.map((item) => ({
          id: item.league.id,
          name: item.league.name,
          short: item.league.short,
        })),
        tables,
        events: historyData.events,
        matches,
        teams,
      });
      if (opts.verbose) {
        console.log(`  latentes   ${latent.summary.midTableTeams} equipos · ${latent.summary.upsets} sorpresas · ${latent.summary.streakSamples} casos de racha`);
      }
    }
  }

  const avgGoals = standings.length
    ? round(standings.reduce((sum, item) => sum + item.avgGoals, 0) / standings.length, 3)
    : 1.35;

  const league = {
    id: "live-espn",
    name: "Fútbol internacional",
    season: "Temporada en curso",
    avgGoals,
    homeFactor: 1.10,
    awayFactor: 0.92,
    avgCards: 4.5,
    avgCorners: 10.2,
    rho: -0.05,
    demo: false,
    live: true,
    source: "ESPN",
    sourceUrl: "https://www.espn.com/soccer/",
    updated: new Date().toISOString(),
    matchCount: matches.length,
    leagueCount: usedLeagues.size,
    teamCount: Object.keys(teams).length,
    historyEvents: historyMeta?.events || 0,
    historyTeams: historyMeta?.teams || 0,
    onTargetRates: playersMeta
      ? { derived: playersMeta.onTargetDerived, placeholder: playersMeta.onTargetPlaceholder }
      : null,
    shotRates: playersMeta
      ? { derived: playersMeta.shotsDerived, placeholder: playersMeta.shotsPlaceholder }
      : null,
    note: "Calendario, tablas, forma, sede y tiros por equipo: ESPN. Probabilidades y salidas: OX V1.0. Uso personal y educativo.",
  };

  return {
    league,
    typeLabels: TYPE_LABELS,
    filters: FILTERS,
    teams,
    matches,
    tables,
    validation,
    latent,
    meta: {
      dates,
      leagues: standings.length,
      candidates: candidates.length,
      matches: matches.length,
      teams: Object.keys(teams).length,
      usedLeagues: [...usedLeagues],
      history: historyMeta,
      players: playersMeta,
      onTargetRates: playersMeta
        ? { derived: playersMeta.onTargetDerived, placeholder: playersMeta.onTargetPlaceholder }
        : null,
      shotRates: playersMeta
        ? { derived: playersMeta.shotsDerived, placeholder: playersMeta.shotsPlaceholder }
        : null,
      validation: validation
        ? { matches: validation.sample.matches, leagues: validation.leagues.length }
        : null,
      latent: latent
        ? { midTableTeams: latent.summary.midTableTeams, upsets: latent.summary.upsets }
        : null,
    },
  };
}

function jsHeader() {
  const stamp = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
  return [
    `// Generado por datos_live.mjs el ${stamp}.`,
    "// Fuente de datos: ESPN (calendario, tablas, forma y sede).",
    "// Probabilidades y salidas: motor propio de OX V1.0.",
    "// No edites este archivo a mano; ejecuta: node datos_live.mjs",
    "",
  ].join("\n");
}

async function copyIfMissing(sourceDir, targetDir, files) {
  if (!(await exists(targetDir))) {
    await mkdir(targetDir, { recursive: true });
  }
  for (const file of files) {
    const source = join(sourceDir, file);
    const target = join(targetDir, file);
    if ((await exists(source)) && !(await exists(target))) {
      await copyFile(source, target);
    }
  }
}

async function readUpdateState() {
  try {
    const text = await readFile(UPDATE_STATE, "utf8");
    const state = JSON.parse(text);
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

async function writeUpdateState(dataset) {
  await mkdir(dirname(UPDATE_STATE), { recursive: true });
  const now = Date.now();
  const upcoming = (dataset.matches || [])
    .map((match) => new Date(match.date).getTime())
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= now - 2 * 3_600_000)
    .sort((a, b) => a - b);
  const nextMatchAt = upcoming.length ? new Date(upcoming[0]).toISOString() : null;
  const matchday = upcoming.some((timestamp) => timestamp - now <= 36 * 3_600_000);
  const payload = {
    version: "1.1",
    finishedAt: new Date().toISOString(),
    matches: dataset.matches?.length || 0,
    leagues: dataset.league?.leagueCount || 0,
    teams: dataset.teams ? Object.keys(dataset.teams).length : 0,
    source: dataset.league?.source || "ESPN",
    shotRates: dataset.league?.shotRates || null,
    nextMatchAt,
    matchday,
  };
  await writeFile(UPDATE_STATE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeAlert(error) {
  const alertPath = join(BASE_DIR, "data", "alerts.json");
  let alerts = [];
  try {
    const parsed = JSON.parse(await readFile(alertPath, "utf8"));
    if (Array.isArray(parsed)) alerts = parsed;
  } catch {
    alerts = [];
  }
  alerts.push({
    at: new Date().toISOString(),
    message: error?.message || String(error),
    context: { stack: String(error?.stack || "").split("\n").slice(0, 6) },
  });
  await mkdir(dirname(alertPath), { recursive: true });
  await writeFile(alertPath, `${JSON.stringify(alerts.slice(-50), null, 2)}\n`, "utf8");
  try {
    await appendFile(
      join(BASE_DIR, "actualizacion_live.log"),
      `[${new Date().toISOString()}] ALERTA ${error?.message || error}\n`,
      "utf8",
    );
  } catch {
    // el log es best-effort; la alerta JSON ya quedó escrita
  }
}

export async function writeDataset(dataset, options = {}) {
  const outDir = resolve(options.outDir || DATA_DIR);
  await mkdir(outDir, { recursive: true });

  if (!options.noBackup) {
    const currentLeague = join(outDir, "league.js");
    if (await exists(currentLeague)) {
      const text = await readFile(currentLeague, "utf8");
      if (/demo\s*:\s*true/.test(text)) {
        await copyIfMissing(outDir, DEMO_BACKUP, DATA_FILES);
      }
      await copyIfMissing(outDir, PRE_LIVE_BACKUP, DATA_FILES);
    }
  }

  const header = jsHeader();
  const leagueJs = `${header}export const LEAGUE = ${JSON.stringify(dataset.league, null, 2)};\n\n`
    + `export const TYPE_LABELS = ${JSON.stringify(dataset.typeLabels, null, 2)};\n\n`
    + `export const FILTERS = ${JSON.stringify(dataset.filters, null, 2)};\n`;
  const teamsJs = `${header}export const TEAMS = ${JSON.stringify(dataset.teams, null, 2)};\n`;
  const { baseJs, detailJs } = splitTeams(dataset.teams, header);
  const matchesJs = `${header}export const MATCHES = ${JSON.stringify(dataset.matches, null, 2)};\n`;
  const tablesJs = `${header}export const TABLES = ${JSON.stringify(dataset.tables, null, 2)};\n`;

  const files = [
    [join(outDir, "league.js"), leagueJs],
    [join(outDir, "teams.js"), teamsJs],
    [join(outDir, "teams_base.js"), baseJs],
    [join(outDir, "player_form.js"), detailJs],
    [join(outDir, "matches.js"), matchesJs],
    [join(outDir, "tables.js"), tablesJs],
  ];
  if (dataset.validation) {
    const validationJs = `${header}// Backtest walk-forward propio; no son datos de FutbolData Pro.\nexport const VALIDATION = ${JSON.stringify(dataset.validation, null, 2)};\n`;
    files.push([join(outDir, "validation.js"), validationJs]);
  }
  if (dataset.latent) {
    const latentJs = `${header}// Equipos latentes y sorpresas reconstruidas sin fuga de información.\nexport const LATENT = ${JSON.stringify(dataset.latent, null, 2)};\n`;
    files.push([join(outDir, "latent.js"), latentJs]);
  }
  for (const [path, content] of files) {
    await writeFile(path, content, "utf8");
  }
  if (options.trackState !== false && outDir === DATA_DIR) {
    await writeUpdateState(dataset);
  }
  return files.map(([path]) => path);
}

function parseArgs(argv) {
  const options = {
    days: 7,
    max: 120,
    cache: true,
    verbose: false,
    dryRun: false,
    noBackup: false,
    leagueIds: [],
    outDir: DATA_DIR,
    history: true,
    validation: true,
    players: true,
    scheduled: false,
    minHours: 6,
    minMatchdayMinutes: 15,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dias" || arg === "--days") options.days = Math.max(1, Math.min(14, Number(argv[++i]) || 7));
    else if (arg === "--max") options.max = Math.max(1, Number(argv[++i]) || 120);
    else if (arg === "--liga" || arg === "--league") options.leagueIds.push(String(argv[++i] || ""));
    else if (arg === "--salida" || arg === "--out") options.outDir = resolve(argv[++i] || DATA_DIR);
    else if (arg === "--sin-cache" || arg === "--no-cache") options.cache = false;
    else if (arg === "--sin-respaldo" || arg === "--no-backup") options.noBackup = true;
    else if (arg === "--sin-historial" || arg === "--no-history") options.history = false;
    else if (arg === "--sin-validacion" || arg === "--no-validation") options.validation = false;
    else if (arg === "--sin-jugadores" || arg === "--no-players") options.players = false;
    else if (arg === "--programado" || arg === "--scheduled") options.scheduled = true;
    else if (arg === "--min-horas" || arg === "--min-hours") {
      options.minHours = Math.max(1, Math.min(168, Number(argv[++i]) || 6));
    } else if (arg === "--min-minutos-dia" || arg === "--matchday-minutes") {
      options.minMatchdayMinutes = Math.max(5, Math.min(120, Number(argv[++i]) || 15));
    } else if (arg === "--forzar" || arg === "--force") options.force = true;
    else if (arg === "--verbose" || arg === "-v") options.verbose = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

function printHelp() {
  console.log(`AIFUT · OX V1.0 · datos live

Uso:
  node datos_live.mjs [opciones]

Opciones:
  --dias N          Días hacia adelante a consultar (1-14, por defecto 7)
  --max N           Máximo de partidos a incluir (por defecto 120)
  --liga ID         Limita a una liga (repetible). Ej.: --liga esp.1
  --salida RUTA     Carpeta de destino (por defecto js/data)
  --sin-cache       Ignora la caché local
  --sin-respaldo    No crea copias de seguridad
  --sin-historial   No descarga los últimos 10 partidos ni el H2H
  --sin-validacion  No ejecuta el backtest walk-forward
  --sin-jugadores   No descarga resúmenes de jugadores ni cronología
  --programado      Modo scheduler: omite si la última actualización es reciente
  --min-horas N     Horas mínimas fuera de día de partido (1-168, por defecto 6)
  --min-minutos-dia N  Minutos mínimos en día de partido (5-120, por defecto 15)
  --forzar          Ignora el enfriamiento del modo programado
  --dry-run         Descarga y resume, pero no escribe archivos
  --verbose         Muestra cada petición
  -h, --help        Esta ayuda

Ligas:
${LEAGUES.map((league) => `  ${league.id.padEnd(18)} ${league.name}`).join("\n")}
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.scheduled && !options.force) {
    const state = await readUpdateState();
    const finishedAt = state?.finishedAt ? new Date(state.finishedAt).getTime() : null;
    const matchday = state?.matchday === true;
    const minMinutes = matchday ? options.minMatchdayMinutes : options.minHours * 60;
    const minMs = minMinutes * 60_000;
    if (Number.isFinite(finishedAt) && finishedAt > 0) {
      const ageMs = Date.now() - finishedAt;
      if (ageMs >= 0 && ageMs < minMs) {
        const remaining = Math.max(1, Math.ceil((minMs - ageMs) / 60_000));
        console.log(`Actualización programada: la última terminó hace ${(ageMs / 60_000).toFixed(1)} min; faltan ~${remaining} min (${matchday ? "día de partido" : "fuera de día de partido"}). Se omite. Usa --forzar para ejecutar igual.`);
        return;
      }
    }
  }

  console.log("AIFUT · OX V1.0 · actualizando datos live desde ESPN");
  console.log(`Ventana: ${options.days} día(s) · máximo ${options.max} partidos${options.cache ? "" : " · sin caché"}`);
  const dataset = await buildDataset(options);

  console.log("");
  console.log(`Ligas con tabla: ${dataset.meta.leagues}`);
  console.log(`Partidos próximos encontrados: ${dataset.meta.candidates}`);
  console.log(`Partidos incluidos: ${dataset.matches.length}`);
  console.log(`Equipos: ${dataset.meta.teams}`);
  console.log(`Ligas en la cartelera: ${dataset.meta.usedLeagues.length}`);
  if (dataset.meta.history) {
    console.log(`Historial: ${dataset.meta.history.events} partidos · ${dataset.meta.history.recentTeams} equipos con muestra reciente`);
  }
  if (dataset.meta.validation) {
    console.log(`Validación: ${dataset.meta.validation.matches} partidos walk-forward · ${dataset.meta.validation.leagues} ligas`);
  }
  if (dataset.meta.players) {
    const p = dataset.meta.players;
    console.log(`Jugadores: ${p.teams} equipos · ${p.matches} partidos · ${p.summaries} resúmenes · tiros reales ${p.shotsDerived}/${p.teams}`);
  }

  const byLeague = new Map();
  for (const match of dataset.matches) {
    if (!byLeague.has(match.competition)) byLeague.set(match.competition, []);
    byLeague.get(match.competition).push(match);
  }
  for (const [league, matches] of byLeague) {
    console.log(`  ${league}: ${matches.length}`);
  }

  if (options.dryRun) {
    console.log("\nPrimeros partidos:");
    for (const match of dataset.matches.slice(0, 12)) {
      const home = dataset.teams[match.home];
      const away = dataset.teams[match.away];
      console.log(`  ${match.date}  ${home.name} vs ${away.name}  (${match.competition})`);
    }
    console.log("\n--dry-run: no se escribió ningún archivo.");
    return;
  }

  const files = await writeDataset(dataset, options);
  console.log("\nArchivos generados:");
  for (const file of files) console.log(`  - ${file}`);
  console.log("\nRecarga http://127.0.0.1:4173");
  console.log("Para volver a los datos de respaldo: python mis_datos.py --restaurar");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeAlert(error);
    console.error(`\nError: ${error.message}`);
    process.exitCode = 1;
  });
}

