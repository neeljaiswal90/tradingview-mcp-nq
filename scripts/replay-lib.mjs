#!/usr/bin/env node
/**
 * replay-lib.mjs — Shared helpers for replay metrics analysis scripts.
 *
 * Exports:
 *   readJsonl(path)         → array of parsed objects
 *   computeMetrics(opts)    → full metrics object
 *   writeReports(metrics, outDir, label) → writes JSON + CSV
 *   printSummary(metrics)   → compact stdout print
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Core utilities ────────────────────────────────────────────────────────────

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function round(x, d = 2) { const f = 10 ** d; return Math.round(x * f) / f; }
export function pct(a, b) { return b === 0 ? null : round((a / b) * 100, 1); }
export function avg(arr) { return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length; }

function group(items, keyFn) {
  const g = {};
  for (const it of items) {
    const k = keyFn(it);
    if (!g[k]) g[k] = [];
    g[k].push(it);
  }
  return g;
}

function summarize(arr) {
  const w = arr.filter(t => t.outcome_class === 'winner').length;
  const l = arr.filter(t => t.outcome_class === 'loser').length;
  const rs = arr.map(t => t.r_multiple);
  return {
    n: arr.length, wins: w, losses: l,
    win_rate_pct: pct(w, arr.length),
    avg_r: rs.length ? round(avg(rs), 3) : null,
    total_pnl_usd: round(arr.reduce((s, t) => s + t.pnl_realized, 0)),
  };
}

// ─── Main metrics computation ──────────────────────────────────────────────────

/**
 * computeMetrics({ logsDir, label })
 * Reads JSONL files from logsDir and returns a structured metrics object.
 */
