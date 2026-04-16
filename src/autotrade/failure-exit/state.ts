// ─── Failure-Exit State Vector ──────────────────────────────────────────────
//
// Pure math layer for the Dead-Trade Guard pre-PT1 failure-to-launch exit.
// All times in MINUTES, all rates in R/MIN. No side effects, no I/O.
//
// See: .claude/plans/fluttering-weaving-pinwheel.md ("Mathematical Framing")
//
// Derived features (per evaluation cycle, pre-PT1 only):
//   givebackR    = peakR − currentR
//   progressRate = peakR / (t + ε)              [R/min]
//   drawdownRate = maeR  / (t + ε)              [R/min]
//   failureRatio = (maeR + ε) / (peakR + ε)
//   netProgress  = currentR − λ · maeR
//   efficiency   = peakR / (maeR + ε)
//   recoveryGap  = peakR − currentR   (alias of givebackR, kept for clarity)
//   decayRate    = (peakR − currentR) / (t − tPeak)   [R/min]
//     GATED: returns 0 when (t − tPeak) < decayMinGapMinutes, or when
//            tPeakMinutes is null. Prevents instability right after a
//            new peak update.
// ────────────────────────────────────────────────────────────────────────────

import type { Position } from '../types.js';

const EPSILON = 1e-6;

export interface FailureExitState {
  /** Minutes since entry (fractional). */
  tMin: number;
  /** Current unrealized R based on initial risk. */
  currentR: number;
  /** Peak unrealized R before any partial, monotone non-decreasing. */
  peakR: number;
  /** Max adverse excursion expressed in R. */
  maeR: number;
  /** peakR − currentR; how much of the peak has been given back. */
  givebackR: number;
  /** R per minute averaged over the full hold (peakR / tMin). */
  progressRate: number;
  /** Adverse R per minute averaged over the full hold (maeR / tMin). */
  drawdownRate: number;
  /** (maeR + ε) / (peakR + ε); pain vs progress ratio. */
  failureRatio: number;
  /** currentR − λ · maeR; penalized net progress. */
  netProgress: number;
  /** peakR / (maeR + ε); favorable per adverse. */
  efficiency: number;
  /** Alias of givebackR. */
  recoveryGap: number;
  /**
   * R per minute since the most recent peak update. 0 when:
   *   - tPeakMin is null (no peak observed yet)
   *   - (tMin − tPeakMin) < decayMinGapMinutes (gating)
   *   - peakR ≤ 0 (no meaningful peak)
   */
  decayRate: number;
  /** Minutes since entry at the most recent peak update, or null. */
  tPeakMin: number | null;
}

/**
 * Compute the full failure-exit state vector from a Position.
 *
 * This function is PURE:
 *   - no side effects on Position
 *   - no access to Date.now() except via the `nowUnixMs` parameter
 *   - no config lookups except via the `lambdaNet` / `decayMinGapMinutes` params
 *
 * Every config knob the math layer depends on is surfaced as an explicit
 * parameter so the function hides no constants and its signature maps 1:1
 * to fields on ResolvedManagementParams.
 *
 * @param pos                  Position being evaluated (pre-PT1)
 * @param favorableMovePts     Signed favorable move (long: price − entry; short: entry − price), in points
 * @param nowUnixMs            Current wall-clock time in ms (Date.now() at call site)
 * @param lambdaNet            λ for netProgress = currentR − λ · maeR
 * @param decayMinGapMinutes   τ_decay: decayRate is 0 until (tMin − tPeakMin) ≥ this
 */
export function computeFailureExitState(
  pos: Position,
  favorableMovePts: number,
  nowUnixMs: number,
  lambdaNet: number,
  decayMinGapMinutes: number,
): FailureExitState {
  // Single conversion point: ms → minutes. No other call site divides by 60_000.
  const tMin = Math.max(0, (nowUnixMs - pos.entry_time_unix) / 60_000);

  const initialRiskPts = Math.abs(pos.entry_price - pos.stop_initial);
  const currentR = initialRiskPts > 0 ? favorableMovePts / initialRiskPts : 0;
  const peakR = pos.peak_r_before_first_partial ?? 0;
  const maeR = initialRiskPts > 0 ? pos.max_adverse_excursion / initialRiskPts : 0;

  const givebackR = peakR - currentR;
  const recoveryGap = givebackR;

  const progressRate = peakR / (tMin + EPSILON);
  const drawdownRate = maeR / (tMin + EPSILON);
  const failureRatio = (maeR + EPSILON) / (peakR + EPSILON);
  const netProgress = currentR - lambdaNet * maeR;
  const efficiency = peakR / (maeR + EPSILON);

  const tPeakMin = pos.t_peak_r_minutes;

  let decayRate = 0;
  if (tPeakMin !== null && peakR > 0) {
    const gap = tMin - tPeakMin;
    if (gap >= decayMinGapMinutes) {
      decayRate = (peakR - currentR) / gap;
    }
  }

  return {
    tMin,
    currentR,
    peakR,
    maeR,
    givebackR,
    progressRate,
    drawdownRate,
    failureRatio,
    netProgress,
    efficiency,
    recoveryGap,
    decayRate,
    tPeakMin,
  };
}
