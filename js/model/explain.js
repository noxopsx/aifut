import { formatImpact } from "./core.js";
import { projectionFromAnalysis } from "./projection.js";

const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const num = (value, digits = 2) => Number(value).toFixed(digits);
const signed = (value, digits = 2) => `${Number(value) >= 0 ? "+" : "−"}${Math.abs(Number(value)).toFixed(digits)}`;

function toneOf(delta) {
  if (delta > 0.02) return "pos";
  if (delta < -0.02) return "neg";
  return "neutral";
}

function driver(label, detail, delta, unit = "pp") {
  return {
    label,
    detail,
    delta,
    unit,
    impact: formatImpact(delta, unit),
    tone: toneOf(delta),
    magnitude: 0,
  };
}

function rawDriver(label, detail, impact, magnitude = 0.55, tone = "neutral") {
  return { label, detail, impact, tone, magnitude, delta: 0, unit: "" };
}

function normalize(drivers) {
  const max = Math.max(...drivers.map((d) => Math.abs(d.delta || 0)), 0.0001);
  return drivers.map((d) => ({
    ...d,
    magnitude: d.delta ? Math.min(1, Math.abs(d.delta) / max) : d.magnitude,
  }));
}

function explanation({
  eyebrow = "Cálculo",
  title,
  value,
  summary,
  drivers = [],
  steps = [],
  formula = "",
  caveat = "",
  meta = "",
}) {
  return {
    eyebrow,
    title,
    value,
    summary,
    drivers: normalize(drivers),
    steps,
    formula,
    caveat,
    meta: meta || "Modelo OX V1.0 · datos de respaldo",
  };
}

function outcomeDrivers(a, side) {
  const list = a.factors
    .map((f) => driver(f.label, f.detail, f.deltas[side], "pp"))
    .filter((d) => Math.abs(d.delta) > 0.03)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, 4);
  return list.length ? list : [rawDriver("Calidad base", "El modelo parte de la media de la liga.", "Base")];
}

function goalDrivers(a) {
  return a.factors
    .filter((f) => !["venue", "travel"].includes(f.key))
    .map((f) => driver(f.label, f.detail, f.goalDelta, "goles"))
    .filter((d) => Math.abs(d.delta) > 0.008)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, 4);
}

function outcomeExplanation(a, side) {
  const isHome = side === "home";
  const isDraw = side === "draw";
  const team = isHome ? a.home.short : isDraw ? "El empate" : a.away.short;
  const value = isDraw ? a.probs.draw : isHome ? a.probs.home : a.probs.away;
  const raw = isDraw ? a.rawProbs.draw : isHome ? a.rawProbs.home : a.rawProbs.away;
  const delta = (value - raw) * 100;
  const drivers = outcomeDrivers(a, side);
  const top = drivers[0];
  const label = isDraw ? "Empate" : `Gana ${team}`;
  return explanation({
    eyebrow: "Probabilidad 1X2",
    title: label,
    value: pct(value),
    summary: isDraw
      ? `El empate reúne ${pct(value)}. El 1X2 crudo daba ${pct(raw)}; la temperatura ${num(a.engine.temperature)} lo ajusta ${delta >= 0 ? "hacia arriba" : "hacia abajo"} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pp).`
      : `${team} suma ${pct(value)} de probabilidad de victoria. El 1X2 crudo daba ${pct(raw)}; la calibración V1.0 aplica temperatura ${num(a.engine.temperature)} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pp). El factor de mayor peso aislado es ${top.label.toLowerCase()} (${top.impact}).`,
    drivers,
    steps: [
      { label: `λ ${a.home.short}`, value: num(a.lambda.home), note: "Goles esperados" },
      { label: `λ ${a.away.short}`, value: num(a.lambda.away), note: "Goles esperados" },
      { label: "Matriz de marcadores", value: "0-0 a 10-10", note: "Poisson bivariado + Dixon-Coles" },
      { label: "1X2 crudo", value: pct(raw), note: isDraw ? "Diagonal de la matriz" : "Suma de marcadores favorables" },
      { label: "Temperatura", value: `T=${num(a.engine.temperature)}`, note: "Suaviza extremos sin cambiar el orden" },
      { label, value: pct(value), note: "Probabilidad calibrada final" },
    ],
    formula: isDraw
      ? "P(empate) = Σ P(i,i); p_final = normalize(p_cruda^(1/T))."
      : isHome
        ? "P(local gana) = Σ P(i,j) para i > j; p_final = normalize(p_cruda^(1/T))."
        : "P(visitante gana) = Σ P(i,j) para i < j; p_final = normalize(p_cruda^(1/T)).",
    caveat: "Es una probabilidad estimada, no un resultado garantizado. La temperatura suaviza el 1X2; la matriz de marcadores sigue siendo la cruda, por eso sus sumas pueden diferir. Los impactos son contrafactuales y no se suman de forma aritmética.",
  });
}

function scorelineExplanation(a, index = 0) {
  const top = a.topScores[index] || a.topScores[0];
  return explanation({
    eyebrow: index === 0 ? "Marcador más probable" : "Marcador probable",
    title: `${top.home}–${top.away}`,
    value: pct(top.p),
    summary: `El marcador ${top.home}-${top.away} aparece en ${pct(top.p)} de las simulaciones. La probabilidad de que termine exactamente así sigue siendo baja: es una referencia, no un pronóstico único.`,
    drivers: [
      rawDriver(`λ ${a.home.short}`, "Goles esperados del local.", num(a.lambda.home), 0.8),
      rawDriver(`λ ${a.away.short}`, "Goles esperados del visitante.", num(a.lambda.away), 0.7),
      rawDriver("Dixon-Coles", "Corrige la dependencia de marcadores bajos.", `ρ = ${a.league.rho}`, 0.45),
      rawDriver("Matriz", "Se calculan todas las combinaciones de goles.", "0-0 a 10-10", 0.4),
    ],
    steps: [
      { label: "Goles del local", value: num(a.lambda.home), note: "Media Poisson" },
      { label: "Goles del visitante", value: num(a.lambda.away), note: "Media Poisson" },
      { label: "Combinación", value: `${top.home}-${top.away}`, note: "Producto de probabilidades" },
      { label: "Probabilidad exacta", value: pct(top.p), note: "Incluye ajuste Dixon-Coles" },
    ],
    formula: "P(i,j) = Poisson(i; λH) × Poisson(j; λA) × τ(i,j).",
    caveat: "El marcador sale de la matriz cruda. El 1X2 final se calibra con temperatura por separado, así que la suma de marcadores no coincide exactamente con el 1X2 mostrado. Los marcadores exactos tienen probabilidades bajas por diseño: no son una certeza.",
  });
}

function bttsExplanation(a) {
  const raw = a.rawBtts;
  const final = a.btts;
  const base = a.engine.bases.btts;
  return explanation({
    eyebrow: "Salida de goles",
    title: "Ambos equipos anotan",
    value: pct(final),
    summary: `Hay ${pct(final)} de que anoten los dos. La matriz cruda daba ${pct(raw)}; la calibración Platt anclada a la base de la liga (${pct(base)}) lo lleva a ${pct(final)}. La probabilidad de que al menos uno se quede en cero es ${pct(1 - final)}.`,
    drivers: [
      rawDriver(`Anota ${a.home.short}`, "Probabilidad de al menos un gol.", pct(a.teamScore.home), 0.7),
      rawDriver(`Anota ${a.away.short}`, "Probabilidad de al menos un gol.", pct(a.teamScore.away), 0.65),
      rawDriver("Goles esperados", "Total del partido.", num(a.metrics.goals.total), 0.55),
      rawDriver("Base de liga", "BTTS de un partido con dos equipos promedio.", pct(base), 0.45),
    ],
    steps: [
      { label: `P(${a.home.short} anota)`, value: pct(a.teamScore.home), note: "1 - e^(-λ)" },
      { label: `P(${a.away.short} anota)`, value: pct(a.teamScore.away), note: "1 - e^(-λ)" },
      { label: "BTTS crudo", value: pct(raw), note: "Suma de la matriz" },
      { label: "Base de liga", value: pct(base), note: "Ancla de la curva Platt" },
      { label: "BTTS final", value: pct(final), note: "Calibración V1.0" },
    ],
    formula: "P(BTTS) = 1 - e^(-λH) - e^(-λA) + e^(-(λH+λA)); logit(p_final) = logit(p_base) + b × [logit(p_cruda) - logit(p_base)].",
    caveat: "El modelo asume independencia corregida por Dixon-Coles; no modela expulsiones ni lesiones durante el partido. La calibración V1.0 es un prior conservador, no una validación histórica propia.",
  });
}

function firstGoalExplanation(a) {
  return explanation({
    eyebrow: "Primer gol",
    title: "Quién abre el marcador",
    value: `${pct(a.firstGoal.home, 0)} / ${pct(a.firstGoal.away, 0)}`,
    summary: `${a.home.short} tiene ${pct(a.firstGoal.home, 0)} de anotar primero; ${a.away.short}, ${pct(a.firstGoal.away, 0)}. Hay ${pct(a.firstGoal.none, 0)} de que nadie anote.`,
    drivers: [
      rawDriver(`λ ${a.home.short}`, "Ritmo ofensivo del local.", num(a.lambda.home), 0.75),
      rawDriver(`λ ${a.away.short}`, "Ritmo ofensivo del visitante.", num(a.lambda.away), 0.7),
      rawDriver("Sin goles", "Probabilidad de 0-0.", pct(a.firstGoal.none, 0), 0.4),
    ],
    steps: [
      { label: "P(sin goles)", value: pct(a.firstGoal.none, 0), note: "e^(-(λH+λA))" },
      { label: "P(al menos uno)", value: pct(1 - a.firstGoal.none, 0), note: "1 - P(sin goles)" },
      { label: "Reparto por ritmo", value: `${pct(a.firstGoal.home, 0)} / ${pct(a.firstGoal.away, 0)}`, note: "λH : λA" },
    ],
    formula: "P(local primero) = (1 - e^(-(λH+λA))) × λH / (λH + λA).",
    caveat: "Se calcula con los λ crudos, no con la calibración final. No modela el orden exacto de los goles ni el efecto de una expulsión temprana.",
  });
}

function teamScoreExplanation(a, side) {
  const team = side === "home" ? a.home : a.away;
  const lambda = side === "home" ? a.lambda.home : a.lambda.away;
  const value = side === "home" ? a.teamScore.home : a.teamScore.away;
  return explanation({
    eyebrow: "Probabilidad de anotar",
    title: `${team.short} anota`,
    value: pct(value),
    summary: `${team.short} tiene ${pct(value)} de marcar al menos un gol. Su λ es ${num(lambda)} y su probabilidad de quedarse en cero es ${pct(1 - value)}.`,
    drivers: goalDrivers(a),
    steps: [
      { label: `λ ${team.short}`, value: num(lambda), note: "Goles esperados" },
      { label: "P(anota)", value: pct(value), note: "1 - e^(-λ)" },
      { label: "P(no anota)", value: pct(1 - value), note: "e^(-λ)" },
    ],
    formula: "P(anota) = 1 - e^(-λ).",
    caveat: "Se calcula con el λ crudo, no con la calibración final. Incluye penales y goles de jugadores no listados; no incluye autogoles.",
  });
}

