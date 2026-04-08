/**
 * Unit tests for three production fixes:
 *   1. shouldAllowTimeStop  — profit-aware time-stop gating
 *   2. isTargetSequenceValid — target ordering validation
 *   3. repairTargetOrdering  — target ordering repair
 *   4. scoreConfidence atStructure — structural level null-fallback fix
 */

import { describe, it, expect } from 'vitest';
import { shouldAllowTimeStop } from '../../src/autotrade/position-manager.js';
import {
  isTargetSequenceValid,
  repairTargetOrdering,
  scoreConfidence,
} from '../../src/autotrade/strategy.js';
import type { IndicatorConfig } from '../../src/autotrade/types.js';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const BASE_CONFIG: IndicatorConfig = {
  version: 'TEST',
  type: 'BASELINE',
  created_at: '2025-01-01T00:00:00Z',
  ema_fast: 9,
  ema_mid: 21,
  ema_slow: 50,
  rsi_period: 14,
  atr_period: 14,
  volume_sma_period: 20,
  min_confidence: 7.5,
  max_confidence: 9,
  min_rr: 2.5,
  max_risk_per_trade_pct: 0.5,
  max_daily_loss_pct: 1.5,
  max_consecutive_losses: 5,
  account_equity: 10_000,
  time_stop_minutes: 30,
  time_stop_max_r_pre_t1: 0.25,
  time_stop_max_r_post_t1: 1.0,
  analysis_interval_seconds: 10,
  in_position_monitor_seconds: 2,
  opening_range_minutes: 15,
  trail_ticks_post_t1: 12,
  enable_momentum_continuation: false,
  enable_opening_drive: true,
  enable_failed_or_break: true,
  dual_min_score: 7.5,
  dual_score_margin: 1.0,
  dual_choppy_extra_margin: 0.5,
};

// ─── 1. shouldAllowTimeStop ──────────────────────────────────────────────────

