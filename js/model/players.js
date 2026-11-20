// Rendimiento reciente de jugadores y cronología de partidos.
// ==========================================================
//
// Convierte el summary público de ESPN en un informe compacto por equipo:
// estadísticas de equipo, aportación individual, cronología de goles y
// tarjetas, y una explicación breve del resultado.
//
// La fuente es ESPN, no Google. La interfaz lo indica para no atribuir mal
// la procedencia de los datos. El módulo es descriptivo: no estima precios ni
// emite recomendaciones.

export const PLAYERS_VERSION = "1.0";
export const PLAYER_REPORT_MATCHES = 3;
export const MAX_TIMELINE_EVENTS = 18;

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function statMap(stats) {
  const map = {};
  for (const stat of stats || []) {
    if (!stat?.name) continue;
    map[stat.name] = num(stat.value ?? stat.displayValue);
  }
  return map;
}

function pct(value) {
  const parsed = num(value);
  return parsed > 0 && parsed <= 1 ? Math.round(parsed * 1000) / 10 : Math.round(parsed * 10) / 10;
}

function teamStats(summary, teamId) {
  const entry = (summary.boxscore?.teams || []).find((team) => String(team.team?.id) === String(teamId));
  const stats = statMap(entry?.statistics);
  const hasStats = Boolean(entry?.statistics?.length);
  return {
    hasStats,
    possession: pct(stats.possessionPct),
    shots: Math.round(stats.totalShots || 0),
    shotsOnTarget: Math.round(stats.shotsOnTarget || 0),
    corners: Math.round(stats.wonCorners || 0),
    fouls: Math.round(stats.foulsCommitted || 0),
    yellow: Math.round(stats.yellowCards || 0),
    red: Math.round(stats.redCards || 0),
    offsides: Math.round(stats.offsides || 0),
    saves: Math.round(stats.saves || 0),
    passes: Math.round(stats.totalPasses || 0),
    passPct: pct(stats.passPct),
  };
}

function positionOf(player) {
  return player.position?.abbreviation
    || player.athlete?.position?.abbreviation
    || player.position?.name
    || "";
}

function playerImpact(stats, starter, subIn) {
  const goals = stats.totalGoals || 0;
  const assists = stats.goalAssists || 0;
  const shots = stats.totalShots || 0;
  const onTarget = stats.shotsOnTarget || 0;
  const yellow = stats.yellowCards || 0;
  const red = stats.redCards || 0;
  const own = stats.ownGoals || 0;
  return Math.round((
    goals * 5
    + assists * 3
    + onTarget * 1.5
    + shots * 0.4
    + (starter ? 0.8 : 0)
    + (subIn ? 0.3 : 0)
    - yellow * 0.3
    - red * 2
    - own * 3
  ) * 10) / 10;
}

function playerLine(player) {
  const stats = statMap(player.stats);
  const name = player.athlete?.displayName || player.athlete?.shortName || "";
  if (!name) return null;
  const starter = Boolean(player.starter);
  const subIn = stats.subIns || 0;
  const appearances = stats.appearances || (starter || subIn ? 1 : 0);
  if (!appearances && !starter && !subIn) return null;
  const goals = Math.round(stats.totalGoals || 0);
  const assists = Math.round(stats.goalAssists || 0);
  const shots = Math.round(stats.totalShots || 0);
  const onTarget = Math.round(stats.shotsOnTarget || 0);
  const yellow = Math.round(stats.yellowCards || 0);
  const red = Math.round(stats.redCards || 0);
  return {
    id: String(player.athlete?.id || ""),
    name,
    shortName: player.athlete?.shortName || name,
    jersey: player.jersey || "",
    pos: positionOf(player),
    starter,
    subIn: Boolean(subIn),
    goals,
    assists,
    shots,
    onTarget,
    yellow,
    red,
    ownGoals: Math.round(stats.ownGoals || 0),
    conceded: Math.round(stats.goalsConceded || 0),
    faced: Math.round(stats.shotsFaced || 0),
    impact: playerImpact(stats, starter, subIn),
  };
}

function playersFor(summary, teamId) {
  const entry = (summary.rosters || []).find((roster) => String(roster.team?.id) === String(teamId));
  return (entry?.roster || [])
    .map(playerLine)
    .filter(Boolean)
    .sort((a, b) => b.impact - a.impact || b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name));
}

function eventKind(event) {
  const type = `${event.type?.text || ""} ${event.type?.type || ""}`.toLowerCase();
  if (event.scoringPlay) {
    if (type.includes("own goal")) return "own-goal";
    if (type.includes("penalty")) return "penalty";
    return "goal";
  }
  if (type.includes("yellow")) return "yellow";
  if (type.includes("red")) return "red";
  if (type.includes("substitution")) return "sub";
  if (type.includes("penalty missed") || type.includes("penalty - missed")) return "penalty-miss";
  return null;
}

