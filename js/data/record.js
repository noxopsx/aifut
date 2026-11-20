// Generado por pipeline.reconcile_results. No editar a mano.
// generatedAt: 2026-11-15T21:15:13Z · registrados: 1 · publicados: 0 · reconciliados: 0
export const RECORD = {
  "schema": "motor-nox.record.v1",
  "generatedAt": "2026-11-15T21:15:13Z",
  "policy": "threshold>=0.70",
  "thresholds": [
    0.7
  ],
  "modelVersions": [
    "live-poisson-1.0"
  ],
  "registered": 1,
  "published": 0,
  "scored": 0,
  "publishedScored": 0,
  "hits": 0,
  "accuracy": null,
  "coverage": 0.0,
  "ci95": null,
  "ci95Wilson": null,
  "brier": null,
  "brierAll": null,
  "pending": 1,
  "void": 0,
  "lastReconciledAt": null,
  "byLeague": [
    {
      "leagueId": "gua.1",
      "leagueName": "Liga Nacional de Guatemala",
      "registered": 1,
      "published": 0,
      "scored": 0,
      "hits": 0,
      "accuracy": null
    }
  ],
  "buckets": [
    {
      "label": "≥ 80%",
      "from": 0.8,
      "to": 1.0,
      "registered": 0,
      "scored": 0,
      "hits": 0,
      "accuracy": null,
      "coverage": 0.0
    },
    {
      "label": "70–80%",
      "from": 0.7,
      "to": 0.8,
      "registered": 0,
      "scored": 0,
      "hits": 0,
      "accuracy": null,
      "coverage": 0.0
    },
    {
      "label": "60–70%",
      "from": 0.6,
      "to": 0.7,
      "registered": 0,
      "scored": 0,
      "hits": 0,
      "accuracy": null,
      "coverage": 0.0
    },
    {
      "label": "< 60%",
      "from": 0.0,
      "to": 0.6,
      "registered": 1,
      "scored": 0,
      "hits": 0,
      "accuracy": null,
      "coverage": 1.0
    }
  ],
  "recent": [],
  "emptyReason": "Hay 1 pronóstico registrado, pero ninguno alcanzó el umbral de publicación (70%). El récord público queda vacío a propósito: no se publican picks de baja confianza.",
  "coverageBasis": "picks publicados / pronósticos registrados",
  "snapshotDir": "data/snapshots/forecasts"
};
