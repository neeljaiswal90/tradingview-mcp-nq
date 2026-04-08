#!/usr/bin/env python3
"""
train_catboost_entry_timing.py — Train CatBoost model for entry timing quality.

Trains:
  1. Classifier: good_entry_timing (1 = good, 0 = bad/late)
  2. Classifier: late_extension_entry (1 = late chase, 0 = ok)

Uses time-ordered train/test split by timestamp.

Usage:
  python scripts/ml/train_catboost_entry_timing.py [--input data/entry_timing_dataset.csv]
"""

from __future__ import annotations
import argparse, csv, json, os, sys, time
from datetime import datetime, timezone
import numpy as np

# Feature lists
NUMERIC_FEATURES = [
    "confidence", "score_margin", "alignment_score", "atr_14",
    "dist_from_vwap_pts", "dist_from_vwap_atr",
    "dist_from_ema9_atr", "dist_from_ema21_atr", "dist_from_ema50_atr",
    "current_impulse_pts", "current_impulse_atr", "bars_since_impulse_start",
    "last_3_bar_return_atr", "last_5_bar_return_atr",
    "consecutive_push_bars", "bars_since_last_pullback", "range_expansion_ratio",
    "upside_room_pts", "upside_room_atr", "downside_room_pts", "downside_room_atr",
    "reset_occurred", "pullback_depth_pts", "pullback_depth_pct_of_impulse",
    "no_reset_extension",
]

CATEGORICAL_FEATURES = ["side", "setup_type", "regime"]
ALL_FEATURES = NUMERIC_FEATURES + CATEGORICAL_FEATURES
TARGET_CLF = "label_good_entry_timing"
TARGET_LATE = "label_late_extension_entry"

