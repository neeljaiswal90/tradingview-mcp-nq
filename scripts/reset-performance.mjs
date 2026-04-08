#!/usr/bin/env node
/**
 * reset-performance.mjs — Write a fresh, schema-correct performance.json.
 *
 * Usage:
 *   node scripts/reset-performance.mjs [--log-dir ./logs]
 *
 * IMPORTANT: The schema below must match PerformanceTracker.emptyStats() in
 * src/autotrade/performance-tracker.ts. If you add fields to PerformanceStats,
 * update BOTH places. A unit test (performance-tracker-normalize.test.ts)
 * verifies key parity to catch drift.
 */

import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Canonical empty performance stats — must stay in sync with
 * PerformanceTracker.emptyStats() in src/autotrade/performance-tracker.ts.
 */
export const EMPTY_PERFORMANCE = {
  session_id: '',
  total_trades: 0,
  wins: 0,
  losses: 0,
  scratches: 0,
  win_rate: null,
  avg_r: null,
  expectancy: null,
  avg_winner_r: null,
  avg_loser_r: null,
  profit_factor: null,
  max_drawdown_pct: 0,
  total_pnl_usd: 0,
  by_setup: {},
  by_regime: {},
  by_hour: {},
  by_config_version: {},
  by_management_profile: {},
  last_updated: new Date().toISOString(),
};

/**
 * Main — only runs when executed directly (not when imported by tests).
 */
function main() {
  const args = process.argv.slice(2);
  const logDir = args.includes('--log-dir') ? args[args.indexOf('--log-dir') + 1] : './logs';
  const perfPath = join(logDir, 'performance.json');

  if (existsSync(perfPath)) {
    console.log(`[RESET] Overwriting existing ${perfPath}`);
  } else {
    console.log(`[RESET] Creating new ${perfPath}`);
  }

  writeFileSync(perfPath, JSON.stringify(EMPTY_PERFORMANCE, null, 2), 'utf8');
  console.log(`[RESET] Wrote fresh performance.json with ${Object.keys(EMPTY_PERFORMANCE).length} fields:`);
  console.log(`  ${Object.keys(EMPTY_PERFORMANCE).join(', ')}`);
  console.log('[RESET] Done. trades.jsonl and other log files were NOT modified.');
}

// Run main only when executed directly, not when imported
const isDirectRun = process.argv[1]?.endsWith('reset-performance.mjs');
if (isDirectRun) {
  main();
}
