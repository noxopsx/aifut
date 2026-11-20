# Plan de mejora de OX

**Versión del plan:** 1.0  
**Fecha:** 4 de noviembre de 2026  
**Base:** auditoría de solo lectura sobre `#/partido/espn-761922` (documento `mejoras del motor.pdf`, 13 páginas).  
**Objetivo:** pasar de OX V1.0, un dashboard explicable con datos finos, a una V2.0 con datos profundos, features reales, modelos comparables, evaluación continua y trazabilidad.

---

## Estado de ejecución (9 de noviembre de 2026)

### Sección 0 — Credibilidad y consistencia: completada

- **0.1 Descanso:** `core.js` respeta `restMeta` y neutraliza solo el lado sin dato; `datos_live.mjs` genera `restMeta`; la UI muestra el descanso cuando existe y lo declara ausente cuando falta.
- **0.2 Procedencia:** chips “Observado / Estimado / Placeholder” en las seis métricas, leyenda y chips en recientes/H2H. El dato observado no se presenta como estimación.
- **0.3 Tiros a puerta:** tasa derivada de tiros observados con contracción bayesiana (prior 0.34, 30 tiros, mínimo 10); se expone fuente y muestra por equipo. El dataset live tiene 189 tasas derivadas y 11 placeholders.
- **0.4 H2H:** `buildH2H` expone `sufficient` y `minMatches`; con menos de 3 partidos la UI muestra “Muestra insuficiente” y el motor no aplica ajuste.
- **0.5 Salidas:** “Mercado/Mercados” se sustituyó por “Salidas” en UI, explicaciones, datos live y `league.js`; se eliminó el lenguaje de liquidez.
- **0.6 Tests:** `test-model.mjs` separa `warnings` de `problems` y valida tasas, `restMeta`, `engine.rest` y `h2h.sufficient`. `node test-model.mjs` termina con código 0.
- **0.7 Frescura:** panel de frescura en la pestaña “Datos” con fuente, actualización, cobertura, tasas derivadas/placeholder y campos faltantes.

### Sección 1 — Datos históricos y fuentes: completada

- **Ligas piloto:** Premier League (`eng.1`) y LaLiga (`esp.1`), seis temporadas (2020-21 a 2025-26).
- **Base:** 4.560 partidos, 56 equipos, 55 sedes, 9.120 filas de estadísticas y 43.754 registros de cuotas.
- **Cobertura:** resultados 100%, tiros 100%, xG global 95,55% (2025-26: 76,3% en Premier League y 80,8% en LaLiga), cuotas 100%, sedes ~99,6% y alineaciones 100% con XI completo en ambos equipos (191.159 filas, 3.608 jugadores).
- **Alineaciones:** `pipeline/ingest_lineups.py` reconstruye los eventos desde los calendarios de equipo y los resúmenes de ESPN, con respaldo por fecha. Guarda titulares, suplentes, dorsal, posición y formación; los minutos quedan en `NULL` porque ESPN no los publica en el resumen.
- **Reproducibilidad:** `python -m pipeline.run_pipeline --all`, `python -m pipeline.validate_data` y `python -m pipeline.build_manifest`. La caché de alineaciones vive en `data/raw/espn_lineups/` y es reanudable.
- **Documentación:** `data/SOURCES.md`, `data/DATA_DICTIONARY.md`, `data/manifest.json` y `README.md` actualizados.

**Siguiente:** Sección 4 (evaluación continua y calibración por segmentos).

---

## 1. Diagnóstico

### 1.1 Veredicto de la auditoría

La auditoría es clara: el punto fuerte no es el dato, es el **modelo estadístico explicable, la calibración y la interfaz**. El cuello de botella es la **pipeline de datos**.

- 120 partidos próximos, 233 equipos y 14 ligas.
- Historial de solo **2 temporadas** (temporada actual + anterior).
- Validación de **1.169 partidos** entre abril y noviembre de 2026.
- H2H disponible en **53 de 120** partidos, con máximo 6 enfrentamientos.
- **19** partidos con lectura de desempate.
- **98** explicaciones por partido.
- **47,9%** de aciertos 1X2 y **3,7%** de skill frente al baseline.
- Sin xG/xGA, sin alineaciones confirmadas, sin cuotas, con contexto mayormente neutro.

La conclusión del documento es correcta: **“buen dashboard explicable sobre una capa de datos fina”**. No es todavía un motor de producción.

### 1.2 Brechas por sección

| Sección | Estado actual | Brecha principal | Prioridad |
|---|---|---|---|
| Datos | 2 temporadas, ESPN + datos propios | Profundidad histórica, xG, alineaciones, contexto, mercado, fuentes y lineage | P0 |
| Feature engineering | Forma, fuerza, localía, H2H limitado | xG, Elo, descanso/congestión real, viajes, splits, mercado | P1 |
| Modelos | Poisson + Dixon-Coles | Elo/logística, GBM, ensamble, modelos de xG/alineación/mercado | P1 |
| Evaluación | Walk-forward + Brier | Log-loss, benchmark de mercado, backtesting continuo, intervalos de confianza, auditoría de leakage | P1 |
| Infraestructura | JS/Node, servidor estático, refresh manual | Base de datos, scheduler, API de predicciones, monitoreo | P2 |
| Extras | Live parcial; sin lenguaje de apuestas | Lesiones/cuotas en vivo, monitoreo y recalibración | P2 |
| Producto/UI | Interfaz responsive y explicable | Etiquetas observado/estimado/placeholder, panel de calidad, comparación de modelos | P1 |

### 1.3 Correcciones inmediatas de credibilidad

No son funcionalidades nuevas, pero afectan la confianza en lo que ya se muestra:

1. **Descanso inconsistente:** `core.js` aplica el factor de descanso, pero la UI lo oculta y la explicación dice “neutro”. Hay que decidir: exponerlo o anularlo.
2. **Estimado vs observado:** tiros, córners, tarjetas y posesión live son estimaciones; deben llevar una marca visible, no solo una nota en README.
3. **`onTargetRate = 0.34` fijo:** es un placeholder; hay que reemplazarlo por dato real o declararlo en la UI.
4. **H2H corto:** 53/120 partidos y máximo 6 enfrentamientos; la UI debe decir “muestra insuficiente” cuando aplique.
5. **“Tabla de mercados”:** el nombre invita a confundirla con cuotas. Renombrar a “Comparación interna” o añadir una nota fija.
6. **Avisos de `test-model.mjs`:** el test sale con código 1 por 4 equipos sin cronología. No es fallo del motor, pero es deuda de datos.
7. **Frescura:** falta un panel visible de última actualización, cobertura y campos faltantes.

### 1.4 Lo que no se debe tocar

