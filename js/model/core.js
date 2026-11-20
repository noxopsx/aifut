import { TYPE_LABELS } from "../data/league.js";
import {
  ENGINE,
  binaryBaseRates,
  calibrateBinary,
  formFactor,
  shotsBlend,
  temperatureScale,
  venueFactors,
} from "./calibration.js";
import {
  buildMatrix,
  clamp,
  matrixOver,
  poissonPmf,
  sliceMatrix,
  summarizeMatrix,
} from "./math.js";
import { comboLegs } from "./combo.js";
import { goalTiming, h2hFactor } from "./ratings.js";
import { buildTiebreak } from "./tiebreak.js";
import { evaluateEnsemble1X2, extractPreMatchFeatures } from "./ensemble.js";

export const MODEL_VERSION = "MOTOR-NOX V1.0";

export { buildMatrix, poissonPmf };

export function formatImpact(value, unit) {
  const sign = value > 0 ? "+" : "";
  if (unit === "pp") return `${sign}${value.toFixed(1)} pp`;
  if (unit === "goles") return `${sign}${value.toFixed(2)} goles`;
  if (unit === "tarjetas") return `${sign}${value.toFixed(2)} tarjetas`;
  if (unit === "córners") return `${sign}${value.toFixed(2)} córners`;
  if (unit === "tiros") return `${sign}${value.toFixed(2)} tiros`;
  return `${sign}${value.toFixed(2)} ${unit}`;
}

