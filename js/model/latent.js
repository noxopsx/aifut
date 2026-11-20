// Equipos latentes y sorpresas de la tabla.
// =========================================
//
// Analiza el tercio medio de cada liga y los partidos en los que un equipo de
// la parte baja venció a uno de los primeros puestos. Las posiciones históricas
// se reconstruyen con los resultados anteriores al partido: nunca se usa la
// tabla final para explicar un partido pasado.
//
// El objetivo es descriptivo: mide rachas y resultados siguientes. No es una
// recomendación ni una garantía de que el patrón se repita.

import { matchDateMs } from "./ratings.js";

export const LATENT_VERSION = "1.0";
export const MIDDLE_THIRD = 1 / 3;
export const MIN_MATCHES_FOR_RANK = 3;
export const MIN_STREAK_SAMPLE = 8;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

const STATE_ORDER = ["W3+", "W2", "W1", "D3+", "D2", "D1", "L3+", "L2", "L1"];

const STATE_LABELS = {
  "W3+": "3+ victorias seguidas",
  W2: "2 victorias seguidas",
  W1: "1 victoria",
  "D3+": "3+ empates seguidos",
  D2: "2 empates seguidos",
  D1: "1 empate",
  "L3+": "3+ derrotas seguidas",
  L2: "2 derrotas seguidas",
  L1: "1 derrota",
};

function outcomeForTeam(match, teamId) {
  if (!match?.completed) return null;
  const isHome = match.homeId === String(teamId);
  const isAway = match.awayId === String(teamId);
  if (!isHome && !isAway) return null;
  const goalsFor = isHome ? match.homeGoals : match.awayGoals;
  const goalsAgainst = isHome ? match.awayGoals : match.homeGoals;
  if (goalsFor > goalsAgainst) return "W";
  if (goalsFor < goalsAgainst) return "L";
  return "D";
}

function streakOf(form) {
  const sequence = (form || []).filter(Boolean);
  if (!sequence.length) return { type: null, length: 0, label: "Sin muestra", key: null };
  const type = sequence[0];
  let length = 0;
  for (const result of sequence) {
    if (result !== type) break;
    length += 1;
  }
  const key = length >= 3 && type !== "D" ? `${type}3+` : `${type}${length >= 2 ? 2 : 1}`;
  return { type, length, label: STATE_LABELS[key] || STATE_LABELS[`${type}1`], key };
}

function formString(form, limit = 5) {
  return (form || []).slice(0, limit).join("");
}

function pointsFor(results) {
  return results.reduce((sum, result) => sum + (result === "W" ? 3 : result === "D" ? 1 : 0), 0);
}

function middleRange(size) {
  const start = Math.floor(size * MIDDLE_THIRD) + 1;
  return {
    start,
    end: Math.max(start, Math.floor(size * (2 * MIDDLE_THIRD))),
  };
}

function topCut(size) {
  return Math.max(1, Math.floor(size * MIDDLE_THIRD));
}

function bottomStart(size) {
  return Math.max(1, Math.floor(size * (2 * MIDDLE_THIRD)) + 1);
}

function isMiddle(pos, size) {
  if (!pos) return false;
  const range = middleRange(size);
  return pos >= range.start && pos <= range.end;
}

function isTop(pos, size) {
  return Boolean(pos) && pos <= topCut(size);
}

function isBottom(pos, size) {
  return Boolean(pos) && pos >= bottomStart(size);
}

function emptyState() {
  return {
    n: 0,
    win: 0,
    draw: 0,
    loss: 0,
    home: { n: 0, win: 0, draw: 0, loss: 0 },
    away: { n: 0, win: 0, draw: 0, loss: 0 },
  };
}

function addState(state, result, venue) {
  state.n += 1;
  const bucket = venue === "home" ? state.home : state.away;
  bucket.n += 1;
  if (result === "W") {
    state.win += 1;
    bucket.win += 1;
  } else if (result === "D") {
    state.draw += 1;
    bucket.draw += 1;
  } else {
    state.loss += 1;
    bucket.loss += 1;
  }
}

function rates(entry) {
  const n = entry?.n || 0;
  return {
    n,
    win: entry?.win || 0,
    draw: entry?.draw || 0,
    loss: entry?.loss || 0,
    winRate: n ? (entry.win || 0) / n : 0,
    drawRate: n ? (entry.draw || 0) / n : 0,
    lossRate: n ? (entry.loss || 0) / n : 0,
    home: {
      n: entry?.home?.n || 0,
      winRate: entry?.home?.n ? entry.home.win / entry.home.n : 0,
      drawRate: entry?.home?.n ? entry.home.draw / entry.home.n : 0,
      lossRate: entry?.home?.n ? entry.home.loss / entry.home.n : 0,
    },
    away: {
      n: entry?.away?.n || 0,
      winRate: entry?.away?.n ? entry.away.win / entry.away.n : 0,
      drawRate: entry?.away?.n ? entry.away.draw / entry.away.n : 0,
      lossRate: entry?.away?.n ? entry.away.loss / entry.away.n : 0,
    },
  };
}

