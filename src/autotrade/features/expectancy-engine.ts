/**
 * features/expectancy-engine.ts — Phase 6 of the quant trend-pullback refactor.
 *
 * Hierarchical bucket lookup for post-cost expected R at the 30-second
 * horizon. See plan §11, §4.3, and §10/11.
 *
 * Dimensions (plan §11):
 *   1. z_ema9         — trend-relative pullback geometry
 *   2. pullback_ratio — retracement depth
 *   3. z_ofi_blend    — direction-signed orderflow pressure
 *
 * Hierarchical fallback (plan §11 + §7 open-items note):
 *   full        — all 3 dimensions
 *   backoff_1d  — 2 dimensions (drops z_ofi_blend first)
 *   backoff_2d  — 1 dimension (drops pullback_ratio next)
 *   side_prior  — direction only (all dimensions dropped)
 *
 * The drop order is specified in-plan: z_ofi_blend first because its
 * snapshot-driven approximation is the noisiest input; pullback_ratio
 * next; z_ema9 last because it's the primary geometric gate.
 *
 * Min sample rule: a bucket is "resolved" only when `n >= min_n`. Cold
 * buckets (below threshold) fall through to the next backoff level.
 * `min_n` defaults to 30 per plan.
 *
 * Sparse-LOB reconciliation: when the candidate's
 * `entry_state_vector.ofi_reliability === 'sparse'` (set by
 * features/orderflow-state.ts under the §4.4 fresh-but-sparse rule),
 * the engine MUST start at `backoff_1d` (z_ofi_blend dropped) even if
 * the full bucket would otherwise resolve. This is the Phase 6
 * reconciliation called out in the plan.
 *
 * Stage A posture: Phase 6 only POPULATES parallel quant fields on
 * CandidateSetup. It never overwrites legacy `stop` / `target_*` /
 * `rr_*` / `confidence`. The `quant_shadow_reject_reason` field carries
 * the would-be Stage B verdict as telemetry only — Phase 7/8 activate
 * the actual gate.
 *
 * Authoritative formulas (plan §3.1 / §10-11):
 *   c_R                    = (fees + slippage) / risk_pts_quant
 *   expected_r_30s_quant   = mean_r_raw_bucket − c_R         (post-cost)
 *   win_prob_30s_quant     = empirical win rate in bucket    (raw)
 *   quality_band_quant     = A/B/C/D tiering on post-cost metrics
 */

import type {
  CandidateSetup,
  EntryStateVector,
  EntryStateOfiReliability,
} from '../types.js';

// ── Configuration constants ────────────────────────────────────────────────
//
// Phase 7 moves these into env.ts under `quant_entry.expectancy`. Until
// then, module-local constants give a single source of truth so the
// bucket-table builder CLI and the runtime engine stay in lockstep.

/** Minimum samples required to "resolve" a bucket per plan §11. */
export const MIN_BUCKET_SAMPLES = 30;

/** Bin edges (inclusive lower, exclusive upper) for z_ema9 ∈ [0.15, 1.25]. */
export const Z_EMA9_BIN_EDGES = [0.15, 0.425, 0.7, 0.975, 1.25];

/** Bin edges for pullback_ratio ∈ [0.25, 0.62]. */
export const PULLBACK_RATIO_BIN_EDGES = [0.25, 0.3425, 0.435, 0.5275, 0.62];

/**
 * Bin edges for z_ofi_blend. Wider / symmetric because OFI has no hard
 * gate and its distribution is roughly centered on 0.
 */
export const Z_OFI_BLEND_BIN_EDGES = [-3, -1, 0, 1, 3];

/**
 * Drop order for hierarchical fallback (plan §4.3). Index 0 is dropped
 * first. Explicitly reified so tests + the bucket builder agree with
 * the runtime engine.
 */
export const EXPECTANCY_BACKOFF_ORDER: ExpectancyDimension[] = [
  'z_ofi_blend',
  'pullback_ratio',
  'z_ema9',
];