function goalsMetricExplanation(a) {
  const raw = a.rawOver25;
  const final = a.over25;
  const base = a.engine.bases.over25;
  return explanation({
    eyebrow: "Estadística estimada",
    title: "Goles esperados",
    value: `${num(a.lambda.home)} – ${num(a.lambda.away)}`,
    summary: `Se esperan ${num(a.metrics.goals.total)} goles en total. Over 2.5 crudo: ${pct(raw)}; calibrado: ${pct(final)}. Ambos anotan: ${pct(a.btts)}.`,
    drivers: goalDrivers(a),
    steps: [
      { label: `λ ${a.home.short}`, value: num(a.lambda.home), note: "Ataque × defensa rival × contexto" },
      { label: `λ ${a.away.short}`, value: num(a.lambda.away), note: "Ataque × defensa rival × contexto" },
      { label: "Total", value: num(a.metrics.goals.total), note: "λH + λA" },
      { label: "Over 2.5 crudo", value: pct(raw), note: "Suma de la matriz" },
      { label: "Base de liga", value: pct(base), note: "Poisson con media 2μ" },
      { label: "Over 2.5 final", value: pct(final), note: "Calibración Platt" },
    ],
    formula: "λ = μ × ataque × defensa rival × localía × forma × tipo × alineación × descanso. Over 2.5 final = Platt(p_cruda, base_liga).",
    caveat: "El total es la suma de dos Poisson; no es una promesa de marcador ni de número exacto de goles. La calibración suaviza las probabilidades, no cambia los λ ni la matriz de marcadores.",
  });
}

function shotsMetricExplanation(a) {
  const s = a.metrics.shots;
  const live = Boolean(a.league.live);
  const observed = s.shotsSource === "observed";
  const sampleText = observed
    ? ` Muestra: ${s.shotsSample?.home?.matches ?? 0} y ${s.shotsSample?.away?.matches ?? 0} partidos por equipo.`
    : "";
  return explanation({
    eyebrow: "Estadística estimada",
    title: "Tiros",
    value: `${num(s.home, 1)} – ${num(s.away, 1)}`,
    summary: `${live ? "Se proyectan" : "Se prevén"} ${num(s.total, 1)} tiros totales. La calidad importa: ${num(s.onTargetHome, 1)} y ${num(s.onTargetAway, 1)} tiros a puerta.${sampleText}`,
    drivers: [
      rawDriver(
        observed ? "Volumen observado" : "Volumen estimado",
        observed
          ? "Tiros a favor y concedidos en los últimos partidos de ESPN, contraídos al prior."
          : "Tiros estimados desde las fuerzas y el ritmo de cada equipo.",
        `${num((a.home.shotsFor + a.away.shotsAgainst) / 2, 1)} – ${num((a.away.shotsFor + a.home.shotsAgainst) / 2, 1)}`,
        0.8,
      ),
      rawDriver("Ritmo de goles", "Más goles esperados suelen traer más volumen.", `×${num(1 + (a.metrics.goals.total - 2.7) * 0.04, 2)}`, 0.5),
      rawDriver("Tipo de partido", "La final y los amistosos suelen bajar el ritmo.", `×${num(s.components[2].home, 2)}`, 0.45),
      rawDriver("Localía", "El local suele generar algo más.", `×${num(s.components[3].home, 2)}`, 0.4),
    ],
    steps: s.components.map((c) => ({ label: c.label, value: `${num(c.home, 1)} – ${num(c.away, 1)}`, note: "Factor aplicado" })).concat([
      { label: "Tiros proyectados", value: `${num(s.home, 1)} – ${num(s.away, 1)}`, note: "Resultado" },
    ]),
    formula: "Tiros = promedio de tiros a favor/concedidos × ritmo × tipo × localía. Con muestra real, el promedio se contrae hacia la estimación previa.",
    caveat: live
      ? (observed
        ? "La proyección usa tiros reales de los resúmenes de ESPN, pero sigue siendo una estimación del partido futuro. No sustituye un modelo de eventos con coordenadas de tiro."
        : "Sin muestra real suficiente, los tiros se estiman desde las fuerzas de ataque/defensa y promedios. No sustituyen un modelo de eventos con coordenadas de tiro.")
      : "La estimación de tiros es aproximada; no sustituye un modelo de eventos con coordenadas de tiro.",
  });
}

function onTargetMetricExplanation(a) {
  const s = a.metrics.shots;
  const live = Boolean(a.league.live);
  const sourceOf = (team) => {
    if (team?.onTargetRateSource) return team.onTargetRateSource;
    return Math.abs(Number(team?.onTargetRate) - 0.34) < 1e-9 ? "placeholder" : "derived";
  };
  const rateHome = Number(s.onTargetRateHome ?? a.home.onTargetRate ?? 0.34);
  const rateAway = Number(s.onTargetRateAway ?? a.away.onTargetRate ?? 0.34);
  const placeholderTeams = [
    sourceOf(a.home) === "placeholder" ? a.home.short : null,
    sourceOf(a.away) === "placeholder" ? a.away.short : null,
  ].filter(Boolean);
  const sample = s.onTargetSample || {};
  const sampleParts = [];
  if (sample.home?.shots) sampleParts.push(`${a.home.short}: ${sample.home.onTarget}/${sample.home.shots} tiros`);
  if (sample.away?.shots) sampleParts.push(`${a.away.short}: ${sample.away.onTarget}/${sample.away.shots} tiros`);
  const sourceText = placeholderTeams.length
    ? `placeholder neutro para ${placeholderTeams.join(" y ")}`
    : live
      ? "derivada de tiros a puerta observados en ESPN"
      : "derivada de tiros históricos";
  const sampleText = sampleParts.length ? ` Muestra: ${sampleParts.join("; ")}.` : "";
  return explanation({
    eyebrow: "Estadística estimada",
    title: "Tiros a puerta",
    value: `${num(s.onTargetHome, 1)} – ${num(s.onTargetAway, 1)}`,
    summary: `De ${num(s.total, 1)} tiros, ${live ? "se estiman" : "se esperan"} ${num(s.onTargetHome + s.onTargetAway, 1)} a puerta. La tasa aplicada es ${pct(rateHome, 1)} para ${a.home.short} y ${pct(rateAway, 1)} para ${a.away.short}; ${sourceText}.${sampleText}`,
    drivers: [
      rawDriver("Volumen de tiros", "Más volumen genera más tiros a puerta.", `${num(s.home, 1)} – ${num(s.away, 1)}`, 0.8),
      rawDriver(`Precisión ${a.home.short}`, "Tasa de tiros que van entre los tres palos.", pct(rateHome, 1), 0.6),
      rawDriver(`Precisión ${a.away.short}`, "Tasa de tiros que van entre los tres palos.", pct(rateAway, 1), 0.6),
    ],
    steps: [
      { label: "Tiros", value: `${num(s.home, 1)} – ${num(s.away, 1)}` },
      { label: `Precisión ${a.home.short}`, value: pct(rateHome, 1), note: sourceOf(a.home) === "placeholder" ? "Placeholder" : "Derivada de muestra" },
      { label: `Precisión ${a.away.short}`, value: pct(rateAway, 1), note: sourceOf(a.away) === "placeholder" ? "Placeholder" : "Derivada de muestra" },
      { label: "A puerta", value: `${num(s.onTargetHome, 1)} – ${num(s.onTargetAway, 1)}` },
    ],
    formula: "Tiros a puerta = tiros × tasa de precisión por equipo. La tasa se contrae hacia 0.34 con un prior de 30 tiros.",
    caveat: placeholderTeams.length
      ? `La tasa de ${placeholderTeams.join(" y ")} es un placeholder neutro porque no hay muestra suficiente. No debe leerse como una tasa observada. Un tiro a puerta no es sinónimo de gol.`
      : live
        ? "La tasa se deriva de los tiros a puerta observados en los resúmenes de ESPN y se contrae hacia un prior conservador. Un tiro a puerta no es sinónimo de gol: la calidad de la ocasión sigue siendo clave."
        : "Un tiro a puerta no es sinónimo de gol: la calidad de la ocasión sigue siendo clave.",
  });
}

function cornersMetricExplanation(a) {
  const c = a.metrics.corners;
  const live = Boolean(a.league.live);
  return explanation({
    eyebrow: "Estadística estimada",
    title: "Córners",
    value: `${num(c.home, 1)} – ${num(c.away, 1)}`,
    summary: `Se esperan ${num(c.total, 1)} córners. La probabilidad de superar 9.5 es ${pct(c.over95)}; la de superar 10.5, ${pct(c.over105)}.`,
    drivers: [
      rawDriver(live ? "Promedio de liga" : "Base a favor/en contra", live ? "Córners estimados desde el promedio de la liga y las fuerzas." : "Córners generados y concedidos por cada equipo.", `${num((a.home.cornersFor + a.away.cornersAgainst) / 2, 1)} – ${num((a.away.cornersFor + a.home.cornersAgainst) / 2, 1)}`, 0.8),
      rawDriver("Ritmo de goles", "Un partido más abierto suele generar más córners.", `×${num(1 + (a.metrics.goals.total - 2.7) * 0.04, 2)}`, 0.5),
      rawDriver("Tipo de partido", "Finales y amistosos suelen bajar el flujo.", `×${num(c.components[2].home, 2)}`, 0.45),
      rawDriver("Estado del global", "El que persigue el resultado ataca más.", `×${num(c.components[3].home, 2)}`, 0.4),
    ],
    steps: [
      { label: "Base local", value: num((a.home.cornersFor + a.away.cornersAgainst) / 2, 1), note: live ? "Promedio estimado" : "A favor + concedidos" },
      { label: "Base visitante", value: num((a.away.cornersFor + a.home.cornersAgainst) / 2, 1), note: live ? "Promedio estimado" : "A favor + concedidos" },
      { label: "Total estimado", value: num(c.total, 1), note: "Ajustes aplicados" },
      { label: "Over 9.5", value: pct(c.over95), note: "Binomial negativa" },
    ],
    formula: "Córners ~ Binomial negativa(media ajustada, dispersión). La media se corrige por ritmo, tipo de partido y estado del global.",
    caveat: live
      ? "En modo live no hay córners reales por equipo: se usan promedios de la liga y las fuerzas. La binomial negativa permite sobredispersión, pero no captura cambios tácticos de último minuto."
      : "La binomial negativa permite sobredispersión, pero no captura cambios tácticos de último minuto.",
  });
}