function readingFor(state, label, overall) {
  if (!state.n) return "Sin muestra suficiente.";
  const edge = state.winRate - overall.winRate;
  const low = state.n < MIN_STREAK_SAMPLE ? " Muestra corta: tómalo como pista, no como regla." : "";
  if (label.startsWith("3+ victorias") || label.startsWith("2 victorias")) {
    return edge > 0.03
      ? `La racha positiva se sostiene: gana ${pct(state.winRate)} de los siguientes partidos, ${Math.round(edge * 100)} pp por encima de la base latente.${low}`
      : `La racha ya no es una ventaja clara: gana ${pct(state.winRate)}, en línea o por debajo de la base.${low}`;
  }
  if (label.includes("empates")) {
    return state.drawRate > 0.32
      ? `El empate pesa: ${pct(state.drawRate)} de los siguientes partidos terminan en tablas. La victoria pierde fuerza en este contexto.${low}`
      : `Los empates no se reproducen con fuerza: solo ${pct(state.drawRate)} del siguiente partido acaba en tablas.${low}`;
  }
  if (label.includes("derrotas")) {
    return edge > 0.02
      ? `Rebote estadístico: tras la mala racha, gana ${pct(state.winRate)} de los siguientes. Es un riesgo, no una certeza.${low}`
      : `La mala racha sigue pesando: gana solo ${pct(state.winRate)} de los siguientes partidos.${low}`;
  }
  return `Gana ${pct(state.winRate)}, empata ${pct(state.drawRate)} y pierde ${pct(state.lossRate)}.${low}`;
}

function buildTableState() {
  return new Map();
}

function ensureTeam(state, id, name, short) {
  if (!state.has(id)) {
    state.set(id, {
      id: String(id),
      name,
      short,
      pj: 0,
      pts: 0,
      gf: 0,
      ga: 0,
      gd: 0,
      form: [],
      lastDate: null,
    });
  }
  const row = state.get(id);
  if (name) row.name = name;
  if (short) row.short = short;
  return row;
}

function sortedTable(state) {
  return [...state.values()]
    .sort((a, b) => (
      b.pts - a.pts
      || b.gd - a.gd
      || b.gf - a.gf
      || b.pj - a.pj
      || a.name.localeCompare(b.name)
    ));
}

function positionMap(state) {
  const rows = sortedTable(state);
  const positions = new Map();
  rows.forEach((row, index) => positions.set(row.id, index + 1));
  return { rows, positions };
}

function applyResult(state, match) {
  const home = ensureTeam(state, match.homeId, match.homeName, match.homeAbbr);
  const away = ensureTeam(state, match.awayId, match.awayName, match.awayAbbr);
  home.pj += 1;
  away.pj += 1;
  home.gf += match.homeGoals;
  home.ga += match.awayGoals;
  away.gf += match.awayGoals;
  away.ga += match.homeGoals;
  home.gd = home.gf - home.ga;
  away.gd = away.gf - away.ga;
  home.lastDate = match.date;
  away.lastDate = match.date;
  if (match.homeGoals > match.awayGoals) {
    home.pts += 3;
    home.form.unshift("W");
    away.form.unshift("L");
  } else if (match.homeGoals < match.awayGoals) {
    away.pts += 3;
    home.form.unshift("L");
    away.form.unshift("W");
  } else {
    home.pts += 1;
    away.pts += 1;
    home.form.unshift("D");
    away.form.unshift("D");
  }
  home.form = home.form.slice(0, 10);
  away.form = away.form.slice(0, 10);
}

function restDays(lastDate, date) {
  if (!lastDate) return null;
  const diff = (matchDateMs(date) - matchDateMs(lastDate)) / 86_400_000;
  return Number.isFinite(diff) ? Math.max(0, Math.round(diff)) : null;
}

