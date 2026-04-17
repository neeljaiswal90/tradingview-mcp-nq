#!/usr/bin/env node
/**
 * build-scalper-expectancy-bucket-table.mjs — Phase 5 offline bucket-table
 * builder for the lob_mbo_scalp strategy family.
 *
 * Reads: data/lob_mbo_scalp_dataset.csv (Phase 4.3 builder output)
 * Writes: reports/ml/lob_mbo_scalp/expectancy_buckets.json
 *
 * The CLI is a JS mirror of `src/autotrade/features/scalper-expectancy-engine.ts`.
 * It duplicates the bin edges, backoff order, key format, and aggregation
 * logic so the script runs standalone without a TypeScript build step.
 * Any change to the TS engine MUST be mirrored here in the same commit —
 * a unit test pins parity against a shared synthetic fixture.
 *
 * Scope (kept tight per Phase 5 "decision-quality not infrastructure"):
 *
 *   1. DECISION-TIME-SAFE INPUTS ONLY. The bucket key is derived ONLY from
 *      the three dimensions `microprice_edge_ticks`, `z_ofi_1s`, `qi_5`
 *      captured at entry time. Forward return labels are used exclusively
 *      to compute bucket statistics — they NEVER feed into the bucket key.
 *
 *   2. DIRECTION-SIGNED TICK LABELS. Raw labels in the Phase 4.3 CSV are
 *      in POINTS (e.g. NQ futures, 1 tick = 0.25 points). The builder
 *      converts to ticks via `fwd_return_pts / tick_size` and then
 *      SIGNS by direction: long → +fwd_ticks, short → -fwd_ticks. The
 *      sign convention is "positive ticks = favorable to intended
 *      direction" so the same bucket statistic reads the same way for
 *      long and short.
 *
 *   3. META-ROW SKIP. The Phase 4.3 CSV has no meta rows, but the CSV
 *      format is enforced via header validation — any unexpected first
 *      row bails loudly.
 *
 *   4. ROW SAMPLE-WEIGHT PASSTHROUGH. When Phase 4.1's rejection sampling
 *      is enabled the Phase 4.3 CSV carries a `sample_weight` column. The
 *      bucket builder applies it to EVERY contribution so rejects weight
 *      correctly in win-prob and mean estimates. Missing / non-finite
 *      sample_weight fails closed (row dropped + warning).
 *
 *   5. SKIP ROWS WHERE all_gates_passed=false. Per the Phase 5 rule
 *      that expectancy reflects ONLY realized post-pass outcomes, the
 *      bucket builder aggregates labels ONLY from rows that cleared the
 *      deterministic + persistence gates. Rows rejected pre-gate carry
 *      zero signal about the forward return distribution of the
 *      live-candidate population and would poison the statistics.
 *
 * Usage:
 *   node scripts/build-scalper-expectancy-bucket-table.mjs \
 *        [--in  data/lob_mbo_scalp_dataset.csv] \
 *        [--out reports/ml/lob_mbo_scalp/expectancy_buckets.json] \
 *        [--min-n 30] \
 *        [--tick-size 0.25]
 *
 * Exit codes:
 *   0 — wrote a table (even if empty buckets)
 *   1 — input missing / header invalid / write failed
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ── Mirrors of scalper-expectancy-engine.ts constants (bump in lockstep) ──

const SCHEMA_VERSION = '0.1.0';
const HORIZONS_SEC = [1, 3, 5];
const DIMENSIONS = ['microprice_edge', 'z_ofi_1s', 'qi_5'];
const BACKOFF_ORDER = ['z_ofi_1s', 'qi_5', 'microprice_edge'];
const MIN_BUCKET_SAMPLES_DEFAULT = 30;
const MICROPRICE_EDGE_BIN_EDGES = [-2.0, -0.5, -0.15, 0, 0.15, 0.5, 2.0];
const Z_OFI_1S_BIN_EDGES = [-3, -1, 0, 1, 3];
const QI_5_BIN_EDGES = [-1.0, -0.3, -0.1, 0, 0.1, 0.3, 1.0];
const KEY_DIMENSION_ORDER = ['microprice_edge', 'qi_5', 'z_ofi_1s'];

function binIndex(value, edges) {
  if (value == null || !Number.isFinite(value)) return null;
  if (edges.length < 2) return null;
  const lastBin = edges.length - 2;
  if (value < edges[0]) return 0;
  if (value >= edges[edges.length - 1]) return lastBin;
  for (let i = 0; i < lastBin; i++) {
    if (value >= edges[i] && value < edges[i + 1]) return i;
  }
  return lastBin;
}

function buildBucketKey(direction, dims) {
  const parts = [direction];
  for (const dim of KEY_DIMENSION_ORDER) {
    const v = dims[dim];
    if (v !== undefined) parts.push(`${dim}=${v}`);
  }
  return parts.join('|');
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

// ── Per-horizon weighted accumulator (online mean / variance / wins) ──────

function emptyPerHorizonAcc() {
  return { sumW: 0, sumWX: 0, sumWX2: 0, sumWWins: 0 };
}

function emptyBucketAcc() {
  return {
    per_horizon: { 1: emptyPerHorizonAcc(), 3: emptyPerHorizonAcc(), 5: emptyPerHorizonAcc() },
    rowsW: 0,
  };
}

/**
 * Add a single (weight, signed-ticks) observation to a per-horizon
 * accumulator. Weighted mean = sumWX / sumW; weighted variance =
 * sumWX2 / sumW - mean² (biased but fine for std diagnostic). Returns
 * true iff the ticks value was finite and accepted.
 */
