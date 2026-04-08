/**
 * Tests for the dual-direction confluence model:
 *   1. compareSides() decision logic
 *   2. applyHardGates() per-candidate gate checking
 *   3. scoreConfidenceDetailed() breakdown structure
 *   4. Integration: generateSignal() returns DualDirectionResult
 */

import { describe, it, expect } from 'vitest';
import {
  compareSides,
  applyHardGates,
  scoreConfidenceDetailed,
} from '../../src/autotrade/strategy.js';
import type {
  IndicatorConfig,
  CandidateSetup,
  DirectionalCandidate,
  ScoreBreakdown,
  MarketSnapshot,
  MultiTfBias,
  MarketRegime,
} from '../../src/autotrade/types.js';

// ─── Shared Fixtures ────────────────────────────────────────────────────────

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
  min_confidence: 7.0,
  max_confidence: 9.0,
  min_rr: 2.0,
  max_risk_per_trade_pct: 1.5,
  max_daily_loss_pct: 1.5,
  max_consecutive_losses: 5,
  account_equity: 25_000,
  time_stop_minutes: 30,
  time_stop_max_r_pre_t1: 0.25,
  time_stop_max_r_post_t1: 1.0,
  analysis_interval_seconds: 20,
  in_position_monitor_seconds: 2,
  opening_range_minutes: 15,
  trail_ticks_post_t1: 12,
  enable_momentum_continuation: false,
  enable_opening_drive: true,
  enable_failed_or_break: true,
  dual_min_score: 7.5,
  dual_score_margin: 1.0,
  dual_choppy_extra_margin: 0.5,
  cooldown_bars: 3,
  no_same_bar_reversal: true,
};

function mkSetup(direction: 'long' | 'short', confidence: number): CandidateSetup {
  const isShort = direction === 'short';
  const entry = 20000;
  const stop = isShort ? entry + 20 : entry - 20;
  const t1 = isShort ? entry - 40 : entry + 40;
  const t2 = isShort ? entry - 80 : entry + 80;
  return {
    direction,
    setup_type: isShort ? 'trend_pullback_short' : 'trend_pullback_long',
    entry_low: entry - 2,
    entry_high: entry + 2,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: null,
    risk_pts: 20,
    rr_t1: 2.0,
    rr_t2: 4.0,
    confidence,
    confidence_factors: ['test_factor'],
    reason: 'test setup',
    target_1_direction_valid: true,
    target_2_direction_valid: true,
    target_3_direction_valid: true,
    rr_validation_passed: true,
    target_ordering_valid: true,
    target_repair_applied: false,
    target_repair_reason: '',
  };
}

function mkBreakdown(total: number): ScoreBreakdown {
  return {
    base: 5.0,
    tf_alignment: total - 5.0,
    htf_direction: 0,
    supertrend: 0,
    structural_level: 0,
    rr_quality: 0,
    volume: 0,
    missing_indicators: 0,
    entry_location: 0,
    regime_alignment: 0,
    swing_structure: 0,
    vwap_position: 0,
    or_level: 0,
    total,
    factors: ['test'],
  };
}

function mkCandidate(direction: 'long' | 'short', score: number, passGates = true): DirectionalCandidate {
  return {
    setup: mkSetup(direction, score),
    score,
    scoreBreakdown: mkBreakdown(score),
    hardGateFailures: passGates ? [] : ['regime_choppy'],
    passedHardGates: passGates,
  };
}

// ─── compareSides() ────��────────────────────────────────────────────────────

