/**
 * Tests for config-driven scoring weights and the elimination of
 * duplicate scoreConfidenceDetailed() calls.
 *
 * Coverage:
 *   1. Parity: default weights reproduce original hardcoded behavior
 *   2. Config override: custom weights change scores as expected
 *   3. Missing weights: partial config falls back to defaults
 *   4. Validation: scoring_weights config loading
 *   5. No duplicate scoring: generateSignal candidate path
 */

import { describe, it, expect, vi } from 'vitest';
import {
  scoreConfidenceDetailed,
  DEFAULT_SCORING_WEIGHTS,
  resolveScoringWeights,
  generateSignal,
} from '../../src/autotrade/strategy.js';
import type {
  IndicatorConfig,
  CandidateSetup,
  MarketSnapshot,
  MultiTfBias,
  ScoringWeights,
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
};

function mkSetup(direction: 'long' | 'short'): CandidateSetup {
  const isShort = direction === 'short';
  const entry = 20000;
  const stop = isShort ? entry + 20 : entry - 20;
  const t1 = isShort ? entry - 60 : entry + 60;
  const t2 = isShort ? entry - 120 : entry + 120;
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
    rr_t1: 3.0,
    rr_t2: 6.0,
    confidence: 0,
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

function mkSnap(): MarketSnapshot {
  return {
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
      open: 19990 + i * 2, high: 20010 + i * 2, low: 19980 + i * 2, close: 20000 + i * 2, volume: 500,
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
      daily_open: null, weekly_open: null,
      monday_high: null, monday_low: null, monday_mid: null, monthly_open: null,
      bos_buy: 19960, bos_sell: 20040,
      choch_buy: 19970, choch_sell: 20030,
      overnight_high: null, overnight_low: null,
      prior_rth_high: null, prior_rth_low: null,
      opening_range_high: null, opening_range_low: null, opening_range_mid: null,
      session_vwap: null,
      pivot_resistance: [20100, 20200, 20300],
      pivot_support: [19900, 19800, 19700],
    },
    data_quality: {
      bars_1m_count: 20, bars_5m_count: 10, bars_15m_count: 10, bars_1h_count: 5,
      vwap_available: true, atr_available: true, rsi_available: true,
      missing_indicators: [],
    },
  } as unknown as MarketSnapshot;
}

const ALIGNED_BULL_BIAS: MultiTfBias = {
  '1h': 'bullish', '15m': 'bullish', '5m': 'bullish', '1m': 'bullish',
  aligned: true, alignment_score: 4,
};

const NEUTRAL_BIAS: MultiTfBias = {
  '1h': 'neutral', '15m': 'neutral', '5m': 'neutral', '1m': 'neutral',
  aligned: false, alignment_score: 0,
};

// ─── 1. Parity: default weights reproduce original hardcoded behavior ───────

describe('DEFAULT_SCORING_WEIGHTS — parity with original hardcoded values', () => {
  it('has correct base score', () => {
    expect(DEFAULT_SCORING_WEIGHTS.base).toBe(5.0);
  });

  it('has correct TF alignment weights', () => {
    expect(DEFAULT_SCORING_WEIGHTS.tf_alignment_4tf).toBe(2.0);
    expect(DEFAULT_SCORING_WEIGHTS.tf_alignment_3tf).toBe(1.0);
    expect(DEFAULT_SCORING_WEIGHTS.tf_alignment_2tf).toBe(0.3);
    expect(DEFAULT_SCORING_WEIGHTS.tf_alignment_weak).toBe(-0.5);
  });

  it('has correct HTF direction weight', () => {
    expect(DEFAULT_SCORING_WEIGHTS.htf_direction_conflict).toBe(-1.0);
  });

  it('has correct SuperTrend weights', () => {
    expect(DEFAULT_SCORING_WEIGHTS.supertrend_confirms).toBe(0.5);
    expect(DEFAULT_SCORING_WEIGHTS.supertrend_opposes).toBe(-0.5);
  });

  it('has correct structural level weight', () => {
    expect(DEFAULT_SCORING_WEIGHTS.structural_level_bonus).toBe(0.5);
  });

  it('has correct R:R quality weights', () => {
    expect(DEFAULT_SCORING_WEIGHTS.rr_excellent).toBe(0.5);
    expect(DEFAULT_SCORING_WEIGHTS.rr_acceptable).toBe(0.25);
    expect(DEFAULT_SCORING_WEIGHTS.rr_below_min).toBe(-0.5);
  });

  it('has correct volume weights', () => {
    expect(DEFAULT_SCORING_WEIGHTS.volume_strong).toBe(0.5);
    expect(DEFAULT_SCORING_WEIGHTS.volume_thin).toBe(-0.5);
  });

  it('has correct missing indicator penalties', () => {
    expect(DEFAULT_SCORING_WEIGHTS.missing_indicators_many).toBe(-0.5);
    expect(DEFAULT_SCORING_WEIGHTS.missing_indicators_some).toBe(-0.25);
  });

  it('has correct entry location penalty', () => {
    expect(DEFAULT_SCORING_WEIGHTS.entry_location_suboptimal).toBe(-0.3);
  });

  it('has correct regime weights', () => {
    expect(DEFAULT_SCORING_WEIGHTS.regime_aligned).toBe(0.3);
    expect(DEFAULT_SCORING_WEIGHTS.regime_adverse).toBe(-1.0);
  });

  it('has correct swing structure weights', () => {
    expect(DEFAULT_SCORING_WEIGHTS.swing_structure_trend).toBe(0.3);
    expect(DEFAULT_SCORING_WEIGHTS.swing_structure_level).toBe(0.2);
  });
});

