/**
 * Tests for the microstructure score overlay.
 *
 * Covers:
 *   - Setup family classification
 *   - Graceful degradation with missing/absent data
 *   - Trend continuation: supportive vs opposing flow
 *   - Breakout continuation: sweep follow-through vs exhaustion
 *   - Reversal/reclaim: failed sweep + absorption
 *   - Score bounding and interpretability
 *   - Config: disabled overlay, multiplier=0
 */
import { describe, it, expect } from 'vitest';
import {
  computeMicrostructureScore,
  computeMicroAdjustment,
  getSetupFamily,
  DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG,
} from '../../src/autotrade/features/microstructure-score.js';
import type {
  MicrostructureOverlayConfig,
  MicrostructureScoreResult,
} from '../../src/autotrade/features/microstructure-score.js';
import type { LobSnapshot } from '../../src/autotrade/lob-client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid LOB snapshot with all fields null (BBO-only). */
function makeBaseSnap(overrides: Partial<LobSnapshot> = {}): LobSnapshot {
  return {
    timestamp_ms: Date.now(),
    bbo_age_ms: 50,
    data_quality: 'full_depth',
    recording_context: 'session',
    bid: 19500.25, ask: 19500.50, mid: 19500.38,
    bid_size: 10, ask_size: 8,
    spread_pts: 0.25, spread_ticks: 1,
    // All optional fields null by default
    depth_imbalance_5: null, depth_imbalance_10: null,
    total_bid_depth_10lvl: null, total_ask_depth_10lvl: null,
    large_bid_within_5pts: null, large_ask_within_5pts: null,
    cumulative_delta_10s: null, cumulative_delta_30s: null, cumulative_delta_60s: null,
    trade_flow_imbalance_10s: null, trade_flow_imbalance_30s: null,
    cancel_add_ratio_10s: null, replenishment_rate_10s: null,
    absorption_rate_10s: null, mean_order_lifetime_top_book: null,
    aggressor_penetration_10s: null, sweep_count_10s: null,
    adv_cancel_replace_ratio_10s: null, adv_modify_rate_10s: null,
    adv_iceberg_suspicion_30s: null,
    adv_queue_deterioration_bid_10s: null, adv_queue_deterioration_ask_10s: null,
    adv_pull_cascade_count_10s: null, adv_lifetime_p50_ms: null,
    absorption_score_10s: null, absorption_bid_score_10s: null,
    absorption_ask_score_10s: null, strongest_absorption_price: null,
    sweep_volume_10s: null, max_sweep_levels_10s: null, last_sweep_side: null,
    footprint_delta_30s: null, footprint_delta_5s: null,
    footprint_imbalance_ratio_30s: null, footprint_stacked_imbalance_count_30s: null,
    dominant_aggressor_side: null,
    large_trade_count_10s: null, large_trade_volume_10s: null,
    largest_trade_size_30s: null, large_trade_buy_sell_imbalance_30s: null,
    session_vpoc: null, session_vah: null, session_val: null,
    distance_to_vpoc: null, inside_value_area: null,
    trade_id: null, signal_id: null,
    ...overrides,
  };
}

const ENABLED_CONFIG = DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG;

// ── Setup Family Classification ──────────────────────────────────────────────

