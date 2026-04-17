import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'analysis', 'check-scalper-rollout-gate.mjs');

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scalper-rollout-gate-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'logs-mnq'), { recursive: true });
  return dir;
}

function writeIndicatorConfig(repoRoot: string, expectancyPath: string): void {
  writeFileSync(
    join(repoRoot, 'config', 'indicator-config.json'),
    JSON.stringify({
      lob_mbo_scalp: {
        expectancy_bucket_table_path: expectancyPath,
        hybrid_gate: false,
      },
    }),
    'utf8',
  );
}

function writeRows(repoRoot: string, rows: Record<string, unknown>[]): void {
  writeFileSync(
    join(repoRoot, 'logs-mnq', 'lob_mbo_scalp_candidates.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n'),
    'utf8',
  );
}

function runGate(repoRoot: string, target: string, extraArgs: string[] = []): Record<string, unknown> {
  const result = spawnSync(
    'node',
    [SCRIPT_PATH, target, ...extraArgs],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'rollout gate script failed');
  }
  return JSON.parse(result.stdout);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-scalper-rollout-gate.mjs', () => {
  it('fails closed when artifacts are missing and readiness counts are zero', () => {
    const repoRoot = makeTempRepo();
    writeIndicatorConfig(repoRoot, 'reports/ml/lob_mbo_scalp/expectancy_buckets.json');
    writeRows(repoRoot, [
      { meta: true, schema_version: '1.0' },
      {
        ts_ms: 1,
        direction: 'long',
        setup_type: 'lob_mbo_scalp_long',
        setup_family: 'lob_mbo_scalp',
        all_gates_passed: false,
        reject_stage: 'expectancy',
        reject_reason: 'expectancy_no_bucket_match',
        ml_ready: false,
        expectancy_ready: false,
        sample_weight: 1,
      },
    ]);

    const report = runGate(repoRoot, join(repoRoot, 'logs-mnq'), [
      '--min-rows', '1',
      '--min-expectancy-ready', '1',
      '--min-ml-ready', '1',
      '--min-allowed', '1',
    ]);
    const rolloutGate = report['rollout_gate'] as Record<string, unknown>;
    const reasons = rolloutGate['reasons'] as string[];

    expect(rolloutGate['stage_a_to_b_eligible']).toBe(false);
    expect(reasons.some((reason) => reason.startsWith('expectancy_bucket_table:'))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith('model_artifacts:'))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith('ml_ready_below_threshold:'))).toBe(true);
  });

  it('declares eligibility when artifacts and thresholded shadow evidence are present', () => {
    const repoRoot = makeTempRepo();
    writeIndicatorConfig(repoRoot, 'reports/ml/lob_mbo_scalp/expectancy_buckets.json');
    mkdirSync(join(repoRoot, 'reports', 'ml', 'lob_mbo_scalp'), { recursive: true });
    writeFileSync(join(repoRoot, 'reports', 'ml', 'lob_mbo_scalp', 'expectancy_buckets.json'), '{}', 'utf8');
    mkdirSync(join(repoRoot, 'models', 'lob_mbo_scalp', 'versions', '2026-04-17T120000Z'), {
      recursive: true,
    });
    for (const fileName of [
      'long_1s_coefs.json',
      'long_3s_coefs.json',
      'long_5s_coefs.json',
      'short_1s_coefs.json',
      'short_3s_coefs.json',
      'short_5s_coefs.json',
    ]) {
      writeFileSync(
        join(repoRoot, 'models', 'lob_mbo_scalp', 'versions', '2026-04-17T120000Z', fileName),
        '{}',
        'utf8',
      );
    }
    writeRows(repoRoot, [
      { meta: true, schema_version: '1.0' },
      {
        ts_ms: 1,
        direction: 'long',
        setup_type: 'lob_mbo_scalp_long',
        setup_family: 'lob_mbo_scalp',
        all_gates_passed: true,
        reject_stage: 'emission',
        reject_reason: 'allowed',
        ml_ready: true,
        expectancy_ready: true,
        sample_weight: 1,
      },
      {
        ts_ms: 2,
        direction: 'short',
        setup_type: 'lob_mbo_scalp_short',
        setup_family: 'lob_mbo_scalp',
        all_gates_passed: true,
        reject_stage: 'emission',
        reject_reason: 'allowed',
        ml_ready: true,
        expectancy_ready: true,
        sample_weight: 1,
      },
    ]);

    const report = runGate(repoRoot, join(repoRoot, 'logs-mnq'), [
      '--min-rows', '2',
      '--min-expectancy-ready', '2',
      '--min-ml-ready', '2',
      '--min-allowed', '2',
    ]);
    const rolloutGate = report['rollout_gate'] as Record<string, unknown>;

    expect(rolloutGate['stage_a_to_b_eligible']).toBe(true);
    expect(rolloutGate['reasons']).toEqual([]);
  });
});
