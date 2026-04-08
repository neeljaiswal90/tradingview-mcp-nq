/**
 * Tests for the live indicator path rewiring.
 *
 * Verifies:
 * 1. buildLocalIndicatorSnapshot produces correct locally-computed values
 *    and leaves TV-only fields as null
 * 2. overlayTvStudyFields preserves local values and fills TV-only fields
 * 3. Source separation is correct (local takes precedence over TV for shared fields)
 * 4. Integration: data-collector.ts uses local computation for HTF snapshots
 */
import { describe, it, expect } from 'vitest';
import {
  buildLocalIndicatorSnapshot,
  overlayTvStudyFields,
} from '../../src/autotrade/data-collector.js';
import type { OhlcvBar } from '../../src/autotrade/types.js';

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeBar(close: number, i: number): OhlcvBar {
  return {
    time: 1700000000 + i * 60,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  };
}

/** 250 bars — enough for EMA 200, ADX, RSI */
const LONG_BARS = Array.from({ length: 250 }, (_, i) =>
  makeBar(24000 + Math.sin(i / 20) * 50, i)
);

/** Short bar set — insufficient for some indicators */
const SHORT_BARS = Array.from({ length: 10 }, (_, i) => makeBar(24000 + i, i));

// ─── buildLocalIndicatorSnapshot ────────────────────────────────────────────

describe('buildLocalIndicatorSnapshot', () => {
  it('computes EMA 9/21/50 from bars', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    expect(snap.ema_9).not.toBeNull();
    expect(snap.ema_21).not.toBeNull();
    expect(snap.ema_50).not.toBeNull();
    // EMA values should be in the ballpark of the price series
    expect(snap.ema_9!).toBeGreaterThan(23000);
    expect(snap.ema_9!).toBeLessThan(25000);
  });

  it('computes EMA 200 from sufficient bars', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    expect(snap.ema_200).not.toBeNull();
  });

  it('returns null for EMA 200 with insufficient bars', () => {
    const snap = buildLocalIndicatorSnapshot(SHORT_BARS);
    expect(snap.ema_200).toBeNull();
  });

  it('computes RSI 14', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    expect(snap.rsi_14).not.toBeNull();
    expect(snap.rsi_14!).toBeGreaterThan(0);
    expect(snap.rsi_14!).toBeLessThanOrEqual(100);
  });

  it('computes ATR 14', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    expect(snap.atr_14).not.toBeNull();
    expect(snap.atr_14!).toBeGreaterThan(0);
  });

  it('computes VWAP from bars', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    expect(snap.vwap).not.toBeNull();
    // VWAP should be close to the mean price
    expect(snap.vwap!).toBeGreaterThan(23000);
    expect(snap.vwap!).toBeLessThan(25000);
  });

  it('computes ADX/DI from bars', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    expect(snap.adx).not.toBeNull();
    expect(snap.di_plus).not.toBeNull();
    expect(snap.di_minus).not.toBeNull();
  });

  it('computes supertrend_direction as local proxy', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    expect(['up', 'down', null]).toContain(snap.supertrend_direction);
  });

  it('computes volume_sma_20', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    expect(snap.volume_sma_20).not.toBeNull();
    expect(snap.volume_sma_20!).toBeGreaterThan(0);
  });

  it('sets volume to last bar volume', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    const lastBar = LONG_BARS[LONG_BARS.length - 1]!;
    expect(snap.volume).toBe(lastBar.volume);
  });

  it('returns null for ALL tradingview_study fields', () => {
    const snap = buildLocalIndicatorSnapshot(LONG_BARS);
    // TV-only fields must all be null — no Pine Script dependency at HTF
    expect(snap.supertrend_level).toBeNull();
    expect(snap.novawave_fast).toBeNull();
    expect(snap.novawave_slow).toBeNull();
    expect(snap.smart_money_choch_sell).toBeNull();
    expect(snap.smart_money_choch_buy).toBeNull();
    expect(snap.smart_money_bos_sell).toBeNull();
    expect(snap.smart_money_bos_buy).toBeNull();
    expect(snap.ttm_squeeze_momentum).toBeNull();
    expect(snap.ttm_squeeze_firing).toBeNull();
    expect(snap.cvd).toBeNull();
    expect(snap.cvd_delta).toBeNull();
    expect(snap.cvd_trend).toBeNull();
  });

  it('returns null for empty bars without crashing', () => {
    const snap = buildLocalIndicatorSnapshot([]);
    expect(snap.ema_9).toBeNull();
    expect(snap.atr_14).toBeNull();
    expect(snap.vwap).toBeNull();
    expect(snap.volume).toBeNull();
  });
});