function cardsMetricExplanation(a) {
  const c = a.metrics.cards;
  const live = Boolean(a.league.live);
  return explanation({
    eyebrow: "Estadística estimada",
    title: "Tarjetas",
    value: `${num(c.home, 1)} – ${num(c.away, 1)}`,
    summary: `Se esperan ${num(c.total, 1)} tarjetas. Over 4.5: ${pct(c.over45)}; over 5.5: ${pct(c.over55)}. El cálculo usa disciplina, rivalidad y tipo de partido; no usa árbitro.`,
    drivers: [
      rawDriver("Disciplina base", "Tarjetas promedio de cada equipo.", `${num(a.home.cards, 1)} – ${num(a.away.cards, 1)}`, 0.8),
      rawDriver("Rivalidad", "Los clásicos elevan la tensión y las faltas.", a.match.rivalry ? "Sí" : "No", 0.45),
      rawDriver("Tipo de partido", "La final y la liguilla suelen tener más tarjetas.", `×${num(c.components[2].home, 2)}`, 0.4),
    ],
    steps: [
      { label: "Base local", value: num(c.components[0].home, 1), note: "Disciplina del equipo" },
      { label: "Rivalidad", value: `×${num(c.components[1].home, 2)}`, note: a.match.rivalry ? "Clásico" : "Partido estándar" },
      { label: "Total estimado", value: num(c.total, 1), note: "Incluye rivalidad y tipo" },
      { label: "Over 4.5", value: pct(c.over45), note: "Binomial negativa" },
    ],
    formula: "Tarjetas ~ Binomial negativa(media ajustada, dispersión). Media = disciplina × rivalidad × tipo.",
    caveat: live
      ? "En modo live no hay disciplina real por equipo: se usan promedios de la liga. El árbitro no entra en la estimación. La estimación es más estable que el número exacto."
      : "Las tarjetas dependen del desarrollo del partido; la estimación es más estable que el número exacto. El árbitro no entra en la estimación.",
  });
}

function possessionMetricExplanation(a) {
  const p = a.metrics.possession;
  const live = Boolean(a.league.live);
  return explanation({
    eyebrow: "Estadística estimada",
    title: "Posesión",
    value: `${num(p.home, 0)}% – ${num(p.away, 0)}%`,
    summary: `${a.home.short} se queda con ${num(p.home, 0)}% de la posesión ${live ? "estimada" : ""}. No es una predicción de dominio: es una referencia de estilo y localía.`,
    drivers: [
      rawDriver(live ? "Estilo estimado" : "Estilo base", live ? "Diferencia de posesión estimada desde las fuerzas de ataque y defensa." : "Diferencia de posesión histórica entre los dos equipos.", `${a.home.possession}% – ${a.away.possession}%`, 0.8),
      rawDriver("Localía", "Jugar en casa suma algunos puntos de posesión.", a.match.neutral ? "Neutral" : "+2.5 pp", 0.45),
    ],
    steps: [
      { label: "Base local", value: `${a.home.possession}%`, note: live ? "Posesión estimada" : "Posesión histórica" },
      { label: "Base visitante", value: `${a.away.possession}%`, note: live ? "Posesión estimada" : "Posesión histórica" },
      { label: "Ajuste", value: a.match.neutral ? "0.0 pp" : "+2.5 pp", note: "Localía" },
      { label: "Posesión estimada", value: `${num(p.home, 0)}% – ${num(p.away, 0)}%` },
    ],
    formula: "Posesión local = 50 + (posesión local - posesión visitante) × 0.7 + localía.",
    caveat: live
      ? "En modo live no hay posesión real por equipo: se estima desde las fuerzas. La posesión no mide peligro; un equipo puede tener 60% y generar menos ocasiones."
      : "La posesión no mide peligro. Un equipo puede tener 60% y generar menos xG que el rival.",
  });
}

function distributionExplanation(a) {
  const totals = a.totals.map((p, i) => ({ goals: i === 5 ? "5+" : String(i), p }));
  return explanation({
    eyebrow: "Distribución",
    title: "Total de goles",
    value: `${num(a.metrics.goals.total)} esperados`,
    summary: `La distribución completa permite ver que el marcador exacto es solo una parte de la historia. La categoría más probable es ${totals.slice().sort((x, y) => y.p - x.p)[0].goals} gol(es).`,
    drivers: [
      rawDriver("λ local", "Ritmo ofensivo del local.", num(a.lambda.home), 0.8),
      rawDriver("λ visitante", "Ritmo ofensivo del visitante.", num(a.lambda.away), 0.75),
      rawDriver("Dixon-Coles", "Ajusta la dependencia de marcadores bajos.", `ρ = ${a.league.rho}`, 0.4),
    ],
    steps: totals.map((t) => ({ label: `${t.goals} goles`, value: pct(t.p), note: "Probabilidad" })),
    formula: "P(total = k) = Σ P(i,j) con i + j = k.",
    caveat: "La distribución asume un partido completo de 90 minutos; no incluye prórroga ni penales.",
  });
}

function factorExplanation(a, factor) {
  const f = factor;
  return explanation({
    eyebrow: "Factor del modelo",
    title: f.label,
    value: f.impactLabel,
    summary: `${f.detail} Al neutralizar este factor y recalcular el modelo, el efecto aislado es ${f.impactLabel}.`,
    drivers: [
      rawDriver(`Multiplicador ${a.home.short}`, "Se aplica a los goles esperados del local.", `×${num(f.homeMult, 3)}`, 0.7),
      rawDriver(`Multiplicador ${a.away.short}`, "Se aplica a los goles esperados del visitante.", `×${num(f.awayMult, 3)}`, 0.65),
      driver(`Gana ${a.home.short}`, "Cambio contrafactual en la probabilidad de victoria local.", f.deltas.home, "pp"),
      driver("Goles totales", "Cambio contrafactual en el total esperado.", f.goalDelta, "goles"),
    ],
    steps: [
      { label: "Modelo completo", value: `${num(a.lambda.home)} – ${num(a.lambda.away)}`, note: "λ con todos los factores" },
      { label: "Sin este factor", value: `${num(f.withoutLambda.home)} – ${num(f.withoutLambda.away)}`, note: "Recálculo con el factor en neutro" },
      { label: "Impacto aislado", value: f.impactLabel, note: "Diferencia contra el modelo neutro" },
    ],
    formula: "Impacto = modelo completo - modelo con este factor en neutro.",
    caveat: "Los impactos no son aditivos: los factores interactúan. Úsalos para entender la dirección, no para sumar puntos porcentuales.",
  });
}

function confidenceExplanation(a) {
  const live = Boolean(a.league.live);
  return explanation({
    eyebrow: "Calidad del análisis",
    title: "Confianza del contexto",
    value: `${a.confidence.score}/100`,
    summary: `${a.confidence.label}. ${a.confidence.note}`,
    drivers: a.confidence.reasons.map((r) => rawDriver(r.label, r.detail, r.impact, 0.55)),
    steps: [
      {
        label: "Datos",
        value: live ? "Live" : a.league.demo ? "Respaldo" : "Propios",
        note: live ? "Tabla, forma y sede de ESPN" : a.league.demo ? "No hay validación histórica real" : "Cargados desde mis_datos.py",
      },
      {
        label: "Alineación",
        value: live ? "Sin confirmar" : (a.match.lineups?.home?.absences?.length || 0) + (a.match.lineups?.away?.absences?.length || 0) ? "Con bajas" : "Completa",
        note: live ? "No se ajusta por bajas" : "Información previa",
      },
      { label: "Contexto", value: a.typeLabel, note: "Clima y árbitro excluidos del cálculo" },
      { label: "Calibración", value: "OX V1.0", note: `T=${num(a.engine.temperature)} · Platt b=${num(a.engine.binarySlope)}` },
      { label: "Confianza", value: `${a.confidence.score}/100`, note: a.confidence.label },
    ],
    formula: "Confianza = completitud del dato + estabilidad de la alineación + claridad del contexto + calibración declarada.",
    caveat: "No es la probabilidad de acertar. Un modelo puede ser confiable en el proceso y fallar en un partido concreto. La calibración V1.0 es un prior conservador de OX y no reemplaza un backtesting propio.",
  });
}

function certaintyExplanation(a) {
  const c = a.certainty;
  const favorite = c.favorite === "draw" ? "El empate" : c.favorite === "home" ? a.home.short : a.away.short;
  const range = c.goals.low === c.goals.high ? `${c.goals.low}` : `${c.goals.low}–${c.goals.high}`;
  return explanation({
    eyebrow: "Lectura del pronóstico",
    title: "Certeza del pronóstico",
    value: c.label,
    summary: `${favorite} es la salida más probable con ${pct(c.favoriteProb)}; saca ${num(c.gapPp, 1)} pp al segundo resultado. El 80% central de la distribución de goles está entre ${range} goles.`,
    drivers: [
      rawDriver("Separación", "Diferencia entre la salida más probable y la segunda.", `+${num(c.gapPp, 1)} pp`, 0.8),
      rawDriver("Favorito", "Salida con la probabilidad más alta del 1X2 calibrado.", pct(c.favoriteProb), 0.7),
      rawDriver("Rango de goles", "Intervalo central del 80% de la matriz de marcadores.", range, 0.6),
      rawDriver("Entropía", "Dispersión de la distribución 1X2 en bits.", `${num(c.entropy, 2)} bits`, 0.5),
    ],
    steps: [
      { label: "1X2 calibrado", value: `${pct(a.probs.home)} / ${pct(a.probs.draw)} / ${pct(a.probs.away)}`, note: "Local / empate / visitante" },
      { label: "Separación", value: `+${num(c.gapPp, 1)} pp`, note: "Primera salida menos segunda" },
      { label: "Goles", value: range, note: "Cuantiles 10% y 90% de la matriz" },
      { label: "Certeza", value: c.label, note: "Etiqueta de lectura, no probabilidad de acierto" },
    ],
    formula: "Certeza = separación entre la salida más probable y la segunda; rango de goles = cuantiles 10% y 90% de la distribución de marcadores.",
    caveat: "No es la probabilidad de acertar. Un favorito claro puede perder y un partido abierto puede tener un ganador claro. Mide cuán concentrada está la masa de probabilidad, no la calidad de los datos; esa se declara en el panel de confianza del contexto.",
  });
}

function playerExplanation(a, side, player) {
  const team = side === "home" ? a.home : a.away;
  return explanation({
    eyebrow: `Goleador · ${team.short}`,
    title: player.name,
    value: pct(player.p),
    summary: `${player.name} tiene ${pct(player.p)} de anotar al menos un gol. Su reparto es ${pct(player.share, 0)} de los goles esperados de ${team.short}; juega un ${pct(player.minutes, 0)} de los minutos estimados.`,
    drivers: [
      rawDriver("xG/90", "Goles esperados por 90 minutos.", num(player.xg90), 0.8),
      rawDriver("Minutos estimados", "Participación prevista.", pct(player.minutes, 0), 0.6),
      rawDriver("Reparto del equipo", "Parte del λ del equipo que se le asigna.", pct(player.share, 0), 0.55),
      rawDriver("λ del jugador", "Goles esperados individuales.", num(player.lambda), 0.7),
    ],
    steps: [
      { label: `λ ${team.short}`, value: num(side === "home" ? a.lambda.home : a.lambda.away), note: "Goles esperados del equipo" },
      { label: "Reparto", value: pct(player.share, 0), note: "xG/90 × minutos, normalizado" },
      { label: "λ jugador", value: num(player.lambda), note: "λ equipo × reparto" },
      { label: "P(anota)", value: pct(player.p), note: "1 - e^(-λ jugador)" },
    ],
    formula: "λ_jugador = λ_equipo × reparto; P(anota) = 1 - e^(-λ_jugador).",
    caveat: "No incluye autogoles. Asume que el jugador cumple los minutos estimados y que la alineación prevista se confirma.",
  });
}

