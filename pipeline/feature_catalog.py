"""
Catálogo de features pre-partido de MOTOR-NOX V1.0.

Cada entrada documenta qué significa la feature, de dónde sale y qué grupo de
cobertura alimenta. La calidad real (observed / estimated / missing) se decide
en build_features.py según el dato disponible para cada partido.
"""

from __future__ import annotations


def _f(label: str, definition: str, source: str, group: str, quality: str = "observed", usable: bool = True) -> dict:
    return {
        "label": label,
        "definition": definition,
        "source": source,
        "group": group,
        "quality": quality,
        "model_usable": usable,
    }


FEATURE_CATALOG = {
    # ------------------------------------------------------------------
    # Contexto de liga
    # ------------------------------------------------------------------
    "league_goals_avg_prior": _f(
        "Media de goles de liga (previa)",
        "Goles por equipo y partido en la liga usando solo partidos anteriores; contracción a 1.35.",
        "Football-Data.co.uk · cálculo propio",
        "context",
        quality="estimated",
    ),
    "league_xg_avg_prior": _f(
        "Media de xG de liga (previa)",
        "xG por equipo y partido en la liga usando solo partidos anteriores con xG; contracción a 1.35.",
        "Understat · cálculo propio",
        "context",
        quality="estimated",
    ),

    # ------------------------------------------------------------------
    # xG / xGA rolling y splits
    # ------------------------------------------------------------------
    **{
        f"{side}_xg_{kind}_{window}{suffix}": _f(
            f"xG {kind} {side} {window}{' (local)' if suffix == '_home' else ' (visitante)' if suffix == '_away' else ''}",
            f"Media de xG {'a favor' if kind == 'for' else 'en contra'} del equipo {side} en sus últimos {window} partidos"
            f"{' como local' if suffix == '_home' else ' como visitante' if suffix == '_away' else ''}, usando solo partidos anteriores.",
            "Understat · media móvil",
            "xg_rolling",
            quality="estimated",
        )
        for side in ("home", "away")
        for kind in ("for", "against")
        for window in (5, 10, 20)
        for suffix in ("",)
    },
    **{
        f"{side}_xg_{kind}_5_{venue}": _f(
            f"xG {kind} {side} (split {'local' if venue == 'home' else 'visitante'})",
            f"Media de xG {'a favor' if kind == 'for' else 'en contra'} del equipo {side} en sus últimos 5 partidos"
            f"{' como local' if venue == 'home' else ' como visitante'}, usando solo partidos anteriores.",
            "Understat · media móvil por sede",
            "xg_rolling",
            quality="estimated",
        )
        for side, venue in (("home", "home"), ("away", "away"))
        for kind in ("for", "against")
    },
    **{
        f"{prefix}xg_diff_{window}": _f(
            f"Diferencial de xG {prefix}{window}",
            "xG a favor menos xG en contra en los últimos N partidos. En la versión de partido, diferencia local menos visitante.",
            "Understat · cálculo propio",
            "xg_rolling",
            quality="estimated",
        )
        for prefix in ("home_", "away_", "")
        for window in (5, 10, 20)
    },

    # ------------------------------------------------------------------
    # Tiros
    # ------------------------------------------------------------------
    **{
        f"{side}_shots_{kind}_10": _f(
            f"Tiros {kind} {side} (10)",
            f"Media de tiros {'a favor' if kind == 'for' else 'en contra'} del equipo {side} en sus últimos 10 partidos.",
            "Football-Data.co.uk · media móvil",
            "shots",
        )
        for side in ("home", "away")
        for kind in ("for", "against")
    },
    **{
        f"{side}_sot_{kind}_10": _f(
            f"Tiros a puerta {kind} {side} (10)",
            f"Media de tiros a puerta {'a favor' if kind == 'for' else 'en contra'} del equipo {side} en sus últimos 10 partidos.",
            "Football-Data.co.uk · media móvil",
            "shots",
        )
        for side in ("home", "away")
        for kind in ("for", "against")
    },

    # ------------------------------------------------------------------
    # PPDA / presión
    # ------------------------------------------------------------------
    **{
        f"{side}_ppda_{window}": _f(
            f"PPDA {side} ({window})",
            f"Passes allowed per defensive action del equipo {side} en sus últimos {window} partidos; menor = más presión.",
            "Understat · media móvil",
            "ppda",
        )
        for side in ("home", "away")
        for window in (5, 10)
    },

    # ------------------------------------------------------------------
    # Elo
    # ------------------------------------------------------------------
    "home_elo_pre": _f(
        "Elo local (pre-partido)",
        "Rating Elo del local antes del kickoff. K=20, ventaja local 65, multiplicador por diferencia de goles.",
        "Cálculo propio sobre resultados observados",
        "elo",
        quality="estimated",
    ),
    "away_elo_pre": _f(
        "Elo visitante (pre-partido)",
        "Rating Elo del visitante antes del kickoff. K=20, ventaja local 65, multiplicador por diferencia de goles.",
        "Cálculo propio sobre resultados observados",
        "elo",
        quality="estimated",
    ),
    "elo_diff": _f(
        "Diferencial de Elo",
        "Elo local menos Elo visitante antes del kickoff.",
        "Cálculo propio sobre resultados observados",
        "elo",
        quality="estimated",
    ),

    # ------------------------------------------------------------------
    # Descanso y congestión
    # ------------------------------------------------------------------
    "home_rest_days": _f(
        "Descanso local (días)",
        "Días desde el último partido completado del local hasta el kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "rest_congestion",
    ),
    "away_rest_days": _f(
        "Descanso visitante (días)",
        "Días desde el último partido completado del visitante hasta el kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "rest_congestion",
    ),
    "rest_diff": _f(
        "Diferencial de descanso",
        "Días de descanso del local menos días del visitante.",
        "Cálculo propio",
        "rest_congestion",
    ),
    "home_matches_14d": _f(
        "Partidos local en 14 días",
        "Partidos de liga del local en los 14 días anteriores al kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "rest_congestion",
    ),
    "away_matches_14d": _f(
        "Partidos visitante en 14 días",
        "Partidos de liga del visitante en los 14 días anteriores al kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "rest_congestion",
    ),
    "matches_14d_diff": _f(
        "Diferencial de congestión (14 días)",
        "Partidos del local menos partidos del visitante en 14 días.",
        "Cálculo propio",
        "rest_congestion",
    ),
    "home_matches_21d": _f(
        "Partidos local en 21 días",
        "Partidos de liga del local en los 21 días anteriores al kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "rest_congestion",
    ),
    "away_matches_21d": _f(
        "Partidos visitante en 21 días",
        "Partidos de liga del visitante en los 21 días anteriores al kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "rest_congestion",
    ),
    "matches_21d_diff": _f(
        "Diferencial de congestión (21 días)",
        "Partidos del local menos partidos del visitante en 21 días.",
        "Cálculo propio",
        "rest_congestion",
    ),
    "home_cup_europe_matches_14d": _f(
        "Partidos de copa/Europa local (14 días)",
        "Partidos de copa o competición europea del local en 14 días. No disponible en la base actual.",
        "No disponible · la base solo cubre liga",
        "rest_congestion",
        quality="missing",
        usable=False,
    ),
    "away_cup_europe_matches_14d": _f(
        "Partidos de copa/Europa visitante (14 días)",
        "Partidos de copa o competición europea del visitante en 14 días. No disponible en la base actual.",
        "No disponible · la base solo cubre liga",
        "rest_congestion",
        quality="missing",
        usable=False,
    ),

    # ------------------------------------------------------------------
    # Viaje
    # ------------------------------------------------------------------
    "home_travel_km": _f(
        "Viaje local (km)",
        "Distancia Haversine entre la sede habitual del local y la sede del partido; 0 si juega en su sede.",
        "venues · cálculo Haversine",
        "travel",
    ),
    "away_travel_km": _f(
        "Viaje visitante (km)",
        "Distancia Haversine entre la sede habitual del visitante y la sede del partido.",
        "venues · cálculo Haversine",
        "travel",
    ),
    "travel_diff": _f(
        "Diferencial de viaje",
        "Kilómetros del visitante menos kilómetros del local.",
        "Cálculo propio",
        "travel",
    ),
    "travel_timezone_diff_h": _f(
        "Diferencial de huso horario",
        "Diferencia absoluta de offset horario entre las sedes al kickoff. En ligas domésticas es 0.",
        "Cálculo propio · reglas DST de Inglaterra/España",
        "travel",
    ),

    # ------------------------------------------------------------------
    # Derbi / rivalidad
    # ------------------------------------------------------------------
    "is_derby": _f(
        "Derbi (0/1)",
        "1 si el par está en la tabla curada de rivalidades; 0 si no está listado.",
        "Tabla curada MOTOR-NOX",
        "derby",
    ),
    "rivalry_intensity": _f(
        "Intensidad de rivalidad",
        "Intensidad 0-1 de la tabla curada; 0 si el par no está listado.",
        "Tabla curada MOTOR-NOX",
        "derby",
    ),
    "rivalry_name": _f(
        "Nombre de la rivalidad",
        "Nombre del derbi si el par está listado; null si no.",
        "Tabla curada MOTOR-NOX",
        "derby",
        usable=False,
    ),

    # ------------------------------------------------------------------
    # Importancia
    # ------------------------------------------------------------------
    "home_position": _f(
        "Posición local (previa)",
        "Posición del local en la tabla usando solo partidos anteriores de la temporada.",
        "Football-Data.co.uk · cálculo propio",
        "importance",
    ),
    "away_position": _f(
        "Posición visitante (previa)",
        "Posición del visitante en la tabla usando solo partidos anteriores de la temporada.",
        "Football-Data.co.uk · cálculo propio",
        "importance",
    ),
    "position_diff": _f(
        "Diferencial de posición",
        "Posición del local menos posición del visitante; negativo = local mejor clasificado.",
        "Cálculo propio",
        "importance",
    ),
    "home_ppg": _f(
        "Puntos por partido local",
        "Puntos por partido del local en la temporada antes del kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "importance",
    ),
    "away_ppg": _f(
        "Puntos por partido visitante",
        "Puntos por partido del visitante en la temporada antes del kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "importance",
    ),
    "home_title_contention": _f(
        "Pelea por el título local (0/1)",
        "1 si el local está en puestos de título (top 4) con al menos 10 partidos jugados.",
        "Cálculo propio",
        "importance",
    ),
    "away_title_contention": _f(
        "Pelea por el título visitante (0/1)",
        "1 si el visitante está en puestos de título (top 4) con al menos 10 partidos jugados.",
        "Cálculo propio",
        "importance",
    ),
    "home_relegation_risk": _f(
        "Riesgo de descenso local (0/1)",
        "1 si el local está en los últimos 3 puestos con al menos 10 partidos jugados.",
        "Cálculo propio",
        "importance",
    ),
    "away_relegation_risk": _f(
        "Riesgo de descenso visitante (0/1)",
        "1 si el visitante está en los últimos 3 puestos con al menos 10 partidos jugados.",
        "Cálculo propio",
        "importance",
    ),
    "match_importance": _f(
        "Importancia del partido",
        "Multiplicador 1.0 normal; 1.15 si hay pelea de título/descenso; 1.10 si es derbi. Se toma el máximo.",
        "Cálculo propio",
        "importance",
    ),
    "season_progress": _f(
        "Progreso de temporada",
        "Partidos de liga ya disputados en la temporada divididos por el total de partidos de la temporada.",
        "Cálculo propio",
        "importance",
    ),
    "is_final_phase": _f(
        "Fase final (0/1)",
        "1 si el progreso de temporada es >= 75%.",
        "Cálculo propio",
        "importance",
    ),

    # ------------------------------------------------------------------
    # Alineaciones
    # ------------------------------------------------------------------
    "home_lineup_continuity": _f(
        "Continuidad del XI local",
        "Jaccard entre los titulares de los dos últimos partidos del local. Proxy de rotación, disponible antes del kickoff.",
        "ESPN · alineaciones históricas",
        "lineups",
    ),
    "away_lineup_continuity": _f(
        "Continuidad del XI visitante",
        "Jaccard entre los titulares de los dos últimos partidos del visitante. Proxy de rotación, disponible antes del kickoff.",
        "ESPN · alineaciones históricas",
        "lineups",
    ),
    "home_formation_last": _f(
        "Formación local (último partido)",
        "Formación usada por el local en su último partido completado.",
        "ESPN · alineaciones históricas",
        "lineups",
    ),
    "away_formation_last": _f(
        "Formación visitante (último partido)",
        "Formación usada por el visitante en su último partido completado.",
        "ESPN · alineaciones históricas",
        "lineups",
    ),
    "home_squad_depth": _f(
        "Profundidad de plantilla local",
        "Jugadores distintos que han sido titulares con el local en la temporada antes del kickoff.",
        "ESPN · alineaciones históricas",
        "lineups",
    ),
    "away_squad_depth": _f(
        "Profundidad de plantilla visitante",
        "Jugadores distintos que han sido titulares con el visitante en la temporada antes del kickoff.",
        "ESPN · alineaciones históricas",
        "lineups",
    ),
    "home_lineup_confirmed": _f(
        "XI local confirmado (0/1)",
        "0 en el store histórico: el XI del partido actual se conoce después del kickoff y no se usa como feature.",
        "ESPN · limitación temporal",
        "lineups",
        quality="observed",
        usable=False,
    ),
    "away_lineup_confirmed": _f(
        "XI visitante confirmado (0/1)",
        "0 en el store histórico: el XI del partido actual se conoce después del kickoff y no se usa como feature.",
        "ESPN · limitación temporal",
        "lineups",
        quality="observed",
        usable=False,
    ),
    "home_absences": _f(
        "Bajas local",
        "Número de bajas confirmadas del local. No disponible en la base histórica.",
        "No disponible · injuries vacío",
        "lineups",
        quality="missing",
        usable=False,
    ),
    "away_absences": _f(
        "Bajas visitante",
        "Número de bajas confirmadas del visitante. No disponible en la base histórica.",
        "No disponible · injuries vacío",
        "lineups",
        quality="missing",
        usable=False,
    ),
    "home_suspensions": _f(
        "Sanciones local",
        "Número de sancionados del local. No disponible en la base histórica.",
        "No disponible",
        "lineups",
        quality="missing",
        usable=False,
    ),
    "away_suspensions": _f(
        "Sanciones visitante",
        "Número de sancionados del visitante. No disponible en la base histórica.",
        "No disponible",
        "lineups",
        quality="missing",
        usable=False,
    ),

    # ------------------------------------------------------------------
    # Splits local/visitante
    # ------------------------------------------------------------------
    "home_home_ppg": _f(
        "Puntos/partido del local en casa",
        "Puntos por partido del local en sus partidos como local de la temporada antes del kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "splits",
    ),
    "away_away_ppg": _f(
        "Puntos/partido del visitante fuera",
        "Puntos por partido del visitante en sus partidos como visitante de la temporada antes del kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "splits",
    ),
    "home_home_gf_pg": _f(
        "Goles a favor del local en casa",
        "Goles a favor por partido del local como local en la temporada antes del kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "splits",
    ),
    "home_home_ga_pg": _f(
        "Goles en contra del local en casa",
        "Goles en contra por partido del local como local en la temporada antes del kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "splits",
    ),
    "away_away_gf_pg": _f(
        "Goles a favor del visitante fuera",
        "Goles a favor por partido del visitante como visitante en la temporada antes del kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "splits",
    ),
    "away_away_ga_pg": _f(
        "Goles en contra del visitante fuera",
        "Goles en contra por partido del visitante como visitante en la temporada antes del kickoff.",
        "Football-Data.co.uk · cálculo propio",
        "splits",
    ),

    # ------------------------------------------------------------------
    # Mercado implícito
    # ------------------------------------------------------------------
    "market_home_prob": _f(
        "Probabilidad implícita local",
        "Media de probabilidad de-vigged de las casas para el 1, normalizada a suma 1. Referencia neutral, no recomendación.",
        "Football-Data.co.uk · cuotas de cierre",
        "market",
        usable=False,
    ),
    "market_draw_prob": _f(
        "Probabilidad implícita empate",
        "Media de probabilidad de-vigged de las casas para el X, normalizada a suma 1. Referencia neutral.",
        "Football-Data.co.uk · cuotas de cierre",
        "market",
        usable=False,
    ),
    "market_away_prob": _f(
        "Probabilidad implícita visitante",
        "Media de probabilidad de-vigged de las casas para el 2, normalizada a suma 1. Referencia neutral.",
        "Football-Data.co.uk · cuotas de cierre",
        "market",
        usable=False,
    ),
    "market_over25_prob": _f(
        "Probabilidad implícita Over 2.5",
        "Media de probabilidad de-vigged de las casas para Over 2.5. Referencia neutral.",
        "Football-Data.co.uk · cuotas de cierre",
        "market",
        usable=False,
    ),
    "market_under25_prob": _f(
        "Probabilidad implícita Under 2.5",
        "Media de probabilidad de-vigged de las casas para Under 2.5. Referencia neutral.",
        "Football-Data.co.uk · cuotas de cierre",
        "market",
        usable=False,
    ),
    "market_btts_prob": _f(
        "Probabilidad implícita BTTS",
        "Probabilidad de-vigged de ambos anotan. No incluida en el backfill actual.",
        "No disponible · Football-Data no incluye BTTS",
        "market",
        quality="missing",
        usable=False,
    ),
    "market_bookmakers": _f(
        "Casas de apuestas (conteo)",
        "Número de casas distintas con cuota 1X2 para el partido.",
        "Football-Data.co.uk",
        "market",
        usable=False,
    ),
    "market_timestamp_available": _f(
        "Timestamp de mercado disponible (0/1)",
        "0 si no se publica la hora exacta de la cuota de cierre. Se conserva como referencia, no como feature histórica.",
        "Football-Data.co.uk · limitación temporal",
        "market",
        quality="observed",
        usable=False,
    ),

    # ------------------------------------------------------------------
    # Valor de plantilla
    # ------------------------------------------------------------------
    "home_squad_value": _f(
        "Valor de plantilla local",
        "Valor de mercado agregado de la plantilla. No integrado en la base actual.",
        "No disponible · Transfermarkt no integrado",
        "squad_value",
        quality="missing",
        usable=False,
    ),
    "away_squad_value": _f(
        "Valor de plantilla visitante",
        "Valor de mercado agregado de la plantilla. No integrado en la base actual.",
        "No disponible · Transfermarkt no integrado",
        "squad_value",
        quality="missing",
        usable=False,
    ),

    # ------------------------------------------------------------------
    # Clima, altitud y árbitro
    # ------------------------------------------------------------------
    "altitude_m": _f(
        "Altitud de la sede",
        "Altitud de la sede del partido en metros.",
        "venues · coordenadas y altitud",
        "altitude",
    ),
    "away_altitude_m": _f(
        "Altitud habitual del visitante",
        "Altitud de la sede habitual del visitante en metros.",
        "venues · coordenadas y altitud",
        "altitude",
    ),
    "altitude_diff": _f(
        "Diferencial de altitud",
        "Altitud de la sede del partido menos altitud habitual del visitante.",
        "Cálculo propio",
        "altitude",
    ),
    "weather_temp_c": _f(
        "Temperatura media",
        "Temperatura media diaria en la sede. Es reanálisis retrospectivo, no el pronóstico previo al partido.",
        "Open-Meteo · reanálisis diario",
        "weather",
        quality="estimated",
        usable=False,
    ),
    "weather_precip_mm": _f(
        "Precipitación diaria",
        "Precipitación total diaria en la sede. Reanálisis retrospectivo.",
        "Open-Meteo · reanálisis diario",
        "weather",
        quality="estimated",
        usable=False,
    ),
    "weather_wind_kmh": _f(
        "Viento máximo diario",
        "Viento máximo diario en la sede. Reanálisis retrospectivo.",
        "Open-Meteo · reanálisis diario",
        "weather",
        quality="estimated",
        usable=False,
    ),
    "weather_condition": _f(
        "Condición meteorológica",
        "Código WMO traducido a etiqueta. Reanálisis retrospectivo.",
        "Open-Meteo · reanálisis diario",
        "weather",
        quality="estimated",
        usable=False,
    ),
    "referee_name": _f(
        "Árbitro",
        "Nombre del árbitro principal asignado. Solo disponible en Premier League.",
        "Football-Data.co.uk",
        "referee",
    ),
    "referee_cards_per_match": _f(
        "Tarjetas por partido del árbitro",
        "Media de tarjetas totales en partidos anteriores dirigidos por el mismo árbitro.",
        "Football-Data.co.uk · cálculo propio",
        "referee",
    ),
    "referee_matches": _f(
        "Partidos previos del árbitro",
        "Número de partidos anteriores del árbitro en la base.",
        "Football-Data.co.uk · cálculo propio",
        "referee",
    ),
    "referee_penalties_per_match": _f(
        "Penales por partido del árbitro",
        "Media de penales señalados. No disponible en la base actual.",
        "No disponible · Football-Data no publica penales por árbitro",
        "referee",
        quality="missing",
        usable=False,
    ),
}


