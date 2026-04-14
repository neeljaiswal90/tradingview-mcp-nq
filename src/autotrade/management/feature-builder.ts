/**
 * feature-builder.ts — Builds a ManagementFeatures vector from live trade state.
 *
 * Called every monitor cycle immediately after the quote is validated.
 * All market-context fields are nullable: the probability engine must handle
 * missing data gracefully, lowering its confidence_in_estimate accordingly.
 */

import type { Position, IndicatorSnapshot, MarketRegime } from '../types.js';
import type { ManagementFeatures } from './types.js';

/**
 * Build the feature vector for the in-trade management layer.
 *
 * @param pos               The current open Position (position-manager.ts)
 * @param currentPrice      Fresh quote price (from QuoteService)
 * @param snap              The most recent IndicatorSnapshot (may be stale by 1 cycle)
 * @param regime            Last known market regime
 * @param sessionBucket     e.g. 'NY_AM' | 'NY_LUNCH' | 'NY_PM' | null
 * @param dailyLossPct      Positive drawdown magnitude from RiskManager.getState()
 * @param maxDailyLossPct   Max daily loss limit from config
 * @param accountEquity     Account equity for q_risk computation
 * @param maxRiskPerTradePct Max risk per trade (percent) for q_risk computation
 */
export function buildManagementFeatures(
  pos: Position,
  currentPrice: number,
  snap: IndicatorSnapshot | null,
  regime: MarketRegime | null,
  sessionBucket: string | null,
  dailyLossPct: number,
  maxDailyLossPct: number,
  accountEquity: number,
  maxRiskPerTradePct: number,
): ManagementFeatures {
  const isLong = pos.side === 'long';
  const initialRiskPts = Math.abs(pos.entry_price - pos.stop_initial);

  // ── R and PnL metrics ──────────────────────────────────────────────────────
  const unrealizedPts = isLong
    ? currentPrice - pos.entry_price
    : pos.entry_price - currentPrice;
  const current_r = initialRiskPts > 0 ? unrealizedPts / initialRiskPts : 0;
  const mfe_r = initialRiskPts > 0 ? pos.max_favorable_excursion / initialRiskPts : 0;
  const mae_r = initialRiskPts > 0 ? pos.max_adverse_excursion / initialRiskPts : 0;

  // ── Time ──────────────────────────────────────────────────────────────────
  const hold_seconds = Math.round((Date.now() - pos.entry_time_unix) / 1000);
  const time_stop_remaining_seconds = Math.max(
    0,
    pos.time_stop_minutes * 60 - hold_seconds,
  );

  // ── Distance to key levels ─────────────────────────────────────────────────
  // All signed from the perspective of the trade direction (positive = favorable distance)
  const distance_to_stop_pts = isLong
    ? currentPrice - pos.stop_current
    : pos.stop_current - currentPrice;

  const distance_to_t1_pts = isLong
    ? pos.target_1 - currentPrice
    : currentPrice - pos.target_1;

  const distance_to_t2_pts = isLong
    ? pos.target_2 - currentPrice
    : currentPrice - pos.target_2;

  // ATR-normalized distances
  const atr = snap?.atr_14 ?? null;
  const distance_to_stop_atr = atr && atr > 0 ? distance_to_stop_pts / atr : null;
  const distance_to_t1_atr = atr && atr > 0 ? distance_to_t1_pts / atr : null;
  const distance_to_t2_atr = atr && atr > 0 ? distance_to_t2_pts / atr : null;

  // ── VWAP ──────────────────────────────────────────────────────────────────
  const vwap = snap?.vwap ?? null;
  // Positive = price is on the favorable side of VWAP for the trade direction
  const vwap_distance_pts =
    vwap !== null
      ? isLong
        ? currentPrice - vwap
        : vwap - currentPrice
      : null;
  const vwap_distance_atr =
    vwap_distance_pts !== null && atr && atr > 0
      ? vwap_distance_pts / atr
      : null;

  // ── EMA alignment ─────────────────────────────────────────────────────────
  const ema9 = snap?.ema_9 ?? null;
  const ema21 = snap?.ema_21 ?? null;
  const ema50 = snap?.ema_50 ?? null;
  let ema_alignment: ManagementFeatures['ema_alignment'] = null;
  if (ema9 !== null && ema21 !== null && ema50 !== null) {
    if (ema9 > ema21 && ema21 > ema50) ema_alignment = 'bullish';
    else if (ema9 < ema21 && ema21 < ema50) ema_alignment = 'bearish';
    else ema_alignment = 'mixed';
  } else if (ema9 !== null && ema21 !== null) {
    ema_alignment = ema9 > ema21 ? 'bullish' : ema9 < ema21 ? 'bearish' : 'mixed';
  }
  const ema_9_21_gap_pts = ema9 !== null && ema21 !== null ? ema9 - ema21 : null;

  // ── Volume ratio ──────────────────────────────────────────────────────────
  const volume = snap?.volume ?? null;
  const volumeSma = snap?.volume_sma_20 ?? null;
  const volume_ratio =
    volume !== null && volumeSma !== null && volumeSma > 0
      ? volume / volumeSma
      : null;

  return {
    side: pos.side,
    setup_type: pos.setup_type,
    current_price: currentPrice,
    unrealized_pnl_pts: unrealizedPts,
    initial_risk_pts: initialRiskPts,
    current_r,
    mfe_r,
    mae_r,
    hold_seconds,
    time_stop_remaining_seconds,
    distance_to_stop_pts,
    distance_to_stop_atr,
    distance_to_t1_pts,
    distance_to_t1_atr,
    distance_to_t2_pts,
    distance_to_t2_atr,
    partial_exit_done: pos.partial_exit_done,
    pt1_done: pos.pt1_done,
    pt2_done: pos.pt2_done,
    quantity_remaining: pos.quantity_remaining,
    quantity_original: pos.quantity,
    realized_pnl_usd: pos.realized_pnl_so_far,
    atr_14: atr,
    adx: snap?.adx ?? null,
    di_plus: snap?.di_plus ?? null,
    di_minus: snap?.di_minus ?? null,
    rsi_14: snap?.rsi_14 ?? null,
    vwap_distance_pts,
    vwap_distance_atr,
    ema_alignment,
    ema_9_21_gap_pts,
    cvd_trend: snap?.cvd_trend ?? null,
    volume_ratio,
    regime,
    session_bucket: sessionBucket,
    ttm_squeeze_firing: snap?.ttm_squeeze_firing ?? null,
    daily_loss_pct: dailyLossPct,
    max_daily_loss_pct: maxDailyLossPct,
    account_equity: accountEquity,
    max_risk_per_trade_pct: maxRiskPerTradePct,
  };
}
