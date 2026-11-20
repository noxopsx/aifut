import { analyzeMatch } from "./js/model/index.js";
import { ENGINE, shotsBlend } from "./js/model/calibration.js";
import { applyShotRates } from "./js/model/observations.js";
import { LEAGUE } from "./js/data/league.js";
import { TEAMS } from "./js/data/teams.js";
import { MATCHES } from "./js/data/matches.js";
import { VALIDATION } from "./js/data/validation.js";
import { LATENT } from "./js/data/latent.js";
import { evaluateCombo } from "./js/model/combo.js";
import {
  modeledProjection,
  ppgFromResults,
  projectionFromAnalysis,
  teamBaseline,
} from "./js/model/projection.js";

const required = [
  "outcome:home",
  "outcome:draw",
  "outcome:away",
  "metric:goals",
  "metric:corners",
  "metric:cards",
  "scoreline",
  "distribution",
  "confidence",
  "certainty",
  "methodology",
  "table",
  "markets",
  "engine",
  "recentForm",
  "h2h",
  "matrix",
  "timing",
  "scenarios",
  "projection",
  "tiebreak",
  "playerForm",
];

const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

const problems = [];
const warnings = [];
const byLeague = new Map();
let explanationTotal = 0;
let tiebreakCount = 0;

const samplePpg = ppgFromResults([{ result: "W" }, { result: "D" }, { result: "L" }]);
if (!close(samplePpg, 4 / 3, 1e-9)) problems.push("proyección: PPG de muestra no cuadra");
const sampleBaseline = teamBaseline({ standing: { pts: 30, pj: 15 } });
if (!close(sampleBaseline.ppg, 2, 1e-9)) problems.push("proyección: baseline de temporada no cuadra");

// Regresión: clima y árbitro están excluidos de todas las probabilidades.
const excludedInputs = ["weather", "referee"];
const probeBase = JSON.parse(JSON.stringify(MATCHES[0]));
const probeChanged = JSON.parse(JSON.stringify(MATCHES[0]));
probeChanged.weather = { condition: "Tormenta", temp: 40, wind: 120 };
probeChanged.referee = { name: "Otro", cardsPerMatch: 9, penaltiesPerMatch: 2 };
const probeA = analyzeMatch(probeBase, TEAMS, LEAGUE);
const probeB = analyzeMatch(probeChanged, TEAMS, LEAGUE);
if (!excludedInputs.every((key) => probeA.excludedInputs?.includes(key))) {
  problems.push("el análisis no declara clima y árbitro como entradas excluidas");
}
if (probeA.factors.some((factor) => excludedInputs.includes(factor.key))) {
  problems.push("clima o árbitro aparecen como factores del modelo");
}
for (const [label, before, after] of [
  ["λ local", probeA.lambda.home, probeB.lambda.home],
  ["λ visitante", probeA.lambda.away, probeB.lambda.away],
  ["1X2 local", probeA.probs.home, probeB.probs.home],
  ["1X2 empate", probeA.probs.draw, probeB.probs.draw],
  ["1X2 visitante", probeA.probs.away, probeB.probs.away],
  ["BTTS", probeA.btts, probeB.btts],
  ["over 2.5", probeA.over25, probeB.over25],
  ["tarjetas totales", probeA.metrics.cards.total, probeB.metrics.cards.total],
  ["tarjetas over 4.5", probeA.metrics.cards.over45, probeB.metrics.cards.over45],
]) {
  if (!close(before, after, 1e-12)) problems.push(`${label} cambia con clima/árbitro`);
}