function supportLabel(score, sample) {
  if (sample < MIN_STREAK_SAMPLE) {
    return { label: "Muestra corta", tone: "neutral", note: "Hay pocos casos históricos con esta racha." };
  }
  if (score >= 65) return { label: "Apoyo", tone: "pos", note: "La racha y el contexto acompañan." };
  if (score >= 52) return { label: "Leve apoyo", tone: "pos", note: "Señal positiva, pero no dominante." };
  if (score >= 40) return { label: "Neutral", tone: "neutral", note: "Sin ventaja clara: contexto parejo." };
  if (score >= 30) return { label: "Cautela", tone: "neg", note: "La racha o el rival juegan en contra." };
  return { label: "Evitar", tone: "neg", note: "El contexto histórico no acompaña." };
}

function buildStreakStats(leagueEvents, tables) {
  const state = new Map();
  const upsets = [];
  const byLeague = new Map();

  for (const [leagueId, events] of leagueEvents) {
    const table = tables[leagueId];
    if (!table?.standings?.length) continue;
    const size = table.standings.length;
    const seasons = new Map();
    const sorted = [...events].sort((a, b) => matchDateMs(a.date) - matchDateMs(b.date));
    const leagueUpsets = [];

    for (const match of sorted) {
      if (!match.completed) continue;
      const seasonKey = match.season || "unknown";
      if (!seasons.has(seasonKey)) seasons.set(seasonKey, buildTableState());
      const seasonTable = seasons.get(seasonKey);
      ensureTeam(seasonTable, match.homeId, match.homeName, match.homeAbbr);
      ensureTeam(seasonTable, match.awayId, match.awayName, match.awayAbbr);
      const { positions } = positionMap(seasonTable);
      const homeRow = seasonTable.get(String(match.homeId));
      const awayRow = seasonTable.get(String(match.awayId));
      const homePos = positions.get(String(match.homeId));
      const awayPos = positions.get(String(match.awayId));

      // Resultado siguiente de un equipo del tercio medio, condicionado a su racha.
      for (const [row, pos, venue, goalsFor, goalsAgainst] of [
        [homeRow, homePos, "home", match.homeGoals, match.awayGoals],
        [awayRow, awayPos, "away", match.awayGoals, match.homeGoals],
      ]) {
        if (!row || row.pj < MIN_MATCHES_FOR_RANK || !isMiddle(pos, size)) continue;
        const streak = streakOf(row.form);
        if (!streak.key) continue;
        const result = goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "D";
        if (!state.has(streak.key)) state.set(streak.key, emptyState());
        addState(state.get(streak.key), result, venue);
      }

      // Sorpresa: equipo del tercio inferior vence a uno del tercio superior.
      if (homeRow?.pj >= MIN_MATCHES_FOR_RANK && awayRow?.pj >= MIN_MATCHES_FOR_RANK) {
        const homeWon = match.homeGoals > match.awayGoals;
        const awayWon = match.awayGoals > match.homeGoals;
        const winner = homeWon
          ? { row: homeRow, pos: homePos, venue: "home", form: homeRow.form }
          : awayWon
            ? { row: awayRow, pos: awayPos, venue: "away", form: awayRow.form }
            : null;
        const loser = homeWon
          ? { row: awayRow, pos: awayPos, venue: "away", form: awayRow.form }
          : awayWon
            ? { row: homeRow, pos: homePos, venue: "home", form: homeRow.form }
            : null;
        if (winner && loser && isBottom(winner.pos, size) && isTop(loser.pos, size)) {
          const winnerStreak = streakOf(winner.form);
          const loserStreak = streakOf(loser.form);
          const record = {
            date: match.date,
            leagueId,
            leagueName: table.name,
            winner: winner.row.name,
            winnerShort: winner.row.short,
            winnerPos: winner.pos,
            winnerVenue: winner.venue,
            winnerForm: formString(winner.form),
            winnerStreak: winnerStreak.label,
            loser: loser.row.name,
            loserShort: loser.row.short,
            loserPos: loser.pos,
            loserForm: formString(loser.form),
            loserStreak: loserStreak.label,
            homeGoals: match.homeGoals,
            awayGoals: match.awayGoals,
            score: `${match.homeGoals}-${match.awayGoals}`,
            gap: winner.pos - loser.pos,
            restWinner: restDays(winner.row.lastDate, match.date),
            restLoser: restDays(loser.row.lastDate, match.date),
            size,
          };
          upsets.push(record);
          leagueUpsets.push(record);
        }
      }

      applyResult(seasonTable, match);
    }

    if (leagueUpsets.length) byLeague.set(leagueId, leagueUpsets);
  }

  return { state, upsets, byLeague };
}

