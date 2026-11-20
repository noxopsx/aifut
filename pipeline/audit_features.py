"""
Auditoría de leakage y comparación de distribuciones del feature store.

Uso:
    python -m pipeline.audit_features
    python -m pipeline.audit_features --version features-2.2.0

La auditoría es deliberadamente estricta:
- Toda feature con value no nulo y usable_for_model=true debe tener as_of.
- as_of debe ser estrictamente anterior al kickoff.
- Un value null debe ser quality=missing y usable_for_model=false.
- Mercado y clima no pueden ser usables (no hay timestamp/pronóstico previo).
- El XI del partido actual no puede aparecer como confirmado.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sqlite3
from statistics import mean

from .db import DATA_DIR, get_connection
from .feature_catalog import CORE_FEATURE_GROUPS, FEATURE_CATALOG, catalog_entry

DEFAULT_VERSION = "features-2.2.0"
FEATURE_STORE_DIR = DATA_DIR / "features"
AUDIT_PATH = FEATURE_STORE_DIR / "leakage_audit.json"
DISTRIBUTION_PATH = FEATURE_STORE_DIR / "distribution_report.json"

MANDATORY_KEYS = {"value", "quality", "source", "as_of", "usable_for_model"}


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _distribution(values: list[float]) -> dict:
    clean = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    if not clean:
        return {"n": 0, "mean": None, "std": None, "min": None, "p25": None, "median": None, "p75": None, "max": None}
    average = mean(clean)
    variance = mean((value - average) ** 2 for value in clean) if len(clean) > 1 else 0.0
    return {
        "n": len(clean),
        "mean": round(average, 4),
        "std": round(math.sqrt(variance), 4),
        "min": round(min(clean), 4),
        "p25": round(_quantile(clean, 0.25), 4),
        "median": round(_quantile(clean, 0.5), 4),
        "p75": round(_quantile(clean, 0.75), 4),
        "max": round(max(clean), 4),
    }


def _pearson(first: list[float], second: list[float]) -> float | None:
    pairs = [
        (float(a), float(b)) for a, b in zip(first, second)
        if a is not None and b is not None and math.isfinite(float(a)) and math.isfinite(float(b))
    ]
    if len(pairs) < 2:
        return None
    mean_a = mean(a for a, _ in pairs)
    mean_b = mean(b for _, b in pairs)
    numerator = sum((a - mean_a) * (b - mean_b) for a, b in pairs)
    denominator = math.sqrt(
        sum((a - mean_a) ** 2 for a, _ in pairs) * sum((b - mean_b) ** 2 for _, b in pairs)
    )
    return round(numerator / denominator, 4) if denominator else None


def audit_dataset(conn: sqlite3.Connection, version: str = DEFAULT_VERSION) -> dict:
    dataset = conn.execute("SELECT * FROM feature_datasets WHERE version = ?", (version,)).fetchone()
    if not dataset:
        return {
            "version": version,
            "status": "FAIL",
            "failures": [f"No existe la versión {version} en feature_datasets."],
            "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    total_matches = conn.execute("SELECT count(*) FROM matches").fetchone()[0]
    rows = conn.execute(
        "SELECT * FROM match_features WHERE dataset_version = ? ORDER BY kickoff_utc, match_id",
        (version,),
    ).fetchall()
    failures: list[str] = []
    if len(rows) != total_matches:
        failures.append(f"Filas del store {len(rows)} != partidos {total_matches}.")
    duplicate_count = conn.execute(
        """
        SELECT count(*) FROM (
            SELECT match_id, dataset_version, count(*) AS n
            FROM match_features GROUP BY match_id, dataset_version HAVING n > 1
        )
        """
    ).fetchone()[0]
    if duplicate_count:
        failures.append(f"Hay {duplicate_count} pares (match_id, versión) duplicados.")

    feature_stats: dict[str, dict] = {}
    total_entries = 0
    non_null = 0
    usable = 0
    excluded = 0
    nulls = 0
    quality_counts = {"observed": 0, "estimated": 0, "placeholder": 0, "missing": 0}
    excluded_reasons: dict[str, int] = {}

    for row in rows:
        kickoff = _parse(row["kickoff_utc"])
        if kickoff is None:
            failures.append(f"{row['match_id']}: kickoff inválido.")
            continue
        try:
            features = json.loads(row["features_json"])
        except json.JSONDecodeError:
            failures.append(f"{row['match_id']}: features_json no es JSON válido.")
            continue
        if len(features) != len(FEATURE_CATALOG):
            failures.append(
                f"{row['match_id']}: {len(features)} features, se esperaban {len(FEATURE_CATALOG)}."
            )
        for name, entry in features.items():
            total_entries += 1
            stats = feature_stats.setdefault(name, {
                "entries": 0, "non_null": 0, "usable": 0, "excluded": 0,
                "nulls": 0, "leakage_failures": 0,
            })
            stats["entries"] += 1
            missing_keys = MANDATORY_KEYS - set(entry)
            if missing_keys:
                failures.append(f"{row['match_id']} · {name}: faltan claves {sorted(missing_keys)}.")
                stats["leakage_failures"] += 1
                continue
            value = entry["value"]
            quality = entry["quality"]
            as_of = entry["as_of"]
            is_usable = bool(entry["usable_for_model"])
            quality_counts[quality] = quality_counts.get(quality, 0) + 1
            if value is None:
                nulls += 1
                stats["nulls"] += 1
                if quality != "missing":
                    failures.append(f"{row['match_id']} · {name}: null con quality={quality}.")
                    stats["leakage_failures"] += 1
                if is_usable:
                    failures.append(f"{row['match_id']} · {name}: null marcado como usable.")
                    stats["leakage_failures"] += 1
                continue
            non_null += 1
            stats["non_null"] += 1
            if quality == "missing":
                failures.append(f"{row['match_id']} · {name}: value no nulo con quality=missing.")
                stats["leakage_failures"] += 1
            if is_usable:
                usable += 1
                stats["usable"] += 1
                if not as_of:
                    failures.append(f"{row['match_id']} · {name}: usable sin as_of.")
                    stats["leakage_failures"] += 1
                    continue
                as_of_dt = _parse(as_of)
                if as_of_dt is None:
                    failures.append(f"{row['match_id']} · {name}: as_of inválido ({as_of}).")
                    stats["leakage_failures"] += 1
                elif as_of_dt >= kickoff:
                    failures.append(
                        f"{row['match_id']} · {name}: as_of {as_of} >= kickoff {row['kickoff_utc']}."
                    )
                    stats["leakage_failures"] += 1
            else:
                excluded += 1
                stats["excluded"] += 1
                reason = f"{quality}:{'usable_false'}"
                excluded_reasons[reason] = excluded_reasons.get(reason, 0) + 1

            # Reglas específicas de fuentes sin timestamp/pronóstico.
            if name.startswith("market_") and is_usable:
                failures.append(f"{row['match_id']} · {name}: mercado no puede ser usable sin timestamp.")
                stats["leakage_failures"] += 1
            if name.startswith("weather_") and is_usable:
                failures.append(f"{row['match_id']} · {name}: clima retrospectivo no puede ser usable.")
                stats["leakage_failures"] += 1
            if name.endswith("_lineup_confirmed") and (value != 0 or is_usable):
                failures.append(f"{row['match_id']} · {name}: el XI actual no puede estar confirmado/usarse.")
                stats["leakage_failures"] += 1

    # Features del catálogo que no aparecieron en ninguna fila.
    missing_catalog = sorted(set(FEATURE_CATALOG) - set(feature_stats))
    if missing_catalog:
        failures.append(f"Features del catálogo ausentes en el store: {missing_catalog}.")

    # Cobertura core.
    coverage = conn.execute(
        "SELECT * FROM feature_coverage WHERE dataset_version = ?", (version,)
    ).fetchall()
    coverage_by_feature = {row["feature"]: dict(row) for row in coverage}
    core_groups = {}
    for group, description in CORE_FEATURE_GROUPS.items():
        # Solo las features declaradas usables cuentan para el objetivo de
        # cobertura. Las ausencias, sanciones, copa/Europa y el nombre de la
        # rivalidad se reportan como opcionales/no usables.
        members = [
            name for name in FEATURE_CATALOG
            if catalog_entry(name)["group"] == group and catalog_entry(name)["model_usable"]
        ]
        if not members:
            continue
        min_coverage = min(
            (coverage_by_feature.get(name, {}).get("coverage_pct", 0.0) for name in members),
            default=0.0,
        )
        min_usable = min(
            (coverage_by_feature.get(name, {}).get("model_usable_pct", 0.0) for name in members),
            default=0.0,
        )
        core_groups[group] = {
            "description": description,
            "features": members,
            "min_coverage_pct": min_coverage,
            "min_model_usable_pct": min_usable,
            "pass": min_coverage >= (40.0 if group == "lineups" else 80.0),
        }
        threshold = 40.0 if group == "lineups" else 80.0
        if min_coverage < threshold:
            failures.append(f"Grupo core {group}: cobertura {min_coverage:.2f}% < {threshold:.0f}%.")

    status = "PASS" if not failures else "FAIL"
    report = {
        "version": version,
        "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": status,
        "dataset": {
            "built_at": dataset["built_at"],
            "match_count": dataset["match_count"],
            "feature_count": dataset["feature_count"],
            "core_feature_count": dataset["core_feature_count"],
            "checksum": dataset["checksum"],
        },
        "summary": {
            "matches": len(rows),
            "total_entries": total_entries,
            "non_null": non_null,
            "nulls": nulls,
            "usable": usable,
            "excluded": excluded,
            "quality_counts": quality_counts,
            "excluded_reasons": excluded_reasons,
            "features_checked": len(feature_stats),
        },
        "core_groups": core_groups,
        "feature_stats": feature_stats,
        "failures": failures[:200],
        "failure_count": len(failures),
        "rules": [
            "value != null + usable_for_model = true ⇒ as_of existe y es < kickoff",
            "value = null ⇒ quality = missing y usable_for_model = false",
            "mercado y clima ⇒ usable_for_model = false",
            "XI del partido actual ⇒ lineup_confirmed = 0 y usable_for_model = false",
            "cobertura mínima por grupo core ⇒ 80%",
        ],
    }
    FEATURE_STORE_DIR.mkdir(parents=True, exist_ok=True)
    AUDIT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def _poisson_pmf(k: int, lam: float) -> float:
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return math.exp(-lam) * (lam ** k) / math.factorial(k)


def _poisson_1x2(home_lambda: float, away_lambda: float, max_goals: int = 8) -> dict:
    home = draw = away = 0.0
    for h in range(max_goals + 1):
        ph = _poisson_pmf(h, home_lambda)
        for a in range(max_goals + 1):
            p = ph * _poisson_pmf(a, away_lambda)
            if h > a:
                home += p
            elif h == a:
                draw += p
            else:
                away += p
    total = home + draw + away
    if total <= 0:
        return {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}
    return {"home": home / total, "draw": draw / total, "away": away / total}


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def distribution_report(conn: sqlite3.Connection, version: str = DEFAULT_VERSION) -> dict:
    rows = conn.execute(
        "SELECT * FROM match_features WHERE dataset_version = ? ORDER BY kickoff_utc, match_id",
        (version,),
    ).fetchall()
    parsed = []
    for row in rows:
        parsed.append({
            "match_id": row["match_id"],
            "kickoff_utc": row["kickoff_utc"],
            "league_id": row["league_id"],
            "season": row["season"],
            "features": json.loads(row["features_json"]),
        })

    selected = [
        "home_xg_for_5", "away_xg_for_5", "xg_diff_5",
        "home_xg_for_10", "away_xg_for_10", "xg_diff_10",
        "home_elo_pre", "away_elo_pre", "elo_diff",
        "home_rest_days", "away_rest_days", "away_travel_km",
        "home_ppg", "away_ppg", "home_squad_depth", "away_squad_depth",
        "market_home_prob", "market_over25_prob", "referee_cards_per_match",
    ]

    def values(name: str, subset: list[dict] | None = None) -> list[float]:
        source = subset if subset is not None else parsed
        result = []
        for row in source:
            entry = row["features"].get(name, {})
            value = entry.get("value")
            if value is not None:
                try:
                    result.append(float(value))
                except (TypeError, ValueError):
                    continue
        return result

    before = [row for row in parsed if row["season"] in {"2020-21", "2021-22", "2022-23"}]
    after = [row for row in parsed if row["season"] in {"2023-24", "2024-25", "2025-26"}]
    distributions = {}
    for name in selected:
        distributions[name] = {
            "overall": _distribution(values(name)),
            "before_2020_2023": _distribution(values(name, before)),
            "after_2023_2026": _distribution(values(name, after)),
        }

    # xG bruto por partido vs media móvil pre-partido. La comparación se hace
    # emparejando por match_id: el xG bruto del partido actual nunca debe
    # entrar en la media móvil previa.
    raw_by_match = {
        row["id"]: float(row["xg"])
        for row in conn.execute(
            """
            SELECT m.id, s.xg
            FROM matches m
            JOIN team_match_stats s ON s.match_id = m.id AND s.team_id = m.home_team_id
            WHERE s.xg IS NOT NULL
            """
        )
    }
    raw_home_xg = []
    rolling_home_xg = []
    paired_deltas = []
    for row in parsed:
        entry = row["features"].get("home_xg_for_5", {})
        raw = raw_by_match.get(row["match_id"])
        if entry.get("value") is not None and raw is not None:
            rolling = float(entry["value"])
            raw_home_xg.append(raw)
            rolling_home_xg.append(rolling)
            paired_deltas.append(rolling - raw)
    raw_vs_rolling = {
        "paired_matches": len(paired_deltas),
        "raw_home_xg": _distribution(raw_home_xg),
        "rolling_home_xg_5": _distribution(rolling_home_xg),
        "mean_delta_rolling_minus_raw": (
            round(mean(paired_deltas), 4) if paired_deltas else None
        ),
        "correlation_raw_vs_rolling": _pearson(raw_home_xg, rolling_home_xg),
        "note": "El xG bruto es el valor del partido; el rolling es la media de los 5 partidos anteriores, emparejada por match_id. No deben coincidir.",
    }

    # Comparación de lambdas y probabilidades: Poisson base vs capa de contexto.
    base_lambdas_home = []
    base_lambdas_away = []
    ctx_lambdas_home = []
    ctx_lambdas_away = []
    base_home_probs = []
    base_draw_probs = []
    base_away_probs = []
    ctx_home_probs = []
    ctx_draw_probs = []
    ctx_away_probs = []
    applied = 0
    skipped = 0
    changed = 0
    meaningful_changed = 0
    abs_changes = []
    abs_prob_changes_home = []
    abs_prob_changes_draw = []
    abs_prob_changes_away = []

    for row in parsed:
        features = row["features"]
        def value(name):
            entry = features.get(name, {})
            return entry.get("value") if entry.get("usable_for_model") else None

        league_avg = value("league_goals_avg_prior")
        league_xg = value("league_xg_avg_prior")
        home_xg_for = value("home_xg_for_10")
        home_xg_against = value("home_xg_against_10")
        away_xg_for = value("away_xg_for_10")
        away_xg_against = value("away_xg_against_10")
        elo_diff = value("elo_diff")
        if None in (league_avg, league_xg, home_xg_for, home_xg_against, away_xg_for, away_xg_against, elo_diff):
            skipped += 1
            continue
        applied += 1
        home_base = float(league_avg) * 1.10
        away_base = float(league_avg) * 0.92
        home_xg_mult = 1 + 0.15 * (
            ((float(home_xg_for) / float(league_xg)) * (float(away_xg_against) / float(league_xg))) - 1
        )
        away_xg_mult = 1 + 0.15 * (
            ((float(away_xg_for) / float(league_xg)) * (float(home_xg_against) / float(league_xg))) - 1
        )
        elo_mult_home = 1 + _clamp(float(elo_diff) / 400 * 0.08, -0.06, 0.06)
        elo_mult_away = 1 - _clamp(float(elo_diff) / 400 * 0.08, -0.06, 0.06)
        home_ctx = home_base * home_xg_mult * elo_mult_home
        away_ctx = away_base * away_xg_mult * elo_mult_away
        base_lambdas_home.append(home_base)
        base_lambdas_away.append(away_base)
        ctx_lambdas_home.append(home_ctx)
        ctx_lambdas_away.append(away_ctx)
        base_probs = _poisson_1x2(home_base, away_base)
        ctx_probs = _poisson_1x2(home_ctx, away_ctx)
        base_home_probs.append(base_probs["home"])
        base_draw_probs.append(base_probs["draw"])
        base_away_probs.append(base_probs["away"])
        ctx_home_probs.append(ctx_probs["home"])
        ctx_draw_probs.append(ctx_probs["draw"])
        ctx_away_probs.append(ctx_probs["away"])
        change = abs(home_ctx - home_base) + abs(away_ctx - away_base)
        abs_changes.append(change)
        if change > 1e-9:
            changed += 1
        prob_change_home = abs(ctx_probs["home"] - base_probs["home"])
        prob_change_draw = abs(ctx_probs["draw"] - base_probs["draw"])
        prob_change_away = abs(ctx_probs["away"] - base_probs["away"])
        abs_prob_changes_home.append(prob_change_home)
        abs_prob_changes_draw.append(prob_change_draw)
        abs_prob_changes_away.append(prob_change_away)
        if max(prob_change_home, prob_change_draw, prob_change_away) >= 0.005:
            meaningful_changed += 1

    model_comparison = {
        "applied_matches": applied,
        "skipped_matches": skipped,
        "changed_matches": changed,
        "changed_matches_pct": round(changed * 100.0 / applied, 2) if applied else 0.0,
        "meaningful_changed_matches": meaningful_changed,
        "meaningful_changed_pct": round(meaningful_changed * 100.0 / applied, 2) if applied else 0.0,
        "meaningful_threshold": "cambio absoluto >= 0.005 en 1X2",
        "mean_abs_lambda_change": round(mean(abs_changes), 4) if abs_changes else None,
        "max_abs_lambda_change": round(max(abs_changes), 4) if abs_changes else None,
        "mean_abs_p_home_change": round(mean(abs_prob_changes_home), 4) if abs_prob_changes_home else None,
        "mean_abs_p_draw_change": round(mean(abs_prob_changes_draw), 4) if abs_prob_changes_draw else None,
        "mean_abs_p_away_change": round(mean(abs_prob_changes_away), 4) if abs_prob_changes_away else None,
        "base_lambda_home": _distribution(base_lambdas_home),
        "base_lambda_away": _distribution(base_lambdas_away),
        "context_lambda_home": _distribution(ctx_lambdas_home),
        "context_lambda_away": _distribution(ctx_lambdas_away),
        "base_p_home": _distribution(base_home_probs),
        "base_p_draw": _distribution(base_draw_probs),
        "base_p_away": _distribution(base_away_probs),
        "context_p_home": _distribution(ctx_home_probs),
        "context_p_draw": _distribution(ctx_draw_probs),
        "context_p_away": _distribution(ctx_away_probs),
        "note": (
            "Comparación de una capa Poisson simple, no del motor final. "
            "Solo se aplican features marcadas usable_for_model; si falta alguna, el partido se omite."
        ),
    }

    report = {
        "version": version,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "matches": len(parsed),
        "selected_features": distributions,
        "raw_xg_vs_rolling": raw_vs_rolling,
        "model_before_after": model_comparison,
        "correlation_home_xg_raw_vs_rolling": raw_vs_rolling["correlation_raw_vs_rolling"],
        "seasons_before": ["2020-21", "2021-22", "2022-23"],
        "seasons_after": ["2023-24", "2024-25", "2025-26"],
    }
    FEATURE_STORE_DIR.mkdir(parents=True, exist_ok=True)
    DISTRIBUTION_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Auditoría de leakage y distribuciones")
    parser.add_argument("--version", default=DEFAULT_VERSION)
    args = parser.parse_args()
    conn = get_connection()
    try:
        audit = audit_dataset(conn, args.version)
        distribution = distribution_report(conn, args.version)
    finally:
        conn.close()
    print("=" * 80)
    print(f"Auditoría de leakage: {audit['status']}")
    print(f"Fallos: {audit.get('failure_count', 0)}")
    print(f"Entradas: {audit.get('summary', {}).get('total_entries', 0):,} · "
          f"usables: {audit.get('summary', {}).get('usable', 0):,} · "
          f"excluidas: {audit.get('summary', {}).get('excluded', 0):,}")
    for group, payload in audit.get("core_groups", {}).items():
        print(f"  {group:<16} cobertura mínima {payload['min_coverage_pct']:.1f}% · usable {payload['min_model_usable_pct']:.1f}% · {'PASS' if payload['pass'] else 'FAIL'}")
    if audit.get("failures"):
        print("Primeros fallos:")
        for failure in audit["failures"][:10]:
            print(f"  [X] {failure}")
    print(f"Distribución: {DISTRIBUTION_PATH}")
    print(f"  partidos con capa de contexto: {distribution['model_before_after']['applied_matches']:,} · "
          f"cambia {distribution['model_before_after']['changed_matches_pct']:.1f}%")
    print("=" * 80)


if __name__ == "__main__":
    main()