for (const match of MATCHES) {
  const a = analyzeMatch(match, TEAMS, LEAGUE);
  const contextGoals = match.leagueContext?.avgGoals;

  const sum = a.probs.home + a.probs.draw + a.probs.away;
  if (Math.abs(sum - 1) > 1e-6) problems.push(`${match.id}: 1X2 suma ${sum.toFixed(6)}`);
  if (contextGoals != null && Math.abs(a.league.avgGoals - contextGoals) > 1e-9) {
    problems.push(`${match.id}: leagueContext.avgGoals ${contextGoals} no se aplicó (${a.league.avgGoals})`);
  }
  if (!(a.btts >= 0 && a.btts <= 1)) problems.push(`${match.id}: BTTS fuera de rango`);
  if (!(a.over25 >= 0 && a.over25 <= 1)) problems.push(`${match.id}: over 2.5 fuera de rango`);
  if (!a.topScores.length) problems.push(`${match.id}: sin marcadores probables`);
  if (!a.insights?.length) problems.push(`${match.id}: sin insights`);
  if (!a.certainty) {
    problems.push(`${match.id}: falta certainty`);
  } else {
    const c = a.certainty;
    const sortedProbs = [a.probs.home, a.probs.draw, a.probs.away].sort((x, y) => y - x);
    if (!["home", "draw", "away"].includes(c.favorite)) problems.push(`${match.id}: certainty.favorite inválido`);
    if (!["clear", "lean", "open"].includes(c.tone)) problems.push(`${match.id}: certainty.tone inválido`);
    if (!inRange(c.gapPp, 0, 100)) problems.push(`${match.id}: certainty.gapPp fuera de rango`);
    if (!close(c.gapPp, (sortedProbs[0] - sortedProbs[1]) * 100, 1e-6)) {
      problems.push(`${match.id}: certainty.gapPp no coincide con el 1X2`);
    }
    if (!close(c.favoriteProb, sortedProbs[0], 1e-9)) problems.push(`${match.id}: certainty.favoriteProb no es la máxima`);
    if (!inRange(c.separation, 0, 1)) problems.push(`${match.id}: certainty.separation fuera de rango`);
    if (!inRange(c.entropy, 0, Math.log2(3) + 1e-9)) problems.push(`${match.id}: certainty.entropy fuera de rango`);
    if (!c.topScore || !close(c.topScore.p, a.topScores[0].p, 1e-9)) problems.push(`${match.id}: certainty.topScore no coincide`);
    if (!(c.goals.low >= 0 && c.goals.high >= c.goals.low && c.goals.high <= 20)) {
      problems.push(`${match.id}: certainty.goals fuera de rango`);
    } else {
      const totalDist = Array.from({ length: 21 }, () => 0);
      for (let i = 0; i < a.matrix.length; i += 1) {
        for (let j = 0; j < a.matrix[i].length; j += 1) totalDist[i + j] += a.matrix[i][j];
      }
      let cumulative = 0;
      let low = 20;
      for (let i = 0; i < totalDist.length; i += 1) {
        cumulative += totalDist[i];
        if (cumulative >= 0.1) { low = i; break; }
      }
      cumulative = 0;
      let high = 20;
      for (let i = 0; i < totalDist.length; i += 1) {
        cumulative += totalDist[i];
        if (cumulative >= 0.9) { high = i; break; }
      }
      if (c.goals.low !== low || c.goals.high !== high) {
        problems.push(`${match.id}: certainty.goals no coincide con los cuantiles 10–90`);
      }
    }
    if (!c.note) problems.push(`${match.id}: certainty sin nota`);
  }
  for (const key of required) {
    if (!a.explanations[key]) problems.push(`${match.id}: falta la explicación ${key}`);
  }
  if (LEAGUE.live && (a.players.home.length || a.players.away.length)) {
    problems.push(`${match.id}: el modo live no debe inventar goleadores`);
  }
  if (!LEAGUE.live && !a.players.home.length) {
    problems.push(`${match.id}: faltan jugadores en datos propios/respaldo`);
  }
  if (a.engine.shots.applied) {
    if (a.metrics.shots.shotsSource !== "observed") {
      problems.push(`${match.id}: blend aplicado sin fuente observada`);
    }
    if (a.home.estimated?.shots !== false || a.away.estimated?.shots !== false) {
      problems.push(`${match.id}: blend aplicado con tiros marcados como estimados`);
    }
  }

  // MOTOR-NOX V1.0: crudo y final deben ser probabilidades válidas.
  if (!a.rawProbs) {
    problems.push(`${match.id}: falta rawProbs`);
  } else {
    const rawSum = a.rawProbs.home + a.rawProbs.draw + a.rawProbs.away;
    if (Math.abs(rawSum - 1) > 1e-6) problems.push(`${match.id}: 1X2 crudo suma ${rawSum.toFixed(6)}`);
    for (const key of ["home", "draw", "away"]) {
      if (!(a.rawProbs[key] >= 0 && a.rawProbs[key] <= 1)) {
        problems.push(`${match.id}: rawProbs.${key} fuera de rango`);
      }
    }
    const rawDistance = ["home", "draw", "away"]
      .reduce((sum, key) => sum + Math.abs(a.rawProbs[key] - 1 / 3), 0);
    const finalDistance = ["home", "draw", "away"]
      .reduce((sum, key) => sum + Math.abs(a.probs[key] - 1 / 3), 0);
    if (finalDistance > rawDistance + 1e-9) {
      problems.push(`${match.id}: la temperatura no acerca el 1X2 al centro`);
    }
  }
  if (!a.engine) {
    problems.push(`${match.id}: falta engine`);
  } else {
    if (!(a.engine.temperature >= 1)) problems.push(`${match.id}: temperatura inválida`);
    if (!(a.engine.binarySlope > 0)) problems.push(`${match.id}: pendiente Platt inválida`);
    for (const key of ["over15", "over25", "over35", "btts"]) {
      const raw = a.engine.rawBinary[key];
      const final = a.engine.binary[key];
      if (!(raw >= 0 && raw <= 1)) problems.push(`${match.id}: rawBinary.${key} fuera de rango`);
      if (!(final >= 0 && final <= 1)) problems.push(`${match.id}: binary.${key} fuera de rango`);
    }
    for (const side of ["home", "away"]) {
      const form = a.engine.form[side];
      if (form.points !== null && !(form.applied >= 0.9 && form.applied <= 1.12)) {
        problems.push(`${match.id}: form.${side} fuera de rango`);
      }
    }
    if (typeof a.engine.shots.applied !== "boolean") problems.push(`${match.id}: shots.applied inválido`);
    if (LEAGUE.live && a.engine.shots.applied && a.metrics?.shots?.shotsSource !== "observed") {
      problems.push(`${match.id}: el modo live solo debe aplicar blend con tiros observados`);
    }
    const shotMetrics = a.metrics?.shots;
    if (!shotMetrics) {
      problems.push(`${match.id}: faltan métricas de tiros`);
    } else {
      if (!["estimated", "placeholder"].includes(shotMetrics.onTargetRateSource)) {
        problems.push(`${match.id}: onTargetRateSource inválido`);
      }
      for (const side of ["Home", "Away"]) {
        if (!inRange(shotMetrics[`onTargetRate${side}`], 0.15, 0.65)) {
          problems.push(`${match.id}: tasa de tiros a puerta ${side} fuera de rango`);
        }
      }
      if (shotMetrics.onTargetRateSource === "placeholder"
        && (!close(shotMetrics.onTargetRateHome, 0.34, 1e-9) || !close(shotMetrics.onTargetRateAway, 0.34, 1e-9))) {
        problems.push(`${match.id}: placeholder de tiros a puerta con tasa distinta de 0.34`);
      }
    }
    if (!a.engine.rest) {
      problems.push(`${match.id}: falta engine.rest`);
    } else if (match.restMeta) {
      for (const side of ["home", "away"]) {
        const meta = match.restMeta[side];
        const rest = a.engine.rest[side];
        if (typeof meta?.observed !== "boolean") problems.push(`${match.id}: restMeta.${side}.observed inválido`);
        if (meta?.observed === true && !(rest?.days >= 2)) problems.push(`${match.id}: descanso observado ${side} sin días válidos`);
        if (meta?.observed === false && rest?.observed !== false) problems.push(`${match.id}: descanso faltante ${side} no se neutralizó`);
      }
    }
    if (!(a.engine.venue.home >= 1 && a.engine.venue.away <= 1)) {
      problems.push(`${match.id}: localía V1.0 fuera de rango`);
    }
  }
  // MOTOR-NOX V1.0: historial reciente, H2H y mezcla de fuerzas.
  const recent = a.engine?.recent;
  if (!recent || !recent.strength) {
    problems.push(`${match.id}: falta engine.recent`);
  } else {
    for (const side of ["home", "away"]) {
      const profile = recent[side];
      const strength = recent.strength[side];
      if (!inRange(strength.recentWeight, 0, 1)) {
        problems.push(`${match.id}: recentWeight ${side} fuera de rango`);
      }
      if (!strength.source) problems.push(`${match.id}: strength ${side} sin fuente`);
      if (profile?.available) {
        if (!(profile.sample >= 2)) problems.push(`${match.id}: muestra reciente ${side} insuficiente`);
        if (!Array.isArray(profile.last) || profile.last.length > profile.window) {
          problems.push(`${match.id}: ventana reciente ${side} inválida`);
        }
        if (!inRange(profile.gfPerMatch, 0, 8) || !inRange(profile.gaPerMatch, 0, 8)) {
          problems.push(`${match.id}: goles recientes ${side} fuera de rango`);
        }
      }
    }
    if (LEAGUE.live && (!recent.home?.available || !recent.away?.available)) {
      problems.push(`${match.id}: live sin historial reciente para ambos equipos`);
    }
  }

  const h2h = match.h2h;
  if (LEAGUE.live) {
    if (!h2h) {
      problems.push(`${match.id}: falta match.h2h en live`);
    } else {
      if (h2h.homeWins + h2h.draws + h2h.awayWins !== h2h.played) {
        problems.push(`${match.id}: H2H no cuadra (${h2h.homeWins}-${h2h.draws}-${h2h.awayWins} vs ${h2h.played})`);
      }
      if (h2h.played > 0) {
        if (!inRange(h2h.avgTotal, 0, 10)) problems.push(`${match.id}: H2H avgTotal fuera de rango`);
        if (h2h.btts > h2h.played || h2h.over25 > h2h.played) problems.push(`${match.id}: H2H conteos fuera de rango`);
      }
      if (h2h.sufficient !== undefined) {
        const minMatches = h2h.minMatches || 3;
        if (!(minMatches >= 1)) problems.push(`${match.id}: H2H minMatches inválido`);
        if (typeof h2h.sufficient !== "boolean") problems.push(`${match.id}: H2H sufficient inválido`);
        if (h2h.sufficient !== (h2h.played >= minMatches)) problems.push(`${match.id}: H2H sufficient no coincide con la muestra`);
      }
    }
  }
  const h2hFx = a.engine?.h2h?.factor;
  if (!h2hFx || typeof h2hFx.applied !== "boolean") {
    problems.push(`${match.id}: falta factor H2H`);
  } else {
    if (!inRange(h2hFx.weight, 0, 0.12 + 1e-9)) problems.push(`${match.id}: peso H2H fuera del límite`);
    if (h2hFx.applied && (!inRange(h2hFx.home, 0.8, 1.2) || !inRange(h2hFx.away, 0.8, 1.2))) {
      problems.push(`${match.id}: factor H2H fuera de rango`);
    }
    if (h2h?.sufficient === true && !h2hFx.applied) problems.push(`${match.id}: H2H suficiente sin ajuste aplicado`);
    if (h2h?.sufficient === false && h2hFx.applied) problems.push(`${match.id}: H2H insuficiente con ajuste aplicado`);
  }

  // Reparto por tiempos.
  const timing = a.timing;
  if (!timing) {
    problems.push(`${match.id}: falta timing`);
  } else {
    if (!inRange(timing.firstHalfShare, 0.4, 0.6)) problems.push(`${match.id}: reparto por tiempos fuera de rango`);
    for (const half of [timing.first, timing.second]) {
      const total = half.p0 + half.p1 + half.p2plus;
      if (!close(total, 1, 1e-6)) problems.push(`${match.id}: tiempos no suman 1 (${total})`);
    }
    if (!close(timing.first.lambda + timing.second.lambda, a.lambda.home + a.lambda.away, 1e-6)) {
      problems.push(`${match.id}: λ por tiempos no cuadra`);
    }
  }

  // Matriz 7×7: 49 celdas, cola agrupada y coherencia con el marcador modal.
  const view = a.scoreMatrix;
  if (!view) {
    problems.push(`${match.id}: falta scoreMatrix`);
  } else {
    if (view.size !== 7 || view.cells.length !== 49) problems.push(`${match.id}: matriz 7×7 inválida`);
    const shown = view.cells.reduce((sum, cell) => sum + cell.p, 0);
    if (!close(shown, view.shown, 1e-9)) problems.push(`${match.id}: suma de celdas no cuadra`);
    if (!close(shown + view.rest, 1, 1e-6)) problems.push(`${match.id}: matriz + cola no suman 1`);
    const maxCell = Math.max(...view.cells.map((cell) => cell.p));
    if (!close(maxCell, view.max, 1e-9)) problems.push(`${match.id}: máximo de matriz no cuadra`);
    const top = a.topScores?.[0];
    if (top) {
      const cell = view.cells.find((item) => item.home === top.home && item.away === top.away);
      if (!cell || !close(cell.p, top.p, 1e-9)) problems.push(`${match.id}: marcador modal no coincide con la matriz`);
    }
  }

  // Escenarios: 18 condiciones, probabilidad conjunta y avisos.
  const legs = a.comboLegs || [];
  if (legs.length !== 18) problems.push(`${match.id}: se esperaban 18 condiciones de escenario`);
  const legIds = new Set();
  for (const leg of legs) {
    if (legIds.has(leg.id)) problems.push(`${match.id}: pata duplicada ${leg.id}`);
    legIds.add(leg.id);
    if (!inRange(leg.p, 0, 1)) problems.push(`${match.id}: pata ${leg.id} fuera de rango`);
    if (!["result", "double", "goals", "btts", "corners", "cards"].includes(leg.group)) {
      problems.push(`${match.id}: grupo de pata inválido ${leg.group}`);
    }
    if (leg.kind === "goal") {
      const expected = a.matrix.reduce((sum, row, i) => sum + row.reduce((inner, p, j) => (
        leg.condition(i, j) ? inner + p : inner
      ), 0), 0);
      if (!close(leg.p, expected, 1e-9)) problems.push(`${match.id}: pata ${leg.id} no coincide con la matriz`);
    }
  }
  const baseCombo = evaluateCombo(a, ["home", "over25"]);
  if (!inRange(baseCombo.probability, 0, 1)) problems.push(`${match.id}: escenario base fuera de rango`);
  if (!baseCombo.exact) problems.push(`${match.id}: escenario de goles debería ser exacto`);
  if (!close(baseCombo.complement, 1 - baseCombo.probability, 1e-9)) {
    problems.push(`${match.id}: probabilidad de fallo no es complemento`);
  }
  const mixCombo = evaluateCombo(a, ["home", "over25", "over95corners"]);
  if (mixCombo.exact || !mixCombo.warnings.some((warning) => warning.includes("independencia"))) {
    problems.push(`${match.id}: escenario mixto sin aviso de independencia`);
  }
  const contradiction = evaluateCombo(a, ["home", "away"]);
  if (contradiction.probability !== 0) problems.push(`${match.id}: condiciones contradictorias no dan probabilidad 0`);
  if (!contradiction.warnings.length) problems.push(`${match.id}: condiciones contradictorias sin aviso`);

  // Proyección VE en puntos: fórmula, referencia y escenario modelado.
  for (const side of ["home", "away"]) {
    const projection = projectionFromAnalysis(a, side);
    if (!projection) {
      problems.push(`${match.id}: falta proyección ${side}`);
      continue;
    }
    const sum = projection.win + projection.draw + projection.loss;
    if (!close(sum, 1, 1e-6)) problems.push(`${match.id}: proyección ${side} no suma 1`);
    if (!inRange(projection.expected, 0, 3)) problems.push(`${match.id}: puntos esperados ${side} fuera de rango`);
    if (!inRange(projection.ve, -4, 4)) problems.push(`${match.id}: VE ${side} fuera de rango`);
    if (!close(projection.expected, 3 * projection.win + projection.draw, 1e-9)) {
      problems.push(`${match.id}: puntos esperados ${side} no aplican la fórmula`);
    }
    if (!close(projection.ve, projection.expected - projection.baseline.ppg, 1e-9)) {
      problems.push(`${match.id}: VE ${side} no resta la referencia`);
    }
    for (const key of ["odds", "fairOdds", "marketOdds", "stake", "profit", "kelly", "ev"]) {
      if (key in projection) problems.push(`${match.id}: proyección ${side} contiene campo monetario ${key}`);
    }
  }
  const modeled = modeledProjection(a.home, a.league, {
    venue: "home",
    temperature: a.engine.temperature,
    week: 1,
  });
  if (!modeled.modeled || !inRange(modeled.ve, -4, 4)) {
    problems.push(`${match.id}: escenario modelado inválido`);
  }
  if (!a.explanations.projection?.formula?.includes("VE")) {
    problems.push(`${match.id}: explicación de proyección sin fórmula VE`);
  }

  // Desempate de partidos parejos: capa separada del 1X2 oficial.
  const tie = a.tiebreak;
  if (!tie) {
    problems.push(`${match.id}: falta tiebreak`);
  } else {
    if (tie.applies) tiebreakCount += 1;
    if (typeof tie.applies !== "boolean") problems.push(`${match.id}: tiebreak.applies inválido`);
    if (!inRange(tie.edge, -1, 1)) problems.push(`${match.id}: tiebreak.edge fuera de rango`);
    if (!inRange(tie.effectiveEdge, -1, 1)) problems.push(`${match.id}: tiebreak.effectiveEdge fuera de rango`);
    if (!inRange(tie.reliability, 0, 1)) problems.push(`${match.id}: tiebreak.reliability fuera de rango`);
    if (!inRange(tie.coverage, 0, 1)) problems.push(`${match.id}: tiebreak.coverage fuera de rango`);
    if (!["home", "draw", "away", "none"].includes(tie.lean)) problems.push(`${match.id}: tiebreak.lean inválido`);
    if (!["technical", "slight", "moderate", "clear", "none"].includes(tie.strength)) {
      problems.push(`${match.id}: tiebreak.strength inválido`);
    }
    if (!tie.formula?.includes("edge")) problems.push(`${match.id}: tiebreak sin fórmula edge`);
    if (!Array.isArray(tie.steps) || tie.steps.length < 5) problems.push(`${match.id}: tiebreak sin pasos suficientes`);
    if (!tie.note) problems.push(`${match.id}: tiebreak sin nota`);
    if (!Array.isArray(tie.signals) || tie.signals.length !== 6) {
      problems.push(`${match.id}: tiebreak debe tener 6 señales`);
    } else {
      const weightSum = tie.signals.reduce((sum, signal) => sum + signal.weight, 0);
      if (!close(weightSum, 1, 1e-9)) problems.push(`${match.id}: pesos de desempate suman ${weightSum}`);
      for (const signal of tie.signals) {
        if (!signal.label) problems.push(`${match.id}: señal ${signal.key} sin etiqueta`);
        if (!inRange(signal.weight, 0, 1)) problems.push(`${match.id}: peso ${signal.key} fuera de rango`);
        if (!inRange(signal.signal, -1, 1)) problems.push(`${match.id}: señal ${signal.key} fuera de rango`);
        if (!inRange(signal.reliability, 0, 1)) problems.push(`${match.id}: fiabilidad ${signal.key} fuera de rango`);
        if (typeof signal.available !== "boolean") problems.push(`${match.id}: disponibilidad ${signal.key} inválida`);
        if (!signal.available && signal.signal !== 0) problems.push(`${match.id}: señal ${signal.key} no disponible con valor distinto de 0`);
      }
      const h2hSignal = tie.signals.find((signal) => signal.key === "h2h");
      const h2hReady = Boolean(match.h2h?.available && match.h2h.played >= 3);
      if (h2hSignal && h2hSignal.available !== h2hReady) {
        problems.push(`${match.id}: disponibilidad H2H de desempate no coincide con la muestra`);
      }
    }
    if (tie.applies) {
      if (!(a.probs.draw >= ENGINE.tiebreak.drawHigh - 1e-9)) {
        problems.push(`${match.id}: desempate aplica con empate por debajo del umbral`);
      }
      if (!(tie.shift >= 0 && tie.shift <= ENGINE.tiebreak.maxShift + 1e-9)) {
        problems.push(`${match.id}: ajuste de desempate fuera de rango`);
      }
      if (tie.lean !== "draw" && tie.shift < ENGINE.tiebreak.minShift - 1e-9) {
        problems.push(`${match.id}: ajuste de desempate por debajo del mínimo`);
      }
      if (tie.lean === "draw" && tie.shift !== 0) {
        problems.push(`${match.id}: empate técnico con ajuste distinto de 0`);
      }
    } else {
      if (tie.shift !== 0) problems.push(`${match.id}: desempate no aplica pero shift != 0`);
      if (tie.lean !== "none") problems.push(`${match.id}: desempate no aplica pero lean != none`);
      if (tie.strength !== "none") problems.push(`${match.id}: desempate no aplica pero strength != none`);
    }
    const adjusted = tie.adjustedProbs;
    if (!adjusted) {
      problems.push(`${match.id}: falta tiebreak.adjustedProbs`);
    } else {
      const adjustedSum = adjusted.home + adjusted.draw + adjusted.away;
      if (Math.abs(adjustedSum - 1) > 1e-6) problems.push(`${match.id}: tiebreak adjustedProbs suma ${adjustedSum}`);
      for (const key of ["home", "draw", "away"]) {
        if (!inRange(adjusted[key], 0, 1)) problems.push(`${match.id}: tiebreak adjustedProbs.${key} fuera de rango`);
      }
      if (!tie.applies) {
        for (const key of ["home", "draw", "away"]) {
          if (!close(adjusted[key], a.probs[key], 1e-9)) {
            problems.push(`${match.id}: desempate no aplica pero adjustedProbs.${key} cambia`);
          }
        }
      } else if (adjusted.draw > a.probs.draw + 1e-9) {
        problems.push(`${match.id}: desempate sube el empate`);
      }
    }
  }

  explanationTotal = Object.keys(a.explanations).length;
  const bucket = byLeague.get(match.competition) || { goals: contextGoals ?? LEAGUE.avgGoals, count: 0 };
  bucket.count += 1;
  byLeague.set(match.competition, bucket);

  const top = a.players.home[0];
  console.log(
    `${match.id.padEnd(20)} ${match.competition.slice(0, 18).padEnd(18)}`,
    `1 ${(a.probs.home * 100).toFixed(1)}`,
    `X ${(a.probs.draw * 100).toFixed(1)}`,
    `2 ${(a.probs.away * 100).toFixed(1)}`,
    `| crudo ${(a.rawProbs.home * 100).toFixed(1)}/${(a.rawProbs.draw * 100).toFixed(1)}/${(a.rawProbs.away * 100).toFixed(1)}`,
    `| λ ${a.lambda.home.toFixed(2)}-${a.lambda.away.toFixed(2)}`,
    `| ctx ${(contextGoals ?? LEAGUE.avgGoals).toFixed(3)}`,
    `| ${a.explanations ? Object.keys(a.explanations).length : 0} exp`,
    top ? `| ${top.name} ${(top.p * 100).toFixed(0)}%` : "| sin goleadores",
  );
}

