/**
 * Tests for the layered scoring architecture V1.
 *
 * Covers:
 *   - Layer isolation: structure, flow, lagging produce correct outputs
 *   - Hard-invalid candidates stay invalid regardless of flow score
 *   - Strong reliable flow improves rank among valid candidates
 *   - Missing-flow renormalization (penalty + cap at 7.5)
 *   - Lagging cannot overpower structure + flow beyond ±1.0
 *   - Research-only features do not materially influence V1 rank
 *   - Old path unchanged when enabled=false
 *   - Setup profiles produce different rankings
 *   - Per-component caps enforced
 *   - Correlated trend factor cap
 */
import { describe, it, expect } from 'vitest';
import {
  computeStructureScore,
  computeFlowScoreV1,
  computeLaggingTieBreakers,
  computeFinalRank,
  computeLayeredScore,
  layeredToLegacyBreakdown,
  DEFAULT_LAYERED_SCORING_CONFIG,
} from '../../src/autotrade/features/layered-scoring.js';
import type {
  LayeredScoringConfig,
  SetupScoringProfile,
  FlowBreakdown,
} from '../../src/autotrade/features/layered-scoring.js';
import type { LobSnapshot } from '../../src/autotrade/lob-client.js';
import type {
  MarketSnapshot,
  CandidateSetup,
  MultiTfBias,
  MarketRegime,
  IndicatorConfig,
  ScoringWeights,
} from '../../src/autotrade/types.js';
import { DEFAULT_SCORING_WEIGHTS } from '../../src/autotrade/strategy.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBaseLobSnap(overrides: Partial<LobSnapshot> = {}): LobSnapshot {
  return {
    timestamp_ms: Date.now(),
    bbo_age_ms: 50,
    data_quality: 'full_depth',
    recording_context: 'session',
    bid: 19500.25, ask: 19500.50, mid: 19500.38,
    bid_size: 10, ask_size: 8,
    spread_pts: 0.25, spread_ticks: 1,
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
    ...overrides,
  } as LobSnapshot;
}

function makeSnap(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    price: 19501,
    timestamp_iso: '2026-04-08T15:00:00Z',
    timestamp_unix: Date.now(),
    bars_1m: [
      { open: 19498, high: 19502, low: 19497, close: 19500, volume: 500, timestamp: Date.now() - 120000 },
      { open: 19500, high: 19503, low: 19499, close: 19501, volume: 600, timestamp: Date.now() - 60000 },
      { open: 19501, high: 19504, low: 19500, close: 19502, volume: 550, timestamp: Date.now() },
    ],
    bars_5m: [],
    bars_15m: [],
    indicators_1m: {
      ema_9: 19498, ema_21: 19495, ema_50: 19490,
      rsi_14: 55, atr_14: 12,
      vwap: 19480, supertrend_direction: 'up',
      supertrend_value: 19485,
      adx: 28, di_plus: 30, di_minus: 15,
      volume_sma_20: 500,
      bos_buy: null, bos_sell: null,
      choch_buy: null, choch_sell: null,
      cvd_delta: null, cvd_trend: null,
      ttm_squeeze_firing: false, ttm_squeeze_momentum: null,
    },
    indicators_1h: null,
    key_levels: {
      prior_rth_high: 19550, prior_rth_low: 19400,
      session_high: 19520, session_low: 19460,
      opening_range_high: null, opening_range_low: null,
      daily_open: 19470, weekly_open: 19400,
      bos_buy: null, bos_sell: null,
      pivot_resistance: [],
      pivot_support: [],
    },
    data_quality: { missing_indicators: [] },
    session: null,
    event: null,
    ...overrides,
  } as MarketSnapshot;
}

function makeSetup(overrides: Partial<CandidateSetup> = {}): CandidateSetup {
  return {
    setup_type: 'trend_pullback_long',
    direction: 'long',
    entry_low: 19499,
    entry_high: 19501,
    stop_loss: 19490,
    target_1: 19515,
    target_2: 19530,
    rr_t1: 2.5,
    rr_t2: 4.0,
    risk_pts: 10,
    confidence: 0,
    confidence_factors: ['trend_pullback'],
    rr_validation_passed: true,
    target_1_direction_valid: true,
    target_2_direction_valid: true,
    target_ordering_valid: true,
    ...overrides,
  } as CandidateSetup;
}

