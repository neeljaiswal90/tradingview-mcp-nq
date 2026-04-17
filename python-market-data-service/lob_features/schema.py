"""
schema.py — Canonical feature definitions for LOB/MBO microstructure data.

Every feature name, type, and description is defined here once.
Live sidecar, offline dataset builder, ML training, and TypeScript consumer
all reference this single schema.
"""

from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class ScalpState:
    """Compact book + flow state for the lob_mbo_scalp family."""

    bid_px: Optional[list[float]] = None
    ask_px: Optional[list[float]] = None
    bid_sz: Optional[list[int]] = None
    ask_sz: Optional[list[int]] = None

    microprice: Optional[float] = None
    microprice_edge_ticks: Optional[float] = None

    qi_1: Optional[float] = None
    qi_3: Optional[float] = None
    qi_5: Optional[float] = None

    ofi_250ms: Optional[float] = None
    ofi_1s: Optional[float] = None
    ofi_3s: Optional[float] = None
    z_ofi_250ms: Optional[float] = None
    z_ofi_1s: Optional[float] = None
    z_ofi_3s: Optional[float] = None

    # Deferred to a later sidecar extension. These stay null-safe on the wire.
    afi_250ms: Optional[float] = None
    afi_1s: Optional[float] = None
    afi_3s: Optional[float] = None
    hazard_bid_1s: Optional[float] = None
    hazard_ask_1s: Optional[float] = None
    abs_bid_1s: Optional[float] = None
    abs_ask_1s: Optional[float] = None
    refill_bid_1s: Optional[float] = None
    refill_ask_1s: Optional[float] = None

    sigma_1s_ticks: Optional[float] = None
    spread_ticks: Optional[int] = None

# ─── Feature Snapshot ─────────────────────────────────────────────────────────

@dataclass
class LobFeatureSnapshot:
    """Complete microstructure feature vector at a single point in time."""

    # ── Metadata ──────────────────────────────────────────────────────────────
    timestamp_ms: int = 0
    bbo_age_ms: float = 99999
    data_quality: str = "unavailable"  # full_depth | bbo_only | stale | unavailable
    recording_context: str = "session"  # session | trade | pre_entry | post_exit

    # ── BBO-derived (Phase 1) ─────────────────────────────────────────────────
    bid: Optional[float] = None
    ask: Optional[float] = None
    mid: Optional[float] = None
    bid_size: Optional[int] = None
    ask_size: Optional[int] = None
    spread_pts: Optional[float] = None
    spread_ticks: Optional[int] = None

    # ── Depth-derived ─────────────────────────────────────────────────────────
    depth_imbalance_5: Optional[float] = None   # (bid_depth - ask_depth) / total, 5 levels
    depth_imbalance_10: Optional[float] = None  # same, 10 levels
    total_bid_depth_10lvl: Optional[int] = None
    total_ask_depth_10lvl: Optional[int] = None
    large_bid_within_5pts: Optional[bool] = None
    large_ask_within_5pts: Optional[bool] = None

    # ── Trade-flow-derived ────────────────────────────────────────────────────
    cumulative_delta_10s: Optional[float] = None
    cumulative_delta_30s: Optional[float] = None
    cumulative_delta_60s: Optional[float] = None
    trade_flow_imbalance_10s: Optional[float] = None  # buy_vol / total_vol
    trade_flow_imbalance_30s: Optional[float] = None

    # ── MBO-derived aggregates ────────────────────────────────────────────────
    cancel_add_ratio_10s: Optional[float] = None
    replenishment_rate_10s: Optional[float] = None
    absorption_rate_10s: Optional[float] = None
    mean_order_lifetime_top_book: Optional[float] = None  # milliseconds
    aggressor_penetration_10s: Optional[float] = None     # avg levels penetrated
    sweep_count_10s: Optional[int] = None

    # ── Advanced MBO-derived (optional — requires rich MBO data) ────────────
    adv_cancel_replace_ratio_10s: Optional[float] = None
    adv_modify_rate_10s: Optional[float] = None
    adv_iceberg_suspicion_30s: Optional[float] = None
    adv_queue_deterioration_bid_10s: Optional[float] = None
    adv_queue_deterioration_ask_10s: Optional[float] = None
    adv_pull_cascade_count_10s: Optional[int] = None
    adv_lifetime_p50_ms: Optional[float] = None

    # ── Microstructure: Absorption ───────────────────────────────────────────
    absorption_score_10s: Optional[float] = None
    absorption_bid_score_10s: Optional[float] = None
    absorption_ask_score_10s: Optional[float] = None
    strongest_absorption_price: Optional[float] = None

    # ── Microstructure: Sweeps ────────────────────────────────────────────────
    sweep_volume_10s: Optional[int] = None
    max_sweep_levels_10s: Optional[int] = None
    last_sweep_side: Optional[str] = None

    # ── Microstructure: Footprint ─────────────────────────────────────────────
    footprint_delta_30s: Optional[float] = None
    footprint_delta_5s: Optional[float] = None
    footprint_imbalance_ratio_30s: Optional[float] = None
    footprint_stacked_imbalance_count_30s: Optional[int] = None
    dominant_aggressor_side: Optional[str] = None

    # ── Microstructure: Large Trades ──────────────────────────────────────────
    large_trade_count_10s: Optional[int] = None
    large_trade_volume_10s: Optional[int] = None
    largest_trade_size_30s: Optional[int] = None
    large_trade_buy_sell_imbalance_30s: Optional[float] = None

    # ── Microstructure: Volume Profile ────────────────────────────────────────
    session_vpoc: Optional[float] = None
    session_vah: Optional[float] = None
    session_val: Optional[float] = None
    distance_to_vpoc: Optional[float] = None
    inside_value_area: Optional[bool] = None

    # ── Correlation context (set by caller) ───────────────────────────────────
    trade_id: Optional[str] = None
    signal_id: Optional[str] = None
    scalp_state: Optional[ScalpState] = None

    def to_dict(self) -> dict:
        return asdict(self)


# ─── Feature name lists (for schema validation) ──────────────────────────────

BBO_FEATURE_NAMES = [
    "bid", "ask", "mid", "bid_size", "ask_size",
    "spread_pts", "spread_ticks",
]

DEPTH_FEATURE_NAMES = [
    "depth_imbalance_5", "depth_imbalance_10",
    "total_bid_depth_10lvl", "total_ask_depth_10lvl",
    "large_bid_within_5pts", "large_ask_within_5pts",
]

TRADE_FLOW_FEATURE_NAMES = [
    "cumulative_delta_10s", "cumulative_delta_30s", "cumulative_delta_60s",
    "trade_flow_imbalance_10s", "trade_flow_imbalance_30s",
]

MBO_FEATURE_NAMES = [
    "cancel_add_ratio_10s", "replenishment_rate_10s",
    "absorption_rate_10s", "mean_order_lifetime_top_book",
    "aggressor_penetration_10s", "sweep_count_10s",
]

ALL_FEATURE_NAMES = (
    BBO_FEATURE_NAMES + DEPTH_FEATURE_NAMES +
    TRADE_FLOW_FEATURE_NAMES + MBO_FEATURE_NAMES
)
