#!/usr/bin/env python3
"""
train_logistic_lob_mbo_scalp.py — Phase 4.4 logistic trainer for the
lob_mbo_scalp family.

Trains SIX independent calibrated-logistic models: {long, short} ×
{1s, 3s, 5s} horizons. Each target produces one probability
P(favor_direction | features) that the Phase 4.5 `/predict_lob_mbo_scalp`
endpoint serves at inference time.

NON-NEGOTIABLE GUARANTEES (locked by tests):

  1. Fail closed on sample_weight. If enforcement is on (default) and
     the `sample_weight` column is missing, empty, non-numeric, or < 1
     for any row, the trainer exits with a non-zero code. The Phase 4.1
     writer produces this column unconditionally, so any violation
     means upstream corruption and must block training.

  2. Per-horizon row filtering. Each target drops rows ONLY where THAT
     horizon's `fwd_return_*s_pts` label is empty. Rows with partial
     coverage still contribute to horizons they cover. A row uncovered
     at 5s but covered at 1s trains the 1s model.

  3. Decision-time-safe features only. The feature list comes from the
     22 ScalperStateVector fields minus the raw `microprice` level.
     NOT included: forward labels, gate outcomes (`det_passed`,
     `persist_passed`, `all_gates_passed`), reject reasons,
     `horizon_coverage_ms`, timestamps, IDs, or the target itself.

  4. Deterministic feature list persisted with artifacts. Every coefs
     file carries `feature_order` as the canonical list used at fit
     time. Phase 4.5 inference validates the incoming feature payload
     against this list.

  5. Reproducible with fixed seed. Train/val split is time-based
     (ts_ms ascending, first 80% train, last 20% val) and
     deterministic. Random seed threaded into LogisticRegression.

  6. Per-target independence. Each target is filtered, scaled, and fit
     independently. A failure on one target (insufficient data, all-null
     features, no positives/negatives) is reported but does not abort
     other targets.

ARTIFACTS per run (written to `--out-dir`):

  {target}_coefs.json      — intercept + coefficients + scaler stats + metadata
  {target}_coefs.csv       — human-readable feature/coef pairs
  {target}_metrics.json    — train and validation metrics
  training_summary.json    — run-level summary with per-target outcomes

METRICS per target:

  ROC AUC, PR AUC, log loss, Brier score, confusion matrix at threshold,
  base rate, predicted probability summary (min/p5/p25/p50/p75/p95/max/mean),
  rows used, n_positive, n_negative, positive_rate, feature_count.

USAGE:

  python scripts/ml/train_logistic_lob_mbo_scalp.py \
         [--input data/lob_mbo_scalp_dataset.csv] \
         [--out-dir models/lob_mbo_scalp/versions/<auto-timestamp>] \
         [--cost-pts 0.0] \
         [--seed 42] \
         [--train-frac 0.8] \
         [--enforce-sample-weight | --no-enforce-sample-weight] \
         [--min-rows 100] \
         [--min-per-class 20] \
         [--threshold 0.5] \
         [--l2 1.0]

EXIT CODES:

   0 — success (all requested targets trained, or some insufficient_data
       but no fatal errors)
   1 — input file missing
   2 — sample_weight contract violated (fail-closed)
   3 — all targets failed (no usable training data)
   4 — unexpected exception during training
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

# ─── Constants ───────────────────────────────────────────────────────────────

# 22 candidate feature columns from the flattened ScalperStateVector.
# `microprice` (raw price level) is excluded because it shifts the intercept
# without providing a signal — the trainer only wants derivatives.
CANDIDATE_FEATURE_COLUMNS: list[str] = [
    "qi_1", "qi_3", "qi_5",
    "microprice_edge_ticks",
    "ofi_250ms", "ofi_1s", "ofi_3s",
    "z_ofi_250ms", "z_ofi_1s", "z_ofi_3s",
    "afi_250ms", "afi_1s", "afi_3s",
    "hazard_bid_1s", "hazard_ask_1s",
    "abs_bid_1s", "abs_ask_1s",
    "refill_bid_1s", "refill_ask_1s",
    "sigma_1s_ticks",
    "spread_ticks",
]

# Six training targets: {direction} × {horizon}. The plan's 4.5 ML service
# endpoint serves one (direction, horizon_sec) pair per call.
TARGETS: list[tuple[str, int]] = [
    ("long", 1),
    ("long", 3),
    ("long", 5),
    ("short", 1),
    ("short", 3),
    ("short", 5),
]

# Per-target status strings — stable telemetry keys, append-only.
STATUS_OK = "ok"
STATUS_INSUFFICIENT_ROWS = "insufficient_rows"
STATUS_NO_POSITIVES = "no_positives"
STATUS_NO_NEGATIVES = "no_negatives"
STATUS_NO_FEATURES = "no_usable_features"
STATUS_FIT_ERROR = "fit_error"

# Schema version for the artifact files. Bump if the coefs.json shape changes.
MODEL_SCHEMA_VERSION = "1.0"


# ─── Sample-weight contract ──────────────────────────────────────────────────

class SampleWeightViolation(Exception):
    """Raised by check_sample_weight_column when the fail-closed rule fires."""


def check_sample_weight_column(rows: list[dict[str, Any]], enforce: bool = True) -> list[float]:
    """
    Fail-closed sample_weight validation.

    Rules (in order):
      1. If `enforce` is False, parse permissively and return — callers that
         disable enforcement accept the consequences for training bias.
      2. If the `sample_weight` column is missing from ANY row → raise.
      3. If any row has an empty / None / non-numeric sample_weight → raise.
      4. If any row has sample_weight < 1 → raise.

    Returns the parsed list of weights aligned with `rows` on success.
    """
    weights: list[float] = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            raise SampleWeightViolation(f"row {i}: not a dict")
        if "sample_weight" not in row:
            if not enforce:
                weights.append(1.0)
                continue
            raise SampleWeightViolation(f"row {i}: sample_weight column missing")
        raw = row["sample_weight"]
        if raw is None or (isinstance(raw, str) and raw.strip() == ""):
            if not enforce:
                weights.append(1.0)
                continue
            raise SampleWeightViolation(f"row {i}: sample_weight is empty/None")
        try:
            w = float(raw)
        except (TypeError, ValueError):
            if not enforce:
                weights.append(1.0)
                continue
            raise SampleWeightViolation(f"row {i}: sample_weight={raw!r} not numeric") from None
        if not math.isfinite(w):
            if not enforce:
                weights.append(1.0)
                continue
            raise SampleWeightViolation(f"row {i}: sample_weight={w} not finite")
        if w < 1.0:
            if not enforce:
                weights.append(max(1.0, w))
                continue
            raise SampleWeightViolation(f"row {i}: sample_weight={w} < 1.0")
        weights.append(w)
    return weights


# ─── Dataset I/O ─────────────────────────────────────────────────────────────

def load_dataset(csv_path: Path) -> list[dict[str, Any]]:
    """
    Load the Phase 4.3 dataset CSV as a list of dicts.

    Empty cells become None (critical for the null-label preservation
    that Phase 4.3 guardrail #4 enforces). Numeric columns are NOT
    coerced here — callers convert at the point of use.
    """
    if not csv_path.exists():
        return []
    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        rows: list[dict[str, Any]] = []
        for row in reader:
            # Empty cells → None (distinct from the string "0" which means zero)
            clean = {k: (None if v == "" else v) for k, v in row.items()}
            rows.append(clean)
    return rows


def _parse_float(value: Any) -> Optional[float]:
    """Parse a cell value to float; return None for empty/None/NaN/invalid."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        return f if math.isfinite(f) else None
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return None
        try:
            f = float(s)
        except ValueError:
            return None
        return f if math.isfinite(f) else None
    return None


# ─── Target construction ─────────────────────────────────────────────────────

def build_target(
    rows: list[dict[str, Any]],
    direction: str,
    horizon_sec: int,
    cost_pts: float = 0.0,
) -> tuple[list[dict[str, Any]], list[int], list[int]]:
    """
    Filter rows by direction + non-null label for this horizon, and compute
    the binary target.

    Target definition:
      long  target = 1 iff fwd_return_{H}s_pts > cost_pts  else 0
      short target = 1 iff fwd_return_{H}s_pts < -cost_pts else 0

    Returns (filtered_rows, y_list, original_indices) where
    `original_indices` is each surviving row's index in the input `rows`
    list. Callers use this to align `sample_weight` without re-parsing.

    Per-horizon filtering rule: a row with an empty fwd_return_{H}s_pts
    cell is dropped for THIS horizon only. It can still contribute to
    other horizons via separate calls to build_target.
    """
    assert direction in ("long", "short"), direction
    assert horizon_sec in (1, 3, 5), horizon_sec
    label_col = f"fwd_return_{horizon_sec}s_pts"

    filtered: list[dict[str, Any]] = []
    y_list: list[int] = []
    original_indices: list[int] = []

    for i, row in enumerate(rows):
        if row.get("direction") != direction:
            continue
        fwd = _parse_float(row.get(label_col))
        if fwd is None:
            # Per-horizon filter: this horizon is uncovered, skip
            continue
        if direction == "long":
            y = 1 if fwd > cost_pts else 0
        else:
            y = 1 if fwd < -cost_pts else 0
        filtered.append(row)
        y_list.append(y)
        original_indices.append(i)

    return filtered, y_list, original_indices


# ─── Feature selection ──────────────────────────────────────────────────────

def select_features(
    rows: list[dict[str, Any]],
    candidate_columns: list[str] = CANDIDATE_FEATURE_COLUMNS,
) -> tuple[list[str], dict[str, str]]:
    """
    Apply feature selection rules and return the effective feature list
    plus a report of what was dropped and why.

    Rules:
      - Drop if every value is None/empty (no signal). Key: 'all_null'.
      - Drop if every non-null value is identical (constant column, no
        variance to fit). Key: 'constant'.

    The drop_report is keyed by column name and the value is the reason
    string. Callers serialize it into training_summary.json.
    """
    effective: list[str] = []
    drop_report: dict[str, str] = {}

    for col in candidate_columns:
        values: list[float] = []
        has_non_null = False
        for row in rows:
            v = _parse_float(row.get(col))
            if v is not None:
                has_non_null = True
                values.append(v)

        if not has_non_null:
            drop_report[col] = "all_null"
            continue
        # Constant: all values equal (within float tolerance)
        if len(values) > 1:
            first = values[0]
            all_equal = all(abs(v - first) < 1e-12 for v in values)
            if all_equal:
                drop_report[col] = "constant"
                continue
        effective.append(col)

    return effective, drop_report


def features_to_matrix(
    rows: list[dict[str, Any]],
    feature_columns: list[str],
) -> tuple[list[list[float]], list[int]]:
    """
    Project rows onto the feature list. Drop any row that has a null in
    ANY selected column (after `select_features` removed all-null ones,
    this should be rare — partial-population regimes are the only way
    to trigger it).

    Returns (X, keep_indices) where `keep_indices` tells the caller which
    rows survived so it can subset y and weights in lockstep.
    """
    X: list[list[float]] = []
    keep_indices: list[int] = []
    for i, row in enumerate(rows):
        vec: list[float] = []
        ok = True
        for col in feature_columns:
            v = _parse_float(row.get(col))
            if v is None:
                ok = False
                break
            vec.append(v)
        if ok:
            X.append(vec)
            keep_indices.append(i)
    return X, keep_indices


# ─── Train/validation split ──────────────────────────────────────────────────

def time_split(
    rows: list[dict[str, Any]],
    train_frac: float = 0.8,
) -> tuple[list[int], list[int]]:
    """
    Time-based split by ts_ms ascending. Returns (train_indices, val_indices)
    where indices refer to positions in the INPUT `rows` list.

    Rows without a parseable ts_ms are placed at the end (deterministic,
    last index) so they land in the validation tail — they're typically
    edge cases that should not anchor training.

    If `rows` has fewer than 10 elements, splits 80/20 by row count
    without worrying about temporal ordering (not enough data to matter).
    """
    if len(rows) == 0:
        return [], []

    # Pair each index with its ts_ms (or +inf for missing)
    keyed: list[tuple[float, int]] = []
    for i, row in enumerate(rows):
        ts = _parse_float(row.get("ts_ms"))
        keyed.append((ts if ts is not None else float("inf"), i))
    keyed.sort(key=lambda t: (t[0], t[1]))
    sorted_indices = [i for _, i in keyed]

    split_point = max(1, int(round(len(sorted_indices) * train_frac)))
    split_point = min(split_point, len(sorted_indices) - 1) if len(sorted_indices) >= 2 else len(sorted_indices)
    return sorted_indices[:split_point], sorted_indices[split_point:]


# ─── Metrics ─────────────────────────────────────────────────────────────────

def _confusion_matrix(y_true: list[int], y_pred: list[int]) -> dict[str, int]:
    """Return {tp, fp, tn, fn}. Inputs are aligned 0/1 lists."""
    tp = fp = tn = fn = 0
    for yt, yp in zip(y_true, y_pred):
        if yt == 1 and yp == 1:
            tp += 1
        elif yt == 0 and yp == 1:
            fp += 1
        elif yt == 0 and yp == 0:
            tn += 1
        elif yt == 1 and yp == 0:
            fn += 1
    return {"tp": tp, "fp": fp, "tn": tn, "fn": fn}


def _percentile(values: list[float], p: float) -> float:
    """Simple linear-interpolation percentile. `p` in [0, 100]."""
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] + (s[c] - s[f]) * (k - f)


