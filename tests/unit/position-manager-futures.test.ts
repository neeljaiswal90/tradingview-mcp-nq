import { describe, it, expect } from 'vitest';
import { PositionManager } from '../../src/autotrade/position-manager.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';
import type { IndicatorConfig, CandidateSetup, SetupType, ResolvedManagementParams } from '../../src/autotrade/types.js';
import type { OrderResult } from '../../src/autotrade/execution.js';
import { buildDefaultProfileFromConfig, resolveProfile } from '../../src/autotrade/management-profiles.js';

const MNQ = getContractSpec('MNQ');

// This test file tests T1/trailing/BE logic — PT scaling disabled to avoid interference
const CFG: IndicatorConfig = {
  version: 'TEST', type: 'BASELINE', created_at: '2026-01-01T00:00:00Z',
  ema_fast: 9, ema_mid: 21, ema_slow: 50,
  rsi_period: 14, atr_period: 14, volume_sma_period: 20,
  min_confidence: 7.5, max_confidence: 10, min_rr: 2.0,
  max_risk_per_trade_pct: 0.5, max_daily_loss_pct: 1.5, max_consecutive_losses: 5,
  account_equity: 25_000, time_stop_minutes: 30,
  time_stop_max_r_pre_t1: 0.25, time_stop_max_r_post_t1: 1.0,
  analysis_interval_seconds: 20, in_position_monitor_seconds: 2,
  opening_range_minutes: 15, trail_ticks_post_t1: 12,
  breakeven_trigger_r: 0.5, pre_t1_trail_trigger_r: 0.75, pre_t1_trail_distance_ticks: 20,
  pt1_offset_pts: 0, pt2_offset_pts: 0,
  pt1_exit_fraction: 0.5, pt2_exit_fraction: 0.25,
  pt1_move_to_be: true, pt1_activate_trailing: true,
  enable_momentum_continuation: false, enable_opening_drive: true, enable_failed_or_break: true,
  dual_min_score: 7.5, dual_score_margin: 1.0, dual_choppy_extra_margin: 0.5,
  cooldown_bars: 3, no_same_bar_reversal: true,
};

function mgmtFromCfg(cfg: IndicatorConfig): ResolvedManagementParams {
  return resolveProfile(buildDefaultProfileFromConfig(cfg), null, MNQ);
}

function buildLongPos(pm: PositionManager, entry: number, stop: number, t1: number, t2: number, qty: number, cfg: IndicatorConfig = CFG) {
  const setup = {
    direction: 'long',
    setup_type: 'trend_pullback_long' as SetupType,
    stop, target_1: t1, target_2: t2, target_3: null, confidence: 8,
    target_1_direction_valid: true, target_2_direction_valid: true,
    target_3_direction_valid: true, target_ordering_valid: true,
    target_repair_applied: false,
  };
  const fill: OrderResult = {
    order_id: 'X', fill_price: entry, fill_time_iso: new Date().toISOString(),
    quantity: qty, side: 'long', slippage_pts: 0.25, fee_usd: 0.5, status: 'simulated',
  };
  pm.openPosition(PositionManager.buildPosition(
    'T1', 'S1', 'SESS', setup, fill, qty, qty * entry * MNQ.point_value,
    'trending_up', 'V1', 30, mgmtFromCfg(cfg),
  ));
}

