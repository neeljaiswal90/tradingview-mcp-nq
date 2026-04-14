/**
 * target-position.test.ts — Unit + integration tests for the V1a dynamic
 * target-position model.
 *
 * Core math cases (1–10):   computeTargetPosition() algebra and invariants
 * Reduce plumbing (11–15):   ManagementDecisionEngine REDUCE branches + cooldown
 * Hysteresis / flatten / precedence (16–24)
 * Cap / stop-widening / stale inputs (25–28)
 * Prior-target init edge (29)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  computeTargetPosition,
  describeTargetAction,
  normalizeConfidence,
  DEFAULT_POSITION_TARGET_CONFIG,
  type TargetPositionContext,
  type PositionTargetConfig,
} from '../../src/autotrade/target-position.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';
import { ManagementDecisionEngine } from '../../src/autotrade/management/decision-engine.js';
import type {
  ManagementFeatures,
  ProbabilityModel,
  TradePoP,
} from '../../src/autotrade/management/types.js';

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

const MNQ = getContractSpec('MNQ'); // point_value=2, tick=0.25

/**
 * Build a TargetPositionContext with sensible defaults. Each field is
 * overrideable for targeted test scenarios.
 */
function ctx(overrides: Partial<TargetPositionContext> = {}): TargetPositionContext {
  const cfg: PositionTargetConfig = overrides.config ?? {
    ...DEFAULT_POSITION_TARGET_CONFIG,
  };
  return {
    stop_distance_pts: 8,
    contract: MNQ,
    equity: 25_000,
    max_risk_per_trade_pct: 1.5,
    confidence_raw: 0.85,
    confidence_source: 'management_pop_t2',
    regime: 'trending_up',
    session_bucket: 'NY_AM',
    daily_loss_pct: 0,
    max_daily_loss_pct: 8,
    hard_cap: cfg.hard_cap,
    config: cfg,
    ...overrides,
  };
}

/** Stub PoP model — emits whatever values the test sets on it. */
class StubPopModel implements ProbabilityModel {
  readonly name = 'stub';
  readonly version = 'test';
  public nextPop: TradePoP = {
    pop_target1_before_stop: 0.6,
    pop_target2_before_stop: 0.5,
    pop_runner_extension: 0.2,
    model_name: 'stub',
    model_version: 'test',
    confidence_in_estimate: 'medium',
  };
  computePoP(): TradePoP {
    return { ...this.nextPop };
  }
}

/**
 * Build a ManagementFeatures object with sensible defaults for integration tests.
 * current_r, distance_to_stop_pts, quantity_remaining, etc. are all overrideable.
 */
function mkFeatures(over: Partial<ManagementFeatures> = {}): ManagementFeatures {
  return {
    side: 'long',
    setup_type: 'trend_pullback_long',
    current_price: 20_000,
    unrealized_pnl_pts: 0,
    initial_risk_pts: 8,
    current_r: 0,
    mfe_r: 0,
    mae_r: 0,
    hold_seconds: 30,
    time_stop_remaining_seconds: 1800,
    distance_to_stop_pts: 8,
    distance_to_stop_atr: null,
    distance_to_t1_pts: 12,
    distance_to_t1_atr: null,
    distance_to_t2_pts: 18,
    distance_to_t2_atr: null,
    partial_exit_done: false,
    pt1_done: false,
    pt2_done: false,
    quantity_remaining: 6,
    quantity_original: 6,
    realized_pnl_usd: 0,
    atr_14: 8,
    adx: 25,
    di_plus: null,
    di_minus: null,
    rsi_14: null,
    vwap_distance_pts: 2,
    vwap_distance_atr: 0.25,
    ema_alignment: 'bullish',
    ema_9_21_gap_pts: 2,
    cvd_trend: 'up',
    volume_ratio: 1.2,
    regime: 'trending_up',
    session_bucket: 'NY_AM',
    ttm_squeeze_firing: false,
    daily_loss_pct: 0,
    max_daily_loss_pct: 8,
    account_equity: 25_000,
    max_risk_per_trade_pct: 1.5,
    ...over,
  };
}

