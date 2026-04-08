#!/usr/bin/env node
/**
 * Replay metrics analyzer.
 * Reads logs from a directory and emits a structured metrics JSON + CSV breakdowns.
 *
 * Usage:
 *   node scripts/analyze-replay.mjs <logs-dir> <out-dir> [--label BEFORE]
 */

import { computeMetrics, writeReports, printSummary } from './replay-lib.mjs';

const [, , logsDir, outDir, ...rest] = process.argv;
if (!logsDir || !outDir) {
  console.error('Usage: analyze-replay.mjs <logs-dir> <out-dir> [--label LABEL]');
  process.exit(1);
}
const labelIdx = rest.indexOf('--label');
const label = labelIdx >= 0 ? rest[labelIdx + 1] : 'RUN';

const metrics = computeMetrics({ logsDir, label });
const { metricsPath, csvPath } = writeReports(metrics, outDir, label);
printSummary(metrics);
console.log(`Full report: ${metricsPath}`);
console.log(`Breakdowns:  ${csvPath}`);
