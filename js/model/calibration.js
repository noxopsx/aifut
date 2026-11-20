// OX V1.0 · capa de calibración.
// Inspirado en el flujo observado en FutbolData Pro (temperatura 1X2, forma,
// blend de tiros y calibración), pero con fórmulas, pesos y constantes propias.
// No contiene código ni parámetros copiados del modelo propietario.

export const CALIBRATION_VERSION = "1.0";

export const ENGINE = {
  id: "motor-nox-v1",
  label: "OX V1.0",
  version: CALIBRATION_VERSION,
  // Temperatura del 1X2: >1 suaviza las probabilidades extremas.
  temperature1x2: 1.15,
  // Pendiente de la curva Platt para mercados binarios.
  binarySlope: 0.85,
  // Forma: 0.85 + 0.02 × puntos. El peso baja cuando ya hay historial
  // reciente de goles para no contar dos veces la misma señal.
  formBase: 0.85,
  formPerPoint: 0.02,
  formWeight: 0.6,
  formWeightRecent: 0.35,
  formMin: 0.85,
  formMax: 1.15,
  // Mezcla de la fuerza de goles con la fuerza de tiros (solo datos reales).
  shotsBlendWeight: 0.2,
  // Muestra mínima y prior para estabilizar los tiros observados por equipo.
  // Con 2-3 partidos la media es ruidosa: se contrae hacia la estimación.
  shotsMinMatches: 2,
  shotsPriorMatches: 4,
  // Rango de la ventaja de localía neta por liga.
  venueEdgeMin: 0.02,
  venueEdgeMax: 0.16,
  // Historial reciente por equipo: ventana, decaimiento y mezcla con la tabla.
  recentWindow: 10,
  recentHalfLifeDays: 45,
  recentWeight: 0.6,
  recentCoverageMatches: 6,
  recentShrink: 3,
  // Historial directo: peso conservador y mínimo de partidos.
  h2hWeight: 0.12,
  h2hMinMatches: 3,
  h2hMaxMatches: 6,
  // Reparto de goles entre tiempos (referencia histórica conservadora).
  firstHalfShare: 0.44,
  // Desempate de partidos parejos. Es una capa separada del 1X2 oficial:
  // detecta empates altos, pondera señales y produce una lectura ajustada.
  tiebreak: {
    drawHigh: 0.28,
    marginalDrawEdge: 0.05,
    leanThreshold: 0.04,
    minShift: 0.015,
    maxShift: 0.06,
    shiftScale: 8,
    weights: {
      performance: 0.38,
      h2h: 0.18,
      goals: 0.16,
      corners: 0.12,
      cards: 0.08,
      venue: 0.08,
    },
    reliability: {
      performance: 0.95,
      performanceFallback: 0.75,
      h2h: 0.9,
      goals: 0.85,
      corners: 0.9,
      cornersEstimated: 0.55,
      cards: 0.9,
      cardsEstimated: 0.55,
      venue: 1,
    },
  },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const FACT = [1];
for (let i = 1; i <= 24; i += 1) FACT[i] = FACT[i - 1] * i;

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k];
}

function poissonOver(line, lambda) {
  const max = Math.floor(line);
  let cdf = 0;
  for (let k = 0; k <= max; k += 1) cdf += poissonPmf(k, lambda);
  return clamp(1 - cdf, 0, 1);
}

export function logit(probability) {
  const p = clamp(Number(probability), 1e-6, 1 - 1e-6);
  return Math.log(p / (1 - p));
}

export function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

export function normalizeProbs(probs) {
  const home = Math.max(0, Number(probs.home) || 0);
  const draw = Math.max(0, Number(probs.draw) || 0);
  const away = Math.max(0, Number(probs.away) || 0);
  const total = home + draw + away;
  if (!total) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: home / total, draw: draw / total, away: away / total };
}

