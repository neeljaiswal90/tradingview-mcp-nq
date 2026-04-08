import { describe, it, expect } from 'vitest';
import { TrainedProbabilityEngine } from '../../src/autotrade/management/trained-engine.js';
import { ManagementDecisionEngine } from '../../src/autotrade/management/decision-engine.js';
import { buildManagementFeatures } from '../../src/autotrade/management/feature-builder.js';
import type { ManagementFeatures } from '../../src/autotrade/management/types.js';
import type { Position, IndicatorSnapshot } from '../../src/autotrade/types.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';

const MNQ = getContractSpec('MNQ');
const NOW_UNIX = Date.now();

// ─── Fixture weights (self-contained — no file dependency) ────────────────────
// Zero means and unit stds → raw features pass through unscaled.
// Small positive weights → predictions hover around 0.5 and
// directional tests are easy to construct by varying one feature at a time.

const FEATURE_NAMES = [
  'geo_ratio_t1', 'geo_ratio_t2',
  'current_r', 'mfe_r', 'mae_r',
  't1_dist_r', 't2_dist_r', 'stop_dist_r',
  'partial_exit_done', 'hold_seconds_norm',
  'is_long',
  'setup_trend_pullback', 'setup_breakout_retest', 'setup_failed_break',
  'regime_trending_up', 'regime_trending_down',
] as const;
const N = FEATURE_NAMES.length;

// Weights with geo_ratio_t1 and current_r as dominant signals for T1
// so directional tests are easy to verify manually.
const FIXTURE_WEIGHTS = {
  schema_version: '1',
  model_name: 'test_lr_v1',
  model_version: '0.0.1',
  trained_at: '2026-04-06T00:00:00.000Z',
  training_samples: { t1: 100, t2: 100, runner: 100 },
  feature_names: [...FEATURE_NAMES],
  feature_means: new Array(N).fill(0),
  feature_stds: new Array(N).fill(1),
  t1_model: {
    // geo_ratio_t1 (idx 0) = +1.5, current_r (idx 2) = +1.0, rest = 0
    weights: [1.5, 0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bias: 0.0,
  },
  t2_model: {
    weights: new Array(N).fill(0.05),
    bias: -0.5,
  },
  runner_model: {
    weights: new Array(N).fill(0.08),
    bias: -0.3,
  },
  min_pop: 0.05,
  max_pop: 0.95,
};

// ─── Position / feature helpers (mirror management-decision-engine.test.ts) ───

function makePos(overrides: Partial<Position> = {}): Position {
  return {
    trade_id: 'T1', signal_id: 'S1', session_id: 'SESS',
    side: 'long',
    entry_price: 20_000,
    entry_time_unix: NOW_UNIX - 120_000,
    entry_time_iso: new Date(NOW_UNIX - 120_000).toISOString(),
    stop_initial: 19_990, stop_current: 19_990,
    target_1: 20_010, target_2: 20_020, target_3: null,
    quantity: 2, quantity_remaining: 2,
    notional: 80_000, setup_type: 'trend_pullback_long',
    market_regime_at_entry: 'trending_up', config_version: 'TEST', confidence: 8,
    stop_moved_to_be: false, pre_t1_be_triggered: false,
    pre_t1_trailing_active: false, trailing_active: false,
    trail_distance_ticks: 0, trail_anchor_price: null,
    partial_exit_done: false, pt1_done: false, pt2_done: false,
    pt1_realized_pnl: 0, pt2_realized_pnl: 0, pt1_qty_exited: 0, pt2_qty_exited: 0,
    max_favorable_excursion: 5, max_adverse_excursion: 2,
    last_checked_price: 20_000, time_stop_minutes: 30,
    target_1_direction_valid: true, target_2_direction_valid: true,
    target_3_direction_valid: true, target_ordering_valid: true,
    target_repair_applied: false,
    exit_legs: [], realized_pnl_so_far: 0, realized_fees_so_far: 0,
    ...overrides,
  };
}

function makeSnap(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    ema_9: 20_005, ema_21: 20_000, ema_50: 19_985,
    ema_100: null, ema_200: null,
    supertrend_direction: 'up', supertrend_level: 19_980,
    novawave_fast: null, novawave_slow: null, novawave_signal: null,
    dma_20: null, dma_50: null, dma_200: null,
    smart_money_choch_sell: null, smart_money_choch_buy: null,
    smart_money_bos_sell: null, smart_money_bos_buy: null,
    vwap: 19_998, atr_14: 8, rsi_14: 55,
    volume: 1_200, volume_sma_20: 1_000,
    adx: 28, di_plus: 30, di_minus: 18,
    ttm_squeeze_momentum: null, ttm_squeeze_firing: false,
    cvd: null, cvd_delta: null, cvd_trend: 'up',
    ...overrides,
  };
}

