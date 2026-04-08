#!/usr/bin/env node
/**
 * Run a single sensitivity experiment: mutate config, replay, analyze, restore.
 * Usage: node scripts/run-single-experiment.mjs <label> [key=value ...]
 * Example: node scripts/run-single-experiment.mjs rr_1.85 min_rr=1.85
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const [,, label, ...overridePairs] = process.argv;
if (!label) { console.error('Usage: run-single-experiment.mjs <label> [key=value ...]'); process.exit(1); }

const CONFIG_PATH = 'config/indicator-config.json';
const HIST_CONFIG_PATH = 'config/historical-config.json';
const OUT_BASE = 'reports/sensitivity';
const toUnix = '1773972000';

// Parse overrides
const overrides = {};
for (const pair of overridePairs) {
  const [k, v] = pair.split('=');
  overrides[k] = Number(v);
}

// Save baseline
const baselineConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const logsDir = `logs/sensitivity_${label}`;
const outDir = join(OUT_BASE, label);

console.log(`[${label}] overrides: ${JSON.stringify(overrides)}`);

// Write mutated config
const mutatedConfig = { ...baselineConfig, ...overrides };
writeFileSync(CONFIG_PATH, JSON.stringify(mutatedConfig, null, 2));

try {
  // Run replay
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const logFd = openSync(join(logsDir, '_replay_stdout.log'), 'w');
  const replayCmd = `node dist/autotrade/historical/cli.js --config ${HIST_CONFIG_PATH} --to ${toUnix} --out ${logsDir}`;
  console.log(`[${label}] running replay...`);
  execSync(replayCmd, { stdio: ['ignore', logFd, logFd], timeout: 900_000 });
  closeSync(logFd);
  console.log(`[${label}] replay done.`);

  // Run analysis
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const analyzeCmd = `node scripts/analyze-replay.mjs ${logsDir} ${outDir} --label ${label}`;
  execSync(analyzeCmd, { stdio: 'ignore', timeout: 60_000 });
  console.log(`[${label}] analysis done.`);

  // Run binning
  const binCmd = `node scripts/bin-results.mjs ${logsDir} ${outDir}`;
  execSync(binCmd, { stdio: 'ignore', timeout: 60_000 });
  console.log(`[${label}] binning done.`);

  // Read and print headline
  const metricsPath = join(outDir, `${label}_metrics.json`);
  if (existsSync(metricsPath)) {
    const m = JSON.parse(readFileSync(metricsPath, 'utf8')).headline;
    console.log(`[${label}] RESULT: trades=${m.total_trades} WR=${m.win_rate_pct}% E[R]=${m.expectancy_r} PF=${m.profit_factor} PnL=$${m.total_pnl_usd} MaxDD=$${m.max_drawdown_usd}`);
  }
} finally {
  // Always restore baseline
  writeFileSync(CONFIG_PATH, JSON.stringify(baselineConfig, null, 2));
  console.log(`[${label}] config restored.`);
}