function pushHorizon(acc, weight, ticks) {
  if (ticks == null || !Number.isFinite(ticks)) return false;
  acc.sumW += weight;
  acc.sumWX += weight * ticks;
  acc.sumWX2 += weight * ticks * ticks;
  if (ticks > 0) acc.sumWWins += weight;
  return true;
}

function finalizePerHorizon(acc) {
  if (acc.sumW === 0) {
    return { n: 0, mean_ticks_raw: 0, win_prob: 0, std_ticks: 0 };
  }
  const mean = acc.sumWX / acc.sumW;
  const variance = acc.sumWX2 / acc.sumW - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  return {
    n: Math.round(acc.sumW),
    mean_ticks_raw: round4(mean),
    win_prob: round4(acc.sumWWins / acc.sumW),
    std_ticks: round4(std),
  };
}

function finalizeBucket(acc) {
  return {
    n: Math.round(acc.rowsW),
    per_horizon: {
      1: finalizePerHorizon(acc.per_horizon[1]),
      3: finalizePerHorizon(acc.per_horizon[3]),
      5: finalizePerHorizon(acc.per_horizon[5]),
    },
  };
}

function finalizeBucketMap(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = finalizeBucket(v);
  }
  return out;
}

// ── CSV parser (tight, no deps) ────────────────────────────────────────────

/**
 * Parse a well-formed CSV into an array of row-objects keyed by header.
 * Values are strings — the caller parses numerics as needed.
 *
 * The parser handles:
 *   - \n or \r\n line endings
 *   - empty cells (preserved as empty string)
 *   - quoted fields containing commas (double-quote escape)
 *
 * The Phase 4.3 CSV emitter does NOT quote fields, so this is a
 * defensive implementation for stability across future revisions.
 */
function parseCsv(raw) {
  // Normalize line endings
  const text = raw.replace(/\r\n?/g, '\n');
  const rows = [];
  let i = 0;
  let field = '';
  let row = [];
  let inQuote = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0];
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue; // blank line
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = cells[c] ?? '';
    }
    records.push(obj);
  }
  return { header, records };
}