function participantNames(event) {
  return (event.participants || [])
    .map((participant) => participant.athlete?.displayName || participant.displayName || participant)
    .filter((name) => typeof name === "string" && name.trim());
}

function scoreFromText(text) {
  const match = String(text || "").match(/^[^!]*!\s*.+?\s+(\d+),\s*.+?\s+(\d+)\./);
  return match ? `${match[1]}-${match[2]}` : "";
}

function withRunningScore(rows, homeId, awayId, homeGoals, awayGoals) {
  const goals = rows.filter((row) => ["goal", "penalty", "own-goal"].includes(row.kind));
  const countHome = goals.filter((row) => row.teamId === String(homeId)).length;
  const countAway = goals.filter((row) => row.teamId === String(awayId)).length;
  const canDerive = countHome === homeGoals && countAway === awayGoals;
  let home = 0;
  let away = 0;
  for (const row of rows) {
    if (!["goal", "penalty", "own-goal"].includes(row.kind)) continue;
    if (canDerive) {
      if (row.teamId === String(homeId)) home += 1;
      else if (row.teamId === String(awayId)) away += 1;
      row.score = `${home}-${away}`;
    } else {
      row.score = scoreFromText(row.text);
    }
  }
  return rows;
}

function timelineFor(summary, homeId, awayId, homeGoals, awayGoals) {
  const rows = [];
  for (const event of summary.keyEvents || []) {
    const kind = eventKind(event);
    if (!kind) continue;
    const names = participantNames(event);
    const teamId = String(event.team?.id || "");
    const isHome = teamId === String(homeId);
    const isAway = teamId === String(awayId);
    if (!isHome && !isAway) continue;
    const text = String(event.text || event.shortText || "").replace(/\s+/g, " ").trim();
    rows.push({
      minute: event.clock?.displayValue || "",
      kind,
      teamId,
      teamName: event.team?.displayName || (isHome ? "Local" : "Visitante"),
      venue: isHome ? "home" : "away",
      player: names[0] || "",
      assist: names[1] || "",
      score: "",
      text: text.length > 220 ? `${text.slice(0, 217)}...` : text,
    });
  }
  const byMinute = (a, b) => (parseInt(a.minute, 10) || 0) - (parseInt(b.minute, 10) || 0);
  const sorted = rows.sort(byMinute);
  const keep = sorted.length <= MAX_TIMELINE_EVENTS
    ? sorted
    : (() => {
        const isKey = (row) => ["goal", "penalty", "own-goal", "red"].includes(row.kind);
        const key = sorted.filter(isKey);
        const rest = sorted.filter((row) => !isKey(row));
        const slots = Math.max(0, MAX_TIMELINE_EVENTS - key.length);
        return [...key, ...rest.slice(-slots)].sort(byMinute);
      })();
  return withRunningScore(keep, homeId, awayId, num(homeGoals), num(awayGoals));
}

function topPlayer(players) {
  return players.find((player) => player.goals > 0 || player.assists > 0 || player.onTarget > 0)
    || players[0]
    || null;
}

