# AIFUT · OX V1.0

**Versión actual:** V1.0 · motor propio.

Pronósticos de fútbol con probabilidades claras. La pantalla de inicio responde una pregunta:

1. ¿Qué porcentaje tiene cada resultado (1X2)?

El detalle de cómo se calcula y las herramientas avanzadas quedan fuera del inicio: **Ver análisis completo** abre probabilidades detalladas, goles, jugadores, contexto y cartelera; **Más** reúne precisión, récord, actualización y metodología.

Incluye 1X2, goles, marcadores, BTTS, goles por tiempo, remates, córners, tarjetas, matriz de marcadores, H2H, goleadores, contexto, tabla de comparación interna (no cuotas de casas de apuestas), proyección de valor esperado en puntos, escenarios de probabilidad conjunta, validación temporal con ensamble, historial de aciertos, equipos latentes y rendimiento de jugadores con cronología. Todo ese detalle queda dentro de **Ver análisis completo**. Puede funcionar con datos propios, con datos de respaldo o con la cartelera live de ESPN.

## Dirección del proyecto

OX deja atrás el prototipo de análisis y se organiza como un motor de predicción. La V1.0 mantiene el núcleo Poisson + Dixon-Coles y la capa de calibración, pero la prioridad de las próximas iteraciones es sustituir supuestos por datos de mayor peso real:

- ampliar el historial a 5-10 temporadas;
- incorporar xG/xGA y estadísticas avanzadas como features;
- alinear lesiones, suspensiones, rotaciones y XI confirmado;
- completar contexto validado (viajes, congestión, derbis, importancia, altitud);
- añadir cuotas y probabilidad implícita de mercado;
- sumar Elo/pi-ratings, ML y ensamble;
- pasar a base de datos, scheduler, API y monitoreo.

Mientras eso no esté, la interfaz distingue entre dato observado, dato estimado y placeholder. No se presentan estimaciones como si fueran observadas.

El plan detallado por secciones, con tareas, dependencias, criterios de aceptación y secuencia de trabajo, está en [`PLAN_MEJORA_MOTOR.md`](./PLAN_MEJORA_MOTOR.md).

## Ejecutar

```powershell
cd "C:\Users\paris\Documents\Proyecto predeterminado\previa"
node server.js
```

Abre `http://127.0.0.1:4173`.

También puedes hacer doble clic en `iniciar.cmd`, o usar:

```powershell
npm.cmd start
```

No hay dependencias externas: el servidor usa solo Node y la interfaz es HTML, CSS y JavaScript nativo.

Para comprobar el motor, la validación, los latentes y los jugadores:

```powershell
node test-model.mjs
```

o `npm.cmd test`.

## Modo live (ESPN)

La app arranca con la cartelera que esté cargada en `js/data/`. Para descargar los próximos partidos:

```powershell
node datos_live.mjs --dias 7 --max 120
```

El comando consulta 14 ligas en la API pública de ESPN, guarda una caché local en `.cache/espn/` y genera:

- `league.js`, `teams.js`, `matches.js` y `tables.js` para la cartelera.
- `validation.js` con el backtest walk-forward y el historial de aciertos.
- `latent.js` con la tabla del tercio medio, rachas y sorpresas.

La ventana por defecto es de 7 días y 120 partidos, alineada con la sección **Próximos 7 días**. Con el servidor encendido también puedes usar el botón **Actualizar** de la barra superior. Llama a `POST /api/live/refresh`, que solo acepta peticiones desde `127.0.0.1`/`localhost`, bloquea ejecuciones simultáneas y aplica un enfriamiento de 60 segundos.

### Actualización programada

La actualización manual sigue disponible, pero también puedes dejar la cartelera al día con el Programador de tareas de Windows:

```powershell
# Ejecuta una actualización manual y la registra en actualizacion_live.log
.\actualizar.cmd

# Registra una tarea cada 6 horas para el usuario actual
powershell -ExecutionPolicy Bypass -File .\programar_actualizacion.ps1

# Cambiar el intervalo o quitar la tarea
powershell -ExecutionPolicy Bypass -File .\programar_actualizacion.ps1 -EveryHours 12
Unregister-ScheduledTask -TaskName "AIFUT actualizar datos" -Confirm:$false
```

La tarea llama a `actualizar_programado.cmd`, que ejecuta `node datos_live.mjs --programado --min-horas 6`. El modo programado lee `.cache/ultima_actualizacion.json` y omite la descarga si la última actualización terminó hace menos de 6 horas; `--forzar` ignora ese enfriamiento. Si la tarea no se registra por permisos, abre PowerShell como administrador o crea la tarea manualmente apuntando a `actualizar_programado.cmd`.

### Qué aporta ESPN

- Calendario, rivales, fecha, sede y competición.
- Tabla de posiciones, partidos jugados, goles a favor/en contra y forma.
- Historial de la temporada actual y la anterior por equipo, usado para los últimos 10 partidos y el H2H.
- Logos, sede, resultados y estadísticas públicas de los partidos.
- Resúmenes de partido (`summary`): estadísticas de equipo, plantillas, goles, tarjetas, cambios y narración.

