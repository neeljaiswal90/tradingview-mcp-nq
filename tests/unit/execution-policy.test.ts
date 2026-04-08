/**
 * Tests for the ExecutionPolicyEngine.
 */

import { describe, it, expect } from 'vitest';
import { ExecutionPolicyEngine } from '../../src/autotrade/execution-policy/engine.js';
import { DEFAULT_EXECUTION_POLICY_CONFIG } from '../../src/autotrade/execution-policy/types.js';
import type { ExecutionPolicyConfig } from '../../src/autotrade/execution-policy/types.js';
import type { Position } from '../../src/autotrade/types.js';
import type { LobSnapshot } from '../../src/autotrade/lob-client.js';

const ENABLED: ExecutionPolicyConfig = {
  ...DEFAULT_EXECUTION_POLICY_CONFIG,
  enabled: true,
};

function makePos(overrides: Partial<Position> = {}): Position {
  return {
    trade_id: 'T001', signal_id: 'S001', session_id: 'SS001',
    side: 'long', entry_price: 24200, entry_time_unix: Date.now() - 60000,
    entry_time_iso: new Date().toISOString(), stop_initial: 24160,
    stop_current: 24170, target_1: 24260, target_2: 24320, target_3: null,
    quantity: 5, notional: 121000, setup_type: 'trend_pullback_long',
    market_regime_at_entry: 'trending_up', config_version: 'v1',
    confidence: 8, stop_moved_to_be: false, partial_exit_done: false,
    quantity_remaining: 5, max_favorable_excursion: 12,
    max_adverse_excursion: 5, last_checked_price: 24210,
    time_stop_minutes: 30, pre_t1_be_triggered: false,
    pre_t1_trailing_active: false, trailing_active: false,
    trail_distance_ticks: 0, trail_anchor_price: null,
    target_1_direction_valid: true, target_2_direction_valid: true,
    target_3_direction_valid: true, target_ordering_valid: true,
    target_repair_applied: false, pt1_done: false, pt2_done: false,
    pt1_realized_pnl: 0, pt2_realized_pnl: 0, pt1_qty_exited: 0,
    pt2_qty_exited: 0, exit_legs: [], realized_pnl_so_far: 0,
    realized_fees_so_far: 0, atr_at_entry: 10,
    management_params: {
      profile_name: 'default', family: 'default', atr_at_entry: 10,
      pt1_offset_pts: 5, pt2_offset_pts: 12, pt1_exit_fraction: 0.5,
      pt2_exit_fraction: 0.25, pt1_move_to_be: true, pt1_activate_trailing: true,
      trail_ticks_post_t1: 20, breakeven_trigger_r: 0.5, pre_t1_trail_trigger_r: 0.75,
      pre_t1_trail_distance_ticks: 20, time_stop_minutes: 30,
      time_stop_max_r_pre_t1: 0.25, time_stop_max_r_post_t1: 1.0,
    },
    mfe_at_pt1_trigger: 0, mae_at_pt1_trigger: 0, peak_r_before_first_partial: 0,
    ...overrides,
  } as Position;
}

function makeLob(overrides: Partial<LobSnapshot> = {}): LobSnapshot {
  return {
    timestamp_ms: Date.now(), bbo_age_ms: 50,
    data_quality: 'full_bbo', recording_context: 'trade',
    bid: 24200.25, ask: 24200.50, mid: 24200.375,
    bid_size: 45, ask_size: 32,
    spread_pts: 0.25, spread_ticks: 1,
    depth_imbalance_5: 0.2, depth_imbalance_10: 0.15,
    total_bid_depth_10lvl: 500, total_ask_depth_10lvl: 400,
    large_bid_within_5pts: false, large_ask_within_5pts: false,
    cumulative_delta_10s: 50, cumulative_delta_30s: 120,
    cumulative_delta_60s: 200,
    trade_flow_imbalance_10s: 0.6, trade_flow_imbalance_30s: 0.55,
    cancel_add_ratio_10s: 0.8, replenishment_rate_10s: 0.5,
    absorption_rate_10s: 0.6, mean_order_lifetime_top_book: 500,
    aggressor_penetration_10s: 1.2, sweep_count_10s: 0,
    trade_id: null, signal_id: null,
    ...overrides,
  } as LobSnapshot;
}

