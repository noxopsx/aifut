// Generado automáticamente. Sin claves ni secretos.
export const SOURCE_STATUS = {
  "schema": "motor-nox.source-status.v1",
  "generatedAt": "2026-11-20T16:17:23Z",
  "providers": {
    "espn": {
      "source": "ESPN",
      "configured": true,
      "status": "ok",
      "quality": "observed",
      "as_of": "2026-11-20T16:17:23Z",
      "events": 2705,
      "plan": "public",
      "budget": null,
      "note": "Calendario, tabla, forma y sedes públicos.",
      "checkedAt": "2026-11-20T16:17:23Z",
      "key": "espn"
    },
    "api_football": {
      "source": "API-Football v3 (Free)",
      "configured": true,
      "status": "ok",
      "quality": "observed",
      "as_of": null,
      "events": 1786,
      "plan": "Free",
      "budget": {
        "plan": "Free",
        "active": true,
        "limit_day": 100,
        "used": 39,
        "remaining": 61,
        "reserve": 5
      },
      "note": "Plan Free: ventana móvil de ±1 día, partidos en directo y backfill 2022-2024.",
      "checkedAt": "2026-11-20T16:17:23Z",
      "key": "api_football"
    },
    "football_data_org": {
      "source": "football-data.org (Free)",
      "configured": false,
      "status": "sin-clave",
      "quality": null,
      "as_of": null,
      "events": null,
      "plan": null,
      "budget": null,
      "note": "Sin clave: define FOOTBALLDATA_KEY o ejecuta --save-key.",
      "checkedAt": "2026-11-20T16:17:23Z",
      "key": "football_data_org"
    },
    "footballapi_org": {
      "source": "footballapi.org (gratuito)",
      "configured": false,
      "status": "sin-clave",
      "quality": null,
      "as_of": null,
      "events": null,
      "plan": null,
      "budget": null,
      "note": "Sin clave: define FOOTBALLAPI_KEY o ejecuta --save-key.",
      "checkedAt": "2026-11-20T16:17:23Z",
      "key": "footballapi_org"
    }
  }
};