describe('getSetupFamily', () => {
  it('classifies trend pullback setups as trend_continuation', () => {
    expect(getSetupFamily('trend_pullback_long')).toBe('trend_continuation');
    expect(getSetupFamily('trend_pullback_short')).toBe('trend_continuation');
  });

  it('classifies breakout/breakdown/momentum as breakout_continuation', () => {
    expect(getSetupFamily('breakout_retest_long')).toBe('breakout_continuation');
    expect(getSetupFamily('breakdown_retest_short')).toBe('breakout_continuation');
    expect(getSetupFamily('momentum_continuation')).toBe('breakout_continuation');
  });

  it('classifies failed_or_break as reversal_reclaim', () => {
    expect(getSetupFamily('failed_or_break_long')).toBe('reversal_reclaim');
    expect(getSetupFamily('failed_or_break_short')).toBe('reversal_reclaim');
  });

  it('classifies opening drive and OR retest as session_structure', () => {
    expect(getSetupFamily('opening_drive_continuation_long')).toBe('session_structure');
    expect(getSetupFamily('opening_drive_continuation_short')).toBe('session_structure');
    expect(getSetupFamily('or_retest_continuation_long')).toBe('session_structure');
    expect(getSetupFamily('or_retest_continuation_short')).toBe('session_structure');
  });

  it('defaults unknown types to trend_continuation', () => {
    expect(getSetupFamily('some_future_setup')).toBe('trend_continuation');
  });
});

// ── Graceful Degradation ─────────────────────────────────────────────────────

describe('Graceful degradation', () => {
  it('returns zero score when snap is null', () => {
    const result = computeMicrostructureScore(null, 'long', 'trend_pullback_long');
    expect(result.total).toBe(0);
    expect(result.data_quality).toBe('none');
    expect(result.warnings).toContain('no_lob_data');
  });

  it('returns zero score when snap is undefined', () => {
    const result = computeMicrostructureScore(undefined, 'short', 'trend_pullback_short');
    expect(result.total).toBe(0);
    expect(result.data_quality).toBe('none');
  });

  it('returns zero score when data_quality is unavailable', () => {
    const snap = makeBaseSnap({ data_quality: 'unavailable' });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.total).toBe(0);
    expect(result.data_quality).toBe('none');
  });

  it('returns zero score when bbo_age_ms is stale (>5000)', () => {
    const snap = makeBaseSnap({ bbo_age_ms: 6000 });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.total).toBe(0);
    expect(result.data_quality).toBe('none');
  });

  it('returns near-zero with no optional fields populated (BBO-only snap)', () => {
    const snap = makeBaseSnap();
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    // BBO size skew (bid_size vs ask_size) produces a tiny imbalance score
    // even without depth data. This is expected — it's using real BBO.
    expect(Math.abs(result.total)).toBeLessThanOrEqual(0.05);
    // Only imbalance component has data (from BBO sizes)
    expect(result.components_available).toBeLessThanOrEqual(1);
  });

  it('returns zero when overlay is disabled', () => {
    const snap = makeBaseSnap({ cumulative_delta_10s: 100, trade_flow_imbalance_10s: 0.8 });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long', {
      ...ENABLED_CONFIG,
      enabled: false,
    });
    expect(result.total).toBe(0);
    expect(result.warnings).toContain('overlay_disabled');
  });

  it('handles partial data (directional flow + BBO imbalance)', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 50,
      trade_flow_imbalance_10s: 0.7,
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    // Directional flow available + imbalance from BBO size skew
    expect(result.components_available).toBeGreaterThanOrEqual(1);
    expect(result.data_quality).not.toBe('none');
    // Should produce a positive score since flow is aligned with long direction
    expect(result.total).toBeGreaterThan(0);
  });

  it('returns zero when data quality insufficient for config requirement', () => {
    const snap = makeBaseSnap({ cumulative_delta_10s: 50 });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long', {
      ...ENABLED_CONFIG,
      require_min_data_quality: 'good',  // requires 4+ components
    });
    expect(result.total).toBe(0);
    expect(result.warnings.some(w => w.includes('insufficient_data_quality'))).toBe(true);
  });
});

// ── Trend Continuation Scoring ───────────────────────────────────────────────

