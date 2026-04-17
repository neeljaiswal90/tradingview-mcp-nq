import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

const SCRIPT_FILES = [
  'scripts/bootstrap-scalper-readiness-artifacts.mjs',
  'scripts/_scalper-exclusion.mjs',
  'scripts/lob-mbo-forward-labeler.mjs',
  'scripts/run-lob-mbo-forward-labeler.mjs',
  'scripts/build-scalper-expectancy-bucket-table.mjs',
  'scripts/analysis/scalper-rollout-lib.mjs',
  'scripts/analysis/check-scalper-shadow-health.mjs',
  'scripts/analysis/check-scalper-rollout-gate.mjs',
  'scripts/ml/_scalper_exclusion.py',
  'scripts/ml/build_lob_mbo_scalp_dataset.py',
  'scripts/ml/train_logistic_lob_mbo_scalp.py',
];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scalper-readiness-artifacts-'));
  tempDirs.push(dir);

  for (const relativePath of SCRIPT_FILES) {
    const source = join(process.cwd(), relativePath);
    const target = join(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }

  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'inputs'), { recursive: true });
  mkdirSync(join(dir, 'logs-mnq'), { recursive: true });

  writeFileSync(
    join(dir, 'config', 'indicator-config.json'),
    JSON.stringify({
      lob_mbo_scalp: {
        expectancy_bucket_table_path: 'reports/ml/lob_mbo_scalp/expectancy_buckets.json',
        hybrid_gate: false,
      },
    }, null, 2),
    'utf8',
  );

  return dir;
}

function generateSyntheticArtifactSources(repoRoot: string): void {
  const candidateRows: Record<string, unknown>[] = [
    { meta: true, schema_version: '1.0', rejection_sample_rate: 1 },
  ];
  const tickRows: Record<string, unknown>[] = [];
  const baseTs = 1_776_409_000_000;

  for (let index = 0; index < 120; index += 1) {
    const direction = index < 60 ? 'long' : 'short';
    const directionIndex = index < 60 ? index : index - 60;
    const positive = directionIndex % 2 === 0;
    const tsMs = baseTs + index * 7_000;
    const entryMid = 20_000 + index * 0.25;

    let qi5: number;
    let edge: number;
    let zofi: number;
    let endMid: number;
    if (direction === 'long') {
      qi5 = positive ? 0.65 : -0.65;
      edge = positive ? 0.8 : -0.8;
      zofi = positive ? 1.4 : -1.4;
      endMid = entryMid + (positive ? 1.0 : -1.0);
    } else {
      qi5 = positive ? -0.65 : 0.65;
      edge = positive ? -0.8 : 0.8;
      zofi = positive ? -1.4 : 1.4;
      endMid = entryMid + (positive ? -1.0 : 1.0);
    }

    candidateRows.push({
      ts_ms: tsMs,
      setup_type: `lob_mbo_scalp_${direction}`,
      setup_family: 'lob_mbo_scalp',
      direction,
      all_gates_passed: true,
      reject_stage: 'emission',
      reject_reason: 'allowed',
      expectancy_ready: false,
      ml_ready: false,
      sample_weight: 1,
      deterministic_verdict: { passed: true, rejectReason: null },
      persistence_verdict: { passed: true, rejectReason: null, ageMs: 250 },
      scalper_state_vector: {
        qi1: qi5 * 0.7,
        qi3: qi5 * 0.85,
        qi5,
        microprice: entryMid,
        micropriceEdgeTicks: edge,
        ofi250ms: zofi * 10,
        ofi1s: zofi * 12,
        ofi3s: zofi * 9,
        zOfi250ms: zofi * 0.8,
        zOfi1s: zofi,
        zOfi3s: zofi * 0.75,
        afi250ms: zofi * 0.4,
        afi1s: zofi * 0.5,
        afi3s: zofi * 0.35,
        hazardBid1s: direction === 'long' ? 0.15 : 0.05,
        hazardAsk1s: direction === 'long' ? 0.05 : 0.15,
        absBid1s: direction === 'long' ? 20 : 8,
        absAsk1s: direction === 'long' ? 8 : 20,
        refillBid1s: direction === 'long' ? 12 : 5,
        refillAsk1s: direction === 'long' ? 5 : 12,
        sigma1sTicks: 1.5,
        spreadTicks: 1.0,
        bidPx: [entryMid - 0.125],
        askPx: [entryMid + 0.125],
      },
    });

    for (const [step, fraction] of [0.2, 0.4, 0.6, 0.8, 1.0].entries()) {
      const mid = entryMid + (endMid - entryMid) * fraction;
      tickRows.push({
        ts_ms: tsMs + (step + 1) * 1_000,
        bid: Math.round((mid - 0.125) * 10_000) / 10_000,
        ask: Math.round((mid + 0.125) * 10_000) / 10_000,
        bid_sz: 5 + (index % 3),
        ask_sz: 4 + (index % 2),
      });
    }
  }

  writeFileSync(
    join(repoRoot, 'inputs', 'lob_mbo_scalp_candidates.jsonl'),
    candidateRows.map((row) => JSON.stringify(row)).join('\n'),
    'utf8',
  );
  writeFileSync(
    join(repoRoot, 'inputs', 'lob_top_of_book.jsonl'),
    tickRows.map((row) => JSON.stringify(row)).join('\n'),
    'utf8',
  );
}

