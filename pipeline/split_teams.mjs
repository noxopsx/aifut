// Divide el dataset de equipos en dos capas para que la interfaz no descargue
// el detalle de jugadores (el bloque más pesado) hasta que se necesite.
//
// - teams_base.js  -> equipos sin `playerForm` (carga inicial)
// - player_form.js -> detalle de jugadores por equipo (bajo demanda)
//
// `js/data/teams.js` se mantiene completo para tests y pipelines.

/**
 * @param {Record<string, object>} teams dataset completo de equipos
 * @param {string} header cabecera de generación compartida
 */
export function splitTeams(teams, header) {
  const base = {};
  const playerForms = {};

  for (const [id, team] of Object.entries(teams || {})) {
    const { playerForm, ...rest } = team;
    base[id] = rest;
    if (playerForm != null) playerForms[id] = playerForm;
  }

  return {
    baseJs: `${header}// Equipos sin detalle de jugadores. Carga inicial de AIFUT.\nexport const TEAMS = ${JSON.stringify(base, null, 2)};\n`,
    detailJs: `${header}// Detalle de jugadores por equipo. Se carga solo con el análisis completo.\nexport const PLAYER_FORMS = ${JSON.stringify(playerForms, null, 2)};\n`,
  };
}