function buildUpsetSummary(upsets) {
  const count = upsets.length;
  if (!count) {
    return {
      count: 0,
      homeShare: 0,
      avgGap: 0,
      avgWinnerPos: 0,
      avgLoserPos: 0,
      oneGoalShare: 0,
      cleanSheetShare: 0,
      winnerStreakShare: 0,
      examples: [],
      patterns: [],
    };
  }
  const home = upsets.filter((row) => row.winnerVenue === "home").length;
  const oneGoal = upsets.filter((row) => Math.abs(row.homeGoals - row.awayGoals) === 1).length;
  const cleanSheet = upsets.filter((row) => (row.winnerVenue === "home" ? row.awayGoals === 0 : row.homeGoals === 0)).length;
  const winnerStreak = upsets.filter((row) => row.winnerStreak?.includes("victorias")).length;
  const avg = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const examples = [...upsets]
    .sort((a, b) => matchDateMs(b.date) - matchDateMs(a.date))
    .slice(0, 12);
  const patterns = [
    `${Math.round((home / count) * 100)}% de las sorpresas las firmó el equipo local.`,
    `${Math.round((oneGoal / count) * 100)}% se decidieron por un solo gol; la sorpresa suele ser ajustada.`,
    `${Math.round((cleanSheet / count) * 100)}% acabaron con la portería del favorito a cero.`,
    `${Math.round((winnerStreak / count) * 100)}% de los ganadores llegaban con una racha de victorias.`,
  ];
  return {
    count,
    homeShare: home / count,
    avgGap: avg(upsets.map((row) => row.gap)),
    avgWinnerPos: avg(upsets.map((row) => row.winnerPos)),
    avgLoserPos: avg(upsets.map((row) => row.loserPos)),
    oneGoalShare: oneGoal / count,
    cleanSheetShare: cleanSheet / count,
    winnerStreakShare: winnerStreak / count,
    examples,
    patterns,
  };
}

