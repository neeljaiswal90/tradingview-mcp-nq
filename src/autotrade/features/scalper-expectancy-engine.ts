/**
 * features/scalper-expectancy-engine.ts — Phase 5 expectancy engine for the
 * lob_mbo_scalp strategy family.
 *
 * This is a CLEAN FORK of `expectancy-engine.ts`. It is deliberately NOT a
 * refactor / generalization of the trend engine, because the two surfaces
 * are structurally incompatible:
 *
 *   - Trend engine: R-denominated, single 30s horizon, dimensions are
 *     z_ema9 / pullback_ratio / z_ofi_blend, cost is per-candidate
 *     `risk_pts_quant` via c_R = (fees + slippage) / risk_pts_quant.
 *   - Scalper engine: ticks-denominated, three horizons (1s, 3s, 5s),
 *     dimensions are microprice_edge_ticks / z_ofi_1s / qi_5, cost is a
 *     flat `cost_ticks` supplied by config (round-turn cost in ticks).
 *
 * Generalizing the trend engine would force polymorphism in types that
 * live downstream (EntryStateVector, quant shadow decision, bucket key
 * format, R-denominated fields on CandidateSetup) and risk silent
 * contamination of the trend pipeline. The scalper shadow decision must
 * remain auditable on its own terms — separate schema version, separate
 * artifact, separate loader, separate tests.
 *
 * Design invariants (per Phase 5 hard requirements):
 *
 *   1. DECISION-TIME-SAFE INPUTS ONLY. The bucket lookup keys are derived
 *      from the scalper state vector captured at entry time — never from
 *      forward labels, never from gate outcomes. The training rows
 *      consumed by `buildScalperBucketTableFromRows` carry labels ONLY
 *      for aggregation; labels never feed back into the bucket key.
 *
 *   2. EXPLICIT, SIDE-AWARE, HORIZON-AWARE OUTPUT. Each resolved bucket
 *      carries a per-horizon mean_ticks_raw / win_prob / std_ticks so
 *      the lookup can return the full per-horizon breakdown AND the
 *      best-horizon winner. Callers choose their horizon explicitly
 *      from `max_ev_horizon_sec` — there is no implicit default horizon.
 *
 *   3. NO SILENT FALLBACK. When the table is missing, the lookup returns
 *      a `null` estimate with `bucket_source = null`. When the resolved
 *      bucket's sample count is below the min, it fails through to the
 *      next fallback level; when NO level resolves, the lookup returns
 *      `null` post-cost — it does NOT substitute a zero or a mean. The
 *      caller is expected to treat null as "no answer" and fail closed.
 *
 *   4. NO HIDDEN THRESHOLDS. The lookup takes `cost_ticks` and `min_n`
 *      from the caller. The post-cost EV floor is enforced ONLY in the
 *      downstream shadow decision (scalper-shadow-decision.ts) — the
 *      engine itself never makes an "allow / reject" judgment. It only
 *      returns a numeric estimate. That keeps execution policy separated
 *      from statistical aggregation.
 *
 * Dimensions and backoff order (per plan §5):
 *
 *   Full 3D:      microprice_edge × z_ofi_1s × qi_5
 *   backoff_1d:   drop z_ofi_1s      (noisiest)
 *   backoff_2d:   drop z_ofi_1s, qi_5 (retain microprice_edge longest)
 *   side_prior:   direction only (all dims dropped)
 *
 * The drop order is explicit so the offline bucket builder and the
 * runtime lookup agree — any change requires updating both the constant
 * and any calibration artifact in lockstep, under a fresh schema version.
 *
 * Parity with the offline builder:
 *   scripts/build-scalper-expectancy-bucket-table.mjs is a pure-JS
 *   mirror of the constants and `buildScalperBucketTableFromRows` logic
 *   below. Any change to an edge, the backoff order, or the key format
 *   MUST be mirrored in the mjs CLI in the same commit. Unit tests
 *   enforce parity.
 */

import type { ScalperDirection, ScalperStateVector } from './scalper-state.js';