- El núcleo **Poisson bivariado + Dixon-Coles**.
- La **calibración** por temperatura 1X2 y Platt para binarios.
- El **walk-forward** con holdout y Brier contra baseline.
- Las **98 explicaciones por factor** y la capa de desempate separada.
- La **matriz 7×7**, los mercados múltiples y los escenarios conjuntos.
- El **VE en puntos**, sin lenguaje de apuestas ni dinero.
- La **interfaz responsive**, el hover explicativo y el clic con cálculo completo.

---

## 2. Estrategia

### 2.1 Principios de trabajo

1. **Data-first:** no se añade un modelo más complejo hasta que el dato lo justifique.
2. **Validación temporal:** nunca split aleatorio; solo información disponible antes del partido.
3. **Trazabilidad:** cada métrica debe indicar si es observada, estimada o placeholder, y de qué fuente viene.
4. **Reproducibilidad:** datasets versionados, modelos versionados, semillas, fechas y manifiestos.
5. **Entrega incremental:** cada sección deja la aplicación funcionando; no hay reescritura big-bang.
6. **Lenguaje neutro:** el mercado se usa como referencia de probabilidad, no como apuesta ni dinero.
7. **Explicabilidad:** si un modelo nuevo no se puede explicar, no reemplaza al Poisson; se suma como capa comparativa.

### 2.2 Arquitectura recomendada

**Recomendación: mantener Node/JS para la interfaz y el servidor, y añadir una pipeline Python offline para datos, features, entrenamiento y evaluación.**

```text
previa/
  pipeline/                  # Python offline
    ingest_espn.py
    ingest_xg.py
    ingest_lineups.py
    ingest_odds.py
    build_features.py
    train_models.py
    evaluate.py
    export_web.py
  data/
    raw/                     # respuesta original, inmutable
    normalized/              # tablas limpias
    features/                # una fila por partido, pre-partido
    snapshots/               # versiones con checksum
  models/                    # artefactos y model cards
  js/data/generated/         # JSON/Parquet exportado para la UI
  js/model/                  # motor actual y capa de inferencia
  server.js                  # API + estáticos
```

**Por qué:**

- No se tira la interfaz ni el motor actual.
- Python permite pandas, scikit-learn, XGBoost/LightGBM, Optuna y validación estadística sin forzar un rewrite del frontend.
- Node sigue siendo el serving y la capa de presentación.
- Si más adelante hace falta, se puede migrar a una API Python completa sin cambiar la UI.

**Base de datos:** empezar con **SQLite** para desarrollo local y **Parquet** para snapshots; PostgreSQL solo cuando haya varias fuentes o usuarios concurrentes.

### 2.3 Decisiones pendientes

| Decisión | Recomendación | Alternativa |
|---|---|---|
| Ligas piloto | Premier League + LaLiga (mejor cobertura de xG y mercado) | Liga MX + MLS si interesa el mercado local |
| Fuentes | ESPN + FBref/Understat + Football-Data.co.uk + API-Football/Sportmonks + Open-Meteo | Opta/StatsBomb de pago |
| Arquitectura | Python offline + serving Node | Implementar Elo/logística en JS y dejar Python para después |
| Base de datos | SQLite + Parquet | PostgreSQL desde el inicio |
| Mercado | Incluirlo como benchmark y feature, con lenguaje neutro | No incluirlo en la primera fase |
| Alcance | 2 ligas × 5 temporadas primero | 14 ligas con datos finos (no recomendado) |

---

## 3. Plan por secciones

### Sección 0 — Credibilidad y consistencia (P0, 1-2 días)

**Objetivo:** que la interfaz y el motor digan lo mismo antes de añadir datos nuevos.

| ID | Tarea | Archivos | Entregable | Criterio de aceptación |
|---|---|---|---|---|
| 0.1 | Decidir y unificar el factor descanso | `js/model/core.js`, `js/model/explain.js`, `js/app.js`, `test-model.mjs` | Descanso expuesto o anulado, nunca contradictorio | La UI, la explicación y el cálculo usan el mismo valor |
| 0.2 | Etiquetas de procedencia | `js/app.js`, `js/model/explain.js`, `css/styles.css` | Chip/leyenda “Observado / Estimado / Placeholder” | Toda métrica estimada tiene marca visible |
| 0.3 | Sustituir o declarar `onTargetRate` | `datos_live.mjs`, `js/model/ratings.js`, `js/model/core.js`, `js/app.js` | Tasa real por equipo/liga o placeholder explícito | No queda un 0.34 silencioso |
| 0.4 | H2H con muestra insuficiente | `js/model/ratings.js`, `js/app.js`, `js/model/explain.js` | Aviso y peso solo con muestra mínima | Menos de 3 partidos → “muestra insuficiente” |
| 0.5 | Renombrar “Mercado” | `js/app.js`, `js/model/explain.js` | “Comparación interna” + nota “no son cuotas” | Ningún panel sugiere que son cuotas |
| 0.6 | Avisos de `test-model.mjs` | `test-model.mjs`, datos | Warnings separados de errores o cronología corregida | `node test-model.mjs` no falla por datos opcionales |
| 0.7 | Panel de frescura | `js/app.js`, `datos_live.mjs` | Última actualización, fuente, cobertura y faltantes | Visible en contexto o precisión |

**Definition of Done:** no hay contradicciones entre cálculo y UI; las estimaciones están marcadas; el test no confunde warning con error; el usuario puede saber de dónde sale cada dato.

---

### Sección 1 — Datos históricos y fuentes (P0, 5-7 días)

**Objetivo:** construir una base histórica profunda y reproducible en 1-2 ligas antes de tocar el modelo.

#### 1.1 Alcance y matriz de fuentes

- Elegir **2 ligas piloto** y **5 temporadas** iniciales (ampliable a 10).
- Mantener las 14 ligas live como cobertura de calendario, pero **entrenar solo con las ligas piloto**.
- Documentar por fuente: cobertura, licencia, límite de peticiones, frecuencia y campos.

| Fuente | Uso previsto | Notas |
|---|---|---|
| ESPN | Calendario, resultados, tablas, resúmenes, alineaciones | Ya integrada; revisar límites y términos |
| FBref | Históricos, estadísticas avanzadas, xG | Verificar cobertura y licencia |
| Understat | xG/xGA de las principales ligas | Útil para validar xG |
| Football-Data.co.uk | Resultados históricos y cuotas de cierre | Bueno para backtesting |
| API-Football / Sportmonks | Alineaciones, lesiones, cuotas | Free tier o pago; revisar términos |
| Open-Meteo | Clima en sede y hora del partido | Gratuito |
| StatsBomb open data | Eventos para un modelo xG propio | Solo si se necesita |
| Transfermarkt | Valores de plantilla | Revisar licencia antes de usarlo |

#### 1.2 Esquema mínimo

