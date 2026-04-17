"""
compute.py — Feature computation functions.

SINGLE SOURCE OF TRUTH for all LOB/MBO feature formulas.
Used by both the live sidecar and the offline dataset builder.

Never duplicate these formulas — always import from here.
"""

from __future__ import annotations

import time
from typing import Optional

from .schema import LobFeatureSnapshot, ScalpState
from .rolling import RollingTradeBuffer, RollingDepthState, RollingMboAggregator, RollingScalpState
from .advanced_mbo import AdvancedMboAnalyzer
from .microstructure import (
    AbsorptionDetector, SweepDetector, FootprintTracker,
    LargeTradeTracker, SessionVolumeProfile,
)

NQ_TICK_SIZE = 0.25


def _weighted_queue_imbalance(
    bids: list[tuple[float, int]],
    asks: list[tuple[float, int]],
    levels: int,
) -> Optional[float]:
    if levels <= 0:
        return None
    weighted_bid = 0.0
    weighted_ask = 0.0
    total = 0.0
    for idx in range(levels):
        weight = 1.0 / float(idx + 1)
        if idx < len(bids):
            bid_sz = bids[idx][1]
            weighted_bid += weight * bid_sz
            total += weight * bid_sz
        if idx < len(asks):
            ask_sz = asks[idx][1]
            weighted_ask += weight * ask_sz
            total += weight * ask_sz
    if total <= 0:
        return None
    return round((weighted_bid - weighted_ask) / total, 4)


def _build_scalp_state(
    bid: Optional[float],
    ask: Optional[float],
    bid_size: Optional[int],
    ask_size: Optional[int],
    depth: RollingDepthState,
    scalp_state_tracker: Optional[RollingScalpState],
    now_ms: int,
    spread_ticks: Optional[int],
) -> Optional[ScalpState]:
    if bid is None or ask is None or bid_size is None or ask_size is None:
        return None
    if bid <= 0 or ask <= bid or bid_size <= 0 or ask_size <= 0:
        return None

    top_bids = depth.top_n_bid(5)
    top_asks = depth.top_n_ask(5)
    if not top_bids:
        top_bids = [(bid, bid_size)]
    if not top_asks:
        top_asks = [(ask, ask_size)]

    microprice = round((ask * bid_size + bid * ask_size) / float(bid_size + ask_size), 4)
    mid = (bid + ask) / 2.0
    microprice_edge_ticks = round((microprice - mid) / NQ_TICK_SIZE, 4)

    flow = scalp_state_tracker.current_features(now_ms) if scalp_state_tracker is not None else {
        "ofi_250ms": None,
        "ofi_1s": None,
        "ofi_3s": None,
        "z_ofi_250ms": None,
        "z_ofi_1s": None,
        "z_ofi_3s": None,
        "sigma_1s_ticks": None,
    }

    return ScalpState(
        bid_px=[round(px, 2) for px, _ in top_bids],
        ask_px=[round(px, 2) for px, _ in top_asks],
        bid_sz=[int(sz) for _, sz in top_bids],
        ask_sz=[int(sz) for _, sz in top_asks],
        microprice=microprice,
        microprice_edge_ticks=microprice_edge_ticks,
        qi_1=_weighted_queue_imbalance(top_bids, top_asks, 1),
        qi_3=_weighted_queue_imbalance(top_bids, top_asks, 3),
        qi_5=_weighted_queue_imbalance(top_bids, top_asks, 5),
        ofi_250ms=flow["ofi_250ms"],
        ofi_1s=flow["ofi_1s"],
        ofi_3s=flow["ofi_3s"],
        z_ofi_250ms=flow["z_ofi_250ms"],
        z_ofi_1s=flow["z_ofi_1s"],
        z_ofi_3s=flow["z_ofi_3s"],
        sigma_1s_ticks=flow["sigma_1s_ticks"],
        spread_ticks=spread_ticks,
    )


