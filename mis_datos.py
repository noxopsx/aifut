#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MOTOR-NOX V1.0 · cargador de datos propios
==========================================

Este archivo es la única fuente de datos que necesitas editar. Al ejecutarlo,
genera los archivos que consume la interfaz:

    js/data/league.js
    js/data/teams.js
    js/data/matches.js
    js/data/tables.js

Uso rápido
----------
1. Edita LIGA, EQUIPOS y PARTIDOS más abajo.
2. Valida sin escribir nada:

       python mis_datos.py --validar

3. Genera los archivos:

       python mis_datos.py

4. Recarga http://127.0.0.1:4173

La primera vez se guarda una copia de los datos de respaldo en `_respaldo_demo/`.
Para volver a los datos de respaldo:

       python mis_datos.py --restaurar

También puedes generar en otra carpeta:

       python mis_datos.py --salida ruta/a/otra/carpeta

Notas del modelo
----------------
- `avgGoals` es el promedio de goles POR EQUIPO. El total de liga sería
  aproximadamente `avgGoals * 2`.
- `attack` y `defense` son índices relativos. 1.00 es la media. Un ataque de
  1.20 genera un 20% más de goles esperados; una defensa de 0.85 concede un
  15% menos.
- `onTargetRate` es la fracción de tiros que van a puerta (0 a 1).
- `form` son los últimos 5 resultados: "W" victoria, "D" empate, "L" derrota.
- `rho` es la corrección Dixon-Coles. Valores habituales: -0.15 a 0.0.
- `demo` debe ser False para que la interfaz no muestre la etiqueta de datos
  simulados.

Los campos que no pongas se rellenan con valores neutros. Aun así, revisa la
validación: te avisará de ids repetidos, equipos inexistentes, fechas mal
escritas, estadísticas fuera de rango y bajas que no coinciden con jugadores.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import re
import shutil
import sys
import unicodedata
from datetime import date, datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "js" / "data"
BACKUP_DIR = BASE_DIR / "_respaldo_demo"
ARCHIVOS = ("league.js", "teams.js", "matches.js")

TIPOS_POR_DEFECTO = {
    "league": "Liga regular",
    "liguilla": "Liguilla",
    "round16": "Octavos de final",
    "quarterfinal": "Cuartos de final",
    "semifinal": "Semifinal",
    "final": "Final",
    "friendly": "Amistoso",
}

FILTROS_POR_DEFECTO = [
    {"id": "all", "label": "Todos"},
    {"id": "league", "label": "Liga"},
    {"id": "liguilla", "label": "Liguilla"},
    {"id": "final", "label": "Final"},
    {"id": "friendly", "label": "Amistoso"},
]


# ===========================================================================
# 1) LIGA
# ===========================================================================
# Edita estos valores con los promedios de tu competición.
LIGA = {
    "id": "mi-liga",
    "name": "Mi Liga",
    "season": "2026",
    "avgGoals": 1.35,          # goles por equipo (el total ronda 2.7)
    "homeFactor": 1.12,        # multiplicador del local
    "awayFactor": 0.90,        # multiplicador del visitante
    "avgCards": 4.6,           # tarjetas totales por partido
    "avgCorners": 10.0,        # córners totales por partido
    "rho": -0.055,             # corrección Dixon-Coles
    "demo": False,             # False = datos propios
    "updated": "2026-10-23T09:00:00-06:00",
}


# ===========================================================================
# 2) EQUIPOS
# ===========================================================================
# Puedes usar una lista o un diccionario {id: equipo}. La lista es más cómoda.
# Cada equipo necesita al menos: id, name, attack, defense y players.
#
# Campos de estadísticas:
#   cornersFor / cornersAgainst   córners a favor / en contra por partido
#   shotsFor / shotsAgainst       tiros a favor / en contra por partido
#   onTargetRate                  proporción de tiros a puerta (0-1)
#   cards                         tarjetas por partido
#   possession                    posesión media (%)
#   altitude                      altitud de su ciudad (m)
#   form                          últimos 5: W/D/L
#
# Cada jugador:
#   name, pos, xg90 (xG por 90 min), minutes (0-1), pen (0-1)
#
# `pen` es una pequeña ponderación por ser cobrador de penales; no es la
# probabilidad de anotar un penal. Puedes dejarlo en 0.

def jugador(nombre: str, pos: str, xg90: float, minutos: float, pen: float = 0.0) -> dict:
    """Atajo para escribir un jugador de forma legible."""
    return {
        "name": nombre,
        "pos": pos,
        "xg90": xg90,
        "minutes": minutos,
        "pen": pen,
    }


def baja(nombre: str, pos: str, nota: str = "") -> dict:
    """Atajo para registrar una baja o duda."""
    return {"name": nombre, "pos": pos, "note": nota}


def alineacion(
    attack_delta: float = 0.0,
    defense_delta: float = 0.0,
    absences: list | None = None,
    note: str = "XI completo.",
) -> dict:
    """Atajo para describir el efecto de la alineación de un equipo.

    attack_delta:  -0.3 a +0.1 (negativo = pierde ataque)
    defense_delta: -0.1 a +0.15 (positivo = concede más)
    """
    return {
        "attackDelta": attack_delta,
        "defenseDelta": defense_delta,
        "absences": absences or [],
        "note": note,
    }