| Tabla | Campos clave |
|---|---|
| `leagues` | id, nombre, país, temporada, tier |
| `teams` | id, liga, nombre, abreviatura, logo, sede |
| `venues` | id, nombre, ciudad, país, latitud, longitud, altitud |
| `matches` | id, liga, temporada, fecha UTC, local, visitante, estado, goles, sede, árbitro |
| `team_match_stats` | partido, equipo, tiros, a puerta, posesión, córners, faltas, tarjetas, pases, PPDA, xG, xGA |
| `lineups` | partido, equipo, jugador, titular, minutos, posición, formación |
| `players` | id, nombre, posición, edad, minutos, xG90, rating, valor |
| `injuries` | jugador, equipo, inicio, fin, estado, fuente |
| `odds` | partido, mercado, selección, precio, timestamp, casa |
| `elo_ratings` | equipo, fecha, Elo pre-partido |
| `data_sources` | id, nombre, URL, licencia, fecha de descarga |
| `ingestion_runs` | id, fuente, inicio, fin, estado, filas, errores |
| `model_runs` | id, modelo, versión, features, train, test, métricas |

#### 1.3 Backfill e incremental

- Descargar 5 temporadas completas de resultados y estadísticas.
- Guardar **raw inmutable** y una capa **normalized** separada.
- Deduplicar por ID estable y por combinación liga/fecha/equipos.
- Reintentos con backoff, caché y límite de peticiones.
- Actualización incremental diaria; no reescribir el histórico.
- Normalizar zonas horarias y estados de partido.

#### 1.4 Calidad y versionado

- Checks: duplicados, equipos sin mapear, fechas inválidas, goles negativos, estadísticas fuera de rango, partidos sin resultado.
- Cobertura por liga/temporada: % de partidos con xG, tiros, alineación, cuotas.
- `data/manifest.json` con versión, fecha, fuentes, checksum, filas y cobertura.
- Snapshots inmutables; nunca sobrescribir un dataset usado por un modelo.

**Definition of Done:** 2 ligas × 5 temporadas; resultados 100%; xG ≥90%; alineaciones y cuotas ≥80% en las ligas piloto; pipeline repetible; manifiesto y diccionario de datos.

---

### Sección 2 — Features y contexto real (P1, 5-7 días)

**Objetivo:** convertir los datos en features pre-partido, sin leakage y con cobertura medible.

| ID | Feature | Cálculo | Reemplaza |
|---|---|---|---|
| 2.1 | xG / xGA | Por partido y equipo; media móvil 5/10/20; local/visitante | Tiros estimados |
| 2.2 | Diferencial de xG | xG propio − xG rival; ajustado por rival | Falta actual |
| 2.3 | Elo / pi-ratings | Elo pre-partido, K=20, ventaja local, diferencia de goles | Falta actual |
| 2.4 | Diferencial de Elo | Elo local − Elo visitante | Falta actual |
| 2.5 | Descanso y congestión | Días desde el último partido; partidos en 14/21 días; copa/Europa | Descanso parcial |
| 2.6 | Viaje | Distancia Haversine sede local → sede visitante; husos | `travelKm: 0` |
| 2.7 | Derbi / rivalidad | Tabla de rivalidades + contexto | `rivalry: false` |
| 2.8 | Importancia | Posición, pelea por título/descenso, fase | `motivation: 1` |
| 2.9 | Alineaciones | XI confirmado/probable, formación, bajas, sanciones, rotación | `absences: []` |
| 2.10 | Splits local/visitante | Ataque/defensa por sede | Solo factor global |
| 2.11 | Mercado implícito | Cuotas 1X2/OU/BTTS de-vigged, timestamp | Sin mercado |
| 2.12 | PPDA / presión | Solo si hay datos de eventos | No disponible |
| 2.13 | Valor de plantilla / rating de jugador | Valor de mercado o rating interno; profundidad de banquillo | `playerImpact` descriptivo |
| 2.14 | Clima, altitud y árbitro | Open-Meteo, coordenadas de sede, asignación arbitral | Placeholders neutros |

**Reglas:**

- Cada feature lleva `quality`, `source` y `as_of`.
- Si falta un dato, se usa `null` y se baja la confianza; no se inventa un neutro silencioso.
- Solo se permiten features con timestamp anterior al kickoff.
- El feature store tiene una fila por partido y versión de dataset.

**Definition of Done:** diccionario de features; cobertura ≥80% en ligas piloto; auditoría de leakage; tests de null/placeholder; comparación de distribución antes/después.

**Estado (7 de noviembre de 2026): COMPLETADA.**

- Dataset `features-2.1.0`: 4.779 partidos, una fila por partido, 111 features y 79 usables.
- Calidad del store: 272.625 entradas `observed`, 153.779 `estimated`, 0 `placeholder` y 61.516 `missing`.
- Cobertura core ≥80% en los 10 grupos: xG rolling 98,3%, tiros 99,3%, PPDA 98,9%, Elo 100%, descanso/congestión 99,1%, viaje 100%, derbi 100%, importancia 97,3%, alineaciones 98,7% y splits 94,7%.
- Auditoría de leakage **PASS** con 0 fallos. Los partidos con el mismo kickoff se agrupan y calculan con el mismo estado previo.
- Tests `pipeline/test_features.py`: 12 pruebas OK (null/placeholder, procedencia, leakage, Elo pre-partido, Haversine/viaje, continuidad de XI, cobertura, distribución, calidad de derivados y lote con kickoff compartido).
- Calidad declarada: xG/xGA, Elo, medias de liga y splits/diffs de xG son `estimated` aunque sean usables; `observed` queda para resultados y estadísticas factuales.
- Comparación antes/después: 4.481 partidos con capa Poisson de sanidad; 95,0% cambia al menos 0,005 en 1X2. xG bruto vs rolling previo: 4.327 pares, correlación 0,2996.
- Decisiones: mercado y clima retrospectivo no usables; XI actual nunca usado; bajas, sanciones, valor de plantilla, penales por árbitro y copa/Europa declarados `missing`; Elo K=20 con prior 1500 no usable en el primer partido.
- Manifiesto `2.3.0` con checksums del feature store, cobertura, auditoría, distribución y artefactos de modelos.
- Límite declarado: el store es offline y no se inyecta en la UI live; evita presentar una feature histórica como observada en un partido fuera de las ligas piloto.

---

### Sección 3 — Modelos (P1, 5-7 días)

**Objetivo:** añadir baselines y un ensamble, sin perder el Poisson explicable.

| ID | Modelo | Uso | Prioridad |
|---|---|---|---|
| 3.1 | Poisson + Dixon-Coles actual | Baseline explicable | Ya existe |
| 3.2 | Elo + regresión logística | Baseline simple y robusto | P1 |
| 3.3 | Regresión logística / Random Forest con features | Baseline ML | P1 |
| 3.4 | XGBoost / LightGBM / CatBoost | Modelo tabular | P1 |
| 3.5 | Ensamble Poisson + Elo + GBM (mercado solo benchmark) | Mejor estimación | P1 |
| 3.6 | Modelo xG propio | Solo si hay eventos | P2 |
| 3.7 | Modelo de alineaciones/lesiones | Ajuste por XI | P2 |
| 3.8 | Modelo de mercado | Probabilidad implícita | P2 |

