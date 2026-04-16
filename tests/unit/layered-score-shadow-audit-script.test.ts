import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'layered-audit-'));
  tempDirs.push(dir);
  return dir;
}

function runAudit(targetPath: string): Record<string, unknown> {
  const result = spawnSync(
    'python',
    ['scripts/analysis/layered_score_shadow_audit.py', targetPath],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'audit script failed');
  }

  return JSON.parse(result.stdout);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('layered score shadow audit source selection', () => {
  it('uses candidate_scores_v2.jsonl when structured rows are present', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'candidate_scores_v2.jsonl'),
      JSON.stringify({
        strategy_id: 'trend_pullback_long',
        direction: 'long',
        raw_flat_score: 8.1,
        layered_shadow_score: 7.4,
        structure_score: 0.7,
        timing_score: 0.6,
        payoff_score: 0.5,
        hard_gate_pass: true,
      }) + '\n',
      'utf8',
    );

    const report = runAudit(dir);
    expect(report['source']).toBe('candidate_scores_v2');
    expect(report['total_records']).toBe(1);
  });

  it('falls back to legacy console rows when JSONL is absent', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'runner.log'),
      '[LAYERED_SHADOW] LONG trend_pullback_long old_score=8.10 new_rank=7.40 structure=6.10 flow=1.20(q=good) lagging=0.80 profile=trend_pullback(s=0.60,f=0.40) trend_cap=1.00->0.90 flow_features=[ofi,depth] flow_degradation=[none]\n',
      'utf8',
    );

    const report = runAudit(dir);
    expect(report['source']).toBe('legacy_console');
    expect(report['total_records']).toBe(1);
  });

  it('prefers JSONL over legacy console rows when both are present', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'candidate_scores_v2.jsonl'),
      JSON.stringify({
        strategy_id: 'trend_pullback_long',
        direction: 'long',
        raw_flat_score: 8.1,
        layered_shadow_score: 7.4,
        structure_score: 0.7,
        timing_score: 0.6,
        payoff_score: 0.5,
        hard_gate_pass: true,
      }) + '\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'runner.log'),
      '[LAYERED_SHADOW] LONG trend_pullback_long old_score=8.10 new_rank=7.90 structure=6.10 flow=1.20(q=good) lagging=0.80 profile=trend_pullback(s=0.60,f=0.40) trend_cap=1.00->0.90 flow_features=[ofi,depth] flow_degradation=[none]\n',
      'utf8',
    );

    const report = runAudit(dir);
    expect(report['source']).toBe('candidate_scores_v2');
    expect(report['total_records']).toBe(1);
    const allCandidates = report['all_candidates'] as Record<string, unknown>;
    expect(allCandidates['old_score_dist']).toBeTruthy();
  });
});