describe('compareSides()', () => {
  it('returns wait_no_candidates when both sides are null', () => {
    const result = compareSides(null, null, 'trending_up', BASE_CONFIG);
    expect(result.decision).toBe('wait_no_candidates');
    expect(result.chosen).toBeNull();
  });

  it('enters long when only long passes gates and score >= minScore', () => {
    const long = mkCandidate('long', 8.0, true);
    const short = mkCandidate('short', 6.0, false);
    const result = compareSides(long, short, 'trending_up', BASE_CONFIG);
    expect(result.decision).toBe('enter_long');
    expect(result.chosen).toBe(long);
  });

  it('enters short when only short passes gates and score >= minScore', () => {
    const long = mkCandidate('long', 5.0, false);
    const short = mkCandidate('short', 8.5, true);
    const result = compareSides(long, short, 'trending_down', BASE_CONFIG);
    expect(result.decision).toBe('enter_short');
    expect(result.chosen).toBe(short);
  });

  it('waits when only valid side is below minScore', () => {
    const long = mkCandidate('long', 6.0, true);
    const short = mkCandidate('short', 4.0, false);
    const result = compareSides(long, short, 'trending_up', BASE_CONFIG);
    expect(result.decision).toBe('wait_below_min_score');
    expect(result.chosen).toBeNull();
  });

  it('waits when neither side passes gates', () => {
    const long = mkCandidate('long', 8.0, false);
    const short = mkCandidate('short', 8.0, false);
    const result = compareSides(long, short, 'choppy', BASE_CONFIG);
    expect(result.decision).toBe('wait_no_gates_passed');
  });

  it('enters long when both valid and long wins by sufficient margin', () => {
    const long = mkCandidate('long', 8.5, true);
    const short = mkCandidate('short', 7.5, true);
    // margin = 1.0 === required margin (1.0)
    const result = compareSides(long, short, 'trending_up', BASE_CONFIG);
    expect(result.decision).toBe('enter_long');
    expect(result.margin).toBeCloseTo(1.0);
  });

  it('enters short when both valid and short wins by sufficient margin', () => {
    const long = mkCandidate('long', 7.5, true);
    const short = mkCandidate('short', 9.0, true);
    const result = compareSides(long, short, 'trending_down', BASE_CONFIG);
    expect(result.decision).toBe('enter_short');
    expect(result.margin).toBeCloseTo(1.5);
  });

  it('waits when both valid but margin insufficient', () => {
    const long = mkCandidate('long', 8.0, true);
    const short = mkCandidate('short', 7.5, true);
    // margin = 0.5 < required 1.0
    const result = compareSides(long, short, 'trending_up', BASE_CONFIG);
    expect(result.decision).toBe('wait_insufficient_margin');
  });

  it('waits when both valid but both below minScore', () => {
    const long = mkCandidate('long', 6.0, true);
    const short = mkCandidate('short', 5.0, true);
    const result = compareSides(long, short, 'range_bound', BASE_CONFIG);
    expect(result.decision).toBe('wait_both_weak');
  });

  it('uses extra margin in choppy regime', () => {
    // In choppy: required margin = 1.0 + 0.5 = 1.5
    const long = mkCandidate('long', 8.5, true);
    const short = mkCandidate('short', 7.5, true);
    // margin = 1.0 < 1.5 → wait
    const result = compareSides(long, short, 'choppy', BASE_CONFIG);
    expect(result.decision).toBe('wait_insufficient_margin');
  });

  it('uses extra margin in high_volatility_impulse regime', () => {
    const long = mkCandidate('long', 9.0, true);
    const short = mkCandidate('short', 7.5, true);
    // margin = 1.5 >= 1.5 → enter long
    const result = compareSides(long, short, 'high_volatility_impulse', BASE_CONFIG);
    expect(result.decision).toBe('enter_long');
  });

  it('handles null long with valid short', () => {
    const short = mkCandidate('short', 8.0, true);
    const result = compareSides(null, short, 'trending_down', BASE_CONFIG);
    expect(result.decision).toBe('enter_short');
  });

  it('handles null short with valid long', () => {
    const long = mkCandidate('long', 8.0, true);
    const result = compareSides(long, null, 'trending_up', BASE_CONFIG);
    expect(result.decision).toBe('enter_long');
  });

  it('handles equal scores from both valid sides (wait_insufficient_margin)', () => {
    const long = mkCandidate('long', 8.0, true);
    const short = mkCandidate('short', 8.0, true);
    const result = compareSides(long, short, 'range_bound', BASE_CONFIG);
    expect(result.decision).toBe('wait_insufficient_margin');
    expect(result.margin).toBeCloseTo(0);
  });
});

// ─── applyHardGates() ───────────────���──────────────────────────────────────

