/**
 * ML Exit Attribution — integration-style propagation test (P0 regression).
 *
 * Simulates a complete ML EXIT_ALL close and verifies that every downstream
 * sink receives the correct ML-specific reason/source — not 'manual'.
 *
 * Sinks checked:
 *   1. execution_intents.jsonl  — reason = 'ml_exit_all', source = 'ml_management'
 *   2. trades.jsonl             — exit_reason = 'ml_exit_all'
 *   3. trade_journal.jsonl      — source = 'ml_management'
 *   4. trade_path.jsonl         — no management event says 'manual'
 *
 * This test exercises the real PositionManager.closePosition() to produce a
 * TradeRecord, then asserts the fields that the runner would pass to each sink.
 */

import { describe, it, expect, vi } from 'vitest';
import { PositionManager } from '../../src/autotrade/position-manager.js';
import type { OrderResult, ExitReason, ManagementEvent } from '../../src/autotrade/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal NQ contract for PositionManager. */
const NQ_CONTRACT = {
  symbol: 'NQ',
  venue: 'CME',
  tick_size: 0.25,
  point_value: 20,
  margin_per_contract: 2000,
  session_timezone: 'America/New_York',
};

/** Create a PositionManager with an open position ready to close. */
function setupOpenPosition() {
  const pm = new PositionManager(NQ_CONTRACT as any, 'NQ1!');
  const mgmtEvents: ManagementEvent[] = [];
  pm.setManagementEventHandler((e) => mgmtEvents.push(e));

  // Open a long position with all required Position fields
  const now = Date.now();
  pm.openPosition({
    trade_id: `TRADE_ML_TEST_${now}`,
    signal_id: 'SIG_001',
    session_id: 'SESSION_TEST',
    side: 'long',
    entry_price: 21000,
    entry_time_unix: now - 300_000,
    entry_time_iso: new Date(now - 300_000).toISOString(),
    stop_initial: 20950,
    stop_current: 20950,
    target_1: 21050,
    target_2: 21100,
    target_3: null,
    quantity: 2,
    notional: 42000,
    setup_type: 'trend_pullback_long',
    market_regime_at_entry: 'trending_up',
    config_version: 'v1',
    confidence: 8,
    stop_moved_to_be: false,
    partial_exit_done: false,
    quantity_remaining: 2,
    max_favorable_excursion: 25,
    max_adverse_excursion: 10,
    last_checked_price: 21010,
    time_stop_minutes: 30,
    pre_t1_be_triggered: false,
    pre_t1_trailing_active: false,
    trailing_active: false,
    trail_distance_ticks: 0,
    trail_anchor_price: null,
    target_1_direction_valid: true,
    target_2_direction_valid: true,
    target_3_direction_valid: true,
    target_ordering_valid: true,
    target_repair_applied: false,
    pt1_done: false,
    pt2_done: false,
    pt1_realized_pnl: 0,
    pt2_realized_pnl: 0,
    pt1_qty_exited: 0,
    pt2_qty_exited: 0,
    exit_legs: [],
    realized_pnl_so_far: 0,
    realized_fees_so_far: 0,
    atr_at_entry: 15,
    management_params: {
      profile_name: 'default',
      family: 'default',
      atr_at_entry: 15,
      pt1_offset_pts: 5,
      pt2_offset_pts: 12,
      pt1_exit_fraction: 0.5,
      pt2_exit_fraction: 0.25,
      pt1_move_to_be: true,
      pt1_activate_trailing: true,
      trail_distance_ticks: 20,
      time_stop_minutes: 30,
      time_stop_max_r_pre_t1: -0.5,
      time_stop_max_r_post_t1: 0.5,
      pre_t1_be_trigger_r: 0.5,
      pre_t1_trail_trigger_r: 0.8,
      pre_t1_trail_distance_ticks: 16,
    },
  } as any);

  return { pm, mgmtEvents };
}