// leagues: [{ id, name, short }]
// tables: { [leagueId]: { name, standings: [...] } }
// events: partidos normalizados y completados de todas las ligas
// matches: próximos partidos generados por datos_live
// teams: mapa de equipos generado por datos_live
export function buildLatentData({ leagues = [], tables = {}, events = [], matches = [], teams = {} } = {}) {
  const completed = (events || []).filter((event) => event?.completed);
  const leagueEvents = new Map();
  for (const event of completed) {
    const list = leagueEvents.get(event.leagueId) || [];
    list.push(event);
    leagueEvents.set(event.leagueId, list);
  }
  for (const list of leagueEvents.values()) {
    list.sort((a, b) => matchDateMs(a.date) - matchDateMs(b.date));
  }

  const { state, upsets } = buildStreakStats(leagueEvents, tables);
  const streakStats = STATE_ORDER.map((key) => {
    const entry = rates(state.get(key) || emptyState());
    return {
      key,
      label: STATE_LABELS[key],
      ...entry,
      reading: "",
    };
  });
  const overall = rates(STATE_ORDER.reduce((acc, key) => {
    const entry = state.get(key);
    if (!entry) return acc;
    acc.n += entry.n;
    acc.win += entry.win;
    acc.draw += entry.draw;
    acc.loss += entry.loss;
    acc.home.n += entry.home.n;
    acc.home.win += entry.home.win;
    acc.home.draw += entry.home.draw;
    acc.home.loss += entry.home.loss;
    acc.away.n += entry.away.n;
    acc.away.win += entry.away.win;
    acc.away.draw += entry.away.draw;
    acc.away.loss += entry.away.loss;
    return acc;
  }, emptyState()));
  for (const row of streakStats) row.reading = readingFor(row, row.label, overall);
  const statsByKey = new Map(streakStats.map((row) => [row.key, row]));

  const midTable = [];
  for (const league of leagues) {
    const table = tables[league.id];
    if (!table?.standings?.length) continue;
    const size = table.standings.length;
    const range = middleRange(size);
    const leagueAvgPpg = table.standings.reduce((sum, row) => sum + (row.pj ? row.pts / row.pj : 0), 0)
      / Math.max(1, table.standings.filter((row) => row.pj > 0).length);
    const byPos = new Map(table.standings.map((row) => [String(row.id), row]));

    for (const row of table.standings) {
      if (row.pos < range.start || row.pos > range.end) continue;
      const teamId = String(row.id);
      const history = (leagueEvents.get(league.id) || [])
        .filter((event) => event.homeId === teamId || event.awayId === teamId)
        .sort((a, b) => matchDateMs(b.date) - matchDateMs(a.date));
      const last10 = history.slice(0, 10).map((event) => outcomeForTeam(event, teamId)).filter(Boolean);
      const streak = streakOf(last10);
      const stats = statsByKey.get(streak.key) || rates(emptyState());
      const nextMatch = (matches || []).find((match) => (
        match.leagueContext?.id === league.id
        && (String(teams[match.home]?.espnId) === teamId || String(teams[match.away]?.espnId) === teamId)
      ));
      let next = null;
      if (nextMatch) {
        const isHome = String(teams[nextMatch.home]?.espnId) === teamId;
        const opponent = isHome ? teams[nextMatch.away] : teams[nextMatch.home];
        const opponentPos = opponent ? byPos.get(String(opponent.espnId))?.pos || null : null;
        next = {
          matchId: nextMatch.id,
          date: nextMatch.date,
          venue: isHome ? "home" : "away",
          opponent: opponent?.name || "Rival",
          opponentShort: opponent?.short || "Rival",
          opponentPos,
          opponentLogo: opponent?.logo || "",
        };
      }
      const venue = next?.venue || null;
      const venueStats = venue === "home" ? stats.home : venue === "away" ? stats.away : null;
      const pWin = venueStats?.n >= MIN_STREAK_SAMPLE ? venueStats.winRate : stats.winRate;
      const opponentPos = next?.opponentPos;
      const oppAdj = opponentPos
        ? isTop(opponentPos, size) ? -0.05 : isBottom(opponentPos, size) ? 0.05 : 0
        : 0;
      const formAdj = clamp((row.pj ? row.pts / row.pj : 0) - leagueAvgPpg, -0.6, 0.6) * 0.05;
      const supportScore = Math.round(clamp(
        50 + (pWin - overall.winRate) * 150 + (venue === "home" ? 5 : venue === "away" ? -5 : 0) + oppAdj * 100 + formAdj * 100,
        0,
        100,
      ));
      const signal = supportLabel(supportScore, stats.n);
      midTable.push({
        leagueId: league.id,
        leagueName: league.name,
        teamId,
        team: row.team,
        short: row.short,
        logo: row.logo,
        pos: row.pos,
        range,
        pj: row.pj,
        pts: row.pts,
        ppg: row.pj ? row.pts / row.pj : 0,
        gf: row.gf,
        gc: row.gc,
        dg: row.dg,
        last10: {
          n: last10.length,
          w: last10.filter((result) => result === "W").length,
          d: last10.filter((result) => result === "D").length,
          l: last10.filter((result) => result === "L").length,
          points: pointsFor(last10),
          sequence: last10,
          ppg: last10.length ? pointsFor(last10) / last10.length : 0,
        },
        streak,
        next,
        support: {
          score: supportScore,
          label: signal.label,
          tone: signal.tone,
          note: signal.note,
          sample: stats.n,
          winRate: pWin,
          baseline: overall.winRate,
          venue: venue || "none",
        },
        sample: stats.n,
      });
    }
  }

  midTable.sort((a, b) => (
    a.leagueName.localeCompare(b.leagueName)
    || a.pos - b.pos
  ));

  const upsetSummary = buildUpsetSummary(upsets);
  const activeLeagues = new Set(midTable.map((row) => row.leagueId));

  return {
    version: LATENT_VERSION,
    generatedAt: new Date().toISOString(),
    method: "posiciones reconstruidas antes de cada partido; rachas de los últimos 10",
    middleThird: { from: MIDDLE_THIRD, to: 2 * MIDDLE_THIRD },
    summary: {
      leagues: activeLeagues.size,
      midTableTeams: midTable.length,
      upsets: upsetSummary.count,
      streakSamples: overall.n,
      overallWinRate: overall.winRate,
    },
    midTable,
    streakStats,
    upsets: upsetSummary,
    notes: [
      "Equipo latente = posición dentro del tercio medio de su liga en la tabla actual. No incluye a los que pelean el título ni a los que están en descenso.",
      "Las posiciones históricas se reconstruyen con los resultados anteriores al partido; no se usa la tabla final para explicar el pasado.",
      "El índice de apoyo combina la tasa histórica de victoria tras la racha actual, la localía, la posición del rival y el PPG. Es una señal descriptiva, no una probabilidad.",
      "Las sorpresas se definen como victorias de un equipo del tercio inferior sobre uno del tercio superior, con al menos 3 partidos jugados por ambos.",
      "Muestra de dos temporadas por liga. Las ligas con pocos partidos o plantillas rotadas pueden cambiar el patrón; revisa siempre la muestra.",
    ],
  };
}

export function streakLabel(form) {
  return streakOf(form).label;
}

export function middlePositions(size) {
  return middleRange(size);
}
