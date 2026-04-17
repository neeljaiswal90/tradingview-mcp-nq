import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'bootstrap-paper-artifacts.mjs');

function makeTempRepoRoot(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'bootstrap-paper-artifacts-'));
  tempDirs.push(repoRoot);
  mkdirSync(join(repoRoot, 'bootstrap', 'paper-artifacts', 'sources', 'MNQ', 'data'), {
    recursive: true,
  });
  mkdirSync(join(repoRoot, 'bootstrap', 'paper-artifacts', 'sources', 'MNQ', 'config'), {
    recursive: true,
  });
  mkdirSync(join(repoRoot, 'data'), { recursive: true });
  mkdirSync(join(repoRoot, 'config'), { recursive: true });
  return repoRoot;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function seedManifestRepo(repoRoot: string): { bucket: string; curves: string } {
  const bucket = '{\n  "bucket": "mnq"\n}\n';
  const curves = '{\n  "curves": {}\n}\n';

  writeFileSync(
    join(repoRoot, 'bootstrap', 'paper-artifacts', 'sources', 'MNQ', 'data', 'expectancy_bucket_table_MNQ.json'),
    bucket,
    'utf8',
  );
  writeFileSync(
    join(repoRoot, 'bootstrap', 'paper-artifacts', 'sources', 'MNQ', 'config', 'failure_exit_curves_MNQ.json'),
    curves,
    'utf8',
  );

  writeFileSync(
    join(repoRoot, 'bootstrap', 'paper-artifacts', 'manifest.json'),
    JSON.stringify(
      {
        version: 1,
        symbols: {
          MNQ: {
            artifacts: [
              {
                source: 'bootstrap/paper-artifacts/sources/MNQ/data/expectancy_bucket_table_MNQ.json',
                target: 'data/expectancy_bucket_table_MNQ.json',
                sha256: sha256(bucket),
              },
              {
                source: 'bootstrap/paper-artifacts/sources/MNQ/config/failure_exit_curves_MNQ.json',
                target: 'config/failure_exit_curves_MNQ.json',
                sha256: sha256(curves),
              },
            ],
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  return { bucket, curves };
}

function runBootstrap(repoRoot: string) {
  return spawnSync(
    'node',
    [SCRIPT_PATH, '--symbol', 'MNQ', '--repo-root', repoRoot],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('bootstrap-paper-artifacts.mjs', () => {
  it('creates the required MNQ paper artifact layout and is idempotent', () => {
    const repoRoot = makeTempRepoRoot();
    const expected = seedManifestRepo(repoRoot);

    const firstRun = runBootstrap(repoRoot);
    expect(firstRun.status).toBe(0);
    expect(firstRun.stdout).toContain('completed symbol=MNQ artifacts=2');

    const bucketPath = join(repoRoot, 'data', 'expectancy_bucket_table_MNQ.json');
    const curvesPath = join(repoRoot, 'config', 'failure_exit_curves_MNQ.json');
    expect(readFileSync(bucketPath, 'utf8')).toBe(expected.bucket);
    expect(readFileSync(curvesPath, 'utf8')).toBe(expected.curves);

    const secondRun = runBootstrap(repoRoot);
    expect(secondRun.status).toBe(0);
    expect(secondRun.stdout).toContain('up-to-date');
    expect(readFileSync(bucketPath, 'utf8')).toBe(expected.bucket);
    expect(readFileSync(curvesPath, 'utf8')).toBe(expected.curves);
  });

  it('rejects manifest paths that escape the repo root', () => {
    const repoRoot = makeTempRepoRoot();
    seedManifestRepo(repoRoot);

    writeFileSync(
      join(repoRoot, 'bootstrap', 'paper-artifacts', 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          symbols: {
            MNQ: {
              artifacts: [
                {
                  source: '..\\outside.json',
                  target: 'data/expectancy_bucket_table_MNQ.json',
                },
              ],
            },
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const result = runBootstrap(repoRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must stay inside repo root');
  });
});