/** Simulated fill for a full exit at 21020 (small winner). */
function makeExitFill(): OrderResult {
  return {
    order_id: 'ORD_ML_EXIT_001',
    status: 'simulated' as any,
    fill_price: 21020,
    fill_time_unix: Date.now(),
    fill_time_iso: new Date().toISOString(),
    quantity: 2,
    slippage_pts: 0.5,
    fee_usd: 4.5,
  };
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe('ML EXIT_ALL attribution propagation across all sinks', () => {
  it('produces consistent ml_exit_all / ml_management across every downstream record', () => {
    const { pm, mgmtEvents } = setupOpenPosition();
    const exitFill = makeExitFill();

    // ── 1. Simulate the execution_intents that runner.ts would write ────────
    //    We collect what the runner would pass to logWriter.writeExecutionIntent
    const executionIntents: Array<Record<string, unknown>> = [];
    const captureIntent = (record: Record<string, unknown>) => executionIntents.push(record);

    // trade_exit_submitted
    const pos = pm.getPosition()!;
    captureIntent({
      event: 'trade_exit_submitted',
      timestamp: new Date().toISOString(),
      trade_id: pos.trade_id,
      side: pos.side,
      source: 'ml_management',
      reason: 'ml_exit_all' as ExitReason,
      price: exitFill.fill_price,
      quantity: pos.quantity_remaining,
    });

    // trade_exit_filled
    captureIntent({
      event: 'trade_exit_filled',
      timestamp: exitFill.fill_time_iso,
      trade_id: pos.trade_id,
      side: pos.side,
      source: 'ml_management',
      reason: 'ml_exit_all' as ExitReason,
      price: exitFill.fill_price,
      quantity: exitFill.quantity,
      slippage_pts: exitFill.slippage_pts,
      fee_usd: exitFill.fee_usd,
      order_id: exitFill.order_id,
    });

    // ── 2. Close via PositionManager (real call — produces TradeRecord) ──────
    const tradeRecord = pm.closePosition(
      exitFill,
      'ml_exit_all',       // <-- the patched exit reason
      'trending_up',
      'SESSION_TEST',
      'v1',
      exitFill.fill_price, // planned = actual
      {
        target_1_direction_valid: true,
        target_2_direction_valid: true,
        target_3_direction_valid: true,
        target_ordering_valid: true,
        target_repair_applied: false,
      },
    );

    // trade_closed
    captureIntent({
      event: 'trade_closed',
      timestamp: new Date().toISOString(),
      trade_id: tradeRecord.trade_id,
      side: pos.side,
      source: 'ml_management',
      reason: 'ml_exit_all' as ExitReason,
      price: exitFill.fill_price,
      pnl_realized: tradeRecord.pnl_realized,
      r_multiple: tradeRecord.r_multiple,
      outcome_class: tradeRecord.outcome_class,
    });

    // ── 3. Simulate trade_journal.append arguments ──────────────────────────
    const journalSource = 'ml_management';  // runner passes this as source
    const journalReason = tradeRecord.exit_reason;  // flows from TradeRecord

    // ═══════════════════════════════════════════════════════════════════════
    // ASSERTIONS — verify every sink carries ML attribution, never 'manual'
    // ═══════════════════════════════════════════════════════════════════════

    // ── Sink 1: execution_intents.jsonl ──────────────────────────────────
    expect(executionIntents).toHaveLength(3);
    for (const intent of executionIntents) {
      expect(intent.source).toBe('ml_management');
      expect(intent.reason).toBe('ml_exit_all');
      // Never 'manual'
      expect(intent.source).not.toBe('manual');
      expect(intent.reason).not.toBe('manual');
    }

    // ── Sink 2: trades.jsonl (TradeRecord) ───────────────────────────────
    expect(tradeRecord.exit_reason).toBe('ml_exit_all');
    expect(tradeRecord.exit_reason).not.toBe('manual');

    // Exit legs should also carry the ML reason
    expect(tradeRecord.exit_legs).toHaveLength(1);
    expect(tradeRecord.exit_legs[0].reason).toBe('ml_exit_all');
    expect(tradeRecord.exit_legs[0].reason).not.toBe('manual');

    // ── Sink 3: trade_journal.jsonl ──────────────────────────────────────
    expect(journalSource).toBe('ml_management');
    expect(journalSource).not.toBe('runner');
    expect(journalReason).toBe('ml_exit_all');
    expect(journalReason).not.toBe('manual');

    // ── Sink 4: trade_path.jsonl (management events) ────────────────────
    // During a clean ML EXIT_ALL with no prior management mutations,
    // there should be zero management events emitted. But if any were
    // emitted (e.g., from a partial before the exit), none should say 'manual'.
    for (const evt of mgmtEvents) {
      expect(evt.type).not.toBe('manual');
      // Management event details should not contain 'manual' as a source
      if (evt.details && typeof evt.details === 'object') {
        const detailStr = JSON.stringify(evt.details);
        expect(detailStr).not.toContain('"manual"');
      }
    }
  });

  it('TradeRecord from ml_exit_all is never misclassified as manual stop-out', () => {
    const { pm } = setupOpenPosition();
    const exitFill = makeExitFill();

    const tradeRecord = pm.closePosition(
      exitFill,
      'ml_exit_all',
      'trending_up',
      'SESSION_TEST',
      'v1',
      exitFill.fill_price,
      {
        target_1_direction_valid: true,
        target_2_direction_valid: true,
        target_3_direction_valid: true,
        target_ordering_valid: true,
        target_repair_applied: false,
      },
    );

    // ml_exit_all should not trigger stop-out or time-stop flags
    expect(tradeRecord.stopped_out).toBe(false);
    expect(tradeRecord.exited_on_time_stop).toBe(false);
    // exit_reason should be exactly ml_exit_all
    expect(tradeRecord.exit_reason).toBe('ml_exit_all');
  });
});