### Qué no aporta y por tanto no se inventa

- Alineaciones confirmadas para partidos próximos y bajas. El clima y el árbitro están excluidos del cálculo aunque alguna fuente los proporcione. La base histórica sí incluye alineaciones de partidos completados (ver **Base histórica**).
- xG/90 por jugador: el panel de goleadores queda vacío en modo live.
- Tiros reales por equipo para todos los partidos: los resúmenes de ESPN publican tiros de los partidos completados. El updater usa los últimos 3 partidos por equipo, contrae la media hacia la estimación y solo activa el blend cuando hay al menos 2 partidos completos. La proyección del partido próximo sigue siendo estimada.
- Córners y tarjetas reales por equipo: se estiman con promedios de la liga y así se indica en la interfaz.
- Estadísticas de equipo en algunas competiciones: el panel de jugadores lo avisa y apoya la lectura en el marcador y la cronología.

## Base histórica (Sección 1)

`data/database.sqlite` es la base reproducible de las dos ligas piloto, Premier League (`eng.1`) y LaLiga (`esp.1`), con seis temporadas: 2020-21 a 2025-26.

- **Partidos:** 4.560, con resultados, estadísticas de equipo y cuotas de cierre.
- **Cobertura:** xG global 95,55% (2025-26: 76,3% en Premier League y 80,8% en LaLiga), cuotas 100%, tiros 100% y sedes ~99,6%.
- **Alineaciones:** 4.560/4.560 partidos (100%) con XI completo en ambos equipos, 191.159 filas y 3.608 jugadores. ESPN publica los `rosters` de los partidos completados; la ingesta guarda titulares, suplentes, dorsal, posición y formación.
- **Límite declarado:** ESPN no publica minutos oficiales en el resumen. `lineups.minutes_played` queda en `NULL`; no se infiere un minuto exacto.
- **Trazabilidad:** cada ejecución deja un registro en `ingestion_runs`, y `data/manifest.json` incluye checksums, cobertura y linaje.

Comandos de la pipeline:

```powershell
python -m pip install -r pipeline/requirements.txt
python -m pipeline.run_pipeline --all       # resultados, xG, alineaciones, features, modelos, auditoría y manifiesto
python -m pipeline.validate_data            # auditoría de cobertura
python -m pipeline.build_manifest           # regenerar manifiesto y checksums
python -m pipeline.ingest_lineups --map-only
python -m pipeline.ingest_lineups --workers 8
```

La ingesta de alineaciones es reanudable: guarda un extracto por evento en `data/raw/espn_lineups/` y no vuelve a descargar lo que ya está en caché. `--refresh-index` reconstruye el índice de eventos; `--limit` sirve para pruebas.

## Features pre-partido (Sección 2)

El feature store `features-2.1.0` convierte la base histórica en una fila por partido y versión de dataset. Cada feature lleva `value`, `quality`, `source`, `as_of` y `usable_for_model`.

- **Partidos:** 4.560, una fila por partido.
- **Features:** 111 en el catálogo; 87 declaradas usables para el modelo.
- **Calidad:** `observed` (290.753 entradas), `estimated` (153.779), `placeholder` (0) y `missing` (61.628). Un `value: null` siempre es `missing` y nunca se sustituye por un neutro silencioso.
- **Derivados:** xG/xGA, Elo, medias de liga y splits/diffs de xG se marcan `estimated` aunque sean usables: son métricas calculadas, no conteos publicados. `observed` queda reservado para resultados y estadísticas factuales.
- **Cobertura core:** todos los grupos superan el objetivo de 80%: xG rolling 98,3%, tiros 99,3%, PPDA 98,9%, Elo 100%, descanso/congestión 99,1%, viaje 100%, derbi 100%, importancia 97,3%, alineaciones 98,7% y splits 94,7%.
- **Leakage:** auditoría **PASS**, 0 fallos. Toda feature usable tiene `as_of` estrictamente anterior al kickoff. Los partidos con el mismo horario se calculan con el mismo estado previo.
- **Distribución:** comparación de una capa Poisson de sanidad en 4.481 partidos; 95,0% cambia al menos 0,005 en 1X2. El xG bruto del partido y el rolling previo de 5 partidos se comparan emparejados por `match_id` (4.327 pares, correlación 0,2996).

Decisiones de honestidad:

- El **mercado** de cierre se conserva como referencia neutral, pero `usable_for_model: false` porque Football-Data no publica la hora exacta.
- El **clima** de Open-Meteo es reanálisis retrospectivo: `quality: estimated`, `usable_for_model: false` y excluido del motor. Se conserva solo como contexto de la base histórica.
- Las **alineaciones** no usan el XI del partido actual. La continuidad se calcula con los dos partidos anteriores; `lineup_confirmed` queda en 0 y no usable.
- **Bajas, sanciones, valor de plantilla, penales por árbitro y partidos de copa/Europa** se declaran `missing` y no usables; no se inventan neutros. El **árbitro** queda excluido del motor: no ajusta goles, tarjetas ni ninguna probabilidad.
- El **Elo** usa K=20, ventaja local 65 y multiplicador por diferencia de goles. El primer partido de un equipo arranca con prior 1500 marcado `estimated` y no usable.

