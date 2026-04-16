/**
 * features/quant-graduation-gates.ts — Phase 8 Stage A → B graduation gate
 * evaluator.
 *
 * Pure function that takes a contiguous shadow window of labeled signal
 * rows and returns the five Stage A → B gates from the plan §1 Decision
 * 4, along with a pass/fail summary artifact. The evaluator is
 * deliberately side-effect-free so tests and CLIs can both exercise it.
 *
 * Row eligibility (Phase 1 fix):
 *   Not every signal row belongs in the Stage A evaluation universe.
 *   Rows emitted before quant activation, rows without ESV, and rows
 *   from non-trend-pullback strategies are INELIGIBLE — they must be
 *   classified and counted separately, not treated as "invalid shadow
 *   vectors". The `classifyRowEligibility` function enforces this.
 *
 * Gates (plan §1 Decision 4):
 *   1. Post-cost expectancy MAE vs realized R < 0.15 across ≥200 shadow signals
 *   2. Short-side shadow signal count ≥ 30% of long-side count
 *   3. Zero NaN / ±∞ / required-null failures across every emitted
 *      EntryStateVector in the eligible shadow window
 *   4. ≥50% of shadow-executed candidates land in buckets with `n ≥ 30`
 *      (side-prior fallbacks count against this)
 *   5. Data-quality envelope from §4.5 within pre-committed limits
 *      recorded in the promotion PR
 */

// ── Gate status ──────────────────────────────────────────────────────────

export type GateStatus = 'pass' | 'fail' | 'not_measurable';

// ── Row eligibility ──────────────────────────────────────────────────────

export type IneligibilityReason =
  | 'missing_candidate_setup'
  | 'non_trend_pullback_strategy'
  | 'missing_direction'
  | 'missing_entry_state_vector'
  | 'missing_quant_shadow_decision'
  | 'pre_quant_activation';

export interface RowEligibility {
  eligible: boolean;
  eligible_for_gate_1: boolean;
  eligible_for_gate_2: boolean;
  eligible_for_gate_3: boolean;
  eligible_for_gate_4: boolean;
  reasons: IneligibilityReason[];
  /**
   * Classification for reporting. Ineligible rows get a bucket that
   * explains WHY they're excluded so operators don't confuse them with
   * actual shadow failures.
   */
  classification:
    | 'eligible_shadow'
    | 'out_of_scope_pre_quant'
    | 'out_of_scope_legacy_only'
    | 'out_of_scope_non_trend_pullback'
    | 'out_of_scope_missing_setup';
}

/**
 * Classify whether a raw signal row belongs in the Stage A evaluation
 * universe. This is the single source of truth for eligibility.
 */
export function classifyRowEligibility(row: RawSignalRow): RowEligibility {
  const reasons: IneligibilityReason[] = [];

  if (!row.has_candidate_setup) {
    reasons.push('missing_candidate_setup');
    return {
      eligible: false,
      eligible_for_gate_1: false,
      eligible_for_gate_2: false,
      eligible_for_gate_3: false,
      eligible_for_gate_4: false,
      reasons,
      classification: 'out_of_scope_missing_setup',
    };
  }

  if (!row.is_trend_pullback) {
    reasons.push('non_trend_pullback_strategy');
    return {
      eligible: false,
      eligible_for_gate_1: false,
      eligible_for_gate_2: false,
      eligible_for_gate_3: false,
      eligible_for_gate_4: false,
      reasons,
      classification: 'out_of_scope_non_trend_pullback',
    };
  }

  if (row.direction !== 'long' && row.direction !== 'short') {
    reasons.push('missing_direction');
  }

  if (!row.has_entry_state_vector) {
    reasons.push('missing_entry_state_vector');
  }

  if (!row.has_quant_shadow_decision) {
    reasons.push('missing_quant_shadow_decision');
  }

  // A row without ESV or shadow decision is pre-quant or legacy-only.
  // It should NOT be counted as an "invalid" shadow row.
  if (!row.has_entry_state_vector && !row.has_quant_shadow_decision) {
    return {
      eligible: false,
      eligible_for_gate_1: false,
      eligible_for_gate_2: false,
      eligible_for_gate_3: false,
      eligible_for_gate_4: false,
      reasons,
      classification: row.has_quant_fields ? 'out_of_scope_legacy_only' : 'out_of_scope_pre_quant',
    };
  }

  // Has ESV but no shadow decision → partial quant wiring, still legacy.
  if (!row.has_quant_shadow_decision) {
    return {
      eligible: false,
      eligible_for_gate_1: false,
      eligible_for_gate_2: false,
      eligible_for_gate_3: false,
      eligible_for_gate_4: false,
      reasons,
      classification: 'out_of_scope_legacy_only',
    };
  }

  if (reasons.length > 0) {
    return {
      eligible: false,
      eligible_for_gate_1: false,
      eligible_for_gate_2: false,
      eligible_for_gate_3: false,
      eligible_for_gate_4: false,
      reasons,
      classification: 'out_of_scope_pre_quant',
    };
  }

  return {
    eligible: true,
    eligible_for_gate_1: true,
    eligible_for_gate_2: true,
    eligible_for_gate_3: true,
    eligible_for_gate_4: true,
    reasons: [],
    classification: 'eligible_shadow',
  };
}

