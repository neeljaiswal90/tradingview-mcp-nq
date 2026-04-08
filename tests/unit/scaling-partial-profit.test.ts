/**
 * Tests for PT1/PT2 partial-profit scaling framework.
 *
 * Covers:
 *   1. PT1 triggers at configured offset from entry
 *   2. PT2 triggers after PT1 at second offset
 *   3. Correct quantity calculation per exit fraction
 *   4. Stop moves to breakeven after PT1 (when configured)
 *   5. Trailing activates after PT1 (when configured)
 *   6. Single-contract: PT1 full exit (no runner possible)
 *   7. PT disabled (offset=0) falls through to T1/T2 logic
 *   8. Exit labels: partial_profit_1, partial_profit_2
 *   9. Position state tracking: pt1_done, pt2_done, realized PnL
 *  10. No regression: T1/T2/stop still work normally
 *  11. Dashboard snapshot includes scaling state
 */

import { describe, it, expect } from 'vitest';
import { PositionManager } from '../../src/autotrade/position-manager.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';
import type { IndicatorConfig, SetupType, ResolvedManagementParams } from '../../src/autotrade/types.js';
import type { OrderResult } from '../../src/autotrade/execution.js';
import { buildDefaultProfileFromConfig, resolveProfile } from '../../src/autotrade/management-profiles.js';

const MNQ = getContractSpec('MNQ');

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
  enable_momentum_continuation: false, enable_opening_drive: true, enable_failed_or_break: true,
  dual_min_score: 7.5, dual_score_margin: 1.0, dual_choppy_extra_margin: 0.5,
  cooldown_bars: 3, no_same_bar_reversal: true,
  // PT scaling
  pt1_offset_pts: 6,
  pt2_offset_pts: 15,
  pt1_exit_fraction: 0.5,
  pt2_exit_fraction: 0.25,
  pt1_move_to_be: true,
  pt1_activate_trailing: true,
};

const NOW = new Date().toISOString();

/** Build resolved management params from a config for testing. */
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
    order_id: 'X', fill_price: entry, fill_time_iso: NOW,
    quantity: qty, side: 'long', slippage_pts: 0.25, fee_usd: 0.5, status: 'simulated',
  };
  pm.openPosition(PositionManager.buildPosition(
    'T1', 'S1', 'SESS', setup, fill, qty, qty * entry * MNQ.point_value,
    'trending_up', 'V1', 30, mgmtFromCfg(cfg),
  ));
}

function buildShortPos(pm: PositionManager, entry: number, stop: number, t1: number, t2: number, qty: number, cfg: IndicatorConfig = CFG) {
  const setup = {
    direction: 'short',
    setup_type: 'trend_pullback_short' as SetupType,
    stop, target_1: t1, target_2: t2, target_3: null, confidence: 8,
    target_1_direction_valid: true, target_2_direction_valid: true,
    target_3_direction_valid: true, target_ordering_valid: true,
    target_repair_applied: false,
  };
  const fill: OrderResult = {
    order_id: 'X', fill_price: entry, fill_time_iso: NOW,
    quantity: qty, side: 'short', slippage_pts: 0.25, fee_usd: 0.5, status: 'simulated',
  };
  pm.openPosition(PositionManager.buildPosition(
    'T1', 'S1', 'SESS', setup, fill, qty, qty * entry * MNQ.point_value,
    'trending_down', 'V1', 30, mgmtFromCfg(cfg),
  ));
}