EQUIPOS = [
    {
        "id": "atletico-ejemplo",
        "name": "Atlético Ejemplo",
        "short": "Atlético",
        "abbr": "ATE",
        "city": "Ciudad Ejemplo",
        "color": "#2457d6",
        "color2": "#f4f1ea",
        "attack": 1.18,
        "defense": 0.88,
        "cornersFor": 5.8,
        "cornersAgainst": 4.6,
        "shotsFor": 13.8,
        "shotsAgainst": 10.9,
        "onTargetRate": 0.36,
        "cards": 2.6,
        "possession": 56,
        "altitude": 1200,
        "form": ["W", "W", "D", "L", "W"],
        "players": [
            jugador("Delantero Ejemplo", "DEL", 0.46, 0.78, 0.35),
            jugador("Extremo Izquierdo", "EXT", 0.28, 0.74, 0.05),
            jugador("Enganche Ejemplo", "MED", 0.24, 0.70, 0.20),
            jugador("Mediocampista Box", "MED", 0.14, 0.80, 0.00),
            jugador("Lateral Ejemplo", "LAT", 0.06, 0.82, 0.00),
        ],
    },
    {
        "id": "deportivo-muestra",
        "name": "Deportivo Muestra",
        "short": "Deportivo",
        "abbr": "DEM",
        "city": "Puerto Muestra",
        "color": "#d64545",
        "color2": "#ffffff",
        "attack": 1.02,
        "defense": 0.96,
        "cornersFor": 5.0,
        "cornersAgainst": 5.1,
        "shotsFor": 12.4,
        "shotsAgainst": 11.8,
        "onTargetRate": 0.34,
        "cards": 2.9,
        "possession": 49,
        "altitude": 20,
        "form": ["D", "L", "W", "D", "L"],
        "players": [
            jugador("Nueve Muestra", "DEL", 0.40, 0.76, 0.40),
            jugador("Extremo Derecho", "EXT", 0.25, 0.72, 0.05),
            jugador("Creativo Muestra", "MED", 0.21, 0.68, 0.15),
            jugador("Volante Muestra", "MED", 0.12, 0.78, 0.00),
            jugador("Central Muestra", "DEF", 0.04, 0.86, 0.00),
        ],
    },
]


# ===========================================================================
# 3) PARTIDOS
# ===========================================================================
# Cada partido necesita al menos: home, away y date.
# `home` y `away` son los ids de los equipos de arriba.
#
# Campos principales:
#   type          league | liguilla | round16 | quarterfinal | semifinal |
#                 final | friendly (puedes añadir más en TIPOS)
#   date          ISO 8601 con zona horaria, por ejemplo:
#                 2026-11-01T19:00:00-06:00
#   neutral       True si se juega en cancha neutral
#   altitude      altitud de la sede (m)
#   referee       name, cardsPerMatch, penaltiesPerMatch
#   weather       condition, temp, wind
#   rest          días de descanso: home / away
#   travelKm      kilómetros viajados: home / away
#   motivation    índice de motivación: home / away (1.00 = normal)
#   rivalry       True si es un clásico o partido de alta tensión
#   lineups       efecto de alineación y bajas de cada lado
#   leg           ida (1) o vuelta (2), solo en eliminatorias
#   aggregate     marcador global antes de la vuelta: home / away
#   note          texto libre que aparece en la interfaz
#
# Si omites referee, weather, rest, travelKm, motivation o lineups, se usan
# valores neutros. Si omites id, se genera a partir de home-away.