export function computeMetrics({ logsDir, label = 'RUN' }) {
  const trades = readJsonl(join(logsDir, 'trades.jsonl'));
  const signals = readJsonl(join(logsDir, 'signals.jsonl'));
  const rejected = readJsonl(join(logsDir, 'rejected_signals.jsonl'));
  const paths = readJsonl(join(logsDir, 'trade_path.jsonl'));

  // ─── Integrity checks ────────────────────────────────────────────────────────
  const integrity = {
    trades_count: trades.length,
    signals_count: signals.length,
    rejected_count: rejected.length,
    path_count: paths.length,
    duplicate_trade_ids: 0,
    duplicate_signal_ids: 0,
    orphan_trades_no_parent: 0,
    missing_entry_price: 0,
    missing_exit_price: 0,
    negative_rr_trades: 0,
    invalid_target_dir_trades: 0,
    impossible_exit_reason: 0,
    trades_without_path: 0,
    ambiguous_exits: 0,
  };
  const tradeIds = new Set();
  const signalIds = new Set();
  const signalById = new Map();
  for (const s of signals) { signalIds.add(s.signal_id); signalById.set(s.signal_id, s); }
  for (const t of trades) {
    if (tradeIds.has(t.trade_id)) integrity.duplicate_trade_ids++;
    tradeIds.add(t.trade_id);
    if (!signalIds.has(t.parent_signal_id)) integrity.orphan_trades_no_parent++;
    if (!t.entry_price_filled) integrity.missing_entry_price++;
    if (!t.exit_price_actual) integrity.missing_exit_price++;
    if (t.r_multiple !== 0 && !Number.isFinite(t.r_multiple)) integrity.negative_rr_trades++;
    if (t.target_1_direction_valid === false || t.target_2_direction_valid === false) integrity.invalid_target_dir_trades++;
    const validExitReasons = new Set([
      'target_1', 'target_2', 'target_3',
      'stop_loss', 'stop_loss_initial', 'stop_loss_breakeven', 'stop_loss_trailing',
      'time_stop', 'invalidation', 'manual', 'daily_loss_limit', 'session_end',
    ]);
    if (!validExitReasons.has(t.exit_reason)) integrity.impossible_exit_reason++;
    if (t.ambiguous_exit === true) integrity.ambiguous_exits++;
  }
  const tradeIdsInPath = new Set(paths.map(p => p.trade_id));
  for (const t of trades) if (!tradeIdsInPath.has(t.trade_id)) integrity.trades_without_path++;

  // ─── Aggregate metrics ───────────────────────────────────────────────────────
  const wins = trades.filter(t => t.outcome_class === 'winner');
  const losses = trades.filter(t => t.outcome_class === 'loser');
  const scratches = trades.filter(t => t.outcome_class === 'scratch');
  const totalPnl = round(trades.reduce((s, t) => s + (t.pnl_realized || 0), 0));
  const winPnl = wins.reduce((s, t) => s + t.pnl_realized, 0);
  const losPnl = Math.abs(losses.reduce((s, t) => s + t.pnl_realized, 0));
  const avgR = avg(trades.map(t => t.r_multiple));
  const avgWinR = avg(wins.map(t => t.r_multiple));
  const avgLossR = avg(losses.map(t => t.r_multiple));
  const expectancy = avgR === null ? null : round(avgR, 3);
  const profitFactor = losPnl > 0 ? round(winPnl / losPnl, 2) : null;

  const holds = trades.map(t => t.hold_time_seconds).filter(h => typeof h === 'number');

  const exitReasons = {};
  for (const t of trades) exitReasons[t.exit_reason] = (exitReasons[t.exit_reason] || 0) + 1;

  const exitReasonsDetailed = {};
  for (const t of trades) {
    const key = t.exit_reason_detailed ?? t.exit_reason;
    exitReasonsDetailed[key] = (exitReasonsDetailed[key] || 0) + 1;
  }

  const givebacks = trades.filter(t => t.max_unrealized_r > 0.5).map(t => ({
    trade_id: t.trade_id, side: t.side, setup: t.setup_type,
    peak_r: t.max_unrealized_r, final_r: t.r_multiple,
    giveback_r: round(t.max_unrealized_r - t.r_multiple, 2),
  }));
  const bigGivebacks = givebacks.filter(g => g.giveback_r >= 1.0);

  let cum = 0, peak = 0, dd = 0;
  for (const t of trades) {
    cum += t.pnl_realized;
    if (cum > peak) peak = cum;
    const thisDd = peak - cum;
    if (thisDd > dd) dd = thisDd;
  }
  const maxDrawdownUsd = round(dd);

  const bySetup = Object.fromEntries(Object.entries(group(trades, t => t.setup_type)).map(([k, v]) => [k, summarize(v)]));
  const byDirection = Object.fromEntries(Object.entries(group(trades, t => t.side)).map(([k, v]) => [k, summarize(v)]));
  const byRegime = Object.fromEntries(Object.entries(group(trades, t => t.market_regime)).map(([k, v]) => [k, summarize(v)]));
  const byExitReason = Object.fromEntries(Object.entries(group(trades, t => t.exit_reason)).map(([k, v]) => [k, summarize(v)]));
  const byExitReasonDetailed = Object.fromEntries(
    Object.entries(group(trades, t => t.exit_reason_detailed ?? t.exit_reason)).map(([k, v]) => [k, summarize(v)])
  );
  const byConfidenceBucket = Object.fromEntries(Object.entries(group(trades, t => t.confidence_bucket)).map(([k, v]) => [k, summarize(v)]));

  const rejReasonCounts = {};
  for (const r of rejected) {
    const reason = (r.reason_for_skip || 'unknown').split(';')[0].trim();
    rejReasonCounts[reason] = (rejReasonCounts[reason] || 0) + 1;
  }
  const rejReasonsSorted = Object.entries(rejReasonCounts).sort((a, b) => b[1] - a[1]);

  const signalsWithSetup = signals.filter(s => s.candidate_setup).length;
  const executedCount = signals.filter(s => s.execution_occurred).length;

  const stopCountDetailed =
    (exitReasonsDetailed['stop_loss_initial'] || 0) +
    (exitReasonsDetailed['stop_loss_breakeven'] || 0) +
    (exitReasonsDetailed['stop_loss_trailing'] || 0);
  const stopCountLegacy = exitReasons['stop_loss'] || 0;
  const hasDetailedLabels = Object.keys(exitReasonsDetailed).some(k =>
    ['stop_loss_initial', 'stop_loss_breakeven', 'stop_loss_trailing'].includes(k)
  );
  const stopOutRate = pct(hasDetailedLabels ? stopCountDetailed : stopCountLegacy, trades.length);
  const initialStopRate = pct(exitReasonsDetailed['stop_loss_initial'] || 0, trades.length);
  const beStopRate = pct(exitReasonsDetailed['stop_loss_breakeven'] || 0, trades.length);
  const trailingStopRate = pct(exitReasonsDetailed['stop_loss_trailing'] || 0, trades.length);
  const t1Rate = pct(exitReasons['target_1'] || 0, trades.length);
  const t2Rate = pct(exitReasons['target_2'] || 0, trades.length);
  const timeStopRate = pct(exitReasons['time_stop'] || 0, trades.length);

  const slipActual = trades.map(t => t.slippage_actual).filter(n => typeof n === 'number');
  const slipExitPlan = trades.map(t => t.exit_slippage_vs_plan_pts).filter(n => typeof n === 'number');

  return {
    label,
    logs_dir: logsDir,
    generated_at: new Date().toISOString(),
    integrity,
    headline: {
      total_trades: trades.length,
      wins: wins.length, losses: losses.length, scratches: scratches.length,
      win_rate_pct: pct(wins.length, trades.length),
      avg_r: expectancy,
      expectancy_r: expectancy,
      avg_winner_r: avgWinR === null ? null : round(avgWinR, 3),
      avg_loser_r: avgLossR === null ? null : round(avgLossR, 3),
      profit_factor: profitFactor,
      total_pnl_usd: totalPnl,
      max_drawdown_usd: maxDrawdownUsd,
      avg_hold_seconds: holds.length ? Math.round(avg(holds)) : null,
      stop_out_rate_pct: stopOutRate,
      initial_stop_rate_pct: initialStopRate,
      breakeven_stop_rate_pct: beStopRate,
      trailing_stop_rate_pct: trailingStopRate,
      target_1_hit_rate_pct: t1Rate,
      target_2_hit_rate_pct: t2Rate,
      time_stop_rate_pct: timeStopRate,
    },
    signal_volume: {
      total_signals: signals.length,
      candidate_generated: signalsWithSetup,
      executed: executedCount,
      rejected_total: rejected.length,
      candidate_rate_pct: pct(signalsWithSetup, signals.length),
      execution_rate_pct: pct(executedCount, signals.length),
    },
    breakdowns: {
      by_setup: bySetup,
      by_direction: byDirection,
      by_regime: byRegime,
      by_exit_reason: byExitReason,
      by_exit_reason_detailed: byExitReasonDetailed,
      by_confidence_bucket: byConfidenceBucket,
    },
    giveback: {
      trades_with_peak_above_0_5r: givebacks.length,
      avg_giveback_r: givebacks.length ? round(avg(givebacks.map(g => g.giveback_r)), 2) : null,
      big_giveback_count_ge_1r: bigGivebacks.length,
      worst_giveback_examples: givebacks.sort((a, b) => b.giveback_r - a.giveback_r).slice(0, 5),
    },
    slippage: {
      avg_slippage_pts: slipActual.length ? round(avg(slipActual), 3) : null,
      avg_exit_slippage_vs_plan_pts: slipExitPlan.length ? round(avg(slipExitPlan), 3) : null,
    },
    top_rejection_reasons: rejReasonsSorted.slice(0, 20).map(([r, n]) => ({ reason: r, count: n })),
  };
}