def _prob_summary(probs: list[float]) -> dict[str, float]:
    """Min/p5/p25/p50/p75/p95/max/mean of the predicted probabilities."""
    if not probs:
        return {
            "min": float("nan"), "p5": float("nan"), "p25": float("nan"),
            "p50": float("nan"), "p75": float("nan"), "p95": float("nan"),
            "max": float("nan"), "mean": float("nan"),
        }
    return {
        "min": min(probs),
        "p5": _percentile(probs, 5),
        "p25": _percentile(probs, 25),
        "p50": _percentile(probs, 50),
        "p75": _percentile(probs, 75),
        "p95": _percentile(probs, 95),
        "max": max(probs),
        "mean": sum(probs) / len(probs),
    }


def compute_metrics(
    y_true: list[int],
    y_pred_proba: list[float],
    sample_weight: Optional[list[float]] = None,
    threshold: float = 0.5,
) -> dict[str, Any]:
    """
    Compute the full Phase 4.4 metrics bundle.

    Uses sklearn lazily so the pure functions above remain importable
    without sklearn installed. If sklearn is missing, falls back to a
    minimal stdlib implementation of the required scalars (ROC/PR AUC
    unavailable in that mode — reported as None).
    """
    n = len(y_true)
    if n == 0:
        return {
            "n": 0,
            "base_rate": None,
            "roc_auc": None,
            "pr_auc": None,
            "log_loss": None,
            "brier": None,
            "threshold": threshold,
            "confusion_matrix": {"tp": 0, "fp": 0, "tn": 0, "fn": 0},
            "prob_summary": _prob_summary([]),
        }

    base_rate = sum(y_true) / n

    # Confusion matrix at threshold
    y_hat = [1 if p >= threshold else 0 for p in y_pred_proba]
    cm = _confusion_matrix(y_true, y_hat)

    # Brier score (stdlib, weighted)
    if sample_weight is None:
        brier = sum((p - y) ** 2 for p, y in zip(y_pred_proba, y_true)) / n
    else:
        w_sum = sum(sample_weight) if sample_weight else 0
        if w_sum > 0:
            brier = sum(w * (p - y) ** 2 for w, p, y in zip(sample_weight, y_pred_proba, y_true)) / w_sum
        else:
            brier = None

    # Log loss (stdlib, weighted, clipped)
    eps = 1e-15
    if sample_weight is None:
        ll_terms = [
            -(y * math.log(max(p, eps)) + (1 - y) * math.log(max(1 - p, eps)))
            for p, y in zip(y_pred_proba, y_true)
        ]
        log_loss = sum(ll_terms) / n
    else:
        w_sum = sum(sample_weight) if sample_weight else 0
        if w_sum > 0:
            ll_terms = [
                -w * (y * math.log(max(p, eps)) + (1 - y) * math.log(max(1 - p, eps)))
                for w, p, y in zip(sample_weight, y_pred_proba, y_true)
            ]
            log_loss = sum(ll_terms) / w_sum
        else:
            log_loss = None

    # ROC AUC / PR AUC via sklearn (lazy import). If sklearn is not
    # available, these come back as None.
    roc_auc: Optional[float] = None
    pr_auc: Optional[float] = None
    if len(set(y_true)) == 2:  # need both classes
        try:
            from sklearn.metrics import roc_auc_score, average_precision_score  # type: ignore
            if sample_weight is None:
                roc_auc = float(roc_auc_score(y_true, y_pred_proba))
                pr_auc = float(average_precision_score(y_true, y_pred_proba))
            else:
                roc_auc = float(roc_auc_score(y_true, y_pred_proba, sample_weight=sample_weight))
                pr_auc = float(average_precision_score(y_true, y_pred_proba, sample_weight=sample_weight))
        except ImportError:
            pass
        except Exception:  # noqa: BLE001
            # Edge cases (all same score, etc.) — leave as None
            pass

    return {
        "n": n,
        "base_rate": base_rate,
        "roc_auc": roc_auc,
        "pr_auc": pr_auc,
        "log_loss": log_loss,
        "brier": brier,
        "threshold": threshold,
        "confusion_matrix": cm,
        "prob_summary": _prob_summary(y_pred_proba),
    }


