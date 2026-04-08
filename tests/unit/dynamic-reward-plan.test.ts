/**
 * Tests for the dynamic reward planning system.
 *
 * Covers:
 *   - Family-aware baseline RR
 *   - Regime adjustments
 *   - Structure/extension adjustments
 *   - Microstructure adjustments
 *   - RR clamping
 *   - Management PT alignment
 *   - Legacy fallback
 *   - Integration with applyHardGates
 *   - Integration with RiskManager.preTradeCheck
 */
import { describe, it, expect } from 'vitest';
import {
  buildDynamicRewardPlan,
  buildLegacyRewardPlan,
  DEFAULT_DYNAMIC_REWARD_CONFIG,
} from '../../src/autotrade/features/dynamic-reward-plan.js';
import type { DynamicRewardConfig } from '../../src/autotrade/features/dynamic-reward-plan.js';
import type { ExtensionFeatures } from '../../src/autotrade/features/extension.js';
import type { MicrostructureScoreResult } from '../../src/autotrade/features/microstructure-score.js';
import { applyHardGates } from '../../src/autotrade/strategy.js';
import { RiskManager } from '../../src/autotrade/risk.js';
import type { CandidateSetup, MarketSnapshot, MarketRegime, IndicatorConfig, MultiTfBias } from '../../src/autotrade/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSetup(overrides: Partial<CandidateSetup> = {}): CandidateSetup {
  return {
    direction: 'long',
    setup_type: 'trend_pullback_long',
    entry_low: 19500,
    entry_high: 19502,
    stop: 19490,
    target_1: 19525,
    target_2: 19545,
    target_3: null,
    risk_pts: 11,
    rr_t1: 2.27,
    rr_t2: 4.09,
    confidence: 8.0,
    confidence_factors: ['trend_pullback', 'ema_stack_bullish'],
    reason: 'test',
    target_1_direction_valid: true,
    target_2_direction_valid: true,
    target_3_direction_valid: true,
    rr_validation_passed: true,
    target_ordering_valid: true,
    target_repair_applied: false,
    target_repair_reason: '',
    ...overrides,
  };
}

function makeSnap(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    price: 19501,
    timestamp_iso: '2026-04-08T15:00:00Z',
    timestamp_unix: Date.now(),
    bars_1m: [],
    bars_5m: [],
    bars_15m: [],
    indicators_1m: {
      ema_9: 19498, ema_21: 19495, ema_50: 19490,
      rsi_14: 55, atr_14: 12,
      vwap: 19480, supertrend_direction: 'up',
      supertrend_value: 19485,
      adx_14: 25, adx_di_plus: 30, adx_di_minus: 15,
      volume_sma_20: 500,
      smart_money_bos_buy: null, smart_money_bos_sell: null,
      smart_money_choch_buy: null, smart_money_choch_sell: null,
      cvd_value: null, ttm_squeeze_on: false,
    },
    indicators_1h: null,
    key_levels: {
      prior_rth_high: 19550, prior_rth_low: 19400,
      session_high: 19520, session_low: 19460,
      opening_range_high: null, opening_range_low: null,
      daily_open: 19470, weekly_open: 19400,
      pivot_resistance: [19530, 19560],
      pivot_support: [19470, 19440],
    },
    session: null,
    event: null,
    ...overrides,
  } as MarketSnapshot;
}

