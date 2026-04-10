/**
 * ml-entry/feature-builder.ts — Build entry feature vectors from signal context.
 *
 * Uses strategy output + TradingView snapshot + LOB snapshot.
 * Feature names must match entry_feature_registry.py exactly.
 */

import type { MarketSnapshot, CandidateSetup, MultiTfBias, MarketRegime, HtfSetupEvaluation } from '../types.js';
import type { LobSnapshot } from '../lob-client.js';
import type { EntryFeatureVector } from './types.js';
import { htfTimeframeOrdinal } from '../features/htf-zones.js';

export function buildEntryFeatures(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  bias: MultiTfBias,
  regime: MarketRegime,
  confidence: number,
  dualScoreMargin: number,
  lobSnapshot?: LobSnapshot | null,
  htfEval?: HtfSetupEvaluation | null,
): EntryFeatureVector {
  const isShort = setup.direction === 'short';
  const ind = snap.indicators_1m;
  const kl = snap.key_levels;
  const price = snap.price;

  // Entry location quality
  const entryMid = (setup.entry_low + setup.entry_high) / 2;
  const entryLocQuality = setup.risk_pts > 0
    ? Math.round(Math.abs(price - entryMid) / setup.risk_pts * 10000) / 10000
    : null;

  // EMA stack
  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const emaStackBullish = (ema9 !== null && ema21 !== null && ema50 !== null)
    ? (ema9 > ema21 && ema21 > ema50 ? 1 : 0) : null;

  // SuperTrend confirmation
  const stConfirms = ind.supertrend_direction !== null
    ? ((isShort && ind.supertrend_direction === 'down') ||
       (!isShort && ind.supertrend_direction === 'up') ? 1 : 0)
    : null;

  // Session context
  const session = snap.session;
  const minutesSinceOpen = session?.minutes_since_rth_open ?? null;
  const isOpeningDrive = minutesSinceOpen !== null && minutesSinceOpen <= 15 ? 1 : 0;
  const hourUtc = new Date().getUTCHours();

  // LOB features
  const lob = lobSnapshot;
  const lobFresh = lob && lob.data_quality !== 'unavailable' && lob.bbo_age_ms < 5000;

  return {
    direction_is_short: isShort ? 1 : 0,
    confidence_score: confidence,
    rr_t1: setup.rr_t1,
    rr_t2: setup.rr_t2,
    risk_pts: setup.risk_pts,
    alignment_score: bias.alignment_score,
    dual_score_margin: dualScoreMargin,
    entry_location_quality: entryLocQuality,

    price_vs_vwap_pts: ind.vwap !== null ? Math.round((price - ind.vwap) * 100) / 100 : null,
    price_vs_ema9_pts: ema9 !== null ? Math.round((price - ema9) * 100) / 100 : null,
    price_vs_ema21_pts: ema21 !== null ? Math.round((price - ema21) * 100) / 100 : null,
    ema_stack_bullish: emaStackBullish,
    supertrend_confirms: stConfirms,
    atr_14: ind.atr_14,
    rsi_14: ind.rsi_14,
    distance_to_or_high_pts: kl.opening_range_high !== null ? Math.round((kl.opening_range_high - price) * 100) / 100 : null,
    distance_to_or_low_pts: kl.opening_range_low !== null ? Math.round((price - kl.opening_range_low) * 100) / 100 : null,
    distance_to_session_high_pts: kl.session_high !== null ? Math.round((kl.session_high - price) * 100) / 100 : null,
    distance_to_session_low_pts: kl.session_low !== null ? Math.round((price - kl.session_low) * 100) / 100 : null,

    lob_spread_ticks: lobFresh ? (lob.spread_ticks ?? null) : null,
    lob_depth_imbalance_5: lobFresh ? (lob.depth_imbalance_5 ?? null) : null,
    lob_depth_imbalance_10: lobFresh ? (lob.depth_imbalance_10 ?? null) : null,
    lob_cumulative_delta_10s: lobFresh ? (lob.cumulative_delta_10s ?? null) : null,
    lob_cumulative_delta_30s: lobFresh ? (lob.cumulative_delta_30s ?? null) : null,
    lob_cumulative_delta_60s: lobFresh ? (lob.cumulative_delta_60s ?? null) : null,
    lob_trade_flow_imbalance_10s: lobFresh ? (lob.trade_flow_imbalance_10s ?? null) : null,
    lob_trade_flow_imbalance_30s: lobFresh ? (lob.trade_flow_imbalance_30s ?? null) : null,
    lob_large_bid_within_5pts: lobFresh && lob.large_bid_within_5pts !== null ? (lob.large_bid_within_5pts ? 1 : 0) : null,
    lob_large_ask_within_5pts: lobFresh && lob.large_ask_within_5pts !== null ? (lob.large_ask_within_5pts ? 1 : 0) : null,
    lob_cancel_add_ratio_10s: lobFresh ? (lob.cancel_add_ratio_10s ?? null) : null,
    lob_absorption_rate_10s: lobFresh ? (lob.absorption_rate_10s ?? null) : null,
    lob_sweep_count_10s: lobFresh ? (lob.sweep_count_10s ?? null) : null,

    // HTF zone context
    htf_inside_resistance_zone: snap.htf_context?.inside_resistance_zone != null
      ? (snap.htf_context.inside_resistance_zone ? 1 : 0) : null,
    htf_inside_support_zone: snap.htf_context?.inside_support_zone != null
      ? (snap.htf_context.inside_support_zone ? 1 : 0) : null,
    htf_distance_to_res_pts: snap.htf_context?.nearest_resistance?.distance_pts ?? null,
    htf_distance_to_sup_pts: snap.htf_context?.nearest_support?.distance_pts ?? null,
    htf_distance_to_res_atr: snap.htf_context?.nearest_resistance?.distance_atr ?? null,
    htf_distance_to_sup_atr: snap.htf_context?.nearest_support?.distance_atr ?? null,
    htf_first_obstacle_rr: htfEval?.first_obstacle_rr ?? null,
    htf_nearest_res_tf_ord: htfTimeframeOrdinal(snap.htf_context?.nearest_resistance?.timeframe),
    htf_nearest_sup_tf_ord: htfTimeframeOrdinal(snap.htf_context?.nearest_support?.timeframe),
    htf_breakout_accepted: htfEval != null ? (htfEval.breakout_accepted ? 1 : 0) : null,

    hour_utc: hourUtc,
    minutes_since_rth_open: minutesSinceOpen,
    is_rth: session?.is_rth ? 1 : 0,
    is_opening_drive_window: isOpeningDrive,

    setup_type: setup.setup_type,
    regime_at_signal: regime,
  };
}
