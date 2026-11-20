// MOTOR-NOX V1.0 — observaciones de tiros por equipo.
//
// ESPN publica los tiros de cada equipo en el resumen de los partidos ya
// jugados. El motor no debe confundir esa señal observada con una estimación:
// este módulo toma la muestra real, la contrae hacia la fuerza de goles y deja
// la procedencia escrita en el equipo para que la interfaz la muestre.
//
// No copia código de terceros. La contracción y los mínimos son propios.

import { ENGINE } from "./calibration.js";

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Devuelve los partidos del formulario que tienen estadísticas de tiros
 * completas para el equipo y su rival.
 */
export function shotSampleFromForm(team) {
  const matches = Array.isArray(team?.playerForm?.matches) ? team.playerForm.matches : [];
  return matches.filter((match) => (
    match?.stats?.hasStats === true
    && match?.rivalStats?.hasStats === true
    && Number.isFinite(Number(match.stats.shots))
    && Number.isFinite(Number(match.rivalStats.shots))
  ));
}

/**
 * Convierte los tiros observados en tasas estables para el partido próximo.
 *
 * - Exige `ENGINE.shotsMinMatches` partidos con estadísticas completas.
 * - Mezcla la media observada con la estimación previa del equipo usando un
 *   prior de `ENGINE.shotsPriorMatches` partidos.
 * - Marca `estimated.shots = false` solo cuando la muestra alcanza el mínimo.
 *   El valor sigue siendo una proyección del partido futuro, pero su insumo
 *   principal ya no es una estimación.
 *
 * @param {object} team equipo generado por datos_live.mjs
 * @param {object} options { minMatches, priorMatches }
 * @returns {object} resultado compacto para logs y pruebas
 */
export function applyShotRates(team, options = {}) {
  if (!team || typeof team !== "object") {
    return { applied: false, matches: 0, reason: "Equipo inválido." };
  }

  const minMatches = Math.max(
    1,
    Number(options.minMatches ?? ENGINE.shotsMinMatches) || ENGINE.shotsMinMatches,
  );
  const priorMatches = Math.max(
    1,
    Number(options.priorMatches ?? ENGINE.shotsPriorMatches) || ENGINE.shotsPriorMatches,
  );
  const sample = shotSampleFromForm(team);
  const matches = sample.length;

  if (matches < minMatches) {
    team.shotsSource = "estimated";
    team.shotsSample = { matches, minMatches, priorMatches };
    team.estimated = { ...(team.estimated || {}), shots: true };
    return {
      applied: false,
      matches,
      minMatches,
      priorMatches,
      reason: `Muestra insuficiente: ${matches}/${minMatches} partidos con tiros completos.`,
    };
  }

  const observedFor = sample.reduce((sum, match) => sum + Number(match.stats.shots), 0) / matches;
  const observedAgainst = sample.reduce(
    (sum, match) => sum + Number(match.rivalStats.shots),
    0,
  ) / matches;
  const priorFor = Number(team.shotsFor);
  const priorAgainst = Number(team.shotsAgainst);
  const baseFor = Number.isFinite(priorFor) && priorFor > 0 ? priorFor : observedFor;
  const baseAgainst = Number.isFinite(priorAgainst) && priorAgainst > 0
    ? priorAgainst
    : observedAgainst;
  const weight = matches / (matches + priorMatches);
  const shotsFor = (1 - weight) * baseFor + weight * observedFor;
  const shotsAgainst = (1 - weight) * baseAgainst + weight * observedAgainst;

  team.shotsFor = round(shotsFor, 2);
  team.shotsAgainst = round(shotsAgainst, 2);
  team.shotsSource = "observed-shrunk";
  team.shotsSample = {
    matches,
    minMatches,
    priorMatches,
    weight: round(weight, 3),
    observedFor: round(observedFor, 2),
    observedAgainst: round(observedAgainst, 2),
    priorFor: round(baseFor, 2),
    priorAgainst: round(baseAgainst, 2),
  };
  team.estimated = { ...(team.estimated || {}), shots: false };

  return {
    applied: true,
    matches,
    minMatches,
    priorMatches,
    weight: round(weight, 3),
    observedFor: round(observedFor, 2),
    observedAgainst: round(observedAgainst, 2),
    shotsFor: team.shotsFor,
    shotsAgainst: team.shotsAgainst,
  };
}
