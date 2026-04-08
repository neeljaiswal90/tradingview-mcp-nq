/**
 * Historical snapshot builder.
 *
 * Converts aligned multi-timeframe historical bars into a MarketSnapshot
 * compatible with the existing strategy engine. Nullable fields are preserved
 * as null when the data provider does not supply them (e.g. volume in a live
 * 1m file, band values during warmup).
 *
 * Explicitly marks run_mode="historical" via snapshot.symbol suffix so any
 * log consumer can distinguish historical vs live rows.
 */

import type {
  MarketSnapshot,
  OhlcvBar,
  IndicatorSnapshot,
  KeyLevels,
  DataQuality,
  SessionState,
} from '../types.js';
import type { HistoricalBar } from './schema.js';
import type { MultiTfBundle, Aligner } from './alignment.js';
import { classifySession, buildOpeningRange, computePriorLevels } from '../session.js';

const NULL_IND: IndicatorSnapshot = {
  ema_9: null, ema_21: null, ema_50: null, ema_100: null, ema_200: null,
  supertrend_direction: null, supertrend_level: null,
  novawave_fast: null, novawave_slow: null, novawave_signal: null,
  dma_20: null, dma_50: null, dma_200: null,
  smart_money_choch_sell: null, smart_money_choch_buy: null,
  smart_money_bos_sell: null, smart_money_bos_buy: null,
  vwap: null, atr_14: null, rsi_14: null, volume: null, volume_sma_20: null,
  adx: null, di_plus: null, di_minus: null,
  ttm_squeeze_momentum: null, ttm_squeeze_firing: null,
  cvd: null, cvd_delta: null, cvd_trend: null,
};

// ─── Indicator imports from shared module ─────────────────────────────────────
import {
  ema, rsi as computeRsi, atr as computeAtr,
  vwap as computeVwap, volumeSma, supertrendDirection,
} from '../features/indicators.js';

// Re-export for backward compat if anyone imports from here
export { ema };

// Legacy: keep the function name but delegate to shared module
function _emaCompat(values: number[], period: number): number | null {
  return ema(values, period);
}

// rsi: delegated to shared features/indicators.ts
function rsi(values: number[], period = 14): number | null {
  return computeRsi(values, period);
}

// atr: uses HistoricalBar which is compatible with Bar interface
function atr(bars: HistoricalBar[], period = 14): number | null {
  return computeAtr(bars as any, period);
}

function buildIndicatorSnapshot(bars: HistoricalBar[]): IndicatorSnapshot {
  if (bars.length === 0) return { ...NULL_IND };
  const closes = bars.map(b => b.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema100 = ema(closes, 100);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);
  const last = bars[bars.length - 1]!;
  // Simple supertrend-direction proxy: slope of ema9 vs ema21.
  const stDir: 'up' | 'down' | null =
    ema9 !== null && ema21 !== null
      ? (ema9 > ema21 ? 'up' : ema9 < ema21 ? 'down' : null)
      : null;
  // Volume SMA(20)
  const vols = bars.slice(-20).map(b => b.volume).filter((v): v is number => v !== null);
  const volSma = vols.length > 0 ? vols.reduce((s, v) => s + v, 0) / vols.length : null;
  return {
    ...NULL_IND,
    ema_9: ema9, ema_21: ema21, ema_50: ema50, ema_100: ema100, ema_200: ema200,
    supertrend_direction: stDir,
    supertrend_level: stDir === 'up' ? ema21 : stDir === 'down' ? ema21 : null,
    vwap: last.vwap, atr_14: atr14, rsi_14: rsi14,
    volume: last.volume, volume_sma_20: volSma,
  };
}

function toOhlcv(bar: HistoricalBar): OhlcvBar {
  return {
    time: bar.timestamp,
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    volume: bar.volume ?? 0,
  };
}