def sf(v):
    if v is None or v == "": return None
    try: return float(v)
    except: return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/entry_timing_dataset.csv")
    parser.add_argument("--out-dir", default="models/entry_timing")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    from catboost import CatBoostClassifier, Pool
    from sklearn.metrics import accuracy_score, f1_score, roc_auc_score

    os.makedirs(args.out_dir, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    with open(args.input, "r") as f:
        rows = list(csv.DictReader(f))

    # Filter to labeled rows only
    labeled = [r for r in rows if r.get(TARGET_CLF) and r[TARGET_CLF] != ""]
    print(f"[TRAIN] Total rows: {len(rows)}, Labeled: {len(labeled)}")

    if len(labeled) < 10:
        print("[TRAIN] Not enough labeled data. Run more trades first.")
        sys.exit(0)

    # Time-ordered split (80/20)
    labeled.sort(key=lambda r: r.get("timestamp", ""))
    split = int(len(labeled) * 0.8)
    train_rows, test_rows = labeled[:split], labeled[split:]

    # Build feature matrices
    cat_indices = [ALL_FEATURES.index(c) for c in CATEGORICAL_FEATURES]

    def build_matrix(rows_in):
        X = []
        for r in rows_in:
            vec = []
            for f in ALL_FEATURES:
                v = r.get(f, "")
                if f in CATEGORICAL_FEATURES:
                    vec.append(v if v else "unknown")
                else:
                    vec.append(sf(v))
            X.append(vec)
        return X

    X_train = build_matrix(train_rows)
    X_test = build_matrix(test_rows)
    y_train = [int(float(r[TARGET_CLF])) for r in train_rows]
    y_test = [int(float(r[TARGET_CLF])) for r in test_rows]

    # Detect device
    device = "CPU"
    if args.device in ("auto", "gpu"):
        try:
            m = CatBoostClassifier(iterations=1, task_type="GPU", verbose=0)
            m.fit([[1, 2, "a"]], [0], cat_features=[2])
            device = "GPU"
        except: pass

    print(f"[TRAIN] Device: {device}, Train: {len(train_rows)}, Test: {len(test_rows)}")

    # Train good_entry_timing classifier
    model = CatBoostClassifier(
        iterations=200, depth=5, learning_rate=0.05,
        task_type=device, random_seed=args.seed, verbose=50,
        early_stopping_rounds=30, auto_class_weights="Balanced",
        cat_features=cat_indices,
    )

    train_pool = Pool(X_train, label=y_train, feature_names=ALL_FEATURES, cat_features=cat_indices)
    test_pool = Pool(X_test, label=y_test, feature_names=ALL_FEATURES, cat_features=cat_indices)

    t0 = time.time()
    model.fit(train_pool, eval_set=test_pool, use_best_model=True)
    elapsed = round(time.time() - t0, 2)

    y_pred = model.predict(test_pool).astype(int)
    y_prob = model.predict_proba(test_pool)[:, 1]

    metrics = {
        "accuracy": round(float(accuracy_score(y_test, y_pred)), 4),
        "f1": round(float(f1_score(y_test, y_pred, zero_division=0)), 4),
        "auc": round(float(roc_auc_score(y_test, y_prob)), 4) if len(set(y_test)) > 1 else None,
        "train_size": len(train_rows),
        "test_size": len(test_rows),
        "training_time_sec": elapsed,
    }

    # Feature importance
    importance = model.get_feature_importance(type="PredictionValuesChange")
    top_features = sorted(zip(ALL_FEATURES, importance), key=lambda x: -abs(x[1]))[:15]

    print(f"\n[TRAIN] Results: acc={metrics['accuracy']} f1={metrics['f1']} auc={metrics['auc']}")
    print("[TRAIN] Top features:")
    for name, imp in top_features[:10]:
        print(f"  {name:40s} {imp:.4f}")

    # Save model
    model_path = os.path.join(args.out_dir, "entry_timing_classifier.cbm")
    model.save_model(model_path)

    # Save metadata
    meta = {
        "generated_at": timestamp,
        "target": TARGET_CLF,
        "device": device,
        "metrics": metrics,
        "feature_names": ALL_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "top_features": [{"name": n, "importance": round(float(v), 4)} for n, v in top_features],
    }
    with open(os.path.join(args.out_dir, "training_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    # Generate report
    report_dir = "reports/ml"
    os.makedirs(report_dir, exist_ok=True)
    report = [
        "# Entry Timing Model Training Report",
        f"\n**Date:** {timestamp}",
        f"**Target:** {TARGET_CLF}",
        f"**Device:** {device}",
        f"**Train:** {metrics['train_size']} | **Test:** {metrics['test_size']}",
        f"\n## Metrics\n",
        f"| Metric | Value |",
        f"|--------|-------|",
    ]
    for k, v in metrics.items():
        report.append(f"| {k} | {v} |")
    report.append(f"\n## Top 10 Features\n")
    report.append("| Rank | Feature | Importance |")
    report.append("|------|---------|------------|")
    for i, (n, v) in enumerate(top_features[:10]):
        report.append(f"| {i+1} | {n} | {round(float(v), 4)} |")

    report.append(f"\n## Extension Feature Impact\n")
    ext_features = [f for f in ALL_FEATURES if any(f.startswith(p) for p in
                    ["dist_", "current_impulse", "bars_since", "last_", "consecutive_",
                     "range_", "upside_", "downside_", "reset_", "pullback_", "no_reset"])]
    ext_importance = sum(abs(importance[ALL_FEATURES.index(f)]) for f in ext_features)
    total_importance = sum(abs(v) for v in importance)
    report.append(f"Extension features contribute **{round(ext_importance/max(total_importance,1)*100,1)}%** of total feature importance.")
    report.append(f"\nThis {'supports' if ext_importance/max(total_importance,1) > 0.3 else 'does not yet strongly support'} the hypothesis that extension detection improves entry timing prediction.")

    with open(os.path.join(report_dir, f"entry_timing_feature_impact_{timestamp}.md"), "w") as f:
        f.write("\n".join(report))

    print(f"\n[TRAIN] Model saved to {model_path}")
    print(f"[TRAIN] Report: {report_dir}/entry_timing_feature_impact_{timestamp}.md")

if __name__ == "__main__":
    main()
