// Generado por datos_live.mjs el 20/11/2026, 10:16:56 a.m..
// Fuente de datos: ESPN (calendario, tablas, forma y sede).
// Probabilidades y salidas: motor propio de OX V1.0.
// No edites este archivo a mano; ejecuta: node datos_live.mjs
export const LEAGUE = {
  "id": "live-espn",
  "name": "Fútbol internacional",
  "season": "Temporada en curso",
  "avgGoals": 1.524,
  "homeFactor": 1.1,
  "awayFactor": 0.92,
  "avgCards": 4.5,
  "avgCorners": 10.2,
  "rho": -0.05,
  "demo": false,
  "live": true,
  "source": "ESPN",
  "sourceUrl": "https://www.espn.com/soccer/",
  "updated": "2026-11-20T16:16:56.461Z",
  "matchCount": 120,
  "leagueCount": 14,
  "teamCount": 236,
  "historyEvents": 5678,
  "historyTeams": 236,
  "onTargetRates": {
    "derived": 224,
    "placeholder": 12
  },
  "shotRates": {
    "derived": 224,
    "placeholder": 12
  },
  "note": "Calendario, tablas, forma, sede y tiros por equipo: ESPN. Probabilidades y salidas: OX V1.0. Uso personal y educativo."
};

export const TYPE_LABELS = {
  "league": "Liga regular",
  "liguilla": "Liguilla",
  "round16": "Octavos de final",
  "quarterfinal": "Cuartos de final",
  "semifinal": "Semifinal",
  "final": "Final",
  "friendly": "Amistoso"
};

export const FILTERS = [
  {
    "id": "all",
    "label": "Todos"
  },
  {
    "id": "today",
    "label": "Hoy"
  },
  {
    "id": "tomorrow",
    "label": "Mañana"
  },
  {
    "id": "league",
    "label": "Por liga"
  }
];
