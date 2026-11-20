// Proyección de puntos con valor esperado (VE).
//
// Adaptación deportiva de VE = Σ(P_i × G_i) − C:
//   G_i = 3, 1 y 0 puntos para victoria, empate y derrota.
//   C   = PPG de referencia del equipo (temporada, últimos 10 o base de liga).
//
// El resultado se expresa en puntos de fútbol.
// Los escenarios posteriores usan un rival promedio de la liga cuando el
// calendario disponible no trae un fixture confirmado.

import { ENGINE, formFactor, temperatureScale, venueFactors } from "./calibration.js";
import { buildMatrix, summarizeMatrix } from "./math.js";

export const PPG_FALLBACK = 1.35;
export const POINTS = { win: 3, draw: 1, loss: 0 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));

export function ppgFromResults(results = []) {
  const last = (Array.isArray(results) ? results : [])
    .filter((row) => row && ["W", "D", "L"].includes(String(row.result).toUpperCase()))
    .slice(0, 10);
  if (!last.length) return null;
  const points = last.reduce((sum, row) => {
    const result = String(row.result).toUpperCase();
    return sum + (result === "W" ? POINTS.win : result === "D" ? POINTS.draw : POINTS.loss);
  }, 0);
  return points / last.length;
}

export function teamBaseline(team = {}) {
  const pj = Number(team.standing?.pj);
  const pts = Number(team.standing?.pts);
  if (Number.isFinite(pj) && pj > 0 && Number.isFinite(pts)) {
    return {
      ppg: pts / pj,
      source: "temporada",
      sample: pj,
      detail: `${pts} pts en ${pj} PJ`,
    };
  }
  const recent = ppgFromResults(team.recent?.last);
  if (recent !== null) {
    const sample = Math.min(10, team.recent?.last?.length || 0);
    return {
      ppg: recent,
      source: "últimos 10",
      sample,
      detail: `${sample} partidos recientes`,
    };
  }
  return {
    ppg: PPG_FALLBACK,
    source: "base de liga",
    sample: 0,
    detail: "Sin muestra del equipo",
  };
}

export function projectionFromProbs({
  team,
  opponent,
  side,
  win,
  draw,
  loss,
  baseline = teamBaseline(team),
  date = "",
  venue = side === "home" ? "Local" : "Visitante",
  source = "modelo",
  modeled = false,
  label = "",
  week = null,
}) {
  const raw = [Number(win) || 0, Number(draw) || 0, Number(loss) || 0].map((value) => clamp(value, 0, 1));
  const total = raw[0] + raw[1] + raw[2];
  const probs = total > 0
    ? { win: raw[0] / total, draw: raw[1] / total, loss: raw[2] / total }
    : { win: 1 / 3, draw: 1 / 3, loss: 1 / 3 };
  const expected = POINTS.win * probs.win + POINTS.draw * probs.draw + POINTS.loss * probs.loss;
  const ve = expected - baseline.ppg;
  return {
    team,
    opponent,
    side,
    ...probs,
    expected,
    baseline,
    ve,
    tone: ve > 0.02 ? "pos" : ve < -0.02 ? "neg" : "neutral",
    breakdown: {
      win: POINTS.win * probs.win,
      draw: POINTS.draw * probs.draw,
      loss: POINTS.loss * probs.loss,
    },
    date,
    venue,
    source,
    modeled,
    label,
    week,
  };
}

export function projectionFromAnalysis(analysis, side) {
  if (!analysis?.probs || !["home", "away"].includes(side)) return null;
  const isHome = side === "home";
  const team = isHome ? analysis.home : analysis.away;
  const opponent = isHome ? analysis.away : analysis.home;
  return projectionFromProbs({
    team,
    opponent,
    side,
    win: isHome ? analysis.probs.home : analysis.probs.away,
    draw: analysis.probs.draw,
    loss: isHome ? analysis.probs.away : analysis.probs.home,
    baseline: teamBaseline(team),
    date: analysis.match?.date || "",
    venue: isHome ? "Local" : "Visitante",
    source: "modelo",
    modeled: false,
    label: "Este partido",
  });
}

export function modeledProjection(team, league = {}, options = {}) {
  const {
    venue = "home",
    date = "",
    temperature = ENGINE.temperature1x2,
    opponentLabel = "Rival promedio",
    week = null,
  } = options;
  const mu = clamp(Number(league.avgGoals) || 1.35, 0.45, 3.2);
  const attack = clamp(Number(team?.attack) || 1, 0.4, 2.5);
  const defense = clamp(Number(team?.defense) || 1, 0.4, 2.5);
  const form = formFactor(team?.form, ENGINE.formWeightRecent);
  const factors = venueFactors(league);
  const isHome = venue === "home";
  const lambdaTeam = clamp(mu * attack * form.applied * (isHome ? factors.home : factors.away), 0.3, 4.2);
  const lambdaOpp = clamp(mu * defense * (isHome ? factors.away : factors.home), 0.3, 4.2);
  const lambdaHome = isHome ? lambdaTeam : lambdaOpp;
  const lambdaAway = isHome ? lambdaOpp : lambdaTeam;
  const raw = summarizeMatrix(buildMatrix(lambdaHome, lambdaAway, league.rho)).probs;
  const probs = temperatureScale(raw, temperature);
  return projectionFromProbs({
    team,
    opponent: { short: opponentLabel, abbr: "MED", name: opponentLabel },
    side: isHome ? "home" : "away",
    win: isHome ? probs.home : probs.away,
    draw: probs.draw,
    loss: isHome ? probs.away : probs.home,
    baseline: teamBaseline(team),
    date,
    venue: isHome ? "Local" : "Visitante",
    source: "escenario",
    modeled: true,
    label: "Escenario",
    week,
  });
}
