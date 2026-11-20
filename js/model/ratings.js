// Fuerzas recientes e historial directo.
// Se calculan con resultados reales de ESPN y se mezclan con la tabla de
// temporada. La idea es propia: ventana de 10 partidos, decaimiento temporal,
// contracción bayesiana y un peso conservador para el H2H.

import { ENGINE } from "./calibration.js";
import { clamp } from "./math.js";

const DAY_MS = 86_400_000;

export function scoreValue(score) {
  if (score === null || score === undefined) return null;
  if (typeof score === "number") return Number.isFinite(score) ? score : null;
  if (typeof score === "object") {
    const value = score.value ?? score.displayValue;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  const number = Number(score);
  return Number.isFinite(number) ? number : null;
}

// Normaliza un evento del calendario de ESPN a un registro mínimo y estable.
export function normalizeScheduleEvent(event, leagueId) {
  const competition = event?.competitions?.[0];
  if (!competition) return null;
  const home = competition.competitors?.find((item) => item.homeAway === "home");
  const away = competition.competitors?.find((item) => item.homeAway === "away");
  if (!home?.team || !away?.team) return null;
  const state = competition.status?.type?.state;
  const homeGoals = scoreValue(home.score);
  const awayGoals = scoreValue(away.score);
  const completed = state === "post" && Number.isFinite(homeGoals) && Number.isFinite(awayGoals);
  return {
    id: String(event.id),
    date: event.date,
    leagueId,
    season: Number(event.season?.year) || null,
    seasonName: event.season?.displayName || "",
    completed,
    homeId: String(home.team.id),
    awayId: String(away.team.id),
    homeName: home.team.displayName || home.team.name || "Equipo",
    awayName: away.team.displayName || away.team.name || "Equipo",
    homeAbbr: (home.team.abbreviation || "").toUpperCase(),
    awayAbbr: (away.team.abbreviation || "").toUpperCase(),
    homeLogo: home.team.logo || "",
    awayLogo: away.team.logo || "",
    homeGoals,
    awayGoals,
    venue: competition.venue?.fullName || "",
    city: competition.venue?.address?.city || "",
    competition: leagueId,
  };
}

export function matchDateMs(date) {
  const ms = new Date(date).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function ageInDays(date, before) {
  const diff = matchDateMs(before) - matchDateMs(date);
  return Math.max(0, diff / DAY_MS);
}

export function recencyWeight(date, before, halfLifeDays = ENGINE.recentHalfLifeDays) {
  const halfLife = clamp(Number(halfLifeDays) || ENGINE.recentHalfLifeDays, 7, 365);
  return Math.pow(0.5, ageInDays(date, before) / halfLife);
}

export function resultForTeam(match, teamId) {
  if (!match?.completed) return null;
  const isHome = match.homeId === String(teamId);
  const isAway = match.awayId === String(teamId);
  if (!isHome && !isAway) return null;
  const goalsFor = isHome ? match.homeGoals : match.awayGoals;
  const goalsAgainst = isHome ? match.awayGoals : match.homeGoals;
  if (goalsFor > goalsAgainst) return "W";
  if (goalsFor < goalsAgainst) return "L";
  return "D";
}

function teamMatches(history, teamId, before) {
  const id = String(teamId);
  const cutoff = matchDateMs(before);
  return (history || [])
    .filter((match) => (
      match?.completed
      && (match.homeId === id || match.awayId === id)
      && matchDateMs(match.date) < cutoff
    ))
    .sort((a, b) => matchDateMs(b.date) - matchDateMs(a.date));
}

function sideStats(match, teamId) {
  const isHome = match.homeId === String(teamId);
  return {
    goalsFor: isHome ? match.homeGoals : match.awayGoals,
    goalsAgainst: isHome ? match.awayGoals : match.homeGoals,
    opponent: isHome ? match.awayName : match.homeName,
    opponentAbbr: isHome ? match.awayAbbr : match.homeAbbr,
    opponentLogo: isHome ? match.awayLogo : match.homeLogo,
    homeAway: isHome ? "home" : "away",
  };
}

// Perfil de los últimos N partidos con peso exponencial por antigüedad.
export function computeRecentProfile(history, teamId, options = {}) {
  const {
    before = new Date().toISOString(),
    leagueAvg = 1.35,
    window = ENGINE.recentWindow,
    halfLifeDays = ENGINE.recentHalfLifeDays,
  } = options;
  const avg = clamp(Number(leagueAvg) || 1.35, 0.45, 3.2);
  const matches = teamMatches(history, teamId, before).slice(0, Math.max(1, window));
  let weighted = 0;
  let weightedFor = 0;
  let weightedAgainst = 0;
  let homeWeighted = 0;
  let awayWeighted = 0;
  let homeWeight = 0;
  let awayWeight = 0;
  const last = [];

  for (const match of matches) {
    const weight = recencyWeight(match.date, before, halfLifeDays);
    const stats = sideStats(match, teamId);
    weighted += weight;
    weightedFor += weight * stats.goalsFor;
    weightedAgainst += weight * stats.goalsAgainst;
    if (stats.homeAway === "home") {
      homeWeighted += weight;
      homeWeight += weight;
    } else {
      awayWeighted += weight;
      awayWeight += weight;
    }
    if (last.length < Math.min(10, matches.length)) {
      last.push({
        date: match.date,
        opponent: stats.opponent,
        opponentAbbr: stats.opponentAbbr,
        opponentLogo: stats.opponentLogo,
        homeAway: stats.homeAway,
        goalsFor: stats.goalsFor,
        goalsAgainst: stats.goalsAgainst,
        result: resultForTeam(match, teamId),
        competition: match.competition,
        venue: match.venue,
      });
    }
  }

  const sample = matches.length;
  const gfPerMatch = weighted > 0 ? weightedFor / weighted : 0;
  const gaPerMatch = weighted > 0 ? weightedAgainst / weighted : 0;
  const coverage = clamp(weighted / ENGINE.recentCoverageMatches, 0, 1);
  const shrink = weighted > 0 ? weighted / (weighted + ENGINE.recentShrink) : 0;
  const attack = clamp(1 + ((gfPerMatch / avg) - 1) * shrink, 0.4, 2.5);
  const defense = clamp(1 + ((gaPerMatch / avg) - 1) * shrink, 0.4, 2.5);
  const form = matches.slice(0, 5).reverse().map((match) => resultForTeam(match, teamId)).filter(Boolean);

  return {
    available: sample >= 2,
    sample,
    window: Math.max(1, window),
    weightedSample: weighted,
    coverage,
    attack,
    defense,
    gfPerMatch,
    gaPerMatch,
    homeGoalsPerMatch: homeWeight > 0 ? homeWeighted / homeWeight : null,
    awayGoalsPerMatch: awayWeight > 0 ? awayWeighted / awayWeight : null,
    form,
    last,
    halfLifeDays,
    leagueAvg: avg,
    source: "ESPN · últimos partidos reales",
  };
}

// Perfil de temporada a partir del mismo historial. Se usa en el backtest,
// donde no hay una tabla histórica congelada en cada fecha.
export function computeSeasonProfile(history, teamId, options = {}) {
  const {
    before = new Date().toISOString(),
    leagueAvg = 1.35,
    seasonYear = null,
    shrink = 6,
  } = options;
  const avg = clamp(Number(leagueAvg) || 1.35, 0.45, 3.2);
  let matches = teamMatches(history, teamId, before);
  if (seasonYear !== null && seasonYear !== undefined) {
    const sameSeason = matches.filter((match) => Number(match.season) === Number(seasonYear));
    if (sameSeason.length >= 3) matches = sameSeason;
  }
  if (!matches.length) {
    return {
      available: false,
      sample: 0,
      attack: 1,
      defense: 1,
      gfPerMatch: 0,
      gaPerMatch: 0,
    };
  }
  let goalsFor = 0;
  let goalsAgainst = 0;
  for (const match of matches) {
    const stats = sideStats(match, teamId);
    goalsFor += stats.goalsFor;
    goalsAgainst += stats.goalsAgainst;
  }
  const sample = matches.length;
  const gfPerMatch = goalsFor / sample;
  const gaPerMatch = goalsAgainst / sample;
  const weight = sample / (sample + shrink);
  return {
    available: true,
    sample,
    attack: clamp(1 + ((gfPerMatch / avg) - 1) * weight, 0.4, 2.5),
    defense: clamp(1 + ((gaPerMatch / avg) - 1) * weight, 0.4, 2.5),
    gfPerMatch,
    gaPerMatch,
    weight,
  };
}

export function blendStrength(seasonAttack, seasonDefense, recent, options = {}) {
  const baseAttack = clamp(Number(seasonAttack) || 1, 0.4, 2.5);
  const baseDefense = clamp(Number(seasonDefense) || 1, 0.4, 2.5);
  const weight = clamp(Number(options.weight ?? ENGINE.recentWeight) || 0, 0, 1);
  const coverage = clamp(Number(recent?.coverage) || 0, 0, 1);
  const appliedWeight = weight * coverage;
  const recentAttack = clamp(Number(recent?.attack) || 1, 0.4, 2.5);
  const recentDefense = clamp(Number(recent?.defense) || 1, 0.4, 2.5);
  return {
    attack: clamp((1 - appliedWeight) * baseAttack + appliedWeight * recentAttack, 0.4, 2.5),
    defense: clamp((1 - appliedWeight) * baseDefense + appliedWeight * recentDefense, 0.4, 2.5),
    seasonAttack: baseAttack,
    seasonDefense: baseDefense,
    recentAttack,
    recentDefense,
    recentWeight: appliedWeight,
    maxWeight: weight,
    coverage,
    source: appliedWeight > 0.03 ? "tabla + últimos partidos" : "tabla",
  };
}

// Historial directo orientado al equipo que hoy juega en casa.
export function buildH2H(homeHistory, awayHistory, options = {}) {
  const {
    homeId,
    awayId,
    before = new Date().toISOString(),
    limit = ENGINE.h2hMaxMatches,
  } = options;
  const home = String(homeId);
  const away = String(awayId);
  const awayIds = new Set((awayHistory || []).map((match) => match.id));
  const matches = (homeHistory || [])
    .filter((match) => (
      match?.completed
      && awayIds.has(match.id)
      && matchDateMs(match.date) < matchDateMs(before)
      && ((match.homeId === home && match.awayId === away) || (match.homeId === away && match.awayId === home))
    ))
    .sort((a, b) => matchDateMs(b.date) - matchDateMs(a.date))
    .slice(0, Math.max(1, limit));

  const oriented = matches.map((match) => {
    const homeWasHome = match.homeId === home;
    const currentHomeGoals = homeWasHome ? match.homeGoals : match.awayGoals;
    const currentAwayGoals = homeWasHome ? match.awayGoals : match.homeGoals;
    return {
      id: match.id,
      date: match.date,
      season: match.season,
      homeTeam: match.homeName,
      awayTeam: match.awayName,
      homeAbbr: match.homeAbbr,
      awayAbbr: match.awayAbbr,
      homeGoals: match.homeGoals,
      awayGoals: match.awayGoals,
      currentHomeGoals,
      currentAwayGoals,
      currentHomeWasHome: homeWasHome,
      competition: match.competition,
      venue: match.venue,
      city: match.city,
    };
  });

  const played = oriented.length;
  const homeWins = oriented.filter((match) => match.currentHomeGoals > match.currentAwayGoals).length;
  const draws = oriented.filter((match) => match.currentHomeGoals === match.currentAwayGoals).length;
  const awayWins = played - homeWins - draws;
  const goalsHome = oriented.reduce((sum, match) => sum + match.currentHomeGoals, 0);
  const goalsAway = oriented.reduce((sum, match) => sum + match.currentAwayGoals, 0);
  const btts = oriented.filter((match) => match.homeGoals > 0 && match.awayGoals > 0).length;
  const over25 = oriented.filter((match) => match.homeGoals + match.awayGoals > 2.5).length;
  const sameVenue = oriented.filter((match) => match.currentHomeWasHome).length;

  const minMatches = Math.max(1, Number(ENGINE.h2hMinMatches) || 3);
  return {
    available: played > 0,
    sufficient: played >= minMatches,
    minMatches,
    played,
    homeWins,
    draws,
    awayWins,
    goalsHome,
    goalsAway,
    avgTotal: played ? (goalsHome + goalsAway) / played : 0,
    btts,
    over25,
    sameVenue,
    matches: oriented,
    source: "ESPN · historial directo",
  };
}

export function h2hFactor(h2h, league = {}, options = {}) {
  const minMatches = Math.max(1, Number(options.minMatches ?? ENGINE.h2hMinMatches) || ENGINE.h2hMinMatches);
  const maxWeight = clamp(Number(options.maxWeight ?? ENGINE.h2hWeight) || ENGINE.h2hWeight, 0.01, 0.35);
  if (!h2h?.available || h2h.played < minMatches) {
    return {
      applied: false,
      home: 1,
      away: 1,
      weight: 0,
      minMatches,
      reason: `Muestra insuficiente: se necesitan al menos ${minMatches} partidos directos; hay ${h2h?.played || 0}.`,
    };
  }
  const leagueAvg = clamp(Number(league.avgGoals) || 1.35, 0.45, 3.2);
  const weight = clamp(h2h.played / 12, 0.04, maxWeight);
  const homeRate = h2h.goalsHome / h2h.played;
  const awayRate = h2h.goalsAway / h2h.played;
  const home = clamp(1 + weight * ((homeRate / leagueAvg) - 1), 0.9, 1.1);
  const away = clamp(1 + weight * ((awayRate / leagueAvg) - 1), 0.9, 1.1);
  return {
    applied: true,
    home,
    away,
    weight,
    homeRate,
    awayRate,
    leagueAvg,
    reason: `${h2h.played} partidos directos · peso ${(weight * 100).toFixed(0)}%.`,
  };
}

// Reparto de goles por tiempo. Se usa una referencia conservadora: 44% antes
// del descanso y 56% después, sin pretender modelar el minuto exacto.
export function goalTiming(lambdaHome, lambdaAway, firstHalfShare = ENGINE.firstHalfShare) {
  const total = Math.max(0, Number(lambdaHome) || 0) + Math.max(0, Number(lambdaAway) || 0);
  const share = clamp(Number(firstHalfShare) || ENGINE.firstHalfShare, 0.35, 0.55);
  const make = (lambda, label) => {
    const p0 = Math.exp(-lambda);
    const p1 = lambda * p0;
    const p2plus = clamp(1 - p0 - p1, 0, 1);
    const p3plus = clamp(1 - p0 - p1 - (lambda * lambda * p0) / 2, 0, 1);
    return {
      label,
      lambda,
      p0,
      p1,
      p2plus,
      p3plus,
      over05: clamp(1 - p0, 0, 1),
      over15: p2plus,
      over25: p3plus,
    };
  };
  return {
    total,
    firstHalfShare: share,
    first: make(total * share, "Primer tiempo"),
    second: make(total * (1 - share), "Segundo tiempo"),
  };
}