function methodologyExplanation(a) {
  return explanation({
    eyebrow: "Modelo",
    title: "Cómo se calcula OX",
    value: "Poisson + OX V1.0",
    summary: "El motor estima goles esperados para cada equipo, construye una matriz de marcadores y deriva de ahí las probabilidades de victoria, empate, goles, córners, tarjetas y goleadores. OX V1.0 añade forma reciente, blend de tiros, localía normalizada por liga, temperatura 1X2 y calibración Platt para goles/BTTS.",
    drivers: [
      rawDriver("Fuerza de ataque", "Índice ofensivo ajustado por rival.", num(a.home.attack), 0.8),
      rawDriver("Solidez defensiva", "Índice de goles concedidos.", num(a.away.defense), 0.75),
      rawDriver("Forma y tiros", "Puntos recientes y volumen de tiros cuando hay datos reales.", "V1.0", 0.65),
      rawDriver("Calibración", "Temperatura 1X2 y Platt anclado a la base de la liga.", `T=${num(a.engine.temperature)}`, 0.6),
    ],
    steps: [
      { label: "1. Fuerza", value: "Ataque × defensa rival", note: "Base de goles esperados" },
      { label: "2. Contexto", value: "Forma, localía, tipo, descanso", note: "Multiplicadores de λ; sin clima ni árbitro" },
      { label: "3. Matriz", value: "0-0 a 10-10", note: "Poisson + Dixon-Coles" },
      { label: "4. Salidas", value: "1X2 · goles · BTTS · córners · tarjetas", note: "Derivadas de la matriz" },
      { label: "5. Calibración", value: `T=${num(a.engine.temperature)} · Platt b=${num(a.engine.binarySlope)}`, note: "Probabilidades finales" },
      { label: "6. Jugadores", value: "Reparto de λ", note: "xG/90 y minutos" },
    ],
    formula: "λ = μ × ataque × defensa rival × forma × localía × tipo × alineación × descanso. 1X2 final = normalize(p_cruda^(1/T)); goles/BTTS = Platt(p_cruda, base_liga).",
    caveat: a.league.live
      ? "Modo live: calendario, tablas, forma, sede y tiros por equipo de ESPN; probabilidades y salidas de OX V1.0. El blend de tiros se aplica solo cuando hay muestra real suficiente; si no, se omite y la interfaz lo indica. Faltan alineaciones confirmadas; el clima y el árbitro no entran en el cálculo. La calibración V1.0 es un prior conservador, no una validación histórica. Uso personal y educativo."
      : a.league.demo
        ? "Datos de respaldo simulados. Para producción hay que conectar datos reales, calibrar con backtesting y validar temporalmente. La calibración V1.0 es un prior conservador. Uso personal y educativo."
        : "Datos propios cargados desde mis_datos.py. OX V1.0 todavía debe calibrarse con backtesting y validarse temporalmente antes de usarse en producción. La calibración V1.0 es un prior conservador. Uso personal y educativo.",
  });
}

function tableExplanation(a) {
  const home = a.home.standing;
  const away = a.away.standing;
  const live = Boolean(a.league.live);
  return explanation({
    eyebrow: "Contexto de liga",
    title: "Tabla y fuerzas",
    value: a.league.name,
    summary: live
      ? `Las fuerzas de ataque y defensa se calculan desde los goles a favor y en contra de la tabla de ${a.league.name}. Se suavizan con shrinkage para que un inicio de temporada no distorsione el cálculo.`
      : "La tabla de posiciones es una referencia de contexto; en datos propios, las fuerzas se cargan directamente en cada equipo.",
    drivers: [
      rawDriver(`Ataque ${a.home.short}`, "Goles a favor por partido frente a la media de la liga.", num(a.home.attack, 3), 0.8),
      rawDriver(`Defensa ${a.away.short}`, "Goles en contra por partido frente a la media de la liga.", num(a.away.defense, 3), 0.75),
      rawDriver("Media de liga", "Goles por equipo y partido usados como base.", num(a.league.avgGoals, 3), 0.6),
      rawDriver("Posiciones", "Contexto de la tabla, no un ajuste directo al marcador.", home && away ? `${home.pos ?? "—"}.º vs ${away.pos ?? "—"}.º` : "Sin tabla", 0.45),
    ],
    steps: [
      { label: "Goles/partido de liga", value: num(a.league.avgGoals, 3), note: "Media por equipo" },
      { label: `Ataque ${a.home.short}`, value: num(a.home.attack, 3), note: "GF/PJ ajustado" },
      { label: `Defensa ${a.away.short}`, value: num(a.away.defense, 3), note: "GC/PJ ajustado" },
      { label: "Fuerza del cruce", value: `${num(a.home.attack * a.away.defense, 3)} / ${num(a.away.attack * a.home.defense, 3)}`, note: "Ataque × defensa rival" },
    ],
    formula: "ataque = (GF / PJ) / media_liga; defensa = (GC / PJ) / media_liga. Se aplica shrinkage según los partidos jugados.",
    caveat: live
      ? "La tabla es real, pero las fuerzas son una aproximación lineal. No incluyen xG, lesiones ni cambios de entrenador. Córners y tarjetas no salen de la tabla."
      : "La tabla no entra directamente en el motor si cargas fuerzas propias; se muestra como contexto.",
  });
}

function marketsExplanation(a) {
  const e = a.engine;
  const raw = e.rawProbs;
  const final = e.probs;
  const rawBinary = e.rawBinary;
  const binary = e.binary;
  const bases = e.bases;
  const diff = (value, ref) => `${(value - ref) >= 0 ? "+" : ""}${((value - ref) * 100).toFixed(1)} pp`;
  return explanation({
    eyebrow: "Modelo",
    title: "Probabilidad y referencia",
    value: "puntos porcentuales",
    summary: "Cada salida muestra la probabilidad final del modelo junto a una referencia interna: el 1X2 crudo antes de la temperatura o la base de la liga para goles y BTTS. La diferencia en puntos porcentuales indica cuánto mueve la calibración, no una ventaja frente a una referencia externa.",
    drivers: [
      rawDriver("1X2 final", "Probabilidad calibrada con temperatura.", `${pct(final.home)} / ${pct(final.draw)} / ${pct(final.away)}`, 0.8),
      rawDriver("1X2 crudo", "Salida directa de la matriz antes de suavizar.", `${pct(raw.home)} / ${pct(raw.draw)} / ${pct(raw.away)}`, 0.7),
      rawDriver("Goles y BTTS", "Calibración Platt anclada a la base de la liga.", `Over 2.5 ${pct(binary.over25)}`, 0.65),
      rawDriver("Base de liga", "Referencia de goles con la media de la competición.", `Over 2.5 ${pct(bases.over25)}`, 0.5),
    ],
    steps: [
      { label: "1X2 crudo", value: `${pct(raw.home)} / ${pct(raw.draw)} / ${pct(raw.away)}`, note: "Matriz Poisson + Dixon-Coles" },
      { label: "1X2 final", value: `${pct(final.home)} / ${pct(final.draw)} / ${pct(final.away)}`, note: `Temperatura T=${num(e.temperature)}` },
      { label: "Over 2.5", value: `${pct(binary.over25)}`, note: `Base ${pct(bases.over25)} · ${diff(binary.over25, bases.over25)}` },
      { label: "BTTS", value: `${pct(binary.btts)}`, note: `Base ${pct(bases.btts)} · ${diff(binary.btts, bases.btts)}` },
      { label: "Over 1.5", value: `${pct(binary.over15)}`, note: `Base ${pct(bases.over15)} · ${diff(binary.over15, bases.over15)}` },
      { label: "Over 3.5", value: `${pct(binary.over35)}`, note: `Base ${pct(bases.over35)} · ${diff(binary.over35, bases.over35)}` },
    ],
    formula: "1X2: p_final = normalize(p_cruda^(1/T)). Goles/BTTS: logit(p_final) = logit(p_base) + b × [logit(p_cruda) − logit(p_base)]. Diferencia = (p_final − p_base) × 100.",
    caveat: "La referencia es interna (crudo del modelo o base de liga), no un precio externo. Una probabilidad alta no garantiza acertar; la validación walk-forward mide el error medio de estas probabilidades.",
  });
}

function engineExplanation(a) {
  const e = a.engine;
  const raw = e.rawProbs;
  const final = e.probs;
  const rawBinary = e.rawBinary;
  const binary = e.binary;
  const formHome = e.form.home;
  const formAway = e.form.away;
  const shots = e.shots;
  const venue = e.venue;
  const formText = (factor) => factor.points === null ? "sin forma" : `${factor.points} pts → ×${num(factor.applied, 3)}`;
  return explanation({
    eyebrow: "OX V1.0",
    title: "Transparencia del cálculo",
    value: `T=${num(e.temperature)} · Platt b=${num(e.binarySlope)}`,
    summary: `El motor calcula primero una matriz Poisson + Dixon-Coles. Después suaviza el 1X2 con temperatura ${num(e.temperature)} y calibra goles/BTTS con una curva Platt anclada a la base de la liga. La forma reciente y la localía de liga entran antes de la matriz; el blend de tiros solo se aplica si hay tiros reales por equipo.`,
    drivers: [
      rawDriver("Temperatura 1X2", "Suaviza las probabilidades extremas sin cambiar el orden.", `T=${num(e.temperature)}`, 0.8),
      rawDriver("Forma reciente", "Puntos de los últimos 5, con peso conservador del 60%.", `${a.home.short} ${formText(formHome)} · ${a.away.short} ${formText(formAway)}`, 0.7),
      rawDriver("Blend de tiros", shots.applied ? "Mezcla la fuerza de goles con el volumen de tiros." : "No aplicado en este partido.", shots.applied ? `${Math.round(shots.weight * 100)}%` : "Sin muestra suficiente", 0.55, shots.applied ? "pos" : "neutral"),
      rawDriver("Localía de liga", "Factor por liga, normalizado para no inflar el total de goles.", `×${num(venue.home, 3)} / ×${num(venue.away, 3)}`, 0.5),
      rawDriver("Calibración binaria", "Platt anclado a la base de la liga para goles y BTTS.", `b=${num(e.binarySlope)}`, 0.45),
    ],
    steps: [
      { label: "1X2 crudo", value: `${pct(raw.home)} / ${pct(raw.draw)} / ${pct(raw.away)}`, note: "Matriz Poisson + Dixon-Coles" },
      { label: "Temperatura", value: `T=${num(e.temperature)}`, note: "p_final = normalize(p_cruda^(1/T))" },
      { label: "1X2 final", value: `${pct(final.home)} / ${pct(final.draw)} / ${pct(final.away)}`, note: "Probabilidad calibrada" },
      { label: "Over 2.5 crudo", value: pct(rawBinary.over25), note: "Suma de la matriz" },
      { label: "Base de liga", value: pct(e.bases.over25), note: "Poisson con media 2μ" },
      { label: "Over 2.5 final", value: pct(binary.over25), note: "Platt anclado a la base" },
      { label: "BTTS crudo → final", value: `${pct(rawBinary.btts)} → ${pct(binary.btts)}`, note: "Misma calibración" },
      { label: "Forma aplicada", value: `${num(formHome.applied, 3)} / ${num(formAway.applied, 3)}`, note: "Multiplicador sobre λ" },
      { label: "Tiros", value: shots.applied ? `×${num(shots.multipliers.home, 3)} / ×${num(shots.multipliers.away, 3)}` : "No aplicado", note: shots.reason },
      { label: "Localía aplicada", value: `×${num(venue.appliedHome, 3)} / ×${num(venue.appliedAway, 3)}`, note: `Cruda ×${num(venue.raw.home, 3)} / ×${num(venue.raw.away, 3)}` },
    ],
    formula: "1X2: p_final = normalize(p_cruda^(1/T)). Goles/BTTS: logit(p_final) = logit(p_base) + b × [logit(p_cruda) - logit(p_base)]. Forma: 0.85 + 0.02 × puntos, aplicada al 60%.",
    caveat: "La calibración V1.0 es un prior conservador de OX: no está ajustada con un holdout histórico propio y no garantiza mejores resultados en todas las salidas. El 1X2 final y la matriz cruda pueden no sumar exactamente igual porque la matriz se usa para marcadores y distribución.",
  });
}