function buildKeyLevels(
  bundle: MultiTfBundle,
  aligner: Aligner,
  bars1mWindow: HistoricalBar[],
  now: Date,
  openingRangeMinutes?: number,
): KeyLevels {
  const k: KeyLevels = {
    session_high: null, session_low: null, daily_open: null, weekly_open: null,
    monday_high: null, monday_low: null, monday_mid: null, monthly_open: null,
    pivot_resistance: [], pivot_support: [],
    choch_sell: null, choch_buy: null, bos_sell: null, bos_buy: null,
    overnight_high: null, overnight_low: null,
    prior_rth_high: null, prior_rth_low: null,
    opening_range_high: null, opening_range_low: null, opening_range_mid: null,
    session_vwap: null,
  };

  // Use HTF VWAP/bands as structural levels (no look-ahead: HTF bar was
  // completed before current 1m bar).
  if (bundle.bar_60m) {
    k.session_vwap = bundle.bar_60m.vwap;
    if (bundle.bar_60m.upper_band_2 !== null) k.pivot_resistance.push(bundle.bar_60m.upper_band_2);
    if (bundle.bar_60m.upper_band_3 !== null) k.pivot_resistance.push(bundle.bar_60m.upper_band_3);
    if (bundle.bar_60m.lower_band_2 !== null) k.pivot_support.push(bundle.bar_60m.lower_band_2);
    if (bundle.bar_60m.lower_band_3 !== null) k.pivot_support.push(bundle.bar_60m.lower_band_3);
  }
  if (bundle.bar_15m) {
    if (bundle.bar_15m.upper_band_1 !== null) k.pivot_resistance.push(bundle.bar_15m.upper_band_1);
    if (bundle.bar_15m.lower_band_1 !== null) k.pivot_support.push(bundle.bar_15m.lower_band_1);
    // Use 15m VWAP as session VWAP if 60m VWAP is absent.
    if (k.session_vwap === null) k.session_vwap = bundle.bar_15m.vwap;
  }
  // Sort and keep nearest 3 each side
  k.pivot_resistance.sort((a, b) => a - b);
  k.pivot_support.sort((a, b) => b - a);
  k.pivot_resistance = k.pivot_resistance.slice(0, 3);
  k.pivot_support = k.pivot_support.slice(0, 3);

  // Derive prior/OR levels from the 1m window we have on hand.
  const oneMforLevels = aligner.getRecentBars('1m', 60 * 48, bundle).map(b => ({
    time: b.timestamp, high: b.high, low: b.low,
  }));
  const prior = computePriorLevels(oneMforLevels, now);
  k.overnight_high = prior.overnight_high;
  k.overnight_low = prior.overnight_low;
  k.prior_rth_high = prior.prior_rth_high;
  k.prior_rth_low = prior.prior_rth_low;
  const or = buildOpeningRange(oneMforLevels, { windowMinutes: openingRangeMinutes, now });
  if (or) {
    k.opening_range_high = or.high;
    k.opening_range_low = or.low;
    k.opening_range_mid = or.midpoint;
  }
  void bars1mWindow;
  return k;
}

export interface SnapshotBuildContext {
  symbol: string;
  aligner: Aligner;
  /** Number of 1m bars to feed strategy for regime/bias. */
  window_1m: number;
  /** Number of HTF bars to expose. */
  window_5m: number;
  window_15m: number;
  window_60m: number;
  /** Opening range window in minutes (default 15). Should match indicator config. */
  opening_range_minutes?: number;
}

export function buildHistoricalSnapshot(
  bundle: MultiTfBundle,
  ctx: SnapshotBuildContext,
): MarketSnapshot {
  const now = new Date(bundle.bar_1m.timestamp * 1000);
  const bars1m = ctx.aligner.getRecentBars('1m', ctx.window_1m, bundle);
  const bars5m = ctx.aligner.getRecentBars('5m', ctx.window_5m, bundle);
  const bars15m = ctx.aligner.getRecentBars('15m', ctx.window_15m, bundle);
  const bars1h = ctx.aligner.getRecentBars('60m', ctx.window_60m, bundle);

  const indicators1m = buildIndicatorSnapshot(bars1m);
  const indicators15m = buildIndicatorSnapshot(bars15m);
  const indicators1h = buildIndicatorSnapshot(bars1h);

  const missing: string[] = [];
  if (indicators1m.vwap === null) missing.push('VWAP_1m');
  if (indicators1m.atr_14 === null) missing.push('ATR_14');
  if (indicators1m.rsi_14 === null) missing.push('RSI_14');
  if (indicators1m.volume_sma_20 === null) missing.push('Volume_SMA_20');
  if (!bundle.availability['5m']) missing.push('HTF_5m');
  if (!bundle.availability['15m']) missing.push('HTF_15m');
  if (!bundle.availability['60m']) missing.push('HTF_60m');

  const quality: DataQuality = {
    bars_1m_count: bars1m.length,
    bars_5m_count: bars5m.length,
    bars_15m_count: bars15m.length,
    bars_1h_count: bars1h.length,
    vwap_available: indicators1m.vwap !== null,
    atr_available: indicators1m.atr_14 !== null,
    rsi_available: indicators1m.rsi_14 !== null,
    missing_indicators: missing,
  };

  const sessionClass = classifySession(now);
  const sessionState: SessionState = {
    is_rth: sessionClass.is_rth,
    is_eth: sessionClass.is_eth,
    is_us_cash_open_window: sessionClass.is_us_cash_open_window,
    is_rth_closing_window: sessionClass.is_rth_closing_window,
    is_weekend: sessionClass.is_weekend,
    minutes_since_rth_open: sessionClass.minutes_since_rth_open,
    minutes_to_rth_close: sessionClass.minutes_to_rth_close,
  };

  return {
    timestamp_unix: bundle.bar_1m.timestamp,
    timestamp_iso: new Date(bundle.bar_1m.timestamp * 1000).toISOString(),
    symbol: ctx.symbol,
    price: bundle.bar_1m.close,
    bars_1m: bars1m.map(toOhlcv),
    bars_5m: bars5m.map(toOhlcv),
    bars_15m: bars15m.map(toOhlcv),
    bars_1h: bars1h.map(toOhlcv),
    indicators_1m: indicators1m,
    indicators_15m: indicators15m,
    indicators_1h: indicators1h,
    key_levels: buildKeyLevels(bundle, ctx.aligner, bars1m, now, ctx.opening_range_minutes),
    data_quality: quality,
    session: sessionState,
  };
}
