/**
 * PerformanceTracker — maintains rolling session statistics and
 * writes them to disk after each completed trade.
 */

import type { TradeRecord, PerformanceStats, SetupStats } from './types.js';
import type { LogWriter } from './log-writer.js';

export class PerformanceTracker {
  private stats: PerformanceStats;
  private readonly sessionId: string;
  private readonly logWriter: LogWriter;
  private readonly accountEquity: number;
  private peakPnl = 0;
  private troughPnl = 0;
  private tradeRs: number[] = [];
  private cumulativePnl = 0;
  /** True if normalizeStats() had to backfill missing fields from a saved file. */
  private statsWereNormalized = false;

  constructor(sessionId: string, logWriter: LogWriter, accountEquity: number) {
    this.sessionId = sessionId;
    this.logWriter = logWriter;
    this.accountEquity = accountEquity > 0 ? accountEquity : 10_000;

    // Try to restore from disk, normalizing against the full schema
    const saved = logWriter.readPerformance();
    this.stats = this.normalizeStats(saved);

    // If we backfilled missing fields from an existing file, persist the fix
    // so the warning does not recur on next startup.
    if (saved && this.statsWereNormalized) {
      logWriter.writePerformance(this.stats);
      console.log('[PERF] Persisted backfilled performance.json to disk.');
    }

    // Hydrate tradeRs, peakPnl, troughPnl, cumulativePnl from the persisted
    // trades.jsonl so that aggregate R stats and drawdown survive restarts.
    const trades = logWriter.readAllTrades();
    let runningPnl = 0;
    let runningPeak = 0;
    let runningTrough = 0;
    for (const t of trades) {
      this.tradeRs.push(t.r_multiple);
      runningPnl += t.pnl_realized;
      if (runningPnl > runningPeak) runningPeak = runningPnl;
      if (runningPnl < runningTrough) runningTrough = runningPnl;
    }
    this.cumulativePnl = runningPnl;
    this.peakPnl = runningPeak;
    this.troughPnl = runningTrough;

    // If persisted stats total_pnl diverges from the hydrated cumulative, trust
    // the trades file (it is the source of truth for executions).
    if (trades.length > 0 && Math.abs(this.stats.total_pnl_usd - runningPnl) > 0.01) {
      console.warn(
        `[PERF] ⚠️  performance.json total_pnl=$${this.stats.total_pnl_usd.toFixed(2)} ` +
        `differs from trades.jsonl cumulative=$${runningPnl.toFixed(2)}. Using trades.jsonl.`,
      );
      this.stats.total_pnl_usd = runningPnl;
    }
  }

