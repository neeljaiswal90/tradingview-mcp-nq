// ─── Dead-Trade Guard Decision Evaluator ───────────────────────────────────
//
// PURE decision function. Given a state vector, resolved management params,
// and an optional curve, return the ordered list of triggered lanes.
//
// This file has NO side effects and NO event emission. Latching, logging,
// and flattening are the position-manager's job. The boundary is strict:
//
//   state.ts       → math-layer  (pure, unit tests assert features)
//   evaluator.ts   → decision-layer (pure, unit tests assert triggered[])
//   position-manager.ts → event-layer (latches, emissions, flatten)
//
// Precedence: triggered is always sorted emergency → hard → soft, so
// triggered[0] is the highest-precedence entry and is what the caller should
// use for a LIVE flatten. Shadow mode should iterate the whole array.
//
// See: .claude/plans/fluttering-weaving-pinwheel.md
//   ("Design Summary", "V1 Rule", "Same-cycle precedence")
// ────────────────────────────────────────────────────────────────────────────

import type { ResolvedManagementParams } from '../types.js';
import type { FailureExitState } from './state.js';
import type { FailureExitCurves } from './curves.js';
import { queryCurve } from './curves.js';

export type FailureExitLane = 'soft' | 'hard' | 'emergency';

export interface FailureExitLaneTrigger {
  lane: FailureExitLane;
  reason: string;
  /** Interpolated Q20_peak_win(t) at evaluation time (Lane B only). */
  q20_peak?: number;
  /** Interpolated Q80_mae_win(t) at evaluation time (Lane B only). */
  q80_mae?: number;
}

export interface FailureExitDecision {
  /**
   * All lanes whose conditions are TRUE this cycle, sorted in DETERMINISTIC
   * precedence order: emergency → hard → soft. Empty array = nothing fired.
   *
   * Caller semantics:
   *   - LIVE mode: flatten on triggered[0] if it is 'hard' or 'emergency'.
   *     Soft never flattens even if it is triggered[0].
   *   - SHADOW mode: iterate all entries and record any unfired latches.
   *
   * This array does NOT respect per-trade latching — it reflects the pure
   * current-cycle decision. Latching is a position-manager concern.
   */
  triggered: FailureExitLaneTrigger[];
}

const PRECEDENCE: Record<FailureExitLane, number> = {
  emergency: 0,
  hard: 1,
  soft: 2,
};

/**
 * Pure decision function. Returns the list of lanes triggered this cycle.
 *
 * Returns { triggered: [] } immediately when the feature is disabled.
 *
 * @param state State vector from computeFailureExitState()
 * @param mgmt  Resolved management params (carries all thresholds)
 * @param curve Optional per-family curve for Lane B; null disables Lane B
 */
export function evaluateFailureExit(
  state: FailureExitState,
  mgmt: ResolvedManagementParams,
  curve: FailureExitCurves | null,
): FailureExitDecision {
  if (!mgmt.pre_t1_failure_exit_enabled) {
    return { triggered: [] };
  }

  const triggered: FailureExitLaneTrigger[] = [];

  // ── Lane A: soft review ─────────────────────────────────────────────
  // Fires when the trade is making slow progress and the adverse-to-peak
  // ratio is high. Logs only — never flattens, even live.
  if (
    state.tMin >= mgmt.pre_t1_failure_soft_min_minutes &&
    state.progressRate < mgmt.pre_t1_failure_soft_progress_rate_max &&
    state.failureRatio > mgmt.pre_t1_failure_soft_failure_ratio_min
  ) {
    triggered.push({
      lane: 'soft',
      reason:
        `lane_A_soft: progressRate=${state.progressRate.toFixed(3)}<` +
        `${mgmt.pre_t1_failure_soft_progress_rate_max} ` +
        `failureRatio=${state.failureRatio.toFixed(2)}>` +
        `${mgmt.pre_t1_failure_soft_failure_ratio_min}`,
    });
  }

  // ── Lane B: empirical quantile cut ──────────────────────────────────
  // Fires when the trade is behaving worse than the bottom ~20% of
  // eventual winners at the same hold time AND has made very little
  // current progress (dynamic cap = α · Q20_peak_win(t)).
  //
  // Degrades to no-op (no entry added) when:
  //   - no curve for this family
  //   - hold time before hard_min_minutes
  //   - bucket low-confidence (queryCurve returns null)
  if (state.tMin >= mgmt.pre_t1_failure_hard_min_minutes && curve !== null) {
    const q = queryCurve(curve, state.tMin);
    if (q !== null) {
      const alpha = mgmt.pre_t1_failure_hard_current_r_alpha;
      const currentRCap = alpha * q.q20_peak;
      if (
        state.peakR < q.q20_peak &&
        state.maeR > q.q80_mae &&
        state.currentR <= currentRCap
      ) {
        triggered.push({
          lane: 'hard',
          reason:
            `lane_B_hard: peakR=${state.peakR.toFixed(3)}<Q20=${q.q20_peak.toFixed(3)} ` +
            `maeR=${state.maeR.toFixed(3)}>Q80=${q.q80_mae.toFixed(3)} ` +
            `currentR=${state.currentR.toFixed(3)}<=α·Q20=${currentRCap.toFixed(3)}`,
          q20_peak: q.q20_peak,
          q80_mae: q.q80_mae,
        });
      }
    }
  }

  // ── Lane C: emergency shape cut ─────────────────────────────────────
  // Runs without curves. Requires a minimum adverse excursion floor to
  // prevent flat-chop false fires (failureRatio is unstable near zero).
  // Optional decayRate gate is only enforced when state.decayRate > 0 —
  // the state layer already returns 0 when (tMin − tPeakMin) < τ_decay.
  if (
    state.tMin >= mgmt.pre_t1_failure_emergency_min_minutes &&
    state.maeR >= mgmt.pre_t1_failure_emergency_mae_r_floor &&
    state.failureRatio >= mgmt.pre_t1_failure_emergency_failure_ratio_min &&
    state.peakR < mgmt.pre_t1_failure_emergency_peak_r_max
  ) {
    // Decay-rate gate: only enforced when we have a meaningful peak and
    // the state layer has actually computed a non-zero decay rate.
    // A zero decayRate means the gating window has not elapsed — in that
    // case the decay check is skipped (does not block the emergency lane).
    const decayGate =
      mgmt.pre_t1_failure_emergency_decay_rate_min <= 0 ||
      state.decayRate === 0 ||
      state.decayRate >= mgmt.pre_t1_failure_emergency_decay_rate_min;

    if (decayGate) {
      triggered.push({
        lane: 'emergency',
        reason:
          `lane_C_emergency: maeR=${state.maeR.toFixed(3)}>=floor=` +
          `${mgmt.pre_t1_failure_emergency_mae_r_floor} ` +
          `failureRatio=${state.failureRatio.toFixed(2)}>=` +
          `${mgmt.pre_t1_failure_emergency_failure_ratio_min} ` +
          `peakR=${state.peakR.toFixed(3)}<` +
          `${mgmt.pre_t1_failure_emergency_peak_r_max}`,
      });
    }
  }

  // Sort into deterministic precedence order.
  triggered.sort((a, b) => PRECEDENCE[a.lane] - PRECEDENCE[b.lane]);

  return { triggered };
}