function makeFeatures(posOverrides: Partial<Position> = {}, price = 20_005): ManagementFeatures {
  return buildManagementFeatures(makePos(posOverrides), price, makeSnap(), 'trending_up', 'NY_AM');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TrainedProbabilityEngine', () => {

  // ── fromJson validation ────────────────────────────────────────────────────

  it('fromJson throws on null input', () => {
    expect(() => TrainedProbabilityEngine.fromJson(null)).toThrow();
  });

  it('fromJson throws on missing feature_names', () => {
    const bad = { ...FIXTURE_WEIGHTS };
    // @ts-expect-error intentional
    delete bad.feature_names;
    expect(() => TrainedProbabilityEngine.fromJson(bad)).toThrow(/feature_names/);
  });

  it('fromJson throws on weight length mismatch', () => {
    const bad = {
      ...FIXTURE_WEIGHTS,
      t1_model: { weights: [1, 2], bias: 0 }, // wrong length
    };
    expect(() => TrainedProbabilityEngine.fromJson(bad)).toThrow(/t1_model/);
  });

  it('fromJson succeeds with valid fixture weights', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    expect(engine.name).toBe('test_lr_v1');
    expect(engine.version).toBe('0.0.1');
  });

  // ── Interface compliance ───────────────────────────────────────────────────

  it('implements ProbabilityModel interface (name, version, computePoP)', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    expect(typeof engine.name).toBe('string');
    expect(typeof engine.version).toBe('string');
    expect(typeof engine.computePoP).toBe('function');
  });

  it('all three PoP values are in [0, 1]', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    const f = makeFeatures();
    const pop = engine.computePoP(f);
    expect(pop.pop_target1_before_stop).toBeGreaterThanOrEqual(0);
    expect(pop.pop_target1_before_stop).toBeLessThanOrEqual(1);
    expect(pop.pop_target2_before_stop).toBeGreaterThanOrEqual(0);
    expect(pop.pop_target2_before_stop).toBeLessThanOrEqual(1);
    expect(pop.pop_runner_extension).toBeGreaterThanOrEqual(0);
    expect(pop.pop_runner_extension).toBeLessThanOrEqual(1);
  });

  it('model_name in TradePoP matches engine.name', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    const pop = engine.computePoP(makeFeatures());
    expect(pop.model_name).toBe(engine.name);
  });

  it('model_version in TradePoP matches engine.version', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    const pop = engine.computePoP(makeFeatures());
    expect(pop.model_version).toBe(engine.version);
  });

  // ── Boundary conditions ────────────────────────────────────────────────────

  it('pop_t1 = 1.0 when partial_exit_done = true', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    const f = makeFeatures({ partial_exit_done: true });
    expect(engine.computePoP(f).pop_target1_before_stop).toBe(1.0);
  });

  it('pop_t1 = 1.0 when pt1_done = true', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    const f = makeFeatures({ pt1_done: true });
    expect(engine.computePoP(f).pop_target1_before_stop).toBe(1.0);
  });

  it('pop_t2 = 1.0 when pt2_done = true', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    const f = makeFeatures({ pt2_done: true });
    expect(engine.computePoP(f).pop_target2_before_stop).toBe(1.0);
  });

  it('pop_t1 = 1.0 when price has already passed T1 (distance_to_t1_pts <= 0)', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    // Price at 20_012 > T1 (20_010) → distance_to_t1_pts < 0
    const f = makeFeatures({}, 20_012);
    expect(engine.computePoP(f).pop_target1_before_stop).toBe(1.0);
  });

  it('pop_t2 ≤ pop_t1 (monotonicity always holds)', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    const f = makeFeatures();
    const pop = engine.computePoP(f);
    expect(pop.pop_target2_before_stop).toBeLessThanOrEqual(pop.pop_target1_before_stop);
  });

  it('pop_runner_extension ≤ 0.75 always (cap enforced)', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    // Very large runner weights still capped
    const bigRunnerWeights = {
      ...FIXTURE_WEIGHTS,
      runner_model: { weights: new Array(N).fill(5.0), bias: 5.0 },
    };
    const engine2 = TrainedProbabilityEngine.fromJson(bigRunnerWeights);
    expect(engine2.computePoP(makeFeatures()).pop_runner_extension).toBeLessThanOrEqual(0.75);
  });

  it('pop values respect min_pop lower bound', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    // Very negative weights → should still be >= min_pop
    const negativeBias = {
      ...FIXTURE_WEIGHTS,
      t1_model: { weights: new Array(N).fill(-10.0), bias: -10.0 },
    };
    const engine2 = TrainedProbabilityEngine.fromJson(negativeBias);
    const pop = engine2.computePoP(makeFeatures());
    expect(pop.pop_target1_before_stop).toBeGreaterThanOrEqual(FIXTURE_WEIGHTS.min_pop);
  });

  // ── Directional sensitivity ────────────────────────────────────────────────

  it('higher current_r → higher pop_t1 (with geo_ratio and current_r as dominant weights)', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    // Price at 20_007 (0.7R) vs 20_002 (0.2R) — same stop/targets
    const fHigh = makeFeatures({}, 20_007);
    const fLow = makeFeatures({}, 20_002);
    expect(engine.computePoP(fHigh).pop_target1_before_stop).toBeGreaterThan(
      engine.computePoP(fLow).pop_target1_before_stop,
    );
  });

  it('stop further from price (favorable geo ratio) → higher pop_t1', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    // Keep stop_initial identical (same current_r) — only vary stop_current.
    // Wide current stop (19_975) → geo_ratio_t1 = 30/(30+5) = 0.857
    // Narrow current stop (19_998) → geo_ratio_t1 = 7/(7+5) = 0.583
    // current_r stays the same since stop_initial = 19_990 in both cases.
    const fWideStop = makeFeatures({ stop_current: 19_975 });   // stop_initial stays 19_990
    const fNarrowStop = makeFeatures({ stop_current: 19_998 }); // stop_initial stays 19_990
    expect(engine.computePoP(fWideStop).pop_target1_before_stop).toBeGreaterThan(
      engine.computePoP(fNarrowStop).pop_target1_before_stop,
    );
  });

  // ── Integration with ManagementDecisionEngine ──────────────────────────────

  it('ManagementDecisionEngine accepts TrainedProbabilityEngine as drop-in', () => {
    const engine = new ManagementDecisionEngine(MNQ, TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS));
    const f = makeFeatures();
    const metrics = engine.evaluate(f);
    // Verify all required output fields are present and valid
    expect(metrics.pop.model_name).toBe('test_lr_v1');
    expect(['HOLD', 'REDUCE', 'MOVE_STOP', 'EXIT_NOW']).toContain(metrics.management_state);
    expect(metrics.expected_value_hold_usd).toBeTypeOf('number');
    expect(metrics.expected_value_exit_now_usd).toBeTypeOf('number');
    expect(metrics.decision_factors).toBeInstanceOf(Array);
    expect(metrics.timestamp_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('confidence_in_estimate is medium for normal trade (stop not breached)', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    const pop = engine.computePoP(makeFeatures());
    expect(pop.confidence_in_estimate).toBe('medium');
  });

  it('has no side effects on Position between calls', () => {
    const engine = TrainedProbabilityEngine.fromJson(FIXTURE_WEIGHTS);
    const f = makeFeatures();
    const snap1 = engine.computePoP(f);
    const snap2 = engine.computePoP(f);
    expect(snap1.pop_target1_before_stop).toBe(snap2.pop_target1_before_stop);
    expect(snap1.pop_target2_before_stop).toBe(snap2.pop_target2_before_stop);
  });
});
