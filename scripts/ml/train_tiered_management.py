#!/usr/bin/env python3
"""
train_tiered_management.py — Train tiered CatBoost management models.

Trains separate models per feature tier:
  tier0: position/time/setup only (22 features, always trainable)
  tier1: tier0 + BBO/depth/trade-flow (38 features, requires LOB coverage)
  tier3: full microstructure (45 features, requires advanced MBO coverage)

Each tier has strict training thresholds (min rows, trades, family coverage).
Tiers that don't meet thresholds are skipped with a structured report.

Usage:
  python scripts/ml/train_tiered_management.py
  python scripts/ml/train_tiered_management.py --device gpu
  python scripts/ml/train_tiered_management.py --tiers tier0 tier1

Outputs:
  models/catboost/tier0/{hold_classifier.cbm, remaining_r_regressor.cbm, training_meta.json}
  models/catboost/tier1/...
  models/catboost/tier3/...
  models/catboost/tier_training_report.json

Requires: catboost, scikit-learn, numpy
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

import numpy as np

# ─── Import canonical feature lists and tier definitions ─────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'python-market-data-service'))
from lob_features.ml_feature_registry import (
    ALL_FEATURES, FEATURE_SCHEMA_VERSION, FEATURE_FAMILIES, FEATURE_METADATA,
)
from lob_features.ml_feature_tiers import (
    TIER_DEFINITIONS, TIER_PRIORITY, get_tier_features, get_tier_cat_indices,
)

CLF_TARGET = "sl_hold_is_better"
REG_TARGET = "sl_remaining_r"
VALIDITY_COL = "sl_labels_valid"


# ─── Helpers ─────────────────────────────────────────────────────────────────

def safe_float(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def load_dataset(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    valid = [r for r in rows if r.get(VALIDITY_COL) == "1"]
    print(f"[DATA] Loaded {len(rows)} rows, {len(valid)} valid (sl_labels_valid=1)")
    return valid


def detect_device(requested: str) -> str:
    if requested == "cpu":
        return "CPU"
    if requested in ("gpu", "cuda", "auto"):
        try:
            from catboost import CatBoostClassifier
            m = CatBoostClassifier(iterations=1, task_type="GPU", verbose=0)
            m.fit([[1, 2], [3, 4]], [0, 1])
            print("[DEVICE] GPU detected and verified")
            return "GPU"
        except Exception:
            print("[DEVICE] GPU not available, using CPU")
            return "CPU"
    return "CPU"


# ─── Tier eligibility checks ────────────────────────────────────────────────

def check_tier_eligibility(
    rows: list[dict],
    tier_name: str,
    tier_def: dict,
) -> tuple[bool, dict]:
    """
    Check if a tier is eligible for training.

    Returns (eligible, report) where report is a structured dict documenting
    why training was or wasn't possible.
    """
    tier_features = get_tier_features(tier_name)
    cat_features = tier_def["categorical_features"]

    # Row count
    min_rows = tier_def.get("min_rows", 50)
    if len(rows) < min_rows:
        return False, {
            "tier": tier_name,
            "skipped": True,
            "reason": "insufficient_rows",
            "details": {"row_count": len(rows), "required": min_rows},
        }

    # Trade count
    min_trades = tier_def.get("min_trades", 10)
    trade_ids = set(r.get("trade_id") for r in rows)
    if len(trade_ids) < min_trades:
        return False, {
            "tier": tier_name,
            "skipped": True,
            "reason": "insufficient_trades",
            "details": {"trade_count": len(trade_ids), "required": min_trades},
        }

    # Family coverage
    min_family_cov = tier_def.get("min_family_coverage", {})
    family_coverages: dict[str, float] = {}
    for family, min_cov in min_family_cov.items():
        family_feats = FEATURE_FAMILIES.get(family, [])
        # Only check features that are in this tier
        tier_family_feats = [f for f in family_feats if f in tier_features]
        if not tier_family_feats:
            family_coverages[family] = 0.0
            continue
        non_null_counts = []
        for f in tier_family_feats:
            non_null = sum(1 for r in rows if r.get(f) is not None and r.get(f) != "")
            non_null_counts.append(non_null / len(rows))
        avg_cov = sum(non_null_counts) / len(non_null_counts)
        family_coverages[family] = round(avg_cov, 4)

    failed_families = {
        fam: cov for fam, cov in family_coverages.items()
        if cov < min_family_cov.get(fam, 0.0)
    }
    if failed_families:
        return False, {
            "tier": tier_name,
            "skipped": True,
            "reason": "insufficient_family_coverage",
            "details": {
                "row_count": len(rows),
                "trade_count": len(trade_ids),
                "family_coverage": family_coverages,
                "required_coverage": min_family_cov,
                "failed_families": list(failed_families.keys()),
            },
        }

    # Per-row completeness (for tier3)
    min_completeness = tier_def.get("min_row_completeness", 0.0)
    if min_completeness > 0:
        lob_features = [f for f in tier_features if f not in cat_features
                        and FEATURE_METADATA.get(f, {}).get("nullable", False)]
        if lob_features:
            row_completeness_vals = []
            for r in rows:
                non_null = sum(1 for f in lob_features if r.get(f) is not None and r.get(f) != "")
                row_completeness_vals.append(non_null / len(lob_features))
            avg_completeness = sum(row_completeness_vals) / len(row_completeness_vals)
            if avg_completeness < min_completeness:
                return False, {
                    "tier": tier_name,
                    "skipped": True,
                    "reason": "insufficient_row_completeness",
                    "details": {
                        "row_count": len(rows),
                        "trade_count": len(trade_ids),
                        "family_coverage": family_coverages,
                        "row_completeness": round(avg_completeness, 4),
                        "required_completeness": min_completeness,
                    },
                }

    return True, {
        "tier": tier_name,
        "skipped": False,
        "reason": None,
        "details": {
            "row_count": len(rows),
            "trade_count": len(trade_ids),
            "family_coverage": family_coverages,
        },
    }


# ─── Feature matrix builder for a specific tier ─────────────────────────────

def prepare_tier_features(
    rows: list[dict],
    tier_name: str,
) -> tuple[list[list[Any]], list[str], list[int]]:
    """Build feature matrix for a specific tier using only that tier's features."""
    feature_names = get_tier_features(tier_name)
    cat_features = TIER_DEFINITIONS[tier_name]["categorical_features"]
    cat_indices = get_tier_cat_indices(tier_name)

    X: list[list[Any]] = []
    for row in rows:
        record: list[Any] = []
        for col in feature_names:
            val = row.get(col, "")
            if col in cat_features:
                record.append(val if val != "" else None)
            else:
                record.append(safe_float(val))
        X.append(record)

    return X, feature_names, cat_indices


