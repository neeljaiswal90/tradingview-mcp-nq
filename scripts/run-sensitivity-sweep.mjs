#!/usr/bin/env node
/**
 * Sensitivity sweep runner.
 *
 * Runs N replay experiments by mutating config/indicator-config.json,
 * executing the historical replay CLI, and collecting metrics for comparison.
 *
 * Usage:
 *   node scripts/run-sensitivity-sweep.mjs [--to <unix>] [--dry-run]
 *
 * Outputs:
 *   reports/sensitivity/
 *     ├── sweep_manifest.json        (all experiment configs)
 *     ├── <label>_metrics.json       (per-experiment)
 *     ├── sweep_comparison.json      (all experiments compared)
 *     └── sweep_summary.csv          (headline metrics for every run)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const toIdx = args.indexOf('--to');
const toUnix = toIdx >= 0 ? args[toIdx + 1] : '1773972000';

const CONFIG_PATH = 'config/indicator-config.json';
const HIST_CONFIG_PATH = 'config/historical-config.json';
const OUT_BASE = 'reports/sensitivity';
if (!existsSync(OUT_BASE)) mkdirSync(OUT_BASE, { recursive: true });

// ── Save baseline config ──
const baselineConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const backupPath = join(OUT_BASE, 'indicator-config-backup.json');
writeFileSync(backupPath, JSON.stringify(baselineConfig, null, 2));

// ── Define experiment matrix ──
const experiments = [
  // Baseline (no change)
  { label: 'baseline', overrides: {} },
  // min_rr sweep
  { label: 'rr_1.85', overrides: { min_rr: 1.85 } },
  { label: 'rr_1.75', overrides: { min_rr: 1.75 } },
  // min_confidence sweep
  { label: 'conf_7.2', overrides: { min_confidence: 7.2 } },
  { label: 'conf_6.8', overrides: { min_confidence: 6.8 } },
  // max_confidence sweep
  { label: 'maxconf_disabled', overrides: { max_confidence: 10.0 } },
  { label: 'maxconf_8.9', overrides: { max_confidence: 8.9 } },
  // Combined: lower RR + lower confidence (best-case from autoresearch)
  { label: 'combined_rr1.85_conf7.2', overrides: { min_rr: 1.85, min_confidence: 7.2 } },
  { label: 'combined_rr1.75_conf6.8_maxconf8.9', overrides: { min_rr: 1.75, min_confidence: 6.8, max_confidence: 8.9 } },
];

console.log(`\n=== Sensitivity Sweep: ${experiments.length} experiments ===\n`);
if (dryRun) console.log('*** DRY RUN — will not execute replays ***\n');

const manifest = {
  generated_at: new Date().toISOString(),
  baseline_config: baselineConfig,
  to_unix: toUnix,
  experiments: [],
};

const headlines = [];

for (const exp of experiments) {
  const tag = exp.label;
  const logsDir = `logs/sensitivity_${tag}`;
  const outDir = join(OUT_BASE, tag);

  console.log(`\n── [${tag}] ──`);
  console.log(`  overrides: ${JSON.stringify(exp.overrides)}`);
  console.log(`  logs: ${logsDir}`);
  console.log(`  metrics: ${outDir}`);

  // Write mutated config
  const mutatedConfig = { ...baselineConfig, ...exp.overrides };
  writeFileSync(CONFIG_PATH, JSON.stringify(mutatedConfig, null, 2));

  manifest.experiments.push({
    label: tag,
    overrides: exp.overrides,
    effective_config: {
      min_rr: mutatedConfig.min_rr,
      min_confidence: mutatedConfig.min_confidence,
      max_confidence: mutatedConfig.max_confidence,
    },
    logs_dir: logsDir,
    metrics_dir: outDir,
  });

  if (dryRun) {
    console.log('  [DRY RUN] skipping replay + analysis');
    continue;
  }

  // Run replay (redirect stdout/stderr to file to avoid ENOBUFS on large output)
  try {
    console.log(`  running replay...`);
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const logFd = openSync(join(logsDir, '_replay_stdout.log'), 'w');
    const replayCmd = `node dist/autotrade/historical/cli.js --config ${HIST_CONFIG_PATH} --to ${toUnix} --out ${logsDir}`;
    execSync(replayCmd, { stdio: ['ignore', logFd, logFd], timeout: 900_000 });
    closeSync(logFd);
    console.log(`  replay done.`);
  } catch (err) {
    console.error(`  REPLAY FAILED: ${err.message}`);
    continue;
  }

  // Run analysis
  try {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const analyzeCmd = `node scripts/analyze-replay.mjs ${logsDir} ${outDir} --label ${tag}`;
    execSync(analyzeCmd, { stdio: 'ignore', timeout: 60_000 });
    console.log(`  analysis done.`);

    // Read headline metrics
    const metricsPath = join(outDir, `${tag}_metrics.json`);
    if (existsSync(metricsPath)) {
      const m = JSON.parse(readFileSync(metricsPath, 'utf8'));
      headlines.push({
        label: tag,
        ...exp.overrides,
        total_trades: m.headline.total_trades,
        wins: m.headline.wins,
        losses: m.headline.losses,
        win_rate_pct: m.headline.win_rate_pct,
        expectancy_r: m.headline.expectancy_r,
        profit_factor: m.headline.profit_factor,
        total_pnl_usd: m.headline.total_pnl_usd,
        max_drawdown_usd: m.headline.max_drawdown_usd,
        avg_hold_seconds: m.headline.avg_hold_seconds,
        stop_out_rate_pct: m.headline.stop_out_rate_pct,
        trailing_stop_rate_pct: m.headline.trailing_stop_rate_pct ?? null,
        initial_stop_rate_pct: m.headline.initial_stop_rate_pct ?? null,
      });
    }
  } catch (err) {
    console.error(`  ANALYSIS FAILED: ${err.message}`);
  }

  // Run binning
  try {
    const binCmd = `node scripts/bin-results.mjs ${logsDir} ${outDir}`;
    execSync(binCmd, { stdio: 'ignore', timeout: 60_000 });
    console.log(`  binning done.`);
  } catch (err) {
    console.error(`  BINNING FAILED: ${err.message}`);
  }
}

// ── Restore baseline config ──
writeFileSync(CONFIG_PATH, JSON.stringify(baselineConfig, null, 2));
console.log(`\n[SWEEP] Restored baseline config.`);

// ── Write manifest ──
writeFileSync(join(OUT_BASE, 'sweep_manifest.json'), JSON.stringify(manifest, null, 2));

// ── Write comparison summary ──
if (headlines.length > 0) {
  writeFileSync(join(OUT_BASE, 'sweep_comparison.json'), JSON.stringify(headlines, null, 2));

  // CSV
  const cols = Object.keys(headlines[0]);
  const csvRows = [cols.join(',')];
  for (const h of headlines) {
    csvRows.push(cols.map(c => h[c] ?? '').join(','));
  }
  writeFileSync(join(OUT_BASE, 'sweep_summary.csv'), csvRows.join('\n'));

  // Print table
  console.log('\n=== SWEEP RESULTS ===\n');
  console.log('Label'.padEnd(42) + 'Trades  WR%   E[R]   PF     PnL($)  MaxDD($)');
  console.log('-'.repeat(90));
  for (const h of headlines) {
    console.log(
      `${h.label.padEnd(42)}${String(h.total_trades).padStart(5)}  ` +
      `${(h.win_rate_pct ?? '-').toString().padStart(5)}  ` +
      `${(h.expectancy_r ?? '-').toString().padStart(5)}  ` +
      `${(h.profit_factor ?? '-').toString().padStart(5)}  ` +
      `${(h.total_pnl_usd ?? '-').toString().padStart(8)}  ` +
      `${(h.max_drawdown_usd ?? '-').toString().padStart(8)}`
    );
  }
}

console.log(`\nArtifacts: ${OUT_BASE}/`);
console.log('Done.\n');