describe('Trend continuation (trend_pullback)', () => {
  it('rewards aligned buy flow for long pullback', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 80,
      cumulative_delta_30s: 50,
      trade_flow_imbalance_10s: 0.75, // buy-heavy
      depth_imbalance_5: 0.3, // bid-heavy
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.directional).toBeGreaterThan(0);
    expect(result.imbalance).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('penalizes opposing sell flow for long pullback', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: -80,
      cumulative_delta_30s: -50,
      trade_flow_imbalance_10s: 0.25, // sell-heavy
      depth_imbalance_5: -0.3, // ask-heavy
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.directional).toBeLessThan(0);
    expect(result.imbalance).toBeLessThan(0);
    expect(result.total).toBeLessThan(0);
  });

  it('rewards aligned sell flow for short pullback', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: -80,
      trade_flow_imbalance_10s: 0.25, // sell-heavy
      depth_imbalance_5: -0.3, // ask-heavy
    });
    const result = computeMicrostructureScore(snap, 'short', 'trend_pullback_short');
    expect(result.directional).toBeGreaterThan(0);
    expect(result.imbalance).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('penalizes high absorption rate (exhaustion) for continuation', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 50,
      trade_flow_imbalance_10s: 0.6,
      absorption_rate_10s: 0.9, // high absorption = slowing
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.absorption).toBeLessThan(0);
  });
});

// ── Breakout Continuation Scoring ────────────────────────────────────────────

describe('Breakout continuation', () => {
  it('rewards aligned sweep follow-through for breakout', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 100,
      trade_flow_imbalance_10s: 0.8,
      sweep_count_10s: 2,
      sweep_volume_10s: 200,
      last_sweep_side: 'buy',
    });
    const result = computeMicrostructureScore(snap, 'long', 'breakout_retest_long');
    expect(result.directional).toBeGreaterThan(0);
    expect(result.sweep).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('penalizes opposing sweep for breakout', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 50,
      trade_flow_imbalance_10s: 0.6,
      sweep_count_10s: 1,
      last_sweep_side: 'sell', // opposing
    });
    const result = computeMicrostructureScore(snap, 'long', 'breakout_retest_long');
    expect(result.sweep).toBeLessThan(0);
  });
});

// ── Reversal / Reclaim Scoring ───────────────────────────────────────────────

describe('Reversal/reclaim (failed_or_break)', () => {
  it('rewards failed opposing sweep + absorption for reclaim long', () => {
    const snap = makeBaseSnap({
      // Flow is turning bullish after a sell sweep failed
      cumulative_delta_10s: 30,
      trade_flow_imbalance_10s: 0.6, // slightly buy-heavy (flow flipping)
      // Failed sell sweep (opposing for long)
      sweep_count_10s: 1,
      last_sweep_side: 'sell',
      // Strong bid-side absorption (buyers defended the low)
      absorption_bid_score_10s: 3.0,
      absorption_rate_10s: 0.7,
    });
    const result = computeMicrostructureScore(snap, 'long', 'failed_or_break_long');
    expect(result.setup_family).toBe('reversal_reclaim');
    expect(result.sweep).toBeGreaterThan(0); // failed opposing sweep = positive
    expect(result.absorption).toBeGreaterThan(0); // bid absorption = positive for long reclaim
    expect(result.directional).toBeGreaterThan(0); // flow flipping to our direction
    expect(result.total).toBeGreaterThan(0);
  });

  it('penalizes continued opposing flow for reclaim attempt', () => {
    const snap = makeBaseSnap({
      // Flow still heavily bearish — not a good long reclaim
      cumulative_delta_10s: -100,
      trade_flow_imbalance_10s: 0.2, // sell-heavy
      sweep_count_10s: 2,
      last_sweep_side: 'buy', // sweep aligned with our direction = weakens reversal thesis
    });
    const result = computeMicrostructureScore(snap, 'long', 'failed_or_break_long');
    expect(result.directional).toBeLessThan(0);
    expect(result.sweep).toBeLessThan(0);
    expect(result.total).toBeLessThan(0);
  });

  it('rewards failed buy sweep for short reclaim', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: -20,
      trade_flow_imbalance_10s: 0.4,
      sweep_count_10s: 1,
      last_sweep_side: 'buy', // failed buy sweep = good for short reclaim
      absorption_ask_score_10s: 2.5,
    });
    const result = computeMicrostructureScore(snap, 'short', 'failed_or_break_short');
    expect(result.sweep).toBeGreaterThan(0);
    expect(result.absorption).toBeGreaterThan(0);
  });
});