def prepare_target(rows: list[dict], target_col: str) -> tuple[np.ndarray, np.ndarray]:
    y = np.full(len(rows), np.nan, dtype=np.float64)
    for i, row in enumerate(rows):
        val = row.get(target_col, "")
        if val != "":
            try:
                y[i] = float(val)
            except (ValueError, TypeError):
                pass
    valid_mask = ~np.isnan(y)
    return y, valid_mask


def split_by_trade(rows: list[dict], test_size: float, seed: int):
    trade_ids = sorted(set(r["trade_id"] for r in rows))
    rng = np.random.RandomState(seed)
    rng.shuffle(trade_ids)
    split_idx = int(len(trade_ids) * (1 - test_size))
    train_trades = set(trade_ids[:split_idx])
    test_trades = set(trade_ids[split_idx:])
    train_idx = [i for i, r in enumerate(rows) if r["trade_id"] in train_trades]
    test_idx = [i for i, r in enumerate(rows) if r["trade_id"] in test_trades]
    return train_idx, test_idx, train_trades, test_trades


# ─── Training functions ──────────────────────────────────────────────────────

def train_classifier(X_train, y_train, X_test, y_test, feature_names, cat_indices, device, iterations, seed):
    from catboost import CatBoostClassifier, Pool
    from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, roc_auc_score, confusion_matrix

    train_pool = Pool(X_train, label=y_train, feature_names=feature_names, cat_features=cat_indices)
    test_pool = Pool(X_test, label=y_test, feature_names=feature_names, cat_features=cat_indices)

    params = {
        "iterations": iterations, "depth": 5, "learning_rate": 0.05,
        "l2_leaf_reg": 3.0, "random_strength": 1.0, "bagging_temperature": 0.8,
        "loss_function": "Logloss", "eval_metric": "Logloss",
        "task_type": device, "random_seed": seed, "verbose": 50,
        "early_stopping_rounds": 30, "auto_class_weights": "Balanced", "od_type": "Iter",
    }

    model = CatBoostClassifier(**params)
    t0 = time.time()
    model.fit(train_pool, eval_set=test_pool, use_best_model=True)
    elapsed = round(time.time() - t0, 2)

    y_pred_prob = model.predict_proba(test_pool)[:, 1]
    y_pred = model.predict(test_pool).astype(int)

    cm = confusion_matrix(y_test, y_pred)
    metrics = {
        "accuracy": round(float(accuracy_score(y_test, y_pred)), 4),
        "precision": round(float(precision_score(y_test, y_pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y_test, y_pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y_test, y_pred, zero_division=0)), 4),
        "roc_auc": round(float(roc_auc_score(y_test, y_pred_prob)), 4),
        "confusion_matrix": cm.tolist(),
        "best_iteration": model.get_best_iteration() or iterations,
        "training_time_sec": elapsed,
    }

    importance = model.get_feature_importance(type="PredictionValuesChange")
    top_features = sorted(zip(feature_names, importance), key=lambda x: -abs(x[1]))[:20]
    metrics["feature_importance_top20"] = [{"feature": k, "importance": round(float(v), 4)} for k, v in top_features]

    return model, metrics


