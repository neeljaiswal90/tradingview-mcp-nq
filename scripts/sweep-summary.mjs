#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';

const tags = [
  'baseline', 'rr_1.85', 'rr_1.75',
  'conf_7.2', 'conf_6.8',
  'maxconf_disabled', 'maxconf_8.9',
  'combined_rr1.85_conf7.2', 'combined_rr1.75_conf6.8_maxconf8.9'
];

const overrides = {
  'baseline': '(none)',
  'rr_1.85': 'min_rr=1.85',
  'rr_1.75': 'min_rr=1.75',
  'conf_7.2': 'min_conf=7.2',
  'conf_6.8': 'min_conf=6.8',
  'maxconf_disabled': 'max_conf=10.0',
  'maxconf_8.9': 'max_conf=8.9',
  'combined_rr1.85_conf7.2': 'rr=1.85+conf=7.2',
  'combined_rr1.75_conf6.8_maxconf8.9': 'rr=1.75+conf=6.8+mc=8.9'
};

const allData = [];
console.log('');
console.log('SENSITIVITY SWEEP — FULL RESULTS');
console.log('='.repeat(135));
console.log(
  'Label'.padEnd(42) +
  'Overrides'.padEnd(25) +
  'Trades'.padStart(6) +
  '  WR%'.padStart(6) +
  '  E[R]'.padStart(7) +
  '    PF'.padStart(7) +
  '  PnL($)'.padStart(10) +
  '  MaxDD($)'.padStart(10) +
  '  StopInit%'.padStart(10) +
  '  StopTrail%'.padStart(11)
);
console.log('-'.repeat(135));

for (const tag of tags) {
  const path = `reports/sensitivity/${tag}/${tag}_metrics.json`;
  if (!existsSync(path)) { console.log(`${tag}: NO DATA`); continue; }
  const m = JSON.parse(readFileSync(path, 'utf8')).headline;
  allData.push({ tag, ...m });

  const row =
    tag.padEnd(42) +
    (overrides[tag] || '').padEnd(25) +
    String(m.total_trades).padStart(6) +
    String(m.win_rate_pct).padStart(6) +
    String(m.expectancy_r).padStart(7) +
    String(m.profit_factor).padStart(7) +
    String(m.total_pnl_usd).padStart(10) +
    String(m.max_drawdown_usd).padStart(10) +
    String(m.initial_stop_rate_pct ?? '-').padStart(10) +
    String(m.trailing_stop_rate_pct ?? '-').padStart(11);
  console.log(row);
}

console.log('-'.repeat(135));
console.log('');

// Write comparison JSON
writeFileSync('reports/sensitivity/sweep_comparison.json', JSON.stringify(allData, null, 2));

// Write CSV
const cols = Object.keys(allData[0]);
const csvRows = [cols.join(',')];
for (const h of allData) {
  csvRows.push(cols.map(c => h[c] ?? '').join(','));
}
writeFileSync('reports/sensitivity/sweep_summary.csv', csvRows.join('\n'));
console.log('Wrote reports/sensitivity/sweep_comparison.json');
console.log('Wrote reports/sensitivity/sweep_summary.csv');