// ─── Schema + global constants ───────────────────────────────────────────────

/**
 * Schema version for the scalper bucket table artifact. Distinct from
 * the trend engine's schema on purpose — the two artifacts share no
 * fields and must never be confused by an operator.
 *
 * Bump on ANY change to:
 *   - bin edges
 *   - backoff order
 *   - bucket key format
 *   - BucketStats / SidePriorStats shape
 *   - horizons list
 */
export const SCALPER_EXPECTANCY_SCHEMA_VERSION = '0.1.0';

/** The three horizons the scalper evaluates. Fixed — must match Phase 4.4 trainer TARGETS. */
export const SCALPER_HORIZONS_SEC: readonly [1, 3, 5] = [1, 3, 5] as const;
export type ScalperHorizonSec = (typeof SCALPER_HORIZONS_SEC)[number];

/**
 * Minimum samples required to "resolve" a bucket. A bucket below this
 * threshold falls through to the next backoff level. Match the trend
 * engine default so the same calibration intuition applies.
 */
export const MIN_SCALPER_BUCKET_SAMPLES = 30;

/** The three dimensions we bucket on. */
export type ScalperExpectancyDimension = 'microprice_edge' | 'z_ofi_1s' | 'qi_5';

/**
 * Backoff drop order (index 0 = dropped first). The scalper plan §5
 * explicitly calls out this order:
 *   drop z_ofi_1s first       (noisiest, event-driven rollouts)
 *   drop qi_5 second
 *   retain microprice_edge    longest (strongest per plan priors)
 */
export const SCALPER_EXPECTANCY_BACKOFF_ORDER: readonly ScalperExpectancyDimension[] = [
  'z_ofi_1s',
  'qi_5',
  'microprice_edge',
];

/**
 * Bin edges for each dimension. Symmetric around zero where the
 * direction sign carries information (microprice_edge, z_ofi_1s, qi_5
 * are all direction-signed). Wide outer edges collapse underflow /
 * overflow into the nearest bin so no candidate is ever unbucketed.
 *
 * These are COLD-START priors, not empirically calibrated. Phase 8
 * shadow-data analysis can adjust them; any change bumps the schema
 * version and invalidates existing artifacts.
 */
export const SCALPER_MICROPRICE_EDGE_BIN_EDGES: readonly number[] = [-2.0, -0.5, -0.15, 0, 0.15, 0.5, 2.0];
export const SCALPER_Z_OFI_1S_BIN_EDGES: readonly number[] = [-3, -1, 0, 1, 3];
export const SCALPER_QI_5_BIN_EDGES: readonly number[] = [-1.0, -0.3, -0.1, 0, 0.1, 0.3, 1.0];

/** Canonical source of the three dimension names in a stable sort order for key serialization. */
const KEY_DIMENSION_ORDER: readonly ScalperExpectancyDimension[] = ['microprice_edge', 'qi_5', 'z_ofi_1s'];

// ─── Bucket table types ──────────────────────────────────────────────────────

export type ScalperBucketSource =
  | 'full'
  | 'backoff_1d'
  | 'backoff_2d'
  | 'side_prior';

/**
 * Per-horizon statistics for one bucket. A single bucket carries THREE
 * horizon-keyed entries because the Phase 4.4 trainer emits three
 * models at 1s/3s/5s — the expectancy aggregate must mirror that
 * horizon grid so the caller can compare the three and pick the max.
 *
 * `mean_ticks_raw` is the direction-signed realized ticks (positive =
 * favorable to the trade's intended direction). `win_prob` is the
 * empirical fraction of rows with strictly positive realized ticks in
 * that direction. `std_ticks` is diagnostic only; it is NOT used in the
 * lookup or gate.
 *
 * Cost is NOT pre-subtracted here — cost is per-candidate via
 * `cost_ticks` at lookup time. That keeps the artifact reusable across
 * cost regimes and makes operator sanity-checks straightforward.
 */
export interface ScalperPerHorizonStats {
  n: number;
  mean_ticks_raw: number;
  win_prob: number;
  std_ticks: number;
}

