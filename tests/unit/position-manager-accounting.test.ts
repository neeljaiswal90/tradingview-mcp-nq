import { describe, it, expect } from 'vitest';
import { PositionManager } from '../../src/autotrade/position-manager.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';
import type { IndicatorConfig, SetupType } from '../../src/autotrade/types.js';
import type { OrderResult } from '../../src/autotrade/execution.js';

const MNQ = getContractSpec('MNQ'); // $2/pt, tick=0.25

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
  pt1_offset_pts: 10, pt2_offset_pts: 20,
  pt1_move_to_be: true, pt1_activate_trailing: false,
};

const TV = { target_1_direction_valid: true, target_2_direction_valid: true, target_3_direction_valid: true, target_ordering_valid: true, target_repair_applied: false };
const NOW = new Date().toISOString();

function makePm(entry: number, stop: number, t1: number, t2: number, qty: number): PositionManager {
  const pm = new PositionManager(MNQ, 'MNQ1!');
  const setup = {
    direction: 'long', setup_type: 'trend_pullback_long' as SetupType,
    stop, target_1: t1, target_2: t2, target_3: null, confidence: 8,
    ...TV,
  };
  const fill: OrderResult = {
    order_id: 'X', fill_price: entry, fill_time_iso: NOW,
    quantity: qty, side: 'long', slippage_pts: 0, fee_usd: 0, status: 'simulated',
  };
  pm.openPosition(PositionManager.buildPosition('T1', 'S1', 'SESS', setup, fill, qty, qty * entry * MNQ.point_value, 'trending_up', 'V1', 30));
  return pm;
}

function closeAt(pm: PositionManager, price: number, reason: 'stop_loss' | 'target_2' | 'target_3' | 'time_stop', feeUsd = 0): ReturnType<PositionManager['closePosition']> {
  const fill: OrderResult = {
    order_id: 'C', fill_price: price, fill_time_iso: NOW,
    quantity: pm.getPosition()!.quantity_remaining, side: 'short', slippage_pts: 0, fee_usd: feeUsd, status: 'simulated',
  };
  return pm.closePosition(fill, reason, 'trending_up', 'SESS', 'V1', price, TV);
}