Comandos:

```powershell
python -m pipeline.ingest_weather          # clima diario Open-Meteo por sede
python -m pipeline.build_features          # construye features-2.1.0 y exportaciones
python -m pipeline.audit_features          # leakage + comparación de distribuciones
python -m unittest pipeline.test_features -v
python -m pipeline.run_pipeline --features --audit --models --manifest
```

Archivos generados:

- `data/features/feature_store_features-2.1.0.csv` y `.jsonl.gz`
- `data/features/coverage.json`
- `data/features/leakage_audit.json`
- `data/features/distribution_report.json`
- `data/features/web_features.json`
- `data/features/dataset_meta.json`
- `data/FEATURE_DICTIONARY.md`

El feature store es **offline y histórico**. La interfaz live sigue usando el calendario y la forma de ESPN; no se mezclan features históricas con partidos live que no estén cubiertos por el store. Para un partido live fuera de las ligas piloto se muestra el contexto disponible y no se presenta una feature histórica como si fuera observada.

## Modelos y ensamble (Sección 3)

`pipeline/models.py` compara cuatro modelos sobre el feature store histórico y publica un informe separado del motor live. El Poisson + Dixon-Coles sigue siendo el núcleo explicable y el fallback; el ensamble 1X2 combina la logística Elo + xG + tiros a puerta (`57,3%`) con la logística core (`42,7%`).

- **Split temporal:** train `2020-21`–`2022-23` (2.280 partidos), validación `2023-24` (752; mitad calibración por temperatura y mitad aprendizaje de pesos) y test `2024-25` + `2025-26` (1.504 de 1.520 partidos comparables).
- **Modelos:** Poisson + Dixon-Coles, logística Elo + xG, logística core y logística Elo + xG + tiros a puerta. Nada de redes neuronales.
- **Ensamble:** pesos por mercado aprendidos solo en validación, sin piso artificial. En 1X2 pesan la logística con tiros a puerta y la logística core; en los mercados binarios domina Poisson y la logística core solo aporta en over 1.5. La logística Elo + xG queda en cero: se conserva como control, no como aporte predictivo.
- **Test 1X2:** `802/1.504 = 53,32%`, log-loss `0,9891`, Brier `0,5886`, ECE `0,0361` y skill `9,17%` frente a la tasa base. IC95% de accuracy `[50,93%, 55,79%]`.
- **Alta confianza:** con probabilidad `≥80%` acierta `65/74 = 87,84%` con cobertura `4,92%`; con `≥70%` acierta `165/223 = 73,99%` con cobertura `14,83%`. Son subconjuntos selectivos, no el rendimiento global.
- **Comparación honesta:** el Poisson calibrado logra `758/1.504 = 50,40%`, log-loss `1,0094` y Brier `0,6043`. La logística Elo+xG individual acierta `801/1.504` (53,26%), un partido menos que el ensamble, que además mejora log-loss y Brier.
- **Benchmark externo:** el mercado de cierre acierta `802/1.504 = 53,32%` con log-loss `0,9766` y Brier `0,5813`. El ensamble iguala los aciertos pero no la calidad probabilística; se muestra solo como referencia y las cuotas no entran como feature.
- **Fallback:** sin fila de features o sin `elo_diff`, el ensamble usa el Poisson calibrado. Las auxiliares ausentes se imputan con la mediana de entrenamiento y se añade un indicador; no se presentan como observadas.
- **Model cards:** `data/models/model_cards.json` y `data/models/MODEL_CARDS.md`.
- **Artefactos:** `data/models/model_report.json`, `data/models/poisson_baseline.json`, `data/models/historical_matches.json` y `js/data/model_report.js`.

Comandos:

```powershell
node pipeline/export_poisson_baseline.mjs   # baseline Poisson de la UI
python -m pipeline.models                   # entrena, calibra y publica el informe
python -m pipeline.experiment_final_calibration  # diagnóstico de calibración final (no publica)
python -m unittest pipeline.test_models -v
python -m pipeline.run_pipeline --models
```

El informe histórico vive en `js/data/model_report.js` y no se edita a mano. `datos_live.mjs` sigue generando `js/data/validation.js` para el backtest live de Poisson; la UI muestra ambos por separado y no los mezcla.

## Motor V1.0

La base es un modelo Poisson bivariado con corrección Dixon-Coles. Los goles de cada equipo se distribuyen como Poisson(λ) y la matriz permite calcular 1X2, marcador exacto, over/under, BTTS, primer gol y distribución de goles.

