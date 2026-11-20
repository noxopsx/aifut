import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDataset, writeDataset } from "./datos_live.mjs";

const execFileAsync = promisify(execFile);

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const REFRESH_COOLDOWN_MS = 60_000;
const REFRESH_MAX_BODY = 2048;
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;
const SOURCE_STATUS_PATH = join(root, "data", "source_status.json");
const refresh = { running: false, lastFinishedAt: 0, lastSync: null, lastError: null };

/**
 * Ejecuta el pipeline operativo: ESPN + API-Football + football-data.org +
 * footballapi.org, y regenera data/fixtures.json, data/source_status.json,
 * js/data/fuentes.js y data/manifest.json. Nunca expone claves.
 */
async function runSyncOperativo() {
  try {
    const { stdout } = await execFileAsync(
      process.env.PYTHON || "python",
      ["-m", "pipeline.sync_operativo", "--scheduled", "--force", "--no-catalog", "--manifest"],
      { cwd: root, timeout: SYNC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
    );
    const line = String(stdout || "").trim().split("\n").filter(Boolean).pop() || "";
    refresh.lastSync = { ok: true, summary: line, at: new Date().toISOString() };
    return refresh.lastSync;
  } catch (error) {
    const detail = String(error?.message || error).split("\n").filter(Boolean).pop() || "Error al sincronizar.";
    refresh.lastSync = { ok: false, summary: detail, at: new Date().toISOString() };
    return refresh.lastSync;
  }
}

/** Refresco completo: datos live (ESPN) + todas las APIs + estado de fuentes. */
async function refreshAll({ days = 7, max = 120 } = {}) {
  const dataset = await buildDataset({ days, max, cache: false });
  if (!dataset.matches.length) {
    throw new Error("ESPN no devolvió partidos próximos; se conservan los datos anteriores.");
  }
  const files = await writeDataset(dataset, {});
  const sync = await runSyncOperativo();
  return { dataset, files, sync };
}

async function readSourceStatus() {
  try {
    const text = await readFile(SOURCE_STATUS_PATH, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function isLoopback(req) {
  const address = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const localHost = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    const localPort = Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port;
    return localHost && localPort;
  } catch {
    return false;
  }
}

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Cuerpo de la petición demasiado grande.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("El cuerpo de la petición no es JSON válido.");
  }
}

async function handleRefresh(req, res) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, error: "La actualización solo está disponible desde este equipo." });
    return;
  }
  if (!originAllowed(req)) {
    sendJson(res, 403, { ok: false, error: "Origen no permitido." });
    return;
  }
  if (refresh.running) {
    sendJson(res, 409, { ok: false, error: "Ya hay una actualización en curso. Espera a que termine." });
    return;
  }
  const sinceLast = Date.now() - refresh.lastFinishedAt;
  if (refresh.lastFinishedAt && sinceLast < REFRESH_COOLDOWN_MS) {
    const wait = Math.ceil((REFRESH_COOLDOWN_MS - sinceLast) / 1000);
    sendJson(res, 429, { ok: false, error: `Espera ${wait} s antes de volver a actualizar.` });
    return;
  }

  let body;
  refresh.running = true;
  try {
    try {
      body = await readBody(req, REFRESH_MAX_BODY);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
      return;
    }

    const days = Math.max(1, Math.min(14, Number(body.days) || 7));
    const max = Math.max(1, Math.min(120, Number(body.max) || 120));

    const { dataset, files, sync } = await refreshAll({ days, max });
    refresh.lastFinishedAt = Date.now();
    sendJson(res, 200, {
      ok: true,
      matches: dataset.matches.length,
      leagues: dataset.league.leagueCount,
      teams: Object.keys(dataset.teams).length,
      updated: dataset.league.updated,
      files: files.length,
      sync,
      sources: await readSourceStatus(),
    });
  } catch (error) {
    refresh.lastFinishedAt = Date.now();
    console.error("Error al actualizar datos live:", error);
    sendJson(res, 502, { ok: false, error: error.message || "No se pudo actualizar." });
  } finally {
    refresh.running = false;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    if (pathname === "/api/live/refresh") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" });
        res.end("Método no permitido");
        return;
      }
      await handleRefresh(req, res);
      return;
    }

    if (pathname === "/api/fuentes") {
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" });
        res.end("Método no permitido");
        return;
      }
      sendJson(res, 200, {
        ok: true,
        lastSync: refresh.lastSync,
        sources: await readSourceStatus(),
      });
      return;
    }

    const filePath = normalize(join(root, pathname));
    const rel = relative(root, filePath);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const data = await readFile(filePath);
    const headers = {
      "Content-Type": mime[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    };
    if (ext === ".woff2") {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    } else {
      headers["Cache-Control"] = "no-store";
      const compressible = [".html", ".css", ".js", ".json", ".svg"].includes(ext);
      if (compressible && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
        headers["Content-Encoding"] = "gzip";
        headers.Vary = "Accept-Encoding";
        res.writeHead(200, headers);
        res.end(gzipSync(data, { level: 6 }));
        return;
      }
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch (error) {
    const notFound = error && error.code === "ENOENT";
    res.writeHead(notFound ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(notFound ? "No encontrado" : "Error interno");
    if (!notFound) console.error(error);
  }
});

server.listen(port, host, () => {
  console.log(`AIFUT · OX V1.0 listo en http://${host}:${port}`);
  console.log("Refresco automático al iniciar: ESPN + API-Football + football-data.org + footballapi.org");
  // Refresco completo en segundo plano: la página sirve de inmediato con los
  // datos existentes y se actualiza en cuanto termina el pipeline.
  setImmediate(async () => {
    if (refresh.running) return;
    refresh.running = true;
    try {
      const { dataset, sync } = await refreshAll({ days: 7, max: 120 });
      refresh.lastFinishedAt = Date.now();
      console.log(
        `Refresco inicial completo: ${dataset.matches.length} partidos · ` +
        `sync ${sync.ok ? "ok" : "parcial"}: ${sync.summary}`
      );
    } catch (error) {
      refresh.lastError = error?.message || String(error);
      console.error("Error en el refresco inicial:", error);
    } finally {
      refresh.running = false;
    }
  });
});