export interface ScalperBucketStats {
  /** Total sample count across all horizons (rows may have partial labels). */
  n: number;
  /** Per-horizon stats keyed by seconds. */
  per_horizon: Record<ScalperHorizonSec, ScalperPerHorizonStats>;
}

export interface ScalperSidePriorStats extends ScalperBucketStats {
  direction: ScalperDirection;
}

export interface ScalperExpectancyBucketTable {
  schema_version: string;
  generated_at: string;
  source_row_count: number;
  min_bucket_samples: number;
  horizons_sec: readonly ScalperHorizonSec[];
  dimensions: readonly ScalperExpectancyDimension[];
  backoff_order: readonly ScalperExpectancyDimension[];
  microprice_edge_bin_edges: readonly number[];
  z_ofi_1s_bin_edges: readonly number[];
  qi_5_bin_edges: readonly number[];
  buckets_full: Record<string, ScalperBucketStats>;
  buckets_backoff_1d: Record<string, ScalperBucketStats>;
  buckets_backoff_2d: Record<string, ScalperBucketStats>;
  side_prior: {
    long: ScalperSidePriorStats | null;
    short: ScalperSidePriorStats | null;
  };
}

// ─── Bin + key helpers ──────────────────────────────────────────────────────

/**
 * Map a value onto a bin index using edges as boundaries. Returns null
 * on non-finite input. Matches the trend engine's `binIndex` semantics
 * bit-for-bit so operators who know one surface can read the other.
 */