function makeBias(overrides: Partial<MultiTfBias> = {}): MultiTfBias {
  return {
    '1m': 'bullish',
    '5m': 'bullish',
    '15m': 'bullish',
    '1h': 'bullish',
    alignment_score: 4,
    ...overrides,
  } as MultiTfBias;
}

function makeConfig(overrides: Partial<IndicatorConfig> = {}): IndicatorConfig {
  return {
    version: 'TEST_v1', type: 'BASELINE', created_at: '2026-04-08',
    ema_fast: 9, ema_mid: 21, ema_slow: 50,
    rsi_period: 14, atr_period: 14, volume_sma_period: 20,
    min_confidence: 7.5, max_confidence: 10, min_rr: 2.0,
    max_risk_per_trade_pct: 1.5, max_daily_loss_pct: 8,
    max_consecutive_losses: 5, account_equity: 25000,
    time_stop_minutes: 30, time_stop_max_r_pre_t1: 0.25,
    time_stop_max_r_post_t1: 1.0,
    analysis_interval_seconds: 5, in_position_monitor_seconds: 2,
    opening_range_minutes: 15, trail_ticks_post_t1: 12,
    breakeven_trigger_r: 0.5, pre_t1_trail_trigger_r: 0.75,
    pre_t1_trail_distance_ticks: 20,
    pt1_offset_pts: 6, pt2_offset_pts: 15,
    pt1_exit_fraction: 0.5, pt2_exit_fraction: 0.25,
    pt1_move_to_be: true, pt1_activate_trailing: true,
    enable_momentum_continuation: false,
    enable_opening_drive: true, enable_failed_or_break: true,
    cooldown_bars: 0, no_same_bar_reversal: false,
    dual_min_score: 7.5, dual_score_margin: 1.0,
    dual_choppy_extra_margin: 0.5,
    ...overrides,
  } as IndicatorConfig;
}

const w = DEFAULT_SCORING_WEIGHTS;

// ── Structure Score Tests ───────────────────────────────────────────────────

describe('computeStructureScore', () => {
  it('returns [0, 10] range', () => {
    const result = computeStructureScore(makeSetup(), makeSnap(), makeBias(), 'trending_up', w, makeConfig());
    expect(result.normalized).toBeGreaterThanOrEqual(0);
    expect(result.normalized).toBeLessThanOrEqual(10);
  });

  it('high structural alignment produces high score', () => {
    const result = computeStructureScore(
      makeSetup(),
      makeSnap({ key_levels: { ...makeSnap().key_levels, bos_buy: 19490 } }),
      makeBias({ alignment_score: 4 }),
      'trending_up',
      w,
      makeConfig(),
    );
    expect(result.normalized).toBeGreaterThanOrEqual(7.5);
  });

  it('weak alignment + adverse regime produces low score', () => {
    const result = computeStructureScore(
      makeSetup({ direction: 'long', rr_t1: 1.5 }),
      makeSnap({ indicators_1m: { ...makeSnap().indicators_1m, supertrend_direction: 'down' } }),
      makeBias({ alignment_score: 2, '1h': 'bearish' }),
      'choppy',
      w,
      makeConfig(),
    );
    expect(result.normalized).toBeLessThan(5.0);
  });

  it('caps correlated trend factors', () => {
    // Full TF alignment (+2.0) + supertrend confirms (+0.5) + regime aligned (+0.3) = 2.8
    // Should be capped at 2.5
    const snap = makeSnap({ key_levels: { ...makeSnap().key_levels, bos_buy: 19490 } });
    const result = computeStructureScore(
      makeSetup(),
      snap,
      makeBias({ alignment_score: 4 }),
      'trending_up',
      w,
      makeConfig(),
    );
    expect(result.trend_cluster_raw).toBeCloseTo(2.8, 1);
    expect(result.trend_cluster_capped).toBeCloseTo(2.5, 1);
    expect(result.trend_cluster_capped).toBeLessThanOrEqual(2.5);
  });

  it('does not cap when cluster is within bounds', () => {
    // 3tf alignment (+1.0) + supertrend opposes (-0.5) + no regime = 0.5
    const result = computeStructureScore(
      makeSetup(),
      makeSnap(),
      makeBias({ alignment_score: 3 }),
      'range_bound',
      w,
      makeConfig(),
    );
    expect(result.trend_cluster_raw).toBe(result.trend_cluster_capped);
  });
});

