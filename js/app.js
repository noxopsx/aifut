import { LEAGUE, TYPE_LABELS } from "./data/league.js";
import { TEAMS as LIVE_TEAMS } from "./data/teams_base.js";
import { MATCHES as LIVE_MATCHES } from "./data/matches.js";
import { TABLES as LIVE_TABLES } from "./data/tables.js";
import { REFERENCE_MATCH, REFERENCE_TEAMS, REFERENCE_TABLES } from "./data/reference.js";
import { VALIDATION } from "./data/validation.js";
import { MODEL_REPORT } from "./data/model_report.js";
import { LATENT } from "./data/latent.js";
import { RECORD } from "./data/record.js";
import { SOURCE_STATUS } from "./data/fuentes.js";
import { analyzeMatchCore } from "./model/core.js";
import { evaluateCombo } from "./model/combo.js";
import { modeledProjection, projectionFromAnalysis } from "./model/projection.js";
// Las explicaciones y el detalle de jugadores se importan bajo demanda, junto
// con el análisis completo, para no cargarlos en la primera pantalla.

// La ventana live se renueva cada semana. El partido de referencia conserva
// enlaces antiguos (por ejemplo #/partido/espn-761922) sin mezclarse con la
// cartelera próxima.
const MATCHES = [
  ...LIVE_MATCHES,
  ...(REFERENCE_MATCH && !LIVE_MATCHES.some((match) => match.id === REFERENCE_MATCH.id)
    ? [{ ...REFERENCE_MATCH, reference: true }]
    : []),
];
const TEAMS = { ...REFERENCE_TEAMS, ...LIVE_TEAMS };
const TABLES = { ...REFERENCE_TABLES, ...LIVE_TABLES };

const FILTERS = [
  { id: "all", label: "Todos" },
  { id: "high_conf", label: "Alta certeza (≥80%)" },
  { id: "today", label: "Hoy" },
  { id: "tomorrow", label: "Mañana" },
  { id: "week", label: "7 días" },
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
}[char]));

const PRODUCT_NAME = "AIFUT";
const ENGINE_NAME = "OX";
const ENGINE_LABEL = "OX V1.0";
const pct = (value, digits = 1) => `${(Number(value) * 100).toFixed(digits)}%`;
const num = (value, digits = 2) => Number(value).toFixed(digits);
const pad = (value) => String(value).padStart(2, "0");
const plural = (value, singular, pluralForm) =>
  `${value} ${Number(value) === 1 ? singular : pluralForm}`;
const matchesLabel = (value) => plural(value, "partido", "partidos");

const MODEL_MARKET_LABELS = {
  "1x2": "1X2",
  btts: "Ambos anotan",
  over15: "Más de 1.5",
  over25: "Más de 2.5",
  over35: "Más de 3.5",
};
const MODEL_MARKET_ORDER = ["1x2", "btts", "over15", "over25", "over35"];
const MODEL_SHORT_LABELS = {
  poisson: "Poisson",
  logit_xg_elo: "Elo + xG",
  logit_core: "Logística",
  logit_xg_shots: "Elo + xG + tiros",
};
const RESULT_LABELS = { home: "Local", draw: "Empate", away: "Visitante" };
const PICK_LABELS = { "1": "Local", X: "Empate", "2": "Visitante" };
const MODEL_LEAGUE_NAMES = { "eng.1": "Premier League", "esp.1": "LaLiga" };

const PROVENANCE = {
  observed: { label: "Observado", title: "Dato factual de ESPN o de los datos propios." },
  estimated: { label: "Estimado", title: "Valor inferido por el modelo a partir de datos observados." },
  placeholder: { label: "Placeholder", title: "Valor neutro fijo porque no hay dato suficiente." },
};

function provenanceChip(kind = "estimated", title = "") {
  const item = PROVENANCE[kind] || PROVENANCE.estimated;
  const tooltip = title || item.title;
  return `<span class="prov prov-${kind}" title="${escapeHtml(tooltip)}">${item.label}</span>`;
}

function onTargetSource(team) {
  if (team?.onTargetRateSource) return team.onTargetRateSource;
  return Math.abs(Number(team?.onTargetRate) - 0.34) < 1e-9 ? "placeholder" : "derived";
}

function provenanceLegend() {
  return `
    <div class="prov-legend" aria-label="Leyenda de procedencia de datos">
      ${provenanceChip("observed")} <span>dato factual de ESPN o datos propios</span>
      ${provenanceChip("estimated")} <span>inferido por el modelo</span>
      ${provenanceChip("placeholder")} <span>valor neutro fijo por falta de dato</span>
    </div>
  `;
}

const matchById = new Map(MATCHES.map((match) => [match.id, match]));

// Los enlaces guardados pueden traer un prefijo anterior en el hash. La URL
// pública siempre usa `partido-` y se empareja por el número final del ID,
// sin depender del nombre del prefijo.
const toPublicId = (id) => {
  const value = String(id ?? "");
  const numeric = value.match(/\d+$/)?.[0];
  return numeric ? `partido-${numeric}` : value.replace(/^[^-]+-/, "partido-");
};

function matchForHashId(id) {
  if (!id) return null;
  if (matchById.has(id)) return matchById.get(id);
  const numeric = String(id).match(/\d+$/)?.[0];
  if (!numeric) return null;
  for (const [key, match] of matchById) {
    if (key.endsWith(numeric)) return match;
  }
  return null;
}

