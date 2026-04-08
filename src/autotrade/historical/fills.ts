/**
 * OHLC-only fill model for historical backtests.
 *
 * Because we do not have intrabar tick data, any fill decision that depends
 * on the intrabar path is an ASSUMPTION. This module makes those assumptions
 * explicit, configurable, and loggable.
 *
 * Supported entry models:
 *   - next_bar_open  (default, conservative): fill at the OPEN of the bar
 *     that FOLLOWS the signal bar.
 *   - signal_close  (aggressive): fill at the CLOSE of the signal bar. The
 *     signal must genuinely have been known at bar close (no future leak).
 *
 * Supported exit checks per subsequent bar:
 *   - stop_hit if bar.low <= stop (long) / bar.high >= stop (short)
 *   - target_hit if bar.high >= target (long) / bar.low <= target (short)
 *   - AMBIGUOUS if both stop and target were touched in the same bar
 *
 * Same-bar ambiguity resolution (configurable):
 *   - "conservative" (default) → assume the STOP was hit first
 *   - "optimistic"             → assume the TARGET was hit first
 *   - "skip"                   → skip the bar entirely and log
 *
 * Slippage: applied in TICKS, subtracted from favor on entry/exit fill.
 */

import type { ContractSpec } from '../contracts.js';
import { roundToTick } from '../contracts.js';

export type EntryFillModel = 'next_bar_open' | 'signal_close';
export type AmbiguityPolicy = 'conservative' | 'optimistic' | 'skip';

export interface FillConfig {
  entry_model: EntryFillModel;
  slippage_ticks: number;
  ambiguity_policy: AmbiguityPolicy;
}

export const DEFAULT_FILL_CONFIG: FillConfig = {
  entry_model: 'next_bar_open',
  slippage_ticks: 1,
  ambiguity_policy: 'conservative',
};

export interface BarForFill {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ─── Entry fills ─────────────────────────────────────────────────────────────

export interface EntryFillResult {
  fill_price: number;
  fill_timestamp: number;
  slippage_pts: number;
  model: EntryFillModel;
}

export function computeEntryFill(
  direction: 'long' | 'short',
  signalBar: BarForFill,
  nextBar: BarForFill | null,
  contract: ContractSpec,
  cfg: FillConfig,
): EntryFillResult | null {
  const slipPts = cfg.slippage_ticks * contract.tick_size;
  if (cfg.entry_model === 'signal_close') {
    const raw = direction === 'long' ? signalBar.close + slipPts : signalBar.close - slipPts;
    return {
      fill_price: roundToTick(raw, contract),
      fill_timestamp: signalBar.timestamp,
      slippage_pts: slipPts,
      model: 'signal_close',
    };
  }
  // next_bar_open
  if (!nextBar) return null;
  const raw = direction === 'long' ? nextBar.open + slipPts : nextBar.open - slipPts;
  return {
    fill_price: roundToTick(raw, contract),
    fill_timestamp: nextBar.timestamp,
    slippage_pts: slipPts,
    model: 'next_bar_open',
  };
}

// ─── Exit fills ──────────────────────────────────────────────────────────────

export type ExitTrigger = 'stop' | 'target_1' | 'target_2' | 'target_3' | 'ambiguous_skipped';

export interface BarExitCheck {
  trigger: ExitTrigger | null;
  planned_exit_price: number;
  actual_fill_price: number;
  ambiguous: boolean;
  notes: string;
}

/**
 * Check whether the given bar triggers a stop or any target (T1/T2/T3).
 * Returns the FIRST trigger encountered per the ambiguity policy.
 *
 * Caller is responsible for ordering targets logically (T1 nearest, T3 farthest).
 * We only report ONE trigger per bar. The runner loops bar-by-bar until exit.
 */
export function checkBarForExit(
  bar: BarForFill,
  direction: 'long' | 'short',
  stop: number,
  targets: { t1: number; t2: number; t3: number | null },
  contract: ContractSpec,
  cfg: FillConfig,
  /**
   * When true, the T1 partial has already been taken. T1 must NOT retrigger
   * a full exit — only T2/T3/stop may close the remainder. This fixes a
   * replay-loop bug where the bar after a T1 partial retriggered T1 and
   * closed the entire trade prematurely.
   */
  partialExitDone: boolean = false,
): BarExitCheck {
  const slipPts = cfg.slippage_ticks * contract.tick_size;
  const isLong = direction === 'long';

  const stopHit = isLong ? bar.low <= stop : bar.high >= stop;
  const t1Hit = !partialExitDone && (isLong ? bar.high >= targets.t1 : bar.low <= targets.t1);
  const t2Hit = isLong ? bar.high >= targets.t2 : bar.low <= targets.t2;
  const t3Hit = targets.t3 !== null
    ? (isLong ? bar.high >= targets.t3 : bar.low <= targets.t3)
    : false;

  // Pick the nearest target that was touched
  let targetTrigger: ExitTrigger | null = null;
  let plannedTargetPrice = 0;
  if (t1Hit) { targetTrigger = 'target_1'; plannedTargetPrice = targets.t1; }
  else if (t2Hit) { targetTrigger = 'target_2'; plannedTargetPrice = targets.t2; }
  else if (t3Hit && targets.t3 !== null) { targetTrigger = 'target_3'; plannedTargetPrice = targets.t3; }

  const ambiguous = stopHit && targetTrigger !== null;

  if (ambiguous) {
    if (cfg.ambiguity_policy === 'skip') {
      return { trigger: 'ambiguous_skipped', planned_exit_price: 0, actual_fill_price: 0, ambiguous: true, notes: 'skipped_bar_both_touched' };
    }
    if (cfg.ambiguity_policy === 'optimistic') {
      const raw = isLong ? plannedTargetPrice - slipPts : plannedTargetPrice + slipPts;
      return {
        trigger: targetTrigger!, planned_exit_price: plannedTargetPrice,
        actual_fill_price: roundToTick(raw, contract),
        ambiguous: true, notes: 'optimistic_target_first',
      };
    }
    // conservative (default): assume stop first
    const raw = isLong ? stop - slipPts : stop + slipPts;
    return {
      trigger: 'stop', planned_exit_price: stop,
      actual_fill_price: roundToTick(raw, contract),
      ambiguous: true, notes: 'conservative_stop_first',
    };
  }

  if (stopHit) {
    const raw = isLong ? stop - slipPts : stop + slipPts;
    return {
      trigger: 'stop', planned_exit_price: stop,
      actual_fill_price: roundToTick(raw, contract),
      ambiguous: false, notes: '',
    };
  }
  if (targetTrigger) {
    const raw = isLong ? plannedTargetPrice - slipPts : plannedTargetPrice + slipPts;
    return {
      trigger: targetTrigger, planned_exit_price: plannedTargetPrice,
      actual_fill_price: roundToTick(raw, contract),
      ambiguous: false, notes: '',
    };
  }
  return { trigger: null, planned_exit_price: 0, actual_fill_price: 0, ambiguous: false, notes: '' };
}