describe('ExecutionPolicyEngine', () => {
  it('passes through when policy is disabled', () => {
    const engine = new ExecutionPolicyEngine({ ...ENABLED, enabled: false });
    const result = engine.evaluate('EXIT_ALL', makePos(), makeLob(), 100);
    expect(result.should_execute).toBe(true);
    expect(result.checks[0]?.name).toBe('policy_disabled');
  });

  it('blocks passive actions (HOLD, NO_ACTION)', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const hold = engine.evaluate('HOLD', makePos(), makeLob(), 100);
    expect(hold.should_execute).toBe(false);
    const noAction = engine.evaluate('NO_ACTION', makePos(), makeLob(), 100);
    expect(noAction.should_execute).toBe(false);
  });

  it('blocks non-risk-reducing actions on stale quotes', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const result = engine.evaluate('MOVE_STOP', makePos(), makeLob(), 10000, null, 24180);
    const quoteCheck = result.checks.find(c => c.name === 'quote_freshness');
    expect(quoteCheck?.passed).toBe(false);
    expect(result.should_execute).toBe(false);
  });

  it('allows EXIT_ALL on stale quotes (risk-reducing)', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const result = engine.evaluate('EXIT_ALL', makePos(), makeLob(), 10000);
    const quoteCheck = result.checks.find(c => c.name === 'quote_freshness');
    expect(quoteCheck?.passed).toBe(true);
  });

  it('blocks stop widening for long', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const pos = makePos({ side: 'long', stop_current: 24170 });
    const result = engine.evaluate('MOVE_STOP', pos, makeLob(), 100, null, 24160); // below = widen
    const stopCheck = result.checks.find(c => c.name === 'stop_only_tightens');
    expect(stopCheck?.passed).toBe(false);
  });

  it('blocks stop widening for short', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const pos = makePos({ side: 'short', stop_current: 24240 });
    const result = engine.evaluate('MOVE_STOP', pos, makeLob(), 100, null, 24250); // above = widen
    const stopCheck = result.checks.find(c => c.name === 'stop_only_tightens');
    expect(stopCheck?.passed).toBe(false);
  });

  it('allows stop tightening for long', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const pos = makePos({ side: 'long', stop_current: 24170 });
    const result = engine.evaluate('MOVE_STOP', pos, makeLob(), 100, null, 24180); // above = tighten
    const stopCheck = result.checks.find(c => c.name === 'stop_only_tightens');
    expect(stopCheck?.passed).toBe(true);
  });

  it('blocks wide spread for non-urgent execution', () => {
    const engine = new ExecutionPolicyEngine({ ...ENABLED, max_spread_ticks_normal: 1 });
    const wideLob = makeLob({ spread_ticks: 3 });
    const result = engine.evaluate('MOVE_TO_BREAKEVEN', makePos(), wideLob, 100);
    const spreadCheck = result.checks.find(c => c.name === 'spread_risk');
    expect(spreadCheck?.passed).toBe(false);
  });

  it('allows wide spread for risk-reducing actions', () => {
    const engine = new ExecutionPolicyEngine({ ...ENABLED, max_spread_ticks_normal: 1 });
    const wideLob = makeLob({ spread_ticks: 3 });
    const result = engine.evaluate('EXIT_ALL', makePos(), wideLob, 100);
    // EXIT_ALL bypasses spread gate
    const spreadCheck = result.checks.find(c => c.name === 'spread_risk');
    expect(spreadCheck?.passed).toBe(true);
  });

  it('blocks SCALE_IN when disabled', () => {
    const engine = new ExecutionPolicyEngine({ ...ENABLED, enable_scale_in: false });
    const result = engine.evaluate('SCALE_IN', makePos(), makeLob(), 100, 2);
    const flagCheck = result.checks.find(c => c.name === 'scale_in_enabled');
    expect(flagCheck?.passed).toBe(false);
    expect(result.should_execute).toBe(false);
  });

  it('blocks SCALE_IN when would exceed max_position_size', () => {
    const engine = new ExecutionPolicyEngine({ ...ENABLED, enable_scale_in: true, max_position_size: 5 });
    const pos = makePos({ quantity_remaining: 5 });
    const result = engine.evaluate('SCALE_IN', pos, makeLob(), 100, 2); // 5+2 = 7 > 5
    const sizeCheck = result.checks.find(c => c.name === 'max_position_size');
    expect(sizeCheck?.passed).toBe(false);
  });

  it('enforces action cooldown', () => {
    const engine = new ExecutionPolicyEngine({ ...ENABLED, action_cooldown_sec: 30 });
    engine.recordExecution('MOVE_STOP');
    // Immediately try another action
    const result = engine.evaluate('MOVE_TO_BREAKEVEN', makePos(), makeLob(), 100);
    const cooldownCheck = result.checks.find(c => c.name === 'action_cooldown');
    expect(cooldownCheck?.passed).toBe(false);
  });

  it('risk-reducing actions bypass cooldown', () => {
    const engine = new ExecutionPolicyEngine({ ...ENABLED, action_cooldown_sec: 30 });
    engine.recordExecution('MOVE_STOP');
    const result = engine.evaluate('EXIT_ALL', makePos(), makeLob(), 100);
    const cooldownCheck = result.checks.find(c => c.name === 'action_cooldown');
    expect(cooldownCheck?.passed).toBe(true);
  });

  it('classifies sweep pressure as immediate urgency', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const sweepLob = makeLob({ sweep_count_10s: 3 });
    const result = engine.evaluate('EXIT_PARTIAL', makePos(), sweepLob, 100, 2);
    expect(result.intent.urgency).toBe('immediate');
  });

  it('classifies high cancel_add_ratio as patient urgency', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const spoofLob = makeLob({ cancel_add_ratio_10s: 4.0, sweep_count_10s: 0, aggressor_penetration_10s: 0.5 });
    const result = engine.evaluate('MOVE_TO_BREAKEVEN', makePos(), spoofLob, 100);
    expect(result.intent.urgency).toBe('patient');
  });

  it('works with null LOB snapshot (degraded)', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const result = engine.evaluate('EXIT_ALL', makePos(), null, 100);
    expect(result.should_execute).toBe(true);
    expect(result.intent.microstructure.data_quality).toBe('unavailable');
  });

  it('logs intent with microstructure fields', () => {
    const engine = new ExecutionPolicyEngine(ENABLED);
    const result = engine.evaluate('EXIT_ALL', makePos(), makeLob(), 100);
    expect(result.intent.microstructure.spread_ticks).toBe(1);
    expect(result.intent.microstructure.quote_age_ms).toBe(100);
  });
});
