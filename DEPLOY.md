# Publicar AIFUT gratis

## 1. Repositorio

Esta carpeta ya tiene `.gitignore`, workflow y script de publicación. Si aún no existe el repo remoto:

```bash
git remote add origin https://github.com/TU_USUARIO/aifut.git
git push -u origin main
```

El repo debe ser **público** para que el `schedule` de GitHub Actions funcione sin consumo de minutos. Las claves se guardan como Secrets de GitHub, nunca en archivos.

## 2. Cloudflare Pages

- **Framework preset**: `None`
- **Build command**: `npm run build:static`
- **Output directory**: `dist`

La URL será `https://<proyecto>.pages.dev`. No hace falta dominio propio.

El script `scripts/build-static.mjs` copia sólo `index.html`, `css/` y `js/`, y elimina del sitio público cualquier referencia al proveedor de datos, incluidos IDs de partido. Los escudos se sirven desde `css/crests/` con nombres neutros: se ven los crest reales, pero el navegador no hace peticiones externas ni muestra la procedencia.

Si el dataset incorpora equipos nuevos:

```bash
node scripts/download-crests.mjs
powershell -ExecutionPolicy Bypass -File scripts/optimize-crests.ps1
node scripts/build-static.mjs
```

El segundo comando es opcional y sólo optimiza el tamaño en Windows.

## 3. Datos automáticos

`.github/workflows/actualizar.yml` ejecuta cada hora:

```bash
node datos_live.mjs --programado --min-horas 6 --min-minutos-dia 15
python -m pipeline.sync_operativo --scheduled --force --no-catalog --manifest
```

Luego hace commit de `js/data/`, lo que provoca un nuevo deploy en Cloudflare.

Secrets configurables en **GitHub → Settings → Secrets and variables → Actions**:

- `APISPORTS_KEY`
- `FOOTBALLDATA_KEY`
- `FOOTBALLAPI_KEY`

Si no los defines, la app sigue funcionando con la fuente pública sin clave.

## 4. Verificación local antes de publicar

```bash
npm run build:static
python -m http.server 4174 --directory dist
```

Abre `http://127.0.0.1:4174/` y revisa que no aparezca ninguna referencia al proveedor de datos. El propio build falla si queda alguna.