function logGamma(z) {
  const p = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = 0.9999999999998099;
  for (let i = 0; i < 8; i += 1) a += p[i] / (x + i + 1);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function nbPmf(k, mean, r) {
  if (mean <= 0) return k === 0 ? 1 : 0;
  return Math.exp(
    logGamma(k + r) - logGamma(r) - logGamma(k + 1)
    + r * Math.log(r / (r + mean))
    + k * Math.log(mean / (r + mean)),
  );
}

export function nbOver(line, mean, r) {
  let cdf = 0;
  const max = Math.floor(line);
  for (let k = 0; k <= max; k += 1) cdf += nbPmf(k, mean, r);
  return clamp(1 - cdf, 0, 1);
}

const restAttack = (days) => {
  if (days >= 6) return 1.02;
  if (days === 5) return 1.01;
  if (days === 4) return 1;
  if (days === 3) return 0.985;
  return 0.96;
};

const restConcede = (days) => 1 + (1 - restAttack(days)) * 0.55;

function travelFx(km = 0, rest = 4) {
  if (km >= 700 && rest <= 4) return { attack: 0.975, defense: 1.012 };
  if (km >= 400 && rest <= 3) return { attack: 0.985, defense: 1.006 };
  return { attack: 1, defense: 1 };
}

function altitudeFx(altitude = 0, awayAltitude = 0) {
  if (altitude >= 2000 && awayAltitude < 1200) return { home: 1.005, away: 0.975 };
  if (altitude >= 1500 && awayAltitude < 500) return { home: 1, away: 0.99 };
  return { home: 1, away: 1 };
}

function goalTypeFx(match) {
  const type = match.type;
  if (type === "friendly") return 0.94;
  if (type === "final") return 0.92;
  if (type === "quarterfinal") return match.leg === 2 ? 0.98 : 0.96;
  if (type === "semifinal") return match.leg === 2 ? 0.98 : 0.96;
  if (type === "round16" || type === "liguilla") return 0.98;
  return 1;
}

function aggregateFx(match) {
  if (match.leg !== 2 || !match.aggregate) return { home: 1, away: 1 };
  const diff = (match.aggregate.home || 0) - (match.aggregate.away || 0);
  if (diff < 0) return { home: 1.06, away: 1.02 };
  if (diff > 0) return { home: 1.02, away: 1.06 };
  return { home: 1, away: 1 };
}

function lineupFx(match) {
  const homeAttack = 1 + clamp(match.lineups?.home?.attackDelta || 0, -0.3, 0.1);
  const awayAttack = 1 + clamp(match.lineups?.away?.attackDelta || 0, -0.3, 0.1);
  const homeDefense = 1 + clamp(match.lineups?.home?.defenseDelta || 0, -0.1, 0.15);
  const awayDefense = 1 + clamp(match.lineups?.away?.defenseDelta || 0, -0.1, 0.15);
  return {
    home: homeAttack * awayDefense,
    away: awayAttack * homeDefense,
  };
}

export function computeCore(match, home, away, league, ignore = new Set()) {
  const steps = { home: [], away: [] };
  let lambdaHome = league.avgGoals;
  let lambdaAway = league.avgGoals;
  const multipliers = {};

  steps.home.push({ key: "base", label: "Promedio de liga", multiplier: 1, value: lambdaHome });
  steps.away.push({ key: "base", label: "Promedio de liga", multiplier: 1, value: lambdaAway });

  const apply = (key, label, homeMult, awayMult) => {
    const h = ignore.has(key) ? 1 : homeMult;
    const a = ignore.has(key) ? 1 : awayMult;
    multipliers[key] = { home: homeMult, away: awayMult };
    lambdaHome *= h;
    lambdaAway *= a;
    steps.home.push({ key, label, multiplier: h, value: lambdaHome });
    steps.away.push({ key, label, multiplier: a, value: lambdaAway });
  };

  const useRecent = !ignore.has("recent");
  const homeSeason = {
    attack: clamp(Number(home.seasonAttack ?? home.attack ?? 1), 0.4, 2.5),
    defense: clamp(Number(home.seasonDefense ?? home.defense ?? 1), 0.4, 2.5),
  };
  const awaySeason = {
    attack: clamp(Number(away.seasonAttack ?? away.attack ?? 1), 0.4, 2.5),
    defense: clamp(Number(away.seasonDefense ?? away.defense ?? 1), 0.4, 2.5),
  };
  const homeStrength = useRecent
    ? {
      attack: clamp(Number(home.strength?.attack ?? home.attack ?? 1), 0.4, 2.5),
      defense: clamp(Number(home.strength?.defense ?? home.defense ?? 1), 0.4, 2.5),
      recentWeight: Number(home.strength?.recentWeight) || 0,
      source: home.strength?.source || "tabla",
    }
    : { ...homeSeason, recentWeight: 0, source: "tabla" };
  const awayStrength = useRecent
    ? {
      attack: clamp(Number(away.strength?.attack ?? away.attack ?? 1), 0.4, 2.5),
      defense: clamp(Number(away.strength?.defense ?? away.defense ?? 1), 0.4, 2.5),
      recentWeight: Number(away.strength?.recentWeight) || 0,
      source: away.strength?.source || "tabla",
    }
    : { ...awaySeason, recentWeight: 0, source: "tabla" };
  const blend = shotsBlend(home, away);
  const qualityHome = homeStrength.attack * awayStrength.defense;
  const qualityAway = awayStrength.attack * homeStrength.defense;
  const seasonQualityHome = homeSeason.attack * awaySeason.defense;
  const seasonQualityAway = awaySeason.attack * homeSeason.defense;
  multipliers.recent = {
    home: seasonQualityHome > 0 ? qualityHome / seasonQualityHome : 1,
    away: seasonQualityAway > 0 ? qualityAway / seasonQualityAway : 1,
  };
  apply("quality", "Calidad de plantilla", qualityHome, qualityAway);

  if (blend.applied) {
    apply("shots", "Blend de tiros", blend.multipliers.home, blend.multipliers.away);
  } else {
    multipliers.shots = { home: 1, away: 1 };
  }

  const formWeightHome = home.recent?.available ? ENGINE.formWeightRecent : ENGINE.formWeight;
  const formWeightAway = away.recent?.available ? ENGINE.formWeightRecent : ENGINE.formWeight;
  const formHome = formFactor(home.form, formWeightHome);
  const formAway = formFactor(away.form, formWeightAway);
  apply("form", "Forma reciente", formHome.applied, formAway.applied);

  const h2h = match.h2h || { available: false, played: 0, matches: [] };
  const h2hFx = h2hFactor(h2h, league);
  apply("h2h", "Historial directo", h2hFx.home, h2hFx.away);

  const venue = venueFactors(league);
  const venueHome = match.neutral ? 1 : venue.home;
  const venueAway = match.neutral ? 1 : venue.away;
  apply("venue", match.neutral ? "Sede neutral" : "Localía", venueHome, venueAway);

  const typeFx = goalTypeFx(match);
  apply("matchType", TYPE_LABELS[match.type] || "Partido", typeFx, typeFx);

  const lineup = lineupFx(match);
  apply("lineup", "Alineación", lineup.home, lineup.away);

  const restMeta = match.restMeta || {};
  const restDaysHome = Number(match.rest?.home);
  const restDaysAway = Number(match.rest?.away);
  const restKnownHome = Number.isFinite(restDaysHome) && restMeta.home?.observed !== false;
  const restKnownAway = Number.isFinite(restDaysAway) && restMeta.away?.observed !== false;
  const restHome = (restKnownHome ? restAttack(restDaysHome) : 1)
    * (restKnownAway ? restConcede(restDaysAway) : 1);
  const restAway = (restKnownAway ? restAttack(restDaysAway) : 1)
    * (restKnownHome ? restConcede(restDaysHome) : 1);
  apply("rest", "Descanso", restHome, restAway);

  const travelHome = travelFx(match.travelKm.home, match.rest.home);
  const travelAway = travelFx(match.travelKm.away, match.rest.away);
  apply("travel", "Viaje", travelHome.attack * travelAway.defense, travelAway.attack * travelHome.defense);

  const altitude = altitudeFx(match.altitude, away.altitude);
  apply("altitude", "Altitud", altitude.home, altitude.away);

  apply("motivation", "Motivación", match.motivation?.home || 1, match.motivation?.away || 1);

  const aggregate = aggregateFx(match);
  apply("aggregate", "Estado del global", aggregate.home, aggregate.away);

  lambdaHome = clamp(lambdaHome, 0.3, 4.2);
  lambdaAway = clamp(lambdaAway, 0.3, 4.2);

  const matrix = buildMatrix(lambdaHome, lambdaAway, league.rho);
  const summary = summarizeMatrix(matrix);
  const rawProbs = summary.probs;
  const probs = temperatureScale(rawProbs, ENGINE.temperature1x2);
  const rawBinary = {
    over15: matrixOver(matrix, 1.5),
    over25: matrixOver(matrix, 2.5),
    over35: matrixOver(matrix, 3.5),
    btts: summary.btts,
  };
  const binary = calibrateBinary(rawBinary, league);
  const bases = binaryBaseRates(league);
  const timing = goalTiming(lambdaHome, lambdaAway);
  const scoreMatrix = sliceMatrix(matrix, 7);

  return {
    lambdaHome,
    lambdaAway,
    matrix,
    probs,
    rawProbs,
    totals: summary.totals,
    btts: binary.btts,
    rawBtts: rawBinary.btts,
    over15: binary.over15,
    over25: binary.over25,
    over35: binary.over35,
    rawOver15: rawBinary.over15,
    rawOver25: rawBinary.over25,
    rawOver35: rawBinary.over35,
    topScores: summary.scores.slice(0, 6),
    timing,
    scoreMatrix,
    steps,
    multipliers,
    engine: {
      id: ENGINE.id,
      label: ENGINE.label,
      version: ENGINE.version,
      temperature: ENGINE.temperature1x2,
      binarySlope: ENGINE.binarySlope,
      formWeight: ENGINE.formWeight,
      formWeightRecent: ENGINE.formWeightRecent,
      shotsWeight: ENGINE.shotsBlendWeight,
      recentWeight: ENGINE.recentWeight,
      h2hWeight: ENGINE.h2hWeight,
      tiebreak: ENGINE.tiebreak,
      rawProbs,
      probs,
      rawBinary,
      binary,
      bases,
      form: { home: formHome, away: formAway },
      recent: {
        home: home.recent || null,
        away: away.recent || null,
        strength: { home: homeStrength, away: awayStrength },
      },
      h2h: { ...h2h, factor: h2hFx },
      rest: {
        home: {
          days: Number.isFinite(restDaysHome) ? restDaysHome : null,
          observed: restKnownHome,
          lastDate: restMeta.home?.lastDate || null,
        },
        away: {
          days: Number.isFinite(restDaysAway) ? restDaysAway : null,
          observed: restKnownAway,
          lastDate: restMeta.away?.lastDate || null,
        },
      },
      shots: blend,
      venue: {
        ...venue,
        neutral: Boolean(match.neutral),
        appliedHome: venueHome,
        appliedAway: venueAway,
      },
    },
  };
}

function typeShotsFx(match) {
  if (match.type === "friendly") return 0.97;
  if (match.type === "final") return 0.96;
  if (match.type === "quarterfinal" || match.type === "semifinal") return 0.98;
  return 1;
}

function typeCornersFx(match) {
  if (match.type === "friendly") return 0.95;
  if (match.type === "final") return 0.96;
  if (match.type === "quarterfinal" || match.type === "semifinal") return 0.98;
  return 1;
}

function typeCardsFx(match) {
  if (match.type === "friendly") return 0.82;
  if (match.type === "final") return 1.12;
  if (match.type === "quarterfinal" || match.type === "semifinal") return 1.05;
  return 1;
}

function buildMetrics(match, home, away, league, core) {
  const totalGoals = core.lambdaHome + core.lambdaAway;
  const goalPace = clamp(1 + (totalGoals - 2.7) * 0.04, 0.92, 1.08);

  const homeShotsBase = (home.shotsFor + away.shotsAgainst) / 2;
  const awayShotsBase = (away.shotsFor + home.shotsAgainst) / 2;
  const venueShotsHome = match.neutral ? 1 : 1.02;
  const venueShotsAway = match.neutral ? 1 : 0.98;
  const shotsType = typeShotsFx(match);
  const homeShots = homeShotsBase * goalPace * shotsType * venueShotsHome;
  const awayShots = awayShotsBase * goalPace * shotsType * venueShotsAway;
  const onTargetSourceOf = (team) => {
    if (team.onTargetRateSource) return team.onTargetRateSource;
    return Math.abs(Number(team.onTargetRate) - 0.34) < 1e-9 ? "placeholder" : "derived";
  };
  const homeOnTargetRate = clamp(Number(home.onTargetRate) || 0.34, 0.15, 0.65);
  const awayOnTargetRate = clamp(Number(away.onTargetRate) || 0.34, 0.15, 0.65);
  const homeOnTargetSource = onTargetSourceOf(home);
  const awayOnTargetSource = onTargetSourceOf(away);
  const shotsSourceOf = (team) => {
    const source = team.shotsSource
      || (team.estimated?.shots === true ? "estimated" : "observed");
    return source === "observed-shrunk" || source === "observed" ? "observed" : "estimated";
  };
  const homeShotsSource = shotsSourceOf(home);
  const awayShotsSource = shotsSourceOf(away);
  const shotsSource = homeShotsSource === "observed" && awayShotsSource === "observed"
    ? "observed"
    : "estimated";
  const homeShotsSample = home.shotsSample || null;
  const awayShotsSample = away.shotsSample || null;
  const shotsDetail = shotsSource === "observed"
    ? `Tiros reales de ${homeShotsSample?.matches ?? 0} y ${awayShotsSample?.matches ?? 0} partidos por equipo, contraídos al prior; la proyección del partido sigue siendo estimada.`
    : "Sin muestra real suficiente; los tiros se estiman desde fuerzas y ritmo.";
  const onTargetRateSource = homeOnTargetSource === "placeholder" && awayOnTargetSource === "placeholder"
    ? "placeholder"
    : "estimated";
  const placeholderTeams = [
    homeOnTargetSource === "placeholder" ? home.short : null,
    awayOnTargetSource === "placeholder" ? away.short : null,
  ].filter(Boolean);
  const onTargetRateDetail = placeholderTeams.length
    ? `Tasa placeholder en ${placeholderTeams.join(" y ")}.`
    : `Derivada de ${home.onTargetRateSample?.shots ?? 0} y ${away.onTargetRateSample?.shots ?? 0} tiros observados.`;

  const cornersType = typeCornersFx(match);
  const agg = aggregateFx(match);
  const aggCornersHome = agg.home > 1 ? 1.08 : agg.home < 1 ? 0.96 : 1;
  const aggCornersAway = agg.away > 1 ? 1.08 : agg.away < 1 ? 0.96 : 1;
  const homeCorners = ((home.cornersFor + away.cornersAgainst) / 2)
    * goalPace * cornersType * aggCornersHome * (match.neutral ? 1 : 1.02);
  const awayCorners = ((away.cornersFor + home.cornersAgainst) / 2)
    * goalPace * cornersType * aggCornersAway * (match.neutral ? 1 : 0.98);

  const rivalryFactor = match.rivalry ? 1.08 : 1;
  const cardsType = typeCardsFx(match);
  const homeCards = home.cards * rivalryFactor * cardsType;
  const awayCards = away.cards * rivalryFactor * cardsType;
  const totalCards = homeCards + awayCards;

  const homePossession = clamp(
    50 + (home.possession - away.possession) * 0.7 + (match.neutral ? 0 : 2.5),
    34,
    66,
  );

  return {
    goals: {
      home: core.lambdaHome,
      away: core.lambdaAway,
      total: totalGoals,
      over25: core.over25,
      over35: core.over35,
      btts: core.btts,
    },
    shots: {
      home: homeShots,
      away: awayShots,
      total: homeShots + awayShots,
      onTargetHome: homeShots * homeOnTargetRate,
      onTargetAway: awayShots * awayOnTargetRate,
      onTargetRateHome: homeOnTargetRate,
      onTargetRateAway: awayOnTargetRate,
      onTargetRateSource,
      onTargetRateDetail,
      onTargetSample: {
        home: home.onTargetRateSample || null,
        away: away.onTargetRateSample || null,
      },
      shotsSource,
      shotsDetail,
      shotsSample: {
        home: homeShotsSample,
        away: awayShotsSample,
      },
      components: [
        { label: "Volumen base", home: homeShotsBase, away: awayShotsBase },
        { label: "Ritmo de goles", home: goalPace, away: goalPace },
        { label: "Tipo de partido", home: shotsType, away: shotsType },
        { label: "Localía", home: venueShotsHome, away: venueShotsAway },
      ],
    },
    corners: {
      home: homeCorners,
      away: awayCorners,
      total: homeCorners + awayCorners,
      line: 9.5,
      over95: nbOver(9.5, homeCorners + awayCorners, 9),
      over105: nbOver(10.5, homeCorners + awayCorners, 9),
      components: [
        { label: "Promedio a favor/en contra", home: (home.cornersFor + away.cornersAgainst) / 2, away: (away.cornersFor + home.cornersAgainst) / 2 },
        { label: "Ritmo de goles", home: goalPace, away: goalPace },
        { label: "Tipo de partido", home: cornersType, away: cornersType },
        { label: "Estado del global", home: aggCornersHome, away: aggCornersAway },
      ],
    },
    cards: {
      home: homeCards,
      away: awayCards,
      total: totalCards,
      line: 4.5,
      over35: nbOver(3.5, totalCards, 6),
      over45: nbOver(4.5, totalCards, 6),
      over55: nbOver(5.5, totalCards, 6),
      components: [
        { label: "Disciplina base", home: home.cards, away: away.cards },
        { label: "Rivalidad", home: rivalryFactor, away: rivalryFactor },
        { label: "Tipo de partido", home: cardsType, away: cardsType },
      ],
    },
    possession: {
      home: homePossession,
      away: 100 - homePossession,
    },
  };
}

function buildPlayers(side, team, opponent, teamLambda, match, league) {
  const absent = new Set((match.lineups?.[side]?.absences || []).map((a) => a.name));
  const baseTeamXg = league.avgGoals * (team.strength?.attack ?? team.attack ?? 1);
  const listed = [];
  for (const player of team.players || []) {
    if (absent.has(player.name)) continue;
    const weight = player.xg90 * player.minutes * (1 + player.pen * 0.08);
    listed.push({
      ...player,
      weight,
      share: 0,
      lambda: 0,
      p: 0,
    });
  }
  const listedWeight = listed.reduce((sum, p) => sum + p.weight, 0);
  const residual = Math.max(0.15, baseTeamXg - listedWeight);
  const totalWeight = listedWeight + residual;
  const players = listed.map((player) => {
    const share = player.weight / totalWeight;
    const lambda = teamLambda * share;
    return {
      ...player,
      share,
      lambda,
      p: 1 - Math.exp(-lambda),
    };
  });
  players.sort((a, b) => b.p - a.p);
  return players.slice(0, 5).map((player, index) => ({
    ...player,
    rank: index + 1,
    key: `player:${side}:${index}`,
    teamSide: side,
    opponent,
  }));
}

function buildFactors(match, home, away, league, core, metrics) {
  const definitions = [
    { key: "quality", label: "Calidad", unit: "pp" },
    { key: "recent", label: "Últimos 10", unit: "pp" },
    { key: "form", label: "Forma", unit: "pp" },
    { key: "shots", label: "Blend de tiros", unit: "pp" },
    { key: "h2h", label: "Historial directo", unit: "pp" },
    { key: "venue", label: "Localía", unit: "pp" },
    { key: "lineup", label: "Alineación", unit: "pp" },
    { key: "rest", label: "Descanso", unit: "pp" },
    { key: "travel", label: "Viaje", unit: "pp" },
    { key: "matchType", label: "Tipo de partido", unit: "goles" },
    { key: "altitude", label: "Altitud", unit: "pp" },
    { key: "motivation", label: "Motivación", unit: "pp" },
    { key: "aggregate", label: "Global", unit: "goles" },
  ];

  return definitions.map((def) => {
    const without = computeCore(match, home, away, league, new Set([def.key]));
    const deltas = {
      home: (core.probs.home - without.probs.home) * 100,
      draw: (core.probs.draw - without.probs.draw) * 100,
      away: (core.probs.away - without.probs.away) * 100,
    };
    const goalDelta = (core.lambdaHome + core.lambdaAway)
      - (without.lambdaHome + without.lambdaAway);
    let primary = { value: deltas.home, unit: "pp" };
    if (def.unit === "goles") primary = { value: goalDelta, unit: "goles" };
    const tone = primary.value > 0.02 ? "pos" : primary.value < -0.02 ? "neg" : "neutral";
    return {
      ...def,
      ...primary,
      impactLabel: formatImpact(primary.value, primary.unit),
      deltas,
      goalDelta,
      multipliers: core.multipliers[def.key],
      detail: factorDetail(def.key, match, home, away, league),
      tone,
      homeMult: core.multipliers[def.key]?.home ?? 1,
      awayMult: core.multipliers[def.key]?.away ?? 1,
      withoutLambda: { home: without.lambdaHome, away: without.lambdaAway },
    };
  });
}

function factorDetail(key, match, home, away, league = {}) {
  const live = Boolean(match.leagueContext?.live);
  const homeAbs = match.lineups?.home?.absences || [];
  const awayAbs = match.lineups?.away?.absences || [];
  switch (key) {
    case "quality":
      return `${home.short} ataque ${home.attack.toFixed(2)} · ${away.short} defensa ${away.defense.toFixed(2)}`;
    case "recent": {
      const describe = (team, profile) => profile?.available
        ? `${team.short}: ${profile.sample} partidos, ${profile.gfPerMatch.toFixed(2)} GF / ${profile.gaPerMatch.toFixed(2)} GC (×${(team.strength?.recentWeight ?? 0).toFixed(2)})`
        : `${team.short}: sin muestra reciente`;
      return `${describe(home, home.recent)} · ${describe(away, away.recent)}. Ventana ${ENGINE.recentWindow}, vida media ${ENGINE.recentHalfLifeDays} días.`;
    }
    case "h2h": {
      if (!match.h2h?.available) return "Sin enfrentamientos directos suficientes en la muestra de ESPN.";
      return `${match.h2h.played} partidos: ${home.short} ${match.h2h.homeWins} victorias, ${match.h2h.draws} empates, ${away.short} ${match.h2h.awayWins}. Peso ${Math.round((h2hFactor(match.h2h, league).weight || 0) * 100)}%.`;
    }
    case "form": {
      const fh = formFactor(home.form, home.recent?.available ? ENGINE.formWeightRecent : ENGINE.formWeight);
      const fa = formFactor(away.form, away.recent?.available ? ENGINE.formWeightRecent : ENGINE.formWeight);
      const describe = (factor) => factor.points === null
        ? "sin forma registrada"
        : `${factor.points} pts en ${factor.games} (×${factor.raw.toFixed(3)} → ×${factor.applied.toFixed(3)})`;
      return `${home.short}: ${describe(fh)} · ${away.short}: ${describe(fa)}. Peso ${Math.round(fh.weight * 100)}% / ${Math.round(fa.weight * 100)}%: baja cuando ya hay historial de goles.`;
    }
    case "shots": {
      const blend = shotsBlend(home, away);
      if (!blend.applied) return blend.reason;
      return `Peso ${Math.round(blend.weight * 100)}% a tiros: ataque ${home.short} ${home.attack.toFixed(2)}→${blend.home.attack.toFixed(2)}; ${away.short} ${away.attack.toFixed(2)}→${blend.away.attack.toFixed(2)}.`;
    }
    case "venue": {
      if (match.neutral) return "Sede neutral: sin ventaja de localía.";
      const venue = venueFactors(match.leagueContext || {});
      return `${home.short} juega en ${match.venue}. Localía de liga ×${venue.home.toFixed(3)} / ×${venue.away.toFixed(3)}.`;
    }
    case "lineup": {
      if (live) return "Sin alineación confirmada; el modelo no ajusta por bajas.";
      const names = [...homeAbs.map((a) => `${home.short}: ${a.name}`), ...awayAbs.map((a) => `${away.short}: ${a.name}`)];
      return names.length ? names.join(" · ") : "Sin bajas relevantes en los dos XI.";
    }
    case "rest": {
      const meta = match.restMeta || {};
      const homeObserved = meta.home?.observed !== false;
      const awayObserved = meta.away?.observed !== false;
      const missing = [];
      if (!homeObserved) missing.push(home.short);
      if (!awayObserved) missing.push(away.short);
      if (missing.length) {
        return `Sin dato de descanso para ${missing.join(" y ")}; el factor queda neutro en ese lado.`;
      }
      const source = live ? " (calculado desde el último partido de ESPN)" : "";
      return `${match.rest.home} vs ${match.rest.away} días de descanso${source}.`;
    }
    case "travel":
      return live ? "Distancia de viaje no disponible; sin ajuste." : `${match.travelKm.home} vs ${match.travelKm.away} km de viaje.`;
    case "matchType":
      return `${TYPE_LABELS[match.type] || match.type}${match.stage ? ` · ${match.stage}` : ""}.`;
    case "altitude":
      return live && !match.altitude ? "Altitud no registrada; sin ajuste." : `${match.altitude} m de altitud; ${away.short} llega desde ${away.altitude} m.`;
    case "motivation":
      return live ? "Motivación no modelada en modo live." : "Incentivos, necesidad de puntos y prioridad del partido.";
    case "aggregate":
      return match.aggregate
        ? `Global ${match.aggregate.home}-${match.aggregate.away}${match.leg === 2 ? " antes de la vuelta" : ""}.`
        : "Partido de ida: global 0-0.";
    default:
      return "";
  }
}

function buildConfidence(match, home, away, league) {
  const live = Boolean(league?.live);
  const demo = Boolean(league?.demo);
  let score = live ? 66 : 76;
  if (match.type === "friendly") score -= 18;
  if (match.type === "final") score -= 7;
  if (match.type === "quarterfinal" || match.type === "semifinal") score -= 4;
  if (match.neutral) score -= 2;
  const absences = (match.lineups?.home?.absences?.length || 0) + (match.lineups?.away?.absences?.length || 0);
  score -= Math.min(8, absences * 2);
  if (live && home.recent?.available && away.recent?.available) score += 4;
  if (live && match.h2h?.available && match.h2h.played >= 3) score += 1;
  score = Math.round(clamp(score, 42, 88));
  const label = score >= 75 ? "Media-alta" : score >= 60 ? "Media" : "Baja";
  const baseReasons = live
    ? [
      {
        label: "Datos",
        detail: "Tabla, últimos 10 partidos, H2H, forma y sede de ESPN; tiros, córners, tarjetas y posesión son estimaciones del modelo.",
        impact: "Live",
      },
      {
        label: "Alineación",
        detail: "Sin XI confirmado: el modelo no ajusta por bajas ni rotaciones.",
        impact: "Pendiente",
      },
      {
        label: "Contexto",
        detail: "El cálculo no usa clima ni árbitro; descanso calculado desde el último partido cuando está disponible; viaje sin dato.",
        impact: "Parcial",
      },
    ]
    : [
      {
        label: "Datos",
        detail: demo ? "Datos de respaldo simulados de la temporada." : "Datos propios cargados para esta competición.",
        impact: demo ? "Respaldo" : "Propios",
      },
      { label: "Alineación", detail: absences ? `${absences} baja(s) o duda(s) registradas.` : "Sin bajas relevantes registradas.", impact: absences ? "Ajustada" : "Completa" },
      { label: "Contexto", detail: match.type === "friendly" ? "Amistoso: rotaciones y poca intensidad." : match.neutral ? "Sede neutral: se elimina la localía." : "Partido con localía definida.", impact: match.type === "friendly" ? "Alta incertidumbre" : match.neutral ? "Neutral" : "Definido" },
    ];
  const reasons = [
    ...baseReasons,
    {
      label: "Calibración",
      detail: `Temperatura 1X2 ${ENGINE.temperature1x2} y Platt suave (b=${ENGINE.binarySlope}). La validación walk-forward propia está en el panel de precisión.`,
      impact: "V1.0",
    },
  ];
  return {
    score,
    label,
    reasons,
    note: live
      ? "La confianza mide la completitud del contexto, no la probabilidad de acertar. El modo live usa tabla, últimos 10 partidos, H2H, descanso y sede de ESPN; el clima y el árbitro no entran en el cálculo."
      : demo
        ? "La confianza mide la completitud del contexto, no la probabilidad de acertar. Con datos simulados es una etiqueta ilustrativa; el backtest walk-forward solo se muestra en modo live."
        : "La confianza mide la completitud del contexto, no la probabilidad de acertar. Revisa que tus datos estén actualizados y sean comparables; el panel de precisión solo se calcula con datos live.",
  };
}

function distributionQuantile(distribution, quantile) {
  const target = clamp(Number(quantile) || 0, 0, 1);
  let cumulative = 0;
  for (let i = 0; i < distribution.length; i += 1) {
    cumulative += distribution[i];
    if (cumulative >= target) return i;
  }
  return distribution.length - 1;
}

// Capa de lectura propia: mide cuán separada está la salida más probable de la
// segunda y resume el 80% central de la distribución de goles. No altera el
// 1X2 ni la matriz; solo describe su forma para que la UI no confunda
// "confianza en los datos" con "partido cerrado o abierto".
function buildForecastCertainty(matrix, probs, topScores) {
  const ordered = [
    { key: "home", p: probs.home },
    { key: "draw", p: probs.draw },
    { key: "away", p: probs.away },
  ].sort((a, b) => b.p - a.p);
  const gap = Math.max(0, ordered[0].p - ordered[1].p);
  const gapPp = gap * 100;
  const label = gap >= 0.22 ? "Favorito claro" : gap >= 0.10 ? "Favorito moderado" : "Partido abierto";
  const tone = gap >= 0.22 ? "clear" : gap >= 0.10 ? "lean" : "open";
  const entropy = ordered.reduce(
    (sum, outcome) => (outcome.p > 0 ? sum - outcome.p * Math.log2(outcome.p) : sum),
    0,
  );
  const totalGoals = Array.from({ length: 21 }, () => 0);
  const goalDiff = new Map();
  for (let homeGoals = 0; homeGoals < matrix.length; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < matrix[homeGoals].length; awayGoals += 1) {
      const p = matrix[homeGoals][awayGoals];
      if (!(p > 0)) continue;
      totalGoals[homeGoals + awayGoals] += p;
      const diff = homeGoals - awayGoals;
      goalDiff.set(diff, (goalDiff.get(diff) || 0) + p);
    }
  }
  const low = distributionQuantile(totalGoals, 0.10);
  const high = distributionQuantile(totalGoals, 0.90);
  const diffOrdered = [...goalDiff.entries()].sort((a, b) => b[1] - a[1]);
  const top = topScores[0] || null;
  return {
    label,
    tone,
    gap,
    gapPp,
    separation: clamp(gap / 0.35, 0, 1),
    favorite: ordered[0].key,
    favoriteProb: ordered[0].p,
    secondProb: ordered[1].p,
    goals: { low, high, level: 0.8 },
    topScore: top ? { home: top.home, away: top.away, p: top.p } : null,
    modalDiff: diffOrdered[0]?.[0] ?? 0,
    entropy,
    entropyNormalized: clamp(entropy / Math.log2(3), 0, 1),
    note: "La certeza mide cuán separadas están las salidas, no la probabilidad de acertar. Un favorito claro puede perder y un partido abierto puede tener un ganador claro.",
  };
}