function makeConfig(overrides: Partial<IndicatorConfig> = {}): IndicatorConfig {
  return {
    version: 'TEST_v1',
    type: 'BASELINE',
    created_at: '2026-04-08',
    ema_fast: 9, ema_mid: 21, ema_slow: 50,
    rsi_period: 14, atr_period: 14, volume_sma_period: 20,
    min_confidence: 7.5, max_confidence: 10, min_rr: 2.0,
    max_risk_per_trade_pct: 1.5, max_daily_loss_pct: 8,
    max_consecutive_losses: 5, account_equity: 25000,
    time_stop_minutes: 30,
    time_stop_max_r_pre_t1: 0.25, time_stop_max_r_post_t1: 1.0,
    analysis_interval_seconds: 5, in_position_monitor_seconds: 2,
    opening_range_minutes: 15, trail_ticks_post_t1: 12,
    breakeven_trigger_r: 0.5,
    pre_t1_trail_trigger_r: 0.75, pre_t1_trail_distance_ticks: 20,
    pt1_offset_pts: 6, pt2_offset_pts: 15,
    pt1_exit_fraction: 0.5, pt2_exit_fraction: 0.25,
    pt1_move_to_be: true, pt1_activate_trailing: true,
    enable_momentum_continuation: false,
    enable_opening_drive: true, enable_failed_or_break: true,
    cooldown_bars: 0, no_same_bar_reversal: false,
    dual_min_score: 7.5, dual_score_margin: 1.0,
    dual_choppy_extra_margin: 0.5,
    management_profiles: {
      trend_pullback: {
        name: 'trend_pullback', family: 'trend_pullback',
        pt1_offset_atr: 0.5, pt2_offset_atr: 1.2,
        pt1_offset_pts_fallback: 6, pt2_offset_pts_fallback: 15,
        pt1_exit_fraction: 0.5, pt2_exit_fraction: 0.25,
        pt1_move_to_be: true, pt1_activate_trailing: true,
        trail_atr_post_t1: 0.5, trail_ticks_post_t1_fallback: 12,
        breakeven_trigger_r: 0.5,
        pre_t1_trail_trigger_r: 0.75, pre_t1_trail_atr: 0.4,
        pre_t1_trail_ticks_fallback: 20,
        time_stop_minutes: 30, time_stop_max_r_pre_t1: 0.25,
        time_stop_max_r_post_t1: 1.0,
      },
      failed_or_break: {
        name: 'failed_or_break', family: 'failed_or_break',
        pt1_offset_atr: 0.4, pt2_offset_atr: 0.9,
        pt1_offset_pts_fallback: 5, pt2_offset_pts_fallback: 11,
        pt1_exit_fraction: 0.5, pt2_exit_fraction: 0.25,
        pt1_move_to_be: true, pt1_activate_trailing: true,
        trail_atr_post_t1: 0.5, trail_ticks_post_t1_fallback: 12,
        breakeven_trigger_r: 0.4,
        pre_t1_trail_trigger_r: 0.75, pre_t1_trail_atr: 0.4,
        pre_t1_trail_ticks_fallback: 20,
        time_stop_minutes: 25, time_stop_max_r_pre_t1: 0.25,
        time_stop_max_r_post_t1: 1.0,
      },
    },
    ...overrides,
  } as IndicatorConfig;
}

function makeExtension(overrides: Partial<ExtensionFeatures> = {}): ExtensionFeatures {
  return {
    dist_from_vwap_pts: 20, dist_from_vwap_atr: 1.5,
    dist_from_ema9_atr: 0.3, dist_from_ema21_atr: 0.8, dist_from_ema50_atr: 1.2,
    current_impulse_pts: 15, current_impulse_atr: 1.2,
    bars_since_impulse_start: 5,
    last_3_bar_return_atr: 0.8, last_5_bar_return_atr: 1.0,
    consecutive_push_bars: 3, bars_since_last_pullback: 4,
    range_expansion_ratio: 1.1,
    upside_room_pts: 30, upside_room_atr: 2.5,
    downside_room_pts: 40, downside_room_atr: 3.3,
    reset_occurred: true, pullback_depth_pts: 8,
    pullback_depth_pct_of_impulse: 0.5, bars_in_pullback: 3,
    no_reset_extension: false,
    ...overrides,
  };
}

function makeMicroScore(total: number, quality: 'good' | 'partial' | 'minimal' | 'none' = 'partial'): MicrostructureScoreResult {
  return {
    total,
    directional: total * 0.5, imbalance: total * 0.2, absorption: total * 0.1,
    queue: total * 0.1, sweep: total * 0.1, profile: 0,
    reasons: [], warnings: [],
    data_quality: quality, setup_family: 'trend_continuation',
    components_available: quality === 'good' ? 5 : quality === 'partial' ? 3 : 1,
  };
}

// ── Family-Aware Baseline RR ─────────────────────────────────────────────────

describe('Family-aware baseline RR', () => {
  const snap = makeSnap();
  const config = makeConfig();

  it('trend_pullback gets lower baseline than failed_or_break', () => {
    const trendPlan = buildDynamicRewardPlan(
      makeSetup({ setup_type: 'trend_pullback_long' }), snap, 'trending_up', config,
    );
    const reversalPlan = buildDynamicRewardPlan(
      makeSetup({ setup_type: 'failed_or_break_long' }), snap, 'trending_up', config,
    );
    expect(trendPlan.rr_base).toBeLessThan(reversalPlan.rr_base);
  });

  it('opening_drive gets lower baseline than breakout_retest', () => {
    const orPlan = buildDynamicRewardPlan(
      makeSetup({ setup_type: 'opening_drive_continuation_long' }), snap, 'trending_up', config,
    );
    const boPlan = buildDynamicRewardPlan(
      makeSetup({ setup_type: 'breakout_retest_long' }), snap, 'trending_up', config,
    );
    expect(orPlan.rr_base).toBeLessThan(boPlan.rr_base);
  });

  it('setup family is recorded correctly', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup({ setup_type: 'failed_or_break_short' }), snap, 'trending_down', config,
    );
    expect(plan.setup_family).toBe('failed_or_break');
  });
});