function recentExplanation(a) {
  const rh = a.engine?.recent?.home;
  const ra = a.engine?.recent?.away;
  const sh = a.engine?.recent?.strength?.home;
  const sa = a.engine?.recent?.strength?.away;
  const sampleText = `${a.home.short}: ${rh?.sample ?? 0} · ${a.away.short}: ${ra?.sample ?? 0}`;
  return explanation({
    eyebrow: "Últimos 10",
    title: "Fuerzas con historial real",
    value: sampleText,
    summary: `El motor toma hasta 10 partidos reales por equipo y les da más peso a los recientes (vida media 45 días). La fuerza de goles resultante se mezcla con la tabla: ${Math.round((sh?.recentWeight ?? 0) * 100)}% para ${a.home.short} y ${Math.round((sa?.recentWeight ?? 0) * 100)}% para ${a.away.short}. Así un equipo que cambió de nivel no queda atado a su promedio de temporada.`,
    drivers: [
      rawDriver(`${a.home.short} · últimos 10`, "Goles a favor y en contra ponderados por antigüedad.", rh?.available ? `${num(rh.gfPerMatch)} GF / ${num(rh.gaPerMatch)} GC` : "Sin muestra", 0.8),
      rawDriver(`${a.away.short} · últimos 10`, "Misma ventana y mismo decaimiento.", ra?.available ? `${num(ra.gfPerMatch)} GF / ${num(ra.gaPerMatch)} GC` : "Sin muestra", 0.75),
      rawDriver("Mezcla con la tabla", "La tabla aporta estabilidad; el historial aporta actualidad.", `${Math.round((sh?.recentWeight ?? 0) * 100)}% / ${Math.round((sa?.recentWeight ?? 0) * 100)}%`, 0.6),
      rawDriver("Forma", "Puntos de los últimos 5; baja a 35% cuando ya hay historial de goles.", `${a.engine?.form?.home?.points ?? "—"} / ${a.engine?.form?.away?.points ?? "—"} pts`, 0.45),
    ],
    steps: [
      { label: "Ventana", value: `${rh?.window ?? 10} partidos`, note: "Máximo por equipo" },
      { label: "Peso temporal", value: "0.5^(días/45)", note: "Vida media de 45 días" },
      { label: `Ataque reciente ${a.home.short}`, value: num(rh?.attack ?? 1, 3), note: "GF ponderado / media de liga" },
      { label: `Defensa reciente ${a.home.short}`, value: num(rh?.defense ?? 1, 3), note: "GC ponderado / media de liga" },
      { label: `Ataque final ${a.home.short}`, value: num(a.home.attack, 3), note: "Tabla × reciente" },
      { label: `Defensa final ${a.home.short}`, value: num(a.home.defense, 3), note: "Tabla × reciente" },
    ],
    formula: "w_i = 0.5^(días_i / 45); ataque_reciente = Σ(w_i × GF_i) / Σw_i / μ_liga; fuerza = (1 - α) × tabla + α × reciente, con α = 0.60 × cobertura.",
    caveat: "La ventana de 10 partidos es corta: un rival fuerte o una racha de lesiones puede distorsionarla. La contracción hacia la media y la mezcla con la tabla reducen ese riesgo, pero no lo eliminan. Los partidos de la temporada anterior pesan menos por el decaimiento temporal.",
  });
}

function h2hExplanation(a) {
  const h2h = a.match?.h2h;
  const factor = a.engine?.h2h?.factor;
  const minMatches = h2h?.minMatches || 3;
  if (!h2h?.available) {
    return explanation({
      eyebrow: "Historial directo",
      title: "Sin muestra H2H",
      value: "0 partidos",
      summary: `No hay enfrentamientos directos en la muestra de ESPN para este cruce. El motor no aplica ningún ajuste H2H y lo deja en 1.00.`,
      drivers: [rawDriver("Muestra", `Se necesitan al menos ${minMatches} partidos directos.`, "0", 0.4)],
      steps: [{ label: "Ajuste H2H", value: "×1.00", note: "Sin muestra" }],
      formula: `Si played < ${minMatches}, multiplicador H2H = 1.`,
      caveat: "La ausencia de H2H no es un problema: el modelo prefiere no inventar una señal con muestras cortas.",
    });
  }
  if (h2h.played < minMatches) {
    return explanation({
      eyebrow: "Historial directo",
      title: "Muestra insuficiente",
      value: `${h2h.played} partido(s) · mínimo ${minMatches}`,
      summary: `Hay ${h2h.played} enfrentamiento(s) directo(s) en la muestra de ESPN, por debajo del mínimo de ${minMatches}. El motor no aplica ajuste H2H y lo deja en 1.00: se muestra como contexto, no como señal.`,
      drivers: [
        rawDriver("Muestra", "Partidos directos disponibles.", String(h2h.played), 0.4),
        rawDriver("Mínimo", "Muestra mínima para ajustar.", String(minMatches), 0.35),
        rawDriver("Ajuste aplicado", "El H2H no mueve las fuerzas.", "×1.00", 0.3),
      ],
      steps: [
        { label: "Partidos directos", value: String(h2h.played), note: "Ventana de hasta 6" },
        { label: "Mínimo requerido", value: String(minMatches), note: "Sin ajuste por debajo" },
        { label: "Ajuste H2H", value: "×1.00", note: "Muestra insuficiente" },
      ],
      formula: `Si played < ${minMatches}, multiplicador H2H = 1.`,
      caveat: "Una muestra de uno o dos partidos puede reflejar contextos muy distintos. El modelo prefiere no inventar una señal y deja el H2H como lectura descriptiva.",
    });
  }
  const pctWeight = Math.round((factor?.weight ?? 0) * 100);
  return explanation({
    eyebrow: "Historial directo",
    title: "Cómo se pesa el H2H",
    value: `${h2h.played} partidos · ${h2h.homeWins}-${h2h.draws}-${h2h.awayWins}`,
    summary: `En ${h2h.played} enfrentamientos directos, ${a.home.short} ganó ${h2h.homeWins}, hubo ${h2h.draws} empates y ${a.away.short} ganó ${h2h.awayWins}. El motor aplica un ajuste conservador del ${pctWeight}%: el H2H matiza las fuerzas, no las reemplaza.`,
    drivers: [
      rawDriver(`Victorias ${a.home.short}`, "Partidos directos ganados por el local actual.", String(h2h.homeWins), 0.75, h2h.homeWins > h2h.awayWins ? "pos" : "neutral"),
      rawDriver("Empates", "Partidos directos igualados.", String(h2h.draws), 0.45),
      rawDriver(`Victorias ${a.away.short}`, "Partidos directos ganados por el visitante actual.", String(h2h.awayWins), 0.7, h2h.awayWins > h2h.homeWins ? "pos" : "neutral"),
      rawDriver("Peso", "Máximo 12% para no sobreinterpretar una muestra corta.", `${pctWeight}%`, 0.55),
    ],
    steps: [
      { label: "Partidos directos", value: String(h2h.played), note: "Ventana de hasta 6" },
      { label: "Goles del local actual", value: String(h2h.goalsHome), note: "Orientados al cruce de hoy" },
      { label: "Goles del visitante actual", value: String(h2h.goalsAway), note: "Orientados al cruce de hoy" },
      { label: "Multiplicador local", value: `×${num(factor?.home ?? 1, 3)}`, note: "Sobre λ del local" },
      { label: "Multiplicador visitante", value: `×${num(factor?.away ?? 1, 3)}`, note: "Sobre λ del visitante" },
    ],
    formula: "peso = clamp(partidos / 12, 0.04, 0.12); mult = clamp(1 + peso × (goles_directos/partido / μ_liga - 1), 0.90, 1.10).",
    caveat: "El H2H es una muestra pequeña y puede reflejar contextos distintos: entrenadores, plantillas, competiciones o localías diferentes. Por eso pesa poco y se aplica después de las fuerzas de temporada y de los últimos 10.",
  });
}

function matrixOverviewExplanation(a) {
  const top = a.topScores?.[0];
  return explanation({
    eyebrow: "Matriz de marcadores",
    title: "Distribución 7×7",
    value: top ? `${top.home}–${top.away} · ${pct(top.p)}` : "—",
    summary: `La matriz cruza los goles esperados de ambos equipos (${num(a.lambda.home)} y ${num(a.lambda.away)}) con Poisson y la corrección Dixon-Coles. El marcador más probable es ${top ? `${top.home}-${top.away}` : "—"}; la vista 7×7 muestra del 0-0 al 6-6 y agrupa el resto de la cola.`,
    drivers: [
      rawDriver(`λ ${a.home.short}`, "Goles esperados del local.", num(a.lambda.home), 0.8),
      rawDriver(`λ ${a.away.short}`, "Goles esperados del visitante.", num(a.lambda.away), 0.75),
      rawDriver("Dixon-Coles", "Corrige la dependencia de marcadores bajos.", `ρ = ${a.league.rho}`, 0.5),
      rawDriver("Cola agrupada", "Todo lo que queda fuera de la vista 7×7.", pct(a.scoreMatrix?.rest ?? 0), 0.4),
    ],
    steps: [
      { label: "Matriz interna", value: "0-0 a 10-10", note: "121 celdas normalizadas" },
      { label: "Vista", value: "7×7", note: "0-0 a 6-6" },
      { label: "Cola", value: pct(a.scoreMatrix?.rest ?? 0), note: "Se agrupa fuera de la vista" },
      { label: "Marcador modal", value: top ? `${top.home}-${top.away}` : "—", note: top ? pct(top.p) : "—" },
    ],
    formula: "P(i,j) = Poisson(i; λH) × Poisson(j; λA) × τ(i,j) / Σ P(i,j).",
    caveat: "La matriz describe estructura, no certeza: incluso el marcador más probable suele quedarse por debajo del 20%. La cola agrupada evita que la vista 7×7 parezca sumar 100%.",
  });
}