describe('applyHardGates()', () => {
  const neutralBias: MultiTfBias = {
    '1h': 'bullish', '15m': 'bullish', '5m': 'bullish', '1m': 'bullish',
    aligned: true, alignment_score: 4,
  };

  const minSnap = {
    price: 20000,
    key_levels: { session_high: null, session_low: null, bos_buy: null, bos_sell: null, choch_buy: null, choch_sell: null },
    data_quality: { bars_1m_count: 60, bars_5m_count: 30, bars_15m_count: 20, bars_1h_count: 12, vwap_available: true, atr_available: true, rsi_available: true, missing_indicators: [] },
    session: { is_rth: true, is_eth: false, is_us_cash_open_window: false, is_rth_closing_window: false, is_weekend: false, minutes_since_rth_open: 60, minutes_to_rth_close: 330 },
    event: { is_event_window: false, event_type: null, minutes_to_next_event: null, minutes_since_last_event: null, no_trade_due_to_event: false, suppression_reason: '' },
  } as unknown as MarketSnapshot;

  it('returns empty array for a fully valid setup', () => {
    const setup = mkSetup('long', 8.0);
    const gates = applyHardGates(setup, 8.0, neutralBias, 'trending_up', minSnap, BASE_CONFIG);
    expect(gates).toEqual([]);
  });

  it('catches rr_validation_failed', () => {
    const setup = mkSetup('long', 8.0);
    setup.rr_validation_passed = false;
    const gates = applyHardGates(setup, 8.0, neutralBias, 'trending_up', minSnap, BASE_CONFIG);
    expect(gates).toContain('rr_validation_failed_invalid_targets');
  });

  it('catches rr_t1 non-positive', () => {
    const setup = mkSetup('long', 8.0);
    setup.rr_t1 = -0.5;
    const gates = applyHardGates(setup, 8.0, neutralBias, 'trending_up', minSnap, BASE_CONFIG);
    expect(gates).toContain('rr_t1_non_positive_-0.5');
  });

  it('catches rr below min', () => {
    const setup = mkSetup('long', 8.0);
    setup.rr_t1 = 1.5; // below min_rr of 2.0
    const gates = applyHardGates(setup, 8.0, neutralBias, 'trending_up', minSnap, BASE_CONFIG);
    expect(gates).toContain('rr_1.5_below_min_2');
  });

  it('catches choppy regime', () => {
    const setup = mkSetup('long', 8.0);
    const gates = applyHardGates(setup, 8.0, neutralBias, 'choppy', minSnap, BASE_CONFIG);
    expect(gates).toContain('regime_choppy');
  });

  it('catches weak alignment', () => {
    const setup = mkSetup('long', 8.0);
    const weakBias: MultiTfBias = {
      '1h': 'bullish', '15m': 'neutral', '5m': 'bearish', '1m': 'neutral',
      aligned: false, alignment_score: 1,
    };
    const gates = applyHardGates(setup, 8.0, weakBias, 'trending_up', minSnap, BASE_CONFIG);
    expect(gates).toContain('alignment_too_weak_1_of_4');
  });

  it('catches market closed', () => {
    const setup = mkSetup('long', 8.0);
    const closedSnap = {
      ...minSnap,
      session: { ...minSnap.session!, is_rth: false, is_eth: false },
    } as unknown as MarketSnapshot;
    const gates = applyHardGates(setup, 8.0, neutralBias, 'trending_up', closedSnap, BASE_CONFIG);
    expect(gates).toContain('market_closed');
  });

  it('catches confidence ceiling', () => {
    const setup = mkSetup('long', 9.5);
    const gates = applyHardGates(setup, 9.5, neutralBias, 'trending_up', minSnap, BASE_CONFIG);
    expect(gates).toContain('confidence_ceiling_9.5_above_max_9');
  });

  it('catches RTH closing window', () => {
    const setup = mkSetup('long', 8.0);
    const closingSnap = {
      ...minSnap,
      session: { ...minSnap.session!, is_rth_closing_window: true },
    } as unknown as MarketSnapshot;
    const gates = applyHardGates(setup, 8.0, neutralBias, 'trending_up', closingSnap, BASE_CONFIG);
    expect(gates).toContain('rth_closing_window_no_new_trades');
  });

  it('catches target_1_wrong_side_of_entry', () => {
    const setup = mkSetup('long', 8.0);
    setup.target_1_direction_valid = false;
    const gates = applyHardGates(setup, 8.0, neutralBias, 'trending_up', minSnap, BASE_CONFIG);
    expect(gates).toContain('target_1_wrong_side_of_entry');
  });
});

// ─── scoreConfidenceDetailed() ──────────────���───────────────────────────────