// ── Input types ───────────────────────────────────────────────────────────

/**
 * Raw signal row fields the eligibility classifier needs. The CLI adapter
 * extracts these from the full signal JSON before classification.
 */
export interface RawSignalRow {
  has_candidate_setup: boolean;
  is_trend_pullback: boolean;
  direction: string | null;
  has_entry_state_vector: boolean;
  has_quant_shadow_decision: boolean;
  /** True if any quant-specific field (stop_quant, risk_pts_quant, etc.) is non-null. */
  has_quant_fields: boolean;
}

/**
 * The subset of signal-row fields the graduation evaluator cares about,
 * AFTER eligibility classification. Only eligible rows reach the gates.
 */
export interface GraduationShadowRow {
  direction: 'long' | 'short';
  executed: boolean;
  expected_r_30s_quant: number | null;
  realized_r_30s: number | null;
  bucket_source: string | null;
  bucket_sample_count: number | null;
  state_vector_invalid: boolean;
  /** Gate 1 pair diagnostic — why expected or realized is null. */
  gate_1_pair_status: Gate1PairStatus;
  /** Why expected_r is null (if it is). */
  expected_r_null_cause: string | null;
  /** Why realized_r is null (if it is). */
  realized_r_null_cause: string | null;
}

export type Gate1PairStatus =
  | 'matched'
  | 'missing_expected'
  | 'missing_realized'
  | 'missing_both'
  | 'missing_risk_pts_quant';

export interface DataQualityEnvelope {
  max_lob_snap_stale_rate: number;
  max_quant_ofi_backoff_rate: number;
  max_lob_snap_cadence_p95_ms: number;
}

export interface DataQualityMetrics {
  lob_snap_stale_rate: number;
  quant_ofi_backoff_rate: number;
  lob_snap_cadence_p95_ms: number;
}

export interface StageAGraduationInput {
  rows: GraduationShadowRow[];
  data_quality: DataQualityMetrics | null;
  data_quality_envelope: DataQualityEnvelope | null;
  /** Eligibility breakdown from the classification step. */
  eligibility_summary?: EligibilitySummary;
}

export interface EligibilitySummary {
  total_signal_rows: number;
  eligible_shadow_count: number;
  ineligible_pre_quant_count: number;
  ineligible_legacy_only_count: number;
  ineligible_non_trend_pullback_count: number;
  ineligible_missing_setup_count: number;
}

// ── Gate result types ────────────────────────────────────────────────────

export interface GateResult {
  pass: boolean;
  /** 'pass' | 'fail' | 'not_measurable' — explicit three-state verdict. */
  status: GateStatus;
  detail: string;
  metrics: Record<string, number | null>;
}

export interface StageAGraduationReport {
  overall_pass: boolean;
  overall_status: GateStatus;
  n_rows: number;
  skipped_rows: number;
  eligibility_summary: EligibilitySummary | null;
  gate_1_mae: GateResult;
  gate_2_short_share: GateResult;
  gate_3_state_vector_integrity: GateResult;
  gate_4_bucket_coverage: GateResult;
  gate_5_data_quality: GateResult;
  /** Per-gate 1 pair diagnostics. */
  gate_1_pair_breakdown: {
    matched: number;
    missing_expected: number;
    missing_realized: number;
    missing_both: number;
    missing_risk_pts_quant: number;
  };
}

// ── Gate thresholds (plan §1 Decision 4) ─────────────────────────────────

export const STAGE_A_MIN_SAMPLES = 200;
export const STAGE_A_MAX_MAE = 0.15;
export const STAGE_A_MIN_SHORT_SHARE = 0.30;
export const STAGE_A_MIN_BUCKET_COVERAGE = 0.50;
export const STAGE_A_MIN_BUCKET_N = 30;

// ── Evaluator ─────────────────────────────────────────────────────────────