```text
λ = μ × ataque × defensa rival × localía × forma reciente × tipo de partido
    × alineación × descanso × viaje × altitud
    × motivación × estado del global
```

El **clima y el árbitro no entran en ningún cálculo**: no multiplican λ, no ajustan tarjetas, penales ni probabilidades, y no aparecen como factores. El clima conserva `usable_for_model: false` en el feature store; el árbitro queda excluido aunque haya datos históricos. Córners y tarjetas usan una binomial negativa para permitir sobredispersión. Los goleadores se reparten el λ del equipo según xG/90, minutos estimados y reparto de penales. La matriz interna es 0-0 a 10-10; la vista 7×7 agrupa la cola.

### Constantes propias

| Parámetro | Valor | Dónde actúa |
| --- | --- | --- |
| Ventana reciente | `10` partidos | Fuerzas por equipo |
| Vida media | `45` días | Decaimiento temporal |
| Mezcla historial/tabla | `60% / 40%` | Fuerza de ataque y defensa |
| Peso de forma con historial | `35%` | Multiplicador de λ |
| Peso de forma sin historial | `60%` | Multiplicador de λ |
| Peso del blend de tiros | `20%` | Solo con tiros reales |
| Mínimo de tiros observados | `2` partidos | Activa el blend |
| Prior de tiros observados | `4` partidos | Contracción de la media |
| Peso máximo del H2H | `12%` | Mínimo 3 partidos |
| Temperatura 1X2 (`T`) | `1.15` | Suaviza el 1X2 final |
| Pendiente Platt (`b`) | `0.85` | Over/under y BTTS |
| Ventaja de localía | `[0.02, 0.16]` | Factor recíproco local/visitante |

1. **Historial reciente.** Se toman los últimos 10 partidos de cada equipo, con peso exponencial por antigüedad y vida media de 45 días. Los goles a favor y en contra se contraen hacia la media de la liga según la muestra disponible. La fuerza resultante se mezcla 60% historial reciente y 40% tabla de temporada.

2. **Forma reciente.** Se usan los últimos resultados: victoria 3 puntos, empate 1, derrota 0. La fuerza bruta es `raw = 0.85 + 0.02 × puntos`. Con historial de goles el peso baja a 35% para no contar dos veces la misma señal; sin historial se queda en 60%. Se aplica con cobertura por muestra y se limita a `[0.9, 1.12]`.

3. **Blend de tiros.** Solo se activa si hay tiros reales por equipo. Mezcla la fuerza de goles con la fuerza de tiros: `80% goles + 20% tiros`. En modo live, los resúmenes de ESPN publican los tiros de los partidos completados. El updater toma los últimos 3 partidos por equipo, exige al menos 2 con estadísticas completas y contrae la media observada hacia la estimación con un prior de 4 partidos. Si no hay muestra suficiente, el blend se omite y la interfaz lo indica. La proyección del partido próximo se sigue marcando como estimada.

4. **Localía normalizada por liga.** Se toma la ventaja bruta de `homeFactor` y `awayFactor`, se limita a `[0.02, 0.16]` y se aplica de forma recíproca: `home = 1 + edge`, `away = 1 / home`. Así el producto local × visitante es 1 y la localía no infla el total de goles.

5. **H2H conservador.** Se calcula intersectando los calendarios de ESPN de la temporada actual y la anterior. Se orienta a los equipos del partido actual y se aplica con un peso máximo del 12%, solo si hay al menos 3 enfrentamientos. No sustituye la forma reciente.

6. **Temperatura del 1X2.** La matriz produce `p_cruda`; el 1X2 final se calcula con `p_final = normalize(p_cruda^(1/T))`, con `T = 1.15`. Suaviza las probabilidades extremas sin cambiar el orden de las opciones. No se aplica a la matriz ni a los marcadores exactos.

7. **Calibración binaria tipo Platt.** Para over 1.5, over 2.5, over 3.5 y BTTS: `logit(p_final) = logit(p_base) + b × [logit(p_cruda) - logit(p_base)]`, con `b = 0.85`. La base `p_base` se calcula con un partido de dos equipos promedio de la liga.

8. **Goles por tiempo.** Se reparten con una referencia histórica conservadora: 44% en el primer tiempo y 56% en el segundo, ajustada por el ritmo de la liga y del partido.

La matriz, los marcadores exactos, la distribución, el primer gol, los goleadores, córners, tarjetas, tiros y posesión **no se recalibran**. El 1X2 final, los overs y BTTS son la capa calibrada. Por eso el 1X2 final y la matriz cruda pueden no sumar exactamente igual; es intencional y la interfaz lo explica en cada detalle.

### Certeza del pronóstico

La capa **Certeza del pronóstico** describe la forma del 1X2 sin cambiar el modelo:

- **Separación:** diferencia en puntos porcentuales entre la salida más probable y la segunda. `>= 22 pp` se etiqueta Favorito claro, `>= 10 pp` Favorito moderado y el resto Partido abierto.
- **Rango de goles:** cuantiles 10% y 90% de la distribución total de goles de la matriz; la UI lo muestra como “80% central”.
- **Favorito:** la salida con mayor probabilidad calibrada, con su probabilidad.