const tieSampleMatch = MATCHES.find((match) => match.id === "espn-401882813");
if (tieSampleMatch) {
  const tieSample = analyzeMatch(tieSampleMatch, TEAMS, LEAGUE);
  if (!tieSample.tiebreak?.applies) {
    problems.push("desempate: el caso 1-1 Espanyol vs Deportivo no se detecta");
  }
  if (!["home", "draw", "away"].includes(tieSample.tiebreak?.lean)) {
    problems.push("desempate: el caso 1-1 no produce un veredicto utilizable");
  }
  if (tieSample.tiebreak?.lean === "draw" && tieSample.tiebreak.shift !== 0) {
    problems.push("desempate: el caso 1-1 técnico no debe transferir probabilidad");
  }
  if (!close(tieSample.tiebreak?.officialProbs?.draw ?? -1, tieSample.probs.draw, 1e-9)) {
    problems.push("desempate: officialProbs no conserva el 1X2 oficial");
  }
}

if (LEAGUE.live) {
  if (!VALIDATION?.overall?.n) {
    problems.push("live sin validación walk-forward");
  } else {
    const v = VALIDATION;
    if (v.method !== "walk-forward") problems.push(`validación con método inesperado: ${v.method}`);
    if (v.overall.n !== v.sample.matches) problems.push("validación: overall.n no coincide con la muestra");
    if (v.leagues.length !== v.sample.leagues) problems.push("validación: número de ligas no coincide");
    for (const [id, market] of Object.entries(v.overall.markets || {})) {
      if (market.n !== v.overall.n) problems.push(`validación: mercado ${id} con muestra distinta`);
      if (!Number.isFinite(market.brier) || !Number.isFinite(market.baseline) || !Number.isFinite(market.skill)) {
        problems.push(`validación: mercado ${id} con métricas inválidas`);
      }
    }
    const leagueTotal = v.leagues.reduce((sum, league) => sum + league.n, 0);
    if (leagueTotal !== v.overall.n) problems.push(`validación: ligas suman ${leagueTotal} y overall ${v.overall.n}`);
    for (const league of v.leagues) {
      if (league.markets?.["1x2"]?.n !== league.n) {
        problems.push(`validación: ${league.name} con 1X2.n distinto de n`);
      }
    }
    for (const key of ["oneX2", "btts", "over25"]) {
      for (const bin of v.calibration?.[key] || []) {
        if (!inRange(bin.predicted, 0, 1) || !inRange(bin.observed, 0, 1)) {
          problems.push(`validación: calibración ${key} fuera de rango`);
        }
      }
    }
    for (const row of v.timeline || []) {
      if (!Number.isFinite(row.skill) || !(row.n >= 5)) problems.push(`validación: fila mensual inválida ${row.month}`);
    }

    // Total de aciertos: pick 1X2 del walk-forward contra el signo real.
    const hits = v.hits;
    if (!hits?.n) {
      problems.push("validación: falta historial de aciertos");
    } else {
      if (!(hits.hits >= 0 && hits.hits <= hits.n)) problems.push("aciertos: hits fuera de la muestra");
      if (!close(hits.rate, hits.hits / hits.n, 1e-9)) problems.push("aciertos: tasa no coincide con hits/n");
      if (!inRange(hits.currentStreak, 0, hits.n)) problems.push("aciertos: racha actual inválida");
      if (!inRange(hits.bestStreak, 1, hits.n)) problems.push("aciertos: mejor racha inválida");
      if (hits.currentStreak > hits.bestStreak) problems.push("aciertos: racha actual mayor que la mejor");
      if (!Array.isArray(hits.recent) || !hits.recent.length) {
        problems.push("aciertos: sin partidos recientes");
      } else {
        for (const row of hits.recent) {
          if (typeof row.hit !== "boolean") problems.push(`aciertos: fila ${row.date} sin hit booleano`);
          if (!inRange(row.probability, 0, 1)) problems.push(`aciertos: fila ${row.date} con probabilidad inválida`);
          if (!row.pick || !row.actual) problems.push(`aciertos: fila ${row.date} sin pick o resultado`);
          if (row.hit !== (row.pick === row.actual)) problems.push(`aciertos: fila ${row.date} con hit incoherente`);
        }
      }
      if (!Array.isArray(hits.byLeague) || !hits.byLeague.length) {
        problems.push("aciertos: sin desglose por liga");
      } else {
        const sumN = hits.byLeague.reduce((sum, row) => sum + row.n, 0);
        const sumHits = hits.byLeague.reduce((sum, row) => sum + row.hits, 0);
        if (sumN !== hits.n) problems.push(`aciertos: ligas suman ${sumN} y total ${hits.n}`);
        if (sumHits !== hits.hits) problems.push(`aciertos: aciertos por liga suman ${sumHits} y total ${hits.hits}`);
        for (const row of hits.byLeague) {
          if (!close(row.rate, row.hits / row.n, 1e-9)) problems.push(`aciertos: tasa de ${row.name} no cuadra`);
        }
      }
    }
  }

  // Equipos latentes: tabla del tercio medio, sorpresas y rachas.
  if (!LATENT?.midTable?.length) {
    problems.push("live sin equipos latentes");
  } else {
    const l = LATENT;
    const s = l.summary || {};
    if (l.midTable.length !== s.midTableTeams) {
      problems.push(`latentes: midTable ${l.midTable.length} no coincide con summary ${s.midTableTeams}`);
    }
    const leagues = new Set(l.midTable.map((row) => row.leagueId));
    if (leagues.size !== s.leagues) problems.push(`latentes: ${leagues.size} ligas y summary ${s.leagues}`);
    if (!inRange(s.overallWinRate, 0, 1)) problems.push("latentes: base de victoria inválida");
    const tones = new Set(["pos", "neutral", "neg"]);
    for (const row of l.midTable) {
      if (!(row.pos >= 1)) problems.push(`latentes: ${row.team} sin posición válida`);
      if (!inRange(row.ppg, 0, 4)) problems.push(`latentes: ${row.team} con PPG inválido`);
      if (!inRange(row.support?.score, 0, 100)) problems.push(`latentes: ${row.team} con índice fuera de rango`);
      if (!tones.has(row.support?.tone)) problems.push(`latentes: ${row.team} con tono inválido`);
      if (!(row.support?.sample >= 0)) problems.push(`latentes: ${row.team} con muestra inválida`);
      const l10 = row.last10 || {};
      if ((l10.w ?? 0) + (l10.d ?? 0) + (l10.l ?? 0) > 10) problems.push(`latentes: ${row.team} con últimos 10 inválidos`);
      if (!Array.isArray(l10.sequence) || l10.sequence.length > 10) problems.push(`latentes: ${row.team} sin secuencia válida`);
      if (row.range && (row.range.start < 1 || row.range.end < row.range.start)) {
        problems.push(`latentes: ${row.team} con rango inválido`);
      }
    }
    const u = l.upsets || {};
    if (u.count !== s.upsets) problems.push(`latentes: sorpresas ${u.count} no coincide con summary ${s.upsets}`);
    for (const key of ["homeShare", "oneGoalShare", "cleanSheetShare", "winnerStreakShare"]) {
      if (!inRange(u[key], 0, 1)) problems.push(`latentes: ${key} fuera de rango`);
    }
    if (!Array.isArray(u.examples) || u.examples.length > u.count) problems.push("latentes: ejemplos de sorpresas inválidos");
    for (const row of u.examples || []) {
      if (!(row.winnerPos > row.loserPos)) problems.push(`latentes: sorpresa ${row.date} sin diferencia de posición`);
      if (!(row.homeGoals >= 0 && row.awayGoals >= 0)) problems.push(`latentes: sorpresa ${row.date} con marcador inválido`);
    }
    const streakN = (l.streakStats || []).reduce((sum, row) => sum + row.n, 0);
    if (streakN !== s.streakSamples) problems.push(`latentes: rachas suman ${streakN} y summary ${s.streakSamples}`);
    for (const row of l.streakStats || []) {
      if (!(row.n >= 0)) problems.push(`latentes: racha ${row.key} con n inválido`);
      if (row.n > 0 && !close(row.winRate + row.drawRate + row.lossRate, 1, 1e-9)) {
        problems.push(`latentes: racha ${row.key} no suma 1`);
      }
      if (row.n > 0 && (row.win + row.draw + row.loss !== row.n)) {
        problems.push(`latentes: racha ${row.key} con conteos incoherentes`);
      }
      if (!row.reading) problems.push(`latentes: racha ${row.key} sin lectura`);
    }
    if (!Array.isArray(l.notes) || !l.notes.length) problems.push("latentes: sin notas metodológicas");
  }

  // Rendimiento de jugadores: muestra compacta, sin duplicar cronologías.
  const teamsWithForm = Object.values(TEAMS).filter((team) => team.playerForm?.sample > 0);
  if (!teamsWithForm.length) {
    problems.push("live sin resúmenes de jugadores");
  } else {
    for (const team of teamsWithForm) {
      const form = team.playerForm;
      if (!form.summary || !(form.summary.goals >= 0) || !(form.summary.conceded >= 0)) {
        problems.push(`jugadores: ${team.name} sin resumen válido`);
      }
      if (!Array.isArray(form.players)) problems.push(`jugadores: ${team.name} sin plantilla`);
      if (!Array.isArray(form.matches) || form.matches.length !== form.sample) {
        problems.push(`jugadores: ${team.name} con partidos distintos de la muestra`);
      }
      for (const player of form.players || []) {
        if (!player.name) problems.push(`jugadores: ${team.name} con jugador sin nombre`);
        if (!(player.matches >= 1)) problems.push(`jugadores: ${player.name} sin partidos`);
        if (!Number.isFinite(player.impact)) problems.push(`jugadores: ${player.name} sin índice`);
        if ((player.goals ?? 0) + (player.assists ?? 0) > 20) problems.push(`jugadores: ${player.name} con aporte imposible`);
      }
      form.matches.forEach((match, index) => {
        const timeline = match.timeline || [];
        for (const row of timeline) {
          if (!["goal", "penalty", "own-goal"].includes(row.kind)) continue;
          if (row.score && !/^\d+-\d+$/.test(row.score)) {
            problems.push(`jugadores: ${team.name} con marcador de cronologia invalido`);
          }
        }
        if (index === 0 && !timeline.length) warnings.push(`jugadores: ${team.name} sin cronología del último partido (opcional en ESPN)`);
        if (index > 0 && timeline.length) problems.push(`jugadores: ${team.name} duplica cronología en partidos antiguos`);
      });
      if (!form.summary.story) problems.push(`jugadores: ${team.name} sin relato`);
    }
  }

  // Tiros reales: el updater solo habilita el blend con muestra suficiente.
  const shotSample = [
    { stats: { hasStats: true, shots: 14 }, rivalStats: { hasStats: true, shots: 9 } },
    { stats: { hasStats: true, shots: 10 }, rivalStats: { hasStats: true, shots: 13 } },
  ];
  const shotTeam = {
    attack: 1.1,
    defense: 0.95,
    shotsFor: 12,
    shotsAgainst: 11,
    estimated: { shots: true },
    playerForm: { matches: shotSample },
  };
  const shotResult = applyShotRates(shotTeam);
  if (!shotResult.applied) problems.push("tiros: no se aplicó con dos partidos completos");
  if (shotTeam.estimated.shots !== false) problems.push("tiros: no se marcó como observado con muestra");
  if (!(shotTeam.shotsFor > 11 && shotTeam.shotsFor < 14)) problems.push("tiros: contracción de tiros a favor fuera de rango");
  if (!(shotTeam.shotsAgainst > 9 && shotTeam.shotsAgainst < 13)) problems.push("tiros: contracción de tiros en contra fuera de rango");
  if (shotTeam.shotsSample?.matches !== 2) problems.push("tiros: muestra guardada incorrecta");

  const rivalTeam = {
    ...shotTeam,
    shotsFor: 10,
    shotsAgainst: 12,
    shotsSample: { matches: 2 },
  };
  const blendOn = shotsBlend(shotTeam, rivalTeam);
  if (!blendOn.applied) problems.push("tiros: el blend no se activó con muestra real");
  if (!blendOn.samples || blendOn.samples.home !== 2 || blendOn.samples.away !== 2) {
    problems.push("tiros: el blend no reporta la muestra");
  }
  if (blendOn.multipliers.home === 1 && blendOn.multipliers.away === 1) {
    problems.push("tiros: el blend no cambió ningún multiplicador");
  }

  const estimatedTeam = { ...shotTeam, estimated: { shots: true } };
  const blendOff = shotsBlend(estimatedTeam, rivalTeam);
  if (blendOff.applied) problems.push("tiros: el blend se activó con una estimación");

  const emptyTeam = {
    ...shotTeam,
    estimated: { shots: true },
    playerForm: { matches: [] },
  };
  const emptyResult = applyShotRates(emptyTeam);
  if (emptyResult.applied) problems.push("tiros: se aplicó sin muestra");
  if (emptyTeam.estimated.shots !== true) problems.push("tiros: sin muestra debería seguir estimado");
  if (emptyTeam.shotsSource !== "estimated") problems.push("tiros: sin muestra debería declarar fuente estimada");

  const oneMatchTeam = {
    ...shotTeam,
    estimated: { shots: true },
    playerForm: { matches: [shotSample[0]] },
  };
  const oneMatchResult = applyShotRates(oneMatchTeam);
  if (oneMatchResult.applied) problems.push("tiros: se aplicó con un solo partido");
  if (oneMatchTeam.estimated.shots !== true) problems.push("tiros: un partido no debería marcar observado");
}

