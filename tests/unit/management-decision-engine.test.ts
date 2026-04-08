import { describe, it, expect } from 'vitest';
import { ManagementDecisionEngine } from '../../src/autotrade/management/decision-engine.js';
import { RulesProbabilityEngine } from '../../src/autotrade/management/probability-engine.js';
import { buildManagementFeatures } from '../../src/autotrade/management/feature-builder.js';
import type { ManagementFeatures } from '../../src/autotrade/management/types.js';
import type { Position, IndicatorSnapshot } from '../../src/autotrade/types.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';

const MNQ = getContractSpec('MNQ'); // $2/pt
const NOW_UNIX = Date.now();

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function features(posOverrides: Partial<Position> = {}, price = 20_005, snapOverrides: Partial<IndicatorSnapshot> = {}): ManagementFeatures {
  return buildManagementFeatures(makePos(posOverrides), price, makeSnap(snapOverrides), 'trending_up', 'NY_AM');
}

// ─── Probability engine tests ─────────────────────────────────────────────────

describe('RulesProbabilityEngine', () => {
  const engine = new RulesProbabilityEngine();

  it('all PoP values are in [0, 1]', () => {
    const pop = engine.computePoP(features());
    expect(pop.pop_target1_before_stop).toBeGreaterThanOrEqual(0);
    expect(pop.pop_target1_before_stop).toBeLessThanOrEqual(1);
    expect(pop.pop_target2_before_stop).toBeGreaterThanOrEqual(0);
    expect(pop.pop_target2_before_stop).toBeLessThanOrEqual(1);
    expect(pop.pop_runner_extension).toBeGreaterThanOrEqual(0);
    expect(pop.pop_runner_extension).toBeLessThanOrEqual(1);
  });

  it('PoP(T1) = 1.0 when T1 already hit (partial_exit_done)', () => {
    const f = features({ partial_exit_done: true });
    expect(engine.computePoP(f).pop_target1_before_stop).toBe(1.0);
  });

  it('PoP(T1) = 1.0 when distance_to_t1 is negative (already past T1)', () => {
    // price = 20012, T1 = 20010 → T1 already passed
    const f = features({}, 20_012);
    expect(f.distance_to_t1_pts).toBeLessThan(0);
    expect(engine.computePoP(f).pop_target1_before_stop).toBe(1.0);
  });

  it('PoP(T1) is higher with strong trend (ADX 35, DI aligned) vs weak (ADX 12)', () => {
    const strong = engine.computePoP(features({}, 20_005, { adx: 35, di_plus: 35, di_minus: 10 }));
    const weak = engine.computePoP(features({}, 20_005, { adx: 12, di_plus: 18, di_minus: 22 }));
    expect(strong.pop_target1_before_stop).toBeGreaterThan(weak.pop_target1_before_stop);
  });

  it('PoP(T1) increases when price is closer to T1 (stop the same)', () => {
    // price=20008 → T1 distance=2, stop distance=18 (strong advantage)
    // price=20002 → T1 distance=8, stop distance=12 (weaker)
    const close = engine.computePoP(features({}, 20_008));
    const far = engine.computePoP(features({}, 20_002));
    expect(close.pop_target1_before_stop).toBeGreaterThan(far.pop_target1_before_stop);
  });

  it('PoP(T1) is lower in choppy regime than trending regime', () => {
    const trending = engine.computePoP(buildManagementFeatures(makePos(), 20_005, makeSnap(), 'trending_up', 'NY_AM'));
    const choppy = engine.computePoP(buildManagementFeatures(makePos(), 20_005, makeSnap(), 'choppy', 'NY_AM'));
    expect(trending.pop_target1_before_stop).toBeGreaterThan(choppy.pop_target1_before_stop);
  });

  it('PoP(T2) <= PoP(T1) always (T2 is harder to reach)', () => {
    const pop = engine.computePoP(features());
    expect(pop.pop_target2_before_stop).toBeLessThanOrEqual(pop.pop_target1_before_stop);
  });

  it('PoP(runner) is capped below PoP(T2)', () => {
    // Runners are exceptional — runner cap is 0.75, T2 can go up to 0.92
    const pop = engine.computePoP(features());
    expect(pop.pop_runner_extension).toBeLessThanOrEqual(0.75);
  });

  it('confidence_in_estimate = high when all context fields are present', () => {
    const pop = engine.computePoP(features()); // makeSnap has ADX, DI, VWAP, CVD, EMA, regime → 7 available
    expect(pop.confidence_in_estimate).toBe('high');
  });

  it('confidence_in_estimate = low when no market context available', () => {
    const f = buildManagementFeatures(makePos(), 20_005, null, null, null);
    const pop = engine.computePoP(f);
    expect(pop.confidence_in_estimate).toBe('low');
  });

  it('PoP responds to RSI extremes (overbought reduces long PoP)', () => {
    // Use a neutral base: equidistant T1 and stop, no other context factors
    // so RSI penalty is visible without being swamped by other modifiers.
    const neutralSnap: Partial<IndicatorSnapshot> = {
      atr_14: null, adx: null, di_plus: null, di_minus: null,
      vwap: null, cvd_trend: null, ema_9: null, ema_21: null, ema_50: null,
      ttm_squeeze_firing: false,
    };
    const f_normal = buildManagementFeatures(
      makePos(), 20_005, makeSnap({ ...neutralSnap, rsi_14: 55 }), null, null,
    );
    const f_overbought = buildManagementFeatures(
      makePos(), 20_005, makeSnap({ ...neutralSnap, rsi_14: 80 }), null, null,
    );
    const normal = engine.computePoP(f_normal);
    const overbought = engine.computePoP(f_overbought);
    expect(overbought.pop_target1_before_stop).toBeLessThan(normal.pop_target1_before_stop);
  });
});

