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

import { createHash, randomUUID } from 'crypto';

// Feature schema version — must stay in sync with FEATURE_SCHEMA_VERSION in
// python-market-data-service/lob_features/ml_feature_registry.py.
// Update this constant (and bump the registry version) whenever the feature set changes.
const ML_FEATURE_SCHEMA_VERSION = 'v3_advanced_mbo';
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
import { Scheduler, LaneScheduler } from './scheduler.js';
import type { LaneConfig } from './scheduler.js';
import { ExecutionLock } from './execution-lock.js';
import { createLaneSharedState } from './lane-state.js';
import type { LaneSharedState } from './lane-state.js';
import { EnginePhaseManager } from './engine-phase.js';
import { getContractSpec } from './contracts.js';
import { EventCalendar } from './events.js';
import { classifySession } from './session.js';
import { DashboardStateManager, DashboardServer } from './dashboard/index.js';
import { ManagementDecisionEngine, buildManagementFeatures } from './management/index.js';
import type { ManagementMetrics } from './management/index.js';
import { getMlDecision, checkMlHealth, DEFAULT_ML_CONFIG } from './ml/index.js';
import type { MlManagementConfig, MlDecision, MlDecisionResult, MlFeatureVector } from './ml/index.js';
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
import { RuntimeStateManager } from './runtime-state.js';
import { TradeJournal } from './trade-journal.js';
import { readRecoveryArtifacts, buildRecoveryReport, isRecoveryBlocked } from './recovery.js';
import type { RecoveryReport } from './recovery.js';

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

  // ── Phase 0: Lock + Recovery Gate (before any other disk writes) ──────────
  const runtimeState = new RuntimeStateManager(env.LOG_DIR, {
    heartbeatIntervalMs: env.RUNTIME_HEARTBEAT_INTERVAL_MS,
    heartbeatStaleMs: env.RUNTIME_HEARTBEAT_STALE_MS,
  });

  if (!runtimeState.acquireLock(sessionId)) {
    console.error('[STARTUP] Another runner instance is active. Exiting.');
    process.exit(1);
  }
  // Lock held — all early-exit paths must release it explicitly.

  runtimeState.cleanupStaleTmpFiles();

  const tradeJournal = new TradeJournal(env.LOG_DIR, sessionId);
  const recoveryArtifacts = readRecoveryArtifacts(runtimeState, tradeJournal);
  const recoveryReport = buildRecoveryReport(
    recoveryArtifacts, tradeJournal,
    env.RESTART_MODE, env.MODE,
    env.RUNTIME_HEARTBEAT_STALE_MS,
  );
  runtimeState.writeRecoveryReport(recoveryReport);

  if (isRecoveryBlocked(recoveryReport)) {
    console.error(`[STARTUP] ${recoveryReport.operator_message}`);
    console.error('[STARTUP] Set RESTART_MODE=dev to auto-clear paper positions, or manually reconcile trade state.');
    runtimeState.releaseLock();
    process.exit(2);
  }

  // Non-blocking recovery outcomes: log and proceed
  if (recoveryReport.outcome !== 'clean_start') {
    console.warn(`[STARTUP_RECOVERY] outcome=${recoveryReport.outcome} trade_id=${recoveryReport.open_trade_id ?? 'none'} action=${recoveryReport.action_taken}`);
  }

  // Recovery gate passed — safe to create LogWriter and proceed
  const logWriter = new LogWriter(env.LOG_DIR);
  logWriter.startFlushTimer();

  runtimeState.initialize(sessionId, env.MODE, env.RESTART_MODE);
  runtimeState.startHeartbeat();
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
  positionManager.setPositionChangeHandler((pos) => {
    runtimeState.updatePositionKnown(pos?.trade_id ?? null);
    runtimeState.writeOpenTradeState(pos);
  });
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
    startup_mode: recoveryReport.outcome === 'clean_start' ? 'normal'
      : recoveryReport.outcome.includes('cleared') ? 'recovery_cleared'
      : 'first_run',
    recovery_action: recoveryReport.outcome,
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
  let engineShuttingDown = false;
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

  // ─── Zombie-trade watchdog state ──────────────────────────────────────────────
  const ZOMBIE_THRESHOLD_MS = 60 * 60 * 1000;  // 60 minutes
  const ZOMBIE_LOG_INTERVAL_MS = 10 * 60 * 1000; // re-warn every 10 min
  let lastZombieWarningAt = 0;

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

    // ── Zombie-trade watchdog ─────────────────────────────────────────────────
    const zombiePos = positionManager.getPosition();
    if (zombiePos) {
      const holdMs = Date.now() - new Date(zombiePos.entry_time_iso).getTime();
      if (holdMs > ZOMBIE_THRESHOLD_MS && Date.now() - lastZombieWarningAt > ZOMBIE_LOG_INTERVAL_MS) {
        lastZombieWarningAt = Date.now();
        const quoteAge = quoteResult ? quoteService.computeAge(quoteResult) : -1;
        console.warn(
          `[ZOMBIE-TRADE] trade_id=${zombiePos.trade_id} open for ${Math.round(holdMs / 60000)}min | ` +
          `price=${price} stop=${zombiePos.stop_current} entry=${zombiePos.entry_price} | ` +
          `side=${zombiePos.side} qty=${zombiePos.quantity_remaining} | ` +
          `quote_age=${quoteAge}ms | ` +
          `last_mgmt_state=${lastMgmtMetrics?.management_state ?? 'none'}`,
        );
      }
    }

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
          const mlResult = await getMlDecision(
            positionManager.getPosition()!,
            price,
            mlQuoteAge,
            mlConfig,
            mlLobSnap,
          );
          const mlDec = mlResult.decision;
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
            model_version: mlDec.model_version || mlConfig.model_version,
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
            tier_used: mlDec.tier_used,
            fallback_used: mlDec.fallback_used,
            fallback_reason: mlDec.fallback_reason,
            notes: mlDec.notes,
          });

          // ── Log exact feature payload + response for training reproducibility ──
          // _feature_schema_hash: sha256 of sorted feature names (excluding trade_id),
          // truncated to 8 hex chars. Changes automatically when the feature set changes.
          // Use this to detect train/serve schema drift in the audit pipeline.
          const _featureSchemaHash = createHash('sha256')
            .update(Object.keys(mlResult.features).filter(k => k !== 'trade_id').sort().join(','))
            .digest('hex')
            .slice(0, 8);
          logWriter.writeMlManagementFeatures({
            // Exact serialized request body (parsed back = what the service received)
            ...JSON.parse(mlResult.serializedRequestBody),
            // Request metadata
            _timestamp: new Date().toISOString(),
            _trade_id: mlLogPos?.trade_id ?? '',
            _request_id: mlResult.requestId,
            _service_url: mlConfig.service_url,
            _request_latency_ms: mlResult.requestLatencyMs,
            _feature_count: Object.keys(mlResult.features).length - 1, // minus trade_id
            // Schema versioning — for audit/drift detection
            _log_schema_version: ML_FEATURE_SCHEMA_VERSION,
            _feature_schema_hash: _featureSchemaHash,
            // Data quality assessment
            _lob_available: mlResult.features.lob_spread_ticks !== null,
            _adv_mbo_available: mlResult.features.adv_cancel_replace_ratio_10s !== null,
            _data_quality_tier: computeDataQualityTier(mlResult.features),
            _bbo_age_ms: mlLobSnap?.bbo_age_ms ?? null,
            // Exact service response (full body for replay/debugging)
            _serialized_response_body: mlResult.serializedResponseBody,
            // Response summary (parsed for quick queries)
            _response_action: mlDec.action,
            _response_confidence: mlDec.confidence,
            _response_approved: mlDec.approved,
            _response_rejection_reason: mlDec.rejection_reason,
            _response_model_name: mlDec.model_name,
            _response_model_version: mlDec.model_version,
            _response_tier_used: mlDec.tier_used,
            _response_fallback_used: mlDec.fallback_used,
            _response_fallback_reason: mlDec.fallback_reason,
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
              logWriter.writeExecutionIntent({
                event: 'trade_exit_submitted', timestamp: new Date().toISOString(),
                trade_id: mlPos.trade_id, side: mlPos.side, source: 'ml_management',
                price, quantity: mlPos.quantity_remaining,
              });
              const exitResult = await adapter.placeExit(mlPos.side, mlPos.quantity_remaining, price, 'manual');
              logWriter.writeExecutionIntent({
                event: 'trade_exit_filled', timestamp: exitResult.fill_time_iso,
                trade_id: mlPos.trade_id, side: mlPos.side, source: 'ml_management',
                price: exitResult.fill_price, quantity: exitResult.quantity,
                slippage_pts: exitResult.slippage_pts, fee_usd: exitResult.fee_usd, order_id: exitResult.order_id,
              });
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
              logWriter.writeExecutionIntent({
                event: 'trade_closed', timestamp: new Date().toISOString(),
                trade_id: mlPos.trade_id, side: mlPos.side, source: 'ml_management',
                price: exitResult.fill_price, pnl_realized: tradeRecord.pnl_realized,
                r_multiple: tradeRecord.r_multiple, outcome_class: tradeRecord.outcome_class,
              });
              logWriter.writeTrade(tradeRecord);
              tradeJournal.append('final_close', tradeRecord.trade_id, 'runner', tradeRecord.exit_reason, null);
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
      logWriter.writeExecutionIntent({
        event: 'trade_exit_submitted', timestamp: new Date().toISOString(),
        trade_id: pos.trade_id, side: pos.side, source: 'management', reason: exit.reason,
        price: exit.exitPrice, quantity: exit.partialQuantity,
      });
      const partialResult = await adapter.placeExit(pos.side, exit.partialQuantity, exit.exitPrice, exit.reason);
      logWriter.writeExecutionIntent({
        event: 'trade_exit_filled', timestamp: partialResult.fill_time_iso,
        trade_id: pos.trade_id, side: pos.side, source: 'management', reason: exit.reason,
        price: partialResult.fill_price, quantity: partialResult.quantity,
        slippage_pts: partialResult.slippage_pts, fee_usd: partialResult.fee_usd, order_id: partialResult.order_id,
      });
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
      logWriter.writeExecutionIntent({
        event: 'trade_exit_submitted', timestamp: new Date().toISOString(),
        trade_id: pos.trade_id, side: pos.side, source: 'management', reason: exit.reason,
        price: exit.exitPrice, quantity: pos.quantity_remaining,
      });
      const exitResult = await adapter.placeExit(pos.side, pos.quantity_remaining, exit.exitPrice, exit.reason);
      logWriter.writeExecutionIntent({
        event: 'trade_exit_filled', timestamp: exitResult.fill_time_iso,
        trade_id: pos.trade_id, side: pos.side, source: 'management', reason: exit.reason,
        price: exitResult.fill_price, quantity: exitResult.quantity,
        slippage_pts: exitResult.slippage_pts, fee_usd: exitResult.fee_usd, order_id: exitResult.order_id,
      });
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
      logWriter.writeExecutionIntent({
        event: 'trade_closed', timestamp: new Date().toISOString(),
        trade_id: pos.trade_id, side: pos.side, source: 'management', reason: exit.reason,
        price: exitResult.fill_price, pnl_realized: tradeRecord.pnl_realized,
        r_multiple: tradeRecord.r_multiple, outcome_class: tradeRecord.outcome_class,
      });
      logWriter.writeTrade(tradeRecord);
      tradeJournal.append('final_close', tradeRecord.trade_id, 'runner', tradeRecord.exit_reason, null);
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
      logWriter.writeExecutionIntent({
        event: 'trade_exit_submitted', timestamp: new Date().toISOString(),
        trade_id: pos.trade_id, side: pos.side, source: 'management', reason: exit.reason,
        price: exit.exitPrice, quantity: pos.quantity_remaining,
      });
      const exitResult = await adapter.placeExit(pos.side, pos.quantity_remaining, exit.exitPrice, exit.reason);
      logWriter.writeExecutionIntent({
        event: 'trade_exit_filled', timestamp: exitResult.fill_time_iso,
        trade_id: pos.trade_id, side: pos.side, source: 'management', reason: exit.reason,
        price: exitResult.fill_price, quantity: exitResult.quantity,
        slippage_pts: exitResult.slippage_pts, fee_usd: exitResult.fee_usd, order_id: exitResult.order_id,
      });
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
      logWriter.writeExecutionIntent({
        event: 'trade_closed', timestamp: new Date().toISOString(),
        trade_id: pos.trade_id, side: pos.side, source: 'management', reason: exit.reason,
        price: exitResult.fill_price, pnl_realized: tradeRecord.pnl_realized,
        r_multiple: tradeRecord.r_multiple, outcome_class: tradeRecord.outcome_class,
      });
      logWriter.writeTrade(tradeRecord);
      tradeJournal.append('final_close', tradeRecord.trade_id, 'runner', tradeRecord.exit_reason, null);
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
        `[RUNNER] Trade closed: ${tradeRecord.outcome_class.toUpperCase()} ` +
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
    if (engineShuttingDown) return; // Block new analysis during shutdown
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
          // ── Row schema ─────────────────────────────────────────────────────
          row_type: 'trade_path_point',
          schema_version: 2,
          owner: 'v1',
          source_lane: 'monitor',
          // ── Core fields ────────────────────────────────────────────────────
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
          // ── Position progression (Phase 10) ────────────────────────────────
          stop_initial: pos.stop_initial,
          trail_anchor_price: pos.trail_anchor_price,
          pt1_realized_pnl: pos.pt1_realized_pnl,
          pt2_realized_pnl: pos.pt2_realized_pnl,
          pt1_qty_exited: pos.pt1_qty_exited,
          pt2_qty_exited: pos.pt2_qty_exited,
          mfe_at_pt1_trigger: pos.mfe_at_pt1_trigger,
          mae_at_pt1_trigger: pos.mae_at_pt1_trigger,
          peak_r_before_first_partial: pos.peak_r_before_first_partial,
          management_state: lastMgmtMetrics?.management_state ?? null,
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

    // Pre-fetch LOB snapshot for layered scoring (shadow or enabled)
    const lsConf = effectiveConfig.layered_scoring;
    const layeredNeedsLob = lsConf?.enabled || lsConf?.shadow_log;
    const preScoringLobSnap = layeredNeedsLob
      ? await lobClient.getSnapshot().catch(() => null)
      : null;

    const dualResult: DualDirectionResult =
      generateSignal(snap, effectiveConfig, contract, undefined, preScoringLobSnap);
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

    // LOB snapshot: reuse pre-scoring snapshot if available (layered shadow/enabled),
    // otherwise fetch now. This avoids comparing scores from different snapshot moments.
    const candidateLobSnap = bestSetup
      ? (preScoringLobSnap ?? await lobClient.getSnapshot().catch(() => null))
      : null;

    // Microstructure score overlay — computed for every candidate, logged always
    const microOverlayConfig: MicrostructureOverlayConfig = {
      ...DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG,
      ...effectiveConfig.microstructure_overlay,
    };
    let microScore: MicrostructureScoreResult | null = null;
    let microAdj: MicroAdjustmentResult | null = null;
    let microInfluencedSelection = false;

    // Dynamic reward plan — the upstream plan from generateSignal() handles the
    // canonical family+regime RR gate. Here we refine it with extension/micro data.
    const dynamicRewardConfig: DynamicRewardConfig = {
      ...DEFAULT_DYNAMIC_REWARD_CONFIG,
      ...effectiveConfig.dynamic_reward_planning,
    };
    // Start with the upstream plan already computed inside generateSignal()
    let rewardPlan: DynamicRewardPlan | null = dualResult.chosen?.rewardPlan ?? null;

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

      // ── Dynamic reward plan: two-stage design ────────────────────────────
      //
      // Stage 1 ("strategy_base"): Built inside generateSignal() per-candidate.
      //   Uses: setup family + market regime. No extension/micro data yet.
      //   Purpose: canonical upstream RR gate — decides which candidates survive.
      //
      // Stage 2 ("runner_refined"): Rebuilt here with full context.
      //   Uses: family + regime + extension features + microstructure score.
      //   Purpose: refined RR gate for risk check, and diagnostics logging.
      //   The upstream plan already allowed the candidate through; this refinement
      //   can only make the dynamic_min_rr MORE or LESS strict via structure/micro
      //   adjustments, but the candidate was already selected.
      //
      if (dynamicRewardConfig.enabled && (extensionFeatures || microScore)) {
        rewardPlan = buildDynamicRewardPlan(
          bestSetup, snap, regime, effectiveConfig,
          extensionFeatures, microScore, dynamicRewardConfig,
        );
      } else if (!rewardPlan) {
        // Fallback: no upstream plan (dynamic explicitly disabled) — build legacy
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
        // Upstream dynamic RR activation diagnostics
        dynamic_rr_upstream_active: dualResult.dynamicRrUpstreamActive,
        dynamic_rr_source: dualResult.dynamicRrSource,
        // Two-stage plan: 'strategy_base' = upstream family+regime only;
        // 'runner_refined' = after extension+micro adjustments in runner
        dynamic_rr_stage: (extensionFeatures || microScore) ? 'runner_refined' : 'strategy_base',
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

          const _entryTradeId = `TRADE_${sessionId}_${String(totalSignals).padStart(4, '0')}`;
          logWriter.writeExecutionIntent({
            event: 'trade_entry_submitted', timestamp: new Date().toISOString(),
            trade_id: _entryTradeId, side: bestSetup.direction as 'long' | 'short', source: 'analysis',
            price: snap.price, quantity: sizing.quantity,
          });

          const entryResult = await adapter.placeEntry(bestSetup, sizing.quantity, snap.price);
          const tradeId = _entryTradeId;

          logWriter.writeExecutionIntent({
            event: 'trade_entry_filled', timestamp: entryResult.fill_time_iso,
            trade_id: tradeId, side: bestSetup.direction as 'long' | 'short', source: 'analysis',
            price: entryResult.fill_price, quantity: entryResult.quantity,
            slippage_pts: entryResult.slippage_pts, fee_usd: entryResult.fee_usd, order_id: entryResult.order_id,
          });

          // ── Resolve management profile for this setup type ─────────────
          // The profile provides trailing, BE, time-stop parameters.
          // PT1/PT2 offsets are unified with the reward plan when available,
          // so entry validation and live management use the same targets.
          const atrAtEntry = snap.indicators_1m?.atr_14 ?? null;
          const mgmtProfile = getManagementProfile(bestSetup.setup_type, regime, effectiveConfig);
          const resolvedMgmt = resolveProfile(mgmtProfile, atrAtEntry, contract);

          // ── Unify PT1/PT2 with reward plan (canonical target truth) ─────
          // When the reward plan provides PT offsets, override the resolved
          // management PT1/PT2 so the position manager uses the same values
          // that the RR gate validated. Trail/BE/time-stop stay profile-driven.
          let targetTruthSource = 'management_profile';
          if (rewardPlan && rewardPlan.mgmt_pt1_offset_pts > 0) {
            const profilePt1 = resolvedMgmt.pt1_offset_pts;
            const profilePt2 = resolvedMgmt.pt2_offset_pts;
            resolvedMgmt.pt1_offset_pts = rewardPlan.mgmt_pt1_offset_pts;
            resolvedMgmt.pt2_offset_pts = rewardPlan.mgmt_pt2_offset_pts;
            targetTruthSource = 'reward_plan';
            if (Math.abs(profilePt1 - rewardPlan.mgmt_pt1_offset_pts) > 0.01 ||
                Math.abs(profilePt2 - rewardPlan.mgmt_pt2_offset_pts) > 0.01) {
              console.log(
                `[MGMT] PT unified: profile PT1=${profilePt1.toFixed(1)} PT2=${profilePt2.toFixed(1)} ` +
                `→ reward_plan PT1=${rewardPlan.mgmt_pt1_offset_pts.toFixed(1)} PT2=${rewardPlan.mgmt_pt2_offset_pts.toFixed(1)}`,
              );
            }
          }

          console.log(
            `[MGMT] Resolved: profile='${resolvedMgmt.profile_name}' ` +
            `PT1=${resolvedMgmt.pt1_offset_pts.toFixed(1)}pts PT2=${resolvedMgmt.pt2_offset_pts.toFixed(1)}pts ` +
            `Trail=${resolvedMgmt.trail_ticks_post_t1}tk TimeStop=${resolvedMgmt.time_stop_minutes}min ` +
            `ATR=${atrAtEntry?.toFixed(1) ?? 'n/a'} source=${targetTruthSource}`,
          );

          const position = PositionManager.buildPosition(
            tradeId, signalId, sessionId, bestSetup, entryResult,
            sizing.quantity, sizing.notional, regime,
            effectiveConfig.version, resolvedMgmt.time_stop_minutes,
            resolvedMgmt, atrAtEntry,
          );
          position.management_variant = effectiveConfig.active_management_variant ?? 'baseline_tight_exit';
          positionManager.openPosition(position);
          tradeJournal.append('trade_opened', tradeId, 'runner', bestSetup.setup_type, position);
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
            // Unified target diagnostics — confirms entry and management are aligned
            target_truth: {
              source: targetTruthSource,
              live_pt1_offset_pts: resolvedMgmt.pt1_offset_pts,
              live_pt2_offset_pts: resolvedMgmt.pt2_offset_pts,
              setup_target_1: bestSetup.target_1,
              setup_target_2: bestSetup.target_2,
              setup_rr_t1: bestSetup.rr_t1,
            },
          });

          cycleChangeNote = `NEW TRADE: ${bestSetup.direction.toUpperCase()} ${sizing.quantity} ${contract.root} @ ${entryResult.fill_price} | Stop: ${bestSetup.stop} | T1: ${bestSetup.target_1} (${bestSetup.rr_t1}R)`;
          console.log(`[RUNNER] 🎯 Trade opened: ${tradeId}`);
          dashboardState.updatePosition(positionManager.getPosition());
          // Seed ML config so dashboard shows "enabled / awaiting" before first inference
          if (mlConfig?.enabled) {
            dashboardState.seedMlConfig(mlConfig);
          }
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

  // ─── V2 Multi-Lane Engine ─────────────────────────────────────────────────
  if (effectiveConfig.runner_v2_enabled) {
    const laneTiming = effectiveConfig.lane_timing ?? {};
    const shadowOnly = effectiveConfig.runner_v2_shadow_only ?? true;
    const executionLock = new ExecutionLock();
    const sharedState: LaneSharedState = createLaneSharedState();

    // Track last ML action execution time for cooldown gate
    let v2LastMlActionTimestamp = 0;

    // Forward ref for lane metrics (assigned before scheduler.run(), read in callbacks)
    let laneSchedulerRef: LaneScheduler | null = null;

    console.log(
      `[RUNNER] ▶️  V2 multi-lane engine ${shadowOnly ? '(SHADOW-ONLY — observation mode)' : '(ACTIVE)'}`,
    );

    // ── Hard Risk Lane (500ms) ────────────────────────────────────────────
    const onHardRisk = async (_cycle: number): Promise<void> => {
      if (!positionManager.hasOpenPosition()) return;
      const pos = positionManager.getPosition();
      if (!pos) return;

      // Fetch quote with per-provider tight timeouts (BBO 150ms, TV 300ms)
      let quoteResult = await quoteService.fetchFresh({
        perProviderTimeoutMs: {
          'bookmap_bbo': laneTiming.hard_risk_quote_timeout_bbo_ms ?? 150,
          'tradingview': laneTiming.hard_risk_quote_timeout_tv_ms ?? 300,
        },
      }).catch(() => null);

      if (quoteResult && !quoteService.isStale(quoteResult)) {
        sharedState.lastPrice = quoteResult.price;
        sharedState.lastQuoteResult = {
          price: quoteResult.price,
          timestamp_unix_ms: quoteResult.timestamp_unix_ms,
          source: quoteResult.source,
          is_stale: quoteResult.is_stale,
        };
        sharedState.lastQuoteAt = Date.now();
        dashboardState.updateQuoteInfo({ ...quoteResult, age_ms: quoteService.computeAge(quoteResult), is_stale: false });
        dashboardState.updateCurrentPrice(quoteResult.price);

        // Recovery from degraded state
        if (sharedState.degradedSince !== null) {
          const degradedDuration = Date.now() - sharedState.degradedSince;
          console.log(`[HARD-RISK] RECOVERED: fresh quote after ${degradedDuration}ms degraded. ${quoteResult.source} ${quoteResult.price} age=${quoteService.computeAge(quoteResult)}ms`);
          sharedState.degradedSince = null;
        }
      }

      const price = sharedState.lastPrice;
      if (price === null) {
        // No quote ever received
        if (sharedState.degradedSince === null) {
          sharedState.degradedSince = Date.now();
        }
        if (_cycle % 20 === 0) {
          console.log(`[HARD-RISK] SKIP: no quote received yet. Waiting for first successful fetch.`);
        }
        return;
      }

      // Determine freshness tier
      const quoteAge = Date.now() - sharedState.lastQuoteAt;
      const staleFull = laneTiming.hard_risk_stale_full_risk_ms ?? 1000;
      const staleStopOnly = laneTiming.hard_risk_stale_stop_only_ms ?? 3000;

      if (quoteAge > staleStopOnly) {
        // Too stale — degraded mode, stop-hit defense only
        if (sharedState.degradedSince === null) {
          sharedState.degradedSince = Date.now();
          console.log(`[HARD-RISK] DEGRADED: no fresh quote for ${quoteAge}ms. Stop-hit only mode. Last price=${price}`);
        }
      }

      if (shadowOnly) {
        // Shadow mode: evaluate but do NOT mutate or exit
        const result = positionManager.evaluateRiskOnly(price);
        if (result.shouldExit || result.hasMutations) {
          logWriter.writeMlManagementAction({
            _type: 'v2_shadow_hard_risk',
            timestamp: new Date().toISOString(),
            trade_id: pos.trade_id,
            would_exit: result.shouldExit,
            exit_reason: result.exitDecision?.reason ?? null,
            would_mutate: result.hasMutations,
            mutations: result.proposedMutations,
            quote_age_ms: quoteAge,
            price,
          });

          // Shadow-diff: both-sides disagreement record in trade_path.jsonl
          const v2ProposedStop = result.proposedMutations.newStopCurrent;
          const stopDisagrees = v2ProposedStop !== null && v2ProposedStop !== pos.stop_current;
          const exitDisagrees = result.shouldExit;

          if (stopDisagrees || exitDisagrees) {
            logWriter.writeTradePathPoint({
              row_type: 'v2_shadow_diff',
              schema_version: 2,
              owner: 'v2_shadow',
              source_lane: 'hard_risk',
              timestamp: new Date().toISOString(),
              trade_id: pos.trade_id,
              // ── v1 live state at this instant ──
              v1_stop_current: pos.stop_current,
              v1_stop_initial: pos.stop_initial,
              v1_trailing_active: pos.trailing_active,
              v1_trail_anchor: pos.trail_anchor_price,
              v1_pre_t1_be_triggered: pos.pre_t1_be_triggered,
              v1_pt1_done: pos.pt1_done,
              v1_pt2_done: pos.pt2_done,
              // ── v2 proposed state ──
              v2_proposed_stop: v2ProposedStop,
              v2_would_exit: result.shouldExit,
              v2_exit_reason: result.exitDecision?.reason ?? null,
              v2_would_move_be: result.proposedMutations.moveStopToBE,
              v2_would_activate_trail: result.proposedMutations.activatePreT1Trail,
              v2_proposed_trail_anchor: result.proposedMutations.newTrailAnchor,
              // ── shared context ──
              price,
              quote_age_ms: quoteAge,
              // ── divergence summary ──
              divergence_type: exitDisagrees ? 'exit' : 'stop',
              stop_delta: v2ProposedStop !== null ? v2ProposedStop - pos.stop_current : null,
            });
          }
        }
        return;
      }

      // ACTIVE mode: apply mutations and exit under lock
      const result = positionManager.evaluateRiskOnly(price);

      if (result.hasMutations && quoteAge <= staleFull) {
        // Fresh enough for full risk logic (BE, trail ratchet, etc.)
        await executionLock.runExclusive(async () => {
          positionManager.applyRiskMutations(result.proposedMutations, price);
        }, { skipIfExitInFlight: true });
      }

      if (result.shouldExit) {
        if (executionLock.exitInFlight) return;
        console.log(`[HARD-RISK] shouldExit=true trade_id=${pos.trade_id} reason=${result.exitDecision?.reason} price=${price}`);
        await executionLock.runExclusive(async () => {
          const exitPos = positionManager.getPosition();
          if (!exitPos) return;
          const exitDecision = result.exitDecision!;
          const exitReason = exitDecision.reason ?? 'stop_loss';

          // 1. Submit exit
          logWriter.writeExecutionIntent({
            event: 'trade_exit_submitted', timestamp: new Date().toISOString(),
            trade_id: exitPos.trade_id, side: exitPos.side, source: 'hard_risk', reason: exitReason,
            price: exitDecision.exitPrice, quantity: exitPos.quantity_remaining,
          });
          console.log(`[EXECUTOR] submitting paper exit trade_id=${exitPos.trade_id}`);

          const exitResult = await adapter.placeExit(exitPos.side, exitPos.quantity_remaining, exitDecision.exitPrice, exitReason);

          // 2. Exit filled
          logWriter.writeExecutionIntent({
            event: 'trade_exit_filled', timestamp: exitResult.fill_time_iso,
            trade_id: exitPos.trade_id, side: exitPos.side, source: 'hard_risk', reason: exitReason,
            price: exitResult.fill_price, quantity: exitResult.quantity,
            slippage_pts: exitResult.slippage_pts, fee_usd: exitResult.fee_usd, order_id: exitResult.order_id,
          });
          console.log(`[EXECUTOR] paper exit acknowledged trade_id=${exitPos.trade_id} fill=${exitResult.fill_price}`);

          const tradeRecord = positionManager.closePosition(
            exitResult, exitReason, sharedState.lastRegime as MarketRegime, sessionId, env.STRATEGY_VERSION, exitDecision.plannedExitPrice,
            {
              target_1_direction_valid: exitPos.target_1_direction_valid,
              target_2_direction_valid: exitPos.target_2_direction_valid,
              target_3_direction_valid: exitPos.target_3_direction_valid,
              target_ordering_valid: exitPos.target_ordering_valid,
              target_repair_applied: exitPos.target_repair_applied,
            },
          );

          // 3. Trade closed
          logWriter.writeExecutionIntent({
            event: 'trade_closed', timestamp: new Date().toISOString(),
            trade_id: exitPos.trade_id, side: exitPos.side, source: 'hard_risk', reason: exitReason,
            price: exitResult.fill_price, pnl_realized: tradeRecord.pnl_realized,
            r_multiple: tradeRecord.r_multiple, outcome_class: tradeRecord.outcome_class,
          });
          console.log(`[POSITION] closed trade_id=${exitPos.trade_id} pnl=$${tradeRecord.pnl_realized.toFixed(2)}`);

          logWriter.writeTrade(tradeRecord);
          tradeJournal.append('final_close', tradeRecord.trade_id, 'runner', tradeRecord.exit_reason, null);
          riskManager.recordTradeClose(tradeRecord.pnl_realized, tradeRecord.outcome_class);
          perfTracker.recordTrade(tradeRecord);
          dashboardState.updatePosition(null);
          dashboardState.clearManagement();
          dashboardState.clearMlManagement();
          lastMgmtMetrics = null;
          dashboardState.recordTrade(tradeRecord);
          dashboardState.updatePerformance(perfTracker.getStats());
          dashboardState.updateRisk(riskManager.getState());
          lobClient.endTradeContext(exitPos.trade_id).catch(() => {});
          phaseManager.transitionTo('EXITING', `v2_hard_risk:${exitDecision.reason}`);
          phaseManager.startCooldown(effectiveConfig.cooldown_bars ?? 0, tradeRecord.side);
          sharedState.exitInFlight = false;
          recentEventLog.push(`trade_closed:${exitPos.trade_id}:${exitReason}:${tradeRecord.outcome_class}`);
          console.log(`[DASH] position cleared trade_id=${exitPos.trade_id}`);
        }, { isExit: true, skipIfExitInFlight: true });
        dashboardState.flush();
      }
    };

    // ── Management Lane (2000ms) ──────────────────────────────────────────
    const onManagement = async (_cycle: number): Promise<void> => {
      if (!positionManager.hasOpenPosition()) return;
      const pos = positionManager.getPosition();
      if (!pos) return;

      const price = sharedState.lastPrice;
      if (price === null) return; // no quote yet

      // Freshness gate for price-sensitive decisions
      const quoteAge = Date.now() - sharedState.lastQuoteAt;
      const staleThreshold = laneTiming.management_stale_threshold_ms ?? 3000;

      // Management metrics (always compute, even with stale quotes)
      const sessionCtx = classifySession();
      const mgmtFeatures = buildManagementFeatures(
        pos, price,
        sharedState.lastLiteSnap?.indicators_1m ?? lastSnap?.indicators_1m ?? null,
        sharedState.lastRegime as MarketRegime,
        sessionCtx.strategy_bucket ?? null,
      );
      const mgmtMetrics = managementEngine.evaluate(mgmtFeatures);
      lastMgmtMetrics = mgmtMetrics;
      sharedState.lastMgmtMetrics = mgmtMetrics;
      dashboardState.updateManagement(mgmtMetrics);

      // ML inference (runs in BOTH shadow and active modes for observability)
      if (mlConfig.enabled && positionManager.hasOpenPosition()) {
        const mlInterval = laneTiming.ml_management_interval_ms ?? 8000;
        const sinceLastMl = Date.now() - sharedState.lastMlCallAt;

        // Event-driven ML override: force call on state changes
        const mlForceEvents = [
          pos.pt1_done && sinceLastMl > 1000,           // PT1 just triggered
          pos.pre_t1_be_triggered && sinceLastMl > 1000, // BE triggered
        ].some(Boolean);

        if (sinceLastMl >= mlInterval || mlForceEvents) {
          try {
            const mlQuoteAge = quoteAge;
            const mlLobSnap = await lobClient.getSnapshot().catch(() => null);
            const mlResult = await getMlDecision(
              pos, price, mlQuoteAge, mlConfig, mlLobSnap,
              v2LastMlActionTimestamp > 0 ? v2LastMlActionTimestamp : null,
            );
            sharedState.lastMlCallAt = Date.now();
            sharedState.lastMlDecision = mlResult.decision;
            lastMlDecision = mlResult.decision;
            dashboardState.updateMlManagement(mlResult.decision, mlConfig);

            // Log ML action + features (same as v1)
            logWriter.writeMlManagementAction({
              timestamp: new Date().toISOString(),
              trade_id: pos.trade_id,
              action: mlResult.decision.action,
              action_confidence: mlResult.decision.confidence,
              model_name: mlResult.decision.model_name,
              model_version: mlResult.decision.model_version || mlConfig.model_version,
              prob_hold: mlResult.decision.prob_hold,
              ev_hold_r: mlResult.decision.ev_hold_r,
              approved: mlResult.decision.approved,
              rejection_reason: mlResult.decision.rejection_reason,
              inference_ms: mlResult.decision.inference_ms,
              quote_age_ms: mlQuoteAge,
              side: pos.side,
              setup_type: pos.setup_type,
              quantity_remaining: pos.quantity_remaining,
              unrealized_r: positionManager.getUnrealizedR(price),
              tier_used: mlResult.decision.tier_used,
              fallback_used: mlResult.decision.fallback_used,
              fallback_reason: mlResult.decision.fallback_reason,
              notes: mlResult.decision.notes,
            });

            // Log features
            const _featureSchemaHash = createHash('sha256')
              .update(Object.keys(mlResult.features).filter(k => k !== 'trade_id').sort().join(','))
              .digest('hex')
              .slice(0, 8);
            logWriter.writeMlManagementFeatures({
              ...JSON.parse(mlResult.serializedRequestBody),
              _timestamp: new Date().toISOString(),
              _trade_id: pos.trade_id,
              _request_id: mlResult.requestId,
              _service_url: mlConfig.service_url,
              _request_latency_ms: mlResult.requestLatencyMs,
              _feature_count: Object.keys(mlResult.features).length - 1,
              _log_schema_version: ML_FEATURE_SCHEMA_VERSION,
              _feature_schema_hash: _featureSchemaHash,
              _lob_available: mlResult.features.lob_spread_ticks !== null,
              _adv_mbo_available: mlResult.features.adv_cancel_replace_ratio_10s !== null,
              _data_quality_tier: computeDataQualityTier(mlResult.features),
              _bbo_age_ms: mlLobSnap?.bbo_age_ms ?? null,
              _serialized_response_body: mlResult.serializedResponseBody,
              _response_action: mlResult.decision.action,
              _response_confidence: mlResult.decision.confidence,
              _response_approved: mlResult.decision.approved,
              _response_rejection_reason: mlResult.decision.rejection_reason,
              _response_model_name: mlResult.decision.model_name,
              _response_model_version: mlResult.decision.model_version,
              _response_tier_used: mlResult.decision.tier_used,
              _response_fallback_used: mlResult.decision.fallback_used,
              _response_fallback_reason: mlResult.decision.fallback_reason,
            });

            // Execute approved ML actions under lock (ACTIVE mode only — shadow skips execution)
            const mlDec = mlResult.decision;
            if (!shadowOnly && mlDec.approved && mlDec.action !== 'NO_ACTION' && mlDec.action !== 'HOLD') {
              const mlLobSnapForPolicy = mlLobSnap;
              const policyResult = execPolicy.evaluate(
                mlDec.action, pos, mlLobSnapForPolicy, mlQuoteAge,
                mlDec.recommended_size_fraction !== null
                  ? Math.max(1, Math.floor(pos.quantity_remaining * mlDec.recommended_size_fraction))
                  : null,
                mlDec.recommended_stop_price,
              );

              if (policyResult.should_execute) {
                let mlExitedAll = false;
                await executionLock.runExclusive(async () => {
                  const mlPos = positionManager.getPosition();
                  if (!mlPos) return;

                  if (mlDec.action === 'EXIT_ALL') {
                    console.log(`[ML] shouldExit=true trade_id=${mlPos.trade_id} reason=ml_exit_all price=${price}`);
                    logWriter.writeExecutionIntent({
                      event: 'trade_exit_submitted', timestamp: new Date().toISOString(),
                      trade_id: mlPos.trade_id, side: mlPos.side, source: 'ml_exit_all', reason: 'manual',
                      price, quantity: mlPos.quantity_remaining,
                    });
                    console.log(`[EXECUTOR] submitting paper exit trade_id=${mlPos.trade_id}`);

                    const exitResult = await adapter.placeExit(mlPos.side, mlPos.quantity_remaining, price, 'manual');

                    logWriter.writeExecutionIntent({
                      event: 'trade_exit_filled', timestamp: exitResult.fill_time_iso,
                      trade_id: mlPos.trade_id, side: mlPos.side, source: 'ml_exit_all', reason: 'manual',
                      price: exitResult.fill_price, quantity: exitResult.quantity,
                      slippage_pts: exitResult.slippage_pts, fee_usd: exitResult.fee_usd, order_id: exitResult.order_id,
                    });
                    console.log(`[EXECUTOR] paper exit acknowledged trade_id=${mlPos.trade_id} fill=${exitResult.fill_price}`);

                    const tradeRecord = positionManager.closePosition(
                      exitResult, 'manual', sharedState.lastRegime as MarketRegime, sessionId, env.STRATEGY_VERSION, price,
                      {
                        target_1_direction_valid: mlPos.target_1_direction_valid,
                        target_2_direction_valid: mlPos.target_2_direction_valid,
                        target_3_direction_valid: mlPos.target_3_direction_valid,
                        target_ordering_valid: mlPos.target_ordering_valid,
                        target_repair_applied: mlPos.target_repair_applied,
                      },
                    );

                    logWriter.writeExecutionIntent({
                      event: 'trade_closed', timestamp: new Date().toISOString(),
                      trade_id: mlPos.trade_id, side: mlPos.side, source: 'ml_exit_all', reason: 'manual',
                      price: exitResult.fill_price, pnl_realized: tradeRecord.pnl_realized,
                      r_multiple: tradeRecord.r_multiple, outcome_class: tradeRecord.outcome_class,
                    });
                    console.log(`[POSITION] closed trade_id=${mlPos.trade_id} pnl=$${tradeRecord.pnl_realized.toFixed(2)}`);

                    logWriter.writeTrade(tradeRecord);
                    tradeJournal.append('final_close', tradeRecord.trade_id, 'runner', tradeRecord.exit_reason, null);
                    riskManager.recordTradeClose(tradeRecord.pnl_realized, tradeRecord.outcome_class);
                    perfTracker.recordTrade(tradeRecord);
                    dashboardState.updatePosition(null);
                    dashboardState.clearManagement();
                    dashboardState.clearMlManagement();
                    lastMgmtMetrics = null;
                    dashboardState.recordTrade(tradeRecord);
                    dashboardState.updatePerformance(perfTracker.getStats());
                    dashboardState.updateRisk(riskManager.getState());
                    lobClient.endTradeContext(mlPos.trade_id).catch(() => {});
                    phaseManager.transitionTo('EXITING', `ml_exit_all:${mlPos.trade_id}`);
                    phaseManager.startCooldown(effectiveConfig.cooldown_bars ?? 0, tradeRecord.side);
                    recentEventLog.push(`trade_closed:${mlPos.trade_id}:ml_exit_all:${tradeRecord.outcome_class}`);
                    console.log(`[DASH] position cleared trade_id=${mlPos.trade_id}`);
                    mlExitedAll = true;
                  } else if (mlDec.action === 'MOVE_TO_BREAKEVEN') {
                    positionManager.moveStopToBreakeven();
                  } else if (mlDec.action === 'MOVE_STOP' && mlDec.recommended_stop_price !== null) {
                    positionManager.moveStopTo(mlDec.recommended_stop_price);
                  } else if (mlDec.action === 'EXIT_PARTIAL' && mlConfig.enable_partial_exit) {
                    const frac = mlDec.recommended_size_fraction;
                    if (frac !== null && frac > 0 && frac < 1) {
                      const qtyToExit = Math.max(1, Math.floor(mlPos.quantity_remaining * frac));
                      if (qtyToExit > 0 && qtyToExit < mlPos.quantity_remaining) {
                        const partialResult = await adapter.placeExit(mlPos.side, qtyToExit, price, 'manual');
                        positionManager.applyPartialExit(qtyToExit, partialResult.fill_price, partialResult.fill_time_iso, partialResult.fee_usd, partialResult.slippage_pts, effectiveConfig);
                      }
                    }
                  }

                  // Record execution timestamp for cooldown
                  v2LastMlActionTimestamp = Date.now();
                  sharedState.lastMlActionTimestamp = v2LastMlActionTimestamp;
                  execPolicy.recordExecution(mlDec.action);
                }, { isExit: mlDec.action === 'EXIT_ALL', skipIfExitInFlight: mlDec.action === 'EXIT_ALL' });
                if (mlExitedAll) dashboardState.flush();
              }
            }
          } catch (err) {
            if (_cycle % 30 === 0) {
              console.warn(`[ML] Decision error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }

      // Shadow guard: v1 onMonitor() owns exit evaluation and position mutation
      if (shadowOnly) {
        logWriter.writeMlManagementAction({
          _type: 'v2_shadow_management',
          timestamp: new Date().toISOString(),
          trade_id: pos.trade_id,
          exit_eval_skipped: true,     // deliberately skipped — not "evaluated and no exit"
          management_state: mgmtMetrics.management_state,
          quote_age_ms: quoteAge,
          price,
        });
        writeTradePathPoint(pos, price, 'shadow_management');
        dashboardState.flush();
        return;
      }

      // ACTIVE mode: full position evaluation under lock
      if (quoteAge <= staleThreshold) {
        const exit = await executionLock.runExclusive(async () => {
          return positionManager.evaluate(price, effectiveConfig);
        }, { skipIfExitInFlight: true });

        if (exit && exit.shouldExit && exit.reason) {
          await handleManagementExit(exit, pos, price);
        }
      }

      // Trade-path point logging
      writeTradePathPoint(pos, price);

      // Heartbeat log (every ~5 ticks = ~10s)
      if (_cycle % 5 === 0) {
        const unrealR = positionManager.getUnrealizedR(price);
        const trailTag = pos.trailing_active ? 'active' : 'off';
        const mlTag = lastMlDecision ? `${lastMlDecision.action}(${lastMlDecision.confidence?.toFixed(2) ?? '?'})` : 'n/a';
        const holdSec = Math.round((Date.now() - pos.entry_time_unix) / 1000);
        console.log(
          `[HB] MANAGING | ${sharedState.lastQuoteResult?.source ?? 'cached'} ${price} age=${quoteAge}ms ` +
          `| ${unrealR >= 0 ? '+' : ''}${unrealR.toFixed(2)}R MFE=${pos.max_favorable_excursion.toFixed(2)}R ` +
          `| stop=${pos.stop_current} trail=${trailTag} | ML=${mlTag} | ${holdSec}s`,
        );
      }

      dashboardState.updatePosition(positionManager.getPosition());
      dashboardState.updateRisk(riskManager.getState());
      dashboardState.flush();
    };

    // ── Context Refresh Lane (5000ms) ─────────────────────────────────────
    const onContextRefresh = async (_cycle: number): Promise<void> => {
      if (!positionManager.hasOpenPosition()) return;

      try {
        // ── Key-levels recompute: run full collect() instead of lite ──
        // Throttle: at most once per 60s to prevent repeated full-collect loops
        const keyLevelRecomputeMinIntervalMs = 60_000;
        if (sharedState.needsKeyLevelRecompute
            && (Date.now() - sharedState.lastKeyLevelRecomputeAt >= keyLevelRecomputeMinIntervalMs)) {
          sharedState.lastKeyLevelRecomputeAt = Date.now();
          try {
            const fullSnap = await dataCollector.collect(instrumentSymbol);
            lastSnap = fullSnap;
            sharedState.lastLiteSnap = {
              timestamp_unix: fullSnap.timestamp_unix,
              timestamp_iso: fullSnap.timestamp_iso,
              price: fullSnap.price,
              bars_1m: fullSnap.bars_1m,
              indicators_1m: fullSnap.indicators_1m,
              session: classifySession(),
              key_levels: fullSnap.key_levels,
              key_levels_age_ms: 0,
            };
            sharedState.lastLiteSnapAt = Date.now();
            sharedState.needsKeyLevelRecompute = false;
            sharedState.keyLevelsStaleLogged = false;
            console.log(`[CTX-REFRESH] Key levels recomputed via full collect`);
          } catch (err) {
            console.warn(`[CTX-REFRESH] Full recompute failed, will retry in ${keyLevelRecomputeMinIntervalMs / 1000}s: ${err instanceof Error ? err.message : String(err)}`);
          }
          return; // Full collect replaces lite for this tick
        }

        const liteSnap = await dataCollector.collectLite1m();
        sharedState.lastLiteSnap = liteSnap;
        sharedState.lastLiteSnapAt = Date.now();

        // Sync fresh indicators to dashboard for buildMarketState()
        dashboardState.updateLiteIndicators({
          ema_9: liteSnap.indicators_1m.ema_9,
          ema_21: liteSnap.indicators_1m.ema_21,
          ema_50: liteSnap.indicators_1m.ema_50,
          vwap: liteSnap.indicators_1m.vwap,
          atr_14: liteSnap.indicators_1m.atr_14,
          supertrend_direction: liteSnap.indicators_1m.supertrend_direction,
        }, liteSnap.price);

        // Recompute regime from fresh indicators
        const indicators = liteSnap.indicators_1m;
        if (indicators.ema_9 !== null && indicators.ema_21 !== null && indicators.ema_50 !== null) {
          // Simple regime from EMA stack (matches strategy.ts logic)
          if (indicators.ema_9 > indicators.ema_21 && indicators.ema_21 > indicators.ema_50) {
            sharedState.lastRegime = 'trending_up';
          } else if (indicators.ema_9 < indicators.ema_21 && indicators.ema_21 < indicators.ema_50) {
            sharedState.lastRegime = 'trending_down';
          } else {
            sharedState.lastRegime = lastRegime; // keep last known
          }
        }

        sharedState.lastSessionCtx = liteSnap.session;

        // Sync legacy variable so v1 paths and analysis lane stay aligned
        lastRegime = sharedState.lastRegime as MarketRegime;

        // Sync regime and session to dashboard for live market-state display
        dashboardState.updateRegime(sharedState.lastRegime as MarketRegime);
        if (liteSnap.session) {
          const sess = liteSnap.session;
          dashboardState.updateSessionInfo({
            bucket: sess.legacy_bucket,
            exchange_state: sess.exchange_state,
            strategy_bucket: sess.strategy_bucket,
            market_open: sess.is_rth,
            or_complete: liteSnap.key_levels.opening_range_high !== null,
            or_high: liteSnap.key_levels.opening_range_high,
            or_low: liteSnap.key_levels.opening_range_low,
            or_mid: liteSnap.key_levels.opening_range_mid,
            or_width: liteSnap.key_levels.opening_range_high !== null && liteSnap.key_levels.opening_range_low !== null
              ? Math.round((liteSnap.key_levels.opening_range_high - liteSnap.key_levels.opening_range_low) * 100) / 100 : null,
          });
        }

        // Check if key_levels need refresh — set flag once, log once
        if (liteSnap.key_levels_age_ms > 120_000 || liteSnap.key_levels_age_ms < 0) {
          if (!sharedState.needsKeyLevelRecompute) {
            sharedState.needsKeyLevelRecompute = true;
            console.log(`[CTX-REFRESH] Key levels stale (${liteSnap.key_levels_age_ms}ms) — will recompute on next tick`);
            sharedState.keyLevelsStaleLogged = true;
          }
        }

        // Lane metrics heartbeat: every 3rd cycle (~15s at 5s interval)
        if (laneSchedulerRef && _cycle % 3 === 0 && _cycle > 0) {
          logWriter.writeLaneMetrics({
            timestamp: new Date().toISOString(),
            session_id: sessionId,
            metrics: laneSchedulerRef.getMetrics(),
          });
        }
      } catch (err) {
        console.warn(`[CTX-REFRESH] Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // Helper: write trade-path point (shared by management and shadow modes)
    const writeTradePathPoint = (
      pos: NonNullable<ReturnType<typeof positionManager.getPosition>>,
      price: number,
      sourceLane: string = 'management',
    ): void => {
      const pnlPts = pos.side === 'short' ? pos.entry_price - price : price - pos.entry_price;
      const pnlUsd = pnlPts * pos.quantity_remaining * contract.point_value;
      const riskPts = Math.abs(pos.entry_price - pos.stop_initial);
      logWriter.writeTradePathPoint({
        // ── Row schema ─────────────────────────────────────────────────────
        row_type: 'trade_path_point',
        schema_version: 2,
        owner: 'v2',
        source_lane: sourceLane,
        // ── Core fields ────────────────────────────────────────────────────
        timestamp: new Date().toISOString(),
        trade_id: pos.trade_id,
        session_id: sessionId,
        side: pos.side,
        entry_price: pos.entry_price,
        current_price: price,
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
        initial_risk_pts: riskPts,
        setup_type: pos.setup_type,
        regime: sharedState.lastRegime as MarketRegime,
        pop_t1_advisory: lastMgmtMetrics?.pop.pop_target1_before_stop ?? null,
        pop_t2_advisory: lastMgmtMetrics?.pop.pop_target2_before_stop ?? null,
        pop_model: lastMgmtMetrics?.pop.model_name ?? null,
        management_profile: pos.management_params?.profile_name ?? null,
        pt1_done: pos.pt1_done,
        pt2_done: pos.pt2_done,
        pre_t1_be_triggered: pos.pre_t1_be_triggered,
        pre_t1_trailing_active: pos.pre_t1_trailing_active,
        trail_distance_ticks: pos.trail_distance_ticks,
        atr_at_entry: pos.atr_at_entry,
        // ── Position progression (Phase 10) ────────────────────────────────
        stop_initial: pos.stop_initial,
        trail_anchor_price: pos.trail_anchor_price,
        pt1_realized_pnl: pos.pt1_realized_pnl,
        pt2_realized_pnl: pos.pt2_realized_pnl,
        pt1_qty_exited: pos.pt1_qty_exited,
        pt2_qty_exited: pos.pt2_qty_exited,
        mfe_at_pt1_trigger: pos.mfe_at_pt1_trigger,
        mae_at_pt1_trigger: pos.mae_at_pt1_trigger,
        peak_r_before_first_partial: pos.peak_r_before_first_partial,
        management_state: lastMgmtMetrics?.management_state ?? null,
        // ── ML advisory state ──────────────────────────────────────────────
        ml_action: lastMlDecision?.action ?? null,
        ml_confidence: lastMlDecision?.confidence ?? null,
        ml_prob_hold: lastMlDecision?.prob_hold ?? null,
        ml_ev_hold_r: lastMlDecision?.ev_hold_r ?? null,
        ml_approved: lastMlDecision?.approved ?? null,
        ml_model: lastMlDecision?.model_name ?? null,
        ml_inference_ms: lastMlDecision?.inference_ms ?? null,
      });
    };

    // Helper: handle management lane exit
    const handleManagementExit = async (
      exit: ReturnType<typeof positionManager.evaluate>,
      pos: NonNullable<ReturnType<typeof positionManager.getPosition>>,
      price: number,
    ): Promise<void> => {
      if (!exit.shouldExit || !exit.reason) return;
      const exitReason = exit.reason; // narrow to non-null for closure safety

      if (exit.isPartial) {
        await executionLock.runExclusive(async () => {
          const partialResult = await adapter.placeExit(pos.side, exit.partialQuantity, exit.exitPrice, exitReason);
          const slippagePts = Math.abs(exit.exitPrice - exit.plannedExitPrice);
          if (exitReason === 'partial_profit_1') {
            positionManager.applyPt1Exit(exit.partialQuantity, exit.exitPrice, partialResult.fill_time_iso, partialResult.fee_usd, slippagePts, effectiveConfig);
          } else if (exitReason === 'partial_profit_2') {
            positionManager.applyPt2Exit(exit.partialQuantity, exit.exitPrice, partialResult.fill_time_iso, partialResult.fee_usd, slippagePts, effectiveConfig);
          } else {
            positionManager.applyPartialExit(exit.partialQuantity, exit.exitPrice, partialResult.fill_time_iso, partialResult.fee_usd, slippagePts, effectiveConfig);
          }
        }, { isPartial: true, skipIfExitInFlight: true });
      } else {
        console.log(`[MGMT] shouldExit=true trade_id=${pos.trade_id} reason=${exitReason} price=${price}`);
        await executionLock.runExclusive(async () => {
          const exitPos = positionManager.getPosition();
          if (!exitPos) return;

          logWriter.writeExecutionIntent({
            event: 'trade_exit_submitted', timestamp: new Date().toISOString(),
            trade_id: exitPos.trade_id, side: exitPos.side, source: 'management', reason: exitReason,
            price: exit.exitPrice, quantity: exitPos.quantity_remaining,
          });
          console.log(`[EXECUTOR] submitting paper exit trade_id=${exitPos.trade_id}`);

          const exitResult = await adapter.placeExit(exitPos.side, exitPos.quantity_remaining, exit.exitPrice, exitReason);

          logWriter.writeExecutionIntent({
            event: 'trade_exit_filled', timestamp: exitResult.fill_time_iso,
            trade_id: exitPos.trade_id, side: exitPos.side, source: 'management', reason: exitReason,
            price: exitResult.fill_price, quantity: exitResult.quantity,
            slippage_pts: exitResult.slippage_pts, fee_usd: exitResult.fee_usd, order_id: exitResult.order_id,
          });
          console.log(`[EXECUTOR] paper exit acknowledged trade_id=${exitPos.trade_id} fill=${exitResult.fill_price}`);

          const tradeRecord = positionManager.closePosition(
            exitResult, exitReason, sharedState.lastRegime as MarketRegime, sessionId, env.STRATEGY_VERSION, exit.plannedExitPrice,
            {
              target_1_direction_valid: exitPos.target_1_direction_valid,
              target_2_direction_valid: exitPos.target_2_direction_valid,
              target_3_direction_valid: exitPos.target_3_direction_valid,
              target_ordering_valid: exitPos.target_ordering_valid,
              target_repair_applied: exitPos.target_repair_applied,
            },
          );

          logWriter.writeExecutionIntent({
            event: 'trade_closed', timestamp: new Date().toISOString(),
            trade_id: exitPos.trade_id, side: exitPos.side, source: 'management', reason: exitReason,
            price: exitResult.fill_price, pnl_realized: tradeRecord.pnl_realized,
            r_multiple: tradeRecord.r_multiple, outcome_class: tradeRecord.outcome_class,
          });
          console.log(`[POSITION] closed trade_id=${exitPos.trade_id} pnl=$${tradeRecord.pnl_realized.toFixed(2)}`);

          logWriter.writeTrade(tradeRecord);
          tradeJournal.append('final_close', tradeRecord.trade_id, 'runner', tradeRecord.exit_reason, null);
          riskManager.recordTradeClose(tradeRecord.pnl_realized, tradeRecord.outcome_class);
          perfTracker.recordTrade(tradeRecord);
          dashboardState.updatePosition(null);
          dashboardState.clearManagement();
          dashboardState.clearMlManagement();
          lastMgmtMetrics = null;
          dashboardState.recordTrade(tradeRecord);
          dashboardState.updatePerformance(perfTracker.getStats());
          dashboardState.updateRisk(riskManager.getState());
          lobClient.endTradeContext(exitPos.trade_id).catch(() => {});
          phaseManager.transitionTo('EXITING', `v2_mgmt:${exit.reason}`);
          phaseManager.startCooldown(effectiveConfig.cooldown_bars ?? 0, tradeRecord.side);
          recentEventLog.push(`trade_closed:${exitPos.trade_id}:${exitReason}:${tradeRecord.outcome_class}`);
          console.log(`[DASH] position cleared trade_id=${exitPos.trade_id}`);
        }, { isExit: true, skipIfExitInFlight: true });
        dashboardState.flush();
      }
    };

    // ── Phase-aware interval override ─────────────────────────────────────
    const getPhaseInterval = (lane: string): number | null => {
      const sess = classifySession();
      const minsSinceOpen = sess.minutes_since_rth_open ?? -1;

      if (lane === 'analysis') {
        // Opening drive: first 15 min RTH
        if (sess.is_rth && minsSinceOpen >= 0 && minsSinceOpen <= 15) {
          return laneTiming.opening_drive_analysis_interval_ms ?? 3000;
        }
        // Midday: 11:30-13:00 ET (120-210 min since 9:30)
        if (sess.is_rth && minsSinceOpen >= 120 && minsSinceOpen <= 210) {
          return laneTiming.midday_analysis_interval_ms ?? 8000;
        }
      }
      return null;
    };

    // ── Build lane configs ────────────────────────────────────────────────
    const lanes: LaneConfig[] = [
      {
        name: 'hardRisk',
        intervalMs: laneTiming.hard_risk_interval_ms ?? 500,
        callback: onHardRisk,
        activeWhen: 'in_position',
        priority: 10,
        independentBusy: true,
        overrunThresholdMs: 500,
      },
      {
        name: 'management',
        intervalMs: laneTiming.management_interval_ms ?? 2000,
        callback: onManagement,
        activeWhen: 'in_position',
        priority: 20,
        independentBusy: false,
        overrunThresholdMs: 2000,
      },
      {
        name: 'contextRefresh',
        intervalMs: laneTiming.context_refresh_interval_ms ?? 5000,
        callback: onContextRefresh,
        activeWhen: 'in_position',
        priority: 30,
        independentBusy: false,
        overduePriorityBoostAfter: laneTiming.context_refresh_starvation_boost_after ?? 3,
        overrunThresholdMs: 1000,
      },
      {
        name: 'analysis',
        intervalMs: effectiveConfig.analysis_interval_seconds * 1000,
        callback: onAnalysis,
        activeWhen: 'flat',
        priority: 40,
        independentBusy: false,
        overrunThresholdMs: 10000,
      },
      {
        name: 'shadow',
        intervalMs: laneTiming.shadow_interval_ms ?? 15000,
        callback: async (cycle) => {
          // Shadow signal requires full MarketSnapshot (5m/15m/1h data).
          // lastSnap is from the analysis lane and is stale when in-position,
          // but shadow is advisory-only — tolerate up to 5min staleness.
          const shadowStaleMs = laneTiming.shadow_snap_stale_ms ?? 300_000;
          if (lastSnap && (Date.now() - lastSnap.timestamp_unix < shadowStaleMs)) {
            await runShadowSignal(lastSnap, cycle);
          }
        },
        activeWhen: 'in_position',
        priority: 50,
        independentBusy: false,
        overrunThresholdMs: 5000,
      },
    ];

    const laneScheduler = new LaneScheduler({
      baseTickMs: 250,
      isInPosition: () => positionManager.hasOpenPosition(),
      getPhaseInterval,
      lanes,
    });
    laneSchedulerRef = laneScheduler;

    await laneScheduler.run();
  } else {
    // ─── V1 Legacy Scheduler ──────────────────────────────────────────────
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
  }

  // ── Ordered shutdown (explicit drains, not sleep-based) ─────────────────
  const SHUTDOWN_TIMEOUT_MS = 10_000;
  let shutdownPromise: Promise<void> | null = null;

  async function gracefulShutdown(reason: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = doShutdown(reason);
    return shutdownPromise;
  }

  async function doShutdown(reason: string): Promise<void> {
    const forceExit = setTimeout(() => {
      console.error('[SHUTDOWN] Timed out after 10s, forcing exit.');
      runtimeState.releaseLock();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      console.log('\n[RUNNER] Shutting down...');
      engineShuttingDown = true;                                        // 1. block new entries
      // (scheduler already stopped by its own SIGINT handler)          // 2. scheduler stopped
      await sleep(250);                                                 // 3. cushion
      logWriter.flushAll();                                             // 4. flush logs
      runtimeState.writeOpenTradeState(positionManager.getPosition());  // 5. persist state
      const finalStats = perfTracker.getStats();
      logWriter.updateSessionEnd(sessionId, {                           // 6. session end record
        timestamp_end: new Date().toISOString(),
        total_signals: totalSignals,
        total_trades: finalStats.total_trades,
        wins: finalStats.wins,
        losses: finalStats.losses,
        scratches: finalStats.scratches,
        total_pnl_usd: finalStats.total_pnl_usd,
        daily_loss_pct: riskManager.getState().daily_loss_pct,
        shutdown_reason: reason,
      });
      dashboardState.setEngineRunning(false);                           // 7. dashboard state
      dashboardServer.stop();                                           // 8. HTTP server
      runtimeState.markCleanShutdown(reason);                           // 9. stops heartbeat, writes state
      perfTracker.printSelfReview();
      logWriter.destroy();                                              // 10. final flush
    } catch (err) {
      console.error('[SHUTDOWN] Error during teardown:', err);
    } finally {
      clearTimeout(forceExit);
      runtimeState.releaseLock();                                       // 11. ALWAYS last
    }
    console.log('[RUNNER] ✅ Session ended cleanly.');
  }

  // Register gracefulShutdown on fatal paths (SIGINT/SIGTERM handled by scheduler)
  process.once('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    gracefulShutdown('uncaught_exception').finally(() => process.exit(1));
  });
  process.once('unhandledRejection', (err) => {
    console.error('[FATAL] Unhandled rejection:', err);
    gracefulShutdown('unhandled_rejection').finally(() => process.exit(1));
  });

  // Normal shutdown: scheduler's SIGINT/SIGTERM handler stops the loop,
  // then control falls through to gracefulShutdown here.
  await gracefulShutdown('user_stopped');
}

/** Classify the data quality tier based on feature availability. */
function computeDataQualityTier(features: MlFeatureVector): string {
  const lobAvailable = features.lob_spread_ticks !== null;
  const advMboAvailable = features.adv_cancel_replace_ratio_10s !== null;
  if (lobAvailable && advMboAvailable) return 'tier3_full';
  if (lobAvailable) return 'tier1_lob';
  return 'tier0_position_only';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('\n[FATAL] Unrecoverable startup error:', err);
  process.exit(1);
});