/** Side-prior threshold (R units). Must clear higher than the main gate. */
export const DEFAULT_SIDE_PRIOR_MIN_EXPECTED_R = 0.2;

export const EXPECTANCY_ENGINE_SCHEMA_VERSION = '0.1.0';

export type ExpectancyDimension = 'z_ema9' | 'pullback_ratio' | 'z_ofi_blend';

export type BucketSource =
  | 'full'
  | 'backoff_1d'
  | 'backoff_2d'
  | 'side_prior';

// ── Bucket table types ────────────────────────────────────────────────────

/**
 * Aggregated statistics for a single bucket key. `mean_r_raw` is the
 * direction-signed realized R at the 30-second horizon (positive =
 * favorable to setup direction). `win_prob` is the empirical fraction
 * of samples with positive realized R.
 *
 * Cost is intentionally NOT pre-subtracted here — cost is per-candidate
 * via `risk_pts_quant` and gets applied at lookup time in the engine.
 */
export interface BucketStats {
  n: number;
  mean_r_raw: number;
  win_prob: number;
  /** Standard deviation of realized R — diagnostic only. */
  std_r_raw: number;
}

export interface SidePriorStats extends BucketStats {
  direction: 'long' | 'short';
}

/**
 * Canonical bucket table emitted by
 * scripts/build-expectancy-bucket-table.mjs and consumed at runtime.
 *
 * Keys for `buckets_full` / `buckets_backoff_1d` / `buckets_backoff_2d`
 * are `buildBucketKey()` strings — the same helper runs in both the
 * builder and the engine to guarantee parity.
 */
export interface ExpectancyBucketTable {
  schema_version: string;
  generated_at: string;
  source_row_count: number;
  min_bucket_samples: number;
  horizon_sec: 30;
  dimensions: ExpectancyDimension[];
  backoff_order: ExpectancyDimension[];
  z_ema9_bin_edges: number[];
  pullback_ratio_bin_edges: number[];
  z_ofi_blend_bin_edges: number[];
  /** Full 3D buckets, keyed by `long|z_ema9=0|pullback_ratio=1|z_ofi_blend=2`. */
  buckets_full: Record<string, BucketStats>;
  /** 2D buckets, keyed by dropping `z_ofi_blend` (or whatever index 0 of backoff is). */
  buckets_backoff_1d: Record<string, BucketStats>;
  /** 1D buckets, keyed by dropping backoff[0] and backoff[1]. */
  buckets_backoff_2d: Record<string, BucketStats>;
  /** Side prior, one entry per direction. */
  side_prior: { long: SidePriorStats | null; short: SidePriorStats | null };
}

// ── Bin helpers ────────────────────────────────────────────────────────────

/**
 * Map a value onto a bin index using edges defined as boundaries:
 *   edges = [e0, e1, e2, e3, e4]
 *     value < e0        → bin 0 (underflow)
 *     e0 <= value < e1  → bin 0
 *     e1 <= value < e2  → bin 1
 *     e2 <= value < e3  → bin 2
 *     e3 <= value < e4  → bin 3
 *     value >= e4       → bin (edges.length - 2) (overflow)
 *
 * Underflow and overflow collapse into the nearest edge bin so every
 * value produces a finite bin id. Returns null on non-finite input.
 */
export function binIndex(value: number | null | undefined, edges: number[]): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (edges.length < 2) return null;
  const lastBin = edges.length - 2;
  if (value < edges[0]!) return 0;
  if (value >= edges[edges.length - 1]!) return lastBin;
  for (let i = 0; i < lastBin; i++) {
    if (value >= edges[i]! && value < edges[i + 1]!) return i;
  }
  return lastBin;
}

