// Descarga los escudos de todos los equipos del dataset y los guarda en
// `css/crests/` con nombres neutros. Así la web Sirve imágenes locales y no
// depende de URLs externas ni muestra la procedencia del proveedor.
//
// Uso:
//   node scripts/download-crests.mjs
//   node scripts/download-crests.mjs --force

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR = join(ROOT, "js", "data");
const CRESTS_DIR = join(ROOT, "css", "crests");
const FORCE = process.argv.includes("--force");
const CONCURRENCY = 8;
const RETRIES = 3;
const USER_AGENT = "AIFUT/1.0 (+sitio estático)";

const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");

async function collectIds() {
  const files = (await readdir(DATA_DIR)).filter((name) => name.endsWith(".js"));
  const ids = new Set();
  for (const file of files) {
    const text = await readFile(join(DATA_DIR, file), "utf8");
    for (const match of text.matchAll(/teamlogos\/soccer\/\d+\/([^"'`\s)]+)/g)) {
      ids.add(safeName(match[1]));
    }
  }
  return [...ids].sort();
}

async function downloadOne(id) {
  const path = join(CRESTS_DIR, id);
  if (!FORCE) {
    try {
      const current = await readFile(path);
      if (current.length > 0) return { id, bytes: current.length, cached: true };
    } catch {}
  }

  const url = `https://a.espncdn.com/i/teamlogos/soccer/500/${id}`;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "image/png,image/*" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("La respuesta no es un PNG válido");
      }
      if (/espn/i.test(buffer.toString("latin1"))) {
        throw new Error("El PNG contiene metadatos del proveedor");
      }
      await writeFile(path, buffer);
      return { id, bytes: buffer.length, cached: false };
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error(`${id}: ${String(lastError?.message || lastError)}`);
}

const ids = await collectIds();
await mkdir(CRESTS_DIR, { recursive: true });

const results = [];
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < ids.length) {
    const id = ids[next];
    next += 1;
    results.push(await downloadOne(id));
  }
}));

const totalMb = results.reduce((sum, item) => sum + item.bytes, 0) / 1024 / 1024;
const downloaded = results.filter((item) => !item.cached).length;
console.log(
  `AIFUT · ${ids.length} escudos listos en css/crests/ ` +
  `(${downloaded} nuevos, ${totalMb.toFixed(1)} MB total).`,
);