function matchStory(result, gf, ga, own, rival, players) {
  const star = topPlayer(players);
  const starText = star
    ? `${star.name}${star.goals ? ` marcó ${star.goals}` : ""}${star.goals && star.assists ? " y" : ""}${star.assists ? ` dio ${star.assists} asistencia${star.assists === 1 ? "" : "s"}` : ""}`
    : "";
  const shotsEdge = own.shotsOnTarget - rival.shotsOnTarget;
  const possession = own.possession;
  const parts = [];

  if (!own.hasStats) {
    const basic = result === "W"
      ? `Ganó ${gf}-${ga} a ${rival.name}.`
      : result === "D"
        ? `Empató ${gf}-${ga} con ${rival.name}.`
        : `Perdió ${gf}-${ga} contra ${rival.name}.`;
    parts.push(basic);
    if (starText) parts.push(`${starText}.`);
    parts.push("ESPN no publica estadísticas de equipo para este partido; la lectura se apoya en el marcador y la cronología.");
    return parts.join(" ");
  }

  if (result === "W") {
    parts.push(`Ganó ${gf}-${ga} a ${rival.name}.`);
    if (shotsEdge > 0) parts.push(`Fue más preciso: ${own.shotsOnTarget} remates a puerta frente a ${rival.shotsOnTarget}.`);
    else if (own.saves >= 4) parts.push(`Su portero sostuvo el resultado con ${own.saves} paradas.`);
    else parts.push(`Aprovechó sus ${own.shotsOnTarget} remates a puerta.`);
    if (possession && possession < 45) parts.push(`Cedió la posesión (${possession}%).`);
    if (starText) parts.push(`${starText}.`);
  } else if (result === "D") {
    parts.push(`Empató ${gf}-${ga} con ${rival.name}.`);
    if (shotsEdge > 2) parts.push(`Generó más peligro (${own.shotsOnTarget} a puerta frente a ${rival.shotsOnTarget}), pero no lo convirtió.`);
    else if (shotsEdge < -2) parts.push(`Se sostuvo con ${own.saves} paradas y menos llegada.`);
    else parts.push(`Fue un partido parejo en remates a puerta (${own.shotsOnTarget}-${rival.shotsOnTarget}).`);
    if (starText) parts.push(`${starText}.`);
  } else {
    parts.push(`Perdió ${gf}-${ga} contra ${rival.name}.`);
    if (shotsEdge > 2) parts.push(`No le alcanzó con más remates a puerta (${own.shotsOnTarget}-${rival.shotsOnTarget}).`);
    else if (own.red > 0) parts.push(`Jugó con ${own.red} expulsado${own.red === 1 ? "" : "s"} y lo pagó.`);
    else parts.push(`Le faltó puntería: ${own.shotsOnTarget} remates a puerta de ${own.shots}.`);
    if (starText) parts.push(`${starText}.`);
  }
  return parts.join(" ");
}

function resultOf(gf, ga) {
  if (gf > ga) return "W";
  if (gf < ga) return "L";
  return "D";
}

/**
 * Resume un partido completo de ESPN.
 * @param {object} summary respuesta de /summary?event=...
 * @param {object} event partido normalizado por ratings.js
 * @param {object} league { id, name, short }
 */
export function summarizeMatch(summary, event, league = {}) {
  if (!summary || !event) return null;
  const homeId = String(event.homeId);
  const awayId = String(event.awayId);
  const homeStats = teamStats(summary, homeId);
  const awayStats = teamStats(summary, awayId);
  const homePlayers = playersFor(summary, homeId);
  const awayPlayers = playersFor(summary, awayId);
  const timeline = timelineFor(summary, homeId, awayId, event.homeGoals, event.awayGoals);
  const base = {
    id: String(event.id),
    date: event.date,
    leagueId: league.id || event.leagueId || "",
    leagueName: league.name || "",
    homeId,
    awayId,
    homeName: event.homeName,
    awayName: event.awayName,
    homeLogo: event.homeLogo || "",
    awayLogo: event.awayLogo || "",
    homeGoals: event.homeGoals,
    awayGoals: event.awayGoals,
    venue: event.venue || "",
  };

  const build = (side) => {
    const isHome = side === "home";
    const teamId = isHome ? homeId : awayId;
    const rivalId = isHome ? awayId : homeId;
    const gf = isHome ? event.homeGoals : event.awayGoals;
    const ga = isHome ? event.awayGoals : event.homeGoals;
    const own = isHome ? homeStats : awayStats;
    const rival = isHome ? awayStats : homeStats;
    const players = isHome ? homePlayers : awayPlayers;
    const result = resultOf(gf, ga);
    const sideTimeline = timeline.map((row) => ({
      ...row,
      score: row.score && !isHome ? row.score.split("-").reverse().join("-") : row.score,
    }));
    return {
      ...base,
      teamId,
      teamName: isHome ? event.homeName : event.awayName,
      rivalId,
      rivalName: isHome ? event.awayName : event.homeName,
      rivalShort: isHome ? event.awayAbbr : event.homeAbbr,
      rivalLogo: isHome ? event.awayLogo : event.homeLogo,
      venue: isHome ? "home" : "away",
      result,
      score: `${gf}-${ga}`,
      goalsFor: gf,
      goalsAgainst: ga,
      stats: own,
      rivalStats: rival,
      players,
      timeline: sideTimeline,
      story: matchStory(result, gf, ga, own, { name: isHome ? event.awayName : event.homeName, ...rival }, players),
    };
  };

  return {
    match: base,
    teams: {
      [homeId]: build("home"),
      [awayId]: build("away"),
    },
  };
}

