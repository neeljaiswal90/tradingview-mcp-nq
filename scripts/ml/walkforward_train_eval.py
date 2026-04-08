#!/usr/bin/env python3
"""
walkforward_train_eval.py — Time-ordered walk-forward evaluation for
XGBoost vs CatBoost management models.

Folds are constructed by DATE boundary (no random shuffle):
  Fold 1: Train on day 1, validate on day 2
  Fold 2: Train on days 1+2, validate on day 3
  ... (expanding window)

Both models see the EXACT same train/val splits on every fold.

Usage:
  python scripts/ml/walkforward_train_eval.py
  python scripts/ml/walkforward_train_eval.py --input data/management_dataset_labeled.csv
  python scripts/ml/walkforward_train_eval.py --device cpu

Outputs:
  reports/ml/walkforward_summary_<ts>.md
  reports/ml/model_comparison_<ts>.md

Requires: xgboost, catboost, scikit-learn, numpy
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import numpy as np

# ─── Feature schema (identical to both training scripts) ─────────────────────

# Import canonical feature lists from the shared registry.
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(__file__), '..', '..', 'python-market-data-service'))
from lob_features.ml_feature_registry import NUMERIC_FEATURES, CATEGORICAL_FEATURES, ALL_FEATURES

CLF_TARGET = "sl_hold_is_better"
REG_TARGET = "sl_remaining_r"
VALIDITY_COL = "sl_labels_valid"


# ─── Helpers ──────────────────────────────────────────────────────────────────

def sf(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def load_valid(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return [r for r in rows if r.get(VALIDITY_COL) == "1"]


def get_trade_date(row: dict) -> str:
    ts = row.get("timestamp", "")
    return ts[:10] if len(ts) >= 10 else ""


def build_xgb_matrix(rows: list[dict], cat_maps: dict[str, dict[str, int]]):
    """Build numpy matrix for XGBoost (with integer-encoded categoricals)."""
    feature_names = list(NUMERIC_FEATURES) + [f"{c}_enc" for c in CATEGORICAL_FEATURES]
    n = len(rows)
    m = len(feature_names)
    X = np.full((n, m), np.nan, dtype=np.float32)
    for i, row in enumerate(rows):
        for j, col in enumerate(NUMERIC_FEATURES):
            v = sf(row.get(col, ""))
            if v is not None:
                X[i, j] = v
        offset = len(NUMERIC_FEATURES)
        for j, col in enumerate(CATEGORICAL_FEATURES):
            val = row.get(col, "")
            if val in cat_maps.get(col, {}):
                X[i, offset + j] = float(cat_maps[col][val])
    return X, feature_names


def build_catboost_matrix(rows: list[dict]):
    """Build list-of-lists for CatBoost (native categoricals)."""
    X = []
    for row in rows:
        record = []
        for col in NUMERIC_FEATURES:
            record.append(sf(row.get(col, "")))
        for col in CATEGORICAL_FEATURES:
            val = row.get(col, "")
            record.append(val if val != "" else None)
        X.append(record)
    feature_names = list(ALL_FEATURES)
    cat_indices = list(range(len(NUMERIC_FEATURES), len(feature_names)))
    return X, feature_names, cat_indices


def extract_target(rows: list[dict], col: str) -> np.ndarray:
    y = np.full(len(rows), np.nan, dtype=np.float64)
    for i, r in enumerate(rows):
        v = sf(r.get(col, ""))
        if v is not None:
            y[i] = v
    return y


# ─── Per-fold training + evaluation ──────────────────────────────────────────

def eval_classifier(y_true, y_pred_prob):
    from sklearn.metrics import (
        accuracy_score, precision_score, recall_score, f1_score,
        roc_auc_score, log_loss, brier_score_loss,
    )
    y_pred = (np.array(y_pred_prob) > 0.5).astype(int)
    yt = np.array(y_true)
    n = len(yt)
    if n == 0 or len(set(yt)) < 2:
        return {"n": n, "error": "insufficient_classes"}

    return {
        "n": n,
        "accuracy": round(float(accuracy_score(yt, y_pred)), 4),
        "precision": round(float(precision_score(yt, y_pred, zero_division=0)), 4),
        "recall": round(float(recall_score(yt, y_pred, zero_division=0)), 4),
        "f1": round(float(f1_score(yt, y_pred, zero_division=0)), 4),
        "roc_auc": round(float(roc_auc_score(yt, y_pred_prob)), 4),
        "log_loss": round(float(log_loss(yt, y_pred_prob)), 4),
        "brier": round(float(brier_score_loss(yt, y_pred_prob)), 4),
        "class_1_rate": round(float(yt.mean()), 4),
        "pred_mean": round(float(np.mean(y_pred_prob)), 4),
    }


def eval_regressor(y_true, y_pred):
    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
    yt = np.array(y_true)
    yp = np.array(y_pred)
    n = len(yt)
    if n == 0:
        return {"n": n, "error": "no_data"}
    return {
        "n": n,
        "rmse": round(float(np.sqrt(mean_squared_error(yt, yp))), 4),
        "mae": round(float(mean_absolute_error(yt, yp)), 4),
        "r2": round(float(r2_score(yt, yp)), 4),
        "target_mean": round(float(yt.mean()), 4),
        "pred_mean": round(float(yp.mean()), 4),
    }


def train_eval_fold_xgb(train_rows, val_rows, cat_maps, device, seed):
    import xgboost as xgb

    X_tr, fnames = build_xgb_matrix(train_rows, cat_maps)
    X_va, _ = build_xgb_matrix(val_rows, cat_maps)

    results = {}

    # Classifier
    y_tr_clf = extract_target(train_rows, CLF_TARGET)
    y_va_clf = extract_target(val_rows, CLF_TARGET)
    mask_tr = ~np.isnan(y_tr_clf)
    mask_va = ~np.isnan(y_va_clf)

    if mask_tr.sum() >= 10 and mask_va.sum() >= 5 and len(set(y_va_clf[mask_va])) >= 2:
        dtrain = xgb.DMatrix(X_tr[mask_tr], label=y_tr_clf[mask_tr], feature_names=fnames, missing=np.nan)
        dval = xgb.DMatrix(X_va[mask_va], label=y_va_clf[mask_va], feature_names=fnames, missing=np.nan)
        params = {
            "objective": "binary:logistic", "eval_metric": "logloss",
            "device": device, "max_depth": 5, "learning_rate": 0.05,
            "subsample": 0.8, "colsample_bytree": 0.8, "min_child_weight": 3,
            "gamma": 0.1, "reg_alpha": 0.1, "reg_lambda": 1.0,
            "seed": seed, "verbosity": 0,
        }
        model = xgb.train(params, dtrain, num_boost_round=300,
                          evals=[(dval, "val")], early_stopping_rounds=30, verbose_eval=0)
        y_prob = model.predict(dval)
        results["clf"] = eval_classifier(y_va_clf[mask_va], y_prob)
        results["clf"]["best_iter"] = int(model.best_iteration) if hasattr(model, "best_iteration") else 300
    else:
        results["clf"] = {"n": int(mask_va.sum()), "error": "insufficient_data"}

    # Regressor
    y_tr_reg = extract_target(train_rows, REG_TARGET)
    y_va_reg = extract_target(val_rows, REG_TARGET)
    mask_tr_r = ~np.isnan(y_tr_reg)
    mask_va_r = ~np.isnan(y_va_reg)

    if mask_tr_r.sum() >= 10 and mask_va_r.sum() >= 5:
        dtrain = xgb.DMatrix(X_tr[mask_tr_r], label=y_tr_reg[mask_tr_r], feature_names=fnames, missing=np.nan)
        dval = xgb.DMatrix(X_va[mask_va_r], label=y_va_reg[mask_va_r], feature_names=fnames, missing=np.nan)
        params = {
            "objective": "reg:squarederror", "eval_metric": "rmse",
            "device": device, "max_depth": 5, "learning_rate": 0.05,
            "subsample": 0.8, "colsample_bytree": 0.8, "min_child_weight": 3,
            "gamma": 0.1, "reg_alpha": 0.1, "reg_lambda": 1.0,
            "seed": seed, "verbosity": 0,
        }
        model = xgb.train(params, dtrain, num_boost_round=300,
                          evals=[(dval, "val")], early_stopping_rounds=30, verbose_eval=0)
        y_pred = model.predict(dval)
        results["reg"] = eval_regressor(y_va_reg[mask_va_r], y_pred)
        results["reg"]["best_iter"] = int(model.best_iteration) if hasattr(model, "best_iteration") else 300
    else:
        results["reg"] = {"n": int(mask_va_r.sum()), "error": "insufficient_data"}

    return results


def train_eval_fold_catboost(train_rows, val_rows, device, seed):
    from catboost import CatBoostClassifier, CatBoostRegressor, Pool

    X_tr, fnames, cat_idx = build_catboost_matrix(train_rows)
    X_va, _, _ = build_catboost_matrix(val_rows)

    results = {}

    # Classifier
    y_tr_clf = extract_target(train_rows, CLF_TARGET)
    y_va_clf = extract_target(val_rows, CLF_TARGET)
    mask_tr = ~np.isnan(y_tr_clf)
    mask_va = ~np.isnan(y_va_clf)

    if mask_tr.sum() >= 10 and mask_va.sum() >= 5 and len(set(y_va_clf[mask_va])) >= 2:
        tr_pool = Pool([X_tr[i] for i in range(len(X_tr)) if mask_tr[i]],
                       label=y_tr_clf[mask_tr].tolist(), feature_names=fnames, cat_features=cat_idx)
        va_pool = Pool([X_va[i] for i in range(len(X_va)) if mask_va[i]],
                       label=y_va_clf[mask_va].tolist(), feature_names=fnames, cat_features=cat_idx)
        model = CatBoostClassifier(
            iterations=300, depth=5, learning_rate=0.05, l2_leaf_reg=3.0,
            loss_function="Logloss", eval_metric="Logloss", task_type=device,
            random_seed=seed, verbose=0, early_stopping_rounds=30,
            auto_class_weights="Balanced",
        )
        model.fit(tr_pool, eval_set=va_pool, use_best_model=True)
        y_prob = model.predict_proba(va_pool)[:, 1]
        results["clf"] = eval_classifier(y_va_clf[mask_va], y_prob)
        best = model.get_best_iteration()
        results["clf"]["best_iter"] = best if best is not None else 300
    else:
        results["clf"] = {"n": int(mask_va.sum()), "error": "insufficient_data"}

    # Regressor
    y_tr_reg = extract_target(train_rows, REG_TARGET)
    y_va_reg = extract_target(val_rows, REG_TARGET)
    mask_tr_r = ~np.isnan(y_tr_reg)
    mask_va_r = ~np.isnan(y_va_reg)

    if mask_tr_r.sum() >= 10 and mask_va_r.sum() >= 5:
        tr_pool = Pool([X_tr[i] for i in range(len(X_tr)) if mask_tr_r[i]],
                       label=y_tr_reg[mask_tr_r].tolist(), feature_names=fnames, cat_features=cat_idx)
        va_pool = Pool([X_va[i] for i in range(len(X_va)) if mask_va_r[i]],
                       label=y_va_reg[mask_va_r].tolist(), feature_names=fnames, cat_features=cat_idx)
        model = CatBoostRegressor(
            iterations=300, depth=5, learning_rate=0.05, l2_leaf_reg=3.0,
            loss_function="RMSE", eval_metric="RMSE", task_type=device,
            random_seed=seed, verbose=0, early_stopping_rounds=30,
        )
        model.fit(tr_pool, eval_set=va_pool, use_best_model=True)
        y_pred = model.predict(va_pool)
        results["reg"] = eval_regressor(y_va_reg[mask_va_r], y_pred)
        best = model.get_best_iteration()
        results["reg"]["best_iter"] = best if best is not None else 300
    else:
        results["reg"] = {"n": int(mask_va_r.sum()), "error": "insufficient_data"}

    return results


# ─── Action-policy simulation ────────────────────────────────────────────────

def simulate_policy(val_rows, clf_probs, threshold=0.5):
    """
    Simple policy: at each tick where model says HOLD (prob > threshold),
    the trade continues. When model says EXIT, we take the current unrealized_r.
    Compare to actual trade outcome.

    Returns per-trade policy results.
    """
    by_trade = defaultdict(list)
    for i, row in enumerate(val_rows):
        by_trade[row["trade_id"]].append((i, row))

    results = []
    for tid, entries in by_trade.items():
        entries.sort(key=lambda x: x[1].get("timestamp", ""))
        actual_r = sf(entries[0][1].get("label_final_r"))
        if actual_r is None:
            continue

        # Find first tick where model says EXIT
        policy_r = actual_r  # default: hold to end
        policy_action = "hold_to_end"
        for idx, row in entries:
            if idx < len(clf_probs) and clf_probs[idx] <= threshold:
                # Model says EXIT here
                r_at_exit = sf(row.get("unrealized_r"))
                if r_at_exit is not None:
                    policy_r = r_at_exit
                    policy_action = "model_exit"
                    break

        results.append({
            "trade_id": tid,
            "actual_r": actual_r,
            "policy_r": round(policy_r, 4),
            "action": policy_action,
            "improvement": round(policy_r - actual_r, 4),
        })

    return results


# ─── Reports ──────────────────────────────────────────────────────────────────

def aggregate_folds(fold_results: list[dict], model_key: str, task_key: str) -> dict:
    """Weighted average across folds for a given model+task."""
    metrics_by_name: dict[str, list[tuple[float, int]]] = defaultdict(list)
    total_n = 0
    for fr in fold_results:
        m = fr.get(model_key, {}).get(task_key, {})
        if "error" in m:
            continue
        n = m.get("n", 0)
        total_n += n
        for k, v in m.items():
            if isinstance(v, (int, float)) and k not in ("n", "best_iter"):
                metrics_by_name[k].append((v, n))

    agg = {"total_n": total_n}
    for k, vals in metrics_by_name.items():
        weighted = sum(v * n for v, n in vals) / sum(n for _, n in vals) if vals else None
        agg[k] = round(weighted, 4) if weighted is not None else None
    return agg


def write_summary(path, folds_info, fold_results, timestamp):
    lines = [
        "# Walk-Forward Evaluation Summary",
        "",
        f"**Generated:** {timestamp}",
        f"**Folds:** {len(fold_results)}",
        f"**Method:** Expanding window, date-boundary splits, no shuffle",
        "",
        "---",
        "",
        "## Fold Construction",
        "",
        "| Fold | Train Dates | Train Trades | Train Rows | Val Dates | Val Trades | Val Rows |",
        "|------|-------------|-------------|------------|-----------|------------|----------|",
    ]
    for fi in folds_info:
        lines.append(
            f"| {fi['fold']} | {fi['train_dates']} | {fi['train_trades']} | {fi['train_rows']} "
            f"| {fi['val_dates']} | {fi['val_trades']} | {fi['val_rows']} |"
        )

    lines.extend(["", "## Fold-by-Fold Results", ""])

    # Classifier table
    lines.extend([
        "### Classifier (`sl_hold_is_better`)", "",
        "| Fold | Model | N | Accuracy | AUC | F1 | Brier | Log Loss |",
        "|------|-------|---|----------|-----|----|----- -|----------|",
    ])
    for i, fr in enumerate(fold_results):
        for model in ["xgb", "catboost"]:
            m = fr.get(model, {}).get("clf", {})
            if "error" in m:
                lines.append(f"| {i+1} | {model} | {m.get('n',0)} | -- | -- | -- | -- | {m.get('error','')} |")
            else:
                lines.append(
                    f"| {i+1} | {model} | {m['n']} | {m['accuracy']} | {m['roc_auc']} "
                    f"| {m['f1']} | {m['brier']} | {m['log_loss']} |"
                )

    # Regressor table
    lines.extend([
        "", "### Regressor (`sl_remaining_r`)", "",
        "| Fold | Model | N | RMSE | MAE | R2 |",
        "|------|-------|---|------|-----|----|",
    ])
    for i, fr in enumerate(fold_results):
        for model in ["xgb", "catboost"]:
            m = fr.get(model, {}).get("reg", {})
            if "error" in m:
                lines.append(f"| {i+1} | {model} | {m.get('n',0)} | -- | -- | {m.get('error','')} |")
            else:
                lines.append(f"| {i+1} | {model} | {m['n']} | {m['rmse']} | {m['mae']} | {m['r2']} |")

    lines.extend(["", "---", ""])

    # Aggregates
    lines.extend(["## Aggregate Metrics (weighted by fold size)", ""])
    for task, task_label in [("clf", "Classifier"), ("reg", "Regressor")]:
        lines.append(f"### {task_label}")
        lines.append("")
        xgb_agg = aggregate_folds(fold_results, "xgb", task)
        cb_agg = aggregate_folds(fold_results, "catboost", task)
        keys = sorted(set(list(xgb_agg.keys()) + list(cb_agg.keys())) - {"total_n"})
        lines.append("| Metric | XGBoost | CatBoost | Winner |")
        lines.append("|--------|---------|----------|--------|")
        for k in keys:
            xv = xgb_agg.get(k)
            cv = cb_agg.get(k)
            if xv is None and cv is None:
                continue
            higher_better = k in ("accuracy", "precision", "recall", "f1", "roc_auc", "r2")
            lower_better = k in ("rmse", "mae", "log_loss", "brier")
            if xv is not None and cv is not None:
                if higher_better:
                    winner = "CatBoost" if cv > xv else "XGBoost" if xv > cv else "Tie"
                elif lower_better:
                    winner = "CatBoost" if cv < xv else "XGBoost" if xv < cv else "Tie"
                else:
                    winner = "--"
            else:
                winner = "--"
            lines.append(f"| {k} | {xv} | {cv} | {winner} |")
        lines.append("")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"[REPORT] Summary -> {path}")


def write_comparison(path, fold_results, policy_results, timestamp):
    lines = [
        "# Model Comparison: XGBoost vs CatBoost",
        "",
        f"**Generated:** {timestamp}",
        f"**Method:** Walk-forward (expanding window, date splits)",
        f"**Folds:** {len(fold_results)}",
        "",
        "---",
        "",
        "## Production Recommendation",
        "",
    ]

    # Compute aggregate AUC and R2
    xgb_clf_agg = aggregate_folds(fold_results, "xgb", "clf")
    cb_clf_agg = aggregate_folds(fold_results, "catboost", "clf")
    xgb_reg_agg = aggregate_folds(fold_results, "xgb", "reg")
    cb_reg_agg = aggregate_folds(fold_results, "catboost", "reg")

    xgb_auc = xgb_clf_agg.get("roc_auc")
    cb_auc = cb_clf_agg.get("roc_auc")
    xgb_r2 = xgb_reg_agg.get("r2")
    cb_r2 = cb_reg_agg.get("r2")

    clf_winner = "CatBoost" if (cb_auc or 0) > (xgb_auc or 0) else "XGBoost"
    reg_winner = "CatBoost" if (cb_r2 or -99) > (xgb_r2 or -99) else "XGBoost"

    lines.extend([
        "| Task | XGBoost | CatBoost | Walk-Forward Winner |",
        "|------|---------|----------|---------------------|",
        f"| Classifier (AUC) | {xgb_auc} | {cb_auc} | **{clf_winner}** |",
        f"| Regressor (R2) | {xgb_r2} | {cb_r2} | **{reg_winner}** |",
        "",
    ])

    overall = clf_winner if clf_winner == reg_winner else "Split decision"
    lines.append(f"**Overall walk-forward winner: {overall}**")
    lines.append("")

    # Calibration
    lines.extend([
        "## Calibration Assessment", "",
        "| Model | Mean Predicted P(hold) | Actual Hold Rate | Brier Score |",
        "|-------|------------------------|------------------|-------------|",
    ])
    for model_key, label in [("xgb", "XGBoost"), ("catboost", "CatBoost")]:
        agg = aggregate_folds(fold_results, model_key, "clf")
        pred_mean = agg.get("pred_mean", "n/a")
        actual_rate = agg.get("class_1_rate", "n/a")
        brier = agg.get("brier", "n/a")
        lines.append(f"| {label} | {pred_mean} | {actual_rate} | {brier} |")

    lines.append("")
    lines.append("*Brier score: lower is better. Perfect calibration = pred_mean matches actual rate.*")
    lines.append("")

    # Policy simulation
    if policy_results:
        lines.extend([
            "---", "",
            "## Action-Policy Simulation",
            "",
            "Simple threshold policy: EXIT when model P(hold) <= 0.5, otherwise HOLD.",
            "",
        ])
        for model_key, label, pr in policy_results:
            if not pr:
                continue
            actual_rs = [t["actual_r"] for t in pr]
            policy_rs = [t["policy_r"] for t in pr]
            improvements = [t["improvement"] for t in pr]
            exits = sum(1 for t in pr if t["action"] == "model_exit")
            lines.extend([
                f"### {label}", "",
                f"- Trades evaluated: {len(pr)}",
                f"- Model triggered early exit: {exits}/{len(pr)} ({round(exits/max(len(pr),1)*100,1)}%)",
                f"- Actual avg R: {round(np.mean(actual_rs), 4)}",
                f"- Policy avg R: {round(np.mean(policy_rs), 4)}",
                f"- Avg improvement: {round(np.mean(improvements), 4)}R per trade",
                f"- Policy {'outperforms' if np.mean(improvements) > 0 else 'underperforms'} actual management",
                "",
            ])

    # Data limitations
    lines.extend([
        "---", "",
        "## Data Limitations", "",
        "- **38 trades across 3 days** is far below the minimum needed for statistical confidence",
        "- Walk-forward folds have 12-25 train trades and 13 validation trades",
        "- Results should be treated as directional indicators, not definitive rankings",
        "- Both models need 200+ trades across diverse market conditions to be production-trusted",
        "- The walk-forward winner is the better *candidate*, not a proven production model",
    ])

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"[REPORT] Comparison -> {path}")


# ─── Device detection ─────────────────────────────────────────────────────────

def detect_device(requested: str) -> tuple[str, str]:
    """Returns (xgb_device, catboost_device)."""
    if requested == "cpu":
        print("[DEVICE] CPU (explicit)")
        return "cpu", "CPU"

    # Test XGBoost GPU
    xgb_dev = "cpu"
    try:
        import xgboost as xgb
        test = xgb.XGBClassifier(device="cuda", n_estimators=1, verbosity=0)
        test.fit(np.array([[1, 2], [3, 4]]), np.array([0, 1]))
        xgb_dev = "cuda"
    except Exception:
        pass

    # Test CatBoost GPU
    cb_dev = "CPU"
    try:
        from catboost import CatBoostClassifier
        m = CatBoostClassifier(iterations=1, task_type="GPU", verbose=0)
        m.fit([[1, 2], [3, 4]], [0, 1])
        cb_dev = "GPU"
    except Exception:
        pass

    print(f"[DEVICE] XGBoost: {xgb_dev}, CatBoost: {cb_dev}")
    return xgb_dev, cb_dev


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Walk-forward evaluation: XGBoost vs CatBoost")
    parser.add_argument("--input", default="data/management_dataset_labeled.csv")
    parser.add_argument("--report-dir", default="reports/ml")
    parser.add_argument("--device", default="auto", choices=["auto", "gpu", "cuda", "cpu"])
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    os.makedirs(args.report_dir, exist_ok=True)

    import xgboost as xgb
    import catboost
    print(f"[EVAL] XGBoost {xgb.__version__}, CatBoost {catboost.__version__}")

    xgb_dev, cb_dev = detect_device(args.device)

    # Load data
    rows = load_valid(args.input)
    print(f"[EVAL] {len(rows)} valid rows")

    # Group rows by trade, get trade dates
    trades_by_date: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        date = get_trade_date(r)
        if date:
            trades_by_date[date].append(r)

    dates = sorted(trades_by_date.keys())
    print(f"[EVAL] Dates: {dates}")

    if len(dates) < 2:
        print("[EVAL] ERROR: Need at least 2 dates for walk-forward. Exiting.")
        sys.exit(1)

    # Build categorical encoding map for XGBoost (from ALL data, to ensure consistency)
    cat_maps: dict[str, dict[str, int]] = {}
    for col in CATEGORICAL_FEATURES:
        vals = sorted(set(r.get(col, "") for r in rows if r.get(col, "") != ""))
        cat_maps[col] = {v: i for i, v in enumerate(vals)}

    # Expanding-window folds
    fold_results = []
    folds_info = []
    all_policy_results = []

    for fold_idx in range(1, len(dates)):
        train_dates = dates[:fold_idx]
        val_dates = [dates[fold_idx]]

        train_rows = []
        for d in train_dates:
            train_rows.extend(trades_by_date[d])
        val_rows = trades_by_date[val_dates[0]]

        train_trade_ids = set(r["trade_id"] for r in train_rows)
        val_trade_ids = set(r["trade_id"] for r in val_rows)

        fi = {
            "fold": fold_idx,
            "train_dates": ", ".join(train_dates),
            "val_dates": val_dates[0],
            "train_trades": len(train_trade_ids),
            "train_rows": len(train_rows),
            "val_trades": len(val_trade_ids),
            "val_rows": len(val_rows),
        }
        folds_info.append(fi)

        print(f"\n{'='*60}")
        print(f"  FOLD {fold_idx}: train={fi['train_dates']} ({fi['train_trades']} trades, {fi['train_rows']} rows)")
        print(f"          val={fi['val_dates']} ({fi['val_trades']} trades, {fi['val_rows']} rows)")
        print(f"{'='*60}")

        # XGBoost
        print(f"  [XGB] Training...")
        t0 = time.time()
        xgb_results = train_eval_fold_xgb(train_rows, val_rows, cat_maps, xgb_dev, args.seed)
        print(f"  [XGB] Done in {time.time()-t0:.1f}s | clf_auc={xgb_results.get('clf',{}).get('roc_auc','n/a')} reg_r2={xgb_results.get('reg',{}).get('r2','n/a')}")

        # CatBoost
        print(f"  [CB]  Training...")
        t0 = time.time()
        cb_results = train_eval_fold_catboost(train_rows, val_rows, cb_dev, args.seed)
        print(f"  [CB]  Done in {time.time()-t0:.1f}s | clf_auc={cb_results.get('clf',{}).get('roc_auc','n/a')} reg_r2={cb_results.get('reg',{}).get('r2','n/a')}")

        fold_results.append({"xgb": xgb_results, "catboost": cb_results})

    # Policy simulation on last fold's validation set
    print(f"\n[POLICY] Simulating action policy on last fold...")
    last_val_rows = trades_by_date[dates[-1]]
    last_train_rows = []
    for d in dates[:-1]:
        last_train_rows.extend(trades_by_date[d])

    # Get classifier predictions for policy sim
    policy_results = []
    for model_name, train_fn in [("XGBoost", "xgb"), ("CatBoost", "catboost")]:
        try:
            if train_fn == "xgb":
                import xgboost as xgb_mod
                X_tr, fnames = build_xgb_matrix(last_train_rows, cat_maps)
                X_va, _ = build_xgb_matrix(last_val_rows, cat_maps)
                y_tr = extract_target(last_train_rows, CLF_TARGET)
                mask = ~np.isnan(y_tr)
                dtrain = xgb_mod.DMatrix(X_tr[mask], label=y_tr[mask], feature_names=fnames, missing=np.nan)
                dval = xgb_mod.DMatrix(X_va, feature_names=fnames, missing=np.nan)
                params = {"objective": "binary:logistic", "device": xgb_dev, "max_depth": 5,
                          "learning_rate": 0.05, "seed": args.seed, "verbosity": 0}
                model = xgb_mod.train(params, dtrain, num_boost_round=100)
                probs = model.predict(dval)
            else:
                from catboost import CatBoostClassifier, Pool
                X_tr, fnames, cat_idx = build_catboost_matrix(last_train_rows)
                X_va, _, _ = build_catboost_matrix(last_val_rows)
                y_tr = extract_target(last_train_rows, CLF_TARGET)
                mask = ~np.isnan(y_tr)
                tr_pool = Pool([X_tr[i] for i in range(len(X_tr)) if mask[i]],
                               label=y_tr[mask].tolist(), feature_names=fnames, cat_features=cat_idx)
                m = CatBoostClassifier(iterations=100, depth=5, learning_rate=0.05,
                                       task_type=cb_dev, random_seed=args.seed, verbose=0,
                                       auto_class_weights="Balanced")
                m.fit(tr_pool)
                va_pool = Pool(X_va, feature_names=fnames, cat_features=cat_idx)
                probs = m.predict_proba(va_pool)[:, 1]

            pr = simulate_policy(last_val_rows, probs, threshold=0.5)
            policy_results.append((train_fn, model_name, pr))
            avg_imp = np.mean([t["improvement"] for t in pr]) if pr else 0
            print(f"  [{model_name}] Policy avg improvement: {avg_imp:.4f}R/trade")
        except Exception as e:
            print(f"  [{model_name}] Policy simulation failed: {e}")

    # Write reports
    summary_path = os.path.join(args.report_dir, f"walkforward_summary_{timestamp}.md")
    write_summary(summary_path, folds_info, fold_results, timestamp)

    comparison_path = os.path.join(args.report_dir, f"model_comparison_{timestamp}.md")
    write_comparison(comparison_path, fold_results, policy_results, timestamp)

    # Final verdict
    xgb_clf = aggregate_folds(fold_results, "xgb", "clf")
    cb_clf = aggregate_folds(fold_results, "catboost", "clf")
    xgb_reg = aggregate_folds(fold_results, "xgb", "reg")
    cb_reg = aggregate_folds(fold_results, "catboost", "reg")

    print(f"\n{'='*60}")
    print(f"  WALK-FORWARD COMPLETE")
    print(f"{'='*60}")
    print(f"  Classifier AUC:  XGB={xgb_clf.get('roc_auc')}  CB={cb_clf.get('roc_auc')}")
    print(f"  Regressor R2:    XGB={xgb_reg.get('r2')}  CB={cb_reg.get('r2')}")
    clf_w = "CatBoost" if (cb_clf.get("roc_auc") or 0) > (xgb_clf.get("roc_auc") or 0) else "XGBoost"
    reg_w = "CatBoost" if (cb_reg.get("r2") or -99) > (xgb_reg.get("r2") or -99) else "XGBoost"
    print(f"  Classifier winner: {clf_w}")
    print(f"  Regressor winner:  {reg_w}")
    print(f"\n  Reports: {summary_path}")
    print(f"           {comparison_path}")


if __name__ == "__main__":
    main()
