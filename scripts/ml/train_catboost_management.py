#!/usr/bin/env python3
"""
train_catboost_management.py — CatBoost challenger for position management.

Trains the same two models as the XGBoost pipeline for direct comparison:
  1. Classifier: sl_hold_is_better  — "should I hold this trade?"
  2. Regressor:  sl_remaining_r     — "how much R remains if I hold?"

Uses the EXACT same features, targets, and trade-level split as XGBoost
so metrics are directly comparable.

CatBoost advantage over XGBoost: native categorical handling (no manual
encoding), ordered boosting (reduces prediction shift on small datasets),
and symmetric tree structure.

Usage:
  python scripts/ml/train_catboost_management.py
  python scripts/ml/train_catboost_management.py --device gpu --iterations 300
  python scripts/ml/train_catboost_management.py --device cpu

Outputs:
  models/catboost/hold_classifier.cbm
  models/catboost/remaining_r_regressor.cbm
  models/catboost/training_meta.json
  reports/ml/catboost_training_<timestamp>.md

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

# ─── Feature parity with XGBoost pipeline ─────────────────────────────────────
# Same features, same coverage thresholds, same exclusions.

# Import canonical feature lists from the shared registry.
# This ensures training uses the EXACT same features as live inference.
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'python-market-data-service'))
from lob_features.ml_feature_registry import NUMERIC_FEATURES, CATEGORICAL_FEATURES, ALL_FEATURES, CAT_FEATURE_INDICES, FEATURE_SCHEMA_VERSION

CLF_TARGET = "sl_hold_is_better"
REG_TARGET = "sl_remaining_r"
VALIDITY_COL = "sl_labels_valid"


# ─── Helpers ──────────────────────────────────────────────────────────────────

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
    print(f"[DATA] Loaded {len(rows)} rows, {len(valid)} valid")
    return valid


def prepare_features(rows: list[dict]) -> tuple[list[list[Any]], list[str], list[int]]:
    """
    Build feature matrix for CatBoost.

    Unlike XGBoost, CatBoost accepts raw string categoricals.
    Returns: (X_raw, feature_names, cat_feature_indices)
    """
    feature_names = list(ALL_FEATURES)
    cat_indices = [i for i, f in enumerate(feature_names) if f in CATEGORICAL_FEATURES]

    X: list[list[Any]] = []
    for row in rows:
        record: list[Any] = []
        for col in feature_names:
            val = row.get(col, "")
            if col in CATEGORICAL_FEATURES:
                # CatBoost accepts strings directly; empty -> None for NaN
                record.append(val if val != "" else None)
            else:
                record.append(safe_float(val))
        X.append(record)

    # Report coverage
    n = len(rows)
    print(f"[DATA] Feature matrix: {n} x {len(feature_names)}")
    for j, name in enumerate(feature_names):
        nan_count = sum(1 for row in X if row[j] is None)
        if nan_count > 0:
            print(f"  {name:40s} {nan_count} missing ({round(nan_count/n*100, 1)}%)")

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
    print(f"[DATA] Target '{target_col}': {int(valid_mask.sum())} valid, {int((~valid_mask).sum())} missing")
    return y, valid_mask


def split_by_trade(rows: list[dict], test_size: float, seed: int):
    """Same trade-level split as XGBoost for direct comparison."""
    trade_ids = sorted(set(r["trade_id"] for r in rows))
    rng = np.random.RandomState(seed)
    rng.shuffle(trade_ids)
    split_idx = int(len(trade_ids) * (1 - test_size))
    train_trades = set(trade_ids[:split_idx])
    test_trades = set(trade_ids[split_idx:])

    train_idx = [i for i, r in enumerate(rows) if r["trade_id"] in train_trades]
    test_idx = [i for i, r in enumerate(rows) if r["trade_id"] in test_trades]

    print(f"[SPLIT] Train: {len(train_idx)} rows ({len(train_trades)} trades), "
          f"Test: {len(test_idx)} rows ({len(test_trades)} trades)")
    return train_idx, test_idx, train_trades, test_trades


# ─── Device detection ─────────────────────────────────────────────────────────

def detect_device(requested: str) -> str:
    if requested == "cpu":
        print("[DEVICE] Using CPU (explicitly requested)")
        return "CPU"

    if requested in ("gpu", "cuda", "auto"):
        try:
            from catboost import CatBoostClassifier
            m = CatBoostClassifier(iterations=1, task_type="GPU", verbose=0)
            m.fit([[1, 2], [3, 4]], [0, 1])
            print("[DEVICE] GPU detected and verified")
            return "GPU"
        except Exception as e:
            print(f"[DEVICE] GPU not available: {str(e)[:80]}")
            print("[DEVICE] Falling back to CPU")
            return "CPU"

    print(f"[DEVICE] Unknown '{requested}', using CPU")
    return "CPU"


# ─── Training ─────────────────────────────────────────────────────────────────

def train_classifier(
    X_train, y_train, X_test, y_test,
    feature_names, cat_indices, device, iterations, seed,
):
    from catboost import CatBoostClassifier, Pool
    from sklearn.metrics import (
        accuracy_score, precision_score, recall_score, f1_score,
        roc_auc_score, log_loss, confusion_matrix,
    )

    train_pool = Pool(X_train, label=y_train, feature_names=feature_names, cat_features=cat_indices)
    test_pool = Pool(X_test, label=y_test, feature_names=feature_names, cat_features=cat_indices)

    params = {
        "iterations": iterations,
        "depth": 5,
        "learning_rate": 0.05,
        "l2_leaf_reg": 3.0,
        "random_strength": 1.0,
        "bagging_temperature": 0.8,
        "loss_function": "Logloss",
        "eval_metric": "Logloss",
        "task_type": device,
        "random_seed": seed,
        "verbose": 50,
        "early_stopping_rounds": 30,
        "auto_class_weights": "Balanced",
        "od_type": "Iter",
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
        "log_loss": round(float(log_loss(y_test, y_pred_prob)), 4),
        "confusion_matrix": cm.tolist(),
        "train_samples": len(X_train),
        "test_samples": len(X_test),
        "best_iteration": model.get_best_iteration() if model.get_best_iteration() is not None else iterations,
        "training_time_sec": elapsed,
        "class_balance_train": {
            "hold_better_1": int((np.array(y_train) == 1).sum()),
            "hold_better_0": int((np.array(y_train) == 0).sum()),
        },
    }

    importance = model.get_feature_importance(type="PredictionValuesChange")
    top_features = sorted(
        zip(feature_names, importance), key=lambda x: -abs(x[1])
    )[:20]
    metrics["feature_importance_top20"] = [
        {"feature": k, "importance": round(float(v), 4)} for k, v in top_features
    ]

    print(f"\n[CLF] Done in {elapsed}s | best_iter={metrics['best_iteration']}")
    print(f"[CLF] Accuracy={metrics['accuracy']} AUC={metrics['roc_auc']} F1={metrics['f1']}")

    return model, {
        "model_type": "classifier",
        "target": CLF_TARGET,
        "params": {k: str(v) if not isinstance(v, (int, float, bool, type(None))) else v
                   for k, v in params.items()},
        "metrics": metrics,
    }


def train_regressor(
    X_train, y_train, X_test, y_test,
    feature_names, cat_indices, device, iterations, seed,
):
    from catboost import CatBoostRegressor, Pool
    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score

    train_pool = Pool(X_train, label=y_train, feature_names=feature_names, cat_features=cat_indices)
    test_pool = Pool(X_test, label=y_test, feature_names=feature_names, cat_features=cat_indices)

    params = {
        "iterations": iterations,
        "depth": 5,
        "learning_rate": 0.05,
        "l2_leaf_reg": 3.0,
        "random_strength": 1.0,
        "bagging_temperature": 0.8,
        "loss_function": "RMSE",
        "eval_metric": "RMSE",
        "task_type": device,
        "random_seed": seed,
        "verbose": 50,
        "early_stopping_rounds": 30,
        "od_type": "Iter",
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
        "pred_mean": round(float(np.mean(y_pred)), 4),
        "pred_std": round(float(np.std(y_pred)), 4),
        "train_samples": len(X_train),
        "test_samples": len(X_test),
        "best_iteration": model.get_best_iteration() if model.get_best_iteration() is not None else iterations,
        "training_time_sec": elapsed,
    }

    importance = model.get_feature_importance(type="PredictionValuesChange")
    top_features = sorted(
        zip(feature_names, importance), key=lambda x: -abs(x[1])
    )[:20]
    metrics["feature_importance_top20"] = [
        {"feature": k, "importance": round(float(v), 4)} for k, v in top_features
    ]

    print(f"\n[REG] Done in {elapsed}s | best_iter={metrics['best_iteration']}")
    print(f"[REG] RMSE={metrics['rmse']} MAE={metrics['mae']} R2={metrics['r2']}")

    return model, {
        "model_type": "regressor",
        "target": REG_TARGET,
        "params": {k: str(v) if not isinstance(v, (int, float, bool, type(None))) else v
                   for k, v in params.items()},
        "metrics": metrics,
    }


# ─── Report ───────────────────────────────────────────────────────────────────

def write_report(
    path, clf_meta, reg_meta, feature_names, cat_indices,
    device, total_rows, timestamp, xgb_meta_path,
):
    # Load XGBoost reference for head-to-head
    xgb_ref = None
    if os.path.exists(xgb_meta_path):
        with open(xgb_meta_path) as f:
            xgb_ref = json.load(f)

    lines = [
        "# CatBoost Management Model Training Report",
        "",
        f"**Generated:** {timestamp}",
        f"**Device:** {device}",
        f"**Dataset:** {total_rows} valid rows",
        f"**Role:** Challenger (vs XGBoost baseline)",
        "",
        "---",
        "",
    ]

    # Head-to-head comparison
    if xgb_ref:
        xgb_clf = xgb_ref.get("classifier", {}).get("metrics", {})
        xgb_reg = xgb_ref.get("regressor", {}).get("metrics", {})
        cb_clf = clf_meta["metrics"]
        cb_reg = reg_meta["metrics"]

        lines.extend([
            "## Head-to-Head: CatBoost vs XGBoost",
            "",
            "### Classifier (`sl_hold_is_better`)",
            "",
            "| Metric | XGBoost | CatBoost | Winner |",
            "|--------|---------|----------|--------|",
        ])
        for m in ["accuracy", "precision", "recall", "f1", "roc_auc", "log_loss"]:
            xv = xgb_clf.get(m, "n/a")
            cv = cb_clf.get(m, "n/a")
            better_higher = m != "log_loss"
            if isinstance(xv, (int, float)) and isinstance(cv, (int, float)):
                winner = "CatBoost" if (cv > xv if better_higher else cv < xv) else "XGBoost" if (xv > cv if better_higher else xv < cv) else "Tie"
            else:
                winner = "?"
            lines.append(f"| {m} | {xv} | {cv} | {winner} |")

        lines.extend([
            "",
            "### Regressor (`sl_remaining_r`)",
            "",
            "| Metric | XGBoost | CatBoost | Winner |",
            "|--------|---------|----------|--------|",
        ])
        for m in ["rmse", "mae", "r2"]:
            xv = xgb_reg.get(m, "n/a")
            cv = cb_reg.get(m, "n/a")
            better_higher = m == "r2"
            if isinstance(xv, (int, float)) and isinstance(cv, (int, float)):
                winner = "CatBoost" if (cv > xv if better_higher else cv < xv) else "XGBoost" if (xv > cv if better_higher else xv < cv) else "Tie"
            else:
                winner = "?"
            lines.append(f"| {m} | {xv} | {cv} | {winner} |")

        lines.extend(["", "---", ""])

    # Classifier detail
    cm = clf_meta["metrics"]
    lines.extend([
        "## Classifier Detail",
        "",
        "| Metric | Value |",
        "|--------|-------|",
    ])
    for k in ["accuracy", "precision", "recall", "f1", "roc_auc", "log_loss",
              "best_iteration", "training_time_sec", "train_samples", "test_samples"]:
        lines.append(f"| {k} | {cm.get(k, 'n/a')} |")

    conf = cm.get("confusion_matrix", [[0, 0], [0, 0]])
    lines.extend([
        "", "**Confusion Matrix:**", "",
        "| | Pred 0 | Pred 1 |",
        "|---|--------|--------|",
        f"| Actual 0 | {conf[0][0]} | {conf[0][1]} |",
        f"| Actual 1 | {conf[1][0]} | {conf[1][1]} |",
        "", "**Top 10 Features:**", "",
        "| Rank | Feature | Importance |",
        "|------|---------|------------|",
    ])
    for i, feat in enumerate(cm.get("feature_importance_top20", [])[:10]):
        lines.append(f"| {i+1} | {feat['feature']} | {feat['importance']} |")

    # Regressor detail
    rm = reg_meta["metrics"]
    lines.extend([
        "", "## Regressor Detail", "",
        "| Metric | Value |",
        "|--------|-------|",
    ])
    for k in ["rmse", "mae", "r2", "target_mean", "target_std", "pred_mean", "pred_std",
              "best_iteration", "training_time_sec"]:
        lines.append(f"| {k} | {rm.get(k, 'n/a')} |")

    lines.extend([
        "", "**Top 10 Features:**", "",
        "| Rank | Feature | Importance |",
        "|------|---------|------------|",
    ])
    for i, feat in enumerate(rm.get("feature_importance_top20", [])[:10]):
        lines.append(f"| {i+1} | {feat['feature']} | {feat['importance']} |")

    # Feature schema
    lines.extend([
        "", "---", "",
        f"## Feature Schema ({len(feature_names)} features)", "",
        "| # | Feature | Type |",
        "|---|---------|------|",
    ])
    for i, name in enumerate(feature_names):
        ftype = "categorical (native)" if i in cat_indices else "numeric"
        lines.append(f"| {i+1} | {name} | {ftype} |")

    lines.extend([
        "", "---", "",
        "## Reproducibility", "",
        "```bash",
        "python scripts/ml/train_catboost_management.py \\",
        f"  --device {device.lower()} --seed {clf_meta['params'].get('random_seed', 42)}",
        "```",
    ])

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"[REPORT] Written to {path}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Train CatBoost management models (challenger)")
    parser.add_argument("--input", default="data/management_dataset_labeled.csv")
    parser.add_argument("--model-dir", default="models/catboost")
    parser.add_argument("--report-dir", default="reports/ml")
    parser.add_argument("--xgb-meta", default="models/xgboost/training_meta.json",
                        help="XGBoost metadata for head-to-head comparison")
    parser.add_argument("--device", default="auto", choices=["auto", "gpu", "cuda", "cpu"])
    parser.add_argument("--iterations", type=int, default=300)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--test-size", type=float, default=0.2)
    args = parser.parse_args()

    import catboost
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    os.makedirs(args.model_dir, exist_ok=True)
    os.makedirs(args.report_dir, exist_ok=True)

    print(f"[TRAIN] CatBoost {catboost.__version__} (challenger)")
    print(f"[TRAIN] Input: {args.input}")
    print(f"[TRAIN] Seed: {args.seed}")

    # 1. Device
    device = detect_device(args.device)

    # 2. Load
    rows = load_dataset(args.input)
    if len(rows) < 50:
        print(f"[TRAIN] ERROR: Only {len(rows)} rows. Need >= 50.")
        sys.exit(1)

    # 3. Features — CatBoost handles categoricals natively, no encoding needed
    X_raw, feature_names, cat_indices = prepare_features(rows)

    # 4. Trade-level split (same seed + method as XGBoost for parity)
    train_idx, test_idx, train_trades, test_trades = split_by_trade(rows, args.test_size, args.seed)

    X_train = [X_raw[i] for i in train_idx]
    X_test = [X_raw[i] for i in test_idx]

    # 5. Classifier
    print("\n" + "=" * 60)
    print("  TRAINING: Hold Classifier (CatBoost)")
    print("=" * 60)

    y_clf, clf_valid = prepare_target(rows, CLF_TARGET)
    clf_train_idx = [i for i in train_idx if clf_valid[i]]
    clf_test_idx = [i for i in test_idx if clf_valid[i]]

    clf_model, clf_meta = train_classifier(
        [X_raw[i] for i in clf_train_idx],
        y_clf[clf_train_idx].tolist(),
        [X_raw[i] for i in clf_test_idx],
        y_clf[clf_test_idx].tolist(),
        feature_names, cat_indices, device, args.iterations, args.seed,
    )

    # 6. Regressor
    print("\n" + "=" * 60)
    print("  TRAINING: Remaining-R Regressor (CatBoost)")
    print("=" * 60)

    y_reg, reg_valid = prepare_target(rows, REG_TARGET)
    reg_train_idx = [i for i in train_idx if reg_valid[i]]
    reg_test_idx = [i for i in test_idx if reg_valid[i]]

    reg_model, reg_meta = train_regressor(
        [X_raw[i] for i in reg_train_idx],
        y_reg[reg_train_idx].tolist(),
        [X_raw[i] for i in reg_test_idx],
        y_reg[reg_test_idx].tolist(),
        feature_names, cat_indices, device, args.iterations, args.seed,
    )

    # 7. Save models
    clf_path = os.path.join(args.model_dir, "hold_classifier.cbm")
    reg_path = os.path.join(args.model_dir, "remaining_r_regressor.cbm")
    clf_model.save_model(clf_path)
    reg_model.save_model(reg_path)
    print(f"[SAVE] Classifier -> {clf_path}")
    print(f"[SAVE] Regressor  -> {reg_path}")

    # 8. Metadata
    meta = {
        "generated_at": timestamp,
        "catboost_version": catboost.__version__,
        "role": "challenger",
        "device": device,
        "seed": args.seed,
        "iterations": args.iterations,
        "test_size": args.test_size,
        "total_valid_rows": len(rows),
        "total_trades": len(set(r["trade_id"] for r in rows)),
        "train_trades": len(train_trades),
        "test_trades": len(test_trades),
        "split_method": "by_trade_id (same seed/method as XGBoost for parity)",
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "feature_names": feature_names,
        "feature_count": len(feature_names),
        "numeric_features": NUMERIC_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "cat_feature_indices": cat_indices,
        "classifier": clf_meta,
        "regressor": reg_meta,
        "artifacts": {
            "classifier_model": clf_path,
            "regressor_model": reg_path,
        },
    }

    meta_path = os.path.join(args.model_dir, "training_meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, default=str)
    print(f"[SAVE] Metadata -> {meta_path}")

    # 9. Report
    report_path = os.path.join(args.report_dir, f"catboost_training_{timestamp}.md")
    write_report(
        report_path, clf_meta, reg_meta, feature_names, cat_indices,
        device, len(rows), timestamp, args.xgb_meta,
    )

    # 10. Summary with head-to-head
    print("\n" + "=" * 60)
    print("  CATBOOST TRAINING COMPLETE (challenger)")
    print("=" * 60)
    print(f"  Device:     {device}")
    print(f"  Classifier: AUC={clf_meta['metrics']['roc_auc']}  F1={clf_meta['metrics']['f1']}")
    print(f"  Regressor:  R2={reg_meta['metrics']['r2']}  RMSE={reg_meta['metrics']['rmse']}")

    if os.path.exists(args.xgb_meta):
        with open(args.xgb_meta) as f:
            xgb = json.load(f)
        xgb_auc = xgb.get("classifier", {}).get("metrics", {}).get("roc_auc", "?")
        xgb_r2 = xgb.get("regressor", {}).get("metrics", {}).get("r2", "?")
        cb_auc = clf_meta["metrics"]["roc_auc"]
        cb_r2 = reg_meta["metrics"]["r2"]
        print(f"\n  HEAD-TO-HEAD:")
        print(f"    Classifier AUC:  XGB={xgb_auc}  CB={cb_auc}  {'CatBoost wins' if cb_auc > xgb_auc else 'XGBoost wins' if xgb_auc > cb_auc else 'Tie'}")
        print(f"    Regressor R2:    XGB={xgb_r2}  CB={cb_r2}  {'CatBoost wins' if cb_r2 > xgb_r2 else 'XGBoost wins' if xgb_r2 > cb_r2 else 'Tie'}")

    print(f"\n  Models:     {args.model_dir}/")
    print(f"  Report:     {report_path}")


if __name__ == "__main__":
    main()
