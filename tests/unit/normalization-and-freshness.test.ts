/**
 * Tests for spatial normalization policy and symmetric directional freshness.
 *
 * Covers:
 *   - Session-scale ATR computation (sqrt-of-time, session range, floor)
 *   - VWAP/room metrics no longer explode under normal trending conditions
 *   - Directional freshness is symmetric under mirrored inputs
 *   - Normalization diagnostics are present in extension features
 */
import { describe, it, expect } from 'vitest';
import { computeNormalizers, DEFAULT_NORMALIZATION_CONFIG } from '../../src/autotrade/features/normalization.js';
import { computeExtensionFeatures } from '../../src/autotrade/features/extension.js';
import { isTrendFresh } from '../../src/autotrade/strategy.js';
import type { MarketSnapshot } from '../../src/autotrade/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBar(price: number, idx: number) {
  return {
    time: 1700000000 + idx * 60,
    open: price - 1, high: price + 2, low: price - 2, close: price + 1,
    volume: 100,
  };
}

function makeSnap(price: number, overrides: {
  atr?: number; vwap?: number | null;
  session_high?: number; session_low?: number;
  supertrend?: 'up' | 'down';
  ema21?: number;
  bars_5m?: any[];
} = {}): MarketSnapshot {
  const bars = Array.from({ length: 30 }, (_, i) => makeBar(price - 15 + i, i));
  return {
    timestamp_unix: Date.now(), timestamp_iso: new Date().toISOString(),
    symbol: 'NQ', price,
    bars_1m: bars,
    bars_5m: overrides.bars_5m ?? [],
    bars_15m: [], bars_1h: [],
    indicators_1m: {
      ema_9: price - 2, ema_21: overrides.ema21 ?? price - 5, ema_50: price - 10,
      supertrend_direction: overrides.supertrend ?? 'up',
      supertrend_value: null,
      vwap: overrides.vwap ?? price - 3,
      atr_14: overrides.atr ?? 7,
      rsi_14: 55, volume_sma_20: 100,
      smart_money_choch_sell: null, smart_money_choch_buy: null,
      smart_money_bos_sell: null, smart_money_bos_buy: null,
      adx_14: null, adx_di_plus: null, adx_di_minus: null,
      cvd_value: null, ttm_squeeze_on: false,
    },
    indicators_1h: null,
    key_levels: {
      session_high: overrides.session_high ?? price + 200,
      session_low: overrides.session_low ?? price - 200,
      daily_open: null, weekly_open: null,
      opening_range_high: null, opening_range_low: null,
      pivot_resistance: [price + 50], pivot_support: [price - 50],
      prior_rth_high: price + 300, prior_rth_low: price - 300,
    },
    session: null, event: null,
  } as MarketSnapshot;
}

// ── Normalization Policy ─────────────────────────────────────────────────────

describe('computeNormalizers', () => {
  it('returns session ATR much larger than micro ATR', () => {
    // Narrow session range so sqrt-time estimate is used
    const snap = makeSnap(19500, { atr: 7, session_high: 19520, session_low: 19480 });
    const norms = computeNormalizers(snap);
    expect(norms).not.toBeNull();
    expect(norms!.micro_atr).toBe(7);
    // sqrt(60) * 7 ≈ 54.2 (session range 40 is smaller, so sqrt used)
    expect(norms!.session_atr).toBeGreaterThan(40);
    expect(norms!.session_atr).toBeLessThan(80);
    expect(norms!.session_atr_source).toBe('sqrt_time');
  });

  it('uses actual session range when larger than sqrt estimate', () => {
    // Session range = 500 pts (large trending day), sqrt estimate = 7*sqrt(60) ≈ 54
    const snap = makeSnap(19500, { atr: 7, session_high: 19750, session_low: 19250 });
    const norms = computeNormalizers(snap);
    expect(norms!.session_atr).toBe(500);
    expect(norms!.session_atr_source).toBe('session_range');
  });

  it('uses sqrt estimate when session range is small', () => {
    // Session range = 30 pts (pre-market), sqrt estimate ≈ 54
    const snap = makeSnap(19500, { atr: 7, session_high: 19515, session_low: 19485 });
    const norms = computeNormalizers(snap);
    expect(norms!.session_atr_source).toBe('sqrt_time');
    expect(norms!.session_atr).toBeGreaterThan(30);
  });

  it('applies floor when all estimates are tiny', () => {
    const snap = makeSnap(19500, { atr: 0.5, session_high: 19502, session_low: 19498 });
    const norms = computeNormalizers(snap);
    expect(norms!.session_atr).toBe(DEFAULT_NORMALIZATION_CONFIG.min_session_normalizer_pts);
    expect(norms!.session_atr_source).toBe('floor');
  });

  it('returns null when ATR is missing', () => {
    const snap = makeSnap(19500);
    snap.indicators_1m.atr_14 = null as any;
    const norms = computeNormalizers(snap);
    expect(norms).toBeNull();
  });

  // ── Room-scale normalizer ──────────────────────────────────────────────

  it('room_atr is between micro and session', () => {
    const snap = makeSnap(19500, { atr: 7, session_high: 19520, session_low: 19480 });
    const norms = computeNormalizers(snap);
    expect(norms!.room_atr).toBeGreaterThan(norms!.micro_atr);
    expect(norms!.room_atr).toBeLessThan(norms!.session_atr);
  });

  it('room_atr is sqrt(5) scaled from micro by default', () => {
    const snap = makeSnap(19500, { atr: 7, session_high: 19520, session_low: 19480 });
    const norms = computeNormalizers(snap);
    // 7 * sqrt(5) ≈ 15.65
    expect(norms!.room_atr).toBeCloseTo(15.65, 0);
    expect(norms!.room_atr_source).toBe('sqrt_time');
  });

  it('room_atr is capped on wide-range days', () => {
    // ATR=20, sqrt(5)*20 = 44.7 → capped at 40
    const snap = makeSnap(19500, { atr: 20, session_high: 19520, session_low: 19480 });
    const norms = computeNormalizers(snap);
    expect(norms!.room_atr).toBe(DEFAULT_NORMALIZATION_CONFIG.max_room_normalizer_pts);
    expect(norms!.room_atr_source).toBe('capped');
  });

  it('room_atr applies floor on thin conditions', () => {
    // ATR=2, sqrt(5)*2 = 4.47 → floored at 8
    const snap = makeSnap(19500, { atr: 2, session_high: 19502, session_low: 19498 });
    const norms = computeNormalizers(snap);
    expect(norms!.room_atr).toBe(DEFAULT_NORMALIZATION_CONFIG.min_room_normalizer_pts);
    expect(norms!.room_atr_source).toBe('floor');
  });
});