/**
 * Build a pre-configured engine + features + model. Does NOT call evaluate()
 * — tests drive cycles themselves so counters/cooldowns stay under their
 * control.
 */
function makeEngine(
  overrides: {
    cfg?: Partial<PositionTargetConfig>;
    popT2?: number;
    features?: Partial<ManagementFeatures>;
    tradeId?: string;
  } = {},
) {
  const cfg: PositionTargetConfig = {
    ...DEFAULT_POSITION_TARGET_CONFIG,
    ...(overrides.cfg ?? {}),
  };
  const model = new StubPopModel();
  if (overrides.popT2 != null) {
    model.nextPop = { ...model.nextPop, pop_target2_before_stop: overrides.popT2 };
  }
  const engine = new ManagementDecisionEngine(MNQ, cfg, model);
  const features = mkFeatures(overrides.features);
  const tradeId = overrides.tradeId ?? 'TRADE_TEST_1';
  engine.beginTrade(tradeId);
  return { engine, features, model, cfg, tradeId };
}

/** Legacy: also run one evaluate() and return the metrics. Used by tests that want a one-shot snapshot. */
function evaluateFixture(
  overrides: {
    cfg?: Partial<PositionTargetConfig>;
    popT2?: number;
    features?: Partial<ManagementFeatures>;
    tradeId?: string;
  } = {},
) {
  const setup = makeEngine(overrides);
  const metrics = setup.engine.evaluate(setup.features, setup.tradeId);
  return { ...setup, metrics };
}

// Quiet log output during tests — the target-position module emits console.log
// on recompute/would_scale_in/execute, and a 29-test run would flood the
// terminal otherwise.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ───────────────────────────────────────────────────────────────────────────
// Core math (1–10)
// ───────────────────────────────────────────────────────────────────────────

