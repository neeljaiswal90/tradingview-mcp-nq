/**
 * ml/feature-builder.ts — Build ML feature vectors from live position state.
 *
 * Uses ONLY information available at the current tick.
 * Feature order and names must exactly match the canonical registry at
 * python-market-data-service/lob_features/ml_feature_registry.py
 *
 * LOB features are populated from the LobSnapshot when the sidecar is
 * available. When unavailable, all LOB fields are null — CatBoost handles
 * missing values natively.
 */

import type { Position } from '../types.js';
import type { LobSnapshot } from '../lob-client.js';
import type { MlFeatureVector } from './types.js';

/**
 * Build a feature vector for the ML service from live position state.
 *
 * @param pos - Current open position
 * @param currentPrice - Latest quote price
 * @param lobSnapshot - Latest LOB snapshot (null if sidecar unavailable)
 * @param quoteTimeUtc - ISO timestamp of the quote (for hour extraction)
 */
export function buildMlFeatures(
  pos: Position,
  currentPrice: number,
  lobSnapshot?: LobSnapshot | null,
  quoteTimeUtc?: string,
): MlFeatureVector {
  const isShort = pos.side === 'short';
  const entryPrice = pos.entry_price;
  const initialRiskPts = Math.abs(entryPrice - pos.stop_initial);

  const pnlPts = isShort
    ? entryPrice - currentPrice
    : currentPrice - entryPrice;

  const unrealizedR = initialRiskPts > 0 ? pnlPts / initialRiskPts : 0;
  const distanceToStop = Math.abs(currentPrice - pos.stop_current);
  const timeInTradeSec = Math.round((Date.now() - pos.entry_time_unix) / 1000);

  const entryDate = new Date(pos.entry_time_iso);
  const entryHourUtc = entryDate.getUTCHours();
  const tickHourUtc = quoteTimeUtc
    ? new Date(quoteTimeUtc).getUTCHours()
    : new Date().getUTCHours();

  const managementEventsCount = pos.exit_legs.length;
  const trailRatchetCount = pos.trailing_active ? Math.max(0, managementEventsCount) : 0;

  // ── LOB features: populated from snapshot, null when unavailable ────────
  const lob = lobSnapshot;
  const lobFresh = lob && lob.data_quality !== 'unavailable' && lob.bbo_age_ms < 5000;

  return {
    trade_id: pos.trade_id,

    // Position-management features (v1)
    is_short: isShort ? 1 : 0,
    confidence_at_entry: pos.confidence,
    initial_risk_pts: Math.round(initialRiskPts * 100) / 100,
    current_price: currentPrice,
    stop_current: pos.stop_current,
    quantity_remaining: pos.quantity_remaining,
    pnl_pts: Math.round(pnlPts * 100) / 100,
    unrealized_r: Math.round(unrealizedR * 100) / 100,
    mfe_pts_so_far: Math.round(pos.max_favorable_excursion * 100) / 100,
    mae_pts_so_far: Math.round(pos.max_adverse_excursion * 100) / 100,
    time_in_trade_sec: timeInTradeSec,
    distance_to_stop_pts: Math.round(distanceToStop * 100) / 100,
    pt1_hit: pos.pt1_done ? 1 : 0,
    pt2_hit: pos.pt2_done ? 1 : 0,
    stop_at_breakeven: pos.stop_moved_to_be ? 1 : 0,
    trail_active: pos.trailing_active ? 1 : 0,
    trail_ratchet_count: trailRatchetCount,
    management_events_count: managementEventsCount,
    entry_hour_utc: entryHourUtc,
    tick_hour_utc: tickHourUtc,

    // LOB/MBO features (v2 — null when sidecar unavailable)
    lob_spread_ticks: lobFresh ? (lob.spread_ticks ?? null) : null,
    lob_bid_size: lobFresh ? (lob.bid_size ?? null) : null,
    lob_ask_size: lobFresh ? (lob.ask_size ?? null) : null,
    lob_depth_imbalance_5: lobFresh ? (lob.depth_imbalance_5 ?? null) : null,
    lob_depth_imbalance_10: lobFresh ? (lob.depth_imbalance_10 ?? null) : null,
    lob_total_bid_depth_10lvl: lobFresh ? (lob.total_bid_depth_10lvl ?? null) : null,
    lob_total_ask_depth_10lvl: lobFresh ? (lob.total_ask_depth_10lvl ?? null) : null,
    lob_cumulative_delta_10s: lobFresh ? (lob.cumulative_delta_10s ?? null) : null,
    lob_cumulative_delta_30s: lobFresh ? (lob.cumulative_delta_30s ?? null) : null,
    lob_cumulative_delta_60s: lobFresh ? (lob.cumulative_delta_60s ?? null) : null,
    lob_trade_flow_imbalance_10s: lobFresh ? (lob.trade_flow_imbalance_10s ?? null) : null,
    lob_trade_flow_imbalance_30s: lobFresh ? (lob.trade_flow_imbalance_30s ?? null) : null,
    lob_cancel_add_ratio_10s: lobFresh ? (lob.cancel_add_ratio_10s ?? null) : null,
    lob_replenishment_rate_10s: lobFresh ? (lob.replenishment_rate_10s ?? null) : null,
    lob_absorption_rate_10s: lobFresh ? (lob.absorption_rate_10s ?? null) : null,
    lob_sweep_count_10s: lobFresh ? (lob.sweep_count_10s ?? null) : null,

    // Advanced MBO features (v3 — null when analyzer unavailable)
    adv_cancel_replace_ratio_10s: lobFresh ? (lob.adv_cancel_replace_ratio_10s ?? null) : null,
    adv_modify_rate_10s: lobFresh ? (lob.adv_modify_rate_10s ?? null) : null,
    adv_iceberg_suspicion_30s: lobFresh ? (lob.adv_iceberg_suspicion_30s ?? null) : null,
    adv_queue_deterioration_bid_10s: lobFresh ? (lob.adv_queue_deterioration_bid_10s ?? null) : null,
    adv_queue_deterioration_ask_10s: lobFresh ? (lob.adv_queue_deterioration_ask_10s ?? null) : null,
    adv_pull_cascade_count_10s: lobFresh ? (lob.adv_pull_cascade_count_10s ?? null) : null,
    adv_lifetime_p50_ms: lobFresh ? (lob.adv_lifetime_p50_ms ?? null) : null,

    // Categoricals
    setup_type: pos.setup_type,
    regime_at_entry: pos.market_regime_at_entry,
  };
}
