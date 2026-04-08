#!/usr/bin/env node
/**
 * build-training-dataset.mjs — Build ML training dataset from trade_path + trades JSONL.
 *
 * Strategy:
 *   - Joins per-cycle trade_path snapshots with their final TradeRecord (by trade_id)
 *   - Each path row becomes one labeled training sample
 *   - Uses 4 canonical source dirs to avoid duplicating the same bar sequence
 *     across the many sweep/sensitivity variants
 *
 * Output:
 *   logs/training_dataset.jsonl  — one JSON object per line, one per path row
 *
 * Usage:
 *   node scripts/build-training-dataset.mjs [--out logs/training_dataset.jsonl]
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// ─── Canonical source directories ─────────────────────────────────────────────
// Using one representative sweep baseline + historical A/B + live session.
// Deliberately excludes sensitivity_* and sweep_v2_rr_*, sweep_v2_conf_*, etc.
// to avoid inflating samples from repeated runs on the same bar sequence.
const SOURCE_DIRS = [
  join(repoRoot, 'logs', 'sweep_v2_baseline'),
  join(repoRoot, 'logs', 'historical_before'),
  join(repoRoot, 'logs', 'historical_after'),
  join(repoRoot, 'logs'),  // live session
];

// ─── Feature names (must match trained-engine.ts and train-pop-model.mjs) ─────
export const FEATURE_NAMES = [
  'geo_ratio_t1',
  'geo_ratio_t2',
  'current_r',
  'mfe_r',
  'mae_r',
  't1_dist_r',
  't2_dist_r',
  'stop_dist_r',
  'partial_exit_done',
  'hold_seconds_norm',
  'is_long',
  'setup_trend_pullback',
  'setup_breakout_retest',
  'setup_failed_break',
  'regime_trending_up',
  'regime_trending_down',
];

// ─── JSONL reader ──────────────────────────────────────────────────────────────

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ─── Feature computation ───────────────────────────────────────────────────────

function computeFeatures(pathRow, trade) {
  const side = trade.side ?? pathRow.side;
  const entryPrice = pathRow.entry_price ?? trade.entry_price_filled;
  const currentPrice = pathRow.current_price;
  const stopCurrent = pathRow.stop_current ?? trade.stop_price_initial;
  const stopInitial = trade.stop_price_initial;
  const t1 = pathRow.target_1 ?? trade.target_1;
  const t2 = pathRow.target_2 ?? trade.target_2;

  if (!entryPrice || !currentPrice || !stopInitial || !t1 || !t2) return null;

  const initialRiskPts = Math.abs(entryPrice - stopInitial);
  if (initialRiskPts <= 0) return null;

  // Signed favorable direction distances
  const sign = side === 'long' ? 1 : -1;
  const unrealPts = sign * (currentPrice - entryPrice);
  const stopDist = Math.max(sign * (currentPrice - stopCurrent), 0.01); // current price to current stop
  const t1dist = Math.max(sign * (t1 - currentPrice), 0.01);
  const t2dist = Math.max(sign * (t2 - currentPrice), 0.01);

  if (stopDist < 0) return null; // stop breached — skip

  const current_r = unrealPts / initialRiskPts;
  const mfe_r = (pathRow.mfe_pts ?? 0) / initialRiskPts;
  const mae_r = (pathRow.mae_pts ?? 0) / initialRiskPts;
  const t1_dist_r = t1dist / initialRiskPts;
  const t2_dist_r = t2dist / initialRiskPts;
  const stop_dist_r = stopDist / initialRiskPts;
  const geo_ratio_t1 = stopDist / (stopDist + t1dist);
  const geo_ratio_t2 = stopDist / (stopDist + t2dist);

  const partial_exit_done = pathRow.partial_exit_done ? 1 : 0;
  const hold_seconds = pathRow.hold_seconds ?? 0;
  const hold_seconds_norm = Math.log1p(hold_seconds) / Math.log1p(3600);
  const is_long = side === 'long' ? 1 : 0;

  // Setup type encoding (from trade record — path row may not have it)
  const setupType = (trade.setup_type ?? '').toLowerCase();
  const setup_trend_pullback = setupType.includes('pullback') ? 1 : 0;
  const setup_breakout_retest = setupType.includes('breakout') ? 1 : 0;
  const setup_failed_break = (setupType.includes('failed') || setupType.includes('break')) && !setupType.includes('breakout') ? 1 : 0;

  // Regime encoding (from trade record — live session path rows may also have regime)
  const regime = (pathRow.regime ?? trade.regime_at_entry ?? trade.market_regime ?? '').toLowerCase();
  const regime_trending_up = regime === 'trending_up' ? 1 : 0;
  const regime_trending_down = regime === 'trending_down' ? 1 : 0;

  return [
    geo_ratio_t1, geo_ratio_t2,
    current_r, mfe_r, mae_r,
    t1_dist_r, t2_dist_r, stop_dist_r,
    partial_exit_done, hold_seconds_norm,
    is_long,
    setup_trend_pullback, setup_breakout_retest, setup_failed_break,
    regime_trending_up, regime_trending_down,
  ];
}

// ─── Label computation ─────────────────────────────────────────────────────────

function computeLabels(pathRow, trade) {
  // T1: did this trade ultimately hit target_1?
  const label_t1 = trade.hit_target_1 === true ? 1 : 0;

  // T2: use r_multiple > 2.0 as proxy (hit_target_2 is rarely set in sweep data)
  const label_t2 = (trade.r_multiple ?? -99) > 2.0 ? 1 : 0;

  // Runner: extended significantly beyond T2
  const label_runner = (trade.r_multiple ?? -99) > 1.5 ? 1 : 0;

  // T1 future-only: skip path rows where T1 event has already occurred
  // (determined by partial_exit_done or pt1_done — label is already determined)
  const t1_already_done = pathRow.partial_exit_done === true;

  return { label_t1, label_t2, label_runner, t1_already_done };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const outArgIdx = process.argv.indexOf('--out');
const outArg = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : null;
const outPath = outArg ? join(repoRoot, outArg) : join(repoRoot, 'logs', 'training_dataset.jsonl');
const { dirname: pathDirname } = await import('path');
mkdirSync(pathDirname(outPath), { recursive: true });

let totalSamples = 0;
let skippedDegenerate = 0;
let posT1 = 0, posT2 = 0, posRunner = 0;
const sourceStats = [];

const outLines = [];

for (const srcDir of SOURCE_DIRS) {
  const tradesPath = join(srcDir, 'trades.jsonl');
  const pathsPath = join(srcDir, 'trade_path.jsonl');

  if (!existsSync(tradesPath) || !existsSync(pathsPath)) {
    console.warn(`Skipping ${srcDir} — missing trades.jsonl or trade_path.jsonl`);
    continue;
  }

  const trades = readJsonl(tradesPath);
  const paths = readJsonl(pathsPath);

  // Build lookup map: trade_id → TradeRecord
  const tradeMap = new Map();
  for (const t of trades) {
    if (t.trade_id) tradeMap.set(t.trade_id, t);
  }

  let dirSamples = 0;
  let dirSkipped = 0;

  for (const pathRow of paths) {
    const trade = tradeMap.get(pathRow.trade_id);
    if (!trade) continue; // orphan path row

    const features = computeFeatures(pathRow, trade);
    if (!features) { dirSkipped++; skippedDegenerate++; continue; }

    const { label_t1, label_t2, label_runner, t1_already_done } = computeLabels(pathRow, trade);

    outLines.push(JSON.stringify({
      trade_id: pathRow.trade_id,
      source_dir: srcDir.replace(repoRoot, '').replace(/\\/g, '/'),
      timestamp: pathRow.timestamp,
      features,
      label_t1: t1_already_done ? null : label_t1,  // null = exclude from T1 training
      label_t2,
      label_runner,
    }));

    if (!t1_already_done && label_t1 === 1) posT1++;
    if (label_t2 === 1) posT2++;
    if (label_runner === 1) posRunner++;
    dirSamples++;
    totalSamples++;
  }

  sourceStats.push({ dir: srcDir.replace(repoRoot, ''), trades: trades.length, samples: dirSamples, skipped: dirSkipped });
}

writeFileSync(outPath, outLines.join('\n'), 'utf8');

// Count valid T1 samples (non-null label_t1)
const t1Samples = outLines.filter(l => {
  try { return JSON.parse(l).label_t1 !== null; } catch { return false; }
}).length;

console.log(`\n=== Training Dataset Built ===`);
console.log(`Output: ${outPath}`);
console.log(`Total path rows: ${totalSamples}  |  Skipped (degenerate): ${skippedDegenerate}`);
console.log(`\nLabel distribution:`);
console.log(`  T1 (hit_target_1):          ${posT1} pos / ${t1Samples} valid rows  (${(posT1/t1Samples*100).toFixed(1)}%)`);
console.log(`  T2 (r_multiple>2.0 proxy):  ${posT2} pos / ${totalSamples} rows  (${(posT2/totalSamples*100).toFixed(1)}%)`);
console.log(`  Runner (r_multiple>1.5):    ${posRunner} pos / ${totalSamples} rows  (${(posRunner/totalSamples*100).toFixed(1)}%)`);
console.log(`\nBy source:`);
for (const s of sourceStats) {
  console.log(`  ${s.dir.padEnd(35)} trades=${s.trades}  samples=${s.samples}  skipped=${s.skipped}`);
}