// Temperature scaling: p_final = normalize(p_cruda^(1/T)).
export function temperatureScale(probs, temperature = ENGINE.temperature1x2) {
  const t = clamp(Number(temperature) || 1, 0.7, 2.5);
  const values = [probs.home, probs.draw, probs.away].map((p) => (
    Math.pow(clamp(Number(p) || 0, 1e-9, 1), 1 / t)
  ));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return {
    home: values[0] / total,
    draw: values[1] / total,
    away: values[2] / total,
  };
}

// Base de liga para mercados binarios: un partido con dos equipos promedio.
// Se usa como ancla de la curva Platt, no como probabilidad final.
export function binaryBaseRates(league = {}) {
  const mu = clamp(Number(league.avgGoals) || 1.35, 0.45, 3.2);
  const total = 2 * mu;
  return {
    over15: poissonOver(1.5, total),
    over25: poissonOver(2.5, total),
    over35: poissonOver(3.5, total),
    btts: Math.pow(1 - Math.exp(-mu), 2),
  };
}

// Calibración tipo Platt anclada a la base de la liga:
// logit(p_final) = logit(p_base) + b × [logit(p_cruda) - logit(p_base)].
export function plattCalibrate(rawProbability, baseProbability, slope = ENGINE.binarySlope) {
  const raw = clamp(Number(rawProbability) || 0.5, 0.001, 0.999);
  const base = clamp(Number(baseProbability) || 0.5, 0.001, 0.999);
  const b = clamp(Number(slope) || 1, 0.4, 1.2);
  const center = logit(base);
  return clamp(sigmoid(center + b * (logit(raw) - center)), 0.001, 0.999);
}

export function calibrateBinary(raw, league = {}) {
  const bases = binaryBaseRates(league);
  return {
    over15: plattCalibrate(raw.over15, bases.over15),
    over25: plattCalibrate(raw.over25, bases.over25),
    over35: plattCalibrate(raw.over35, bases.over35),
    btts: plattCalibrate(raw.btts, bases.btts),
  };
}

const FORM_POINTS = {
  W: 3, D: 1, L: 0,
  G: 3, E: 1, P: 0,
};

export function formPoints(form) {
  if (!Array.isArray(form)) return null;
  const results = form
    .map((result) => FORM_POINTS[String(result).trim().toUpperCase()])
    .filter((value) => value !== undefined);
  if (!results.length) return null;
  return results.reduce((sum, value) => sum + value, 0);
}

// Factor de forma independiente: se inspira en la dirección observada
// (0.85 + 0.02 × puntos), pero se aplica con peso 60% y cobertura por muestra.
export function formFactor(form, weight = ENGINE.formWeight) {
  const results = Array.isArray(form)
    ? form.filter((result) => FORM_POINTS[String(result).trim().toUpperCase()] !== undefined)
    : [];
  const points = formPoints(results);
  const appliedWeight = clamp(Number(weight) || 0, 0, 1);
  if (points === null) {
    return {
      points: null,
      games: 0,
      coverage: 0,
      raw: 1,
      applied: 1,
      weight: appliedWeight,
    };
  }
  const coverage = clamp(results.length / 5, 0, 1);
  const raw = clamp(
    ENGINE.formBase + ENGINE.formPerPoint * points,
    ENGINE.formMin,
    ENGINE.formMax,
  );
  const applied = clamp(
    1 + appliedWeight * (raw - 1) * coverage,
    0.9,
    1.12,
  );
  return {
    points,
    games: results.length,
    coverage,
    raw,
    applied,
    weight: appliedWeight,
  };
}