function parseFloatOrNull(s) {
  if (s === undefined || s === null || s === '') return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

function parseBoolStrict(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    in: 'data/lob_mbo_scalp_dataset.csv',
    out: 'reports/ml/lob_mbo_scalp/expectancy_buckets.json',
    minN: MIN_BUCKET_SAMPLES_DEFAULT,
    tickSize: 0.25,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in' && i + 1 < argv.length) args.in = argv[++i];
    else if (a === '--out' && i + 1 < argv.length) args.out = argv[++i];
    else if (a === '--min-n' && i + 1 < argv.length) args.minN = Number(argv[++i]);
    else if (a === '--tick-size' && i + 1 < argv.length) args.tickSize = Number(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: node scripts/build-scalper-expectancy-bucket-table.mjs ' +
          '[--in PATH] [--out PATH] [--min-n N] [--tick-size F]',
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.minN) || args.minN < 1) {
    console.error(`[error] invalid --min-n: ${args.minN}`);
    process.exit(1);
  }
  if (!Number.isFinite(args.tickSize) || args.tickSize <= 0) {
    console.error(`[error] invalid --tick-size: ${args.tickSize}`);
    process.exit(1);
  }
  return args;
}

/**
 * The core builder, exposed for testing. Given already-parsed CSV
 * records (as row-objects) and the two numeric knobs, returns the
 * bucket table JSON object. Pure — no fs, no stdout.
 */
export function buildScalperBucketTable({ records, minN, tickSize }) {
  const accFull = {};
  const acc1d = {};
  const acc2d = {};
  const accSide = { long: emptyBucketAcc(), short: emptyBucketAcc() };

  let usedRows = 0;
  let skippedWeight = 0;
  let skippedGate = 0;
  let skippedDir = 0;

  for (const row of records) {
    const direction = row.direction;
    if (direction !== 'long' && direction !== 'short') {
      skippedDir++;
      continue;
    }

    // Skip rows that did not clear the deterministic + persistence gates.
    // This is the Phase 5 rule that expectancy is trained on post-gate
    // candidates only — we never learn the EV of rejected geometry.
    const allGatesPassed = parseBoolStrict(row.all_gates_passed);
    if (allGatesPassed !== true) {
      skippedGate++;
      continue;
    }

    // Sample-weight: fail-closed passthrough.
    const sampleWeightStr = row.sample_weight;
    const sampleWeight = parseFloatOrNull(sampleWeightStr);
    if (sampleWeight === null || sampleWeight <= 0) {
      skippedWeight++;
      continue;
    }

    const mpEdge = parseFloatOrNull(row.microprice_edge_ticks);
    const zOfi1s = parseFloatOrNull(row.z_ofi_1s);
    const qi5 = parseFloatOrNull(row.qi_5);

    // Per-horizon forward returns in POINTS — convert to ticks and sign.
    const rawFwd1 = parseFloatOrNull(row.fwd_return_1s_pts);
    const rawFwd3 = parseFloatOrNull(row.fwd_return_3s_pts);
    const rawFwd5 = parseFloatOrNull(row.fwd_return_5s_pts);
    const sign = direction === 'long' ? 1 : -1;
    const signedTicks = (pts) => (pts == null ? null : round4((pts / tickSize) * sign));
    const fwdTicks1 = signedTicks(rawFwd1);
    const fwdTicks3 = signedTicks(rawFwd3);
    const fwdTicks5 = signedTicks(rawFwd5);

    const anyLabel =
      (fwdTicks1 != null && Number.isFinite(fwdTicks1)) ||
      (fwdTicks3 != null && Number.isFinite(fwdTicks3)) ||
      (fwdTicks5 != null && Number.isFinite(fwdTicks5));
    if (!anyLabel) continue;

    usedRows++;

    const bins = {
      microprice_edge: binIndex(mpEdge, MICROPRICE_EDGE_BIN_EDGES),
      z_ofi_1s: binIndex(zOfi1s, Z_OFI_1S_BIN_EDGES),
      qi_5: binIndex(qi5, QI_5_BIN_EDGES),
    };

    const pushRow = (acc) => {
      let any = false;
      any = pushHorizon(acc.per_horizon[1], sampleWeight, fwdTicks1) || any;
      any = pushHorizon(acc.per_horizon[3], sampleWeight, fwdTicks3) || any;
      any = pushHorizon(acc.per_horizon[5], sampleWeight, fwdTicks5) || any;
      if (any) acc.rowsW += sampleWeight;
    };

    pushRow(accSide[direction]);

    if (bins.microprice_edge !== null && bins.z_ofi_1s !== null && bins.qi_5 !== null) {
      const key = buildBucketKey(direction, {
        microprice_edge: bins.microprice_edge,
        z_ofi_1s: bins.z_ofi_1s,
        qi_5: bins.qi_5,
      });
      pushRow((accFull[key] ??= emptyBucketAcc()));
    }

    const drop1 = BACKOFF_ORDER[0];
    const dims1 = {};
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
      const key = buildBucketKey(direction, dims1);
      pushRow((acc1d[key] ??= emptyBucketAcc()));
    }

    const drop2a = BACKOFF_ORDER[0];
    const drop2b = BACKOFF_ORDER[1];
    const dims2 = {};
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
      const key = buildBucketKey(direction, dims2);
      pushRow((acc2d[key] ??= emptyBucketAcc()));
    }
  }

  const longPrior = finalizeBucket(accSide.long);
  const shortPrior = finalizeBucket(accSide.short);

  return {
    table: {
      schema_version: SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      source_row_count: usedRows,
      min_bucket_samples: minN,
      horizons_sec: HORIZONS_SEC,
      dimensions: DIMENSIONS,
      backoff_order: BACKOFF_ORDER,
      microprice_edge_bin_edges: MICROPRICE_EDGE_BIN_EDGES,
      z_ofi_1s_bin_edges: Z_OFI_1S_BIN_EDGES,
      qi_5_bin_edges: QI_5_BIN_EDGES,
      buckets_full: finalizeBucketMap(accFull),
      buckets_backoff_1d: finalizeBucketMap(acc1d),
      buckets_backoff_2d: finalizeBucketMap(acc2d),
      side_prior: {
        long: longPrior.n > 0 ? { ...longPrior, direction: 'long' } : null,
        short: shortPrior.n > 0 ? { ...shortPrior, direction: 'short' } : null,
      },
    },
    stats: {
      usedRows,
      skippedWeight,
      skippedGate,
      skippedDir,
    },
  };
}

