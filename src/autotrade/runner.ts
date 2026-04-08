#!/usr/bin/env node
/**
 * Autonomous NQ / MNQ Futures Trading Engine — Main Runner (paper-only).
 *
 * Startup sequence:
 *   1. Load env + indicator config
 *   2. Resolve futures contract spec from SYMBOL
 *   3. Initialize log files + session
 *   4. Verify TradingView MCP connection (retry on failure)
 *   5. Set chart symbol to the contract's tv_symbol and load 1m candles
 *   6. Start hybrid loop (slow analysis when flat, fast monitor in-position)
 *
 * Usage:
 *   npm run auto             # paper mode (default)
 *   npm run auto:signal      # signal_only mode
 *   npm run auto:live        # live mode (DISABLED — futures live not implemented)
 */

import { randomUUID } from 'crypto';
import * as tvHealth from '../core/tradingview/health.js';
import * as tvChart from '../core/tradingview/chart.js';
import { QuoteService, BookmapQuoteProvider } from './quote-service.js';
import { LobClient } from './lob-client.js';

import { loadEnv, printEnv } from './env.js';
import { DataCollector } from './data-collector.js';
import { generateSignal } from './strategy.js';
import { RiskManager } from './risk.js';
import { createAdapter } from './execution.js';
import { PositionManager } from './position-manager.js';
import { getManagementProfile, resolveProfile } from './management-profiles.js';
import { LogWriter } from './log-writer.js';
import { IndicatorConfigManager } from './indicator-config-manager.js';
import { PerformanceTracker } from './performance-tracker.js';
import { Scheduler } from './scheduler.js';
import { EnginePhaseManager } from './engine-phase.js';
import { getContractSpec } from './contracts.js';
import { EventCalendar } from './events.js';
import { classifySession } from './session.js';
import { DashboardStateManager, DashboardServer } from './dashboard/index.js';
import { ManagementDecisionEngine, buildManagementFeatures } from './management/index.js';
import type { ManagementMetrics } from './management/index.js';
import { getMlDecision, checkMlHealth, DEFAULT_ML_CONFIG } from './ml/index.js';
import type { MlManagementConfig, MlDecision } from './ml/index.js';
import { getEntryMlDecision, DEFAULT_ENTRY_ML_CONFIG } from './ml-entry/index.js';
import type { EntryMlConfig, EntryMlDecision } from './ml-entry/index.js';
import { ExecutionPolicyEngine, DEFAULT_EXECUTION_POLICY_CONFIG } from './execution-policy/index.js';
import { computeExtensionFeatures, evaluateExtensionVeto, DEFAULT_EXTENSION_FILTER_CONFIG } from './features/extension.js';
import type { ExtensionFeatures, EntryExtensionFilterConfig } from './features/extension.js';
import { extractMboDiagnostics, buildMboTradeContext, buildMboHealthSummary, formatMboStatusLine } from './mbo-diagnostics.js';
import { computeMicrostructureScore, computeMicroAdjustment, DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG } from './features/microstructure-score.js';
import type { MicrostructureScoreResult, MicrostructureOverlayConfig, MicroAdjustmentResult } from './features/microstructure-score.js';
import { buildDynamicRewardPlan, buildLegacyRewardPlan, DEFAULT_DYNAMIC_REWARD_CONFIG } from './features/dynamic-reward-plan.js';
import type { DynamicRewardPlan, DynamicRewardConfig } from './features/dynamic-reward-plan.js';
import type { ExecutionPolicyConfig } from './execution-policy/index.js';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

import type {
  Signal,
  SessionRecord,
  MarketRegime,
  MarketSnapshot,
  DualDirectionResult,
} from './types.js';

const MAX_STARTUP_RETRIES = 5;
const STARTUP_RETRY_DELAY_MS = 3_000;
const HEALTH_RETRY_DELAY_MS = 5_000;
const MAX_HEALTH_RETRIES = 3;

