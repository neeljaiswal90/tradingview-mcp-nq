/**
 * features/quant-shadow-decision.ts — Phase 7 shadow-decision telemetry.
 *
 * Produces a structured record of every Phase 7 gate's verdict on a
 * given candidate. Written onto `CandidateSetup.quant_shadow_decision`
 * and threaded through the signal dataset for Stage A shadow analysis.
 *
 * Rules (plan §1 / §5 Phase 7):
 *   - Stage A (hybrid_gate = false): this module produces a decision
 *     object but the runner DOES NOT act on `combined_verdict`. Every
 *     candidate still executes on its legacy verdict alone.
 *   - Stage B (hybrid_gate = true): the runner reads `combined_verdict`.
 *     Only `'pass'` lets execution proceed; any other verdict sets
 *     `signal.no_trade = true` and appends the reject code to
 *     `signal.reason_for_skip`. Legacy `stop` / `target_*` / `rr_*` /
 *     `confidence` are never touched — plan §3 no-overwrite rule.
 *   - Stage C (quant_primary_mode): NOT read by Phase 7 code. Reserved.
 *
 * entry_ml interaction (plan §1 Decision 3):
 *   - Stage A: entry_ml runs unchanged against the legacy pipeline;
 *     the quant expectancy gate does not touch it. This module simply
 *     MIRRORS the entry_ml verdict into the decision object for
 *     telemetry — it does not re-run entry_ml.
 *   - Stage B: both gates must agree (AND). Rejection reasons are
 *     separable: `rejected_by_expectancy` / `rejected_by_entry_ml` /
 *     `rejected_by_both`.
 *   - Stage C: Phase 8 decides whether entry_ml stays.
 */

import type { CandidateSetup } from '../types.js';
import type { QuantEntryConfig } from './quant-entry-config.js';

// ── No-data reason codes ──────────────────────────────────────────────────
//
// When the expectancy verdict is 'no_data', these codes explain WHY the
// engine had no data. This is failure telemetry — non-negotiable for
// Stage A debugging. Without specific codes, every row just says
// "no_data" with no indication of what to fix.

export type ExpectancyNoDataReason =
  | 'missing_bucket_table'
  | 'cold_start_only'
  | 'insufficient_bucket_samples'
  | 'orderflow_warmup_incomplete'
  | 'missing_lob_snapshot'
  | 'missing_required_entry_state_field'
  | null;

/**
 * Context the runner threads into the shadow decision builder so the
 * expectancy verdict can produce a specific no_data reason code
 * instead of a blank null.
 */
export interface ExpectancyNoDataContext {
  /** True when the runner loaded a bucket table at startup. */
  bucket_table_loaded: boolean;
  /** True when the orderflow z-score buffer has reached warmup. */
  orderflow_buffer_ready: boolean;
  /** Current sample count of the orderflow history buffer. */
  orderflow_buffer_sample_count: number;
}

// ── Shadow decision types ─────────────────────────────────────────────────

/** Verdict shape shared by every individual gate. */
export interface ShadowGateVerdict {
  /**
   * 'pass'       — gate approves this candidate
   * 'reject'     — gate actively rejects this candidate
   * 'no_data'    — gate couldn't decide (e.g. expectancy engine missing table)
   * 'disabled'   — gate is disabled in config
   */
  verdict: 'pass' | 'reject' | 'no_data' | 'disabled';
  /** Non-null when verdict != 'pass'. Human-readable rejection code. */
  reason: string | null;
}

/** Combined AND-gate verdict for Stage B. */
export type CombinedVerdict =
  | 'pass'
  | 'rejected_by_expectancy'
  | 'rejected_by_entry_ml'
  | 'rejected_by_both'
  | 'rejected_by_missing_cost_config'
  | 'no_data';

export interface QuantShadowDecision {
  /** Snapshot of the flags that drove this decision. */
  flags: {
    enabled: boolean;
    hybrid_gate: boolean;
    long_enabled: boolean;
    short_enabled: boolean;
  };
  /** Direction this decision applies to. */
  direction: 'long' | 'short';
  /** Reproducible hash of the state vector that fed the decision. */
  entry_state_vector_hash: string | null;

  // ── Per-gate verdicts ─────────────────────────────────────────────
  expectancy: ShadowGateVerdict;
  entry_ml: ShadowGateVerdict;

  /** AND-gate result. Runner consults this when hybrid_gate is on. */
  combined_verdict: CombinedVerdict;
  /** Telemetry copy of the reject code that goes into reason_for_skip. */
  combined_reason: string | null;
  /**
   * Whether this decision would actually gate execution. False in
   * Stage A (telemetry-only), true in Stage B. Used by the dataset
   * exporter to distinguish observations from enforcement.
   */
  gate_active: boolean;
}

// ── Expectancy verdict extraction ─────────────────────────────────────────