function aggregatePlayers(reports) {
  const map = new Map();
  for (const report of reports) {
    for (const player of report.players || []) {
      const key = player.id || player.name;
      if (!map.has(key)) {
        map.set(key, {
          id: player.id,
          name: player.name,
          shortName: player.shortName,
          pos: player.pos,
          jersey: player.jersey,
          matches: 0,
          starts: 0,
          goals: 0,
          assists: 0,
          shots: 0,
          onTarget: 0,
          yellow: 0,
          red: 0,
          ownGoals: 0,
          impact: 0,
        });
      }
      const row = map.get(key);
      row.matches += 1;
      if (player.starter) row.starts += 1;
      row.goals += player.goals;
      row.assists += player.assists;
      row.shots += player.shots;
      row.onTarget += player.onTarget;
      row.yellow += player.yellow;
      row.red += player.red;
      row.ownGoals += player.ownGoals;
      row.impact = Math.round((row.impact + player.impact) * 10) / 10;
    }
  }
  return [...map.values()]
    .sort((a, b) => b.impact - a.impact || b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name));
}

function aggregateStory(reports) {
  if (!reports.length) return "";
  const wins = reports.filter((report) => report.result === "W").length;
  const draws = reports.filter((report) => report.result === "D").length;
  const losses = reports.filter((report) => report.result === "L").length;
  const goalsFor = reports.reduce((sum, report) => sum + report.goalsFor, 0);
  const goalsAgainst = reports.reduce((sum, report) => sum + report.goalsAgainst, 0);
  const players = aggregatePlayers(reports);
  const scorer = players.find((player) => player.goals > 0);
  const creator = players.find((player) => player.assists > 0);
  const pieces = [
    `Últimos ${reports.length} partidos: ${wins}V ${draws}E ${losses}D, ${goalsFor}-${goalsAgainst} en goles.`,
  ];
  if (scorer) pieces.push(`${scorer.name} suma ${scorer.goals} gol${scorer.goals === 1 ? "" : "es"}.`);
  if (creator && creator.id !== scorer?.id) pieces.push(`${creator.name} acumula ${creator.assists} asistencia${creator.assists === 1 ? "" : "s"}.`);
  const latest = reports[0];
  if (latest?.story) pieces.push(latest.story);
  return pieces.join(" ");
}

/**
 * Agrega los informes de un equipo en una ficha compacta.
 * @param {Array} reports informes de summarizeMatch().teams[teamId]
 * @param {object} options { teamName, before }
 */
export function aggregateTeamForm(reports, options = {}) {
  const ordered = [...(reports || [])]
    .filter(Boolean)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, PLAYER_REPORT_MATCHES);
  const players = aggregatePlayers(ordered);
  const totals = ordered.reduce((acc, report) => {
    acc.goals += report.goalsFor || 0;
    acc.conceded += report.goalsAgainst || 0;
    acc.shots += report.stats?.shots || 0;
    acc.onTarget += report.stats?.shotsOnTarget || 0;
    acc.corners += report.stats?.corners || 0;
    acc.cards += (report.stats?.yellow || 0) + (report.stats?.red || 0);
    return acc;
  }, { goals: 0, conceded: 0, shots: 0, onTarget: 0, corners: 0, cards: 0 });
  return {
    version: PLAYERS_VERSION,
    source: "ESPN summary (boxscore, rosters, keyEvents)",
    teamName: options.teamName || ordered[0]?.teamName || "",
    sample: ordered.length,
    updated: new Date().toISOString(),
    summary: {
      wins: ordered.filter((report) => report.result === "W").length,
      draws: ordered.filter((report) => report.result === "D").length,
      losses: ordered.filter((report) => report.result === "L").length,
      ...totals,
      story: aggregateStory(ordered),
    },
    players,
    matches: ordered.map((report, index) => ({
      id: report.id,
      date: report.date,
      leagueName: report.leagueName,
      rivalName: report.rivalName,
      rivalShort: report.rivalShort,
      rivalLogo: report.rivalLogo,
      venue: report.venue,
      result: report.result,
      score: report.score,
      goalsFor: report.goalsFor,
      goalsAgainst: report.goalsAgainst,
      stats: report.stats,
      rivalStats: report.rivalStats,
      // La cronología se guarda solo del partido más reciente para no
      // duplicar el mismo detalle en ambos equipos y en ambos partidos.
      timeline: index === 0 ? report.timeline : [],
      story: report.story,
    })),
  };
}

export function emptyPlayerForm(teamName = "") {
  return {
    version: PLAYERS_VERSION,
    source: "ESPN summary (boxscore, rosters, keyEvents)",
    teamName,
    sample: 0,
    updated: new Date().toISOString(),
    summary: {
      wins: 0,
      draws: 0,
      losses: 0,
      goals: 0,
      conceded: 0,
      shots: 0,
      onTarget: 0,
      corners: 0,
      cards: 0,
      story: "Sin resumen reciente disponible.",
    },
    players: [],
    matches: [],
  };
}