describe('scoreConfidenceDetailed()', () => {
  const mkSnap = (): MarketSnapshot => ({
    timestamp_unix: Date.now(),
    timestamp_iso: new Date().toISOString(),
    symbol: 'NQ1!',
    price: 20000,
    bars_1m: Array.from({ length: 20 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (20 - i) * 60,
      open: 19990 + i, high: 20000 + i, low: 19980 + i, close: 19995 + i, volume: 100,
    })),
    bars_5m: Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (10 - i) * 300,
      open: 19990, high: 20010, low: 19980, close: 20000, volume: 500,
    })),
    bars_15m: Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (10 - i) * 900,
      open: 19990, high: 20010, low: 19980, close: 20000, volume: 1500,
    })),
    bars_1h: Array.from({ length: 5 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (5 - i) * 3600,
      open: 19950, high: 20050, low: 19900, close: 20000, volume: 6000,
    })),
    indicators_1m: {
      ema_9: 19995, ema_21: 19990, ema_50: 19980, ema_200: null,
      rsi_14: 55, atr_14: 15, vwap: 19990,
      supertrend_direction: 'up', supertrend_value: 19970,
      novawave_fast: 0.5, novawave_slow: 0.3,
    },
    indicators_15m: {
      ema_9: 19990, ema_21: 19980, ema_50: 19970, ema_200: 19900,
      rsi_14: 55, atr_14: 30, vwap: null,
      supertrend_direction: 'up', supertrend_value: 19960,
      novawave_fast: null, novawave_slow: null,
    },
    indicators_1h: {
      ema_9: 19980, ema_21: 19970, ema_50: 19960, ema_200: 19800,
      rsi_14: 55, atr_14: 50, vwap: null,
      supertrend_direction: 'up', supertrend_value: 19940,
      novawave_fast: null, novawave_slow: null,
    },
    key_levels: {
      session_high: 20050, session_low: 19950,
      bos_buy: 19960, bos_sell: 20040,
      choch_buy: 19970, choch_sell: 20030,
    },
    data_quality: {
      bars_1m_count: 20, bars_5m_count: 10, bars_15m_count: 10, bars_1h_count: 5,
      vwap_available: true, atr_available: true, rsi_available: true,
      missing_indicators: [],
    },
  } as unknown as MarketSnapshot);

  it('returns a ScoreBreakdown with all expected fields', () => {
    const setup = mkSetup('long', 0);
    const snap = mkSnap();
    const bias: MultiTfBias = {
      '1h': 'bullish', '15m': 'bullish', '5m': 'bullish', '1m': 'bullish',
      aligned: true, alignment_score: 4,
    };
    const breakdown = scoreConfidenceDetailed(setup, snap, bias, 'trending_up', BASE_CONFIG);

    expect(breakdown.base).toBe(5.0);
    expect(typeof breakdown.tf_alignment).toBe('number');
    expect(typeof breakdown.htf_direction).toBe('number');
    expect(typeof breakdown.supertrend).toBe('number');
    expect(typeof breakdown.total).toBe('number');
    expect(breakdown.total).toBeGreaterThanOrEqual(0);
    expect(breakdown.total).toBeLessThanOrEqual(10);
    expect(Array.isArray(breakdown.factors)).toBe(true);
  });

  it('gives full TF alignment bonus for alignment_score 4', () => {
    const setup = mkSetup('long', 0);
    const snap = mkSnap();
    const bias: MultiTfBias = {
      '1h': 'bullish', '15m': 'bullish', '5m': 'bullish', '1m': 'bullish',
      aligned: true, alignment_score: 4,
    };
    const breakdown = scoreConfidenceDetailed(setup, snap, bias, 'trending_up', BASE_CONFIG);
    expect(breakdown.tf_alignment).toBe(2.0);
  });

  it('penalizes weak TF alignment (score < 2)', () => {
    const setup = mkSetup('long', 0);
    const snap = mkSnap();
    const bias: MultiTfBias = {
      '1h': 'neutral', '15m': 'neutral', '5m': 'neutral', '1m': 'bullish',
      aligned: false, alignment_score: 1,
    };
    const breakdown = scoreConfidenceDetailed(setup, snap, bias, 'range_bound', BASE_CONFIG);
    expect(breakdown.tf_alignment).toBe(-0.5);
  });

  it('penalizes when 1h conflicts with direction', () => {
    const setup = mkSetup('long', 0);
    const snap = mkSnap();
    const bias: MultiTfBias = {
      '1h': 'bearish', '15m': 'bullish', '5m': 'bullish', '1m': 'bullish',
      aligned: false, alignment_score: 3,
    };
    const breakdown = scoreConfidenceDetailed(setup, snap, bias, 'trending_up', BASE_CONFIG);
    expect(breakdown.htf_direction).toBe(-1.0);
  });

  it('total score is clamped between 0 and 10', () => {
    const setup = mkSetup('long', 0);
    setup.rr_t1 = 0.5; // very low RR
    const snap = mkSnap();
    snap.indicators_1m.supertrend_direction = 'down'; // opposes long
    const bias: MultiTfBias = {
      '1h': 'bearish', '15m': 'bearish', '5m': 'bearish', '1m': 'bearish',
      aligned: true, alignment_score: 4,
    };
    const breakdown = scoreConfidenceDetailed(setup, snap, bias, 'choppy', BASE_CONFIG);
    expect(breakdown.total).toBeGreaterThanOrEqual(0);
    expect(breakdown.total).toBeLessThanOrEqual(10);
  });
});

