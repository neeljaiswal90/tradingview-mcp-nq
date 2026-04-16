/**
 * Shared exit-labeling helper — one canonical function for both live and replay paths.
 *
 * Granular stop labels:
 *   stop_loss_initial   → stop hit before any T1 partial (initial stop never moved)
 *   stop_loss_breakeven → stop hit after T1 partial, trailing NOT yet armed
 *   stop_loss_trailing  → stop hit after T1 partial, trailing WAS armed
 *
 * All non-stop reasons pass through unchanged.
 */

import type { ExitReason } from './types.js';

/**
 * Derive `exit_reason_detailed` from the coarse exit reason and position state.
 *
 * Used in both live position-manager close and historical replay.
 * Pure function with no side effects.
 */
export function computeExitReasonDetailed(
  reason: ExitReason,
  partialExitDone: boolean,
  trailingActive: boolean,
): ExitReason {
  if (reason === 'stop_loss') {
    if (!partialExitDone) return 'stop_loss_initial';
    return trailingActive ? 'stop_loss_trailing' : 'stop_loss_breakeven';
  }
  return reason;
}

/**
 * Derive `stopped_out` from the detailed exit reason.
 * True for any stop-loss variant (initial, breakeven, trailing, or coarse).
 */
export function isStoppedOut(detailedReason: ExitReason): boolean {
  return detailedReason === 'stop_loss'
    || detailedReason === 'stop_loss_initial'
    || detailedReason === 'stop_loss_breakeven'
    || detailedReason === 'stop_loss_trailing';
}