PARTIDOS = [
    {
        "id": "atletico-ejemplo-deportivo-muestra",
        "home": "atletico-ejemplo",
        "away": "deportivo-muestra",
        "type": "league",
        "competition": "Mi Liga",
        "stage": "Jornada 1",
        "headline": "Partido inaugural",
        "date": "2026-11-01T19:00:00-06:00",
        "venue": "Estadio Ejemplo",
        "city": "Ciudad Ejemplo",
        "neutral": False,
        "altitude": 1200,
        "referee": {
            "name": "Árbitro Ejemplo",
            "cardsPerMatch": 4.5,
            "penaltiesPerMatch": 0.25,
        },
        "weather": {"condition": "Despejado", "temp": 21, "wind": 9},
        "rest": {"home": 4, "away": 4},
        "travelKm": {"home": 0, "away": 420},
        "motivation": {"home": 1.02, "away": 1.00},
        "rivalry": True,
        "lineups": {
            "home": alineacion(note="XI completo."),
            "away": alineacion(
                attack_delta=-0.03,
                defense_delta=0.01,
                absences=[baja("Creativo Muestra", "MED", "Molestia muscular")],
                note="Baja sensible en la creación.",
            ),
        },
        "note": "Partido de ejemplo. Cambia este texto por el contexto real.",
    },
    {
        "id": "atletico-ejemplo-deportivo-muestra-ida",
        "home": "atletico-ejemplo",
        "away": "deportivo-muestra",
        "type": "quarterfinal",
        "competition": "Liguilla",
        "stage": "Cuartos de final · Ida",
        "headline": "Ida de cuartos",
        "date": "2026-11-15T20:00:00-06:00",
        "venue": "Estadio Ejemplo",
        "city": "Ciudad Ejemplo",
        "neutral": False,
        "altitude": 1200,
        "referee": {
            "name": "Árbitro Liguilla",
            "cardsPerMatch": 5.1,
            "penaltiesPerMatch": 0.26,
        },
        "weather": {"condition": "Despejado", "temp": 20, "wind": 7},
        "rest": {"home": 4, "away": 4},
        "travelKm": {"home": 0, "away": 420},
        "motivation": {"home": 1.03, "away": 1.03},
        "rivalry": False,
        "lineups": {
            "home": alineacion(note="XI completo."),
            "away": alineacion(note="XI completo."),
        },
        "leg": 1,
        "aggregate": {"home": 0, "away": 0},
        "note": "Ejemplo de ida de eliminatoria. Para la vuelta usa leg: 2 y el global.",
    },
    {
        "id": "deportivo-muestra-atletico-ejemplo-final",
        "home": "deportivo-muestra",
        "away": "atletico-ejemplo",
        "type": "final",
        "competition": "Copa Ejemplo",
        "stage": "Final · Sede neutral",
        "headline": "Final",
        "date": "2026-11-08T18:00:00-06:00",
        "venue": "Estadio Neutral",
        "city": "Ciudad Neutral",
        "neutral": True,
        "altitude": 800,
        "referee": {
            "name": "Árbitro Final",
            "cardsPerMatch": 5.0,
            "penaltiesPerMatch": 0.28,
        },
        "weather": {"condition": "Nublado", "temp": 19, "wind": 12},
        "rest": {"home": 5, "away": 5},
        "travelKm": {"home": 300, "away": 500},
        "motivation": {"home": 1.05, "away": 1.05},
        "rivalry": False,
        "lineups": {
            "home": alineacion(note="XI completo."),
            "away": alineacion(note="XI completo."),
        },
        "note": "Segundo ejemplo: final en sede neutral. Puedes borrarlo.",
    },
]


# ===========================================================================
# 4) TIPOS Y FILTROS
# ===========================================================================
# Añade aquí cualquier tipo nuevo que uses en `type`. La etiqueta es la que
# verás en la interfaz.
TIPOS = {
    "league": "Liga regular",
    "liguilla": "Liguilla",
    "round16": "Octavos de final",
    "quarterfinal": "Cuartos de final",
    "semifinal": "Semifinal",
    "final": "Final",
    "friendly": "Amistoso",
}

# Los filtros de la barra lateral. Los ids "league", "liguilla", "final" y
# "friendly" son especiales: agrupan los tipos de partido. "all" muestra todo.
FILTROS = [
    {"id": "all", "label": "Todos"},
    {"id": "league", "label": "Liga"},
    {"id": "liguilla", "label": "Liguilla"},
    {"id": "final", "label": "Final"},
    {"id": "friendly", "label": "Amistoso"},
]


# ===========================================================================
# A partir de aquí no hace falta editar para usar tus datos.
# ===========================================================================

class DatosError(Exception):
    """Error de estructura que impide validar los datos."""


def slugify(texto: str) -> str:
    """Convierte un nombre en un id seguro para URL."""
    texto = unicodedata.normalize("NFKD", str(texto))
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    texto = texto.lower()
    texto = re.sub(r"[^a-z0-9]+", "-", texto).strip("-")
    return texto or "equipo"


def abbr_de(nombre: str) -> str:
    """Genera una abreviatura de 3 letras si no se indica una."""
    limpio = unicodedata.normalize("NFKD", str(nombre))
    limpio = "".join(c for c in limpio if not unicodedata.combining(c))
    limpio = re.sub(r"[^A-Za-z0-9]", "", limpio).upper()
    return (limpio[:3] or "EQP").ljust(3, "X")


def es_numero(valor) -> bool:
    return (
        isinstance(valor, (int, float))
        and not isinstance(valor, bool)
        and math.isfinite(valor)
    )


def fecha_iso(valor) -> str:
    if isinstance(valor, datetime):
        return valor.isoformat()
    if isinstance(valor, date):
        return datetime.combine(valor, datetime.min.time()).isoformat()
    return str(valor)