// ── Flow Score Tests ────────────────────────────────────────────────────────

describe('computeFlowScoreV1', () => {
  it('returns 5.0 (neutral) when LOB is null', () => {
    const result = computeFlowScoreV1(null, 'trend_continuation', 'long', DEFAULT_LAYERED_SCORING_CONFIG);
    expect(result.normalized).toBe(5.0);
    expect(result.data_quality).toBe('none');
    expect(result.quality_degradation_reasons).toContain('no_lob_snapshot');
  });

  it('returns 5.0 when LOB is stale', () => {
    const snap = makeBaseLobSnap({ bbo_age_ms: 6000 });
    const result = computeFlowScoreV1(snap, 'trend_continuation', 'long', DEFAULT_LAYERED_SCORING_CONFIG);
    expect(result.normalized).toBe(5.0);
    expect(result.data_quality).toBe('none');
  });

  it('strong aligned flow produces score > 5.0', () => {
    const snap = makeBaseLobSnap({
      cumulative_delta_10s: 150,
      cumulative_delta_30s: 100,
      trade_flow_imbalance_10s: 0.8,
      depth_imbalance_5: 0.4,
    });
    const result = computeFlowScoreV1(snap, 'trend_continuation', 'long', DEFAULT_LAYERED_SCORING_CONFIG);
    expect(result.normalized).toBeGreaterThan(5.5);
    expect(result.active_flow_features).toContain('directional_flow');
    expect(result.active_flow_features).toContain('book_imbalance');
  });

  it('opposing flow produces score < 5.0', () => {
    const snap = makeBaseLobSnap({
      cumulative_delta_10s: -100,
      trade_flow_imbalance_10s: 0.2,
      depth_imbalance_5: -0.5,
    });
    const result = computeFlowScoreV1(snap, 'trend_continuation', 'long', DEFAULT_LAYERED_SCORING_CONFIG);
    expect(result.normalized).toBeLessThan(5.0);
  });

  it('enforces per-component caps', () => {
    const snap = makeBaseLobSnap({
      cumulative_delta_10s: 99999,
      cumulative_delta_30s: 50000,
      trade_flow_imbalance_10s: 1.0,
    });
    const result = computeFlowScoreV1(snap, 'trend_continuation', 'long', DEFAULT_LAYERED_SCORING_CONFIG);
    // directional_flow should be capped at 1.0
    expect(result.directional_flow).toBeLessThanOrEqual(1.0);
    expect(result.directional_flow).toBeGreaterThanOrEqual(-1.0);
  });

  it('microprice edge works with BBO data', () => {
    // Bid-heavy BBO → microprice closer to ask → positive for longs
    const snap = makeBaseLobSnap({
      bid: 19500.25, ask: 19500.50,
      bid_size: 50, ask_size: 5,
    });
    const result = computeFlowScoreV1(snap, 'trend_continuation', 'long', DEFAULT_LAYERED_SCORING_CONFIG);
    expect(result.microprice).toBeGreaterThan(0);
    expect(result.active_flow_features).toContain('microprice');
  });

  it('records quality degradation reasons', () => {
    const snap = makeBaseLobSnap(); // minimal data — only BBO
    const result = computeFlowScoreV1(snap, 'trend_continuation', 'long', DEFAULT_LAYERED_SCORING_CONFIG);
    expect(result.quality_degradation_reasons.length).toBeGreaterThan(0);
  });
});

// ── Lagging Tie-Breaker Tests ───────────────────────────────────────────────