/**
 * Derive the expectancy gate verdict from the fields Phase 6 has
 * already populated on the setup. Does NOT re-run the engine — it
 * just reads `expected_r_30s_quant`, `bucket_source_quant`, and
 * `quant_shadow_reject_reason` to build a ShadowGateVerdict.
 *
 * Phase 8 operationalization (plan §11 + user-locked boundaries):
 *   - Missing cost config takes priority (fail-closed, configuration bug).
 *   - Null expected_r → `no_data`, NEVER a rejection. The plan is
 *     explicit: "no helpful fallback that silently turns missing
 *     bucket tables into live gate behavior." Bucket-table absence
 *     must show up as missing data in telemetry, not as a silent
 *     reject that masquerades as a gate decision.
 *   - Side-prior tier + post-cost expectancy below
 *     `side_prior_min_expected_r` → `rejected_by_bucket_sparsity`
 *     (fed from the Phase 6 engine via `quant_shadow_reject_reason`).
 *   - Non-side-prior tier + post-cost expectancy below
 *     `min_expected_r_primary` → NEW Phase 8 reject code
 *     `rejected_by_expectancy_below_threshold`. This is the active
 *     gate the plan calls out for Stage B promotion. Default config
 *     value is 0.0 so Stage A stays neutral — Phase 8 operators
 *     calibrate the real value from shadow data before flipping
 *     `hybrid_gate = true`.
 *   - Otherwise → pass.
 */
export function deriveExpectancyVerdict(
  setup: CandidateSetup,
  quantConfig: QuantEntryConfig,
  noDataCtx?: ExpectancyNoDataContext | null,
): ShadowGateVerdict {
  // `quant_shadow_reject_reason` is the single source of truth for
  // engine-level rejections — populated by features/expectancy-engine.ts
  // `lookupExpectancy` via `attachQuantExpectancy`. This function just
  // reads it and converts to the ShadowGateVerdict shape.
  void quantConfig; // reserved for future per-config overrides

  // Missing cost config overrides everything — plan §3.1 fail-closed.
  if (setup.quant_shadow_reject_reason === 'rejected_by_missing_cost_config') {
    return { verdict: 'reject', reason: 'rejected_by_missing_cost_config' };
  }

  // No bucket table / no expectancy at all → no_data, NOT a rejection.
  // Plan: "no helpful fallback that silently turns missing bucket
  // tables into live gate behavior." Bucket-table absence must show
  // up as missing data in telemetry, not as a silent reject.
  //
  // Phase 8 enhancement: produce a SPECIFIC reason code so operators
  // can diagnose why the engine had no data instead of seeing a blank
  // null on every row.
  if (setup.expected_r_30s_quant === null || setup.expected_r_30s_quant === undefined) {
    const reason = deriveNoDataReason(setup, noDataCtx ?? null);
    return { verdict: 'no_data', reason };
  }

  // Engine-level rejects — Phase 6 + Phase 8.
  if (setup.quant_shadow_reject_reason === 'rejected_by_bucket_sparsity') {
    return { verdict: 'reject', reason: 'rejected_by_bucket_sparsity' };
  }
  if (setup.quant_shadow_reject_reason === 'rejected_by_expectancy_below_threshold') {
    return { verdict: 'reject', reason: 'rejected_by_expectancy_below_threshold' };
  }

  return { verdict: 'pass', reason: null };
}

/**
 * Derive a specific no_data reason code from the candidate's state
 * and the runner-level context. The priority order reflects the
 * pipeline evaluation sequence: structural issues first, then data
 * availability, then quality.
 */
function deriveNoDataReason(
  setup: CandidateSetup,
  ctx: ExpectancyNoDataContext | null,
): ExpectancyNoDataReason {
  const esv = setup.entry_state_vector;

  // No entry state vector at all — can't do anything.
  if (!esv || esv.sigma_pts == null || !Number.isFinite(esv.sigma_pts) || esv.sigma_pts <= 0) {
    return 'missing_required_entry_state_field';
  }

  // LOB missing → orderflow and depth features are unavailable.
  if (esv.lob_state === 'missing') {
    return 'missing_lob_snapshot';
  }

  // No bucket table loaded at startup → cold_start is the only path.
  if (ctx && !ctx.bucket_table_loaded) {
    return 'missing_bucket_table';
  }

  // Bucket table loaded but candidate fell through to cold_start.
  if (setup.bucket_source_quant === 'cold_start') {
    return 'cold_start_only';
  }

  // OFI z-scores not warmed up yet.
  if (ctx && !ctx.orderflow_buffer_ready) {
    return 'orderflow_warmup_incomplete';
  }

  // Bucket table loaded and not cold_start, but still no expectancy.
  // This means every bucket at every fallback level had n < min_n.
  if (setup.bucket_source_quant === null || setup.bucket_source_quant === undefined) {
    return 'insufficient_bucket_samples';
  }

  return null;
}

/**
 * Build the entry_ml gate verdict. Phase 7 does NOT re-run the
 * entry_ml model — it mirrors whatever decision runner.ts already
 * computed (or "disabled" when `entry_ml.mode === 'off'`).
 *
 * Stage A: the mirror is telemetry-only (runner.ts still uses its
 * own entry_ml path to decide execution independently).
 * Stage B: the mirror is the same decision, combined with the
 * expectancy verdict via AND.
 */