def parsear_fecha(valor):
    if isinstance(valor, datetime):
        return valor
    if isinstance(valor, date):
        return datetime.combine(valor, datetime.min.time())
    texto = str(valor).strip()
    if texto.endswith("Z"):
        texto = texto[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(texto)
    except ValueError:
        return None


def normalizar() -> tuple[dict, list[dict], list[dict], dict, list[dict]]:
    """Rellena valores opcionales y devuelve copias listas para validar."""
    liga = copy.deepcopy(LIGA)
    if not isinstance(liga, dict):
        raise DatosError("LIGA debe ser un diccionario.")

    liga.setdefault("avgGoals", 1.35)
    liga.setdefault("homeFactor", 1.12)
    liga.setdefault("awayFactor", 0.90)
    liga.setdefault("avgCards", 4.6)
    liga.setdefault("avgCorners", 10.0)
    liga.setdefault("rho", -0.055)
    liga.setdefault("demo", False)
    liga.setdefault("updated", datetime.now().astimezone().isoformat(timespec="seconds"))
    if isinstance(liga.get("updated"), (datetime, date)):
        liga["updated"] = fecha_iso(liga["updated"])

    if isinstance(EQUIPOS, dict):
        equipos = []
        for clave, valor in EQUIPOS.items():
            if not isinstance(valor, dict):
                raise DatosError(f"EQUIPOS[{clave!r}] debe ser un diccionario.")
            item = copy.deepcopy(valor)
            item.setdefault("id", str(clave))
            equipos.append(item)
    elif isinstance(EQUIPOS, list):
        equipos = copy.deepcopy(EQUIPOS)
    else:
        raise DatosError("EQUIPOS debe ser una lista o un diccionario.")

    normalizados = []
    for indice, equipo in enumerate(equipos):
        if not isinstance(equipo, dict):
            raise DatosError(f"EQUIPOS[{indice}] debe ser un diccionario.")
        e = copy.deepcopy(equipo)
        nombre = e.get("name", "")
        if not e.get("id") and nombre:
            e["id"] = slugify(nombre)
        if not e.get("short"):
            e["short"] = nombre
        if not e.get("abbr"):
            e["abbr"] = abbr_de(nombre)
        e["abbr"] = str(e["abbr"]).upper()
        e.setdefault("city", "")
        e.setdefault("color", "#333333")
        e.setdefault("color2", "#ffffff")
        e.setdefault("attack", 1.0)
        e.setdefault("defense", 1.0)
        e.setdefault("cornersFor", 5.0)
        e.setdefault("cornersAgainst", 5.0)
        e.setdefault("shotsFor", 12.0)
        e.setdefault("shotsAgainst", 12.0)
        e.setdefault("onTargetRate", 0.34)
        e.setdefault("cards", 2.5)
        e.setdefault("possession", 50)
        e.setdefault("altitude", 0)
        e.setdefault("form", ["D", "D", "D", "D", "D"])
        e["form"] = [str(x).upper() for x in e["form"]] if isinstance(e["form"], list) else e["form"]
        e.setdefault("players", [])

        jugadores = []
        if isinstance(e["players"], list):
            for j in e["players"]:
                if not isinstance(j, dict):
                    jugadores.append(j)
                    continue
                p = copy.deepcopy(j)
                p.setdefault("pos", "MED")
                p.setdefault("xg90", 0.15)
                p.setdefault("minutes", 0.65)
                p.setdefault("pen", 0.0)
                p["pos"] = str(p["pos"]).upper()
                jugadores.append(p)
        e["players"] = jugadores
        normalizados.append(e)

    equipos = normalizados
    equipos_por_id = {e.get("id"): e for e in equipos if isinstance(e, dict)}

    tipos = dict(TIPOS_POR_DEFECTO)
    if isinstance(TIPOS, dict):
        for clave, etiqueta in TIPOS.items():
            tipos[str(clave)] = str(etiqueta)
    else:
        raise DatosError("TIPOS debe ser un diccionario.")

    if not isinstance(PARTIDOS, list):
        raise DatosError("PARTIDOS debe ser una lista.")

    partidos = []
    for indice, partido in enumerate(PARTIDOS):
        if not isinstance(partido, dict):
            raise DatosError(f"PARTIDOS[{indice}] debe ser un diccionario.")
        m = copy.deepcopy(partido)
        m["home"] = "" if m.get("home") is None else str(m["home"]).strip()
        m["away"] = "" if m.get("away") is None else str(m["away"]).strip()
        if not m.get("id") and m["home"] and m["away"]:
            m["id"] = slugify(f"{m['home']}-{m['away']}")
        m["type"] = str(m.get("type", "league")).strip().lower()
        m.setdefault("competition", liga.get("name", ""))
        m.setdefault("stage", tipos.get(m["type"], m["type"]))
        m.setdefault("headline", m["stage"])
        if "date" in m:
            m["date"] = fecha_iso(m["date"])
        m.setdefault("venue", f"Estadio de {equipos_por_id.get(m['home'], {}).get('name', m['home'])}")
        m.setdefault("city", equipos_por_id.get(m["home"], {}).get("city", ""))
        m.setdefault("neutral", False)
        m.setdefault("altitude", equipos_por_id.get(m["home"], {}).get("altitude", 0))
        m.setdefault("rivalry", False)
        m.setdefault("note", "")

        arbitro = {
            "name": "Árbitro por confirmar",
            "cardsPerMatch": liga.get("avgCards", 4.6),
            "penaltiesPerMatch": 0.25,
        }
        if isinstance(m.get("referee"), dict):
            arbitro.update(m["referee"])
        m["referee"] = arbitro

        clima = {"condition": "Despejado", "temp": 20, "wind": 8}
        if isinstance(m.get("weather"), dict):
            clima.update(m["weather"])
        m["weather"] = clima

        descanso = {"home": 4, "away": 4}
        if isinstance(m.get("rest"), dict):
            descanso.update(m["rest"])
        m["rest"] = descanso

        viaje = {"home": 0, "away": 0}
        if isinstance(m.get("travelKm"), dict):
            viaje.update(m["travelKm"])
        m["travelKm"] = viaje

        motivacion = {"home": 1.0, "away": 1.0}
        if isinstance(m.get("motivation"), dict):
            motivacion.update(m["motivation"])
        m["motivation"] = motivacion

        alineaciones = m.get("lineups") if isinstance(m.get("lineups"), dict) else {}
        for lado in ("home", "away"):
            base = {
                "attackDelta": 0.0,
                "defenseDelta": 0.0,
                "absences": [],
                "note": "XI completo.",
            }
            if isinstance(alineaciones.get(lado), dict):
                base.update(alineaciones[lado])
            alineaciones[lado] = base
        m["lineups"] = alineaciones

        if m.get("leg") is not None:
            try:
                m["leg"] = int(m["leg"])
            except (TypeError, ValueError):
                pass
        if m.get("leg") == 2 and m.get("aggregate") is None:
            m["aggregate"] = {"home": 0, "away": 0}
        if isinstance(m.get("aggregate"), dict):
            m["aggregate"] = {
                "home": m["aggregate"].get("home", 0),
                "away": m["aggregate"].get("away", 0),
            }

        partidos.append(m)

    if isinstance(FILTROS, list):
        filtros = copy.deepcopy(FILTROS)
    else:
        raise DatosError("FILTROS debe ser una lista.")
    if not any(isinstance(f, dict) and f.get("id") == "all" for f in filtros):
        filtros.insert(0, {"id": "all", "label": "Todos"})

    return liga, equipos, partidos, tipos, filtros


def validar(liga, equipos, partidos, tipos, filtros) -> tuple[list[str], list[str]]:
    errores: list[str] = []
    avisos: list[str] = []

    def texto(valor, ruta, minimo=1):
        if not isinstance(valor, str) or len(valor.strip()) < minimo:
            errores.append(f"{ruta}: falta un texto válido.")

    def numero(valor, ruta, minimo=None, maximo=None, entero=False):
        if not es_numero(valor):
            errores.append(f"{ruta}: debe ser un número.")
            return
        if entero and int(valor) != valor:
            errores.append(f"{ruta}: debe ser un número entero.")
        if minimo is not None and valor < minimo:
            errores.append(f"{ruta}: debe ser >= {minimo} (valor: {valor}).")
        if maximo is not None and valor > maximo:
            errores.append(f"{ruta}: debe ser <= {maximo} (valor: {valor}).")

    def booleano(valor, ruta):
        if not isinstance(valor, bool):
            errores.append(f"{ruta}: debe ser True o False.")

    # Liga
    texto(liga.get("id"), "LIGA.id")
    texto(liga.get("name"), "LIGA.name")
    texto(liga.get("season"), "LIGA.season")
    numero(liga.get("avgGoals"), "LIGA.avgGoals", 0.4, 4.0)
    numero(liga.get("homeFactor"), "LIGA.homeFactor", 0.7, 1.6)
    numero(liga.get("awayFactor"), "LIGA.awayFactor", 0.6, 1.3)
    numero(liga.get("avgCards"), "LIGA.avgCards", 0, 15)
    numero(liga.get("avgCorners"), "LIGA.avgCorners", 0, 30)
    numero(liga.get("rho"), "LIGA.rho", -0.2, 0.2)
    booleano(liga.get("demo"), "LIGA.demo")
    texto(liga.get("updated"), "LIGA.updated")

    # Equipos
    if len(equipos) < 2:
        errores.append("EQUIPOS: necesitas al menos 2 equipos.")
    ids = {}
    abreviaturas = {}
    for i, e in enumerate(equipos):
        ruta = f"EQUIPOS[{i}]"
        texto(e.get("id"), f"{ruta}.id")
        texto(e.get("name"), f"{ruta}.name")
        texto(e.get("short"), f"{ruta}.short")
        texto(e.get("abbr"), f"{ruta}.abbr")
        texto(e.get("city"), f"{ruta}.city")
        if isinstance(e.get("id"), str):
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", e["id"]):
                errores.append(
                    f"{ruta}.id: usa minúsculas, números y guiones "
                    f"(ejemplo: mi-equipo). Valor: {e['id']!r}"
                )
            if e["id"] in ids:
                errores.append(f"{ruta}.id: repetido con EQUIPOS[{ids[e['id']]}].")
            else:
                ids[e["id"]] = i
        if isinstance(e.get("abbr"), str):
            if not re.fullmatch(r"[A-Z0-9]{2,4}", e["abbr"]):
                errores.append(f"{ruta}.abbr: usa 2-4 letras/números, sin espacios.")
            abreviaturas.setdefault(e["abbr"], []).append(e.get("name", ruta))
        for color in ("color", "color2"):
            if not isinstance(e.get(color), str) or not re.fullmatch(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})", e[color]):
                errores.append(f"{ruta}.{color}: usa un color hex como #2457d6.")
        for clave in ("attack", "defense"):
            numero(e.get(clave), f"{ruta}.{clave}", 0.2, 2.5)
        for clave in ("cornersFor", "cornersAgainst", "shotsFor", "shotsAgainst", "cards"):
            numero(e.get(clave), f"{ruta}.{clave}", 0, 40)
        numero(e.get("onTargetRate"), f"{ruta}.onTargetRate", 0, 1)
        numero(e.get("possession"), f"{ruta}.possession", 0, 100)
        numero(e.get("altitude"), f"{ruta}.altitude", 0, 5000)
        if not isinstance(e.get("form"), list) or len(e["form"]) != 5:
            errores.append(f"{ruta}.form: deben ser exactamente 5 resultados W/D/L.")
        elif any(x not in ("W", "D", "L") for x in e["form"]):
            errores.append(f"{ruta}.form: solo se permite W, D o L.")
        jugadores = e.get("players")
        if not isinstance(jugadores, list) or not jugadores:
            errores.append(f"{ruta}.players: necesitas al menos 1 jugador.")
            continue
        nombres = set()
        for j, p in enumerate(jugadores):
            jr = f"{ruta}.players[{j}]"
            if not isinstance(p, dict):
                errores.append(f"{jr}: debe ser un diccionario.")
                continue
            texto(p.get("name"), f"{jr}.name")
            texto(p.get("pos"), f"{jr}.pos")
            numero(p.get("xg90"), f"{jr}.xg90", 0, 2)
            numero(p.get("minutes"), f"{jr}.minutes", 0, 1)
            numero(p.get("pen"), f"{jr}.pen", 0, 1)
            if isinstance(p.get("name"), str):
                if p["name"] in nombres:
                    errores.append(f"{jr}.name: jugador repetido en el mismo equipo.")
                nombres.add(p["name"])
        if len(jugadores) < 3:
            avisos.append(f"{ruta}: solo tiene {len(jugadores)} jugador(es); el panel de goleadores se verá corto.")

    for abbr, nombres in abreviaturas.items():
        if len(nombres) > 1:
            avisos.append(f"Abreviatura {abbr!r} repetida en: {', '.join(nombres)}.")

    # Partidos
    if not partidos:
        errores.append("PARTIDOS: necesitas al menos 1 partido.")
    ids_partidos = {}
    for i, m in enumerate(partidos):
        ruta = f"PARTIDOS[{i}]"
        texto(m.get("id"), f"{ruta}.id")
        if isinstance(m.get("id"), str):
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", m["id"]):
                errores.append(
                    f"{ruta}.id: usa minúsculas, números y guiones. Valor: {m['id']!r}"
                )
            if m["id"] in ids_partidos:
                errores.append(f"{ruta}.id: repetido con PARTIDOS[{ids_partidos[m['id']]}].")
            else:
                ids_partidos[m["id"]] = i
        for lado in ("home", "away"):
            if m.get(lado) not in ids:
                errores.append(
                    f"{ruta}.{lado}: el equipo {m.get(lado)!r} no existe en EQUIPOS. "
                    f"Ids válidos: {', '.join(sorted(ids)) or '(ninguno)'}"
                )
        if m.get("home") == m.get("away"):
            errores.append(f"{ruta}: home y away no pueden ser el mismo equipo.")
        if m.get("type") not in tipos:
            errores.append(f"{ruta}.type: {m.get('type')!r} no está definido en TIPOS.")
        texto(m.get("competition"), f"{ruta}.competition")
        texto(m.get("stage"), f"{ruta}.stage")
        texto(m.get("headline"), f"{ruta}.headline")
        texto(m.get("venue"), f"{ruta}.venue")
        texto(m.get("city"), f"{ruta}.city")
        if not parsear_fecha(m.get("date")):
            errores.append(
                f"{ruta}.date: usa ISO 8601 con zona horaria, "
                f"por ejemplo 2026-11-01T19:00:00-06:00. Valor: {m.get('date')!r}"
            )
        elif isinstance(m.get("date"), str) and not re.search(r"(Z|[+-]\d{2}:?\d{2})$", m["date"].strip()):
            avisos.append(f"{ruta}.date: no tiene zona horaria; se interpretará como hora local.")
        booleano(m.get("neutral"), f"{ruta}.neutral")
        booleano(m.get("rivalry"), f"{ruta}.rivalry")
        numero(m.get("altitude"), f"{ruta}.altitude", 0, 5000)
        if not isinstance(m.get("note"), str):
            errores.append(f"{ruta}.note: debe ser texto.")
        if m.get("leg") is not None and m.get("leg") not in (1, 2):
            errores.append(f"{ruta}.leg: debe ser 1 (ida) o 2 (vuelta).")

        arbitro = m.get("referee")
        if not isinstance(arbitro, dict):
            errores.append(f"{ruta}.referee: debe ser un diccionario.")
        else:
            texto(arbitro.get("name"), f"{ruta}.referee.name")
            numero(arbitro.get("cardsPerMatch"), f"{ruta}.referee.cardsPerMatch", 0, 15)
            numero(arbitro.get("penaltiesPerMatch"), f"{ruta}.referee.penaltiesPerMatch", 0, 2)

        clima = m.get("weather")
        if not isinstance(clima, dict):
            errores.append(f"{ruta}.weather: debe ser un diccionario.")
        else:
            texto(clima.get("condition"), f"{ruta}.weather.condition")
            numero(clima.get("temp"), f"{ruta}.weather.temp", -20, 50)
            numero(clima.get("wind"), f"{ruta}.weather.wind", 0, 150)

        for clave in ("rest", "travelKm", "motivation"):
            bloque = m.get(clave)
            if not isinstance(bloque, dict):
                errores.append(f"{ruta}.{clave}: debe ser un diccionario con home y away.")
                continue
            for lado in ("home", "away"):
                if clave == "rest":
                    numero(bloque.get(lado), f"{ruta}.{clave}.{lado}", 0, 30, entero=True)
                elif clave == "travelKm":
                    numero(bloque.get(lado), f"{ruta}.{clave}.{lado}", 0, 20000, entero=True)
                else:
                    numero(bloque.get(lado), f"{ruta}.{clave}.{lado}", 0.5, 1.5)

        alineaciones = m.get("lineups")
        if not isinstance(alineaciones, dict):
            errores.append(f"{ruta}.lineups: debe ser un diccionario con home y away.")
        else:
            for lado in ("home", "away"):
                al = alineaciones.get(lado)
                ar = f"{ruta}.lineups.{lado}"
                if not isinstance(al, dict):
                    errores.append(f"{ar}: debe ser un diccionario.")
                    continue
                numero(al.get("attackDelta"), f"{ar}.attackDelta", -0.3, 0.1)
                numero(al.get("defenseDelta"), f"{ar}.defenseDelta", -0.1, 0.15)
                if not isinstance(al.get("note"), str):
                    errores.append(f"{ar}.note: debe ser texto.")
                ausencias = al.get("absences")
                if not isinstance(ausencias, list):
                    errores.append(f"{ar}.absences: debe ser una lista.")
                    continue
                equipo = next((e for e in equipos if e.get("id") == m.get(lado)), {})
                nombres_equipo = {p.get("name") for p in equipo.get("players", []) if isinstance(p, dict)}
                for k, ausencia in enumerate(ausencias):
                    aur = f"{ar}.absences[{k}]"
                    if not isinstance(ausencia, dict):
                        errores.append(f"{aur}: debe ser un diccionario.")
                        continue
                    texto(ausencia.get("name"), f"{aur}.name")
                    texto(ausencia.get("pos"), f"{aur}.pos")
                    if not isinstance(ausencia.get("note"), str):
                        errores.append(f"{aur}.note: debe ser texto.")
                    if ausencia.get("name") not in nombres_equipo:
                        avisos.append(
                            f"{aur}: {ausencia.get('name')!r} no coincide con ningún jugador de "
                            f"{equipo.get('name', m.get(lado))}; la baja no se descontará del reparto."
                        )

        if m.get("aggregate") is not None:
            agg = m.get("aggregate")
            if not isinstance(agg, dict):
                errores.append(f"{ruta}.aggregate: debe ser un diccionario con home y away.")
            else:
                numero(agg.get("home"), f"{ruta}.aggregate.home", 0, 20, entero=True)
                numero(agg.get("away"), f"{ruta}.aggregate.away", 0, 20, entero=True)

    # Tipos y filtros
    if not tipos:
        errores.append("TIPOS: necesitas al menos un tipo de partido.")
    for clave, etiqueta in tipos.items():
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(clave)):
            errores.append(f"TIPOS: la clave {clave!r} debe ser un id en minúsculas.")
        if not isinstance(etiqueta, str) or not etiqueta.strip():
            errores.append(f"TIPOS[{clave!r}]: la etiqueta no puede estar vacía.")
    ids_filtros = set()
    for i, f in enumerate(filtros):
        if not isinstance(f, dict):
            errores.append(f"FILTROS[{i}]: debe ser un diccionario.")
            continue
        if not isinstance(f.get("id"), str) or not f["id"].strip():
            errores.append(f"FILTROS[{i}].id: falta un id.")
        elif f["id"] in ids_filtros:
            errores.append(f"FILTROS[{i}].id: repetido.")
        else:
            ids_filtros.add(f["id"])
        if not isinstance(f.get("label"), str) or not f["label"].strip():
            errores.append(f"FILTROS[{i}].label: falta una etiqueta.")
    if "all" not in ids_filtros:
        errores.append("FILTROS: falta el filtro con id 'all'.")

    return errores, avisos