# ─── Model fit (sklearn-gated) ──────────────────────────────────────────────

def fit_logistic_model(
    X_train: list[list[float]],
    y_train: list[int],
    sample_weight_train: list[float],
    seed: int = 42,
    l2: float = 1.0,
) -> dict[str, Any]:
    """
    Fit StandardScaler → LogisticRegression on the training split.

    Returns a dict with scaler stats + logistic coefficients suitable
    for JSON serialization and for the Phase 4.5 inference formula:

        z_i = (x_i - mean_i) / std_i
        logit = intercept + sum(coef_i * z_i)
        p = 1 / (1 + exp(-logit))

    Imports sklearn + numpy lazily so the rest of the module can be
    loaded without them (for pure-function unit tests).
    """
    import numpy as np  # noqa: WPS433
    from sklearn.linear_model import LogisticRegression  # noqa: WPS433
    from sklearn.preprocessing import StandardScaler  # noqa: WPS433

    X = np.asarray(X_train, dtype=float)
    y = np.asarray(y_train, dtype=int)
    w = np.asarray(sample_weight_train, dtype=float)

    scaler = StandardScaler()
    scaler.fit(X, sample_weight=w)
    X_scaled = scaler.transform(X)

    # Note: sklearn 1.8 deprecated the `penalty` kwarg. L2 is the default
    # solver behavior when we pass C without penalty, so we omit the
    # explicit `penalty='l2'` to silence the FutureWarning. Effective
    # regularization is still controlled by C = 1/l2.
    clf = LogisticRegression(
        C=1.0 / l2,
        solver="lbfgs",
        max_iter=1000,
        random_state=seed,
    )
    clf.fit(X_scaled, y, sample_weight=w)

    return {
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "intercept": float(clf.intercept_[0]),
        "coefficients": clf.coef_[0].tolist(),
        "n_iter": int(clf.n_iter_[0]),
        "l2": l2,
        "seed": seed,
    }