No es la probabilidad de acertar ni la calidad de los datos. La confianza del contexto mide completitud; la certeza mide concentración de probabilidad. Un favorito claro puede perder y un partido abierto puede tener un ganador claro.

### Desempate de partidos parejos

El 1X2 oficial puede dejar el empate arriba por apenas 2 puntos porcentuales. Eso no basta para tratarlo como certeza. Cuando el empate es alto, OX añade una **lectura ajustada** separada: mira el desempeño previo, el H2H, los goles esperados, los córners, las tarjetas y la localía para decidir si el partido sigue siendo un empate técnico o si hay señales suficientes para inclinarlo hacia un lado.

**Cuándo se activa.** Se exige empate `>= 28%` y al menos una de estas condiciones:

- el marcador más probable es un empate corto (`0-0` o `1-1`);
- el empate lidera el 1X2 por `<= 5 pp`;
- el marcador empatado está cerca del favorito.

Si el empate es alto pero el marcador más probable es, por ejemplo, `2-1`, el panel queda visible como referencia y no aplica ajuste.

**Señales y pesos.** Cada señal se normaliza a `[-1, 1]`: positivo favorece al local, negativo al visitante.

| Señal | Peso | Qué mide |
| --- | --- | --- |
| Desempeño previo | `38%` | PPG y diferencia de goles de los últimos 10; si falta, tabla |
| H2H | `18%` | Victorias y goles directos, mínimo 3 partidos |
| Goles esperados | `16%` | Diferencia de λ de OX V1.0 |
| Córners | `12%` | Diferencia de córners esperados |
| Tarjetas | `8%` | Menos tarjetas, mejor disciplina |
| Localía | `8%` | Ventaja de jugar en casa; sede neutral = 0 |

**Fórmula.**

```text
edge = Σ(peso_i × señal_i) / Σ(peso_i)
edge_ajustado = edge × fiabilidad
```

La fiabilidad es la media ponderada de la fiabilidad de cada señal disponible. Si `|edge_ajustado| <= 4 pp`, la lectura es **empate técnico** y no se transfiere probabilidad. Si supera el umbral, se restan entre `1.5` y `6 pp` al empate y se suman al lado con mejor edge. El 1X2 oficial **no cambia**: la interfaz muestra las dos filas y lo advierte.

En modo live, córners y tarjetas son estimaciones de liga. Se marcan como `est.` y su fiabilidad baja a `0.55`, de modo que pesan menos en el edge. El H2H sin muestra suficiente también se excluye y su peso se reparte entre las señales disponibles.

El panel vive en **Análisis > Probabilidades**, con veredicto, tabla oficial/ajustada, señales, fórmula y pasos. También aparece como badge en el hero, como fila en **Contexto > Datos** y como tarjetas en el panel del motor. Al hacer clic se abre el cálculo completo.

En la foto actual del dataset, 19 de 120 partidos activan la lectura: 3 quedan como empate técnico y 16 se inclinan (8 hacia el local y 8 hacia el visitante).

## Validación y total de aciertos

La UI separa dos mediciones que no deben confundirse:

### Ensamble histórico (headline)

El informe de la Sección 3 entrena con `2020-21`–`2022-23`, calibra y aprende pesos en `2023-24`, y evalúa una sola vez en `2024-25` + `2025-26`:

- **1X2:** `802/1.504 = 53,32%` de aciertos, log-loss `0,9891`, Brier `0,5886`, ECE `0,0361` y skill `9,17%` frente a la tasa base.
- **IC95% de accuracy:** `[50,93%, 55,79%]`.
- **Poisson calibrado:** `758/1.504 = 50,40%`, log-loss `1,0094` y Brier `0,6043`.
- **Mercado de cierre (solo benchmark):** `802/1.504 = 53,32%`, log-loss `0,9766` y Brier `0,5813`; no entra como feature.

El botón **Total de aciertos** muestra `802/1504` y la tasa `53,3%`; en móvil, la tarjeta muestra `802` con `de 1504 · 53,3%`. El modal “Ensamble · test temporal” incluye métricas por mercado, pesos, calibración, benchmark, desglose por liga/temporada y partidos recientes.

### Modo de alta confianza (Fase 1)

El sidebar incluye un filtro **Confianza 1X2** con umbrales `≥70%` y `≥80%`. Filtra por la probabilidad máxima del favorito que muestra el motor live (Poisson + Dixon-Coles); no es la confianza del contexto ni una garantía de acierto. La tabla histórica es del ensamble, que es offline y no se inyecta en la lista live. El modal de precisión añade **Cobertura vs. acierto**:

