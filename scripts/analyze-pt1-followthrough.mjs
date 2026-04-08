#!/usr/bin/env node
/**
 * analyze-pt1-followthrough.mjs
 *
 * Analyzes post-PT1 follow-through to answer:
 * "After PT1 fires, is there usually enough additional movement
 *  left to justify a wider trail?"
 *
 * Reads trades.jsonl + trade_path.jsonl, splits each trade's price path
 * at the PT1 boundary, and computes follow-through metrics.
 *
 * Usage:
 *   node scripts/analyze-pt1-followthrough.mjs [--log-dir ./logs] [--out-dir ./reports]
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function round(x, d = 2) { return Math.round(x * (10 ** d)) / (10 ** d); }
function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function avg(arr) { return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length; }
function pct(count, total) { return total === 0 ? 0 : round((count / total) * 100, 1); }

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const logDir = args.includes('--log-dir') ? args[args.indexOf('--log-dir') + 1] : './logs';
const outDir = args.includes('--out-dir') ? args[args.indexOf('--out-dir') + 1] : './reports';

// ─── Load data ────────────────────────────────────────────────────────────────

const trades = readJsonl(join(logDir, 'trades.jsonl'));
const pathRecords = readJsonl(join(logDir, 'trade_path.jsonl'));

// Separate tick snapshots from management events
const pathTicks = pathRecords.filter(r => r._record_type !== 'management_event');
const mgmtEvents = pathRecords.filter(r => r._record_type === 'management_event');

console.log(`Loaded ${trades.length} trades, ${pathTicks.length} path ticks, ${mgmtEvents.length} management events`);

// ─── Filter trades with PT1 partials ──────────────────────────────────────────

const pt1Trades = trades.filter(t =>
  t.exit_legs && t.exit_legs.some(l => l.reason === 'partial_profit_1')
);

console.log(`Found ${pt1Trades.length} trades with PT1 partial exits\n`);

if (pt1Trades.length === 0) {
  console.log('No PT1 trades found. Nothing to analyze.');
  process.exit(0);
}

// ─── Build path index by trade_id ─────────────────────────────────────────────

const pathByTrade = {};
for (const tick of pathTicks) {
  if (!tick.trade_id) continue;
  if (!pathByTrade[tick.trade_id]) pathByTrade[tick.trade_id] = [];
  pathByTrade[tick.trade_id].push(tick);
}

const eventsByTrade = {};
for (const evt of mgmtEvents) {
  if (!evt.trade_id) continue;
  if (!eventsByTrade[evt.trade_id]) eventsByTrade[evt.trade_id] = [];
  eventsByTrade[evt.trade_id].push(evt);
}

// ─── Analyze each PT1 trade ───────────────────────────────────────────────────

const results = [];

for (const trade of pt1Trades) {
  const ticks = pathByTrade[trade.trade_id] || [];
  const events = eventsByTrade[trade.trade_id] || [];

  // Find PT1 moment
  const pt1Leg = trade.exit_legs.find(l => l.reason === 'partial_profit_1');
  if (!pt1Leg) continue;

  const pt1Event = events.find(e => e.event_type === 'pt1_trigger');
  const pt1Time = pt1Event?.timestamp || pt1Leg.fill_time_iso;
  const pt1Price = pt1Leg.fill_price;

  const isShort = trade.side === 'short';
  const entryPrice = trade.entry_price_filled;
  const initialRiskPts = Math.abs(entryPrice - trade.stop_price_initial);
  const atr = trade.atr_at_entry || 10; // fallback

  // Use new instrumented fields if available, else infer from path
  let mfeAtPt1 = trade.mfe_at_pt1;
  let maeAtPt1 = trade.mae_at_pt1;
  let mfeAfterPt1 = trade.mfe_after_pt1;

  if (mfeAtPt1 == null && ticks.length > 0) {
    // Infer from path: split at PT1 time
    const prePt1Ticks = ticks.filter(t => t.timestamp <= pt1Time);
    const postPt1Ticks = ticks.filter(t => t.timestamp > pt1Time);

    mfeAtPt1 = prePt1Ticks.length > 0
      ? Math.max(...prePt1Ticks.map(t => t.mfe_pts || 0))
      : Math.abs(pt1Price - entryPrice);
    maeAtPt1 = prePt1Ticks.length > 0
      ? Math.max(...prePt1Ticks.map(t => t.mae_pts || 0))
      : 0;

    const postPt1MfePeaks = postPt1Ticks.map(t => t.mfe_pts || 0);
    const overallMfe = trade.mfe || 0;
    mfeAfterPt1 = Math.max(0, overallMfe - mfeAtPt1);
  }

  // Runner capture: how much of post-PT1 opportunity was captured
  const runnerLeg = trade.exit_legs.find(l =>
    l.reason !== 'partial_profit_1' && l.reason !== 'partial_profit_2'
  );
  const runnerPnlPts = runnerLeg ? runnerLeg.pnl_points : 0;
  const postPt1Opportunity = mfeAfterPt1 || 0;
  const runnerCapture = postPt1Opportunity > 0.01
    ? round(Math.max(0, runnerPnlPts) / postPt1Opportunity, 2) : 0;

  // Was this a noise exit? (stopped within 1x ATR of PT1 trigger)
  const pt1OffsetPts = Math.abs(pt1Price - entryPrice);
  const runnerExitPrice = runnerLeg?.fill_price || trade.exit_price_actual;
  const distFromPt1 = runnerExitPrice
    ? Math.abs(runnerExitPrice - pt1Price) : 0;
  const noiseExit = distFromPt1 < atr;

  // R at various points
  const peakRBeforePt1 = trade.peak_unrealized_r_before_first_partial
    || (initialRiskPts > 0 ? round((mfeAtPt1 || 0) / initialRiskPts, 2) : 0);
  const givebackR = trade.giveback_after_pt1_r
    || (initialRiskPts > 0 ? round(((trade.mfe || 0) / initialRiskPts) - trade.r_multiple, 2) : 0);

  // Simulate wider trail: what if trail was 0.45x ATR instead of current?
  // We can only estimate: if postPt1Opportunity > wider_trail_distance, runner would have captured more
  const currentTrailPts = atr * 0.3; // current typical
  const widerTrailPts = atr * 0.45;
  const evenWiderTrailPts = atr * 0.6;

  // Simple simulation: if MFE after PT1 > wider trail distance, wider trail would have let runner continue
  // If MFE after PT1 < wider trail distance, wider trail doesn't help (trade didn't move enough)
  const widerTrailWouldHelp = postPt1Opportunity > widerTrailPts && noiseExit;
  const evenWiderWouldHelp = postPt1Opportunity > evenWiderTrailPts && noiseExit;

  results.push({
    trade_id: trade.trade_id,
    side: trade.side,
    setup_type: trade.setup_type,
    management_profile: trade.management_profile || 'unknown',
    atr,
    entry_price: entryPrice,
    pt1_price: pt1Price,
    pt1_offset_pts: round(pt1OffsetPts, 1),
    mfe_at_pt1: round(mfeAtPt1 || 0, 1),
    mae_at_pt1: round(maeAtPt1 || 0, 1),
    mfe_after_pt1: round(postPt1Opportunity, 1),
    total_mfe: round(trade.mfe || 0, 1),
    runner_pnl_pts: round(runnerPnlPts, 1),
    runner_capture_ratio: runnerCapture,
    noise_exit: noiseExit,
    dist_from_pt1_pts: round(distFromPt1, 1),
    r_multiple: trade.r_multiple,
    peak_r_before_pt1: peakRBeforePt1,
    giveback_r: givebackR,
    wider_trail_helps: widerTrailWouldHelp,
    even_wider_helps: evenWiderWouldHelp,
    hold_seconds: trade.hold_time_seconds,
    outcome: trade.outcome_class,
  });
}

// ─── Aggregate statistics ─────────────────────────────────────────────────────

const mfeAtPt1Arr = results.map(r => r.mfe_at_pt1);
const mfeAfterPt1Arr = results.map(r => r.mfe_after_pt1);
const runnerCaptureArr = results.map(r => r.runner_capture_ratio);
const givebackArr = results.map(r => r.giveback_r);
const peakRArr = results.map(r => r.peak_r_before_pt1);
const noiseCount = results.filter(r => r.noise_exit).length;
const widerHelpsCount = results.filter(r => r.wider_trail_helps).length;
const evenWiderHelpsCount = results.filter(r => r.even_wider_helps).length;

const aggStats = {
  total_pt1_trades: results.length,
  noise_exit_count: noiseCount,
  noise_exit_pct: pct(noiseCount, results.length),
  wider_trail_helps_count: widerHelpsCount,
  wider_trail_helps_pct: pct(widerHelpsCount, results.length),
  even_wider_helps_count: evenWiderHelpsCount,
  even_wider_helps_pct: pct(evenWiderHelpsCount, results.length),
  mfe_at_pt1: { mean: round(avg(mfeAtPt1Arr) || 0, 1), median: round(median(mfeAtPt1Arr) || 0, 1) },
  mfe_after_pt1: { mean: round(avg(mfeAfterPt1Arr) || 0, 1), median: round(median(mfeAfterPt1Arr) || 0, 1) },
  runner_capture_ratio: { mean: round(avg(runnerCaptureArr) || 0, 2), median: round(median(runnerCaptureArr) || 0, 2) },
  giveback_r: { mean: round(avg(givebackArr) || 0, 2), median: round(median(givebackArr) || 0, 2) },
  peak_r_before_pt1: { mean: round(avg(peakRArr) || 0, 2), median: round(median(peakRArr) || 0, 2) },
};

// By profile
const byProfile = {};
for (const r of results) {
  const key = r.management_profile;
  if (!byProfile[key]) byProfile[key] = [];
  byProfile[key].push(r);
}

const profileStats = {};
for (const [profile, rs] of Object.entries(byProfile)) {
  profileStats[profile] = {
    count: rs.length,
    noise_exit_pct: pct(rs.filter(r => r.noise_exit).length, rs.length),
    mfe_after_pt1_median: round(median(rs.map(r => r.mfe_after_pt1)) || 0, 1),
    runner_capture_median: round(median(rs.map(r => r.runner_capture_ratio)) || 0, 2),
    avg_r: round(avg(rs.map(r => r.r_multiple)) || 0, 2),
    wider_trail_helps_pct: pct(rs.filter(r => r.wider_trail_helps).length, rs.length),
  };
}

// ─── Print to console ─────────────────────────────────────────────────────────

console.log('='.repeat(70));
console.log('  POST-PT1 FOLLOW-THROUGH ANALYSIS');
console.log('='.repeat(70));
console.log(`\n  Total PT1 trades analyzed: ${aggStats.total_pt1_trades}`);
console.log(`  Noise exits (stopped < 1x ATR from PT1): ${aggStats.noise_exit_count} (${aggStats.noise_exit_pct}%)`);
console.log(`  Wider trail (0.45x ATR) would help: ${aggStats.wider_trail_helps_count} (${aggStats.wider_trail_helps_pct}%)`);
console.log(`  Even wider (0.6x ATR) would help: ${aggStats.even_wider_helps_count} (${aggStats.even_wider_helps_pct}%)`);
console.log();
console.log(`  MFE at PT1:        mean=${aggStats.mfe_at_pt1.mean}pts  median=${aggStats.mfe_at_pt1.median}pts`);
console.log(`  MFE after PT1:     mean=${aggStats.mfe_after_pt1.mean}pts  median=${aggStats.mfe_after_pt1.median}pts`);
console.log(`  Runner capture:    mean=${aggStats.runner_capture_ratio.mean}  median=${aggStats.runner_capture_ratio.median}`);
console.log(`  Giveback R:        mean=${aggStats.giveback_r.mean}R  median=${aggStats.giveback_r.median}R`);
console.log(`  Peak R before PT1: mean=${aggStats.peak_r_before_pt1.mean}R  median=${aggStats.peak_r_before_pt1.median}R`);
console.log();

if (Object.keys(profileStats).length > 0) {
  console.log('  By Management Profile:');
  for (const [p, s] of Object.entries(profileStats)) {
    console.log(`    ${p}: ${s.count} trades | noise=${s.noise_exit_pct}% | mfe_after=${s.mfe_after_pt1_median}pts | capture=${s.runner_capture_median} | avgR=${s.avg_r} | wider_helps=${s.wider_trail_helps_pct}%`);
  }
  console.log();
}

// Key diagnostic answer
console.log('-'.repeat(70));
if (aggStats.mfe_after_pt1.median > 0 && aggStats.noise_exit_pct > 50) {
  console.log('  CONCLUSION: Post-PT1 opportunity EXISTS but trail is killing the runner.');
  console.log('  Median MFE after PT1 = ' + aggStats.mfe_after_pt1.median + 'pts — there IS room for wider trail.');
  console.log('  ' + aggStats.noise_exit_pct + '% of exits are within noise distance of PT1.');
  console.log('  RECOMMENDATION: Widen trail (trail_atr_post_t1: 0.3 -> 0.45+)');
} else if (aggStats.mfe_after_pt1.median <= 0.5) {
  console.log('  CONCLUSION: Entries lack follow-through beyond PT1.');
  console.log('  Median MFE after PT1 = ' + aggStats.mfe_after_pt1.median + 'pts — almost no additional move.');
  console.log('  Widening trail would NOT help. Focus on entry quality / strategy filters.');
} else {
  console.log('  CONCLUSION: Mixed — some trades have follow-through, others do not.');
  console.log('  Need more data or per-profile analysis to distinguish.');
}
console.log('-'.repeat(70));

// ─── Write report ─────────────────────────────────────────────────────────────

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const reportLines = [
  '# Post-PT1 Follow-Through Analysis',
  '',
  `**Generated:** ${new Date().toISOString()}`,
  `**Trades analyzed:** ${aggStats.total_pt1_trades} (with PT1 partial exits)`,
  `**Data source:** ${logDir}/trades.jsonl + trade_path.jsonl`,
  '',
  '## Key Question',
  '',
  '> After PT1 fires, is there usually enough additional movement left to justify a wider trail?',
  '',
  '## Aggregate Statistics',
  '',
  '| Metric | Mean | Median |',
  '|--------|------|--------|',
  `| MFE at PT1 (pts) | ${aggStats.mfe_at_pt1.mean} | ${aggStats.mfe_at_pt1.median} |`,
  `| MFE after PT1 (pts) | ${aggStats.mfe_after_pt1.mean} | ${aggStats.mfe_after_pt1.median} |`,
  `| Runner capture ratio | ${aggStats.runner_capture_ratio.mean} | ${aggStats.runner_capture_ratio.median} |`,
  `| Giveback R | ${aggStats.giveback_r.mean} | ${aggStats.giveback_r.median} |`,
  `| Peak R before PT1 | ${aggStats.peak_r_before_pt1.mean} | ${aggStats.peak_r_before_pt1.median} |`,
  '',
  '## Noise Exits',
  '',
  `- **${aggStats.noise_exit_pct}%** of runner exits were within 1x ATR of PT1 trigger price (noise-level)`,
  `- **${aggStats.wider_trail_helps_pct}%** would have benefited from wider trail (0.45x ATR)`,
  `- **${aggStats.even_wider_helps_pct}%** would have benefited from even wider trail (0.6x ATR)`,
  '',
];

if (Object.keys(profileStats).length > 0) {
  reportLines.push('## By Management Profile', '');
  reportLines.push('| Profile | Trades | Noise Exit % | MFE After PT1 (median) | Runner Capture | Avg R | Wider Trail Helps |');
  reportLines.push('|---------|--------|--------------|------------------------|----------------|-------|-------------------|');
  for (const [p, s] of Object.entries(profileStats)) {
    reportLines.push(`| ${p} | ${s.count} | ${s.noise_exit_pct}% | ${s.mfe_after_pt1_median} pts | ${s.runner_capture_median} | ${s.avg_r} | ${s.wider_trail_helps_pct}% |`);
  }
  reportLines.push('');
}

reportLines.push(
  '## Per-Trade Detail', '',
  '| Trade ID | Side | Profile | MFE@PT1 | MFE After | Runner Capture | Noise? | R | Giveback R |',
  '|----------|------|---------|---------|-----------|----------------|--------|---|------------|',
);
for (const r of results) {
  const shortId = r.trade_id.length > 20 ? '...' + r.trade_id.slice(-15) : r.trade_id;
  reportLines.push(
    `| ${shortId} | ${r.side} | ${r.management_profile} | ${r.mfe_at_pt1} | ${r.mfe_after_pt1} | ${r.runner_capture_ratio} | ${r.noise_exit ? 'YES' : 'no'} | ${r.r_multiple} | ${r.giveback_r} |`
  );
}

reportLines.push('', '## Diagnostic Interpretation', '');
if (aggStats.mfe_after_pt1.median > 0 && aggStats.noise_exit_pct > 50) {
  reportLines.push('**Finding: Trail is too tight.** Post-PT1 opportunity exists (median ' + aggStats.mfe_after_pt1.median + ' pts) but the trail kills the runner in noise (' + aggStats.noise_exit_pct + '% exits within 1x ATR). Widening trail_atr_post_t1 from 0.3 to 0.45+ is justified.');
} else if (aggStats.mfe_after_pt1.median <= 0.5) {
  reportLines.push('**Finding: Entries lack follow-through.** Median MFE after PT1 is only ' + aggStats.mfe_after_pt1.median + ' pts. The market does not continue in the trade direction after PT1. Widening trail would NOT help. Focus on entry quality and strategy filters instead.');
} else {
  reportLines.push('**Finding: Mixed.** Some trades show post-PT1 opportunity, others do not. More data needed, or consider per-profile treatment.');
}

reportLines.push('', '## Unresolved Questions', '');
reportLines.push('- Is the MFE after PT1 an artifact of brief spikes, or does it represent sustained movement?');
reportLines.push('- Would delayed PT1 (larger pt1_offset_atr) also improve outcomes?');
reportLines.push('- Are certain setup types better follow-through candidates than others?');
reportLines.push('- With 16 trades, all conclusions have wide confidence intervals.');

const reportPath = join(outDir, 'post_pt1_followthrough_analysis_20260407.md');
writeFileSync(reportPath, reportLines.join('\n'), 'utf8');
console.log(`\nReport written to: ${reportPath}`);

// Also write raw JSON for programmatic use
const jsonPath = join(outDir, 'pt1_followthrough_data.json');
writeFileSync(jsonPath, JSON.stringify({ aggregate: aggStats, by_profile: profileStats, trades: results }, null, 2), 'utf8');
console.log(`Data written to: ${jsonPath}`);