def predict_proba(
    model: dict[str, Any],
    X: list[list[float]],
) -> list[float]:
    """
    Score a list of feature vectors against a fitted model dict from
    `fit_logistic_model`. Pure-Python inference so tests can verify
    the formula without sklearn.
    """
    mean = model["scaler_mean"]
    scale = model["scaler_scale"]
    intercept = model["intercept"]
    coefs = model["coefficients"]
    out: list[float] = []
    for row in X:
        z = 0.0
        for i, x in enumerate(row):
            s = scale[i] if scale[i] != 0 else 1.0
            z += coefs[i] * ((x - mean[i]) / s)
        logit = intercept + z
        if logit >= 0:
            p = 1.0 / (1.0 + math.exp(-logit))
        else:
            # Numerically stable form for very negative logits
            e = math.exp(logit)
            p = e / (1.0 + e)
        out.append(p)
    return out


# ─── Per-target training ─────────────────────────────────────────────────────

def train_target(
    dataset: list[dict[str, Any]],
    weights: list[float],
    direction: str,
    horizon_sec: int,
    cost_pts: float,
    seed: int,
    train_frac: float,
    min_rows: int,
    min_per_class: int,
    l2: float,
    threshold: float,
) -> dict[str, Any]:
    """
    Full per-target pipeline. Returns a result dict with status +
    artifacts (when status == 'ok') + metrics + diagnostics.

    Status values (stable telemetry keys):
      ok                    — trained and metrics computed
      insufficient_rows     — total filtered rows below min_rows
      no_positives          — training split has zero positives
      no_negatives          — training split has zero negatives
      no_usable_features    — every candidate column dropped as all-null/constant
      fit_error             — sklearn raised during fit (details in error field)
    """
    # 1. Filter by direction + per-horizon label
    filtered_rows, y, indices = build_target(dataset, direction, horizon_sec, cost_pts)
    filtered_weights = [weights[i] for i in indices]

    result: dict[str, Any] = {
        "direction": direction,
        "horizon_sec": horizon_sec,
        "cost_pts": cost_pts,
        "rows_filtered": len(filtered_rows),
        "status": STATUS_OK,
    }

    if len(filtered_rows) < min_rows:
        result["status"] = STATUS_INSUFFICIENT_ROWS
        result["error"] = f"rows_filtered={len(filtered_rows)} < min_rows={min_rows}"
        return result

    # 2. Select features (drop all-null + constant)
    features, drop_report = select_features(filtered_rows)
    result["features_selected"] = features
    result["feature_drop_report"] = drop_report

    if not features:
        result["status"] = STATUS_NO_FEATURES
        return result

    # 3. Build matrix (drops rows with any null in selected columns)
    X_all, keep = features_to_matrix(filtered_rows, features)
    y_all = [y[k] for k in keep]
    w_all = [filtered_weights[k] for k in keep]
    result["rows_after_matrix_build"] = len(X_all)

    if len(X_all) < min_rows:
        result["status"] = STATUS_INSUFFICIENT_ROWS
        result["error"] = f"rows_after_matrix_build={len(X_all)} < min_rows={min_rows}"
        return result

    # 4. Time-based split
    #    Use the ts_ms from the rows still in the matrix. We need to
    #    split on the filtered+matrix-surviving rows, so build a small
    #    shadow dataset of ts-only dicts for the splitter.
    matrix_rows_for_split = [filtered_rows[k] for k in keep]
    train_idx, val_idx = time_split(matrix_rows_for_split, train_frac)

    X_train = [X_all[i] for i in train_idx]
    y_train = [y_all[i] for i in train_idx]
    w_train = [w_all[i] for i in train_idx]
    X_val = [X_all[i] for i in val_idx]
    y_val = [y_all[i] for i in val_idx]
    w_val = [w_all[i] for i in val_idx]

    result["rows_train"] = len(X_train)
    result["rows_val"] = len(X_val)
    n_pos_train = sum(y_train)
    n_neg_train = len(y_train) - n_pos_train
    result["n_pos_train"] = n_pos_train
    result["n_neg_train"] = n_neg_train

    if n_pos_train < min_per_class:
        result["status"] = STATUS_NO_POSITIVES
        result["error"] = f"n_pos_train={n_pos_train} < min_per_class={min_per_class}"
        return result
    if n_neg_train < min_per_class:
        result["status"] = STATUS_NO_NEGATIVES
        result["error"] = f"n_neg_train={n_neg_train} < min_per_class={min_per_class}"
        return result

    # 5. Fit
    try:
        model = fit_logistic_model(X_train, y_train, w_train, seed=seed, l2=l2)
    except Exception as exc:  # noqa: BLE001
        result["status"] = STATUS_FIT_ERROR
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result

    # 6. Metrics — train and validation
    p_train = predict_proba(model, X_train)
    p_val = predict_proba(model, X_val) if X_val else []
    result["train_metrics"] = compute_metrics(y_train, p_train, w_train, threshold)
    result["val_metrics"] = compute_metrics(y_val, p_val, w_val, threshold)

    # 7. Attach the model for artifact writing
    result["model"] = model
    return result