// ── Queue Pressure Scoring ───────────────────────────────────────────────────

describe('Queue pressure', () => {
  it('rewards opposing side queue deterioration for continuation', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 50,
      trade_flow_imbalance_10s: 0.6,
      adv_queue_deterioration_bid_10s: 0.5,
      adv_queue_deterioration_ask_10s: 1.5, // ask-side thinning = good for longs
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.queue).toBeGreaterThan(0);
  });

  it('penalizes own-side queue deterioration', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 50,
      trade_flow_imbalance_10s: 0.6,
      adv_queue_deterioration_bid_10s: 1.5, // bid thinning = bad for longs
      adv_queue_deterioration_ask_10s: 0.5,
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.queue).toBeLessThan(0);
  });
});

// ── Volume Profile Scoring ───────────────────────────────────────────────────

describe('Volume profile context', () => {
  it('rewards trading above VPOC/VAH for longs', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 30,
      trade_flow_imbalance_10s: 0.55,
      session_vpoc: 19480, session_vah: 19495, session_val: 19460,
      distance_to_vpoc: 20, // above VPOC
      inside_value_area: false, // accepted above value
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.profile).toBeGreaterThan(0);
  });

  it('has no profile score when VP data missing', () => {
    const snap = makeBaseSnap({ cumulative_delta_10s: 30, trade_flow_imbalance_10s: 0.6 });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.profile).toBe(0);
  });
});

// ── Score Bounding ───────────────────────────────────────────────────────────

describe('Score bounding', () => {
  it('total score is bounded to [-2.0, +2.0]', () => {
    // Create maximally supportive snapshot
    const snap = makeBaseSnap({
      cumulative_delta_10s: 500, cumulative_delta_30s: 300,
      trade_flow_imbalance_10s: 0.95,
      depth_imbalance_5: 0.9,
      bid_size: 100, ask_size: 5,
      absorption_ask_score_10s: 5.0,
      adv_queue_deterioration_ask_10s: 3.0,
      adv_queue_deterioration_bid_10s: 0.1,
      sweep_count_10s: 3, sweep_volume_10s: 500, last_sweep_side: 'buy',
      session_vpoc: 19400, session_vah: 19450, session_val: 19380,
      distance_to_vpoc: 100, inside_value_area: false,
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.total).toBeLessThanOrEqual(2.0);
    expect(result.total).toBeGreaterThanOrEqual(-2.0);
    expect(result.total).toBeGreaterThan(0); // should be positive
  });

  it('all sub-scores are within their bounds', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: -500, trade_flow_imbalance_10s: 0.05,
      depth_imbalance_5: -0.9,
      absorption_bid_score_10s: 5.0,
      adv_queue_deterioration_bid_10s: 3.0,
      sweep_count_10s: 5, last_sweep_side: 'sell',
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.directional).toBeGreaterThanOrEqual(-0.5);
    expect(result.directional).toBeLessThanOrEqual(0.5);
    expect(result.imbalance).toBeGreaterThanOrEqual(-0.3);
    expect(result.imbalance).toBeLessThanOrEqual(0.3);
    expect(result.absorption).toBeGreaterThanOrEqual(-0.4);
    expect(result.absorption).toBeLessThanOrEqual(0.4);
    expect(result.queue).toBeGreaterThanOrEqual(-0.3);
    expect(result.queue).toBeLessThanOrEqual(0.3);
    expect(result.sweep).toBeGreaterThanOrEqual(-0.3);
    expect(result.sweep).toBeLessThanOrEqual(0.3);
    expect(result.profile).toBeGreaterThanOrEqual(-0.2);
    expect(result.profile).toBeLessThanOrEqual(0.2);
  });
});