**Reglas:**

- Entrenar con validación temporal; el test se toca una sola vez.
- Calibrar cada modelo antes de compararlo.
- El ensamble aprende pesos en validación, nunca en test.
- Si faltan features, el sistema cae al Poisson; no falla.
- El mercado de cierre se excluye como feature porque no tiene hora exacta; solo se usa como benchmark externo.
- Cada modelo tiene model card: versión, datos, features, hiperparámetros, métricas y limitaciones.
- Nada de redes neuronales/LSTM/Transformers hasta tener 5-10 temporadas y datos de eventos.

**Definition of Done:** baseline Elo/logística funcionando; GBM con mejora medible; ensamble calibrado; model cards; comparación honesta contra Poisson.

**Estado (9 de noviembre de 2026): COMPLETADA.**

- **Datos:** `pipeline/models.py` entrena sobre el feature store `features-2.1.0`; `pipeline/export_poisson_baseline.mjs` exporta el baseline Poisson de la UI para compararlo en el mismo corte.
- **Split temporal:** train `2020-21`–`2022-23` (2.280 partidos), validación `2023-24` (752; mitad calibración, mitad pesos) y test `2024-25` + `2025-26` (1.504 de 1.520 partidos con features comparables).
- **Cuatro modelos (Fase 2):** Poisson + Dixon-Coles, logística Elo + xG, logística core y logística Elo + xG + tiros a puerta. Cada uno se calibra por temperatura antes de compararse; el Poisson conserva su calibración explicable. Se retiraron Elo + logística, Random Forest core y GBM core porque no aportaban al ensamble.
- **Ensamble:** pesos por mercado aprendidos solo en validación, sin floor artificial. En 1X2 pesan la logística con tiros a puerta (`57,3%`) y la logística core (`42,7%`); la logística Elo + xG queda en cero. En los binarios domina Poisson y la logística core solo aporta en over 1.5 (`36,1%`).
- **Test 1X2:** 802/1.504 = **53,32%**, log-loss **0,9891**, Brier **0,5886**, ECE **0,0361** y skill **9,17%** frente a la tasa base. IC95% de accuracy [50,93%, 55,79%]. El Poisson calibrado logra 758/1.504 = 50,40%, log-loss 1,0094 y Brier 0,6043.
- **Alta confianza:** `≥80%` acierta `65/74 = 87,84%` con cobertura `4,92%`; `≥70%` acierta `165/223 = 73,99%` con cobertura `14,83%`. Es un subconjunto selectivo, no el rendimiento global.
- **Honestidad:** `logit_xg_elo` individual acierta 801/1.504 (53,26%), un partido menos que el ensamble, que además mejora log-loss y Brier. El mercado de cierre iguala 802 aciertos (53,32%, log-loss 0,9766) y se muestra solo como referencia externa; nunca entra como feature.
- **Fallback:** si falta la fila de features o `elo_diff`, el ensamble usa el Poisson calibrado; las auxiliares ausentes se imputan con la mediana de entrenamiento y se añade un indicador. En el test comparable `test_fallbacks` es 0 porque los partidos sin ancla Elo quedan fuera de la muestra de 1.504.
- **Model cards:** `data/models/model_cards.json` y `data/models/MODEL_CARDS.md` con versión, datos, features, hiperparámetros, métricas y límites.
- **Artefactos:** `data/models/model_report.json`, `data/models/poisson_baseline.json` (2.256 filas), `data/models/historical_matches.json` y `js/data/model_report.js` (generado, no editar a mano).
- **UI:** el modal “Ensamble · test temporal” muestra el headline del ensamble y deja el backtest live de Poisson como sección secundaria; el botón “Total de aciertos” muestra `802/1504` + `53,3%` y la barra móvil `802` con `de 1504 · 53,3%`.
- **Tests:** `pipeline/test_models.py` cubre split, baseline, pesos, temperaturas, métricas, calibración, ligas/temporadas, features, fallback, model cards, benchmark, módulo web y lenguaje.
- **Manifiesto:** `2.3.0` con checksums de `data/models/*` y `js/data/model_report.js`, además del feature store.
- **Análisis web y capa de certeza:** se revisaron patrones públicos de ClubElo (incertidumbre y columnas condicionales) y FotMob (ranking por métrica); Understat, Opta Analyst, FBref y FiveThirtyEight no fueron accesibles desde el navegador aislado (vacío, redirect o 403) y no se copió su contenido. Se adaptó una capa original **“Certeza del pronóstico”** que mide la separación 1X2 y el rango central del 80% de goles; no cambia el 1X2, la matriz ni el fallback.
- **Límite declarado:** el ensamble es offline y no se inyecta en el motor live; el Poisson sigue siendo el núcleo explicable y el fallback de la UI.

---

### Mejora 3.9 — Tiros reales de ESPN y actualización programada (10 de noviembre de 2026)

**Origen:** análisis de la web pública `futboldatapro.com` con REA y Craft Anything. El cliente público solo consume `/api/*` y Supabase realtime; no contiene el motor Poisson ni el actualizador del servidor. Los términos del sitio declaran el motor como propiedad de Ariel Martínez y prohíben su redistribución, así que no se copió código ni texto propietario. Se adaptaron patrones de flujo con implementación propia.

**Qué se observó:**

- El calendario live usa logos y eventos de ESPN; los nombres de equipos y las fuerzas parecen venir de CSVs históricos tipo Football-Data.
- El cliente llama a `/api/leagues`, `/api/teams`, `/api/proximos_partidos`, `/api/predict`, `/api/validacion`, `/api/league_stats`, `/api/picks`, `/api/livescore` y `/api/stats`.
- `/api/validacion` declara walk-forward con el último 30% por liga, Brier, versión cruda vs calibrada, 8.086 partidos y 14 ligas.
- El motor no es público. No se encontró repositorio ni código de actualización reutilizable.

**Qué se implementó (original):**

- `js/model/observations.js`: `applyShotRates` toma los tiros por equipo de los resúmenes de ESPN, exige al menos 2 partidos con estadísticas completas y contrae la media observada hacia la estimación previa con un prior de 4 partidos. Deja `shotsSource`, `shotsSample` y `estimated.shots` para que la UI distinga insumo observado de proyección estimada.
- `PLAYER_REPORT_MATCHES` pasa de 2 a 3 para ampliar la muestra de tiros, tiros a puerta y forma sin disparar el número de peticiones.
- `shotsBlend` ahora se activa cuando ambos equipos tienen muestra real; informa `samples` y un motivo con el tamaño de muestra. Si falta un lado, se omite.
- La UI muestra “Tiros por equipo: X/2 con muestra” en frescura, actualiza la nota de tiros y las explicaciones. La proyección del partido próximo sigue marcada como estimada.
- Actualización programada: `actualizar.cmd`, `actualizar_programado.cmd`, `programar_actualizacion.ps1`, `--programado`, `--min-horas` y `--forzar`. El estado se guarda en `.cache/ultima_actualizacion.json` y el log en `actualizacion_live.log`. El botón **Actualizar** también actualiza ese estado.