// ── Extension Feature Session-Scale Metrics ──────────────────────────────────

describe('Extension features with session-scale normalization', () => {
  it('VWAP distance is reasonable on a trending day', () => {
    // Price 400 pts from VWAP (normal trending day for NQ)
    // Old system: 400/7 = 57 ATR → absurd
    // New system: 400/54 ≈ 7.4 session-ATR → meaningful
    const snap = makeSnap(19900, { vwap: 19500, atr: 7 });
    const features = computeExtensionFeatures(snap, 19900, 'long');

    expect(features.dist_from_vwap_atr).toBeGreaterThan(50); // old: absurd
    expect(features.dist_from_vwap_session).toBeLessThan(10); // new: reasonable
    expect(features.dist_from_vwap_session).toBeGreaterThan(0);
  });

  it('room metrics use room scale (not session scale)', () => {
    const snap = makeSnap(19500, { atr: 7, session_high: 19600, session_low: 19400 });
    const features = computeExtensionFeatures(snap, 19500, 'long');

    // room_atr ≈ 7*sqrt(5) ≈ 15.7 (capped at 40 max)
    // session_atr with 200pt session range = 200
    // Upside room: nearest resistance ~50 pts
    // Room-scaled: 50/15.7 ≈ 3.2 (reasonable for room filter)
    // Session-scaled would be: 50/200 = 0.25 (absurdly low, would fail threshold 1.0)
    expect(features.upside_room_session).not.toBeNull();
    expect(features.upside_room_session!).toBeGreaterThan(1.0); // passes room filter
    expect(features.room_scale_atr).not.toBeNull();
    expect(features.room_scale_atr!).toBeLessThan(features.session_atr!); // room < session
  });

  it('normalization diagnostics are present', () => {
    const snap = makeSnap(19500, { atr: 7 });
    const features = computeExtensionFeatures(snap, 19500, 'long');
    expect(features.normalization_mode).toBeDefined();
    expect(features.session_atr).toBeGreaterThan(0);
    expect(features.micro_atr).toBe(7);
  });
});

// ── Symmetric Directional Freshness ──────────────────────────────────────────