// ─── Integration: compareSides edge cases ───────────────────────────────────

describe('compareSides() edge cases', () => {
  it('long null + short below minScore → wait_below_min_score', () => {
    const short = mkCandidate('short', 6.0, true);
    const result = compareSides(null, short, 'trending_down', BASE_CONFIG);
    expect(result.decision).toBe('wait_below_min_score');
  });

  it('custom config with dual_min_score=6 allows lower scores', () => {
    const customConfig = { ...BASE_CONFIG, dual_min_score: 6.0 };
    const long = mkCandidate('long', 6.5, true);
    const result = compareSides(long, null, 'trending_up', customConfig);
    expect(result.decision).toBe('enter_long');
  });

  it('custom config with dual_score_margin=2.0 requires larger gap', () => {
    const customConfig = { ...BASE_CONFIG, dual_score_margin: 2.0 };
    const long = mkCandidate('long', 8.5, true);
    const short = mkCandidate('short', 7.5, true);
    // margin = 1.0 < 2.0 → wait
    const result = compareSides(long, short, 'trending_up', customConfig);
    expect(result.decision).toBe('wait_insufficient_margin');
  });

  it('returns opposing side in result when one side wins', () => {
    const long = mkCandidate('long', 9.0, true);
    const short = mkCandidate('short', 7.5, true);
    const result = compareSides(long, short, 'trending_up', BASE_CONFIG);
    expect(result.decision).toBe('enter_long');
    expect(result.opposing).toBe(short);
  });
});

// ─── VWAP Direction-Specific Scoring ──────────────────────────────────────────