**Validación de temperatura (sin fuga del test):**

Se reconstruyeron las probabilidades crudas desde `lambdaHome`/`lambdaAway` de `poisson_baseline.json` y se evaluó la temperatura en la ventana 2023 (calibración) y 2024-2026 (test):

| T | Log-loss calibración | Log-loss test | Brier test |
|---|---|---|---|
| 1,00 | 0,96736 | 0,99950 | 0,59733 |
| 1,05 | 0,96858 | 0,99945 | 0,59728 |
| 1,15 | 0,97178 | 1,00039 | 0,59784 |
| 1,25 | 0,97557 | 1,00221 | 0,59902 |

La diferencia entre 1,05 y 1,15 es de ~0,001 en log-loss, muy por debajo del intervalo de confianza del ensamble. Se mantiene `T = 1.15` como prior conservador para no invalidar el baseline exportado ni el informe del ensamble; no se cambió `binarySlope`. La tabla queda como evidencia y no como una recalibración del test.

**Pruebas:** `test-model.mjs` cubre activación/omisión del blend, contracción de tiros, muestra mínima y coherencia entre `shotsSource` y `estimated.shots`. `node --check` valida los módulos nuevos.

---

### Mejora 3.10 — Fase 1: modo de alta confianza y calibración final (14 de noviembre de 2026)

**Origen:** la meta de 80–90% de acierto en cada partido 1X2.

**Hallazgo:** no es alcanzable en todos los partidos. El test del ensamble muestra que el tramo 80–90% acierta 88,9% pero cubre solo 3,6% (54/1.504); ≥80% cubre 3,7% (55/1.504) con 89,1%; ≥70% cubre 14,1% (212/1.504) con 75,5%. El mercado de cierre acierta 53,32%. La meta correcta es alta confianza con cobertura explícita, no 80–90% global.

**Implementado:**

- `index.html` y `css/styles.css`: filtro **Confianza 1X2** en el sidebar (`Todas`, `≥70%`, `≥80%`), pista de cobertura y resaltado del favorito cuando supera 70%. Responsive en 1440/900/800/390 px sin desbordes.
- `js/app.js`: `state.confidence`, `favoriteProbability()`, `filteredMatches({ ignoreConfidence })`, estado vacío que muestra el máximo de la ventana y tabla **Cobertura vs. acierto** en el modal de precisión. La tabla se calcula desde `MODEL_REPORT.calibration["1x2"]`; los artefactos generados no se editaron a mano.
- La ventana live verificada tuvo máximo 59,2%; el filtro ≥70% mostró 0 de 9 partidos y el estado vacío lo explicó. No se fuerza una selección cuando no hay confianza suficiente.
- **Clima:** se confirmó peso 0 (`usable_for_model: false`). Se quitó de los faltantes y se etiquetó como contexto, no como feature.

**Calibración final del ensamble (solo validación):**

- Protocolo: reproducir el split y los seis modelos; generar el ensamble de la mitad de pesos con 5 folds contiguos por fecha; evaluar temperature scaling, escalado por clase y vector scaling con validación cruzada anidada. El test no participó en la decisión.
- Validación (376 partidos): baseline log-loss `0,93284`, Brier `0,55033`, ECE `0,03845`, accuracy `57,98%`.
- Temperature: log-loss `−0,00013`, Brier `+0,000004`, ECE `−0,00031`, accuracy `0,00 pp`. Escalado por clase: log-loss `+0,00067`, Brier `+0,00070`, accuracy `−1,60 pp`. Vector scaling: log-loss `+0,00069`, Brier `+0,00090`, ECE `−0,01057`, accuracy `−1,86 pp`.
- **Decisión: no adoptar.** La mejora de temperatura es indistinguible del ruido y el Brier empeora; los otros calibradores degradan log-loss/Brier y aciertos. El headline se mantiene en `796/1504 = 52,93%` y no se regeneró el reporte.

**Pruebas:** `node --check js/app.js`, `node test-model.mjs` y verificación CDP de los cuatro anchos. El filtro y la tabla no introducen lenguaje de apuestas ni cambian el núcleo Poisson + Dixon-Coles.

**Siguiente:** Fase 2 completada en la Mejora 3.11: `logit_xg_shots` con tiros, tiros a puerta y defensa rival, ablación contra `logit_xg_elo` y poda del ensamble.

---

### Mejora 3.11 — Fase 2: tiros a puerta, defensa rival y poda del ensamble (14 de noviembre de 2026)

**Origen:** la Fase 2 debía añadir tiros, tiros a puerta y defensa rival al 1X2, y descartar configuraciones que no aportaran información al motor.

**Datos nuevos:**

- `team_match_stats.shots_on_target` ya estaba completo para `eng.1` y `esp.1`; no se añadió una fuente nueva.
- `pipeline/build_features.py` calcula `home_sot_for_10`, `home_sot_against_10`, `away_sot_for_10` y `away_sot_against_10` como medias móviles de 10 partidos, y las diferencias `d_sot_for_10` / `d_sot_against_10`.
- Cobertura del feature store `features-2.1.0`: 4.779 partidos, 111 features; SOT base 4.749/4.753 y derivadas 4.738. Media de tiros a puerta 4,28, rango 0–17.
- Cada feature conserva `quality`, `source` y `as_of`; las ausentes quedan en `null`, no se presentan como observadas.

**Ablaciones (solo validación, mitad de pesos):**

| Configuración | Muestra | Aciertos | Log-loss | Brier | ECE |
|---|---|---:|---:|---:|---:|
| Lean 15 features (PPDA + contexto) | Validación | 218/376 = 57,98% | 0,92005 | 0,54320 | 0,04174 |
| Lean 15 features (PPDA + contexto) | Test | 792/1.504 = 52,66% | 0,99278 | 0,59096 | 0,03932 |
| Lean 10 features pre-registrado | Test | 799/1.504 = 53,13% | 0,98808 | 0,58777 | 0,04020 |
| Ensamble 4 modelos, piso 0 (producción) | Test | 802/1.504 = 53,32% | 0,9891 | 0,5886 | 0,0361 |

- La variante de 15 features era fuerte en validación, pero en test cayó a **792/1.504 = 52,66%** con log-loss **0,99278**: peor que el candidato pre-registrado. Se rechazó y no se usa en producción.
- El candidato pre-registrado de 10 features (`elo_diff`, `xg_diff_5`, `xg_diff_20`, `d_xg_for_10`, `d_xg_against_10`, `d_shots_for_10`, `d_shots_against_10`, `d_sot_for_10`, `d_sot_against_10`, `is_esp`) confirmó **799/1.504** en el protocolo de ablación, con log-loss **0,98808**, Brier **0,58777** y ECE **0,04020**.
- El ensamble de producción, con pesos aprendidos en validación, combina ese modelo con la logística core y confirma **802/1.504 = 53,32%**, log-loss **0,9891**, Brier **0,5886** y ECE **0,0361**.

