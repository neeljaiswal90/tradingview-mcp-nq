"""
schemas.py — Pydantic request/response models for the ML management service.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ─── Request ──────────────────────────────────────────────────────────────────

class ManagementRequest(BaseModel):
    """Feature vector for a single management decision point."""

    # Trade identity (for logging/correlation, not used by model)
    trade_id: str = ""

    # Numeric features (all required by the model)
    is_short: int = Field(..., ge=0, le=1, description="1 if short, 0 if long")
    confidence_at_entry: float = Field(..., description="Signal confidence score at entry (0-10)")
    initial_risk_pts: float = Field(..., gt=0, description="Distance from entry to initial stop (points)")
    current_price: float = Field(..., gt=0)
    stop_current: float = Field(..., gt=0)
    quantity_remaining: float = Field(..., gt=0)
    pnl_pts: float = Field(..., description="Unrealized PnL in points")
    unrealized_r: float = Field(..., description="Current R-multiple")
    mfe_pts_so_far: float = Field(..., ge=0, description="Max favorable excursion so far (points)")
    mae_pts_so_far: float = Field(..., ge=0, description="Max adverse excursion so far (points)")
    time_in_trade_sec: int = Field(..., ge=0, description="Seconds since entry")
    distance_to_stop_pts: float = Field(..., ge=0, description="Distance from price to current stop")
    pt1_hit: int = Field(..., ge=0, le=1, description="1 if PT1 partial has been taken")
    pt2_hit: int = Field(..., ge=0, le=1, description="1 if PT2 partial has been taken")
    stop_at_breakeven: int = Field(..., ge=0, le=1, description="1 if stop moved to breakeven")
    trail_active: int = Field(..., ge=0, le=1, description="1 if trailing stop is active")
    trail_ratchet_count: int = Field(..., ge=0, description="Number of trail ratchets so far")
    management_events_count: int = Field(..., ge=0, description="Total management events so far")
    entry_hour_utc: int = Field(..., ge=0, le=23, description="Hour of entry (UTC)")
    tick_hour_utc: int = Field(..., ge=0, le=23, description="Current hour (UTC)")

    # LOB/MBO features (nullable — missing when sidecar unavailable)
    lob_spread_ticks: Optional[float] = Field(None, description="Bid-ask spread in ticks")
    lob_bid_size: Optional[float] = Field(None, description="Size at best bid")
    lob_ask_size: Optional[float] = Field(None, description="Size at best ask")
    lob_depth_imbalance_5: Optional[float] = Field(None, description="5-level depth imbalance [-1,1]")
    lob_depth_imbalance_10: Optional[float] = Field(None, description="10-level depth imbalance [-1,1]")
    lob_total_bid_depth_10lvl: Optional[float] = Field(None, description="Total bid depth, 10 levels")
    lob_total_ask_depth_10lvl: Optional[float] = Field(None, description="Total ask depth, 10 levels")
    lob_cumulative_delta_10s: Optional[float] = Field(None, description="Cumulative delta, 10s window")
    lob_cumulative_delta_30s: Optional[float] = Field(None, description="Cumulative delta, 30s window")
    lob_cumulative_delta_60s: Optional[float] = Field(None, description="Cumulative delta, 60s window")
    lob_trade_flow_imbalance_10s: Optional[float] = Field(None, description="Trade flow imbalance, 10s [0,1]")
    lob_trade_flow_imbalance_30s: Optional[float] = Field(None, description="Trade flow imbalance, 30s [0,1]")
    lob_cancel_add_ratio_10s: Optional[float] = Field(None, description="MBO cancel/add ratio, 10s")
    lob_replenishment_rate_10s: Optional[float] = Field(None, description="MBO replenishment rate, 10s")
    lob_absorption_rate_10s: Optional[float] = Field(None, description="MBO absorption rate, 10s")
    lob_sweep_count_10s: Optional[float] = Field(None, description="MBO sweep count, 10s")

    # Advanced MBO features (nullable — requires rich MBO data)
    adv_cancel_replace_ratio_10s: Optional[float] = Field(None, description="Advanced: cancel+replace/add ratio")
    adv_modify_rate_10s: Optional[float] = Field(None, description="Advanced: modify events / total events")
    adv_iceberg_suspicion_30s: Optional[float] = Field(None, description="Advanced: iceberg detection score")
    adv_queue_deterioration_bid_10s: Optional[float] = Field(None, description="Advanced: bid queue deterioration rate")
    adv_queue_deterioration_ask_10s: Optional[float] = Field(None, description="Advanced: ask queue deterioration rate")
    adv_pull_cascade_count_10s: Optional[float] = Field(None, description="Advanced: liquidity pull cascade count")
    adv_lifetime_p50_ms: Optional[float] = Field(None, description="Advanced: median order lifetime (ms)")

    # Categorical features (native strings for CatBoost)
    setup_type: str = Field(..., description="Setup type: trend_pullback_long, trend_pullback_short, etc.")
    regime_at_entry: str = Field(..., description="Market regime: trending_up, trending_down, range_bound, etc.")


# ─── Response ─────────────────────────────────────────────────────────────────

class ManagementAction(str, Enum):
    HOLD = "HOLD"
    EXIT_ALL = "EXIT_ALL"
    EXIT_PARTIAL = "EXIT_PARTIAL"
    MOVE_STOP = "MOVE_STOP"
    MOVE_TO_BREAKEVEN = "MOVE_TO_BREAKEVEN"
    NO_ACTION = "NO_ACTION"


class ManagementResponse(BaseModel):
    """Structured management decision from the ML model."""

    action: ManagementAction
    action_confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence in the action (0-1)")

    prob_hold: Optional[float] = Field(None, description="P(holding is better than exiting now)")
    prob_pt2_before_stop: Optional[float] = Field(None, description="P(PT2 fires before stop)")
    prob_continue_next_window: Optional[float] = Field(None, description="P(R improves in next 30-60s)")

    ev_hold_r: Optional[float] = Field(None, description="Expected remaining R if holding")
    ev_exit_now_r: Optional[float] = Field(None, description="Current unrealized R (exit now)")
    ev_reduce_r: Optional[float] = Field(None, description="Estimated R if reducing position")

    recommended_size_fraction: Optional[float] = Field(None, description="Fraction to exit if EXIT_PARTIAL")
    recommended_stop_price: Optional[float] = Field(None, description="Suggested stop price if MOVE_STOP")

    model_name: str = ""
    model_version: str = ""
    inference_ms: float = 0.0
    notes: list[str] = []

    # Tier selection info
    tier_used: Optional[str] = Field(None, description="Tier selected for this inference")
    fallback_reason: Optional[str] = Field(None, description="Reason for tier fallback if applicable")


# ─── Health ───────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    # Overall service status: "ok" | "degraded" | "incompatible"
    status: str
    uptime_sec: float

    # Management model
    model_loaded: bool
    model_name: str
    model_version: str

    # Feature contract
    feature_schema_version: str   # registry version the service was built against
    feature_count: int            # registry feature count
    schema_compatible: bool       # True only when artifact features match registry exactly
    schema_error: Optional[str]   # human-readable mismatch if schema_compatible is False

    # Entry model (stub until a real entry timing model is trained)
    entry_model_loaded: bool      # always False until a real entry model exists
    entry_model_status: str       # "stub_disabled" | "loaded" | "not_found"

    # Tiered model info
    loaded_model_dir: Optional[str] = None
    available_tiers: list[str] = []
    tier_feature_counts: dict[str, int] = {}
    loaded_at: Optional[str] = None
    model_file_paths: dict[str, str] = {}
    feature_schema_hash: Optional[str] = None


# ─── Entry Response ──────────────────────────────────────────────────────────

class EntryPredictionResponse(BaseModel):
    """Response from entry timing ML model."""
    confirmed: bool = True
    confidence: float = 0.0
    expected_r: Optional[float] = None
    entry_quality_prob: Optional[float] = None
    model_name: str = "none"
    inference_ms: float = 0.0
    reasons: list[str] = []


# ─── Entry Request ───────────────────────────────────────────────────────────

class EntryRequest(BaseModel):
    """Feature vector for entry timing confirmation.

    Must match EntryFeatureVector in src/autotrade/ml-entry/types.ts
    and entry_feature_registry.py exactly.
    """

    # Signal context
    direction_is_short: int = Field(..., ge=0, le=1, description="1 if short, 0 if long")
    confidence_score: float = Field(..., description="Strategy confidence score (0-10)")
    rr_t1: Optional[float] = Field(None, description="Risk:reward to target 1")
    rr_t2: Optional[float] = Field(None, description="Risk:reward to target 2")
    risk_pts: Optional[float] = Field(None, description="Stop distance in points")
    alignment_score: Optional[float] = Field(None, description="Multi-TF alignment (0-4)")
    dual_score_margin: Optional[float] = Field(None, description="Margin between long and short scores")
    entry_location_quality: Optional[float] = Field(None, description="How close price is to entry zone mid")

    # Market structure
    price_vs_vwap_pts: Optional[float] = Field(None, description="Price - VWAP in points")
    price_vs_ema9_pts: Optional[float] = Field(None, description="Price - EMA9")
    price_vs_ema21_pts: Optional[float] = Field(None, description="Price - EMA21")
    ema_stack_bullish: Optional[float] = Field(None, description="1 if EMA9 > EMA21 > EMA50")
    supertrend_confirms: Optional[float] = Field(None, description="1 if SuperTrend aligns with direction")
    atr_14: Optional[float] = Field(None, description="Current ATR(14)")
    rsi_14: Optional[float] = Field(None, description="Current RSI(14)")
    distance_to_or_high_pts: Optional[float] = Field(None, description="Distance to opening range high")
    distance_to_or_low_pts: Optional[float] = Field(None, description="Distance to opening range low")
    distance_to_session_high_pts: Optional[float] = Field(None, description="Distance to session high")
    distance_to_session_low_pts: Optional[float] = Field(None, description="Distance to session low")

    # Microstructure (nullable — missing when sidecar unavailable)
    lob_spread_ticks: Optional[float] = Field(None, description="Bid-ask spread in ticks")
    lob_depth_imbalance_5: Optional[float] = Field(None, description="5-level depth imbalance [-1,1]")
    lob_depth_imbalance_10: Optional[float] = Field(None, description="10-level depth imbalance [-1,1]")
    lob_cumulative_delta_10s: Optional[float] = Field(None, description="Cumulative delta, 10s window")
    lob_cumulative_delta_30s: Optional[float] = Field(None, description="Cumulative delta, 30s window")
    lob_cumulative_delta_60s: Optional[float] = Field(None, description="Cumulative delta, 60s window")
    lob_trade_flow_imbalance_10s: Optional[float] = Field(None, description="Trade flow imbalance, 10s [0,1]")
    lob_trade_flow_imbalance_30s: Optional[float] = Field(None, description="Trade flow imbalance, 30s [0,1]")
    lob_large_bid_within_5pts: Optional[float] = Field(None, description="Large bid size within 5pts")
    lob_large_ask_within_5pts: Optional[float] = Field(None, description="Large ask size within 5pts")
    lob_cancel_add_ratio_10s: Optional[float] = Field(None, description="MBO cancel/add ratio, 10s")
    lob_absorption_rate_10s: Optional[float] = Field(None, description="MBO absorption rate, 10s")
    lob_sweep_count_10s: Optional[float] = Field(None, description="MBO sweep count, 10s")

    # HTF zone context
    htf_inside_resistance_zone: Optional[int] = Field(None, ge=0, le=1, description="1 if inside HTF resistance")
    htf_inside_support_zone: Optional[int] = Field(None, ge=0, le=1, description="1 if inside HTF support")
    htf_distance_to_res_pts: Optional[float] = Field(None, description="Signed offset to nearest resistance midpoint")
    htf_distance_to_sup_pts: Optional[float] = Field(None, description="Signed offset to nearest support midpoint")
    htf_distance_to_res_atr: Optional[float] = Field(None, description="Absolute distance to nearest resistance in ATR")
    htf_distance_to_sup_atr: Optional[float] = Field(None, description="Absolute distance to nearest support in ATR")
    htf_first_obstacle_rr: Optional[float] = Field(None, description="Room to first obstacle / risk_pts")
    htf_nearest_res_tf_ord: int = Field(0, ge=0, le=3, description="Ordinal: 0=null, 1=15m, 2=1h, 3=4h")
    htf_nearest_sup_tf_ord: int = Field(0, ge=0, le=3, description="Ordinal: 0=null, 1=15m, 2=1h, 3=4h")
    htf_breakout_accepted: Optional[int] = Field(None, ge=0, le=1, description="1 if breakout above zone top (long) or below bottom (short)")

    # Session context
    hour_utc: int = Field(..., ge=0, le=23, description="Current hour UTC")
    minutes_since_rth_open: Optional[float] = Field(None, description="Minutes since RTH open")
    is_rth: int = Field(..., ge=0, le=1, description="1 if during RTH")
    is_opening_drive_window: int = Field(..., ge=0, le=1, description="1 if first 15 min of RTH")

    # Categorical features (native strings for CatBoost)
    setup_type: str = Field(..., description="Setup type: trend_pullback_long, breakout_retest_short, etc.")
    regime_at_signal: str = Field(..., description="Market regime: trending_up, trending_down, range_bound, etc.")
