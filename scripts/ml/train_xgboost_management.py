#!/usr/bin/env python3
"""
train_xgboost_management.py — Train XGBoost models for position management.

Trains:
  1. Classifier: sl_hold_is_better  — "should I hold this trade?"
  2. Regressor:  sl_remaining_r     — "how much R remains if I hold?"

Uses GPU (CUDA) when available, falls back to CPU with explicit logging.

Usage:
  python scripts/ml/train_xgboost_management.py
  python scripts/ml/train_xgboost_management.py --input data/management_dataset_labeled.csv
  python scripts/ml/train_xgboost_management.py --device cpu --n-rounds 200

Outputs:
  models/xgboost/hold_classifier.ubj         — classifier model
  models/xgboost/remaining_r_regressor.ubj   — regressor model
  models/xgboost/training_meta.json          — metadata, params, metrics, feature schema
  reports/ml/xgboost_training_<timestamp>.md  — training report

Requires: xgboost, scikit-learn, numpy
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


# ─── Constants ────────────────────────────────────────────────────────────────

# Import canonical feature lists from the shared registry.
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(__file__), '..', '..', 'python-market-data-service'))
from lob_features.ml_feature_registry import NUMERIC_FEATURES, CATEGORICAL_FEATURES, FEATURE_SCHEMA_VERSION

# Classifier target
CLF_TARGET = "sl_hold_is_better"

# Regressor target
REG_TARGET = "sl_remaining_r"

# Validity filter
VALIDITY_COL = "sl_labels_valid"


# ─── Data loading ─────────────────────────────────────────────────────────────

def load_dataset(path: str) -> list[dict]:
    """Load CSV and filter to valid rows."""
    with open(path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    valid = [r for r in rows if r.get(VALIDITY_COL) == "1"]
    print(f"[DATA] Loaded {len(rows)} rows, {len(valid)} valid (sl_labels_valid=1)")
    return valid


def prepare_features(
    rows: list[dict],
    numeric_features: list[str],
    categorical_features: list[str],
) -> tuple[np.ndarray, list[str], dict[str, dict[str, int]]]:
    """
    Build feature matrix from rows.
    - Numeric features: parse to float, NaN for missing
    - Categorical features: integer-encode with explicit mapping

    Returns: (X, feature_names, category_maps)
    """
    # Build category maps
    cat_maps: dict[str, dict[str, int]] = {}
    for col in categorical_features:
        unique_vals = sorted(set(r.get(col, "") for r in rows if r.get(col, "") != ""))
        cat_maps[col] = {v: i for i, v in enumerate(unique_vals)}

    # All feature names in order
    feature_names = list(numeric_features) + [f"{col}_enc" for col in categorical_features]

    # Build matrix
    n = len(rows)
    m = len(feature_names)
    X = np.full((n, m), np.nan, dtype=np.float32)

    for i, row in enumerate(rows):
        # Numeric
        for j, col in enumerate(numeric_features):
            val = row.get(col, "")
            if val != "":
                try:
                    X[i, j] = float(val)
                except (ValueError, TypeError):
                    pass  # stays NaN

        # Categorical (integer encoded)
        offset = len(numeric_features)
        for j, col in enumerate(categorical_features):
            val = row.get(col, "")
            if val in cat_maps[col]:
                X[i, offset + j] = float(cat_maps[col][val])

    # Report NaN rates
    print(f"[DATA] Feature matrix: {X.shape[0]} x {X.shape[1]}")
    for j, name in enumerate(feature_names):
        nan_count = int(np.isnan(X[:, j]).sum())
        if nan_count > 0:
            print(f"  {name:40s} {nan_count} NaN ({round(nan_count/n*100, 1)}%)")

    return X, feature_names, cat_maps


def prepare_target(rows: list[dict], target_col: str) -> tuple[np.ndarray, np.ndarray]:
    """
    Extract target values and a mask of valid (non-NaN) indices.
    Returns: (y, valid_mask)
    """
    y = np.full(len(rows), np.nan, dtype=np.float32)
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


# ─── Device detection ─────────────────────────────────────────────────────────

def detect_device(requested: str) -> str:
    """
    Detect and validate the XGBoost device setting.
    Returns 'cuda' or 'cpu'.
    """
    import xgboost as xgb

    if requested == "cpu":
        print("[DEVICE] Using CPU (explicitly requested)")
        return "cpu"

    if requested in ("gpu", "cuda", "auto"):
        try:
            test = xgb.XGBClassifier(device="cuda", n_estimators=1, verbosity=0)
            test.fit(np.array([[1, 2], [3, 4]]), np.array([0, 1]))
            print("[DEVICE] GPU (CUDA) detected and verified")
            return "cuda"
        except Exception as e:
            print(f"[DEVICE] GPU requested but not available: {e}")
            print("[DEVICE] Falling back to CPU")
            return "cpu"

    print(f"[DEVICE] Unknown device '{requested}', using CPU")
    return "cpu"


# ─── Training ─────────────────────────────────────────────────────────────────

def train_classifier(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_test: np.ndarray,
    y_test: np.ndarray,
    feature_names: list[str],
    device: str,
    n_rounds: int,
    seed: int,
) -> tuple[Any, dict]:
    """Train XGBoost binary classifier for sl_hold_is_better."""
    import xgboost as xgb
    from sklearn.metrics import (
        accuracy_score, precision_score, recall_score, f1_score,
        roc_auc_score, log_loss, confusion_matrix,
    )

    params = {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "device": device,
        "max_depth": 5,
        "learning_rate": 0.05,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "min_child_weight": 3,
        "gamma": 0.1,
        "reg_alpha": 0.1,
        "reg_lambda": 1.0,
        "seed": seed,
        "verbosity": 1,
    }

    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=feature_names, missing=np.nan)
    dtest = xgb.DMatrix(X_test, label=y_test, feature_names=feature_names, missing=np.nan)

    evals_result: dict = {}
    t0 = time.time()
    model = xgb.train(
        params,
        dtrain,
        num_boost_round=n_rounds,
        evals=[(dtrain, "train"), (dtest, "test")],
        evals_result=evals_result,
        early_stopping_rounds=30,
        verbose_eval=50,
    )
    elapsed = round(time.time() - t0, 2)

    # Predict
    y_pred_prob = model.predict(dtest)
    y_pred = (y_pred_prob > 0.5).astype(int)

    # Metrics
    cm = confusion_matrix(y_test, y_pred)
    metrics = {
        "accuracy": round(float(accuracy_score(y_test, y_pred)), 4),
        "precision": round(float(precision_score(y_test, y_pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y_test, y_pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y_test, y_pred, zero_division=0)), 4),
        "roc_auc": round(float(roc_auc_score(y_test, y_pred_prob)), 4),
        "log_loss": round(float(log_loss(y_test, y_pred_prob)), 4),
        "confusion_matrix": cm.tolist(),
        "train_samples": int(X_train.shape[0]),
        "test_samples": int(X_test.shape[0]),
        "best_iteration": int(model.best_iteration) if hasattr(model, "best_iteration") else n_rounds,
        "training_time_sec": elapsed,
        "class_balance_train": {
            "hold_better_1": int((y_train == 1).sum()),
            "hold_better_0": int((y_train == 0).sum()),
        },
    }

    # Feature importance
    importance = model.get_score(importance_type="gain")
    top_features = sorted(importance.items(), key=lambda x: -x[1])[:20]

    metrics["feature_importance_top20"] = [
        {"feature": k, "gain": round(v, 2)} for k, v in top_features
    ]

    print(f"\n[CLF] Training complete in {elapsed}s")
    print(f"[CLF] Best iteration: {metrics['best_iteration']}")
    print(f"[CLF] Test accuracy: {metrics['accuracy']}")
    print(f"[CLF] Test AUC: {metrics['roc_auc']}")
    print(f"[CLF] Test F1: {metrics['f1']}")

    return model, {
        "model_type": "classifier",
        "target": CLF_TARGET,
        "params": params,
        "metrics": metrics,
        "evals_result_final": {
            "train_logloss": evals_result.get("train", {}).get("logloss", [])[-1:],
            "test_logloss": evals_result.get("test", {}).get("logloss", [])[-1:],
        },
    }


def train_regressor(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_test: np.ndarray,
    y_test: np.ndarray,
    feature_names: list[str],
    device: str,
    n_rounds: int,
    seed: int,
) -> tuple[Any, dict]:
    """Train XGBoost regressor for sl_remaining_r."""
    import xgboost as xgb
    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score

    params = {
        "objective": "reg:squarederror",
        "eval_metric": "rmse",
        "device": device,
        "max_depth": 5,
        "learning_rate": 0.05,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "min_child_weight": 3,
        "gamma": 0.1,
        "reg_alpha": 0.1,
        "reg_lambda": 1.0,
        "seed": seed,
        "verbosity": 1,
    }

    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=feature_names, missing=np.nan)
    dtest = xgb.DMatrix(X_test, label=y_test, feature_names=feature_names, missing=np.nan)

    evals_result: dict = {}
    t0 = time.time()
    model = xgb.train(
        params,
        dtrain,
        num_boost_round=n_rounds,
        evals=[(dtrain, "train"), (dtest, "test")],
        evals_result=evals_result,
        early_stopping_rounds=30,
        verbose_eval=50,
    )
    elapsed = round(time.time() - t0, 2)

    # Predict
    y_pred = model.predict(dtest)

    # Metrics
    metrics = {
        "rmse": round(float(np.sqrt(mean_squared_error(y_test, y_pred))), 4),
        "mae": round(float(mean_absolute_error(y_test, y_pred)), 4),
        "r2": round(float(r2_score(y_test, y_pred)), 4),
        "target_mean": round(float(np.mean(y_test)), 4),
        "target_std": round(float(np.std(y_test)), 4),
        "pred_mean": round(float(np.mean(y_pred)), 4),
        "pred_std": round(float(np.std(y_pred)), 4),
        "train_samples": int(X_train.shape[0]),
        "test_samples": int(X_test.shape[0]),
        "best_iteration": int(model.best_iteration) if hasattr(model, "best_iteration") else n_rounds,
        "training_time_sec": elapsed,
    }

    # Feature importance
    importance = model.get_score(importance_type="gain")
    top_features = sorted(importance.items(), key=lambda x: -x[1])[:20]
    metrics["feature_importance_top20"] = [
        {"feature": k, "gain": round(v, 2)} for k, v in top_features
    ]

    print(f"\n[REG] Training complete in {elapsed}s")
    print(f"[REG] Best iteration: {metrics['best_iteration']}")
    print(f"[REG] Test RMSE: {metrics['rmse']}")
    print(f"[REG] Test MAE: {metrics['mae']}")
    print(f"[REG] Test R2: {metrics['r2']}")

    return model, {
        "model_type": "regressor",
        "target": REG_TARGET,
        "params": params,
        "metrics": metrics,
        "evals_result_final": {
            "train_rmse": evals_result.get("train", {}).get("rmse", [])[-1:],
            "test_rmse": evals_result.get("test", {}).get("rmse", [])[-1:],
        },
    }


# ─── Report generation ────────────────────────────────────────────────────────

def write_report(
    report_path: str,
    clf_meta: dict,
    reg_meta: dict,
    feature_names: list[str],
    cat_maps: dict,
    device: str,
    total_rows: int,
    timestamp: str,
) -> None:
    """Write markdown training report."""
    lines = [
        "# XGBoost Management Model Training Report",
        "",
        f"**Generated:** {timestamp}",
        f"**Device:** {device}",
        f"**Dataset:** {total_rows} valid rows",
        "",
        "---",
        "",
        "## Models Trained",
        "",
        "### 1. Hold Classifier (`sl_hold_is_better`)",
        "",
        "Binary classification: should the trade be held (1) or exited (0)?",
        "",
        "| Metric | Value |",
        "|--------|-------|",
    ]

    cm = clf_meta["metrics"]
    for k in ["accuracy", "precision", "recall", "f1", "roc_auc", "log_loss"]:
        lines.append(f"| {k} | {cm[k]} |")
    lines.append(f"| best_iteration | {cm['best_iteration']} |")
    lines.append(f"| training_time | {cm['training_time_sec']}s |")
    lines.append(f"| train_samples | {cm['train_samples']} |")
    lines.append(f"| test_samples | {cm['test_samples']} |")

    balance = cm.get("class_balance_train", {})
    lines.append(f"| class_balance (train) | 1:{balance.get('hold_better_1',0)} / 0:{balance.get('hold_better_0',0)} |")

    conf = cm.get("confusion_matrix", [[0, 0], [0, 0]])
    lines.extend([
        "",
        "**Confusion Matrix (test):**",
        "",
        "| | Pred 0 | Pred 1 |",
        "|---|--------|--------|",
        f"| Actual 0 | {conf[0][0]} | {conf[0][1]} |",
        f"| Actual 1 | {conf[1][0]} | {conf[1][1]} |",
        "",
        "**Top 10 Features by Gain:**",
        "",
        "| Rank | Feature | Gain |",
        "|------|---------|------|",
    ])
    for i, feat in enumerate(cm.get("feature_importance_top20", [])[:10]):
        lines.append(f"| {i+1} | {feat['feature']} | {feat['gain']} |")

    lines.extend([
        "",
        "### 2. Remaining-R Regressor (`sl_remaining_r`)",
        "",
        "Regression: how much additional R will the trade capture?",
        "",
        "| Metric | Value |",
        "|--------|-------|",
    ])

    rm = reg_meta["metrics"]
    for k in ["rmse", "mae", "r2", "target_mean", "target_std", "pred_mean", "pred_std"]:
        lines.append(f"| {k} | {rm[k]} |")
    lines.append(f"| best_iteration | {rm['best_iteration']} |")
    lines.append(f"| training_time | {rm['training_time_sec']}s |")

    lines.extend([
        "",
        "**Top 10 Features by Gain:**",
        "",
        "| Rank | Feature | Gain |",
        "|------|---------|------|",
    ])
    for i, feat in enumerate(rm.get("feature_importance_top20", [])[:10]):
        lines.append(f"| {i+1} | {feat['feature']} | {feat['gain']} |")

    lines.extend([
        "",
        "---",
        "",
        "## Feature Schema",
        "",
        f"**Total features:** {len(feature_names)}",
        "",
        "| # | Feature | Type |",
        "|---|---------|------|",
    ])
    for i, name in enumerate(feature_names):
        ftype = "categorical_encoded" if name.endswith("_enc") else "numeric"
        lines.append(f"| {i+1} | {name} | {ftype} |")

    if cat_maps:
        lines.extend(["", "**Categorical Encoding Maps:**", ""])
        for col, mapping in cat_maps.items():
            lines.append(f"- `{col}`: {json.dumps(mapping)}")

    lines.extend([
        "",
        "---",
        "",
        "## Hyperparameters",
        "",
        "**Classifier:**",
        f"```json",
        json.dumps(clf_meta["params"], indent=2),
        "```",
        "",
        "**Regressor:**",
        f"```json",
        json.dumps(reg_meta["params"], indent=2),
        "```",
        "",
        "---",
        "",
        "## Reproducibility",
        "",
        "```bash",
        "python scripts/ml/train_xgboost_management.py \\",
        f"  --input data/management_dataset_labeled.csv \\",
        f"  --device {device} \\",
        f"  --seed {clf_meta['params'].get('seed', 42)}",
        "```",
    ])

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"[REPORT] Written to {report_path}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Train XGBoost management models")
    parser.add_argument("--input", default="data/management_dataset_labeled.csv")
    parser.add_argument("--model-dir", default="models/xgboost")
    parser.add_argument("--report-dir", default="reports/ml")
    parser.add_argument("--device", default="auto", choices=["auto", "gpu", "cuda", "cpu"])
    parser.add_argument("--n-rounds", type=int, default=300)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--test-size", type=float, default=0.2)
    args = parser.parse_args()

    import xgboost as xgb
    from sklearn.model_selection import train_test_split

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    os.makedirs(args.model_dir, exist_ok=True)
    os.makedirs(args.report_dir, exist_ok=True)

    print(f"[TRAIN] XGBoost {xgb.__version__}")
    print(f"[TRAIN] Input: {args.input}")
    print(f"[TRAIN] Seed: {args.seed}")

    # 1. Detect device
    device = detect_device(args.device)

    # 2. Load data
    rows = load_dataset(args.input)
    if len(rows) < 50:
        print(f"[TRAIN] ERROR: Only {len(rows)} valid rows. Need at least 50 for training.")
        sys.exit(1)

    # 3. Prepare features
    X, feature_names, cat_maps = prepare_features(rows, NUMERIC_FEATURES, CATEGORICAL_FEATURES)

    # 4. Train/test split (by trade to prevent within-trade leakage)
    trade_ids = list(set(r["trade_id"] for r in rows))
    trade_ids.sort()
    np.random.seed(args.seed)
    np.random.shuffle(trade_ids)
    split_idx = int(len(trade_ids) * (1 - args.test_size))
    train_trades = set(trade_ids[:split_idx])
    test_trades = set(trade_ids[split_idx:])

    train_mask = np.array([r["trade_id"] in train_trades for r in rows])
    test_mask = np.array([r["trade_id"] in test_trades for r in rows])

    X_train, X_test = X[train_mask], X[test_mask]
    print(f"[SPLIT] Train: {X_train.shape[0]} rows ({len(train_trades)} trades), Test: {X_test.shape[0]} rows ({len(test_trades)} trades)")

    # 5. Train classifier
    print("\n" + "=" * 60)
    print("  TRAINING: Hold Classifier (sl_hold_is_better)")
    print("=" * 60)

    y_clf, clf_valid = prepare_target(rows, CLF_TARGET)
    clf_train_mask = train_mask & clf_valid
    clf_test_mask = test_mask & clf_valid

    if clf_train_mask.sum() < 20 or clf_test_mask.sum() < 10:
        print(f"[CLF] ERROR: Not enough data (train={clf_train_mask.sum()}, test={clf_test_mask.sum()})")
        sys.exit(1)

    clf_model, clf_meta = train_classifier(
        X[clf_train_mask], y_clf[clf_train_mask],
        X[clf_test_mask], y_clf[clf_test_mask],
        feature_names, device, args.n_rounds, args.seed,
    )

    # 6. Train regressor
    print("\n" + "=" * 60)
    print("  TRAINING: Remaining-R Regressor (sl_remaining_r)")
    print("=" * 60)

    y_reg, reg_valid = prepare_target(rows, REG_TARGET)
    reg_train_mask = train_mask & reg_valid
    reg_test_mask = test_mask & reg_valid

    if reg_train_mask.sum() < 20 or reg_test_mask.sum() < 10:
        print(f"[REG] ERROR: Not enough data (train={reg_train_mask.sum()}, test={reg_test_mask.sum()})")
        sys.exit(1)

    reg_model, reg_meta = train_regressor(
        X[reg_train_mask], y_reg[reg_train_mask],
        X[reg_test_mask], y_reg[reg_test_mask],
        feature_names, device, args.n_rounds, args.seed,
    )

    # 7. Save models
    clf_path = os.path.join(args.model_dir, "hold_classifier.ubj")
    reg_path = os.path.join(args.model_dir, "remaining_r_regressor.ubj")

    clf_model.save_model(clf_path)
    print(f"[SAVE] Classifier saved to {clf_path}")

    reg_model.save_model(reg_path)
    print(f"[SAVE] Regressor saved to {reg_path}")

    # 8. Save metadata
    meta = {
        "generated_at": timestamp,
        "xgboost_version": xgb.__version__,
        "device": device,
        "seed": args.seed,
        "n_rounds": args.n_rounds,
        "test_size": args.test_size,
        "total_valid_rows": len(rows),
        "total_trades": len(trade_ids),
        "train_trades": len(train_trades),
        "test_trades": len(test_trades),
        "split_method": "by_trade_id (prevents within-trade leakage)",
        # feature_schema_version matches the registry the model was trained against.
        # Note: XGBoost encodes categoricals as integers, so feature_names here are
        # the encoded names (e.g. "setup_type_enc"), not the raw registry names.
        # The registry_feature_schema_version records which registry version was active.
        "registry_feature_schema_version": FEATURE_SCHEMA_VERSION,
        "registry_numeric_features": NUMERIC_FEATURES,
        "registry_categorical_features": CATEGORICAL_FEATURES,
        "feature_names": feature_names,      # encoded names (XGBoost-specific)
        "categorical_encoding": cat_maps,
        "classifier": clf_meta,
        "regressor": reg_meta,
        "artifacts": {
            "classifier_model": clf_path,
            "regressor_model": reg_path,
            "metadata": os.path.join(args.model_dir, "training_meta.json"),
        },
    }

    meta_path = os.path.join(args.model_dir, "training_meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, default=str)
    print(f"[SAVE] Metadata saved to {meta_path}")

    # 9. Write report
    report_path = os.path.join(args.report_dir, f"xgboost_training_{timestamp}.md")
    write_report(
        report_path, clf_meta, reg_meta,
        feature_names, cat_maps, device,
        len(rows), timestamp,
    )

    # 10. Summary
    print("\n" + "=" * 60)
    print("  TRAINING COMPLETE")
    print("=" * 60)
    print(f"  Device:     {device}")
    print(f"  Classifier: AUC={clf_meta['metrics']['roc_auc']}  F1={clf_meta['metrics']['f1']}")
    print(f"  Regressor:  R2={reg_meta['metrics']['r2']}  RMSE={reg_meta['metrics']['rmse']}")
    print(f"  Models:     {args.model_dir}/")
    print(f"  Report:     {report_path}")


if __name__ == "__main__":
    main()
