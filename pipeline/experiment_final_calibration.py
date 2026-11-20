"""
Experimento Fase 1: calibración final del ensamble 1X2.

Protocolo:
- Reproduce el split temporal y los modelos de pipeline/models.py.
- Genera predicciones del ensamble en la mitad de pesos de validación con
  validación cruzada por bloques de fecha (los pesos de cada fold se aprenden
  sin el fold evaluado).
- Evalúa calibrar el ensamble final con temperature scaling, escalado por clase
  y vector scaling mediante validación cruzada anidada. La decisión se toma
  solo con validación; el test se evalúa una vez al final como confirmación.

Es un diagnóstico: no escribe reportes ni cambia pesos publicados.

Uso:
    python -m pipeline.experiment_final_calibration
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.metrics import log_loss

from . import models as M


def apply_vector_scaling(probs: np.ndarray, params: np.ndarray) -> np.ndarray:
    logp = np.log(np.clip(probs, 1e-12, 1.0))
    scaled = logp * params[:3] + params[3:]
    scaled -= scaled.max(axis=1, keepdims=True)
    exp = np.exp(scaled)
    return exp / exp.sum(axis=1, keepdims=True)


def fit_vector_scaling(probs: np.ndarray, y: np.ndarray, l2: float = 1e-3) -> np.ndarray:
    logp = np.log(np.clip(probs, 1e-12, 1.0))

    def objective(params: np.ndarray) -> float:
        scaled = logp * params[:3] + params[3:]
        scaled -= scaled.max(axis=1, keepdims=True)
        exp = np.exp(scaled)
        p = exp / exp.sum(axis=1, keepdims=True)
        loss = float(log_loss(y, np.clip(p, 1e-15, 1 - 1e-15), labels=[0, 1, 2]))
        reg = l2 * (float(np.sum((params[:3] - 1.0) ** 2)) + float(np.sum(params[3:] ** 2)))
        return loss + reg

    x0 = np.array([1.0, 1.0, 1.0, 0.0, 0.0, 0.0])
    result = minimize(
        objective,
        x0,
        method="L-BFGS-B",
        bounds=[(0.2, 3.0)] * 3 + [(-1.0, 1.0)] * 3,
        options={"maxiter": 2000},
    )
    return np.asarray(result.x, dtype=float)


def fit_class_scaling(probs: np.ndarray, y: np.ndarray) -> np.ndarray:
    logp = np.log(np.clip(probs, 1e-12, 1.0))

    def objective(scales: np.ndarray) -> float:
        scaled = logp * scales
        scaled -= scaled.max(axis=1, keepdims=True)
        exp = np.exp(scaled)
        p = exp / exp.sum(axis=1, keepdims=True)
        return float(log_loss(y, np.clip(p, 1e-15, 1 - 1e-15), labels=[0, 1, 2]))

    result = minimize(
        objective,
        np.ones(3),
        method="L-BFGS-B",
        bounds=[(0.2, 3.0)] * 3,
        options={"maxiter": 2000},
    )
    return np.asarray(result.x, dtype=float)


def apply_class_scaling(probs: np.ndarray, scales: np.ndarray) -> np.ndarray:
    logp = np.log(np.clip(probs, 1e-12, 1.0))
    scaled = logp * scales
    scaled -= scaled.max(axis=1, keepdims=True)
    exp = np.exp(scaled)
    return exp / exp.sum(axis=1, keepdims=True)


def apply_temperature(probs: np.ndarray, temperature: float) -> np.ndarray:
    return M.apply_temperature_1x2(probs, temperature)


def confidence_table(y: np.ndarray, probs: np.ndarray) -> list[dict]:
    confidence = probs.max(axis=1)
    correct = probs.argmax(axis=1) == y
    rows = []
    for threshold in (0.5, 0.6, 0.7, 0.8):
        mask = confidence >= threshold
        rows.append(
            {
                "threshold": threshold,
                "n": int(mask.sum()),
                "coverage": float(mask.mean()) if len(mask) else 0.0,
                "accuracy": float(correct[mask].mean()) if mask.any() else None,
            }
        )
    return rows


def metric(y: np.ndarray, probs: np.ndarray) -> dict:
    return M._metric_block_1x2(y, probs)


def delta(before: dict, after: dict) -> dict:
    return {
        "logLoss": after["logLoss"] - before["logLoss"],
        "brier": after["brier"] - before["brier"],
        "ece": after["ece"] - before["ece"],
        "accuracy": after["accuracy"] - before["accuracy"],
        "hits": after["hits"] - before["hits"],
    }


def main() -> None:
    conn = M.get_connection()
    try:
        df, _feature_entries, _feature_version = M.load_dataset(conn)
        baseline_payload = M._load_poisson_baseline()
        df = M._attach_poisson(df, baseline_payload)
        splits = M.split_dataset(df)
        train = splits["train"]
        calibration = splits["calibration"]
        weights_frame = splits["weights"]
        test = splits["test"]

        bundles = {
            key: M.build_feature_bundle(train, calibration, weights_frame, test, features)
            for key, features in M.FEATURE_SET_NAMES.items()
        }

        y_train = train["y"].to_numpy()
        y_cal = calibration["y"].to_numpy()
        y_wgt = weights_frame["y"].to_numpy()
        y_test = test["y"].to_numpy()

        poisson_cal = np.column_stack(
            [calibration["poisson_home"], calibration["poisson_draw"], calibration["poisson_away"]]
        )
        poisson_wgt = np.column_stack(
            [weights_frame["poisson_home"], weights_frame["poisson_draw"], weights_frame["poisson_away"]]
        )
        poisson_test = np.column_stack(
            [test["poisson_home"], test["poisson_draw"], test["poisson_away"]]
        )

        temp_poisson, poisson_cal_cal = M.fit_temperature_1x2(poisson_cal, y_cal)
        poisson_wgt_cal = M.apply_temperature_1x2(poisson_wgt, temp_poisson)
        poisson_test_cal = M.apply_temperature_1x2(poisson_test, temp_poisson)

        calibrated_wgt = [poisson_wgt_cal]
        calibrated_test = [poisson_test_cal]
        masks = {
            "cal": M.fallback_mask(calibration),
            "wgt": M.fallback_mask(weights_frame),
            "test": M.fallback_mask(test),
        }

        for spec in M.MODEL_SPECS[1:]:
            bundle = bundles[spec["feature_set"]]
            model = M.fit_model(spec, bundle, pd.Series(y_train))
            p_cal, p_wgt, p_test = M.predict_model(model, bundle, "1x2")
            temp, p_cal_cal = M.fit_temperature_1x2(p_cal, y_cal)
            p_wgt_cal = M.apply_temperature_1x2(p_wgt, temp)
            p_test_cal = M.apply_temperature_1x2(p_test, temp)
            calibrated_wgt.append(M.apply_fallback(p_wgt_cal, poisson_wgt_cal, masks["wgt"]))
            calibrated_test.append(M.apply_fallback(p_test_cal, poisson_test_cal, masks["test"]))

        weights_full, weight_loss = M.optimize_weights(calibrated_wgt, y_wgt, M.WEIGHT_FLOOR)
        ensemble_wgt = np.tensordot(np.stack(calibrated_wgt, axis=2), weights_full, axes=([2], [0]))
        ensemble_test = np.tensordot(np.stack(calibrated_test, axis=2), weights_full, axes=([2], [0]))

        # OOF dentro de la mitad de pesos: 5 bloques contiguos por fecha.
        n = len(y_wgt)
        folds = [np.array(index) for index in np.array_split(np.arange(n), 5)]
        oof = np.zeros_like(ensemble_wgt)
        fold_weights = []
        for index in folds:
            train_index = np.setdiff1d(np.arange(n), index)
            fold_w, _ = M.optimize_weights(
                [probs[train_index] for probs in calibrated_wgt], y_wgt[train_index], M.WEIGHT_FLOOR
            )
            fold_weights.append([float(value) for value in fold_w])
            oof[index] = np.tensordot(
                np.stack([probs[index] for probs in calibrated_wgt], axis=2),
                fold_w,
                axes=([2], [0]),
            )

        baseline_val = metric(y_wgt, oof)
        baseline_test = metric(y_test, ensemble_test)

        # Evaluación anidada de calibradores sobre OOF de validación.
        def nested(fit_fn, apply_fn) -> tuple[np.ndarray, list]:
            predictions = np.zeros_like(oof)
            params = []
            for index in folds:
                train_index = np.setdiff1d(np.arange(n), index)
                param = fit_fn(oof[train_index], y_wgt[train_index])
                params.append(np.asarray(param, dtype=float).tolist())
                predictions[index] = apply_fn(oof[index], param)
            return predictions, params

        temp_val, temp_params = nested(
            lambda p, target: M.fit_temperature_1x2(p, target)[0],
            apply_temperature,
        )
        class_val, class_params = nested(fit_class_scaling, apply_class_scaling)
        vector_val, vector_params = nested(fit_vector_scaling, apply_vector_scaling)

        candidates = {
            "temperature": (temp_val, temp_params, lambda p, target: M.fit_temperature_1x2(p, target)[0], apply_temperature),
            "class_scaling": (class_val, class_params, fit_class_scaling, apply_class_scaling),
            "vector_scaling": (vector_val, vector_params, fit_vector_scaling, apply_vector_scaling),
        }

        report = {
            "splits": {
                "train": int(len(train)),
                "calibration": int(len(calibration)),
                "weights": int(len(weights_frame)),
                "test": int(len(test)),
            },
            "weights_full": {model_id: float(w) for model_id, w in zip(M.MODEL_IDS, weights_full)},
            "weight_loss": float(weight_loss),
            "fold_weights": fold_weights,
            "validation": {
                "baseline": baseline_val,
                "baseline_confidence": confidence_table(y_wgt, oof),
                "candidates": {},
            },
            "test": {
                "baseline": baseline_test,
                "baseline_confidence": confidence_table(y_test, ensemble_test),
                "candidates": {},
            },
        }

        for name, (val_probs, params, fit_fn, apply_fn) in candidates.items():
            val_metrics = metric(y_wgt, val_probs)
            report["validation"]["candidates"][name] = {
                "metrics": val_metrics,
                "delta": delta(baseline_val, val_metrics),
                "confidence": confidence_table(y_wgt, val_probs),
                "fold_params": params,
            }

        # Elegir por validación: menor log-loss, con Brier/ECE mejores y
        # precisión no peor por más de 0.5 puntos.
        eligible = []
        for name, payload in report["validation"]["candidates"].items():
            d = payload["delta"]
            if d["logLoss"] < 0 and d["brier"] < 0 and d["ece"] < 0 and d["accuracy"] >= -0.005:
                eligible.append((payload["metrics"]["logLoss"], name))
        eligible.sort()
        chosen = eligible[0][1] if eligible else None
        report["chosen_by_validation"] = chosen

        if chosen:
            _val_probs, _params, fit_fn, apply_fn = candidates[chosen]
            final_params = fit_fn(oof, y_wgt)
            calibrated_test = apply_fn(ensemble_test, final_params)
            test_metrics = metric(y_test, calibrated_test)
            report["test"]["candidates"][chosen] = {
                "metrics": test_metrics,
                "delta": delta(baseline_test, test_metrics),
                "confidence": confidence_table(y_test, calibrated_test),
                "final_params": np.asarray(final_params, dtype=float).tolist(),
            }

        print(json.dumps(report, indent=2, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