describe('shouldAllowTimeStop', () => {
  describe('PRE-T1 (partialExitDone=false)', () => {
    it('allows time stop when unrealizedR is at the threshold (0.25)', () => {
      const result = shouldAllowTimeStop(false, 0.25, 0.5, BASE_CONFIG);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('pre_t1');
    });

    it('allows time stop when unrealizedR is below the threshold (0.1)', () => {
      const result = shouldAllowTimeStop(false, 0.1, 0.3, BASE_CONFIG);
      expect(result.allowed).toBe(true);
    });

    it('allows time stop when trade is flat / slightly negative (-0.1)', () => {
      const result = shouldAllowTimeStop(false, -0.1, 0.1, BASE_CONFIG);
      expect(result.allowed).toBe(true);
    });

    it('BLOCKS time stop when unrealizedR is above threshold (0.5 > 0.25)', () => {
      const result = shouldAllowTimeStop(false, 0.5, 1.0, BASE_CONFIG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('pre_t1 protected');
    });

    it('BLOCKS time stop for a strong winner at +2.74R pre-T1 (Trade #7 scenario)', () => {
      // Trade #7: was at peak 2.74R, pulled back to 0.66R — must be blocked
      // (0.66 > 0.25 threshold → protected)
      const result = shouldAllowTimeStop(false, 0.66, 2.74, BASE_CONFIG);
      expect(result.allowed).toBe(false);
    });
  });

  describe('POST-T1 (partialExitDone=true, stop at BE)', () => {
    it('allows time stop when stalled near breakeven (0.3R <= 1.0 threshold)', () => {
      const result = shouldAllowTimeStop(true, 0.3, 1.5, BASE_CONFIG);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('post_t1 stalled');
    });

    it('allows time stop exactly at the threshold (1.0R)', () => {
      const result = shouldAllowTimeStop(true, 1.0, 2.0, BASE_CONFIG);
      expect(result.allowed).toBe(true);
    });

    it('BLOCKS time stop when above 1.0R threshold (1.5R — still running)', () => {
      const result = shouldAllowTimeStop(true, 1.5, 2.0, BASE_CONFIG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('post_t1 protected');
    });

    it('BLOCKS time stop for a strong post-T1 winner at +2.5R', () => {
      const result = shouldAllowTimeStop(true, 2.5, 2.8, BASE_CONFIG);
      expect(result.allowed).toBe(false);
    });

    it('respects a custom time_stop_max_r_post_t1 threshold', () => {
      const config = { ...BASE_CONFIG, time_stop_max_r_post_t1: 0.5 };
      // At 0.6R, which is above the custom 0.5 threshold, should be blocked
      expect(shouldAllowTimeStop(true, 0.6, 1.0, config).allowed).toBe(false);
      // At 0.4R, which is below the custom 0.5 threshold, should be allowed
      expect(shouldAllowTimeStop(true, 0.4, 1.0, config).allowed).toBe(true);
    });
  });
});

// ─── 2. isTargetSequenceValid ────────────────────────────────────────────────

describe('isTargetSequenceValid', () => {
  describe('SHORT direction', () => {
    // For shorts: entry ~67,000; T1 < entry; T2 < T1 (further down)
    const E = 67_000;
    const T1 = 66_800; // 200pts below entry — OK
    const T2_valid = 66_500; // 300pts below entry, so 500pts from E — OK (< T1)
    const T2_invalid = 66_900; // 100pts below entry — WRONG (closer than T1, > T1)
    const T2_equal = 66_800;   // same as T1 — WRONG (not strictly less)

    it('passes when T2 is strictly further below entry than T1', () => {
      expect(isTargetSequenceValid(T1, T2_valid, null, 'short')).toBe(true);
    });

    it('fails when T2 is above T1 (Trade #6 scenario — T2 closer to entry)', () => {
      expect(isTargetSequenceValid(T1, T2_invalid, null, 'short')).toBe(false);
    });

    it('fails when T2 equals T1', () => {
      expect(isTargetSequenceValid(T1, T2_equal, null, 'short')).toBe(false);
    });

    it('passes with valid T3 further below T2', () => {
      const T3 = 66_200;
      expect(isTargetSequenceValid(T1, T2_valid, T3, 'short')).toBe(true);
    });

    it('fails when T3 is above T2', () => {
      const T3 = 66_700; // above T2_valid(66,500)
      expect(isTargetSequenceValid(T1, T2_valid, T3, 'short')).toBe(false);
    });

    it('passes when T3 is null (T3 is optional)', () => {
      expect(isTargetSequenceValid(T1, T2_valid, null, 'short')).toBe(true);
    });
  });

  describe('LONG direction', () => {
    // For longs: entry ~67,000; T1 > entry; T2 > T1 (further up)
    const T1 = 67_200; // 200pts above entry — OK
    const T2_valid = 67_500; // 300pts above T1 from entry — OK (> T1)
    const T2_invalid = 67_100; // 100pts above entry — WRONG (below T1)
    const T2_equal = 67_200;   // same as T1 — WRONG

    it('passes when T2 is strictly further above entry than T1', () => {
      expect(isTargetSequenceValid(T1, T2_valid, null, 'long')).toBe(true);
    });

    it('fails when T2 is below T1', () => {
      expect(isTargetSequenceValid(T1, T2_invalid, null, 'long')).toBe(false);
    });

    it('fails when T2 equals T1', () => {
      expect(isTargetSequenceValid(T1, T2_equal, null, 'long')).toBe(false);
    });

    it('passes with valid T3 further above T2', () => {
      const T3 = 67_900;
      expect(isTargetSequenceValid(T1, T2_valid, T3, 'long')).toBe(true);
    });

    it('fails when T3 is below T2 for long', () => {
      const T3 = 67_300; // below T2_valid(67,500)
      expect(isTargetSequenceValid(T1, T2_valid, T3, 'long')).toBe(false);
    });
  });

  it('returns true for direction=none (no ordering rules)', () => {
    expect(isTargetSequenceValid(100, 50, null, 'none')).toBe(true);
  });
});

// ─── 3. repairTargetOrdering ─────────────────────────────────────────────────

describe('repairTargetOrdering', () => {
  describe('SHORT direction', () => {
    // Entry mid = 67,000; T1 = 66,800 (200pts below entry — correct)
    // T2 misordered: 66,900 (only 100pts below entry — should be 66,600 = 2× T1 dist)
    const ENTRY = 67_000;
    const T1 = 66_800;
    const T2_bad = 66_900; // wrong: closer to entry than T1

    it('repairs T2 to 2× T1 distance below entry', () => {
      const result = repairTargetOrdering(T1, T2_bad, null, ENTRY, 'short');
      expect(result.repaired).toBe(true);
      // T1 dist from entry = 67000 - 66800 = 200; repaired T2 = 66800 - 200 = 66600
      expect(result.t2).toBe(66_600);
      expect(result.t1).toBe(T1); // T1 unchanged
    });

    it('sets repaired=false and leaves values unchanged when ordering is already valid', () => {
      const T2_ok = 66_600; // 400pts below entry, further than T1 (200pts)
      const result = repairTargetOrdering(T1, T2_ok, null, ENTRY, 'short');
      expect(result.repaired).toBe(false);
      expect(result.t2).toBe(T2_ok);
    });

    it('also repairs T3 when misordered after T2 repair', () => {
      // T2 is bad (→ repaired to 66,600). T3 at 66,650 is above repaired T2 → also bad.
      const T3_bad = 66_650;
      const result = repairTargetOrdering(T1, T2_bad, T3_bad, ENTRY, 'short');
      expect(result.repaired).toBe(true);
      // repaired T2 = 66,600; T2 dist from entry = 67000 - 66600 = 400
      // repaired T3 = 66600 - 400 = 66200
      expect(result.t2).toBe(66_600);
      expect(result.t3).toBe(66_200);
    });

    it('includes a human-readable repairReason', () => {
      const result = repairTargetOrdering(T1, T2_bad, null, ENTRY, 'short');
      expect(result.repairReason).toContain('t2_misordered');
    });
  });

  describe('LONG direction', () => {
    // Entry mid = 67,000; T1 = 67,200 (200pts above entry — correct)
    // T2 misordered: 67,100 (only 100pts above entry — should be 67,400)
    const ENTRY = 67_000;
    const T1 = 67_200;
    const T2_bad = 67_100; // wrong: closer to entry than T1

    it('repairs T2 to 2× T1 distance above entry', () => {
      const result = repairTargetOrdering(T1, T2_bad, null, ENTRY, 'long');
      expect(result.repaired).toBe(true);
      // T1 dist from entry = 67200 - 67000 = 200; repaired T2 = 67200 + 200 = 67400
      expect(result.t2).toBe(67_400);
      expect(result.t1).toBe(T1);
    });

    it('sets repaired=false when ordering is already valid', () => {
      const T2_ok = 67_450;
      const result = repairTargetOrdering(T1, T2_ok, null, ENTRY, 'long');
      expect(result.repaired).toBe(false);
    });
  });
});

// ─── 4. scoreConfidence — atStructure null-fallback fix ──────────────────────

describe('scoreConfidence — atStructure structural level check', () => {
  /**
   * Build a minimal MarketSnapshot with only the fields scoreConfidence touches.
   * We stub everything at neutral values and vary bos_sell / bos_buy to isolate
   * the atStructure fix.
   */
  function makeSnap(overrides: {
    price?: number;
    bos_sell?: number | null;
    bos_buy?: number | null;
  } = {}): Parameters<typeof scoreConfidence>[1] {
    const price = overrides.price ?? 67_000;
    const bos_sell = overrides.bos_sell !== undefined ? overrides.bos_sell : null;
    const bos_buy  = overrides.bos_buy  !== undefined ? overrides.bos_buy  : null;

    const nullIndicators = {
      ema_9: null, ema_21: null, ema_50: null, ema_100: null, ema_200: null,
      supertrend_direction: null, supertrend_level: null,
      novawave_fast: null, novawave_slow: null, novawave_signal: null,
      dma_20: null, dma_50: null, dma_200: null,
      smart_money_choch_sell: null, smart_money_choch_buy: null,
      smart_money_bos_sell: null, smart_money_bos_buy: null,
      vwap: null, atr_14: null, rsi_14: null, volume: null, volume_sma_20: null,
    };

    const emptyBar = () => ({ time: 0, open: price, high: price, low: price, close: price, volume: 100 });
    const bars = Array.from({ length: 10 }, emptyBar);

    return {
      timestamp_unix: Date.now(),
      timestamp_iso: new Date().toISOString(),
      symbol: 'BTCUSD',
      price,
      bars_1m: bars,
      bars_5m: bars,
      bars_15m: bars,
      bars_1h: bars,
      indicators_1m: { ...nullIndicators },
      indicators_15m: { ...nullIndicators },
      indicators_1h: { ...nullIndicators },
      key_levels: {
        session_high: null, session_low: null, daily_open: null, weekly_open: null,
        monday_high: null, monday_low: null, monday_mid: null, monthly_open: null,
        pivot_resistance: [], pivot_support: [],
        choch_sell: null, choch_buy: null,
        bos_sell, bos_buy,
      },
      data_quality: {
        bars_1m_count: 10, bars_5m_count: 10, bars_15m_count: 10, bars_1h_count: 10,
        vwap_available: false, atr_available: false, rsi_available: false,
        missing_indicators: [],
      },
    };
  }

  function makeShortSetup(price: number) {
    return {
      direction: 'short' as const,
      setup_type: 'trend_pullback_short' as const,
      entry_low: price - 10,
      entry_high: price + 10,
      stop: price + 200,
      target_1: price - 500,
      target_2: price - 1000,
      target_3: null,
      risk_pts: 210,
      rr_t1: 2.38,
      rr_t2: 4.76,
      confidence: 0,
      confidence_factors: [] as string[],
      reason: 'test short',
      target_1_direction_valid: true,
      target_2_direction_valid: true,
      target_3_direction_valid: true,
      rr_validation_passed: true,
      target_ordering_valid: true,
      target_repair_applied: false,
      target_repair_reason: '',
    };
  }

  function makeLongSetup(price: number) {
    return {
      ...makeShortSetup(price),
      direction: 'long' as const,
      setup_type: 'trend_pullback_long' as const,
      stop: price - 200,
      target_1: price + 500,
      target_2: price + 1000,
      reason: 'test long',
    };
  }

  const neutralBias = {
    '1h': 'neutral' as const,
    '15m': 'neutral' as const,
    '5m': 'neutral' as const,
    '1m': 'neutral' as const,
    aligned: false,
    alignment_score: 0,
  };

  const bearBias = {
    '1h': 'bearish' as const,
    '15m': 'bearish' as const,
    '5m': 'bearish' as const,
    '1m': 'bearish' as const,
    aligned: true,
    alignment_score: 4,
  };

  it('SHORT: does NOT award +0.5 when bos_sell is null (old bug gave free bonus)', () => {
    const price = 67_000;
    const snap = makeSnap({ price, bos_sell: null });
    const setup = makeShortSetup(price);
    scoreConfidence(setup, snap, bearBias, 'trending_down', BASE_CONFIG);
    // Should NOT have at_structural_level factor
    expect(setup.confidence_factors.join(',')).not.toContain('at_structural_level(+0.5)');
    // Should log that bos_sell was unavailable
    expect(setup.confidence_factors.join(',')).toContain('bos_sell_unavailable');
  });

  it('SHORT: awards +0.5 when bos_sell is set and price is below it', () => {
    const price = 67_000;
    // bos_sell at 67,500 — price (67,000) is below it ✓
    const snap = makeSnap({ price, bos_sell: 67_500 });
    const setup = makeShortSetup(price);
    scoreConfidence(setup, snap, bearBias, 'trending_down', BASE_CONFIG);
    expect(setup.confidence_factors.join(',')).toContain('at_structural_level:bos_sell(+0.5)');
  });

  it('SHORT: does NOT award +0.5 when bos_sell is set but price is above it', () => {
    const price = 67_000;
    // bos_sell at 66,500 — price (67,000) is ABOVE it — condition should fail
    const snap = makeSnap({ price, bos_sell: 66_500 });
    const setup = makeShortSetup(price);
    scoreConfidence(setup, snap, bearBias, 'trending_down', BASE_CONFIG);
    expect(setup.confidence_factors.join(',')).not.toContain('at_structural_level(+0.5)');
  });

  it('LONG: does NOT award +0.5 when bos_buy is null and no alternatives available', () => {
    const price = 67_000;
    const snap = makeSnap({ price, bos_buy: null });
    const setup = makeLongSetup(price);
    // Use bullish bias for a long trade
    const bullBias = { ...bearBias, '1h': 'bullish' as const, '15m': 'bullish' as const, '5m': 'bullish' as const, '1m': 'bullish' as const };
    scoreConfidence(setup, snap, bullBias, 'trending_up', BASE_CONFIG);
    // No bos_buy AND no alternative confirmations (vwap, daily_open, OR_high, prior_rth_low all null)
    expect(setup.confidence_factors.join(',')).not.toContain('at_structural_level');
    expect(setup.confidence_factors.join(',')).toContain('bos_buy_unavailable:no_alt_confirmed');
  });

  it('LONG: awards +0.5 when bos_buy is set and price is above it', () => {
    const price = 67_000;
    // bos_buy at 66,500 — price (67,000) is above it ✓
    const snap = makeSnap({ price, bos_buy: 66_500 });
    const setup = makeLongSetup(price);
    const bullBias = { ...bearBias, '1h': 'bullish' as const, '15m': 'bullish' as const, '5m': 'bullish' as const, '1m': 'bullish' as const };
    scoreConfidence(setup, snap, bullBias, 'trending_up', BASE_CONFIG);
    expect(setup.confidence_factors.join(',')).toContain('at_structural_level:bos_buy(+0.5)');
  });
});
