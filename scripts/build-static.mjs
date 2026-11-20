// Prepara `dist/` para Cloudflare Pages o GitHub Pages.
//
// Además de copiar sólo los archivos que necesita el navegador, elimina del
// sitio público cualquier referencia al proveedor de datos: textos visibles,
// URLs externas, IDs de partido, claves internas y escudos remotos.
// El repositorio y los pipelines conservan sus nombres originales; la limpieza
// ocurre únicamente en la copia que se publica.

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "dist");

const TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".svg", ".txt"]);

// Orden importante: las frases específicas van antes que los reemplazos genéricos.
const REPLACEMENTS = [
  // Escudos remotos -> copias locales con nombre neutro.
  [
    /https:\/\/a\.espncdn\.com\/i\/teamlogos\/soccer\/\d+\/([^"'`\s)]+)/gi,
    (_match, file) => `./css/crests/${String(file).replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
  ],
  // Cualquier otro recurso externo del proveedor -> escudo local neutro.
  [/https:\/\/a\.espncdn\.com\/[^"'`\s)]+/gi, "./css/escudo.svg"],
  [/https?:\/\/[^\s"']*espn[^\s"']*/gi, ""],

  // Textos visibles con sentido propio.
  [/Backtest walk-forward con datos ESPN/gi, "Backtest walk-forward con datos públicos"],
  [/Backtest live · datos ESPN/gi, "Backtest live · datos públicos"],
  [/Datos live de ESPN/gi, "Datos live"],
  [/datos live de ESPN/gi, "datos live"],
  [/ESPN live/gi, "Datos live"],
  [/ESPN no publica/gi, "La fuente pública no publica"],
  [/ESPN publica/gi, "La fuente pública publica"],
  [/resúmenes de ESPN/gi, "resúmenes públicos"],
  [/resumen de ESPN/gi, "resumen público"],
  [/muestra de ESPN/gi, "muestra pública"],
  [/historial de ESPN/gi, "historial público"],
  [/Datos de ESPN/gi, "Datos públicos"],
  [/datos de ESPN/gi, "datos públicos"],
  [/ESPN summary/gi, "Resumen público"],
  [/en ESPN/gi, "en la fuente pública"],
  [/desde ESPN/gi, "con datos públicos"],
  [/con ESPN/gi, "con datos públicos"],
  [/por ESPN/gi, "por la fuente pública"],
  [/para ESPN/gi, "para la fuente pública"],
  [/a ESPN/gi, "a la fuente pública"],
  [/del ESPN/gi, "de la fuente pública"],
  [/de ESPN/gi, "de la fuente pública"],

  // Identificadores internos: el link público nunca muestra la procedencia.
  [/live-espn/gi, "live"],
  [/espnId/gi, "providerId"],
  [/espn-/gi, "partido-"],

  // Último recurso: cualquier palabra suelta que haya quedado.
  [/\bespn\b/gi, "publica"],
];

function sanitize(text) {
  return REPLACEMENTS.reduce((value, [pattern, replacement]) => (
    value.replace(pattern, replacement)
  ), text);
}

async function copyPublicFiles() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await cp(join(ROOT, "index.html"), join(OUT, "index.html"));
  await cp(join(ROOT, "css"), join(OUT, "css"), {
    recursive: true,
    filter: (source) => !/\.bak-/i.test(source),
  });
  await cp(join(ROOT, "js"), join(OUT, "js"), {
    recursive: true,
    // `teams.js` sólo lo usan tests y pipelines; la web carga base + detalle.
    filter: (source) => !source.replace(/\\/g, "/").endsWith("/js/data/teams.js"),
  });
}

async function sanitizeTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let changed = 0;

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      changed += await sanitizeTree(path);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

    const original = await readFile(path, "utf8");
    const cleaned = sanitize(original);
    if (cleaned !== original) {
      await writeFile(path, cleaned, "utf8");
      changed += 1;
    }
  }
  return changed;
}

async function assertClean(directory, found = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertClean(path, found);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const text = await readFile(path, "utf8");
    if (/espn/i.test(text)) found.push(path.replace(ROOT, ""));
  }
  if (found.length) {
    throw new Error(`Quedaron referencias al proveedor en: ${found.join(", ")}`);
  }
}

await copyPublicFiles();
const changed = await sanitizeTree(OUT);
await assertClean(OUT);
console.log(`AIFUT · sitio estático listo en dist/ (${changed} archivos sanificados, 0 referencias al proveedor).`);
