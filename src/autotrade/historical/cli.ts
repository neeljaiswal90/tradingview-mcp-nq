#!/usr/bin/env node
/**
 * Historical replay CLI.
 *
 * Usage:
 *   node dist/autotrade/historical/cli.js [--config path] [--1m path] [--5m path]
 *     [--15m path] [--60m path] [--symbol NQ1!] [--from UNIX] [--to UNIX]
 *     [--fill next_bar_open|signal_close] [--slippage 1]
 *     [--ambiguity conservative|optimistic|skip] [--warmup 250]
 *     [--out logs/historical]
 */

import { existsSync } from 'fs';
import {
  DEFAULT_HISTORICAL_CONFIG, loadHistoricalConfig, runHistoricalReplay,
  type HistoricalConfig,
} from './runner.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next; i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

function numOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let cfg: HistoricalConfig;
  if (args['config']) {
    cfg = loadHistoricalConfig(args['config']);
  } else {
    cfg = { ...DEFAULT_HISTORICAL_CONFIG, files: { ...DEFAULT_HISTORICAL_CONFIG.files } };
  }

  // CLI flags override config file
  if (args['1m']) cfg.files['1m'] = args['1m'];
  if (args['5m']) cfg.files['5m'] = args['5m'];
  if (args['15m']) cfg.files['15m'] = args['15m'];
  if (args['60m']) cfg.files['60m'] = args['60m'];
  if (args['symbol']) cfg.symbol = args['symbol'];
  if (args['from']) cfg.from_unix = numOrNull(args['from']);
  if (args['to']) cfg.to_unix = numOrNull(args['to']);
  if (args['warmup']) cfg.warmup_bars = Math.max(50, Number(args['warmup']) || cfg.warmup_bars);
  if (args['out']) cfg.output_dir = args['out'];
  if (args['fill']) cfg.fill.entry_model = args['fill'] === 'signal_close' ? 'signal_close' : 'next_bar_open';
  if (args['slippage']) cfg.fill.slippage_ticks = Math.max(0, Number(args['slippage']) || 0);
  if (args['ambiguity']) {
    const v = args['ambiguity'];
    cfg.fill.ambiguity_policy = v === 'optimistic' ? 'optimistic' : v === 'skip' ? 'skip' : 'conservative';
  }
  if (args['qty']) cfg.fixed_qty = Math.max(1, Math.floor(Number(args['qty']) || 1));

  // Validate file paths
  if (!cfg.files['1m'] || !existsSync(cfg.files['1m'])) {
    console.error(`[CLI] ❌ 1m file is required and must exist: ${cfg.files['1m']}`);
    process.exit(2);
  }
  for (const tf of ['5m', '15m', '60m'] as const) {
    const p = cfg.files[tf];
    if (p && !existsSync(p)) {
      console.error(`[CLI] ❌ ${tf} file does not exist: ${p}`);
      process.exit(2);
    }
  }

  console.log('[CLI] Historical Replay Configuration:');
  console.log(`      symbol:      ${cfg.symbol}`);
  console.log(`      1m:          ${cfg.files['1m']}`);
  console.log(`      5m:          ${cfg.files['5m'] ?? '(none)'}`);
  console.log(`      15m:         ${cfg.files['15m'] ?? '(none)'}`);
  console.log(`      60m:         ${cfg.files['60m'] ?? '(none)'}`);
  console.log(`      warmup:      ${cfg.warmup_bars} bars`);
  console.log(`      fill:        ${cfg.fill.entry_model}`);
  console.log(`      slippage:    ${cfg.fill.slippage_ticks} ticks`);
  console.log(`      ambiguity:   ${cfg.fill.ambiguity_policy}`);
  console.log(`      qty:         ${cfg.fixed_qty} contracts`);
  console.log(`      output_dir:  ${cfg.output_dir}`);

  const result = await runHistoricalReplay(cfg);
  console.log(`[CLI] Session: ${result.sessionId}`);
  console.log(`[CLI] Outputs written to: ${result.output_dir}`);
}

main().catch(err => {
  console.error('[CLI] ❌ Fatal:', err);
  process.exit(1);
});