function buildInsights(analysis) {
  const { home, away, probs, metrics, match, league } = analysis;
  const live = Boolean(league?.live);
  const favorite = [
    { kind: "home", label: home.short, p: probs.home },
    { kind: "draw", label: "El empate", p: probs.draw },
    { kind: "away", label: away.short, p: probs.away },
  ].sort((a, b) => b.p - a.p)[0];
  const goalsText = metrics.goals.total >= 2.8
    ? "partido con ritmo alto"
    : metrics.goals.total <= 2.3
      ? "partido de pocas ocasiones"
      : "partido de ritmo medio";
  const insights = [
    {
      label: "Favorito",
      text: favorite.kind === "draw"
        ? `El empate es la salida más probable (${(favorite.p * 100).toFixed(1)}%).${live ? " Con tabla real y sin XI confirmado, la lectura es provisional." : " La lectura cambia si se ajusta la alineación."}`
        : `${favorite.label} concentra ${(favorite.p * 100).toFixed(1)}% de probabilidad de victoria.${live ? " Con tabla real y sin XI confirmado, la lectura es provisional." : " La lectura cambia si se ajusta la alineación."}`,
    },
    {
      label: "Goles",
      text: `Se esperan ${metrics.goals.total.toFixed(1)} goles: ${goalsText}. Over 2.5: ${(metrics.goals.over25 * 100).toFixed(0)}%.`,
    },
    {
      label: "Córners",
      text: `${metrics.corners.total.toFixed(1)} córners esperados${live ? " (promedio estimado de la liga)" : ""}; ${(metrics.corners.over95 * 100).toFixed(0)}% de superar 9.5.`,
    },
    {
      label: "Tarjetas",
      text: `${metrics.cards.total.toFixed(1)} tarjetas esperadas (disciplina, rivalidad y tipo de partido; sin árbitro); ${(metrics.cards.over45 * 100).toFixed(0)}% de superar 4.5.`,
    },
  ];
  if (analysis.engine) {
    const engine = analysis.engine;
    insights.push({
      label: "OX V1.0",
      text: `El 1X2 crudo (${(engine.rawProbs.home * 100).toFixed(1)}% / ${(engine.rawProbs.draw * 100).toFixed(1)}% / ${(engine.rawProbs.away * 100).toFixed(1)}%) se suaviza con temperatura ${engine.temperature.toFixed(2)}. Over 2.5 pasa de ${(engine.rawBinary.over25 * 100).toFixed(1)}% a ${(engine.binary.over25 * 100).toFixed(1)}% tras la calibración Platt.`,
    });
    const rh = engine.recent?.home;
    const ra = engine.recent?.away;
    if (rh?.available || ra?.available) {
      insights.push({
        label: "Últimos 10",
        text: `${home.short} llega con ${rh?.sample ?? 0} partidos recientes (${(rh?.gfPerMatch ?? 0).toFixed(2)} GF / ${(rh?.gaPerMatch ?? 0).toFixed(2)} GC); ${away.short}, con ${ra?.sample ?? 0} (${(ra?.gfPerMatch ?? 0).toFixed(2)} / ${(ra?.gaPerMatch ?? 0).toFixed(2)}). La mezcla con la tabla pesa ${Math.round((engine.recent?.strength?.home?.recentWeight ?? 0) * 100)}% y ${Math.round((engine.recent?.strength?.away?.recentWeight ?? 0) * 100)}%.`,
      });
    }
    if (engine.h2h?.factor?.applied) {
      insights.push({
        label: "H2H",
        text: `${engine.h2h.played} enfrentamientos directos: ${home.short} ${engine.h2h.homeWins}, empates ${engine.h2h.draws}, ${away.short} ${engine.h2h.awayWins}. El ajuste es conservador (${Math.round((engine.h2h.factor?.weight || 0) * 100)}% de peso) para no sobreinterpretar una muestra corta.`,
      });
    }
  }
  if (analysis.tiebreak?.applies) {
    insights.push({
      label: "Desempate",
      text: `${analysis.tiebreak.verdict}. ${analysis.tiebreak.summary}`,
    });
  }
  return insights;
}

