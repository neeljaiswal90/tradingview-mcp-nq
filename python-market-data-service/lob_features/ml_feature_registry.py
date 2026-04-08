"""
ml_feature_registry.py — CANONICAL feature list for management ML models.

THIS FILE IS THE SINGLE SOURCE OF TRUTH for feature names and order.
Every consumer MUST import from here:
  - train_catboost_management.py
  - train_xgboost_management.py
  - walkforward_train_eval.py
  - python-ml-service/loaders.py
  - build_management_dataset.py (for column validation)

TypeScript (ml/types.ts, ml/feature-builder.ts, schemas.py) must mirror
this list exactly. The feature parity tests enforce this.

Adding a feature:
  1. Add it to NUMERIC_FEATURES or CATEGORICAL_FEATURES below
  2. Add it to the TypeScript MlFeatureVector interface
  3. Add it to python-ml-service/schemas.py ManagementRequest
  4. Add it to ml/feature-builder.ts buildMlFeatures()
  5. Run feature parity tests
  6. Retrain models
"""

from __future__ import annotations

# ─── Existing position-management features (v1, 22 features) ─────────────────

POSITION_NUMERIC_FEATURES: list[str] = [
    "is_short",
    "confidence_at_entry",
    "initial_risk_pts",
    "current_price",
    "stop_current",
    "quantity_remaining",
    "pnl_pts",
    "unrealized_r",
    "mfe_pts_so_far",
    "mae_pts_so_far",
    "time_in_trade_sec",
    "distance_to_stop_pts",
    "pt1_hit",
    "pt2_hit",
    "stop_at_breakeven",
    "trail_active",
    "trail_ratchet_count",
    "management_events_count",
    "entry_hour_utc",
    "tick_hour_utc",
]

# ─── LOB/MBO features (v2, added for Bookmap/Rithmic integration) ────────────
# All nullable — missing when sidecar is unavailable. CatBoost handles natively.

LOB_NUMERIC_FEATURES: list[str] = [
    # BBO
    "lob_spread_ticks",
    "lob_bid_size",
    "lob_ask_size",
    # Depth
    "lob_depth_imbalance_5",
    "lob_depth_imbalance_10",
    "lob_total_bid_depth_10lvl",
    "lob_total_ask_depth_10lvl",
    # Trade flow
    "lob_cumulative_delta_10s",
    "lob_cumulative_delta_30s",
    "lob_cumulative_delta_60s",
    "lob_trade_flow_imbalance_10s",
    "lob_trade_flow_imbalance_30s",
    # MBO aggregates
    "lob_cancel_add_ratio_10s",
    "lob_replenishment_rate_10s",
    "lob_absorption_rate_10s",
    "lob_sweep_count_10s",
]

# ─── Advanced MBO features (v3, optional — requires rich MBO data) ────────────
# These are isolated: missing when advanced MBO analyzer is not running.
# CatBoost handles natively. Models trained without these still work.

ADVANCED_MBO_FEATURES: list[str] = [
    "adv_cancel_replace_ratio_10s",
    "adv_modify_rate_10s",
    "adv_iceberg_suspicion_30s",
    "adv_queue_deterioration_bid_10s",
    "adv_queue_deterioration_ask_10s",
    "adv_pull_cascade_count_10s",
    "adv_lifetime_p50_ms",
]

# ─── Combined lists ──────────────────────────────────────────────────────────

NUMERIC_FEATURES: list[str] = POSITION_NUMERIC_FEATURES + LOB_NUMERIC_FEATURES + ADVANCED_MBO_FEATURES

CATEGORICAL_FEATURES: list[str] = [
    "setup_type",
    "regime_at_entry",
]

ALL_FEATURES: list[str] = NUMERIC_FEATURES + CATEGORICAL_FEATURES

CAT_FEATURE_INDICES: list[int] = [
    ALL_FEATURES.index(c) for c in CATEGORICAL_FEATURES
]

# ─── Version tracking ────────────────────────────────────────────────────────

FEATURE_SCHEMA_VERSION = "v3_advanced_mbo"
FEATURE_COUNT = len(ALL_FEATURES)

# Validate at import time
assert len(set(ALL_FEATURES)) == len(ALL_FEATURES), "Duplicate feature names!"
assert FEATURE_COUNT == len(POSITION_NUMERIC_FEATURES) + len(LOB_NUMERIC_FEATURES) + len(ADVANCED_MBO_FEATURES) + len(CATEGORICAL_FEATURES)
