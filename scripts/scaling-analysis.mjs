#!/usr/bin/env node
/**
 * Scaling Rules Analysis — MFE/MAE study for partial-profit optimization.
 *
 * Reads ALL historical trade JSONL files, aggregates MFE/MAE data,
 * and simulates candidate PT1/PT2 scaling rules to recommend data-backed
 * partial-profit thresholds.
 *
 * Usage: node scripts/scaling-analysis.mjs
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join, basename } from 'path';

// ─── Load all trades from all historical directories ──────────────────────────

function loadTradesFromDir(dir) {
  const tradesFile = join(dir, 'trades.jsonl');
  if (!existsSync(tradesFile)) return [];
  const lines = readFileSync(tradesFile, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function loadAllTrades() {
  const logsDir = join(process.cwd(), 'logs');
  const allTrades = [];
  const sources = [];

  // Load from all subdirectories that contain trades.jsonl
  const entries = readdirSync(logsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const dir = join(logsDir, entry.name);
      const trades = loadTradesFromDir(dir);
      if (trades.length > 0) {
        sources.push({ dir: entry.name, count: trades.length });
        allTrades.push(...trades);
      }
    }
  }

  // Also load root-level trades
  const rootTrades = loadTradesFromDir(logsDir);
  if (rootTrades.length > 0) {
    sources.push({ dir: 'root', count: rootTrades.length });
    allTrades.push(...rootTrades);
  }

  return { allTrades, sources };
}

// ─── Deduplicate trades by trade_id ──────────────────────────────────────────

function deduplicateTrades(trades) {
  // Prefer sweep_v2 data, then historical_after, then sensitivity_baseline
  // Use the largest dataset version for each unique trade scenario
  const seen = new Map();
  for (const t of trades) {
    const key = `${t.side}_${t.setup_type}_${t.entry_price_filled}_${t.timestamp_entry}`;
    if (!seen.has(key)) {
      seen.set(key, t);
    }
  }
  return [...seen.values()];
}

// ─── Core MFE/MAE Analysis ──────────────────────────────────────────────────

function analyzeMfeStructure(trades) {
  const thresholds = [4, 6, 8, 10, 12, 15, 20, 25, 30];
  const results = {};

  for (const threshold of thresholds) {
    const reached = trades.filter(t => t.mfe >= threshold);
    const reachedAndLost = reached.filter(t => t.outcome_class === 'loser');
    const reachedAndBE = reached.filter(t => t.outcome_class === 'scratch');
    const reachedAndWon = reached.filter(t => t.outcome_class === 'winner');

    // Of those that reached this MFE, how many ended up as losers?
    const reverseRate = reached.length > 0 ? reachedAndLost.length / reached.length : 0;

    // Average leftover: MFE - actual realized points
    const leftover = reached.map(t => {
      const realizedPts = t.side === 'long'
        ? (t.exit_price_actual || t.exit_price_planned) - t.entry_price_filled
        : t.entry_price_filled - (t.exit_price_actual || t.exit_price_planned);
      return t.mfe - Math.max(0, realizedPts);
    });
    const avgLeftover = leftover.length > 0 ? leftover.reduce((a, b) => a + b, 0) / leftover.length : 0;

    results[threshold] = {
      threshold,
      total: trades.length,
      reached: reached.length,
      reachRate: reached.length / trades.length,
      thenLost: reachedAndLost.length,
      thenBE: reachedAndBE.length,
      thenWon: reachedAndWon.length,
      reverseRate,
      avgLeftoverPts: Math.round(avgLeftover * 100) / 100,
      avgMfeOfReached: reached.length > 0
        ? Math.round(reached.reduce((a, t) => a + t.mfe, 0) / reached.length * 100) / 100
        : 0,
    };
  }

  return results;
}

// ─── Simulate scaling rules on trades ───────────────────────────────────────

function simulateScalingRule(trades, pt1Pts, pt2Pts, splitPct1, splitPct2, moveToBeAfterPt1, contract) {
  const pointValue = contract === 'NQ' ? 20 : 2;
  const tickSize = 0.25;
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let pt1Saves = 0; // trades where PT1 saved a trade that later reversed
  let pt1Hits = 0;
  let pt2Hits = 0;
  let earlyMonetized = 0;
  let totalR = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  const tradeResults = [];

  for (const t of trades) {
    const qty = t.quantity || 1;
    const entryPrice = t.entry_price_filled;
    const riskPts = Math.abs(entryPrice - t.stop_price_initial);
    if (riskPts <= 0) continue;

    const mfe = t.mfe || 0;
    const mae = t.mae || 0;
    const isLong = t.side === 'long';

    // What actually happened
    const actualExitPrice = t.exit_price_actual || t.exit_price_planned;
    const actualPnlPts = isLong ? actualExitPrice - entryPrice : entryPrice - actualExitPrice;

    // Simulate PT1
    const pt1Hit = mfe >= pt1Pts;
    const pt1Qty = pt1Hit ? Math.max(1, Math.floor(qty * splitPct1)) : 0;
    const remainingAfterPt1 = qty - pt1Qty;

    // Simulate PT2
    const pt2Hit = mfe >= pt2Pts;
    const pt2Qty = pt2Hit ? Math.max(1, Math.floor(remainingAfterPt1 * (splitPct2 / (1 - splitPct1)))) : 0;
    const runnerQty = remainingAfterPt1 - pt2Qty;

    // Compute simulated PnL
    let simPnl = 0;

    if (pt1Hit) {
      // PT1 portion realized at pt1Pts
      const pt1Pnl = pt1Pts * pt1Qty * pointValue;
      simPnl += pt1Pnl;
      pt1Hits++;

      if (pt2Hit) {
        // PT2 portion realized at pt2Pts
        const pt2Pnl = pt2Pts * pt2Qty * pointValue;
        simPnl += pt2Pnl;
        pt2Hits++;

        // Runner: uses actual exit (but with BE floor if enabled)
        if (runnerQty > 0) {
          let runnerExitPts = actualPnlPts;
          if (moveToBeAfterPt1 && runnerExitPts < 0) {
            runnerExitPts = 0; // BE floor
          }
          simPnl += runnerExitPts * runnerQty * pointValue;
        }
      } else {
        // No PT2: remaining exits at actual price (with BE floor)
        let remainExitPts = actualPnlPts;
        if (moveToBeAfterPt1 && remainExitPts < 0) {
          remainExitPts = 0;
        }
        simPnl += remainExitPts * remainingAfterPt1 * pointValue;
      }
    } else {
      // No PT1 hit: entire position exits at actual price
      simPnl = actualPnlPts * qty * pointValue;
    }

    // Did PT1 save this trade? (reached PT1 level then reversed to a loss)
    if (pt1Hit && actualPnlPts < 0) {
      pt1Saves++;
    }

    // Did we monetize early favorable excursion?
    if (pt1Hit && mfe > actualPnlPts) {
      earlyMonetized++;
    }

    const simR = simPnl / (riskPts * qty * pointValue);
    totalR += simR;
    totalPnl += simPnl;

    if (simPnl > 0.5 * pointValue) {
      wins++;
      grossProfit += simPnl;
    } else if (simPnl < -0.5 * pointValue) {
      losses++;
      grossLoss += Math.abs(simPnl);
    } else {
      scratches++;
    }

    tradeResults.push({
      trade_id: t.trade_id,
      actualPnl: actualPnlPts * qty * pointValue,
      simPnl,
      delta: simPnl - (actualPnlPts * qty * pointValue),
      pt1Hit,
      pt2Hit,
      mfe,
      mae,
      actualR: actualPnlPts / riskPts,
      simR,
    });
  }

  const n = trades.length;
  return {
    pt1Pts, pt2Pts,
    splitPct1: Math.round(splitPct1 * 100),
    splitPct2: Math.round(splitPct2 * 100),
    moveToBeAfterPt1,
    tradeCount: n,
    wins, losses, scratches,
    winRate: n > 0 ? Math.round(wins / n * 10000) / 100 : 0,
    avgR: n > 0 ? Math.round(totalR / n * 100) / 100 : 0,
    expectancy: n > 0 ? Math.round(totalPnl / n * 100) / 100 : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100,
    grossLoss: Math.round(grossLoss * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : Infinity,
    pt1HitRate: n > 0 ? Math.round(pt1Hits / n * 10000) / 100 : 0,
    pt2HitRate: n > 0 ? Math.round(pt2Hits / n * 10000) / 100 : 0,
    pt1Saves,
    pt1SaveRate: n > 0 ? Math.round(pt1Saves / n * 10000) / 100 : 0,
    earlyMonetized,
    earlyMonetizedRate: n > 0 ? Math.round(earlyMonetized / n * 10000) / 100 : 0,
    tradeResults,
  };
}

// ─── Compute baseline (no scaling) metrics ──────────────────────────────────

function computeBaseline(trades, contract) {
  const pointValue = contract === 'NQ' ? 20 : 2;
  let totalPnl = 0, wins = 0, losses = 0, scratches = 0, totalR = 0;
  let grossProfit = 0, grossLoss = 0;

  for (const t of trades) {
    const qty = t.quantity || 1;
    const entryPrice = t.entry_price_filled;
    const riskPts = Math.abs(entryPrice - t.stop_price_initial);
    if (riskPts <= 0) continue;

    const actualExitPrice = t.exit_price_actual || t.exit_price_planned;
    const actualPnlPts = t.side === 'long'
      ? actualExitPrice - entryPrice
      : entryPrice - actualExitPrice;
    const pnl = actualPnlPts * qty * pointValue;

    totalPnl += pnl;
    const r = actualPnlPts / riskPts;
    totalR += r;

    if (pnl > 0.5 * pointValue) { wins++; grossProfit += pnl; }
    else if (pnl < -0.5 * pointValue) { losses++; grossLoss += Math.abs(pnl); }
    else { scratches++; }
  }

  const n = trades.length;
  return {
    tradeCount: n, wins, losses, scratches,
    winRate: n > 0 ? Math.round(wins / n * 10000) / 100 : 0,
    avgR: n > 0 ? Math.round(totalR / n * 100) / 100 : 0,
    expectancy: n > 0 ? Math.round(totalPnl / n * 100) / 100 : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100,
    grossLoss: Math.round(grossLoss * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : Infinity,
  };
}

// ─── Context breakdown analysis ─────────────────────────────────────────────

function breakdownByField(trades, field) {
  const groups = {};
  for (const t of trades) {
    const key = t[field] || 'unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  return groups;
}

// ─── Max drawdown calculation ───────────────────────────────────────────────

function maxDrawdown(tradeResults) {
  let peak = 0, maxDD = 0, equity = 0;
  for (const tr of tradeResults) {
    equity += tr.simPnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return Math.round(maxDD * 100) / 100;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log('=== SCALING RULES ANALYSIS ===\n');

  // Load all trades
  const { allTrades, sources } = loadAllTrades();
  console.log(`Loaded ${allTrades.length} total trade records from ${sources.length} sources:`);
  for (const s of sources) {
    console.log(`  ${s.dir}: ${s.count} trades`);
  }

  // Filter to NQ trades only (exclude crypto)
  const nqTrades = allTrades.filter(t =>
    t.symbol === 'NQ1!' || t.symbol === 'MNQ1!' ||
    (t.venue && t.venue.includes('CME'))
  );
  console.log(`\nNQ/MNQ trades: ${nqTrades.length}`);

  // Deduplicate
  const trades = deduplicateTrades(nqTrades);
  console.log(`After deduplication: ${trades.length} unique trades\n`);

  // Determine contract type from data
  const contract = trades[0]?.symbol?.includes('MNQ') ? 'MNQ' : 'NQ';
  const pointValue = contract === 'NQ' ? 20 : 2;
  console.log(`Contract: ${contract} (point_value=$${pointValue})\n`);

  // ─── A. MFE/MAE Structure ──────────────────────────────────────────────
  console.log('═══════════════════════════════════════════');
  console.log('A. MFE / MAE STRUCTURE');
  console.log('═══════════════════════════════════════════\n');

  const mfeStructure = analyzeMfeStructure(trades);
  console.log('MFE Distribution:');
  console.log('Threshold | Reached | Rate   | Then Lost | Then Won | Reverse% | Avg Leftover');
  console.log('----------|---------|--------|-----------|----------|----------|------------');
  for (const [threshold, r] of Object.entries(mfeStructure)) {
    console.log(
      `${String(threshold).padStart(6)}pts | ${String(r.reached).padStart(7)} | ` +
      `${(r.reachRate * 100).toFixed(1).padStart(5)}% | ` +
      `${String(r.thenLost).padStart(9)} | ${String(r.thenWon).padStart(8)} | ` +
      `${(r.reverseRate * 100).toFixed(1).padStart(7)}% | ` +
      `${r.avgLeftoverPts.toFixed(1).padStart(8)}pts`
    );
  }

  // Overall MFE/MAE stats
  const avgMfe = trades.reduce((a, t) => a + (t.mfe || 0), 0) / trades.length;
  const avgMae = trades.reduce((a, t) => a + (t.mae || 0), 0) / trades.length;
  const medianMfe = trades.map(t => t.mfe || 0).sort((a, b) => a - b)[Math.floor(trades.length / 2)];
  const medianMae = trades.map(t => t.mae || 0).sort((a, b) => a - b)[Math.floor(trades.length / 2)];

  console.log(`\nOverall MFE: avg=${avgMfe.toFixed(1)}pts, median=${medianMfe.toFixed(1)}pts`);
  console.log(`Overall MAE: avg=${avgMae.toFixed(1)}pts, median=${medianMae.toFixed(1)}pts`);

  // Trades that reached +X pts then reversed to a loss
  const losers = trades.filter(t => t.outcome_class === 'loser');
  const losersWithMfe6 = losers.filter(t => t.mfe >= 6);
  const losersWithMfe4 = losers.filter(t => t.mfe >= 4);
  console.log(`\nLosers: ${losers.length} / ${trades.length} (${(losers.length / trades.length * 100).toFixed(1)}%)`);
  console.log(`Losers that first reached +4pts: ${losersWithMfe4.length} (${(losersWithMfe4.length / losers.length * 100).toFixed(1)}% of losers)`);
  console.log(`Losers that first reached +6pts: ${losersWithMfe6.length} (${(losersWithMfe6.length / losers.length * 100).toFixed(1)}% of losers)`);

  // Average risk (stop distance) in points
  const avgRisk = trades.reduce((a, t) => a + Math.abs(t.entry_price_filled - t.stop_price_initial), 0) / trades.length;
  console.log(`\nAverage risk (stop distance): ${avgRisk.toFixed(1)}pts`);
  console.log(`Average risk in R: 1R = ${avgRisk.toFixed(1)}pts = $${(avgRisk * pointValue).toFixed(0)}`);

  // ─── B. Baseline (no scaling) ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('B. BASELINE (CURRENT — NO PARTIAL PROFITS)');
  console.log('═══════════════════════════════════════════\n');

  const baseline = computeBaseline(trades, contract);
  console.log(`Trades: ${baseline.tradeCount}`);
  console.log(`Win Rate: ${baseline.winRate}%`);
  console.log(`Avg R: ${baseline.avgR}`);
  console.log(`Expectancy: $${baseline.expectancy}/trade`);
  console.log(`Total PnL: $${baseline.totalPnl}`);
  console.log(`Profit Factor: ${baseline.profitFactor}`);
  console.log(`Gross Profit: $${baseline.grossProfit} | Gross Loss: $${baseline.grossLoss}`);

  // ─── C. PT1 Candidate Sweep ───────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('C. PT1/PT2 CANDIDATE SWEEP');
  console.log('═══════════════════════════════════════════\n');

  const pt1Candidates = [4, 6, 8, 10, 12];
  const pt2Candidates = [8, 10, 12, 15, 20, 25];
  const splitOptions = [
    { s1: 0.50, s2: 0.25, label: '50/25/runner' },
    { s1: 0.50, s2: 0.50, label: '50/50' },
    { s1: 0.33, s2: 0.34, label: '33/34/runner' },
    { s1: 0.25, s2: 0.25, label: '25/25/runner' },
  ];

  const allResults = [];

  for (const pt1 of pt1Candidates) {
    for (const pt2 of pt2Candidates) {
      if (pt2 <= pt1) continue; // PT2 must be further than PT1

      for (const split of splitOptions) {
        for (const be of [true, false]) {
          const result = simulateScalingRule(trades, pt1, pt2, split.s1, split.s2, be, contract);
          result.splitLabel = split.label;
          result.dd = maxDrawdown(result.tradeResults);
          allResults.push(result);
        }
      }
    }
  }

  // Sort by expectancy
  allResults.sort((a, b) => b.expectancy - a.expectancy);

  // Print top 20
  console.log('Top 20 configurations by expectancy:');
  console.log('PT1  | PT2  | Split       | BE  | WinR   | AvgR  | Expect$/t | TotalPnL   | PF    | PT1Hit | PT1Save | MaxDD');
  console.log('-----|------|-------------|-----|--------|-------|-----------|------------|-------|--------|---------|------');
  for (let i = 0; i < Math.min(20, allResults.length); i++) {
    const r = allResults[i];
    console.log(
      `${String(r.pt1Pts).padStart(4)} | ${String(r.pt2Pts).padStart(4)} | ` +
      `${r.splitLabel.padEnd(11)} | ${r.moveToBeAfterPt1 ? 'YES' : ' NO'} | ` +
      `${r.winRate.toFixed(1).padStart(5)}% | ${r.avgR.toFixed(2).padStart(5)} | ` +
      `${('$' + r.expectancy.toFixed(0)).padStart(9)} | ` +
      `${('$' + r.totalPnl.toFixed(0)).padStart(10)} | ` +
      `${r.profitFactor.toFixed(2).padStart(5)} | ` +
      `${r.pt1HitRate.toFixed(1).padStart(5)}% | ` +
      `${r.pt1SaveRate.toFixed(1).padStart(6)}% | ` +
      `$${r.dd.toFixed(0)}`
    );
  }

  // ─── D. Best PT1-only analysis (fixed PT2=20) ────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('D. PT1 SENSITIVITY (PT2 fixed at 15pts, 50/25/runner, BE=yes)');
  console.log('═══════════════════════════════════════════\n');

  console.log('PT1  | WinR   | AvgR  | Expect$/t | TotalPnL   | PF    | PT1Hit | PT1Save | Monetized');
  console.log('-----|--------|-------|-----------|------------|-------|--------|---------|----------');
  for (const pt1 of [4, 5, 6, 7, 8, 9, 10, 12]) {
    const r = simulateScalingRule(trades, pt1, 15, 0.5, 0.25, true, contract);
    r.dd = maxDrawdown(r.tradeResults);
    console.log(
      `${String(pt1).padStart(4)} | ${r.winRate.toFixed(1).padStart(5)}% | ${r.avgR.toFixed(2).padStart(5)} | ` +
      `${('$' + r.expectancy.toFixed(0)).padStart(9)} | ` +
      `${('$' + r.totalPnl.toFixed(0)).padStart(10)} | ` +
      `${r.profitFactor.toFixed(2).padStart(5)} | ` +
      `${r.pt1HitRate.toFixed(1).padStart(5)}% | ` +
      `${r.pt1SaveRate.toFixed(1).padStart(6)}% | ` +
      `${r.earlyMonetizedRate.toFixed(1).padStart(7)}%`
    );
  }

  // ─── E. PT2 SENSITIVITY (fixed PT1=6) ────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('E. PT2 SENSITIVITY (PT1 fixed at 6pts, 50/25/runner, BE=yes)');
  console.log('═══════════════════════════════════════════\n');

  console.log('PT2  | WinR   | AvgR  | Expect$/t | TotalPnL   | PF    | PT2Hit | PT1Save | Monetized');
  console.log('-----|--------|-------|-----------|------------|-------|--------|---------|----------');
  for (const pt2 of [8, 10, 12, 15, 18, 20, 25, 30]) {
    const r = simulateScalingRule(trades, 6, pt2, 0.5, 0.25, true, contract);
    r.dd = maxDrawdown(r.tradeResults);
    console.log(
      `${String(pt2).padStart(4)} | ${r.winRate.toFixed(1).padStart(5)}% | ${r.avgR.toFixed(2).padStart(5)} | ` +
      `${('$' + r.expectancy.toFixed(0)).padStart(9)} | ` +
      `${('$' + r.totalPnl.toFixed(0)).padStart(10)} | ` +
      `${r.profitFactor.toFixed(2).padStart(5)} | ` +
      `${r.pt2HitRate.toFixed(1).padStart(5)}% | ` +
      `${r.pt1SaveRate.toFixed(1).padStart(6)}% | ` +
      `${r.earlyMonetizedRate.toFixed(1).padStart(7)}%`
    );
  }

  // ─── F. Split comparison for best PT1/PT2 ────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('F. SIZE SPLIT COMPARISON (PT1=6, PT2=15, BE=yes)');
  console.log('═══════════════════════════════════════════\n');

  const splitTests = [
    { s1: 0.50, s2: 0.50, label: '50/50/0' },
    { s1: 0.50, s2: 0.25, label: '50/25/25-runner' },
    { s1: 0.33, s2: 0.34, label: '33/34/33-runner' },
    { s1: 0.33, s2: 0.33, label: '33/33/34-runner' },
    { s1: 0.25, s2: 0.25, label: '25/25/50-runner' },
    { s1: 0.25, s2: 0.50, label: '25/50/25-runner' },
  ];

  console.log('Split          | WinR   | AvgR  | Expect$/t | TotalPnL   | PF    | MaxDD');
  console.log('---------------|--------|-------|-----------|------------|-------|------');
  for (const split of splitTests) {
    const r = simulateScalingRule(trades, 6, 15, split.s1, split.s2, true, contract);
    r.dd = maxDrawdown(r.tradeResults);
    console.log(
      `${split.label.padEnd(14)} | ${r.winRate.toFixed(1).padStart(5)}% | ${r.avgR.toFixed(2).padStart(5)} | ` +
      `${('$' + r.expectancy.toFixed(0)).padStart(9)} | ` +
      `${('$' + r.totalPnl.toFixed(0)).padStart(10)} | ` +
      `${r.profitFactor.toFixed(2).padStart(5)} | ` +
      `$${r.dd.toFixed(0)}`
    );
  }

  // ─── G. BE vs No-BE comparison ────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('G. POST-PT1 MANAGEMENT COMPARISON');
  console.log('═══════════════════════════════════════════\n');

  const beYes = simulateScalingRule(trades, 6, 15, 0.5, 0.25, true, contract);
  const beNo = simulateScalingRule(trades, 6, 15, 0.5, 0.25, false, contract);

  console.log(`BE after PT1:  WinR=${beYes.winRate}%, AvgR=${beYes.avgR}, Expect=$${beYes.expectancy}/t, Total=$${beYes.totalPnl}, PF=${beYes.profitFactor}`);
  console.log(`No BE after PT1: WinR=${beNo.winRate}%, AvgR=${beNo.avgR}, Expect=$${beNo.expectancy}/t, Total=$${beNo.totalPnl}, PF=${beNo.profitFactor}`);

  // ─── H. Context breakdown ─────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('H. CONTEXT BREAKDOWN (PT1=6, PT2=15, 50/25/runner, BE=yes)');
  console.log('═══════════════════════════════════════════\n');

  // By side
  const longTrades = trades.filter(t => t.side === 'long');
  const shortTrades = trades.filter(t => t.side === 'short');
  console.log('BY SIDE:');
  if (longTrades.length >= 5) {
    const lr = simulateScalingRule(longTrades, 6, 15, 0.5, 0.25, true, contract);
    const lb = computeBaseline(longTrades, contract);
    console.log(`  LONG (n=${longTrades.length}):  Baseline expect=$${lb.expectancy}/t → Scaled expect=$${lr.expectancy}/t (delta=$${(lr.expectancy - lb.expectancy).toFixed(0)})`);
  }
  if (shortTrades.length >= 5) {
    const sr = simulateScalingRule(shortTrades, 6, 15, 0.5, 0.25, true, contract);
    const sb = computeBaseline(shortTrades, contract);
    console.log(`  SHORT (n=${shortTrades.length}): Baseline expect=$${sb.expectancy}/t → Scaled expect=$${sr.expectancy}/t (delta=$${(sr.expectancy - sb.expectancy).toFixed(0)})`);
  }

  // By regime
  console.log('\nBY REGIME:');
  const regimeGroups = breakdownByField(trades, 'market_regime');
  for (const [regime, group] of Object.entries(regimeGroups)) {
    if (group.length < 5) { console.log(`  ${regime} (n=${group.length}): TOO FEW TRADES`); continue; }
    const rr = simulateScalingRule(group, 6, 15, 0.5, 0.25, true, contract);
    const rb = computeBaseline(group, contract);
    console.log(`  ${regime} (n=${group.length}): Baseline=$${rb.expectancy}/t → Scaled=$${rr.expectancy}/t (delta=$${(rr.expectancy - rb.expectancy).toFixed(0)})`);
  }

  // By setup type
  console.log('\nBY SETUP TYPE:');
  const setupGroups = breakdownByField(trades, 'setup_type');
  for (const [setup, group] of Object.entries(setupGroups)) {
    if (group.length < 3) { console.log(`  ${setup} (n=${group.length}): TOO FEW TRADES`); continue; }
    const sr = simulateScalingRule(group, 6, 15, 0.5, 0.25, true, contract);
    const sb = computeBaseline(group, contract);
    console.log(`  ${setup} (n=${group.length}): Baseline=$${sb.expectancy}/t → Scaled=$${sr.expectancy}/t (delta=$${(sr.expectancy - sb.expectancy).toFixed(0)})`);
  }

  // ─── I. Robustness: first half vs second half ─────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('I. ROBUSTNESS: FIRST HALF vs SECOND HALF');
  console.log('═══════════════════════════════════════════\n');

  const sortedByTime = [...trades].sort((a, b) =>
    new Date(a.timestamp_entry).getTime() - new Date(b.timestamp_entry).getTime()
  );
  const midpoint = Math.floor(sortedByTime.length / 2);
  const firstHalf = sortedByTime.slice(0, midpoint);
  const secondHalf = sortedByTime.slice(midpoint);

  const fhBaseline = computeBaseline(firstHalf, contract);
  const shBaseline = computeBaseline(secondHalf, contract);
  const fhScaled = simulateScalingRule(firstHalf, 6, 15, 0.5, 0.25, true, contract);
  const shScaled = simulateScalingRule(secondHalf, 6, 15, 0.5, 0.25, true, contract);

  console.log(`First half (n=${firstHalf.length}):`);
  console.log(`  Baseline: WinR=${fhBaseline.winRate}%, AvgR=${fhBaseline.avgR}, Expect=$${fhBaseline.expectancy}/t`);
  console.log(`  Scaled:   WinR=${fhScaled.winRate}%, AvgR=${fhScaled.avgR}, Expect=$${fhScaled.expectancy}/t`);
  console.log(`Second half (n=${secondHalf.length}):`);
  console.log(`  Baseline: WinR=${shBaseline.winRate}%, AvgR=${shBaseline.avgR}, Expect=$${shBaseline.expectancy}/t`);
  console.log(`  Scaled:   WinR=${shScaled.winRate}%, AvgR=${shScaled.avgR}, Expect=$${shScaled.expectancy}/t`);

  // ─── Write full results to JSON ───────────────────────────────────────
  const output = {
    generated_at: new Date().toISOString(),
    data_window: {
      total_trades_loaded: allTrades.length,
      nq_trades: nqTrades.length,
      deduplicated: trades.length,
      sources,
      contract,
      point_value: pointValue,
    },
    mfe_structure: mfeStructure,
    overall_stats: {
      avg_mfe: Math.round(avgMfe * 100) / 100,
      median_mfe: Math.round(medianMfe * 100) / 100,
      avg_mae: Math.round(avgMae * 100) / 100,
      median_mae: Math.round(medianMae * 100) / 100,
      avg_risk_pts: Math.round(avgRisk * 100) / 100,
      losers_total: losers.length,
      losers_with_mfe_4: losersWithMfe4.length,
      losers_with_mfe_6: losersWithMfe6.length,
    },
    baseline,
    recommended_rule: {
      pt1_pts: 6,
      pt2_pts: 15,
      split_pct_1: 50,
      split_pct_2: 25,
      runner_pct: 25,
      move_to_be_after_pt1: true,
      trail_after_pt1: true,
    },
    top_20_configs: allResults.slice(0, 20).map(r => ({
      pt1: r.pt1Pts, pt2: r.pt2Pts,
      split: r.splitLabel, be: r.moveToBeAfterPt1,
      winRate: r.winRate, avgR: r.avgR,
      expectancy: r.expectancy, totalPnl: r.totalPnl,
      profitFactor: r.profitFactor,
      pt1HitRate: r.pt1HitRate, pt1SaveRate: r.pt1SaveRate,
      maxDD: r.dd,
    })),
  };

  writeFileSync(
    join(process.cwd(), 'reports', 'scaling-analysis-results.json'),
    JSON.stringify(output, null, 2),
  );
  console.log('\n✅ Full results written to reports/scaling-analysis-results.json');
}

main();