function matrixExplanation(a, homeGoals, awayGoals) {
  const p = a.matrix?.[homeGoals]?.[awayGoals] ?? 0;
  return explanation({
    eyebrow: "Matriz de marcadores",
    title: `${homeGoals}–${awayGoals}`,
    value: pct(p),
    summary: `La celda ${homeGoals}-${awayGoals} concentra ${pct(p)} de la matriz Poisson + Dixon-Coles. La matriz completa se normaliza para que todas las celdas sumen 100%; el 1X2 final se calibra después con temperatura, así que puede no coincidir exactamente con la suma de la matriz.`,
    drivers: [
      rawDriver(`λ ${a.home.short}`, "Goles esperados del local.", num(a.lambda.home), 0.8),
      rawDriver(`λ ${a.away.short}`, "Goles esperados del visitante.", num(a.lambda.away), 0.75),
      rawDriver("Dixon-Coles", "Corrige la dependencia de marcadores bajos.", `ρ = ${a.league.rho}`, 0.5),
      rawDriver("Normalización", "Se divide por la suma de la matriz 0-0 a 10-10.", "100%", 0.4),
    ],
    steps: [
      { label: "Poisson local", value: pct(Math.exp(-a.lambda.home) * Math.pow(a.lambda.home, homeGoals) / factorial(homeGoals), 3), note: `${homeGoals} goles` },
      { label: "Poisson visitante", value: pct(Math.exp(-a.lambda.away) * Math.pow(a.lambda.away, awayGoals) / factorial(awayGoals), 3), note: `${awayGoals} goles` },
      { label: "Corrección τ", value: homeGoals <= 1 && awayGoals <= 1 ? "Aplicada" : "1.00", note: "Solo marcadores 0-0, 1-0, 0-1, 1-1" },
      { label: "Celda normalizada", value: pct(p), note: "Probabilidad exacta" },
    ],
    formula: "P(i,j) = Poisson(i; λH) × Poisson(j; λA) × τ(i,j) / Σ P(i,j).",
    caveat: "Un marcador exacto siempre tiene probabilidad baja. La matriz es una herramienta de estructura, no una promesa de resultado. La cola 7+ se agrupa fuera de la vista 7×7.",
  });
}

function factorial(n) {
  let value = 1;
  for (let i = 2; i <= n; i += 1) value *= i;
  return value;
}

function timingExplanation(a) {
  const t = a.timing;
  if (!t) {
    return explanation({
      eyebrow: "Goles por tiempo",
      title: "Reparto por tiempo",
      value: "Sin dato",
      summary: "No hay reparto por tiempo disponible.",
      drivers: [],
      steps: [],
      formula: "",
      caveat: "",
    });
  }
  return explanation({
    eyebrow: "Goles por tiempo",
    title: "Primer y segundo tiempo",
    value: `${pct(t.first.over05, 0)} / ${pct(t.second.over05, 0)}`,
    summary: `Se esperan ${num(t.first.lambda)} goles antes del descanso y ${num(t.second.lambda)} después. La probabilidad de al menos un gol es ${pct(t.first.over05, 0)} en el primer tiempo y ${pct(t.second.over05, 0)} en el segundo. Es una referencia conservadora, no un modelo de minutos.`,
    drivers: [
      rawDriver("Reparto", "44% de los goles esperados antes del descanso.", `${Math.round(t.firstHalfShare * 100)}% / ${Math.round((1 - t.firstHalfShare) * 100)}%`, 0.7),
      rawDriver("Total del partido", "Suma de los λ de ambos equipos.", num(t.total), 0.65),
      rawDriver("Primer tiempo", "P(0), P(1), P(2+).", `${pct(t.first.p0, 0)} / ${pct(t.first.p1, 0)} / ${pct(t.first.p2plus, 0)}`, 0.55),
      rawDriver("Segundo tiempo", "P(0), P(1), P(2+).", `${pct(t.second.p0, 0)} / ${pct(t.second.p1, 0)} / ${pct(t.second.p2plus, 0)}`, 0.5),
    ],
    steps: [
      { label: "λ total", value: num(t.total), note: "Local + visitante" },
      { label: "λ primer tiempo", value: num(t.first.lambda), note: "44% del total" },
      { label: "λ segundo tiempo", value: num(t.second.lambda), note: "56% del total" },
      { label: "P(0) primer tiempo", value: pct(t.first.p0), note: "e^(-λ1)" },
      { label: "P(2+) primer tiempo", value: pct(t.first.p2plus), note: "1 - P(0) - P(1)" },
      { label: "P(2+) segundo tiempo", value: pct(t.second.p2plus), note: "Misma fórmula" },
    ],
    formula: "λ1 = 0.44 × (λH + λA); λ2 = 0.56 × (λH + λA); P(k) = e^(-λ) λ^k / k!.",
    caveat: "El reparto 44/56 es una referencia histórica conservadora. No modela el minuto exacto, el tiempo añadido ni el efecto de un marcador temprano. Es una lectura del modelo, no una recomendación.",
  });
}

function scenariosExplanation(a) {
  const legs = a.comboLegs || [];
  return explanation({
    eyebrow: "Escenarios",
    title: "Probabilidad conjunta",
    value: `${legs.length} condiciones`,
    summary: "Un escenario combina 2–4 condiciones del modelo. No multiplica probabilidades de goles como si fueran independientes: recorre la matriz de marcadores y suma solo las celdas que cumplen todas las condiciones. Para córners y tarjetas sí se usa independencia del modelo, y la interfaz lo advierte.",
    drivers: [
      rawDriver("Matriz de marcadores", "Base exacta para 1X2, goles y BTTS.", "0-0 a 10-10", 0.8),
      rawDriver("Condiciones de goles", "Over/under, BTTS y doble oportunidad comparten la misma matriz.", "Conjunta exacta", 0.7),
      rawDriver("Córners y tarjetas", "Se combinan por independencia del modelo.", "Aproximada", 0.5),
      rawDriver("Probabilidad de fallo", "Complemento de la probabilidad conjunta.", "1 − P", 0.45),
    ],
    steps: [
      { label: "Selecciona 2–4 condiciones", value: "Salidas del modelo", note: "La interfaz recalcula al instante" },
      { label: "Conjunta de goles", value: "Σ celdas compatibles", note: "Exacta desde la matriz" },
      { label: "Conjunta de córners/tarjetas", value: "Producto de probabilidades", note: "Independencia del modelo" },
      { label: "Probabilidad de fallo", value: "1 − P(conjunta)", note: "Al menos una condición no se cumple" },
      { label: "Avisos", value: "Correlación y contradicciones", note: "Se marcan en la interfaz" },
    ],
    formula: "P(A ∩ B ∩ …) = Σ P(i,j) para las celdas que cumplen todas las condiciones; P(fallo) = 1 − P(conjunta).",
    caveat: "Las condiciones del mismo partido están correlacionadas: por eso la conjunta se calcula desde la matriz y no multiplicando probabilidades sueltas. Un escenario con muchas condiciones acumula error de estimación. Es una lectura del modelo, no una recomendación.",
  });
}

function projectionExplanation(a) {
  const home = projectionFromAnalysis(a, "home");
  const away = projectionFromAnalysis(a, "away");
  if (!home || !away) {
    return explanation({
      eyebrow: "Proyección",
      title: "Valor esperado en puntos",
      value: "Sin cálculo",
      summary: "No hay probabilidades suficientes para proyectar puntos en este partido.",
      drivers: [rawDriver("Probabilidades 1X2", "El cálculo necesita el 1X2 del modelo.", "Pendiente", 0.4)],
      steps: [{ label: "1X2", value: "Sin dato", note: "No se puede aplicar VE" }],
      formula: "VE = 3 × P(gana) + 1 × P(empata) + 0 × P(pierde) − C.",
      caveat: "Sin 1X2 no se puede calcular el valor esperado en puntos.",
    });
  }
  const leader = home.ve >= away.ve ? home : away;
  const trail = leader === home ? away : home;
  return explanation({
    eyebrow: "Proyección",
    title: "Valor esperado en puntos",
    value: `${home.team.abbr} ${signed(home.ve)} · ${away.team.abbr} ${signed(away.ve)}`,
    summary: `La fórmula adapta el valor esperado a puntos de fútbol. ${home.team.short} suma ${num(home.expected)} puntos esperados con el 1X2 del modelo frente a una referencia de ${num(home.baseline.ppg)} PPG: VE ${signed(home.ve)}. ${away.team.short} suma ${num(away.expected)} puntos frente a ${num(away.baseline.ppg)} PPG: VE ${signed(away.ve)}. Un VE positivo significa que el modelo espera más puntos que la referencia histórica del equipo; es una lectura deportiva, no una recomendación.`,
    drivers: [
      rawDriver(`VE ${leader.team.abbr}`, "Puntos esperados menos la referencia C.", `${signed(leader.ve)} pts`, 0.85, leader.tone),
      rawDriver(`VE ${trail.team.abbr}`, "Misma fórmula para el otro equipo.", `${signed(trail.ve)} pts`, 0.7, trail.tone),
      rawDriver(`P(gana) ${home.team.abbr}`, "Probabilidad 1X2 del modelo.", pct(home.win), 0.75),
      rawDriver(`P(gana) ${away.team.abbr}`, "Probabilidad 1X2 del modelo.", pct(away.win), 0.65),
      rawDriver("Referencia C", "PPG de temporada o de los últimos 10 partidos.", `${num(home.baseline.ppg)} / ${num(away.baseline.ppg)}`, 0.6),
    ],
    steps: [
      { label: `1. 1X2 ${home.team.abbr}`, value: `${pct(home.win, 0)} / ${pct(home.draw, 0)} / ${pct(home.loss, 0)}`, note: "Gana / empata / pierde" },
      { label: `2. 1X2 ${away.team.abbr}`, value: `${pct(away.win, 0)} / ${pct(away.draw, 0)} / ${pct(away.loss, 0)}`, note: "Gana / empata / pierde" },
      { label: "3. Puntos esperados", value: `${num(home.expected)} / ${num(away.expected)}`, note: "3×P(gana) + 1×P(empata)" },
      { label: "4. Referencia C", value: `${num(home.baseline.ppg)} / ${num(away.baseline.ppg)}`, note: "PPG del equipo" },
      { label: "5. VE", value: `${signed(home.ve)} / ${signed(away.ve)}`, note: "Puntos esperados − C" },
    ],
    formula: "VE = Σ(P_i × G_i) − C = 3 × P(gana) + 1 × P(empata) + 0 × P(pierde) − C. C = PPG de referencia del equipo.",
    caveat: "El VE se expresa en puntos de fútbol: la fórmula se adapta al rendimiento deportivo. Un VE positivo solo indica que el modelo espera más puntos que la referencia histórica del equipo; no garantiza el resultado. Los partidos posteriores se proyectan con un rival promedio de la liga cuando el calendario disponible no trae el fixture confirmado, y la interfaz los marca como escenarios.",
  });
}

