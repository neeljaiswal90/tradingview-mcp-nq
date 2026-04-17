import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'analysis', 'check-scalper-shadow-health.mjs');

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scalper-shadow-health-'));
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

function runHealth(repoRoot: string, target: string): Record<string, unknown> {
  const result = spawnSync(
    'node',
    [SCRIPT_PATH, target],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'shadow health script failed');
  }
  return JSON.parse(result.stdout);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-scalper-shadow-health.mjs', () => {
  it('reports artifact readiness and row summaries from scalper candidate logs', () => {
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
    writeFileSync(
      join(repoRoot, 'logs-mnq', 'lob_mbo_scalp_candidates.jsonl'),
      [
        JSON.stringify({ meta: true, schema_version: '1.0' }),
        JSON.stringify({
          ts_ms: 1,
          direction: 'long',
          setup_type: 'lob_mbo_scalp_long',
          setup_family: 'lob_mbo_scalp',
          all_gates_passed: false,
          reject_stage: 'ml',
          reject_reason: 'ml_unavailable',
          ml_ready: false,
          expectancy_ready: true,
          sample_weight: 2,
        }),
        JSON.stringify({
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
        }),
      ].join('\n'),
      'utf8',
    );

    const report = runHealth(repoRoot, join(repoRoot, 'logs-mnq'));
    const summary = report['summary'] as Record<string, unknown>;
    const totals = summary['totals'] as Record<string, unknown>;
    const artifactHealth = report['artifact_health'] as Record<string, unknown>;
    const modelArtifacts = artifactHealth['model_artifacts'] as Record<string, unknown>;

    expect(report['files_found']).toBe(1);
    expect(totals['rows_raw']).toBe(2);
    expect(totals['rows_weighted']).toBe(3);
    expect(totals['allowed_raw']).toBe(1);
    expect(totals['rejected_weighted']).toBe(2);
    expect(modelArtifacts['status']).toBe('ready');
    expect((artifactHealth['expectancy_bucket_table'] as Record<string, unknown>)['status']).toBe('ready');
  });
});
