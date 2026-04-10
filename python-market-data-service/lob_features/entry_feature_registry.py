"""
entry_feature_registry.py — Canonical feature list for ENTRY ML models.

SEPARATE from management ML features (ml_feature_registry.py).
Entry features describe the market STATE at signal time, not position state.

Feature groups:
  1. Signal context — from strategy's DualDirectionResult
  2. Market structure — from TradingView slow-path snapshot
  3. Microstructure — from Bookmap/Rithmic sidecar
  4. Session context — time/event information
"""

from __future__ import annotations

# ─── Signal context (from strategy output) ────────────────────────────────────

SIGNAL_FEATURES: list[str] = [
    "direction_is_short",       # 1 if short, 0 if long
    "confidence_score",         # strategy confidence (0-10)
    "rr_t1",                    # risk:reward to target 1
    "rr_t2",                    # risk:reward to target 2
    "risk_pts",                 # stop distance in points
    "alignment_score",          # multi-TF alignment (0-4)
    "dual_score_margin",        # margin between long and short scores
    "entry_location_quality",   # how close price is to entry zone mid
]

# ─── Market structure (from TradingView slow-path snapshot) ───────────────────

STRUCTURE_FEATURES: list[str] = [
    "price_vs_vwap_pts",        # price - VWAP in points
    "price_vs_ema9_pts",        # price - EMA9
    "price_vs_ema21_pts",       # price - EMA21
    "ema_stack_bullish",        # 1 if EMA9 > EMA21 > EMA50
    "supertrend_confirms",      # 1 if SuperTrend aligns with direction
    "atr_14",                   # current ATR(14)
    "rsi_14",                   # current RSI(14)
    "distance_to_or_high_pts",  # distance to opening range high
    "distance_to_or_low_pts",   # distance to opening range low
    "distance_to_session_high_pts",
    "distance_to_session_low_pts",
]

# ─── Microstructure (from Bookmap/Rithmic sidecar) ───────────────────────────

MICROSTRUCTURE_FEATURES: list[str] = [
    "lob_spread_ticks",
    "lob_depth_imbalance_5",
    "lob_depth_imbalance_10",
    "lob_cumulative_delta_10s",
    "lob_cumulative_delta_30s",
    "lob_cumulative_delta_60s",
    "lob_trade_flow_imbalance_10s",
    "lob_trade_flow_imbalance_30s",
    "lob_large_bid_within_5pts",
    "lob_large_ask_within_5pts",
    "lob_cancel_add_ratio_10s",
    "lob_absorption_rate_10s",
    "lob_sweep_count_10s",
]

# ─── HTF zone context ────────────────────────────────────────────────────────

HTF_ZONE_FEATURES: list[str] = [
    "htf_inside_resistance_zone",   # 1 if price inside HTF resistance
    "htf_inside_support_zone",      # 1 if price inside HTF support
    "htf_distance_to_res_pts",      # signed offset to nearest resistance midpoint
    "htf_distance_to_sup_pts",      # signed offset to nearest support midpoint
    "htf_distance_to_res_atr",      # absolute distance to nearest resistance in ATR
    "htf_distance_to_sup_atr",      # absolute distance to nearest support in ATR
    "htf_first_obstacle_rr",        # room to first obstacle / risk_pts
    "htf_nearest_res_tf_ord",       # ordinal: 0=null, 1=15m, 2=1h, 3=4h
    "htf_nearest_sup_tf_ord",       # ordinal: 0=null, 1=15m, 2=1h, 3=4h
    "htf_breakout_accepted",        # 1 if price closed above zone top (long) / below bottom (short)
]

# ─── Session context ──────────────────────────────────────────────────────────

SESSION_FEATURES: list[str] = [
    "hour_utc",
    "minutes_since_rth_open",
    "is_rth",
    "is_opening_drive_window",  # first 15 min of RTH
]

# ─── Categorical features (native strings for CatBoost) ──────────────────────

ENTRY_CATEGORICAL_FEATURES: list[str] = [
    "setup_type",
    "regime_at_signal",
]

# ─── Combined ────────────────────────────────────────────────────────────────

ENTRY_NUMERIC_FEATURES: list[str] = (
    SIGNAL_FEATURES + STRUCTURE_FEATURES +
    MICROSTRUCTURE_FEATURES + HTF_ZONE_FEATURES + SESSION_FEATURES
)

ENTRY_ALL_FEATURES: list[str] = ENTRY_NUMERIC_FEATURES + ENTRY_CATEGORICAL_FEATURES

ENTRY_CAT_FEATURE_INDICES: list[int] = [
    ENTRY_ALL_FEATURES.index(c) for c in ENTRY_CATEGORICAL_FEATURES
]

ENTRY_FEATURE_SCHEMA_VERSION = "entry_v3_htf_zones"
ENTRY_FEATURE_COUNT = len(ENTRY_ALL_FEATURES)

# Validate at import time
assert len(set(ENTRY_ALL_FEATURES)) == len(ENTRY_ALL_FEATURES), "Duplicate entry feature names!"
