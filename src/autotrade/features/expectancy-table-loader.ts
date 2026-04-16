/**
 * features/expectancy-table-loader.ts — Phase 8 Stage A bucket table loader.
 *
 * Reads an on-disk `ExpectancyBucketTable` JSON file, validates its
 * provenance against the engine's canonical constants, and returns
 * either a typed table or a structured load error. The runner calls
 * this once at startup and passes the result through to generateSignal.
 *
 * Plan boundaries enforced by this module:
 *   1. "Do not auto-load production tables in a way that hides
 *      provenance or schema mismatch." — every failure is LOUD and
 *      returns null so the engine sees "no table" (null) rather than
 *      a mismatched table that could silently drift.
 *   2. "Do not let missing bucket tables or no_data become effective
 *      rejections." — the loader NEVER throws; callers get back a
 *      structured `LoadResult` so the runner can log the status and
 *      continue. Downstream (`lookupExpectancy`) returns null-null
 *      estimates, which `deriveExpectancyVerdict` converts to
 *      `no_data`, which the Stage B runner treats as neutral.
 *
 * Validation checks performed (in order, short-circuiting on first
 * failure):
 *   - File exists and is readable.
 *   - JSON parses without error.
 *   - `schema_version` matches `EXPECTANCY_ENGINE_SCHEMA_VERSION`.
 *   - `dimensions` exactly matches `['z_ema9', 'pullback_ratio', 'z_ofi_blend']`.
 *   - `backoff_order` matches the engine's `EXPECTANCY_BACKOFF_ORDER`.
 *   - `z_ema9_bin_edges` / `pullback_ratio_bin_edges` /
 *     `z_ofi_blend_bin_edges` match the engine's canonical edges
 *     (element-wise equality to 4 decimals).
 *   - `horizon_sec === 30` (only horizon Phase 6 supports).
 *   - `buckets_full` / `buckets_backoff_1d` / `buckets_backoff_2d` /
 *     `side_prior` keys exist (may be empty objects; `side_prior` may
 *     have null `long` / `short`).
 */

import { existsSync, readFileSync } from 'fs';
import {
  EXPECTANCY_ENGINE_SCHEMA_VERSION,
  EXPECTANCY_BACKOFF_ORDER,
  Z_EMA9_BIN_EDGES,
  PULLBACK_RATIO_BIN_EDGES,
  Z_OFI_BLEND_BIN_EDGES,
  type ExpectancyBucketTable,
} from './expectancy-engine.js';

export type LoadStatus =
  | 'loaded'
  | 'insufficient_data'
  | 'file_missing'
  | 'parse_error'
  | 'schema_version_mismatch'
  | 'dimensions_mismatch'
  | 'backoff_order_mismatch'
  | 'bin_edges_mismatch'
  | 'horizon_mismatch'
  | 'structure_invalid'
  | 'symbol_mismatch';

/** Minimum source rows required for a table to be execution-eligible. */
export const MIN_SOURCE_ROWS = 200;
/** Minimum per-side rows required for execution eligibility. */
export const MIN_SIDE_ROWS = 10;
/** Minimum backoff bucket sample size for meaningful statistics. */
export const MIN_BACKOFF_BUCKET_N = 10;

export interface LoadResult {
  status: LoadStatus;
  path: string;
  /** The validated table when status === 'loaded'. Null otherwise. */
  table: ExpectancyBucketTable | null;
  /** Human-readable detail line for operator log. */
  detail: string;
  /**
   * For provenance logging. Populated on successful load and on
   * structural rejects so the operator can diagnose why a seemingly
   * valid file was refused.
   */
  provenance: {
    source_row_count: number | null;
    generated_at: string | null;
    schema_version_on_disk: string | null;
    resolved_bucket_count_full: number | null;
    resolved_bucket_count_backoff_1d: number | null;
    resolved_bucket_count_backoff_2d: number | null;
    side_prior_long_n: number | null;
    side_prior_short_n: number | null;
  };
}

function emptyProvenance(): LoadResult['provenance'] {
  return {
    source_row_count: null,
    generated_at: null,
    schema_version_on_disk: null,
    resolved_bucket_count_full: null,
    resolved_bucket_count_backoff_1d: null,
    resolved_bucket_count_backoff_2d: null,
    side_prior_long_n: null,
    side_prior_short_n: null,
  };
}

function arraysEqualNumeric(a: unknown, b: number[], epsilon = 1e-6): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (typeof ai !== 'number' || !Number.isFinite(ai)) return false;
    if (Math.abs(ai - b[i]!) > epsilon) return false;
  }
  return true;
}