function main() {
  const args = parseArgs(process.argv);

  const inPath = resolve(args.in);
  if (!existsSync(inPath)) {
    console.error(`[error] input not found: ${inPath}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = readFileSync(inPath, 'utf8');
  } catch (err) {
    console.error(`[error] cannot read ${inPath}: ${err && err.message}`);
    process.exit(1);
  }
  const { header, records } = parseCsv(raw);

  const required = [
    'direction',
    'all_gates_passed',
    'sample_weight',
    'microprice_edge_ticks',
    'z_ofi_1s',
    'qi_5',
    'fwd_return_1s_pts',
    'fwd_return_3s_pts',
    'fwd_return_5s_pts',
  ];
  for (const col of required) {
    if (!header.includes(col)) {
      console.error(`[error] input header missing required column: ${col}`);
      process.exit(1);
    }
  }

  const { table, stats } = buildScalperBucketTable({ records, minN: args.minN, tickSize: args.tickSize });

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    writeFileSync(outPath, JSON.stringify(table, null, 2));
  } catch (err) {
    console.error(`[error] cannot write ${outPath}: ${err && err.message}`);
    process.exit(1);
  }

  const fullCount = Object.keys(table.buckets_full).length;
  const backoff1Count = Object.keys(table.buckets_backoff_1d).length;
  const backoff2Count = Object.keys(table.buckets_backoff_2d).length;
  console.log(
    `[ok] wrote ${outPath} — used=${stats.usedRows} ` +
      `(skipped: gate=${stats.skippedGate} weight=${stats.skippedWeight} dir=${stats.skippedDir}) ` +
      `buckets: full=${fullCount} 1d=${backoff1Count} 2d=${backoff2Count}`,
  );
}

// Run when invoked as a script (not when imported from tests).
// Use fileURLToPath so the comparison is robust on Windows where the
// native path uses backslashes and file:// URLs use forward slashes
// plus an extra leading slash for drive letters.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main();
}