// ── Regime Adjustments ───────────────────────────────────────────────────────

describe('Regime adjustments', () => {
  const config = makeConfig();
  const snap = makeSnap();
  const setup = makeSetup();

  it('trending regime lowers required RR', () => {
    const trendPlan = buildDynamicRewardPlan(setup, snap, 'trending_up', config);
    const neutralPlan = buildDynamicRewardPlan(setup, snap, 'compression', config);
    expect(trendPlan.dynamic_min_rr).toBeLessThan(neutralPlan.dynamic_min_rr);
    expect(trendPlan.rr_regime_adj).toBeLessThan(0);
  });

  it('choppy regime raises required RR', () => {
    const choppyPlan = buildDynamicRewardPlan(setup, snap, 'choppy', config);
    const trendPlan = buildDynamicRewardPlan(setup, snap, 'trending_up', config);
    expect(choppyPlan.dynamic_min_rr).toBeGreaterThan(trendPlan.dynamic_min_rr);
    expect(choppyPlan.rr_regime_adj).toBeGreaterThan(0);
  });
});

// ── Structure / Extension Adjustments ────────────────────────────────────────

describe('Structure/extension adjustments', () => {
  const config = makeConfig();
  const snap = makeSnap();

  it('clean reset lowers required RR', () => {
    const cleanPlan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      makeExtension({ reset_occurred: true, no_reset_extension: false }),
    );
    const noResetPlan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      makeExtension({ reset_occurred: false, no_reset_extension: true }),
    );
    expect(cleanPlan.rr_structure_adj).toBeLessThan(noResetPlan.rr_structure_adj);
  });

  it('mature impulse raises required RR', () => {
    const maturePlan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      makeExtension({ current_impulse_atr: 4.0 }),
    );
    const freshPlan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      makeExtension({ current_impulse_atr: 1.0 }),
    );
    expect(maturePlan.rr_structure_adj).toBeGreaterThan(freshPlan.rr_structure_adj);
  });

  it('tight room raises required RR', () => {
    const tightPlan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      makeExtension({ upside_room_atr: 0.5 }),
    );
    const spaciousPlan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      makeExtension({ upside_room_atr: 3.0 }),
    );
    expect(tightPlan.rr_structure_adj).toBeGreaterThan(spaciousPlan.rr_structure_adj);
  });
});

// ── Microstructure Adjustments ───────────────────────────────────────────────

describe('Microstructure adjustments', () => {
  const config = makeConfig();
  const snap = makeSnap();

  it('positive micro score lowers required RR', () => {
    const supportivePlan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      null, makeMicroScore(+1.0),
    );
    const contradictoryPlan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      null, makeMicroScore(-1.0),
    );
    expect(supportivePlan.dynamic_min_rr).toBeLessThan(contradictoryPlan.dynamic_min_rr);
  });

  it('zero micro score has no adjustment', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      null, makeMicroScore(0),
    );
    // round2(-0 * weight) can produce -0; both are fine
    expect(Math.abs(plan.rr_micro_adj)).toBe(0);
  });

  it('micro adjustment is ignored when data quality is none', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup(), snap, 'trending_up', config,
      null, makeMicroScore(+1.5, 'none'),
    );
    expect(plan.rr_micro_adj).toBe(0);
  });
});

// ── RR Clamping ──────────────────────────────────────────────────────────────

