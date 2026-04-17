#!/usr/bin/env node

import { buildScalperHealthReport, resolveRepoRoot } from './scalper-rollout-lib.mjs';

const targetPath = process.argv[2] ?? '.';
const repoRoot = resolveRepoRoot(process.env['REPO_ROOT'] ?? null);

try {
  const report = buildScalperHealthReport({ targetPath, repoRoot });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
