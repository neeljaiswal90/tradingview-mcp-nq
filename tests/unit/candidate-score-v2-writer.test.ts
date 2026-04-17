import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  formatCandidateScoreV2StatusLine,
  LogWriter,
} from '../../src/autotrade/log-writer.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-score-v2-writer-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('LogWriter candidate_scores_v2 lifecycle', () => {
  it('reports never_opened before any score-v2 row is written', () => {
    const logDir = makeTempDir();
    const writer = new LogWriter(logDir);

    const status = writer.getCandidateScoreV2Status();
    expect(status.state).toBe('never_opened');
    expect(status.file_exists).toBe(false);
    expect(status.buffered_rows).toBe(0);
    expect(status.flushed_rows).toBe(0);
  });

  it('touches the file on first row and flushes it on destroy', () => {
    const logDir = makeTempDir();
    const writer = new LogWriter(logDir);
    const candidatePath = join(logDir, 'candidate_scores_v2.jsonl');

    writer.writeCandidateScoreV2({
      symbol: 'MNQ1!',
      strategy_id: 'trend_pullback_long',
      score_v2_source: 'score_v2',
    });

    const preFlushStatus = writer.getCandidateScoreV2Status();
    expect(existsSync(candidatePath)).toBe(true);
    expect(preFlushStatus.state).toBe('opened_empty');
    expect(preFlushStatus.file_size_bytes).toBe(0);
    expect(preFlushStatus.buffered_rows).toBe(1);
    expect(preFlushStatus.flushed_rows).toBe(0);

    writer.destroy();

    const finalStatus = writer.getCandidateScoreV2Status();
    expect(finalStatus.state).toBe('written_successfully');
    expect(finalStatus.file_size_bytes).toBeGreaterThan(0);
    expect(finalStatus.buffered_rows).toBe(1);
    expect(finalStatus.flushed_rows).toBe(1);
    expect(formatCandidateScoreV2StatusLine(finalStatus)).toContain('state=written_successfully');

    const rows = readFileSync(candidatePath, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!)['symbol']).toBe('MNQ1!');
  });
});
