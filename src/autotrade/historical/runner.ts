#!/usr/bin/env node
/**
 * Historical replay runner (offline, deterministic).
 *
 * 1. Loads 1m/5m/15m/60m CSVs.
 * 2. Aligns them with no future-leak.
 * 3. Warms up indicators.
 * 4. Walks the 1m stream chronologically:
 *      a. build MarketSnapshot
 *      b. call generateSignal() from the live strategy engine
 *      c. if trade allowed → schedule entry per fill model
 *      d. manage open position bar-by-bar using OHLC exit rules
 *      e. emit signals/trades/trade-path/rejected to logs/historical/...
 * 5. Writes a historical session summary.
 *
 * Intentionally independent of TradingView — no CDP, no UI.
 */

import { mkdirSync, existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';

import { loadCsvBars, formatSummary } from './data-loader.js';
import { Aligner } from './alignment.js';
import { buildHistoricalSnapshot } from './snapshot-builder.js';
import {
  computeEntryFill,
  checkBarForExit,
  DEFAULT_FILL_CONFIG,
  type FillConfig,
  type ExitTrigger,
  type EntryFillResult,
} from './fills.js';
import { DEFAULT_SCORING_WEIGHTS, generateSignal } from '../strategy.js';
import { RiskManager } from '../risk.js';
import { formatCandidateScoreV2StatusLine, LogWriter } from '../log-writer.js';
import { IndicatorConfigManager } from '../indicator-config-manager.js';
import { PerformanceTracker } from '../performance-tracker.js';
import { getContractSpec, roundToTick, ticksToPrice } from '../contracts.js';
import { EventCalendar } from '../events.js';
import { exportSignalDataset, exportTradeDataset } from './dataset-export.js';
import { computeExtensionFeatures } from '../features/extension.js';
import { writeCandidateScoreV2Telemetry } from '../candidate-score-v2.js';
import { APP_BUILD_SHA, APP_VERSION, computeConfigHash } from '../../shared/app-version.js';

import type { Signal, TradeRecord, SessionRecord, MarketRegime, SessionState, ExitLeg } from '../types.js';
import { computeExitReasonDetailed, isStoppedOut } from '../exit-labeling.js';
import type { HistoricalBar } from './schema.js';
import { classifyExchangeState, classifyStrategyBucket, getTzHour, getEtParts } from '../session.js';

/**
 * Classify session bucket for historical bars using the canonical session module.
 * Derives ET parts from the bar timestamp and delegates to the canonical classifiers.
 */
function classifySessionBucket(session?: SessionState, barTimeUnix?: number): string {
  if (!session) return 'unknown';
  // If we have a bar timestamp, use the canonical classifier
  if (barTimeUnix) {
    const d = new Date(barTimeUnix * 1000);
    const etParts = getEtParts(d);
    const minutesOfDay = etParts.hour * 60 + etParts.minute;
    const dow = etParts.dow;
    const tokyoHour = getTzHour(d, 'Asia/Tokyo');
    const londonHour = getTzHour(d, 'Europe/London');
    const exchangeState = classifyExchangeState(dow, minutesOfDay);
    return classifyStrategyBucket(exchangeState, minutesOfDay, dow, tokyoHour, londonHour);
  }
  // Fallback to simple classification from SessionState flags
  if (session.is_rth_closing_window) return 'NY_PM';
  if (session.is_us_cash_open_window) return 'NY_AM';
  if (session.is_rth) {
    return (session.minutes_since_rth_open ?? 0) < 150 ? 'NY_AM' : 'NY_PM';
  }
  if (session.is_eth) return 'LONDON'; // best guess for ETH
  return 'CLOSED';
}

export interface HistoricalConfig {
  files: {
    '1m': string;
    '5m': string | null;
    '15m': string | null;
    '60m': string | null;
  };
  symbol: string;
  from_unix?: number | null;
  to_unix?: number | null;
  warmup_bars: number;
  fill: FillConfig;
  output_dir: string;
  allow_missing_htf: boolean;
  /** Integer contracts per trade. Historical mode bypasses dynamic sizing. */
  fixed_qty: number;
}

export const DEFAULT_HISTORICAL_CONFIG: HistoricalConfig = {
  files: { '1m': '', '5m': null, '15m': null, '60m': null },
  symbol: 'NQ1!',
  from_unix: null,
  to_unix: null,
  warmup_bars: 250,
  fill: DEFAULT_FILL_CONFIG,
  output_dir: './logs/historical',
  allow_missing_htf: true,
  fixed_qty: 1,
};

export function loadHistoricalConfig(path: string): HistoricalConfig {
  if (!existsSync(path)) throw new Error(`Historical config not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    ...DEFAULT_HISTORICAL_CONFIG,
    ...raw,
    files: { ...DEFAULT_HISTORICAL_CONFIG.files, ...(raw.files ?? {}) },
    fill: { ...DEFAULT_HISTORICAL_CONFIG.fill, ...(raw.fill ?? {}) },
  };
}

// ─── The replay ──────────────────────────────────────────────────────────────

export interface HistoricalRunResult {
  sessionId: string;
  total_signals: number;
  total_trades: number;
  wins: number;
  losses: number;
  scratches: number;
  total_pnl_usd: number;
  ambiguous_bars: number;
  output_dir: string;
  /** OR diagnostic: RTH bars where opening range levels were populated. */
  or_populated_bars: number;
  /** OR diagnostic: RTH bars where opening range levels were null. */
  or_null_bars: number;
  /** OR diagnostic: total RTH bars processed (when flat). */
  rth_bars_total: number;
}

export async function runHistoricalReplay(cfg: HistoricalConfig): Promise<HistoricalRunResult> {
  console.log('\n🧪 NQ Historical Replay starting (offline, deterministic)\n');
  if (!existsSync(cfg.output_dir)) mkdirSync(cfg.output_dir, { recursive: true });

  const contract = getContractSpec(cfg.symbol);
  console.log(`[HIST] Contract: ${contract.display} (${contract.root}) | tick=${contract.tick_size} pt_value=$${contract.point_value}`);

  // ── Load all timeframes ──
  const load1m = loadCsvBars(cfg.files['1m'], '1m', { from_unix: cfg.from_unix, to_unix: cfg.to_unix });
  const load5m = cfg.files['5m'] ? loadCsvBars(cfg.files['5m'], '5m', { from_unix: cfg.from_unix, to_unix: cfg.to_unix }) : null;
  const load15m = cfg.files['15m'] ? loadCsvBars(cfg.files['15m'], '15m', { from_unix: cfg.from_unix, to_unix: cfg.to_unix }) : null;
  const load60m = cfg.files['60m'] ? loadCsvBars(cfg.files['60m'], '60m', { from_unix: cfg.from_unix, to_unix: cfg.to_unix }) : null;

  console.log(formatSummary(load1m.summary));
  if (load5m) console.log(formatSummary(load5m.summary));
  if (load15m) console.log(formatSummary(load15m.summary));
  if (load60m) console.log(formatSummary(load60m.summary));

  if (!cfg.allow_missing_htf && (!load5m || !load15m || !load60m)) {
    throw new Error('allow_missing_htf=false but one or more HTF files are missing');
  }

  const bars1m: HistoricalBar[] = load1m.bars;
  const aligner = new Aligner(
    bars1m,
    load5m?.bars ?? [],
    load15m?.bars ?? [],
    load60m?.bars ?? [],
  );

  // ── Wire up strategy components ──
  const configMgr = new IndicatorConfigManager('./config');
  const effectiveConfig = { ...configMgr.getConfig() };
  const configHashShort = computeConfigHash().short;
  const riskManager = new RiskManager(effectiveConfig, contract);
  const events = EventCalendar.load('./config', { historical: true });
  const sessionId = `HIST_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${randomUUID().slice(0, 8)}`;
  const logWriter = new LogWriter(cfg.output_dir);
  logWriter.startFlushTimer();
  const perfTracker = new PerformanceTracker(sessionId, logWriter, effectiveConfig.account_equity);

  const session: SessionRecord = {
    session_id: sessionId,
    prompt_version: 'historical_v1.0',
    strategy_version: 'STRAT_v1.0',
    indicator_config_version: effectiveConfig.version,
    mode: 'paper',
    symbol: cfg.symbol,
    venue: contract.venue,
    timestamp_start: new Date().toISOString(),
    timestamp_end: null,
    live_trading_enabled: false,
    total_signals: 0,
    total_trades: 0,
    wins: 0, losses: 0, scratches: 0,
    total_pnl_usd: 0,
    daily_loss_pct: 0,
    daily_loss_limit_pct: effectiveConfig.max_daily_loss_pct,
    shutdown_reason: null,
  };
  logWriter.writeSession({
    ...session,
    // attach historical-mode metadata
    ...({
      run_mode: 'historical',
      historical_file_1m: cfg.files['1m'],
      historical_file_5m: cfg.files['5m'],
      historical_file_15m: cfg.files['15m'],
      historical_file_60m: cfg.files['60m'],
      fill_model: cfg.fill.entry_model,
      slippage_ticks: cfg.fill.slippage_ticks,
      ambiguity_policy: cfg.fill.ambiguity_policy,
    } as Record<string, unknown>),
  });

  // ── Walk the 1m stream ──
  const start = cfg.warmup_bars;
  const end = bars1m.length;
  let totalSignals = 0;
  let totalTrades = 0;
  let wins = 0, losses = 0, scratches = 0;
  let totalPnl = 0;
  let ambiguousBars = 0;
  let orPopulatedBars = 0;
  let orNullBars = 0;
  let rthBarsTotal = 0;
  // ── Cooldown & safety state ──────────────────────────────────────────────
  let lastTradeExitBarIndex: number | null = null;
  let lastTradeExitDirection: 'long' | 'short' | null = null;

  type OpenTrade = {
    trade_id: string; signal_id: string;
    direction: 'long' | 'short'; qty: number;
    entry_index: number; entry_price: number; entry_ts: number;
    stop_initial: number; stop_current: number;
    t1: number; t2: number; t3: number | null;
    setup_type: string; regime_at_entry: MarketRegime;
    mfe_pts: number; mae_pts: number;
    partial_exit_done: boolean;
    /** Contracts sold at T1 partial (0 when qty<2 so no partial occurred). */
    qty_partial: number;
    /** Contracts still running after any T1 partial. */
    qty_remaining: number;
    /** True once trailing logic engaged (post T1 partial). */
    trailing_active: boolean;
    /** Tick-count trailing distance from peak favorable price. */
    trail_distance_ticks: number;
    /** Peak favorable price reached since trail was armed. */
    trail_anchor_price: number | null;
    target_1_direction_valid: boolean;
    target_2_direction_valid: boolean;
    target_3_direction_valid: boolean;
    target_ordering_valid: boolean;
    target_repair_applied: boolean;
    confidence: number;
  };
  // Pending entries: signal fires at bar i, fills at bar i+1 open (when next_bar_open).
  type Pending = { direction: 'long' | 'short'; signal_id: string; setup: any; regime: MarketRegime; signalIndex: number };
  let pending: Pending | null = null;
  let open: OpenTrade | null = null;

  const progressEvery = Math.max(500, Math.floor((end - start) / 40));
  const runStart = Date.now();

  for (let i = start; i < end; i++) {
    const bundle = aligner.advanceTo(i);

    // ── 1) handle pending entry from prior bar ─────────────────────────
    if (pending) {
      const signalBar: HistoricalBar | undefined = bars1m[pending.signalIndex];
      const nextBar: HistoricalBar | null = bars1m[pending.signalIndex + 1] ?? null;
      const fill: EntryFillResult | null = signalBar ? computeEntryFill(pending.direction, signalBar, nextBar, contract, cfg.fill) : null;
      if (fill) {
        open = {
          trade_id: `HTRADE_${sessionId}_${String(totalTrades + 1).padStart(4, '0')}`,
          signal_id: pending.signal_id,
          direction: pending.direction,
          qty: cfg.fixed_qty,
          entry_index: i,
          entry_price: fill.fill_price,
          entry_ts: fill.fill_timestamp,
          stop_initial: pending.setup.stop,
          stop_current: pending.setup.stop,
          t1: pending.setup.target_1,
          t2: pending.setup.target_2,
          t3: pending.setup.target_3,
          setup_type: pending.setup.setup_type,
          regime_at_entry: pending.regime,
          mfe_pts: 0, mae_pts: 0,
          partial_exit_done: false,
          qty_partial: 0,
          qty_remaining: cfg.fixed_qty,
          trailing_active: false,
          trail_distance_ticks: 0,
          trail_anchor_price: null,
          target_1_direction_valid: pending.setup.target_1_direction_valid,
          target_2_direction_valid: pending.setup.target_2_direction_valid,
          target_3_direction_valid: pending.setup.target_3_direction_valid,
          target_ordering_valid: pending.setup.target_ordering_valid,
          target_repair_applied: pending.setup.target_repair_applied,
          confidence: pending.setup.confidence,
        };
      }
      pending = null;
    }

    // ── 2) manage open position against the CURRENT bar ────────────────
    if (open) {
      const bar = bars1m[i]!;
      // Update MFE/MAE (intrabar extremes)
      if (open.direction === 'long') {
        const mfe = bar.high - open.entry_price;
        const mae = open.entry_price - bar.low;
        if (mfe > open.mfe_pts) open.mfe_pts = mfe;
        if (mae > open.mae_pts) open.mae_pts = mae;
      } else {
        const mfe = open.entry_price - bar.low;
        const mae = bar.high - open.entry_price;
        if (mfe > open.mfe_pts) open.mfe_pts = mfe;
        if (mae > open.mae_pts) open.mae_pts = mae;
      }
      // Trade-path point per bar
      logWriter.writeTradePathPoint({
        timestamp: new Date(bar.timestamp * 1000).toISOString(),
        trade_id: open.trade_id,
        session_id: sessionId,
        side: open.direction,
        entry_price: open.entry_price,
        current_price: bar.close,
        bar_index: i,
        stop_current: open.stop_current,
        target_1: open.t1,
        target_2: open.t2,
        partial_exit_done: open.partial_exit_done,
        mfe_pts: Math.round(open.mfe_pts * 100) / 100,
        mae_pts: Math.round(open.mae_pts * 100) / 100,
        hold_seconds: bar.timestamp - open.entry_ts,
      });

      // ── Trailing-stop update BEFORE exit check, using intrabar extremes ──
      if (open.trailing_active && open.trail_distance_ticks > 0) {
        const trailPts = ticksToPrice(open.trail_distance_ticks, contract);
        // Anchor follows only in the favorable direction (use bar extreme)
        const favorableExtreme = open.direction === 'long' ? bar.high : bar.low;
        if (open.trail_anchor_price === null) {
          open.trail_anchor_price = favorableExtreme;
        } else {
          const improved = open.direction === 'long'
            ? favorableExtreme > open.trail_anchor_price
            : favorableExtreme < open.trail_anchor_price;
          if (improved) open.trail_anchor_price = favorableExtreme;
        }
        const rawTrail = open.direction === 'long'
          ? open.trail_anchor_price - trailPts
          : open.trail_anchor_price + trailPts;
        const candidateStop = roundToTick(rawTrail, contract);
        // Never loosen; never move stop back past entry (BE floor)
        const tighten = open.direction === 'long'
          ? candidateStop > open.stop_current && candidateStop <= bar.high
          : candidateStop < open.stop_current && candidateStop >= bar.low;
        if (tighten) open.stop_current = candidateStop;
      }

      const check = checkBarForExit(
        bar, open.direction, open.stop_current,
        { t1: open.t1, t2: open.t2, t3: open.t3 },
        contract, cfg.fill,
        open.partial_exit_done,
      );
      if (check.ambiguous) ambiguousBars++;
      if (check.trigger === 'ambiguous_skipped') {
        // Ambiguity policy = skip: move to next bar unchanged
      } else if (check.trigger === 'target_1' && !open.partial_exit_done) {
        // T1 partial: if qty>=2, sell floor(qty/2). Otherwise just arm BE+trail.
        open.partial_exit_done = true;
        open.stop_current = roundToTick(open.entry_price, contract);
        const partial = Math.floor(open.qty / 2);
        if (partial >= 1) {
          open.qty_partial = partial;
          open.qty_remaining = open.qty - partial;
        }
        const trailTicks = Math.max(0, Math.floor(effectiveConfig.trail_ticks_post_t1 ?? 0));
        if (trailTicks > 0) {
          open.trailing_active = true;
          open.trail_distance_ticks = trailTicks;
          open.trail_anchor_price = open.direction === 'long' ? bar.high : bar.low;
        }
      } else if (check.trigger !== null) {
        // Full exit of the REMAINING contracts
        const exitPrice = check.actual_fill_price;
        const exitPts = open.direction === 'long'
          ? exitPrice - open.entry_price
          : open.entry_price - exitPrice;
        const slipPts = cfg.fill.slippage_ticks * contract.tick_size;
        const remainingPnlUsd = exitPts * open.qty_remaining * contract.point_value;
        // T1 realized slice (0 when no partial was sold)
        let t1PnlUsd = 0;
        if (open.qty_partial > 0) {
          const t1Pts = open.direction === 'long'
            ? open.t1 - open.entry_price
            : open.entry_price - open.t1;
          t1PnlUsd = (t1Pts - slipPts) * open.qty_partial * contract.point_value;
        }
        const reportedPnlUsd = remainingPnlUsd + t1PnlUsd;
        const riskPts = Math.abs(open.entry_price - open.stop_initial);
        const dollarRisk = riskPts * contract.point_value * Math.max(1, open.qty);
        const rMul = dollarRisk > 0 ? Math.round((reportedPnlUsd / dollarRisk) * 100) / 100 : 0;
        const scratchBand = contract.tick_value * open.qty;
        const outcome: 'winner' | 'loser' | 'scratch' =
          reportedPnlUsd > scratchBand ? 'winner'
          : reportedPnlUsd < -scratchBand ? 'loser' : 'scratch';

        // Build exit legs for fill-based accounting fields
        const barTimeIso = new Date(bar.timestamp * 1000).toISOString();
        const exitReasonMapped: ExitLeg['reason'] = check.trigger === 'stop' ? 'stop_loss'
          : check.trigger === 'target_1' ? 'target_1'
          : check.trigger === 'target_2' ? 'target_2' : 'target_3';
        const histExitLegs: ExitLeg[] = [];
        if (open.qty_partial > 0) {
          const t1Pts = open.direction === 'long'
            ? open.t1 - open.entry_price
            : open.entry_price - open.t1;
          histExitLegs.push({
            reason: 'target_1',
            quantity: open.qty_partial,
            fill_price: open.t1,
            fill_time_iso: barTimeIso,
            pnl_points: t1Pts - slipPts,
            pnl_usd: t1PnlUsd,
            fee_usd: 0,
            slippage_pts: slipPts,
          });
        }
        histExitLegs.push({
          reason: exitReasonMapped,
          quantity: open.qty_remaining,
          fill_price: exitPrice,
          fill_time_iso: barTimeIso,
          pnl_points: exitPts,
          pnl_usd: remainingPnlUsd,
          fee_usd: 0,
          slippage_pts: slipPts,
        });

        const tradeRec: TradeRecord & Record<string, unknown> = {
          trade_id: open.trade_id,
          parent_signal_id: open.signal_id,
          session_id: sessionId,
          strategy_version: 'STRAT_v1.0',
          indicator_config_version: effectiveConfig.version,
          mode: 'paper',
          timestamp_signal: new Date(open.entry_ts * 1000).toISOString(),
          timestamp_entry: new Date(open.entry_ts * 1000).toISOString(),
          timestamp_exit: new Date(bar.timestamp * 1000).toISOString(),
          symbol: cfg.symbol,
          venue: contract.venue,
          side: open.direction,
          setup_type: open.setup_type as any,
          market_regime: open.regime_at_entry,
          confidence_score: open.confidence,
          entry_price_planned: open.entry_price,
          entry_price_filled: open.entry_price,
          stop_price_initial: open.stop_initial,
          stop_price_final: open.stop_current,
          target_1: open.t1, target_2: open.t2, target_3: open.t3,
          quantity: open.qty,
          notional_value: open.entry_price * open.qty * contract.point_value,
          fee_estimate: 0, fee_actual: 0,
          slippage_estimate: cfg.fill.slippage_ticks * contract.tick_size,
          slippage_actual: cfg.fill.slippage_ticks * contract.tick_size,
          pnl_realized: Math.round(reportedPnlUsd * 100) / 100,
          pnl_percent: 0,
          r_multiple: rMul,
          hold_time_seconds: bar.timestamp - open.entry_ts,
          exit_reason: check.trigger === 'stop' ? 'stop_loss'
            : check.trigger === 'target_1' ? 'target_1'
            : check.trigger === 'target_2' ? 'target_2' : 'target_3',
          exit_reason_detailed: computeExitReasonDetailed(
            check.trigger === 'stop' ? 'stop_loss'
              : check.trigger === 'target_1' ? 'target_1'
              : check.trigger === 'target_2' ? 'target_2' : 'target_3',
            open.partial_exit_done,
            open.trailing_active,
          ),
          mfe: Math.round(open.mfe_pts * 100) / 100,
          mae: Math.round(open.mae_pts * 100) / 100,
          outcome_class: outcome,
          hit_target_1: open.partial_exit_done || check.trigger === 'target_1',
          hit_target_2: check.trigger === 'target_2' || check.trigger === 'target_3',
          stopped_out: isStoppedOut(computeExitReasonDetailed(
            check.trigger === 'stop' ? 'stop_loss'
              : check.trigger === 'target_1' ? 'target_1'
              : check.trigger === 'target_2' ? 'target_2' : 'target_3',
            open.partial_exit_done,
            open.trailing_active,
          )),
          exited_on_time_stop: false,
          regime_at_entry: open.regime_at_entry,
          regime_at_exit: open.regime_at_entry,
          confidence_bucket: open.confidence >= 8.5 ? 'high' : open.confidence >= 7.5 ? 'medium' : 'low',
          trend_alignment: true,
          config_type: 'BASELINE',
          notes: `historical replay | ambiguous=${check.ambiguous} | ${check.notes}`,
          exit_price_planned: check.planned_exit_price,
          exit_price_actual: exitPrice,
          exit_slippage_vs_plan_pts: Math.abs(exitPrice - check.planned_exit_price),
          max_unrealized_r: riskPts > 0 ? Math.round((open.mfe_pts / riskPts) * 100) / 100 : 0,
          max_drawdown_r: riskPts > 0 ? -Math.round((open.mae_pts / riskPts) * 100) / 100 : 0,
          target_1_direction_valid: open.target_1_direction_valid,
          target_2_direction_valid: open.target_2_direction_valid,
          target_3_direction_valid: open.target_3_direction_valid,
          target_ordering_valid: open.target_ordering_valid,
          target_repair_applied: open.target_repair_applied,
          // historical-extension fields:
          run_mode: 'historical',
          bar_index: i,
          entry_bar_index: open.entry_index,
          ambiguous_exit: check.ambiguous,
          ambiguity_policy: cfg.fill.ambiguity_policy,
          fill_model: cfg.fill.entry_model,
          // Extended observability for patches P1/P2/P3
          post_t1_exit: open.partial_exit_done,
          trailing_active: open.trailing_active,
          trail_distance_ticks: open.trail_distance_ticks,
          qty_partial: open.qty_partial,
          qty_remaining: open.qty_remaining,
          partial_exit_done: open.partial_exit_done,
          // Fill-based accounting
          exit_legs: histExitLegs,
          exit_legs_count: histExitLegs.length,
          partial_exit_count: open.qty_partial > 0 ? 1 : 0,
          pnl_pt1: open.qty_partial > 0 ? t1PnlUsd : null,
          pnl_pt2: null,
          pnl_runner: Math.round(remainingPnlUsd * 100) / 100,
          total_fees_usd: 0,
        };
        logWriter.writeTrade(tradeRec as TradeRecord);
        perfTracker.recordTrade(tradeRec as TradeRecord);
        riskManager.recordTradeClose(tradeRec.pnl_realized, outcome);
        totalTrades++;
        totalPnl += reportedPnlUsd;
        if (outcome === 'winner') wins++;
        else if (outcome === 'loser') losses++;
        else scratches++;
        // Track exit for cooldown / same-bar reversal safety
        lastTradeExitBarIndex = i;
        lastTradeExitDirection = open.direction;
        open = null;
      }
    }

    // ── 3) generate a new signal if flat ────────────────────────────────
    if (!open && !pending) {
      const snap = buildHistoricalSnapshot(bundle, {
        symbol: cfg.symbol, aligner,
        window_1m: 60, window_5m: 30, window_15m: 20, window_60m: 12,
        opening_range_minutes: effectiveConfig.opening_range_minutes,
      });
      snap.event = events.evaluate(new Date(bundle.bar_1m.timestamp * 1000));

      // OR diagnostic tracking
      if (snap.session?.is_rth) {
        rthBarsTotal++;
        if (snap.key_levels.opening_range_high !== null) orPopulatedBars++;
        else orNullBars++;
      }

      const dualResult = generateSignal(snap, effectiveConfig, contract);
      const { regime, bias, bestSetup, confidence, tradeAllowed, skipReasons, mlFeatures, decision: dualDecision, bestLong, bestShort, chosen, scoreMargin: dualMargin } = dualResult;
      totalSignals++;
      const signalId = `HSIG_${sessionId}_${String(totalSignals).padStart(6, '0')}`;

      const signal: Signal & Record<string, unknown> = {
        signal_id: signalId,
        session_id: sessionId,
        timestamp: snap.timestamp_iso,
        unix_ts: snap.timestamp_unix,
        symbol: cfg.symbol,
        mode: 'paper',
        strategy_version: 'STRAT_v1.0',
        indicator_config_version: effectiveConfig.version,
        market_regime: regime,
        higher_timeframe_bias: bias,
        current_price: snap.price,
        indicator_snapshot_1m: snap.indicators_1m,
        indicator_snapshot_1h: snap.indicators_1h,
        key_levels: snap.key_levels,
        candidate_setup: bestSetup,
        confidence,
        trade_allowed: tradeAllowed,
        reason_for_skip: skipReasons.length > 0 ? skipReasons.join('; ') : null,
        execution_occurred: false,
        no_trade: !tradeAllowed,
        near_miss_filters_failed: skipReasons,
        ml_features: mlFeatures,
        outcome_label: null,
        config_type: effectiveConfig.type,
        dual_direction_decision: dualDecision,
        dual_long_score: bestLong?.score ?? null,
        dual_short_score: bestShort?.score ?? null,
        dual_score_margin: dualMargin,
        run_mode: 'historical',
        bar_index: i,
        htf_available_5m: bundle.availability['5m'],
        htf_available_15m: bundle.availability['15m'],
        htf_available_60m: bundle.availability['60m'],
        confidence_score_at_entry: confidence,
        session_bucket: classifySessionBucket(snap.session),
      };

      // ── Cooldown & same-bar reversal safety ────────────────────────────
      let cooldownBlock: string | null = null;
      if (tradeAllowed && bestSetup && lastTradeExitBarIndex !== null) {
        const barsSinceExit = i - lastTradeExitBarIndex;

        if (effectiveConfig.no_same_bar_reversal
          && lastTradeExitDirection !== null
          && bestSetup.direction !== lastTradeExitDirection
          && barsSinceExit < 1) {
          cooldownBlock = `same_bar_reversal:exited_${lastTradeExitDirection}_${barsSinceExit}bars_ago`;
        } else if (effectiveConfig.cooldown_bars > 0 && barsSinceExit < effectiveConfig.cooldown_bars) {
          cooldownBlock = `cooldown:${barsSinceExit}/${effectiveConfig.cooldown_bars}_bars`;
        }

        if (cooldownBlock) {
          signal.reason_for_skip = (signal.reason_for_skip ? signal.reason_for_skip + '; ' : '') + cooldownBlock;
          signal.trade_allowed = false;
          signal.no_trade = true;
        }
      }

      if (bestSetup) {
        const entryMid = (bestSetup.entry_low + bestSetup.entry_high) / 2;
        const chosenCand = chosen ?? (bestSetup.direction === 'long' ? bestLong : bestShort);
        const vetoFlags: string[] = [];
        if (cooldownBlock) vetoFlags.push(cooldownBlock);
        if (chosenCand && !chosenCand.passedHardGates) {
          vetoFlags.push(...chosenCand.hardGateFailures.map((failure) => `hard_gate:${failure}`));
        }
        const reasonCodes: string[] = [];
        if (dualResult.decision_reason_primary) reasonCodes.push(dualResult.decision_reason_primary);
        if (chosenCand?.rejection_reason_primary) reasonCodes.push(chosenCand.rejection_reason_primary);
        writeCandidateScoreV2Telemetry({
          logWriter,
          signalId,
          sessionId,
          symbol: cfg.symbol,
          snap,
          bias,
          regime,
          bestSetup,
          chosenCandidate: chosenCand,
          indicatorConfig: effectiveConfig,
          scoringWeights: DEFAULT_SCORING_WEIGHTS,
          extension: computeExtensionFeatures(
            snap,
            entryMid,
            bestSetup.direction as 'long' | 'short',
            effectiveConfig.normalization,
          ),
          microstructure: null,
          lob: null,
          rewardPlan: chosenCand?.rewardPlan ?? null,
          appVersion: APP_VERSION,
          buildSha: APP_BUILD_SHA,
          configHash: configHashShort,
          selectedForExecution: true,
          executionAllowedFinal: tradeAllowed && !cooldownBlock,
          shadowReason: cooldownBlock,
          registryEffectiveStatus: tradeAllowed && !cooldownBlock ? 'active' : 'selection_only',
          vetoFlags,
          reasonCodes,
        });
      }

      if (tradeAllowed && !cooldownBlock && bestSetup) {
        signal.execution_occurred = true;
        signal.no_trade = false;
        pending = {
          direction: bestSetup.direction as 'long' | 'short',
          signal_id: signalId,
          setup: bestSetup,
          regime,
          signalIndex: i,
        };
      }
      logWriter.writeSignal(signal as Signal);
      if (bestSetup && !signal.execution_occurred) {
        logWriter.writeRejectedSignal({
          timestamp: snap.timestamp_iso,
          signal_id: signalId,
          session_id: sessionId,
          direction: bestSetup.direction,
          setup_type: bestSetup.setup_type,
          confidence,
          rr_t1: bestSetup.rr_t1,
          rr_t2: bestSetup.rr_t2,
          reason_for_skip: signal.reason_for_skip,
          regime,
          bar_index: i,
          htf_available_5m: bundle.availability['5m'],
          htf_available_15m: bundle.availability['15m'],
          htf_available_60m: bundle.availability['60m'],
          confidence_score_at_entry: confidence,
          alignment_score: bias.alignment_score,
          setup_family: bestSetup.setup_type,
          session_bucket: classifySessionBucket(snap.session),
        });
      }
    }

    if ((i - start) % progressEvery === 0 && i > start) {
      const pct = Math.round(((i - start) / (end - start)) * 100);
      const elapsed = Math.round((Date.now() - runStart) / 1000);
      console.log(
        `[HIST] progress ${pct}% bar=${i}/${end} signals=${totalSignals} trades=${totalTrades} pnl=$${Math.round(totalPnl)} elapsed=${elapsed}s`,
      );
    }
  }

  logWriter.updateSessionEnd(sessionId, {
    timestamp_end: new Date().toISOString(),
    total_signals: totalSignals,
    total_trades: totalTrades,
    wins, losses, scratches,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    daily_loss_pct: 0,
    shutdown_reason: 'replay_complete',
  });
  perfTracker.printSelfReview();
  logWriter.destroy();
  console.log(formatCandidateScoreV2StatusLine(logWriter.getCandidateScoreV2Status()));

  // ── Dataset exports ──
  const outSignalCsv = join(cfg.output_dir, `historical_signal_dataset_${sessionId}.csv`);
  const outTradeCsv = join(cfg.output_dir, `historical_trade_dataset_${sessionId}.csv`);
  exportSignalDataset(join(cfg.output_dir, 'signals.jsonl'), outSignalCsv, sessionId);
  exportTradeDataset(join(cfg.output_dir, 'trades.jsonl'), outTradeCsv, sessionId);

  const orPct = rthBarsTotal > 0 ? Math.round((orPopulatedBars / rthBarsTotal) * 100) : 0;
  console.log(
    `\n[HIST] ✅ Replay complete\n` +
    `       signals=${totalSignals} trades=${totalTrades} ` +
    `wins=${wins} losses=${losses} scratches=${scratches}\n` +
    `       pnl=$${totalPnl.toFixed(2)} ambiguous_bars=${ambiguousBars}\n` +
    `       OR parity: ${orPopulatedBars}/${rthBarsTotal} RTH bars had OR levels (${orPct}%)\n` +
    `       outputs → ${cfg.output_dir}\n`,
  );

  return {
    sessionId, total_signals: totalSignals, total_trades: totalTrades,
    wins, losses, scratches,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    ambiguous_bars: ambiguousBars,
    output_dir: cfg.output_dir,
    or_populated_bars: orPopulatedBars,
    or_null_bars: orNullBars,
    rth_bars_total: rthBarsTotal,
  };
}