/**
 * Canonical bucket key. `dims` is a map from dimension name to bin
 * index; only the dimensions present in the map are included in the
 * key, so `full` / `backoff_1d` / `backoff_2d` / `side_prior` all use
 * the same format.
 *
 * Key layout (stable, sorted alphabetically by dimension name):
 *   "${direction}|pullback_ratio=${a}|z_ema9=${b}|z_ofi_blend=${c}"
 */
export function buildBucketKey(
  direction: 'long' | 'short',
  dims: Partial<Record<ExpectancyDimension, number>>,
): string {
  const parts: string[] = [direction];
  const order: ExpectancyDimension[] = ['pullback_ratio', 'z_ema9', 'z_ofi_blend'];
  for (const dim of order) {
    const v = dims[dim];
    if (v !== undefined) parts.push(`${dim}=${v}`);
  }
  return parts.join('|');
}

/**
 * Bin a state vector onto the 3 dimension indices. Returns nulls per
 * dimension when the value is missing or out-of-grid.
 */
export function binStateVector(
  vector: EntryStateVector,
): { z_ema9: number | null; pullback_ratio: number | null; z_ofi_blend: number | null } {
  return {
    z_ema9: binIndex(vector.z_ema9, Z_EMA9_BIN_EDGES),
    pullback_ratio: binIndex(vector.pullback_ratio, PULLBACK_RATIO_BIN_EDGES),
    z_ofi_blend: binIndex(vector.z_ofi_blend, Z_OFI_BLEND_BIN_EDGES),
  };
}

// ── Lookup types + engine ─────────────────────────────────────────────────

export interface ExpectancyLookupInput {
  direction: 'long' | 'short';
  vector: EntryStateVector;
  /** Per-candidate cost in R units — (fees + slippage) / risk_pts_quant. */
  cost_r: number;
  /** Min sample threshold override (defaults to MIN_BUCKET_SAMPLES). */
  min_n?: number;
  /** Side-prior post-cost min expectancy for the fail-closed rule. */
  side_prior_min_expected_r?: number;
  /**
   * Phase 8: post-cost expected-R threshold for non-side-prior tiers
   * (`full` / `backoff_1d` / `backoff_2d`). When the resolved bucket's
   * post-cost value is below this, the engine tags
   * `shadow_reject_reason = 'rejected_by_expectancy_below_threshold'`.
   * Default 0.0 makes this a no-op until the operator calibrates a
   * real threshold from Stage A shadow data.
   */
  min_expected_r_primary?: number;
}

export type ExpectancyShadowRejectReason =
  | 'rejected_by_bucket_sparsity'
  | 'rejected_by_expectancy_below_threshold';

export interface ExpectancyEstimate {
  /** Post-cost expected R at 30s. Null when the engine has no data. */
  expected_r_30s_post_cost: number | null;
  /** Raw (pre-cost) expected R from the resolved bucket. */
  expected_r_30s_raw: number | null;
  /** Empirical win probability in the resolved bucket. */
  win_prob_30s: number | null;
  /** A/B/C/D quality band on the post-cost value. */
  quality_band: 'A' | 'B' | 'C' | 'D';
  /** Which fallback level resolved (or null when no data at all). */
  bucket_source: BucketSource | null;
  /** Serialized bucket key for telemetry + reproducibility. */
  bucket_id: string | null;
  /** Sample count backing the resolved bucket. */
  bucket_sample_count: number | null;
  /** True iff the OFI dimension was deliberately skipped due to sparse LOB. */
  sparse_ofi_forced: boolean;
  /** Would-be Stage B shadow decision (null = pass). */
  shadow_reject_reason: ExpectancyShadowRejectReason | null;
}

/**
 * Convert a raw expectancy + win probability into a quality band.
 * Thresholds are deliberately conservative for Phase 6 cold start —
 * Phase 8 shadow telemetry informs the refit.
 */
