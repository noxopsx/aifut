// Desempate de partidos parejos.
//
// Es una capa separada del 1X2 oficial. MOTOR-NOX V1.0 conserva sus
// probabilidades y esta lectura solo responde a una pregunta:
// cuando el empate es alto, ¿hay señales suficientes para inclinar la
// lectura hacia un lado o el partido sigue siendo un empate técnico?
//
// Señales propias, con pesos explícitos:
//   desempeño previo 38%, H2H 18%, goles esperados 16%,
//   córners 12%, tarjetas 8% y localía 8%.
//
// La fórmula es un promedio ponderado de señales en [-1, 1]. El resultado
// se contrae por la fiabilidad de los datos y solo se transfiere al 1X2
// cuando supera el umbral de empate técnico.

import { ENGINE } from "./calibration.js";
import { clamp } from "./math.js";

const signed = (value, digits = 2) => {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : "−"}${Math.abs(number).toFixed(digits)}`;
};

const pct = (value, digits = 1) => `${(Number(value) * 100).toFixed(digits)}%`;

function toneOf(signal) {
  if (signal > 0.02) return "pos";
  if (signal < -0.02) return "neg";
  return "neutral";
}

function signalFrom(value, scale) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isFinite(scale) || scale <= 0) return 0;
  return clamp(number / scale, -1, 1);
}

function recentPoints(profile) {
  const last = Array.isArray(profile?.last) ? profile.last : [];
  const results = last
    .map((row) => String(row?.result || "").toUpperCase())
    .filter((result) => ["W", "D", "L"].includes(result));
  if (!results.length) return null;
  const points = results.reduce((sum, result) => (
    sum + (result === "W" ? 3 : result === "D" ? 1 : 0)
  ), 0);
  return {
    points,
    games: results.length,
    ppg: points / results.length,
  };
}

function standingPpg(team) {
  const standing = team?.standing;
  const played = Number(standing?.pj);
  const points = Number(standing?.pts);
  if (!(played > 0) || !Number.isFinite(points)) return null;
  return points / played;
}

function standingGoalDiff(team) {
  const standing = team?.standing;
  const played = Number(standing?.pj);
  const goalsFor = Number(standing?.gf);
  const goalsAgainst = Number(standing?.gc);
  if (!(played > 0) || !Number.isFinite(goalsFor) || !Number.isFinite(goalsAgainst)) return null;
  return (goalsFor - goalsAgainst) / played;
}

function makeSignal({
  key,
  label,
  weight,
  signal,
  homeValue,
  awayValue,
  unit,
  detail,
  available = true,
  estimated = false,
  reliability = 1,
}) {
  const value = available ? clamp(Number(signal) || 0, -1, 1) : 0;
  return {
    key,
    label,
    weight,
    signal: value,
    homeValue,
    awayValue,
    unit,
    detail,
    available,
    estimated,
    reliability: clamp(Number(reliability) || 0, 0, 1),
    tone: available ? toneOf(value) : "neutral",
    contribution: available ? weight * value : 0,
  };
}

function performanceSignal(home, away) {
  const cfg = ENGINE.tiebreak;
  const homeRecent = home.recent?.available ? home.recent : null;
  const awayRecent = away.recent?.available ? away.recent : null;
  const homePoints = recentPoints(homeRecent);
  const awayPoints = recentPoints(awayRecent);
  const homePpg = homePoints?.ppg ?? standingPpg(home) ?? 1.35;
  const awayPpg = awayPoints?.ppg ?? standingPpg(away) ?? 1.35;
  const homeGd = homeRecent
    ? homeRecent.gfPerMatch - homeRecent.gaPerMatch
    : standingGoalDiff(home) ?? 0;
  const awayGd = awayRecent
    ? awayRecent.gfPerMatch - awayRecent.gaPerMatch
    : standingGoalDiff(away) ?? 0;
  const ppgDiff = homePpg - awayPpg;
  const gdDiff = homeGd - awayGd;
  const signal = clamp(
    0.65 * (ppgDiff / 1.2) + 0.35 * (gdDiff / 1.2),
    -1,
    1,
  );
  const bothRecent = Boolean(homeRecent && awayRecent);
  const anyRecent = Boolean(homeRecent || awayRecent);
  const source = bothRecent
    ? "últimos 10"
    : anyRecent
      ? "mezcla últimos 10/tabla"
      : "tabla";
  return makeSignal({
    key: "performance",
    label: "Desempeño previo",
    weight: cfg.weights.performance,
    signal,
    homeValue: homePpg.toFixed(2),
    awayValue: awayPpg.toFixed(2),
    unit: "PPG",
    detail: `${home.short} ${homePpg.toFixed(2)} PPG (${signed(homeGd, 2)} DG) · ${away.short} ${awayPpg.toFixed(2)} PPG (${signed(awayGd, 2)} DG) · ${source}.`,
    reliability: bothRecent
      ? cfg.reliability.performance
      : anyRecent
        ? 0.85
        : cfg.reliability.performanceFallback,
  });
}

function h2hSignal(match, home, away) {
  const cfg = ENGINE.tiebreak;
  const h2h = match?.h2h;
  const played = Number(h2h?.played) || 0;
  const available = Boolean(h2h?.available && played >= 3);
  const signal = available
    ? clamp(
      0.65 * ((h2h.homeWins - h2h.awayWins) / played)
      + 0.35 * ((h2h.goalsHome - h2h.goalsAway) / (played * 2)),
      -1,
      1,
    )
    : 0;
  return makeSignal({
    key: "h2h",
    label: "Historial directo",
    weight: cfg.weights.h2h,
    signal,
    homeValue: available ? String(h2h.homeWins) : "—",
    awayValue: available ? String(h2h.awayWins) : "—",
    unit: available ? "victorias" : "",
    detail: available
      ? `${played} partidos: ${h2h.homeWins}-${h2h.draws}-${h2h.awayWins}; goles ${h2h.goalsHome}-${h2h.goalsAway}.`
      : "Sin muestra suficiente (mínimo 3 partidos).",
    available,
    reliability: cfg.reliability.h2h,
  });
}

function goalsSignal(analysis) {
  const cfg = ENGINE.tiebreak;
  const diff = analysis.lambda.home - analysis.lambda.away;
  return makeSignal({
    key: "goals",
    label: "Goles esperados",
    weight: cfg.weights.goals,
    signal: signalFrom(diff, 1.2),
    homeValue: analysis.lambda.home.toFixed(2),
    awayValue: analysis.lambda.away.toFixed(2),
    unit: "λ",
    detail: `Diferencia de goles esperados: ${signed(diff, 2)}.`,
    reliability: cfg.reliability.goals,
  });
}

function cornersSignal(analysis) {
  const cfg = ENGINE.tiebreak;
  const { metrics, home, away, league } = analysis;
  const diff = metrics.corners.home - metrics.corners.away;
  const estimated = Boolean(league.live || home.estimated?.corners || away.estimated?.corners);
  return makeSignal({
    key: "corners",
    label: "Córners",
    weight: cfg.weights.corners,
    signal: signalFrom(diff, 3),
    homeValue: metrics.corners.home.toFixed(1),
    awayValue: metrics.corners.away.toFixed(1),
    unit: "córners",
    detail: `Total ${metrics.corners.total.toFixed(1)}${estimated ? " · estimado de liga" : ""}. Diferencia ${signed(diff, 2)}.`,
    estimated,
    reliability: estimated ? cfg.reliability.cornersEstimated : cfg.reliability.corners,
  });
}

function cardsSignal(analysis) {
  const cfg = ENGINE.tiebreak;
  const { metrics, home, away, league } = analysis;
  const diff = metrics.cards.away - metrics.cards.home;
  const estimated = Boolean(league.live || home.estimated?.cards || away.estimated?.cards);
  return makeSignal({
    key: "cards",
    label: "Tarjetas",
    weight: cfg.weights.cards,
    signal: signalFrom(diff, 2.5),
    homeValue: metrics.cards.home.toFixed(1),
    awayValue: metrics.cards.away.toFixed(1),
    unit: "tarjetas",
    detail: `Menos tarjetas = mejor disciplina. Diferencia ${signed(diff, 2)}${estimated ? " · estimado de liga" : ""}.`,
    estimated,
    reliability: estimated ? cfg.reliability.cardsEstimated : cfg.reliability.cards,
  });
}

function venueSignal(analysis) {
  const cfg = ENGINE.tiebreak;
  const { match, home } = analysis;
  const signal = match.neutral ? 0 : 0.5;
  return makeSignal({
    key: "venue",
    label: "Localía",
    weight: cfg.weights.venue,
    signal,
    homeValue: match.neutral ? "Neutral" : home.abbr,
    awayValue: match.neutral ? "Neutral" : "—",
    unit: "",
    detail: match.neutral
      ? "Sede neutral: sin ventaja de localía."
      : `${home.short} juega en ${match.venue}.`,
    reliability: cfg.reliability.venue,
  });
}

function detection(analysis) {
  const cfg = ENGINE.tiebreak;
  const { probs, topScores } = analysis;
  const top = topScores?.[0] || { home: 0, away: 0, p: 0 };
  const favorite = Math.max(probs.home, probs.away);
  const drawGap = probs.draw - favorite;
  const topIsDraw = top.home === top.away;
  const topIsShortDraw = topIsDraw && top.home + top.away <= 2;
  const drawHigh = probs.draw >= cfg.drawHigh;
  const drawLeads = drawGap >= 0 && drawGap <= cfg.marginalDrawEdge;
  const drawClose = drawGap >= -cfg.marginalDrawEdge;
  const triggers = [];
  if (topIsShortDraw) triggers.push("marcador corto empatado");
  if (drawLeads) triggers.push("empate líder a ≤5 pp");
  if (topIsDraw && drawClose) triggers.push("marcador empatado cerca del favorito");
  const applies = drawHigh && triggers.length > 0;
  return {
    top,
    favorite,
    drawGap,
    drawHigh,
    drawLeads,
    drawClose,
    topIsDraw,
    topIsShortDraw,
    triggers,
    applies,
  };
}

function reasonFor(analysis, det) {
  const cfg = ENGINE.tiebreak;
  const { probs } = analysis;
  const { top, drawGap, drawHigh, applies, triggers } = det;
  if (!drawHigh) {
    // Si el redondeo a un decimal muestra el mismo valor que el umbral,
    // se usa un decimal más para no afirmar que 28.0% está por debajo de 28%.
    const nearThreshold = cfg.drawHigh - probs.draw < 0.001;
    const drawText = pct(probs.draw, nearThreshold ? 2 : 1);
    return `El empate (${drawText}) no alcanza el umbral de ${pct(cfg.drawHigh, 0)}; no se aplica desempate.`;
  }
  if (!applies) {
    const gapText = drawGap >= 0
      ? `el empate lidera por ${(drawGap * 100).toFixed(1)} pp`
      : `el empate queda a ${Math.abs(drawGap * 100).toFixed(1)} pp del favorito`;
    return `El empate es alto (${pct(probs.draw)}), pero el marcador más probable es ${top.home}-${top.away} y ${gapText}; no se aplica desempate.`;
  }
  return `Empate ${pct(probs.draw)} · marcador ${top.home}-${top.away} · ${triggers.join(" · ")}.`;
}

export function buildTiebreak(analysis) {
  const cfg = ENGINE.tiebreak;
  const { probs, match, home, away } = analysis;
  const det = detection(analysis);
  const signals = [
    performanceSignal(home, away),
    h2hSignal(match, home, away),
    goalsSignal(analysis),
    cornersSignal(analysis),
    cardsSignal(analysis),
    venueSignal(analysis),
  ];
  const available = signals.filter((signal) => signal.available);
  const totalWeight = available.reduce((sum, signal) => sum + signal.weight, 0);
  const allWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const weightedSignal = available.reduce((sum, signal) => sum + signal.weight * signal.signal, 0);
  const weightedReliability = available.reduce((sum, signal) => sum + signal.weight * signal.reliability, 0);
  const edge = totalWeight > 0 ? weightedSignal / totalWeight : 0;
  const reliability = totalWeight > 0 ? weightedReliability / totalWeight : 0;
  const coverage = allWeight > 0 ? totalWeight / allWeight : 0;
  const effectiveEdge = edge * reliability;
  const absEdge = Math.abs(effectiveEdge);
  const threshold = cfg.leanThreshold;
  const lean = !det.applies
    ? "none"
    : absEdge <= threshold
      ? "draw"
      : effectiveEdge > 0
        ? "home"
        : "away";
  const strength = !det.applies
    ? "none"
    : absEdge <= threshold
      ? "technical"
      : absEdge < 0.15
        ? "slight"
        : absEdge < 0.3
          ? "moderate"
          : "clear";
  const leanTeamRaw = lean === "home" ? home : lean === "away" ? away : null;
  const leanTeam = leanTeamRaw
    ? { ...leanTeamRaw, short: String(leanTeamRaw.short || "").trim() }
    : null;
  const baseShift = leanTeam
    ? clamp(
      cfg.minShift + (absEdge - threshold) * cfg.shiftScale / 100,
      cfg.minShift,
      cfg.maxShift,
    )
    : 0;
  const shift = det.applies ? baseShift : 0;
  const adjustedProbs = {
    home: probs.home,
    draw: probs.draw,
    away: probs.away,
  };
  if (shift > 0 && leanTeam) {
    const delta = shift;
    adjustedProbs.draw = Math.max(0.001, adjustedProbs.draw - delta);
    adjustedProbs[lean] = Math.min(0.999, adjustedProbs[lean] + delta);
    const total = adjustedProbs.home + adjustedProbs.draw + adjustedProbs.away;
    adjustedProbs.home /= total;
    adjustedProbs.draw /= total;
    adjustedProbs.away /= total;
  }

  const strengthLabels = {
    technical: "técnica",
    slight: "leve",
    moderate: "moderada",
    clear: "clara",
  };
  const verdict = !det.applies
    ? "No aplica"
    : lean === "draw"
      ? "Empate técnico"
      : `Inclinación ${strengthLabels[strength]} hacia ${leanTeam.short}`;
  const reason = reasonFor(analysis, det);
  const topSignal = available.length
    ? [...available].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))[0]
    : null;
  const summary = !det.applies
    ? reason
    : lean === "draw"
      ? `Las señales quedan dentro del umbral de ${pct(threshold, 0)}. El empate se mantiene como lectura y no se transfiere probabilidad.`
      : `La señal con más peso es ${topSignal ? topSignal.label.toLowerCase() : "el conjunto"} (${topSignal ? signed(topSignal.signal, 2) : "0.00"}). Se transfieren ${(shift * 100).toFixed(1)} pp del empate a ${leanTeam.short}; el 1X2 oficial no cambia.`;
  const badge = !det.applies
    ? "No aplica"
    : lean === "draw"
      ? "Empate técnico"
      : `Inclinación a ${leanTeam.abbr}`;
  const badgeDetail = !det.applies
    ? reason
    : lean === "draw"
      ? "sin ajuste"
      : `−${(shift * 100).toFixed(1)} pp al empate`;
  const shortReason = !det.applies
    ? !det.drawHigh
      ? `Empate ${pct(probs.draw, cfg.drawHigh - probs.draw < 0.001 ? 2 : 0)}`
      : `Marcador ${det.top.home}-${det.top.away}`
    : lean === "draw"
      ? `Edge ${signed(edge, 2)}`
      : `−${(shift * 100).toFixed(1)} pp`;
  const officialWinGap = probs.home - probs.away;
  const adjustedWinGap = adjustedProbs.home - adjustedProbs.away;
  const adjustedDrawGap = adjustedProbs.draw - Math.max(adjustedProbs.home, adjustedProbs.away);
  const notes = [
    `El 1X2 oficial no cambia: ${pct(probs.home)} / ${pct(probs.draw)} / ${pct(probs.away)}.`,
  ];
  if (det.applies) {
    notes.push(`Lectura ajustada: ${pct(adjustedProbs.home)} / ${pct(adjustedProbs.draw)} / ${pct(adjustedProbs.away)}.`);
  }
  if (analysis.league.live) {
    notes.push(`Córners y tarjetas son estimaciones de liga; su fiabilidad baja a ${pct(cfg.reliability.cornersEstimated, 0)}.`);
  }
  if (!available.some((signal) => signal.key === "h2h")) {
    notes.push("H2H sin muestra suficiente; su peso se reparte entre las señales disponibles.");
  }
  if (det.applies && lean === "draw") {
    notes.push(`Umbral de empate técnico: |edge ajustado| ≤ ${pct(threshold, 0)}.`);
  }
  if (shift > 0) {
    notes.push(`Se transfieren ${(shift * 100).toFixed(1)} pp del empate a ${leanTeam.short}.`);
  }

  const formula = "edge = Σ(peso_i × señal_i) / Σ(peso_i); edge_ajustado = edge × fiabilidad.";
  const formulaNote = `Si |edge_ajustado| ≤ ${pct(threshold, 0)}, es empate técnico. Si no, el ajuste va de ${(cfg.minShift * 100).toFixed(1)} a ${(cfg.maxShift * 100).toFixed(0)} pp desde el empate hacia el lado con mejor edge.`;
  const steps = [
    {
      label: "1X2 oficial",
      value: `${pct(probs.home)} / ${pct(probs.draw)} / ${pct(probs.away)}`,
      note: "No cambia",
    },
    {
      label: "Detección",
      value: `Empate ${pct(probs.draw)} · ${det.top.home}-${det.top.away}`,
      note: det.applies ? det.triggers.join(" · ") : reason,
    },
    {
      label: "Señales",
      value: `${available.length} de ${signals.length}`,
      note: `Cobertura ${pct(coverage, 0)}`,
    },
    {
      label: "Edge",
      value: signed(edge, 3),
      note: `Fiabilidad ${pct(reliability, 0)}`,
    },
    {
      label: "Edge ajustado",
      value: signed(effectiveEdge, 3),
      note: `Umbral ±${pct(threshold, 0)}`,
    },
    {
      label: "Veredicto",
      value: verdict,
      note: det.applies
        ? lean === "draw"
          ? "Sin transferencia"
          : `−${(shift * 100).toFixed(1)} pp al empate`
        : "No aplica",
    },
    {
      label: "Lectura ajustada",
      value: `${pct(adjustedProbs.home)} / ${pct(adjustedProbs.draw)} / ${pct(adjustedProbs.away)}`,
      note: det.applies ? "Capa separada" : "Igual al oficial",
    },
  ];

  return {
    applies: det.applies,
    reason,
    shortReason,
    drawHigh: det.drawHigh,
    drawGap: det.drawGap,
    drawClose: det.drawClose,
    drawLeads: det.drawLeads,
    topIsDraw: det.topIsDraw,
    topIsShortDraw: det.topIsShortDraw,
    triggers: det.triggers,
    topScore: det.top,
    threshold: cfg.drawHigh,
    leanThreshold: threshold,
    signals,
    weights: { ...cfg.weights },
    edge,
    effectiveEdge,
    reliability,
    coverage,
    lean,
    strength,
    verdict,
    summary,
    badge,
    badgeDetail,
    officialProbs: { ...probs },
    adjustedProbs,
    officialWinGap,
    adjustedWinGap,
    adjustedDrawGap,
    shift,
    leanTeam,
    topSignal,
    formula,
    formulaNote,
    steps,
    note: notes.join(" "),
    engine: {
      drawHigh: cfg.drawHigh,
      marginalDrawEdge: cfg.marginalDrawEdge,
      leanThreshold: cfg.leanThreshold,
      minShift: cfg.minShift,
      maxShift: cfg.maxShift,
      shiftScale: cfg.shiftScale,
    },
  };
}
