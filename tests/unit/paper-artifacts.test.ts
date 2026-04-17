import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findMissingPaperArtifacts,
  formatMissingPaperArtifactsMessage,
  getSymbolExpectancyBucketTablePath,
  resolveExpectancyBucketTablePath,
  resolveRepoLocalPath,
} from '../../src/autotrade/paper-artifacts.js';

const tempDirs: string[] = [];

function makeTempRepoRoot(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'paper-artifacts-'));
  tempDirs.push(repoRoot);
  mkdirSync(join(repoRoot, 'data'), { recursive: true });
  mkdirSync(join(repoRoot, 'config'), { recursive: true });
  return repoRoot;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('paper artifact path enforcement', () => {
  it('resolves symbol-scoped artifact paths inside the repo root', () => {
    const repoRoot = makeTempRepoRoot();

    const bucketPath = getSymbolExpectancyBucketTablePath(repoRoot, 'MNQ');

    expect(bucketPath.relativePath).toBe('data/expectancy_bucket_table_MNQ.json');
    expect(bucketPath.absolutePath).toBe(
      join(repoRoot, 'data', 'expectancy_bucket_table_MNQ.json'),
    );
  });

  it('rejects configured artifact paths that escape the repo root', () => {
    const repoRoot = makeTempRepoRoot();

    expect(() => resolveRepoLocalPath(repoRoot, '..\\outside.json', 'test_artifact'))
      .toThrow(/must stay inside repo root/);
  });

  it('prefers symbol-scoped expectancy artifacts and otherwise uses a repo-local fallback', () => {
    const repoRoot = makeTempRepoRoot();
    writeFileSync(
      join(repoRoot, 'data', 'expectancy_bucket_table.json'),
      '{"ok":true}\n',
      'utf8',
    );

    const firstResolution = resolveExpectancyBucketTablePath(
      repoRoot,
      'MNQ',
      'data/expectancy_bucket_table.json',
    );
    expect(firstResolution.fallbackUsed).toBe(true);
    expect(firstResolution.path.relativePath).toBe('data/expectancy_bucket_table.json');

    writeFileSync(
      join(repoRoot, 'data', 'expectancy_bucket_table_MNQ.json'),
      '{"symbol":"MNQ"}\n',
      'utf8',
    );

    const secondResolution = resolveExpectancyBucketTablePath(
      repoRoot,
      'MNQ',
      'data/expectancy_bucket_table.json',
    );
    expect(secondResolution.fallbackUsed).toBe(false);
    expect(secondResolution.path.relativePath).toBe('data/expectancy_bucket_table_MNQ.json');
  });

  it('produces a clear bootstrap error when required paper artifacts are missing', () => {
    const repoRoot = makeTempRepoRoot();
    const missing = findMissingPaperArtifacts(repoRoot, 'MNQ');
    const message = formatMissingPaperArtifactsMessage(
      'paper',
      repoRoot,
      'MNQ',
      missing,
    );

    expect(missing.map(pathSpec => pathSpec.relativePath)).toEqual([
      'data/expectancy_bucket_table_MNQ.json',
      'config/failure_exit_curves_MNQ.json',
    ]);
    expect(message).toContain('npm run bootstrap:paper-artifacts -- --symbol MNQ');
    expect(message).toContain(repoRoot);
    expect(message).toContain('cross-worktree borrowing are not allowed');
  });
});