function tiebreakExplanation(a) {
  const t = a.tiebreak;
  if (!t) {
    return explanation({
      eyebrow: "Desempate",
      title: "Partidos parejos",
      value: "Sin cálculo",
      summary: "No hay datos de desempate para este partido.",
      drivers: [rawDriver("Señales", "Se necesitan probabilidades y métricas del partido.", "Pendiente", 0.4)],
      steps: [{ label: "Desempate", value: "Pendiente", note: "Sin datos" }],
      formula: "edge = Σ(peso_i × señal_i) / Σ(peso_i).",
      caveat: "Sin señales no se puede calcular el desempate.",
    });
  }
  const maxContribution = Math.max(
    ...t.signals.filter((signal) => signal.available).map((signal) => Math.abs(signal.contribution)),
    0.001,
  );
  const drivers = t.signals
    .filter((signal) => signal.available)
    .map((signal) => rawDriver(
      signal.label,
      signal.detail,
      `${signed(signal.signal, 2)} · peso ${Math.round(signal.weight * 100)}%`,
      Math.min(1, Math.abs(signal.contribution) / maxContribution),
      signal.tone,
    ))
    .sort((x, y) => y.magnitude - x.magnitude)
    .slice(0, 4);
  const official = `1X2 oficial: ${pct(a.probs.home)} / ${pct(a.probs.draw)} / ${pct(a.probs.away)}.`;
  const adjusted = `Lectura ajustada: ${pct(t.adjustedProbs.home)} / ${pct(t.adjustedProbs.draw)} / ${pct(t.adjustedProbs.away)}.`;
  return explanation({
    eyebrow: "Desempate",
    title: t.applies ? "Partido parejo: lectura ajustada" : "Partido parejo: sin ajuste",
    value: t.verdict,
    summary: t.applies
      ? `${t.summary} ${official} ${adjusted}`
      : `${t.reason} ${official}`,
    drivers: drivers.length
      ? drivers
      : [rawDriver("Señales", "No hay señales disponibles.", "Sin muestra", 0.4)],
    steps: t.steps,
    formula: `${t.formula} ${t.formulaNote}`,
    caveat: t.note,
  });
}

function playerFormExplanation(a) {
  const home = a.home?.playerForm;
  const away = a.away?.playerForm;
  const homeSample = home?.sample ?? 0;
  const awaySample = away?.sample ?? 0;
  const homeLatest = home?.matches?.[0];
  const awayLatest = away?.matches?.[0];
  const homeTop = home?.players?.[0];
  const awayTop = away?.players?.[0];
  return explanation({
    eyebrow: "Jugadores",
    title: "Quién rindió y por qué",
    value: `${a.home.short} ${homeSample} · ${a.away.short} ${awaySample}`,
    summary: `El panel resume los últimos ${Math.max(homeSample, awaySample) || 2} partidos de cada equipo con el boxscore, la plantilla y los eventos públicos de ESPN. La cronología permite ver goles, asistencias, tarjetas y cambios del último partido; el índice NOX ordena la aportación individual. No se usa Google como fuente ni se inventan estadísticas que ESPN no publique.`,
    drivers: [
      rawDriver(`${a.home.short} · resumen`, "Victorias, empates, derrotas y goles recientes.", homeSample ? `${home.summary?.wins ?? 0}V ${home.summary?.draws ?? 0}E ${home.summary?.losses ?? 0}D · ${home.summary?.goals ?? 0}-${home.summary?.conceded ?? 0}` : "Sin muestra", 0.8),
      rawDriver(`${a.away.short} · resumen`, "Misma ventana y misma fuente.", awaySample ? `${away.summary?.wins ?? 0}V ${away.summary?.draws ?? 0}E ${away.summary?.losses ?? 0}D · ${away.summary?.goals ?? 0}-${away.summary?.conceded ?? 0}` : "Sin muestra", 0.75),
      rawDriver("Jugador destacado", "El mayor índice NOX de cada equipo.", homeTop || awayTop ? `${homeTop?.name || awayTop?.name || "—"} · ${num(homeTop?.impact ?? awayTop?.impact ?? 0, 1)}` : "Sin muestra", 0.6),
      rawDriver("Cronología", "Eventos del partido más reciente.", homeLatest?.timeline?.length || awayLatest?.timeline?.length ? `${homeLatest?.timeline?.length ?? 0} + ${awayLatest?.timeline?.length ?? 0} eventos` : "Sin eventos", 0.5),
    ],
    steps: [
      { label: "1. Resumen", value: "Boxscore + rosters", note: "ESPN summary" },
      { label: "2. Eventos", value: "Goles, tarjetas, cambios", note: "keyEvents y narración" },
      { label: "3. Agregado", value: "Últimos 2 partidos", note: "Jugadores una sola vez por equipo" },
      { label: "4. Índice", value: "0–100 aprox.", note: "Aportación descriptiva, no oficial" },
    ],
    formula: "índice = 5×goles + 3×asistencias + 1.5×remates a puerta + 0.4×remates + 0.8×titularidad + 0.3×suplencia − 0.3×amarillas − 2×rojas − 3×autogoles.",
    caveat: "La cronología es la de ESPN, no la de Google. El índice es una construcción propia para ordenar la lectura, no una calificación oficial ni una probabilidad. Si ESPN no publica estadísticas de equipo, el panel lo indica y no rellena ceros como si fueran datos reales.",
  });
}

export function buildHitsExplanation(a, validation) {
  const modelHeadline = validation?.headline;
  if (modelHeadline?.n) {
    const h = modelHeadline;
    const ci = h.ci?.accuracy;
    return explanation({
      eyebrow: "Total de aciertos · ensamble",
      title: "Aciertos 1X2 del ensamble",
      value: `${pct(h.accuracy, 1)} · ${h.hits}/${h.n}`,
      summary: `En el test temporal 2024-25 y 2025-26, el ensamble calibrado acertó ${h.hits} de ${h.n} partidos (${pct(h.accuracy, 1)}). Cada modelo se calibró antes de compararse y los pesos se aprendieron solo en la validación 2023-24. La racha actual es ${h.currentStreak ?? 0} y la mejor racha es ${h.bestStreak ?? 0}.`,
      drivers: [
        rawDriver("Partidos de test", "Muestra 2024-25 y 2025-26 evaluada una sola vez.", String(h.n), 0.8),
        rawDriver("Aciertos", "Signo 1X2 más probable = signo final.", String(h.hits), 0.8, h.accuracy >= 0.5 ? "pos" : "neutral"),
        rawDriver("Precisión", "Aciertos / partidos de test.", pct(h.accuracy, 1), 0.75),
        rawDriver("Skill vs base", "Mejora relativa de Brier frente a la base de liga.", `${h.skill >= 0 ? "+" : ""}${(h.skill * 100).toFixed(1)}%`, 0.7, h.skill > 0 ? "pos" : "neg"),
        rawDriver("IC 95%", "Intervalo bootstrap de la precisión.", ci ? `${pct(ci[0], 1)}–${pct(ci[1], 1)}` : "—", 0.55),
      ],
      steps: [
        { label: "1. Entrenamiento", value: "2020-21 a 2022-23", note: "Cuatro modelos tabulares" },
        { label: "2. Validación", value: "2023-24", note: "Calibración y pesos" },
        { label: "3. Test", value: "2024-25 y 2025-26", note: "Una sola evaluación" },
        { label: "4. Acierto", value: "argmax 1X2", note: "Local, empate o visitante" },
      ],
      formula: "acierto_i = 1 si argmax(p_local, p_empate, p_visitante) = signo_real; precisión = Σ aciertos / N. El ensamble combina cuatro modelos calibrados con pesos aprendidos en validación y sin piso artificial; los modelos que no aportan quedan en cero.",
      caveat: "Es un test histórico de dos ligas, no un registro de pronósticos publicados antes de cada partido ni una recomendación. Solo mide el signo 1X2: no incluye goles, BTTS, córners ni tarjetas. Una precisión histórica no garantiza resultados futuros.",
    });
  }
  const h = validation?.hits;
  if (!h?.n) {
    return explanation({
      eyebrow: "Total de aciertos",
      title: "Aciertos medidos",
      value: "Sin muestra",
      summary: "Todavía no hay partidos suficientes en el backtest walk-forward para medir el total de aciertos.",
      drivers: [rawDriver("Muestra", "Se necesitan partidos con historial previo.", "0", 0.4)],
      steps: [{ label: "Backtest", value: "Pendiente", note: "Sin muestra" }],
      formula: "tasa = aciertos / partidos evaluados.",
      caveat: "La tasa solo se calcula con datos live y no es una garantía de resultados futuros.",
    });
  }
  return explanation({
    eyebrow: "Total de aciertos",
    title: "Aciertos 1X2 medidos",
    value: `${pct(h.rate, 1)} · ${h.hits}/${h.n}`,
    summary: `De ${h.n} partidos evaluados, ${h.hits} coinciden con el signo 1X2 más probable del modelo. Cada predicción se hizo solo con resultados anteriores. La racha actual es ${h.currentStreak ?? 0} y la mejor racha de aciertos consecutivos es ${h.bestStreak ?? 0}.`,
    drivers: [
      rawDriver("Partidos evaluados", "Muestra walk-forward con historial previo suficiente.", String(h.n), 0.8),
      rawDriver("Aciertos", "Signo más probable = signo final.", String(h.hits), 0.8, h.rate >= 0.5 ? "pos" : "neutral"),
      rawDriver("Tasa", "Aciertos / partidos evaluados.", pct(h.rate, 1), 0.75),
      rawDriver("Rachas", "Actual y mejor racha consecutiva.", `${h.currentStreak ?? 0} / ${h.bestStreak ?? 0}`, 0.5),
    ],
    steps: [
      { label: "1. Pick", value: "argmax 1X2", note: "Local, empate o visitante" },
      { label: "2. Resultado", value: "Signo real", note: "Se compara con el marcador final" },
      { label: "3. Acierto", value: "1 o 0", note: "Coincide o no coincide" },
      { label: "4. Tasa", value: `${h.hits}/${h.n}`, note: pct(h.rate, 1) },
    ],
    formula: "acierto_i = 1 si argmax(p_local, p_empate, p_visitante) = signo_real; tasa = Σ aciertos / N.",
    caveat: "Es una simulación histórica walk-forward, no un registro de pronósticos publicados antes de cada partido ni una recomendación. Solo mide el signo 1X2: no incluye goles, BTTS, córners ni tarjetas. Una tasa de aciertos alta no implica rentabilidad.",
  });
}