export function scalperBinIndex(value: number | null | undefined, edges: readonly number[]): number | null {
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
 * Canonical bucket key. Keys include ONLY the dimensions present in
 * `dims` so the same helper serves `full` / `backoff_1d` / `backoff_2d`.
 * Layout (stable, sorted by the KEY_DIMENSION_ORDER constant):
 *
 *   "${direction}|microprice_edge=${a}|qi_5=${b}|z_ofi_1s=${c}"
 */
export function buildScalperBucketKey(
  direction: ScalperDirection,
  dims: Partial<Record<ScalperExpectancyDimension, number>>,
): string {
  const parts: string[] = [direction];
  for (const dim of KEY_DIMENSION_ORDER) {
    const v = dims[dim];
    if (v !== undefined) parts.push(`${dim}=${v}`);
  }
  return parts.join('|');
}

/**
 * Bin a scalper state vector onto the three dimensions. Returns nulls
 * per dimension when the source is unavailable (null, undefined, NaN).
 */
export function binScalperStateVector(
  vec: ScalperStateVector,
): Record<ScalperExpectancyDimension, number | null> {
  return {
    microprice_edge: scalperBinIndex(vec.micropriceEdgeTicks, SCALPER_MICROPRICE_EDGE_BIN_EDGES),
    z_ofi_1s: scalperBinIndex(vec.zOfi1s, SCALPER_Z_OFI_1S_BIN_EDGES),
    qi_5: scalperBinIndex(vec.qi5, SCALPER_QI_5_BIN_EDGES),
  };
}

// ─── Lookup types ────────────────────────────────────────────────────────────

export interface ScalperExpectancyLookupInput {
  direction: ScalperDirection;
  vec: ScalperStateVector;
  /** Flat round-turn cost in ticks, subtracted from the raw per-horizon EV. */
  cost_ticks: number;
  /** Min sample threshold override (defaults to MIN_SCALPER_BUCKET_SAMPLES). */
  min_n?: number;
}

/**
 * Result of a scalper expectancy lookup. Carries both the per-horizon
 * detail AND a precomputed winner (`max_ev_*`) so the caller does not
 * need to re-derive which horizon maximized EV. The winner is chosen
 * strictly by post-cost EV ticks; ties (exact equality) are broken by
 * the earliest horizon — deterministic for replay.
 *
 * Every field is present even on the "no data" path (null values) so
 * downstream log records have a stable shape — this is part of the
 * "every decision is observable in logs" requirement.
 */
export interface ScalperExpectancyEstimate {
  /** Post-cost EV ticks at the winning horizon, or null when no bucket resolved. */
  max_ev_ticks_post_cost: number | null;
  /** The horizon that produced `max_ev_ticks_post_cost`, or null when no bucket resolved. */
  max_ev_horizon_sec: ScalperHorizonSec | null;
  /** Per-horizon breakdown. All entries null-filled when no bucket resolved. */
  per_horizon: Record<
    ScalperHorizonSec,
    {
      raw_ticks: number | null;
      post_cost_ticks: number | null;
      win_prob: number | null;
    }
  >;
  /** Which fallback level resolved (or null when no data at all). */
  bucket_source: ScalperBucketSource | null;
  /** Serialized bucket key for telemetry + reproducibility. */
  bucket_id: string | null;
  /** Sample count backing the resolved bucket. */
  bucket_sample_count: number | null;
  /** Echoed cost so the log record carries every input used in the decision. */
  cost_ticks: number;
  /** Echoed min_n actually applied for this lookup. */
  applied_min_n: number;
}

/** Emit a canonical "no data" estimate. Every field is null-filled. */
function emptyEstimate(costTicks: number, minN: number): ScalperExpectancyEstimate {
  return {
    max_ev_ticks_post_cost: null,
    max_ev_horizon_sec: null,
    per_horizon: {
      1: { raw_ticks: null, post_cost_ticks: null, win_prob: null },
      3: { raw_ticks: null, post_cost_ticks: null, win_prob: null },
      5: { raw_ticks: null, post_cost_ticks: null, win_prob: null },
    },
    bucket_source: null,
    bucket_id: null,
    bucket_sample_count: null,
    cost_ticks: costTicks,
    applied_min_n: minN,
  };
}

// ─── Lookup engine ──────────────────────────────────────────────────────────

/**
 * Hierarchical bucket lookup. Walks full → backoff_1d → backoff_2d →
 * side_prior and resolves on the first level whose bucket has at least
 * `min_n` samples.
 *
 * Never throws. Returns a structured `ScalperExpectancyEstimate` on every
 * code path — null-filled when the table is missing or no level resolves.
 */
export function lookupScalperExpectancy(
  table: ScalperExpectancyBucketTable | null,
  input: ScalperExpectancyLookupInput,
): ScalperExpectancyEstimate {
  const minN = input.min_n ?? MIN_SCALPER_BUCKET_SAMPLES;
  const costTicks = input.cost_ticks;
  const direction = input.direction;

  if (!table) return emptyEstimate(costTicks, minN);

  const bins = binScalperStateVector(input.vec);

  // Build the per-level key map honoring the backoff drop order.
  // Level 0 = full (no dims dropped)
  // Level 1 = backoff_1d (drops backoff_order[0])
  // Level 2 = backoff_2d (drops backoff_order[0,1])
  const order = table.backoff_order;
  const keyAtLevel = (level: number): string | null => {
    const dropped = new Set(order.slice(0, level));
    const dims: Partial<Record<ScalperExpectancyDimension, number>> = {};
    for (const dim of KEY_DIMENSION_ORDER) {
      if (dropped.has(dim)) continue;
      const bin = bins[dim];
      if (bin === null) return null; // cannot form the key at this level
      dims[dim] = bin;
    }
    return buildScalperBucketKey(direction, dims);
  };

  const levels: Array<{
    level: number;
    dict: Record<string, ScalperBucketStats> | null;
    source: ScalperBucketSource;
  }> = [
    { level: 0, dict: table.buckets_full, source: 'full' },
    { level: 1, dict: table.buckets_backoff_1d, source: 'backoff_1d' },
    { level: 2, dict: table.buckets_backoff_2d, source: 'backoff_2d' },
  ];

  for (const { level, dict, source } of levels) {
    if (!dict) continue;
    const key = keyAtLevel(level);
    if (key === null) continue;
    const stats = dict[key];
    if (!stats || stats.n < minN) continue;
    return buildEstimate(stats, source, key, costTicks, minN);
  }

  // Side-prior fallback — direction only.
  const prior = direction === 'long' ? table.side_prior.long : table.side_prior.short;
  if (prior && prior.n >= minN) {
    const key = `${direction}|side_prior`;
    return buildEstimate(prior, 'side_prior', key, costTicks, minN);
  }

  // Nothing resolved.
  return emptyEstimate(costTicks, minN);
}

/**
 * Convert a resolved bucket's per-horizon stats into the
 * `ScalperExpectancyEstimate` shape, choosing the post-cost winner.
 *
 * Tie-break on exact post-cost equality: the earliest horizon wins
 * (1s < 3s < 5s). Deterministic so replay and live produce identical
 * results. Undefined-finite values are treated as "no data" for that
 * horizon and cannot win the tie.
 */
function buildEstimate(
  stats: ScalperBucketStats,
  source: ScalperBucketSource,
  key: string,
  costTicks: number,
  minN: number,
): ScalperExpectancyEstimate {
  const perHorizon: ScalperExpectancyEstimate['per_horizon'] = {
    1: { raw_ticks: null, post_cost_ticks: null, win_prob: null },
    3: { raw_ticks: null, post_cost_ticks: null, win_prob: null },
    5: { raw_ticks: null, post_cost_ticks: null, win_prob: null },
  };

  let bestH: ScalperHorizonSec | null = null;
  let bestPostCost: number | null = null;

  for (const h of SCALPER_HORIZONS_SEC) {
    const ph = stats.per_horizon[h];
    if (!ph) continue;
    if (!Number.isFinite(ph.mean_ticks_raw) || ph.n <= 0) continue;
    const raw = round4(ph.mean_ticks_raw);
    const post = round4(ph.mean_ticks_raw - costTicks);
    perHorizon[h] = {
      raw_ticks: raw,
      post_cost_ticks: post,
      win_prob: Number.isFinite(ph.win_prob) ? round4(ph.win_prob) : null,
    };
    if (bestPostCost === null || post > bestPostCost) {
      bestPostCost = post;
      bestH = h;
    }
  }

  return {
    max_ev_ticks_post_cost: bestPostCost,
    max_ev_horizon_sec: bestH,
    per_horizon: perHorizon,
    bucket_source: source,
    bucket_id: key,
    bucket_sample_count: stats.n,
    cost_ticks: costTicks,
    applied_min_n: minN,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ─── Offline bucket-table builder (pure function) ──────────────────────────

/**
 * A single labeled training row — the subset of Phase 4.3 dataset fields
 * the bucket builder needs. All callers must deliver rows that already
 * have: a direction, the three bucketing dimensions (`microprice_edge_ticks`,
 * `z_ofi_1s`, `qi_5` — same names as the Phase 4.3 dataset columns), and
 * the per-horizon forward returns expressed in DIRECTION-SIGNED TICKS (not
 * points, not raw returns).
 *
 * The builder does NOT convert points → ticks. That conversion happens in
 * the offline CLI (`scripts/build-scalper-expectancy-bucket-table.mjs`)
 * using a known tick size. Keeping the conversion at the CLI boundary
 * means this function only ever sees direction-signed tick values, which
 * makes the bucket statistics auditable by hand.
 */
export interface ScalperExpectancyTrainingRow {
  direction: ScalperDirection;
  microprice_edge_ticks: number | null;
  z_ofi_1s: number | null;
  qi_5: number | null;
  /** Direction-signed forward return in ticks at 1s. null when uncovered. */
  fwd_ticks_1s: number | null;
  /** Direction-signed forward return in ticks at 3s. null when uncovered. */
  fwd_ticks_3s: number | null;
  /** Direction-signed forward return in ticks at 5s. null when uncovered. */
  fwd_ticks_5s: number | null;
}

export interface BuildScalperBucketTableOptions {
  /** Min sample threshold. Defaults to MIN_SCALPER_BUCKET_SAMPLES. */
  min_n?: number;
}

/**
 * Accumulator for per-horizon stats — online mean / variance / win-count.
 * Separated from finalized stats so we can accumulate three horizons per
 * bucket in one pass through the rows.
 */
interface PerHorizonAcc {
  n: number;
  sum: number;
  sumSq: number;
  wins: number;
}
interface BucketAcc {
  per_horizon: Record<ScalperHorizonSec, PerHorizonAcc>;
  /** Row count — a row counts here if ANY horizon contributed to this bucket. */
  n_rows: number;
}

function emptyPerHorizonAcc(): PerHorizonAcc {
  return { n: 0, sum: 0, sumSq: 0, wins: 0 };
}

function emptyBucketAcc(): BucketAcc {
  return {
    per_horizon: { 1: emptyPerHorizonAcc(), 3: emptyPerHorizonAcc(), 5: emptyPerHorizonAcc() },
    n_rows: 0,
  };
}

function pushHorizon(acc: PerHorizonAcc, ticks: number | null): boolean {
  if (ticks == null || !Number.isFinite(ticks)) return false;
  acc.n += 1;
  acc.sum += ticks;
  acc.sumSq += ticks * ticks;
  if (ticks > 0) acc.wins += 1;
  return true;
}

function finalizePerHorizon(acc: PerHorizonAcc): ScalperPerHorizonStats {
  if (acc.n === 0) {
    return { n: 0, mean_ticks_raw: 0, win_prob: 0, std_ticks: 0 };
  }
  const mean = acc.sum / acc.n;
  const variance = acc.sumSq / acc.n - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  return {
    n: acc.n,
    mean_ticks_raw: round4(mean),
    win_prob: round4(acc.wins / acc.n),
    std_ticks: round4(std),
  };
}

function finalizeBucket(acc: BucketAcc): ScalperBucketStats {
  return {
    n: acc.n_rows,
    per_horizon: {
      1: finalizePerHorizon(acc.per_horizon[1]),
      3: finalizePerHorizon(acc.per_horizon[3]),
      5: finalizePerHorizon(acc.per_horizon[5]),
    },
  };
}

function finalizeBucketMap(map: Record<string, BucketAcc>): Record<string, ScalperBucketStats> {
  const out: Record<string, ScalperBucketStats> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = finalizeBucket(v);
  }
  return out;
}

/**
 * Aggregate labeled training rows into a runtime-ready bucket table.
 *
 *   - Drops rows with direction ∉ {long, short}.
 *   - Drops rows where ALL THREE horizons are null (no label signal).
 *   - Contributes to `buckets_full` only when all three bucket dims
 *     resolved to a finite bin.
 *   - Contributes to `buckets_backoff_1d` / `buckets_backoff_2d` /
 *     `side_prior` whenever the relevant subset of bins resolves.
 *
 * Per-row horizon push is conditional: a row with only `fwd_ticks_3s`
 * populated still contributes to the 3s accumulator of its bucket but
 * does NOT pollute 1s / 5s. That's how per-horizon coverage feeds into
 * the same bucket while keeping each horizon's statistics clean.
 */
export function buildScalperBucketTableFromRows(
  rows: ScalperExpectancyTrainingRow[],
  options: BuildScalperBucketTableOptions = {},
): ScalperExpectancyBucketTable {
  const minN = options.min_n ?? MIN_SCALPER_BUCKET_SAMPLES;

  const accFull: Record<string, BucketAcc> = {};
  const acc1d: Record<string, BucketAcc> = {};
  const acc2d: Record<string, BucketAcc> = {};
  const accSide: Record<ScalperDirection, BucketAcc> = {
    long: emptyBucketAcc(),
    short: emptyBucketAcc(),
  };

  let usedRows = 0;

  for (const row of rows) {
    if (row.direction !== 'long' && row.direction !== 'short') continue;

    const anyLabel =
      (row.fwd_ticks_1s != null && Number.isFinite(row.fwd_ticks_1s)) ||
      (row.fwd_ticks_3s != null && Number.isFinite(row.fwd_ticks_3s)) ||
      (row.fwd_ticks_5s != null && Number.isFinite(row.fwd_ticks_5s));
    if (!anyLabel) continue;

    usedRows++;

    const bins = {
      microprice_edge: scalperBinIndex(row.microprice_edge_ticks, SCALPER_MICROPRICE_EDGE_BIN_EDGES),
      z_ofi_1s: scalperBinIndex(row.z_ofi_1s, SCALPER_Z_OFI_1S_BIN_EDGES),
      qi_5: scalperBinIndex(row.qi_5, SCALPER_QI_5_BIN_EDGES),
    };

    const pushRow = (acc: BucketAcc) => {
      let any = false;
      any = pushHorizon(acc.per_horizon[1], row.fwd_ticks_1s) || any;
      any = pushHorizon(acc.per_horizon[3], row.fwd_ticks_3s) || any;
      any = pushHorizon(acc.per_horizon[5], row.fwd_ticks_5s) || any;
      if (any) acc.n_rows += 1;
    };

    // side prior always accumulates
    pushRow(accSide[row.direction]);

    // full 3D — requires all three dims
    if (bins.microprice_edge !== null && bins.z_ofi_1s !== null && bins.qi_5 !== null) {
      const key = buildScalperBucketKey(row.direction, {
        microprice_edge: bins.microprice_edge,
        z_ofi_1s: bins.z_ofi_1s,
        qi_5: bins.qi_5,
      });
      pushRow((accFull[key] ??= emptyBucketAcc()));
    }

    // backoff_1d — drop backoff_order[0] (= z_ofi_1s)
    const drop1 = SCALPER_EXPECTANCY_BACKOFF_ORDER[0]!;
    const dims1: Partial<Record<ScalperExpectancyDimension, number>> = {};
    let ok1 = true;
    for (const dim of KEY_DIMENSION_ORDER) {
      if (dim === drop1) continue;
      const b = bins[dim];
      if (b === null) {
        ok1 = false;
        break;
      }
      dims1[dim] = b;
    }
    if (ok1) {
      const key = buildScalperBucketKey(row.direction, dims1);
      pushRow((acc1d[key] ??= emptyBucketAcc()));
    }

    // backoff_2d — drop backoff_order[0,1]
    const drop2a = SCALPER_EXPECTANCY_BACKOFF_ORDER[0]!;
    const drop2b = SCALPER_EXPECTANCY_BACKOFF_ORDER[1]!;
    const dims2: Partial<Record<ScalperExpectancyDimension, number>> = {};
    let ok2 = true;
    for (const dim of KEY_DIMENSION_ORDER) {
      if (dim === drop2a || dim === drop2b) continue;
      const b = bins[dim];
      if (b === null) {
        ok2 = false;
        break;
      }
      dims2[dim] = b;
    }
    if (ok2) {
      const key = buildScalperBucketKey(row.direction, dims2);
      pushRow((acc2d[key] ??= emptyBucketAcc()));
    }
  }

  const longPrior = finalizeBucket(accSide.long);
  const shortPrior = finalizeBucket(accSide.short);

  return {
    schema_version: SCALPER_EXPECTANCY_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source_row_count: usedRows,
    min_bucket_samples: minN,
    horizons_sec: SCALPER_HORIZONS_SEC,
    dimensions: ['microprice_edge', 'z_ofi_1s', 'qi_5'],
    backoff_order: SCALPER_EXPECTANCY_BACKOFF_ORDER,
    microprice_edge_bin_edges: SCALPER_MICROPRICE_EDGE_BIN_EDGES,
    z_ofi_1s_bin_edges: SCALPER_Z_OFI_1S_BIN_EDGES,
    qi_5_bin_edges: SCALPER_QI_5_BIN_EDGES,
    buckets_full: finalizeBucketMap(accFull),
    buckets_backoff_1d: finalizeBucketMap(acc1d),
    buckets_backoff_2d: finalizeBucketMap(acc2d),
    side_prior: {
      long: longPrior.n > 0 ? { ...longPrior, direction: 'long' } : null,
      short: shortPrior.n > 0 ? { ...shortPrior, direction: 'short' } : null,
    },
  };
}
