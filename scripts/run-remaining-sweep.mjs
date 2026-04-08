#!/usr/bin/env node
/**
 * Run remaining sensitivity experiments that timed out in the initial sweep.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const CONFIG_PATH = 'config/indicator-config.json';
const HIST_CONFIG_PATH = 'config/historical-config.json';
const OUT_BASE = 'reports/sensitivity';
const toUnix = '1773972000';

const baselineConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const experiments = [
  { label: 'maxconf_disabled', overrides: { max_confidence: 10.0 } },
  { label: 'maxconf_8.9', overrides: { max_confidence: 8.9 } },
  { label: 'combined_rr1.85_conf7.2', overrides: { min_rr: 1.85, min_confidence: 7.2 } },
  { label: 'combined_rr1.75_conf6.8_maxconf8.9', overrides: { min_rr: 1.75, min_confidence: 6.8, max_confidence: 8.9 } },
];

for (const exp of experiments) {
  const tag = exp.label;
  const logsDir = `logs/sensitivity_${tag}`;
  const outDir = join(OUT_BASE, tag);

  console.log(`\n── [${tag}] ──`);
  console.log(`  overrides: ${JSON.stringify(exp.overrides)}`);

  // Write mutated config
  const mutatedConfig = { ...baselineConfig, ...exp.overrides };
  writeFileSync(CONFIG_PATH, JSON.stringify(mutatedConfig, null, 2));

  // Run replay (10 minute timeout)
  try {
    console.log(`  running replay...`);
    const replayCmd = `node dist/autotrade/historical/cli.js --config ${HIST_CONFIG_PATH} --to ${toUnix} --out ${logsDir}`;
    execSync(replayCmd, { stdio: 'pipe', timeout: 600_000 });
    console.log(`  replay done.`);
  } catch (err) {
    console.error(`  REPLAY FAILED: ${err.message?.slice(0, 200)}`);
    continue;
  }

  // Run analysis
  try {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const analyzeCmd = `node scripts/analyze-replay.mjs ${logsDir} ${outDir} --label ${tag}`;
    execSync(analyzeCmd, { stdio: 'pipe', timeout: 60_000 });
    console.log(`  analysis done.`);
  } catch (err) {
    console.error(`  ANALYSIS FAILED: ${err.message?.slice(0, 200)}`);
  }

  // Run binning
  try {
    const binCmd = `node scripts/bin-results.mjs ${logsDir} ${outDir}`;
    execSync(binCmd, { stdio: 'pipe', timeout: 60_000 });
    console.log(`  binning done.`);
  } catch (err) {
    console.error(`  BINNING FAILED: ${err.message?.slice(0, 200)}`);
  }
}

// Restore baseline
writeFileSync(CONFIG_PATH, JSON.stringify(baselineConfig, null, 2));
console.log(`\n[SWEEP] Restored baseline config.`);
console.log('Done.\n');
