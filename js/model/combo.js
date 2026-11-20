// Escenarios: probabilidad conjunta desde la matriz de marcadores.
// Para mercados de goles/1X2/BTTS la conjunta es exacta (se recorren las
// celdas de la matriz). Para córners y tarjetas se usa la independencia del
// modelo y se advierte en la interfaz. No se usan precios externos.

import { matrixJoint } from "./math.js";

export const COMBO_MARKETS = [
  {
    id: "home",
    group: "result",
    kind: "goal",
    label: (a) => `Gana ${a.home.short}`,
    short: (a) => `1 · ${a.home.abbr}`,
    condition: (i, j) => i > j,
  },
  {
    id: "draw",
    group: "result",
    kind: "goal",
    label: () => "Empate",
    short: () => "X",
    condition: (i, j) => i === j,
  },
  {
    id: "away",
    group: "result",
    kind: "goal",
    label: (a) => `Gana ${a.away.short}`,
    short: (a) => `2 · ${a.away.abbr}`,
    condition: (i, j) => i < j,
  },
  {
    id: "homeOrDraw",
    group: "double",
    kind: "goal",
    label: (a) => `${a.home.short} o empate`,
    short: (a) => `1X · ${a.home.abbr}`,
    condition: (i, j) => i >= j,
  },
  {
    id: "drawOrAway",
    group: "double",
    kind: "goal",
    label: (a) => `Empate o ${a.away.short}`,
    short: (a) => `X2 · ${a.away.abbr}`,
    condition: (i, j) => i <= j,
  },
  {
    id: "homeOrAway",
    group: "double",
    kind: "goal",
    label: () => "Sin empate",
    short: () => "12",
    condition: (i, j) => i !== j,
  },
  {
    id: "over15",
    group: "goals",
    kind: "goal",
    label: () => "Más de 1.5 goles",
    short: () => "Over 1.5",
    condition: (i, j) => i + j >= 2,
  },
  {
    id: "under15",
    group: "goals",
    kind: "goal",
    label: () => "Menos de 1.5 goles",
    short: () => "Under 1.5",
    condition: (i, j) => i + j <= 1,
  },
  {
    id: "over25",
    group: "goals",
    kind: "goal",
    label: () => "Más de 2.5 goles",
    short: () => "Over 2.5",
    condition: (i, j) => i + j >= 3,
  },
  {
    id: "under25",
    group: "goals",
    kind: "goal",
    label: () => "Menos de 2.5 goles",
    short: () => "Under 2.5",
    condition: (i, j) => i + j <= 2,
  },
  {
    id: "over35",
    group: "goals",
    kind: "goal",
    label: () => "Más de 3.5 goles",
    short: () => "Over 3.5",
    condition: (i, j) => i + j >= 4,
  },
  {
    id: "under35",
    group: "goals",
    kind: "goal",
    label: () => "Menos de 3.5 goles",
    short: () => "Under 3.5",
    condition: (i, j) => i + j <= 3,
  },
  {
    id: "btts",
    group: "btts",
    kind: "goal",
    label: () => "Ambos anotan",
    short: () => "BTTS sí",
    condition: (i, j) => i > 0 && j > 0,
  },
  {
    id: "bttsNo",
    group: "btts",
    kind: "goal",
    label: () => "No ambos anotan",
    short: () => "BTTS no",
    condition: (i, j) => i === 0 || j === 0,
  },
  {
    id: "over95corners",
    group: "corners",
    kind: "independent",
    label: () => "Más de 9.5 córners",
    short: () => "Over 9.5 córners",
    probability: (a) => a.metrics.corners.over95,
  },
  {
    id: "under95corners",
    group: "corners",
    kind: "independent",
    label: () => "Menos de 9.5 córners",
    short: () => "Under 9.5 córners",
    probability: (a) => 1 - a.metrics.corners.over95,
  },
  {
    id: "over45cards",
    group: "cards",
    kind: "independent",
    label: () => "Más de 4.5 tarjetas",
    short: () => "Over 4.5 tarjetas",
    probability: (a) => a.metrics.cards.over45,
  },
  {
    id: "under45cards",
    group: "cards",
    kind: "independent",
    label: () => "Menos de 4.5 tarjetas",
    short: () => "Under 4.5 tarjetas",
    probability: (a) => 1 - a.metrics.cards.over45,
  },
];

export function comboLegs(a) {
  return COMBO_MARKETS.map((market) => {
    const p = market.kind === "goal"
      ? matrixJoint(a.matrix, [market.condition])
      : market.probability(a);
    return {
      ...market,
      p,
      label: market.label(a),
      short: market.short(a),
    };
  });
}

function independentJoint(legs) {
  const groups = new Map();
  for (const leg of legs) {
    if (leg.kind !== "independent") continue;
    const current = groups.get(leg.group) || [];
    current.push(leg);
    groups.set(leg.group, current);
  }
  let probability = 1;
  const contradictions = [];
  for (const [group, groupLegs] of groups) {
    if (groupLegs.length > 1) {
      const unique = new Set(groupLegs.map((leg) => leg.id));
      if (unique.size > 1) {
        contradictions.push(group);
        continue;
      }
    }
    probability *= groupLegs[0].p;
  }
  return { probability, contradictions };
}

export function jointProbability(a, ids) {
  const wanted = [...new Set((ids || []).filter(Boolean))];
  const legs = wanted
    .map((id) => COMBO_MARKETS.find((market) => market.id === id))
    .filter(Boolean)
    .map((market) => ({
      ...market,
      p: market.kind === "goal"
        ? matrixJoint(a.matrix, [market.condition])
        : market.probability(a),
      label: market.label(a),
      short: market.short(a),
    }));
  const goalLegs = legs.filter((leg) => leg.kind === "goal");
  const independentLegs = legs.filter((leg) => leg.kind === "independent");
  const goalProbability = matrixJoint(a.matrix, goalLegs.map((leg) => leg.condition));
  const independent = independentJoint(independentLegs);
  const probability = independent.contradictions.length ? 0 : goalProbability * independent.probability;
  return {
    ids: wanted,
    legs,
    probability: Math.max(0, Math.min(1, probability)),
    goalProbability,
    independentProbability: independent.probability,
    exact: independentLegs.length === 0,
    contradictions: independent.contradictions,
    hasGoalLegs: goalLegs.length > 0,
    hasIndependentLegs: independentLegs.length > 0,
  };
}

export function evaluateCombo(a, ids) {
  const joint = jointProbability(a, ids);
  const p = joint.probability;
  const warnings = [];
  if (joint.contradictions.length) warnings.push("Hay selecciones incompatibles en el mismo mercado.");
  if (!joint.contradictions.length && p === 0) warnings.push("Las condiciones elegidas no pueden ocurrir a la vez.");
  if (p > 0 && p < 0.02) warnings.push("Probabilidad conjunta muy baja: el escenario es poco probable.");
  if (joint.ids.length > 4) warnings.push("Muchas condiciones: el error de estimación se acumula.");
  if (joint.hasIndependentLegs) warnings.push("Córners y tarjetas se combinan por independencia del modelo, no por una matriz conjunta.");
  return {
    ...joint,
    complement: 1 - p,
    warnings,
    correlation: joint.hasIndependentLegs
      ? "Goles/1X2/BTTS exactos desde la matriz; córners y tarjetas por independencia."
      : "Probabilidad conjunta exacta desde la matriz de marcadores.",
  };
}