  recordTrade(trade: TradeRecord): void {
    const s = this.stats;
    s.total_trades++;

    if (trade.outcome_class === 'winner') s.wins++;
    else if (trade.outcome_class === 'loser') s.losses++;
    else s.scratches++;

    s.total_pnl_usd += trade.pnl_realized;

    // By setup
    this.incrementBucket(s.by_setup, trade.setup_type, trade);
    // By regime
    this.incrementBucket(s.by_regime, trade.regime_at_entry, trade);
    // By hour
    const hour = new Date(trade.timestamp_entry).getUTCHours().toString().padStart(2, '0');
    this.incrementBucket(s.by_hour, `${hour}:00`, trade);
    // By config version
    this.incrementBucket(s.by_config_version, trade.indicator_config_version, trade);
    // By management profile
    if (trade.management_profile) {
      this.incrementBucket(s.by_management_profile, trade.management_profile, trade);
    }

    // Recompute aggregates
    s.win_rate = s.total_trades > 0 ? Math.round((s.wins / s.total_trades) * 1000) / 10 : null;
    s.last_updated = new Date().toISOString();

    // Store individual R-multiple for accurate aggregate computation
    this.tradeRs.push(trade.r_multiple);

    // Compute aggregate R statistics
    if (this.tradeRs.length > 0) {
      s.avg_r = Math.round((this.tradeRs.reduce((sum, r) => sum + r, 0) / this.tradeRs.length) * 100) / 100;

      const winnerR = this.tradeRs.filter(r => r > 0);
      const loserR = this.tradeRs.filter(r => r < 0);

      s.avg_winner_r = winnerR.length > 0
        ? Math.round((winnerR.reduce((sum, r) => sum + r, 0) / winnerR.length) * 100) / 100
        : null;
      s.avg_loser_r = loserR.length > 0
        ? Math.round((loserR.reduce((sum, r) => sum + r, 0) / loserR.length) * 100) / 100
        : null;

      // Expectancy = (WR × avg_win_R) - ((1-WR) × |avg_loss_R|)
      const wr = s.wins / s.total_trades;
      if (s.avg_winner_r !== null && s.avg_loser_r !== null) {
        s.expectancy = Math.round((wr * s.avg_winner_r - (1 - wr) * Math.abs(s.avg_loser_r)) * 100) / 100;
      }

      // Profit factor = gross_wins / gross_losses
      const grossWins = winnerR.reduce((sum, r) => sum + r, 0);
      const grossLosses = Math.abs(loserR.reduce((sum, r) => sum + r, 0));
      s.profit_factor = grossLosses > 0
        ? Math.round((grossWins / grossLosses) * 100) / 100
        : grossWins > 0 ? Infinity : null;
    }

    // ── Track max drawdown ────────────────────────────────────────────────
    // Peak-to-trough equity curve, normalized against account equity.
    // Unlike the prior implementation, this works correctly even when PnL
    // starts negative (peakPnl remains at 0 or prior high-water mark).
    this.cumulativePnl = s.total_pnl_usd;
    if (this.cumulativePnl > this.peakPnl) this.peakPnl = this.cumulativePnl;
    if (this.cumulativePnl < this.troughPnl) this.troughPnl = this.cumulativePnl;
    const drawdownFromPeak = this.peakPnl - this.cumulativePnl;
    // Denominator is account equity so we get a meaningful % regardless of
    // whether the strategy ever achieved a positive peak.
    const drawdownPct = Math.round((drawdownFromPeak / this.accountEquity) * 10000) / 100;
    if (drawdownPct > s.max_drawdown_pct) {
      s.max_drawdown_pct = drawdownPct;
    }

    this.logWriter.writePerformance(s);

    // Every 10 trades, log a self-review
    if (s.total_trades % 10 === 0) {
      this.printSelfReview();
    }
  }

  getStats(): Readonly<PerformanceStats> {
    return { ...this.stats };
  }