describe('scoreConfidenceDetailed — parity with no config weights', () => {
  it('produces same base score as original hardcoded value', () => {
    const setup = mkSetup('long');
    const snap = mkSnap();
    const breakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'trending_up', BASE_CONFIG);
    expect(breakdown.base).toBe(5.0);
  });

  it('gives 4-TF alignment bonus of +2.0 (original value)', () => {
    const setup = mkSetup('long');
    const snap = mkSnap();
    const breakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'trending_up', BASE_CONFIG);
    expect(breakdown.tf_alignment).toBe(2.0);
  });

  it('gives weak alignment penalty of -0.5 (original value)', () => {
    const setup = mkSetup('long');
    const snap = mkSnap();
    const breakdown = scoreConfidenceDetailed(setup, snap, NEUTRAL_BIAS, 'range_bound', BASE_CONFIG);
    expect(breakdown.tf_alignment).toBe(-0.5);
  });

  it('gives 1h conflict penalty of -1.0 when bias opposes direction', () => {
    const setup = mkSetup('long');
    const snap = mkSnap();
    const bearBias: MultiTfBias = { ...ALIGNED_BULL_BIAS, '1h': 'bearish' };
    const breakdown = scoreConfidenceDetailed(setup, snap, bearBias, 'trending_up', BASE_CONFIG);
    expect(breakdown.htf_direction).toBe(-1.0);
  });

  it('gives choppy regime penalty of -1.0 (original value)', () => {
    const setup = mkSetup('long');
    const snap = mkSnap();
    const breakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'choppy', BASE_CONFIG);
    expect(breakdown.regime_alignment).toBe(-1.0);
  });
});

// ─── 2. Config override: custom weights change scores ───────────────────────

describe('scoreConfidenceDetailed — config weight overrides', () => {
  it('uses custom base score from config', () => {
    const config = { ...BASE_CONFIG, scoring_weights: { base: 6.0 } };
    const setup = mkSetup('long');
    const snap = mkSnap();
    const breakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'trending_up', config);
    expect(breakdown.base).toBe(6.0);
  });

  it('uses custom TF alignment weight', () => {
    const config = { ...BASE_CONFIG, scoring_weights: { tf_alignment_4tf: 3.0 } };
    const setup = mkSetup('long');
    const snap = mkSnap();
    const breakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'trending_up', config);
    expect(breakdown.tf_alignment).toBe(3.0);
  });

  it('uses custom regime_adverse weight', () => {
    const config = { ...BASE_CONFIG, scoring_weights: { regime_adverse: -2.0 } };
    const setup = mkSetup('long');
    const snap = mkSnap();
    const breakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'choppy', config);
    expect(breakdown.regime_alignment).toBe(-2.0);
  });

  it('uses custom supertrend_confirms weight', () => {
    const config = { ...BASE_CONFIG, scoring_weights: { supertrend_confirms: 1.5 } };
    const setup = mkSetup('long');
    const snap = mkSnap();
    // snap has supertrend_direction='up', setup is long → confirms
    const breakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'trending_up', config);
    expect(breakdown.supertrend).toBe(1.5);
  });

  it('uses custom rr_excellent weight when RR is excellent', () => {
    const config = { ...BASE_CONFIG, scoring_weights: { rr_excellent: 1.0 } };
    const setup = mkSetup('long');
    setup.rr_t1 = 4.0; // 4.0 >= 2.0 * 1.5 = excellent
    const snap = mkSnap();
    const breakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'trending_up', config);
    expect(breakdown.rr_quality).toBe(1.0);
  });

  it('custom weight increases total score predictably', () => {
    const setup = mkSetup('long');
    const snap = mkSnap();

    const defaultBreakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'trending_up', BASE_CONFIG);
    const defaultTotal = defaultBreakdown.total;

    // Increase base by 1.0
    const config = { ...BASE_CONFIG, scoring_weights: { base: 6.0 } };
    const customBreakdown = scoreConfidenceDetailed(setup, snap, ALIGNED_BULL_BIAS, 'trending_up', config);
    const customTotal = customBreakdown.total;

    // Custom should be 1.0 higher (or clamped at 10)
    expect(customTotal).toBe(Math.min(10, Math.round((defaultTotal + 1.0) * 10) / 10));
  });
});