// ─── overlayTvStudyFields ─────────────────────────────────────────────────────

describe('overlayTvStudyFields', () => {
  const base = buildLocalIndicatorSnapshot(LONG_BARS);

  const tvVals: Record<string, number | null> = {
    'Volume': 5000,
    'CHoCH Sell': 24100,
    'CHoCH Buy': 23950,
    'BOS Sell': 24150,
    'BOS Buy': 23900,
    'NovaWave Fast EMA': 24010,
    'NovaWave Slow EMA': 23990,
    'Up Trend': 23980,    // SuperTrend level (up trend)
    'TTM Squeeze::Plot': 2.5,
    'CVD::CVD': 12345,
    'Volume delta for the bar': 300,
    'Up trend': 1,        // CVD direction
  };

  it('preserves local EMA values (not overridden by TV)', () => {
    const merged = overlayTvStudyFields(base, tvVals);
    expect(merged.ema_9).toBe(base.ema_9);
    expect(merged.ema_21).toBe(base.ema_21);
    expect(merged.ema_50).toBe(base.ema_50);
    expect(merged.ema_200).toBe(base.ema_200);
  });

  it('preserves local RSI, ATR, VWAP, ADX', () => {
    const merged = overlayTvStudyFields(base, tvVals);
    expect(merged.rsi_14).toBe(base.rsi_14);
    expect(merged.atr_14).toBe(base.atr_14);
    expect(merged.vwap).toBe(base.vwap);
    expect(merged.adx).toBe(base.adx);
    expect(merged.di_plus).toBe(base.di_plus);
    expect(merged.di_minus).toBe(base.di_minus);
  });

  it('preserves local supertrend_direction (not overridden)', () => {
    const merged = overlayTvStudyFields(base, tvVals);
    expect(merged.supertrend_direction).toBe(base.supertrend_direction);
  });

  it('fills SmartMoney BOS/CHoCH from TV values', () => {
    const merged = overlayTvStudyFields(base, tvVals);
    expect(merged.smart_money_choch_sell).toBe(24100);
    expect(merged.smart_money_choch_buy).toBe(23950);
    expect(merged.smart_money_bos_sell).toBe(24150);
    expect(merged.smart_money_bos_buy).toBe(23900);
  });

  it('fills NovaWave from TV values', () => {
    const merged = overlayTvStudyFields(base, tvVals);
    expect(merged.novawave_fast).toBe(24010);
    expect(merged.novawave_slow).toBe(23990);
  });

  it('fills SuperTrend level from TV Up Trend or Down Trend field', () => {
    const merged = overlayTvStudyFields(base, tvVals);
    expect(merged.supertrend_level).toBe(23980); // Up Trend value
  });

  it('fills TTM Squeeze momentum from TV', () => {
    const merged = overlayTvStudyFields(base, tvVals);
    expect(merged.ttm_squeeze_momentum).toBe(2.5);
    // TTM firing: |2.5| > 0.5 so not firing
    expect(merged.ttm_squeeze_firing).toBe(false);
  });

  it('detects TTM Squeeze firing when momentum is near zero', () => {
    const tvNearZero = { ...tvVals, 'TTM Squeeze::Plot': 0.3 };
    const merged = overlayTvStudyFields(base, tvNearZero);
    expect(merged.ttm_squeeze_firing).toBe(true);
  });

  it('fills CVD from TV values', () => {
    const merged = overlayTvStudyFields(base, tvVals);
    expect(merged.cvd).toBe(12345);
    expect(merged.cvd_delta).toBe(300);
    expect(merged.cvd_trend).toBe('up');
  });

  it('uses TV volume in preference to local when provided', () => {
    const merged = overlayTvStudyFields(base, tvVals);
    expect(merged.volume).toBe(5000); // TV volume
  });

  it('falls back to local volume when TV volume absent', () => {
    const tvNoVol = { ...tvVals };
    delete tvNoVol['Volume'];
    const merged = overlayTvStudyFields(base, tvNoVol);
    expect(merged.volume).toBe(base.volume);
  });

  it('leaves TV-only fields null when tvVals is empty', () => {
    const merged = overlayTvStudyFields(base, {});
    expect(merged.smart_money_choch_sell).toBeNull();
    expect(merged.novawave_fast).toBeNull();
    expect(merged.ttm_squeeze_momentum).toBeNull();
    expect(merged.cvd).toBeNull();
    // But local fields are still present
    expect(merged.ema_9).toBe(base.ema_9);
    expect(merged.atr_14).toBe(base.atr_14);
  });
});