def js_dump(valor) -> str:
    return json.dumps(valor, ensure_ascii=False, indent=2)


def escribir_archivo(ruta: Path, contenido: str) -> None:
    temporal = ruta.with_suffix(ruta.suffix + ".tmp")
    temporal.write_text(contenido, encoding="utf-8", newline="\n")
    temporal.replace(ruta)


def respaldar_demo(salida: Path) -> bool:
    """Guarda una copia de los datos actuales antes de sobrescribirlos."""
    if BACKUP_DIR.exists():
        return False
    existentes = [salida / nombre for nombre in ARCHIVOS if (salida / nombre).exists()]
    if not existentes:
        return False
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    for origen in existentes:
        shutil.copy2(origen, BACKUP_DIR / origen.name)
    return True


def generar(liga, equipos, partidos, tipos, filtros, salida: Path) -> list[Path]:
    salida.mkdir(parents=True, exist_ok=True)
    respaldo = False
    if salida.resolve() == DATA_DIR.resolve():
        respaldo = respaldar_demo(salida)

    equipos_por_id = {e["id"]: e for e in equipos}
    marca = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
    cabecera = (
        f"// Generado por mis_datos.py el {marca}.\n"
        "// Edita mis_datos.py y vuelve a ejecutar; no edites este archivo a mano.\n\n"
    )

    league_js = (
        cabecera
        + f"export const LEAGUE = {js_dump(liga)};\n\n"
        + f"export const TYPE_LABELS = {js_dump(tipos)};\n\n"
        + f"export const FILTERS = {js_dump(filtros)};\n"
    )
    equipos_base = {
        equipo_id: {k: v for k, v in equipo.items() if k != "playerForm"}
        for equipo_id, equipo in equipos_por_id.items()
    }
    formularios = {
        equipo_id: equipo["playerForm"]
        for equipo_id, equipo in equipos_por_id.items()
        if "playerForm" in equipo
    }
    teams_js = cabecera + f"export const TEAMS = {js_dump(equipos_por_id)};\n"
    teams_base_js = (
        cabecera
        + "// Equipos sin detalle de jugadores. Carga inicial de AIFUT.\n"
        + f"export const TEAMS = {js_dump(equipos_base)};\n"
    )
    player_form_js = (
        cabecera
        + "// Detalle de jugadores por equipo. Se carga solo con el análisis completo.\n"
        + f"export const PLAYER_FORMS = {js_dump(formularios)};\n"
    )
    matches_js = cabecera + f"export const MATCHES = {js_dump(partidos)};\n"
    tables_js = cabecera + "export const TABLES = {};\n"

    rutas = [
        salida / "league.js",
        salida / "teams.js",
        salida / "teams_base.js",
        salida / "player_form.js",
        salida / "matches.js",
        salida / "tables.js",
    ]
    escribir_archivo(rutas[0], league_js)
    escribir_archivo(rutas[1], teams_js)
    escribir_archivo(rutas[2], teams_base_js)
    escribir_archivo(rutas[3], player_form_js)
    escribir_archivo(rutas[4], matches_js)
    escribir_archivo(rutas[5], tables_js)
    if respaldo:
        print(f"Respaldo de los datos anteriores: {BACKUP_DIR}")
    return rutas