  printSelfReview(): void {
    const s = this.stats;
    console.log('\n┌─ 📊 Performance Self-Review (' + s.total_trades + ' trades) ────────────────');
    console.log(`│  Win rate:      ${s.win_rate ?? 'n/a'}%   W:${s.wins} L:${s.losses} S:${s.scratches}`);
    const dailyLossPct = Math.abs(Math.min(0, s.total_pnl_usd)) / 10_000 * 100;
    console.log(`│  Total PnL:     $${s.total_pnl_usd.toFixed(2)}`);
    console.log(`│  Daily loss:    ${dailyLossPct.toFixed(2)}%`);
    if (s.expectancy !== null) console.log(`│  Expectancy:    ${s.expectancy}R per trade`);
    if (s.profit_factor !== null) console.log(`│  Profit factor: ${s.profit_factor}`);
    if (s.avg_winner_r !== null) console.log(`│  Avg winner:    ${s.avg_winner_r}R`);
    if (s.avg_loser_r !== null) console.log(`│  Avg loser:     ${s.avg_loser_r}R`);
    console.log(`│  Max drawdown:  ${s.max_drawdown_pct.toFixed(2)}%`);
    console.log('│  By Setup:');
    for (const [setup, st] of Object.entries(s.by_setup)) {
      const wr = st.trades > 0 ? ((st.wins / st.trades) * 100).toFixed(0) : '0';
      const avgR = st.trades > 0 ? (st.total_r / st.trades).toFixed(2) : '0';
      console.log(`│    ${setup.padEnd(30)} ${st.trades} trades | WR ${wr}% | Avg R ${avgR}`);
    }
    console.log('│  By Regime:');
    for (const [regime, st] of Object.entries(s.by_regime)) {
      const wr = st.trades > 0 ? ((st.wins / st.trades) * 100).toFixed(0) : '0';
      console.log(`│    ${regime.padEnd(25)} ${st.trades} trades | WR ${wr}%`);
    }
    if (Object.keys(s.by_management_profile).length > 0) {
      console.log('│  By Management Profile:');
      for (const [profile, st] of Object.entries(s.by_management_profile)) {
        const wr = st.trades > 0 ? ((st.wins / st.trades) * 100).toFixed(0) : '0';
        const avgR = st.trades > 0 ? (st.total_r / st.trades).toFixed(2) : '0.00';
        console.log(`│    ${profile.padEnd(25)} ${st.trades} trades | WR ${wr}% | avgR ${avgR}`);
      }
    }
    console.log('└───────────────────────────────────────────────────────────────\n');
  }

  private incrementBucket(map: Record<string, SetupStats> | undefined, key: string, trade: TradeRecord): void {
    if (!map) return; // defensive: skip if map is somehow undefined
    if (!map[key]) {
      map[key] = { trades: 0, wins: 0, total_r: 0 };
    }
    const bucket = map[key]!;
    bucket.trades++;
    if (trade.outcome_class === 'winner') bucket.wins++;
    bucket.total_r += trade.r_multiple;
  }

  /**
   * Merge a saved (possibly partial) PerformanceStats with the full schema.
   * Preserves existing headline values but backfills any missing bucket maps
   * so incrementBucket() never receives undefined.
   */
  private normalizeStats(saved: PerformanceStats | null): PerformanceStats {
    const empty = this.emptyStats();
    if (!saved) return empty;

    const missingFields: string[] = [];
    // Check each required bucket map
    if (!saved.by_setup || typeof saved.by_setup !== 'object') { missingFields.push('by_setup'); }
    if (!saved.by_regime || typeof saved.by_regime !== 'object') { missingFields.push('by_regime'); }
    if (!saved.by_hour || typeof saved.by_hour !== 'object') { missingFields.push('by_hour'); }
    if (!saved.by_config_version || typeof saved.by_config_version !== 'object') { missingFields.push('by_config_version'); }
    if (!saved.by_management_profile || typeof saved.by_management_profile !== 'object') { missingFields.push('by_management_profile'); }

    if (missingFields.length > 0) {
      console.warn(
        `[PERF] ⚠️  performance.json missing fields: [${missingFields.join(', ')}] — backfilling with empty defaults. ` +
        `This is normal after a schema upgrade.`,
      );
      this.statsWereNormalized = true;
    }

    // Spread empty first so all fields exist, then overlay saved values.
    // Bucket maps: use saved if it's a valid object, otherwise empty {}.
    return {
      ...empty,
      ...saved,
      by_setup: (saved.by_setup && typeof saved.by_setup === 'object') ? saved.by_setup : {},
      by_regime: (saved.by_regime && typeof saved.by_regime === 'object') ? saved.by_regime : {},
      by_hour: (saved.by_hour && typeof saved.by_hour === 'object') ? saved.by_hour : {},
      by_config_version: (saved.by_config_version && typeof saved.by_config_version === 'object') ? saved.by_config_version : {},
      by_management_profile: (saved.by_management_profile && typeof saved.by_management_profile === 'object') ? saved.by_management_profile : {},
    };
  }

  private emptyStats(): PerformanceStats {
    return {
      session_id: this.sessionId,
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
  }
}