function arraysEqualString(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Load and validate an expectancy bucket table from disk. Never
 * throws. The caller inspects `status` and uses `table` only when
 * `status === 'loaded'`.
 */
export function loadExpectancyBucketTable(path: string, expectedSymbol?: string): LoadResult {
  if (!existsSync(path)) {
    return {
      status: 'file_missing',
      path,
      table: null,
      detail: `Bucket table file not found at ${path}`,
      provenance: emptyProvenance(),
    };
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(path, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: 'parse_error',
      path,
      table: null,
      detail: `Failed to read or parse bucket table: ${err instanceof Error ? err.message : String(err)}`,
      provenance: emptyProvenance(),
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      status: 'structure_invalid',
      path,
      table: null,
      detail: 'Bucket table root is not a JSON object.',
      provenance: emptyProvenance(),
    };
  }

  const provenance: LoadResult['provenance'] = {
    source_row_count: typeof parsed['source_row_count'] === 'number' ? parsed['source_row_count'] : null,
    generated_at: typeof parsed['generated_at'] === 'string' ? parsed['generated_at'] : null,
    schema_version_on_disk: typeof parsed['schema_version'] === 'string' ? parsed['schema_version'] : null,
    resolved_bucket_count_full: null,
    resolved_bucket_count_backoff_1d: null,
    resolved_bucket_count_backoff_2d: null,
    side_prior_long_n: null,
    side_prior_short_n: null,
  };

  // Symbol mismatch check — mandatory in paper/live modes.
  // When expectedSymbol is provided and the table carries a symbol_filter,
  // they must match. This prevents cross-symbol data from driving execution.
  if (expectedSymbol && typeof parsed['symbol_filter'] === 'string' && parsed['symbol_filter'] !== expectedSymbol) {
    return {
      status: 'symbol_mismatch',
      path,
      table: null,
      detail: (
        `Bucket table symbol_filter '${parsed['symbol_filter']}' does not match ` +
        `expected symbol '${expectedSymbol}'. Build a symbol-scoped table with ` +
        `--symbol ${expectedSymbol} to eliminate cross-symbol risk.`
      ),
      provenance,
    };
  }

  // Schema version check — canonical refuse-to-load gate.
  if (parsed['schema_version'] !== EXPECTANCY_ENGINE_SCHEMA_VERSION) {
    return {
      status: 'schema_version_mismatch',
      path,
      table: null,
      detail: (
        `Bucket table schema_version '${parsed['schema_version']}' does not match ` +
        `the expectancy engine's current schema_version '${EXPECTANCY_ENGINE_SCHEMA_VERSION}'. ` +
        `Rebuild the table with scripts/build-expectancy-bucket-table.mjs before loading.`
      ),
      provenance,
    };
  }

  // Dimensions order.
  if (!arraysEqualString(parsed['dimensions'], ['z_ema9', 'pullback_ratio', 'z_ofi_blend'])) {
    return {
      status: 'dimensions_mismatch',
      path,
      table: null,
      detail: 'Bucket table `dimensions` does not match the canonical engine order.',
      provenance,
    };
  }

  if (!arraysEqualString(parsed['backoff_order'], EXPECTANCY_BACKOFF_ORDER)) {
    return {
      status: 'backoff_order_mismatch',
      path,
      table: null,
      detail: (
        `Bucket table backoff_order does not match the engine's canonical order ` +
        `[${EXPECTANCY_BACKOFF_ORDER.join(',')}]. Rebuild the table.`
      ),
      provenance,
    };
  }

  // Bin-edge checks (element-wise to 1e-6). Refusing to load protects
  // against a silent drift where the builder used different edges
  // than the engine expects — the resulting expectancy lookups would
  // hit wrong buckets even though the JSON parses fine.
  if (!arraysEqualNumeric(parsed['z_ema9_bin_edges'], Z_EMA9_BIN_EDGES)) {
    return {
      status: 'bin_edges_mismatch',
      path,
      table: null,
      detail: 'Bucket table z_ema9_bin_edges do not match engine constants.',
      provenance,
    };
  }
  if (!arraysEqualNumeric(parsed['pullback_ratio_bin_edges'], PULLBACK_RATIO_BIN_EDGES)) {
    return {
      status: 'bin_edges_mismatch',
      path,
      table: null,
      detail: 'Bucket table pullback_ratio_bin_edges do not match engine constants.',
      provenance,
    };
  }
  if (!arraysEqualNumeric(parsed['z_ofi_blend_bin_edges'], Z_OFI_BLEND_BIN_EDGES)) {
    return {
      status: 'bin_edges_mismatch',
      path,
      table: null,
      detail: 'Bucket table z_ofi_blend_bin_edges do not match engine constants.',
      provenance,
    };
  }

  if (parsed['horizon_sec'] !== 30) {
    return {
      status: 'horizon_mismatch',
      path,
      table: null,
      detail: `Bucket table horizon_sec=${parsed['horizon_sec']}, expected 30.`,
      provenance,
    };
  }

  // Structural checks for the bucket sub-objects. We don't typecheck
  // every individual stats entry — the runtime lookup handles missing
  // keys as cold buckets — but we DO require the container fields.
  const required = ['buckets_full', 'buckets_backoff_1d', 'buckets_backoff_2d', 'side_prior'];
  for (const key of required) {
    const v = parsed[key];
    if (!isPlainObject(v)) {
      return {
        status: 'structure_invalid',
        path,
        table: null,
        detail: `Bucket table is missing or has invalid '${key}' (expected object).`,
        provenance,
      };
    }
  }

  const full = parsed['buckets_full'] as Record<string, unknown>;
  const b1 = parsed['buckets_backoff_1d'] as Record<string, unknown>;
  const b2 = parsed['buckets_backoff_2d'] as Record<string, unknown>;
  const sp = parsed['side_prior'] as Record<string, unknown>;

  provenance.resolved_bucket_count_full = Object.keys(full).length;
  provenance.resolved_bucket_count_backoff_1d = Object.keys(b1).length;
  provenance.resolved_bucket_count_backoff_2d = Object.keys(b2).length;
  provenance.side_prior_long_n = isPlainObject(sp['long']) && typeof sp['long']['n'] === 'number'
    ? sp['long']['n']
    : null;
  provenance.side_prior_short_n = isPlainObject(sp['short']) && typeof sp['short']['n'] === 'number'
    ? sp['short']['n']
    : null;

  // ── Quality gate — insufficient data check ──────────────────────────────
  // Tables that pass schema validation but lack statistical power are loaded
  // for telemetry/diagnostics only, NOT for execution gating.
  const srcRows = provenance.source_row_count ?? 0;
  const longN = provenance.side_prior_long_n ?? 0;
  const shortN = provenance.side_prior_short_n ?? 0;
  const fullCount = provenance.resolved_bucket_count_full ?? 0;

  // Check if all backoff buckets have small n
  let allBackoffTiny = true;
  for (const key of Object.keys(b1)) {
    const bucket = b1[key];
    if (isPlainObject(bucket) && typeof bucket['n'] === 'number' && bucket['n'] >= MIN_BACKOFF_BUCKET_N) {
      allBackoffTiny = false;
      break;
    }
  }
  if (allBackoffTiny) {
    for (const key of Object.keys(b2)) {
      const bucket = b2[key];
      if (isPlainObject(bucket) && typeof bucket['n'] === 'number' && bucket['n'] >= MIN_BACKOFF_BUCKET_N) {
        allBackoffTiny = false;
        break;
      }
    }
  }

  const reasons: string[] = [];
  if (srcRows < MIN_SOURCE_ROWS) reasons.push(`source_row_count=${srcRows} < ${MIN_SOURCE_ROWS}`);
  if (longN < MIN_SIDE_ROWS) reasons.push(`long_side_n=${longN} < ${MIN_SIDE_ROWS}`);
  if (shortN < MIN_SIDE_ROWS) reasons.push(`short_side_n=${shortN} < ${MIN_SIDE_ROWS}`);
  if (fullCount === 0 && allBackoffTiny) reasons.push('no full buckets and all backoff buckets have n < ' + MIN_BACKOFF_BUCKET_N);

  if (reasons.length > 0) {
    return {
      status: 'insufficient_data',
      path,
      table: parsed as unknown as ExpectancyBucketTable,
      detail: `Bucket table loaded but insufficient for execution: ${reasons.join('; ')}. Telemetry-only mode.`,
      provenance,
    };
  }

  return {
    status: 'loaded',
    path,
    table: parsed as unknown as ExpectancyBucketTable,
    detail: (
      `Loaded bucket table: ${provenance.source_row_count ?? '?'} training rows, ` +
      `${provenance.resolved_bucket_count_full} full buckets, ` +
      `${provenance.resolved_bucket_count_backoff_1d} 1d, ` +
      `${provenance.resolved_bucket_count_backoff_2d} 2d, ` +
      `side_prior long.n=${provenance.side_prior_long_n ?? 0} ` +
      `short.n=${provenance.side_prior_short_n ?? 0}`
    ),
    provenance,
  };
}
