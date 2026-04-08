#!/usr/bin/env node
/**
 * analyze-today.mjs — Analyze trades from the current live session.
 *
 * Reads from logs/ (the live session JSONL files) and outputs a compact
 * session summary to stdout plus a full metrics JSON to reports/today_<date>/.
 *
 * Usage:
 *   node scripts/analyze-today.mjs [--out-dir reports/today] [--logs-dir logs]
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { computeMetrics, writeReports, printSummary } from './replay-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Parse args
const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const logsDir = join(repoRoot, argVal('--logs-dir') ?? 'logs');
const todayLabel = `TODAY_${new Date().toISOString().slice(0, 10)}`;
const outDir = join(repoRoot, argVal('--out-dir') ?? `reports/today_${new Date().toISOString().slice(0, 10)}`);

mkdirSync(outDir, { recursive: true });

console.log(`Analyzing live session logs: ${logsDir}`);
console.log(`Report output: ${outDir}\n`);

const metrics = computeMetrics({ logsDir, label: todayLabel });

if (metrics.headline.total_trades === 0) {
  console.log('No trades found in logs/. Is the autotrade session running?');
  process.exit(0);
}

printSummary(metrics);
const { metricsPath, csvPath } = writeReports(metrics, outDir, todayLabel);
console.log(`Full metrics: ${metricsPath}`);
console.log(`Breakdowns:   ${csvPath}`);
