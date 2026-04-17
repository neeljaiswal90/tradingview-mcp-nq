import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'analysis', 'check-scalper-candidate-capture.mjs');

function makeTempLogDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'scalper-candidate-capture-'));
  tempDirs.push(root);
  const logDir = join(root, 'logs-mnq');
  mkdirSync(logDir, { recursive: true });
  return logDir;
}

function runCaptureCheck(targetPath: string): Record<string, unknown> {
  const result = spawnSync(
    'node',
    [SCRIPT_PATH, targetPath],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'candidate capture script failed');
  }
  return JSON.parse(result.stdout);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-scalper-candidate-capture.mjs', () => {
  it('surfaces scalper generator rejection reasons from signal diagnostics', () => {
    const logDir = makeTempLogDir();
    writeFileSync(
      join(logDir, 'signals.jsonl'),
      [
        JSON.stringify({
          signal_id: 'SIG_1',
          candidate_diagnostics: [
            {
              setup_type: 'lob_mbo_scalp_long',
              setup_family: 'lob_mbo_scalp',
              accepted: false,
              rejection_reason_primary: 'no_scalp_state',
              rejection_reason_all: ['no_scalp_state'],
            },
            {
              setup_type: 'lob_mbo_scalp_short',
              setup_family: 'lob_mbo_scalp',
              accepted: false,
              rejection_reason_primary: 'no_scalp_state',
              rejection_reason_all: ['no_scalp_state'],
            },
          ],
        }),
      ].join('\n'),
      'utf8',
    );

    const report = runCaptureCheck(logDir);
    expect(report['likely_blocker']).toBe('scalper_generator:no_scalp_state');
    const signalSummary = report['signal_summary'] as Record<string, unknown>;
    expect(signalSummary['signals_with_candidate_diagnostics']).toBe(1);
    expect((signalSummary['scalper_rejection_reasons'] as Record<string, unknown>)['no_scalp_state']).toBe(2);
  });

  it('falls back to snapshot coverage when signals lack candidate diagnostics', () => {
    const logDir = makeTempLogDir();
    writeFileSync(
      join(logDir, 'lob_session_snapshots.jsonl'),
      [
        JSON.stringify({
          timestamp_ms: 1,
          data_quality: 'full_depth',
          recording_context: 'session',
          bid: 20000,
          ask: 20000.25,
        }),
        JSON.stringify({
          timestamp_ms: 2,
          data_quality: 'full_depth',
          recording_context: 'session',
          bid: 20000.25,
          ask: 20000.5,
        }),
      ].join('\n'),
      'utf8',
    );

    const report = runCaptureCheck(logDir);
    expect(report['likely_blocker']).toBe('sidecar_snapshot_missing_scalp_state');
    const snapshotSummary = report['snapshot_summary'] as Record<string, unknown>;
    expect(snapshotSummary['snapshots_with_scalp_state']).toBe(0);
    expect(snapshotSummary['snapshots_without_scalp_state']).toBe(2);
  });
});