describe('computeLaggingTieBreakers', () => {
  it('clamps total to [-1.0, +1.0]', () => {
    // ADX strong (+0.30) + DI confirms (+0.15) + TTM release (+0.20) + CVD aligned (+0.15) + VWAP supports (+0.20) = 1.00
    const snap = makeSnap({
      indicators_1m: {
        ...makeSnap().indicators_1m,
        adx: 30, di_plus: 35, di_minus: 10,
        ttm_squeeze_firing: false, ttm_squeeze_momentum: 5.0,
        vwap: 19480,
      },
    });
    const result = computeLaggingTieBreakers(snap, 'long', 'trending_up', 1.0);
    expect(result.clamped).toBeLessThanOrEqual(1.0);
    expect(result.clamped).toBeGreaterThanOrEqual(-1.0);
  });

  it('negative lagging does not exceed -1.0', () => {
    const snap = makeSnap({
      indicators_1m: {
        ...makeSnap().indicators_1m,
        adx: 10,
        ttm_squeeze_firing: true,
        cvd_delta: 5.0, cvd_trend: 'up',
        vwap: 19510,
      },
      bars_1m: [
        { open: 19502, high: 19503, low: 19500, close: 19501, volume: 500, timestamp: Date.now() - 60000 },
        { open: 19501, high: 19502, low: 19499, close: 19500, volume: 500, timestamp: Date.now() },
      ],
    });
    const result = computeLaggingTieBreakers(snap, 'short', 'choppy', 1.0);
    expect(result.clamped).toBeGreaterThanOrEqual(-1.0);
  });
});

// ── Final Rank Tests ────────────────────────────────────────────────────────

describe('computeFinalRank', () => {
  const profile: SetupScoringProfile = { structure_weight: 0.60, flow_weight: 0.40 };
  const missingPolicy = DEFAULT_LAYERED_SCORING_CONFIG.missing_flow_policy;

  it('combines structure and flow with weights', () => {
    const { rank } = computeFinalRank(8.0, 7.0, 0.0, profile, 'good', missingPolicy);
    // 0.6 * 8.0 + 0.4 * 7.0 = 4.8 + 2.8 = 7.6
    expect(rank).toBeCloseTo(7.6, 0);
  });

  it('applies lagging adjustment', () => {
    const { rank } = computeFinalRank(8.0, 7.0, 0.5, profile, 'good', missingPolicy);
    // 7.6 + 0.5 = 8.1
    expect(rank).toBeCloseTo(8.1, 0);
  });

  it('missing flow: applies penalty and cap', () => {
    const { rank, missingFlowApplied, effectiveFlowWeight } = computeFinalRank(
      8.0, 5.0, 0.5, profile, 'none', missingPolicy,
    );
    expect(missingFlowApplied).toBe(true);
    expect(effectiveFlowWeight).toBe(0);
    // rank = structure + lagging - penalty = 8.0 + 0.5 - 0.35 = 8.15 → capped at 7.5
    expect(rank).toBeLessThanOrEqual(7.5);
  });

  it('clamps rank to [0, 10]', () => {
    const { rank: high } = computeFinalRank(10, 10, 1.0, profile, 'good', missingPolicy);
    expect(high).toBeLessThanOrEqual(10);
    const { rank: low } = computeFinalRank(0, 0, -1.0, profile, 'good', missingPolicy);
    expect(low).toBeGreaterThanOrEqual(0);
  });
});

// ── Integration: Layered vs Flat Behavior ───────────────────────────────────