// Blend de tiros: solo se aplica si los tiros son datos reales, no estimados.
// En live, los resúmenes de ESPN sí publican tiros por equipo. Si la muestra
// es insuficiente, el updater deja `estimated.shots = true` y el blend se omite
// para no retroalimentar una estimación con otra estimación.
// El peso es dinámico: 0.20 con 2 partidos (prior conservador) y escala
// hasta 0.35 con mayor muestra para potenciar la señal de tiros y defensa rival.
export function shotsBlend(home = {}, away = {}) {
  const estimated = home.estimated?.shots === true || away.estimated?.shots === true;
  const values = [home.shotsFor, home.shotsAgainst, away.shotsFor, away.shotsAgainst]
    .map((value) => Number(value));
  const samples = {
    home: Number(home.shotsSample?.matches) || 0,
    away: Number(away.shotsSample?.matches) || 0,
  };
  const minSample = Math.min(samples.home, samples.away);
  const weight = clamp(
    ENGINE.shotsBlendWeight + Math.max(0, minSample - 2) * 0.05,
    0.15,
    0.35,
  );
  const usable = !estimated && values.every((value) => Number.isFinite(value) && value > 0);

  if (!usable) {
    return {
      applied: false,
      weight,
      samples,
      reason: estimated
        ? "Sin muestra real suficiente de tiros por equipo; el blend se omite para no retroalimentar una estimación."
        : "Faltan tiros por equipo; el blend se omite.",
      home: { attack: Number(home.attack) || 1, defense: Number(home.defense) || 1 },
      away: { attack: Number(away.attack) || 1, defense: Number(away.defense) || 1 },
      multipliers: { home: 1, away: 1 },
    };
  }

  const base = values.reduce((sum, value) => sum + value, 0) / 4;
  const homeAttackShots = ((values[0] + values[3]) / 2) / base;
  const awayAttackShots = ((values[2] + values[1]) / 2) / base;
  const homeDefenseShots = ((values[1] + values[2]) / 2) / base;
  const awayDefenseShots = ((values[3] + values[0]) / 2) / base;
  const blend = (goalValue, shotValue) => clamp(
    (1 - weight) * (Number(goalValue) || 1) + weight * shotValue,
    0.4,
    2.2,
  );

  const homeAttack = blend(home.attack, homeAttackShots);
  const homeDefense = blend(home.defense, homeDefenseShots);
  const awayAttack = blend(away.attack, awayAttackShots);
  const awayDefense = blend(away.defense, awayDefenseShots);
  const goalQualityHome = (Number(home.attack) || 1) * (Number(away.defense) || 1);
  const goalQualityAway = (Number(away.attack) || 1) * (Number(home.defense) || 1);
  const blendedQualityHome = homeAttack * awayDefense;
  const blendedQualityAway = awayAttack * homeDefense;

  return {
    applied: true,
    weight,
    samples,
    reason: samples.home && samples.away
      ? `Tiros reales de ${samples.home} y ${samples.away} partidos por equipo, contraídos al prior.`
      : "Tiros reales por equipo disponibles.",
    home: { attack: homeAttack, defense: homeDefense },
    away: { attack: awayAttack, defense: awayDefense },
    goalQuality: { home: goalQualityHome, away: goalQualityAway },
    blendedQuality: { home: blendedQualityHome, away: blendedQualityAway },
    multipliers: {
      home: blendedQualityHome / goalQualityHome,
      away: blendedQualityAway / goalQualityAway,
    },
  };
}

// Localía por liga: se toma la ventaja neta y se normaliza para que el
// producto local × visitante sea 1 y no infle el total de goles.
export function venueFactors(league = {}) {
  const rawHome = clamp(Number(league.homeFactor) || 1.1, 1, 1.2);
  const rawAway = clamp(Number(league.awayFactor) || 0.92, 0.8, 1);
  const edge = clamp(
    ((rawHome - 1) + (1 - rawAway)) / 2,
    ENGINE.venueEdgeMin,
    ENGINE.venueEdgeMax,
  );
  const home = 1 + edge;
  const away = 1 / home;
  return {
    raw: { home: rawHome, away: rawAway },
    home,
    away,
    edge,
    mode: "reciprocal",
  };
}