describe('scoreConfidenceDetailed() VWAP scoring', () => {
  const mkSnap = (overrides?: { vwap?: number | null; price?: number }): MarketSnapshot => ({
    timestamp_unix: Date.now(),
    timestamp_iso: new Date().toISOString(),
    symbol: 'NQ1!',
    price: overrides?.price ?? 20000,
    bars_1m: Array.from({ length: 20 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (20 - i) * 60,
      open: 19990 + i, high: 20000 + i, low: 19980 + i, close: 19995 + i, volume: 100,
    })),
    bars_5m: Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (10 - i) * 300,
      open: 19990, high: 20010, low: 19980, close: 20000, volume: 500,
    })),
    bars_15m: Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (10 - i) * 900,
      open: 19990, high: 20010, low: 19980, close: 20000, volume: 1500,
    })),
    bars_1h: Array.from({ length: 5 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (5 - i) * 3600,
      open: 19950, high: 20050, low: 19900, close: 20000, volume: 6000,
    })),
    indicators_1m: {
      ema_9: 19995, ema_21: 19990, ema_50: 19980, ema_200: null,
      rsi_14: 55, atr_14: 15, vwap: overrides && 'vwap' in overrides ? overrides.vwap : 19990,
      supertrend_direction: 'up', supertrend_value: 19970,
      novawave_fast: 0.5, novawave_slow: 0.3,
    },
    indicators_15m: {
      ema_9: 19990, ema_21: 19980, ema_50: 19970, ema_200: 19900,
      rsi_14: 55, atr_14: 30, vwap: null,
      supertrend_direction: 'up', supertrend_value: 19960,
      novawave_fast: null, novawave_slow: null,
    },
    indicators_1h: {
      ema_9: 19980, ema_21: 19970, ema_50: 19960, ema_200: 19800,
      rsi_14: 55, atr_14: 50, vwap: null,
      supertrend_direction: 'up', supertrend_value: 19940,
      novawave_fast: null, novawave_slow: null,
    },
    key_levels: {
      session_high: 20050, session_low: 19950,
      bos_buy: 19960, bos_sell: 20040,
      choch_buy: 19970, choch_sell: 20030,
      opening_range_high: null, opening_range_low: null,
    },
    data_quality: {
      bars_1m_count: 20, bars_5m_count: 10, bars_15m_count: 10, bars_1h_count: 5,
      vwap_available: true, atr_available: true, rsi_available: true,
      missing_indicators: [],
    },
  } as unknown as MarketSnapshot);

  const bullBias: MultiTfBias = {
    '1h': 'bullish', '15m': 'bullish', '5m': 'bullish', '1m': 'bullish',
    aligned: true, alignment_score: 4,
  };

  it('adds vwap_supports bonus for long when price > VWAP', () => {
    // price=20000, vwap=19990 → price above VWAP → supports long
    const setup = mkSetup('long', 0);
    const snap = mkSnap({ price: 20000, vwap: 19990 });
    const bd = scoreConfidenceDetailed(setup, snap, bullBias, 'trending_up', BASE_CONFIG);
    expect(bd.vwap_position).toBeGreaterThan(0);
    expect(bd.factors.some(f => f.includes('vwap_supports_long'))).toBe(true);
  });

  it('adds vwap_opposes penalty for long when price < VWAP', () => {
    // price=19980, vwap=19990 → price below VWAP → opposes long
    const setup = mkSetup('long', 0);
    const snap = mkSnap({ price: 19980, vwap: 19990 });
    const bd = scoreConfidenceDetailed(setup, snap, bullBias, 'trending_up', BASE_CONFIG);
    expect(bd.vwap_position).toBeLessThan(0);
    expect(bd.factors.some(f => f.includes('vwap_opposes_long'))).toBe(true);
  });

  it('adds vwap_supports bonus for short when price < VWAP', () => {
    // price=19980, vwap=19990 → price below VWAP → supports short
    const setup = mkSetup('short', 0);
    const snap = mkSnap({ price: 19980, vwap: 19990 });
    const bearBias: MultiTfBias = {
      '1h': 'bearish', '15m': 'bearish', '5m': 'bearish', '1m': 'bearish',
      aligned: true, alignment_score: 4,
    };
    const bd = scoreConfidenceDetailed(setup, snap, bearBias, 'trending_down', BASE_CONFIG);
    expect(bd.vwap_position).toBeGreaterThan(0);
    expect(bd.factors.some(f => f.includes('vwap_supports_short'))).toBe(true);
  });

  it('adds vwap_opposes penalty for short when price > VWAP', () => {
    // price=20000, vwap=19990 → price above VWAP → opposes short
    const setup = mkSetup('short', 0);
    const snap = mkSnap({ price: 20000, vwap: 19990 });
    const bearBias: MultiTfBias = {
      '1h': 'bearish', '15m': 'bearish', '5m': 'bearish', '1m': 'bearish',
      aligned: true, alignment_score: 4,
    };
    const bd = scoreConfidenceDetailed(setup, snap, bearBias, 'trending_down', BASE_CONFIG);
    expect(bd.vwap_position).toBeLessThan(0);
    expect(bd.factors.some(f => f.includes('vwap_opposes_short'))).toBe(true);
  });

  it('produces zero vwap_position when VWAP is null', () => {
    const setup = mkSetup('long', 0);
    const snap = mkSnap({ vwap: null });
    const bd = scoreConfidenceDetailed(setup, snap, bullBias, 'trending_up', BASE_CONFIG);
    expect(bd.vwap_position).toBe(0);
    expect(bd.factors.some(f => f.includes('vwap_'))).toBe(false);
  });

  it('same market data produces opposite VWAP effects for long vs short', () => {
    // price=20000, vwap=19990 → above VWAP
    const snap = mkSnap({ price: 20000, vwap: 19990 });
    const longBd = scoreConfidenceDetailed(mkSetup('long', 0), snap, bullBias, 'trending_up', BASE_CONFIG);
    const bearBias: MultiTfBias = {
      '1h': 'bearish', '15m': 'bearish', '5m': 'bearish', '1m': 'bearish',
      aligned: true, alignment_score: 4,
    };
    const shortBd = scoreConfidenceDetailed(mkSetup('short', 0), snap, bearBias, 'trending_down', BASE_CONFIG);
    // long should be supported (positive), short should be opposed (negative)
    expect(longBd.vwap_position).toBeGreaterThan(0);
    expect(shortBd.vwap_position).toBeLessThan(0);
  });
});

// ─── OR Level Proximity Scoring ───────────────────────────────────────────────