// ─── Output helpers ────────────────────────────────────────────────────────────

export function writeReports(metrics, outDir, label) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const slug = label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  writeFileSync(join(outDir, `${slug}_metrics.json`), JSON.stringify(metrics, null, 2));

  const csvRows = ['group,key,n,wins,losses,win_rate_pct,avg_r,total_pnl_usd'];
  for (const [grpName, grp] of Object.entries(metrics.breakdowns)) {
    for (const [k, v] of Object.entries(grp)) {
      csvRows.push([grpName, k, v.n, v.wins, v.losses, v.win_rate_pct ?? '', v.avg_r ?? '', v.total_pnl_usd].join(','));
    }
  }
  writeFileSync(join(outDir, `${slug}_breakdowns.csv`), csvRows.join('\n'));
  return { metricsPath: join(outDir, `${slug}_metrics.json`), csvPath: join(outDir, `${slug}_breakdowns.csv`) };
}

export function printSummary(metrics) {
  const h = metrics.headline;
  const bk = metrics.breakdowns;
  console.log(`\n═══ ${metrics.label} — ${metrics.logs_dir} ═══`);
  console.log(`Trades: ${h.total_trades}  |  Wins: ${h.wins}  Losses: ${h.losses}  Scratches: ${h.scratches}`);
  console.log(`Win rate: ${h.win_rate_pct ?? 'n/a'}%  |  Avg R: ${h.avg_r ?? 'n/a'}  |  Profit factor: ${h.profit_factor ?? 'n/a'}`);
  console.log(`Total PnL: $${h.total_pnl_usd}  |  Max DD: $${h.max_drawdown_usd}  |  Avg hold: ${h.avg_hold_seconds ?? 'n/a'}s`);
  console.log(`T1 hit: ${h.target_1_hit_rate_pct ?? 'n/a'}%  |  T2 hit: ${h.target_2_hit_rate_pct ?? 'n/a'}%  |  Stop-out: ${h.stop_out_rate_pct ?? 'n/a'}%  |  Time stop: ${h.time_stop_rate_pct ?? 'n/a'}%`);
  if (h.initial_stop_rate_pct !== null || h.breakeven_stop_rate_pct !== null || h.trailing_stop_rate_pct !== null) {
    console.log(`  ↳ Initial stop: ${h.initial_stop_rate_pct ?? 'n/a'}%  BE stop: ${h.breakeven_stop_rate_pct ?? 'n/a'}%  Trailing stop: ${h.trailing_stop_rate_pct ?? 'n/a'}%`);
  }

  if (Object.keys(bk.by_setup).length) {
    console.log('\nBy setup:');
    for (const [k, v] of Object.entries(bk.by_setup)) {
      console.log(`  ${k.padEnd(30)} n=${String(v.n).padStart(3)}  wr=${String(v.win_rate_pct ?? 'n/a').padStart(5)}%  avgR=${v.avg_r ?? 'n/a'}  pnl=$${v.total_pnl_usd}`);
    }
  }

  if (Object.keys(bk.by_exit_reason_detailed).length) {
    console.log('\nBy exit reason:');
    for (const [k, v] of Object.entries(bk.by_exit_reason_detailed)) {
      console.log(`  ${k.padEnd(25)} n=${String(v.n).padStart(3)}  avgR=${v.avg_r ?? 'n/a'}`);
    }
  }

  if (metrics.giveback.worst_giveback_examples?.length) {
    console.log(`\nTop givebacks (trades with peak >0.5R then reversed):`);
    for (const g of metrics.giveback.worst_giveback_examples) {
      console.log(`  ${g.trade_id.slice(-8)}  peak=${g.peak_r}R → final=${g.final_r}R  giveback=${g.giveback_r}R  (${g.side} ${g.setup})`);
    }
  }
  console.log('');
}