def restaurar() -> None:
    if not BACKUP_DIR.exists():
        raise DatosError(
            f"No existe el respaldo {BACKUP_DIR}. "
            "Todavía no has generado datos propios o ya restauraste los datos de respaldo."
        )
    faltan = [nombre for nombre in ARCHIVOS if not (BACKUP_DIR / nombre).exists()]
    if faltan:
        raise DatosError(f"El respaldo está incompleto; faltan: {', '.join(faltan)}")
    for nombre in ARCHIVOS:
        shutil.copy2(BACKUP_DIR / nombre, DATA_DIR / nombre)
    escribir_archivo(
        DATA_DIR / "tables.js",
        "// Datos propios/respaldo: sin tabla de liga.\nexport const TABLES = {};\n",
    )
    print("Datos de respaldo restaurados en js/data/.")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Valida tus datos y genera los archivos JS de MOTOR-NOX V1.0."
    )
    parser.add_argument(
        "--validar",
        action="store_true",
        help="Comprueba los datos sin escribir archivos.",
    )
    parser.add_argument(
        "--restaurar",
        action="store_true",
        help="Restaura los datos de respaldo guardados en _respaldo_demo/.",
    )
    parser.add_argument(
        "--salida",
        type=Path,
        default=DATA_DIR,
        help=f"Carpeta de destino (por defecto: {DATA_DIR}).",
    )
    args = parser.parse_args()

    if args.restaurar:
        try:
            restaurar()
        except DatosError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        return 0

    try:
        liga, equipos, partidos, tipos, filtros = normalizar()
    except DatosError as exc:
        print(f"Error de estructura: {exc}", file=sys.stderr)
        return 1

    errores, avisos = validar(liga, equipos, partidos, tipos, filtros)
    for aviso in avisos:
        print(f"Aviso: {aviso}")
    if errores:
        print(f"\nSe encontraron {len(errores)} error(es):", file=sys.stderr)
        for error in errores:
            print(f"  - {error}", file=sys.stderr)
        print("\nNo se escribió ningún archivo.", file=sys.stderr)
        return 1

    print(
        f"Validación correcta: {len(equipos)} equipos, "
        f"{len(partidos)} partidos, {len(tipos)} tipos."
    )
    if args.validar:
        print("Modo --validar: no se escribió nada.")
        return 0

    salida = args.salida
    if not salida.is_absolute():
        salida = (BASE_DIR / salida).resolve()
    rutas = generar(liga, equipos, partidos, tipos, filtros, salida)
    print("\nArchivos generados:")
    for ruta in rutas:
        print(f"  - {ruta}")
    if salida.resolve() == DATA_DIR.resolve():
        print("\nRecarga http://127.0.0.1:4173 para ver tus datos.")
        print("Para volver a los datos de respaldo: python mis_datos.py --restaurar")
    else:
        print(f"\nNota: la app lee de {DATA_DIR}. Copia los archivos ahí para verlos en la interfaz.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