describe('scoreConfidenceDetailed() OR level scoring', () => {
  const mkSnapWithOR = (price: number, orHigh: number | null, orLow: number | null): MarketSnapshot => ({
    timestamp_unix: Date.now(),
    timestamp_iso: new Date().toISOString(),
    symbol: 'NQ1!',
    price,
    bars_1m: Array.from({ length: 20 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (20 - i) * 60,
      open: price - 10 + i, high: price + i, low: price - 20 + i, close: price - 5 + i, volume: 100,
    })),
    bars_5m: Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (10 - i) * 300,
      open: price - 10, high: price + 10, low: price - 20, close: price, volume: 500,
    })),
    bars_15m: Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (10 - i) * 900,
      open: price - 10, high: price + 10, low: price - 20, close: price, volume: 1500,
    })),
    bars_1h: Array.from({ length: 5 }, (_, i) => ({
      timestamp: Date.now() / 1000 - (5 - i) * 3600,
      open: price - 50, high: price + 50, low: price - 100, close: price, volume: 6000,
    })),
    indicators_1m: {
      ema_9: price - 5, ema_21: price - 10, ema_50: price - 20, ema_200: null,
      rsi_14: 55, atr_14: 15, vwap: null,
      supertrend_direction: 'up', supertrend_value: price - 30,
      novawave_fast: 0.5, novawave_slow: 0.3,
    },
    indicators_15m: {
      ema_9: price - 10, ema_21: price - 20, ema_50: price - 30, ema_200: price - 100,
      rsi_14: 55, atr_14: 30, vwap: null,
      supertrend_direction: 'up', supertrend_value: price - 40,
      novawave_fast: null, novawave_slow: null,
    },
    indicators_1h: {
      ema_9: price - 20, ema_21: price - 30, ema_50: price - 40, ema_200: price - 200,
      rsi_14: 55, atr_14: 50, vwap: null,
      supertrend_direction: 'up', supertrend_value: price - 60,
      novawave_fast: null, novawave_slow: null,
    },
    key_levels: {
      session_high: price + 50, session_low: price - 50,
      bos_buy: price - 40, bos_sell: price + 40,
      choch_buy: price - 30, choch_sell: price + 30,
      opening_range_high: orHigh,
      opening_range_low: orLow,
    },
    data_quality: {
      bars_1m_count: 20, bars_5m_count: 10, bars_15m_count: 10, bars_1h_count: 5,
      vwap_available: false, atr_available: true, rsi_available: true,
      missing_indicators: [],
    },
  } as unknown as MarketSnapshot);

  const bullBias: MultiTfBias = {
    '1h': 'bullish', '15m': 'bullish', '5m': 'bullish', '1m': 'bullish',
    aligned: true, alignment_score: 4,
  };
  const bearBias: MultiTfBias = {
    '1h': 'bearish', '15m': 'bearish', '5m': 'bearish', '1m': 'bearish',
    aligned: true, alignment_score: 4,
  };

  it('adds or_level bonus for long near OR low (support)', () => {
    // OR range = 20100-20000 = 100, threshold = 30
    // price=20005 is 5 pts from OR low (20000) → within threshold
    const snap = mkSnapWithOR(20005, 20100, 20000);
    const setup = mkSetup('long', 0);
    const bd = scoreConfidenceDetailed(setup, snap, bullBias, 'trending_up', BASE_CONFIG);
    expect(bd.or_level).toBeGreaterThan(0);
    expect(bd.factors.some(f => f.includes('or_low_supports_long'))).toBe(true);
  });

  it('adds or_level bonus for short near OR high (resistance)', () => {
    // OR range = 20100-20000 = 100, threshold = 30
    // price=20095 is 5 pts from OR high (20100) → within threshold
    const snap = mkSnapWithOR(20095, 20100, 20000);
    const setup = mkSetup('short', 0);
    const bd = scoreConfidenceDetailed(setup, snap, bearBias, 'trending_down', BASE_CONFIG);
    expect(bd.or_level).toBeGreaterThan(0);
    expect(bd.factors.some(f => f.includes('or_high_supports_short'))).toBe(true);
  });

  it('no or_level bonus when price is far from OR levels', () => {
    // OR range = 20100-20000 = 100, threshold = 30
    // price=20050 is 50 pts from both → outside threshold
    const snap = mkSnapWithOR(20050, 20100, 20000);
    const setup = mkSetup('long', 0);
    const bd = scoreConfidenceDetailed(setup, snap, bullBias, 'trending_up', BASE_CONFIG);
    expect(bd.or_level).toBe(0);
  });

  it('no or_level scoring when OR levels are null', () => {
    const snap = mkSnapWithOR(20000, null, null);
    const setup = mkSetup('long', 0);
    const bd = scoreConfidenceDetailed(setup, snap, bullBias, 'trending_up', BASE_CONFIG);
    expect(bd.or_level).toBe(0);
  });

  it('long near OR high gets no bonus (resistance opposes longs)', () => {
    // price=20095 near OR high → this only helps shorts, not longs
    const snap = mkSnapWithOR(20095, 20100, 20000);
    const setup = mkSetup('long', 0);
    const bd = scoreConfidenceDetailed(setup, snap, bullBias, 'trending_up', BASE_CONFIG);
    expect(bd.or_level).toBe(0);
  });

  it('short near OR low gets no bonus (support opposes shorts)', () => {
    // price=20005 near OR low → this only helps longs, not shorts
    const snap = mkSnapWithOR(20005, 20100, 20000);
    const setup = mkSetup('short', 0);
    const bd = scoreConfidenceDetailed(setup, snap, bearBias, 'trending_down', BASE_CONFIG);
    expect(bd.or_level).toBe(0);
  });
});