console.log("");
console.log(`Partidos: ${MATCHES.length} · equipos: ${Object.keys(TEAMS).length} · ligas: ${byLeague.size}`);
console.log(`Explicaciones por partido: ${explanationTotal}`);
console.log(`Desempate: ${tiebreakCount} partidos parejos con lectura ajustada`);
console.log(
  "Contexto por liga:",
  [...byLeague].map(([name, bucket]) => `${name} ${bucket.goals.toFixed(3)} (${bucket.count})`).join(" · "),
);
if (LEAGUE.live && VALIDATION?.overall?.n) {
  const v = VALIDATION;
  console.log(
    `Validación: ${v.sample.matches} partidos · ${v.sample.leagues} ligas ·`,
    `skill 1X2 ${(v.overall.markets["1x2"].skill * 100).toFixed(1)}% ·`,
    `BTTS ${(v.overall.markets.btts.skill * 100).toFixed(1)}%`,
  );
  if (v.hits?.n) {
    console.log(`Aciertos 1X2: ${v.hits.hits}/${v.hits.n} = ${(v.hits.rate * 100).toFixed(1)}% · mejor racha ${v.hits.bestStreak}`);
  }
}
if (LEAGUE.live && LATENT?.midTable?.length) {
  console.log(
    `Latentes: ${LATENT.summary.midTableTeams} equipos · ${LATENT.summary.upsets} sorpresas ·`,
    `${LATENT.summary.streakSamples} casos de racha · base ${(LATENT.summary.overallWinRate * 100).toFixed(1)}%`,
  );
  console.log(`Jugadores: ${Object.values(TEAMS).filter((team) => team.playerForm?.sample > 0).length} equipos con resumen reciente`);
}

if (warnings.length) {
  console.warn(`\n${warnings.length} aviso(s) (datos opcionales):`);
  for (const warning of warnings) console.warn(`- [AVISO] ${warning}`);
}

if (problems.length) {
  console.error(`\n${problems.length} problema(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\nOK: OX V1.0 coherente (1X2, goles, forma, H2H, desempate, tiempos, matriz, escenarios, proyección VE y validación).");
}