export function evaluateStageAGraduation(input: StageAGraduationInput): StageAGraduationReport {
  const rows = input.rows ?? [];
  const nRows = rows.length;
  let skippedRows = 0;

  // ── Gate 1 pair breakdown ──────────────────────────────────────────
  const pairBreakdown = { matched: 0, missing_expected: 0, missing_realized: 0, missing_both: 0, missing_risk_pts_quant: 0 };
  for (const r of rows) {
    switch (r.gate_1_pair_status) {
      case 'matched': pairBreakdown.matched++; break;
      case 'missing_expected': pairBreakdown.missing_expected++; break;
      case 'missing_realized': pairBreakdown.missing_realized++; break;
      case 'missing_both': pairBreakdown.missing_both++; break;
      case 'missing_risk_pts_quant': pairBreakdown.missing_risk_pts_quant++; break;
    }
  }

  // ── Gate 1: post-cost expectancy MAE < 0.15 on ≥200 paired rows ───
  let maeSum = 0;
  let maeCount = 0;
  for (const r of rows) {
    if (r.expected_r_30s_quant === null || r.realized_r_30s === null) continue;
    if (!Number.isFinite(r.expected_r_30s_quant) || !Number.isFinite(r.realized_r_30s)) {
      skippedRows++;
      continue;
    }
    maeSum += Math.abs(r.expected_r_30s_quant - r.realized_r_30s);
    maeCount++;
  }
  const maeValue = maeCount > 0 ? maeSum / maeCount : null;

  let gate1Status: GateStatus;
  if (maeCount === 0) {
    gate1Status = 'not_measurable';
  } else if (maeCount < STAGE_A_MIN_SAMPLES) {
    gate1Status = 'not_measurable';
  } else {
    gate1Status = maeValue !== null && maeValue < STAGE_A_MAX_MAE ? 'pass' : 'fail';
  }

  const gate1: GateResult = {
    pass: gate1Status === 'pass',
    status: gate1Status,
    detail: gate1Status === 'not_measurable'
      ? `NOT MEASURABLE: ${maeCount} matched pairs (need ≥${STAGE_A_MIN_SAMPLES}). Pair breakdown: ${pairBreakdown.matched} matched, ${pairBreakdown.missing_expected} missing_expected, ${pairBreakdown.missing_realized} missing_realized, ${pairBreakdown.missing_both} missing_both`
      : `MAE=${maeValue!.toFixed(4)} over n=${maeCount} (need ≥${STAGE_A_MIN_SAMPLES}, <${STAGE_A_MAX_MAE})`,
    metrics: { mae: maeValue, n: maeCount, threshold: STAGE_A_MAX_MAE, min_n: STAGE_A_MIN_SAMPLES },
  };

  // ── Gate 2: short-side count ≥ 30% of long-side count ────────────
  let longCount = 0;
  let shortCount = 0;
  for (const r of rows) {
    if (r.direction === 'long') longCount++;
    else if (r.direction === 'short') shortCount++;
  }
  const shortShare = longCount > 0 ? shortCount / longCount : 0;
  let gate2Status: GateStatus;
  if (nRows === 0) {
    gate2Status = 'not_measurable';
  } else if (longCount === 0) {
    gate2Status = 'not_measurable';
  } else {
    gate2Status = shortShare >= STAGE_A_MIN_SHORT_SHARE ? 'pass' : 'fail';
  }

  const gate2: GateResult = {
    pass: gate2Status === 'pass',
    status: gate2Status,
    detail: gate2Status === 'not_measurable'
      ? `NOT MEASURABLE: ${nRows} eligible rows, ${longCount} long, ${shortCount} short`
      : `short=${shortCount} long=${longCount} share=${shortShare.toFixed(4)} (need ≥${STAGE_A_MIN_SHORT_SHARE})`,
    metrics: { long_count: longCount, short_count: shortCount, short_share: shortShare, threshold: STAGE_A_MIN_SHORT_SHARE },
  };

  // ── Gate 3: zero ESV integrity failures on ELIGIBLE rows only ─────
  let invalidCount = 0;
  for (const r of rows) {
    if (r.state_vector_invalid) invalidCount++;
  }
  let gate3Status: GateStatus;
  if (nRows === 0) {
    gate3Status = 'not_measurable';
  } else {
    gate3Status = invalidCount === 0 ? 'pass' : 'fail';
  }

  const gate3: GateResult = {
    pass: gate3Status === 'pass',
    status: gate3Status,
    detail: gate3Status === 'not_measurable'
      ? `NOT MEASURABLE: 0 eligible shadow rows to evaluate`
      : `invalid=${invalidCount} of ${nRows} eligible shadow rows (need exactly 0)`,
    metrics: { invalid_count: invalidCount, eligible_n: nRows },
  };

  // ── Gate 4: ≥50% of EXECUTED candidates land in buckets with n≥30
  let executedCount = 0;
  let executedInGoodBucket = 0;
  for (const r of rows) {
    if (!r.executed) continue;
    executedCount++;
    const bucketCount = r.bucket_sample_count ?? 0;
    const isSidePrior = r.bucket_source === 'side_prior';
    if (!isSidePrior && bucketCount >= STAGE_A_MIN_BUCKET_N) executedInGoodBucket++;
  }
  const coverage = executedCount > 0 ? executedInGoodBucket / executedCount : 0;

  let gate4Status: GateStatus;
  if (executedCount === 0) {
    gate4Status = 'not_measurable';
  } else {
    gate4Status = coverage >= STAGE_A_MIN_BUCKET_COVERAGE ? 'pass' : 'fail';
  }

  const gate4: GateResult = {
    pass: gate4Status === 'pass',
    status: gate4Status,
    detail: gate4Status === 'not_measurable'
      ? `NOT MEASURABLE: 0 executed candidates among eligible rows`
      : `executed=${executedCount} good_bucket=${executedInGoodBucket} coverage=${coverage.toFixed(4)} (need ≥${STAGE_A_MIN_BUCKET_COVERAGE})`,
    metrics: { executed: executedCount, good_bucket: executedInGoodBucket, coverage, threshold: STAGE_A_MIN_BUCKET_COVERAGE },
  };

  // ── Gate 5: data-quality envelope ────────────────────────────────
  let gate5: GateResult;
  if (!input.data_quality || !input.data_quality_envelope) {
    gate5 = {
      pass: false,
      status: 'not_measurable',
      detail: 'NOT MEASURABLE: data_quality metrics or envelope not provided — gate FAILS closed',
      metrics: {},
    };
  } else {
    const dq = input.data_quality;
    const env = input.data_quality_envelope;
    const staleOk = dq.lob_snap_stale_rate <= env.max_lob_snap_stale_rate;
    const ofiOk = dq.quant_ofi_backoff_rate < env.max_quant_ofi_backoff_rate;
    const cadenceOk = dq.lob_snap_cadence_p95_ms <= env.max_lob_snap_cadence_p95_ms;
    const pass = staleOk && ofiOk && cadenceOk;
    gate5 = {
      pass,
      status: pass ? 'pass' : 'fail',
      detail: (
        `stale=${dq.lob_snap_stale_rate.toFixed(4)}/${env.max_lob_snap_stale_rate} (${staleOk ? 'ok' : 'FAIL'}), ` +
        `ofi_backoff=${dq.quant_ofi_backoff_rate.toFixed(4)}/${env.max_quant_ofi_backoff_rate} (${ofiOk ? 'ok' : 'FAIL'}, strict <), ` +
        `cadence_p95=${dq.lob_snap_cadence_p95_ms}/${env.max_lob_snap_cadence_p95_ms} (${cadenceOk ? 'ok' : 'FAIL'})`
      ),
      metrics: {
        lob_snap_stale_rate: dq.lob_snap_stale_rate,
        max_lob_snap_stale_rate: env.max_lob_snap_stale_rate,
        stale_ok: staleOk ? 1 : 0,
        quant_ofi_backoff_rate: dq.quant_ofi_backoff_rate,
        max_quant_ofi_backoff_rate: env.max_quant_ofi_backoff_rate,
        ofi_ok: ofiOk ? 1 : 0,
        lob_snap_cadence_p95_ms: dq.lob_snap_cadence_p95_ms,
        max_lob_snap_cadence_p95_ms: env.max_lob_snap_cadence_p95_ms,
        cadence_ok: cadenceOk ? 1 : 0,
      },
    };
  }

  const statuses = [gate1.status, gate2.status, gate3.status, gate4.status, gate5.status];
  const anyNotMeasurable = statuses.includes('not_measurable');
  const allPass = statuses.every(s => s === 'pass');

  let overallStatus: GateStatus;
  if (allPass) overallStatus = 'pass';
  else if (anyNotMeasurable) overallStatus = 'not_measurable';
  else overallStatus = 'fail';

  return {
    overall_pass: allPass,
    overall_status: overallStatus,
    n_rows: nRows,
    skipped_rows: skippedRows,
    eligibility_summary: input.eligibility_summary ?? null,
    gate_1_mae: gate1,
    gate_2_short_share: gate2,
    gate_3_state_vector_integrity: gate3,
    gate_4_bucket_coverage: gate4,
    gate_5_data_quality: gate5,
    gate_1_pair_breakdown: pairBreakdown,
  };
}