async function verifyConnection(retries = MAX_STARTUP_RETRIES): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const health = await tvHealth.healthCheck() as Record<string, unknown>;
      if (!health['api_available']) {
        throw new Error(`TradingView API not available: ${JSON.stringify(health)}`);
      }
      console.log(`[STARTUP] ✅ TradingView connected | Symbol: ${health['chart_symbol']} | TF: ${health['chart_resolution']}`);
      return;
    } catch (err) {
      console.error(`[STARTUP] ❌ Connection attempt ${attempt}/${retries} failed:`, err);
      if (attempt < retries) {
        console.log(`[STARTUP] Retrying in ${STARTUP_RETRY_DELAY_MS / 1000}s...`);
        await sleep(STARTUP_RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(`Failed to connect to TradingView after ${retries} attempts`);
}

async function ensureChartSetup(tvSymbol: string, contractRoot: string): Promise<void> {
  const health = await tvHealth.healthCheck() as Record<string, unknown>;
  const currentSymbol = (health['chart_symbol'] as string | undefined) ?? '';

  if (!currentSymbol.toUpperCase().includes(contractRoot.toUpperCase())) {
    console.log(`[STARTUP] Switching chart symbol to ${tvSymbol}...`);
    await tvChart.setSymbol({ symbol: tvSymbol });
    await sleep(500);
  }

  await tvChart.setType({ chart_type: '1' }); // candles
  await tvChart.setTimeframe({ timeframe: '1' }); // 1m
  await sleep(300);
  console.log(`[STARTUP] ✅ Chart configured: ${tvSymbol} / 1m / Candles`);

  try {
    const state = await tvChart.getState() as Record<string, unknown>;
    const indicators = JSON.stringify(state).toLowerCase();
    if (!indicators.includes('average true range')) {
      console.log('[STARTUP] Adding ATR(14) indicator...');
      await tvChart.manageIndicator({ action: 'add', indicator: 'Average True Range' });
      await sleep(300);
    }
    if (!indicators.includes('relative strength index')) {
      console.log('[STARTUP] Adding RSI(14) indicator...');
      await tvChart.manageIndicator({ action: 'add', indicator: 'Relative Strength Index' });
      await sleep(300);
    }
  } catch (err) {
    console.warn('[STARTUP] ⚠️ Could not auto-add indicators (non-fatal):', err);
  }
}

async function quickHealthCheck(): Promise<boolean> {
  for (let i = 0; i < MAX_HEALTH_RETRIES; i++) {
    try {
      const h = await tvHealth.healthCheck() as Record<string, unknown>;
      return h['cdp_connected'] === true && h['api_available'] === true;
    } catch {
      if (i < MAX_HEALTH_RETRIES - 1) await sleep(HEALTH_RETRY_DELAY_MS);
    }
  }
  return false;
}

function printCycleSummary(opts: {
  cycle: number;
  mode: string;
  symbol: string;
  price: number;
  regime: MarketRegime;
  sessionTag: string;
  eventTag: string;
  bias: string;
  setup: string;
  decision: string;
  confidence: number;
  executed: boolean;
  positionOpen: boolean;
  configVersion: string;
  changeNote: string;
}): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const modeTag = opts.mode === 'paper' ? '📋 PAPER' : opts.mode === 'live' ? '🔴 LIVE ' : '📡 SIG  ';
  const posTag = opts.positionOpen ? '🟢 IN' : '⬜ OUT';
  const decTag =
    opts.decision === 'SHORT' ? '🔴 SHORT' :
    opts.decision === 'LONG'  ? '🟢 LONG ' :
    '⬜ WAIT ';

  console.log(
    `\n${'═'.repeat(70)}\n` +
    `  ${modeTag} | Cycle #${String(opts.cycle).padStart(3)} | ${ts} UTC\n` +
    `${'─'.repeat(70)}\n` +
    `  Symbol:    ${opts.symbol}    Price: ${opts.price.toFixed(2)}\n` +
    `  Regime:    ${opts.regime.padEnd(25)}  Position: ${posTag}\n` +
    `  Session:   ${opts.sessionTag}\n` +
    `  Event:     ${opts.eventTag}\n` +
    `  HTF Bias:  ${opts.bias}\n` +
    `  Setup:     ${opts.setup}\n` +
    `  Decision:  ${decTag}   Confidence: ${opts.confidence}/10\n` +
    `  Config:    ${opts.configVersion}\n` +
    (opts.executed ? `  ✅ ORDER EXECUTED\n` : '') +
    (opts.changeNote ? `  ⚡ ${opts.changeNote}\n` : '') +
    `${'═'.repeat(70)}`
  );
}

async function main(): Promise<void> {
  console.log('\n🚀 NQ / MNQ Futures Autonomous Trading Engine starting (PAPER-ONLY)…\n');

  const env = loadEnv();
  printEnv(env);

  const contract = getContractSpec(env.SYMBOL);
  const instrumentSymbol = contract.app_symbol;
  console.log(
    `[STARTUP] Contract: ${contract.display} (${contract.root}) | venue=${contract.venue} ` +
    `| tick=${contract.tick_size} pt_value=$${contract.point_value} tick_value=$${contract.tick_value}`,
  );

  const sessionId = `SESSION_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${randomUUID().slice(0, 8)}`;
  const logWriter = new LogWriter(env.LOG_DIR);
  const configManager = new IndicatorConfigManager('./config');

  // Validate and print the canonical trading config.
  // All strategy/risk params come from indicator-config.json — env vars are
  // operational only (mode, symbol, log_dir, adapter selection).
  const validation = configManager.validate();
  if (!validation.valid) {
    for (const err of validation.errors) console.error(`[CONFIG] ❌ ${err}`);
    throw new Error('indicator-config.json has invalid values — fix before starting');
  }
  for (const warn of validation.warnings) console.warn(`[CONFIG] ⚠️  ${warn}`);
  configManager.printEffectiveConfig();

  const effectiveConfig = configManager.getConfig();

  const quoteService = new QuoteService(
    effectiveConfig.max_quote_age_ms_for_management ?? 3_000,
    effectiveConfig.quote_poll_timeout_ms ?? 1_000,
  );

  // ── Bookmap/Rithmic BBO provider (primary quote authority when available) ──
  const lobServiceUrl = process.env['LOB_SERVICE_URL'] ?? 'http://127.0.0.1:5010';
  const lobClient = new LobClient(lobServiceUrl, 800);
  const bookmapProvider = new BookmapQuoteProvider(
    lobClient,
    effectiveConfig.max_quote_age_ms_for_management ?? 3_000,
  );
  quoteService.addProvider(bookmapProvider);

  // Check LOB sidecar at startup (including MBO capability)
  let lobHealth: Awaited<ReturnType<typeof lobClient.getHealth>> | null = null;
  try { lobHealth = await lobClient.getHealth(); } catch { /* sidecar not running */ }
  const lobHealthy = lobHealth?.status === 'ok' && lobHealth.source_connected && lobHealth.bbo_fresh;
  if (lobHealthy) {
    console.log(`[LOB] Bookmap/Rithmic sidecar connected at ${lobServiceUrl} — primary quote authority`);
    console.log(formatMboStatusLine(lobHealth));
  } else {
    console.log(`[LOB] Bookmap/Rithmic sidecar not available at ${lobServiceUrl} — using TradingView fallback`);
  }

  const managementEngine = new ManagementDecisionEngine(contract);
  // Persists the latest management metrics across the onMonitor → writeTradePathPoint boundary
  let lastMgmtMetrics: ManagementMetrics | null = null;
  let lastMlDecision: MlDecision | null = null;
  const mlConfig: MlManagementConfig = effectiveConfig.ml_management ?? DEFAULT_ML_CONFIG;
  const entryMlConfig: EntryMlConfig = effectiveConfig.entry_ml ?? DEFAULT_ENTRY_ML_CONFIG;
  const execPolicyConfig: ExecutionPolicyConfig = effectiveConfig.execution_policy ?? DEFAULT_EXECUTION_POLICY_CONFIG;
  const extensionConfig: EntryExtensionFilterConfig = effectiveConfig.entry_extension_filters ?? DEFAULT_EXTENSION_FILTER_CONFIG;
  const execPolicy = new ExecutionPolicyEngine(execPolicyConfig);

  // 480 × 1m bars = 8 hours — enough to span overnight into prior RTH
  // for prior_rth_high/low computation; also supports opening range caching.
  const dataCollector = new DataCollector({ bars1m: 480, bars5m: 60, bars15m: 30, bars1h: 24 });
  const riskManager = new RiskManager(effectiveConfig, contract);
  const adapter = createAdapter(env.MODE, env.LIVE_TRADING_ENABLED, contract);
  const positionManager = new PositionManager(contract, instrumentSymbol);
  positionManager.setManagementEventHandler((event) => logWriter.writeManagementEvent(event));
  const perfTracker = new PerformanceTracker(sessionId, logWriter, effectiveConfig.account_equity);
  const events = EventCalendar.load('./config');
  console.log(`[STARTUP] Loaded event calendar: ${events.size()} events`);

  const session: SessionRecord = {
    session_id: sessionId,
    prompt_version: 'ml_v1.0',
    strategy_version: env.STRATEGY_VERSION,
    indicator_config_version: effectiveConfig.version,
    mode: env.MODE,
    symbol: instrumentSymbol,
    venue: contract.venue,
    timestamp_start: new Date().toISOString(),
    timestamp_end: null,
    live_trading_enabled: env.LIVE_TRADING_ENABLED,
    total_signals: 0,
    total_trades: 0,
    wins: 0,
    losses: 0,
    scratches: 0,
    total_pnl_usd: 0,
    daily_loss_pct: 0,
    daily_loss_limit_pct: effectiveConfig.max_daily_loss_pct,
    shutdown_reason: null,
  };
  logWriter.writeSession(session);

  // ─── Dashboard ─────────────────────────────────────────────────────────────
  const dashboardState = new DashboardStateManager();
  dashboardState.setAppMeta(
    { symbol: instrumentSymbol, mode: env.MODE, session_id: sessionId },
    contract,
    effectiveConfig.account_equity,
  );
  // Hydrate recent trades from disk
  dashboardState.loadTradesFromDisk(logWriter.readAllTrades());
  // Hydrate performance stats if available
  const savedPerf = logWriter.readPerformance();
  if (savedPerf) dashboardState.updatePerformance(savedPerf);

  const dashboardPort = parseInt(process.env['DASHBOARD_PORT'] ?? '3900', 10);
  // Resolve static dir relative to project root (works from dist/ after build)
  const __filename_resolved = fileURLToPath(import.meta.url);
  const projectRoot = resolve(join(__filename_resolved, '..', '..', '..'));
  const staticDir = join(projectRoot, 'dashboard', 'dist');
  const dashboardServer = new DashboardServer({
    port: dashboardPort,
    stateManager: dashboardState,
    staticDir,
  });
  dashboardServer.start().catch(err => {
    console.warn('[DASHBOARD] ⚠️ Failed to start dashboard server (non-fatal):', err);
  });

  console.log('\n[STARTUP] Verifying TradingView connection...');
  await verifyConnection();
  dashboardState.setConnectionStatus('connected');
  dashboardState.setEngineRunning(true);
  await ensureChartSetup(contract.tv_symbol, contract.root);

  let totalSignals = 0;
  let lastRegime: MarketRegime = 'range_bound';
  let cycleChangeNote = '';
  let lastResetDay = new Date().getUTCDate();
  let lastSnap: MarketSnapshot | null = null;
  let lastAlignmentScore: number | null = null;
  let lastConfidence: number | null = null;
  const recentEventLog: string[] = [];
  // ── Engine phase state machine ────────────────────────────────────────────
  const phaseManager = new EnginePhaseManager();
  let lastSignal: DualDirectionResult | null = null;
  let lastCooldownActive: boolean | null = null;

  // ── ML management health check ────────────────────────────────────────────
  if (mlConfig.enabled) {
    const mlHealthy = await checkMlHealth(mlConfig.service_url, mlConfig.timeout_ms);
    if (mlHealthy) {
      console.log(`[ML] ML management service connected at ${mlConfig.service_url}`);
    } else {
      console.warn(`[ML] ML management service NOT reachable at ${mlConfig.service_url} — ML decisions will be skipped`);
    }
  } else {
    console.log('[ML] ML management disabled in config');
  }

  const scheduler = new Scheduler(effectiveConfig.analysis_interval_seconds * 1000);
  console.log(
    `\n[RUNNER] ▶️  Starting hybrid loop in mode: ${env.MODE.toUpperCase()} ` +
    `(analysis=${effectiveConfig.analysis_interval_seconds}s, ` +
    `monitor=${effectiveConfig.in_position_monitor_seconds}s)\n`,
  );

  // ─── Shadow / advisory signal (runs in MANAGING for analytics only) ─────────
  const runShadowSignal = async (snap: MarketSnapshot | null, cycleNumber: number): Promise<void> => {
    if (!snap) return;
    const advisoryResult: DualDirectionResult = generateSignal(snap, effectiveConfig, contract);

    console.log(
      `[SHADOW] Cycle #${cycleNumber} advisory: ${advisoryResult.decision} ` +
      `| conf=${advisoryResult.confidence} | regime=${advisoryResult.regime}`,
    );

    // Log as advisory signal — never used for execution
    const shadowId = `SHADOW_${sessionId}_${String(cycleNumber).padStart(4, '0')}`;
    const shadowSignal: Signal = {
      signal_id: shadowId,
      session_id: sessionId,
      timestamp: snap.timestamp_iso,
      unix_ts: snap.timestamp_unix,
      symbol: instrumentSymbol,
      mode: env.MODE,
      strategy_version: env.STRATEGY_VERSION,
      indicator_config_version: effectiveConfig.version,
      market_regime: advisoryResult.regime,
      higher_timeframe_bias: advisoryResult.bias,
      current_price: snap.price,
      indicator_snapshot_1m: snap.indicators_1m,
      indicator_snapshot_1h: snap.indicators_1h,
      key_levels: snap.key_levels,
      candidate_setup: advisoryResult.bestSetup,
      confidence: advisoryResult.confidence,
      trade_allowed: false,
      reason_for_skip: 'advisory_only_managing_phase',
      execution_occurred: false,
      no_trade: true,
      near_miss_filters_failed: [],
      ml_features: advisoryResult.mlFeatures,
      outcome_label: null,
      config_type: effectiveConfig.type,
      dual_direction_decision: advisoryResult.decision,
      dual_long_score: advisoryResult.bestLong?.score ?? null,
      dual_short_score: advisoryResult.bestShort?.score ?? null,
      dual_score_margin: advisoryResult.scoreMargin,
    };
    logWriter.writeSignal(shadowSignal);

    // Update dashboard directional display (advisory only)
    dashboardState.updateDirectionalSignal(advisoryResult);
    lastSignal = advisoryResult;
    lastRegime = advisoryResult.regime;
    lastAlignmentScore = advisoryResult.bias.alignment_score;
    lastConfidence = advisoryResult.confidence;
  };

  // ─── Fast in-position monitor ───────────────────────────────────────────────
  const onMonitor = async (_cycleNumber: number): Promise<void> => {
    if (!positionManager.hasOpenPosition()) return;
    let price: number | null = null;
    let quoteResult = await quoteService.fetchFresh().catch(() => null);
    if (quoteResult) {
      const age = quoteService.computeAge(quoteResult);
      const stale = quoteService.isStale(quoteResult);
      const failoverNote = quoteResult.failover_reason ? ` failover=[${quoteResult.failover_reason}]` : '';
      console.log(`[QUOTE] source=${quoteResult.source} price=${quoteResult.price} age_ms=${age}${failoverNote}`);
      dashboardState.updateQuoteInfo({ ...quoteResult, age_ms: age, is_stale: stale });
      if (stale) {
        console.warn(`[QUOTE] Stale quote (${age}ms > ${effectiveConfig.max_quote_age_ms_for_management ?? 3_000}ms) — skipping monitor tick`);
        dashboardState.flush();
        return;
      }
      price = quoteResult.price;
    } else if (effectiveConfig.enable_stale_quote_fallback && lastSnap) {
      quoteResult = quoteService.makeFallback(lastSnap.price);
      dashboardState.updateQuoteInfo(quoteResult);
      price = lastSnap.price;
      console.warn(`[QUOTE] fetch failed — fallback to lastSnap price=${price}`);
    } else {
      console.warn('[QUOTE] fetch failed, no fallback — skipping monitor tick');
      return;
    }
    if (price === null) return;

    // ── In-trade management metrics (PoP + EV advisory) ──────────────────────
    const openPos = positionManager.getPosition();
    if (openPos) {
      const sessionCtx = classifySession();
      const mgmtFeatures = buildManagementFeatures(
        openPos,
        price,
        lastSnap?.indicators_1m ?? null,
        lastRegime,
        sessionCtx.strategy_bucket ?? null,
      );
      const mgmtMetrics = managementEngine.evaluate(mgmtFeatures);
      lastMgmtMetrics = mgmtMetrics;
      dashboardState.updateManagement(mgmtMetrics);
      console.log(
        `[MGMT] state=${mgmtMetrics.management_state} ` +
        `pop_t1=${mgmtMetrics.pop.pop_target1_before_stop} ` +
        `pop_t2=${mgmtMetrics.pop.pop_target2_before_stop} ` +
        `ev_hold=$${mgmtMetrics.expected_value_hold_usd} ` +
        `ev_exit=$${mgmtMetrics.expected_value_exit_now_usd} ` +
        `model=${mgmtMetrics.pop.model_name}(${mgmtMetrics.pop.confidence_in_estimate}) ` +
        `reason="${mgmtMetrics.management_state_reason}"`,
      );
    }

    const exit = positionManager.evaluate(price, effectiveConfig);
    if (!exit.shouldExit || !exit.reason) {
      // ── ML management advisory (only when hard stops did NOT trigger) ──
      // The ML model can suggest actions, but hard stops always take precedence.
      if (mlConfig.enabled && positionManager.hasOpenPosition()) {
        try {
          // Quote is confirmed fresh at this point (stale quotes cause early return above)
          const mlQuoteAge = quoteResult ? quoteService.computeAge(quoteResult) : 9999;
          // Fetch LOB snapshot for ML features (non-blocking, null if unavailable)
          const mlLobSnap = await lobClient.getSnapshot().catch(() => null);
          const mlDec = await getMlDecision(
            positionManager.getPosition()!,
            price,
            mlQuoteAge,
            mlConfig,
            mlLobSnap,
          );
          lastMlDecision = mlDec;

          // Log ML decision + update dashboard
          const mlLogPos = positionManager.getPosition();
          dashboardState.updateMlManagement(mlDec, mlConfig);
          logWriter.writeMlManagementAction({
            timestamp: new Date().toISOString(),
            trade_id: mlLogPos?.trade_id ?? '',
            action: mlDec.action,
            action_confidence: mlDec.confidence,
            model_name: mlDec.model_name,
            model_version: mlConfig.model_version,
            prob_hold: mlDec.prob_hold,
            ev_hold_r: mlDec.ev_hold_r,
            approved: mlDec.approved,
            rejection_reason: mlDec.rejection_reason,
            inference_ms: mlDec.inference_ms,
            quote_age_ms: mlQuoteAge,
            side: mlLogPos?.side ?? null,
            setup_type: mlLogPos?.setup_type ?? null,
            quantity_remaining: mlLogPos?.quantity_remaining ?? null,
            unrealized_r: mlLogPos ? positionManager.getUnrealizedR(price) : null,
            notes: mlDec.notes,
          });

          if (mlDec.approved && mlDec.action !== 'NO_ACTION' && mlDec.action !== 'HOLD') {
            const mlPos = positionManager.getPosition()!;

            // ── Execution policy gate ────────────────────────────────────────
            const policyResult = execPolicy.evaluate(
              mlDec.action, mlPos, mlLobSnap, mlQuoteAge,
              mlDec.recommended_size_fraction !== null
                ? Math.max(1, Math.floor(mlPos.quantity_remaining * mlDec.recommended_size_fraction))
                : null,
              mlDec.recommended_stop_price,
            );

            // Log intent
            logWriter.writeMlManagementAction({
              _type: 'execution_intent',
              timestamp: new Date().toISOString(),
              trade_id: mlPos.trade_id,
              source_action: policyResult.intent.source_action,
              execution_action: policyResult.intent.execution_action,
              urgency: policyResult.intent.urgency,
              timing: policyResult.intent.timing,
              should_execute: policyResult.should_execute,
              block_reason: policyResult.block_reason,
              spread_ticks: policyResult.intent.microstructure.spread_ticks,
              quote_age_ms: policyResult.intent.microstructure.quote_age_ms,
              reasons: policyResult.intent.reasons,
            });

            if (!policyResult.should_execute) {
              if (_cycleNumber % 10 === 0) {
                console.log(`[EXEC-POLICY] Blocked: ${mlDec.action} — ${policyResult.block_reason}`);
              }
            } else {

            console.log(
              `[ML] Approved: ${mlDec.action} conf=${mlDec.confidence.toFixed(2)} ` +
              `prob_hold=${mlDec.prob_hold?.toFixed(2) ?? 'n/a'} ev_hold=${mlDec.ev_hold_r?.toFixed(3) ?? 'n/a'} ` +
              `model=${mlDec.model_name} ${mlDec.inference_ms}ms ` +
              `urgency=${policyResult.intent.urgency} timing=${policyResult.intent.timing}`,
            );

            if (mlDec.action === 'EXIT_ALL') {
              const exitResult = await adapter.placeExit(mlPos.side, mlPos.quantity_remaining, price, 'manual');
              const tradeRecord = positionManager.closePosition(
                exitResult, 'manual', lastRegime, sessionId, env.STRATEGY_VERSION, price,
                {
                  target_1_direction_valid: mlPos.target_1_direction_valid,
                  target_2_direction_valid: mlPos.target_2_direction_valid,
                  target_3_direction_valid: mlPos.target_3_direction_valid,
                  target_ordering_valid: mlPos.target_ordering_valid,
                  target_repair_applied: mlPos.target_repair_applied,
                },
              );
              logWriter.writeTrade(tradeRecord);
              riskManager.recordTradeClose(tradeRecord.pnl_realized, tradeRecord.outcome_class);
              perfTracker.recordTrade(tradeRecord);
              dashboardState.updatePosition(null);
              dashboardState.recordTrade(tradeRecord);
              dashboardState.updatePerformance(perfTracker.getStats());
              dashboardState.updateRisk(riskManager.getState());
              lobClient.endTradeContext(mlPos.trade_id).catch(() => {});
              phaseManager.transitionTo('EXITING', `ml_exit_all:${mlPos.trade_id}`);
              phaseManager.startCooldown(effectiveConfig.cooldown_bars ?? 0, tradeRecord.side);
              console.log(`[ML] Trade closed: ${tradeRecord.outcome_class} $${tradeRecord.pnl_realized.toFixed(2)}`);
            } else if (mlDec.action === 'MOVE_TO_BREAKEVEN') {
              const moved = positionManager.moveStopToBreakeven();
              if (moved) console.log('[ML] Stop moved to breakeven');
            } else if (mlDec.action === 'MOVE_STOP' && mlDec.recommended_stop_price !== null && mlDec.recommended_stop_price > 0) {
              // Gate already verified tightening-only and valid price; safe to apply
              const moved = positionManager.moveStopTo(mlDec.recommended_stop_price);
              if (moved) console.log(`[ML] Stop moved to ${mlDec.recommended_stop_price}`);
            } else if (mlDec.action === 'EXIT_PARTIAL' && mlConfig.enable_partial_exit) {
              const frac = mlDec.recommended_size_fraction;
              if (frac !== null && frac > 0 && frac < 1) {
                const qtyToExit = Math.max(1, Math.floor(mlPos.quantity_remaining * frac));
                if (qtyToExit > 0 && qtyToExit < mlPos.quantity_remaining) {
                  console.log(`[ML] Executing EXIT_PARTIAL (${qtyToExit} of ${mlPos.quantity_remaining})`);
                  const partialResult = await adapter.placeExit(mlPos.side, qtyToExit, price, 'manual');
                  positionManager.applyPartialExit(
                    qtyToExit, partialResult.fill_price, partialResult.fill_time_iso,
                    partialResult.fee_usd, partialResult.slippage_pts, effectiveConfig,
                  );
                }
              }
            }

            // Record execution for cooldown tracking
            execPolicy.recordExecution(mlDec.action);

            } // end execution policy should_execute block
          } else if (mlDec.action !== 'HOLD' && mlDec.action !== 'NO_ACTION' && !mlDec.approved) {
            // Log rejections at lower frequency (every 10th cycle)
            if (_cycleNumber % 10 === 0) {
              console.log(`[ML] Rejected: ${mlDec.action} — ${mlDec.rejection_reason}`);
            }
          }
        } catch (err) {
          // ML failures must never break trading — log and continue
          if (_cycleNumber % 30 === 0) {
            console.warn(`[ML] Decision error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      dashboardState.flush();
      return;
    }

    const slipVsPlan = Math.abs(exit.exitPrice - exit.plannedExitPrice);
    console.log(
      `[EXIT] trigger=${exit.reason} planned=${exit.plannedExitPrice.toFixed(contract.price_decimals)} ` +
      `actual=${exit.exitPrice.toFixed(contract.price_decimals)} slip=${slipVsPlan.toFixed(2)}pts`,
    );
    const pos = positionManager.getPosition()!;
    if (exit.isPartial) {
      const partialResult = await adapter.placeExit(pos.side, exit.partialQuantity, exit.exitPrice, exit.reason);
      const fillTimeIso = partialResult.fill_time_iso;
      const slippagePts = Math.abs(exit.exitPrice - exit.plannedExitPrice);
      if (exit.reason === 'partial_profit_1') {
        positionManager.applyPt1Exit(exit.partialQuantity, exit.exitPrice, fillTimeIso, partialResult.fee_usd, slippagePts, effectiveConfig);
      } else if (exit.reason === 'partial_profit_2') {
        positionManager.applyPt2Exit(exit.partialQuantity, exit.exitPrice, fillTimeIso, partialResult.fee_usd, slippagePts, effectiveConfig);
      } else {
        // T1-hit partial (target_1 as partial trigger)
        positionManager.applyPartialExit(exit.partialQuantity, exit.exitPrice, fillTimeIso, partialResult.fee_usd, slippagePts, effectiveConfig);
      }
    } else if (exit.reason === 'partial_profit_1' && !exit.isPartial) {
      // Single-contract position: PT1 triggers a full exit — no prior partial leg recorded,
      // closePosition() will compute pnl from quantity_remaining (= original qty) correctly.
      const exitResult = await adapter.placeExit(pos.side, pos.quantity_remaining, exit.exitPrice, exit.reason);
      // Mark PT1 fields on position for backward-compat consumers
      const posRef = positionManager.getPosition();
      if (posRef) {
        posRef.pt1_done = true;
        posRef.pt1_qty_exited = pos.quantity_remaining;
      }
      const tradeRecord = positionManager.closePosition(
        exitResult, exit.reason, lastRegime, sessionId, env.STRATEGY_VERSION, exit.plannedExitPrice,
        {
          target_1_direction_valid: pos.target_1_direction_valid,
          target_2_direction_valid: pos.target_2_direction_valid,
          target_3_direction_valid: pos.target_3_direction_valid,
          target_ordering_valid: pos.target_ordering_valid,
          target_repair_applied: pos.target_repair_applied,
        },
      );
      logWriter.writeTrade(tradeRecord);
      riskManager.recordTradeClose(tradeRecord.pnl_realized, tradeRecord.outcome_class);
      perfTracker.recordTrade(tradeRecord);
      dashboardState.updatePosition(null);
      dashboardState.clearManagement();
      lastMgmtMetrics = null;
      dashboardState.recordTrade(tradeRecord);
      dashboardState.updatePerformance(perfTracker.getStats());
      dashboardState.updateRisk(riskManager.getState());
      dashboardState.flush();
      console.log(
        `[RUNNER] Trade closed (PT1 full): ${tradeRecord.outcome_class.toUpperCase()} ` +
        `| $${tradeRecord.pnl_realized.toFixed(2)} | ${tradeRecord.r_multiple}R`,
      );
      recentEventLog.push(`trade_closed:${tradeRecord.trade_id}:${tradeRecord.outcome_class}:${tradeRecord.r_multiple}R`);
      lobClient.endTradeContext(tradeRecord.trade_id).catch(() => {});
      phaseManager.transitionTo('EXITING', `exit:${exit.reason}`);
      phaseManager.startCooldown(effectiveConfig.cooldown_bars ?? 0, tradeRecord.side);
      lastCooldownActive = phaseManager.current() === 'COOLDOWN';
    } else {
      const exitResult = await adapter.placeExit(pos.side, pos.quantity_remaining, exit.exitPrice, exit.reason);
      const tradeRecord = positionManager.closePosition(
        exitResult, exit.reason, lastRegime, sessionId, env.STRATEGY_VERSION, exit.plannedExitPrice,
        {
          target_1_direction_valid: pos.target_1_direction_valid,
          target_2_direction_valid: pos.target_2_direction_valid,
          target_3_direction_valid: pos.target_3_direction_valid,
          target_ordering_valid: pos.target_ordering_valid,
          target_repair_applied: pos.target_repair_applied,
        },
      );
      logWriter.writeTrade(tradeRecord);
      riskManager.recordTradeClose(tradeRecord.pnl_realized, tradeRecord.outcome_class);
      perfTracker.recordTrade(tradeRecord);
      dashboardState.updatePosition(null);
      dashboardState.clearManagement();
      lastMgmtMetrics = null;
      dashboardState.recordTrade(tradeRecord);
      dashboardState.updatePerformance(perfTracker.getStats());
      dashboardState.updateRisk(riskManager.getState());
      dashboardState.flush();
      console.log(
        `[RUNNER] 📋 Trade closed: ${tradeRecord.outcome_class.toUpperCase()} ` +
        `| $${tradeRecord.pnl_realized.toFixed(2)} | ${tradeRecord.r_multiple}R`,
      );
      recentEventLog.push(`trade_closed:${tradeRecord.trade_id}:${tradeRecord.outcome_class}:${tradeRecord.r_multiple}R`);
      lobClient.endTradeContext(tradeRecord.trade_id).catch(() => {});
      phaseManager.transitionTo('EXITING', `exit:${exit.reason}`);
      phaseManager.startCooldown(effectiveConfig.cooldown_bars ?? 0, tradeRecord.side);
      lastCooldownActive = phaseManager.current() === 'COOLDOWN';
    }
  };

  // ─── Analysis cycle ─────────────────────────────────────────────────────────
  const onAnalysis = async (cycleNumber: number): Promise<void> => {
    cycleChangeNote = '';
    const analysisStartMs = Date.now();

    const currentDay = new Date().getUTCDate();
    if (currentDay !== lastResetDay) {
      console.log('[RUNNER] 🔄 New UTC day — resetting daily risk counters');
      riskManager.resetDaily();
      lastResetDay = currentDay;
    }

    if (riskManager.isLocked()) {
      const lockReason = riskManager.getLockReason();
      console.log(`[RUNNER] 🔒 Risk locked (${lockReason}). Monitoring only.`);
      return;
    }

    const healthy = await quickHealthCheck();
    if (!healthy) {
      console.error('[RUNNER] ⚠️  TradingView health check failed. Skipping cycle.');
      return;
    }

    let snap: MarketSnapshot;
    try {
      snap = await dataCollector.collect(instrumentSymbol);
    } catch (err) {
      console.error('[RUNNER] ❌ Data collection failed:', err);
      return;
    }
    // attach event state
    snap.event = events.evaluate(new Date());
    lastSnap = snap;
    dashboardState.updateMarketSnapshot(snap);
    dashboardState.incrementCycle();
    // Track collection timing for freshness metadata + observability
    const collectionTiming = dataCollector.lastTiming;
    if (collectionTiming) {
      dashboardState.updateCollectionTiming(collectionTiming);
      // Log timing every 10th cycle to avoid spam
      if (cycleNumber % 10 === 1) {
        const hits = collectionTiming.htf_cache_hits.join(',') || 'none';
        const misses = collectionTiming.htf_cache_misses.join(',') || 'none';
        console.log(
          `[COLLECT] ${collectionTiming.total_ms}ms | 1m:${collectionTiming.phase_1m_ms}ms ` +
          `| HTF cache hits=[${hits}] misses=[${misses}]`,
        );
      }
    }

    // ── Phase-aware routing ──────────────────────────────────────────────
    const phase = phaseManager.current();

    // COOLDOWN: check if expired, transition to FLAT; otherwise skip analysis
    if (phase === 'COOLDOWN') {
      if (phaseManager.checkCooldownExpired(effectiveConfig.cooldown_bars ?? 0)) {
        phaseManager.transitionTo('FLAT', 'cooldown_expired');
        lastCooldownActive = false;
      } else {
        dashboardState.updateEnginePhase(phaseManager.snapshot());
        dashboardState.incrementCycle();
        dashboardState.flush();
        return;
      }
    }

    // MANAGING: position is open — run exit evaluation + trade-path logging only
    if (phase === 'MANAGING') {
      await onMonitor(cycleNumber);
      const pos = positionManager.getPosition();
      if (pos) {
        const direction = pos.side === 'short' ? '🔴' : '🟢';
        const pnlPts = pos.side === 'short' ? pos.entry_price - snap.price : snap.price - pos.entry_price;
        const pnlUsd = pnlPts * pos.quantity_remaining * contract.point_value;
        console.log(
          `[POS] ${direction} ${pos.side.toUpperCase()} ${pos.quantity_remaining} ${contract.root} | ` +
          `Entry: ${pos.entry_price} | Now: ${snap.price} | ` +
          `P&L: ${pnlPts > 0 ? '+' : ''}${pnlPts.toFixed(2)}pts ($${pnlUsd.toFixed(2)}) | ` +
          `Stop: ${pos.stop_current} | T1: ${pos.target_1} | trail=${pos.trailing_active ? pos.trail_distance_ticks + 'tk' : 'off'}`,
        );
        const riskPts = Math.abs(pos.entry_price - pos.stop_initial);
        logWriter.writeTradePathPoint({
          timestamp: new Date().toISOString(),
          trade_id: pos.trade_id,
          session_id: sessionId,
          side: pos.side,
          entry_price: pos.entry_price,
          current_price: snap.price,
          pnl_pts: Math.round(pnlPts * 100) / 100,
          pnl_usd: Math.round(pnlUsd * 100) / 100,
          unrealized_r: riskPts > 0 ? Math.round((pnlPts / riskPts) * 100) / 100 : 0,
          stop_current: pos.stop_current,
          trailing_active: pos.trailing_active,
          target_1: pos.target_1,
          target_2: pos.target_2,
          partial_exit_done: pos.partial_exit_done,
          quantity_remaining: pos.quantity_remaining,
          mfe_pts: Math.round(pos.max_favorable_excursion * 100) / 100,
          mae_pts: Math.round(pos.max_adverse_excursion * 100) / 100,
          hold_seconds: Math.round((Date.now() - pos.entry_time_unix) / 1000),
          // ── ML training enrichment fields ──────────────────────────────────
          initial_risk_pts: riskPts,
          setup_type: pos.setup_type,
          regime: lastRegime,
          pop_t1_advisory: lastMgmtMetrics?.pop.pop_target1_before_stop ?? null,
          pop_t2_advisory: lastMgmtMetrics?.pop.pop_target2_before_stop ?? null,
          pop_model: lastMgmtMetrics?.pop.model_name ?? null,
          // ── Management state enrichment ────────────────────────────────────
          management_profile: pos.management_params?.profile_name ?? null,
          pt1_done: pos.pt1_done,
          pt2_done: pos.pt2_done,
          pre_t1_be_triggered: pos.pre_t1_be_triggered,
          pre_t1_trailing_active: pos.pre_t1_trailing_active,
          trail_distance_ticks: pos.trail_distance_ticks,
          atr_at_entry: pos.atr_at_entry,
          // ── ML advisory state ──────────────────────────────────────────────
          ml_action: lastMlDecision?.action ?? null,
          ml_confidence: lastMlDecision?.confidence ?? null,
          ml_prob_hold: lastMlDecision?.prob_hold ?? null,
          ml_ev_hold_r: lastMlDecision?.ev_hold_r ?? null,
          ml_approved: lastMlDecision?.approved ?? null,
          ml_model: lastMlDecision?.model_name ?? null,
          ml_inference_ms: lastMlDecision?.inference_ms ?? null,
        });
      }
      // Dashboard updates for MANAGING phase
      dashboardState.updateRisk(riskManager.getState());
      dashboardState.updatePosition(positionManager.getPosition());
      dashboardState.updatePerformance(perfTracker.getStats());
      dashboardState.updateEnginePhase(phaseManager.snapshot());
      dashboardState.updateAnalysisTiming(
        Date.now() - analysisStartMs,
        effectiveConfig.analysis_interval_seconds * 1000,
      );
      dashboardState.flush();
      return; // Do NOT fall through to generateSignal() — no entry analysis in MANAGING
    }

    // ── FLAT phase: full analysis + entry evaluation ───────────────────────

    const dualResult: DualDirectionResult =
      generateSignal(snap, effectiveConfig, contract);
    const { regime, bias, bestSetup, tradeAllowed: baseTradeAllowed, skipReasons, mlFeatures, decision: dualDecision, bestLong, bestShort, scoreMargin: dualMargin } = dualResult;
    // confidence is mutable — micro overlay may adjust it below
    let confidence = dualResult.confidence;
    let tradeAllowed = baseTradeAllowed;
    lastRegime = regime;
    lastAlignmentScore = bias.alignment_score;
    lastConfidence = confidence;
    lastSignal = dualResult;
    dashboardState.updateRegime(regime);
    dashboardState.updateDirectionalSignal(dualResult);
    dashboardState.updateConfidenceTiming();
    totalSignals++;
    const signalId = `SIG_${sessionId}_${String(totalSignals).padStart(4, '0')}`;

    const nearMissFilters: string[] = [...skipReasons];
    if (bestSetup && confidence >= effectiveConfig.min_confidence - 1.0 && !tradeAllowed) {
      nearMissFilters.push('near_miss');
    }

    const biasStr = `1h:${bias['1h']} 15m:${bias['15m']} 5m:${bias['5m']} 1m:${bias['1m']} (${bias.alignment_score}/4)`;
    const setupStr = bestSetup
      ? `${bestSetup.setup_type} ${bestSetup.direction} @ ${bestSetup.entry_low.toFixed(2)}–${bestSetup.entry_high.toFixed(2)}`
      : 'none';

    const signal: Signal = {
      signal_id: signalId,
      session_id: sessionId,
      timestamp: snap.timestamp_iso,
      unix_ts: snap.timestamp_unix,
      symbol: instrumentSymbol,
      mode: env.MODE,
      strategy_version: env.STRATEGY_VERSION,
      indicator_config_version: effectiveConfig.version,
      market_regime: regime,
      higher_timeframe_bias: bias,
      current_price: snap.price,
      indicator_snapshot_1m: snap.indicators_1m,
      indicator_snapshot_1h: snap.indicators_1h,
      key_levels: snap.key_levels,
      candidate_setup: bestSetup,
      confidence,
      trade_allowed: tradeAllowed && !positionManager.hasOpenPosition(),
      reason_for_skip: skipReasons.length > 0 ? skipReasons.join('; ') : null,
      execution_occurred: false,
      no_trade: !tradeAllowed || positionManager.hasOpenPosition(),
      near_miss_filters_failed: nearMissFilters,
      ml_features: mlFeatures,
      outcome_label: null,
      config_type: effectiveConfig.type,
      // Dual-direction fields
      dual_direction_decision: dualDecision,
      dual_long_score: bestLong?.score ?? null,
      dual_short_score: bestShort?.score ?? null,
      dual_score_margin: dualMargin,
    };

    // ── Cooldown & same-bar reversal safety (delegated to EnginePhaseManager) ──
    let cooldownBlock: string | null = null;
    if (tradeAllowed && bestSetup) {
      cooldownBlock = phaseManager.getCooldownBlock(
        bestSetup.direction as 'long' | 'short',
        effectiveConfig.no_same_bar_reversal ?? false,
        effectiveConfig.cooldown_bars ?? 0,
      );
      if (cooldownBlock) {
        skipReasons.push(cooldownBlock);
        signal.reason_for_skip = (signal.reason_for_skip ? signal.reason_for_skip + '; ' : '') + cooldownBlock;
        signal.trade_allowed = false;
        signal.no_trade = true;
        console.log(`[RUNNER] ⏳ Safety block: ${cooldownBlock}`);
      }
    }
    lastCooldownActive = cooldownBlock !== null;

    let executed = false;

    // ── Log candidate signal + compute extension features ────────────────
    let extensionFeatures: ExtensionFeatures | null = null;
    let extensionVetoed = false;
    let extensionVetoReasons: string[] = [];

    // Fetch LOB snapshot once at candidate time — used for MBO diagnostics, entry ML, and microstructure overlay
    const candidateLobSnap = bestSetup ? await lobClient.getSnapshot().catch(() => null) : null;

    // Microstructure score overlay — computed for every candidate, logged always
    const microOverlayConfig: MicrostructureOverlayConfig = {
      ...DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG,
      ...effectiveConfig.microstructure_overlay,
    };
    let microScore: MicrostructureScoreResult | null = null;
    let microAdj: MicroAdjustmentResult | null = null;
    let microInfluencedSelection = false;

    // Dynamic reward plan — canonical source for RR gating and management alignment
    const dynamicRewardConfig: DynamicRewardConfig = {
      ...DEFAULT_DYNAMIC_REWARD_CONFIG,
      ...effectiveConfig.dynamic_reward_planning,
    };
    let rewardPlan: DynamicRewardPlan | null = null;

    if (bestSetup) {
      const entryMid = (bestSetup.entry_low + bestSetup.entry_high) / 2;
      extensionFeatures = computeExtensionFeatures(snap, entryMid, bestSetup.direction as 'long' | 'short');
      const vetoResult = evaluateExtensionVeto(extensionFeatures, bestSetup.direction as 'long' | 'short', extensionConfig, bestSetup.setup_type);
      extensionVetoed = vetoResult.vetoed;
      extensionVetoReasons = vetoResult.reasons;
      const extensionSoftReasons = vetoResult.soft_reasons;

      // Extract MBO diagnostics from LOB snapshot (all-null when unavailable)
      const mboDiagnostics = extractMboDiagnostics(candidateLobSnap);

      // ── Microstructure score overlay ──────────────────────────────────────
      // Computed for every candidate. When enabled, this ACTUALLY adjusts
      // bestSetup.confidence and the downstream confidence/tradeAllowed flags.
      // This is NOT just telemetry — it enters the decision path.
      microScore = computeMicrostructureScore(
        candidateLobSnap,
        bestSetup.direction as 'long' | 'short',
        bestSetup.setup_type,
        microOverlayConfig,
      );

      // Compute bounded adjustment and APPLY it to the live confidence
      microAdj = computeMicroAdjustment(microScore, confidence, microOverlayConfig);
      if (microAdj.applied) {
        const baseConf = confidence;
        // Write the adjusted confidence back into the decision path
        confidence = microAdj.final_confidence;
        bestSetup.confidence = microAdj.final_confidence;
        signal.confidence = microAdj.final_confidence;

        // Re-evaluate tradeAllowed: the micro adjustment may push a near-miss
        // above threshold or a marginal signal below it.
        if (!tradeAllowed && skipReasons.length > 0) {
          // Check if the ONLY reason was confidence below threshold
          const confSkipPattern = /^confidence_[\d.]+_below_threshold_[\d.]+$/;
          const onlyConfidenceBlock = skipReasons.length === 1 && confSkipPattern.test(skipReasons[0] ?? '');
          if (onlyConfidenceBlock && confidence >= effectiveConfig.min_confidence) {
            // Micro boost promoted this above threshold — allow it
            skipReasons.length = 0;
            signal.reason_for_skip = null;
            signal.trade_allowed = true;
            signal.no_trade = false;
            tradeAllowed = true;
            microInfluencedSelection = true;
          }
        } else if (tradeAllowed && confidence < effectiveConfig.min_confidence) {
          // Micro penalty demoted this below threshold
          skipReasons.push(`confidence_${confidence}_below_threshold_${effectiveConfig.min_confidence}(micro_demoted)`);
          signal.reason_for_skip = (signal.reason_for_skip ? signal.reason_for_skip + '; ' : '') +
            `confidence_${confidence}_below_threshold_${effectiveConfig.min_confidence}(micro_demoted)`;
          signal.trade_allowed = false;
          signal.no_trade = true;
          tradeAllowed = false;
          microInfluencedSelection = true;
        }

        console.log(
          `[MICRO] ${bestSetup.direction} ${bestSetup.setup_type} ` +
          `conf ${baseConf}→${confidence} (${microAdj.reason}) ` +
          `[${microScore.setup_family}] ${microScore.reasons.join(', ') || 'neutral'}` +
          (microInfluencedSelection ? ' ★ INFLUENCED SELECTION' : ''),
        );
      }

      // ── Dynamic reward plan ────────────────────────────────────────────────
      // Build the canonical reward plan: dynamic min RR + management-aligned PT offsets.
      // Uses extension features and microstructure score when available.
      if (dynamicRewardConfig.enabled) {
        rewardPlan = buildDynamicRewardPlan(
          bestSetup, snap, regime, effectiveConfig,
          extensionFeatures, microScore, dynamicRewardConfig,
        );
      } else {
        rewardPlan = buildLegacyRewardPlan(bestSetup, effectiveConfig, snap);
      }

      if (rewardPlan && !rewardPlan.rr_gate_pass) {
        console.log(
          `[REWARD] ${bestSetup.direction} ${bestSetup.setup_type} ` +
          `RR=${bestSetup.rr_t1} < dynamic_min=${rewardPlan.dynamic_min_rr} ` +
          `[${rewardPlan.rr_components.join(' | ')}]`,
        );
      }

      // Log candidate signal to canonical log (ALWAYS — whether taken or not)
      logWriter.writeCandidateSignal({
        _event: 'candidate',
        candidate_id: signalId,
        timestamp: snap.timestamp_iso,
        symbol: instrumentSymbol,
        side: bestSetup.direction,
        setup_type: bestSetup.setup_type,
        regime: regime,
        confidence: confidence,
        base_confidence: microAdj?.base_confidence ?? confidence,
        micro_adjustment: microAdj?.adjustment ?? 0,
        micro_adjustment_reason: microAdj?.reason ?? 'none',
        micro_influenced_selection: microInfluencedSelection,
        score_margin: dualMargin,
        trade_allowed: tradeAllowed,
        cooldown_blocked: cooldownBlock !== null,
        extension_vetoed: extensionVetoed,
        extension_veto_reasons: extensionVetoReasons,
        extension_soft_reasons: extensionSoftReasons,
        actually_executed: false, // updated below if executed
        // Extension features
        ...extensionFeatures,
        // Market context
        price: snap.price,
        atr_14: snap.indicators_1m.atr_14,
        vwap: snap.indicators_1m.vwap,
        ema_9: snap.indicators_1m.ema_9,
        ema_21: snap.indicators_1m.ema_21,
        supertrend_dir: snap.indicators_1m.supertrend_direction,
        alignment_score: bias.alignment_score,
        // MBO diagnostics (compact — all null when MBO absent)
        ...mboDiagnostics,
        // Microstructure score overlay diagnostics
        micro_score_total: microScore.total,
        micro_score_directional: microScore.directional,
        micro_score_imbalance: microScore.imbalance,
        micro_score_absorption: microScore.absorption,
        micro_score_queue: microScore.queue,
        micro_score_sweep: microScore.sweep,
        micro_score_profile: microScore.profile,
        micro_score_reasons: microScore.reasons,
        micro_score_warnings: microScore.warnings,
        micro_data_quality: microScore.data_quality,
        micro_setup_family: microScore.setup_family,
        micro_components_available: microScore.components_available,
        // Dynamic reward plan diagnostics
        dynamic_min_rr: rewardPlan?.dynamic_min_rr ?? null,
        dynamic_rr_gate_pass: rewardPlan?.rr_gate_pass ?? null,
        dynamic_rr_base: rewardPlan?.rr_base ?? null,
        dynamic_rr_regime_adj: rewardPlan?.rr_regime_adj ?? null,
        dynamic_rr_structure_adj: rewardPlan?.rr_structure_adj ?? null,
        dynamic_rr_micro_adj: rewardPlan?.rr_micro_adj ?? null,
        dynamic_rr_components: rewardPlan?.rr_components ?? null,
        dynamic_mgmt_pt1_offset_pts: rewardPlan?.mgmt_pt1_offset_pts ?? null,
        dynamic_mgmt_pt2_offset_pts: rewardPlan?.mgmt_pt2_offset_pts ?? null,
        dynamic_quality_band: rewardPlan?.quality_band ?? null,
      });

      if (extensionVetoed) {
        signal.reason_for_skip = (signal.reason_for_skip ? signal.reason_for_skip + '; ' : '')
          + `extension_veto:${extensionVetoReasons[0]}`;
        signal.no_trade = true;
        console.log(`[EXTENSION] Vetoed ${bestSetup.direction} ${bestSetup.setup_type}: ${extensionVetoReasons.join('; ')}`);
        logWriter.writeCandidateSignal({
          _event: 'extension_vetoed',
          candidate_id: signalId,
          timestamp: new Date().toISOString(),
          direction: bestSetup.direction,
          setup_type: bestSetup.setup_type,
          reasons: extensionVetoReasons,
          soft_reasons: extensionSoftReasons,
          actually_executed: false,
        });
      }

      // Log soft warnings when the trade is NOT vetoed but has informational flags
      if (!extensionVetoed && extensionSoftReasons.length > 0) {
        console.log(`[EXTENSION] Soft warnings for ${bestSetup.direction} ${bestSetup.setup_type}: ${extensionSoftReasons.join('; ')}`);
      }
    }

    if (tradeAllowed && !cooldownBlock && !extensionVetoed && !positionManager.hasOpenPosition() && bestSetup) {
      // ── ML entry confirmation gate (before risk check) ──────────────────
      let entryMlDecision: EntryMlDecision | null = null;
      if (entryMlConfig.mode !== 'off') {
        try {
          // Notify sidecar of signal window
          lobClient.startSignalContext(signalId, bestSetup.direction).catch(() => {});
          // Reuse the LOB snapshot already fetched at candidate time
          entryMlDecision = await getEntryMlDecision(
            bestSetup, snap, bias, regime, confidence,
            dualMargin, entryMlConfig, candidateLobSnap,
          );
          lobClient.endSignalContext(signalId).catch(() => {});

          // Log the decision (with MBO context for diagnostics)
          logWriter.writeMlManagementAction({
            _type: 'entry_ml_decision',
            timestamp: new Date().toISOString(),
            signal_id: signalId,
            setup_type: bestSetup.setup_type,
            direction: bestSetup.direction,
            confirmed: entryMlDecision.confirmed,
            reason: entryMlDecision.reason,
            confidence: entryMlDecision.response?.confidence ?? null,
            expected_r: entryMlDecision.response?.expected_r ?? null,
            entry_quality_prob: entryMlDecision.response?.entry_quality_prob ?? null,
            inference_ms: entryMlDecision.inference_ms,
            mode: entryMlConfig.mode,
            mbo_context: buildMboTradeContext(candidateLobSnap),
          });

          if (!entryMlDecision.confirmed && entryMlConfig.mode === 'confirm_only') {
            signal.reason_for_skip = (signal.reason_for_skip ? signal.reason_for_skip + '; ' : '') + `entry_ml:${entryMlDecision.reason}`;
            signal.no_trade = true;
            console.log(`[ENTRY-ML] Rejected: ${bestSetup.direction} ${bestSetup.setup_type} — ${entryMlDecision.reason}`);
            logWriter.writeCandidateSignal({
              _event: 'ml_rejected',
              candidate_id: signalId,
              timestamp: new Date().toISOString(),
              direction: bestSetup.direction,
              setup_type: bestSetup.setup_type,
              reason: entryMlDecision.reason,
              confidence: entryMlDecision.response?.confidence ?? null,
              expected_r: entryMlDecision.response?.expected_r ?? null,
              actually_executed: false,
            });
          } else if (entryMlDecision.confirmed) {
            console.log(
              `[ENTRY-ML] Confirmed: ${bestSetup.direction} ${bestSetup.setup_type} ` +
              `conf=${entryMlDecision.response?.confidence?.toFixed(2) ?? 'n/a'} ` +
              `r=${entryMlDecision.response?.expected_r?.toFixed(2) ?? 'n/a'} ` +
              `(${entryMlDecision.inference_ms}ms)`,
            );
          }
        } catch (err) {
          // ML entry failure is non-fatal: log and continue to rules-based entry
          console.warn(`[ENTRY-ML] Error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // If ML rejected in confirm_only mode, skip to logging
      if (entryMlDecision && !entryMlDecision.confirmed && entryMlConfig.mode === 'confirm_only') {
        // Entry blocked by ML — falls through to signal logging below
      } else {
      // ── Risk check + entry execution ───────────────────────────────────
      // Pass dynamic min RR from reward plan so the risk manager uses the
      // same canonical gate as applyHardGates() — no more duplicate fixed checks.
      const riskBlock = riskManager.preTradeCheck(bestSetup, rewardPlan?.dynamic_min_rr);
      if (riskBlock) {
        // Compute sizing detail so we can log every input that contributed to the rejection.
        const sizingDetail = riskManager.calcPositionSize(bestSetup);
        riskManager.logSizingDecision(sizingDetail, bestSetup.direction as 'long' | 'short', contract.root, contract.point_value, false);
        signal.reason_for_skip = (signal.reason_for_skip ? signal.reason_for_skip + '; ' : '') + riskBlock;
        signal.no_trade = true;
        console.log(`[RUNNER] 🚫 Risk check blocked trade: ${riskBlock}`);
        logWriter.writeCandidateSignal({
          _event: 'risk_rejected',
          candidate_id: signalId,
          timestamp: new Date().toISOString(),
          direction: bestSetup.direction,
          setup_type: bestSetup.setup_type,
          reason: riskBlock,
          actually_executed: false,
        });
      } else {
        phaseManager.transitionTo('ENTERING', `signal_${bestSetup.direction}_${bestSetup.setup_type}`);
        try {
          const sizing = riskManager.calcPositionSize(bestSetup);
          riskManager.logSizingDecision(sizing, bestSetup.direction as 'long' | 'short', contract.root, contract.point_value, true);

          const entryResult = await adapter.placeEntry(bestSetup, sizing.quantity, snap.price);
          const tradeId = `TRADE_${sessionId}_${String(totalSignals).padStart(4, '0')}`;

          // ── Resolve management profile for this setup type ─────────────
          const atrAtEntry = snap.indicators_1m?.atr_14 ?? null;
          const mgmtProfile = getManagementProfile(bestSetup.setup_type, regime, effectiveConfig);
          const resolvedMgmt = resolveProfile(mgmtProfile, atrAtEntry, contract);
          console.log(
            `[MGMT] Resolved: profile='${resolvedMgmt.profile_name}' ` +
            `PT1=${resolvedMgmt.pt1_offset_pts.toFixed(1)}pts PT2=${resolvedMgmt.pt2_offset_pts.toFixed(1)}pts ` +
            `Trail=${resolvedMgmt.trail_ticks_post_t1}tk TimeStop=${resolvedMgmt.time_stop_minutes}min ` +
            `ATR=${atrAtEntry?.toFixed(1) ?? 'n/a'}`,
          );

          const position = PositionManager.buildPosition(
            tradeId, signalId, sessionId, bestSetup, entryResult,
            sizing.quantity, sizing.notional, regime,
            effectiveConfig.version, resolvedMgmt.time_stop_minutes,
            resolvedMgmt, atrAtEntry,
          );
          position.management_variant = effectiveConfig.active_management_variant ?? 'baseline_tight_exit';
          positionManager.openPosition(position);
          riskManager.recordTradeOpen();
          phaseManager.transitionTo('MANAGING', `position_opened:${tradeId}`);

          // Notify LOB sidecar of trade context (non-blocking)
          lobClient.startTradeContext(tradeId, bestSetup.direction, entryResult.fill_price).catch(() => {});

          signal.execution_occurred = true;
          signal.no_trade = false;
          executed = true;

          // Update candidate log: append execution event linked to trade_id
          // Include MBO context snapshot at trade entry for post-hoc analysis
          logWriter.writeCandidateSignal({
            _event: 'executed',
            candidate_id: signalId,
            trade_id: tradeId,
            timestamp: new Date().toISOString(),
            fill_price: entryResult.fill_price,
            quantity: sizing.quantity,
            actually_executed: true,
            mbo_context: buildMboTradeContext(candidateLobSnap),
            micro_score_at_entry: microScore ? {
              total: microScore.total,
              family: microScore.setup_family,
              quality: microScore.data_quality,
              reasons: microScore.reasons,
            } : null,
            reward_plan_at_entry: rewardPlan ? {
              dynamic_min_rr: rewardPlan.dynamic_min_rr,
              quality_band: rewardPlan.quality_band,
              family: rewardPlan.setup_family,
              mgmt_pt1_pts: rewardPlan.mgmt_pt1_offset_pts,
              mgmt_pt2_pts: rewardPlan.mgmt_pt2_offset_pts,
              rr_components: rewardPlan.rr_components,
            } : null,
          });

          cycleChangeNote = `NEW TRADE: ${bestSetup.direction.toUpperCase()} ${sizing.quantity} ${contract.root} @ ${entryResult.fill_price} | Stop: ${bestSetup.stop} | T1: ${bestSetup.target_1} (${bestSetup.rr_t1}R)`;
          console.log(`[RUNNER] 🎯 Trade opened: ${tradeId}`);
          dashboardState.updatePosition(positionManager.getPosition());
          recentEventLog.push(`trade_opened:${tradeId}:${bestSetup.direction}:${bestSetup.setup_type}`);

        } catch (entryErr) {
          console.error(`[RUNNER] ❌ Entry failed, reverting to FLAT:`, entryErr);
          phaseManager.transitionTo('FLAT', `entry_failed:${entryErr}`);
        }
      }
      } // end ML confirmation else-block
    } else if (!tradeAllowed && skipReasons.length > 0) {
      console.log(`[RUNNER] ⏭  No trade: ${skipReasons[0]}`);
    }

    logWriter.writeSignal(signal);

    if (bestSetup && !signal.execution_occurred) {
      // Compute effective skip reason: if strategy-level reason is null but an
      // operational block prevented execution, surface that operational reason
      // so rejected_signals.jsonl never has reason_for_skip: null.
      let effectiveSkipReason = signal.reason_for_skip;
      if (!effectiveSkipReason) {
        if (positionManager.hasOpenPosition()) {
          effectiveSkipReason = 'position_already_open';
        } else if (cooldownBlock) {
          effectiveSkipReason = cooldownBlock;
        } else {
          effectiveSkipReason = 'risk_check_failed';
        }
      }
      logWriter.writeRejectedSignal({
        timestamp: snap.timestamp_iso,
        signal_id: signalId,
        session_id: sessionId,
        direction: bestSetup.direction,
        setup_type: bestSetup.setup_type,
        confidence,
        rr_t1: bestSetup.rr_t1,
        rr_t2: bestSetup.rr_t2,
        rr_validation_passed: bestSetup.rr_validation_passed,
        target_1_direction_valid: bestSetup.target_1_direction_valid,
        target_2_direction_valid: bestSetup.target_2_direction_valid,
        reason_for_skip: effectiveSkipReason,
        near_miss_filters_failed: nearMissFilters,
        current_price: snap.price,
        regime,
        alignment_score: bias.alignment_score,
        session: snap.session,
        event: snap.event,
      });
    }

    const decision = !bestSetup ? 'NO TRADE'
      : !tradeAllowed ? 'NO TRADE'
      : bestSetup.direction === 'long' ? 'LONG'
      : 'SHORT';

    const sessionTag = snap.session
      ? `${snap.session.is_rth ? 'RTH' : snap.session.is_eth ? 'ETH' : 'CLOSED'}` +
        (snap.session.is_us_cash_open_window ? ' OPEN_WINDOW' : '') +
        (snap.session.is_rth_closing_window ? ' CLOSING_WINDOW' : '')
      : 'n/a';
    const eventTag = snap.event
      ? (snap.event.is_event_window ? snap.event.suppression_reason : 'clear')
      : 'n/a';

    // ── Dashboard updates ────────────────────────────────────────────────
    dashboardState.updateRisk(riskManager.getState());
    dashboardState.updatePosition(positionManager.getPosition());
    dashboardState.updatePerformance(perfTracker.getStats());
    // Update session info from snap — use canonical session module (single call)
    if (snap.session) {
      const sess = classifySession();
      const or = snap.key_levels;
      dashboardState.updateSessionInfo({
        bucket: sess.legacy_bucket,
        exchange_state: sess.exchange_state,
        strategy_bucket: sess.strategy_bucket,
        market_open: snap.session.is_rth,
        or_complete: or.opening_range_high !== null,
        or_high: or.opening_range_high,
        or_low: or.opening_range_low,
        or_mid: or.opening_range_mid,
        or_width: or.opening_range_high !== null && or.opening_range_low !== null
          ? Math.round((or.opening_range_high - or.opening_range_low) * 100) / 100 : null,
      });
    }

    // Track analysis timing for freshness metadata
    dashboardState.updateAnalysisTiming(
      Date.now() - analysisStartMs,
      effectiveConfig.analysis_interval_seconds * 1000,
    );
    // Update engine phase for dashboard
    dashboardState.updateEnginePhase(phaseManager.snapshot());
    // Flush all accumulated state changes to the dashboard as a single SSE broadcast
    dashboardState.flush();

    printCycleSummary({
      cycle: cycleNumber,
      mode: env.MODE,
      symbol: instrumentSymbol,
      price: snap.price,
      regime,
      sessionTag,
      eventTag,
      bias: biasStr,
      setup: setupStr,
      decision,
      confidence,
      executed,
      positionOpen: positionManager.hasOpenPosition(),
      configVersion: effectiveConfig.version,
      changeNote: cycleChangeNote,
    });
  };

  await scheduler.runHybrid({
    analysisIntervalMs: effectiveConfig.analysis_interval_seconds * 1000,
    monitorIntervalMs: effectiveConfig.in_position_monitor_seconds * 1000,
    isInPosition: () => positionManager.hasOpenPosition(),
    onAnalysis,
    onMonitor,
    onShadowAnalysis: async (cycleNumber) => {
      await runShadowSignal(lastSnap, cycleNumber);
    },
  });

  console.log('\n[RUNNER] Shutting down...');
  dashboardState.setEngineRunning(false);
  dashboardServer.stop();
  const finalStats = perfTracker.getStats();
  logWriter.updateSessionEnd(sessionId, {
    timestamp_end: new Date().toISOString(),
    total_signals: totalSignals,
    total_trades: finalStats.total_trades,
    wins: finalStats.wins,
    losses: finalStats.losses,
    scratches: finalStats.scratches,
    total_pnl_usd: finalStats.total_pnl_usd,
    daily_loss_pct: riskManager.getState().daily_loss_pct,
    shutdown_reason: 'user_stopped',
  });

  perfTracker.printSelfReview();
  console.log('[RUNNER] ✅ Session ended cleanly.');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('\n[FATAL] Unrecoverable startup error:', err);
  process.exit(1);
});