describe('RR clamping', () => {
  it('dynamic RR never falls below floor', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup(), makeSnap(), 'trending_up', makeConfig(),
      makeExtension({ reset_occurred: true, upside_room_atr: 5.0, current_impulse_atr: 0.5 }),
      makeMicroScore(+2.0), // very supportive
    );
    expect(plan.dynamic_min_rr).toBeGreaterThanOrEqual(DEFAULT_DYNAMIC_REWARD_CONFIG.rr_floor);
  });

  it('dynamic RR never exceeds ceiling', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup({ setup_type: 'failed_or_break_long' }), makeSnap(), 'choppy', makeConfig(),
      makeExtension({ no_reset_extension: true, current_impulse_atr: 5.0, upside_room_atr: 0.3, consecutive_push_bars: 10, last_3_bar_return_atr: 3.0 }),
      makeMicroScore(-2.0),
    );
    expect(plan.dynamic_min_rr).toBeLessThanOrEqual(DEFAULT_DYNAMIC_REWARD_CONFIG.rr_ceiling);
  });
});

// ── RR Gate Pass Logic ───────────────────────────────────────────────────────

describe('RR gate pass', () => {
  it('passes when rr_t1 >= dynamic_min_rr', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup({ rr_t1: 2.0 }), makeSnap(), 'trending_up', makeConfig(),
    );
    // trending_up with trend_pullback baseline ~1.6 - 0.1 = ~1.5
    expect(plan.rr_gate_pass).toBe(true);
  });

  it('fails when rr_t1 < dynamic_min_rr', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup({ rr_t1: 1.0 }), makeSnap(), 'choppy', makeConfig(),
    );
    expect(plan.rr_gate_pass).toBe(false);
  });
});

// ── Management PT Alignment ──────────────────────────────────────────────────

describe('Management PT alignment', () => {
  it('resolves PT1/PT2 from management profile', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup(), makeSnap(), 'trending_up', makeConfig(),
    );
    // ATR=12, trend_pullback PT1=0.5*ATR=6, PT2=1.2*ATR=14.4
    expect(plan.mgmt_pt1_offset_pts).toBeGreaterThan(0);
    expect(plan.mgmt_pt2_offset_pts).toBeGreaterThan(plan.mgmt_pt1_offset_pts);
  });

  it('PT1 implied RR is computed', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup({ risk_pts: 10 }), makeSnap(), 'trending_up', makeConfig(),
    );
    expect(plan.mgmt_pt1_implied_rr).toBeGreaterThan(0);
    // PT1=6pts, risk=10pts → implied RR = 0.6
    expect(plan.mgmt_pt1_implied_rr).toBeCloseTo(0.6, 1);
  });
});

// ── Quality Band ─────────────────────────────────────────────────────────────

describe('Quality band', () => {
  it('high quality when RR >> dynamic_min and good structure', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup({ rr_t1: 3.0 }), makeSnap(), 'trending_up', makeConfig(),
      makeExtension({ reset_occurred: true }),
    );
    expect(plan.quality_band).toBe('high');
  });

  it('marginal when RR < dynamic_min', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup({ rr_t1: 1.0 }), makeSnap(), 'choppy', makeConfig(),
    );
    expect(plan.quality_band).toBe('marginal');
  });
});

// ── Legacy Fallback ──────────────────────────────────────────────────────────

describe('Legacy fallback', () => {
  it('uses fixed config.min_rr when dynamic is disabled', () => {
    const legacy = buildLegacyRewardPlan(makeSetup(), makeConfig(), makeSnap());
    expect(legacy.dynamic_min_rr).toBe(2.0);
    expect(legacy.rr_regime_adj).toBe(0);
    expect(legacy.rr_structure_adj).toBe(0);
    expect(legacy.rr_micro_adj).toBe(0);
  });

  it('legacy gate matches config.min_rr', () => {
    const passing = buildLegacyRewardPlan(makeSetup({ rr_t1: 2.5 }), makeConfig(), makeSnap());
    expect(passing.rr_gate_pass).toBe(true);

    const failing = buildLegacyRewardPlan(makeSetup({ rr_t1: 1.5 }), makeConfig(), makeSnap());
    expect(failing.rr_gate_pass).toBe(false);
  });
});

// ── Integration: applyHardGates uses dynamic plan ────────────────────────────