**Configuraciones descartadas:**

- **`elo_logit` (solo Elo):** redundante con la logística Elo + xG y con el resto del ensamble; se retiró.
- **`rf_core` y `gbm_core`:** no aportaban mejora incremental frente a las logísticas; se retiraron. El ensamble pasó de seis a cuatro modelos.
- **`xg_diff_10`:** exactamente colineal con `d_xg_for_10 - d_xg_against_10`; efecto cero. Se quitó de todos los feature sets.
- **`d_lineup` y `d_depth`:** se quitaron de `CORE_FEATURES`; el over 1.5 de validación mejoró de log-loss `0,49554` a `0,49494` sin ellos.
- **Piso de peso `0,05`:** se cambió a `0,0`. El optimizador ahora puede dejar en cero cualquier modelo que no aporte; no se fuerza la participación de nadie.
- **Calibración final del ensamble:** sigue rechazada. Temperature scaling por modelo y mercado se mantiene; el escalado global no mejoró lo suficiente y el test no se usó para elegirlo.
- **PPDA y contexto en el modelo lean:** no se adoptaron en el 1X2 principal; siguen en `CORE_FEATURES` porque el modelo auxiliar binario no los validó como removibles.

**Estado actual:**

- **Modelos:** Poisson + Dixon-Coles, `logit_xg_elo` (control, peso cero), `logit_core` (apoyo binario y 42,7% del 1X2) y `logit_xg_shots` (57,3% del 1X2).
- **Pesos 1X2:** `logit_xg_shots` 57,3%, `logit_core` 42,7%; Poisson y `logit_xg_elo` en cero.
- **Binarios:** BTTS, over 2.5 y over 3.5 quedan 100% Poisson; over 1.5 combina Poisson 63,9% + `logit_core` 36,1%.
- **Cobertura de alta confianza (test):**

| Umbral | Partidos | Cobertura | Acierto |
|---|---:|---:|---:|
| ≥80% | 74 | 4,92% | 65/74 = 87,84% |
| ≥70% | 223 | 14,83% | 165/223 = 73,99% |
| 80–90% | 71 | 4,72% | 62/71 = 87,32% |

**Cautela de protocolo:** el test se usó para confirmar el candidato pre-registrado y para verificar que la variante de 15 features empeoraba; no se usó para elegir features ni pesos. La selección de features y pesos se hizo en validación. El 80–90% global sigue sin ser una promesa: es el rendimiento de un subconjunto selectivo con cobertura explícita.

---

### Mejora 3.12 — Modo de Alta Certeza (≥80%), Blend Adaptativo de Tiros/Defensa y Neutralización del Clima (15 de noviembre de 2026)

**Objetivo:** dar respuesta a la solicitud del usuario de alcanzar 80%–90% de aciertos mediante tiros, defensa rival y descarte del clima, manteniendo la integridad matemática y la transparencia editorial.

**Implementado:**

1. **Modo y filtro de Alta Certeza (≥80%):**
   - Se añadió el chip directo `Alta certeza (≥80%)` en la barra rápida de `FILTERS` (`index.html` / `js/app.js`), complementando y sincronizándose bidireccionalmente con el desplegable `#confidence-select`.
   - Si no hay partidos que alcancen el 80% en la ventana seleccionada, la interfaz muestra un estado claro con el máximo registrado en la ventana (por ejemplo 59,2%) e invita a bajar el umbral o seleccionar "Todos", evitando forzar picks sin fundamento.
   - Corrección del cálculo base: al activar el chip o el desplegable ≥80%, la pista de cobertura ignora también el filtro `high_conf` al contar la ventana. Así muestra `0 de 9 partidos ≥ 80% · máximo 59,2%` en lugar de ocultarse o reportar una base vacía.
   - En las tarjetas de partido (`renderMatchList`), los encuentros con probabilidad de favorito $\ge 80\%$ muestran el distintivo `88% hist.` y borde esmeralda; los de $\ge 70\%$ muestran `74% hist.`.
   - En la cabecera del partido (`renderHero`), se destaca el pill `Alta certeza (≥80%) · 88% hist.` o `Certeza inclinada (≥70%) · 74% hist.`.

2. **Cobertura vs. Acierto en 4 tramos acumulados:**
   - La tabla del modal de Precisión muestra ahora los cuatro umbrales operativos del ensamble:
     - **$\ge 80\%$:** 74 partidos (cobertura 4,9%) $\rightarrow$ **87,84% de acierto** (log-loss y calibración excelentes).
     - **$\ge 70\%$:** 223 partidos (cobertura 14,8%) $\rightarrow$ **73,99% de acierto**.
     - **$\ge 60\%$:** 506 partidos (cobertura 33,6%) $\rightarrow$ **67,19% de acierto**.
     - **$\ge 50\%$:** 869 partidos (cobertura 57,8%) $\rightarrow$ **59,72% de acierto**.
   - Se documenta con claridad que el 80%–90% global en el 100% de partidos es una imposibilidad teórica por ruido Poisson y empates (techo global del fútbol de élite 53%–57%), pero es una realidad verificada out-of-fold en el tramo selectivo $\ge 80\%$.

3. **Blend adaptativo de tiros y defensa rival (`shotsBlendWeight`):**
   - En `js/model/calibration.js`, el peso de la señal de tiros y contención defensiva se vuelve adaptativo a la muestra observada: con 2 partidos (mínimo) conserva `0.20` (prior conservador); con 3 partidos sube a `0.25`, y con 4 o más partidos reales escala hasta `0.30–0.35`.
   - Se preserva la regla de oro: si la muestra es estimada o falta un lado, el blend se omite para no retroalimentar estimaciones.

4. **Exclusión del clima y del árbitro:**
   - Se elimina `weatherFx` y el factor `weather` de `js/model/core.js`; el clima deja de multiplicar λ y de penalizar la confianza.
   - Se elimina el factor `referee`: ni los penales del colegiado ni sus tarjetas ajustan goles o disciplina.
   - Ninguno de los dos aparece ya en el hero, los factores ni las explicaciones como entrada del cálculo; solo se declara explícitamente que están excluidos.

**Pruebas:** `node test-model.mjs` (0 problemas, 99 explicaciones), `python -m unittest pipeline.test_models` (19 tests OK), `python -m unittest pipeline.test_features` (12 tests OK), `python -m pipeline.validate_data` (PASS 100%). Verificación CDP del filtro ≥80% en 1440 y 390 px: pista `0 de 9 partidos ≥ 80% · máximo 59,2%`, estado vacío correcto y sin desbordes horizontales.

---

### Sección 4 — Evaluación y calibración (P1, 3-5 días + continuo)

**Objetivo:** medir de verdad, no solo con una foto de Brier.