export function computeQualityBand(
  expectedRPostCost: number | null,
  winProb: number | null,
): 'A' | 'B' | 'C' | 'D' {
  if (expectedRPostCost === null || winProb === null) return 'D';
  if (expectedRPostCost >= 0.3 && winProb >= 0.6) return 'A';
  if (expectedRPostCost >= 0.15 && winProb >= 0.55) return 'B';
  if (expectedRPostCost >= 0.05 && winProb >= 0.5) return 'C';
  return 'D';
}

/**
 * Core engine lookup. Implements the hierarchical fallback chain:
 *
 *   full → backoff_1d → backoff_2d → side_prior
 *
 * The `sparse_ofi_forced` flag is set when the input's ofi_reliability
 * is 'sparse', in which case `full` is SKIPPED entirely. This matches
 * the §4.4 fresh-but-sparse row of the degradation matrix: a sparse
 * book means OFI is unreliable for bucketing, so the engine refuses to
 * use that dimension even if the bucket would otherwise resolve.
 *
 * Stage B telemetry: when the terminal fallback is `side_prior` AND
 * the post-cost expectancy is below `side_prior_min_expected_r`, the
 * output carries `shadow_reject_reason = 'rejected_by_bucket_sparsity'`.
 * Phase 6 does not act on this tag — Phase 7/8 activate the gate.
 */
export function lookupExpectancy(
  table: ExpectancyBucketTable | null,
  input: ExpectancyLookupInput,
): ExpectancyEstimate {
  const minN = input.min_n ?? MIN_BUCKET_SAMPLES;
  const sidePriorMin = input.side_prior_min_expected_r ?? DEFAULT_SIDE_PRIOR_MIN_EXPECTED_R;
  const primaryMin = input.min_expected_r_primary ?? 0.0;
  const costR = input.cost_r;
  const direction = input.direction;

  // Degraded path: no table loaded.
  if (!table) {
    return {
      expected_r_30s_post_cost: null,
      expected_r_30s_raw: null,
      win_prob_30s: null,
      quality_band: 'D',
      bucket_source: null,
      bucket_id: null,
      bucket_sample_count: null,
      sparse_ofi_forced: false,
      shadow_reject_reason: null,
    };
  }

  const sparseOfi: boolean = input.vector.ofi_reliability === 'sparse';
  const bins = binStateVector(input.vector);

  // Precompute candidate keys for each fallback level using the
  // canonical backoff order.
  const order = table.backoff_order;
  const dropFromLevel = (level: number): ExpectancyDimension[] =>
    order.slice(0, level); // `level` dims dropped from the front

  // Level 0 = full (no dims dropped)
  // Level 1 = backoff_1d
  // Level 2 = backoff_2d
  // Level 3 = side_prior
  const makeKeyAtLevel = (level: number): { key: string; dims: Partial<Record<ExpectancyDimension, number>> } | null => {
    const dropped = new Set(dropFromLevel(level));
    const dims: Partial<Record<ExpectancyDimension, number>> = {};
    for (const dim of ['z_ema9', 'pullback_ratio', 'z_ofi_blend'] as ExpectancyDimension[]) {
      if (dropped.has(dim)) continue;
      const bin = bins[dim];
      if (bin === null) return null;
      dims[dim] = bin;
    }
    return { key: buildBucketKey(direction, dims), dims };
  };

  // Sparse OFI forces starting at level 1 (drops z_ofi_blend).
  // Otherwise start at the full 3D lookup.
  const startLevel = sparseOfi ? 1 : 0;

  // ── Walk the fallback chain ─────────────────────────────────────────
  const tryLevels: Array<{ level: number; dict: Record<string, BucketStats> | null; source: BucketSource }> = [
    { level: 0, dict: table.buckets_full, source: 'full' },
    { level: 1, dict: table.buckets_backoff_1d, source: 'backoff_1d' },
    { level: 2, dict: table.buckets_backoff_2d, source: 'backoff_2d' },
  ];

  for (const { level, dict, source } of tryLevels) {
    if (level < startLevel) continue;
    if (!dict) continue;
    const keyInfo = makeKeyAtLevel(level);
    if (!keyInfo) continue;
    const stats = dict[keyInfo.key];
    if (!stats || stats.n < minN) continue;
    // Resolved.
    return buildEstimate(stats, source, keyInfo.key, costR, sparseOfi, sidePriorMin, primaryMin, /*isSidePrior*/ false);
  }

  // ── Side prior fallback ─────────────────────────────────────────────
  const prior = direction === 'long' ? table.side_prior.long : table.side_prior.short;
  if (prior && prior.n >= minN) {
    const keyId = `${direction}|side_prior`;
    return buildEstimate(prior, 'side_prior', keyId, costR, sparseOfi, sidePriorMin, primaryMin, /*isSidePrior*/ true);
  }

  // ── No data at any level ────────────────────────────────────────────
  return {
    expected_r_30s_post_cost: null,
    expected_r_30s_raw: null,
    win_prob_30s: null,
    quality_band: 'D',
    bucket_source: null,
    bucket_id: null,
    bucket_sample_count: null,
    sparse_ofi_forced: sparseOfi,
    shadow_reject_reason: null,
  };
}

