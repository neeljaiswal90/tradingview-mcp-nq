#!/usr/bin/env node
/**
 * Bin results analyzer.
 * Reads trades.jsonl and rejected_signals.jsonl from a logs directory and
 * produces a JSON + CSV report with multi-dimensional bucketed breakdowns.
 *
 * Usage:
 *   node scripts/bin-results.mjs <logs-dir> <out-dir>
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Helpers ────────────────────────────────────────────────────────────────────

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function round(x, d = 2) { const f = 10 ** d; return Math.round(x * f) / f; }
function pct(a, b) { return b === 0 ? null : round((a / b) * 100, 1); }
function avg(arr) { return arr.length === 0 ? null : arr.reduce((s, v) => s + v, 0) / arr.length; }

// ── Bucket classifiers ─────────────────────────────────────────────────────────

function confidenceBucket(c) {
  if (c == null) return 'unknown';
  if (c < 6.5) return '<6.5';
  if (c < 7.0) return '6.5-7.0';
  if (c < 7.5) return '7.0-7.5';
  if (c < 8.0) return '7.5-8.0';
  if (c < 8.5) return '8.0-8.5';
  if (c < 9.0) return '8.5-9.0';
  return '9.0+';
}

function rrBucket(rr) {
  if (rr == null) return 'unknown';
  if (rr < 1.5) return '<1.5';
  if (rr < 1.75) return '1.5-1.75';
  if (rr < 2.0) return '1.75-2.0';
  if (rr < 2.5) return '2.0-2.5';
  if (rr < 3.0) return '2.5-3.0';
  return '3.0+';
}

function holdTimeBucket(seconds) {
  if (seconds == null) return 'unknown';
  if (seconds < 300) return '<5min';
  if (seconds < 900) return '5-15min';
  if (seconds < 1800) return '15-30min';
  if (seconds < 3600) return '30-60min';
  return '60min+';
}

// ── Main ───────────────────────────────────────────────────────────────────────

const [, , logsDir, outDir] = process.argv;
if (!logsDir || !outDir) {
  console.error('Usage: node scripts/bin-results.mjs <logs-dir> <out-dir>');
  process.exit(1);
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const trades = readJsonl(join(logsDir, 'trades.jsonl'));
const rejected = readJsonl(join(logsDir, 'rejected_signals.jsonl'));

console.log(`Loaded ${trades.length} trades, ${rejected.length} rejected signals from ${logsDir}`);

// ── Grouping utility ───────────────────────────────────────────────────────────

function group(items, keyFn) {
  const g = {};
  for (const it of items) {
    const k = String(keyFn(it) ?? 'unknown');
    if (!g[k]) g[k] = [];
    g[k].push(it);
  }
  return g;
}

function summarizeTrades(arr) {
  const w = arr.filter(t => t.outcome_class === 'winner');
  const l = arr.filter(t => t.outcome_class === 'loser');
  const s = arr.filter(t => t.outcome_class === 'scratch');
  const rs = arr.map(t => t.r_multiple).filter(r => typeof r === 'number');
  const holds = arr.map(t => t.hold_time_seconds).filter(h => typeof h === 'number');
  return {
    n: arr.length,
    wins: w.length,
    losses: l.length,
    scratches: s.length,
    win_rate_pct: pct(w.length, arr.length),
    avg_r: rs.length ? round(avg(rs), 3) : null,
    total_pnl_usd: round(arr.reduce((sum, t) => sum + (t.pnl_realized || 0), 0)),
    avg_hold_seconds: holds.length ? Math.round(avg(holds)) : null,
  };
}

function buildBreakdown(items, keyFn) {
  const groups = group(items, keyFn);
  const result = {};
  for (const [k, v] of Object.entries(groups)) {
    result[k] = summarizeTrades(v);
  }
  return result;
}

// ── Build all breakdowns ───────────────────────────────────────────────────────

const breakdowns = {
  by_confidence_bucket: buildBreakdown(trades, t =>
    confidenceBucket(t.confidence_score_at_entry ?? t.confidence_score ?? t.confidence ?? t.confidence_bucket_raw)),
  by_rr_bucket: buildBreakdown(trades, t => rrBucket(t.rr_t1 ?? t.r_multiple)),
  by_setup_family: buildBreakdown(trades, t => t.setup_type),
  by_regime: buildBreakdown(trades, t => t.market_regime),
  by_direction: buildBreakdown(trades, t => t.side),
  by_hold_time_bucket: buildBreakdown(trades, t => holdTimeBucket(t.hold_time_seconds)),
  by_session_bucket: buildBreakdown(trades, t => t.session_bucket ?? 'unknown'),
  by_exit_reason_detailed: buildBreakdown(trades, t => t.exit_reason_detailed ?? t.exit_reason),
};

const report = {
  generated_at: new Date().toISOString(),
  logs_dir: logsDir,
  total_trades: trades.length,
  total_rejected: rejected.length,
  breakdowns,
};

// ── Write JSON ─────────────────────────────────────────────────────────────────

const jsonPath = join(outDir, 'binned_results.json');
writeFileSync(jsonPath, JSON.stringify(report, null, 2));
console.log(`Wrote ${jsonPath}`);

// ── Write CSV ──────────────────────────────────────────────────────────────────

const csvRows = ['group,key,n,wins,losses,scratches,win_rate_pct,avg_r,total_pnl_usd,avg_hold_seconds'];
for (const [grpName, grp] of Object.entries(breakdowns)) {
  for (const [k, v] of Object.entries(grp)) {
    csvRows.push([
      grpName, k, v.n, v.wins, v.losses, v.scratches,
      v.win_rate_pct ?? '', v.avg_r ?? '', v.total_pnl_usd, v.avg_hold_seconds ?? '',
    ].join(','));
  }
}
const csvPath = join(outDir, 'binned_results.csv');
writeFileSync(csvPath, csvRows.join('\n'));
console.log(`Wrote ${csvPath}`);