// ─── 3. Missing weights fallback ────────────────────────────────────────────

describe('resolveScoringWeights — fallback behavior', () => {
  it('returns all default weights when no config weights provided', () => {
    const weights = resolveScoringWeights(BASE_CONFIG);
    expect(weights).toEqual(DEFAULT_SCORING_WEIGHTS);
  });

  it('returns all default weights when scoring_weights is undefined', () => {
    const config = { ...BASE_CONFIG };
    delete config.scoring_weights;
    const weights = resolveScoringWeights(config);
    expect(weights).toEqual(DEFAULT_SCORING_WEIGHTS);
  });

  it('merges partial overrides with defaults', () => {
    const config = { ...BASE_CONFIG, scoring_weights: { base: 7.0, regime_adverse: -2.0 } };
    const weights = resolveScoringWeights(config);
    expect(weights.base).toBe(7.0);
    expect(weights.regime_adverse).toBe(-2.0);
    // All other fields should be default
    expect(weights.tf_alignment_4tf).toBe(2.0);
    expect(weights.supertrend_confirms).toBe(0.5);
    expect(weights.structural_level_bonus).toBe(0.5);
  });

  it('single override does not affect other weights', () => {
    const config = { ...BASE_CONFIG, scoring_weights: { volume_strong: 2.0 } };
    const weights = resolveScoringWeights(config);
    expect(weights.volume_strong).toBe(2.0);
    expect(weights.volume_thin).toBe(-0.5); // default preserved
    expect(weights.base).toBe(5.0); // default preserved
  });
});

// ─── 4. Config validation for scoring_weights ───────────────────────────────
// Validation tests for scoring_weights are covered in config-precedence.test.ts
// (the IndicatorConfigManager mock is set up there). Here we test the
// resolveScoringWeights function directly, which is the main validation point.

describe('resolveScoringWeights — validation behavior', () => {
  it('accepts empty scoring_weights gracefully', () => {
    const config = { ...BASE_CONFIG, scoring_weights: {} };
    const weights = resolveScoringWeights(config);
    expect(weights).toEqual(DEFAULT_SCORING_WEIGHTS);
  });

  it('accepts scoring_weights with all fields overridden', () => {
    const allOverrides: ScoringWeights = {
      base: 4.0,
      tf_alignment_4tf: 1.5,
      tf_alignment_3tf: 0.8,
      tf_alignment_2tf: 0.2,
      tf_alignment_weak: -0.3,
      htf_direction_conflict: -0.8,
      supertrend_confirms: 0.4,
      supertrend_opposes: -0.4,
      structural_level_bonus: 0.3,
      rr_excellent: 0.4,
      rr_acceptable: 0.2,
      rr_below_min: -0.4,
      volume_strong: 0.4,
      volume_thin: -0.4,
      missing_indicators_many: -0.4,
      missing_indicators_some: -0.2,
      entry_location_suboptimal: -0.2,
      regime_aligned: 0.2,
      regime_adverse: -0.8,
      swing_structure_trend: 0.2,
      swing_structure_level: 0.15,
      vwap_supports: 0.3,
      vwap_opposes: -0.3,
      or_level_supports: 0.4,
      adx_strong_trend: 0.4,
      adx_weak_trend: -0.3,
      adx_di_confirms: 0.2,
      ttm_squeeze_penalty: -0.3,
      ttm_squeeze_release: 0.3,
      cvd_divergence: -0.4,
      cvd_aligned: 0.25,
    };
    const config = { ...BASE_CONFIG, scoring_weights: allOverrides };
    const weights = resolveScoringWeights(config);
    expect(weights).toEqual(allOverrides);
  });
});

// ─── 5. No duplicate scoring in candidate path ──────────────────────────────