describe('isTrendFresh: symmetric directional freshness', () => {
  // Helper: create 5m bars with specific high/low patterns
  function make5mBars(pattern: 'higher_lows' | 'lower_highs' | 'flat') {
    const base = 19500;
    if (pattern === 'higher_lows') {
      // Prior 3: lows at 100, 102, 104; Recent 3: lows at 106, 108, 110
      return [
        { time: 1, open: base, high: base + 20, low: base + 100, close: base + 15, volume: 100 },
        { time: 2, open: base, high: base + 20, low: base + 102, close: base + 15, volume: 100 },
        { time: 3, open: base, high: base + 20, low: base + 104, close: base + 15, volume: 100 },
        { time: 4, open: base, high: base + 20, low: base + 106, close: base + 15, volume: 100 },
        { time: 5, open: base, high: base + 20, low: base + 108, close: base + 15, volume: 100 },
        { time: 6, open: base, high: base + 20, low: base + 110, close: base + 15, volume: 100 },
      ];
    }
    if (pattern === 'lower_highs') {
      // Prior 3: highs at 110, 108, 106; Recent 3: highs at 104, 102, 100
      return [
        { time: 1, open: base, high: base - 100, low: base - 120, close: base - 115, volume: 100 },
        { time: 2, open: base, high: base - 102, low: base - 120, close: base - 115, volume: 100 },
        { time: 3, open: base, high: base - 104, low: base - 120, close: base - 115, volume: 100 },
        { time: 4, open: base, high: base - 106, low: base - 120, close: base - 115, volume: 100 },
        { time: 5, open: base, high: base - 108, low: base - 120, close: base - 115, volume: 100 },
        { time: 6, open: base, high: base - 110, low: base - 120, close: base - 115, volume: 100 },
      ];
    }
    // flat: same highs and lows
    return Array.from({ length: 6 }, (_, i) => ({
      time: i + 1, open: base, high: base + 10, low: base - 10, close: base, volume: 100,
    }));
  }

  it('long: fresh uptrend with higher lows', () => {
    const snap = makeSnap(19600, { supertrend: 'up', vwap: 19500 });
    snap.bars_5m = make5mBars('higher_lows');
    const result = isTrendFresh(snap, 'long');
    expect(result.fresh).toBe(true);
  });

  it('long: stale uptrend with flat/lower lows', () => {
    const snap = makeSnap(19600, { supertrend: 'up', vwap: 19500 });
    snap.bars_5m = make5mBars('flat');
    const result = isTrendFresh(snap, 'long');
    expect(result.fresh).toBe(false);
    expect(result.reason).toContain('stale_uptrend');
  });

  it('short: fresh downtrend with lower highs', () => {
    const snap = makeSnap(19400, { supertrend: 'down', vwap: 19500 });
    snap.bars_5m = make5mBars('lower_highs');
    const result = isTrendFresh(snap, 'short');
    expect(result.fresh).toBe(true);
  });

  it('short: stale downtrend with flat/higher highs', () => {
    const snap = makeSnap(19400, { supertrend: 'down', vwap: 19500 });
    snap.bars_5m = make5mBars('flat');
    const result = isTrendFresh(snap, 'short');
    expect(result.fresh).toBe(false);
    expect(result.reason).toContain('stale_downtrend');
  });

  it('long and short produce mirrored outcomes under mirrored conditions', () => {
    // Uptrend snap: price above VWAP, supertrend up, higher lows
    const upSnap = makeSnap(19600, { supertrend: 'up', vwap: 19500 });
    upSnap.bars_5m = make5mBars('higher_lows');
    const upResult = isTrendFresh(upSnap, 'long');

    // Downtrend snap: price below VWAP, supertrend down, lower highs
    const downSnap = makeSnap(19400, { supertrend: 'down', vwap: 19500 });
    downSnap.bars_5m = make5mBars('lower_highs');
    const downResult = isTrendFresh(downSnap, 'short');

    // Both should be fresh
    expect(upResult.fresh).toBe(true);
    expect(downResult.fresh).toBe(true);
  });

  it('VWAP gate: long fails when price below VWAP', () => {
    const snap = makeSnap(19400, { supertrend: 'up', vwap: 19500 });
    snap.bars_5m = make5mBars('higher_lows');
    const result = isTrendFresh(snap, 'long');
    expect(result.fresh).toBe(false);
    expect(result.reason).toContain('price_below_vwap');
  });

  it('VWAP gate: short fails when price above VWAP', () => {
    const snap = makeSnap(19600, { supertrend: 'down', vwap: 19500 });
    snap.bars_5m = make5mBars('lower_highs');
    const result = isTrendFresh(snap, 'short');
    expect(result.fresh).toBe(false);
    expect(result.reason).toContain('price_above_vwap');
  });

  it('SuperTrend gate: long stale when ST flipped down and price below EMA21', () => {
    const snap = makeSnap(19400, { supertrend: 'down', vwap: 19300, ema21: 19450 });
    snap.bars_5m = make5mBars('higher_lows');
    const result = isTrendFresh(snap, 'long');
    expect(result.fresh).toBe(false);
    expect(result.reason).toContain('supertrend_down');
  });

  it('SuperTrend gate: short stale when ST flipped up and price above EMA21', () => {
    const snap = makeSnap(19600, { supertrend: 'up', vwap: 19700, ema21: 19550 });
    snap.bars_5m = make5mBars('lower_highs');
    const result = isTrendFresh(snap, 'short');
    expect(result.fresh).toBe(false);
    expect(result.reason).toContain('supertrend_up');
  });
});