| Umbral | Partidos | Cobertura | Acierto observado |
|---|---:|---:|---:|
| ≥80% | 74 | 4,92% | 87,84% |
| ≥70% | 223 | 14,83% | 73,99% |
| 80–90% | 71 | 4,72% | 87,32% |
| 70–80% | 149 | 9,91% | 67,11% |
| 60–70% | 283 | 18,82% | 61,84% |
| 50–60% | 363 | 24,14% | 49,31% |

El tramo ≥80% incluye tres partidos en 90–100% además de los 71 en 80–90%; por eso el agregado es 74. **80–90% en todos los partidos no es realista:** incluso el mercado de cierre acierta 53,32%. La meta honesta es 80–90% en el subconjunto de alta confianza, reportando siempre la cobertura. En la ventana live verificada el máximo fue 59,2%, así que el filtro ≥70% mostró 0 partidos; eso es esperado y el estado vacío lo explica.

La calibración final del ensamble se probó solo en validación (376 partidos) con validación cruzada por bloques. Temperature scaling mejoró log-loss en `0,00013` pero empeoró Brier en `0,000004`; el escalado por clase y el vector scaling empeoraron log-loss, Brier y accuracy. **No se adoptó:** el headline sigue en `802/1504` y el test no se usó para elegir la calibración.

### Backtest live de Poisson (secundario)

El motor live conserva su propio walk-forward, que no es el mismo corte que el ensamble:

- Se ordenan los partidos por fecha y se reserva el 30% final de cada liga como test.
- Para cada partido del test solo se usan resultados anteriores. No hay fuga de información ni alineaciones retroactivas.
- Se exigen al menos 4 partidos previos por equipo y 20 por liga.
- Se comparan los mercados 1X2, BTTS y over 1.5/2.5/3.5 con un baseline de la propia liga.
- La métrica principal es el Brier score; `skill = 1 - Brier / baseline`.

Foto actual del dataset live:

- 1.424 partidos evaluados en 11 ligas, con 5.015 eventos de historial.
- Brier 1X2 `0.6243` frente a baseline `0.6457`; skill `+3.3%`.
- BTTS skill `+0.2%`; over 1.5 `+0.5%`, over 2.5 `+0.8%` y over 3.5 `+0.05%`.
- Aciertos 1X2: `658 / 1.424 = 46.2%`.
- Racha actual `1`; mejor racha `8`.

El total de aciertos del ensamble es una simulación histórica del pronóstico 1X2 más probable; no son pronósticos publicados antes del partido ni una recomendación. El panel de precisión muestra calibración por bins, evolución mensual, desglose por liga y partidos recientes. Si un mercado no mejora al baseline, se muestra con honestidad.

## Equipos latentes

El apartado **Equipos latentes** analiza el tercio medio de cada liga y los partidos en los que un equipo de la parte baja venció a uno de los primeros puestos.

- Las posiciones históricas se reconstruyen con los resultados anteriores a cada partido: nunca se usa la tabla final como fuga de información.
- La tabla mide puntos por partido, últimos 10, racha actual, índice de apoyo, muestra y próximo partido.
- El índice de apoyo combina resultados recientes, racha y contexto; se muestra con un tono `pos`, `neutral` o `neg`.
- Las rachas se agrupan en `3+ victorias`, `2 victorias`, `1 victoria`, `3+ empates`, `2 empates`, `1 empate`, `3+ derrotas`, `2 derrotas` y `1 derrota`.
- Las sorpresas de tabla incluyen ganador, perdedor, posiciones, marcador, diferencia de goles y contexto.

Foto actual: 112 equipos en el tercio medio, 257 sorpresas y 2.231 casos de racha, con una base de victoria del 36.0%. Son lecturas descriptivas: una racha no garantiza que el patrón se repita y el índice no es una recomendación.

## Jugadores y cronología

El panel **Quién rindió y por qué** usa el `summary` público de ESPN:

- `rosters`: estadísticas individuales del partido (goles, asistencias, remates, tarjetas, minutos).
- `keyEvents`: goles, penales, autogoles, tarjetas y cambios.
- `commentary`: apoyo para asistencias y narración.

La fuente es **ESPN, no Google**. La interfaz lo indica para no atribuir mal la procedencia. El panel agrega los últimos 3 partidos por equipo, muestra el índice de impacto y explica el resultado con el marcador, los remates y la cronología. La cronología se muestra solo del partido más reciente para no duplicar datos.

La cronología conserva todos los goles, penales, autogoles y rojas aunque superen el límite visual de 18 eventos; completa con los eventos más recientes. Cada gol muestra el marcador acumulado cuando la fuente lo permite o cuando se puede reconstruir con el resultado final. No se muestra la narración cruda en inglés.

## Interacción