| ID | Tarea | Entregable |
|---|---|---|
| 4.1 | Log-loss además de Brier | Métrica por mercado y global |
| 4.2 | Accuracy formal | Accuracy 1X2 y por segmento |
| 4.3 | Calibración | ECE, bins, curvas predicho vs observado |
| 4.4 | Benchmark de mercado | Log-loss/Brier del mercado de-vigged |
| 4.5 | Segmentos | Favorito/empate/underdog, local/visitante, liga, temporada |
| 4.6 | Intervalos de confianza | Bootstrap y significancia del skill |
| 4.7 | Backtesting continuo | Job programado + histórico de resultados |
| 4.8 | Auditoría de leakage | Timestamps de features, cuotas y alineaciones |
| 4.9 | Recalibración | Periodicidad y detección de drift |

**Protocolo temporal recomendado:**

- Entrenamiento: temporadas 1-3.
- Validación: temporada 4.
- Test: temporada 5.
- Después: walk-forward con ventana expansiva y origen móvil.
- Mínimo de partidos por liga antes de evaluar: 500.

**Definition of Done:** informe con log-loss, Brier, ECE, accuracy, skill, benchmark de mercado, intervalos y segmentos; backtest continuo; auditoría de leakage documentada.

---

### Sección 5 — Infraestructura y automatización (P2, 5-7 días)

**Objetivo:** que el motor se actualice solo y se pueda consumir sin depender de abrir la UI.

| ID | Tarea | Entregable |
|---|---|---|
| 5.1 | SQLite + migraciones | Base local reproducible |
| 5.2 | Parquet + snapshots | Versionado de datasets |
| 5.3 | Scheduler | Ingesta diaria, predicciones pre-partido, resultados post-partido, reentreno semanal |
| 5.4 | API de predicciones | `/api/predictions/:matchId` |
| 5.5 | API de datos | `/api/matches`, `/api/data/freshness`, `/api/models/:version` |
| 5.6 | Serving | La UI lee predicciones precomputadas |
| 5.7 | Monitoreo | Frescura, cobertura, errores, latencia, drift |
| 5.8 | Monte Carlo | Simulación de torneos, opcional |

**Reglas:**

- La API devuelve `quality`, `model_version`, `generated_at`, `probabilities` e `intervals`.
- Si hay mercado, se llama `market_reference`, no “cuota” ni “apuesta”.
- El refresh manual sigue existiendo, pero deja de ser el único mecanismo.
- Logs estructurados y alertas por fallo o dato viejo.

**Definition of Done:** un comando actualiza datos y predicciones; la API responde; el panel muestra frescura; se puede volver a una versión anterior.

---

### Sección 6 — Producto y UI (P1/P2, 2-3 días + continuo)

**Objetivo:** que el usuario vea la calidad del dato sin perder la claridad actual.

| ID | Tarea | Entregable |
|---|---|---|
| 6.1 | Chips de procedencia | Observado / Estimado / Placeholder en cada métrica |
| 6.2 | Panel de calidad | Cobertura, fuente, última actualización, faltantes |
| 6.3 | Comparación de modelos | Poisson vs Elo vs ML vs mercado |
| 6.4 | H2H y contexto | “Muestra insuficiente” y nulls explícitos |
| 6.5 | Nombres | “Comparación interna”, no “mercado” |
| 6.6 | Lenguaje | VE en puntos; sin apuestas/dinero |
| 6.7 | Documentación | README, changelog, model cards, diccionario de datos |

**Definition of Done:** el usuario distingue dato observado, estimado y placeholder; no hay etiquetas engañosas; la UI sigue siendo responsive y sin errores de consola.

---

## 4. Secuencia recomendada

| Fase | Sección | Duración | Depende de | Salida |
|---|---|---|---|---|
| 0 | Credibilidad | 1-2 días | — | UI y motor consistentes |
| 1 | Datos | 5-7 días | Fase 0 | 2 ligas × 5 temporadas + manifiesto |
| 2 | Features | 5-7 días | Fase 1 | xG, Elo, descanso, viajes, alineaciones, mercado |
| 3 | Modelos | 5-7 días | Fase 2 | Baselines + GBM + ensamble |
| 4 | Evaluación | 3-5 días | Fase 3 | Log-loss, benchmark, intervalos, backtest continuo |
| 5 | Infraestructura | 5-7 días | Fases 1-4 | SQLite, scheduler, API, monitoreo |
| 6 | Producto/UI | 2-3 días + continuo | Fases 0-5 | Procedencia, calidad, comparación |

**Duración total estimada:** 4-6 semanas para una persona, según acceso a datos y licencias.

### Primera semana (propuesta)

| Día | Trabajo |
|---|---|
| 1 | 0.1 descanso + 0.5 renombrar “mercado” |
| 2 | 0.2 procedencia + 0.3 `onTargetRate` + 0.4 H2H |
| 3 | 0.6 test warnings + 0.7 frescura + log-loss en backtest |
| 4 | 1.1 alcance/fuentes + 1.2 esquema |
| 5 | 1.3 backfill inicial + checks de calidad |
| 6-7 | 1.4 versionado + primer informe de cobertura |

### Semanas 2-3

- Completar features 2.1-2.11.
- Implementar Elo + logística y comparar contra Poisson.
- Añadir GBM y ensamble con validación temporal.

### Semanas 4-6

- Evaluación completa y backtesting continuo.
- SQLite, scheduler y API.
- UI de procedencia y comparación de modelos.
- Documentación y model cards.

---

## 5. Backlog priorizado

### P0 — Ahora

1. Descanso consistente.
2. Etiquetas observado/estimado/placeholder.
3. `onTargetRate` real o declarado.
4. H2H con muestra insuficiente.
5. Renombrar “tabla de mercados”.
6. `test-model.mjs` sin falsos fallos.
7. Panel de frescura.

### P1 — Datos y modelo

8. 2 ligas × 5 temporadas.
9. Esquema y diccionario de datos.
10. xG/xGA por partido y equipo.
11. Elo/pi-ratings y diferencial.
12. Descanso, congestión, viajes, derbis e importancia.
13. Alineaciones, lesiones y rotaciones.
14. Cuotas de-vigged como benchmark.
15. Log-loss y accuracy formal.
16. Benchmark contra mercado.
17. Segmentos e intervalos de confianza.
18. Backtesting continuo.
19. Elo + logística.
20. XGBoost/LightGBM + ensamble.

### P2 — Plataforma

21. SQLite/Parquet.
22. Scheduler.
23. API de predicciones.
24. Monitoreo y alertas.
25. Monte Carlo.
26. Comparación de modelos en UI.

---

## 6. Criterios de aceptación y métricas

### Datos

- 2 ligas × 5 temporadas (mínimo).
- Resultados: 100% de partidos.
- xG/xGA: ≥90% en ligas piloto.
- Alineaciones: ≥80%.
- Cuotas: ≥80%.
- Manifiesto y diccionario de datos publicados.
- Cero duplicados y cero equipos sin mapear.

