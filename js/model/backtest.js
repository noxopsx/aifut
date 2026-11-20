// Backtest walk-forward propio de MOTOR-NOX.
// ======================================
//
// Evalúa el mismo motor que usa la interfaz, pero en orden temporal: para cada
// partido del tramo de test solo se usan resultados anteriores. No hay fuga de
// información ni alineaciones retroactivas.
//
// La validación no es una promesa de precisión: es una foto honesta de cómo se
// habría comportado el modelo con los datos disponibles en ese momento.

import { computeCore } from "./core.js";
import { ENGINE } from "./calibration.js";
import {
  blendStrength,
  buildH2H,
  computeRecentProfile,
  computeSeasonProfile,
  matchDateMs,
} from "./ratings.js";

export const BACKTEST_VERSION = "1.0";
export const HOLDOUT_SHARE = 0.3;
export const MIN_TEAM_MATCHES = 4;
export const MIN_LEAGUE_MATCHES = 20;

const MARKETS = [
  { id: "1x2", label: "1X2", kind: "multi" },
  { id: "btts", label: "Ambos anotan", kind: "binary" },
  { id: "over15", label: "Más de 1.5", kind: "binary" },
  { id: "over25", label: "Más de 2.5", kind: "binary" },
  { id: "over35", label: "Más de 3.5", kind: "binary" },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const EPS = 1e-15;

function outcomeOf(match) {
  if (match.homeGoals > match.awayGoals) return [1, 0, 0];
  if (match.homeGoals < match.awayGoals) return [0, 0, 1];
  return [0, 1, 0];
}

function binaryOutcome(match, market) {
  const total = match.homeGoals + match.awayGoals;
  if (market === "btts") return match.homeGoals > 0 && match.awayGoals > 0 ? 1 : 0;
  if (market === "over15") return total > 1.5 ? 1 : 0;
  if (market === "over25") return total > 2.5 ? 1 : 0;
  if (market === "over35") return total > 3.5 ? 1 : 0;
  return 0;
}

function brier1x2(probs, outcome) {
  return (probs.home - outcome[0]) ** 2
    + (probs.draw - outcome[1]) ** 2
    + (probs.away - outcome[2]) ** 2;
}

function brierBinary(p, outcome) {
  return (p - outcome) ** 2;
}

function logLoss1x2(probs, outcome) {
  const pH = clamp(probs.home, EPS, 1 - EPS);
  const pD = clamp(probs.draw, EPS, 1 - EPS);
  const pA = clamp(probs.away, EPS, 1 - EPS);
  return -(outcome[0] * Math.log(pH) + outcome[1] * Math.log(pD) + outcome[2] * Math.log(pA));
}

function logLossBinary(p, outcome) {
  const prob = clamp(p, EPS, 1 - EPS);
  return -(outcome * Math.log(prob) + (1 - outcome) * Math.log(1 - prob));
}

function emptyMarket() {
  return { n: 0, brier: 0, baseline: 0, skill: 0, logLoss: 0, logLossBaseline: 0, logLossSkill: 0 };
}

function finalizeMarket(entry) {
  if (!entry.n) return emptyMarket();
  const brier = entry.brier / entry.n;
  const baseline = entry.baseline / entry.n;
  const logLoss = entry.logLoss ? entry.logLoss / entry.n : 0;
  const logLossBaseline = entry.logLossBaseline ? entry.logLossBaseline / entry.n : 0;
  return {
    n: entry.n,
    brier,
    baseline,
    skill: baseline > 0 ? 1 - brier / baseline : 0,
    logLoss,
    logLossBaseline,
    logLossSkill: logLossBaseline > 0 ? 1 - logLoss / logLossBaseline : 0,
  };
}

function leagueAverage(priorMatches) {
  const n = priorMatches.length;
  const goals = priorMatches.reduce((sum, match) => sum + match.homeGoals + match.awayGoals, 0);
  // Media rodante con contracción hacia 1.35 goles por equipo.
  return clamp((goals + 1.35 * 2 * 8) / (2 * (n + 8)), 0.55, 2.6);
}

function priorTeamMatches(history, teamId, before) {
  const cutoff = matchDateMs(before);
  return (history || []).filter((match) => (
    match?.completed
    && (match.homeId === String(teamId) || match.awayId === String(teamId))
    && matchDateMs(match.date) < cutoff
  ));
}

function syntheticTeam(teamId, name, recent, season, strength) {
  return {
    id: String(teamId),
    name,
    short: name,
    abbr: name.slice(0, 3).toUpperCase(),
    attack: strength.attack,
    defense: strength.defense,
    seasonAttack: season.attack,
    seasonDefense: season.defense,
    strength,
    recent,
    form: recent.form,
    estimated: { shots: true },
    shotsFor: 0,
    shotsAgainst: 0,
  };
}

function syntheticMatch(match, h2h) {
  return {
    id: match.id,
    type: "league",
    neutral: false,
    rest: { home: 4, away: 4 },
    travelKm: { home: 0, away: 0 },
    altitude: 0,
    motivation: { home: 1, away: 1 },
    lineups: {
      home: { attackDelta: 0, defenseDelta: 0, absences: [] },
      away: { attackDelta: 0, defenseDelta: 0, absences: [] },
    },
    h2h,
  };
}

function leagueContext(config, avgGoals) {
  return {
    id: config.id,
    name: config.name,
    short: config.short || config.name,
    avgGoals,
    homeFactor: config.homeFactor,
    awayFactor: config.awayFactor,
    avgCards: config.avgCards,
    avgCorners: config.avgCorners,
    rho: config.rho,
    live: true,
  };
}

function buildTeamProfiles(match, histories, avgGoals) {
  const homeHistory = histories.get(`${match.leagueId}:${match.homeId}`) || [];
  const awayHistory = histories.get(`${match.leagueId}:${match.awayId}`) || [];
  const before = match.date;
  const seasonYear = match.season;
  const make = (teamId, name, history) => {
    const recent = computeRecentProfile(history, teamId, {
      before,
      leagueAvg: avgGoals,
      window: ENGINE.recentWindow,
      halfLifeDays: ENGINE.recentHalfLifeDays,
    });
    const season = computeSeasonProfile(history, teamId, {
      before,
      leagueAvg: avgGoals,
      seasonYear,
      shrink: 6,
    });
    const strength = blendStrength(season.attack, season.defense, recent);
    return { recent, season, strength, team: syntheticTeam(teamId, name, recent, season, strength) };
  };
  const home = make(match.homeId, match.homeName, homeHistory);
  const away = make(match.awayId, match.awayName, awayHistory);
  return { home, away, homeHistory, awayHistory };
}

function newAccumulator() {
  const markets = {};
  for (const market of MARKETS) {
    markets[market.id] = { n: 0, brier: 0, baseline: 0, logLoss: 0, logLossBaseline: 0 };
  }
  return markets;
}

function addMatch(acc, prediction, match, baselines) {
  const oneX2 = outcomeOf(match);
  acc["1x2"].n += 1;
  acc["1x2"].brier += brier1x2(prediction.probs, oneX2);
  acc["1x2"].baseline += brier1x2(baselines.oneX2, oneX2);
  acc["1x2"].logLoss += logLoss1x2(prediction.probs, oneX2);
  acc["1x2"].logLossBaseline += logLoss1x2(baselines.oneX2, oneX2);

  for (const market of ["btts", "over15", "over25", "over35"]) {
    const y = binaryOutcome(match, market);
    acc[market].n += 1;
    acc[market].brier += brierBinary(prediction[market], y);
    acc[market].baseline += brierBinary(baselines[market], y);
    acc[market].logLoss += logLossBinary(prediction[market], y);
    acc[market].logLossBaseline += logLossBinary(baselines[market], y);
  }
}

function finalizeAccumulator(acc) {
  const markets = {};
  for (const market of MARKETS) markets[market.id] = finalizeMarket(acc[market.id]);
  return markets;
}

function addCalibration(bins, probability, outcome) {
  const p = clamp(Number(probability) || 0, 0, 1);
  const index = Math.min(9, Math.floor(p * 10));
  const bin = bins[index];
  bin.n += 1;
  bin.predicted += p;
  bin.observed += outcome;
}

function finalizeBins(bins) {
  return bins
    .map((bin, index) => ({
      from: index / 10,
      to: (index + 1) / 10,
      n: bin.n,
      predicted: bin.n ? bin.predicted / bin.n : null,
      observed: bin.n ? bin.observed / bin.n : null,
      error: bin.n ? Math.abs(bin.predicted / bin.n - bin.observed / bin.n) : null,
    }))
    .filter((bin) => bin.n > 0);
}

function emptyBins() {
  return Array.from({ length: 10 }, () => ({ n: 0, predicted: 0, observed: 0 }));
}

function monthKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// events: array de partidos normalizados (solo completados), con leagueId.
// leagues: configuración de cada liga (id, name, homeFactor, awayFactor, rho...).
export function runBacktest(events, options = {}) {
  const {
    leagues = [],
    holdout = HOLDOUT_SHARE,
    minTeamMatches = MIN_TEAM_MATCHES,
    minLeagueMatches = MIN_LEAGUE_MATCHES,
    // Uso interno de la pipeline histórica: devuelve una fila por partido
    // evaluado. La UI no lo activa para no inflar validation.js.
    collectRows = false,
  } = options;

  const configs = new Map(leagues.map((league) => [league.id, league]));
  const byLeague = new Map();
  for (const event of events || []) {
    if (!event?.completed) continue;
    if (!configs.has(event.leagueId)) continue;
    const list = byLeague.get(event.leagueId) || [];
    list.push(event);
    byLeague.set(event.leagueId, list);
  }

  const histories = new Map();
  for (const [leagueId, list] of byLeague) {
    for (const match of list) {
      for (const [teamId, name] of [[match.homeId, match.homeName], [match.awayId, match.awayName]]) {
        const key = `${leagueId}:${teamId}`;
        const history = histories.get(key) || [];
        history.push(match);
        histories.set(key, history);
      }
    }
  }
  for (const history of histories.values()) {
    history.sort((a, b) => matchDateMs(a.date) - matchDateMs(b.date));
  }

  const overallAcc = newAccumulator();
  const leagueRows = [];
  const hitRows = [];
  const predictionRows = [];
  const calibration = {
    oneX2: emptyBins(),
    btts: emptyBins(),
    over25: emptyBins(),
  };
  const timeline = new Map();
  let evaluated = 0;
  let skipped = 0;
  let firstDate = null;
  let lastDate = null;
  const testWindows = [];

  for (const [leagueId, list] of byLeague) {
    const config = configs.get(leagueId);
    const sorted = [...list].sort((a, b) => matchDateMs(a.date) - matchDateMs(b.date));
    const n = sorted.length;
    const testStart = Math.max(minLeagueMatches, Math.floor(n * (1 - holdout)));
    const acc = newAccumulator();
    let leagueEvaluated = 0;
    let leagueSkipped = 0;
    let leagueHits = 0;

    for (let index = 0; index < n; index += 1) {
      const match = sorted[index];
      if (index < testStart) continue;
      const priorLeague = sorted.slice(0, index);
      if (priorLeague.length < minLeagueMatches) {
        skipped += 1;
        leagueSkipped += 1;
        continue;
      }
      const homeHistory = histories.get(`${leagueId}:${match.homeId}`) || [];
      const awayHistory = histories.get(`${leagueId}:${match.awayId}`) || [];
      const priorHome = priorTeamMatches(homeHistory, match.homeId, match.date);
      const priorAway = priorTeamMatches(awayHistory, match.awayId, match.date);
      if (priorHome.length < minTeamMatches || priorAway.length < minTeamMatches) {
        skipped += 1;
        leagueSkipped += 1;
        continue;
      }

      const avgGoals = leagueAverage(priorLeague);
      const profiles = buildTeamProfiles(match, histories, avgGoals);
      const h2h = buildH2H(priorHome, priorAway, {
        homeId: match.homeId,
        awayId: match.awayId,
        before: match.date,
        limit: ENGINE.h2hMaxMatches,
      });
      const context = leagueContext(config, avgGoals);
      let core;
      try {
        core = computeCore(
          syntheticMatch(match, h2h),
          profiles.home.team,
          profiles.away.team,
          context,
        );
      } catch {
        skipped += 1;
        leagueSkipped += 1;
        continue;
      }

      const priorHomeWins = priorLeague.filter((m) => m.homeGoals > m.awayGoals).length;
      const priorDraws = priorLeague.filter((m) => m.homeGoals === m.awayGoals).length;
      const priorAwayWins = priorLeague.length - priorHomeWins - priorDraws;
      const totalPrior = priorLeague.length;
      const baselines = {
        oneX2: {
          home: (priorHomeWins + 1) / (totalPrior + 3),
          draw: (priorDraws + 1) / (totalPrior + 3),
          away: (priorAwayWins + 1) / (totalPrior + 3),
        },
        btts: (priorLeague.filter((m) => m.homeGoals > 0 && m.awayGoals > 0).length + 1) / (totalPrior + 2),
        over15: (priorLeague.filter((m) => m.homeGoals + m.awayGoals > 1.5).length + 1) / (totalPrior + 2),
        over25: (priorLeague.filter((m) => m.homeGoals + m.awayGoals > 2.5).length + 1) / (totalPrior + 2),
        over35: (priorLeague.filter((m) => m.homeGoals + m.awayGoals > 3.5).length + 1) / (totalPrior + 2),
      };

      const prediction = {
        probs: core.probs,
        btts: core.btts,
        over15: core.over15,
        over25: core.over25,
        over35: core.over35,
      };

      addMatch(acc, prediction, match, baselines);
      addMatch(overallAcc, prediction, match, baselines);
      evaluated += 1;
      leagueEvaluated += 1;

      if (collectRows) {
        predictionRows.push({
          matchId: match.id,
          date: match.date,
          leagueId,
          season: match.season,
          homeId: match.homeId,
          awayId: match.awayId,
          homeGoals: match.homeGoals,
          awayGoals: match.awayGoals,
          probs: { home: core.probs.home, draw: core.probs.draw, away: core.probs.away },
          btts: core.btts,
          over15: core.over15,
          over25: core.over25,
          over35: core.over35,
          lambdaHome: core.lambdaHome,
          lambdaAway: core.lambdaAway,
        });
      }

      const oneX2 = outcomeOf(match);
      const pick = core.probs.home >= core.probs.draw && core.probs.home >= core.probs.away
        ? "home"
        : core.probs.away >= core.probs.draw ? "away" : "draw";
      const actual = oneX2[0] ? "home" : oneX2[1] ? "draw" : "away";
      const hit = pick === actual;
      if (hit) leagueHits += 1;
      hitRows.push({
        date: match.date,
        leagueId,
        leagueName: config.name,
        homeName: match.homeName,
        awayName: match.awayName,
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals,
        pick,
        pickLabel: pick === "home" ? "Local" : pick === "draw" ? "Empate" : "Visitante",
        probability: core.probs[pick],
        actual,
        actualLabel: actual === "home" ? "Local" : actual === "draw" ? "Empate" : "Visitante",
        hit,
      });
      addCalibration(calibration.oneX2, core.probs.home, oneX2[0]);
      addCalibration(calibration.oneX2, core.probs.draw, oneX2[1]);
      addCalibration(calibration.oneX2, core.probs.away, oneX2[2]);
      addCalibration(calibration.btts, core.btts, binaryOutcome(match, "btts"));
      addCalibration(calibration.over25, core.over25, binaryOutcome(match, "over25"));

      const key = monthKey(match.date);
      if (key) {
        const row = timeline.get(key) || { month: key, n: 0, brier: 0, baseline: 0 };
        row.n += 1;
        row.brier += brier1x2(core.probs, oneX2);
        row.baseline += brier1x2(baselines.oneX2, oneX2);
        timeline.set(key, row);
      }

      if (!firstDate || matchDateMs(match.date) < matchDateMs(firstDate)) firstDate = match.date;
      if (!lastDate || matchDateMs(match.date) > matchDateMs(lastDate)) lastDate = match.date;
    }

    if (leagueEvaluated > 0) {
      leagueRows.push({
        id: leagueId,
        name: config.name,
        n: leagueEvaluated,
        skipped: leagueSkipped,
        hits: leagueHits,
        hitRate: leagueEvaluated ? leagueHits / leagueEvaluated : 0,
        markets: finalizeAccumulator(acc),
      });
    }
    testWindows.push({
      id: leagueId,
      name: config.name,
      total: n,
      testStart,
      testFrom: sorted[testStart]?.date || null,
    });
  }

  const markets = finalizeAccumulator(overallAcc);
  const leaguesRows = leagueRows.sort((a, b) => b.n - a.n);
  const timelineRows = [...timeline.values()]
    .filter((row) => row.n >= 5)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((row) => ({
      month: row.month,
      n: row.n,
      brier: row.brier / row.n,
      baseline: row.baseline / row.n,
      skill: row.baseline > 0 ? 1 - (row.brier / row.n) / (row.baseline / row.n) : 0,
    }));

  const chronologicalHits = [...hitRows].sort((a, b) => matchDateMs(a.date) - matchDateMs(b.date));
  let currentStreak = 0;
  let bestStreak = 0;
  for (const row of chronologicalHits) {
    if (row.hit) {
      currentStreak += 1;
      if (currentStreak > bestStreak) bestStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }
  const totalHits = chronologicalHits.filter((row) => row.hit).length;
  const recentHits = [...chronologicalHits]
    .sort((a, b) => matchDateMs(b.date) - matchDateMs(a.date))
    .slice(0, 40)
    .map((row) => ({ ...row, probability: Number(row.probability.toFixed(4)) }));
  const hits = {
    n: chronologicalHits.length,
    hits: totalHits,
    rate: chronologicalHits.length ? totalHits / chronologicalHits.length : 0,
    currentStreak,
    bestStreak,
    recent: recentHits,
    byLeague: leagueRows
      .map((row) => ({
        id: row.id,
        name: row.name,
        n: row.n,
        hits: row.hits,
        rate: row.hitRate,
      }))
      .sort((a, b) => b.n - a.n),
  };

  return {
    version: BACKTEST_VERSION,
    engine: ENGINE.id,
    engineVersion: ENGINE.version,
    method: "walk-forward",
    holdout,
    generatedAt: new Date().toISOString(),
    minTeamMatches,
    minLeagueMatches,
    sample: {
      matches: evaluated,
      skipped,
      leagues: leaguesRows.length,
      from: firstDate,
      to: lastDate,
      events: events?.length || 0,
    },
    markets: MARKETS.map((market) => ({ id: market.id, label: market.label, kind: market.kind })),
    overall: {
      n: evaluated,
      markets,
    },
    hits,
    leagues: leaguesRows,
    calibration: {
      oneX2: finalizeBins(calibration.oneX2),
      btts: finalizeBins(calibration.btts),
      over25: finalizeBins(calibration.over25),
    },
    timeline: timelineRows,
    testWindows,
    ...(collectRows ? { rows: predictionRows } : {}),
    notes: [
      "Solo se evalúan partidos del último 30% de cada liga; cada predicción usa exclusivamente resultados anteriores.",
      "No se usan alineaciones; el clima y el árbitro están excluidos del cálculo: el backtest mide el núcleo del motor, no el contexto completo.",
      "La tabla de temporada se reconstruye con los goles previos del mismo historial; en live, la app usa la tabla real de ESPN.",
      "El Brier es un error cuadrático: menor es mejor. El baseline es la frecuencia previa de cada mercado en la misma liga.",
      "El historial de aciertos cuenta solo el resultado 1X2 más probable del modelo: acierta si coincide con el signo final. No es una recomendación.",
      "Una muestra de dos temporadas no garantiza el futuro; los resultados por liga pueden variar mucho.",
    ],
  };
}