- **Hover** sobre un porcentaje, tarjeta o jugador: aparece un resumen con los factores principales.
- **Clic o toque** sobre el mismo elemento: se abre un panel con el cálculo completo, la fórmula y la advertencia.
- **Total de aciertos**: abre el modal de precisión con el ensamble histórico, el desglose por liga, la calibración y los partidos recientes; el backtest live de Poisson queda como sección secundaria.
- **Certeza del pronóstico**: dentro del panel de confianza, muestra la separación entre la salida más probable y la segunda, el favorito y el rango central del 80% de goles. No es la probabilidad de acertar.
- **Equipos latentes**: abre la tabla de riesgo del tercio medio, las sorpresas y las rachas. Por defecto usa la liga del partido seleccionado; puedes cambiar a “Todas”.
- **Pestañas**: tres paneles agrupan Análisis (Probabilidades · Proyección · Goles · Escenarios), Jugadores (secciones apiladas sin pestañas) y Contexto (Lectura · Datos). Calibración y calidad viven dentro de Probabilidades; el desempate de partidos parejos también; tiempos y matriz dentro de Goles; forma reciente, H2H y tabla dentro de Datos.
- **Próximos 7 días**: cartelera agrupada por día, con días colapsables y filas clicables. Cada fila abre el partido; el botón **Ver en la lista** activa el filtro de 7 días en la barra lateral.
- **Deportes**: la franja superior solo muestra **Fútbol**. AIFUT no inventa datos de otros deportes.
- **Tabla de mercados**: probabilidad del modelo frente al 1X2 crudo o la base de la liga, con la diferencia en puntos porcentuales. Solo probabilidades del modelo.
- **Proyección**: aplica `VE = Σ(P_i × G_i) − C` a puntos de fútbol, con `G = 3/1/0` para victoria, empate y derrota. `C` es el PPG de referencia del equipo (`pts / PJ`, últimos 10 resultados o 1.35 de fallback). Muestra el partido actual y tres escenarios posteriores por equipo; cuando el calendario no trae un fixture confirmado, se modelan contra un rival promedio de la liga y se marcan como «modelado». El VE se expresa solo en puntos.
- **Escenarios**: probabilidad conjunta exacta desde la matriz para 1X2, goles y BTTS, más probabilidad de fallo, avisos y correlación. Córners y tarjetas se combinan por independencia del modelo, con advertencia.
- **Filtros** de la barra lateral: Todos, Hoy, Mañana, 7 días y Por liga.
- **Buscador** por equipo, estadio, fase o competición.
- **Compartir** copia el enlace del partido seleccionado.
- **Imprimir** genera una versión limpia del análisis.
- **Teclado**: `Tab` recorre los elementos explicables, `Enter` abre el cálculo y `Escape` cierra el panel.

La interfaz es responsive: sidebar fija en escritorio, menú deslizante en tablet/móvil y barra de herramientas móvil con aciertos, latentes y precisión. Los modales tienen cabecera fija y contenido con scroll interno. Las tablas de latentes se convierten en tarjetas en pantallas estrechas.

## Tus datos

La forma recomendada es editar `mis_datos.py`, que valida la información y genera los cuatro archivos JS de la cartelera:

1. Abre `mis_datos.py` y edita `LIGA`, `EQUIPOS` y `PARTIDOS`.
2. Valida sin escribir nada:

   ```powershell
   python mis_datos.py --validar
   ```

3. Genera los datos:

   ```powershell
   python mis_datos.py
   ```

4. Recarga `http://127.0.0.1:4173`.

El primer uso guarda una copia de los datos de respaldo en `_respaldo_demo/`. Para volver a los datos de respaldo:

```powershell
python mis_datos.py --restaurar
```

La restauración vuelve a `league.js`, `teams.js`, `matches.js` y `tables.js`; `validation.js`, `latent.js` y los resúmenes de jugadores persisten. Si cargas datos propios, la calidad del análisis dependerá de la fuente y de la calibración del modelo.

También puedes generar en otra carpeta con `--salida ruta/a/carpeta`. El archivo incluye comentarios con el significado de cada campo y comprueba ids repetidos, equipos inexistentes, fechas mal escritas, estadísticas fuera de rango y bajas que no coinciden con ningún jugador.

**Los datos de ejemplo de `mis_datos.py` son simulados** (temporada Apertura 2026). Los equipos, plantillas, estadísticas, fechas, sedes y árbitros son de respaldo. No son pronósticos reales ni recomendaciones. El dataset live que viene cargado, en cambio, procede de ESPN y se actualiza con `datos_live.mjs`.

## Estructura