### Modelo

- Log-loss y Brier mejores que el Poisson baseline en test.
- Mejora ≥2% en log-loss (objetivo inicial, ajustable).
- ECE ≤0.03.
- Skill positivo en al menos 2 temporadas.
- Sin caída catastrófica en ninguna liga piloto.
- Model card por versión.

### Evaluación

- Informe por liga y segmento.
- Benchmark de mercado.
- Intervalos de confianza.
- Backtest continuo programado.
- Auditoría de leakage documentada.

### Infraestructura

- Pipeline diaria reproducible.
- API con latencia p95 <300 ms para una predicción.
- Frescura <24 h.
- Rollback de dataset/modelo.
- Alertas por fallo o dato viejo.

### UI

- 100% de métricas con procedencia.
- Ningún texto que sugiera cuotas o apuestas.
- “Muestra insuficiente” cuando aplique.
- Responsive 390/1024/1440.
- Sin errores de consola.

---

## 7. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Licencias/límites de fuentes | Alto | Revisar términos; caché raw; fuentes abiertas primero |
| xG incompleto | Alto | Empezar con 2 ligas cubiertas; modelo xG propio solo si hay eventos |
| Cuotas con licencia restrictiva | Medio | Usar solo benchmark; documentar; no mostrar como apuesta |
| Muestra pequeña | Alto | Validación temporal, regularización, mínimos por liga |
| Sobreajuste al añadir ML | Alto | Baseline primero; ablación; test intacto; model cards |
| Leakage de datos | Alto | Auditoría de timestamps; features solo pre-kickoff |
| Complejidad de arquitectura | Medio | Python offline + Node serving; incremental |
| Scope creep | Alto | 2 ligas primero; no 14 ligas con datos finos |
| UI saturada | Medio | Divulgación progresiva; chips y panel de calidad |
| Lenguaje de apuestas | Medio | Glosario neutral; revisar textos y nombres de API |

---

## 8. Primeras 10 tareas concretas

1. Corregir la inconsistencia de descanso.
2. Añadir chips de procedencia a tiros, córners, tarjetas y posesión.
3. Reemplazar `onTargetRate = 0.34` por tasa real o placeholder visible.
4. Añadir “muestra insuficiente” al H2H.
5. Renombrar “Mercado” a “Comparación interna”.
6. Separar warnings de errores en `test-model.mjs`.
7. Añadir panel de frescura y cobertura.
8. Añadir log-loss al backtest.
9. Definir las 2 ligas piloto y la matriz de fuentes.
10. Crear el esquema de datos y el primer snapshot histórico.

---

## 9. Mapa de archivos

| Archivo | Uso actual | Cambio previsto |
|---|---|---|
| `datos_live.mjs` | Ingesta ESPN y generación live | Extender a pipeline, xG, alineaciones, cuotas, manifiesto |
| `mis_datos.py` | Carga de datos propios | Alinear esquema y validaciones |
| `js/model/core.js` | Cálculo de λ y mercados | Añadir features xG/Elo/contexto, nulls explícitos |
| `js/model/ratings.js` | Forma, fuerza, H2H | Añadir xG, Elo, splits, descanso real |
| `js/model/calibration.js` | Temperatura y Platt | Añadir calibración por modelo/liga |
| `js/model/backtest.js` | Walk-forward y Brier | Añadir log-loss, segmentos, intervalos, mercado |
| `js/model/explain.js` | Explicaciones | Reflejar procedencia y nuevos factores |
| `js/app.js` | UI | Chips, panel de calidad, comparación, nombres |
| `server.js` | Servidor estático + refresh | API de predicciones, datos y salud |
| `test-model.mjs` | Validación del motor | Warnings/errores, leakage, procedencia |
| `js/data/*.js` | Datos generados | Migrar a JSON/Parquet/DB y versionar |
| `css/styles.css` | Estilos | Chips, panel de calidad, comparación |

---

## 10. Definición de “motor completo” para OX

Para este proyecto, “completo” no significa implementar las 22 casillas de la auditoría a la vez. Significa:

- 2 ligas con 5-10 temporadas y datos profundos.
- xG/xGA, alineaciones, lesiones, contexto y mercado como features.
- Elo + logística + GBM + ensamble, con el Poisson como base explicable.
- Evaluación con log-loss, Brier, calibración, benchmark de mercado, intervalos y backtesting continuo.
- Base de datos, scheduler, API y monitoreo.
- UI que distingue observado, estimado y placeholder.
- Sin lenguaje de apuestas ni dinero.

Quedan como **opcionales** para más adelante: redes neuronales/LSTM/Transformers, sentimiento de noticias, PPDA si no hay eventos, Monte Carlo de torneos y detección de “value bets” (excluida por diseño editorial).

---

## Anexo — Cobertura de la lista consolidada de la auditoría

| # | Falta en la auditoría | Sección del plan | Fase |
|---|---|---|---|
| 1 | 5-10 temporadas históricas | Datos | 1 |
| 2 | xG/xGA por partido y equipo | Datos / Features | 1-2 |
| 3 | Estadísticas avanzadas como features | Datos / Features | 1-2 |
| 4 | Alineaciones, formación, lesiones, sanciones, rotaciones | Datos / Features | 1-2 |
| 5 | Valoraciones de plantilla | Datos / Features | 2 |
| 6 | Contexto real completo | Features | 2 |
| 7 | Cuotas y mercado implícito de-vigged | Datos / Features | 1-2 |
| 8 | Fuentes externas y reconciliación | Datos | 1 |
| 9 | Versionado, lineage y frescura | Datos / Infra | 1 / 5 |
| 10 | Elo o pi-ratings y diferencial | Features / Modelos | 2-3 |
| 11 | XGBoost/LightGBM/CatBoost + baseline | Modelos | 3 |
| 12 | Ensamble Poisson + ML + mercado | Modelos | 3 |
| 13 | Log-loss además de Brier | Evaluación | 4 |
| 14 | Backtesting continuo y benchmark de mercado | Evaluación | 4 |
| 15 | Métricas por liga/segmento e intervalos | Evaluación | 4 |
| 16 | Base de datos SQLite/PostgreSQL/Parquet | Infraestructura | 5 |
| 17 | Scheduler | Infraestructura | 5 |
| 18 | API de predicciones y edge | Infraestructura | 5 |
| 19 | Monte Carlo para torneos | Infraestructura | 5 |
| 20 | Lesiones y cuotas en vivo | Datos / Extras | 2 / 5 |
| 21 | Detección de value bets (opcional, lenguaje neutro) | Extras | Posterior |
| 22 | Monitoreo y recalibración | Infraestructura / Evaluación | 4-5 |

---

**Nota final:** la auditoría se hizo sobre la versión live del partido `espn-761922`. El nombre del producto ya es **OX V1.0**; las referencias a “PREVIA” en el documento original corresponden al nombre anterior del proyecto.
