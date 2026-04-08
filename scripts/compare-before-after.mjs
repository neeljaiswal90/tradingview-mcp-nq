#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const beforePath = process.argv[2] ?? 'reports/before_metrics.json';
const afterPath = process.argv[3] ?? 'reports/after_metrics.json';
const outDir = process.argv[4] ?? 'reports';

const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

function delta(b, a) {
  if (b === null || a === null || b === undefined || a === undefined) return null;
  return Math.round((a - b) * 1000) / 1000;
}
function pctChange(b, a) {
  if (!b || b === 0) return null;
  return Math.round(((a - b) / Math.abs(b)) * 1000) / 10;
}

const cmp = {
  generated_at: new Date().toISOString(),
  before_label: before.label,
  after_label: after.label,
  headline: {
    total_trades:           { before: before.headline.total_trades,           after: after.headline.total_trades,           delta: delta(before.headline.total_trades, after.headline.total_trades) },
    wins:                   { before: before.headline.wins,                   after: after.headline.wins,                   delta: delta(before.headline.wins, after.headline.wins) },
    losses:                 { before: before.headline.losses,                 after: after.headline.losses,                 delta: delta(before.headline.losses, after.headline.losses) },
    scratches:              { before: before.headline.scratches,              after: after.headline.scratches,              delta: delta(before.headline.scratches, after.headline.scratches) },
    win_rate_pct:           { before: before.headline.win_rate_pct,           after: after.headline.win_rate_pct,           delta: delta(before.headline.win_rate_pct, after.headline.win_rate_pct) },
    expectancy_r:           { before: before.headline.expectancy_r,           after: after.headline.expectancy_r,           delta: delta(before.headline.expectancy_r, after.headline.expectancy_r) },
    avg_winner_r:           { before: before.headline.avg_winner_r,           after: after.headline.avg_winner_r,           delta: delta(before.headline.avg_winner_r, after.headline.avg_winner_r) },
    avg_loser_r:            { before: before.headline.avg_loser_r,            after: after.headline.avg_loser_r,            delta: delta(before.headline.avg_loser_r, after.headline.avg_loser_r) },
    profit_factor:          { before: before.headline.profit_factor,          after: after.headline.profit_factor,          delta: delta(before.headline.profit_factor, after.headline.profit_factor) },
    total_pnl_usd:          { before: before.headline.total_pnl_usd,          after: after.headline.total_pnl_usd,          delta: delta(before.headline.total_pnl_usd, after.headline.total_pnl_usd), pct_change: pctChange(before.headline.total_pnl_usd, after.headline.total_pnl_usd) },
    max_drawdown_usd:       { before: before.headline.max_drawdown_usd,       after: after.headline.max_drawdown_usd,       delta: delta(before.headline.max_drawdown_usd, after.headline.max_drawdown_usd) },
    avg_hold_seconds:       { before: before.headline.avg_hold_seconds,       after: after.headline.avg_hold_seconds,       delta: delta(before.headline.avg_hold_seconds, after.headline.avg_hold_seconds) },
    stop_out_rate_pct:         { before: before.headline.stop_out_rate_pct,         after: after.headline.stop_out_rate_pct,         delta: delta(before.headline.stop_out_rate_pct, after.headline.stop_out_rate_pct) },
    initial_stop_rate_pct:     { before: before.headline.initial_stop_rate_pct,     after: after.headline.initial_stop_rate_pct,     delta: delta(before.headline.initial_stop_rate_pct, after.headline.initial_stop_rate_pct) },
    breakeven_stop_rate_pct:   { before: before.headline.breakeven_stop_rate_pct,   after: after.headline.breakeven_stop_rate_pct,   delta: delta(before.headline.breakeven_stop_rate_pct, after.headline.breakeven_stop_rate_pct) },
    trailing_stop_rate_pct:    { before: before.headline.trailing_stop_rate_pct,    after: after.headline.trailing_stop_rate_pct,    delta: delta(before.headline.trailing_stop_rate_pct, after.headline.trailing_stop_rate_pct) },
    target_1_hit_rate_pct:     { before: before.headline.target_1_hit_rate_pct,     after: after.headline.target_1_hit_rate_pct,     delta: delta(before.headline.target_1_hit_rate_pct, after.headline.target_1_hit_rate_pct) },
    target_2_hit_rate_pct:     { before: before.headline.target_2_hit_rate_pct,     after: after.headline.target_2_hit_rate_pct,     delta: delta(before.headline.target_2_hit_rate_pct, after.headline.target_2_hit_rate_pct) },
    time_stop_rate_pct:        { before: before.headline.time_stop_rate_pct,        after: after.headline.time_stop_rate_pct,        delta: delta(before.headline.time_stop_rate_pct, after.headline.time_stop_rate_pct) },
  },
  giveback: {
    avg_giveback_r:                { before: before.giveback.avg_giveback_r,                after: after.giveback.avg_giveback_r,                delta: delta(before.giveback.avg_giveback_r, after.giveback.avg_giveback_r) },
    trades_with_peak_above_0_5r:   { before: before.giveback.trades_with_peak_above_0_5r,   after: after.giveback.trades_with_peak_above_0_5r,   delta: delta(before.giveback.trades_with_peak_above_0_5r, after.giveback.trades_with_peak_above_0_5r) },
    big_giveback_count_ge_1r:      { before: before.giveback.big_giveback_count_ge_1r,      after: after.giveback.big_giveback_count_ge_1r,      delta: delta(before.giveback.big_giveback_count_ge_1r, after.giveback.big_giveback_count_ge_1r) },
  },
  by_direction: {
    long:  { before: before.breakdowns.by_direction.long,  after: after.breakdowns.by_direction.long  },
    short: { before: before.breakdowns.by_direction.short, after: after.breakdowns.by_direction.short },
  },
  by_setup:  { before: before.breakdowns.by_setup,  after: after.breakdowns.by_setup },
  by_exit_reason: { before: before.breakdowns.by_exit_reason, after: after.breakdowns.by_exit_reason },
  by_exit_reason_detailed: { before: before.breakdowns.by_exit_reason_detailed, after: after.breakdowns.by_exit_reason_detailed },
  signal_volume: {
    before: before.signal_volume,
    after: after.signal_volume,
  },
};

