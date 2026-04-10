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


# ─── Feature metadata (canonical manifest for all consumers) ──────────────────
# Defines family, dtype, nullable, and default for every feature.
# Dataset builders, training scripts, and inference all derive from this.

FEATURE_METADATA: dict[str, dict] = {
    # Position-management features (v1) — always required
    "is_short":              {"family": "position", "dtype": "int",   "nullable": False},
    "confidence_at_entry":   {"family": "position", "dtype": "float", "nullable": False},
    "initial_risk_pts":      {"family": "position", "dtype": "float", "nullable": False},
    "current_price":         {"family": "position", "dtype": "float", "nullable": False},
    "stop_current":          {"family": "position", "dtype": "float", "nullable": False},
    "quantity_remaining":    {"family": "position", "dtype": "float", "nullable": False},
    "pnl_pts":               {"family": "position", "dtype": "float", "nullable": False},
    "unrealized_r":          {"family": "position", "dtype": "float", "nullable": False},
    "mfe_pts_so_far":        {"family": "position", "dtype": "float", "nullable": False},
    "mae_pts_so_far":        {"family": "position", "dtype": "float", "nullable": False},
    "time_in_trade_sec":     {"family": "position", "dtype": "int",   "nullable": False},
    "distance_to_stop_pts":  {"family": "position", "dtype": "float", "nullable": False},
    "pt1_hit":               {"family": "position", "dtype": "int",   "nullable": False},
    "pt2_hit":               {"family": "position", "dtype": "int",   "nullable": False},
    "stop_at_breakeven":     {"family": "position", "dtype": "int",   "nullable": False},
    "trail_active":          {"family": "position", "dtype": "int",   "nullable": False},
    "trail_ratchet_count":   {"family": "position", "dtype": "int",   "nullable": False},
    "management_events_count": {"family": "position", "dtype": "int", "nullable": False},
    "entry_hour_utc":        {"family": "position", "dtype": "int",   "nullable": False},
    "tick_hour_utc":         {"family": "position", "dtype": "int",   "nullable": False},

    # LOB BBO features — nullable when sidecar unavailable
    "lob_spread_ticks":               {"family": "lob_bbo",  "dtype": "float", "nullable": True},
    "lob_bid_size":                   {"family": "lob_bbo",  "dtype": "float", "nullable": True},
    "lob_ask_size":                   {"family": "lob_bbo",  "dtype": "float", "nullable": True},
    "lob_depth_imbalance_5":          {"family": "lob_bbo",  "dtype": "float", "nullable": True},
    "lob_depth_imbalance_10":         {"family": "lob_bbo",  "dtype": "float", "nullable": True},
    "lob_total_bid_depth_10lvl":      {"family": "lob_bbo",  "dtype": "float", "nullable": True},
    "lob_total_ask_depth_10lvl":      {"family": "lob_bbo",  "dtype": "float", "nullable": True},

    # LOB trade flow features
    "lob_cumulative_delta_10s":       {"family": "lob_flow", "dtype": "float", "nullable": True},
    "lob_cumulative_delta_30s":       {"family": "lob_flow", "dtype": "float", "nullable": True},
    "lob_cumulative_delta_60s":       {"family": "lob_flow", "dtype": "float", "nullable": True},
    "lob_trade_flow_imbalance_10s":   {"family": "lob_flow", "dtype": "float", "nullable": True},
    "lob_trade_flow_imbalance_30s":   {"family": "lob_flow", "dtype": "float", "nullable": True},

    # LOB MBO aggregates
    "lob_cancel_add_ratio_10s":       {"family": "lob_mbo",  "dtype": "float", "nullable": True},
    "lob_replenishment_rate_10s":     {"family": "lob_mbo",  "dtype": "float", "nullable": True},
    "lob_absorption_rate_10s":        {"family": "lob_mbo",  "dtype": "float", "nullable": True},
    "lob_sweep_count_10s":            {"family": "lob_mbo",  "dtype": "float", "nullable": True},

    # Advanced MBO features (v3) — nullable when analyzer unavailable
    "adv_cancel_replace_ratio_10s":        {"family": "adv_mbo", "dtype": "float", "nullable": True},
    "adv_modify_rate_10s":                 {"family": "adv_mbo", "dtype": "float", "nullable": True},
    "adv_iceberg_suspicion_30s":           {"family": "adv_mbo", "dtype": "float", "nullable": True},
    "adv_queue_deterioration_bid_10s":     {"family": "adv_mbo", "dtype": "float", "nullable": True},
    "adv_queue_deterioration_ask_10s":     {"family": "adv_mbo", "dtype": "float", "nullable": True},
    "adv_pull_cascade_count_10s":          {"family": "adv_mbo", "dtype": "float", "nullable": True},
    "adv_lifetime_p50_ms":                 {"family": "adv_mbo", "dtype": "float", "nullable": True},

    # Categoricals
    "setup_type":       {"family": "categorical", "dtype": "str", "nullable": False, "default": "unknown"},
    "regime_at_entry":  {"family": "categorical", "dtype": "str", "nullable": False, "default": "unknown"},
}