CORE_FEATURE_GROUPS = {
    "xg_rolling": "xG/xGA rolling 5/10/20 y splits local/visitante",
    "shots": "Tiros a favor/en contra (10 partidos)",
    "ppda": "PPDA/presión (5 y 10 partidos)",
    "elo": "Elo pre-partido y diferencial",
    "rest_congestion": "Descanso y congestión de liga (14/21 días)",
    "travel": "Distancia Haversine y huso horario",
    "derby": "Derbi y rivalidad",
    "importance": "Posición, título/descenso y fase",
    "lineups": "Continuidad de XI, formación y profundidad",
    "splits": "Rendimiento local/visitante de la temporada",
}

OPTIONAL_FEATURE_GROUPS = {
    "context": "Medias previas de liga",
    "market": "Mercado implícito de cierre (sin timestamp utilizable)",
    "squad_value": "Valor de plantilla (no disponible)",
    "altitude": "Altitud de sede",
    "weather": "Clima retrospectivo (no usable como feature)",
    "referee": "Árbitro (solo Premier League)",
}


def catalog_entry(feature: str) -> dict:
    """Return catalog metadata or a safe fallback for an undocumented feature."""
    return FEATURE_CATALOG.get(
        feature,
        {
            "label": feature.replace("_", " ").title(),
            "definition": "Feature calculada por la pipeline; revisar el código de build_features.py.",
            "source": "MOTOR-NOX",
            "group": "other",
            "quality": "observed",
            "model_usable": True,
        },
    )