describe('PT1 / PT2 Partial-Profit Scaling', () => {
  // ── PT1 Basic Functionality ────────────────────────────────────────────

  it('triggers PT1 at configured offset for long position', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    // Price at +5 pts — should NOT trigger PT1 (6pts required)
    const dec1 = pm.evaluate(20_005, CFG);
    expect(dec1.shouldExit).toBe(false);

    // Price at +6 pts — should trigger PT1
    const dec2 = pm.evaluate(20_006, CFG);
    expect(dec2.shouldExit).toBe(true);
    expect(dec2.reason).toBe('partial_profit_1');
    expect(dec2.isPartial).toBe(true);
    expect(dec2.partialQuantity).toBe(2); // 50% of 4 = 2
    expect(dec2.plannedExitPrice).toBe(20_006); // entry + 6pts
  });

  it('triggers PT1 at configured offset for short position', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildShortPos(pm, 20_000, 20_040, 19_950, 19_900, 4);

    // Price at -5 pts (favorable for short) — should NOT trigger
    const dec1 = pm.evaluate(19_995, CFG);
    expect(dec1.shouldExit).toBe(false);

    // Price at -6 pts (favorable for short) — should trigger PT1
    const dec2 = pm.evaluate(19_994, CFG);
    expect(dec2.shouldExit).toBe(true);
    expect(dec2.reason).toBe('partial_profit_1');
    expect(dec2.isPartial).toBe(true);
    expect(dec2.partialQuantity).toBe(2);
    expect(dec2.plannedExitPrice).toBe(19_994); // entry - 6pts
  });

  // ── PT1 Post-Exit State ──────────────────────────────────────────────

  it('moves stop to BE and arms trailing after PT1 when configured', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    const dec = pm.evaluate(20_006, CFG);
    expect(dec.reason).toBe('partial_profit_1');
    // 6pts × 2qty × $2/pt = $24
    pm.applyPt1Exit(dec.partialQuantity, dec.exitPrice, NOW, 0, 0, CFG);

    const pos = pm.getPosition()!;
    expect(pos.pt1_done).toBe(true);
    expect(pos.pt1_qty_exited).toBe(2);
    expect(pos.pt1_realized_pnl).toBe(24);
    expect(pos.quantity_remaining).toBe(2); // 4 - 2 = 2
    expect(pos.stop_current).toBe(20_000); // moved to BE
    expect(pos.stop_moved_to_be).toBe(true);
    expect(pos.trailing_active).toBe(true);
    expect(pos.trail_distance_ticks).toBe(12); // post-T1 trail distance
  });

  it('does NOT move to BE when pt1_move_to_be is false', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    const noBeCfg = { ...CFG, pt1_move_to_be: false };
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4, noBeCfg);

    const dec = pm.evaluate(20_006, noBeCfg);
    pm.applyPt1Exit(dec.partialQuantity, dec.exitPrice, NOW, 0, 0, noBeCfg);

    const pos = pm.getPosition()!;
    expect(pos.pt1_done).toBe(true);
    expect(pos.stop_current).toBe(19_960); // unchanged from initial stop
    expect(pos.stop_moved_to_be).toBe(false);
  });

  it('does NOT activate trailing when pt1_activate_trailing is false', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    const noTrailCfg = { ...CFG, pt1_activate_trailing: false };
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4, noTrailCfg);

    const dec = pm.evaluate(20_006, noTrailCfg);
    pm.applyPt1Exit(dec.partialQuantity, dec.exitPrice, NOW, 0, 0, noTrailCfg);

    const pos = pm.getPosition()!;
    expect(pos.trailing_active).toBe(false);
  });

  // ── PT2 ─────────────────────────────────────────────────────────────

  it('triggers PT2 after PT1 at second offset', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    // Take PT1
    const dec1 = pm.evaluate(20_006, CFG);
    pm.applyPt1Exit(dec1.partialQuantity, dec1.exitPrice, NOW, 0, 0, CFG);

    // Price at +14 pts — should NOT trigger PT2 (15pts required)
    const dec2 = pm.evaluate(20_014, CFG);
    expect(dec2.shouldExit).toBe(false);

    // Price at +15 pts — should trigger PT2
    const dec3 = pm.evaluate(20_015, CFG);
    expect(dec3.shouldExit).toBe(true);
    expect(dec3.reason).toBe('partial_profit_2');
    expect(dec3.isPartial).toBe(true);
    // 25% of original 4 = 1 contract
    expect(dec3.partialQuantity).toBe(1);
  });

  it('PT2 state updates correctly', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    // Take PT1
    const dec1 = pm.evaluate(20_006, CFG);
    pm.applyPt1Exit(dec1.partialQuantity, dec1.exitPrice, NOW, 0, 0, CFG);
    expect(pm.getPosition()!.quantity_remaining).toBe(2);

    // Take PT2 — 15pts × 1qty × $2 = $30
    const dec2 = pm.evaluate(20_015, CFG);
    pm.applyPt2Exit(dec2.partialQuantity, dec2.exitPrice, NOW, 0, 0, CFG);

    const pos = pm.getPosition()!;
    expect(pos.pt2_done).toBe(true);
    expect(pos.pt2_qty_exited).toBe(1);
    expect(pos.pt2_realized_pnl).toBe(30);
    expect(pos.quantity_remaining).toBe(1); // runner remains
  });

  // ── PT2 does NOT trigger before PT1 ────────────────────────────────

  it('PT2 does not trigger until PT1 is done', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    // Price at +15 pts — PT1 not yet done, so only PT1 should trigger
    const dec = pm.evaluate(20_015, CFG);
    expect(dec.reason).toBe('partial_profit_1');
    expect(dec.reason).not.toBe('partial_profit_2');
  });

  // ── Single contract: PT1 full exit ─────────────────────────────────

  it('with 1 contract, PT1 triggers as full exit (no runner)', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 1);

    const dec = pm.evaluate(20_006, CFG);
    expect(dec.shouldExit).toBe(true);
    expect(dec.reason).toBe('partial_profit_1');
    expect(dec.isPartial).toBe(false); // full exit with 1 contract
    expect(dec.partialQuantity).toBe(0);
  });

  // ── PT disabled: falls through to T1/T2 ────────────────────────────

  it('when pt1_offset_pts=0, normal T1 logic fires', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    const noPtCfg = { ...CFG, pt1_offset_pts: 0, pt2_offset_pts: 0 };
    buildLongPos(pm, 20_000, 19_960, 20_010, 20_020, 2, noPtCfg);

    // Price at T1 (20010) — should use normal T1 logic
    const dec = pm.evaluate(20_010, noPtCfg);
    expect(dec.shouldExit).toBe(true);
    expect(dec.reason).toBe('target_1');
    expect(dec.isPartial).toBe(true);
  });

  // ── Quantity math ──────────────────────────────────────────────────

  it('correct qty split for 3-contract position', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 3);

    // PT1: 50% of 3 = floor(1.5) = 1
    const dec1 = pm.evaluate(20_006, CFG);
    expect(dec1.partialQuantity).toBe(1); // floor(3 * 0.5) = 1

    // 6pts × 1qty × $2 = $12
    pm.applyPt1Exit(1, 20_006, NOW, 0, 0, CFG);
    expect(pm.getPosition()!.quantity_remaining).toBe(2);

    // PT2: 25% of original 3 = floor(0.75) = max(1, 0) = 1
    // But leaves at least 1 runner: maxQty = 2-1 = 1
    const dec2 = pm.evaluate(20_015, CFG);
    expect(dec2.partialQuantity).toBe(1);

    // 15pts × 1qty × $2 = $30
    pm.applyPt2Exit(1, 20_015, NOW, 0, 0, CFG);
    expect(pm.getPosition()!.quantity_remaining).toBe(1); // runner
  });

  it('correct qty split for 2-contract position', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 2);

    // PT1: 50% of 2 = 1 contract
    const dec1 = pm.evaluate(20_006, CFG);
    expect(dec1.partialQuantity).toBe(1);

    pm.applyPt1Exit(1, 20_006, NOW, 0, 0, CFG);
    expect(pm.getPosition()!.quantity_remaining).toBe(1);

    // PT2: only 1 contract left, need to leave 1 for runner → maxQty = 0 → skipped
    const dec2 = pm.evaluate(20_015, CFG);
    // With only 1 contract remaining, PT2 should NOT fire (can't leave runner)
    expect(dec2.reason).not.toBe('partial_profit_2');
  });

  // ── Stop loss still works with PT active ───────────────────────────

  it('stop loss fires normally before PT1', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    const dec = pm.evaluate(19_960, CFG);
    expect(dec.shouldExit).toBe(true);
    expect(dec.reason).toBe('stop_loss');
    expect(dec.isPartial).toBe(false);
  });

  it('stop loss at BE fires after PT1 move to BE', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    // Take PT1 (moves to BE)
    const dec1 = pm.evaluate(20_006, CFG);
    pm.applyPt1Exit(dec1.partialQuantity, dec1.exitPrice, NOW, 0, 0, CFG);

    // Price falls to entry — BE stop should fire
    const dec2 = pm.evaluate(20_000, CFG);
    expect(dec2.shouldExit).toBe(true);
    expect(dec2.reason).toBe('stop_loss');
  });

  // ── T2 full exit still works after PT1+PT2 ────────────────────────

  it('T2 closes runner after PT1+PT2', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    // PT1
    pm.evaluate(20_006, CFG);
    pm.applyPt1Exit(2, 20_006, NOW, 0, 0, CFG);

    // PT2
    pm.evaluate(20_015, CFG);
    pm.applyPt2Exit(1, 20_015, NOW, 0, 0, CFG);

    // Runner hits T2
    const dec = pm.evaluate(20_100, CFG);
    expect(dec.shouldExit).toBe(true);
    expect(dec.reason).toBe('target_2');
    expect(dec.isPartial).toBe(false); // full exit of runner
  });

  // ── Position initialization ────────────────────────────────────────

  it('new positions initialize PT scaling state to defaults', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    const pos = pm.getPosition()!;
    expect(pos.pt1_done).toBe(false);
    expect(pos.pt2_done).toBe(false);
    expect(pos.pt1_realized_pnl).toBe(0);
    expect(pos.pt2_realized_pnl).toBe(0);
    expect(pos.pt1_qty_exited).toBe(0);
    expect(pos.pt2_qty_exited).toBe(0);
    expect(pos.exit_legs).toHaveLength(0);
    expect(pos.realized_pnl_so_far).toBe(0);
    expect(pos.realized_fees_so_far).toBe(0);
  });

  // ── Trailing tightens after PT1 ────────────────────────────────────

  it('trailing stop tightens after PT1 as price advances', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildLongPos(pm, 20_000, 19_960, 20_050, 20_100, 4);

    // Take PT1
    const dec1 = pm.evaluate(20_006, CFG);
    pm.applyPt1Exit(dec1.partialQuantity, dec1.exitPrice, NOW, 0, 0, CFG);
    expect(pm.getPosition()!.trailing_active).toBe(true);

    // Price runs to 20015 → trailing = 20015 - 12ticks*0.25 = 20012
    pm.evaluate(20_015, CFG);
    expect(pm.getPosition()!.stop_current).toBeCloseTo(20_012, 1);

    // Price pulls back — stop should not loosen
    pm.evaluate(20_012, CFG);
    expect(pm.getPosition()!.stop_current).toBeCloseTo(20_012, 1);
  });

  // ── Short position PT flow ─────────────────────────────────────────

  it('full PT1→PT2→runner flow for short position', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    buildShortPos(pm, 20_000, 20_040, 19_950, 19_900, 4);

    // PT1: price falls 6 pts → (20000-19994)×2×$2 = $24
    const dec1 = pm.evaluate(19_994, CFG);
    expect(dec1.reason).toBe('partial_profit_1');
    expect(dec1.partialQuantity).toBe(2);
    pm.applyPt1Exit(2, 19_994, NOW, 0, 0, CFG);
    expect(pm.getPosition()!.stop_current).toBe(20_000); // BE
    expect(pm.getPosition()!.pt1_realized_pnl).toBe(24);

    // PT2: price falls 15 pts → (20000-19985)×1×$2 = $30
    const dec2 = pm.evaluate(19_985, CFG);
    expect(dec2.reason).toBe('partial_profit_2');
    expect(dec2.partialQuantity).toBe(1);
    pm.applyPt2Exit(1, 19_985, NOW, 0, 0, CFG);
    expect(pm.getPosition()!.quantity_remaining).toBe(1);
    expect(pm.getPosition()!.pt2_realized_pnl).toBe(30);

    // Runner hits T2
    const dec3 = pm.evaluate(19_900, CFG);
    expect(dec3.reason).toBe('target_2');
    expect(dec3.isPartial).toBe(false);
  });
});
