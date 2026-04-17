#!/usr/bin/env node

import {
  assessScalperRolloutGate,
  buildScalperHealthReport,
  resolveRepoRoot,
} from './scalper-rollout-lib.mjs';

function parseThresholds(argv) {
  const thresholds = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (!current?.startsWith('--')) continue;
    const numericValue = Number(next);
    if (!Number.isFinite(numericValue)) continue;
    if (current === '--min-rows') thresholds.minRowsRaw = numericValue;
    if (current === '--min-expectancy-ready') thresholds.minExpectancyReadyRaw = numericValue;
    if (current === '--min-ml-ready') thresholds.minMlReadyRaw = numericValue;
    if (current === '--min-allowed') thresholds.minAllowedRaw = numericValue;
  }
  return thresholds;
}

const targetPath = process.argv[2] ?? '.';
const thresholds = parseThresholds(process.argv.slice(3));
const repoRoot = resolveRepoRoot(process.env['REPO_ROOT'] ?? null);

try {
  const report = buildScalperHealthReport({ targetPath, repoRoot });
  const gate = assessScalperRolloutGate(report, thresholds);
  console.log(
    JSON.stringify(
      {
        ...report,
        rollout_gate: gate,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