// ─── Integration: source wiring in data-collector.ts ─────────────────────────

describe('Live indicator path wiring', () => {
  const collectorSource = require('fs').readFileSync('src/autotrade/data-collector.ts', 'utf8');

  it('imports computeIndicators from features/indicators', () => {
    expect(collectorSource).toContain("from './features/indicators.js'");
    expect(collectorSource).toContain('computeIndicators');
  });

  it('1m path uses buildLocalIndicatorSnapshot then overlayTvStudyFields', () => {
    expect(collectorSource).toContain('buildLocalIndicatorSnapshot(bars1m)');
    expect(collectorSource).toContain('overlayTvStudyFields(localIndicators1m, tvVals1m)');
  });

  it('15m cache-miss path drops getStudyValues — local only', () => {
    // Check that data.getStudyValues() is not called in the 15m cache-miss block
    // (use data.getStudyValues() to avoid matching comments that mention the method name)
    const start = collectorSource.indexOf("setTimeframe({ timeframe: '15'");
    const end = collectorSource.indexOf("setTimeframe({ timeframe: '60'");
    const block15m = collectorSource.slice(start, end);
    expect(block15m).not.toContain('data.getStudyValues()');
    expect(block15m).toContain('buildLocalIndicatorSnapshot');
  });

  it('1h cache-miss path drops getStudyValues — local only', () => {
    // The 1h block runs from the 60m setTimeframe call to cacheMisses.push('1h')
    const start = collectorSource.indexOf("setTimeframe({ timeframe: '60'");
    const end = collectorSource.indexOf("cacheMisses.push('1h')");
    const block1h = collectorSource.slice(start, end);
    expect(block1h).not.toContain('data.getStudyValues()');
    expect(block1h).toContain('buildLocalIndicatorSnapshot');
  });

  it('1m path keeps getStudyValues for TV-only studies', () => {
    // The 1m block still needs TV studies for SmartMoney/NovaWave/TTM/CVD
    const start = collectorSource.indexOf("timeframe: '1'");
    const end = collectorSource.indexOf("timeframe: '5'");
    const block1m = collectorSource.slice(start, end);
    expect(block1m).toContain('getStudyValues');
  });

  it('5m cache miss uses local computation', () => {
    const start = collectorSource.indexOf("timeframe: '5'");
    const end = collectorSource.indexOf("timeframe: '15'");
    const block5m = collectorSource.slice(start, end);
    expect(block5m).toContain('buildLocalIndicatorSnapshot');
    expect(block5m).not.toContain('getStudyValues');
  });

  it('indicator source distinction is documented in module header', () => {
    expect(collectorSource).toContain('local_computed');
    expect(collectorSource).toContain('tradingview_study');
  });
});
