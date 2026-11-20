"""
Sección 3 de MOTOR-NOX V1.0: baselines, modelos tabulares y ensamble.

Este módulo entrena y evalúa cuatro modelos sobre el feature store pre-partido:

1. Poisson + Dixon-Coles del motor JavaScript (baseline explicable y fallback).
2. Regresión logística con Elo + xG.
3. Regresión logística con el núcleo pre-partido (apoyo binario).
4. Regresión logística con Elo + xG + tiros + tiros a puerta (modelo principal
   de 1X2).

Reglas de la sección:
- Split temporal estricto: train 2020-21..2022-23, validación 2023-24,
  test 2024-25..2025-26.
- La validación se parte por fecha: primera mitad para calibrar (temperatura),
  segunda mitad para aprender los pesos del ensamble.
- El test se evalúa una sola vez y no participa en ninguna decisión.
- Cada modelo se calibra antes de compararse.
- Los pesos del ensamble se aprenden sin piso artificial; los modelos que no
  aportan reciben peso cero.
- Si falta la fila de features o el ancla Elo, el ensamble cae a Poisson.
- Nada de redes neuronales.

Uso:
    python -m pipeline.models
    python -m pipeline.models --no-write
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sqlite3
from typing import Any

import numpy as np
import pandas as pd
from scipy.optimize import minimize, minimize_scalar
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss
from sklearn.preprocessing import StandardScaler

from .db import BASE_DIR, DATA_DIR, get_connection
from .feature_catalog import FEATURE_CATALOG

REPORT_VERSION = "3.0.0"
ENGINE_ID = "motor-nox-v1"
ENGINE_VERSION = "1.0"
MODEL_NAME = "OX V1.0"

MODELS_DIR = DATA_DIR / "models"
REPORT_PATH = MODELS_DIR / "model_report.json"
CARDS_PATH = MODELS_DIR / "model_cards.json"
CARDS_MD_PATH = MODELS_DIR / "MODEL_CARDS.md"
POISSON_PATH = MODELS_DIR / "poisson_baseline.json"
WEB_REPORT_PATH = BASE_DIR / "js" / "data" / "model_report.js"
ENSEMBLE_PARAMS_JSON_PATH = MODELS_DIR / "ensemble_params.json"
ENSEMBLE_PARAMS_JS_PATH = BASE_DIR / "js" / "data" / "ensemble_params.js"

TRAIN_SEASONS = ("2020-21", "2021-22", "2022-23")
VALIDATION_SEASON = "2023-24"
TEST_SEASONS = ("2024-25", "2025-26")
WEIGHT_FLOOR = 0.0
BOOTSTRAP_SAMPLES = 1000
RANDOM_STATE = 42
CALIBRATION_BOUNDS = (0.5, 3.0)
MARKETS = (
    {"id": "1x2", "label": "1X2", "kind": "multi"},
    {"id": "btts", "label": "Ambos anotan", "kind": "binary"},
    {"id": "over15", "label": "Más de 1.5", "kind": "binary"},
    {"id": "over25", "label": "Más de 2.5", "kind": "binary"},
    {"id": "over35", "label": "Más de 3.5", "kind": "binary"},
)

XG_ELO_FEATURES = [
    "elo_diff",
    "xg_diff_5",
    "xg_diff_20",
    "d_xg_for_10",
    "d_xg_against_10",
    "is_esp",
]
CORE_FEATURES = [
    "elo_diff",
    "xg_diff_5",
    "xg_diff_20",
    "d_xg_for_10",
    "d_xg_against_10",
    "d_shots_for_10",
    "d_shots_against_10",
    "d_ppda_10",
    "rest_diff",
    "travel_diff",
    "position_diff",
    "d_ppg",
    "league_goals_avg_prior",
    "match_importance",
    "is_derby",
    "season_progress",
    "is_esp",
]
LEAN_FEATURES = [
    "elo_diff",
    "xg_diff_5",
    "xg_diff_20",
    "d_xg_for_10",
    "d_xg_against_10",
    "d_shots_for_10",
    "d_shots_against_10",
    "d_sot_for_10",
    "d_sot_against_10",
    "is_esp",
]

FEATURE_SET_NAMES = {
    "xg_elo": XG_ELO_FEATURES,
    "core": CORE_FEATURES,
    "lean": LEAN_FEATURES,
}
MODEL_FEATURES = sorted(
    {name for features in FEATURE_SET_NAMES.values() for name in features}
)

DERIVED_FEATURES = {
    "d_xg_for_10": ("home_xg_for_10", "away_xg_for_10"),
    "d_xg_against_10": ("home_xg_against_10", "away_xg_against_10"),
    "d_shots_for_10": ("home_shots_for_10", "away_shots_for_10"),
    "d_shots_against_10": ("home_shots_against_10", "away_shots_against_10"),
    "d_sot_for_10": ("home_sot_for_10", "away_sot_for_10"),
    "d_sot_against_10": ("home_sot_against_10", "away_sot_against_10"),
    "d_ppda_10": ("home_ppda_10", "away_ppda_10"),
    "d_ppg": ("home_ppg", "away_ppg"),
    "d_lineup": ("home_lineup_continuity", "away_lineup_continuity"),
    "d_depth": ("home_squad_depth", "away_squad_depth"),
}

DERIVED_LABELS = {
    "d_xg_for_10": "Diferencia de xG a favor (10)",
    "d_xg_against_10": "Diferencia de xG en contra (10)",
    "d_shots_for_10": "Diferencia de tiros a favor (10)",
    "d_shots_against_10": "Diferencia de tiros en contra (10)",
    "d_sot_for_10": "Diferencia de tiros a puerta a favor (10)",
    "d_sot_against_10": "Diferencia de tiros a puerta en contra (10)",
    "d_ppda_10": "Diferencia de PPDA (10)",
    "d_ppg": "Diferencia de puntos por partido",
    "d_lineup": "Diferencia de continuidad del XI",
    "d_depth": "Diferencia de profundidad de plantilla",
    "is_esp": "Indicador de LaLiga",
}

MODEL_SPECS = [
    {
        "id": "poisson",
        "label": "Poisson + Dixon-Coles",
        "family": "poisson",
        "feature_set": None,
        "description": "Motor explicable de la UI: fuerzas de ataque/defensa, últimos 10, H2H y matriz bivariada con Dixon-Coles.",
        "source": "js/model/core.js · backtest.js",
    },
    {
        "id": "logit_xg_elo",
        "label": "Logística Elo + xG",
        "family": "logistic",
        "feature_set": "xg_elo",
        "C": 0.03,
        "description": "Baseline de control: Elo, xG a 5/20, diferencias de xG a 10 y liga. El optimizador le asigna peso cero; se conserva para comparar.",
        "source": "scikit-learn LogisticRegression",
    },
    {
        "id": "logit_core",
        "label": "Logística core",
        "family": "logistic",
        "feature_set": "core",
        "C": 0.03,
        "description": "Logística con el núcleo pre-partido de 17 features. Aporta al 1X2 y al over 1.5; el resto de binarios queda en Poisson.",
        "source": "scikit-learn LogisticRegression",
    },
    {
        "id": "logit_xg_shots",
        "label": "Logística Elo + xG + tiros",
        "family": "logistic",
        "feature_set": "lean",
        "C": 0.03,
        "description": "Componente principal del 1X2: Elo, xG a 5/20, diferencias de xG a 10, tiros y tiros a puerta.",
        "source": "scikit-learn LogisticRegression",
    },
]

MODEL_IDS = [spec["id"] for spec in MODEL_SPECS]


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _to_native(value: Any) -> Any:
    """Convierte tipos de numpy/pandas a tipos JSON nativos."""
    if isinstance(value, dict):
        return {str(key): _to_native(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_native(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        number = float(value)
        return None if math.isnan(number) or math.isinf(number) else number
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if value is pd.NA:
        return None
    return value


def _pct(value: float | None, digits: int = 2) -> str:
    if value is None:
        return "—"
    return f"{value * 100:.{digits}f}%"


def _num(value: float | None, digits: int = 4) -> str:
    if value is None:
        return "—"
    return f"{value:.{digits}f}"


def _json_dump(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(_to_native(payload), handle, ensure_ascii=False, indent=2)
        handle.write("\n")


# ---------------------------------------------------------------------------
# Carga y preparación
# ---------------------------------------------------------------------------


def _latest_feature_version(conn: sqlite3.Connection) -> str | None:
    row = conn.execute(
        "SELECT version FROM feature_datasets ORDER BY built_at DESC LIMIT 1"
    ).fetchone()
    return row["version"] if row else None


def load_dataset(conn: sqlite3.Connection) -> tuple[pd.DataFrame, dict[str, dict], str]:
    """Carga partidos, etiquetas y features usables en un DataFrame."""
    version = _latest_feature_version(conn)
    if not version:
        raise RuntimeError("No hay feature_datasets. Ejecuta primero: python -m pipeline.run_pipeline --features")

    rows = conn.execute(
        """
        SELECT
            m.id, m.league_id, m.season, m.date_utc,
            m.home_team_id, m.away_team_id,
            m.home_goals, m.away_goals,
            th.name AS home_name, ta.name AS away_name,
            f.features_json
        FROM matches m
        JOIN match_features f
          ON f.match_id = m.id AND f.dataset_version = ?
        LEFT JOIN teams th ON th.id = m.home_team_id
        LEFT JOIN teams ta ON ta.id = m.away_team_id
        WHERE m.status = 'completed'
          AND m.home_goals IS NOT NULL
          AND m.away_goals IS NOT NULL
          AND m.league_id IN ('eng.1', 'esp.1')
        ORDER BY m.date_utc, m.id
        """,
        (version,),
    ).fetchall()

    records: list[dict[str, Any]] = []
    feature_entries: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        payload = json.loads(row["features_json"])
        record: dict[str, Any] = {
            "match_id": row["id"],
            "league_id": row["league_id"],
            "season": row["season"],
            "date": row["date_utc"],
            "home_team_id": row["home_team_id"],
            "away_team_id": row["away_team_id"],
            "home_name": row["home_name"] or row["home_team_id"],
            "away_name": row["away_name"] or row["away_team_id"],
            "home_goals": int(row["home_goals"]),
            "away_goals": int(row["away_goals"]),
        }
        for name, entry in payload.items():
            if entry.get("usable_for_model"):
                record[name] = entry.get("value")
            feature_entries.setdefault(name, []).append(entry)
        records.append(record)

    df = pd.DataFrame(records)
    if df.empty:
        raise RuntimeError("El feature store no tiene partidos utilizables.")

    df["y"] = np.where(
        df["home_goals"] > df["away_goals"],
        0,
        np.where(df["home_goals"] == df["away_goals"], 1, 2),
    )
    df["btts"] = ((df["home_goals"] > 0) & (df["away_goals"] > 0)).astype(int)
    df["over15"] = ((df["home_goals"] + df["away_goals"]) > 1.5).astype(int)
    df["over25"] = ((df["home_goals"] + df["away_goals"]) > 2.5).astype(int)
    df["over35"] = ((df["home_goals"] + df["away_goals"]) > 3.5).astype(int)
    df["is_esp"] = (df["league_id"] == "esp.1").astype(int)

    # Diferencias derivadas. Se calculan a partir de las features base para que
    # el modelo no dependa de que existan columnas ya derivadas en el store.
    for name, (home, away) in DERIVED_FEATURES.items():
        if home in df.columns and away in df.columns:
            df[name] = df[home] - df[away]

    if "xg_diff_5" not in df.columns or df["xg_diff_5"].isna().any():
        if "home_xg_for_5" in df.columns and "away_xg_for_5" in df.columns:
            df["xg_diff_5"] = df["xg_diff_5"].fillna(df["home_xg_for_5"] - df["away_xg_for_5"])
    if "xg_diff_10" not in df.columns or df["xg_diff_10"].isna().any():
        if "home_xg_for_10" in df.columns and "away_xg_for_10" in df.columns:
            df["xg_diff_10"] = df["xg_diff_10"].fillna(df["home_xg_for_10"] - df["away_xg_for_10"])
    if "xg_diff_20" not in df.columns or df["xg_diff_20"].isna().any():
        if "home_xg_for_20" in df.columns and "away_xg_for_20" in df.columns:
            df["xg_diff_20"] = df["xg_diff_20"].fillna(df["home_xg_for_20"] - df["away_xg_for_20"])
    if "elo_diff" not in df.columns or df["elo_diff"].isna().any():
        if "home_elo_pre" in df.columns and "away_elo_pre" in df.columns:
            df["elo_diff"] = df["elo_diff"].fillna(df["home_elo_pre"] - df["away_elo_pre"])

    for name in MODEL_FEATURES:
        if name not in df.columns:
            df[name] = np.nan

    return df, feature_entries, version


def _load_poisson_baseline() -> dict[str, Any]:
    if not POISSON_PATH.exists():
        raise RuntimeError(
            f"No existe {POISSON_PATH}. Ejecuta primero: node pipeline/export_poisson_baseline.mjs"
        )
    with open(POISSON_PATH, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not payload.get("rows"):
        raise RuntimeError("El baseline de Poisson no tiene filas.")
    return payload


def _attach_poisson(df: pd.DataFrame, baseline: dict[str, Any]) -> pd.DataFrame:
    rows = {str(row["matchId"]): row for row in baseline["rows"]}
    df = df.copy()
    df["poisson_home"] = df["match_id"].map(lambda value: rows.get(str(value), {}).get("probs", {}).get("home"))
    df["poisson_draw"] = df["match_id"].map(lambda value: rows.get(str(value), {}).get("probs", {}).get("draw"))
    df["poisson_away"] = df["match_id"].map(lambda value: rows.get(str(value), {}).get("probs", {}).get("away"))
    for market in ("btts", "over15", "over25", "over35"):
        df[f"poisson_{market}"] = df["match_id"].map(lambda value: rows.get(str(value), {}).get(market))
    df["has_poisson"] = df["poisson_home"].notna() & df["poisson_draw"].notna() & df["poisson_away"].notna()
    return df


def split_dataset(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Split temporal. Validación y test se limitan a filas con Poisson comparable."""
    train = df[df["season"].isin(TRAIN_SEASONS)].copy()
    val_all = df[df["season"] == VALIDATION_SEASON].copy()
    test_all = df[df["season"].isin(TEST_SEASONS)].copy()
    val = val_all[val_all["has_poisson"]].sort_values(["date", "match_id"]).copy()
    test = test_all[test_all["has_poisson"]].sort_values(["date", "match_id"]).copy()
    if train.empty or val.empty or test.empty:
        raise RuntimeError("El split temporal quedó vacío.")
    # La validación se corta por fecha para no separar partidos del mismo día
    # entre calibración y pesos. Si la fecha de corte dejara un bloque vacío,
    # se usa el corte posicional como respaldo.
    cut_date = val["date"].iloc[len(val) // 2]
    calibration = val[val["date"] < cut_date].copy()
    weights = val[val["date"] >= cut_date].copy()
    if calibration.empty or weights.empty:
        half = len(val) // 2
        calibration = val.iloc[:half].copy()
        weights = val.iloc[half:].copy()
    return {
        "train": train,
        "validation_all": val_all,
        "validation": val,
        "calibration": calibration,
        "weights": weights,
        "test_all": test_all,
        "test": test,
    }


# ---------------------------------------------------------------------------
# Matrices de features
# ---------------------------------------------------------------------------


@dataclass
class FeatureBundle:
    features: list[str]
    matrix_features: list[str]
    imputed_features: list[str]
    X_train: pd.DataFrame
    X_cal: pd.DataFrame
    X_wgt: pd.DataFrame
    X_test: pd.DataFrame
    imputer: Any = None
    scaler: Any = None


def build_feature_bundle(
    train: pd.DataFrame,
    calibration: pd.DataFrame,
    weights: pd.DataFrame,
    test: pd.DataFrame,
    features: list[str],
) -> FeatureBundle:
    """Imputa con mediana de train, añade indicadores de ausencia y escala."""
    for name in features:
        if name not in train.columns:
            raise KeyError(f"Feature ausente en el dataset: {name}")

    X_train = train[features].copy()
    X_cal = calibration[features].copy()
    X_wgt = weights[features].copy()
    X_test = test[features].copy()

    missing = [
        name
        for name in features
        if X_train[name].isna().any()
        or X_cal[name].isna().any()
        or X_wgt[name].isna().any()
        or X_test[name].isna().any()
    ]
    for name in missing:
        X_train[f"{name}__missing"] = X_train[name].isna().astype(int)
        X_cal[f"{name}__missing"] = X_cal[name].isna().astype(int)
        X_wgt[f"{name}__missing"] = X_wgt[name].isna().astype(int)
        X_test[f"{name}__missing"] = X_test[name].isna().astype(int)

    empty = [name for name in X_train.columns if X_train[name].isna().all()]
    if empty:
        raise RuntimeError(f"Features sin ningún valor en train: {', '.join(empty)}")

    imputer = SimpleImputer(strategy="median")
    X_train = pd.DataFrame(imputer.fit_transform(X_train), columns=X_train.columns, index=X_train.index)
    X_cal = pd.DataFrame(imputer.transform(X_cal), columns=X_cal.columns, index=X_cal.index)
    X_wgt = pd.DataFrame(imputer.transform(X_wgt), columns=X_wgt.columns, index=X_wgt.index)
    X_test = pd.DataFrame(imputer.transform(X_test), columns=X_test.columns, index=X_test.index)

    scaler = StandardScaler()
    X_train = pd.DataFrame(scaler.fit_transform(X_train), columns=X_train.columns, index=X_train.index)
    X_cal = pd.DataFrame(scaler.transform(X_cal), columns=X_cal.columns, index=X_cal.index)
    X_wgt = pd.DataFrame(scaler.transform(X_wgt), columns=X_wgt.columns, index=X_wgt.index)
    X_test = pd.DataFrame(scaler.transform(X_test), columns=X_test.columns, index=X_test.index)

    return FeatureBundle(
        features=list(features),
        matrix_features=list(X_train.columns),
        imputed_features=missing,
        X_train=X_train,
        X_cal=X_cal,
        X_wgt=X_wgt,
        X_test=X_test,
        imputer=imputer,
        scaler=scaler,
    )


# ---------------------------------------------------------------------------
# Modelos
# ---------------------------------------------------------------------------


def fit_model(spec: dict[str, Any], bundle: FeatureBundle, target: pd.Series):
    family = spec["family"]
    if family == "logistic":
        model = LogisticRegression(max_iter=5000, C=spec.get("C", 1.0))
    elif family == "random_forest":
        model = RandomForestClassifier(**spec["params"])
    elif family == "gradient_boosting":
        model = GradientBoostingClassifier(**spec["params"])
    else:
        raise ValueError(f"Familia de modelo no soportada: {family}")
    model.fit(bundle.X_train, target)
    return model


def predict_model(model, bundle: FeatureBundle, market: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if market == "1x2":
        return (
            model.predict_proba(bundle.X_cal),
            model.predict_proba(bundle.X_wgt),
            model.predict_proba(bundle.X_test),
        )
    return (
        model.predict_proba(bundle.X_cal)[:, 1],
        model.predict_proba(bundle.X_wgt)[:, 1],
        model.predict_proba(bundle.X_test)[:, 1],
    )


# ---------------------------------------------------------------------------
# Calibración
# ---------------------------------------------------------------------------


def apply_temperature_1x2(probs: np.ndarray, temperature: float) -> np.ndarray:
    clipped = np.clip(probs, 1e-12, 1.0)
    log_probs = np.log(clipped)
    scaled = np.exp(log_probs / temperature)
    return scaled / scaled.sum(axis=1, keepdims=True)


def fit_temperature_1x2(probs: np.ndarray, y: np.ndarray) -> tuple[float, np.ndarray]:
    clipped = np.clip(probs, 1e-12, 1.0)
    log_probs = np.log(clipped)

    def objective(temperature: float) -> float:
        scaled = np.exp(log_probs / temperature)
        scaled = scaled / scaled.sum(axis=1, keepdims=True)
        return float(log_loss(y, np.clip(scaled, 1e-15, 1 - 1e-15), labels=[0, 1, 2]))

    result = minimize_scalar(
        objective,
        bounds=CALIBRATION_BOUNDS,
        method="bounded",
        options={"xatol": 1e-6},
    )
    temperature = float(result.x)
    return temperature, apply_temperature_1x2(probs, temperature)


def apply_temperature_binary(probs: np.ndarray, temperature: float) -> np.ndarray:
    clipped = np.clip(probs, 1e-6, 1 - 1e-6)
    logits = np.log(clipped / (1 - clipped))
    return 1.0 / (1.0 + np.exp(-logits / temperature))


def fit_temperature_binary(probs: np.ndarray, y: np.ndarray) -> tuple[float, np.ndarray]:
    clipped = np.clip(probs, 1e-6, 1 - 1e-6)
    logits = np.log(clipped / (1 - clipped))

    def objective(temperature: float) -> float:
        scaled = 1.0 / (1.0 + np.exp(-logits / temperature))
        return float(log_loss(y, np.clip(scaled, 1e-15, 1 - 1e-15)))

    result = minimize_scalar(
        objective,
        bounds=CALIBRATION_BOUNDS,
        method="bounded",
        options={"xatol": 1e-6},
    )
    temperature = float(result.x)
    return temperature, apply_temperature_binary(probs, temperature)


# ---------------------------------------------------------------------------
# Pesos del ensamble
# ---------------------------------------------------------------------------


def _project_weights(weights: np.ndarray, floor: float) -> np.ndarray:
    weights = np.maximum(weights, floor)
    weights = weights / weights.sum()
    for _ in range(100):
        below = weights < floor - 1e-12
        if not below.any():
            break
        deficit = float((floor - weights[below]).sum())
        weights[below] = floor
        free = (~below) & (weights > floor + 1e-12)
        if not free.any():
            break
        capacity = weights[free] - floor
        weights[free] -= deficit * capacity / capacity.sum()
    return weights / weights.sum()


def optimize_weights(probabilities: list[np.ndarray], y: np.ndarray, floor: float = WEIGHT_FLOOR) -> tuple[list[float], float]:
    """Aprende pesos no negativos, suma 1 y piso `floor`, minimizando log-loss."""
    count = len(probabilities)
    if count == 0:
        raise ValueError("No hay modelos para el ensamble.")

    if probabilities[0].ndim == 1:
        stacked = np.stack(probabilities, axis=1)

        def objective(weights: np.ndarray) -> float:
            blended = np.clip(stacked @ weights, 1e-15, 1 - 1e-15)
            return float(log_loss(y, blended))

    else:
        stacked = np.stack(probabilities, axis=2)

        def objective(weights: np.ndarray) -> float:
            blended = np.tensordot(stacked, weights, axes=([2], [0]))
            blended = np.clip(blended, 1e-15, 1.0)
            return float(log_loss(y, blended, labels=[0, 1, 2]))

    initial = np.full(count, 1.0 / count)
    result = minimize(
        objective,
        initial,
        method="SLSQP",
        bounds=[(floor, 1.0)] * count,
        constraints={"type": "eq", "fun": lambda weights: weights.sum() - 1.0},
        options={"maxiter": 3000, "ftol": 1e-12},
    )
    weights = _project_weights(np.asarray(result.x, dtype=float), floor)
    return [float(value) for value in weights], float(objective(weights))


# ---------------------------------------------------------------------------
# Métricas
# ---------------------------------------------------------------------------


def _metric_block_1x2(y: np.ndarray, probs: np.ndarray) -> dict[str, Any]:
    probs = np.clip(probs, 1e-15, 1.0)
    probs = probs / probs.sum(axis=1, keepdims=True)
    hits = int((probs.argmax(axis=1) == y).sum())
    one_hot = np.eye(3)[y]
    return {
        "n": int(len(y)),
        "hits": hits,
        "accuracy": float(hits / len(y)) if len(y) else None,
        "logLoss": float(log_loss(y, probs, labels=[0, 1, 2])),
        "brier": float(np.mean(np.sum((probs - one_hot) ** 2, axis=1))),
        "ece": float(ece_1x2(y, probs)),
    }


def _metric_block_binary(y: np.ndarray, probs: np.ndarray) -> dict[str, Any]:
    probs = np.clip(probs, 1e-15, 1 - 1e-15)
    hits = int(((probs >= 0.5).astype(int) == y).sum())
    return {
        "n": int(len(y)),
        "hits": hits,
        "accuracy": float(hits / len(y)) if len(y) else None,
        "logLoss": float(log_loss(y, probs)),
        "brier": float(np.mean((probs - y) ** 2)),
        "ece": float(ece_binary(y, probs)),
    }


def baseline_1x2(y_train: np.ndarray, y_test: np.ndarray) -> dict[str, Any]:
    rates = np.bincount(y_train, minlength=3).astype(float)
    rates = rates / rates.sum()
    probs = np.tile(rates, (len(y_test), 1))
    block = _metric_block_1x2(y_test, probs)
    block.update(
        {
            "kind": "baseline",
            "probabilities": rates.tolist(),
            "brier": float(np.mean(np.sum((probs - np.eye(3)[y_test]) ** 2, axis=1))),
            "logLoss": float(log_loss(y_test, np.clip(probs, 1e-15, 1), labels=[0, 1, 2])),
        }
    )
    return block


def baseline_binary(y_train: np.ndarray, y_test: np.ndarray) -> dict[str, Any]:
    rate = float(np.mean(y_train))
    probs = np.full(len(y_test), rate)
    block = _metric_block_binary(y_test, probs)
    block.update(
        {
            "kind": "baseline",
            "probability": rate,
            "brier": float(np.mean((probs - y_test) ** 2)),
            "logLoss": float(log_loss(y_test, np.clip(probs, 1e-15, 1 - 1e-15))),
        }
    )
    return block


def add_skill(block: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    block = dict(block)
    block["baseline"] = baseline
    block["skill"] = (
        1.0 - block["brier"] / baseline["brier"] if baseline.get("brier") else None
    )
    block["logLossSkill"] = (
        1.0 - block["logLoss"] / baseline["logLoss"] if baseline.get("logLoss") else None
    )
    return block


def ece_1x2(y: np.ndarray, probs: np.ndarray, bins: int = 10) -> float:
    confidence = probs.max(axis=1)
    correct = (probs.argmax(axis=1) == y).astype(float)
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = 0.0
    for index in range(bins):
        lower, upper = edges[index], edges[index + 1]
        if index == bins - 1:
            mask = (confidence >= lower) & (confidence <= upper)
        else:
            mask = (confidence >= lower) & (confidence < upper)
        if not mask.any():
            continue
        total += float(mask.mean()) * abs(float(confidence[mask].mean()) - float(correct[mask].mean()))
    return total


def ece_binary(y: np.ndarray, probs: np.ndarray, bins: int = 10) -> float:
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = 0.0
    for index in range(bins):
        lower, upper = edges[index], edges[index + 1]
        if index == bins - 1:
            mask = (probs >= lower) & (probs <= upper)
        else:
            mask = (probs >= lower) & (probs < upper)
        if not mask.any():
            continue
        total += float(mask.mean()) * abs(float(probs[mask].mean()) - float(y[mask].mean()))
    return total


def calibration_bins_1x2(y: np.ndarray, probs: np.ndarray, bins: int = 10) -> list[dict[str, Any]]:
    confidence = probs.max(axis=1)
    correct = (probs.argmax(axis=1) == y).astype(float)
    edges = np.linspace(0.0, 1.0, bins + 1)
    output = []
    for index in range(bins):
        lower, upper = edges[index], edges[index + 1]
        if index == bins - 1:
            mask = (confidence >= lower) & (confidence <= upper)
        else:
            mask = (confidence >= lower) & (confidence < upper)
        if not mask.any():
            continue
        output.append(
            {
                "from": float(lower),
                "to": float(upper),
                "n": int(mask.sum()),
                "predicted": float(confidence[mask].mean()),
                "observed": float(correct[mask].mean()),
            }
        )
    return output


def calibration_bins_binary(y: np.ndarray, probs: np.ndarray, bins: int = 10) -> list[dict[str, Any]]:
    edges = np.linspace(0.0, 1.0, bins + 1)
    output = []
    for index in range(bins):
        lower, upper = edges[index], edges[index + 1]
        if index == bins - 1:
            mask = (probs >= lower) & (probs <= upper)
        else:
            mask = (probs >= lower) & (probs < upper)
        if not mask.any():
            continue
        output.append(
            {
                "from": float(lower),
                "to": float(upper),
                "n": int(mask.sum()),
                "predicted": float(probs[mask].mean()),
                "observed": float(y[mask].mean()),
            }
        )
    return output


def bootstrap_ci(
    y: np.ndarray,
    probs: np.ndarray,
    kind: str,
    samples: int = BOOTSTRAP_SAMPLES,
    seed: int = RANDOM_STATE,
) -> dict[str, list[float]]:
    rng = np.random.default_rng(seed)
    n = len(y)
    accuracy_values: list[float] = []
    log_loss_values: list[float] = []
    brier_values: list[float] = []
    for _ in range(samples):
        indices = rng.integers(0, n, n)
        sampled_y = y[indices]
        sampled_probs = probs[indices]
        if kind == "multi":
            block = _metric_block_1x2(sampled_y, sampled_probs)
        else:
            block = _metric_block_binary(sampled_y, sampled_probs)
        accuracy_values.append(block["accuracy"])
        log_loss_values.append(block["logLoss"])
        brier_values.append(block["brier"])
    return {
        "accuracy": [float(np.percentile(accuracy_values, 2.5)), float(np.percentile(accuracy_values, 97.5))],
        "logLoss": [float(np.percentile(log_loss_values, 2.5)), float(np.percentile(log_loss_values, 97.5))],
        "brier": [float(np.percentile(brier_values, 2.5)), float(np.percentile(brier_values, 97.5))],
    }


# ---------------------------------------------------------------------------
# Fallback a Poisson
# ---------------------------------------------------------------------------


def fallback_mask(frame: pd.DataFrame) -> np.ndarray:
    """Marca filas sin ancla Elo o sin fila de features."""
    mask = frame["elo_diff"].isna().to_numpy()
    return mask


def apply_fallback(probs: np.ndarray, poisson_probs: np.ndarray, mask: np.ndarray) -> np.ndarray:
    output = np.array(probs, copy=True)
    if mask.any():
        output[mask] = poisson_probs[mask]
    return output


# ---------------------------------------------------------------------------
# Benchmark de mercado
# ---------------------------------------------------------------------------


def market_benchmark(conn: sqlite3.Connection, test: pd.DataFrame) -> dict[str, Any]:
    """Benchmark externo de cierre. No se usa como feature."""
    match_ids = set(test["match_id"].astype(str))
    rows = conn.execute(
        """
        SELECT match_id, market, selection, bookmaker, prob_devigged
        FROM odds
        WHERE market IN ('1X2', 'OU25')
        """
    ).fetchall()

    one_x2: dict[str, dict[str, dict[str, float]]] = {}
    over25: dict[str, dict[str, float]] = {}
    for row in rows:
        match_id = str(row["match_id"])
        if match_id not in match_ids:
            continue
        if row["market"] == "1X2":
            one_x2.setdefault(match_id, {}).setdefault(row["bookmaker"], {})[row["selection"]] = float(row["prob_devigged"])
        elif row["market"] == "OU25" and row["selection"] == "Over":
            over25.setdefault(match_id, {})[row["bookmaker"]] = float(row["prob_devigged"])

    meta = test.set_index("match_id")
    output: dict[str, Any] = {
        "available": True,
        "source": "Football-Data.co.uk · cuotas de cierre Bet365 y Pinnacle",
        "closing": True,
        "excluded_as_feature": True,
        "note": (
            "Solo referencia externa. El mercado de cierre no se usa como feature "
            "por la decisión de la Sección 2 y no forma parte del ensamble."
        ),
        "markets": {},
    }

    # 1X2
    y_values: list[int] = []
    probs_values: list[list[float]] = []
    for match_id, row in meta.iterrows():
        books = one_x2.get(str(match_id), {})
        vectors = []
        for book in ("Bet365", "Pinnacle"):
            selection = books.get(book)
            if selection and all(key in selection for key in ("1", "X", "2")):
                vector = np.array([selection["1"], selection["X"], selection["2"]], dtype=float)
                if vector.sum() > 0:
                    vectors.append(vector / vector.sum())
        if not vectors:
            continue
        y_values.append(int(row["y"]))
        probs_values.append(np.mean(vectors, axis=0).tolist())
    if y_values:
        y_array = np.array(y_values)
        p_array = np.array(probs_values)
        block = _metric_block_1x2(y_array, p_array)
        block["coverage"] = len(y_values) / len(test)
        block["bookmakers"] = ["Bet365", "Pinnacle"]
        output["markets"]["1x2"] = block

    # Over 2.5
    y_values = []
    probs_values = []
    for match_id, row in meta.iterrows():
        books = over25.get(str(match_id), {})
        values = [books[book] for book in ("Bet365", "Pinnacle") if book in books]
        if not values:
            continue
        y_values.append(int(row["over25"]))
        probs_values.append(float(np.mean(values)))
    if y_values:
        y_array = np.array(y_values)
        p_array = np.array(probs_values)
        block = _metric_block_binary(y_array, p_array)
        block["coverage"] = len(y_values) / len(test)
        block["bookmakers"] = ["Bet365", "Pinnacle"]
        output["markets"]["over25"] = block

    return output


# ---------------------------------------------------------------------------
# Metadatos de features
# ---------------------------------------------------------------------------


def _feature_label(name: str) -> str:
    if name in DERIVED_LABELS:
        return DERIVED_LABELS[name]
    entry = FEATURE_CATALOG.get(name)
    if entry:
        return entry["label"]
    return name


def _component_features(name: str) -> list[str]:
    if name in DERIVED_FEATURES:
        return list(DERIVED_FEATURES[name])
    return [name]


def build_feature_metadata(
    df: pd.DataFrame,
    feature_entries: dict[str, list[dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Resume quality, source y as_of de cada feature usada por los modelos."""
    used = MODEL_FEATURES
    metadata: dict[str, dict[str, Any]] = {}

    for name in used:
        components = _component_features(name)
        quality_counts: dict[str, int] = {}
        sources: list[str] = []
        as_of_values: list[str] = []
        usable_count = 0
        total = 0
        for component in components:
            entries = feature_entries.get(component, [])
            for entry in entries:
                total += 1
                quality = entry.get("quality") or "missing"
                quality_counts[quality] = quality_counts.get(quality, 0) + 1
                source = entry.get("source")
                if source and source not in sources:
                    sources.append(source)
                as_of = entry.get("as_of")
                if as_of:
                    as_of_values.append(as_of)
                if entry.get("usable_for_model"):
                    usable_count += 1

        missing_pct = float(df[name].isna().mean()) if name in df.columns else 1.0
        if name == "is_esp":
            metadata[name] = {
                "name": name,
                "label": _feature_label(name),
                "quality": "observed",
                "source": "Football-Data.co.uk · identificador de liga",
                "as_of": "prepartido",
                "missing_pct": 0.0,
                "usable_pct": 1.0,
                "quality_counts": {"observed": len(df)},
                "sources": ["Football-Data.co.uk · identificador de liga"],
                "derived_from": [],
            }
            continue

        if name == "elo_diff":
            quality = "estimated"
            source = "Cálculo propio · Elo local − Elo visitante"
            as_of = max(as_of_values) if as_of_values else "prepartido"
            derived_from = ["home_elo_pre", "away_elo_pre"]
        elif name in DERIVED_FEATURES or name.startswith("d_"):
            quality = "estimated"
            source = "Cálculo propio · diferencia local−visitante"
            as_of = max(as_of_values) if as_of_values else "prepartido"
            derived_from = components
        else:
            quality = max(quality_counts, key=quality_counts.get) if quality_counts else "missing"
            source = "; ".join(sources[:3]) if sources else "Feature store"
            as_of = max(as_of_values) if as_of_values else "prepartido"
            derived_from = []

        metadata[name] = {
            "name": name,
            "label": _feature_label(name),
            "quality": quality,
            "source": source,
            "as_of": as_of,
            "missing_pct": missing_pct,
            "usable_pct": float(1.0 - missing_pct),
            "quality_counts": quality_counts,
            "sources": sources,
            "derived_from": derived_from,
        }

    return metadata


# ---------------------------------------------------------------------------
# Evaluación y reporte
# ---------------------------------------------------------------------------


def _season_metrics(test: pd.DataFrame, probs: np.ndarray) -> list[dict[str, Any]]:
    output = []
    for season, group in test.groupby("season", sort=True):
        indices = group.index.to_numpy()
        # `probs` está alineado posicionalmente con test; se reconstruye por posición.
        positions = [test.index.get_loc(index) for index in indices]
        block = _metric_block_1x2(group["y"].to_numpy(), probs[positions])
        output.append(
            {
                "season": season,
                "n": block["n"],
                "hits": block["hits"],
                "accuracy": block["accuracy"],
                "logLoss": block["logLoss"],
                "brier": block["brier"],
                "skill": None,
            }
        )
    return output


def _league_metrics(test: pd.DataFrame, probs: np.ndarray) -> list[dict[str, Any]]:
    names = {"eng.1": "Premier League", "esp.1": "LaLiga"}
    output = []
    for league_id, group in test.groupby("league_id", sort=True):
        positions = [test.index.get_loc(index) for index in group.index]
        block = _metric_block_1x2(group["y"].to_numpy(), probs[positions])
        output.append(
            {
                "id": league_id,
                "name": names.get(league_id, league_id),
                "n": block["n"],
                "hits": block["hits"],
                "accuracy": block["accuracy"],
                "logLoss": block["logLoss"],
                "brier": block["brier"],
                "skill": None,
            }
        )
    return output


def _timeline_metrics(test: pd.DataFrame, probs: np.ndarray) -> list[dict[str, Any]]:
    months = test["date"].str.slice(0, 7)
    output = []
    for month, group in test.groupby(months, sort=True):
        positions = [test.index.get_loc(index) for index in group.index]
        block = _metric_block_1x2(group["y"].to_numpy(), probs[positions])
        output.append(
            {
                "month": month,
                "n": block["n"],
                "hits": block["hits"],
                "accuracy": block["accuracy"],
                "logLoss": block["logLoss"],
                "brier": block["brier"],
                "skill": None,
            }
        )
    return output


def _streaks(test: pd.DataFrame, probs: np.ndarray) -> tuple[int, int, list[dict[str, Any]]]:
    outcomes = ["home", "draw", "away"]
    hits = (probs.argmax(axis=1) == test["y"].to_numpy())
    current = 0
    for value in hits[::-1]:
        if not value:
            break
        current += 1
    best = 0
    running = 0
    for value in hits:
        if value:
            running += 1
            best = max(best, running)
        else:
            running = 0

    recent = []
    for position in range(len(test) - 1, max(-1, len(test) - 16), -1):
        row = test.iloc[position]
        predicted_index = int(probs[position].argmax())
        actual_index = int(row["y"])
        recent.append(
            {
                "matchId": row["match_id"],
                "date": row["date"],
                "leagueId": row["league_id"],
                "homeName": row["home_name"],
                "awayName": row["away_name"],
                "homeGoals": int(row["home_goals"]),
                "awayGoals": int(row["away_goals"]),
                "predicted": outcomes[predicted_index],
                "actual": outcomes[actual_index],
                "hit": bool(predicted_index == actual_index),
                "probs": {
                    "home": float(probs[position, 0]),
                    "draw": float(probs[position, 1]),
                    "away": float(probs[position, 2]),
                },
            }
        )
    return current, best, recent


def _market_block(
    market: dict[str, Any],
    y_train: np.ndarray,
    y_test: np.ndarray,
    ensemble_test: np.ndarray,
    poisson_test: np.ndarray,
    baseline: dict[str, Any],
) -> dict[str, Any]:
    if market["kind"] == "multi":
        ensemble = _metric_block_1x2(y_test, ensemble_test)
        poisson = _metric_block_1x2(y_test, poisson_test)
    else:
        ensemble = _metric_block_binary(y_test, ensemble_test)
        poisson = _metric_block_binary(y_test, poisson_test)

    ensemble = add_skill(ensemble, baseline)
    poisson = add_skill(poisson, baseline)
    ensemble["ci"] = bootstrap_ci(y_test, ensemble_test, market["kind"])
    ensemble["poisson"] = poisson
    ensemble["delta"] = {
        "accuracy": ensemble["accuracy"] - poisson["accuracy"],
        "logLoss": ensemble["logLoss"] - poisson["logLoss"],
        "brier": ensemble["brier"] - poisson["brier"],
    }
    ensemble["label"] = market["label"]
    ensemble["kind"] = market["kind"]
    return ensemble


def build_model_report(
    conn: sqlite3.Connection | None = None,
    write: bool = True,
) -> dict[str, Any]:
    close_conn = False
    if conn is None:
        conn = get_connection()
        close_conn = True

    try:
        df, feature_entries, feature_version = load_dataset(conn)
        baseline_payload = _load_poisson_baseline()
        df = _attach_poisson(df, baseline_payload)
        splits = split_dataset(df)
        train = splits["train"]
        calibration = splits["calibration"]
        weights_frame = splits["weights"]
        test = splits["test"]

        bundles = {
            key: build_feature_bundle(train, calibration, weights_frame, test, features)
            for key, features in FEATURE_SET_NAMES.items()
        }

        poisson_cal = np.column_stack(
            [calibration["poisson_home"], calibration["poisson_draw"], calibration["poisson_away"]]
        )
        poisson_wgt = np.column_stack(
            [weights_frame["poisson_home"], weights_frame["poisson_draw"], weights_frame["poisson_away"]]
        )
        poisson_test = np.column_stack(
            [test["poisson_home"], test["poisson_draw"], test["poisson_away"]]
        )

        market_results: dict[str, Any] = {}
        model_markets: dict[str, dict[str, Any]] = {model_id: {} for model_id in MODEL_IDS}
        ensemble_weights: dict[str, dict[str, float]] = {}
        temperatures: dict[str, dict[str, float]] = {model_id: {} for model_id in MODEL_IDS}
        ensemble_test_probs: dict[str, np.ndarray] = {}
        poisson_test_probs: dict[str, np.ndarray] = {}
        fallback_counts: dict[str, int] = {}
        trained_artifacts: dict[str, dict[str, Any]] = {}

        for market in MARKETS:
            market_id = market["id"]
            kind = market["kind"]
            trained_artifacts[market_id] = {}
            y_train = train[market_id].to_numpy() if kind == "binary" else train["y"].to_numpy()
            y_cal = calibration[market_id].to_numpy() if kind == "binary" else calibration["y"].to_numpy()
            y_wgt = weights_frame[market_id].to_numpy() if kind == "binary" else weights_frame["y"].to_numpy()
            y_test = test[market_id].to_numpy() if kind == "binary" else test["y"].to_numpy()

            # Poisson baseline: calibración por temperatura.
            if kind == "multi":
                temp_poisson, poisson_calibrated = fit_temperature_1x2(poisson_cal, y_cal)
                poisson_wgt_calibrated = apply_temperature_1x2(poisson_wgt, temp_poisson)
                poisson_test_calibrated = apply_temperature_1x2(poisson_test, temp_poisson)
            else:
                poisson_cal_binary = calibration[f"poisson_{market_id}"].to_numpy()
                poisson_wgt_binary = weights_frame[f"poisson_{market_id}"].to_numpy()
                poisson_test_binary = test[f"poisson_{market_id}"].to_numpy()
                temp_poisson, poisson_calibrated = fit_temperature_binary(poisson_cal_binary, y_cal)
                poisson_wgt_calibrated = apply_temperature_binary(poisson_wgt_binary, temp_poisson)
                poisson_test_calibrated = apply_temperature_binary(poisson_test_binary, temp_poisson)

            temperatures["poisson"][market_id] = temp_poisson
            model_markets["poisson"][market_id] = {
                "temperature": temp_poisson,
                "test": _metric_block_1x2(y_test, poisson_test_calibrated)
                if kind == "multi"
                else _metric_block_binary(y_test, poisson_test_calibrated),
            }
            trained_artifacts[market_id]["poisson"] = {
                "temperature": float(temp_poisson),
            }
            poisson_test_probs[market_id] = poisson_test_calibrated

            calibrated_cal: list[np.ndarray] = [poisson_calibrated]
            calibrated_wgt: list[np.ndarray] = [poisson_wgt_calibrated]
            calibrated_test: list[np.ndarray] = [poisson_test_calibrated]

            mask_cal = fallback_mask(calibration)
            mask_wgt = fallback_mask(weights_frame)
            mask_test = fallback_mask(test)
            fallback_counts[market_id] = int(mask_test.sum())

            for spec in MODEL_SPECS[1:]:
                bundle = bundles[spec["feature_set"]]
                model = fit_model(spec, bundle, pd.Series(y_train))
                if kind == "multi":
                    p_cal, p_wgt, p_test = predict_model(model, bundle, market_id)
                    temp, p_cal_calibrated = fit_temperature_1x2(p_cal, y_cal)
                    p_wgt_calibrated = apply_temperature_1x2(p_wgt, temp)
                    p_test_calibrated = apply_temperature_1x2(p_test, temp)
                else:
                    p_cal, p_wgt, p_test = predict_model(model, bundle, market_id)
                    temp, p_cal_calibrated = fit_temperature_binary(p_cal, y_cal)
                    p_wgt_calibrated = apply_temperature_binary(p_wgt, temp)
                    p_test_calibrated = apply_temperature_binary(p_test, temp)

                p_cal_calibrated = apply_fallback(p_cal_calibrated, poisson_calibrated, mask_cal)
                p_wgt_calibrated = apply_fallback(p_wgt_calibrated, poisson_wgt_calibrated, mask_wgt)
                p_test_calibrated = apply_fallback(p_test_calibrated, poisson_test_calibrated, mask_test)

                temperatures[spec["id"]][market_id] = temp
                model_markets[spec["id"]][market_id] = {
                    "temperature": temp,
                    "test": _metric_block_1x2(y_test, p_test_calibrated)
                    if kind == "multi"
                    else _metric_block_binary(y_test, p_test_calibrated),
                }
                if spec.get("family") == "logistic":
                    coef_list = (
                        [[float(w) for w in row] for row in model.coef_]
                        if model.coef_.ndim == 2
                        else [[float(w) for w in model.coef_]]
                    )
                    intercept_list = (
                        [float(b) for b in model.intercept_]
                        if hasattr(model.intercept_, "__iter__")
                        else [float(model.intercept_)]
                    )
                    classes_list = [int(c) for c in model.classes_]
                    trained_artifacts[market_id][spec["id"]] = {
                        "features": list(bundle.features),
                        "matrix_features": list(bundle.matrix_features),
                        "imputed_features": list(bundle.imputed_features),
                        "medians": {
                            feat: float(bundle.imputer.statistics_[i])
                            for i, feat in enumerate(bundle.matrix_features)
                        },
                        "scaler_mean": [float(m) for m in bundle.scaler.mean_],
                        "scaler_scale": [float(s) for s in bundle.scaler.scale_],
                        "classes": classes_list,
                        "coef": coef_list,
                        "intercept": intercept_list,
                        "temperature": float(temp),
                    }
                calibrated_cal.append(p_cal_calibrated)
                calibrated_wgt.append(p_wgt_calibrated)
                calibrated_test.append(p_test_calibrated)

            weights, weight_loss = optimize_weights(calibrated_wgt, y_wgt, WEIGHT_FLOOR)
            ensemble_weights[market_id] = {
                model_id: weights[index] for index, model_id in enumerate(MODEL_IDS)
            }
            ensemble_test = (
                np.tensordot(np.stack(calibrated_test, axis=2), weights, axes=([2], [0]))
                if kind == "multi"
                else np.stack(calibrated_test, axis=1) @ weights
            )
            ensemble_test_probs[market_id] = ensemble_test

            baseline = (
                baseline_1x2(y_train, y_test)
                if kind == "multi"
                else baseline_binary(y_train, y_test)
            )
            block = _market_block(
                market,
                y_train,
                y_test,
                ensemble_test,
                poisson_test_calibrated,
                baseline,
            )
            block["weights"] = ensemble_weights[market_id]
            block["weight_loss"] = weight_loss
            block["models"] = {
                model_id: model_markets[model_id][market_id]["test"]
                for model_id in MODEL_IDS
            }
            block["temperatures"] = {
                model_id: temperatures[model_id][market_id]
                for model_id in MODEL_IDS
            }
            block["fallbacks"] = fallback_counts[market_id]
            market_results[market_id] = block

        # Métricas del ensamble 1X2 para el encabezado y la UI.
        ensemble_1x2 = ensemble_test_probs["1x2"]
        headline_block = _metric_block_1x2(test["y"].to_numpy(), ensemble_1x2)
        baseline_1x2_block = baseline_1x2(train["y"].to_numpy(), test["y"].to_numpy())
        headline = add_skill(headline_block, baseline_1x2_block)
        headline["ci"] = bootstrap_ci(test["y"].to_numpy(), ensemble_1x2, "multi")
        current_streak, best_streak, recent = _streaks(test, ensemble_1x2)
        headline["currentStreak"] = current_streak
        headline["bestStreak"] = best_streak
        headline["recent"] = recent
        headline["market"] = "1x2"
        headline["label"] = "1X2"
        headline["poisson"] = market_results["1x2"]["poisson"]
        headline["delta"] = market_results["1x2"]["delta"]

        by_league = _league_metrics(test, ensemble_1x2)
        by_season = _season_metrics(test, ensemble_1x2)
        timeline = _timeline_metrics(test, ensemble_1x2)
        for row in by_league + by_season + timeline:
            row["skill"] = (
                1.0 - row["brier"] / baseline_1x2_block["brier"]
                if baseline_1x2_block["brier"]
                else None
            )

        calibration_blocks = {
            "1x2": calibration_bins_1x2(test["y"].to_numpy(), ensemble_1x2),
            "btts": calibration_bins_binary(test["btts"].to_numpy(), ensemble_test_probs["btts"]),
            "over25": calibration_bins_binary(test["over25"].to_numpy(), ensemble_test_probs["over25"]),
        }

        benchmark = market_benchmark(conn, test)
        feature_metadata = build_feature_metadata(df, feature_entries)

        split_info = {
            "method": "temporal",
            "train": {
                "seasons": list(TRAIN_SEASONS),
                "matches": int(len(train)),
                "from": train["date"].min(),
                "to": train["date"].max(),
            },
            "validation": {
                "seasons": [VALIDATION_SEASON],
                "matches": int(len(splits["validation"])),
                "matches_available": int(len(splits["validation_all"])),
                "from": splits["validation"]["date"].min(),
                "to": splits["validation"]["date"].max(),
                "calibration": {
                    "matches": int(len(calibration)),
                    "from": calibration["date"].min(),
                    "to": calibration["date"].max(),
                },
                "weights": {
                    "matches": int(len(weights_frame)),
                    "from": weights_frame["date"].min(),
                    "to": weights_frame["date"].max(),
                },
            },
            "test": {
                "seasons": list(TEST_SEASONS),
                "matches": int(len(test)),
                "matches_available": int(len(splits["test_all"])),
                "from": test["date"].min(),
                "to": test["date"].max(),
                "coverage": float(len(test) / len(splits["test_all"])) if len(splits["test_all"]) else None,
            },
            "note": (
                "El test se evalúa una sola vez. La validación se parte por fecha: "
                "la primera mitad calibra la temperatura y la segunda aprende los pesos "
                "del ensamble. El mercado de cierre no se usa como feature."
            ),
        }

        sample_info = {
            "feature_version": feature_version,
            "poisson_baseline_version": baseline_payload.get("version"),
            "poisson_engine": baseline_payload.get("engine"),
            "poisson_engine_version": baseline_payload.get("engineVersion"),
            "poisson_rows": len(baseline_payload.get("rows", [])),
            "train": int(len(train)),
            "validation": int(len(splits["validation"])),
            "calibration": int(len(calibration)),
            "weights": int(len(weights_frame)),
            "test": int(len(test)),
            "test_available": int(len(splits["test_all"])),
            "leagues": int(test["league_id"].nunique()),
            "seasons": list(TEST_SEASONS),
        }

        fallback = {
            "policy": (
                "Si el partido no tiene fila en el feature store o falta el ancla Elo "
                "(elo_diff), el ensamble usa Poisson calibrado. Las features auxiliares "
                "ausentes se imputan con la mediana de entrenamiento y se añade un "
                "indicador de ausencia."
            ),
            "anchor": "elo_diff",
            "test_fallbacks": fallback_counts,
            "imputed_features": {
                key: bundle.imputed_features for key, bundle in bundles.items()
            },
            "note": (
                "El fallback evita que una predicción falle por falta de una feature. "
                "No se presenta una estimación como observada: cada feature del reporte "
                "lleva quality, source y as_of."
            ),
        }

        notes = [
            "Split temporal estricto: 2020-21 a 2022-23 para entrenar, 2023-24 para calibrar y pesar, 2024-25 y 2025-26 para test.",
            "Cada modelo se calibra con temperature scaling antes de compararse.",
            "Los pesos del ensamble se aprenden solo en la segunda mitad de la validación, sin piso artificial; los modelos que no aportan reciben peso cero.",
            "El ensamble 1X2 combina la logística Elo + xG + tiros con la logística core; los mercados binarios siguen dominados por Poisson.",
            "El test no participa en el entrenamiento, la calibración ni la elección de pesos.",
            "El benchmark de cuotas de cierre es solo una referencia externa; no es una feature ni forma parte del ensamble.",
            "La muestra se limita a los partidos con baseline Poisson comparable (equipos con al menos 4 partidos previos).",
        ]
        limitations = [
            "Dos ligas y seis temporadas: la muestra es suficiente para un piloto, no para prometer precisión universal.",
            "El modelo no usa alineaciones confirmadas, lesiones, sanciones, árbitro ni clima en vivo.",
            "El mercado de cierre se reporta como referencia, no como señal del modelo.",
            "Una tasa de aciertos histórica no garantiza resultados futuros y no es una recomendación.",
            "Los modelos tabulares pueden degradarse si cambia la distribución de features entre temporadas.",
        ]

        # Model cards.
        cards: list[dict[str, Any]] = []
        for spec in MODEL_SPECS:
            feature_names = FEATURE_SET_NAMES.get(spec["feature_set"], []) if spec["feature_set"] else []
            metrics = {
                market_id: model_markets[spec["id"]][market_id]["test"]
                for market_id in [market["id"] for market in MARKETS]
            }
            cards.append(
                {
                    "id": spec["id"],
                    "name": spec["label"],
                    "family": spec["family"],
                    "version": REPORT_VERSION,
                    "objective": spec["description"],
                    "markets": [market["id"] for market in MARKETS],
                    "training": {
                        "seasons": list(TRAIN_SEASONS),
                        "matches": int(len(train)),
                        "calibration_matches": int(len(calibration)),
                        "weight_matches": int(len(weights_frame)),
                    },
                    "features": [
                        {
                            "name": name,
                            "label": feature_metadata[name]["label"],
                            "quality": feature_metadata[name]["quality"],
                            "source": feature_metadata[name]["source"],
                            "as_of": feature_metadata[name]["as_of"],
                            "missing_pct": feature_metadata[name]["missing_pct"],
                        }
                        for name in feature_names
                    ],
                    "hyperparameters": (
                        {"C": spec["C"]}
                        if spec["family"] == "logistic"
                        else spec.get("params", {})
                        if spec["family"] in {"random_forest", "gradient_boosting"}
                        else {}
                    ),
                    "calibration": {
                        "method": "temperature scaling",
                        "temperatures": temperatures[spec["id"]],
                    },
                    "metrics": {"test": metrics},
                    "weights": {
                        market_id: ensemble_weights[market_id].get(spec["id"])
                        for market_id in [market["id"] for market in MARKETS]
                    },
                    "limitations": limitations if spec["id"] != "poisson" else [
                        "El Poisson es explicable pero simplifica el contexto: no usa alineaciones, árbitro ni clima.",
                        "El baseline se limita a los partidos con historial previo suficiente.",
                    ],
                    "source": spec["source"],
                }
            )

        cards.append(
            {
                "id": "ensemble",
                "name": "Ensamble OX",
                "family": "weighted_ensemble",
                "version": REPORT_VERSION,
                "objective": "Combinar Poisson, Elo, xG, tiros y tiros a puerta con pesos aprendidos en validación; el peso cero descarta lo que no aporta.",
                "markets": [market["id"] for market in MARKETS],
                "members": MODEL_IDS,
                "weights": ensemble_weights,
                "weight_floor": WEIGHT_FLOOR,
                "training": {
                    "seasons": list(TRAIN_SEASONS),
                    "matches": int(len(train)),
                    "calibration_matches": int(len(calibration)),
                    "weight_matches": int(len(weights_frame)),
                },
                "features": [],
                "hyperparameters": {
                    "members": MODEL_IDS,
                    "weight_floor": WEIGHT_FLOOR,
                    "optimizer": "SLSQP · log-loss",
                },
                "calibration": {
                    "method": "temperature scaling por modelo y mercado",
                    "temperatures": temperatures,
                },
                "metrics": {
                    "test": {
                        market["id"]: market_results[market["id"]]
                        for market in MARKETS
                    }
                },
                "fallback": fallback,
                "limitations": limitations,
                "source": "pipeline/models.py",
            }
        )

        report = {
            "version": REPORT_VERSION,
            "generatedAt": _now_iso(),
            "engine": ENGINE_ID,
            "engineVersion": ENGINE_VERSION,
            "modelName": MODEL_NAME,
            "title": "Ensamble OX",
            "description": (
                "Cuatro modelos calibrados y combinados con pesos aprendidos en validación. "
                "El ensamble 1X2 combina la logística Elo + xG + tiros con la logística core; "
                "los mercados binarios se apoyan en Poisson. El Poisson sigue siendo la referencia explicable y el fallback."
            ),
            "split": split_info,
            "sample": sample_info,
            "headline": headline,
            "markets": market_results,
            "models": [
                {
                    "id": spec["id"],
                    "label": spec["label"],
                    "family": spec["family"],
                    "features": FEATURE_SET_NAMES.get(spec["feature_set"], []) if spec["feature_set"] else [],
                    "metrics": {
                        market_id: model_markets[spec["id"]][market_id]["test"]
                        for market_id in [market["id"] for market in MARKETS]
                    },
                    "temperatures": temperatures[spec["id"]],
                    "weights": {
                        market_id: ensemble_weights[market_id].get(spec["id"])
                        for market_id in [market["id"] for market in MARKETS]
                    },
                }
                for spec in MODEL_SPECS
            ],
            "ensemble": {
                "members": MODEL_IDS,
                "weightFloor": WEIGHT_FLOOR,
                "weights": ensemble_weights,
                "calibration": "temperature scaling por modelo y mercado",
                "fallback": fallback,
            },
            "benchmark": benchmark,
            "byLeague": by_league,
            "bySeason": by_season,
            "timeline": timeline,
            "calibration": calibration_blocks,
            "featureMetadata": feature_metadata,
            "fallback": fallback,
            "notes": notes,
            "limitations": limitations,
            "modelCards": {
                "version": REPORT_VERSION,
                "generatedAt": _now_iso(),
                "cards": cards,
            },
        }

        ensemble_params = {
            "version": REPORT_VERSION,
            "generatedAt": _now_iso(),
            "weights": ensemble_weights,
            "markets": trained_artifacts,
            "feature_sets": FEATURE_SET_NAMES,
        }

        if write:
            _json_dump(REPORT_PATH, report)
            _json_dump(CARDS_PATH, report["modelCards"])
            CARDS_MD_PATH.write_text(_render_cards_markdown(report), encoding="utf-8")
            _write_web_report(report)
            _write_ensemble_params(ensemble_params)

        return report
    finally:
        if close_conn:
            conn.close()


def _write_ensemble_params(params: dict[str, Any]) -> None:
    """Exporta los parámetros entrenados del ensamble (pesos, medianas, scalers, coeficientes)."""
    ENSEMBLE_PARAMS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    _json_dump(ENSEMBLE_PARAMS_JSON_PATH, params)
    ENSEMBLE_PARAMS_JS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(ENSEMBLE_PARAMS_JS_PATH, "w", encoding="utf-8") as handle:
        handle.write("// Generado por pipeline/models.py. No editar a mano.\n")
        handle.write(f"// Versión {params['version']} · {params['generatedAt']}\n")
        handle.write("export const ENSEMBLE_PARAMS = ")
        json.dump(_to_native(params), handle, ensure_ascii=False, indent=2)
        handle.write(";\n")


def _write_web_report(report: dict[str, Any]) -> None:
    """Genera el módulo ES para la UI. No incluye featureMetadata completo."""
    web = {
        "version": report["version"],
        "generatedAt": report["generatedAt"],
        "engine": report["engine"],
        "engineVersion": report["engineVersion"],
        "modelName": report["modelName"],
        "title": report["title"],
        "description": report["description"],
        "split": report["split"],
        "sample": report["sample"],
        "headline": report["headline"],
        "markets": report["markets"],
        "models": report["models"],
        "ensemble": report["ensemble"],
        "benchmark": report["benchmark"],
        "byLeague": report["byLeague"],
        "bySeason": report["bySeason"],
        "timeline": report["timeline"],
        "calibration": report["calibration"],
        "fallback": report["fallback"],
        "notes": report["notes"],
        "limitations": report["limitations"],
    }
    WEB_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(WEB_REPORT_PATH, "w", encoding="utf-8") as handle:
        handle.write("// Generado por pipeline/models.py. No editar a mano.\n")
        handle.write(f"// Versión {report['version']} · {report['generatedAt']}\n")
        handle.write("export const MODEL_REPORT = ")
        json.dump(_to_native(web), handle, ensure_ascii=False, indent=2)
        handle.write(";\n")


def _render_cards_markdown(report: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# Model cards · OX V1.0")
    lines.append("")
    lines.append(f"Versión: **{report['version']}** · Generado: {report['generatedAt']}")
    lines.append("")
    lines.append(
        "Cuatro modelos calibrados y un ensamble con pesos aprendidos en validación. "
        "El test 2024-25 y 2025-26 se evaluó una sola vez. El mercado de cierre "
        "aparece solo como benchmark externo y no se usa como feature."
    )
    lines.append("")
    lines.append("## Muestra")
    lines.append("")
    lines.append("| Split | Temporadas | Partidos |")
    lines.append("|---|---|---:|")
    lines.append(f"| Train | {', '.join(report['split']['train']['seasons'])} | {report['split']['train']['matches']} |")
    lines.append(f"| Validación | {', '.join(report['split']['validation']['seasons'])} | {report['split']['validation']['matches']} |")
    lines.append(f"| Calibración | {', '.join(report['split']['validation']['seasons'])} (primera mitad) | {report['split']['validation']['calibration']['matches']} |")
    lines.append(f"| Pesos | {', '.join(report['split']['validation']['seasons'])} (segunda mitad) | {report['split']['validation']['weights']['matches']} |")
    lines.append(f"| Test | {', '.join(report['split']['test']['seasons'])} | {report['split']['test']['matches']} |")
    lines.append("")
    lines.append("## Comparación en test · 1X2")
    lines.append("")
    lines.append("| Modelo | Aciertos | Precisión | Log-loss | Brier | ECE | Peso |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for model in report["models"]:
        metrics = model["metrics"]["1x2"]
        weight = model["weights"]["1x2"]
        lines.append(
            f"| {model['label']} | {metrics['hits']}/{metrics['n']} | {_pct(metrics['accuracy'])} | "
            f"{_num(metrics['logLoss'])} | {_num(metrics['brier'])} | {_num(metrics['ece'], 3)} | {_pct(weight, 1)} |"
        )
    headline = report["headline"]
    lines.append(
        f"| **Ensamble** | **{headline['hits']}/{headline['n']}** | **{_pct(headline['accuracy'])}** | "
        f"**{_num(headline['logLoss'])}** | **{_num(headline['brier'])}** | **{_num(headline['ece'], 3)}** | **100%** |"
    )
    lines.append("")
    lines.append("## Comparación por mercado")
    lines.append("")
    lines.append("| Mercado | N | Aciertos | Precisión | Log-loss | Brier | Skill Brier | Poisson log-loss |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for market_id, market in report["markets"].items():
        lines.append(
            f"| {market['label']} | {market['n']} | {market['hits']} | {_pct(market['accuracy'])} | "
            f"{_num(market['logLoss'])} | {_num(market['brier'])} | {_pct(market['skill'])} | "
            f"{_num(market['poisson']['logLoss'])} |"
        )
    lines.append("")
    lines.append("## Pesos del ensamble")
    lines.append("")
    header = "| Mercado | " + " | ".join(model["label"] for model in report["models"]) + " |"
    lines.append(header)
    lines.append("|---|" + "---:|" * len(report["models"]))
    for market_id, weights in report["ensemble"]["weights"].items():
        label = next(market["label"] for market in MARKETS if market["id"] == market_id)
        lines.append("| " + label + " | " + " | ".join(_pct(weights[model["id"]], 1) for model in report["models"]) + " |")
    lines.append("")
    lines.append("## Benchmark externo de mercado")
    lines.append("")
    benchmark = report["benchmark"]
    if benchmark.get("markets", {}).get("1x2"):
        item = benchmark["markets"]["1x2"]
        lines.append(
            f"- 1X2 cierre (Bet365 + Pinnacle): {_pct(item['accuracy'])} · "
            f"log-loss {_num(item['logLoss'])} · Brier {_num(item['brier'])} · n={item['n']}."
        )
    if benchmark.get("markets", {}).get("over25"):
        item = benchmark["markets"]["over25"]
        lines.append(
            f"- Over 2.5 cierre: {_pct(item['accuracy'])} · "
            f"log-loss {_num(item['logLoss'])} · Brier {_num(item['brier'])} · n={item['n']}."
        )
    lines.append("")
    lines.append(f"> {benchmark.get('note', '')}")
    lines.append("")
    lines.append("## Cards")
    lines.append("")
    for card in report["modelCards"]["cards"]:
        lines.append(f"### {card['name']}")
        lines.append("")
        lines.append(f"- **ID:** `{card['id']}`")
        lines.append(f"- **Familia:** {card['family']}")
        lines.append(f"- **Objetivo:** {card['objective']}")
        lines.append(f"- **Fuente:** {card['source']}")
        if card.get("features"):
            lines.append("- **Features:** " + ", ".join(f"`{item['name']}`" for item in card["features"]))
        if card.get("hyperparameters"):
            lines.append(f"- **Hiperparámetros:** `{json.dumps(card['hyperparameters'], ensure_ascii=False)}`")
        if card.get("calibration", {}).get("temperatures"):
            temps = card["calibration"]["temperatures"]
            if all(isinstance(value, (int, float)) for value in temps.values()):
                lines.append(
                    "- **Temperaturas:** "
                    + ", ".join(f"{market} {value:.3f}" for market, value in temps.items())
                )
            else:
                lines.append(
                    "- **Temperaturas:** una por modelo y mercado; el detalle está en cada model card."
                )
        if card.get("members"):
            lines.append(f"- **Miembros:** {', '.join(card['members'])}")
            lines.append(f"- **Piso de peso:** {card['weight_floor']}")
        lines.append("- **Limitaciones:**")
        for limitation in card["limitations"]:
            lines.append(f"  - {limitation}")
        lines.append("")
    lines.append("## Fallback")
    lines.append("")
    lines.append(report["fallback"]["policy"])
    lines.append("")
    lines.append("## Limitaciones generales")
    lines.append("")
    for limitation in report["limitations"]:
        lines.append(f"- {limitation}")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    report = build_model_report()
    headline = report["headline"]
    print(
        f"Model report {report['version']}: {headline['hits']}/{headline['n']} "
        f"({_pct(headline['accuracy'])}) · log-loss {_num(headline['logLoss'])} · "
        f"Brier {_num(headline['brier'])}"
    )
    print(f"Reporte: {REPORT_PATH}")
    print(f"Cards: {CARDS_PATH}")
    print(f"Markdown: {CARDS_MD_PATH}")
    print(f"UI: {WEB_REPORT_PATH}")


if __name__ == "__main__":
    main()