function writeReadinessProofLog(repoRoot: string): void {
  const rows: Record<string, unknown>[] = [
    { meta: true, schema_version: '1.0' },
  ];
  const baseTs = 1_776_409_000_000;
  for (let index = 0; index < 120; index += 1) {
    const direction = index < 60 ? 'long' : 'short';
    const allowed = index % 3 === 0;
    rows.push({
      ts_ms: baseTs + index * 7_000,
      direction,
      setup_type: `lob_mbo_scalp_${direction}`,
      setup_family: 'lob_mbo_scalp',
      all_gates_passed: allowed,
      reject_stage: allowed ? 'emission' : 'ml',
      reject_reason: allowed ? 'allowed' : 'ml_below_threshold',
      ml_ready: true,
      expectancy_ready: true,
      sample_weight: 1,
    });
  }

  writeFileSync(
    join(repoRoot, 'logs-mnq', 'lob_mbo_scalp_candidates.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n'),
    'utf8',
  );
}

function runJson(cwd: string, command: string, args: string[]): Record<string, unknown> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('bootstrap-scalper-readiness-artifacts', () => {
  it('builds repo-local scalper artifacts and leaves the rollout gate blocked only on low sample volume', { timeout: 120_000 }, () => {
    const repoRoot = makeTempRepo();
    generateSyntheticArtifactSources(repoRoot);

    const bootstrap = spawnSync(
      'node',
      [
        'scripts/bootstrap-scalper-readiness-artifacts.mjs',
        '--repo-root', repoRoot,
        '--candidates', join(repoRoot, 'inputs', 'lob_mbo_scalp_candidates.jsonl'),
        '--ticks', join(repoRoot, 'inputs', 'lob_top_of_book.jsonl'),
        '--min-rows', '20',
        '--min-per-class', '10',
        '--threshold', '0.5',
        '--seed', '42',
        '--train-frac', '0.8',
        '--l2', '1.0',
        '--enforce-sample-weight',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );

    if (bootstrap.status !== 0) {
      throw new Error(bootstrap.stderr || bootstrap.stdout || 'bootstrap script failed');
    }

    writeReadinessProofLog(repoRoot);

    const health = runJson(
      repoRoot,
      'node',
      ['scripts/analysis/check-scalper-shadow-health.mjs', join(repoRoot, 'logs-mnq')],
    );
    const gate = runJson(
      repoRoot,
      'node',
      ['scripts/analysis/check-scalper-rollout-gate.mjs', join(repoRoot, 'logs-mnq')],
    );

    const artifactHealth = health['artifact_health'] as Record<string, unknown>;
    expect((artifactHealth['expectancy_bucket_table'] as Record<string, unknown>)['status']).toBe('ready');
    expect((artifactHealth['model_artifacts'] as Record<string, unknown>)['status']).toBe('ready');

    const totals = (health['summary'] as Record<string, unknown>)['totals'] as Record<string, unknown>;
    expect(totals['rows_raw']).toBe(120);
    expect(totals['expectancy_ready_raw']).toBe(120);
    expect(totals['ml_ready_raw']).toBe(120);
    expect(totals['allowed_raw']).toBe(40);

    const rolloutGate = gate['rollout_gate'] as Record<string, unknown>;
    expect(rolloutGate['stage_a_to_b_eligible']).toBe(false);
    expect(rolloutGate['reasons']).toEqual(['rows_raw_below_threshold:120<1000']);
  });
});