def train_regressor(X_train, y_train, X_test, y_test, feature_names, cat_indices, device, iterations, seed):
    from catboost import CatBoostRegressor, Pool
    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score

    train_pool = Pool(X_train, label=y_train, feature_names=feature_names, cat_features=cat_indices)
    test_pool = Pool(X_test, label=y_test, feature_names=feature_names, cat_features=cat_indices)

    params = {
        "iterations": iterations, "depth": 5, "learning_rate": 0.05,
        "l2_leaf_reg": 3.0, "random_strength": 1.0, "bagging_temperature": 0.8,
        "loss_function": "RMSE", "eval_metric": "RMSE",
        "task_type": device, "random_seed": seed, "verbose": 50,
        "early_stopping_rounds": 30, "od_type": "Iter",
    }

    model = CatBoostRegressor(**params)
    t0 = time.time()
    model.fit(train_pool, eval_set=test_pool, use_best_model=True)
    elapsed = round(time.time() - t0, 2)

    y_pred = model.predict(test_pool)
    metrics = {
        "rmse": round(float(np.sqrt(mean_squared_error(y_test, y_pred))), 4),
        "mae": round(float(mean_absolute_error(y_test, y_pred)), 4),
        "r2": round(float(r2_score(y_test, y_pred)), 4),
        "target_mean": round(float(np.mean(y_test)), 4),
        "target_std": round(float(np.std(y_test)), 4),
        "best_iteration": model.get_best_iteration() or iterations,
        "training_time_sec": elapsed,
    }

    importance = model.get_feature_importance(type="PredictionValuesChange")
    top_features = sorted(zip(feature_names, importance), key=lambda x: -abs(x[1]))[:20]
    metrics["feature_importance_top20"] = [{"feature": k, "importance": round(float(v), 4)} for k, v in top_features]

    return model, metrics


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Train tiered CatBoost management models")
    parser.add_argument("--input", default="data/management_dataset_labeled.csv")
    parser.add_argument("--model-dir", default="models/catboost")
    parser.add_argument("--device", default="auto", choices=["auto", "gpu", "cuda", "cpu"])
    parser.add_argument("--iterations", type=int, default=300)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--tiers", nargs="*", default=None,
                        help="Specific tiers to train (default: all)")
    args = parser.parse_args()

    import catboost
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    print(f"[TIERED-TRAIN] CatBoost {catboost.__version__}")
    print(f"[TIERED-TRAIN] Input: {args.input}")

    device = detect_device(args.device)

    # Load dataset
    rows = load_dataset(args.input)
    if not rows:
        print("[TIERED-TRAIN] ERROR: No valid rows. Exiting.")
        sys.exit(1)

    # Global split (same across all tiers for comparability)
    train_idx, test_idx, train_trades, test_trades = split_by_trade(rows, args.test_size, args.seed)
    print(f"[SPLIT] Train: {len(train_idx)} rows ({len(train_trades)} trades), "
          f"Test: {len(test_idx)} rows ({len(test_trades)} trades)")

    # Prepare targets
    y_clf, clf_valid = prepare_target(rows, CLF_TARGET)
    y_reg, reg_valid = prepare_target(rows, REG_TARGET)

    # Determine which tiers to attempt
    tiers_to_train = args.tiers or list(TIER_DEFINITIONS.keys())
    tier_reports: list[dict] = []
    trained_tiers: list[str] = []

    for tier_name in tiers_to_train:
        if tier_name not in TIER_DEFINITIONS:
            print(f"\n[TIERED-TRAIN] WARNING: Unknown tier '{tier_name}', skipping")
            continue

        tier_def = TIER_DEFINITIONS[tier_name]
        print(f"\n{'='*60}")
        print(f"  TIER: {tier_name} ({tier_def['name']})")
        print(f"  Features: {len(get_tier_features(tier_name))}")
        print(f"{'='*60}")

        # Check eligibility
        eligible, report = check_tier_eligibility(rows, tier_name, tier_def)
        if not eligible:
            print(f"[TIERED-TRAIN] SKIPPED {tier_name}: {report['reason']}")
            details = report.get("details", {})
            for k, v in details.items():
                print(f"  {k}: {v}")
            tier_reports.append(report)
            continue

        # Prepare tier-specific features
        X_raw, feature_names, cat_indices = prepare_tier_features(rows, tier_name)

        # Report coverage for this tier
        n = len(rows)
        lob_feats = [f for f in feature_names if f.startswith("lob_") or f.startswith("adv_")]
        if lob_feats:
            non_null_pcts = []
            for j, name in enumerate(feature_names):
                if name in lob_feats:
                    nan_count = sum(1 for row in X_raw if row[j] is None)
                    pct = round((n - nan_count) / n * 100, 1)
                    non_null_pcts.append(pct)
                    if nan_count > 0:
                        print(f"  {name:45s} {pct:6.1f}% non-null")
            if non_null_pcts:
                print(f"  Average LOB coverage: {round(sum(non_null_pcts)/len(non_null_pcts), 1)}%")

        # Train classifier
        print(f"\n  Training classifier ({CLF_TARGET})...")
        clf_train = [i for i in train_idx if clf_valid[i]]
        clf_test = [i for i in test_idx if clf_valid[i]]

        clf_model, clf_metrics = train_classifier(
            [X_raw[i] for i in clf_train], y_clf[clf_train].tolist(),
            [X_raw[i] for i in clf_test], y_clf[clf_test].tolist(),
            feature_names, cat_indices, device, args.iterations, args.seed,
        )

        # Train regressor
        print(f"\n  Training regressor ({REG_TARGET})...")
        reg_train = [i for i in train_idx if reg_valid[i]]
        reg_test = [i for i in test_idx if reg_valid[i]]

        reg_model, reg_metrics = train_regressor(
            [X_raw[i] for i in reg_train], y_reg[reg_train].tolist(),
            [X_raw[i] for i in reg_test], y_reg[reg_test].tolist(),
            feature_names, cat_indices, device, args.iterations, args.seed,
        )

        # Save tier artifacts
        tier_dir = os.path.join(args.model_dir, tier_name)
        os.makedirs(tier_dir, exist_ok=True)

        clf_path = os.path.join(tier_dir, "hold_classifier.cbm")
        reg_path = os.path.join(tier_dir, "remaining_r_regressor.cbm")
        clf_model.save_model(clf_path)
        reg_model.save_model(reg_path)

        # Provenance breakdown
        provenance_counts: dict[str, int] = {}
        for r in rows:
            src = r.get("_lob_data_source", "unknown")
            provenance_counts[src] = provenance_counts.get(src, 0) + 1

        # Training metadata
        meta = {
            "generated_at": timestamp,
            "tier_name": tier_name,
            "tier_description": tier_def["description"],
            "catboost_version": catboost.__version__,
            "device": device,
            "seed": args.seed,
            "feature_schema_version": FEATURE_SCHEMA_VERSION,
            "feature_names": feature_names,
            "feature_count": len(feature_names),
            "categorical_features": tier_def["categorical_features"],
            "cat_feature_indices": cat_indices,
            "total_valid_rows": len(rows),
            "total_trades": len(set(r["trade_id"] for r in rows)),
            "train_trades": len(train_trades),
            "test_trades": len(test_trades),
            "provenance_breakdown": provenance_counts,
            "coverage_summary": report.get("details", {}).get("family_coverage", {}),
            "classifier": {
                "target": CLF_TARGET,
                "metrics": clf_metrics,
            },
            "regressor": {
                "target": REG_TARGET,
                "metrics": reg_metrics,
            },
        }

        meta_path = os.path.join(tier_dir, "training_meta.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, default=str)

        print(f"\n  [SAVED] {tier_name} -> {tier_dir}/")
        print(f"    Classifier AUC={clf_metrics['roc_auc']}  F1={clf_metrics['f1']}")
        print(f"    Regressor  R2={reg_metrics['r2']}  RMSE={reg_metrics['rmse']}")

        trained_tiers.append(tier_name)
        tier_reports.append({
            "tier": tier_name,
            "skipped": False,
            "reason": None,
            "details": {
                "row_count": len(rows),
                "trade_count": len(set(r["trade_id"] for r in rows)),
                "family_coverage": report.get("details", {}).get("family_coverage", {}),
                "classifier_auc": clf_metrics["roc_auc"],
                "classifier_f1": clf_metrics["f1"],
                "regressor_r2": reg_metrics["r2"],
                "regressor_rmse": reg_metrics["rmse"],
            },
        })

    # Write overall tier training report
    report = {
        "generated_at": timestamp,
        "tiers_attempted": tiers_to_train,
        "tiers_trained": trained_tiers,
        "tiers_skipped": [t["tier"] for t in tier_reports if t.get("skipped")],
        "tier_reports": tier_reports,
        "dataset_info": {
            "total_rows": len(rows),
            "total_trades": len(set(r["trade_id"] for r in rows)),
            "train_trades": len(train_trades),
            "test_trades": len(test_trades),
        },
    }

    report_path = os.path.join(args.model_dir, "tier_training_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, default=str)

    print(f"\n{'='*60}")
    print(f"  TIERED TRAINING COMPLETE")
    print(f"{'='*60}")
    print(f"  Trained: {trained_tiers or 'none'}")
    print(f"  Skipped: {[t['tier'] for t in tier_reports if t.get('skipped')] or 'none'}")
    print(f"  Report:  {report_path}")


if __name__ == "__main__":
    main()