export interface EntryMlVerdictSource {
  /** True when the entry_ml gate is fully disabled in config. */
  disabled: boolean;
  /** True when entry_ml ran and confirmed (or was advisory-only). */
  confirmed: boolean;
  /** True when entry_ml ran but failed to produce a decision. */
  no_data: boolean;
  /** entry_ml's own reason code when not confirmed. */
  reason: string | null;
}

export function deriveEntryMlVerdict(source: EntryMlVerdictSource): ShadowGateVerdict {
  if (source.disabled) return { verdict: 'disabled', reason: null };
  if (source.no_data) return { verdict: 'no_data', reason: null };
  if (source.confirmed) return { verdict: 'pass', reason: null };
  return { verdict: 'reject', reason: source.reason ?? 'entry_ml_rejected' };
}

// ── Combined AND-gate logic ───────────────────────────────────────────────

/**
 * Combine the expectancy + entry_ml verdicts into a single
 * `combined_verdict`. The combination rules honor plan §1 Decision 3
 * (Stage B AND-gate semantics) and distinguish the four diagnostic
 * cases the Phase 7 exit criterion calls out: expectancy-only,
 * entry_ml-only, both, or missing cost.
 *
 *   - `pass`                        — both gates approve (or one passes
 *                                     and the other is disabled/no_data
 *                                     — never block on missing data)
 *   - `rejected_by_expectancy`      — expectancy rejects, entry_ml OK
 *   - `rejected_by_entry_ml`        — entry_ml rejects, expectancy OK
 *   - `rejected_by_both`            — both gates reject
 *   - `rejected_by_missing_cost_config` — expectancy failed closed on cost
 *   - `no_data`                     — both gates returned no_data / disabled
 *
 * `rejected_by_missing_cost_config` takes priority over any other
 * reject code because it's a configuration bug, not a data bug — the
 * operator needs to fix it before any candidate can be evaluated.
 */
export function combineVerdicts(
  expectancy: ShadowGateVerdict,
  entryMl: ShadowGateVerdict,
): { verdict: CombinedVerdict; reason: string | null } {
  // Configuration bug takes priority.
  if (expectancy.reason === 'rejected_by_missing_cost_config') {
    return {
      verdict: 'rejected_by_missing_cost_config',
      reason: 'rejected_by_missing_cost_config',
    };
  }

  const expReject = expectancy.verdict === 'reject';
  const mlReject = entryMl.verdict === 'reject';

  if (expReject && mlReject) {
    return { verdict: 'rejected_by_both', reason: 'rejected_by_both' };
  }
  if (expReject) {
    return {
      verdict: 'rejected_by_expectancy',
      reason: expectancy.reason ?? 'rejected_by_expectancy',
    };
  }
  if (mlReject) {
    return {
      verdict: 'rejected_by_entry_ml',
      reason: entryMl.reason ?? 'rejected_by_entry_ml',
    };
  }

  // Both neutral (pass / disabled / no_data). If either gate
  // explicitly passed, treat the combined decision as pass — this
  // preserves the plan's guarantee that missing data never silently
  // rejects. If both gates said "no_data" AND "disabled" in some
  // combination, return no_data as a diagnostic.
  //
  // Phase 8: thread the expectancy reason through so no_data carries
  // the specific cause (e.g. 'missing_bucket_table', 'cold_start_only').
  const expOk = expectancy.verdict === 'pass';
  const mlOk = entryMl.verdict === 'pass';
  if (expOk || mlOk) return { verdict: 'pass', reason: null };
  return { verdict: 'no_data', reason: expectancy.reason ?? entryMl.reason ?? null };
}

// ── Top-level builder ─────────────────────────────────────────────────────

export interface BuildShadowDecisionInput {
  setup: CandidateSetup;
  direction: 'long' | 'short';
  quantConfig: QuantEntryConfig;
  entryMl: EntryMlVerdictSource;
  /** Runner-level context for specific no_data reason codes. */
  noDataContext?: ExpectancyNoDataContext | null;
}

/**
 * Build the Phase 7 shadow-decision telemetry object for a candidate.
 * Assumes `setup.entry_state_vector_hash` has already been populated
 * by the hydration step in strategy.ts.
 */
export function buildQuantShadowDecision(
  input: BuildShadowDecisionInput,
): QuantShadowDecision {
  const { setup, direction, quantConfig, entryMl, noDataContext } = input;
  const expectancy = deriveExpectancyVerdict(setup, quantConfig, noDataContext);
  const entryMlVerdict = deriveEntryMlVerdict(entryMl);
  const combined = combineVerdicts(expectancy, entryMlVerdict);

  return {
    flags: {
      enabled: quantConfig.enabled,
      hybrid_gate: quantConfig.hybrid_gate,
      long_enabled: quantConfig.long_enabled,
      short_enabled: quantConfig.short_enabled,
    },
    direction,
    entry_state_vector_hash: setup.entry_state_vector_hash ?? null,
    expectancy,
    entry_ml: entryMlVerdict,
    combined_verdict: combined.verdict,
    combined_reason: combined.reason,
    gate_active: quantConfig.enabled && quantConfig.hybrid_gate,
  };
}
