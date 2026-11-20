"""
Tests de la Sección 3: split temporal, calibración, pesos del ensamble,
métricas, features, fallback y model cards.

Los tests validan los artefactos generados por `python -m pipeline.models`.
No vuelven a entrenar para mantener la suite rápida; la reproducibilidad se
comprueba comparando el JSON con el módulo que consume la UI.

Uso:
    python -m unittest pipeline.test_models -v
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import unittest

from .db import BASE_DIR, DATA_DIR
from .models import (
    CORE_FEATURES,
    LEAN_FEATURES,
    MARKETS,
    MODEL_FEATURES,
    MODEL_IDS,
    REPORT_VERSION,
    TEST_SEASONS,
    TRAIN_SEASONS,
    VALIDATION_SEASON,
    WEIGHT_FLOOR,
    XG_ELO_FEATURES,
)

MODELS_DIR = DATA_DIR / "models"
REPORT_PATH = MODELS_DIR / "model_report.json"
CARDS_PATH = MODELS_DIR / "model_cards.json"
CARDS_MD_PATH = MODELS_DIR / "MODEL_CARDS.md"
WEB_REPORT_PATH = BASE_DIR / "js" / "data" / "model_report.js"
POISSON_PATH = MODELS_DIR / "poisson_baseline.json"

MARKET_IDS = [market["id"] for market in MARKETS]
REQUIRED_FEATURE_KEYS = {"name", "label", "quality", "source", "as_of", "missing_pct"}
REQUIRED_CARD_KEYS = {
    "id",
    "name",
    "family",
    "version",
    "objective",
    "markets",
    "training",
    "features",
    "hyperparameters",
    "calibration",
    "metrics",
    "weights",
    "limitations",
    "source",
}


def _load_json(path: Path) -> dict:
    if not path.exists():
        raise unittest.SkipTest(f"No existe el artefacto: {path}. Ejecuta python -m pipeline.models.")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _load_web_report(path: Path) -> dict:
    if not path.exists():
        raise unittest.SkipTest(f"No existe el módulo web: {path}.")
    text = path.read_text(encoding="utf-8")
    text = "\n".join(line for line in text.splitlines() if not line.strip().startswith("//"))
    marker = "export const MODEL_REPORT ="
    if marker not in text:
        raise AssertionError("El módulo web no exporta MODEL_REPORT.")
    payload = text.split(marker, 1)[1].strip()
    payload = payload.rstrip().rstrip(";").strip()
    return json.loads(payload)


class ModelReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.report = _load_json(REPORT_PATH)
        cls.cards = _load_json(CARDS_PATH)
        cls.web = _load_web_report(WEB_REPORT_PATH)
        cls.baseline = _load_json(POISSON_PATH)

    # ------------------------------------------------------------------
    # Split temporal
    # ------------------------------------------------------------------

    def test_split_is_temporal_and_disjoint(self) -> None:
        split = self.report["split"]
        self.assertEqual(split["method"], "temporal")
        self.assertEqual(tuple(split["train"]["seasons"]), TRAIN_SEASONS)
        self.assertEqual(tuple(split["validation"]["seasons"]), (VALIDATION_SEASON,))
        self.assertEqual(tuple(split["test"]["seasons"]), TEST_SEASONS)
        self.assertTrue(set(split["train"]["seasons"]).isdisjoint(split["test"]["seasons"]))
        self.assertTrue(set(split["validation"]["seasons"]).isdisjoint(split["test"]["seasons"]))
        self.assertLess(split["train"]["to"], split["validation"]["from"])
        self.assertLess(split["validation"]["to"], split["test"]["from"])
        self.assertEqual(split["train"]["matches"], 2280)
        self.assertEqual(split["validation"]["matches"], 752)
        self.assertEqual(split["test"]["matches"], 1504)
        self.assertEqual(
            split["validation"]["calibration"]["matches"] + split["validation"]["weights"]["matches"],
            split["validation"]["matches"],
        )
        self.assertLess(
            split["validation"]["calibration"]["to"],
            split["validation"]["weights"]["from"],
        )
        self.assertAlmostEqual(split["test"]["coverage"], 1504 / 1520, places=9)

    def test_poisson_baseline_is_comparable(self) -> None:
        rows = self.baseline["rows"]
        self.assertEqual(len(rows), 2256)
        self.assertEqual(self.baseline["engine"], "motor-nox-v1")
        self.assertEqual(self.report["sample"]["poisson_rows"], len(rows))
        seasons = {row["season"] for row in rows}
        self.assertEqual(seasons, {2023, 2024, 2025})
        for row in rows:
            self.assertAlmostEqual(
                row["probs"]["home"] + row["probs"]["draw"] + row["probs"]["away"],
                1.0,
                places=9,
            )
            for market in ("btts", "over15", "over25", "over35"):
                self.assertGreaterEqual(row[market], 0.0)
                self.assertLessEqual(row[market], 1.0)

    # ------------------------------------------------------------------
    # Pesos y calibración
    # ------------------------------------------------------------------

    def test_weights_sum_to_one_and_honor_floor(self) -> None:
        self.assertEqual(tuple(self.report["ensemble"]["members"]), tuple(MODEL_IDS))
        self.assertEqual(self.report["ensemble"]["weightFloor"], WEIGHT_FLOOR)
        for market_id in MARKET_IDS:
            weights = self.report["ensemble"]["weights"][market_id]
            self.assertEqual(set(weights), set(MODEL_IDS))
            total = sum(weights.values())
            self.assertAlmostEqual(total, 1.0, places=9)
            for model_id, value in weights.items():
                self.assertGreaterEqual(value, WEIGHT_FLOOR - 1e-9, f"{market_id}/{model_id}")
                self.assertLessEqual(value, 1.0)
            for model in self.report["models"]:
                self.assertAlmostEqual(
                    model["weights"][market_id],
                    weights[model["id"]],
                    places=12,
                )

    def test_temperatures_are_bounded(self) -> None:
        for model in self.report["models"]:
            self.assertEqual(set(model["temperatures"]), set(MARKET_IDS))
            for market_id, temperature in model["temperatures"].items():
                self.assertGreaterEqual(temperature, 0.5 - 1e-9, f"{model['id']}/{market_id}")
                self.assertLessEqual(temperature, 3.0 + 1e-9, f"{model['id']}/{market_id}")
        self.assertEqual(self.report["ensemble"]["calibration"], "temperature scaling por modelo y mercado")

    # ------------------------------------------------------------------
    # Métricas
    # ------------------------------------------------------------------

    def test_headline_metrics_are_consistent(self) -> None:
        headline = self.report["headline"]
        self.assertEqual(headline["market"], "1x2")
        self.assertEqual(headline["n"], 1504)
        self.assertEqual(headline["hits"], 802)
        self.assertAlmostEqual(headline["accuracy"], headline["hits"] / headline["n"], places=12)
        self.assertGreater(headline["logLoss"], 0.0)
        self.assertGreater(headline["brier"], 0.0)
        self.assertLess(headline["brier"], headline["baseline"]["brier"])
        self.assertAlmostEqual(
            headline["skill"],
            1.0 - headline["brier"] / headline["baseline"]["brier"],
            places=12,
        )
        self.assertAlmostEqual(
            headline["logLossSkill"],
            1.0 - headline["logLoss"] / headline["baseline"]["logLoss"],
            places=12,
        )
        for key in ("accuracy", "logLoss", "brier"):
            low, high = headline["ci"][key]
            self.assertLessEqual(low, headline[key] + 1e-9)
            self.assertGreaterEqual(high, headline[key] - 1e-9)
        self.assertGreaterEqual(headline["bestStreak"], headline["currentStreak"])
        self.assertGreaterEqual(headline["currentStreak"], 0)
        self.assertEqual(len(headline["recent"]), 15)
        for row in headline["recent"]:
            self.assertIn(row["predicted"], {"home", "draw", "away"})
            self.assertIn(row["actual"], {"home", "draw", "away"})
            self.assertIsInstance(row["hit"], bool)
            self.assertAlmostEqual(sum(row["probs"].values()), 1.0, places=9)

    def test_ensemble_beats_poisson_in_1x2(self) -> None:
        market = self.report["markets"]["1x2"]
        poisson = market["poisson"]
        self.assertGreaterEqual(market["accuracy"], poisson["accuracy"])
        self.assertLess(market["logLoss"], poisson["logLoss"])
        self.assertLess(market["brier"], poisson["brier"])
        self.assertAlmostEqual(
            market["delta"]["accuracy"],
            market["accuracy"] - poisson["accuracy"],
            places=12,
        )
        self.assertAlmostEqual(
            market["delta"]["logLoss"],
            market["logLoss"] - poisson["logLoss"],
            places=12,
        )

    def test_binary_markets_are_not_worse_than_poisson(self) -> None:
        # En BTTS/over 2.5/over 3.5 el peso óptimo es 100% Poisson; en over 1.5
        # la logística core aporta una mejora pequeña. El ensamble nunca debe
        # empeorar el log-loss del Poisson calibrado.
        for market_id in ("btts", "over15", "over25", "over35"):
            market = self.report["markets"][market_id]
            self.assertEqual(market["kind"], "binary")
            self.assertEqual(market["n"], 1504)
            self.assertLessEqual(
                market["logLoss"],
                market["poisson"]["logLoss"] + 1e-9,
                market_id,
            )
            self.assertGreaterEqual(market["accuracy"], 0.0)
            self.assertLessEqual(market["accuracy"], 1.0)
        self.assertLess(
            self.report["markets"]["over15"]["logLoss"],
            self.report["markets"]["over15"]["poisson"]["logLoss"],
        )

    def test_models_are_reported_for_every_market(self) -> None:
        self.assertEqual(len(self.report["models"]), 4)
        for model in self.report["models"]:
            self.assertIn(model["id"], MODEL_IDS)
            self.assertEqual(set(model["metrics"]), set(MARKET_IDS))
            for market_id in MARKET_IDS:
                block = model["metrics"][market_id]
                self.assertEqual(block["n"], 1504)
                self.assertGreaterEqual(block["hits"], 0)
                self.assertLessEqual(block["hits"], block["n"])
                self.assertTrue(math.isfinite(block["logLoss"]))
                self.assertTrue(math.isfinite(block["brier"]))
                self.assertGreaterEqual(block["ece"], 0.0)
                self.assertLessEqual(block["ece"], 1.0)

    def test_calibration_bins_cover_test_set(self) -> None:
        for key in ("1x2", "btts", "over25"):
            bins = self.report["calibration"][key]
            self.assertTrue(bins, key)
            self.assertEqual(sum(item["n"] for item in bins), 1504, key)
            for item in bins:
                self.assertLessEqual(item["from"], item["to"])
                self.assertGreaterEqual(item["predicted"], 0.0)
                self.assertLessEqual(item["predicted"], 1.0)
                self.assertGreaterEqual(item["observed"], 0.0)
                self.assertLessEqual(item["observed"], 1.0)

    def test_league_season_and_timeline_sums(self) -> None:
        for key in ("byLeague", "bySeason", "timeline"):
            rows = self.report[key]
            self.assertTrue(rows, key)
            self.assertEqual(sum(row["n"] for row in rows), 1504, key)
            for row in rows:
                self.assertAlmostEqual(row["accuracy"], row["hits"] / row["n"], places=12)
                self.assertTrue(math.isfinite(row["skill"]))
        self.assertEqual({row["season"] for row in self.report["bySeason"]}, set(TEST_SEASONS))
        self.assertEqual(len(self.report["byLeague"]), 2)

    # ------------------------------------------------------------------
    # Features, calidad y fallback
    # ------------------------------------------------------------------

    def test_feature_metadata_has_provenance(self) -> None:
        metadata = self.report["featureMetadata"]
        expected = set(MODEL_FEATURES)
        self.assertEqual(set(metadata), expected)
        self.assertEqual(len(CORE_FEATURES), 17)
        self.assertEqual(len(XG_ELO_FEATURES), 6)
        self.assertEqual(len(LEAN_FEATURES), 10)
        for name, entry in metadata.items():
            self.assertTrue(REQUIRED_FEATURE_KEYS.issubset(entry), name)
            self.assertIn(entry["quality"], {"observed", "estimated"}, name)
            self.assertTrue(entry["source"], name)
            self.assertTrue(entry["as_of"], name)
            self.assertGreaterEqual(entry["missing_pct"], 0.0, name)
            self.assertLessEqual(entry["missing_pct"], 1.0, name)
            self.assertAlmostEqual(entry["usable_pct"], 1.0 - entry["missing_pct"], places=12)

    def test_derived_features_are_estimated(self) -> None:
        metadata = self.report["featureMetadata"]
        for name in (
            "d_xg_for_10",
            "d_xg_against_10",
            "d_shots_for_10",
            "d_shots_against_10",
            "d_sot_for_10",
            "d_sot_against_10",
            "d_ppda_10",
            "d_ppg",
            "elo_diff",
        ):
            self.assertEqual(metadata[name]["quality"], "estimated", name)
            self.assertTrue(metadata[name]["derived_from"], name)
        self.assertEqual(metadata["is_esp"]["quality"], "observed")

    def test_no_market_or_current_lineup_features(self) -> None:
        forbidden = ("market", "odds", "closing", "referee", "formation")
        used = set(self.report["featureMetadata"])
        for name in used:
            for token in forbidden:
                self.assertNotIn(token, name.lower())
        for model in self.report["models"]:
            for name in model["features"]:
                self.assertIn(name, used)

    def test_feature_sets_match_expected(self) -> None:
        by_id = {model["id"]: model for model in self.report["models"]}
        self.assertEqual(by_id["logit_xg_elo"]["features"], XG_ELO_FEATURES)
        self.assertEqual(by_id["logit_core"]["features"], CORE_FEATURES)
        self.assertEqual(by_id["logit_xg_shots"]["features"], LEAN_FEATURES)
        self.assertEqual(by_id["poisson"]["features"], [])

    def test_fallback_policy_and_counts(self) -> None:
        fallback = self.report["fallback"]
        self.assertEqual(fallback["anchor"], "elo_diff")
        self.assertIn("Poisson", fallback["policy"])
        self.assertIn("mediana", fallback["policy"])
        for market_id in MARKET_IDS:
            self.assertEqual(fallback["test_fallbacks"][market_id], 0)
        self.assertEqual(set(fallback["imputed_features"]), {"xg_elo", "core", "lean"})
        for names in fallback["imputed_features"].values():
            for name in names:
                self.assertIn(name, self.report["featureMetadata"])

    # ------------------------------------------------------------------
    # Model cards y benchmark
    # ------------------------------------------------------------------

    def test_model_cards_are_complete(self) -> None:
        cards = self.cards["cards"]
        self.assertEqual(len(cards), 5)
        ids = {card["id"] for card in cards}
        self.assertEqual(ids, set(MODEL_IDS) | {"ensemble"})
        for card in cards:
            self.assertTrue(REQUIRED_CARD_KEYS.issubset(card), card["id"])
            self.assertEqual(card["version"], REPORT_VERSION)
            self.assertEqual(set(card["markets"]), set(MARKET_IDS))
            self.assertNotIn("neural", card["family"].lower())
            self.assertTrue(card["limitations"])
            self.assertTrue(card["source"])
        ensemble = next(card for card in cards if card["id"] == "ensemble")
        self.assertEqual(tuple(ensemble["members"]), tuple(MODEL_IDS))
        self.assertEqual(ensemble["weight_floor"], WEIGHT_FLOOR)
        self.assertIn("fallback", ensemble)
        for card in cards:
            if card["id"] == "ensemble":
                continue
            for feature in card["features"]:
                self.assertTrue({"name", "label", "quality", "source", "as_of"}.issubset(feature))
        markdown = CARDS_MD_PATH.read_text(encoding="utf-8")
        for card in cards:
            self.assertIn(card["name"], markdown)

    def test_benchmark_is_external_reference(self) -> None:
        benchmark = self.report["benchmark"]
        self.assertTrue(benchmark["available"])
        self.assertTrue(benchmark["closing"])
        self.assertTrue(benchmark["excluded_as_feature"])
        self.assertIn("referencia", benchmark["note"].lower())
        one_x2 = benchmark["markets"]["1x2"]
        self.assertEqual(one_x2["n"], 1504)
        self.assertGreater(one_x2["accuracy"], 0.5)
        self.assertEqual(set(one_x2["bookmakers"]), {"Bet365", "Pinnacle"})
        self.assertIn("over25", benchmark["markets"])

    def test_web_module_matches_report(self) -> None:
        self.assertEqual(self.web["version"], self.report["version"])
        self.assertEqual(self.web["generatedAt"], self.report["generatedAt"])
        self.assertEqual(self.web["headline"]["hits"], self.report["headline"]["hits"])
        self.assertEqual(self.web["headline"]["n"], self.report["headline"]["n"])
        self.assertAlmostEqual(
            self.web["headline"]["accuracy"],
            self.report["headline"]["accuracy"],
            places=12,
        )
        for market_id in MARKET_IDS:
            self.assertEqual(
                set(self.web["ensemble"]["weights"][market_id]),
                set(MODEL_IDS),
            )

    def test_language_avoids_betting_claims(self) -> None:
        text = json.dumps(self.web, ensure_ascii=False).lower()
        for token in ("apuesta", "rentabilidad", "bankroll", "ganancia segura"):
            self.assertNotIn(token, text)


if __name__ == "__main__":
    unittest.main()