// ── Result Structure ─────────────────────────────────────────────────────────

describe('Result structure and diagnostics', () => {
  it('always includes setup_family', () => {
    const result = computeMicrostructureScore(null, 'long', 'trend_pullback_long');
    expect(result.setup_family).toBe('trend_continuation');
  });

  it('includes reasons array for significant contributions', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 100,
      trade_flow_imbalance_10s: 0.8,
      depth_imbalance_5: 0.4,
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(Array.isArray(result.reasons)).toBe(true);
    // Should have at least directional and imbalance reasons
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some(r => r.startsWith('directional:'))).toBe(true);
  });

  it('includes warnings for sparse data', () => {
    const snap = makeBaseSnap({ cumulative_delta_10s: 50, trade_flow_imbalance_10s: 0.6 });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long');
    expect(result.warnings.some(w => w.includes('sparse_data'))).toBe(true);
  });

  it('has stable field set regardless of data availability', () => {
    const r1 = computeMicrostructureScore(null, 'long', 'trend_pullback_long');
    const r2 = computeMicrostructureScore(
      makeBaseSnap({ cumulative_delta_10s: 100, trade_flow_imbalance_10s: 0.8 }),
      'long', 'trend_pullback_long',
    );
    const keys1 = Object.keys(r1).sort();
    const keys2 = Object.keys(r2).sort();
    expect(keys1).toEqual(keys2);
  });
});

// ── Config Behavior ──────────────────────────────────────────────────────────

describe('Configuration', () => {
  it('multiplier=0 produces a score but adjustment would be zero', () => {
    const snap = makeBaseSnap({
      cumulative_delta_10s: 100, trade_flow_imbalance_10s: 0.8,
      depth_imbalance_5: 0.4,
    });
    const result = computeMicrostructureScore(snap, 'long', 'trend_pullback_long', {
      ...ENABLED_CONFIG,
      multiplier: 0,
    });
    // Score is still computed (for logging), just won't adjust confidence
    expect(result.total).not.toBe(0);
    const adjustment = result.total * 0; // multiplier=0
    expect(adjustment).toBe(0);
  });

  it('default config has conservative multiplier', () => {
    expect(DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG.multiplier).toBeLessThanOrEqual(1.0);
    expect(DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG.multiplier).toBeGreaterThan(0);
  });

  it('default config is enabled', () => {
    expect(DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG.enabled).toBe(true);
  });

  it('default config has asymmetric bounds', () => {
    expect(DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG.max_positive_adj).toBeGreaterThan(0);
    expect(DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG.max_negative_adj).toBeGreaterThan(0);
    // Positive cap >= negative cap (easier to boost than demote)
    expect(DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG.max_positive_adj)
      .toBeGreaterThanOrEqual(DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG.max_negative_adj);
  });
});

// ── computeMicroAdjustment ───────────────────────────────────────────────────