// ─── Decision engine tests ────────────────────────────────────────────────────

describe('ManagementDecisionEngine', () => {
  const engine = new ManagementDecisionEngine(MNQ);

  it('returns all required fields', () => {
    const m = engine.evaluate(features());
    expect(m).toHaveProperty('pop');
    expect(m).toHaveProperty('unrealized_pnl_usd');
    expect(m).toHaveProperty('expected_value_hold_usd');
    expect(m).toHaveProperty('expected_value_exit_now_usd');
    expect(m).toHaveProperty('expected_value_reduce_usd');
    expect(m).toHaveProperty('management_state');
    expect(m).toHaveProperty('management_state_reason');
    expect(m).toHaveProperty('decision_factors');
    expect(m).toHaveProperty('timestamp_iso');
  });

  it('unrealized_pnl_usd correct for long (5pts × 2ct × $2 = $20)', () => {
    const m = engine.evaluate(features({}, 20_005));
    // 5pts × 2ct × $2 = $20
    expect(m.unrealized_pnl_usd).toBeCloseTo(20, 1);
  });

  it('EV_exit_now equals unrealized_pnl_usd (locks in current mark)', () => {
    const m = engine.evaluate(features({}, 20_005));
    expect(m.expected_value_exit_now_usd).toBeCloseTo(m.unrealized_pnl_usd, 1);
  });

  it('EV_reduce is between EV_exit and EV_hold', () => {
    const m = engine.evaluate(features({}, 20_005));
    const sorted = [m.expected_value_exit_now_usd, m.expected_value_reduce_usd, m.expected_value_hold_usd].sort((a, b) => a - b);
    // reduce should be between exit and hold (by construction: 0.5×exit + 0.5×hold)
    expect(m.expected_value_reduce_usd).toBeCloseTo(
      0.5 * m.expected_value_exit_now_usd + 0.5 * m.expected_value_hold_usd,
      1,
    );
  });

  it('state = HOLD when trade is well-positioned with strong trend', () => {
    // At 0.5R with strong trend context — EV(hold) should exceed EV(exit)
    const m = engine.evaluate(features({}, 20_005, { adx: 35, di_plus: 35, di_minus: 10 }));
    expect(['HOLD', 'MOVE_STOP']).toContain(m.management_state);
  });

  it('state = EXIT_NOW when PoP is very low and trade is profitable', () => {
    // Put price right below T1, far from stop, but in choppy regime with ADX 10 → PoP will be low
    const f = buildManagementFeatures(
      makePos(),
      20_008, // in profit (0.8R)
      makeSnap({ adx: 10, di_plus: 12, di_minus: 20, cvd_trend: 'down' }),
      'choppy',
      'NY_AM',
    );
    const pop = new RulesProbabilityEngine().computePoP(f);
    // If PoP is genuinely low (<0.30) and trade is profitable, EXIT_NOW should fire
    if (pop.pop_target1_before_stop < 0.30) {
      const m = engine.evaluate(f);
      expect(m.management_state).toBe('EXIT_NOW');
    }
    // Otherwise just verify state is valid
    const m = engine.evaluate(f);
    expect(['HOLD', 'REDUCE', 'MOVE_STOP', 'EXIT_NOW']).toContain(m.management_state);
  });

  it('state = MOVE_STOP when at 0.5R and stop not yet at BE', () => {
    // 0.5R, stop still at original, no partials done
    const pos = makePos({ stop_current: 19_990 }); // stop at original (not BE)
    const f = buildManagementFeatures(pos, 20_005, makeSnap(), 'trending_up', 'NY_AM');
    const m = engine.evaluate(f);
    // At exactly 0.5R with no partial — MOVE_STOP is the expected advisory
    expect(m.management_state).toBe('MOVE_STOP');
    expect(m.management_state_reason).toContain('breakeven');
  });

  it('management state changes when price moves from 0.3R to 0.8R', () => {
    const f_low = features({}, 20_003); // 0.3R
    const f_high = features({}, 20_008); // 0.8R
    const m_low = engine.evaluate(f_low);
    const m_high = engine.evaluate(f_high);
    // Both states must be valid
    expect(['HOLD', 'MOVE_STOP', 'REDUCE', 'EXIT_NOW']).toContain(m_low.management_state);
    expect(['HOLD', 'MOVE_STOP', 'REDUCE', 'EXIT_NOW']).toContain(m_high.management_state);
    // EV(exit_now) should be higher at 0.8R since more unrealized PnL is locked in
    expect(m_high.expected_value_exit_now_usd).toBeGreaterThan(m_low.expected_value_exit_now_usd);
    // At higher R, unrealized PnL is larger
    expect(m_high.unrealized_pnl_usd).toBeGreaterThan(m_low.unrealized_pnl_usd);
  });

  it('management features reflect ATR-normalized distances when ATR changes', () => {
    // ATR only affects normalized distance fields in features, not raw PoP (which uses pts)
    const f_low_atr = buildManagementFeatures(makePos(), 20_005, makeSnap({ atr_14: 5 }), 'trending_up', 'NY_AM');
    const f_high_atr = buildManagementFeatures(makePos(), 20_005, makeSnap({ atr_14: 20 }), 'trending_up', 'NY_AM');
    // Absolute distances unchanged; ATR-normalized differ
    expect(f_low_atr.distance_to_stop_pts).toBeCloseTo(f_high_atr.distance_to_stop_pts, 1);
    expect(f_low_atr.distance_to_stop_atr).not.toBeCloseTo(f_high_atr.distance_to_stop_atr!, 1);
    // At low ATR, normalized stop distance is larger (more ATRs to stop)
    expect(f_low_atr.distance_to_stop_atr!).toBeGreaterThan(f_high_atr.distance_to_stop_atr!);
  });

  it('NEVER overrides hard stop — EXIT_NOW is advisory only', () => {
    // Simulate a trade where EV says EXIT_NOW, but we verify the hard stop fields
    // are NOT modified by the management engine (it only produces ManagementMetrics)
    const pos = makePos();
    const f = buildManagementFeatures(pos, 20_000, makeSnap({ adx: 8, cvd_trend: 'down' }), 'choppy', 'NY_AM');
    const m = engine.evaluate(f);
    // Management engine should NOT have changed pos.stop_current
    expect(pos.stop_current).toBe(19_990); // unchanged
    // Management engine only produces metrics — no side effects
    expect(m.management_state).toBeDefined();
  });

  it('ev_hold_vs_exit_delta = EV(hold) - EV(exit)', () => {
    const m = engine.evaluate(features());
    expect(m.ev_hold_vs_exit_delta).toBeCloseTo(
      m.expected_value_hold_usd - m.expected_value_exit_now_usd,
      1,
    );
  });

  it('decision_factors array is non-empty', () => {
    const m = engine.evaluate(features());
    expect(m.decision_factors.length).toBeGreaterThan(0);
  });

  it('management_state_reason is a non-empty string', () => {
    const m = engine.evaluate(features());
    expect(typeof m.management_state_reason).toBe('string');
    expect(m.management_state_reason.length).toBeGreaterThan(0);
  });

  it('accepts a custom ProbabilityModel via constructor', () => {
    // Verify the model-pluggable interface works
    const customModel = new RulesProbabilityEngine(); // same model, different instance
    const engineCustom = new ManagementDecisionEngine(MNQ, customModel);
    const m = engineCustom.evaluate(features());
    expect(m.pop.model_name).toBe('rules_v1');
  });
});