writeFileSync(join(outDir, 'before_after_comparison.json'), JSON.stringify(cmp, null, 2));

// CSV of metric deltas
const rows = ['metric,before,after,delta,pct_change'];
for (const [k, v] of Object.entries(cmp.headline)) {
  rows.push([k, v.before ?? '', v.after ?? '', v.delta ?? '', v.pct_change ?? ''].join(','));
}
for (const [k, v] of Object.entries(cmp.giveback)) {
  rows.push(['giveback.' + k, v.before ?? '', v.after ?? '', v.delta ?? '', ''].join(','));
}
writeFileSync(join(outDir, 'before_after_metric_deltas.csv'), rows.join('\n'));

console.log('=== BEFORE vs AFTER comparison ===\n');
console.log('Metric                      BEFORE        AFTER         Δ');
console.log('-'.repeat(60));
for (const [k, v] of Object.entries(cmp.headline)) {
  console.log(`${k.padEnd(26)} ${String(v.before).padEnd(13)} ${String(v.after).padEnd(13)} ${v.delta === null ? '' : (v.delta > 0 ? '+' : '') + v.delta}`);
}
console.log('-'.repeat(60));
console.log('Givebacks:');
for (const [k, v] of Object.entries(cmp.giveback)) {
  console.log(`  ${k.padEnd(34)} ${String(v.before).padEnd(8)} ${String(v.after).padEnd(8)} Δ=${v.delta ?? ''}`);
}
console.log('\nBy direction:');
console.log(`  long:  before n=${cmp.by_direction.long.before?.n} avgR=${cmp.by_direction.long.before?.avg_r} pnl=$${cmp.by_direction.long.before?.total_pnl_usd}  →  after n=${cmp.by_direction.long.after?.n} avgR=${cmp.by_direction.long.after?.avg_r} pnl=$${cmp.by_direction.long.after?.total_pnl_usd}`);
console.log(`  short: before n=${cmp.by_direction.short.before?.n} avgR=${cmp.by_direction.short.before?.avg_r} pnl=$${cmp.by_direction.short.before?.total_pnl_usd}  →  after n=${cmp.by_direction.short.after?.n} avgR=${cmp.by_direction.short.after?.avg_r} pnl=$${cmp.by_direction.short.after?.total_pnl_usd}`);
console.log('\nArtifacts:');
console.log('  reports/before_metrics.json');
console.log('  reports/after_metrics.json');
console.log('  reports/before_after_comparison.json');
console.log('  reports/before_after_metric_deltas.csv');