# ─── Artifact writing ───────────────────────────────────────────────────────

def _target_key(direction: str, horizon_sec: int) -> str:
    return f"{direction}_{horizon_sec}s"


def write_artifacts(target_key: str, result: dict[str, Any], out_dir: Path) -> list[Path]:
    """
    Write per-target artifacts to `out_dir`. Returns the list of paths
    created. When the target's status is not OK, only a metrics file
    is written (no model, no coefs CSV).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []

    # Always write metrics (includes failure reasons)
    metrics_path = out_dir / f"{target_key}_metrics.json"
    metrics_payload = {
        "target_key": target_key,
        "direction": result.get("direction"),
        "horizon_sec": result.get("horizon_sec"),
        "status": result.get("status"),
        "error": result.get("error"),
        "cost_pts": result.get("cost_pts"),
        "rows_filtered": result.get("rows_filtered"),
        "rows_after_matrix_build": result.get("rows_after_matrix_build"),
        "rows_train": result.get("rows_train"),
        "rows_val": result.get("rows_val"),
        "n_pos_train": result.get("n_pos_train"),
        "n_neg_train": result.get("n_neg_train"),
        "features_selected": result.get("features_selected"),
        "feature_drop_report": result.get("feature_drop_report"),
        "train_metrics": result.get("train_metrics"),
        "val_metrics": result.get("val_metrics"),
    }
    metrics_path.write_text(json.dumps(metrics_payload, indent=2), encoding="utf-8")
    created.append(metrics_path)

    if result.get("status") != STATUS_OK or "model" not in result:
        return created

    # Coefs JSON — this is the "model file" the Phase 4.5 loader reads.
    model = result["model"]
    features = result["features_selected"]
    coefs_payload = {
        "schema_version": MODEL_SCHEMA_VERSION,
        "target_key": target_key,
        "direction": result["direction"],
        "horizon_sec": result["horizon_sec"],
        "feature_order": features,
        "scaler_mean": model["scaler_mean"],
        "scaler_scale": model["scaler_scale"],
        "intercept": model["intercept"],
        "coefficients": model["coefficients"],
        "l2": model["l2"],
        "seed": model["seed"],
        "n_iter": model["n_iter"],
    }
    coefs_json_path = out_dir / f"{target_key}_coefs.json"
    coefs_json_path.write_text(json.dumps(coefs_payload, indent=2), encoding="utf-8")
    created.append(coefs_json_path)

    # Coefs CSV (human-readable view)
    coefs_csv_path = out_dir / f"{target_key}_coefs.csv"
    with coefs_csv_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["feature", "coefficient", "scaler_mean", "scaler_scale"])
        for i, feat in enumerate(features):
            writer.writerow([
                feat,
                model["coefficients"][i],
                model["scaler_mean"][i],
                model["scaler_scale"][i],
            ])
        writer.writerow(["__intercept__", model["intercept"], "", ""])
    created.append(coefs_csv_path)

    return created


def write_training_summary(
    results: dict[str, dict[str, Any]],
    out_dir: Path,
    args: argparse.Namespace,
    input_row_count: int,
    sample_weight_enforced: bool,
) -> Path:
    """Write the run-level training_summary.json."""
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = {
        "schema_version": MODEL_SCHEMA_VERSION,
        "written_at": datetime.now(timezone.utc).isoformat(),
        "input_path": str(args.input),
        "input_row_count": input_row_count,
        "out_dir": str(out_dir),
        "cost_pts": args.cost_pts,
        "seed": args.seed,
        "train_frac": args.train_frac,
        "l2": args.l2,
        "threshold": args.threshold,
        "min_rows": args.min_rows,
        "min_per_class": args.min_per_class,
        "sample_weight_enforced": sample_weight_enforced,
        "candidate_features": CANDIDATE_FEATURE_COLUMNS,
        "targets": [
            {
                "target_key": target_key,
                "status": result.get("status"),
                "error": result.get("error"),
                "rows_filtered": result.get("rows_filtered"),
                "rows_train": result.get("rows_train"),
                "rows_val": result.get("rows_val"),
                "n_pos_train": result.get("n_pos_train"),
                "n_neg_train": result.get("n_neg_train"),
                "features_used": len(result.get("features_selected", []) or []),
                "feature_drop_report": result.get("feature_drop_report"),
                "train_roc_auc": (result.get("train_metrics") or {}).get("roc_auc"),
                "val_roc_auc": (result.get("val_metrics") or {}).get("roc_auc"),
                "train_log_loss": (result.get("train_metrics") or {}).get("log_loss"),
                "val_log_loss": (result.get("val_metrics") or {}).get("log_loss"),
            }
            for target_key, result in results.items()
        ],
    }
    summary_path = out_dir / "training_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary_path


# ─── CLI ────────────────────────────────────────────────────────────────────

def _default_out_dir() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"models/lob_mbo_scalp/versions/{ts}"


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Phase 4.4 logistic trainer for the lob_mbo_scalp family.",
    )
    parser.add_argument("--input", default="data/lob_mbo_scalp_dataset.csv")
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--cost-pts", type=float, default=0.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--train-frac", type=float, default=0.8)
    parser.add_argument("--l2", type=float, default=1.0)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--min-rows", type=int, default=100)
    parser.add_argument("--min-per-class", type=int, default=20)
    sw_group = parser.add_mutually_exclusive_group()
    sw_group.add_argument("--enforce-sample-weight", dest="enforce_sample_weight", action="store_true")
    sw_group.add_argument("--no-enforce-sample-weight", dest="enforce_sample_weight", action="store_false")
    parser.set_defaults(enforce_sample_weight=True)
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])

    input_path = Path(args.input).resolve()
    if not input_path.exists():
        print(f"[TRAIN] Input file not found: {input_path}", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir or _default_out_dir()).resolve()

    print(f"[TRAIN] Reading:   {input_path}")
    print(f"[TRAIN] Writing:   {out_dir}")

    dataset = load_dataset(input_path)

    # Fail-closed sample_weight check
    try:
        weights = check_sample_weight_column(dataset, enforce=args.enforce_sample_weight)
    except SampleWeightViolation as exc:
        print(f"[TRAIN] sample_weight contract violated: {exc}", file=sys.stderr)
        return 2

    print(f"[TRAIN] Dataset rows: {len(dataset)}")
    print(f"[TRAIN] sample_weight enforced: {args.enforce_sample_weight}")

    results: dict[str, dict[str, Any]] = {}
    try:
        for direction, horizon_sec in TARGETS:
            target_key = _target_key(direction, horizon_sec)
            print(f"[TRAIN] -- Training {target_key} --")
            result = train_target(
                dataset=dataset,
                weights=weights,
                direction=direction,
                horizon_sec=horizon_sec,
                cost_pts=args.cost_pts,
                seed=args.seed,
                train_frac=args.train_frac,
                min_rows=args.min_rows,
                min_per_class=args.min_per_class,
                l2=args.l2,
                threshold=args.threshold,
            )
            results[target_key] = result
            created = write_artifacts(target_key, result, out_dir)
            status = result.get("status")
            err = result.get("error")
            suffix = f" ({err})" if err else ""
            print(f"[TRAIN]   status={status}{suffix} | artifacts={len(created)}")
    except Exception as exc:  # noqa: BLE001
        print(f"[TRAIN] Unexpected error during training: {exc}", file=sys.stderr)
        return 4

    summary_path = write_training_summary(
        results, out_dir, args, input_row_count=len(dataset),
        sample_weight_enforced=args.enforce_sample_weight,
    )
    print(f"[TRAIN] Summary: {summary_path}")

    # Overall exit: 0 unless EVERY target failed
    ok_count = sum(1 for r in results.values() if r.get("status") == STATUS_OK)
    if ok_count == 0 and len(results) > 0:
        print(f"[TRAIN] All {len(results)} targets failed. See training_summary.json", file=sys.stderr)
        return 3

    print(f"[TRAIN] Done. {ok_count}/{len(results)} targets trained successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
