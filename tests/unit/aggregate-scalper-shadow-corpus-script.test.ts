import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'analysis', 'aggregate-scalper-shadow-corpus.mjs');

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scalper-corpus-aggregate-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.runtime'), { recursive: true });
  return dir;
}

function writeJsonl(path: string, rows: Record<string, unknown>[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
}

function writePairedSession(
  repoRoot: string,
  relativeDir: string,
  candidateRows: Record<string, unknown>[],
  tickRows: Record<string, unknown>[],
): void {
  const dir = join(repoRoot, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'lob_mbo_scalp_candidates.jsonl'),
    candidateRows.map((row) => JSON.stringify(row)).join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'lob_top_of_book.jsonl'),
    tickRows.map((row) => JSON.stringify(row)).join('\n'),
    'utf8',
  );
}

function runScript(repoRoot: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    'node',
    [SCRIPT_PATH, '--repo-root', repoRoot, '--search-root', '.runtime', ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('aggregate-scalper-shadow-corpus.mjs', () => {
  it('builds a sorted MNQ-only corpus from paired sessions and records skipped unpaired dirs', () => {
    const repoRoot = makeTempRepo();

    writePairedSession(
      repoRoot,
      '.runtime/session-a/logs-mnq',
      [
        { meta: true, schema_version: '1.0', rejection_sample_rate: 1 },
        { ts_ms: 20, setup_type: 'lob_mbo_scalp_long', setup_family: 'lob_mbo_scalp', direction: 'long' },
        { ts_ms: 10, setup_type: 'lob_mbo_scalp_short', setup_family: 'lob_mbo_scalp', direction: 'short' },
      ],
      [
        { ts_ms: 20, bid: 100.0, ask: 100.25, bid_sz: 2, ask_sz: 3 },
        { ts_ms: 10, bid: 99.75, ask: 100.0, bid_sz: 1, ask_sz: 2 },
      ],
    );

    writePairedSession(
      repoRoot,
      '.runtime/session-b/logs-mnq',
      [
        { meta: true, schema_version: '1.0', rejection_sample_rate: 1 },
        { ts_ms: 30, setup_type: 'lob_mbo_scalp_long', setup_family: 'lob_mbo_scalp', direction: 'long' },
      ],
      [
        { ts_ms: 30, bid: 100.25, ask: 100.5, bid_sz: 5, ask_sz: 4 },
      ],
    );

    writePairedSession(
      repoRoot,
      '.runtime/session-c/logs-mes',
      [
        { meta: true, schema_version: '1.0', rejection_sample_rate: 1 },
        { ts_ms: 40, setup_type: 'lob_mbo_scalp_long', setup_family: 'lob_mbo_scalp', direction: 'long' },
      ],
      [
        { ts_ms: 40, bid: 50.0, ask: 50.25, bid_sz: 5, ask_sz: 4 },
      ],
    );

    const unpairedDir = join(repoRoot, '.runtime', 'session-d', 'logs-mnq');
    mkdirSync(unpairedDir, { recursive: true });
    writeFileSync(
      join(unpairedDir, 'lob_mbo_scalp_candidates.jsonl'),
      [JSON.stringify({ meta: true }), JSON.stringify({ ts_ms: 50, setup_type: 'lob_mbo_scalp_long', setup_family: 'lob_mbo_scalp', direction: 'long' })].join('\n'),
      'utf8',
    );

    const result = runScript(repoRoot, ['--instrument', 'MNQ', '--out-dir', '.runtime/scalper-corpus/mnq']);
    expect(result.status).toBe(0);

    const summary = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(summary['paired_session_count']).toBe(2);
    expect(summary['candidate_rows']).toBe(3);
    expect(summary['tick_rows']).toBe(3);
    expect(summary['skipped_unpaired_candidate_dirs']).toEqual([
      { dir: '.runtime/session-d/logs-mnq', instrument: 'MNQ' },
    ]);

    const aggregatedCandidates = readFileSync(
      join(repoRoot, '.runtime', 'scalper-corpus', 'mnq', 'lob_mbo_scalp_candidates.jsonl'),
      'utf8',
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(aggregatedCandidates[0].meta).toBe(true);
    expect(aggregatedCandidates.slice(1).map((row) => row.ts_ms)).toEqual([10, 20, 30]);

    const aggregatedTicks = readFileSync(
      join(repoRoot, '.runtime', 'scalper-corpus', 'mnq', 'lob_top_of_book.jsonl'),
      'utf8',
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(aggregatedTicks.map((row) => row.ts_ms)).toEqual([10, 20, 30]);

    const manifest = JSON.parse(
      readFileSync(join(repoRoot, '.runtime', 'scalper-corpus', 'mnq', 'corpus_manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['paired_session_count']).toBe(2);
  });

  it('fails clearly when no paired sessions are present', () => {
    const repoRoot = makeTempRepo();
    const result = runScript(repoRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no paired scalper sessions found');
  });
});