```text
previa/
  index.html
  css/styles.css
  js/app.js
  js/data/league.js
  js/data/teams.js
  js/data/matches.js
  js/data/tables.js
  js/data/reference.js      # partido de referencia espn-761922 y su contexto
  js/data/validation.js     # backtest walk-forward, calibración y aciertos
  js/data/model_report.js   # informe del ensamble histórico (generado)
  js/data/latent.js         # tercio medio, rachas y sorpresas
  js/model/core.js
  js/model/calibration.js   # constantes y capa de calibración de OX V1.0
  js/model/ratings.js       # forma reciente, fuerzas y H2H
  js/model/tiebreak.js      # desempate de partidos parejos y lectura ajustada
  js/model/backtest.js      # validación walk-forward y total de aciertos
  js/model/latent.js        # equipos latentes y sorpresas
  js/model/players.js       # jugadores y cronología ESPN
  js/model/explain.js
  js/model/index.js
  datos_live.mjs            # adaptador ESPN y generación del dataset live
  mis_datos.py              # validación y carga de datos propios
  pipeline/                 # pipeline histórica reproducible (Secciones 1-3)
    db.py                   # esquema SQLite y normalización de equipos
    ingest_football_data.py # resultados, estadísticas y cuotas
    ingest_xg.py            # xG/xGA desde Understat
    ingest_lineups.py       # alineaciones históricas desde ESPN
    validate_data.py        # auditoría de integridad y cobertura
    build_manifest.py       # manifiesto, checksums y linaje
    models.py               # cuatro modelos, calibración y ensamble (Sección 3)
    test_models.py          # pruebas del informe de modelos
    export_poisson_baseline.mjs # baseline Poisson para el mismo corte
    run_pipeline.py         # orquestador end-to-end
  data/
    database.sqlite         # base histórica de las ligas piloto
    manifest.json           # versión, cobertura, fuentes y checksums
    models/                 # reporte, model cards y baseline Poisson
    SOURCES.md              # matriz de fuentes y límites
    DATA_DICTIONARY.md      # diccionario de tablas y procedencia
    raw/                    # CSV, parquet y extractos de alineaciones
  _respaldo_demo/           # copia de los datos de respaldo (se crea al generar)
  _respaldo_antes_live/     # copia previa a la primera actualización live
  .cache/espn/              # caché local de la API de ESPN
  server.js
  test-model.mjs
  iniciar.cmd
```

**Nota sobre la carpeta:** el proyecto conserva la carpeta local `previa/` para no romper rutas, el servidor y los accesos directos. El nombre de la página es **AIFUT** y el del motor es **OX**; `previa/` es solo la ubicación del código. Por la misma razón se mantienen nombres internos como `_respaldo_demo/`, el flag `demo` y el identificador `motor-nox-v1`, que no aparecen en la interfaz.

## Limitaciones

- En modo live, la confianza mide la completitud del contexto, no la probabilidad de acertar. No hay XI confirmado para partidos próximos ni xG/90 por jugador; el clima y el árbitro no entran en el cálculo. La base histórica sí tiene XI de partidos completados, pero no minutos oficiales.
- Córners, tarjetas y posesión en modo live son estimaciones a partir de promedios de liga y fuerzas. Los tiros por equipo sí se toman de los resúmenes de ESPN cuando hay muestra; la proyección de tiros del partido próximo sigue siendo una estimación, no una estadística observada.
- La calibración V1.0 sigue siendo un prior conservador. La validación walk-forward es una foto histórica, no una garantía universal.
- El total de aciertos es una simulación del pronóstico 1X2 más probable en el backtest, no el registro de pronósticos publicados antes de cada partido.
- El modelo no predice eventos en vivo, expulsiones, lesiones durante el partido ni prórroga/penales.
- El desempate es una lectura separada del 1X2 oficial. No cambia las probabilidades de OX V1.0 ni la matriz; solo responde a si un empate alto merece inclinarse. Sus pesos son una elección propia y no están validados walk-forward como el 1X2.
- La cronología depende de lo que ESPN publique. Si faltan eventos o estadísticas, se indica en vez de inventarlos.
- Las posiciones históricas de los latentes se reconstruyen con los resultados disponibles; en ligas con pocos partidos la muestra puede ser corta.
- Los escenarios combinan condiciones del mismo partido y pueden acumular error de estimación. La probabilidad conjunta no es una recomendación ni una garantía.
- No hay datos licenciados ni señales externas. Para producción hacen falta backtesting adicional, calibración con datos propios y revisión legal de las fuentes.

## Fuentes y uso

- Datos live: API pública de ESPN (`site.api.espn.com`). Se consultan tablas y calendarios de 14 competiciones, con caché local y límite de peticiones concurrentes.
- Sofascore se usó como referencia visual de estructura (navegación por deporte, filtros de fecha/estado, filas compactas agrupadas por jornada y jerarquía tipográfica), no como fuente de datos ni de probabilidades.
- Resúmenes de jugadores, cronología y tiros por equipo: `summary` de ESPN, con caché de 12 horas. Los tiros observados se contraen hacia la estimación y la procedencia queda en `shotsSource`/`shotsSample`.
- `futboldatapro.com` se usó como referencia de producto y flujo, no como fuente de datos ni de probabilidades. OX V1.0 es una implementación independiente, con fórmulas y constantes propias; no se copió su código ni su modelo.
- Uso personal y educativo. No se permite scraping masivo, reventa ni redistribución comercial de los datos de terceros sin autorización. Revisa los términos de ESPN y de cada proveedor antes de desplegar esto públicamente.
- Las probabilidades son una lectura educativa. No son consejo financiero ni una promesa de resultados.