export function analyzeMatchCore(match, teams, league) {
  const home = teams[match.home];
  const away = teams[match.away];
  if (!home || !away) throw new Error(`Equipo no encontrado en ${match.id}`);
  const ctx = match.leagueContext ? { ...league, ...match.leagueContext } : league;
  const core = computeCore(match, home, away, ctx);
  const metrics = buildMetrics(match, home, away, ctx, core);
  const players = {
    home: buildPlayers("home", home, away, core.lambdaHome, match, ctx),
    away: buildPlayers("away", away, home, core.lambdaAway, match, ctx),
  };
  const factors = buildFactors(match, home, away, ctx, core, metrics);
  const firstGoalNone = Math.exp(-(core.lambdaHome + core.lambdaAway));
  const someGoal = 1 - firstGoalNone;
  const analysis = {
    match,
    home,
    away,
    league: ctx,
    modelVersion: MODEL_VERSION,
    excludedInputs: ["weather", "referee"],
    typeLabel: TYPE_LABELS[match.type] || match.type,
    lambda: { home: core.lambdaHome, away: core.lambdaAway },
    probs: core.probs,
    rawProbs: core.rawProbs,
    engine: core.engine,
    matrix: core.matrix,
    totals: core.totals,
    btts: core.btts,
    rawBtts: core.rawBtts,
    over15: core.over15,
    over25: core.over25,
    over35: core.over35,
    rawOver15: core.rawOver15,
    rawOver25: core.rawOver25,
    rawOver35: core.rawOver35,
    topScores: core.topScores,
    timing: core.timing,
    scoreMatrix: core.scoreMatrix,
    steps: core.steps,
    multipliers: core.multipliers,
    metrics,
    players,
    factors,
    teamScore: {
      home: 1 - Math.exp(-core.lambdaHome),
      away: 1 - Math.exp(-core.lambdaAway),
    },
    cleanSheet: {
      home: Math.exp(-core.lambdaAway),
      away: Math.exp(-core.lambdaHome),
    },
    firstGoal: {
      home: someGoal * core.lambdaHome / (core.lambdaHome + core.lambdaAway),
      away: someGoal * core.lambdaAway / (core.lambdaHome + core.lambdaAway),
      none: firstGoalNone,
    },
  };
  analysis.tiebreak = buildTiebreak(analysis);
  analysis.confidence = buildConfidence(match, home, away, ctx);
  analysis.certainty = buildForecastCertainty(core.matrix, core.probs, core.topScores);
  analysis.insights = buildInsights(analysis);
  analysis.comboLegs = comboLegs(analysis);
  return analysis;
}