# ─── Feature families (derived from metadata) ────────────────────────────────

FEATURE_FAMILIES: dict[str, list[str]] = {}
for _feat, _meta in FEATURE_METADATA.items():
    FEATURE_FAMILIES.setdefault(_meta["family"], []).append(_feat)

# ─── LOB field mapping (lob_snapshots.jsonl → registry names) ─────────────────
# Used by dataset builder to map snapshot field names to canonical feature names.

LOB_SNAPSHOT_FIELD_MAP: dict[str, str] = {
    "spread_ticks":               "lob_spread_ticks",
    "bid_size":                   "lob_bid_size",
    "ask_size":                   "lob_ask_size",
    "depth_imbalance_5":          "lob_depth_imbalance_5",
    "depth_imbalance_10":         "lob_depth_imbalance_10",
    "total_bid_depth_10lvl":      "lob_total_bid_depth_10lvl",
    "total_ask_depth_10lvl":      "lob_total_ask_depth_10lvl",
    "cumulative_delta_10s":       "lob_cumulative_delta_10s",
    "cumulative_delta_30s":       "lob_cumulative_delta_30s",
    "cumulative_delta_60s":       "lob_cumulative_delta_60s",
    "trade_flow_imbalance_10s":   "lob_trade_flow_imbalance_10s",
    "trade_flow_imbalance_30s":   "lob_trade_flow_imbalance_30s",
    "cancel_add_ratio_10s":       "lob_cancel_add_ratio_10s",
    "replenishment_rate_10s":     "lob_replenishment_rate_10s",
    "absorption_rate_10s":        "lob_absorption_rate_10s",
    "sweep_count_10s":            "lob_sweep_count_10s",
    # Advanced MBO fields already match registry names
    "adv_cancel_replace_ratio_10s":    "adv_cancel_replace_ratio_10s",
    "adv_modify_rate_10s":             "adv_modify_rate_10s",
    "adv_iceberg_suspicion_30s":       "adv_iceberg_suspicion_30s",
    "adv_queue_deterioration_bid_10s": "adv_queue_deterioration_bid_10s",
    "adv_queue_deterioration_ask_10s": "adv_queue_deterioration_ask_10s",
    "adv_pull_cascade_count_10s":      "adv_pull_cascade_count_10s",
    "adv_lifetime_p50_ms":             "adv_lifetime_p50_ms",
}

# Validate metadata at import time
assert set(FEATURE_METADATA.keys()) == set(ALL_FEATURES), \
    f"FEATURE_METADATA keys don't match ALL_FEATURES: " \
    f"missing={set(ALL_FEATURES) - set(FEATURE_METADATA.keys())}, " \
    f"extra={set(FEATURE_METADATA.keys()) - set(ALL_FEATURES)}"
assert set(LOB_SNAPSHOT_FIELD_MAP.values()) == set(LOB_NUMERIC_FEATURES + ADVANCED_MBO_FEATURES), \
    "LOB_SNAPSHOT_FIELD_MAP values don't cover all LOB + advanced MBO features"