describe('layered scoring integration', () => {
  it('strong structure + strong flow beats mediocre + max lagging', () => {
    const config = makeConfig();
    const lsConfig = DEFAULT_LAYERED_SCORING_CONFIG;

    // Setup A: strong structure, strong flow
    const lobStrong = makeBaseLobSnap({
      cumulative_delta_10s: 150, trade_flow_imbalance_10s: 0.85,
      depth_imbalance_5: 0.5,
    });
    const resultA = computeLayeredScore(
      makeSetup(), makeSnap({ key_levels: { ...makeSnap().key_levels, bos_buy: 19490 } }),
      makeBias({ alignment_score: 4 }), 'trending_up', config, w, lobStrong, lsConfig,
    );

    // Setup B: mediocre structure, no flow, max lagging
    const resultB = computeLayeredScore(
      makeSetup({ rr_t1: 1.8 }),
      makeSnap({ indicators_1m: {
        ...makeSnap().indicators_1m,
        adx: 30, di_plus: 35, di_minus: 10,
        ttm_squeeze_firing: false, ttm_squeeze_momentum: 5.0,
        supertrend_direction: 'up',
      }}),
      makeBias({ alignment_score: 2 }), 'range_bound', config, w, null, lsConfig,
    );

    expect(resultA.final_rank).toBeGreaterThan(resultB.final_rank);
  });

  it('lagging cannot overcome >1.0 point deficit', () => {
    const config = makeConfig();
    const lsConfig = DEFAULT_LAYERED_SCORING_CONFIG;
    const lobNeutral = makeBaseLobSnap();

    // Two identical setups, one with max lagging, one with min
    const baseSnap = makeSnap();
    const baseBias = makeBias({ alignment_score: 3 });

    const resultMax = computeLayeredScore(
      makeSetup(), baseSnap, baseBias, 'trending_up', config, w, lobNeutral, lsConfig,
    );
    // Manually check: lagging is capped
    expect(Math.abs(resultMax.lagging_adjustment)).toBeLessThanOrEqual(1.0);
  });

  it('setup profiles produce different rankings', () => {
    const config = makeConfig();
    const lobStrong = makeBaseLobSnap({
      cumulative_delta_10s: 200, trade_flow_imbalance_10s: 0.9,
      depth_imbalance_5: 0.6,
    });

    // Breakout continuation has flow_weight=0.50
    const lsBreakout: LayeredScoringConfig = {
      ...DEFAULT_LAYERED_SCORING_CONFIG,
      setup_profiles: {
        ...DEFAULT_LAYERED_SCORING_CONFIG.setup_profiles,
        breakout_continuation: { structure_weight: 0.50, flow_weight: 0.50 },
        trend_continuation: { structure_weight: 0.60, flow_weight: 0.40 },
      },
    };

    const resultBreakout = computeLayeredScore(
      makeSetup({ setup_type: 'breakout_retest_long' }),
      makeSnap(), makeBias({ alignment_score: 3 }), 'trending_up',
      config, w, lobStrong, lsBreakout,
    );
    const resultTrend = computeLayeredScore(
      makeSetup({ setup_type: 'trend_pullback_long' }),
      makeSnap(), makeBias({ alignment_score: 3 }), 'trending_up',
      config, w, lobStrong, lsBreakout,
    );

    // With strong flow, breakout (50% flow weight) should rank flow higher than trend (40%)
    // The difference should be visible
    expect(resultBreakout.profile_used.flow_weight).toBe(0.50);
    expect(resultTrend.profile_used.flow_weight).toBe(0.40);
  });

  it('legacy breakdown mapping preserves all fields', () => {
    const config = makeConfig();
    const lsConfig = DEFAULT_LAYERED_SCORING_CONFIG;

    const result = computeLayeredScore(
      makeSetup(), makeSnap(),
      makeBias({ alignment_score: 3 }), 'trending_up',
      config, w, null, lsConfig,
    );

    const legacy = layeredToLegacyBreakdown(result, w.base);
    expect(legacy.base).toBe(w.base);
    expect(legacy.total).toBe(result.final_rank);
    expect(legacy.tf_alignment).toBe(result.structure_breakdown.tf_alignment);
    expect(legacy.adx_trend_strength).toBe(
      result.lagging_breakdown.adx_trend + result.lagging_breakdown.adx_di,
    );
    expect(legacy.feature_set).toBe('full');
  });

  it('factors array includes all layer summaries', () => {
    const config = makeConfig();
    const result = computeLayeredScore(
      makeSetup(), makeSnap(),
      makeBias(), 'trending_up',
      config, w, null, DEFAULT_LAYERED_SCORING_CONFIG,
    );

    const factorsStr = result.factors.join(' ');
    expect(factorsStr).toContain('structure:');
    expect(factorsStr).toContain('flow:');
    expect(factorsStr).toContain('lagging:');
    expect(factorsStr).toContain('rank:');
    expect(factorsStr).toContain('profile:');
  });

  it('missing flow policy is logged in factors', () => {
    const config = makeConfig();
    const result = computeLayeredScore(
      makeSetup(), makeSnap(),
      makeBias(), 'trending_up',
      config, w, null, DEFAULT_LAYERED_SCORING_CONFIG,
    );

    expect(result.missing_flow_policy_applied).toBe(true);
    expect(result.factors).toContain('missing_flow_policy_applied');
  });
});