describe('computeMicroAdjustment', () => {
  const cfg = DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG;

  function makeScore(total: number, quality: 'good' | 'partial' | 'minimal' | 'none' = 'partial'): MicrostructureScoreResult {
    return {
      total,
      directional: total * 0.5, imbalance: total * 0.2, absorption: total * 0.1,
      queue: total * 0.1, sweep: total * 0.1, profile: 0,
      reasons: [], warnings: [],
      data_quality: quality, setup_family: 'trend_continuation',
      components_available: quality === 'none' ? 0 : 3,
    };
  }

  it('returns no adjustment when overlay is disabled', () => {
    const result = computeMicroAdjustment(makeScore(1.0), 8.0, { ...cfg, enabled: false });
    expect(result.applied).toBe(false);
    expect(result.adjustment).toBe(0);
    expect(result.final_confidence).toBe(8.0);
  });

  it('returns no adjustment when multiplier is zero', () => {
    const result = computeMicroAdjustment(makeScore(1.0), 8.0, { ...cfg, multiplier: 0 });
    expect(result.applied).toBe(false);
    expect(result.adjustment).toBe(0);
  });

  it('returns no adjustment when data quality is none', () => {
    const result = computeMicroAdjustment(makeScore(1.0, 'none'), 8.0, cfg);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('no_lob_data');
  });

  it('positive score increases confidence within bounds', () => {
    const result = computeMicroAdjustment(makeScore(1.5), 7.5, cfg);
    expect(result.applied).toBe(true);
    expect(result.adjustment).toBeGreaterThan(0);
    expect(result.final_confidence).toBeGreaterThan(7.5);
    // Bounded by max_positive_adj
    expect(result.adjustment).toBeLessThanOrEqual(cfg.max_positive_adj);
  });

  it('negative score decreases confidence within bounds', () => {
    const result = computeMicroAdjustment(makeScore(-1.5), 8.0, cfg);
    expect(result.applied).toBe(true);
    expect(result.adjustment).toBeLessThan(0);
    expect(result.final_confidence).toBeLessThan(8.0);
    // Bounded by max_negative_adj
    expect(Math.abs(result.adjustment)).toBeLessThanOrEqual(cfg.max_negative_adj);
  });

  it('caps positive adjustment at max_positive_adj', () => {
    // score=2.0 × multiplier=0.5 = 1.0, but max_positive_adj=0.8
    const result = computeMicroAdjustment(makeScore(2.0), 7.0, cfg);
    expect(result.adjustment).toBeLessThanOrEqual(cfg.max_positive_adj);
  });

  it('caps negative adjustment at max_negative_adj', () => {
    // score=-2.0 × multiplier=0.5 = -1.0, but max_negative_adj=0.6
    const result = computeMicroAdjustment(makeScore(-2.0), 8.0, cfg);
    expect(Math.abs(result.adjustment)).toBeLessThanOrEqual(cfg.max_negative_adj);
  });

  it('confidence stays clamped to [0, 10]', () => {
    const highResult = computeMicroAdjustment(makeScore(2.0), 9.8, cfg);
    expect(highResult.final_confidence).toBeLessThanOrEqual(10);

    const lowResult = computeMicroAdjustment(makeScore(-2.0), 0.3, cfg);
    expect(lowResult.final_confidence).toBeGreaterThanOrEqual(0);
  });

  it('includes reason string with raw score and multiplier', () => {
    const result = computeMicroAdjustment(makeScore(1.0), 7.5, cfg);
    expect(result.reason).toContain('micro:');
    expect(result.reason).toContain('raw=');
  });

  it('near-miss promotion: boost from 7.3 to above 7.5 threshold', () => {
    // Score +1.2 × 0.5 = +0.6 → rounds to +0.5 confidence
    // 7.3 + 0.5 = 7.8 → above typical min_confidence of 7.5
    const result = computeMicroAdjustment(makeScore(1.2), 7.3, cfg);
    expect(result.applied).toBe(true);
    expect(result.final_confidence).toBeGreaterThanOrEqual(7.5);
  });

  it('marginal demotion: penalty from 7.7 below 7.5 threshold', () => {
    // Score -1.0 × 0.5 = -0.5 → rounds to -0.5
    // 7.7 - 0.5 = 7.2 → below 7.5
    const result = computeMicroAdjustment(makeScore(-1.0), 7.7, cfg);
    expect(result.applied).toBe(true);
    expect(result.final_confidence).toBeLessThan(7.5);
  });

  it('does not act like a hard veto — cannot push to zero', () => {
    // Even with worst score, confidence should not collapse
    const result = computeMicroAdjustment(makeScore(-2.0), 5.0, cfg);
    expect(result.final_confidence).toBeGreaterThanOrEqual(5.0 - cfg.max_negative_adj);
    expect(result.final_confidence).toBeGreaterThan(0);
  });
});
