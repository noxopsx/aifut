"""
Venue and stadium metadata with geographical coordinates and altitude.
Used for Haversine travel distance and altitude differential calculations.
"""

from pathlib import Path
import sqlite3
from .db import get_connection

VENUES_DATA = [
    # Premier League
    ("emirates", "Emirates Stadium", "London", "England", 51.5549, -0.1084, 42),
    ("villa_park", "Villa Park", "Birmingham", "England", 52.5091, -1.8848, 114),
    ("vitality", "Vitality Stadium", "Bournemouth", "England", 50.7352, -1.8383, 34),
    ("gtech", "Gtech Community Stadium", "London", "England", 51.4907, -0.2887, 8),
    ("amex", "Amex Stadium", "Brighton", "England", 50.8616, -0.0837, 65),
    ("stamford_bridge", "Stamford Bridge", "London", "England", 51.4817, -0.1910, 5),
    ("selhurst_park", "Selhurst Park", "London", "England", 51.3983, -0.0855, 60),
    ("goodison_park", "Goodison Park", "Liverpool", "England", 53.4388, -2.9664, 45),
    ("craven_cottage", "Craven Cottage", "London", "England", 51.4749, -0.2217, 5),
    ("anfield", "Anfield", "Liverpool", "England", 53.4308, -2.9608, 52),
    ("etihad", "Etihad Stadium", "Manchester", "England", 53.4831, -2.2004, 66),
    ("old_trafford", "Old Trafford", "Manchester", "England", 53.4631, -2.2913, 44),
    ("st_james_park", "St James' Park", "Newcastle", "England", 54.9756, -1.6217, 65),
    ("city_ground", "City Ground", "Nottingham", "England", 52.9400, -1.1328, 25),
    ("tottenham_stadium", "Tottenham Hotspur Stadium", "London", "England", 51.6043, -0.0664, 15),
    ("london_stadium", "London Stadium", "London", "England", 51.5387, -0.0166, 11),
    ("molineux", "Molineux Stadium", "Wolverhampton", "England", 52.5903, -2.1304, 134),
    ("king_power", "King Power Stadium", "Leicester", "England", 52.6204, -1.1422, 57),
    ("turf_moor", "Turf Moor", "Burnley", "England", 53.7890, -2.2302, 117),
    ("elland_road", "Elland Road", "Leeds", "England", 53.7778, -1.5722, 45),
    ("st_marys", "St Mary's Stadium", "Southampton", "England", 50.9058, -1.3911, 4),
    ("kenilworth_road", "Kenilworth Road", "Luton", "England", 51.8841, -0.4316, 115),
    ("portman_road", "Portman Road", "Ipswich", "England", 52.0551, 1.1448, 7),
    ("carrow_road", "Carrow Road", "Norwich", "England", 52.6221, 1.3090, 6),
    ("vicarage_road", "Vicarage Road", "Watford", "England", 51.6498, -0.4015, 62),
    ("the_hawthorns", "The Hawthorns", "West Bromwich", "England", 52.5090, -1.9639, 168),
    ("bramall_lane", "Bramall Lane", "Sheffield", "England", 53.3703, -1.4709, 85),
    ("stadium_of_light", "Stadium of Light", "Sunderland", "England", 54.9145, -1.3882, 32),
    ("mkm_stadium", "MKM Stadium", "Hull", "England", 53.7461, -0.3678, 10),
    ("cbs_arena", "Coventry Building Society Arena", "Coventry", "England", 52.4481, -1.4956, 89),

    # LaLiga
    ("bernabeu", "Santiago Bernabéu", "Madrid", "Spain", 40.4531, -3.6883, 720),
    ("montjuic", "Estadi Olímpic Lluís Companys", "Barcelona", "Spain", 41.3648, 2.1557, 120),
    ("metropolitano", "Cívitas Metropolitano", "Madrid", "Spain", 40.4361, -3.5997, 660),
    ("san_mames", "San Mamés", "Bilbao", "Spain", 43.2642, -2.9493, 20),
    ("reale_arena", "Reale Arena", "San Sebastián", "Spain", 43.3014, -1.9736, 10),
    ("villamarin", "Benito Villamarín", "Seville", "Spain", 37.3565, -5.9818, 12),
    ("sanchez_pizjuan", "Ramón Sánchez-Pizjuán", "Seville", "Spain", 37.3840, -5.9706, 15),
    ("mestalla", "Mestalla", "Valencia", "Spain", 39.4746, -0.3582, 17),
    ("ceramica", "Estadio de la Cerámica", "Villarreal", "Spain", 39.9442, -0.1036, 42),
    ("balaidos", "Abanca-Balaídos", "Vigo", "Spain", 42.2119, -8.7397, 24),
    ("coliseum", "Coliseum", "Getafe", "Spain", 40.3257, -3.7149, 620),
    ("el_sadar", "El Sadar", "Pamplona", "Spain", 42.7967, -1.6371, 440),
    ("mendizorrotza", "Mendizorrotza", "Vitoria-Gasteiz", "Spain", 42.8371, -2.6880, 525),
    ("montilivi", "Montilivi", "Girona", "Spain", 41.9610, 2.8286, 95),
    ("son_moix", "Estadi Mallorca Son Moix", "Palma", "Spain", 39.5900, 2.6300, 30),
    ("vallecas", "Campo de Fútbol de Vallecas", "Madrid", "Spain", 40.3919, -3.6587, 630),
    ("gran_canaria", "Estadio Gran Canaria", "Las Palmas", "Spain", 28.1004, -15.4566, 130),
    ("butarque", "Estadio Municipal Butarque", "Leganés", "Spain", 40.3404, -3.7610, 670),
    ("zorrilla", "Estadio José Zorrilla", "Valladolid", "Spain", 41.6444, -4.7611, 700),
    ("los_carmenes", "Nuevo Los Cármenes", "Granada", "Spain", 37.1528, -3.5957, 680),
    ("nuevo_mirandilla", "Nuevo Mirandilla", "Cádiz", "Spain", 36.5028, -6.2731, 10),
    ("power_horse", "Power Horse Stadium", "Almería", "Spain", 36.8400, -2.4356, 15),
    ("martinez_valero", "Martínez Valero", "Elche", "Spain", 38.2671, -0.6631, 86),
    ("rcde_stadium", "Stage Front Stadium", "Barcelona", "Spain", 41.3479, 2.0757, 18),
    ("ipurua", "Ipurua Municipal Stadium", "Eibar", "Spain", 43.1817, -2.4759, 121),
    ("el_alcoraz", "El Alcoraz", "Huesca", "Spain", 42.1320, -0.4244, 480),
    ("ciutat_valencia", "Estadi Ciutat de València", "Valencia", "Spain", 39.4947, -0.3639, 15),
    ("carlos_tartiere", "Estadio Carlos Tartiere", "Oviedo", "Spain", 43.3606, -5.8706, 230),
    ("el_sardinero", "Campos de Sport de El Sardinero", "Santander", "Spain", 43.4764, -3.7933, 12),
    ("la_rosaleda", "La Rosaleda", "Málaga", "Spain", 36.7342, -4.4264, 18),
    ("riazor", "Estadio Abanca-Riazor", "A Coruña", "Spain", 43.3687, -8.4175, 10),
]