describe('computeTargetPosition — core math', () => {
  it('1. q_risk bound — tight stop + normal equity → q_risk wins', () => {
    // MNQ: stop 2pts → rpcUsd = 4. budget = 25000*1.5%=$375. q_risk = 93.
    // To isolate q_risk binding: softcap ~ 200*0.85*1*1*1 = 170, hardcap 200 → 93 wins.
    const result = computeTargetPosition(
      ctx({
        stop_distance_pts: 2,
        config: { ...DEFAULT_POSITION_TARGET_CONFIG, soft_cap_base: 200, hard_cap: 200 },
        hard_cap: 200,
      }),
    );
    expect(result.q_risk).toBe(93); // floor(375/4)
    expect(result.bound_by).toBe('risk');
    expect(result.q_target).toBe(93);
  });

  it('2. q_softcap bound — wide stop + low confidence → softcap wins', () => {
    // Low confidence (0.3) → c_t=0.3, softcap_base=10 → qSoft=3.
    // Wide stop (20pts, MNQ rpc=$40) + budget $375 → q_risk=9.
    // Hardcap=10. min(9, 3, 10) = 3, softcap binds.
    const result = computeTargetPosition(
      ctx({
        stop_distance_pts: 20,
        confidence_raw: 0.3,
      }),
    );
    expect(result.q_softcap).toBe(3);
    expect(result.q_risk).toBe(9);
    expect(result.bound_by).toBe('softcap');
    expect(result.q_target).toBe(3);
  });

  it('3. q_hardcap bound — tiny stop + full confidence + 0% drawdown → clamps to 10', () => {
    const result = computeTargetPosition(
      ctx({
        stop_distance_pts: 1,
        confidence_raw: 1.0,
      }),
    );
    // q_risk would be huge (375/2=187), q_softcap = 10*1*1*1*1 = 10, hardcap = 10.
    // Softcap and hardcap both tie at 10 — tie precedence prefers softcap label.
    expect(result.q_target).toBe(10);
    expect(result.q_hardcap).toBe(10);
    expect(result.bound_by_all).toContain('hardcap');
  });

  it('4. d_t → 0 as drawdown approaches max → q_softcap collapses to 0', () => {
    const result = computeTargetPosition(
      ctx({
        daily_loss_pct: 8, // equals max_daily_loss_pct
      }),
    );
    expect(result.drawdown_factor).toBe(0);
    expect(result.q_softcap).toBe(0);
    expect(result.q_target).toBe(0);
  });

  it('5. choppy regime halves q_softcap vs trending (session held constant)', () => {
    const trending = computeTargetPosition(ctx({ regime: 'trending_up' }));
    const choppy = computeTargetPosition(ctx({ regime: 'choppy' }));
    // trending ρ=1.0, choppy ρ=0.5 → q_softcap should halve.
    expect(trending.regime_factor).toBe(1.0);
    expect(choppy.regime_factor).toBe(0.5);
    // Softcap numeric comparison: same c_t (0.85), same s_t, same d_t.
    // trending: 10 * 0.85 * 1.0 * 1.0 * 1.0 = 8.5 → floor = 8
    // choppy:   10 * 0.85 * 0.5 * 1.0 * 1.0 = 4.25 → floor = 4
    expect(trending.q_softcap).toBe(8);
    expect(choppy.q_softcap).toBe(4);
  });

  it('6. session bucket change (NY_AM → NY_LUNCH) produces expected softcap delta', () => {
    const am = computeTargetPosition(ctx({ session_bucket: 'NY_AM' }));
    const lunch = computeTargetPosition(ctx({ session_bucket: 'NY_LUNCH' }));
    expect(am.session_factor).toBe(1.0);
    expect(lunch.session_factor).toBe(0.85);
    // am:    10 * 0.85 * 1.0 * 1.0 * 1.0 = 8.5 → 8
    // lunch: 10 * 0.85 * 1.0 * 0.85 * 1.0 = 7.225 → 7
    expect(am.q_softcap).toBe(8);
    expect(lunch.q_softcap).toBe(7);
  });

  it('7. stop_distance_pts = 0 → q_target = 0, reason = risk_per_contract_non_positive', () => {
    // 0 stop → normalizeStopDistance clamps to 2 ticks (0.5pts) so rpc > 0.
    // The degenerate-stop guard only fires when rpc <= 0, which happens on
    // malformed contracts. Simulate via a contract with 0 point_value.
    const result = computeTargetPosition(
      ctx({
        stop_distance_pts: 5,
        contract: { ...MNQ, point_value: 0 }, // force rpc = 0
      }),
    );
    expect(result.q_target).toBe(0);
    expect(result.reason).toBe('risk_per_contract_non_positive');
  });

  it('8. tie precedence — q_risk = q_softcap = 5 → bound_by=softcap, bound_by_all=[softcap,risk]', () => {
    // Stop 5pts, MNQ rpc=$10, budget=$50 → q_risk = 5. soft_cap_base tuned to hit 5.
    // softcap = base * c_t(0.5) * 1 * 1 * 1. For softcap=5, base=10.
    const result = computeTargetPosition(
      ctx({
        stop_distance_pts: 5,
        equity: 10_000 / 3, // 10000/3 * 0.015 = 50 budget → q_risk = 5
        max_risk_per_trade_pct: 1.5,
        confidence_raw: 0.5,
        config: { ...DEFAULT_POSITION_TARGET_CONFIG, soft_cap_base: 10, hard_cap: 100 },
        hard_cap: 100,
      }),
    );
    // Both q_risk and q_softcap should equal 5
    expect(result.q_risk).toBe(5);
    expect(result.q_softcap).toBe(5);
    expect(result.q_target).toBe(5);
    // Stable precedence: softcap wins label on tie
    expect(result.bound_by).toBe('softcap');
    expect(result.bound_by_all).toContain('softcap');
    expect(result.bound_by_all).toContain('risk');
  });

  it('9. confidence normalization stability — entry_setup 8.0 == management_pop_t2 0.8', () => {
    const entry = computeTargetPosition(
      ctx({ confidence_source: 'entry_setup', confidence_raw: 8.0 }),
    );
    const mgmt = computeTargetPosition(
      ctx({ confidence_source: 'management_pop_t2', confidence_raw: 0.8 }),
    );
    expect(entry.confidence_factor).toBeCloseTo(mgmt.confidence_factor, 5);
    expect(entry.q_softcap).toBe(mgmt.q_softcap);
  });

  it('10. confidence source audit trail — result carries both raw and source', () => {
    const entry = computeTargetPosition(
      ctx({ confidence_source: 'entry_setup', confidence_raw: 7.5 }),
    );
    expect(entry.confidence_raw).toBe(7.5);
    expect(entry.confidence_source).toBe('entry_setup');
    expect(entry.confidence_factor).toBe(0.75);
  });

  it('normalizeConfidence — entry_setup divides by 10', () => {
    expect(normalizeConfidence('entry_setup', 5)).toBe(0.5);
    expect(normalizeConfidence('entry_setup', 12)).toBe(1); // clamped
    expect(normalizeConfidence('entry_setup', -1)).toBe(0); // clamped
  });

  it('normalizeConfidence — management_pop_t2 passes through', () => {
    expect(normalizeConfidence('management_pop_t2', 0.5)).toBe(0.5);
    expect(normalizeConfidence('management_pop_t2', 1.5)).toBe(1);
    expect(normalizeConfidence('management_pop_t2', -0.1)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Reduce plumbing (11–15)
// ───────────────────────────────────────────────────────────────────────────

describe('ManagementDecisionEngine — target-position REDUCE plumbing', () => {
  it('11. would_scale_in path — q_target > q_current → no REDUCE', () => {
    // 6 contracts, stop 8pts, high confidence, trending → softcap ~8, hardcap 10
    // But quantity_remaining is 6, so q_target(8) > q_current(6). Should NOT REDUCE.
    const { metrics } = evaluateFixture({ popT2: 0.95, features: { quantity_remaining: 6 } });
    expect(metrics.management_state).not.toBe('REDUCE');
    expect(metrics.target_position).not.toBeNull();
    expect(metrics.target_position!.q_target).toBeGreaterThanOrEqual(metrics.features.quantity_remaining);
    expect(metrics.requested_qty_to_exit).toBeNull();
  });

  it('12. no-spam invariant — three consecutive cycles with unchanged q_target < q_current produce one REDUCE', () => {
    // Low confidence + large position → q_target < q_current, delta_drop=5 (large → immediate fire)
    const { engine, features, tradeId } = makeEngine({
      popT2: 0.1,
      features: { quantity_remaining: 6 },
    });
    // Cycle 1: popT2=0.1, q_softcap = 10*0.1*1*1*1 = 1 → delta_drop = 5. Large delta fires.
    const m1 = engine.evaluate(features, tradeId);
    expect(m1.management_state).toBe('REDUCE');
    // Simulate runner successfully executing the reduce — starts the cooldown.
    engine.notifyReduceApplied();

    // Cycle 2: same features but cooldown now active → HOLD
    const m2 = engine.evaluate(features, tradeId);
    expect(m2.management_state).toBe('HOLD');
    expect(m2.management_state_reason).toMatch(/cooldown/);

    // Cycle 3: still within cooldown → HOLD
    const m3 = engine.evaluate(features, tradeId);
    expect(m3.management_state).toBe('HOLD');
  });

  it('13. cooldown blocks second reduce', () => {
    const { engine, features, tradeId } = makeEngine({
      popT2: 0.1,
      features: { quantity_remaining: 6 },
    });
    const m1 = engine.evaluate(features, tradeId);
    expect(m1.management_state).toBe('REDUCE');
    // Notify the runner applied the reduce — sets last_reduce_ts_ms = now
    engine.notifyReduceApplied();
    // Drop quantity to match what the runner would have done
    const f2 = mkFeatures({ ...features, quantity_remaining: 4 });
    const m2 = engine.evaluate(f2, tradeId);
    // q_target is still 1, q_current=4, delta_drop=3 > large_threshold(2) → would fire, but cooldown blocks
    expect(m2.management_state).toBe('HOLD');
    expect(m2.management_state_reason).toMatch(/cooldown/);
  });

  it('14. post-reduce recompute uses new quantity', () => {
    const { engine, features, tradeId } = makeEngine({
      popT2: 0.1,
      features: { quantity_remaining: 6 },
    });
    engine.evaluate(features, tradeId);
    engine.notifyReduceApplied();
    // Simulate applyPartialExit dropping quantity to 1 (matching q_target)
    const f2 = mkFeatures({ ...features, quantity_remaining: 1 });
    const m2 = engine.evaluate(f2, tradeId);
    // delta_drop = 1 - 1 = 0 → no reduce wanted
    expect(m2.management_state).not.toBe('REDUCE');
    expect(m2.target_position!.delta).toBe(0);
  });

  it('15. sign convention guard — daily_loss_pct = 4 with max=8 → d_t = 0.5', () => {
    const result = computeTargetPosition(ctx({ daily_loss_pct: 4, max_daily_loss_pct: 8 }));
    expect(result.drawdown_factor).toBe(0.5);

    // Negative daily_loss_pct (malformed input) must NOT silently invert — clamped to 0
    const resultNeg = computeTargetPosition(ctx({ daily_loss_pct: -4, max_daily_loss_pct: 8 }));
    expect(resultNeg.drawdown_factor).toBe(1); // max(0, 1 - 0/8) = 1
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Hysteresis / flatten / precedence (16–24)
// ───────────────────────────────────────────────────────────────────────────

describe('ManagementDecisionEngine — hysteresis, flatten, precedence', () => {
  it('16. flatten routing — q_target = 0 → EXIT_NOW with full remaining quantity', () => {
    // daily_loss_pct at max → d_t=0 → q_softcap=0 → q_target=0
    const { metrics } = evaluateFixture({
      features: { quantity_remaining: 6, daily_loss_pct: 8, max_daily_loss_pct: 8 },
    });
    expect(metrics.management_state).toBe('EXIT_NOW');
    expect(metrics.management_state_reason).toMatch(/target_position_flatten/);
    expect(metrics.target_position!.q_target).toBe(0);
  });

  it('17. dust residual routing — q_target < min_residual_contracts triggers flatten', () => {
    // quantity_remaining = 2, target = 1, min_residual = 2 → residual 1 < 2 → flatten
    const { metrics } = evaluateFixture({
      cfg: { min_residual_contracts: 2 },
      popT2: 0.1, // forces q_softcap low
      features: { quantity_remaining: 2 },
    });
    // q_softcap = 10*0.1*1*1*1 = 1 → q_target = 1. delta_drop = 1 (reduce wanted).
    // Residual = q_target = 1 < 2 → dust-residual flatten.
    expect(metrics.management_state).toBe('EXIT_NOW');
    expect(metrics.management_state_reason).toMatch(/residual_below_minimum/);
  });

  it('18. hysteresis — small delta (1) requires 2 cycles of persistence', () => {
    // popT2=0.5: softcap = 10*0.5 = 5 → target=5, delta_drop = 6-5 = 1.
    const { engine, features, tradeId } = makeEngine({
      popT2: 0.5,
      features: { quantity_remaining: 6 },
    });
    const m1 = engine.evaluate(features, tradeId);
    expect(m1.management_state).toBe('HOLD');
    expect(m1.management_state_reason).toMatch(/pending_small_drop_persistence 1\/2/);
    const m2 = engine.evaluate(features, tradeId);
    expect(m2.management_state).toBe('REDUCE');
  });

  it('19. hysteresis — large delta (>=2) fires immediately', () => {
    // popT2=0.3 → softcap = 10*0.3 = 3 → target=3, delta_drop=3 from q_current=6
    const { engine, features, tradeId } = makeEngine({
      popT2: 0.3,
      features: { quantity_remaining: 6 },
    });
    const m1 = engine.evaluate(features, tradeId);
    expect(m1.management_state).toBe('REDUCE');
  });

  it('20. hysteresis counter resets on transient flip', () => {
    // popT2=0.5 → target=5 always.
    // Cycle 1: q_current=6 → delta_drop=1 → counter=1 (HOLD)
    // Cycle 2: q_current=5 → delta_drop=0 → counter resets
    // Cycle 3: q_current=6 → delta_drop=1 → counter=1 (HOLD, NOT REDUCE)
    const { engine, tradeId } = makeEngine({
      popT2: 0.5,
      features: { quantity_remaining: 6 },
    });

    const m1 = engine.evaluate(mkFeatures({ quantity_remaining: 6 }), tradeId);
    expect(m1.management_state).toBe('HOLD');
    expect(m1.management_state_reason).toMatch(/pending_small_drop_persistence 1\/2/);

    // Cycle 2: quantity_remaining=5 matches target → delta_drop=0 → counter resets
    const m2 = engine.evaluate(mkFeatures({ quantity_remaining: 5 }), tradeId);
    expect(m2.target_position!.delta).toBe(0);

    // Cycle 3: back to 6 → delta_drop=1 again, counter should be 1 (not 2) → HOLD
    const m3 = engine.evaluate(mkFeatures({ quantity_remaining: 6 }), tradeId);
    expect(m3.management_state).toBe('HOLD');
    expect(m3.management_state_reason).toMatch(/pending_small_drop_persistence 1\/2/);
  });

  it('21. session-factor noise alone does not spam reduces', () => {
    // Fix popT2 so softcap=6 (delta_drop=0 in NY_AM) and softcap<=5 (delta_drop=1 in NY_LUNCH).
    // With popT2=0.65, softcap = 10*0.65*1*s_t*1.
    // NY_AM (s=1.0):   10*0.65*1*1.0*1 = 6.5 → floor 6 → delta_drop = 0
    // NY_LUNCH (s=0.85): 10*0.65*1*0.85*1 = 5.525 → floor 5 → delta_drop = 1
    const { engine } = evaluateFixture({
      popT2: 0.65,
      features: { quantity_remaining: 6, session_bucket: 'NY_AM' },
    });
    // Cycle 1: NY_AM, delta_drop=0
    const m1 = engine.evaluate(
      mkFeatures({ quantity_remaining: 6, session_bucket: 'NY_AM' }),
      'TRADE_TEST_1',
    );
    // delta_drop = 6 - 6 = 0 → fall through to legacy HOLD/EV
    expect(m1.management_state).not.toBe('REDUCE');

    // Cycle 2: LUNCH, delta_drop=1 → counter=1
    const m2 = engine.evaluate(
      mkFeatures({ quantity_remaining: 6, session_bucket: 'NY_LUNCH' }),
      'TRADE_TEST_1',
    );
    expect(m2.management_state).not.toBe('REDUCE');

    // Cycle 3: NY_AM again, delta_drop=0 → counter resets
    engine.evaluate(mkFeatures({ quantity_remaining: 6, session_bucket: 'NY_AM' }), 'TRADE_TEST_1');

    // Cycle 4: LUNCH, delta_drop=1 → counter=1 (NOT 2) → still HOLD
    const m4 = engine.evaluate(
      mkFeatures({ quantity_remaining: 6, session_bucket: 'NY_LUNCH' }),
      'TRADE_TEST_1',
    );
    expect(m4.management_state).not.toBe('REDUCE');
  });

  it('22. target-vs-EV single-action precedence — target REDUCE suppresses EV REDUCE', () => {
    // Large target drop fires REDUCE, factors should include the suppression marker.
    const { metrics } = evaluateFixture({
      popT2: 0.1,
      features: { quantity_remaining: 6 },
    });
    expect(metrics.management_state).toBe('REDUCE');
    expect(metrics.decision_factors).toContain('ev_reduce_suppressed_by_target_reduce');
    // Only one REDUCE reason attached — not both target + EV
    expect(metrics.management_state_reason).toMatch(/target_position_reduce/);
    expect(metrics.management_state_reason).not.toMatch(/PoP\(T1\)/);
  });

  it('23. bracket-sync failure blocks future target reduces', () => {
    const { engine, features } = evaluateFixture({
      popT2: 0.1,
      features: { quantity_remaining: 6 },
    });
    const m1 = engine.evaluate(features, 'TRADE_TEST_1');
    expect(m1.management_state).toBe('REDUCE');

    // Simulate bracket-sync failure after the reduce fill
    engine.notifyBracketSyncFailed();

    // Next cycles should be blocked regardless of delta
    const m2 = engine.evaluate(mkFeatures({ quantity_remaining: 5 }), 'TRADE_TEST_1');
    expect(m2.management_state).toBe('HOLD');
    expect(m2.management_state_reason).toMatch(/bracket_sync_block_active/);

    // Unblock and verify reduces can fire again (after cooldown expires; tested next)
    engine.notifyBracketSyncReconciled();
  });

  it('24. per-trade state reset on new trade', () => {
    const { engine } = evaluateFixture({ popT2: 0.1, features: { quantity_remaining: 6 } });
    engine.notifyBracketSyncFailed();

    // New trade_id → beginTrade replaces runtime state, clearing the block
    const m = engine.evaluate(mkFeatures({ quantity_remaining: 6 }), 'TRADE_TEST_2');
    expect(m.management_state_reason).not.toMatch(/bracket_sync_block_active/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Per-cycle cap / stop-widening / stale inputs (25–28) + init edge (29)
// ───────────────────────────────────────────────────────────────────────────

describe('ManagementDecisionEngine — per-cycle cap, stale inputs, init edge', () => {
  it('25. per-cycle reduce cap clamps large delta', () => {
    // quantity_remaining = 8, popT2 makes target = 3 → delta_drop = 5, cap = 2
    // With popT2=0.3: softcap = 10*0.3 = 3 → target=3, delta=5. Large delta fires.
    const { metrics } = evaluateFixture({
      popT2: 0.3,
      features: { quantity_remaining: 8, quantity_original: 8 },
    });
    expect(metrics.management_state).toBe('REDUCE');
    expect(metrics.requested_qty_to_exit).toBe(2); // clamped from 5
  });

  it('26. stop_widening_allowed=false is the V1a default', () => {
    expect(DEFAULT_POSITION_TARGET_CONFIG.stop_widening_allowed).toBe(false);
  });

  it('27. stale input holds prior target — no recompute, no REDUCE', () => {
    const { engine, features } = evaluateFixture({
      popT2: 0.1,
      features: { quantity_remaining: 6 },
    });
    // Cycle 1: fresh recompute caches target=1 (delta_drop=5, large → REDUCE fires)
    const m1 = engine.evaluate(features, 'TRADE_TEST_1');
    expect(m1.management_state).toBe('REDUCE');

    // Cycle 2: stale inputs (NaN current_price) → stale-input branch fires
    const staleFeatures = mkFeatures({
      ...features,
      current_price: NaN,
      quantity_remaining: 6, // unchanged — prior cache has target=1, so delta_drop=5 would fire without stale guard
    });
    const m2 = engine.evaluate(staleFeatures, 'TRADE_TEST_1');
    // Stale-cache branch: HOLD with stale-input reason, NOT REDUCE
    expect(m2.management_state).toBe('HOLD');
    expect(m2.management_state_reason).toMatch(/target_position_stale_input/);
    expect(m2.target_position!.from_stale_cache).toBe(true);
  });

  it('28. stale input does not block hard risk invariants (stop breach still fires EXIT_NOW)', () => {
    const { engine } = evaluateFixture({ popT2: 0.5, features: { quantity_remaining: 6 } });
    // Cycle 1: seed a prior target
    engine.evaluate(mkFeatures({ quantity_remaining: 6 }), 'TRADE_TEST_1');

    // Cycle 2: stop breached (distance_to_stop_pts <= 0) → legacy EXIT_NOW fires
    // BEFORE target-position branches run. Verify the hard stop-breach path still wins.
    const breached = mkFeatures({
      quantity_remaining: 6,
      distance_to_stop_pts: 0, // breached
    });
    const m2 = engine.evaluate(breached, 'TRADE_TEST_1');
    expect(m2.management_state).toBe('EXIT_NOW');
    expect(m2.management_state_reason).toMatch(/Stop price breached/);
  });

  it('29. prior-target init on brand-new trade — stale inputs fall through without stale-input reason', () => {
    const model = new StubPopModel();
    model.nextPop.pop_target2_before_stop = 0.5;
    const engine = new ManagementDecisionEngine(
      MNQ,
      DEFAULT_POSITION_TARGET_CONFIG,
      model,
    );
    engine.beginTrade('TRADE_NEW_1');

    // Cycle 1: brand-new trade, stale inputs (no prior cache)
    const m1 = engine.evaluate(
      mkFeatures({ current_price: NaN, quantity_remaining: 6 }),
      'TRADE_NEW_1',
    );
    // Cold-start stale path: target_position should be null, no 'target_position_stale_input' reason
    expect(m1.target_position).toBeNull();
    expect(m1.management_state_reason).not.toMatch(/target_position_stale_input/);

    // Cycle 2: fresh inputs → seed the cache for the first time
    const m2 = engine.evaluate(mkFeatures({ quantity_remaining: 6 }), 'TRADE_NEW_1');
    expect(m2.target_position).not.toBeNull();
    expect(m2.target_position!.from_stale_cache).toBe(false);

    // Cycle 3: stale again, but now prior cache exists → stale-input branch fires
    const m3 = engine.evaluate(
      mkFeatures({ current_price: NaN, quantity_remaining: 6 }),
      'TRADE_NEW_1',
    );
    expect(m3.target_position).not.toBeNull();
    expect(m3.target_position!.from_stale_cache).toBe(true);
    expect(m3.management_state_reason).toMatch(/target_position_stale_input/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// describeTargetAction helper tests
// ───────────────────────────────────────────────────────────────────────────

describe('describeTargetAction', () => {
  it('ON_TARGET when delta = 0 and target > 0', () => {
    expect(describeTargetAction(0, 5, 0, 0)).toEqual({ kind: 'ON_TARGET', qty: 0 });
  });
  it('REDUCE when delta < 0 and no cooldown/persistence', () => {
    expect(describeTargetAction(-2, 5, 0, 0)).toEqual({ kind: 'REDUCE', qty: 2 });
  });
  it('WOULD_ADD when delta > 0', () => {
    expect(describeTargetAction(1, 7, 0, 0)).toEqual({ kind: 'WOULD_ADD', qty: 1 });
  });
  it('FLATTEN_PENDING when target = 0', () => {
    expect(describeTargetAction(-5, 0, 0, 0)).toEqual({ kind: 'FLATTEN_PENDING', qty: 0 });
  });
  it('HOLD_COOLDOWN when delta < 0 and cooldown remaining', () => {
    expect(describeTargetAction(-2, 5, 0, 15)).toEqual({ kind: 'HOLD_COOLDOWN', qty: 2 });
  });
  it('HOLD_PERSISTENCE when delta < 0 and persistence pending', () => {
    expect(describeTargetAction(-1, 6, 1, 0)).toEqual({ kind: 'HOLD_PERSISTENCE', qty: 1 });
  });
  it('HOLD_BRACKET_SYNC when delta < 0 and bracket sync blocked', () => {
    // bracketSyncBlocked=true outranks cooldown + persistence
    expect(describeTargetAction(-2, 5, 0, 0, true, false)).toEqual({
      kind: 'HOLD_BRACKET_SYNC',
      qty: 2,
    });
    expect(describeTargetAction(-2, 5, 5, 10, true, false)).toEqual({
      kind: 'HOLD_BRACKET_SYNC',
      qty: 2,
    });
  });
  it('HOLD_STALE_INPUT outranks all other states when fromStaleCache=true', () => {
    // Stale-input is the highest-priority hold: even delta=-2 with no cooldown
    // returns HOLD_STALE_INPUT, not REDUCE, because the target is frozen.
    expect(describeTargetAction(-2, 5, 0, 0, false, true)).toEqual({
      kind: 'HOLD_STALE_INPUT',
      qty: 0,
    });
    // Even combined with a bracket-sync block, stale-input takes precedence.
    expect(describeTargetAction(-2, 5, 0, 0, true, true)).toEqual({
      kind: 'HOLD_STALE_INPUT',
      qty: 0,
    });
  });
});
