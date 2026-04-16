/**
 * features/scalper-expectancy-loader.ts — Phase 5 loader for the scalper
 * expectancy bucket table artifact.
 *
 * Mirrors the trend-side `expectancy-table-loader.ts` contract one
 * structural level for one — same "never throws, always returns status"
 * shape, same refuse-to-load posture on schema drift — but validates
 * against the scalper engine's canonical constants so there is zero
 * chance of loading a trend artifact into the scalper runtime (or vice
 * versa).
 *
 * Validation order (short-circuits on first failure):
 *
 *   1. File exists and is readable.
 *   2. JSON parses.
 *   3. Root is a plain object.
 *   4. schema_version === SCALPER_EXPECTANCY_SCHEMA_VERSION.
 *   5. dimensions matches ['microprice_edge', 'z_ofi_1s', 'qi_5'].
 *   6. backoff_order matches SCALPER_EXPECTANCY_BACKOFF_ORDER.
 *   7. microprice_edge_bin_edges / z_ofi_1s_bin_edges / qi_5_bin_edges
 *      match the engine constants element-wise.
 *   8. horizons_sec === [1, 3, 5].
 *   9. buckets_full / buckets_backoff_1d / buckets_backoff_2d / side_prior
 *      exist as plain objects.
 *
 * The loader REFUSES to return a table whose bin edges drift from the
 * runtime constants even when the JSON is well-formed. A drift means
 * the lookups would bin candidates against different boundaries than
 * the training-time statistics were computed against — a silent
 * statistical corruption. Rejecting on drift is the "no silent
 * fallback" rule applied at the loader boundary.
 *
 * Phase 5 scope: this loader deliberately does NOT apply an
 * "insufficient data" quality gate like the trend loader. The scalper
 * bucket table is shadow-only in Phase 5; operator interpretation of
 * bucket sparsity happens downstream in the Phase 5/6 shadow decision
 * engine, where the min_n rule is already enforced at lookup time.
 * Adding another gate here would be a second hidden threshold — rejected
 * per the Phase 5 "no hidden thresholds" rule.
 */

import { existsSync, readFileSync } from 'fs';
import {
  SCALPER_EXPECTANCY_SCHEMA_VERSION,
  SCALPER_EXPECTANCY_BACKOFF_ORDER,
  SCALPER_MICROPRICE_EDGE_BIN_EDGES,
  SCALPER_Z_OFI_1S_BIN_EDGES,
  SCALPER_QI_5_BIN_EDGES,
  SCALPER_HORIZONS_SEC,
  type ScalperExpectancyBucketTable,
} from './scalper-expectancy-engine.js';

export type ScalperLoaderStatus =
  | 'loaded'
  | 'file_missing'
  | 'parse_error'
  | 'structure_invalid'
  | 'schema_version_mismatch'
  | 'dimensions_mismatch'
  | 'backoff_order_mismatch'
  | 'bin_edges_mismatch'
  | 'horizons_mismatch';