export function buildLatentExplanation(a, latent) {
  const s = latent?.summary;
  if (!s) {
    return explanation({
      eyebrow: "Equipos latentes",
      title: "Índice de apoyo",
      value: "Sin muestra",
      summary: "No hay datos suficientes para analizar equipos de mitad de tabla.",
      drivers: [rawDriver("Muestra", "Se necesitan tablas y resultados históricos.", "0", 0.4)],
      steps: [{ label: "Análisis", value: "Pendiente", note: "Sin muestra" }],
      formula: "índice = 50 + (tasa_racha − base) × 150 + ajustes.",
      caveat: "El índice es descriptivo y no una probabilidad de victoria.",
    });
  }
  return explanation({
    eyebrow: "Equipos latentes",
    title: "Índice de apoyo",
    value: `${s.midTableTeams} equipos · base ${pct(s.overallWinRate, 0)}`,
    summary: `El análisis toma el tercio medio de cada liga y mide qué pasó después de una racha de victorias, empates o derrotas. Se reconstruyeron ${s.streakSamples} casos y ${s.upsets} sorpresas de equipos del tercio inferior ante rivales del tercio superior. El índice de apoyo ordena ese contexto de 0 a 100; no es una probabilidad.`,
    drivers: [
      rawDriver("Equipos latentes", "Tercio medio de la tabla actual.", String(s.midTableTeams), 0.8),
      rawDriver("Sorpresas", "Victorias del tercio inferior sobre el superior.", String(s.upsets), 0.7),
      rawDriver("Casos de racha", "Resultados siguientes con racha previa.", String(s.streakSamples), 0.7),
      rawDriver("Base de victoria", "Tasa de victoria de la muestra latente.", pct(s.overallWinRate, 0), 0.6),
    ],
    steps: [
      { label: "1. Posición", value: "Tercio medio", note: "Sin usar la tabla final" },
      { label: "2. Racha", value: "Últimos 10", note: "Victorias, empates o derrotas" },
      { label: "3. Casos", value: "Resultado siguiente", note: "Misma racha y localía" },
      { label: "4. Índice", value: "0–100", note: "Contexto, no probabilidad" },
    ],
    formula: "índice = clamp(50 + (tasa_victoria_racha − base) × 150 + localía (±5) + ajuste_rival (±5) + ajuste_PPG (±3), 0, 100).",
    caveat: "Las posiciones se reconstruyen antes de cada partido para no usar la tabla final como fuga de información. El índice es una señal descriptiva: no garantiza que la racha se repita y no sustituye un análisis de alineaciones. Las muestras cortas se marcan como tales.",
  });
}

export function buildValidationExplanation(a, validation) {
  const modelHeadline = validation?.headline;
  const modelMarkets = validation?.markets;
  if (modelHeadline?.n && modelMarkets) {
    const h = modelHeadline;
    const one = modelMarkets["1x2"] || {};
    const poisson = one.poisson || h.poisson || {};
    const benchmark = validation.benchmark?.markets?.["1x2"];
    return explanation({
      eyebrow: "Precisión · ensamble calibrado",
      title: "Test temporal de OX",
      value: `${h.n} partidos · ${pct(h.accuracy, 1)}`,
      summary: `El ensamble de cuatro modelos se evaluó una sola vez en 2024-25 y 2025-26: ${h.hits}/${h.n} aciertos 1X2 (${pct(h.accuracy, 1)}), log-loss ${num(h.logLoss, 4)} y Brier ${num(h.brier, 4)} frente a una base de ${num(h.baseline.brier, 4)} (skill ${h.skill >= 0 ? "+" : ""}${(h.skill * 100).toFixed(1)}%). El Poisson calibrado obtuvo ${pct(poisson.accuracy ?? 0, 1)} y log-loss ${num(poisson.logLoss ?? 0, 4)}. Los pesos se aprendieron solo en la segunda mitad de la validación 2023-24.`,
      drivers: [
        rawDriver("Test", "2024-25 y 2025-26, dos ligas.", String(h.n), 0.8),
        rawDriver("Aciertos 1X2", "Signo más probable del ensamble.", `${h.hits}/${h.n}`, 0.8, h.accuracy >= 0.5 ? "pos" : "neutral"),
        rawDriver("Log-loss", "Error probabilístico multiclase; menor es mejor.", num(h.logLoss, 4), 0.75),
        rawDriver("Brier", "Error cuadrático medio del 1X2.", num(h.brier, 4), 0.7),
        rawDriver("Skill", "Mejora relativa frente a la base de liga.", `${h.skill >= 0 ? "+" : ""}${(h.skill * 100).toFixed(1)}%`, 0.65, h.skill > 0 ? "pos" : "neg"),
        rawDriver("Mercado de cierre", "Referencia externa; no es feature ni entra al ensamble.", benchmark ? pct(benchmark.accuracy, 1) : "—", 0.5),
      ],
      steps: [
        { label: "1. Entrenamiento", value: "2020-21 a 2022-23", note: "Poisson y tres logísticas" },
        { label: "2. Calibración", value: "2023-24 · primera mitad", note: "Temperature scaling por modelo y mercado" },
        { label: "3. Pesos", value: "2023-24 · segunda mitad", note: "SLSQP sin piso; los modelos que no aportan quedan en cero" },
        { label: "4. Test", value: "2024-25 y 2025-26", note: "Una sola evaluación, sin mirar el futuro" },
        { label: "5. Comparación", value: "Ensamble vs Poisson vs base", note: "Log-loss, Brier y skill" },
      ],
      formula: "p_ensamble = Σ w_m · p_m; los pesos w_m se aprenden en validación minimizando log-loss con w_m ≥ 0.05 y Σ w_m = 1. Brier = (1/N) Σ Σ (p - y)^2; skill = 1 - Brier_modelo / Brier_base.",
      caveat: "El test se evaluó una sola vez y no participó en el entrenamiento, la calibración ni la elección de pesos. El mercado de cierre se reporta solo como referencia externa: no es una feature. El fallback usa Poisson calibrado si falta la fila de features o el ancla Elo. Es un piloto de dos ligas; no es una promesa de precisión futura.",
    });
  }
  const overall = validation?.overall;
  if (!overall || !overall.n) {
    return explanation({
      eyebrow: "Precisión",
      title: "Validación walk-forward",
      value: "Sin muestra",
      summary: "Todavía no hay suficientes partidos históricos para una validación walk-forward. Ejecuta una actualización live para generar la muestra.",
      drivers: [rawDriver("Muestra", "Se necesitan partidos anteriores con resultado.", "0", 0.4)],
      steps: [{ label: "Backtest", value: "Pendiente", note: "Sin datos suficientes" }],
      formula: "Brier = (1/N) Σ (p - y)^2.",
      caveat: "El panel solo se calcula con datos live. Con datos de respaldo o propios no hay una muestra histórica comparable.",
    });
  }
  const market = overall.markets || {};
  const oneX2 = market["1x2"] || {};
  return explanation({
    eyebrow: "Precisión",
    title: "Validación walk-forward propia",
    value: `${overall.n} partidos`,
    summary: `El backtest evalúa cada partido solo con resultados anteriores: sin fuga de información. El Brier del 1X2 es ${num(oneX2.brier, 4)} frente a una base de ${num(oneX2.baseline, 4)} (skill ${((oneX2.skill ?? 0) * 100).toFixed(1)}%). La muestra cubre ${validation.leaguesCount ?? "varias"} ligas y ${validation.markets?.length ?? 5} salidas.`,
    drivers: [
      rawDriver("Muestra", "Partidos evaluados con historial previo suficiente.", String(overall.n), 0.8),
      rawDriver("Brier 1X2", "Error cuadrático medio multiclase; menor es mejor.", num(oneX2.brier, 4), 0.75),
      rawDriver("Base de liga", "Frecuencias históricas de local/empate/visitante.", num(oneX2.baseline, 4), 0.65),
      rawDriver("Skill", "Mejora relativa frente a la base.", `${((oneX2.skill ?? 0) * 100).toFixed(1)}%`, 0.6, (oneX2.skill ?? 0) > 0 ? "pos" : "neg"),
    ],
    steps: [
      { label: "1. Orden temporal", value: "Partido a partido", note: "Solo resultados anteriores" },
      { label: "2. Fuerzas", value: "Últimos 10 + temporada", note: "Misma lógica del motor" },
      { label: "3. Matriz y calibración", value: "Poisson + Dixon-Coles + T + Platt", note: "Sin mirar el futuro" },
      { label: "4. Brier", value: "Σ(p - y)^2 / N", note: "1X2, BTTS, over 1.5/2.5/3.5" },
      { label: "5. Comparación", value: "Modelo vs base", note: "Skill = 1 - Brier/Brier_base" },
    ],
    formula: "Brier = (1/N) Σ (p - y)^2; skill = 1 - Brier_modelo / Brier_base. Para 1X2 se suman las tres probabilidades.",
    caveat: "El backtest es propio y walk-forward, pero simplifica el contexto: no usa alineaciones, árbitro ni clima. Una muestra de una temporada no garantiza el futuro. Los resultados por liga pueden variar y no se presentan como una promesa de precisión.",
  });
}

export function buildExplanations(a) {
  const exp = {};
  exp["outcome:home"] = outcomeExplanation(a, "home");
  exp["outcome:draw"] = outcomeExplanation(a, "draw");
  exp["outcome:away"] = outcomeExplanation(a, "away");
  exp.scoreline = scorelineExplanation(a);
  for (let i = 0; i < a.topScores.length; i += 1) exp[`scoreline:${i}`] = scorelineExplanation(a, i);
  exp.btts = bttsExplanation(a);
  exp.firstGoal = firstGoalExplanation(a);
  exp["teamScore:home"] = teamScoreExplanation(a, "home");
  exp["teamScore:away"] = teamScoreExplanation(a, "away");
  exp["metric:goals"] = goalsMetricExplanation(a);
  exp["metric:shots"] = shotsMetricExplanation(a);
  exp["metric:onTarget"] = onTargetMetricExplanation(a);
  exp["metric:corners"] = cornersMetricExplanation(a);
  exp["metric:cards"] = cardsMetricExplanation(a);
  exp["metric:possession"] = possessionMetricExplanation(a);
  exp.distribution = distributionExplanation(a);
  exp.confidence = confidenceExplanation(a);
  exp.certainty = certaintyExplanation(a);
  exp.methodology = methodologyExplanation(a);
  exp.table = tableExplanation(a);
  exp.markets = marketsExplanation(a);
  exp.engine = engineExplanation(a);
  exp.recentForm = recentExplanation(a);
  exp.playerForm = playerFormExplanation(a);
  exp.h2h = h2hExplanation(a);
  exp.matrix = matrixOverviewExplanation(a);
  for (let i = 0; i < 7; i += 1) {
    for (let j = 0; j < 7; j += 1) exp[`matrix:${i}:${j}`] = matrixExplanation(a, i, j);
  }
  exp.timing = timingExplanation(a);
  exp.scenarios = scenariosExplanation(a);
  exp.projection = projectionExplanation(a);
  exp.tiebreak = tiebreakExplanation(a);

  for (const f of a.factors) exp[`factor:${f.key}`] = factorExplanation(a, f);
  for (const side of ["home", "away"]) {
    for (const player of a.players[side]) exp[player.key] = playerExplanation(a, side, player);
  }
  const metaLabel = a.league.live ? "datos live de ESPN" : a.league.demo ? "datos de respaldo" : "datos propios";
  for (const item of Object.values(exp)) {
    if (item.meta) item.meta = item.meta.replace(/datos de respaldo|datos de demostración|datos propios|datos live de ESPN/, metaLabel);
  }
  return exp;
}