describe('PositionManager — fill-based PnL accounting', () => {
  it('1-contract full exit: single leg, no partials', () => {
    const pm = makePm(20_000, 19_990, 20_010, 20_020, 1);
    const rec = closeAt(pm, 20_015, 'target_2', 0.5);

    // 15pts × 1ct × $2 - $0.50 fee = $29.50
    expect(rec.exit_legs).toHaveLength(1);
    expect(rec.exit_legs![0]!.pnl_usd).toBeCloseTo(29.5, 2);
    expect(rec.pnl_realized).toBeCloseTo(29.5, 2);
    expect(rec.partial_exit_count).toBe(0);
    expect(rec.exit_legs_count).toBe(1);
    expect(rec.pnl_pt1).toBeNull();
    expect(rec.pnl_pt2).toBeNull();
    // runner leg = final leg pnl
    expect(rec.pnl_runner).toBeCloseTo(29.5, 2);
  });

  it('2-contract PT1 partial then runner to T2: 2 legs, correct per-leg pnl', () => {
    const pm = makePm(20_000, 19_990, 20_010, 20_020, 2);
    // PT1: 1ct at 20010, fee=$0.50
    pm.applyPt1Exit(1, 20_010, NOW, 0.5, 0, CFG);

    const pos = pm.getPosition()!;
    expect(pos.quantity_remaining).toBe(1);
    expect(pos.pt1_done).toBe(true);
    expect(pos.realized_pnl_so_far).toBeCloseTo(19.5, 2); // 10pts*1*$2 - $0.5

    const rec = closeAt(pm, 20_020, 'target_2', 0.5);

    // Leg 0: 10pts × 1ct × $2 - $0.50 = $19.50
    // Leg 1: 20pts × 1ct × $2 - $0.50 = $39.50
    expect(rec.exit_legs).toHaveLength(2);
    expect(rec.exit_legs![0]!.pnl_usd).toBeCloseTo(19.5, 2);
    expect(rec.exit_legs![1]!.pnl_usd).toBeCloseTo(39.5, 2);
    expect(rec.pnl_realized).toBeCloseTo(59.0, 2);
    expect(rec.pnl_pt1).toBeCloseTo(19.5, 2);
    expect(rec.pnl_pt2).toBeNull();
    expect(rec.pnl_runner).toBeCloseTo(39.5, 2);
    expect(rec.partial_exit_count).toBe(1);
    expect(rec.exit_legs_count).toBe(2);
    expect(rec.total_fees_usd).toBeCloseTo(1.0, 2);
  });

  it('3-leg: PT1 + PT2 + runner stop-out on 4 contracts', () => {
    const pm = makePm(20_000, 19_990, 20_010, 20_020, 4);
    // PT1: 2ct at 20010, fee=$1.00  → 10pts*2*$2 - $1 = $39
    pm.applyPt1Exit(2, 20_010, NOW, 1.0, 0, CFG);
    // PT2: 1ct at 20020, fee=$0.50  → 20pts*1*$2 - $0.5 = $39.50
    pm.applyPt2Exit(1, 20_020, NOW, 0.5, 0, CFG);

    const pos = pm.getPosition()!;
    expect(pos.quantity_remaining).toBe(1);
    expect(pos.realized_pnl_so_far).toBeCloseTo(78.5, 2); // $39 + $39.50

    // Runner: 1ct at 20005 (trailing stop), fee=$0.50  → 5pts*1*$2 - $0.5 = $9.50
    const rec = closeAt(pm, 20_005, 'stop_loss', 0.5);

    expect(rec.exit_legs).toHaveLength(3);
    expect(rec.exit_legs![0]!.pnl_usd).toBeCloseTo(39.0, 2);
    expect(rec.exit_legs![1]!.pnl_usd).toBeCloseTo(39.5, 2);
    expect(rec.exit_legs![2]!.pnl_usd).toBeCloseTo(9.5, 2);
    expect(rec.pnl_realized).toBeCloseTo(88.0, 2);
    expect(rec.pnl_pt1).toBeCloseTo(39.0, 2);
    expect(rec.pnl_pt2).toBeCloseTo(39.5, 2);
    expect(rec.pnl_runner).toBeCloseTo(9.5, 2);
    expect(rec.partial_exit_count).toBe(2);
    expect(rec.exit_legs_count).toBe(3);
    expect(rec.total_fees_usd).toBeCloseTo(2.0, 2);

    // R-multiple: $88 / (10pts * 4ct * $2) = $88 / $80 = 1.1
    expect(rec.r_multiple).toBeCloseTo(1.1, 2);
  });

  it('losing trade (no partials): negative pnl, negative r_multiple', () => {
    const pm = makePm(20_000, 19_990, 20_010, 20_020, 1);
    const rec = closeAt(pm, 19_985, 'stop_loss', 0.5);

    // -15pts × 1ct × $2 - $0.50 = -$30.50
    expect(rec.pnl_realized).toBeCloseTo(-30.5, 2);
    expect(rec.exit_legs).toHaveLength(1);
    expect(rec.exit_legs![0]!.pnl_usd).toBeCloseTo(-30.5, 2);
    expect(rec.r_multiple).toBeLessThan(0);
    expect(rec.outcome_class).toBe('loser');
    expect(rec.exit_legs_count).toBe(1);
    expect(rec.partial_exit_count).toBe(0);
  });

  it('fees are attributed per leg and sum matches total_fees_usd', () => {
    const pm = makePm(20_000, 19_990, 20_010, 20_020, 3);
    // PT1: 1ct, fee=$1.25
    pm.applyPt1Exit(1, 20_010, NOW, 1.25, 0, CFG);
    // PT2: 1ct, fee=$1.25
    pm.applyPt2Exit(1, 20_020, NOW, 1.25, 0, CFG);
    // Final: 1ct, fee=$1.25
    const rec = closeAt(pm, 20_030, 'target_3', 1.25);

    expect(rec.exit_legs![0]!.fee_usd).toBeCloseTo(1.25, 2);
    expect(rec.exit_legs![1]!.fee_usd).toBeCloseTo(1.25, 2);
    expect(rec.exit_legs![2]!.fee_usd).toBeCloseTo(1.25, 2);
    const feeSum = rec.exit_legs!.reduce((s, l) => s + l.fee_usd, 0);
    expect(rec.total_fees_usd).toBeCloseTo(feeSum, 2);
    expect(rec.total_fees_usd).toBeCloseTo(3.75, 2);
  });

  it('leg sum consistency: pnl_realized === sum of exit_legs pnl_usd', () => {
    const pm = makePm(20_000, 19_990, 20_010, 20_020, 3);
    pm.applyPt1Exit(1, 20_010, NOW, 0.75, 0.25, CFG);
    pm.applyPt2Exit(1, 20_018, NOW, 0.75, 0.25, CFG);
    const rec = closeAt(pm, 20_025, 'target_3', 0.75);

    const legSum = rec.exit_legs!.reduce((s, l) => s + l.pnl_usd, 0);
    expect(rec.pnl_realized).toBeCloseTo(legSum, 2);
  });
});