TEAM_VENUE_MAP = {
    # Premier League
    "arsenal": "emirates",
    "aston_villa": "villa_park",
    "bournemouth": "vitality",
    "brentford": "gtech",
    "brighton": "amex",
    "chelsea": "stamford_bridge",
    "crystal_palace": "selhurst_park",
    "everton": "goodison_park",
    "fulham": "craven_cottage",
    "liverpool": "anfield",
    "manchester_city": "etihad",
    "manchester_united": "old_trafford",
    "newcastle": "st_james_park",
    "nottingham_forest": "city_ground",
    "tottenham": "tottenham_stadium",
    "west_ham": "london_stadium",
    "wolverhampton": "molineux",
    "leicester": "king_power",
    "burnley": "turf_moor",
    "leeds": "elland_road",
    "southampton": "st_marys",
    "luton": "kenilworth_road",
    "ipswich": "portman_road",
    "norwich": "carrow_road",
    "watford": "vicarage_road",
    "west_brom": "the_hawthorns",
    "sheffield_united": "bramall_lane",
    "sunderland": "stadium_of_light",
    "hull_city": "mkm_stadium",
    "coventry_city": "cbs_arena",

    # LaLiga
    "real_madrid": "bernabeu",
    "barcelona": "montjuic",
    "atletico_madrid": "metropolitano",
    "athletic_club": "san_mames",
    "real_sociedad": "reale_arena",
    "real_betis": "villamarin",
    "sevilla": "sanchez_pizjuan",
    "valencia": "mestalla",
    "villarreal": "ceramica",
    "celta_vigo": "balaidos",
    "getafe": "coliseum",
    "osasuna": "el_sadar",
    "alaves": "mendizorrotza",
    "girona": "montilivi",
    "mallorca": "son_moix",
    "rayo_vallecano": "vallecas",
    "las_palmas": "gran_canaria",
    "leganes": "butarque",
    "real_valladolid": "zorrilla",
    "granada": "los_carmenes",
    "cadiz": "nuevo_mirandilla",
    "almeria": "power_horse",
    "elche": "martinez_valero",
    "espanyol": "rcde_stadium",
    "eibar": "ipurua",
    "huesca": "el_alcoraz",
    "levante": "ciutat_valencia",
    "real_oviedo": "carlos_tartiere",
    "racing_santander": "el_sardinero",
    "malaga": "la_rosaleda",
    "deportivo_la_coruna": "riazor",
}


def populate_venues(conn: sqlite3.Connection) -> int:
    """Insert venues into database."""
    with conn:
        conn.executemany(
            """
            INSERT INTO venues (id, name, city, country, latitude, longitude, altitude)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                city = excluded.city,
                country = excluded.country,
                latitude = excluded.latitude,
                longitude = excluded.longitude,
                altitude = excluded.altitude
            """,
            VENUES_DATA,
        )
    return len(VENUES_DATA)


def repair_venues(conn: sqlite3.Connection) -> dict:
    """Backfill team and match venues from the canonical venue map.

    Promoted teams added after the original backfill (for example Sunderland in
    2025-26) may have no venue_id. The repair is deterministic and only fills
    missing values; it never overwrites a venue already present.
    """
    populate_venues(conn)
    with conn:
        for team_id, venue_id in TEAM_VENUE_MAP.items():
            conn.execute(
                "UPDATE teams SET venue_id = ? WHERE id = ? AND venue_id IS NULL",
                (venue_id, team_id),
            )
        conn.execute(
            """
            UPDATE matches
            SET venue_id = (
                SELECT t.venue_id FROM teams t WHERE t.id = matches.home_team_id
            )
            WHERE venue_id IS NULL
              AND EXISTS (
                  SELECT 1 FROM teams t
                  WHERE t.id = matches.home_team_id AND t.venue_id IS NOT NULL
              )
            """
        )
    teams_missing = conn.execute("SELECT count(*) FROM teams WHERE venue_id IS NULL").fetchone()[0]
    matches_missing = conn.execute("SELECT count(*) FROM matches WHERE venue_id IS NULL").fetchone()[0]
    return {
        "venues": len(VENUES_DATA),
        "teams_missing_venue": teams_missing,
        "matches_missing_venue": matches_missing,
    }