describe('PositionManager — futures trailing & PnL', () => {
  it('activates trailing stop after T1 partial exit', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_990, 20_010, 20_020, 2);
    // Price reaches T1
    const dec = pm.evaluate(20_010.25, CFG);
    expect(dec.shouldExit).toBe(true);
    expect(dec.reason).toBe('target_1');
    expect(dec.isPartial).toBe(true);
    pm.applyPartialExit(dec.partialQuantity, dec.exitPrice, new Date().toISOString(), 0, 0, CFG);
    const pos = pm.getPosition()!;
    expect(pos.partial_exit_done).toBe(true);
    expect(pos.trailing_active).toBe(true);
    expect(pos.trail_distance_ticks).toBe(12);
    expect(pos.stop_current).toBeCloseTo(20_000, 2); // moved to BE
  });

  it('trailing stop only tightens, never loosens', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_990, 20_010, 20_020, 2);
    pm.evaluate(20_010.25, CFG);
    pm.applyPartialExit(1, 20_010.25, new Date().toISOString(), 0, 0, CFG);
    // Price runs up to 20_015 → trailing = 20_015 - 12ticks*0.25 = 20_012
    pm.evaluate(20_015, CFG);
    const stopAfterRun = pm.getPosition()!.stop_current;
    expect(stopAfterRun).toBeCloseTo(20_012, 2);
    // Price pulls back to 20_013 — stop should NOT loosen
    pm.evaluate(20_013, CFG);
    expect(pm.getPosition()!.stop_current).toBeCloseTo(20_012, 2);
  });

  it('moves stop to breakeven at breakeven_trigger_r pre-T1', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    // Long entry=20000, stop=19990 → risk=10pts. 0.5R = 5pts → trigger at 20005
    buildLongPos(pm, 20_000, 19_990, 20_020, 20_040, 2);
    // At +0.3R (below trigger) — stop should stay at original
    pm.evaluate(20_003, CFG);
    expect(pm.getPosition()!.stop_current).toBeCloseTo(19_990, 2);
    expect(pm.getPosition()!.pre_t1_be_triggered).toBe(false);
    // At +0.5R (trigger) — stop should move to BE
    pm.evaluate(20_005, CFG);
    expect(pm.getPosition()!.stop_current).toBeCloseTo(20_000, 2);
    expect(pm.getPosition()!.pre_t1_be_triggered).toBe(true);
    expect(pm.getPosition()!.stop_moved_to_be).toBe(true);
  });

  it('arms pre-T1 trailing at pre_t1_trail_trigger_r', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    // risk=10pts. 0.75R = 7.5pts → trigger at 20007.5
    buildLongPos(pm, 20_000, 19_990, 20_020, 20_040, 2);
    // At +0.6R — BE triggered but trailing not yet
    pm.evaluate(20_006, CFG);
    expect(pm.getPosition()!.pre_t1_be_triggered).toBe(true);
    expect(pm.getPosition()!.pre_t1_trailing_active).toBe(false);
    expect(pm.getPosition()!.trailing_active).toBe(false);
    // At +0.8R — trailing should arm
    pm.evaluate(20_008, CFG);
    expect(pm.getPosition()!.pre_t1_trailing_active).toBe(true);
    expect(pm.getPosition()!.trailing_active).toBe(true);
    expect(pm.getPosition()!.trail_distance_ticks).toBe(20);
  });

  it('pre-T1 trailing tightens stop as price moves in favor', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    // risk=10pts. Entry=20000, stop=19990
    buildLongPos(pm, 20_000, 19_990, 20_020, 20_040, 2);
    // Reach +0.8R to arm trailing (20 ticks = 5pts for MNQ)
    pm.evaluate(20_008, CFG);
    expect(pm.getPosition()!.trailing_active).toBe(true);
    // Stop should be at anchor(20008) - 20ticks*0.25 = 20008 - 5 = 20003
    expect(pm.getPosition()!.stop_current).toBeCloseTo(20_003, 2);
    // Price runs to 20015 → stop tightens to 20015 - 5 = 20010
    pm.evaluate(20_015, CFG);
    expect(pm.getPosition()!.stop_current).toBeCloseTo(20_010, 2);
    // Price pulls back to 20012 → stop should NOT loosen
    pm.evaluate(20_012, CFG);
    expect(pm.getPosition()!.stop_current).toBeCloseTo(20_010, 2);
  });

  it('pre-T1 protection disabled when breakeven_trigger_r is 0', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    const noBeCfg = { ...CFG, breakeven_trigger_r: 0, pre_t1_trail_trigger_r: 0 };
    buildLongPos(pm, 20_000, 19_990, 20_020, 20_040, 2, noBeCfg);
    // At +0.8R — no pre-T1 protection should fire
    pm.evaluate(20_008, noBeCfg);
    expect(pm.getPosition()!.pre_t1_be_triggered).toBe(false);
    expect(pm.getPosition()!.pre_t1_trailing_active).toBe(false);
    expect(pm.getPosition()!.stop_current).toBeCloseTo(19_990, 2);
  });

  it('T1 partial switches from pre-T1 trail to tighter post-T1 trail', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    // risk=10pts, T1 at +2R (20020)
    buildLongPos(pm, 20_000, 19_990, 20_020, 20_040, 2);
    // Trigger pre-T1 trailing at +0.8R
    pm.evaluate(20_008, CFG);
    expect(pm.getPosition()!.trail_distance_ticks).toBe(20); // pre-T1 distance
    // Hit T1 at 20020
    const dec = pm.evaluate(20_020.25, CFG);
    expect(dec.reason).toBe('target_1');
    pm.applyPartialExit(dec.partialQuantity, dec.exitPrice, new Date().toISOString(), 0, 0, CFG);
    // Trail should switch to post-T1 distance (tighter)
    expect(pm.getPosition()!.trail_distance_ticks).toBe(12); // post-T1 distance
    expect(pm.getPosition()!.partial_exit_done).toBe(true);
  });

  it('futures PnL uses contract point_value, not raw price diff', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_990, 20_010, 20_020, 3);
    pm.evaluate(20_010, CFG); // at T1
    const fill: OrderResult = {
      order_id: 'X', fill_price: 20_010, fill_time_iso: new Date().toISOString(),
      quantity: 3, side: 'long', slippage_pts: 0.25, fee_usd: 1.5, status: 'simulated',
    };
    const rec = pm.closePosition(fill, 'target_2', 'trending_up', 'SESS', 'V1', 20_010, {
      target_1_direction_valid: true, target_2_direction_valid: true,
      target_3_direction_valid: true, target_ordering_valid: true,
      target_repair_applied: false,
    });
    // 10pts × 3 contracts × $2 (MNQ) = $60, minus $1.5 fee = $58.50
    expect(rec.pnl_realized).toBeCloseTo(58.5, 2);
    expect(rec.symbol).toBe('MNQ1!');
    expect(rec.venue).toBe('CME_MINI');
  });
});