def compute_lob_features(
    bid: Optional[float],
    ask: Optional[float],
    bid_size: Optional[int],
    ask_size: Optional[int],
    trade_buf: RollingTradeBuffer,
    depth: RollingDepthState,
    mbo_agg: RollingMboAggregator,
    now: Optional[float] = None,
    recording_context: str = "session",
    trade_id: Optional[str] = None,
    signal_id: Optional[str] = None,
    advanced_mbo: Optional[AdvancedMboAnalyzer] = None,
    absorption: Optional[AbsorptionDetector] = None,
    sweeps: Optional[SweepDetector] = None,
    footprint: Optional[FootprintTracker] = None,
    large_trades: Optional[LargeTradeTracker] = None,
    volume_profile: Optional[SessionVolumeProfile] = None,
    current_price: Optional[float] = None,
    scalp_state_tracker: Optional[RollingScalpState] = None,
) -> LobFeatureSnapshot:
    """
    Compute the full feature snapshot from current state.

    This function is deterministic: same inputs -> same outputs.
    Called by both live sidecar (real-time) and offline replay (historical).
    """
    now = now or time.time()
    snap = LobFeatureSnapshot()

    # ── Metadata ──────────────────────────────────────────────────────────────
    snap.timestamp_ms = int(now * 1000)
    snap.recording_context = recording_context
    snap.trade_id = trade_id
    snap.signal_id = signal_id

    # ── BBO ───────────────────────────────────────────────────────────────────
    snap.bid = bid
    snap.ask = ask
    snap.bid_size = bid_size
    snap.ask_size = ask_size

    if bid is not None and ask is not None:
        snap.mid = round((bid + ask) / 2, 2)
        sp = round(ask - bid, 2)
        snap.spread_pts = sp
        snap.spread_ticks = max(0, round(sp / NQ_TICK_SIZE))

        # Determine data quality
        if depth.last_update_ts > 0 and (now - depth.last_update_ts) < 5.0:
            snap.data_quality = "full_depth"
        else:
            snap.data_quality = "bbo_only"

        snap.bbo_age_ms = 0  # computed fresh
    else:
        snap.data_quality = "unavailable" if bid is None else "stale"
        snap.bbo_age_ms = 99999

    snap.scalp_state = _build_scalp_state(
        bid=bid,
        ask=ask,
        bid_size=bid_size,
        ask_size=ask_size,
        depth=depth,
        scalp_state_tracker=scalp_state_tracker,
        now_ms=snap.timestamp_ms,
        spread_ticks=snap.spread_ticks,
    )

    # ── Depth ─────────────────────────────────────────────────────────────────
    if depth.bids or depth.asks:
        snap.depth_imbalance_5 = depth.depth_imbalance(5)
        snap.depth_imbalance_10 = depth.depth_imbalance(10)
        snap.total_bid_depth_10lvl = depth.total_depth("bid", 10)
        snap.total_ask_depth_10lvl = depth.total_depth("ask", 10)

        ref_price = snap.mid or bid or ask or 0
        if ref_price > 0:
            snap.large_bid_within_5pts = depth.has_large_order("bid", ref_price, 5.0)
            snap.large_ask_within_5pts = depth.has_large_order("ask", ref_price, 5.0)

    # ── Trade flow ────────────────────────────────────────────────────────────
    if trade_buf.count > 0:
        snap.cumulative_delta_10s = round(trade_buf.cumulative_delta(10, now), 1)
        snap.cumulative_delta_30s = round(trade_buf.cumulative_delta(30, now), 1)
        snap.cumulative_delta_60s = round(trade_buf.cumulative_delta(60, now), 1)
        snap.trade_flow_imbalance_10s = trade_buf.trade_flow_imbalance(10, now)
        snap.trade_flow_imbalance_30s = trade_buf.trade_flow_imbalance(30, now)

    # ── MBO aggregates ────────────────────────────────────────────────────────
    if mbo_agg.event_count > 0:
        snap.cancel_add_ratio_10s = mbo_agg.cancel_add_ratio(10, now)
        snap.replenishment_rate_10s = mbo_agg.replenishment_rate(10, now)
        snap.absorption_rate_10s = mbo_agg.absorption_rate(10, now)
        snap.mean_order_lifetime_top_book = mbo_agg.mean_order_lifetime_ms(10, now)
        snap.aggressor_penetration_10s = mbo_agg.aggressor_penetration(10, now)
        snap.sweep_count_10s = mbo_agg.sweep_count(10, now)

    # ── Advanced MBO features (optional layer) ────────────────────────────────
    if advanced_mbo is not None and advanced_mbo.enabled and advanced_mbo.event_count > 0:
        adv = advanced_mbo.compute_advanced_features(now)
        snap.adv_cancel_replace_ratio_10s = adv.get("adv_cancel_replace_ratio_10s")
        snap.adv_modify_rate_10s = adv.get("adv_modify_rate_10s")
        snap.adv_iceberg_suspicion_30s = adv.get("adv_iceberg_suspicion_30s")
        snap.adv_queue_deterioration_bid_10s = adv.get("adv_queue_deterioration_bid_10s")
        snap.adv_queue_deterioration_ask_10s = adv.get("adv_queue_deterioration_ask_10s")
        snap.adv_pull_cascade_count_10s = adv.get("adv_pull_cascade_count_10s")
        snap.adv_lifetime_p50_ms = adv.get("adv_lifetime_p50_ms")

    # ── Microstructure: Absorption ────────────────────────────────────────────
    if absorption is not None:
        snap.absorption_score_10s = absorption.absorption_score(now)
        snap.absorption_bid_score_10s = absorption.absorption_bid_score(now)
        snap.absorption_ask_score_10s = absorption.absorption_ask_score(now)
        snap.strongest_absorption_price = absorption.strongest_absorption_price(now)

    # ── Microstructure: Sweeps ────────────────────────────────────────────────
    if sweeps is not None:
        snap.sweep_volume_10s = sweeps.sweep_volume(10, now)
        snap.max_sweep_levels_10s = sweeps.max_sweep_levels(10, now)
        snap.last_sweep_side = sweeps.last_sweep_side(now)

    # ── Microstructure: Footprint ─────────────────────────────────────────────
    if footprint is not None:
        snap.footprint_delta_30s = round(footprint.delta(30, now), 1)
        snap.footprint_delta_5s = round(footprint.delta(5, now), 1)
        snap.footprint_imbalance_ratio_30s = footprint.imbalance_ratio(30, now)
        snap.footprint_stacked_imbalance_count_30s = footprint.stacked_imbalance_count(30, now=now)
        snap.dominant_aggressor_side = footprint.dominant_aggressor(10, now)

    # ── Microstructure: Large Trades ──────────────────────────────────────────
    if large_trades is not None:
        snap.large_trade_count_10s = large_trades.count(10, now)
        snap.large_trade_volume_10s = large_trades.volume(10, now)
        snap.largest_trade_size_30s = large_trades.largest_size(30, now)
        snap.large_trade_buy_sell_imbalance_30s = large_trades.buy_sell_imbalance(30, now)

    # ── Microstructure: Volume Profile ────────────────────────────────────────
    if volume_profile is not None and volume_profile.level_count > 0:
        snap.session_vpoc = volume_profile.vpoc
        snap.session_vah = volume_profile.vah
        snap.session_val = volume_profile.val
        ref = current_price or snap.mid or snap.bid
        if ref is not None:
            snap.distance_to_vpoc = volume_profile.distance_to_vpoc(ref)
            snap.inside_value_area = volume_profile.inside_value_area(ref)

    return snap


def compute_mbo_features(
    mbo_agg: RollingMboAggregator,
    now: Optional[float] = None,
) -> dict:
    """
    Compute MBO-only aggregate features (subset of full snapshot).
    Useful for lightweight feature extraction when depth/BBO state is not needed.
    """
    now = now or time.time()
    return {
        "cancel_add_ratio_10s": mbo_agg.cancel_add_ratio(10, now),
        "replenishment_rate_10s": mbo_agg.replenishment_rate(10, now),
        "absorption_rate_10s": mbo_agg.absorption_rate(10, now),
        "mean_order_lifetime_top_book": mbo_agg.mean_order_lifetime_ms(10, now),
        "aggressor_penetration_10s": mbo_agg.aggressor_penetration(10, now),
        "sweep_count_10s": mbo_agg.sweep_count(10, now),
    }