describe('generateSignal — no duplicate scoring (reuse invariant)', () => {
  it('bestLong scoreBreakdown.total matches score (reused, not recomputed)', () => {
    const snap = mkSnap();
    snap.price = 20000;
    snap.indicators_1m.ema_9 = 19995;
    snap.indicators_1m.ema_21 = 19980;
    snap.indicators_1m.ema_50 = 19960;
    snap.indicators_1m.supertrend_direction = 'up';

    const result = generateSignal(snap, BASE_CONFIG);

    // The result should have at least one candidate
    expect(result.bestLong).not.toBeNull();

    // The scoreBreakdown attached to the DirectionalCandidate must be the SAME
    // object that was computed during generation (not a fresh recomputation).
    // This proves the breakdown was reused, not recomputed via a second call.
    if (result.bestLong) {
      expect(result.bestLong.scoreBreakdown.total).toBe(result.bestLong.score);
      expect(result.bestLong.scoreBreakdown.total).toBe(result.bestLong.setup.confidence);
      // Verify the breakdown's factors array is the same reference as the setup's
      // (they share the same object because no re-scoring happened)
      expect(result.bestLong.scoreBreakdown.factors).toBe(result.bestLong.setup.confidence_factors);
    }
  });

  it('bestShort scoreBreakdown matches if short candidate exists', () => {
    const snap = mkSnap();
    snap.price = 20000;
    snap.indicators_1m.ema_9 = 19995;
    snap.indicators_1m.ema_21 = 19980;
    snap.indicators_1m.ema_50 = 19960;
    snap.indicators_1m.supertrend_direction = 'up';

    const result = generateSignal(snap, BASE_CONFIG);

    if (result.bestShort) {
      expect(result.bestShort.scoreBreakdown.total).toBe(result.bestShort.score);
      expect(result.bestShort.scoreBreakdown.total).toBe(result.bestShort.setup.confidence);
      expect(result.bestShort.scoreBreakdown.factors).toBe(result.bestShort.setup.confidence_factors);
    }
  });

  it('breakdown is referentially identical to setup factors (proves reuse)', () => {
    const snap = mkSnap();
    snap.price = 20000;
    snap.indicators_1m.ema_9 = 19995;
    snap.indicators_1m.ema_21 = 19980;
    snap.indicators_1m.ema_50 = 19960;
    snap.indicators_1m.supertrend_direction = 'up';

    const result = generateSignal(snap, BASE_CONFIG);

    // For every candidate that was returned, the scoreBreakdown.factors array
    // should be the exact same reference as setup.confidence_factors.
    // If scoreConfidenceDetailed had been called a second time, it would create
    // a NEW factors array (via [...setup.confidence_factors]), breaking this identity.
    if (result.bestLong) {
      expect(result.bestLong.scoreBreakdown.factors).toBe(result.bestLong.setup.confidence_factors);
    }
    if (result.bestShort) {
      expect(result.bestShort.scoreBreakdown.factors).toBe(result.bestShort.setup.confidence_factors);
    }
  });
});

// ─── 6. Factor naming clarity ───────────────────────────────────────────────

describe('ScoringWeights — naming conventions', () => {
  it('all weight field names are descriptive and unambiguous', () => {
    const weights = DEFAULT_SCORING_WEIGHTS;
    const keys = Object.keys(weights);

    // No single-letter or cryptic names
    for (const key of keys) {
      expect(key.length).toBeGreaterThan(2);
    }

    // Confirm renamed fields exist
    expect(weights).toHaveProperty('structural_level_bonus'); // was just 'structural_level'
    expect(weights).toHaveProperty('regime_adverse'); // was 'choppy_regime', now covers HVI too
    expect(weights).toHaveProperty('swing_structure_trend'); // was unnamed inline +0.3
    expect(weights).toHaveProperty('swing_structure_level'); // was unnamed inline +0.2
  });

  it('every ScoreBreakdown field has at least one corresponding weight key', () => {
    const breakdownFields = [
      'base', 'tf_alignment', 'htf_direction', 'supertrend',
      'structural_level', 'rr_quality', 'volume', 'missing_indicators',
      'entry_location', 'regime_alignment', 'swing_structure',
    ];
    const weightKeys = Object.keys(DEFAULT_SCORING_WEIGHTS);

    // Map breakdown fields to their weight key prefixes
    const prefixMap: Record<string, string> = {
      base: 'base',
      tf_alignment: 'tf_alignment',
      htf_direction: 'htf_direction',
      supertrend: 'supertrend',
      structural_level: 'structural_level',
      rr_quality: 'rr_',
      volume: 'volume',
      missing_indicators: 'missing_indicators',
      entry_location: 'entry_location',
      regime_alignment: 'regime_',
      swing_structure: 'swing_structure',
    };

    for (const field of breakdownFields) {
      const prefix = prefixMap[field] ?? field;
      const hasRelated = weightKeys.some(k => k === field || k.startsWith(prefix));
      expect(hasRelated, `No weight found for breakdown field '${field}' (prefix: '${prefix}')`).toBe(true);
    }
  });
});