export interface ScalperLoaderResult {
  status: ScalperLoaderStatus;
  path: string;
  /** The validated table when status === 'loaded'. Null otherwise. */
  table: ScalperExpectancyBucketTable | null;
  /** Human-readable detail for operator log. */
  detail: string;
  /** Provenance for log + dashboard review. */
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

function emptyProvenance(): ScalperLoaderResult['provenance'] {
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function arraysEqualString(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function arraysEqualNumeric(a: unknown, b: readonly number[], epsilon = 1e-6): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (typeof ai !== 'number' || !Number.isFinite(ai)) return false;
    if (Math.abs(ai - b[i]!) > epsilon) return false;
  }
  return true;
}

function arraysEqualNumberOrder(a: unknown, b: readonly number[]): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Load and validate a scalper expectancy bucket table from disk. Never
 * throws. Callers inspect `status` and use `table` only when
 * `status === 'loaded'`.
 */
export function loadScalperExpectancyTable(path: string): ScalperLoaderResult {
  if (!existsSync(path)) {
    return {
      status: 'file_missing',
      path,
      table: null,
      detail: `Scalper bucket table file not found at ${path}`,
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
      detail: `Failed to read or parse scalper bucket table: ${err instanceof Error ? err.message : String(err)}`,
      provenance: emptyProvenance(),
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      status: 'structure_invalid',
      path,
      table: null,
      detail: 'Scalper bucket table root is not a JSON object.',
      provenance: emptyProvenance(),
    };
  }

  const provenance: ScalperLoaderResult['provenance'] = {
    source_row_count: typeof parsed['source_row_count'] === 'number' ? parsed['source_row_count'] : null,
    generated_at: typeof parsed['generated_at'] === 'string' ? parsed['generated_at'] : null,
    schema_version_on_disk: typeof parsed['schema_version'] === 'string' ? parsed['schema_version'] : null,
    resolved_bucket_count_full: null,
    resolved_bucket_count_backoff_1d: null,
    resolved_bucket_count_backoff_2d: null,
    side_prior_long_n: null,
    side_prior_short_n: null,
  };

  if (parsed['schema_version'] !== SCALPER_EXPECTANCY_SCHEMA_VERSION) {
    return {
      status: 'schema_version_mismatch',
      path,
      table: null,
      detail: (
        `Scalper bucket table schema_version '${parsed['schema_version']}' does not match ` +
        `the runtime engine's '${SCALPER_EXPECTANCY_SCHEMA_VERSION}'. ` +
        `Rebuild with scripts/build-scalper-expectancy-bucket-table.mjs before loading.`
      ),
      provenance,
    };
  }

  if (!arraysEqualString(parsed['dimensions'], ['microprice_edge', 'z_ofi_1s', 'qi_5'])) {
    return {
      status: 'dimensions_mismatch',
      path,
      table: null,
      detail: 'Scalper bucket table `dimensions` does not match the canonical engine order.',
      provenance,
    };
  }

  if (!arraysEqualString(parsed['backoff_order'], SCALPER_EXPECTANCY_BACKOFF_ORDER)) {
    return {
      status: 'backoff_order_mismatch',
      path,
      table: null,
      detail: (
        `Scalper bucket table backoff_order does not match the engine's canonical order ` +
        `[${SCALPER_EXPECTANCY_BACKOFF_ORDER.join(',')}]. Rebuild the table.`
      ),
      provenance,
    };
  }

  if (!arraysEqualNumeric(parsed['microprice_edge_bin_edges'], SCALPER_MICROPRICE_EDGE_BIN_EDGES)) {
    return {
      status: 'bin_edges_mismatch',
      path,
      table: null,
      detail: 'Scalper bucket table microprice_edge_bin_edges do not match engine constants.',
      provenance,
    };
  }
  if (!arraysEqualNumeric(parsed['z_ofi_1s_bin_edges'], SCALPER_Z_OFI_1S_BIN_EDGES)) {
    return {
      status: 'bin_edges_mismatch',
      path,
      table: null,
      detail: 'Scalper bucket table z_ofi_1s_bin_edges do not match engine constants.',
      provenance,
    };
  }
  if (!arraysEqualNumeric(parsed['qi_5_bin_edges'], SCALPER_QI_5_BIN_EDGES)) {
    return {
      status: 'bin_edges_mismatch',
      path,
      table: null,
      detail: 'Scalper bucket table qi_5_bin_edges do not match engine constants.',
      provenance,
    };
  }

  if (!arraysEqualNumberOrder(parsed['horizons_sec'], SCALPER_HORIZONS_SEC)) {
    return {
      status: 'horizons_mismatch',
      path,
      table: null,
      detail: (
        `Scalper bucket table horizons_sec=${JSON.stringify(parsed['horizons_sec'])} does not match ` +
        `engine constant [${SCALPER_HORIZONS_SEC.join(',')}].`
      ),
      provenance,
    };
  }

  for (const key of ['buckets_full', 'buckets_backoff_1d', 'buckets_backoff_2d', 'side_prior']) {
    if (!isPlainObject(parsed[key])) {
      return {
        status: 'structure_invalid',
        path,
        table: null,
        detail: `Scalper bucket table is missing or has invalid '${key}' (expected object).`,
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
  provenance.side_prior_long_n =
    isPlainObject(sp['long']) && typeof sp['long']['n'] === 'number' ? sp['long']['n'] : null;
  provenance.side_prior_short_n =
    isPlainObject(sp['short']) && typeof sp['short']['n'] === 'number' ? sp['short']['n'] : null;

  return {
    status: 'loaded',
    path,
    table: parsed as unknown as ScalperExpectancyBucketTable,
    detail: (
      `Loaded scalper bucket table: ${provenance.source_row_count ?? '?'} training rows, ` +
      `${provenance.resolved_bucket_count_full} full buckets, ` +
      `${provenance.resolved_bucket_count_backoff_1d} 1d, ` +
      `${provenance.resolved_bucket_count_backoff_2d} 2d, ` +
      `side_prior long.n=${provenance.side_prior_long_n ?? 0} ` +
      `short.n=${provenance.side_prior_short_n ?? 0}`
    ),
    provenance,
  };
}