function buildEstimate(
  stats: BucketStats,
  source: BucketSource,
  key: string,
  costR: number,
  sparseOfi: boolean,
  sidePriorMin: number,
  primaryMin: number,
  isSidePrior: boolean,
): ExpectancyEstimate {
  const rawR = stats.mean_r_raw;
  const postR = round4(rawR - costR);
  const quality = computeQualityBand(postR, stats.win_prob);

  // Shadow-reject logic:
  //   - side_prior + below side_prior_min_expected_r
  //     → 'rejected_by_bucket_sparsity' (Phase 6)
  //   - non-side-prior + below min_expected_r_primary
  //     → 'rejected_by_expectancy_below_threshold' (Phase 8 Stage A)
  //
  // Both cases fail-loud via the same `shadow_reject_reason` field.
  // Phase 7 Stage A runner ignores this (telemetry only); Phase 7
  // Stage B runner uses it to AND-gate execution when `hybrid_gate`
  // is on. Legacy execution fields are never touched either way.
  let shadowReject: ExpectancyShadowRejectReason | null = null;
  if (isSidePrior) {
    if (postR < sidePriorMin) shadowReject = 'rejected_by_bucket_sparsity';
  } else {
    if (postR < primaryMin) shadowReject = 'rejected_by_expectancy_below_threshold';
  }

  return {
    expected_r_30s_post_cost: postR,
    expected_r_30s_raw: round4(rawR),
    win_prob_30s: round4(stats.win_prob),
    quality_band: quality,
    bucket_source: source,
    bucket_id: key,
    bucket_sample_count: stats.n,
    sparse_ofi_forced: sparseOfi,
    shadow_reject_reason: shadowReject,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ── Hydration helper ───────────────────────────────────────────────────────

/**
 * Apply expectancy lookup results to the candidate's parallel quant
 * fields. Legacy execution fields are NEVER touched. Called from
 * hydrateQuantRewardContract in features/initial-risk.ts after the
 * cold-start target / initial-stop fields are already in place.
 */
export function attachQuantExpectancy(
  setup: CandidateSetup,
  estimate: ExpectancyEstimate,
): void {
  setup.expected_r_30s_quant = estimate.expected_r_30s_post_cost;
  setup.win_prob_30s_quant = estimate.win_prob_30s;
  setup.quality_band_quant = estimate.bucket_source === null ? null : estimate.quality_band;
  setup.bucket_id_quant = estimate.bucket_id;
  setup.bucket_sample_count_quant = estimate.bucket_sample_count;
  // Override bucket_source_quant ONLY when the expectancy engine had a
  // real answer. If the engine returned null (no table), we preserve
  // the Phase 4 'cold_start' tag written by the cold-start target path.
  if (estimate.bucket_source !== null) {
    setup.bucket_source_quant = estimate.bucket_source;
  }
  setup.quant_shadow_reject_reason = estimate.shadow_reject_reason;
  setup.bucket_lookup_status = estimate.bucket_source === null
    ? 'cold_start_no_match'
    : estimate.bucket_source === 'full'
      ? 'full_match'
      : estimate.bucket_source;
}

// ── Bucket table builder (pure function) ───────────────────────────────────
//
// Consumed by scripts/build-expectancy-bucket-table.mjs and by Phase 6
// tests. Keeping the builder here means the runtime engine's bin edges
// / key format / backoff order remain the single source of truth — the
// CLI just shells out to this function via node --import with tsx (or
// duplicates the logic as a last resort; either way this file is the
// canonical reference).

/**
 * A single labeled training row — the subset of Phase 5 signal fields
 * the bucket builder needs. All callers produce rows that already have
 * direction, entry_state_vector fields, and a resolved R label.
 */
export interface ExpectancyTrainingRow {
  direction: 'long' | 'short';
  z_ema9: number | null;
  pullback_ratio: number | null;
  z_ofi_blend: number | null;
  ofi_reliability?: EntryStateOfiReliability | null;
  /** Realized R at 30s, direction-signed (positive = favorable). */
  realized_r_30s: number;
}

export interface BuildBucketTableOptions {
  /** Min sample threshold. Defaults to MIN_BUCKET_SAMPLES. */
  min_n?: number;
  /** Override horizon for metadata only — engine is 30s-locked. */
  horizon_sec?: 30;
}

/**
 * Aggregate labeled training rows into a runtime-ready bucket table.
 * Skips rows with non-finite R or direction outside {long, short}.
 *
 * Sparse-OFI rows (rows whose orderflow state was sparse at capture
 * time) contribute to `backoff_1d` / `backoff_2d` / `side_prior` but
 * NOT to `buckets_full`. That way the full 3D bucket never contains
 * samples with untrustworthy OFI, and the runtime sparse-OFI start-at-
 * backoff-1d rule matches the training-time distribution.
 */
export function buildBucketTableFromRows(
  rows: ExpectancyTrainingRow[],
  options: BuildBucketTableOptions = {},
): ExpectancyBucketTable {
  const minN = options.min_n ?? MIN_BUCKET_SAMPLES;

  const accFull: Record<string, { sum: number; sumSq: number; wins: number; n: number }> = {};
  const acc1d: Record<string, { sum: number; sumSq: number; wins: number; n: number }> = {};
  const acc2d: Record<string, { sum: number; sumSq: number; wins: number; n: number }> = {};
  const accSide: Record<'long' | 'short', { sum: number; sumSq: number; wins: number; n: number }> = {
    long: { sum: 0, sumSq: 0, wins: 0, n: 0 },
    short: { sum: 0, sumSq: 0, wins: 0, n: 0 },
  };

  let usedRows = 0;
  for (const row of rows) {
    if (row.direction !== 'long' && row.direction !== 'short') continue;
    const r = row.realized_r_30s;
    if (!Number.isFinite(r)) continue;
    usedRows++;

    const bins = {
      z_ema9: binIndex(row.z_ema9, Z_EMA9_BIN_EDGES),
      pullback_ratio: binIndex(row.pullback_ratio, PULLBACK_RATIO_BIN_EDGES),
      z_ofi_blend: binIndex(row.z_ofi_blend, Z_OFI_BLEND_BIN_EDGES),
    };
    const isSparse = row.ofi_reliability === 'sparse';

    // Side prior always accumulates.
    pushStat(accSide[row.direction], r);

    // Full 3D bucket — only if OFI is trustworthy AND all dims resolved.
    if (!isSparse && bins.z_ema9 !== null && bins.pullback_ratio !== null && bins.z_ofi_blend !== null) {
      const key = buildBucketKey(row.direction, {
        z_ema9: bins.z_ema9,
        pullback_ratio: bins.pullback_ratio,
        z_ofi_blend: bins.z_ofi_blend,
      });
      pushStat(accFull[key] ??= emptyAcc(), r);
    }

    // backoff_1d drops backoff[0] (= z_ofi_blend by plan §4.3).
    const drop1 = EXPECTANCY_BACKOFF_ORDER[0]!;
    const dims1d: Partial<Record<ExpectancyDimension, number>> = {};
    let ok1d = true;
    for (const dim of ['z_ema9', 'pullback_ratio', 'z_ofi_blend'] as ExpectancyDimension[]) {
      if (dim === drop1) continue;
      const b = bins[dim];
      if (b === null) { ok1d = false; break; }
      dims1d[dim] = b;
    }
    if (ok1d) {
      const key = buildBucketKey(row.direction, dims1d);
      pushStat(acc1d[key] ??= emptyAcc(), r);
    }

    // backoff_2d drops backoff[0] AND backoff[1].
    const drop2a = EXPECTANCY_BACKOFF_ORDER[0]!;
    const drop2b = EXPECTANCY_BACKOFF_ORDER[1]!;
    const dims2d: Partial<Record<ExpectancyDimension, number>> = {};
    let ok2d = true;
    for (const dim of ['z_ema9', 'pullback_ratio', 'z_ofi_blend'] as ExpectancyDimension[]) {
      if (dim === drop2a || dim === drop2b) continue;
      const b = bins[dim];
      if (b === null) { ok2d = false; break; }
      dims2d[dim] = b;
    }
    if (ok2d) {
      const key = buildBucketKey(row.direction, dims2d);
      pushStat(acc2d[key] ??= emptyAcc(), r);
    }
  }

  return {
    schema_version: EXPECTANCY_ENGINE_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source_row_count: usedRows,
    min_bucket_samples: minN,
    horizon_sec: 30,
    dimensions: ['z_ema9', 'pullback_ratio', 'z_ofi_blend'],
    backoff_order: EXPECTANCY_BACKOFF_ORDER,
    z_ema9_bin_edges: Z_EMA9_BIN_EDGES,
    pullback_ratio_bin_edges: PULLBACK_RATIO_BIN_EDGES,
    z_ofi_blend_bin_edges: Z_OFI_BLEND_BIN_EDGES,
    buckets_full: finalizeBuckets(accFull),
    buckets_backoff_1d: finalizeBuckets(acc1d),
    buckets_backoff_2d: finalizeBuckets(acc2d),
    side_prior: {
      long: accSide.long.n > 0 ? { ...finalizeOne(accSide.long), direction: 'long' } : null,
      short: accSide.short.n > 0 ? { ...finalizeOne(accSide.short), direction: 'short' } : null,
    },
  };
}

function emptyAcc() {
  return { sum: 0, sumSq: 0, wins: 0, n: 0 };
}

function pushStat(acc: { sum: number; sumSq: number; wins: number; n: number }, r: number): void {
  acc.sum += r;
  acc.sumSq += r * r;
  if (r > 0) acc.wins += 1;
  acc.n += 1;
}

function finalizeOne(acc: { sum: number; sumSq: number; wins: number; n: number }): BucketStats {
  const mean = acc.n > 0 ? acc.sum / acc.n : 0;
  const variance = acc.n > 0 ? acc.sumSq / acc.n - mean * mean : 0;
  const std = Math.sqrt(Math.max(0, variance));
  return {
    n: acc.n,
    mean_r_raw: round4(mean),
    win_prob: round4(acc.n > 0 ? acc.wins / acc.n : 0),
    std_r_raw: round4(std),
  };
}

function finalizeBuckets(
  acc: Record<string, { sum: number; sumSq: number; wins: number; n: number }>,
): Record<string, BucketStats> {
  const out: Record<string, BucketStats> = {};
  for (const [key, a] of Object.entries(acc)) {
    out[key] = finalizeOne(a);
  }
  return out;
}