// Los datos generados pueden traer escudos remotos; el sitio siempre sirve los
// archivos locales para no depender de peticiones externas.
function localCrest(url) {
  const value = String(url ?? "");
  const remote = value.match(/teamlogos\/soccer\/\d+\/([^"?#]+)/i);
  if (remote) return `./css/crests/${String(remote[1]).replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  if (/^https?:\/\//i.test(value)) return "./css/escudo.svg";
  return value;
}

const analyses = new Map();
const fullAnalyses = new Map();
const modelReady = Boolean(MODEL_REPORT?.headline?.n);
const validationReady = Boolean(LEAGUE.live && VALIDATION?.overall?.n);
const hitsReady = Boolean(modelReady || (validationReady && VALIDATION?.hits?.n));
const precisionReady = Boolean(modelReady || validationReady);
const latentReady = Boolean(LEAGUE.live && LATENT?.midTable?.length);
const recordReady = Boolean(RECORD?.generatedAt);

let fullAssetsPromise = null;
let explainApi = null;
let analyzeFull = null;

/** Análisis ligero (sin explicaciones), calculado solo cuando se necesita. */
function getAnalysis(id) {
  if (analyses.has(id)) return analyses.get(id);
  const match = matchById.get(id);
  if (!match) return null;
  const analysis = analyzeMatchCore(match, TEAMS, LEAGUE);
  analyses.set(id, analysis);
  return analysis;
}

/** Carga el detalle de jugadores y el módulo de explicaciones bajo demanda. */
function ensureFullAssets() {
  if (!fullAssetsPromise) {
    fullAssetsPromise = Promise.all([
      import("./data/player_form.js"),
      import("./model/index.js"),
      import("./model/explain.js"),
    ]).then(([detail, model, explain]) => {
      explainApi = explain;
      analyzeFull = model.analyzeMatch;
      for (const [id, playerForm] of Object.entries(detail.PLAYER_FORMS || {})) {
        if (TEAMS[id]) TEAMS[id].playerForm = playerForm;
      }
      return true;
    }).catch((error) => {
      fullAssetsPromise = null;
      console.error("No se pudo cargar el análisis detallado:", error);
      return false;
    });
  }
  return fullAssetsPromise;
}

/** Análisis completo: mismo motor y mismas explicaciones que antes. */
function getFullAnalysis(id) {
  if (!analyzeFull) return null;
  if (fullAnalyses.has(id)) return fullAnalyses.get(id);
  const match = matchById.get(id);
  if (!match) return null;
  const analysis = analyzeFull(match, TEAMS, LEAGUE);
  if (modelReady) {
    analysis.explanations.validation = explainApi.buildValidationExplanation(analysis, MODEL_REPORT);
    analysis.explanations.hits = explainApi.buildHitsExplanation(analysis, MODEL_REPORT);
  }
  if (validationReady) {
    if (!modelReady) analysis.explanations.validation = explainApi.buildValidationExplanation(analysis, VALIDATION);
    analysis.explanations.poissonValidation = explainApi.buildValidationExplanation(analysis, VALIDATION);
  }
  if (latentReady) {
    analysis.explanations.latent = explainApi.buildLatentExplanation(analysis, LATENT);
  }
  fullAnalyses.set(id, analysis);
  return analysis;
}
const state = {
  selectedId: null,
  filter: "all",
  league: "all",
  confidence: 0,
  query: "",
  analysis: null,
  analysisOpen: false,
  tooltipKey: null,
  lastFocus: null,
  suppressFocusTooltip: false,
  drawerTimer: null,
  combo: [],
  matchListReady: false,
  tabs: {
    analysis: "markets",
    context: "read",
  },
  validationOpen: false,
  lastValidationFocus: null,
  validationTimer: null,
  latentOpen: false,
  lastLatentFocus: null,
  latentTimer: null,
  latentLeague: "all",
  latentLeagueChosen: false,
  recordOpen: false,
  lastRecordFocus: null,
  recordTimer: null,
};

const view = $("#match-view");
const filtersEl = $("#filters");
const matchListEl = $("#match-list");
const searchEl = $("#search");
const matchCountEl = $("#match-count");
const tooltip = $("#tooltip");
const drawer = $("#drawer");
const drawerBackdrop = $("#drawer-backdrop");
const drawerContent = $("#drawer-content");
const drawerEyebrow = $("#drawer-eyebrow");
const toastEl = $("#toast");
const sidebarBackdrop = $("#sidebar-backdrop");
const sidebarEl = $("#sidebar");
const menuBtn = $("#menu-btn");
const validationModal = $("#validation-modal");
const validationBackdrop = $("#validation-backdrop");
const validationContent = $("#validation-content");
const latentModal = $("#latent-modal");
const latentBackdrop = $("#latent-backdrop");
const latentContent = $("#latent-content");
const recordModal = $("#record-modal");
const recordBackdrop = $("#record-backdrop");
const recordContent = $("#record-content");

function formatDate(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { day: "Sin fecha", time: "--:--", zone: "" };
  const day = new Intl.DateTimeFormat("es-MX", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(date).replace(/\./g, "");
  const time = new Intl.DateTimeFormat("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
  const zone = new Intl.DateTimeFormat("es-MX", { timeZoneName: "short", timeZone })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || "";
  return { day, time, zone };
}

function formatTimestamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function freshnessAge(iso) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const hours = Math.max(0, (Date.now() - ms) / 3_600_000);
  if (hours < 1) return "hace menos de 1 h";
  if (hours < 48) return `hace ${Math.round(hours)} h`;
  return `hace ${Math.round(hours / 24)} días`;
}

function dateKey(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function todayKey(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return dateKey(date.toISOString());
}

function dayHeading(iso) {
  const key = dateKey(iso);
  if (key === todayKey(0)) return "Hoy";
  if (key === todayKey(1)) return "Mañana";
  return new Intl.DateTimeFormat("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(new Date(iso)).replace(/\./g, "");
}

function categoryOf(match) {
  if (match.type === "league") return "league";
  if (match.type === "final") return "final";
  if (match.type === "friendly") return "friendly";
  return "liguilla";
}

function stageLabel(match) {
  const stage = String(match.stage || "").trim();
  return stage && stage !== match.competition ? stage : "";
}

function favoriteProbability(match) {
  const analysis = getAnalysis(match.id);
  if (!analysis) return 0;
  return Math.max(analysis.probs.home, analysis.probs.draw, analysis.probs.away);
}

function filteredMatches({ ignoreConfidence = false } = {}) {
  const query = state.query.trim().toLowerCase();
  const today = todayKey(0);
  const tomorrow = todayKey(1);
  const weekEnd = todayKey(7);
  return MATCHES
    .filter((match) => {
      if (match.reference) return false;
      if (state.league !== "all" && match.competition !== state.league) return false;
      const key = dateKey(match.date);
      if (state.filter === "today" && key !== today) return false;
      if (state.filter === "tomorrow" && key !== tomorrow) return false;
      if (state.filter === "week" && (key < today || key > weekEnd)) return false;
      if (!ignoreConfidence && state.filter === "high_conf" && favoriteProbability(match) < 0.8) return false;
      if (!ignoreConfidence && state.confidence > 0 && favoriteProbability(match) < state.confidence) return false;
      if (!query) return true;
      const home = TEAMS[match.home];
      const away = TEAMS[match.away];
      return [home.name, home.short, home.abbr, away.name, away.short, away.abbr, match.venue, match.stage, match.competition]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function crest(team, size = "sm") {
  const logo = team.logo
    ? `<img src="${escapeHtml(localCrest(team.logo))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
    : "";
  return `<span class="crest crest-${size}${logo ? " has-logo" : ""}" style="--c1:${escapeHtml(team.color || "#2457d6")};--c2:${escapeHtml(team.color2 || "#ffffff")}" aria-hidden="true">${logo}<span class="crest-abbr">${escapeHtml(team.abbr)}</span></span>`;
}

function formDots(form) {
  const labels = { W: "G", D: "E", L: "P" };
  return `<span class="form-dots" title="Últimos 5 partidos">${form
    .map((result) => `<i class="form-${result.toLowerCase()}">${labels[result]}</i>`)
    .join("")}</span>`;
}

function absencesSummary(analysis) {
  const names = [
    ...(analysis.match.lineups?.home?.absences || []).map((a) => `${analysis.home.abbr} ${a.name}`),
    ...(analysis.match.lineups?.away?.absences || []).map((a) => `${analysis.away.abbr} ${a.name}`),
  ];
  if (!names.length) return "Sin bajas relevantes";
  return names.slice(0, 3).join(" · ") + (names.length > 3 ? ` · +${names.length - 3}` : "");
}

function renderFilters() {
  filtersEl.innerHTML = FILTERS.map((filter) => `
    <button type="button" class="chip ${state.filter === filter.id ? "is-active" : ""}" data-filter="${filter.id}" aria-pressed="${state.filter === filter.id}">
      ${escapeHtml(filter.label)}
    </button>
  `).join("");
}

function renderLeagueFilter() {
  const wrap = $("#league-filter");
  const select = $("#league-select");
  if (!wrap || !select) return;
  if (!LEAGUE.live) {
    wrap.hidden = true;
    return;
  }
  const competitions = [...new Set(MATCHES.filter((match) => !match.reference).map((match) => match.competition).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "es"));
  if (!competitions.includes(state.league)) state.league = "all";
  const isCup = (name) => /UEFA|Champions|Europa|Conference|Copa|Cup|Supercopa/i.test(name);
  const domestic = competitions.filter((name) => !isCup(name));
  const cups = competitions.filter(isCup);
  const options = (list) => list.map((competition) => `<option value="${escapeHtml(competition)}">${escapeHtml(competition)}</option>`).join("");
  select.innerHTML = `<option value="all">Todas las competiciones (${competitions.length})</option>`
    + (domestic.length ? `<optgroup label="Ligas nacionales">${options(domestic)}</optgroup>` : "")
    + (cups.length ? `<optgroup label="Copas internacionales">${options(cups)}</optgroup>` : "");
  select.value = state.league;
  wrap.hidden = false;
}

function updateConfidenceHint(baseMatches) {
  const hint = $("#confidence-hint");
  if (!hint) return;
  if (!baseMatches.length) {
    hint.hidden = true;
    return;
  }
  const top = Math.max(...baseMatches.map(favoriteProbability));
  const threshold = state.filter === "high_conf" ? Math.max(state.confidence, 0.8) : state.confidence;
  const eligible = threshold > 0
    ? baseMatches.filter((match) => favoriteProbability(match) >= threshold).length
    : baseMatches.length;
  hint.textContent = threshold > 0
    ? `${eligible} de ${baseMatches.length} partidos ≥ ${pct(threshold, 0)} · máximo ${pct(top, 1)}`
    : `Máximo ${pct(top, 1)} · sin umbral de confianza`;
  hint.hidden = false;
}

function renderMatchList() {
  state.matchListReady = true;
  const baseMatches = filteredMatches({ ignoreConfidence: true });
  const matches = filteredMatches();
  updateConfidenceHint(baseMatches);
  matchCountEl.textContent = pad(matches.length);
  if (!matches.length) {
    const top = baseMatches.length ? Math.max(...baseMatches.map(favoriteProbability)) : null;
    const isConfFiltered = state.filter === "high_conf" || state.confidence > 0;
    const targetConf = state.filter === "high_conf" ? 0.8 : state.confidence;
    const message = state.query.trim()
      ? "No hay partidos que coincidan con la búsqueda."
      : isConfFiltered && baseMatches.length
        ? `Ningún partido alcanza ${pct(targetConf, 0)} de confianza. El máximo de la ventana es ${pct(top, 1)}. Baja el umbral o elige Todos.`
        : state.filter === "today"
          ? "No hay partidos hoy en la ventana cargada. Prueba Mañana o 7 días."
          : state.filter === "tomorrow"
            ? "No hay partidos mañana en la ventana cargada. Prueba Hoy o 7 días."
            : state.filter === "week"
              ? "No hay partidos en los próximos 7 días para esta competición."
              : "No hay partidos con ese filtro.";
    matchListEl.innerHTML = `<div class="empty-list">${message}</div>`;
    return;
  }

  const groups = new Map();
  for (const match of matches) {
    const key = dateKey(match.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  }

  matchListEl.innerHTML = [...groups.values()].map((dayMatches) => {
    const rows = dayMatches.map((match) => {
      const analysis = getAnalysis(match.id);
      const home = TEAMS[match.home];
      const away = TEAMS[match.away];
      const favorite = [
        { label: home.abbr, p: analysis.probs.home },
        { label: "X", p: analysis.probs.draw },
        { label: away.abbr, p: analysis.probs.away },
      ].sort((a, b) => b.p - a.p)[0];
      const date = formatDate(match.date);
      const venueDate = match.timezone ? formatDate(match.date, match.timezone) : null;
      const stage = stageLabel(match);
      const isHighConf = favorite.p >= 0.8;
      const isMidConf = favorite.p >= 0.7 && !isHighConf;
      return `
        <button type="button" class="match-item ${state.selectedId === match.id ? "is-active" : ""}${isHighConf ? " is-high-conf" : ""}" data-match-id="${match.id}" aria-current="${state.selectedId === match.id ? "true" : "false"}" title="${escapeHtml(venueDate ? `${venueDate.time} ${venueDate.zone} · ${match.venue}` : match.venue)}">
          <span class="match-item-time">${escapeHtml(date.time)}<small>${escapeHtml(date.zone)}</small></span>
          <span class="match-item-body">
            <span class="match-item-meta">${escapeHtml(match.competition)}${stage ? ` · ${escapeHtml(stage)}` : ""}</span>
            <span class="match-item-main">
              <span class="match-item-team">${crest(home, "xs")} ${escapeHtml(home.short)}</span>
              <span class="match-item-vs">vs</span>
              <span class="match-item-team">${crest(away, "xs")} ${escapeHtml(away.short)}</span>
            </span>
          </span>
          <span class="match-favorite${favorite.p >= 0.7 ? " is-high" : ""}">
            ${isHighConf ? '<span class="conf-badge high-conf-pill" title="Alta certeza: ~88% de acierto histórico en test">88% hist.</span>' : isMidConf ? '<span class="conf-badge mid-conf-pill" title="Certeza moderada: ~74% de acierto histórico en test">74% hist.</span>' : ""}
            ${escapeHtml(favorite.label)}<strong>${pct(favorite.p, 0)}</strong>
          </span>
        </button>
      `;
    }).join("");
    return `
      <div class="match-day">
        <div class="match-day-head"><span>${escapeHtml(dayHeading(dayMatches[0].date))}</span><span>${pad(dayMatches.length)}</span></div>
        ${rows}
      </div>
    `;
  }).join("");
}

function renderHero(a) {
  const { match, home, away } = a;
  const date = formatDate(match.date);
  const live = Boolean(a.league.live);
  const venue = match.venue ? ` · ${match.venue}` : "";
  const outcome = [
    { label: "Local", value: a.probs.home, color: "lime" },
    { label: "Empate", value: a.probs.draw, color: "draw" },
    { label: "Visitante", value: a.probs.away, color: "coral" },
  ];
  const role = (neutral, local) => (neutral ? "Neutral" : local ? "Local" : "Visitante");
  return `
    <section class="hero hero-simple">
      <div class="hero-meta">
        <span>${escapeHtml(date.day)} · ${escapeHtml(date.time)} ${escapeHtml(date.zone)}${venue ? ` · ${escapeHtml(match.venue)}` : ""}</span>
        ${live ? '<span class="live-pill">En vivo</span>' : ""}
      </div>

      <div class="hero-main">
        <div class="team team-home">
          ${crest(home, "lg")}
          <h1 class="team-name">${escapeHtml(home.name)}</h1>
          <div class="team-meta">${role(match.neutral, true)}</div>
        </div>

        <div class="hero-center" aria-hidden="true"><span class="hero-vs">vs</span></div>

        <div class="team team-away">
          ${crest(away, "lg")}
          <h1 class="team-name">${escapeHtml(away.name)}</h1>
          <div class="team-meta">${role(match.neutral, false)}</div>
        </div>
      </div>

      <div class="hero-outcomes" aria-label="Probabilidades 1X2">
        ${outcome.map((item) => `
          <div class="hero-outcome outcome-${item.color}">
            <span>${item.label}</span>
            <strong>${pct(item.value)}</strong>
          </div>
        `).join("")}
      </div>

      <div class="hero-bar" aria-hidden="true">
        ${outcome.map((item) => `<span class="${item.color}" style="width:${Math.max(1, item.value * 100)}%"></span>`).join("")}
      </div>
    </section>
  `;
}

function metricCard({ key, title, value, sub, home, away, note, provenance = "estimated", provenanceTitle = "" }) {
  const total = home + away;
  const homeWidth = total ? (home / total) * 100 : 50;
  const plainValue = String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const label = [title, plainValue, sub, note, PROVENANCE[provenance]?.label].filter(Boolean).join(". ");
  return `
    <button type="button" class="metric-card" data-explain="${key}" aria-label="${escapeHtml(label)}">
      <span class="metric-top">
        <span>${escapeHtml(title)}</span>
        <span class="metric-top-right">${provenanceChip(provenance, provenanceTitle)}<span class="metric-info" aria-hidden="true">i</span></span>
      </span>
      <span class="metric-value">${value}</span>
      <span class="metric-sub">${escapeHtml(sub)}</span>
      <span class="metric-bars" aria-hidden="true">
        <span class="metric-bar-home" style="width:${homeWidth}%"></span>
        <span class="metric-bar-away" style="width:${100 - homeWidth}%"></span>
      </span>
    </button>
  `;
}

function renderKeyStrip(a) {
  return `
    <div class="key-strip">
      <button type="button" class="key-chip" data-explain="teamScore:home">
        <span>Anota ${escapeHtml(a.home.abbr)}</span>
        <strong>${pct(a.teamScore.home)}</strong>
      </button>
      <button type="button" class="key-chip" data-explain="btts">
        <span>Ambos anotan</span>
        <strong>${pct(a.btts)}</strong>
      </button>
      <button type="button" class="key-chip" data-explain="teamScore:away">
        <span>Anota ${escapeHtml(a.away.abbr)}</span>
        <strong>${pct(a.teamScore.away)}</strong>
      </button>
      <button type="button" class="key-chip" data-explain="firstGoal">
        <span>Primer gol</span>
        <strong>${pct(a.firstGoal.home, 0)} / ${pct(a.firstGoal.away, 0)}</strong>
      </button>
    </div>
  `;
}

function renderMetrics(a) {
  const g = a.metrics.goals;
  const s = a.metrics.shots;
  const c = a.metrics.corners;
  const cards = a.metrics.cards;
  const p = a.metrics.possession;
  const onTargetPlaceholder = s.onTargetRateSource === "placeholder";
  const shotsObserved = s.shotsSource === "observed";
  return `
    <section class="panel">
      <div class="panel-head">
        <div><span class="eyebrow">Salidas del modelo</span><h2>Lo que dice el modelo</h2></div>
        <span class="panel-note">${a.league.live ? "90 minutos · tabla real" : "90 minutos · prepartido"}</span>
      </div>
      ${provenanceLegend()}
      ${renderKeyStrip(a)}
      <div class="metric-grid">
        ${metricCard({
          key: "metric:goals",
          title: "Goles esperados",
          value: `${num(g.home)} <em>–</em> ${num(g.away)}`,
          sub: `Total ${num(g.total)} · Over 2.5 ${pct(g.over25)}`,
          home: g.home,
          away: g.away,
          note: `${num(g.home)} y ${num(g.away)} goles esperados`,
          provenance: "estimated",
          provenanceTitle: "Salida del modelo Poisson + Dixon-Coles; no es un dato observado.",
        })}
        ${metricCard({
          key: "metric:shots",
          title: "Tiros",
          value: `${num(s.home, 1)} <em>–</em> ${num(s.away, 1)}`,
          sub: `Total ${num(s.total, 1)} · A puerta ${num(s.onTargetHome + s.onTargetAway, 1)}`,
          home: s.home,
          away: s.away,
          note: `${num(s.home, 1)} y ${num(s.away, 1)} tiros`,
          provenance: "estimated",
          provenanceTitle: a.league.live
            ? (shotsObserved
              ? s.shotsDetail
              : "Sin muestra real suficiente; los tiros se estiman desde fuerzas y ritmo.")
            : "Proyección a partir de tiros históricos por equipo.",
        })}
        ${metricCard({
          key: "metric:onTarget",
          title: "Tiros a puerta",
          value: `${num(s.onTargetHome, 1)} <em>–</em> ${num(s.onTargetAway, 1)}`,
          sub: `Precisión ${pct(s.onTargetRateHome, 0)} / ${pct(s.onTargetRateAway, 0)}${onTargetPlaceholder ? " · placeholder" : ""}`,
          home: s.onTargetHome,
          away: s.onTargetAway,
          note: `${num(s.onTargetHome, 1)} y ${num(s.onTargetAway, 1)} tiros a puerta`,
          provenance: onTargetPlaceholder ? "placeholder" : "estimated",
          provenanceTitle: s.onTargetRateDetail || "Tasa derivada de tiros observados.",
        })}
        ${metricCard({
          key: "metric:corners",
          title: "Córners",
          value: `${num(c.home, 1)} <em>–</em> ${num(c.away, 1)}`,
          sub: `Total ${num(c.total, 1)} · Over 9.5 ${pct(c.over95)}`,
          home: c.home,
          away: c.away,
          note: `${num(c.home, 1)} y ${num(c.away, 1)} córners`,
          provenance: "estimated",
          provenanceTitle: "Media estimada desde promedios de liga y fuerzas; ESPN no publica córners por equipo.",
        })}
        ${metricCard({
          key: "metric:cards",
          title: "Tarjetas",
          value: `${num(cards.home, 1)} <em>–</em> ${num(cards.away, 1)}`,
          sub: `Total ${num(cards.total, 1)} · Over 4.5 ${pct(cards.over45)}`,
          home: cards.home,
          away: cards.away,
          note: `${num(cards.home, 1)} y ${num(cards.away, 1)} tarjetas`,
          provenance: "estimated",
          provenanceTitle: "Media estimada desde disciplina, rivalidad y tipo de partido; el árbitro no entra en el cálculo.",
        })}
        ${metricCard({
          key: "metric:possession",
          title: "Posesión",
          value: `${num(p.home, 0)}% <em>–</em> ${num(p.away, 0)}%`,
          sub: "Referencia de estilo, no de peligro",
          home: p.home,
          away: p.away,
          note: `${num(p.home, 0)}% y ${num(p.away, 0)}% de posesión`,
          provenance: "estimated",
          provenanceTitle: "Posesión estimada desde las fuerzas; no mide peligro.",
        })}
      </div>
    </section>
  `;
}

function renderEnginePanel(a) {
  const e = a.engine;
  if (!e) return "";
  const raw = e.rawProbs;
  const final = e.probs;
  const rawBinary = e.rawBinary;
  const binary = e.binary;
  const formHome = e.form.home;
  const formAway = e.form.away;
  const shots = e.shots;
  const venue = e.venue;
  const t = a.tiebreak;
  const outcomes = [
    { key: "home", label: "Local", team: a.home.abbr },
    { key: "draw", label: "Empate", team: "X" },
    { key: "away", label: "Visitante", team: a.away.abbr },
  ];
  const binaryRows = [
    { label: "Over 1.5", raw: rawBinary.over15, base: e.bases.over15, final: binary.over15 },
    { label: "Over 2.5", raw: rawBinary.over25, base: e.bases.over25, final: binary.over25 },
    { label: "Over 3.5", raw: rawBinary.over35, base: e.bases.over35, final: binary.over35 },
    { label: "BTTS", raw: rawBinary.btts, base: e.bases.btts, final: binary.btts },
  ];
  const formLabel = (factor) => factor.points === null ? "sin forma" : `${factor.points} pts`;
  return `
    <section class="panel engine-panel">
      <div class="panel-head">
        <div><span class="eyebrow">${escapeHtml(e.label || ENGINE_LABEL)}</span><h2>Crudo vs calibrado</h2></div>
        <button type="button" class="panel-info" data-explain="engine" aria-label="Cómo funciona el ${escapeHtml(e.label || ENGINE_LABEL)}">i</button>
      </div>
      <div class="engine-top">
        <span class="engine-badge">T ${num(e.temperature)}</span>
        <p>La matriz calcula primero. La temperatura suaviza el 1X2 y la curva Platt ajusta goles y BTTS hacia la base de la liga.</p>
      </div>
      <div class="engine-outcomes">
        ${outcomes.map((item) => {
          const rawValue = raw[item.key] * 100;
          const finalValue = final[item.key] * 100;
          const diff = finalValue - rawValue;
          return `
            <div class="engine-outcome">
              <span>${escapeHtml(item.label)} <em>${escapeHtml(item.team)}</em></span>
              <strong>${finalValue.toFixed(1)}%</strong>
              <div class="engine-bars" aria-hidden="true">
                <i class="raw" style="width:${Math.max(1, rawValue)}%"></i>
                <i class="final" style="width:${Math.max(1, finalValue)}%"></i>
              </div>
              <small>crudo ${rawValue.toFixed(1)}% · ${diff >= 0 ? "+" : ""}${diff.toFixed(1)} pp</small>
            </div>
          `;
        }).join("")}
      </div>
      <div class="engine-grid">
        <div class="engine-card">
          <span>Últimos 10</span>
          <strong>${a.home.abbr} ${e.recent?.home?.sample ?? 0} · ${a.away.abbr} ${e.recent?.away?.sample ?? 0}</strong>
          <small>Mezcla ${Math.round((e.recent?.strength?.home?.recentWeight ?? 0) * 100)}% / ${Math.round((e.recent?.strength?.away?.recentWeight ?? 0) * 100)}% · vida media 45 d</small>
        </div>
        <div class="engine-card">
          <span>Historial directo</span>
          <strong>${e.h2h?.available ? matchesLabel(e.h2h.played) : "Sin muestra"}</strong>
          <small>${e.h2h?.available ? `${e.h2h.homeWins}-${e.h2h.draws}-${e.h2h.awayWins} · ${e.h2h.factor?.applied ? `peso ${Math.round((e.h2h.factor.weight || 0) * 100)}%` : "sin ajuste (mín. 3)"}` : "No se aplica ajuste H2H"}</small>
        </div>
        <div class="engine-card">
          <span>Forma · últimos 5</span>
          <strong>${a.home.abbr} ${formLabel(formHome)} · ${a.away.abbr} ${formLabel(formAway)}</strong>
          <small>×${num(formHome.applied, 3)} / ×${num(formAway.applied, 3)} · peso ${Math.round(formHome.weight * 100)}% / ${Math.round(formAway.weight * 100)}%</small>
        </div>
        <div class="engine-card">
          <span>Blend de tiros</span>
          <strong>${shots.applied ? `${Math.round(shots.weight * 100)}% aplicado` : "No aplicado"}</strong>
          <small>${escapeHtml(shots.reason)}</small>
        </div>
        <div class="engine-card">
          <span>Localía de liga</span>
          <strong>×${num(venue.home, 3)} / ×${num(venue.away, 3)}</strong>
          <small>Cruda ×${num(venue.raw.home, 3)} / ×${num(venue.raw.away, 3)} · normalizada</small>
        </div>
        <div class="engine-card">
          <span>Calibración binaria</span>
          <strong>Platt b=${num(e.binarySlope)}</strong>
          <small>Anclada a la base de ${escapeHtml(a.league.name)}</small>
        </div>
        <div class="engine-card">
          <span>Desempate</span>
          <strong>${t?.applies ? escapeHtml(t.badge) : "No aplica"}</strong>
          <small>${t?.applies ? `edge ${signedPoints(t.edge, 3)} · fiabilidad ${pct(t.reliability, 0)}` : escapeHtml(t?.shortReason || "Empate por debajo del umbral")}</small>
        </div>
        <div class="engine-card">
          <span>Ajuste al empate</span>
          <strong>${t?.applies && t.shift > 0 ? `−${(t.shift * 100).toFixed(1)} pp` : "0 pp"}</strong>
          <small>${t?.applies && t.shift > 0 && t.leanTeam ? `Del empate a ${escapeHtml(t.leanTeam.short)} · 1X2 oficial intacto` : "Sin transferencia"}</small>
        </div>
      </div>
      <div class="engine-table">
        <div class="engine-table-head"><span>Salida</span><span>Crudo</span><span>Base liga</span><span>Final</span></div>
        ${binaryRows.map((row) => `
          <div class="engine-table-row">
            <span>${row.label}</span>
            <span>${pct(row.raw)}</span>
            <span>${pct(row.base)}</span>
            <strong>${pct(row.final)}</strong>
          </div>
        `).join("")}
      </div>
      <p class="panel-footnote">La calibración V1.0 es un prior conservador de OX. La validación walk-forward propia está en el panel de precisión. El 1X2 final y la matriz cruda pueden diferir; los marcadores y la distribución se calculan con la matriz cruda.</p>
    </section>
  `;
}

function renderScorers(a) {
  const totalPlayers = a.players.home.length + a.players.away.length;
  if (!totalPlayers) {
    return `
      <section class="panel scorers-panel empty-panel">
        <div class="panel-head">
          <div><span class="eyebrow">Jugadores</span><h2>Quién puede anotar</h2></div>
          <span class="panel-note">Sin xG/90</span>
        </div>
        <p class="empty-copy">ESPN no publica xG/90 por jugador para estos partidos. Para no inventar goleadores, el panel queda vacío. Si cargas datos propios con <code>players</code>, aquí aparecerá el reparto de goles por jugador.</p>
      </section>
    `;
  }
  const columns = ["home", "away"].map((side) => {
    const team = side === "home" ? a.home : a.away;
    const players = a.players[side];
    const top = players[0]?.p || 1;
    return `
      <div class="scorers-team ${side}">
        <div class="scorers-team-head">
          ${crest(team, "sm")}
          <div><strong>${escapeHtml(team.short)}</strong><span>Prob. de anotar</span></div>
        </div>
        ${players.map((player) => `
          <button type="button" class="scorer-row" data-explain="${player.key}" aria-label="${escapeHtml(player.name)}: ${pct(player.p)} de anotar">
            <span class="scorer-rank">${pad(player.rank)}</span>
            <span class="scorer-name">${escapeHtml(player.name)}<small>${escapeHtml(player.pos)}</small></span>
            <span class="scorer-bar" aria-hidden="true"><i style="width:${Math.max(8, (player.p / top) * 100)}%"></i></span>
            <span class="scorer-pct">${pct(player.p, 0)}</span>
          </button>
        `).join("")}
      </div>
    `;
  }).join("");
  return `
    <section class="panel scorers-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Jugadores</span><h2>Quién puede anotar</h2></div>
        <span class="panel-note">P(anota al menos un gol)</span>
      </div>
      <div class="scorers-grid">${columns}</div>
      <p class="panel-footnote">El reparto de goles de cada jugador sale de los goles esperados del equipo, sus minutos y su xG/90. No incluye autogoles.</p>
    </section>
  `;
}

function renderDistribution(a) {
  const max = Math.max(...a.totals);
  const bars = a.totals.map((p, index) => {
    const label = index === 5 ? "5+" : String(index);
    return `
      <button type="button" class="dist-col" data-explain="distribution" aria-label="${label} goles: ${pct(p)}">
        <span class="dist-value">${pct(p, 1)}</span>
        <span class="dist-bar" style="height:${Math.max(3, (p / max) * 100)}%"></span>
        <span class="dist-label">${label}</span>
      </button>
    `;
  }).join("");
  const topScores = a.topScores.slice(0, 5).map((score, index) => `
    <button type="button" class="top-score" data-explain="scoreline:${index}" aria-label="${score.home}-${score.away}: ${pct(score.p)}">
      <strong>${score.home}–${score.away}</strong>
      <span>${pct(score.p)}</span>
    </button>
  `).join("");
  return `
    <section class="panel distribution-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Simulación</span><h2>Distribución de goles</h2></div>
        <span class="panel-note">${num(a.metrics.goals.total)} goles esperados</span>
      </div>
      <div class="dist-chart">${bars}</div>
      <div class="top-scores">${topScores}</div>
    </section>
  `;
}

function renderMarketTable(a) {
  const e = a.engine;
  const raw = e.rawProbs;
  const binary = e.binary;
  const bases = e.bases;
  const rows = [
    {
      group: "Resultado",
      items: [
        { label: `Gana ${a.home.abbr}`, model: a.probs.home, ref: raw.home, refLabel: "1X2 crudo" },
        { label: "Empate", model: a.probs.draw, ref: raw.draw, refLabel: "1X2 crudo" },
        { label: `Gana ${a.away.abbr}`, model: a.probs.away, ref: raw.away, refLabel: "1X2 crudo" },
        { label: `1X · ${a.home.abbr} o empate`, model: a.probs.home + a.probs.draw, ref: raw.home + raw.draw, refLabel: "1X2 crudo" },
        { label: "12 · sin empate", model: a.probs.home + a.probs.away, ref: raw.home + raw.away, refLabel: "1X2 crudo" },
        { label: `X2 · empate o ${a.away.abbr}`, model: a.probs.draw + a.probs.away, ref: raw.draw + raw.away, refLabel: "1X2 crudo" },
      ],
    },
    {
      group: "Goles y BTTS",
      items: [
        { label: "Más de 1.5 goles", model: binary.over15, ref: bases.over15, refLabel: "base de liga" },
        { label: "Más de 2.5 goles", model: binary.over25, ref: bases.over25, refLabel: "base de liga" },
        { label: "Más de 3.5 goles", model: binary.over35, ref: bases.over35, refLabel: "base de liga" },
        { label: "Ambos anotan", model: binary.btts, ref: bases.btts, refLabel: "base de liga" },
      ],
    },
    {
      group: "Córners y tarjetas",
      items: [
        { label: "Más de 9.5 córners", model: a.metrics.corners.over95, ref: null, refLabel: "sin referencia" },
        { label: "Más de 4.5 tarjetas", model: a.metrics.cards.over45, ref: null, refLabel: "sin referencia" },
      ],
    },
  ];
  return `
    <section class="panel market-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Comparación interna</span><h2>Probabilidad por salida</h2></div>
        <button type="button" class="panel-info" data-explain="markets" aria-label="Cómo se comparan las probabilidades con su referencia">i</button>
      </div>
      <div class="market-table" role="table" aria-label="Probabilidades del modelo y su referencia interna">
        <div class="market-row market-head" role="row">
          <span role="columnheader">Salida</span><span role="columnheader">Modelo</span><span role="columnheader">Referencia</span><span role="columnheader">Diferencia</span>
        </div>
        ${rows.map((group) => `
          <div class="market-group-label" role="row"><span role="cell" aria-colspan="4">${escapeHtml(group.group)}</span></div>
          ${group.items.map((row) => {
            const diff = row.ref === null ? null : (row.model - row.ref) * 100;
            const tone = diff === null ? "" : diff > 0.05 ? "pos" : diff < -0.05 ? "neg" : "";
            return `
              <div class="market-row" role="row">
                <span class="market-label" role="cell">${escapeHtml(row.label)}</span>
                <strong role="cell">${pct(row.model)}</strong>
                <span class="market-ref" role="cell">${row.ref === null ? "—" : pct(row.ref)}<small>${escapeHtml(row.refLabel)}</small></span>
                <span class="market-diff ${tone}" role="cell">${diff === null ? "—" : `${diff >= 0 ? "+" : ""}${diff.toFixed(1)} pp`}</span>
              </div>
            `;
          }).join("")}
        `).join("")}
      </div>
      <p class="panel-footnote">La referencia es interna: el 1X2 crudo antes de la temperatura o la base de la liga para goles y BTTS. La diferencia en puntos porcentuales mide el efecto de la calibración. No son cuotas ni precios externos.</p>
    </section>
  `;
}

function tiebreakTone(t) {
  if (!t?.applies) return "neutral";
  if (t.lean === "draw") return "draw";
  return t.lean === "home" ? "pos" : "neg";
}

function tiebreakSignalHtml(signal) {
  const values = signal.unit
    ? `<span>${escapeHtml(signal.homeValue)} <em>${escapeHtml(signal.unit)}</em></span><span class="tiebreak-signal-sep">·</span><span>${escapeHtml(signal.awayValue)} <em>${escapeHtml(signal.unit)}</em></span>`
    : `<span>${escapeHtml(signal.homeValue)}</span><span class="tiebreak-signal-sep">·</span><span>${escapeHtml(signal.awayValue)}</span>`;
  const width = Math.max(2, Math.abs(signal.signal) * 50);
  // La barra positiva crece hacia la izquierda (local) y la negativa hacia
  // la derecha (visitante), en el mismo orden que la tabla oficial/ajustada.
  const style = signal.signal >= 0
    ? `right:50%;width:${width}%`
    : `left:50%;width:${width}%`;
  return `
    <div class="tiebreak-signal ${signal.available ? "" : "is-unavailable"} ${signal.estimated ? "is-estimated" : ""}">
      <div class="tiebreak-signal-head">
        <span>${escapeHtml(signal.label)}${signal.estimated ? ' <em class="tiebreak-est">est.</em>' : ""}</span>
        <small>peso ${Math.round(signal.weight * 100)}%</small>
      </div>
      <div class="tiebreak-signal-body">
        <span class="tiebreak-signal-values">${values}</span>
        <span class="tiebreak-signal-track" aria-hidden="true"><i class="${signal.tone}" style="${style}"></i></span>
        <strong class="${signal.tone}">${signal.available ? signedPoints(signal.signal, 2) : "—"}</strong>
      </div>
      <small class="tiebreak-signal-detail">${escapeHtml(signal.detail)}</small>
    </div>
  `;
}

function renderTiebreak(a) {
  const t = a.tiebreak;
  if (!t) return "";
  if (!t.applies && a.probs.draw < 0.26) return "";
  const tone = tiebreakTone(t);
  const official = [
    { key: "home", label: a.home.abbr, value: a.probs.home },
    { key: "draw", label: "Empate", value: a.probs.draw },
    { key: "away", label: a.away.abbr, value: a.probs.away },
  ];
  const adjusted = [
    { key: "home", label: a.home.abbr, value: t.adjustedProbs.home },
    { key: "draw", label: "Empate", value: t.adjustedProbs.draw },
    { key: "away", label: a.away.abbr, value: t.adjustedProbs.away },
  ];
  const leanKey = t.lean === "none" ? null : t.lean;
  const row = (label, values, isAdjusted = false) => `
    <div class="tiebreak-row${isAdjusted ? " is-adjusted" : ""}" role="row">
      <span role="cell">${escapeHtml(label)}</span>
      ${values.map((item) => `
        <strong class="${isAdjusted && item.key === leanKey ? "is-lean" : ""}" role="cell">${pct(item.value)}</strong>
      `).join("")}
    </div>
  `;
  return `
    <section class="panel tiebreak-panel${t.applies ? " is-active" : " is-muted"}">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Desempate</span>
          <h2>${t.applies ? "Partido parejo: lectura ajustada" : "Partido parejo: sin ajuste"}</h2>
        </div>
        <div class="panel-head-actions">
          <span class="panel-note">1X2 oficial intacto</span>
          <button type="button" class="panel-info" data-explain="tiebreak" aria-label="Cómo se calcula el desempate de partidos parejos">i</button>
        </div>
      </div>
      <div class="tiebreak-verdict ${tone}">
        <div class="tiebreak-verdict-main">
          <span class="eyebrow">${t.applies ? "Veredicto" : "Lectura"}</span>
          <strong>${escapeHtml(t.verdict)}</strong>
          <p>${escapeHtml(t.applies ? t.summary : t.reason)}</p>
        </div>
        <div class="tiebreak-verdict-metrics">
          ${t.applies ? `
            <div><span>Edge</span><strong>${signedPoints(t.edge, 3)}</strong><small>fiabilidad ${pct(t.reliability, 0)}</small></div>
            <div><span>Ajuste</span><strong>${t.shift > 0 ? `−${(t.shift * 100).toFixed(1)} pp` : "0 pp"}</strong><small>${t.shift > 0 && t.leanTeam ? `al empate → ${escapeHtml(t.leanTeam.short)}` : "sin transferencia"}</small></div>
          ` : `
            <div><span>Empate</span><strong>${pct(a.probs.draw)}</strong><small>umbral ${pct(t.threshold, 0)}</small></div>
            <div><span>Marcador</span><strong>${t.topScore.home}–${t.topScore.away}</strong><small>${pct(t.topScore.p)}</small></div>
          `}
        </div>
      </div>
      <div class="tiebreak-table" role="table" aria-label="Probabilidades oficiales y lectura ajustada">
        <div class="tiebreak-row head" role="row">
          <span role="columnheader">Lectura</span>
          <span role="columnheader">${escapeHtml(a.home.abbr)}</span>
          <span role="columnheader">Empate</span>
          <span role="columnheader">${escapeHtml(a.away.abbr)}</span>
        </div>
        ${row("Oficial", official)}
        ${t.applies ? row("Ajustada", adjusted, true) : ""}
      </div>
      ${t.applies ? `
        <div class="tiebreak-gap">
          <span>Diferencia 1X2 oficial <strong>${signedPoints(t.officialWinGap * 100, 1)} pp</strong></span>
          <span>Diferencia 1X2 ajustada <strong>${signedPoints(t.adjustedWinGap * 100, 1)} pp</strong></span>
          <span>Empate vs favorito <strong>${signedPoints(t.drawGap * 100, 1)} → ${signedPoints(t.adjustedDrawGap * 100, 1)} pp</strong></span>
        </div>
        <div class="tiebreak-signals-legend">
          <span><i class="pos"></i> ${escapeHtml(a.home.abbr)} mejor</span>
          <span><i class="neg"></i> ${escapeHtml(a.away.abbr)} mejor</span>
        </div>
        <div class="tiebreak-signals">
          ${t.signals.map(tiebreakSignalHtml).join("")}
        </div>
        <div class="tiebreak-formula">
          <span class="eyebrow">Fórmula</span>
          <code>${escapeHtml(t.formula)}</code>
          <p>${escapeHtml(t.formulaNote)}</p>
        </div>
      ` : `
        <p class="tiebreak-muted-note">${escapeHtml(t.shortReason)}. El panel completo de señales se activa cuando el empate supera el umbral y el marcador es corto o está cerca del favorito.</p>
      `}
      <p class="panel-footnote">${escapeHtml(t.note)}</p>
    </section>
  `;
}

function renderModelQuality() {
  if (modelReady) {
    const h = MODEL_REPORT.headline;
    const one = MODEL_REPORT.markets?.["1x2"];
    if (!one) return "";
    const skill = Number(h.skill);
    const marketRows = MODEL_MARKET_ORDER.map((key) => {
      const market = MODEL_REPORT.markets?.[key];
      if (!market?.n) return "";
      const value = Number(market.skill);
      return `
        <div class="quality-market">
          <span>${escapeHtml(MODEL_MARKET_LABELS[key] || key)}</span>
          <strong>${num(market.brier, 3)}</strong>
          <small class="${value > 0 ? "pos" : value < 0 ? "neg" : ""}">${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}% skill</small>
        </div>
      `;
    }).join("");
    const liveLine = validationReady && VALIDATION?.hits?.n
      ? `<div class="quality-live"><span>Poisson en vivo</span><strong>${pct(VALIDATION.hits.rate, 1)}</strong><small>${VALIDATION.hits.hits}/${VALIDATION.hits.n} · referencia walk-forward</small></div>`
      : "";
    return `
      <section class="panel quality-panel">
        <div class="panel-head">
          <div><span class="eyebrow">Ensamble · test temporal</span><h2>Calidad del motor</h2></div>
          <button type="button" class="panel-info" data-explain="validation" aria-label="Cómo se mide la calidad del motor">i</button>
        </div>
        <div class="quality-strip">
          <div><span>Aciertos 1X2</span><strong>${pct(h.accuracy, 1)}</strong><small>${h.hits}/${h.n}</small></div>
          <div><span>Brier 1X2</span><strong>${num(h.brier, 4)}</strong><small>base ${num(h.baseline.brier, 4)}</small></div>
          <div><span>Skill</span><strong class="${skill > 0 ? "pos" : skill < 0 ? "neg" : ""}">${skill >= 0 ? "+" : ""}${(skill * 100).toFixed(1)}%</strong><small>vs base de liga</small></div>
          <div><span>Muestra test</span><strong>${h.n}</strong><small>${MODEL_REPORT.sample?.leagues ?? 2} ligas · 2024-26</small></div>
        </div>
        <div class="quality-markets">${marketRows}</div>
        ${liveLine}
        <p class="panel-footnote">Ensamble de cuatro modelos calibrados: Poisson + Dixon-Coles, logística Elo + xG, logística core y logística Elo + xG + tiros. En 1X2 el peso se reparte entre la logística con tiros a puerta (57,3%) y la logística core (42,7%); en los mercados binarios domina Poisson. Los pesos se aprendieron solo en la validación 2023-24, sin piso artificial; el test 2024-25 y 2025-26 se evaluó una sola vez. El Brier mide error cuadrático medio (más bajo es mejor) y el skill compara contra la base de la liga. No es una promesa de precisión futura.</p>
      </section>
    `;
  }
  if (!validationReady) return "";
  const overall = VALIDATION.overall;
  const one = overall.markets?.["1x2"];
  const hits = VALIDATION.hits;
  if (!one) return "";
  const skill = Number(one.skill);
  const labels = {
    "1x2": "1X2",
    btts: "BTTS",
    over15: "Over 1.5",
    over25: "Over 2.5",
    over35: "Over 3.5",
  };
  const marketRows = Object.entries(overall.markets || {}).map(([key, market]) => {
    const value = Number(market.skill);
    return `
      <div class="quality-market">
        <span>${escapeHtml(labels[key] || key)}</span>
        <strong>${num(market.brier, 3)}</strong>
        <small class="${value > 0 ? "pos" : value < 0 ? "neg" : ""}">${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}% skill</small>
      </div>
    `;
  }).join("");
  return `
    <section class="panel quality-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Validación</span><h2>Calidad del motor</h2></div>
        <button type="button" class="panel-info" data-explain="validation" aria-label="Cómo se mide la calidad del motor">i</button>
      </div>
      <div class="quality-strip">
        <div><span>Brier 1X2</span><strong>${num(one.brier, 4)}</strong><small>base ${num(one.baseline, 4)}</small></div>
        <div><span>Skill</span><strong class="${skill > 0 ? "pos" : skill < 0 ? "neg" : ""}">${skill >= 0 ? "+" : ""}${(skill * 100).toFixed(1)}%</strong><small>vs base de liga</small></div>
        <div><span>Aciertos 1X2</span><strong>${hits ? pct(hits.rate, 1) : "—"}</strong><small>${hits ? `${hits.hits}/${hits.n}` : "sin muestra"}</small></div>
        <div><span>Muestra</span><strong>${overall.n}</strong><small>${VALIDATION.sample?.leagues ?? "—"} ligas · walk-forward</small></div>
      </div>
      <div class="quality-markets">${marketRows}</div>
      <p class="panel-footnote">Backtest propio walk-forward: cada partido se evalúa solo con resultados anteriores. El Brier mide error cuadrático medio (más bajo es mejor); el skill compara contra la base de la liga. No es una promesa de precisión futura.</p>
    </section>
  `;
}

function renderTabs(group, tabs, active) {
  return `
    <div class="panel-tabs" role="tablist" aria-label="Secciones del panel">
      ${tabs.map((tab) => `
        <button type="button" class="panel-tab ${tab.id === active ? "is-active" : ""}" role="tab" aria-selected="${tab.id === active}" data-tab-group="${group}" data-tab-target="${tab.id}" data-tab-explain="${tab.explain || ""}">${escapeHtml(tab.label)}</button>
      `).join("")}
    </div>
  `;
}

function renderTabbedPanel({ group, eyebrow, title, note, tabs, active }) {
  const current = tabs.find((tab) => tab.id === active) || tabs[0];
  return `
    <section class="panel tab-panel" data-panel-group="${group}">
      <div class="panel-head">
        <div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h2>${escapeHtml(title)}</h2></div>
        <div class="panel-head-actions">
          ${note ? `<span class="panel-note">${escapeHtml(note)}</span>` : ""}
          ${current?.explain ? `<button type="button" class="panel-info" data-explain="${current.explain}" aria-label="Cómo se calcula esta sección">i</button>` : ""}
        </div>
      </div>
      ${renderTabs(group, tabs, current?.id || tabs[0].id)}
      <div class="tab-body">
        ${tabs.map((tab) => `
          <div class="tab-pane ${tab.id === current?.id ? "is-active" : ""}" data-tab-panel="${tab.id}" ${tab.id === current?.id ? "" : "hidden"}>
            ${tab.content}
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function switchTab(group, id) {
  state.tabs[group] = id;
  const root = $(`[data-panel-group="${group}"]`);
  if (!root) return;
  $$("[data-tab-target]", root).forEach((button) => {
    const active = button.dataset.tabTarget === id;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$("[data-tab-panel]", root).forEach((pane) => {
    const active = pane.dataset.tabPanel === id;
    pane.classList.toggle("is-active", active);
    if (active) pane.removeAttribute("hidden");
    else pane.setAttribute("hidden", "");
  });
  const activeButton = $(`[data-tab-target="${id}"]`, root);
  const info = $(".panel-head .panel-info", root);
  if (info && activeButton) {
    const explain = activeButton.dataset.tabExplain;
    if (explain) info.dataset.explain = explain;
  }
}

function handlePanelInput(event) {
  if (event.target.id === "latent-league") {
    state.latentLeague = event.target.value;
    state.latentLeagueChosen = true;
    renderLatentRows();
  }
}

function renderLeagueTable(a) {
  const table = TABLES?.[a.league?.id];
  if (!table || !Array.isArray(table.standings) || !table.standings.length) {
    return `
      <section class="panel table-panel empty-panel">
        <div class="panel-head">
          <div><span class="eyebrow">Liga</span><h2>Tabla de posiciones</h2></div>
          <button type="button" class="panel-info" data-explain="table" aria-label="Cómo se usan los datos de la tabla">i</button>
        </div>
        <p class="empty-copy">No hay tabla disponible para esta competición en la muestra actual. Ejecuta una actualización live para descargarla de ESPN.</p>
      </section>
    `;
  }
  const homeKey = String(a.home.espnId || "");
  const awayKey = String(a.away.espnId || "");
  const rows = table.standings.map((entry) => {
    const key = String(entry.id ?? entry.teamId ?? "");
    const isHome = (homeKey && key === homeKey) || entry.team === a.home.name;
    const isAway = (awayKey && key === awayKey) || entry.team === a.away.name;
    const initials = escapeHtml(String(entry.short || entry.team || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase());
    const logo = entry.logo
      ? `<img src="${escapeHtml(localCrest(entry.logo))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
      : "";
    return `
      <tr class="${isHome ? "is-home" : ""}${isAway ? " is-away" : ""}">
        <td class="pos">${entry.pos ?? "—"}</td>
        <td class="team-cell"><span class="table-logo">${logo}<i>${initials}</i></span><span>${escapeHtml(entry.short || entry.team)}</span></td>
        <td>${entry.pj}</td>
        <td class="hide-sm">${entry.pg}</td>
        <td class="hide-sm">${entry.pe}</td>
        <td class="hide-sm">${entry.pp}</td>
        <td class="hide-sm">${entry.gf}</td>
        <td class="hide-sm">${entry.gc}</td>
        <td>${entry.dg > 0 ? "+" : ""}${entry.dg}</td>
        <td class="pts">${entry.pts}</td>
      </tr>
    `;
  }).join("");
  return `
    <section class="panel table-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Liga</span><h2>Tabla de posiciones</h2></div>
        <button type="button" class="panel-info" data-explain="table" aria-label="Cómo se usan los datos de la tabla">i</button>
      </div>
      <div class="table-meta">${escapeHtml(table.name)} · ${escapeHtml(table.season)} <span>${table.standings.length} equipos</span></div>
      <div class="table-scroll">
        <table class="league-table">
          <thead>
            <tr><th>#</th><th>Equipo</th><th>PJ</th><th class="hide-sm">G</th><th class="hide-sm">E</th><th class="hide-sm">P</th><th class="hide-sm">GF</th><th class="hide-sm">GC</th><th>DG</th><th>Pts</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="panel-footnote">Las fuerzas de ataque y defensa se derivan de los goles a favor y en contra de esta tabla. El resaltado marca a los dos equipos del partido.</p>
    </section>
  `;
}

function renderContext(a) {
  const { match, home, away } = a;
  const live = Boolean(a.league.live);
  let rows;
  if (live) {
    rows = [
      { key: "factor:matchType", label: "Tipo", value: a.typeLabel, note: stageLabel(match) },
      { key: "tiebreak", label: "Desempate", value: a.tiebreak?.applies ? a.tiebreak.badge : "No aplica", note: a.tiebreak?.applies ? a.tiebreak.badgeDetail : a.tiebreak?.shortReason || "" },
      { key: "factor:venue", label: "Sede", value: match.venue, note: match.city },
      { key: "factor:lineup", label: "Alineación", value: "Sin confirmar", note: "No se ajusta por bajas" },
      { key: "factor:recent", label: "Últimos 10", value: `${home.recent?.sample ?? 0} vs ${away.recent?.sample ?? 0}`, note: `Mezcla ${Math.round((home.strength?.recentWeight ?? 0) * 100)}% / ${Math.round((away.strength?.recentWeight ?? 0) * 100)}%` },
      { key: "factor:h2h", label: "H2H", value: match.h2h?.available ? `${match.h2h.homeWins}-${match.h2h.draws}-${match.h2h.awayWins}` : "Sin muestra", note: match.h2h?.available ? plural(match.h2h.played, "partido directo", "partidos directos") : "No se aplica" },
      { key: "factor:form", label: "Forma", value: `${a.engine.form.home.points ?? "—"} vs ${a.engine.form.away.points ?? "—"} pts`, note: "Últimos 5" },
      { label: "Excluidos", value: "Clima y árbitro", note: "No entran en ninguna probabilidad" },
      { label: "Motor", value: `${a.engine.label || ENGINE_LABEL} · T ${num(a.engine.temperature)}`, note: `Platt b=${num(a.engine.binarySlope)}` },
      { label: "Tabla", value: `${home.standing?.pos ?? "—"}.º vs ${away.standing?.pos ?? "—"}.º`, note: `${a.league.name} · ${a.league.season}` },
      { label: "Fuente", value: "ESPN", note: "Datos live" },
    ];
  } else {
    const motivation = match.motivation || { home: 1, away: 1 };
    rows = [
      { key: "factor:matchType", label: "Tipo", value: a.typeLabel, note: match.stage },
      { key: "tiebreak", label: "Desempate", value: a.tiebreak?.applies ? a.tiebreak.badge : "No aplica", note: a.tiebreak?.applies ? a.tiebreak.badgeDetail : a.tiebreak?.shortReason || "" },
      { key: "factor:venue", label: "Sede", value: match.neutral ? "Neutral" : "Con localía", note: `${match.venue} · ${match.city}` },
      { key: "factor:lineup", label: "Bajas", value: absencesSummary(a), note: "" },
      { key: "factor:rest", label: "Descanso", value: `${match.rest.home} vs ${match.rest.away} días`, note: "" },
      { key: "factor:motivation", label: "Motivación", value: `${motivation.home.toFixed(2)} vs ${motivation.away.toFixed(2)}`, note: "Índice local vs visitante" },
      { key: "factor:travel", label: "Viaje", value: `${match.travelKm.home} vs ${match.travelKm.away} km`, note: "" },
      { label: "Excluidos", value: "Clima y árbitro", note: "No entran en ninguna probabilidad" },
      { key: "factor:altitude", label: "Altitud", value: `${match.altitude} m`, note: `${away.short}: ${away.altitude} m` },
    ];
  }
  return `
    <section class="panel context-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Contexto</span><h2>Análisis del partido</h2></div>
        <span class="panel-note">${escapeHtml(match.competition)}</span>
      </div>
      <div class="context-list">
        ${rows.map((row) => row.key ? `
          <button type="button" class="context-row" data-explain="${row.key}">
            <span>${escapeHtml(row.label)}</span>
            <strong>${escapeHtml(row.value)}${row.note ? `<small>${escapeHtml(row.note)}</small>` : ""}</strong>
          </button>
        ` : `
          <div class="context-row is-static">
            <span>${escapeHtml(row.label)}</span>
            <strong>${escapeHtml(row.value)}${row.note ? `<small>${escapeHtml(row.note)}</small>` : ""}</strong>
          </div>
        `).join("")}
      </div>
      <p class="match-note">${escapeHtml(match.note)}</p>
    </section>
  `;
}

function renderFactors(a) {
  const order = ["quality", "recent", "form", "h2h", "shots", "venue", "lineup", "rest", "motivation", "travel", "matchType", "altitude", "aggregate"];
  const live = Boolean(a.league.live);
  const hiddenInLive = new Set(["lineup", "travel", "altitude", "motivation", "aggregate"]);
  const visible = order
    .map((key) => a.factors.find((factor) => factor.key === key))
    .filter(Boolean)
    .filter((factor) => {
      if (live && hiddenInLive.has(factor.key)) return false;
      if (live && factor.key === "rest" && a.match.restMeta
        && a.match.restMeta.home?.observed === false
        && a.match.restMeta.away?.observed === false) return false;
      if (factor.key === "shots" && !a.engine.shots.applied) return false;
      if (factor.key === "travel" && a.match.travelKm.home === 0 && a.match.travelKm.away === 0) return false;
      if (factor.key === "altitude" && a.match.altitude < 1500) return false;
      if (factor.key === "aggregate" && a.match.leg !== 2) return false;
      if (live && !["quality", "recent", "form", "h2h", "venue", "rest"].includes(factor.key) && Math.abs(factor.value) < 0.03) return false;
      return true;
    });
  return `
    <section class="panel factors-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Factores</span><h2>Qué mueve el resultado</h2></div>
        <span class="panel-note">impacto aislado</span>
      </div>
      <div class="factor-list">
        ${visible.map((factor, index) => `
          <button type="button" class="factor-row" data-explain="factor:${factor.key}">
            <span class="factor-icon">${pad(index + 1)}</span>
            <span class="factor-main">
              <strong>${escapeHtml(factor.label)}</strong>
              <small>${escapeHtml(factor.detail)}</small>
            </span>
            <span class="factor-impact ${factor.tone}">${escapeHtml(factor.impactLabel)}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function renderInsights(a) {
  return `
    <section class="panel insight-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Lectura</span><h2>Lo que importa</h2></div>
        <span class="panel-note">resumen automático</span>
      </div>
      <ul class="insight-list">
        ${a.insights.map((insight) => `
          <li>
            <span class="insight-dot"></span>
            <div><span class="insight-label">${escapeHtml(insight.label)}</span><p>${escapeHtml(insight.text)}</p></div>
          </li>
        `).join("")}
      </ul>
    </section>
  `;
}

function renderConfidence(a) {
  const c = a.certainty;
  const favoriteLabel = c.favorite === "draw" ? "Empate" : c.favorite === "home" ? a.home.abbr : a.away.abbr;
  const goalsLabel = c.goals.low === c.goals.high ? `${c.goals.low}` : `${c.goals.low}–${c.goals.high}`;
  const marker = Math.max(0, Math.min(100, c.separation * 100));
  return `
    <section class="panel confidence-panel">
      <div class="confidence-head">
        <div class="confidence-ring" style="--score:${a.confidence.score}"><span>${a.confidence.score}</span></div>
        <div>
          <span class="eyebrow">Confianza del contexto</span>
          <h2>${escapeHtml(a.confidence.label)}</h2>
        </div>
      </div>
      <p>${escapeHtml(a.confidence.note)}</p>
      <div class="certainty-block">
        <div class="certainty-head">
          <div><span class="eyebrow">Certeza del pronóstico</span><strong>${escapeHtml(c.label)}</strong></div>
          <span class="certainty-gap">+${num(c.gapPp, 1)} pp</span>
        </div>
        <div class="certainty-meter" role="img" aria-label="Separación del favorito: ${num(c.gapPp, 1)} puntos porcentuales sobre el segundo resultado">
          <span class="certainty-zone open"></span><span class="certainty-zone lean"></span><span class="certainty-zone clear"></span>
          <i style="left:${marker.toFixed(1)}%"></i>
        </div>
        <div class="certainty-scale"><span>Abierto</span><span>Inclinado</span><span>Claro</span></div>
        <div class="certainty-facts">
          <div><span>Favorito</span><strong>${escapeHtml(favoriteLabel)}</strong><small>${pct(c.favoriteProb)}</small></div>
          <div><span>Ventaja</span><strong>+${num(c.gapPp, 1)} pp</strong><small>sobre el segundo</small></div>
          <div><span>Goles probables</span><strong>${escapeHtml(goalsLabel)}</strong><small>80% central</small></div>
        </div>
        <p class="certainty-note">${escapeHtml(c.note)}</p>
        <button type="button" class="text-link" data-explain="certainty">Ver cómo se calcula <span>→</span></button>
      </div>
      <button type="button" class="text-link" data-explain="confidence">Ver confianza del contexto <span>→</span></button>
    </section>
  `;
}

function renderApiSources() {
  const providers = SOURCE_STATUS?.providers || {};
  const keys = ["espn", "api_football", "football_data_org", "footballapi_org"];
  const statusLabels = { ok: "Activa", "sin-clave": "Sin clave", error: "Error" };
  const qualityLabels = {
    observed: "Observado",
    observed_delayed: "Observado (con retraso)",
  };
  const rows = keys.map((key) => {
    const info = providers[key] || {};
    const status = info.status || "sin-clave";
    const tone = status === "ok" ? "ok" : status === "error" ? "stale" : "unknown";
    const quality = info.quality != null
      ? (qualityLabels[info.quality] || escapeHtml(info.quality))
      : "—";
    const asOf = info.as_of ? escapeHtml(formatTimestamp(info.as_of)) : "—";
    const events = info.events != null ? escapeHtml(String(info.events)) : "—";
    const note = info.note ? escapeHtml(info.note) : "";
    const label = info.source || key;
    return `
      <div class="api-source-row">
        <div class="api-source-top">
          <span class="api-source-name">${escapeHtml(label)}</span>
          <span class="api-source-status ${tone}">${statusLabels[status] || escapeHtml(status)}</span>
        </div>
        <div class="api-source-meta">
          <span>calidad: <strong>${quality}</strong></span>
          <span>actualizado: <strong>${asOf}</strong></span>
          <span>eventos: <strong>${events}</strong></span>
        </div>
        ${note ? `<small>${note}</small>` : ""}
      </div>
    `;
  }).join("");
  return `
    <div class="api-sources">
      <div class="api-sources-head">
        <span>Fuentes de datos</span>
        <small>API-Football, football-data.org y footballapi.org · planes gratuitos · sin claves en la vista</small>
      </div>
      <div class="api-sources-grid">${rows}</div>
    </div>
  `;
}

function renderFreshness(a) {
  const live = Boolean(a.league.live);
  const updated = a.league.updated || a.match.source?.updated || null;
  const source = a.league.source || a.match.source?.name || (a.league.demo ? "Datos de respaldo" : "Datos propios");
  const matchCount = a.match.reference ? 1 : (a.league.matchCount || MATCHES.filter((match) => !match.reference).length);
  const leagueCount = a.league.leagueCount || null;
  const teamCount = a.match.reference ? 2 : (a.league.teamCount || Object.keys(LIVE_TEAMS).length);
  const ageHours = updated ? Math.max(0, (Date.now() - new Date(updated).getTime()) / 3_600_000) : null;
  const status = ageHours === null ? "sin fecha" : ageHours > 72 ? "desactualizado" : ageHours > 24 ? "revisar" : "al día";
  const statusTone = ageHours === null ? "unknown" : ageHours > 72 ? "stale" : ageHours > 24 ? "warn" : "ok";
  const onTargetDerived = [onTargetSource(a.home), onTargetSource(a.away)].filter((value) => value === "derived").length;
  const onTargetPlaceholder = 2 - onTargetDerived;
  const shotDerived = [a.home?.shotsSource, a.away?.shotsSource]
    .filter((value) => value === "observed-shrunk" || value === "observed").length;
  const shotEstimated = 2 - shotDerived;
  const missing = [];
  if (/sin alineaci/i.test(a.match.lineups?.home?.note || "") || /sin alineaci/i.test(a.match.lineups?.away?.note || "")) missing.push("Alineaciones confirmadas");
  if (a.match.travelKm?.home === 0 && a.match.travelKm?.away === 0) missing.push("Distancia de viaje");
  if ((a.match.h2h?.played || 0) < (a.match.h2h?.minMatches || 3)) missing.push("H2H suficiente (3+)");
  if (onTargetPlaceholder) missing.push("Tasa de tiros a puerta real");
  if (shotEstimated) missing.push("Tiros reales por equipo");
  if (a.match.restMeta && (a.match.restMeta.home?.observed === false || a.match.restMeta.away?.observed === false)) missing.push("Descanso de algún equipo");
  missing.push("xG / xGA");
  missing.push("Benchmark externo");
  return `
    <section class="panel freshness-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Frescura y cobertura</span><h2>De dónde sale cada dato</h2></div>
        <span class="freshness-status ${statusTone}">${status}</span>
      </div>
      <div class="freshness-grid">
        <div class="freshness-card"><span>Fuente</span><strong>${escapeHtml(source)}</strong><small>${live ? "Calendario, tabla, forma, sede y tiros" : "Datos propios"}</small></div>
        <div class="freshness-card"><span>Última actualización</span><strong>${updated ? escapeHtml(formatTimestamp(updated)) : "Sin fecha"}</strong><small>${updated ? escapeHtml(freshnessAge(updated)) : "Ejecuta una actualización"}</small></div>
        <div class="freshness-card"><span>Cobertura</span><strong>${matchesLabel(matchCount)}</strong><small>${leagueCount ? `${leagueCount} ligas · ` : ""}${teamCount} equipos</small></div>
        <div class="freshness-card"><span>Tiros por equipo</span><strong>${shotDerived}/2 con muestra</strong><small>${onTargetDerived}/2 tasa a puerta${shotEstimated ? ` · ${shotEstimated} estimado(s)` : ""}</small></div>
      </div>
      ${renderApiSources()}
      <div class="freshness-missing">
        <span>Faltantes</span>
        <div>${missing.map((item) => `<span class="missing-chip">${escapeHtml(item)}</span>`).join("")}</div>
      </div>
      <p class="panel-footnote">Observado: resultados, tabla, forma, sede, H2H y tiros por equipo de ESPN. Estimado: goles, tiros proyectados, córners, tarjetas y posesión. Placeholder: valores neutros fijos cuando falta muestra. La tasa de tiros a puerta se deriva de los resúmenes de ESPN; los tiros por equipo se contraen al prior y la proyección del partido se marca como estimada.</p>
    </section>
  `;
}

function renderRecent(a) {
  const sides = [
    { side: "home", team: a.home, recent: a.engine?.recent?.home, strength: a.engine?.recent?.strength?.home },
    { side: "away", team: a.away, recent: a.engine?.recent?.away, strength: a.engine?.recent?.strength?.away },
  ];
  const available = sides.some((item) => item.recent?.available);
  return `
    <section class="panel recent-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Últimos 10</span><h2>El pulso real</h2></div>
        <div class="panel-head-actions">
          ${provenanceChip("observed", "Resultados y forma observados en ESPN.")}
          <button type="button" class="panel-info" data-explain="recentForm" aria-label="Cómo se usan los últimos partidos">i</button>
        </div>
      </div>
      ${available ? `
        <div class="recent-grid">
          ${sides.map(({ side, team, recent, strength }) => `
            <div class="recent-team ${side}">
              <div class="recent-team-head">
                ${crest(team, "xs")}
                <strong>${escapeHtml(team.short)}</strong>
                <span>${matchesLabel(recent?.sample ?? 0)}</span>
              </div>
              <div class="recent-rates">
                <div><span>GF</span><strong>${num(recent?.gfPerMatch ?? 0)}</strong></div>
                <div><span>GC</span><strong>${num(recent?.gaPerMatch ?? 0)}</strong></div>
                <div><span>Mezcla</span><strong>${Math.round((strength?.recentWeight ?? 0) * 100)}%</strong></div>
              </div>
              <ul class="recent-list">
                ${(recent?.last || []).map((match) => `
                  <li>
                    <span class="recent-res ${String(match.result || "").toLowerCase()}">${match.result || "—"}</span>
                    <span class="recent-opp">${match.homeAway === "home" ? "vs" : "@"} ${escapeHtml(match.opponentAbbr || match.opponent)}</span>
                    <strong>${match.goalsFor}-${match.goalsAgainst}</strong>
                    <small>${escapeHtml(formatDate(match.date).day)}</small>
                  </li>
                `).join("")}
              </ul>
            </div>
          `).join("")}
        </div>
        <p class="panel-footnote">Ventana de 10 partidos con vida media de 45 días. La mezcla indica cuánto pesa el historial frente a la tabla de temporada.</p>
      ` : `
        <p class="empty-copy">Sin historial reciente en este modo. Ejecuta una actualización live para descargar los últimos partidos reales de ESPN.</p>
      `}
    </section>
  `;
}

function renderH2H(a) {
  const h2h = a.match?.h2h;
  const minMatches = h2h?.minMatches || 3;
  if (!h2h?.available) {
    return `
      <section class="panel h2h-panel">
        <div class="panel-head">
          <div><span class="eyebrow">Historial directo</span><h2>Cara a cara</h2></div>
          <span class="panel-note">sin muestra</span>
        </div>
        <p class="empty-copy">No hay enfrentamientos directos en la muestra de ESPN. El motor no aplica ajuste H2H.</p>
      </section>
    `;
  }
  const insufficient = h2h.played < minMatches;
  return `
    <section class="panel h2h-panel${insufficient ? " is-insufficient" : ""}">
      <div class="panel-head">
        <div><span class="eyebrow">Historial directo</span><h2>Cara a cara</h2></div>
        <div class="panel-head-actions">
          ${provenanceChip("observed", "Resultados directos observados en ESPN.")}
          <button type="button" class="panel-info" data-explain="h2h" aria-label="Cómo se pondera el historial directo">i</button>
        </div>
      </div>
      ${insufficient ? `<p class="data-warning">Muestra insuficiente: ${h2h.played} partido(s) directo(s); el mínimo para ajustar es ${minMatches}. Se muestra como contexto, no como señal.</p>` : ""}
      <div class="h2h-score">
        <div><strong>${h2h.homeWins}</strong><span>${escapeHtml(a.home.abbr)}</span></div>
        <div class="h2h-draw"><strong>${h2h.draws}</strong><span>Empates</span></div>
        <div><strong>${h2h.awayWins}</strong><span>${escapeHtml(a.away.abbr)}</span></div>
      </div>
      <div class="h2h-meta">
        <span>${matchesLabel(h2h.played)}</span>
        <span>${num(h2h.avgTotal)} goles/partido</span>
        <span>BTTS ${Math.round((h2h.btts / h2h.played) * 100)}%</span>
        <span>Over 2.5 ${Math.round((h2h.over25 / h2h.played) * 100)}%</span>
      </div>
      <ul class="h2h-list">
        ${h2h.matches.slice(0, 4).map((match) => `
          <li>
            <span class="h2h-date">${escapeHtml(formatDate(match.date).day)}</span>
            <span class="h2h-teams">${escapeHtml(match.homeAbbr || match.homeTeam)} <strong>${match.homeGoals}-${match.awayGoals}</strong> ${escapeHtml(match.awayAbbr || match.awayTeam)}</span>
            <span class="h2h-venue">${escapeHtml(match.currentHomeWasHome ? "mismo local" : "localía inversa")}</span>
          </li>
        `).join("")}
      </ul>
      <p class="panel-footnote">${a.engine?.h2h?.factor?.applied ? "Ajuste conservador aplicado con un máximo de 12% de peso." : `Sin ajuste: ${escapeHtml(a.engine?.h2h?.factor?.reason || `se necesitan al menos ${minMatches} partidos directos.`)}`} El H2H matiza las fuerzas; no las reemplaza.</p>
    </section>
  `;
}

function renderScoreMatrix(a) {
  const view = a.scoreMatrix;
  if (!view) return "";
  const top = a.topScores?.[0];
  const topKey = top ? `${top.home}:${top.away}` : "";
  const cells = new Map(view.cells.map((cell) => [`${cell.home}:${cell.away}`, cell.p]));
  const max = view.max || 0.0001;
  const labels = Array.from({ length: view.size }, (_, index) => index);
  return `
    <section class="panel matrix-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Matriz</span><h2>Marcadores 7×7</h2></div>
        <button type="button" class="panel-info" data-explain="matrix" aria-label="Cómo se construye la matriz de marcadores">i</button>
      </div>
      <div class="matrix-legend">
        <span>Local ↓ · Visitante →</span>
        <span>La cola 7+ se agrupa: <strong>${pct(view.rest)}</strong></span>
      </div>
      <div class="matrix-grid" style="--matrix-cols:${view.size + 1}" role="table" aria-label="Matriz de probabilidad de marcadores">
        <span class="matrix-corner" role="columnheader">L / V</span>
        ${labels.map((goal) => `<span class="matrix-col-label" role="columnheader">${goal}</span>`).join("")}
        ${labels.map((homeGoals) => `
          <span class="matrix-row-label" role="rowheader">${homeGoals}</span>
          ${labels.map((awayGoals) => {
            const p = cells.get(`${homeGoals}:${awayGoals}`) ?? 0;
            const heat = Math.min(1, p / max);
            const hot = heat > 0.55 ? " is-hot" : "";
            const isTop = `${homeGoals}:${awayGoals}` === topKey ? " is-top" : "";
            return `
              <button type="button" class="matrix-cell${hot}${isTop}" role="cell" style="--heat:${heat.toFixed(3)}" data-explain="matrix:${homeGoals}:${awayGoals}" aria-label="${homeGoals}-${awayGoals}: ${pct(p, 2)}">
                <span>${p >= 0.001 ? pct(p, 1) : "·"}</span>
              </button>
            `;
          }).join("")}
        `).join("")}
      </div>
      <div class="matrix-top">
        ${(a.topScores || []).slice(0, 4).map((score, index) => `
          <button type="button" class="matrix-top-score" data-explain="scoreline:${index}">
            <strong>${score.home}–${score.away}</strong>
            <span>${pct(score.p)}</span>
          </button>
        `).join("")}
      </div>
      <p class="panel-footnote">Cada celda es la probabilidad conjunta de ese marcador. La matriz interna llega hasta 10-10; la vista muestra 0-0 a 6-6 y agrupa el resto.</p>
    </section>
  `;
}

function renderTiming(a) {
  const t = a.timing;
  if (!t) return "";
  const halves = [
    { key: "first", label: "Primer tiempo", data: t.first, share: t.firstHalfShare },
    { key: "second", label: "Segundo tiempo", data: t.second, share: 1 - t.firstHalfShare },
  ];
  return `
    <section class="panel timing-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Goles por tiempo</span><h2>Primero y segundo</h2></div>
        <button type="button" class="panel-info" data-explain="timing" aria-label="Cómo se reparten los goles por tiempo">i</button>
      </div>
      <div class="timing-split" aria-hidden="true">
        ${halves.map((half) => `<span class="${half.key}" style="width:${Math.max(1, half.share * 100)}%"><i>${Math.round(half.share * 100)}%</i></span>`).join("")}
      </div>
      <div class="timing-grid">
        ${halves.map((half) => `
          <div class="timing-card">
            <div class="timing-head"><span>${half.label}</span><strong>λ ${num(half.data.lambda)}</strong></div>
            <div class="timing-bars">
              <div><span>0 goles</span><i style="width:${Math.max(2, half.data.p0 * 100)}%"></i><strong>${pct(half.data.p0, 0)}</strong></div>
              <div><span>1 gol</span><i style="width:${Math.max(2, half.data.p1 * 100)}%"></i><strong>${pct(half.data.p1, 0)}</strong></div>
              <div><span>2+ goles</span><i style="width:${Math.max(2, half.data.p2plus * 100)}%"></i><strong>${pct(half.data.p2plus, 0)}</strong></div>
            </div>
          </div>
        `).join("")}
      </div>
      <p class="panel-footnote">Reparto conservador 44/56. No modela el minuto exacto ni el tiempo añadido. Es una lectura del modelo, no una recomendación.</p>
    </section>
  `;
}

const COMBO_GROUPS = [
  { id: "result", label: "Resultado" },
  { id: "double", label: "Doble oportunidad" },
  { id: "goals", label: "Goles" },
  { id: "btts", label: "Ambos anotan" },
  { id: "corners", label: "Córners" },
  { id: "cards", label: "Tarjetas" },
];

function comboResultsHtml(a, selected) {
  if (!selected.length) {
    return `<div class="combo-empty"><strong>Elige 2–4 condiciones</strong><p>La probabilidad conjunta se calcula desde la matriz de marcadores. Córners y tarjetas usan independencia del modelo.</p></div>`;
  }
  const result = evaluateCombo(a, selected);
  const strong = result.probability >= 0.5 ? "pos" : result.probability < 0.2 ? "neg" : "";
  return `
    <div class="combo-summary">
      <div><span>Prob. conjunta</span><strong class="${strong}">${pct(result.probability)}</strong><small>${result.exact ? "exacta desde la matriz" : "mixta: matriz + independencia"}</small></div>
      <div><span>Prob. de fallo</span><strong>${pct(result.complement)}</strong><small>1 − probabilidad conjunta</small></div>
      <div><span>Condiciones</span><strong>${result.ids.length}</strong><small>${result.hasIndependentLegs ? "incluye córners o tarjetas" : "solo goles y resultado"}</small></div>
      <div><span>Correlación</span><strong>${result.exact ? "Exacta" : "Mixta"}</strong><small>${result.exact ? "matriz de marcadores" : "matriz + independencia"}</small></div>
    </div>
    ${result.warnings.length ? `<ul class="combo-warnings">${result.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}
    <p class="combo-note">${escapeHtml(result.correlation)}</p>
  `;
}

function renderCombo(a) {
  const legs = a.comboLegs || [];
  const selected = new Set(state.combo);
  const result = selected.size ? evaluateCombo(a, state.combo) : null;
  return `
    <section class="panel combo-panel" id="combo-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Escenarios</span><h2>Combina condiciones</h2></div>
        <button type="button" class="panel-info" data-explain="scenarios" aria-label="Cómo se calcula la probabilidad conjunta">i</button>
      </div>
      <div class="combo-groups">
        ${COMBO_GROUPS.map((group) => {
          const groupLegs = legs.filter((leg) => leg.group === group.id);
          if (!groupLegs.length) return "";
          return `
            <div class="combo-group">
              <span class="combo-group-label">${group.label}</span>
              <div class="combo-chips">
                ${groupLegs.map((leg) => `
                  <button type="button" class="combo-chip ${selected.has(leg.id) ? "is-active" : ""}" data-combo="${leg.id}" aria-pressed="${selected.has(leg.id)}" title="${escapeHtml(leg.label)} · ${pct(leg.p)}">
                    <span>${escapeHtml(leg.short)}</span>
                    <strong>${pct(leg.p, 0)}</strong>
                  </button>
                `).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>
      ${selected.size ? `
        <div class="combo-legs">
          ${result.legs.map((leg) => `
            <div class="combo-leg">
              <span class="combo-leg-label">${escapeHtml(leg.label)}</span>
              <span class="combo-leg-prob">${pct(leg.p)}</span>
              <span class="combo-leg-kind">${leg.kind === "goal" ? "matriz" : "independiente"}</span>
              <button type="button" class="combo-remove" data-combo-remove="${leg.id}" aria-label="Quitar ${escapeHtml(leg.label)}">×</button>
            </div>
          `).join("")}
        </div>
      ` : ""}
      <div class="combo-controls">
        <button type="button" class="ghost-btn" id="combo-clear" ${selected.size ? "" : "disabled"}>Limpiar</button>
        <span class="combo-count">${selected.size}/4 condiciones</span>
      </div>
      <div id="combo-results" aria-live="polite">${comboResultsHtml(a, state.combo)}</div>
      <p class="panel-footnote">Las condiciones del mismo partido están correlacionadas. La matriz ya incorpora esa correlación para 1X2, goles y BTTS; córners y tarjetas se combinan por independencia. Es una lectura del modelo, no una recomendación.</p>
    </section>
  `;
}

function updateComboResults() {
  const a = state.analysis;
  const results = $("#combo-results");
  if (!a || !results) return;
  results.innerHTML = comboResultsHtml(a, state.combo);
}

function modelHits() {
  const h = MODEL_REPORT?.headline;
  if (!h?.n) return null;
  return {
    n: h.n,
    hits: h.hits,
    rate: h.accuracy,
    currentStreak: h.currentStreak,
    bestStreak: h.bestStreak,
    skill: h.skill,
    byLeague: (MODEL_REPORT.byLeague || []).map((league) => ({
      name: league.name,
      n: league.n,
      hits: league.hits,
      rate: league.accuracy,
    })),
    recent: (h.recent || []).map((row) => ({
      ...row,
      leagueName: MODEL_LEAGUE_NAMES[row.leagueId] || row.leagueId,
      pickLabel: RESULT_LABELS[row.predicted] || row.predicted,
      actualLabel: RESULT_LABELS[row.actual] || row.actual,
      probability: row.probs?.[row.predicted] ?? null,
    })),
  };
}

function renderHits(source = null) {
  const h = source || modelHits();
  if (!h?.n) return "";
  const ensemble = !source;
  const rate = h.rate;
  const leagueRows = [...(h.byLeague || [])]
    .sort((a, b) => b.n - a.n)
    .map((league) => `
      <tr>
        <td>${escapeHtml(league.name)}</td>
        <td>${league.hits}/${league.n}</td>
        <td class="${league.rate >= 0.5 ? "pos" : league.rate < 0.42 ? "neg" : ""}">${pct(league.rate, 1)}</td>
        <td>${league.n}</td>
      </tr>
    `).join("");
  const recentRows = (h.recent || []).slice(0, 8).map((row) => `
    <li class="hit-row ${row.hit ? "is-hit" : "is-miss"}">
      <span class="hit-badge" aria-hidden="true">${row.hit ? "✓" : "×"}</span>
      <span class="hit-teams">
        <strong>${escapeHtml(row.homeName)} <b>${row.homeGoals}-${row.awayGoals}</b> ${escapeHtml(row.awayName)}</strong>
        <small>${escapeHtml(row.leagueName)} · ${escapeHtml(formatDate(row.date).day)}</small>
      </span>
      <span class="hit-pick">
        <small>Pronóstico ${escapeHtml(row.pickLabel)} · ${row.probability != null ? pct(row.probability, 0) : "—"}</small>
        <strong>${escapeHtml(row.actualLabel)}</strong>
      </span>
    </li>
  `).join("");
  return `
    <section class="hits-hero" id="hits-section">
      <div class="hits-copy">
        <span class="eyebrow">${ensemble ? "Detalle de aciertos" : "Seguimiento · 1X2"}</span>
        <h3>Total de aciertos</h3>
        <p>${h.hits} de ${plural(h.n, "partido jugado", "partidos jugados")} coinciden con el signo más probable. ${ensemble ? "La revisión se aplicó una sola vez a partidos ya jugados de dos ligas, sin ajustes posteriores." : "Cada pronóstico se calculó solo con información anterior al partido."}</p>
        <div class="hits-meter" aria-hidden="true"><i style="width:${(rate * 100).toFixed(1)}%"></i></div>
        <div class="hits-meta">
          <span>Racha actual <strong>${h.currentStreak ?? 0}</strong></span>
          <span>Mejor racha <strong>${h.bestStreak ?? 0}</strong></span>
          ${ensemble && Number.isFinite(h.skill) ? `<span>Skill <strong>${h.skill >= 0 ? "+" : ""}${(h.skill * 100).toFixed(1)}%</strong></span>` : ""}
        </div>
      </div>
    </section>
    <div class="hits-stats">
      <div><span>Partidos</span><strong>${h.n}</strong></div>
      <div><span>Aciertos</span><strong>${h.hits}</strong></div>
      <div><span>Racha actual</span><strong>${h.currentStreak ?? 0}</strong></div>
      <div><span>Mejor racha</span><strong>${h.bestStreak ?? 0}</strong></div>
    </div>
    <div class="hits-grid">
      <div class="hits-panel">
        <div class="hits-panel-head"><h4>Por liga</h4><span>aciertos 1X2</span></div>
        <div class="table-scroll">
          <table class="precision-table hits-table">
            <thead><tr><th>Liga</th><th>Aciertos</th><th>Tasa</th><th>N</th></tr></thead>
            <tbody>${leagueRows}</tbody>
          </table>
        </div>
      </div>
      <div class="hits-panel">
        <div class="hits-panel-head"><h4>Últimos partidos</h4><span>pronóstico vs resultado</span></div>
        <ul class="hit-list">${recentRows}</ul>
      </div>
    </div>
    <p class="hits-note">${ensemble ? "Muestra histórica: 1.504 partidos de dos ligas. Estos porcentajes describen aciertos pasados; no son pronósticos ni una garantía de resultados futuros. No miden goles, ambos anotan ni córners." : "Seguimiento histórico: el pronóstico es el signo 1X2 más probable en cada partido ya jugado. No son pronósticos publicados ni una recomendación. Esta tasa no mide goles, ambos anotan ni córners."}</p>
  `;
}

function latentCrest(row) {
  const logo = row.logo
    ? `<img src="${escapeHtml(localCrest(row.logo))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
    : "";
  return `<span class="latent-crest${logo ? " has-logo" : ""}"><span class="latent-crest-abbr">${escapeHtml(row.short || "—")}</span>${logo}</span>`;
}

function streakDots(sequence, limit = 5) {
  const labels = { W: "G", D: "E", L: "P" };
  return `<span class="streak-dots">${(sequence || []).slice(0, limit).map((result) => `
    <i class="streak-${String(result).toLowerCase()}">${labels[result] || "·"}</i>
  `).join("")}</span>`;
}

function upsetReason(row) {
  const reasons = [];
  if (row.winnerVenue === "home") reasons.push("localía");
  if (row.winnerStreak?.includes("victorias")) reasons.push("racha ganadora");
  if (row.restWinner != null && row.restLoser != null && row.restWinner - row.restLoser >= 3) reasons.push("más descanso");
  const loserGoals = row.winnerVenue === "home" ? row.awayGoals : row.homeGoals;
  if (loserGoals === 0) reasons.push("portería a cero");
  if (Math.abs(row.homeGoals - row.awayGoals) === 1) reasons.push("margen de un gol");
  if (row.loserForm?.startsWith("L")) reasons.push("favorito en mal momento");
  return reasons.slice(0, 3).join(" · ") || "Partido cerrado";
}

function latentFilteredRows() {
  return (LATENT?.midTable || []).filter((row) => state.latentLeague === "all" || row.leagueId === state.latentLeague);
}

function latentCountLabel() {
  const rows = latentFilteredRows();
  return `${rows.length} equipos · ${rows.filter((row) => row.next).length} con próximo partido`;
}

function latentRowHtml(row) {
  const support = row.support || {
    score: 0,
    label: "Sin muestra",
    tone: "neutral",
    note: "No hay casos suficientes.",
    sample: 0,
  };
  const tone = support.tone || "neutral";
  const next = row.next
    ? `<strong>${row.next.venue === "home" ? "Recibe a" : "Visita a"} ${escapeHtml(row.next.opponentShort)}</strong>
       <small>${escapeHtml(formatDate(row.next.date).day)} · rival ${row.next.opponentPos ? `${row.next.opponentPos}º` : "sin posición"}</small>`
    : `<span class="muted">Sin partido en la ventana</span>`;
  const last = row.last10 || {};
  return `
    <tr>
      <td data-label="Equipo">
        <div class="latent-team">
          ${latentCrest(row)}
          <div>
            <strong>${escapeHtml(row.team)}</strong>
            <small>Puesto ${row.pos}º · ${row.pts} pts · ${num(row.ppg, 2)} por partido</small>
          </div>
        </div>
      </td>
      <td data-label="Racha actual">
        <span class="latent-streak">${escapeHtml(row.streak?.label || "Sin muestra")}</span>
        ${streakDots(last.sequence)}
      </td>
      <td data-label="Últimos 10 partidos">
        <strong class="latent-record">${last.w ?? 0}-${last.d ?? 0}-${last.l ?? 0}</strong>
        <small>${last.w ?? 0} victorias · ${last.d ?? 0} empates · ${last.l ?? 0} derrotas</small>
        <small>${last.points ?? 0} pts · ${num(last.ppg ?? 0, 2)} por partido</small>
      </td>
      <td data-label="Próximo partido">${next}</td>
      <td data-label="Señal de contexto">
        <div class="support-pill ${tone}"><span class="support-caption">Señal</span><strong>${support.score}</strong><span>${escapeHtml(support.label)}</span></div>
        <div class="support-bar" aria-hidden="true"><i class="${tone}" style="width:${support.score}%"></i></div>
        <small>${escapeHtml(support.note)}</small>
        <small>${support.sample} casos parecidos · ${pct(support.winRate ?? 0, 0)} de victorias (habitual ${pct(support.baseline ?? 0, 0)})</small>
      </td>
    </tr>
  `;
}

function latentRowsHtml() {
  const rows = latentFilteredRows();
  if (!rows.length) {
    return `<tr><td colspan="5" class="latent-empty">No hay equipos latentes para este filtro.</td></tr>`;
  }
  return rows.map(latentRowHtml).join("");
}

function renderLatent() {
  if (!latentReady) {
    return `
      <div class="validation-empty">
        <span class="eyebrow">Sin muestra</span>
        <h3>Los equipos latentes necesitan datos live</h3>
        <p>El análisis reconstruye posiciones y rachas con resultados anteriores. Con datos de respaldo o propios no hay una muestra histórica comparable.</p>
        <code>node datos_live.mjs</code>
      </div>
    `;
  }
  const l = LATENT;
  const s = l.summary || {};
  const u = l.upsets || {};
  const leagues = [...new Map((l.midTable || []).map((row) => [row.leagueId, row.leagueName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const options = leagues
    .map(([id, name]) => `<option value="${escapeHtml(id)}"${state.latentLeague === id ? " selected" : ""}>${escapeHtml(name)}</option>`)
    .join("");
  const examples = (u.examples || []).slice(0, 10).map((row) => `
    <tr>
      <td>${escapeHtml(formatDate(row.date).day)}<small>${escapeHtml(row.leagueName)}</small></td>
      <td><strong>${escapeHtml(row.winner)}</strong><small> venció a ${escapeHtml(row.loser)}</small></td>
      <td>${row.homeGoals}-${row.awayGoals}</td>
      <td>Puesto ${row.winnerPos}º sobre el ${row.loserPos}º</td>
      <td>${escapeHtml(upsetReason(row))}</td>
    </tr>
  `).join("");
  const baseline = s.overallWinRate || 0;
  const streakCards = (l.streakStats || []).filter((row) => row.n > 0).map((row) => {
    const tone = row.winRate > baseline + 0.03 ? "pos" : row.winRate < baseline - 0.03 ? "neg" : "neutral";
    return `
      <div class="streak-card ${tone}">
        <div class="streak-card-head"><strong>${escapeHtml(row.label)}</strong><span>${row.n} casos</span></div>
        <div class="streak-card-bar" aria-hidden="true">
          <i class="win" style="width:${(row.winRate * 100).toFixed(1)}%"></i>
          <i class="draw" style="width:${(row.drawRate * 100).toFixed(1)}%"></i>
          <b style="left:${(baseline * 100).toFixed(1)}%"></b>
        </div>
        <div class="streak-card-rates">
          <span class="pos">Ganó ${pct(row.winRate, 0)}</span>
          <span>Empató ${pct(row.drawRate, 0)}</span>
          <span class="neg">Perdió ${pct(row.lossRate, 0)}</span>
        </div>
        <p>${escapeHtml(row.reading)}</p>
      </div>
    `;
  }).join("");
  return `
    <section class="latent-hero">
      <div class="latent-hero-copy">
        <span class="eyebrow">Tercio medio · ${s.leagues ?? 0} ligas</span>
        <h3>Cómo les va a los equipos de mitad de tabla</h3>
        <p>Revisamos su racha actual y lo que ocurrió después en casos parecidos. La señal sirve para ordenar el contexto; no es una probabilidad ni una recomendación.</p>
      </div>
      <div class="latent-kpis">
        <div><strong>${s.midTableTeams ?? 0}</strong><span>equipos observados</span></div>
        <div><strong>${s.upsets ?? 0}</strong><span>sorpresas</span></div>
        <div><strong>${pct(s.overallWinRate ?? 0, 0)}</strong><span>victorias habituales</span></div>
      </div>
    </section>
    <div class="latent-toolbar">
      <label class="latent-select"><span>Liga</span>
        <select id="latent-league">
          <option value="all"${state.latentLeague === "all" ? " selected" : ""}>Todas</option>
          ${options}
        </select>
      </label>
      <span class="latent-count" id="latent-count">${latentCountLabel()}</span>
      <span class="latent-legend"><i class="pos"></i> apoyo <i class="neutral"></i> neutral <i class="neg"></i> cautela</span>
    </div>
    <p class="latent-guide">
      <span><i class="pos"></i><strong>Apoyo:</strong> el contexto y la racha acompañan.</span>
      <span><i class="neutral"></i><strong>Neutral:</strong> no hay una ventaja clara.</span>
      <span><i class="neg"></i><strong>Cautela:</strong> conviene esperar.</span>
    </p>
    <div class="table-scroll latent-table-wrap">
      <table class="latent-table">
        <thead><tr><th>Equipo</th><th>Racha actual</th><th>Últimos 10 partidos</th><th>Próximo partido</th><th>Señal de contexto</th></tr></thead>
        <tbody id="latent-rows">${latentRowsHtml()}</tbody>
      </table>
    </div>
    <section class="latent-section">
      <div class="latent-section-head">
        <div><span class="eyebrow">Sorpresas</span><h4>Cuando la tabla se rompe</h4></div>
        <span>${u.count ?? 0} casos · equipos de abajo que vencen a los de arriba</span>
      </div>
      <div class="upset-stats">
        <div><strong>${u.count ?? 0}</strong><span>casos revisados</span></div>
        <div><strong>${pct(u.homeShare ?? 0, 0)}</strong><span>ganó quien jugaba en casa</span></div>
        <div><strong>${pct(u.oneGoalShare ?? 0, 0)}</strong><span>ganaron por un gol</span></div>
        <div><strong>${pct(u.cleanSheetShare ?? 0, 0)}</strong><span>sin recibir goles</span></div>
        <div><strong>${pct(u.winnerStreakShare ?? 0, 0)}</strong><span>venía en racha</span></div>
      </div>
      <ul class="upset-patterns">${(u.patterns || []).map((pattern) => `<li>${escapeHtml(pattern)}</li>`).join("")}</ul>
      <div class="table-scroll">
        <table class="precision-table upset-table">
          <thead><tr><th>Fecha</th><th>Ganador</th><th>Resultado</th><th>Puestos</th><th>Contexto del caso</th></tr></thead>
          <tbody>${examples}</tbody>
        </table>
      </div>
      <p class="latent-footnote">Las señales describen el contexto del caso; no demuestran causalidad. Una sorpresa puede explicarse por expulsiones, errores puntuales o decisiones tácticas que la tabla no recoge.</p>
    </section>
    <section class="latent-section">
      <div class="latent-section-head">
        <div><span class="eyebrow">Rachas</span><h4>Resultados después de cada racha</h4></div>
        <span>${s.streakSamples ?? 0} casos con racha previa</span>
      </div>
      <p class="latent-section-copy">Cada tarjeta muestra qué pasó en el siguiente partido tras una racha concreta. La línea marca el ${pct(baseline, 0)} de victorias habitual en esta muestra.</p>
      <div class="streak-grid">${streakCards}</div>
    </section>
    <p class="precision-foot">Lectura descriptiva de ${s.midTableTeams ?? 0} equipos en ${s.leagues ?? 0} ligas y ${s.streakSamples ?? 0} casos de racha. No es una predicción ni una garantía.</p>
  `;
}

function renderLatentRows() {
  const tbody = $("#latent-rows");
  if (tbody) tbody.innerHTML = latentRowsHtml();
  const count = $("#latent-count");
  if (count) count.textContent = latentCountLabel();
}

function goalScore(text) {
  const match = String(text || "").match(/^[^!]*!\s*.+?\s+(\d+),\s*.+?\s+(\d+)\./);
  return match ? `${match[1]}-${match[2]}` : "";
}

function playerTimelineLabel(kind) {
  const labels = {
    goal: "Gol",
    penalty: "Penal",
    "own-goal": "Autogol",
    yellow: "Amarilla",
    red: "Roja",
    sub: "Cambio",
    "penalty-miss": "Penal fallado",
  };
  return labels[kind] || "Evento";
}

function playerStatsHtml(stats) {
  if (!stats?.hasStats) {
    return `<p class="player-empty">ESPN no publica estadísticas de equipo para este partido. La lectura se apoya en el marcador y la cronología.</p>`;
  }
  return `
    <div class="player-stat-grid">
      <div><span>Posesión</span><strong>${stats.possession}%</strong></div>
      <div><span>Remates</span><strong>${stats.shots}</strong><small>${stats.shotsOnTarget} a puerta</small></div>
      <div><span>Córners</span><strong>${stats.corners}</strong></div>
      <div><span>Tarjetas</span><strong>${stats.yellow + stats.red}</strong><small>${stats.red} rojas</small></div>
      <div><span>Paradas</span><strong>${stats.saves}</strong></div>
      <div><span>Pases</span><strong>${stats.passPct}%</strong><small>${stats.passes}</small></div>
    </div>
  `;
}

function playerTableHtml(players) {
  if (!players?.length) {
    return `<p class="player-empty">ESPN no publica una plantilla con estadísticas individuales para este partido.</p>`;
  }
  return `
    <div class="table-scroll">
      <table class="player-table">
        <thead><tr><th>Jugador</th><th>PJ</th><th>G/A</th><th>Remates</th><th>Índice</th></tr></thead>
        <tbody>
          ${players.slice(0, 8).map((player) => `
            <tr>
              <td><strong>${escapeHtml(player.name)}</strong><small>${escapeHtml(player.pos || "—")}${player.jersey ? ` · #${escapeHtml(player.jersey)}` : ""}</small></td>
              <td>${player.matches}</td>
              <td>${player.goals}/${player.assists}</td>
              <td>${player.shots}<small>${player.onTarget} a puerta</small></td>
              <td><span class="player-impact ${player.impact >= 10 ? "pos" : player.impact < 4 ? "neg" : ""}">${num(player.impact, 1)}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function playerTimelineHtml(form, team) {
  const latest = form.matches?.[0];
  if (!latest?.timeline?.length) {
    return `<p class="player-empty">ESPN no publica una cronología de eventos para este partido.</p>`;
  }
  return `
    <details class="player-timeline">
      <summary><span>Cronología del último partido</span><strong>${latest.venue === "home" ? "vs" : "@"} ${escapeHtml(latest.rivalName)} · ${escapeHtml(latest.score)}</strong></summary>
      <ol class="timeline-list">
        ${latest.timeline.map((event) => {
          const own = String(event.teamId) === String(team.espnId);
          const detail = event.kind === "sub"
            ? event.assist ? ` por ${event.assist}` : ""
            : event.assist ? ` · asistencia de ${event.assist}` : "";
          const score = ["goal", "penalty", "own-goal"].includes(event.kind)
            ? event.score || goalScore(event.text)
            : "";
          return `
            <li class="timeline-item is-${event.kind}${own ? " is-own" : " is-rival"}">
              <span class="timeline-minute">${escapeHtml(event.minute || "—")}</span>
              <span class="timeline-kind">${playerTimelineLabel(event.kind)}</span>
              <div class="timeline-body">
                <strong>${escapeHtml(event.player || event.teamName || "Evento")}${escapeHtml(detail)}${score ? ` <em class="timeline-score">${score}</em>` : ""}</strong>
                ${event.teamName && event.player ? `<p>${escapeHtml(event.teamName)}</p>` : ""}
              </div>
            </li>
          `;
        }).join("")}
      </ol>
    </details>
  `;
}

function playerTeamHtml(side, team) {
  const form = team.playerForm;
  if (!form?.sample) {
    return `
      <div class="player-team is-empty">
        <div class="player-team-head">
          ${crest(team, "xs")}
          <div><strong>${escapeHtml(team.short)}</strong><span>Sin resumen reciente</span></div>
        </div>
        <p class="player-empty">No hay un resumen de jugadores disponible para este equipo.</p>
      </div>
    `;
  }
  const summary = form.summary || {};
  const latest = form.matches?.[0];
  return `
    <div class="player-team ${side}">
      <div class="player-team-head">
        ${crest(team, "xs")}
        <div><strong>${escapeHtml(team.short)}</strong><span>${summary.wins ?? 0}V ${summary.draws ?? 0}E ${summary.losses ?? 0}D · ${summary.goals ?? 0}-${summary.conceded ?? 0} goles</span></div>
        <span class="player-sample">${matchesLabel(form.sample)}</span>
      </div>
      <p class="player-story">${escapeHtml(summary.story || "Sin relato disponible.")}</p>
      ${latest?.stats?.hasStats ? playerStatsHtml(latest.stats) : ""}
      ${playerTableHtml(form.players)}
      ${playerTimelineHtml(form, team)}
    </div>
  `;
}

function renderPlayerForm(a) {
  const sides = [
    { side: "home", team: a.home, form: a.home.playerForm },
    { side: "away", team: a.away, form: a.away.playerForm },
  ].filter((item) => item.form?.sample > 0);
  if (!sides.length) {
    return `
      <section class="panel player-form-panel empty-panel">
        <div class="panel-head">
          <div><span class="eyebrow">Jugadores</span><h2>Quién rindió y por qué</h2></div>
          <button type="button" class="panel-info" data-explain="playerForm" aria-label="Cómo se lee el rendimiento de jugadores">i</button>
        </div>
        <p class="empty-copy">ESPN no publica un resumen reciente de jugadores para este partido. Para no inventar estadísticas, la cronología queda vacía.</p>
      </section>
    `;
  }
  return `
    <section class="panel player-form-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Jugadores</span><h2>Quién rindió y por qué</h2></div>
        <button type="button" class="panel-info" data-explain="playerForm" aria-label="Cómo se lee el rendimiento de jugadores">i</button>
      </div>
      <p class="player-source">Cronología reconstruida con el resumen público de ESPN (boxscore, rosters y keyEvents). No se usa Google como fuente ni se inventan estadísticas ausentes.</p>
      <div class="player-teams">${sides.map(({ side, team }) => playerTeamHtml(side, team)).join("")}</div>
      <p class="panel-footnote">El índice NOX es descriptivo: 5×gol + 3×asistencia + 1.5×remate a puerta + 0.4×remate + titularidad − tarjetas. No es una calificación oficial ni una probabilidad.</p>
    </section>
  `;
}

function calibrationBinsBlock(bins, title) {
  const visible = (bins || []).filter((bin) => bin.n >= 3);
  if (!visible.length) return "";
  return `
    <div class="calibration-block">
      <h4>${escapeHtml(title)}</h4>
      <div class="calibration-rows">
        ${visible.map((bin) => `
          <div class="calibration-row">
            <span>${Math.round(bin.from * 100)}–${Math.round(bin.to * 100)}%</span>
            <i style="--pred:${bin.predicted * 100}%;--obs:${bin.observed * 100}%"></i>
            <strong>${pct(bin.predicted, 0)} / ${pct(bin.observed, 0)}</strong>
            <small>${bin.n}</small>
          </div>
        `).join("")}
      </div>
      <p class="calibration-key"><span class="pred"></span> predicho <span class="obs"></span> observado</p>
    </div>
  `;
}

function coverageBlock(bins, total) {
  const visible = (bins || []).filter((bin) => bin.n >= 1).sort((a, b) => b.from - a.from);
  if (!visible.length || !total) return "";
  const aggregate = (threshold) => {
    const selected = (bins || []).filter((bin) => bin.from >= threshold - 1e-9);
    const n = selected.reduce((sum, bin) => sum + bin.n, 0);
    if (!n) return null;
    const hits = selected.reduce((sum, bin) => sum + bin.n * bin.observed, 0);
    return { n, coverage: n / total, accuracy: hits / n };
  };
  const high80 = aggregate(0.8);
  const mid70 = aggregate(0.7);
  const mid60 = aggregate(0.6);
  const base50 = aggregate(0.5);
  const rows = visible.map((bin) => `
    <tr class="${bin.from >= 0.8 ? "is-high" : bin.from >= 0.7 ? "is-mid" : ""}${bin.n < 3 ? " is-sparse" : ""}">
      <td>${Math.round(bin.from * 100)}–${Math.round(bin.to * 100)}%</td>
      <td>${bin.n}</td>
      <td>${pct(bin.n / total, 1)}</td>
      <td>${pct(bin.observed, 1)}</td>
      <td>${pct(bin.predicted, 1)}</td>
    </tr>
  `).join("");
  const callouts = [
    high80 ? `<div><span>Umbral ≥ 80%</span><strong>${pct(high80.accuracy, 1)}</strong><small>${high80.n} partidos · ${pct(high80.coverage, 1)} cobertura</small></div>` : "",
    mid70 ? `<div><span>Umbral ≥ 70%</span><strong>${pct(mid70.accuracy, 1)}</strong><small>${mid70.n} partidos · ${pct(mid70.coverage, 1)} cobertura</small></div>` : "",
    mid60 ? `<div><span>Umbral ≥ 60%</span><strong>${pct(mid60.accuracy, 1)}</strong><small>${mid60.n} partidos · ${pct(mid60.coverage, 1)} cobertura</small></div>` : "",
    base50 ? `<div><span>Umbral ≥ 50%</span><strong>${pct(base50.accuracy, 1)}</strong><small>${base50.n} partidos · ${pct(base50.coverage, 1)} cobertura</small></div>` : "",
  ].join("");
  const topBin = (bins || []).find((bin) => Math.abs(bin.from - 0.8) < 1e-9);
  const extraHigh = high80 && topBin ? high80.n - topBin.n : 0;
  const topNote = high80 && topBin
    ? `El tramo 80–90% acierta ${pct(topBin.observed, 1)} con ${topBin.n} partidos (${pct(topBin.n / total, 1)}).${extraHigh > 0 ? ` El agregado ≥80% suma ${plural(extraHigh, "partido", "partidos")} en 90–100% y queda en ${high80.n} partidos con ${pct(high80.accuracy, 1)}.` : ""}`
    : high80
      ? `El tramo ≥80% acierta ${pct(high80.accuracy, 1)} con ${high80.n} partidos (${pct(high80.coverage, 1)}).`
      : "";
  const coverageNote = high80 && mid70
    ? `El porcentaje de aciertos del 80%–90% se alcanza en el tramo selectivo de alta confianza (≥80%), donde el modelo acierta ${pct(high80.accuracy, 1)} sobre ${high80.n} partidos de test out-of-fold. ${topNote} A nivel global (100% de partidos), el techo estadístico del fútbol es 53%–57% debido a la varianza y los empates. El filtro 'Alta certeza (≥80%)' aísla estos partidos de máxima fiabilidad.`
    : "El modelo alcanza 80%–90% en partidos de alta confianza (≥80%). La tabla es del ensamble histórico en test out-of-fold; el filtro del sidebar usa la probabilidad del favorito en vivo.";
  return `
    <div class="precision-section coverage-section">
      <div class="precision-section-head"><h4>Cobertura vs. acierto</h4><span>1X2 · test · alta confianza</span></div>
      <div class="coverage-callouts">${callouts}</div>
      <div class="table-scroll">
        <table class="precision-table coverage-table">
          <thead><tr><th>Confianza del favorito</th><th>Partidos</th><th>Cobertura</th><th>Acierto</th><th>Predicho</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="panel-footnote">${coverageNote}</p>
    </div>
  `;
}

function renderModelReport() {
  const report = MODEL_REPORT;
  const h = report.headline;
  const marketBars = MODEL_MARKET_ORDER.map((id) => {
    const market = report.markets[id];
    if (!market?.n) return "";
    const tone = market.skill > 0.005 ? "pos" : market.skill < -0.005 ? "neg" : "neutral";
    return `
      <div class="precision-market-row">
        <span class="precision-market-name">${escapeHtml(MODEL_MARKET_LABELS[id])}</span>
        <span class="precision-market-track"><i class="${tone}" style="width:${(market.accuracy * 100).toFixed(1)}%"></i></span>
        <strong class="${tone}">${pct(market.accuracy, 1)}</strong>
        <small>${market.hits}/${market.n}</small>
      </div>
    `;
  }).join("");
  const bestMarket = MODEL_MARKET_ORDER
    .map((id) => ({ id, data: report.markets[id] }))
    .filter((entry) => entry.data?.n)
    .sort((a, b) => b.data.accuracy - a.data.accuracy)[0];
  const rateCell = (rate, skill) => `
    <td class="rate-cell">
      <span>${pct(rate, 1)}</span>
      <span class="precision-rate"><i class="${skill < -0.005 ? "neg" : ""}" style="width:${(Number(rate) * 100).toFixed(1)}%"></i></span>
    </td>
  `;
  const leagueRows = (report.byLeague || []).map((league) => `
    <tr>
      <td>${escapeHtml(league.name)}</td>
      <td>${league.hits}/${league.n}</td>
      ${rateCell(league.accuracy, league.skill)}
      <td>${num(league.brier, 3)}</td>
      <td class="${league.skill > 0 ? "pos" : league.skill < 0 ? "neg" : ""}">${league.skill >= 0 ? "+" : ""}${(league.skill * 100).toFixed(1)}%</td>
    </tr>
  `).join("");
  const seasonRows = (report.bySeason || []).map((season) => `
    <tr>
      <td>${escapeHtml(season.season)}</td>
      <td>${season.hits}/${season.n}</td>
      ${rateCell(season.accuracy, season.skill)}
      <td>${num(season.brier, 3)}</td>
      <td class="${season.skill > 0 ? "pos" : season.skill < 0 ? "neg" : ""}">${season.skill >= 0 ? "+" : ""}${(season.skill * 100).toFixed(1)}%</td>
    </tr>
  `).join("");
  return `
    <section class="precision-overview">
      <div class="precision-overview-copy">
        <span class="eyebrow">Lectura rápida · muestra histórica</span>
        <h3>${pct(h.accuracy, 1)} de aciertos en el signo 1X2</h3>
        <p>En ${plural(h.n, "partido evaluado", "partidos evaluados")}, el signo más probable coincidió con el resultado final ${h.hits} veces. Esta lectura se mantiene separada del seguimiento en vivo.</p>
      </div>
      <div class="precision-overview-badge">
        <strong>${pct(h.accuracy, 1)}</strong>
        <span>aciertos 1X2</span>
        <small>${h.hits} de ${h.n}</small>
      </div>
    </section>
    ${renderHits()}
    <div class="precision-highlights">
      <div>
        <span>Ventaja sobre la referencia</span>
        <strong class="pos">${h.skill >= 0 ? "+" : ""}${(h.skill * 100).toFixed(1)}%</strong>
        <small>Brier ${num(h.brier, 3)} frente a ${num(h.baseline.brier, 3)}</small>
      </div>
      <div>
        <span>Margen de confianza</span>
        <strong>${pct(h.ci.accuracy[0], 1)}–${pct(h.ci.accuracy[1], 1)}</strong>
        <small>rango probable de aciertos</small>
      </div>
      <div>
        <span>Mejor mercado</span>
        <strong>${bestMarket ? pct(bestMarket.data.accuracy, 1) : "—"}</strong>
        <small>${bestMarket ? escapeHtml(MODEL_MARKET_LABELS[bestMarket.id]) : "Sin muestra"}</small>
      </div>
    </div>
    <div class="precision-section">
      <div class="precision-section-head"><h4>Aciertos por mercado</h4><span>${plural(h.n, "partido", "partidos")} revisados</span></div>
      <div class="precision-market-list">${marketBars}</div>
      <p class="precision-inline-note">Cada barra muestra qué parte de los partidos se acertó en ese mercado. El detalle de aciertos aparece a la derecha.</p>
    </div>
    <div class="precision-section">
      <div class="precision-section-head"><h4>Por liga y temporada</h4><span>1X2 · partidos ya jugados</span></div>
      <div class="precision-split">
        <div class="table-scroll">
          <table class="precision-table">
            <thead><tr><th>Liga</th><th>Aciertos</th><th>Tasa</th><th>Brier</th><th>Ventaja</th></tr></thead>
            <tbody>${leagueRows}</tbody>
          </table>
        </div>
        <div class="table-scroll">
          <table class="precision-table">
            <thead><tr><th>Temporada</th><th>Aciertos</th><th>Tasa</th><th>Brier</th><th>Ventaja</th></tr></thead>
            <tbody>${seasonRows}</tbody>
          </table>
        </div>
      </div>
      <p class="precision-inline-note">La tasa es el porcentaje de aciertos. La ventaja compara el resultado con una referencia sencilla de la liga; los valores positivos indican mejor lectura.</p>
    </div>
    <p class="precision-foot">Muestra histórica de OX · generada ${escapeHtml(formatDate(report.generatedAt).day)} ${escapeHtml(formatDate(report.generatedAt).time)} · ${plural(h.n, "partido", "partidos")} revisados.</p>
  `;
}

function renderLiveValidationSummary() {
  if (!validationReady) return "";
  const v = VALIDATION;
  const one = v.overall?.markets?.["1x2"];
  const h = v.hits;
  if (!one || !h?.n) return "";
  const marketCards = MODEL_MARKET_ORDER.map((id) => {
    const market = v.overall.markets?.[id];
    if (!market?.n) return "";
    const tone = market.skill > 0.005 ? "pos" : market.skill < -0.005 ? "neg" : "neutral";
    return `
      <div class="precision-card">
        <span>${escapeHtml(MODEL_MARKET_LABELS[id])}</span>
        <strong class="${tone}">${(market.skill * 100).toFixed(1)}%</strong>
        <small>skill · Brier ${num(market.brier, 3)} vs ${num(market.baseline, 3)}</small>
        <em>${matchesLabel(market.n)}</em>
      </div>
    `;
  }).join("");
  return `
    <div class="precision-divider precision-secondary"><span>Motor Poisson en vivo · referencia</span><i></i></div>
    <div class="precision-section">
      <div class="precision-section-head"><h4>Backtest walk-forward con datos ESPN</h4><span>${v.sample?.leagues ?? "varias"} ligas</span></div>
      <div class="precision-grid live-metrics">
        <div class="precision-card"><span>Aciertos 1X2</span><strong>${pct(h.rate, 1)}</strong><small>${h.hits}/${h.n}</small><em>signo más probable</em></div>
        <div class="precision-card"><span>Skill Brier</span><strong class="${one.skill > 0 ? "pos" : one.skill < 0 ? "neg" : ""}">${one.skill >= 0 ? "+" : ""}${(one.skill * 100).toFixed(1)}%</strong><small>Brier ${num(one.brier, 4)} vs ${num(one.baseline, 4)}</small><em>vs base de liga</em></div>
        <div class="precision-card"><span>Muestra</span><strong>${v.overall.n}</strong><small>${matchesLabel(v.overall.n)}</small><em>walk-forward</em></div>
      </div>
      <div class="precision-grid">${marketCards}</div>
      <p class="panel-footnote">El Poisson + Dixon-Coles sigue siendo la referencia explicable y el fallback del ensamble. Este backtest live se actualiza con ESPN; no participa en el entrenamiento ni en la elección de pesos del ensamble.</p>
      <button type="button" class="text-link" data-explain="poissonValidation">Ver cálculo del Poisson en vivo <span>→</span></button>
    </div>
  `;
}

function renderValidation() {
  const sections = [];
  if (modelReady) sections.push(renderModelReport());
  if (!sections.length) {
    return `
      <div class="validation-empty">
        <span class="eyebrow">Sin muestra</span>
        <h3>La validación necesita datos</h3>
        <p>El ensamble se genera con el pipeline histórico y el backtest live se actualiza desde ESPN. No hay una muestra comparable disponible.</p>
        <code>python -m pipeline.models</code>
      </div>
    `;
  }
  return sections.join("");
}

function openValidation() {
  if (!validationModal) return;
  if (!latentModal.hidden) closeLatent(true);
  clearTimeout(state.validationTimer);
  state.lastValidationFocus = document.activeElement;
  validationContent.innerHTML = renderValidation();
  validationModal.hidden = false;
  validationBackdrop.hidden = false;
  document.body.classList.add("modal-open");
  validationContent.scrollTop = 0;
  void validationModal.offsetWidth;
  validationModal.classList.add("is-open");
  validationBackdrop.classList.add("is-open");
  $("#validation-close")?.focus({ preventScroll: true });
}

function closeValidation(immediate = false) {
  if (!validationModal || validationModal.hidden) return;
  clearTimeout(state.validationTimer);
  validationModal.classList.remove("is-open");
  validationBackdrop.classList.remove("is-open");
  document.body.classList.remove("modal-open");
  const finish = () => {
    if (!validationModal.classList.contains("is-open")) {
      validationModal.hidden = true;
      validationBackdrop.hidden = true;
    }
  };
  if (immediate) finish();
  else state.validationTimer = setTimeout(finish, 220);
  if (state.lastValidationFocus && typeof state.lastValidationFocus.focus === "function") {
    state.lastValidationFocus.focus({ preventScroll: true });
  }
  state.lastValidationFocus = null;
}

function renderRecord() {
  if (!recordReady) {
    return `
      <div class="validation-empty">
        <span class="eyebrow">Sin registro</span>
        <h3>El récord todavía no existe</h3>
        <p>Genera el registro con el productor live y vuelve a exportar el récord desde la base.</p>
        <code>npm run pronosticos</code>
      </div>
    `;
  }
  const r = RECORD;
  const hasScore = r.publishedScored > 0;
  const accuracy = hasScore && Number.isFinite(r.accuracy) ? pct(r.accuracy, 1) : "—";
  const ci = Array.isArray(r.ci95) ? `${pct(r.ci95[0], 1)}–${pct(r.ci95[1], 1)}` : "—";
  const meter = hasScore ? Math.max(0, Math.min(100, r.accuracy * 100)) : 0;
  const thresholdText = (r.thresholds || []).map((value) => pct(value, 0)).join(" / ") || "sin umbral";
  const publishedText = hasScore
    ? `${r.hits} de ${plural(r.publishedScored, "pick publicado", "picks publicados")} coinciden con el signo final.`
    : r.emptyReason || "Todavía no hay picks publicados con resultado.";
  const leagueRows = (r.byLeague || []).map((league) => `
    <tr>
      <td>${escapeHtml(league.leagueName || league.leagueId || "Sin liga")}</td>
      <td>${league.published}/${league.registered}</td>
      <td>${league.scored}</td>
      <td>${league.accuracy != null ? pct(league.accuracy, 1) : "—"}</td>
    </tr>
  `).join("");
  const recentRows = (r.recent || []).map((row) => `
    <li class="hit-row ${row.hit ? "is-hit" : "is-miss"}">
      <span class="hit-badge" aria-hidden="true">${row.hit ? "✓" : "×"}</span>
      <span class="hit-teams">
        <strong>${escapeHtml(row.home)} <b>${row.homeGoals ?? "—"}-${row.awayGoals ?? "—"}</b> ${escapeHtml(row.away)}</strong>
        <small>${escapeHtml(row.league || "Sin liga")} · ${escapeHtml(formatDate(row.kickoff).day)}</small>
      </span>
      <span class="hit-pick">
        <small>Pick ${escapeHtml(PICK_LABELS[row.pick] || row.pick)} · ${pct(row.confidence, 0)}</small>
        <strong>${escapeHtml(PICK_LABELS[row.result] || row.result || "—")}</strong>
      </span>
    </li>
  `).join("");
  return `
    <section class="hits-hero" id="record-section">
      <div class="hits-copy">
        <span class="eyebrow">Registro verificable · 1X2 · picks publicados</span>
        <h3>Récord del motor</h3>
        <p>${escapeHtml(publishedText)} Cada pick se guardó antes del kickoff con hash SHA-256 y se cierra con el resultado oficial.</p>
        <div class="hits-meter" aria-hidden="true"><i style="width:${meter.toFixed(1)}%"></i></div>
        <div class="hits-meta">
          <span><strong>${accuracy}</strong> de acierto</span>
          <span>IC95 <strong>${ci}</strong></span>
          <span>Brier <strong>${r.brier != null ? num(r.brier, 3) : "—"}</strong></span>
          <span>Cobertura <strong>${pct(r.coverage, 1)}</strong></span>
        </div>
      </div>
      <div class="hits-big">
        <strong>${accuracy}</strong>
        <span>${r.hits}/${r.publishedScored}</span>
      </div>
    </section>
    <div class="hits-stats">
      <div><span>Registrados</span><strong>${r.registered}</strong></div>
      <div><span>Publicados</span><strong>${r.published}</strong></div>
      <div><span>Reconciliados</span><strong>${r.publishedScored}</strong></div>
      <div><span>Pendientes</span><strong>${r.pending}</strong></div>
    </div>
    ${r.emptyReason ? `<p class="record-note">${escapeHtml(r.emptyReason)}</p>` : ""}
    <div class="hits-grid">
      <div class="hits-panel">
        <div class="hits-panel-head"><h4>Por liga</h4><span>publicados / registrados</span></div>
        ${leagueRows ? `
          <table class="hits-table">
            <thead><tr><th>Liga</th><th>Picks</th><th>Con resultado</th><th>Acierto</th></tr></thead>
            <tbody>${leagueRows}</tbody>
          </table>
        ` : `<p class="panel-footnote">Sin ligas registradas.</p>`}
      </div>
      <div class="hits-panel">
        <div class="hits-panel-head"><h4>Últimos picks</h4><span>resultado a 90 minutos</span></div>
        ${recentRows ? `<ul class="hit-list">${recentRows}</ul>` : `<p class="panel-footnote">Sin resultados reconciliados todavía. Los picks pendientes se cierran cuando termina el partido.</p>`}
      </div>
    </div>
    <div class="precision-section">
      <div class="precision-section-head"><h4>Cómo se mide</h4><span>sin edición manual</span></div>
      <p class="panel-footnote">
        Cobertura = ${escapeHtml(r.coverageBasis || "picks publicados / pronósticos registrados")}. El umbral de publicación es
        ${escapeHtml(thresholdText)}. Un pick solo cuenta si el snapshot se guardó antes del kickoff; los aplazados se excluyen
        y las correcciones de resultado se registran con su fecha de reconciliación.
      </p>
      <code class="record-pending">python -m pipeline.reconcile_results --results data/live_results.json</code>
    </div>
    <p class="precision-foot">
      Generado ${escapeHtml(formatTimestamp(r.generatedAt))} · Política ${escapeHtml(r.policy || "—")} ·
      Modelo ${escapeHtml((r.modelVersions || []).join(", ") || "—")} · ${r.registered} snapshots en la base.
    </p>
  `;
}

function openRecord() {
  if (!recordModal) return;
  if (!validationModal.hidden) closeValidation(true);
  if (!latentModal.hidden) closeLatent(true);
  clearTimeout(state.recordTimer);
  state.lastRecordFocus = document.activeElement;
  recordContent.innerHTML = renderRecord();
  recordModal.hidden = false;
  recordBackdrop.hidden = false;
  document.body.classList.add("modal-open");
  recordContent.scrollTop = 0;
  void recordModal.offsetWidth;
  recordModal.classList.add("is-open");
  recordBackdrop.classList.add("is-open");
  state.recordOpen = true;
  $("#record-close")?.focus({ preventScroll: true });
}

function closeRecord(immediate = false) {
  if (!recordModal || recordModal.hidden) return;
  clearTimeout(state.recordTimer);
  recordModal.classList.remove("is-open");
  recordBackdrop.classList.remove("is-open");
  document.body.classList.remove("modal-open");
  const finish = () => {
    if (!recordModal.classList.contains("is-open")) {
      recordModal.hidden = true;
      recordBackdrop.hidden = true;
    }
  };
  if (immediate) finish();
  else state.recordTimer = setTimeout(finish, 220);
  state.recordOpen = false;
  if (state.lastRecordFocus && typeof state.lastRecordFocus.focus === "function") {
    state.lastRecordFocus.focus({ preventScroll: true });
  }
  state.lastRecordFocus = null;
}

function openLatent() {
  if (!latentModal) return;
  if (!validationModal.hidden) closeValidation(true);
  clearTimeout(state.latentTimer);
  if (!state.latentLeagueChosen) {
    const leagueId = state.analysis?.league?.id;
    if (leagueId && LATENT?.midTable?.some((row) => row.leagueId === leagueId)) {
      state.latentLeague = leagueId;
    }
  }
  state.lastLatentFocus = document.activeElement;
  latentContent.innerHTML = renderLatent();
  latentModal.hidden = false;
  latentBackdrop.hidden = false;
  document.body.classList.add("modal-open");
  latentContent.scrollTop = 0;
  void latentModal.offsetWidth;
  latentModal.classList.add("is-open");
  latentBackdrop.classList.add("is-open");
  $("#latent-close")?.focus({ preventScroll: true });
}

function closeLatent(immediate = false) {
  if (!latentModal || latentModal.hidden) return;
  clearTimeout(state.latentTimer);
  latentModal.classList.remove("is-open");
  latentBackdrop.classList.remove("is-open");
  document.body.classList.remove("modal-open");
  const finish = () => {
    if (!latentModal.classList.contains("is-open")) {
      latentModal.hidden = true;
      latentBackdrop.hidden = true;
    }
  };
  if (immediate) finish();
  else state.latentTimer = setTimeout(finish, 220);
  if (state.lastLatentFocus && typeof state.lastLatentFocus.focus === "function") {
    state.lastLatentFocus.focus({ preventScroll: true });
  }
  state.lastLatentFocus = null;
}

function signedPoints(value, digits = 2) {
  const number = Number(value);
  return `${number >= 0 ? "+" : "−"}${Math.abs(number).toFixed(digits)}`;
}

function projectionTone(value) {
  return value > 0.02 ? "pos" : value < -0.02 ? "neg" : "neutral";
}

function shortProjectionDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

function teamUpcoming(teamId, currentMatch, analysis, side, limit = 3) {
  const currentMs = new Date(currentMatch?.date || Date.now()).getTime();
  const actual = MATCHES
    .filter((match) => !match.reference)
    .filter((match) => match.id !== currentMatch.id && (match.home === teamId || match.away === teamId))
    .filter((match) => new Date(match.date).getTime() > currentMs)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, limit)
    .map((match) => {
      const fixture = getAnalysis(match.id);
      if (!fixture) return null;
      return projectionFromAnalysis(fixture, match.home === teamId ? "home" : "away");
    })
    .filter(Boolean);

  const team = side === "home" ? analysis.home : analysis.away;
  const startVenue = side === "home" ? "away" : "home";
  const modeled = [];
  for (let i = actual.length; i < limit; i += 1) {
    const venue = i % 2 === 0 ? startVenue : startVenue === "home" ? "away" : "home";
    const week = i + 1;
    modeled.push(modeledProjection(team, analysis.league, {
      venue,
      date: new Date(currentMs + week * 7 * 86400000).toISOString(),
      temperature: analysis.engine?.temperature,
      opponentLabel: "Rival promedio",
      week,
    }));
  }
  return [...actual, ...modeled];
}

function projectionRowHtml(projection, { current = false, index = 0 } = {}) {
  const label = current ? "Este partido" : projection.modeled ? `Escenario ${index}` : `Próximo ${index}`;
  const badge = current
    ? ""
    : projection.modeled
      ? `<span class="projection-badge">modelado</span>`
      : `<span class="projection-badge is-real">calendario</span>`;
  const when = projection.modeled ? `Semana +${projection.week || index}` : shortProjectionDate(projection.date);
  const opponent = projection.opponent?.short || projection.opponent?.name || "Rival";
  return `
    <div class="projection-row ${current ? "is-current" : ""}" role="row"${current ? ' aria-current="true"' : ""}>
      <span class="projection-match" role="cell">
        <span class="projection-row-label">${label} ${badge}</span>
        <strong>vs ${escapeHtml(opponent)}</strong>
        <small>${escapeHtml(projection.venue)}${when ? ` · ${escapeHtml(when)}` : ""}</small>
      </span>
      <span class="projection-probs" role="cell" aria-label="Gana ${pct(projection.win)}; empata ${pct(projection.draw)}; pierde ${pct(projection.loss)}">
        <span><small>G</small>${pct(projection.win, 0)}</span>
        <span><small>E</small>${pct(projection.draw, 0)}</span>
        <span><small>P</small>${pct(projection.loss, 0)}</span>
      </span>
      <span class="projection-expected" role="cell"><strong>${num(projection.expected)}</strong><small>pts</small></span>
      <span class="projection-ve ${projectionTone(projection.ve)}" role="cell"><strong>${signedPoints(projection.ve)}</strong><small>VE</small></span>
    </div>
  `;
}

function projectionTeamHtml(current, upcoming) {
  const avgExpected = upcoming.length
    ? upcoming.reduce((sum, row) => sum + row.expected, 0) / upcoming.length
    : current.expected;
  const avgVe = upcoming.length
    ? upcoming.reduce((sum, row) => sum + row.ve, 0) / upcoming.length
    : current.ve;
  const positives = upcoming.filter((row) => row.ve > 0.02).length;
  const reading = avgVe > 0.05
    ? "Por encima de su referencia"
    : avgVe < -0.05
      ? "Por debajo de su referencia"
      : "En línea con su referencia";
  const baseline = current.baseline;
  return `
    <article class="projection-team" aria-label="Proyección de ${escapeHtml(current.team.short)}">
      <div class="projection-team-head">
        ${crest(current.team, "sm")}
        <div class="projection-team-name">
          <strong>${escapeHtml(current.team.short)}</strong>
          <span>${current.team.standing?.pos ? `${current.team.standing.pos}.º · ` : ""}${num(baseline.ppg)} PPG · ${escapeHtml(baseline.source)}</span>
        </div>
        <span class="projection-team-ve ${projectionTone(avgVe)}">${signedPoints(avgVe)}<small>VE medio</small></span>
      </div>
      <div class="projection-summary">
        <div><span>Puntos esperados</span><strong>${num(avgExpected)}</strong><small>próximos ${upcoming.length}</small></div>
        <div><span>Referencia C</span><strong>${num(baseline.ppg)}</strong><small>${escapeHtml(baseline.detail || baseline.source)}</small></div>
        <div><span>VE positivo</span><strong>${positives}/${upcoming.length}</strong><small>${escapeHtml(reading)}</small></div>
      </div>
      <div class="projection-table" role="table" aria-label="Valor esperado en puntos de ${escapeHtml(current.team.short)}">
        <div class="projection-row projection-head" role="row">
          <span role="columnheader">Partido</span>
          <span role="columnheader">Gana · Empata · Pierde</span>
          <span role="columnheader">Pts. esp.</span>
          <span role="columnheader">VE</span>
        </div>
        ${projectionRowHtml(current, { current: true })}
        ${upcoming.map((row, index) => projectionRowHtml(row, { index: index + 1 })).join("")}
      </div>
    </article>
  `;
}

function renderProjection(a) {
  const homeCurrent = projectionFromAnalysis(a, "home");
  const awayCurrent = projectionFromAnalysis(a, "away");
  if (!homeCurrent || !awayCurrent) {
    return `<p class="empty-copy">No hay probabilidades suficientes para proyectar puntos en este partido.</p>`;
  }
  const homeUpcoming = teamUpcoming(a.home.id, a.match, a, "home");
  const awayUpcoming = teamUpcoming(a.away.id, a.match, a, "away");
  const homeAvg = homeUpcoming.length
    ? homeUpcoming.reduce((sum, row) => sum + row.ve, 0) / homeUpcoming.length
    : homeCurrent.ve;
  const awayAvg = awayUpcoming.length
    ? awayUpcoming.reduce((sum, row) => sum + row.ve, 0) / awayUpcoming.length
    : awayCurrent.ve;
  const leader = homeAvg >= awayAvg ? a.home : a.away;
  const leaderAvg = Math.max(homeAvg, awayAvg);
  const reading = leaderAvg > 0.05
    ? `${leader.short} tiene el VE medio más alto de los próximos escenarios.`
    : leaderAvg < -0.05
      ? "Ambos equipos quedan por debajo de su referencia en los próximos escenarios."
      : "Los próximos escenarios están en línea con la referencia de ambos equipos.";
  return `
    <section class="panel projection-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Proyección</span><h2>Valor esperado en puntos</h2></div>
        <div class="panel-head-actions">
          <span class="panel-note">3 escenarios · solo puntos</span>
          <button type="button" class="panel-info" data-explain="projection" aria-label="Cómo se calcula el valor esperado en puntos">i</button>
        </div>
      </div>
      <div class="projection-formula">
        <div>
          <span class="eyebrow">Fórmula adaptada</span>
          <strong>VE = 3·P(gana) + 1·P(empata) + 0·P(pierde) − C</strong>
          <p>C es el PPG de referencia del equipo. Un VE positivo indica que el modelo espera más puntos que esa referencia.</p>
        </div>
        <div class="projection-reading">
          <span class="eyebrow">Lectura</span>
          <p>${escapeHtml(reading)}</p>
        </div>
      </div>
      <div class="projection-grid">
        ${projectionTeamHtml(homeCurrent, homeUpcoming)}
        ${projectionTeamHtml(awayCurrent, awayUpcoming)}
      </div>
      <p class="panel-footnote">El VE se mide en puntos de fútbol. La referencia C sale de la tabla (pts/PJ) o, si falta, de los últimos 10 resultados; el fallback es 1.35 PPG. Los escenarios posteriores usan un rival promedio de la liga y alternan la localía cuando el calendario disponible no trae el fixture confirmado; se marcan como «modelado».</p>
    </section>
  `;
}

function renderAnalysisPanel(a) {
  const tabs = [
    {
      id: "markets",
      label: "Probabilidades",
      explain: "markets",
      content: `${renderMetrics(a)}${renderMarketTable(a)}${renderTiebreak(a)}<div class="section-subtitle"><span>Calibración y calidad</span><small>Ajuste y precisión de OX</small></div>${renderEnginePanel(a)}${renderModelQuality(a)}`,
    },
    {
      id: "projection",
      label: "Proyección",
      explain: "projection",
      content: renderProjection(a),
    },
    {
      id: "goals",
      label: "Goles",
      explain: "distribution",
      content: `${renderDistribution(a)}${renderScoreMatrix(a)}${renderTiming(a)}`,
    },
    {
      id: "scenarios",
      label: "Escenarios",
      explain: "scenarios",
      content: renderCombo(a),
    },
  ];
  return renderTabbedPanel({
    group: "analysis",
    eyebrow: "Salidas del modelo",
    title: "Probabilidades, goles y proyección",
    note: `${num(a.metrics.goals.total)} goles esperados · OX`,
    tabs,
    active: state.tabs.analysis,
  });
}

function renderPlayersPanel(a) {
  return `
    <section class="panel tab-panel players-panel" data-panel-group="players">
      <div class="panel-head">
        <div><span class="eyebrow">Jugadores</span><h2>Reparto individual</h2></div>
        <div class="panel-head-actions">
          <span class="panel-note">xG/90 · minutos</span>
          <button type="button" class="panel-info" data-explain="methodology" aria-label="Cómo se calcula el reparto individual">i</button>
        </div>
      </div>
      <div class="panel-stack-body">
        ${renderScorers(a)}
        ${renderPlayerForm(a)}
      </div>
    </section>
  `;
}

function renderContextPanel(a) {
  const tabs = [
    {
      id: "read",
      label: "Lectura",
      explain: "confidence",
      content: `${renderContext(a)}${renderInsights(a)}${renderConfidence(a)}${renderFactors(a)}`,
    },
    {
      id: "data",
      label: "Datos",
      explain: "recentForm",
      content: `${renderFreshness(a)}${renderRecent(a)}${renderH2H(a)}${renderLeagueTable(a)}`,
    },
  ];
  return renderTabbedPanel({
    group: "context",
    eyebrow: "Contexto",
    title: "Lectura y datos",
    note: a.league.live ? "ESPN live" : a.league.demo ? "respaldo" : "datos propios",
    tabs,
    active: state.tabs.context,
  });
}

function renderUpcomingSection(a) {
  const currentId = a.match.id;
  const now = Date.now();
  const end = now + 7 * 24 * 60 * 60 * 1000;
  const upcoming = MATCHES
    .filter((match) => !match.reference && match.id !== currentId)
    .filter((match) => {
      const time = new Date(match.date).getTime();
      return Number.isFinite(time) && time >= now && time <= end;
    })
    .sort((x, y) => new Date(x.date) - new Date(y.date));

  if (!upcoming.length) return "";

  const groups = new Map();
  for (const match of upcoming) {
    const key = dateKey(match.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  }

  const days = [...groups.values()].map((dayMatches, index) => {
    const rows = dayMatches.map((match) => {
      const home = TEAMS[match.home];
      const away = TEAMS[match.away];
      const time = formatDate(match.date);
      return `
        <button type="button" class="upcoming-row" data-match-id="${match.id}" title="${escapeHtml(`${home.name} vs ${away.name} · ${match.competition} · ${match.venue}`)}">
          <span class="upcoming-time">${escapeHtml(time.time)}</span>
          <span class="upcoming-teams">
            <span>${crest(home, "xs")} ${escapeHtml(home.short)}</span>
            <span class="upcoming-vs">vs</span>
            <span>${crest(away, "xs")} ${escapeHtml(away.short)}</span>
          </span>
          <span class="upcoming-comp">${escapeHtml(match.competition)}</span>
        </button>
      `;
    }).join("");
    return `
      <details class="upcoming-day" ${index === 0 ? "open" : ""}>
        <summary>
          <span class="upcoming-day-name">${escapeHtml(dayHeading(dayMatches[0].date))}</span>
          <span class="upcoming-day-count">${matchesLabel(pad(dayMatches.length))}</span>
          <span class="upcoming-chevron" aria-hidden="true">›</span>
        </summary>
        <div class="upcoming-rows">${rows}</div>
      </details>
    `;
  }).join("");

  return `
    <section class="panel upcoming-panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Cartelera</span>
          <h2>Próximos 7 días</h2>
        </div>
        <div class="panel-head-actions">
          <span class="panel-note">${matchesLabel(pad(upcoming.length))} · ${groups.size} días</span>
          <button type="button" class="panel-link" data-action="week-filter">Ver en la lista</button>
        </div>
      </div>
      <div class="upcoming-days">${days}</div>
    </section>
  `;
}

function renderSimpleAnalysis(a) {
  const nf = (value, digits = 1) => Number.isFinite(Number(value)) ? num(value, digits) : "—";
  const ZONE_LABELS = {
    "Champions League": "Champions League",
    "Champions League qualifying": "Clasificación a Champions",
    "Conference League qualifying": "Clasificación a Conference League",
    "Eliminated": "Eliminado",
    "Europa League": "Europa League",
    "Europa League qualifying": "Clasificación a Europa League",
    "Knockout phase playoffs - seeded": "Playoffs de octavos · cabeza de serie",
    "Knockout phase playoffs - unseeded": "Playoffs de octavos",
    "Qualifies for MLS Cup Playoffs - Round One Best-of-3 series": "Playoffs MLS · primera ronda",
    "Qualifies for MLS Cup Playoffs - Wild Card Matches": "Playoffs MLS · comodín",
    "Qualifies for playoffs": "Clasifica a playoffs",
    "Qualifies for round of 16": "Clasifica a octavos",
    "Relegated": "Descenso",
    "Relegation": "Zona de descenso",
    "Relegation playoff": "Playoff de descenso",
    "Relegation playoffs": "Playoffs de descenso",
  };
  const goals = a.metrics.goals;
  const binary = a.binary || a.engine?.binary || {};
  const btts = a.btts ?? binary.btts ?? 0;
  const outcomes = [
    { label: a.home.short, value: a.probs.home },
    { label: "Empate", value: a.probs.draw },
    { label: a.away.short, value: a.probs.away },
  ].sort((left, right) => right.value - left.value);
  const leader = outcomes[0];
  const second = outcomes[1];
  const gap = Math.max(0, (leader.value - second.value) * 100);
  const topScore = a.topScores?.[0];
  const homeForm = a.engine?.form?.home?.points;
  const awayForm = a.engine?.form?.away?.points;
  const h2h = a.match?.h2h;
  const formValue = Number.isFinite(homeForm) && Number.isFinite(awayForm)
    ? `${a.home.short} ${homeForm} pts · ${a.away.short} ${awayForm} pts`
    : "Sin muestra suficiente";
  const h2hValue = h2h?.available
    ? `${h2h.played} ${h2h.played === 1 ? "partido" : "partidos"} · ${a.home.short} ${h2h.homeWins}, empates ${h2h.draws}, ${a.away.short} ${h2h.awayWins}`
    : "Sin muestra suficiente";

  const card = (label, value, note = "") => `
    <div class="simple-card">
      <span>${label}</span>
      <strong>${value}</strong>
      ${note ? `<small>${note}</small>` : ""}
    </div>
  `;
  const signal = (label, value) => `
    <div class="simple-signal">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
  const row = (label, value) => `
    <div class="simple-compare-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
  const personList = (items) => items.length
    ? `<ul class="simple-person-list">${items.map((item) => `
        <li>
          <span class="simple-person-name">${escapeHtml(item.name)}${item.meta ? ` <small>${escapeHtml(item.meta)}</small>` : ""}</span>
          ${item.value ? `<strong>${escapeHtml(item.value)}</strong>` : ""}
          ${item.detail ? `<small class="simple-person-detail">${escapeHtml(item.detail)}</small>` : ""}
        </li>
      `).join("")}</ul>`
    : `<p class="simple-empty">Sin datos disponibles</p>`;

  const scorersFor = (side) => {
    const modeled = a.players?.[side] || [];
    if (modeled.length) {
      return {
        label: "Con más probabilidad de anotar",
        items: modeled.slice(0, 3).map((player) => ({
          name: player.shortName || player.name,
          meta: player.pos || "",
          value: pct(player.p, 0),
          detail: "probabilidad de anotar",
        })),
      };
    }
    const recent = [...(a[side]?.playerForm?.players || a[side]?.players || [])]
      .sort((x, y) => (Number(y.goals) || 0) - (Number(x.goals) || 0)
        || (Number(y.impact) || 0) - (Number(x.impact) || 0)
        || (Number(y.shots) || 0) - (Number(x.shots) || 0));
    const scorers = recent.filter((player) => Number(player.goals) > 0);
    const hasScorers = scorers.length > 0;
    const selected = (hasScorers ? scorers : recent).slice(0, 3);
    return {
      label: hasScorers ? "Con más goles recientes" : "Con más participación reciente",
      items: selected.map((player) => ({
        name: player.shortName || player.name,
        meta: player.pos || "",
        value: hasScorers
          ? plural(Number(player.goals), "gol", "goles")
          : plural(Number(player.starts) || 0, "titularidad", "titularidades"),
        detail: plural(Number(player.matches) || 0, "partido", "partidos"),
      })),
    };
  };

  const defendersFor = (team) => {
    const list = [...(team?.playerForm?.players || team?.players || [])];
    return list
      .filter((player) => /^(CD|CB|LB|RB|SW|DM|DF|LWB|RWB|G)/i.test(String(player.pos || "")))
      .sort((x, y) => (Number(y.starts) || 0) - (Number(x.starts) || 0)
        || (Number(y.matches) || 0) - (Number(x.matches) || 0)
        || (Number(y.impact) || 0) - (Number(x.impact) || 0))
      .slice(0, 3)
      .map((player) => ({
        name: player.shortName || player.name,
        meta: player.pos === "G" ? "POR" : (player.pos || ""),
        value: plural(Number(player.starts) || 0, "titularidad", "titularidades"),
        detail: plural(Number(player.matches) || 0, "partido", "partidos"),
      }));
  };

  const lineupFor = (side) => {
    const data = a.match?.lineups?.[side] || {};
    const starters = data.starters || data.xi || data.players || [];
    if (starters.length) {
      return {
        note: "Once inicial confirmado",
        items: starters.slice(0, 11).map((player) => ({
          name: player.shortName || player.name || "Jugador",
          meta: player.jersey ? `#${player.jersey}` : (player.pos || ""),
          value: "",
          detail: "",
        })),
      };
    }
    const absences = (data.absences || []).map((item) => item.name).filter(Boolean);
    return {
      note: absences.length
        ? `Pendiente de confirmación · bajas o dudas: ${absences.join(", ")}`
        : "Pendiente de confirmación",
      items: [],
    };
  };

  const teamTitle = (team) => `
    <div class="simple-team-title">${crest(team, "xs")}<strong>${escapeHtml(team.short)}</strong></div>
  `;

  const teamData = (side, team) => {
    const st = team?.standing || {};
    const corners = a.metrics?.corners || {};
    const projected = side === "home" ? corners.home : corners.away;
    const cornersFor = Number(team?.cornersFor);
    const cornersAgainst = Number(team?.cornersAgainst);
    const cornersTotal = Number.isFinite(cornersFor) && Number.isFinite(cornersAgainst)
      ? nf(cornersFor + cornersAgainst)
      : "—";
    const dg = Number(st.dg);
    return `
      <div class="simple-team-block">
        ${teamTitle(team)}
        <div class="simple-subhead">Tabla de posiciones</div>
        ${row("Puesto", st.pos ? `${st.pos}º` : "—")}
        ${row("Puntos / partidos", `${st.pts ?? "—"} pts · ${st.pj ?? "—"} PJ`)}
        ${row("Goles a favor / en contra", `${st.gf ?? "—"} / ${st.gc ?? "—"}`)}
        ${row("Saldo", Number.isFinite(dg) ? `${dg > 0 ? "+" : ""}${dg}` : "—")}
        ${row("Zona", ZONE_LABELS[st.zone] || st.zone || "—")}
        <div class="simple-subhead">Córners por partido</div>
        ${row("A favor", `${nf(team?.cornersFor)} córners`)}
        ${row("En contra", `${nf(team?.cornersAgainst)} córners`)}
        ${row("Total habitual", `${cornersTotal} córners`)}
        ${row("En este partido", `${nf(projected)} córners`)}
      </div>
    `;
  };

  const teamPlayers = (side, team) => {
    const scorers = scorersFor(side);
    const lineup = lineupFor(side);
    return `
      <div class="simple-team-block">
        ${teamTitle(team)}
        <div class="simple-subhead">${escapeHtml(scorers.label)}</div>
        ${personList(scorers.items)}
        <div class="simple-subhead">Defensas y portero habituales</div>
        ${personList(defendersFor(team))}
        <div class="simple-subhead">Alineación</div>
        ${lineup.items.length ? personList(lineup.items) : `<p class="simple-empty">${escapeHtml(lineup.note)}</p>`}
      </div>
    `;
  };

  return `
    <div class="simple-analysis">
      <section class="panel simple-panel">
        <div class="panel-head">
          <div><span class="eyebrow">Lectura</span><h2>Lo esencial</h2></div>
          <span class="panel-note">${escapeHtml(a.match.competition)}</span>
        </div>
        <div class="simple-highlight">
          <span>Resultado más probable</span>
          <strong>${escapeHtml(leader.label)} · ${pct(leader.value)}</strong>
          <small>Ventaja de ${num(gap, 1)} puntos sobre el siguiente resultado</small>
        </div>
        <div class="simple-grid">
          ${card("Goles esperados", `${num(goals.home)}–${num(goals.away)}`, `Total ${num(goals.total)}`)}
          ${card("Más de 2.5 goles", pct(goals.over25))}
          ${card("Ambos anotan", pct(btts))}
          ${card("Marcador orientativo", topScore ? `${topScore.home}–${topScore.away}` : "—", topScore ? pct(topScore.p) : "")}
        </div>
      </section>
      <section class="panel simple-panel">
        <div class="panel-head">
          <div><span class="eyebrow">Señales</span><h2>Cómo se perfila</h2></div>
        </div>
        <div class="simple-signals">
          ${signal(`Anota ${a.home.short}`, pct(a.teamScore.home))}
          ${signal(`Anota ${a.away.short}`, pct(a.teamScore.away))}
          ${signal("Primer gol", `${pct(a.firstGoal.home, 0)} / ${pct(a.firstGoal.away, 0)}`)}
          ${signal("Forma reciente", formValue)}
          ${signal("Historial directo", h2hValue)}
        </div>
      </section>
      <section class="panel simple-panel">
        <div class="panel-head">
          <div><span class="eyebrow">Por equipo</span><h2>Tabla y córners</h2></div>
        </div>
        <div class="simple-compare">
          ${teamData("home", a.home)}
          ${teamData("away", a.away)}
        </div>
        <p class="simple-note">Los promedios de córners son por partido; el último dato corresponde a este encuentro.</p>
      </section>
      <section class="panel simple-panel">
        <div class="panel-head">
          <div><span class="eyebrow">Jugadores</span><h2>Goleadores, defensas y alineación</h2></div>
        </div>
        <div class="simple-compare">
          ${teamPlayers("home", a.home)}
          ${teamPlayers("away", a.away)}
        </div>
        <p class="simple-note">Cuando no hay una probabilidad individual disponible, los goleadores se ordenan por goles recientes. Las titularidades son recuentos de los últimos partidos.</p>
      </section>
      <p class="simple-legend">juego responsable y con medida</p>
    </div>
  `;
}

function renderMatchView() {
  const a = state.analysis;
  if (!a) return;
  const full = getFullAnalysis(state.selectedId);
  const detailsBody = full
    ? `<div class="main-column panel-stack">${renderSimpleAnalysis(full)}</div>`
    : `<div class="analysis-loading"><span aria-hidden="true"></span><p>Preparando el análisis detallado…</p></div>`;
  view.innerHTML = `
    ${renderHero(a)}
    <details class="analysis-details" ${state.analysisOpen ? "open" : ""}>
      <summary class="details-summary">
        <span>Ver análisis completo</span>
        <small>Posiciones, goleadores, defensas, córners y alineación</small>
      </summary>
      <div class="details-body">${detailsBody}</div>
    </details>
  `;
  const analysisDetails = $(".analysis-details", view);
  if (analysisDetails) {
    analysisDetails.addEventListener("toggle", () => {
      state.analysisOpen = analysisDetails.open;
      if (analysisDetails.open) loadFullAnalysisIntoView(state.selectedId);
    });
  }
  if (state.analysisOpen && !full) loadFullAnalysisIntoView(state.selectedId);
}

function loadFullAnalysisIntoView(requestedId) {
  if (getFullAnalysis(requestedId)) return Promise.resolve(true);
  return ensureFullAssets().then(() => {
    if (requestedId !== state.selectedId) return false;
    const loaded = getFullAnalysis(requestedId);
    if (!loaded) return false;
    state.analysis = loaded;
    const body = $(".analysis-details .details-body", view);
    if (body) body.innerHTML = `<div class="main-column panel-stack">${renderSimpleAnalysis(loaded)}</div>`;
    return true;
  });
}

function selectMatch(id, options = {}) {
  const analysis = getAnalysis(id);
  if (!analysis) return;
  state.selectedId = id;
  state.analysis = getFullAnalysis(id) || analysis;
  state.combo = [];
  if (options.updateHash !== false) {
    const hash = `#/partido/${toPublicId(id)}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  document.title = PRODUCT_NAME;
  if (state.matchListReady) renderMatchList();
  renderMatchView();
  closeDrawer(true);
  closeValidation(true);
  closeLatent(true);
  closeSidebar();
  if (options.scroll !== false) {
    const behavior = window.matchMedia("(max-width: 860px)").matches ? "auto" : "smooth";
    window.scrollTo({ top: 0, behavior });
  }
}

function tooltipHtml(exp) {
  const drivers = exp.drivers.slice(0, 3).map((driver) => `
    <div class="tt-driver">
      <span>${escapeHtml(driver.label)}</span>
      <strong class="${driver.tone}">${escapeHtml(driver.impact)}</strong>
    </div>
  `).join("");
  return `
    <div class="tt-eyebrow">${escapeHtml(exp.eyebrow)}</div>
    <div class="tt-title">${escapeHtml(exp.title)}</div>
    <div class="tt-value">${escapeHtml(exp.value)}</div>
    <p class="tt-summary">${escapeHtml(exp.summary)}</p>
    <div class="tt-drivers">${drivers}</div>
    <div class="tt-foot">Clic para ver el cálculo <span>→</span></div>
  `;
}

function positionTooltip(x, y) {
  tooltip.classList.add("is-visible");
  const rect = tooltip.getBoundingClientRect();
  const gap = 16;
  let left = x + gap;
  let top = y + gap;
  if (left + rect.width > window.innerWidth - 12) left = x - rect.width - gap;
  if (top + rect.height > window.innerHeight - 12) top = y - rect.height - gap;
  left = Math.max(12, left);
  top = Math.max(12, top);
  tooltip.style.transform = `translate(${left}px, ${top}px)`;
}

function showTooltip(key, x, y) {
  let exp = state.analysis?.explanations?.[key];
  if (!exp && !getFullAnalysis(state.selectedId)) {
    const requestedId = state.selectedId;
    ensureFullAssets().then(() => {
      if (requestedId !== state.selectedId) return;
      const loaded = getFullAnalysis(requestedId);
      if (!loaded) return;
      state.analysis = loaded;
      showTooltip(key, x, y);
    });
    return;
  }
  exp = state.analysis?.explanations?.[key];
  if (!exp) return;
  state.tooltipKey = key;
  tooltip.innerHTML = tooltipHtml(exp);
  tooltip.setAttribute("aria-hidden", "false");
  positionTooltip(x, y);
}

function hideTooltip() {
  state.tooltipKey = null;
  tooltip.classList.remove("is-visible");
  tooltip.setAttribute("aria-hidden", "true");
}

function drawerHtml(exp) {
  const drivers = exp.drivers.map((driver) => `
    <div class="drawer-driver">
      <div class="drawer-driver-top">
        <span>${escapeHtml(driver.label)}</span>
        <strong class="${driver.tone}">${escapeHtml(driver.impact)}</strong>
      </div>
      <p>${escapeHtml(driver.detail)}</p>
      <div class="drawer-driver-bar" aria-hidden="true"><i style="width:${Math.round(driver.magnitude * 100)}%"></i></div>
    </div>
  `).join("");
  const steps = exp.steps.map((step, index) => `
    <li>
      <div><span>${escapeHtml(step.label)}</span>${step.note ? `<small>${escapeHtml(step.note)}</small>` : ""}</div>
      <strong>${escapeHtml(step.value)}</strong>
      <span class="step-index">${pad(index + 1)}</span>
    </li>
  `).join("");
  return `
    <header class="drawer-head">
      <h2 id="drawer-title">${escapeHtml(exp.title)}</h2>
      <div class="drawer-value">${escapeHtml(exp.value)}</div>
      <p class="drawer-summary">${escapeHtml(exp.summary)}</p>
    </header>
    <section class="drawer-section">
      <h3>Factores <span>impacto aislado</span></h3>
      <div class="drawer-drivers">${drivers}</div>
    </section>
    <section class="drawer-section">
      <h3>Paso a paso</h3>
      <ol class="calc-steps">${steps}</ol>
    </section>
    <section class="drawer-formula">
      <span>Fórmula</span>
      <code>${escapeHtml(exp.formula)}</code>
    </section>
    <section class="drawer-caveat">
      <strong>Qué tener en cuenta</strong>
      <p>${escapeHtml(exp.caveat)}</p>
    </section>
    <footer class="drawer-meta">${escapeHtml(exp.meta)}</footer>
  `;
}

function openDrawer(key) {
  let exp = state.analysis?.explanations?.[key];
  if (!exp && !getFullAnalysis(state.selectedId)) {
    const requestedId = state.selectedId;
    ensureFullAssets().then(() => {
      if (requestedId !== state.selectedId) return;
      const loaded = getFullAnalysis(requestedId);
      if (!loaded) return;
      state.analysis = loaded;
      openDrawer(key);
    });
    return;
  }
  exp = state.analysis?.explanations?.[key];
  if (!exp) return;
  hideTooltip();
  state.lastFocus = document.activeElement;
  drawerEyebrow.textContent = exp.eyebrow;
  drawerContent.innerHTML = drawerHtml(exp);
  drawer.hidden = false;
  drawerBackdrop.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  drawer.scrollTop = 0;
  document.body.classList.add("drawer-open");
  // Forzar un reflow para que la transición arranque incluso si rAF está pausado.
  void drawer.offsetWidth;
  drawer.classList.add("is-open");
  drawerBackdrop.classList.add("is-open");
  $("#drawer-close")?.focus();
}

function closeDrawer(immediate = false) {
  if (drawer.hidden) return;
  clearTimeout(state.drawerTimer);
  drawer.classList.remove("is-open");
  drawerBackdrop.classList.remove("is-open");
  document.body.classList.remove("drawer-open");
  const finish = () => {
    drawer.hidden = true;
    drawerBackdrop.hidden = true;
    drawer.setAttribute("aria-hidden", "true");
    if (state.lastFocus && typeof state.lastFocus.focus === "function") {
      state.suppressFocusTooltip = true;
      state.lastFocus.focus();
      setTimeout(() => {
        state.suppressFocusTooltip = false;
      }, 0);
    }
    state.lastFocus = null;
  };
  if (immediate) finish();
  else state.drawerTimer = setTimeout(finish, 220);
}

let toastTimer;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2200);
}

async function refreshLive() {
  const btn = $("#refresh-btn");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "Actualizando…";
  try {
    const response = await fetch("/api/live/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: 7, max: 120 }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
    showToast(`${matchesLabel(data.matches)} · ${data.leagues} ligas actualizados`);
    setTimeout(() => location.reload(), 900);
  } catch (error) {
    const message = String(error?.message || error);
    showToast(message.includes("Failed to fetch") ? "Abre la app con npm start para actualizar" : message);
    btn.disabled = false;
    btn.textContent = "Actualizar";
  }
}

function openSidebar() {
  if (!state.matchListReady) renderMatchList();
  sidebarBackdrop.hidden = false;
  document.body.classList.add("sidebar-open");
  menuBtn?.setAttribute("aria-expanded", "true");
  void sidebarBackdrop.offsetWidth;
  sidebarBackdrop.classList.add("is-open");
  $("#sidebar-close")?.focus({ preventScroll: true });
}

function closeSidebar() {
  const hadFocus = sidebarEl?.contains(document.activeElement);
  document.body.classList.remove("sidebar-open");
  menuBtn?.setAttribute("aria-expanded", "false");
  sidebarBackdrop.classList.remove("is-open");
  if (hadFocus && menuBtn && getComputedStyle(menuBtn).display !== "none") {
    menuBtn.focus({ preventScroll: true });
  }
  setTimeout(() => {
    if (!document.body.classList.contains("sidebar-open")) sidebarBackdrop.hidden = true;
  }, 220);
}

function handleClick(event) {
  const matchItem = event.target.closest("[data-match-id]");
  if (matchItem) {
    selectMatch(matchItem.dataset.matchId);
    return;
  }
  const filterChip = event.target.closest("[data-filter]");
  if (filterChip) {
    state.filter = filterChip.dataset.filter;
    if (state.filter === "high_conf") {
      state.confidence = 0.8;
      const select = $("#confidence-select");
      if (select) select.value = "0.8";
    } else if (state.confidence === 0.8 && state.filter !== "league") {
      state.confidence = 0;
      const select = $("#confidence-select");
      if (select) select.value = "0";
    }
    if (state.filter === "league") $("#league-select")?.focus();
    renderFilters();
    renderMatchList();
    const visible = filteredMatches();
    if (!visible.some((match) => match.id === state.selectedId) && visible[0]) {
      selectMatch(visible[0].id);
    }
    return;
  }
  const openEl = event.target.closest("[data-open]");
  if (openEl) {
    if (openEl.dataset.open === "latent") openLatent();
    else if (openEl.dataset.open === "record") openRecord();
    else openValidation();
    return;
  }
  const explainEl = event.target.closest("[data-explain]");
  if (explainEl) {
    openDrawer(explainEl.dataset.explain);
    return;
  }
  const tabEl = event.target.closest("[data-tab-target]");
  if (tabEl) {
    switchTab(tabEl.dataset.tabGroup, tabEl.dataset.tabTarget);
    return;
  }
  const comboEl = event.target.closest("[data-combo]");
  if (comboEl) {
    const id = comboEl.dataset.combo;
    if (state.combo.includes(id)) {
      state.combo = state.combo.filter((item) => item !== id);
    } else if (state.combo.length >= 4) {
      showToast("Máximo 4 condiciones por escenario");
      return;
    } else {
      state.combo = [...state.combo, id];
    }
    const a = state.analysis;
    const panel = $("#combo-panel");
    if (a && panel) {
      panel.outerHTML = renderCombo(a);
      $(`[data-combo="${id}"]`)?.focus();
    }
    return;
  }
  const comboRemove = event.target.closest("[data-combo-remove]");
  if (comboRemove) {
    const id = comboRemove.dataset.comboRemove;
    state.combo = state.combo.filter((item) => item !== id);
    const a = state.analysis;
    const panel = $("#combo-panel");
    if (a && panel) panel.outerHTML = renderCombo(a);
    return;
  }
  if (event.target.closest("#combo-clear")) {
    state.combo = [];
    const a = state.analysis;
    const panel = $("#combo-panel");
    if (a && panel) panel.outerHTML = renderCombo(a);
    return;
  }
  if (event.target.closest("#precision-btn")) {
    openValidation();
    return;
  }
  if (event.target.closest("#validation-close") || event.target === validationBackdrop) {
    closeValidation();
    return;
  }
  if (event.target.closest("#latent-close") || event.target === latentBackdrop) {
    closeLatent();
    return;
  }
  if (event.target.closest("#record-close") || event.target === recordBackdrop) {
    closeRecord();
    return;
  }
  const actionEl = event.target.closest("[data-action]");
  if (actionEl) {
    if (actionEl.dataset.action === "share") {
      const url = location.href;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(() => showToast("Enlace copiado")).catch(() => showToast("No se pudo copiar el enlace"));
      } else {
        showToast("Copia el enlace desde la barra del navegador");
      }
    }
    if (actionEl.dataset.action === "print") window.print();
    if (actionEl.dataset.action === "week-filter") {
      state.filter = "week";
      renderFilters();
      renderMatchList();
      if (window.matchMedia("(max-width: 860px)").matches) {
        openSidebar();
      } else {
        $("#sidebar")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      showToast("Mostrando los próximos 7 días");
    }
    if (actionEl.dataset.action === "other-sports") {
      showToast(`${PRODUCT_NAME} solo modela fútbol. Otros deportes quedan fuera del modelo.`);
    }
    return;
  }
  if (event.target.closest("#refresh-btn")) {
    refreshLive();
    return;
  }
  if (event.target.closest("#engine-btn")) {
    openDrawer("engine");
    return;
  }
  if (event.target.closest("#methodology-btn")) {
    openDrawer("methodology");
    return;
  }
  if (event.target.closest("#drawer-close") || event.target === drawerBackdrop) {
    closeDrawer();
    return;
  }
  if (event.target.closest("#menu-btn")) {
    openSidebar();
    return;
  }
  if (event.target.closest("#sidebar-close") || event.target === sidebarBackdrop) {
    closeSidebar();
  }
}

function handleMouseOver(event) {
  const el = event.target.closest("[data-explain]");
  if (!el) return;
  const key = el.dataset.explain;
  if (key !== state.tooltipKey) showTooltip(key, event.clientX, event.clientY);
}

function handleMouseMove(event) {
  if (state.tooltipKey) positionTooltip(event.clientX, event.clientY);
}

function handleMouseOut(event) {
  const el = event.target.closest("[data-explain]");
  if (el && !el.contains(event.relatedTarget)) hideTooltip();
}

function handleFocusIn(event) {
  if (state.suppressFocusTooltip) return;
  const el = event.target.closest("[data-explain]");
  if (!el) return;
  const rect = el.getBoundingClientRect();
  showTooltip(el.dataset.explain, rect.left + rect.width / 2, rect.bottom);
}

function handleFocusOut(event) {
  const el = event.target.closest("[data-explain]");
  if (el) hideTooltip();
}

function trapFocus(container, event) {
  const focusables = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const outside = !container.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    if (!drawer.hidden) {
      closeDrawer();
      hideTooltip();
      return;
    }
    if (!validationModal.hidden) closeValidation();
    if (!latentModal.hidden) closeLatent();
    if (!recordModal.hidden) closeRecord();
    hideTooltip();
    closeSidebar();
  }
  const activeModal = !validationModal.hidden
    ? validationModal
    : !latentModal.hidden
      ? latentModal
      : !recordModal.hidden
        ? recordModal
        : null;
  if (event.key === "Tab" && activeModal && drawer.hidden) trapFocus(activeModal, event);
  if (event.key === "Tab" && !drawer.hidden) trapFocus(drawer, event);
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-explain]") && event.target.tagName !== "BUTTON") {
    event.preventDefault();
    openDrawer(event.target.dataset.explain);
  }
}

function renderDatasetLabels() {
  const demo = Boolean(LEAGUE.demo);
  const live = Boolean(LEAGUE.live);
  const updated = LEAGUE.updated ? formatDate(LEAGUE.updated) : null;
  $("#breadcrumb").textContent = live
    ? `${LEAGUE.name} / ${LEAGUE.leagueCount} ligas · ${matchesLabel(LEAGUE.matchCount)}`
    : `${LEAGUE.name} / ${LEAGUE.season}`;
  $("#sidebar-note").textContent = live
    ? `Partidos y resultados actualizados. ${ENGINE_LABEL}. Uso personal y educativo.`
    : demo
      ? `Datos de respaldo simulados. ${ENGINE_LABEL}. Uso personal y educativo.`
      : `Datos propios cargados. ${ENGINE_LABEL}, no una garantía.`;
  $("#demo-badge-text").textContent = live ? `Live · ${ENGINE_NAME}` : demo ? `Respaldo · ${ENGINE_NAME}` : `Datos propios · ${ENGINE_NAME}`;
  $("#demo-badge").classList.toggle("is-custom", !demo && !live);
  $("#demo-badge").classList.toggle("is-live", live);
  $("#footer-data").textContent = live
    ? `${matchesLabel(LEAGUE.matchCount)} · ${ENGINE_NAME} · actualizado ${updated ? `${updated.day} ${updated.time}` : "ahora"}`
    : demo
      ? `Datos de respaldo · 2026 · ${ENGINE_NAME}`
      : `${LEAGUE.name} · ${LEAGUE.season} · ${ENGINE_NAME}`;
  const localApi = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  const refresh = $("#refresh-btn");
  if (refresh) refresh.hidden = !live || !localApi;

  const hitsBtn = $("#hits-btn");
  if (hitsBtn) {
    hitsBtn.hidden = !hitsReady;
    if (modelReady) {
      const h = MODEL_REPORT.headline;
      hitsBtn.innerHTML = `<span class="hits-btn-label">Total de aciertos</span><span class="hits-btn-value">${h.hits}/${h.n}</span><small class="hits-btn-rate">${pct(h.accuracy, 1)}</small>`;
      hitsBtn.title = `Aciertos en la muestra disponible · ${h.hits}/${h.n} (${pct(h.accuracy, 1)})`;
    } else if (hitsReady) {
      const h = VALIDATION.hits;
      hitsBtn.innerHTML = `<span class="hits-btn-label">Total de aciertos</span><span class="hits-btn-value">${h.hits}/${h.n}</span><small class="hits-btn-rate">${pct(h.rate, 1)}</small>`;
      hitsBtn.title = `Backtest live · ${h.hits}/${h.n} aciertos (${pct(h.rate, 1)})`;
    }
  }
  const latentBtn = $("#latent-btn");
  if (latentBtn) latentBtn.hidden = !latentReady;
  const recordBtn = $("#record-btn");
  if (recordBtn) {
    recordBtn.hidden = !recordReady;
    if (recordReady) {
      recordBtn.title = `Récord verificado · ${RECORD.published} picks publicados · ${RECORD.publishedScored} con resultado`;
    }
  }
}

function boot() {
  $("#model-version").textContent = ENGINE_NAME;
  renderDatasetLabels();
  renderFilters();
  renderLeagueFilter();
  if (window.matchMedia("(min-width: 861px)").matches) renderMatchList();
  else matchCountEl.textContent = pad(MATCHES.filter((match) => !match.reference).length);
  if (!MATCHES.length) {
    view.innerHTML = `
      <section class="panel">
        <div class="panel-head"><div><span class="eyebrow">Sin datos</span><h2>No hay partidos cargados</h2></div></div>
        <p class="empty-copy">Ejecuta <code>node datos_live.mjs</code> para descargar la cartelera, o <code>python mis_datos.py</code> para cargar tus propios datos.</p>
      </section>
    `;
  } else {
    const hashId = location.hash.match(/partido\/([^/?]+)/)?.[1];
    const initial = matchForHashId(hashId) || MATCHES[0];
    selectMatch(initial.id, { updateHash: Boolean(hashId), scroll: false });
  }
  if (location.hash === "#record") openRecord();

  document.addEventListener("click", handleClick);
  const moreMenu = $(".topbar-more");
  if (moreMenu) {
    moreMenu.addEventListener("click", (event) => {
      if (event.target.closest(".topbar-more-menu button, .topbar-more-menu [data-explain]")) {
        moreMenu.open = false;
      }
    });
    document.addEventListener("click", (event) => {
      if (moreMenu.open && !moreMenu.contains(event.target)) moreMenu.open = false;
    });
  }
  document.addEventListener("mouseover", handleMouseOver);
  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseout", handleMouseOut);
  document.addEventListener("focusin", handleFocusIn);
  document.addEventListener("focusout", handleFocusOut);
  document.addEventListener("keydown", handleKeydown);
  document.addEventListener("input", handlePanelInput);
  document.addEventListener("change", handlePanelInput);
  window.addEventListener("scroll", hideTooltip, true);
  window.addEventListener("resize", hideTooltip);
  window.addEventListener("hashchange", () => {
    const id = location.hash.match(/partido\/([^/?]+)/)?.[1];
    const match = matchForHashId(id);
    if (match && match.id !== state.selectedId) selectMatch(match.id, { updateHash: true });
    if (location.hash === "#record") openRecord();
  });
  $("#league-select")?.addEventListener("change", (event) => {
    state.league = event.target.value;
    state.filter = state.league === "all" ? "all" : "league";
    renderFilters();
    renderMatchList();
    const visible = filteredMatches();
    if (!visible.some((match) => match.id === state.selectedId) && visible[0]) {
      selectMatch(visible[0].id);
    }
  });
  $("#confidence-select")?.addEventListener("change", (event) => {
    state.confidence = Number(event.target.value) || 0;
    if (state.confidence === 0.8) {
      state.filter = "high_conf";
    } else if (state.filter === "high_conf") {
      state.filter = "all";
    }
    renderFilters();
    renderMatchList();
    const visible = filteredMatches();
    if (!visible.some((match) => match.id === state.selectedId) && visible[0]) {
      selectMatch(visible[0].id);
    }
  });
  searchEl.addEventListener("input", (event) => {
    state.query = event.target.value;
    renderMatchList();
  });
}

boot();
