/**
 * management/scalper-features.ts — Phase 6 exit feature types for the
 * lob_mbo_scalp strategy family.
 *
 * The scalper has its OWN exit feature vector, distinct from
 * `management/types.ts::ManagementFeatures`, because the trend-side
 * management features carry no LOB surface (see plan Phase 6 §
 * "ManagementFeatures has zero LOB surface, ManagementDecisionEngine is
 * monolithic"). Extending the trend struct would force polymorphism
 * downstream and risk silent contamination of trend management.
 *
 * Design invariants (per plan Phase 6):
 *
 *   1. PARALLEL, NOT EXTENDING. Nothing in this file is imported by
 *      `management/types.ts` or the trend `ManagementDecisionEngine`.
 *      The scalper exit path is fully isolated — the runner dispatches
 *      to `ScalperExitEngine` for any position whose setup family is
 *      `lob_mbo_scalp`.
 *
 *   2. POSITION-SIDE + LOB-SIDE. Feature construction mixes
 *      position-state fields (hold_ms, current_ticks_pnl, entry_direction,
 *      scalper_extended_cap, frozen stop/target in ticks) with a fresh
 *      LOB snapshot (microprice_edge, qi_5, zOFI_250ms/1s/3s, sigma_1s,
 *      spread_ticks). Both are required at every exit tick so the
 *      engine can compare the current microstructure to the entry
 *      microstructure without keeping a sidecar state machine.
 *
 *   3. ENTRY-SIGN CONVENTION. The scalper generator captures entry-time
 *      `microprice_edge` / `qi_5` / `zOfi250ms` / `zOfi1s` and freezes
 *      their signs on the `ScalperExitFeatures` so the reversal rule
 *      can count "sign flips" without re-reading the entry signal.
 *      Exit tick values are compared against these frozen signs.
 *
 *   4. DECISION-TIME-SAFE INPUTS ONLY. Every field is observable at the
 *      moment of the exit evaluation — no forward returns, no realized
 *      MFE/MAE that would contaminate training.
 *
 *   5. STABLE REASON VOCABULARY. `ScalperExitDecision.exit_reason_enum`
 *      uses the family-specific reasons added to `types.ts::ExitReason`
 *      in Phase 3a: `scalper_hard_cap`, `scalper_no_progress`,
 *      `scalper_reversal`, `microstructure_edge_decay`. Plus the
 *      already-standard `stop_loss` and `target_hit` enums for
 *      microstructure-stop and target-hit exits.
 */

import type { ScalperDirection } from '../features/scalper-state.js';
import type { ExitReason } from '../types.js';

// ─── Feature vector ────────────────────────────────────────────────────────

/**
 * Exit-time feature vector for one open scalper position. Constructed
 * on every scalper exit tick by `scalper-feature-builder.ts` from the
 * combination of the Position and a fresh LobSnapshot.
 *
 * All microstructure fields carry the CURRENT LOB state. The
 * `entry_*_sign` fields are the FROZEN entry-time signs used by the
 * reversal rule — never mutated after fill.
 */
export interface ScalperExitFeatures {
  // ── Position identity / timing ─────────────────────────────────
  /** Setup direction (long or short) — read from Position at fill. */
  entry_direction: ScalperDirection;
  /** Milliseconds since entry (derived from Position.entry_time_unix). */
  hold_ms: number;
  /** Signed tick P&L from entry price to the current mid. Positive = favorable. */
  current_ticks_pnl: number;

  // ── Frozen entry-time stop/target distances in ticks ───────────
  /** Entry-time microstructure stop distance in ticks (positive number). */
  stop_ticks: number;
  /** Entry-time microstructure target distance in ticks (positive number). */
  target_ticks: number;

  // ── Effective hard cap (chosen at entry from scalper_extended_cap) ──
  /** Applied hard cap in seconds: `time_stop_seconds` when extended, else `scalper_hard_cap_seconds`. */
  effective_hard_cap_sec: number;
  /** The no-progress trigger from the management profile (ms). */
  no_progress_trigger_ms: number;

  // ── Current LOB microstructure (from fresh LobSnapshot) ────────
  microprice_edge_ticks: number | null;
  qi_5: number | null;
  z_ofi_250ms: number | null;
  z_ofi_1s: number | null;
  z_ofi_3s: number | null;
  sigma_1s_ticks: number | null;
  spread_ticks: number | null;

  /** Same-side absorption ratio (bid for long, ask for short). May be null during warmup. */
  abs_same_side: number | null;
  /** Same-side hazard (bid for long, ask for short). */
  hazard_same_side: number | null;
  /** Opposite-side hazard (ask for long, bid for short). */
  hazard_opp_side: number | null;

  // ── Frozen entry-time signs for reversal detection ─────────────
  /** +1 for positive, -1 for negative, 0 when entry value was 0 or null (neutral — never flips). */
  entry_microprice_edge_sign: -1 | 0 | 1;
  entry_qi5_sign: -1 | 0 | 1;
  entry_z_ofi_250ms_sign: -1 | 0 | 1;
  entry_z_ofi_1s_sign: -1 | 0 | 1;
  /** Entry spread in ticks (frozen). Used by the "spread widens >1 tick" reversal signal. */
  entry_spread_ticks: number | null;
  /** Frozen entry-time absorption ratio for the "absorption flip" reversal signal. */
  entry_abs_same_side: number | null;
  /** Entry-time hazard diff (opp - same) for reversal detection. */
  entry_hazard_diff: number | null;
}

// ─── Decision result ───────────────────────────────────────────────────────

/**
 * Outcome of one `ScalperExitEngine.evaluate(...)` call.
 *
 * `state === 'HOLD'` means the position stays open and the engine will
 * be re-evaluated on the next scalper monitor tick. `state === 'EXIT_NOW'`
 * means the engine has selected an exit; the caller (runner) dispatches
 * the flatten order under the single-flight exit guard.
 *
 * No intermediate states (no MOVE_STOP, no REDUCE, no SCALE) — scalps
 * are atomic. The frozen `scalper_stop_ticks` and `scalper_target_ticks`
 * never move after fill.
 *
 * `reason` is a short free-form string for the log trail;
 * `exit_reason_enum` is the stable enum the trade record writes into
 * its `exit_reason` column. Callers log BOTH so dashboards bucket on
 * the enum and operators read the free-form summary.
 *
 * `factors` is an append-only object of every signal that contributed
 * to the decision (current_ticks_pnl, which reversal signals fired,
 * which thresholds the hold_ms cleared). Dashboards read this to show
 * why a scalper exited without re-deriving anything.
 */
export interface ScalperExitDecision {
  state: 'HOLD' | 'EXIT_NOW';
  reason: string | null;
  exit_reason_enum: ExitReason | null;
  factors: Record<string, unknown>;
}

/** Convenience helper: build a HOLD decision with structured factors. */
export function scalperHold(factors: Record<string, unknown> = {}): ScalperExitDecision {
  return { state: 'HOLD', reason: null, exit_reason_enum: null, factors };
}

/** Convenience helper: build an EXIT_NOW decision with reason + enum + factors. */
export function scalperExitNow(
  reason: string,
  enumVal: ExitReason,
  factors: Record<string, unknown>,
): ScalperExitDecision {
  return { state: 'EXIT_NOW', reason, exit_reason_enum: enumVal, factors };
}