describe('Integration: applyHardGates with dynamic plan', () => {
  const snap = makeSnap();
  const config = makeConfig();
  const bias: MultiTfBias = {
    '1h': 'bullish', '15m': 'bullish', '5m': 'bullish', '1m': 'bullish',
    alignment_score: 4,
  };

  it('passes with dynamic plan when RR > dynamic_min but < config.min_rr', () => {
    // Setup has rr_t1=1.7 — would FAIL the old fixed 2.0 gate
    // But dynamic plan for trend_pullback in trending_up gives ~1.5 min_rr
    const setup = makeSetup({ rr_t1: 1.7 });
    const plan = buildDynamicRewardPlan(setup, snap, 'trending_up', config);
    expect(plan.rr_gate_pass).toBe(true); // 1.7 >= ~1.5

    const failures = applyHardGates(setup, 8.0, bias, 'trending_up', snap, config, plan);
    const rrFailure = failures.find(f => f.includes('rr_'));
    expect(rrFailure).toBeUndefined(); // No RR failure
  });

  it('fails with dynamic plan when RR < dynamic_min', () => {
    const setup = makeSetup({ rr_t1: 1.0 });
    const plan = buildDynamicRewardPlan(setup, snap, 'choppy', config);
    expect(plan.rr_gate_pass).toBe(false);

    const failures = applyHardGates(setup, 8.0, bias, 'choppy', snap, config, plan);
    const rrFailure = failures.find(f => f.includes('dynamic_min'));
    expect(rrFailure).toBeDefined();
  });

  it('falls back to config.min_rr when no plan provided', () => {
    const setup = makeSetup({ rr_t1: 1.7 });
    const failures = applyHardGates(setup, 8.0, bias, 'trending_up', snap, config);
    // No plan → uses config.min_rr=2.0, so 1.7 < 2.0 should fail
    const rrFailure = failures.find(f => f.includes('below_min'));
    expect(rrFailure).toBeDefined();
  });
});

// ── Integration: RiskManager.preTradeCheck uses dynamic min RR ──────────────

describe('Integration: RiskManager with dynamic min RR', () => {
  it('passes with dynamic_min_rr when RR > dynamic but < config.min_rr', () => {
    const config = makeConfig();
    const contract = { root: 'MNQ', tv_symbol: 'MNQ1!', tick_size: 0.25, point_value: 2, exchange: 'CME' };
    const rm = new RiskManager(config, contract);

    const setup = makeSetup({ rr_t1: 1.7 });
    // Pass dynamic_min_rr=1.5 (from reward plan)
    const result = rm.preTradeCheck(setup, 1.5);
    expect(result).toBeNull(); // No block
  });

  it('blocks with dynamic_min_rr when RR < dynamic', () => {
    const config = makeConfig();
    const contract = { root: 'MNQ', tv_symbol: 'MNQ1!', tick_size: 0.25, point_value: 2, exchange: 'CME' };
    const rm = new RiskManager(config, contract);

    const setup = makeSetup({ rr_t1: 1.2 });
    const result = rm.preTradeCheck(setup, 1.5);
    expect(result).toContain('rr_insufficient');
  });

  it('falls back to config.min_rr when dynamic not provided', () => {
    const config = makeConfig({ min_rr: 2.0 });
    const contract = { root: 'MNQ', tv_symbol: 'MNQ1!', tick_size: 0.25, point_value: 2, exchange: 'CME' };
    const rm = new RiskManager(config, contract);

    const setup = makeSetup({ rr_t1: 1.7 });
    const result = rm.preTradeCheck(setup); // no dynamic_min_rr
    expect(result).toContain('rr_insufficient');
  });
});

// ── Result Diagnostics ───────────────────────────────────────────────────────

describe('Result diagnostics', () => {
  it('rr_components always includes base and final', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup(), makeSnap(), 'trending_up', makeConfig(),
    );
    expect(plan.rr_components.some(c => c.startsWith('base:'))).toBe(true);
    expect(plan.rr_components.some(c => c.includes('→'))).toBe(true);
  });

  it('rr_components includes regime when non-zero', () => {
    const plan = buildDynamicRewardPlan(
      makeSetup(), makeSnap(), 'choppy', makeConfig(),
    );
    expect(plan.rr_components.some(c => c.includes('regime:'))).toBe(true);
  });

  it('rr_components includes structure reasons when extension has net non-zero adj', () => {
    // Combine no_reset (+0.15) + tight room (+0.15) + mature impulse (+0.15)
    // to get a clearly positive structure adjustment
    const plan = buildDynamicRewardPlan(
      makeSetup(), makeSnap(), 'trending_up', makeConfig(),
      makeExtension({
        reset_occurred: false, no_reset_extension: true,
        current_impulse_atr: 4.0, upside_room_atr: 0.5,
      }),
    );
    expect(plan.rr_structure_adj).toBeGreaterThan(0);
    expect(plan.rr_components.some(c => c.includes('no_reset'))).toBe(true);
    expect(plan.rr_components.some(c => c.includes('tight_room'))).toBe(true);
  });
});