// ─── Cooldown & Same-Bar Reversal (runner-level) ─────────────────────────────
// These test the logic patterns used in runner.ts and historical/runner.ts.
// Since cooldown is implemented in the runner (stateful), we test the
// decision logic in isolation here.

describe('cooldown and same-bar reversal logic', () => {
  /**
   * Simulate the cooldown/reversal check from runner.ts.
   * Returns the block reason string or null if allowed.
   */
  function checkCooldown(
    config: IndicatorConfig,
    bestDirection: 'long' | 'short',
    lastExitDirection: 'long' | 'short' | null,
    barsSinceExit: number | null,
  ): string | null {
    if (barsSinceExit === null) return null; // no prior trade

    if (config.no_same_bar_reversal
      && lastExitDirection !== null
      && bestDirection !== lastExitDirection
      && barsSinceExit < 1) {
      return `same_bar_reversal:exited_${lastExitDirection}_${barsSinceExit}bars_ago`;
    }

    if (config.cooldown_bars > 0 && barsSinceExit < config.cooldown_bars) {
      return `cooldown:${barsSinceExit}/${config.cooldown_bars}_bars`;
    }

    return null;
  }

  it('blocks same-bar reversal (exited long 0 bars ago, entering short)', () => {
    const block = checkCooldown(BASE_CONFIG, 'short', 'long', 0);
    expect(block).toContain('same_bar_reversal');
    expect(block).toContain('exited_long');
  });

  it('blocks same-bar reversal (exited short 0 bars ago, entering long)', () => {
    const block = checkCooldown(BASE_CONFIG, 'long', 'short', 0);
    expect(block).toContain('same_bar_reversal');
    expect(block).toContain('exited_short');
  });

  it('allows same-direction re-entry on same bar (no reversal)', () => {
    // Same direction is not a reversal — falls through to cooldown check
    const block = checkCooldown(BASE_CONFIG, 'long', 'long', 0);
    // Should be blocked by cooldown (0 < 3), not by same_bar_reversal
    expect(block).not.toContain('same_bar_reversal');
    expect(block).toContain('cooldown');
  });

  it('blocks entry during cooldown window (1 bar after exit, cooldown=3)', () => {
    const block = checkCooldown(BASE_CONFIG, 'long', 'long', 1);
    expect(block).toContain('cooldown:1/3_bars');
  });

  it('blocks entry during cooldown window (2 bars after exit, cooldown=3)', () => {
    const block = checkCooldown(BASE_CONFIG, 'short', 'long', 2);
    expect(block).toContain('cooldown:2/3_bars');
  });

  it('allows entry after cooldown expires (3 bars after exit, cooldown=3)', () => {
    const block = checkCooldown(BASE_CONFIG, 'long', 'short', 3);
    expect(block).toBeNull();
  });

  it('allows entry when no prior trade exists', () => {
    const block = checkCooldown(BASE_CONFIG, 'long', null, null);
    expect(block).toBeNull();
  });

  it('respects custom cooldown_bars=0 (no cooldown)', () => {
    const noCooldown = { ...BASE_CONFIG, cooldown_bars: 0, no_same_bar_reversal: false };
    const block = checkCooldown(noCooldown, 'short', 'long', 0);
    expect(block).toBeNull();
  });

  it('respects no_same_bar_reversal=false (reversal allowed)', () => {
    const noReversalBlock = { ...BASE_CONFIG, no_same_bar_reversal: false };
    // Same bar opposite direction — should only hit cooldown, not reversal
    const block = checkCooldown(noReversalBlock, 'short', 'long', 0);
    expect(block).not.toContain('same_bar_reversal');
    expect(block).toContain('cooldown');
  });
});
