/**
 * Tests for scripts/build-scalper-expectancy-bucket-table.mjs.
 *
 * Scope (Phase 5 parity lock):
 *
 *   1. Core builder (pure function exported from the .mjs) aggregates
 *      synthetic CSV records into the expected bucket shape.
 *   2. Rows where `all_gates_passed !== true` are dropped (Phase 5
 *      training rule — only post-gate candidates contribute to EV).
 *   3. Rows with missing / invalid sample_weight are dropped (fail-closed
 *      passthrough).
 *   4. Points → ticks conversion sign-flips for short rows (so bucket
 *      stats are always in "positive = favorable to direction").
 *   5. Output JSON matches the TS engine constants (schema_version, bin
 *      edges, backoff order, horizons) — proves the JS mirror has not
 *      drifted.
 *   6. End-to-end CSV pipeline: write a synthetic dataset to disk, run
 *      the mjs via node child_process, read the emitted JSON, assert
 *      top-level shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
// @ts-expect-error — plain .mjs module, no type defs; imported here only to
// exercise the pure builder function directly.
import { buildScalperBucketTable } from '../../scripts/build-scalper-expectancy-bucket-table.mjs';
import {
  SCALPER_EXPECTANCY_SCHEMA_VERSION,
  SCALPER_EXPECTANCY_BACKOFF_ORDER,
  SCALPER_MICROPRICE_EDGE_BIN_EDGES,
  SCALPER_Z_OFI_1S_BIN_EDGES,
  SCALPER_QI_5_BIN_EDGES,
} from '../../src/autotrade/features/scalper-expectancy-engine.js';

type Record_ = Record<string, string>;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scalper-bucket-builder-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRow(overrides: Partial<Record_>): Record_ {
  return {
    direction: 'long',
    all_gates_passed: 'true',
    sample_weight: '1',
    microprice_edge_ticks: '0.50',
    z_ofi_1s: '0.6',
    qi_5: '0.30',
    fwd_return_1s_pts: '0.25', // 1 tick at 0.25 tick size
    fwd_return_3s_pts: '0.50', // 2 ticks
    fwd_return_5s_pts: '0.375', // 1.5 ticks
    ...overrides,
  };
}

// ─── 1. Pure builder ───────────────────────────────────────────────────────

describe('buildScalperBucketTable: core aggregation', () => {
  it('aggregates 100 happy rows into a single full bucket with per-horizon means', () => {
    const records = Array.from({ length: 100 }, () => makeRow({}));
    const { table, stats } = buildScalperBucketTable({ records, minN: 30, tickSize: 0.25 });
    expect(stats.usedRows).toBe(100);
    expect(stats.skippedGate).toBe(0);
    expect(stats.skippedWeight).toBe(0);

    const keys = Object.keys(table.buckets_full);
    expect(keys.length).toBe(1);
    const bucket = table.buckets_full[keys[0]!] as {
      n: number;
      per_horizon: { 1: { mean_ticks_raw: number }; 3: { mean_ticks_raw: number }; 5: { mean_ticks_raw: number } };
    };
    expect(bucket.n).toBe(100);
    // Ticks: 0.25pts/0.25 = 1.0 tick, 0.50pts = 2.0 ticks, 0.375pts = 1.5 ticks
    expect(bucket.per_horizon[1].mean_ticks_raw).toBeCloseTo(1.0, 6);
    expect(bucket.per_horizon[3].mean_ticks_raw).toBeCloseTo(2.0, 6);
    expect(bucket.per_horizon[5].mean_ticks_raw).toBeCloseTo(1.5, 6);
  });

  it('drops rows where all_gates_passed !== "true"', () => {
    const records = [
      makeRow({ all_gates_passed: 'false' }),
      makeRow({ all_gates_passed: 'true' }),
      makeRow({ all_gates_passed: 'nope' }),
    ];
    const { stats } = buildScalperBucketTable({ records, minN: 1, tickSize: 0.25 });
    expect(stats.usedRows).toBe(1);
    expect(stats.skippedGate).toBe(2);
  });

  it('drops rows with missing or non-positive sample_weight', () => {
    const records = [
      makeRow({ sample_weight: '' }),
      makeRow({ sample_weight: 'NaN' }),
      makeRow({ sample_weight: '0' }),
      makeRow({ sample_weight: '-3' }),
      makeRow({ sample_weight: '2' }),
    ];
    const { stats } = buildScalperBucketTable({ records, minN: 1, tickSize: 0.25 });
    expect(stats.usedRows).toBe(1);
    expect(stats.skippedWeight).toBe(4);
  });

  it('applies sample_weight to the weighted mean and win_prob', () => {
    // Weight 5 on one row → mean should reflect weighting, not row count.
    const records = [
      makeRow({ sample_weight: '5', fwd_return_3s_pts: '0.5' }), // 2 ticks × weight 5
      makeRow({ sample_weight: '1', fwd_return_3s_pts: '0' }),    // 0 ticks × weight 1
    ];
    const { table } = buildScalperBucketTable({ records, minN: 1, tickSize: 0.25 });
    const bucket = Object.values(table.buckets_full)[0] as {
      per_horizon: { 3: { mean_ticks_raw: number; win_prob: number; n: number } };
    };
    // Weighted mean: (5*2 + 1*0) / (5+1) = 10/6 ≈ 1.667
    expect(bucket.per_horizon[3].mean_ticks_raw).toBeCloseTo(10 / 6, 4);
    // Win prob: 5 wins out of weight 6
    expect(bucket.per_horizon[3].win_prob).toBeCloseTo(5 / 6, 4);
  });

  it('sign-flips short rows so bucket stats are direction-signed', () => {
    // A short trade with fwd_return_3s_pts = -0.50 → favorable direction
    // → +2 ticks signed.
    const records = [
      makeRow({
        direction: 'short',
        microprice_edge_ticks: '-0.50',
        z_ofi_1s: '-0.6',
        qi_5: '-0.30',
        fwd_return_1s_pts: '-0.25',
        fwd_return_3s_pts: '-0.50',
        fwd_return_5s_pts: '-0.375',
      }),
    ];
    const { table } = buildScalperBucketTable({ records, minN: 1, tickSize: 0.25 });
    const bucket = Object.values(table.buckets_full)[0] as {
      per_horizon: { 3: { mean_ticks_raw: number; win_prob: number } };
    };
    expect(bucket.per_horizon[3].mean_ticks_raw).toBeCloseTo(2.0, 6);
    expect(bucket.per_horizon[3].win_prob).toBe(1);
  });

  it('builds backoff_1d buckets dropping z_ofi_1s', () => {
    const records = Array.from({ length: 60 }, () => makeRow({}));
    const { table } = buildScalperBucketTable({ records, minN: 30, tickSize: 0.25 });
    const keys1d = Object.keys(table.buckets_backoff_1d);
    expect(keys1d.length).toBe(1);
    // 1d key does NOT contain z_ofi_1s.
    expect(keys1d[0]!).not.toMatch(/z_ofi_1s/);
  });

  it('populates side_prior for every direction observed', () => {
    const records = [
      makeRow({ direction: 'long' }),
      makeRow({
        direction: 'short',
        microprice_edge_ticks: '-0.50',
        z_ofi_1s: '-0.6',
        qi_5: '-0.30',
        fwd_return_3s_pts: '-0.5',
      }),
    ];
    const { table } = buildScalperBucketTable({ records, minN: 1, tickSize: 0.25 });
    expect(table.side_prior.long).not.toBeNull();
    expect(table.side_prior.short).not.toBeNull();
  });
});

// ─── 2. Constants parity with TS engine ──────────────────────────────────

describe('buildScalperBucketTable: TS constants parity', () => {
  it('emits schema_version matching SCALPER_EXPECTANCY_SCHEMA_VERSION', () => {
    const { table } = buildScalperBucketTable({ records: [], minN: 30, tickSize: 0.25 });
    expect(table.schema_version).toBe(SCALPER_EXPECTANCY_SCHEMA_VERSION);
  });

  it('emits microprice_edge_bin_edges matching engine constant', () => {
    const { table } = buildScalperBucketTable({ records: [], minN: 30, tickSize: 0.25 });
    expect(table.microprice_edge_bin_edges).toEqual([...SCALPER_MICROPRICE_EDGE_BIN_EDGES]);
  });

  it('emits z_ofi_1s_bin_edges matching engine constant', () => {
    const { table } = buildScalperBucketTable({ records: [], minN: 30, tickSize: 0.25 });
    expect(table.z_ofi_1s_bin_edges).toEqual([...SCALPER_Z_OFI_1S_BIN_EDGES]);
  });

  it('emits qi_5_bin_edges matching engine constant', () => {
    const { table } = buildScalperBucketTable({ records: [], minN: 30, tickSize: 0.25 });
    expect(table.qi_5_bin_edges).toEqual([...SCALPER_QI_5_BIN_EDGES]);
  });

  it('emits backoff_order matching engine constant', () => {
    const { table } = buildScalperBucketTable({ records: [], minN: 30, tickSize: 0.25 });
    expect(table.backoff_order).toEqual([...SCALPER_EXPECTANCY_BACKOFF_ORDER]);
  });

  it('emits horizons_sec = [1,3,5]', () => {
    const { table } = buildScalperBucketTable({ records: [], minN: 30, tickSize: 0.25 });
    expect(table.horizons_sec).toEqual([1, 3, 5]);
  });
});

// ─── 3. End-to-end CLI invocation ─────────────────────────────────────────

describe('build-scalper-expectancy-bucket-table CLI', () => {
  function writeCsv(rows: Record_[]): string {
    const header = [
      'ts_ms',
      'setup_type',
      'setup_family',
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
    const lines: string[] = [header.join(',')];
    for (const r of rows) {
      lines.push(header.map((h) => r[h] ?? '').join(','));
    }
    const p = join(dir, 'dataset.csv');
    writeFileSync(p, lines.join('\n'));
    return p;
  }

  function runCli(inPath: string, outPath: string): string {
    const cliPath = join(process.cwd(), 'scripts', 'build-scalper-expectancy-bucket-table.mjs');
    return execFileSync('node', [cliPath, '--in', inPath, '--out', outPath, '--min-n', '1'], {
      encoding: 'utf8',
    });
  }

  it('reads a CSV, writes a bucket table, and reports stats on stdout', () => {
    const rows: Record_[] = [
      makeRow({ ts_ms: '1000', setup_type: 'lob_mbo_scalp_long', setup_family: 'lob_mbo_scalp' }),
      makeRow({
        ts_ms: '2000',
        setup_type: 'lob_mbo_scalp_long',
        setup_family: 'lob_mbo_scalp',
        all_gates_passed: 'false',
      }),
    ];
    const csvPath = writeCsv(rows);
    const outPath = join(dir, 'out.json');

    const output = runCli(csvPath, outPath);
    expect(output).toMatch(/used=1/);
    expect(output).toMatch(/gate=1/);
    expect(existsSync(outPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe(SCALPER_EXPECTANCY_SCHEMA_VERSION);
    expect(parsed['source_row_count']).toBe(1);
    expect(Array.isArray(parsed['horizons_sec'])).toBe(true);
    expect((parsed['horizons_sec'] as number[])).toEqual([1, 3, 5]);
  });

  it('exits 1 and errors when required columns are missing', () => {
    const csvPath = join(dir, 'bad.csv');
    writeFileSync(csvPath, 'direction,missing\nlong,x\n');
    const cliPath = join(process.cwd(), 'scripts', 'build-scalper-expectancy-bucket-table.mjs');
    let threw = false;
    try {
      execFileSync('node', [cliPath, '--in', csvPath, '--out', join(dir, 'out.json')], {
        encoding: 'utf8',
      });
    } catch (err) {
      threw = true;
      const stderr = (err as { stderr?: string }).stderr ?? '';
      expect(stderr).toMatch(/missing required column/);
    }
    expect(threw).toBe(true);
  });
});
