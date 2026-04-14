/**
 * DashboardStateManager — singleton that collects canonical app state
 * and builds a coherent DashboardSnapshot for the frontend.
 *
 * The runner pushes state updates into this manager. The dashboard server
 * reads the snapshot and broadcasts SSE events to connected clients.
 *
 * Design:
 * - Never parses log strings
 * - Uses existing typed state objects directly
 * - Emits change events for SSE broadcasting
 * - Thread-safe for single-threaded Node.js (no races)
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { Position, MarketSnapshot, DualDirectionResult, MarketRegime, TradeRecord, PerformanceStats } from '../types.js';
import type { ContractSpec } from '../contracts.js';
import { getEtParts } from '../session.js';
import type { DashboardDeltaEvent, DashboardDeltaBatch } from '../../shared/dashboard-contract.js';
import type {
  DashboardSnapshot,
  DashboardAppMeta,
  DashboardKpis,
  DashboardActiveTrade,
  DashboardMarketState,
  DashboardDirectionalAssessment,
  DashboardManagement,
  DashboardRecentTrade,
  DashboardHtfContext,
  DashboardHtfZone,
  DashboardHtfSetupEval,
  PnlPoint,
  FreshnessMetadata,
} from './types.js';
import { DASHBOARD_VERSION } from './types.js';
import type { ManagementMetrics } from '../management/types.js';
import type { SessionInfo } from '../types.js';

// ─── Input state containers ──────────────────────────────────────────────────

interface AppMetaInput {
  symbol: string;
  mode: 'live' | 'paper' | 'signal_only';
  session_id: string;
}

interface RiskStateInput {
  daily_pnl_usd: number;
  daily_loss_pct: number;
  consecutive_losses: number;
  total_trades_today: number;
  is_locked: boolean;
  lock_reason: string | null;
}

// ─── State Manager ───────────────────────────────────────────────────────────

export class DashboardStateManager extends EventEmitter {
  // App metadata
  private appMeta: AppMetaInput | null = null;
  private contract: ContractSpec | null = null;
  private engineRunning = false;
  private cycleCount = 0;
  private connectionStatus: 'connected' | 'disconnected' | 'unknown' = 'unknown';
  private enginePhaseSnap: { phase: string; elapsed_ms: number; reason: string } | null = null;
  private quoteInfo: { source: string; timestamp_unix_ms: number; is_stale: boolean } | null = null;
  private managementMetrics: ManagementMetrics | null = null;

  // Market data
  private lastSnap: MarketSnapshot | null = null;
  private lastRegime: MarketRegime = 'range_bound';
  private sessionInfo: SessionInfo | null = null;
  /** Fresh lite indicators from context-refresh lane (preferred over stale lastSnap in buildMarketState). */
  private liteIndicators: {
    ema_9: number | null;
    ema_21: number | null;
    ema_50: number | null;
    vwap: number | null;
    atr_14: number | null;
    supertrend_direction: string | null;
    price: number;
  } | null = null;

  // Position
  private position: Position | null = null;
  private currentPrice: number | null = null;

  // Directional
  private lastSignal: DualDirectionResult | null = null;

  // Performance
  private perfStats: PerformanceStats | null = null;
  private recentTrades: TradeRecord[] = [];
  private pnlHistory: PnlPoint[] = [];
  private entryCount = 0;

  // Risk
  private riskState: RiskStateInput | null = null;
  private accountEquity = 25_000;
  private maxDailyLossPct = 1.5;


  // ML Management
  private mlDecision: import('../ml/types.js').MlDecision | null = null;
  private mlConfig: import('../ml/types.js').MlManagementConfig | null = null;
  private mlDecisionCount = 0;
  private mlApprovedCount = 0;

  // ── Sequence tracking ───────────────────────────────────────────────────
  /** Increments on every internal state mutation. */
  private mutationSeq = 0;
  /** Increments only on SSE publish commit. getSnapshot() does NOT increment this. */
  private publishSeq = 0;
  private lastMutationIso: string | null = null;
  /** Random UUID generated at startup — clients detect restarts via mismatch. */
  readonly serverInstanceId = randomUUID();

  /** Coalescable events — keyed by type, only latest kept. */
  private coalescable: Map<string, DashboardDeltaEvent> = new Map();
  /** Non-coalescable lifecycle events — all instances preserved, order maintained. */
  private lifecycleEvents: DashboardDeltaEvent[] = [];

  /** Event types that are coalesced (only latest kept per publish cycle). */
  private static readonly COALESCABLE_TYPES = new Set([
    'price_tick', 'management_update', 'position_updated', 'app_update',
  ]);

  // Freshness tracking
  private snapshotVersion = 0;
  private dataGatheredAt: string | null = null;
  private dataGatherDurationMs: number | null = null;
  private confidenceUpdatedAt: string | null = null;
  private analysisIntervalTargetMs = 5_000;
  private lastAnalysisDurationMs = 0;
  private htfCacheHits: string[] = [];

  // ─── Setters (called by runner) ──────────────────────────────────────────

  setAppMeta(meta: AppMetaInput, contract: ContractSpec, equity: number): void {
    this.appMeta = meta;
    this.contract = contract;
    this.accountEquity = equity;
  }

  setMaxDailyLossPct(pct: number): void {
    this.maxDailyLossPct = pct;
  }

  setEngineRunning(running: boolean): void {
    this.engineRunning = running;
    this.emitUpdate();
  }

  setConnectionStatus(status: 'connected' | 'disconnected' | 'unknown'): void {
    this.connectionStatus = status;
    this.emitUpdate();
  }

  updateMarketSnapshot(snap: MarketSnapshot): void {
    this.lastSnap = snap;
    this.currentPrice = snap.price;
    this.liteIndicators = null; // Full snap supersedes lite
    this.recordMutation();
    // No emit here — the runner calls flush() at end of cycle to broadcast
    // all state changes (regime, directional, session, etc.) as one coherent snapshot.
  }

  updateRegime(regime: MarketRegime): void {
    this.lastRegime = regime;
  }

  updateSessionInfo(info: SessionInfo): void {
    this.sessionInfo = info;
  }

  updatePosition(pos: Position | null): void {
    const wasOpen = !!this.position;
    if (pos && !this.position) {
      this.entryCount++;
    }
    this.position = pos;
    this.recordMutation();

    if (pos && !wasOpen) {
      this.queueEvent({ type: 'position_opened', active_trade: this.buildActiveTrade(), kpis: this.buildKpis() });
    } else if (!pos && wasOpen) {
      this.queueEvent({ type: 'position_cleared', active_trade: this.buildActiveTrade(), kpis: this.buildKpis() });
    } else if (pos) {
      // Position update (stop/target/trail change)
      this.queueEvent({ type: 'position_updated', active_trade: this.buildActiveTrade() });
    }
    this.emitUpdate();
  }

  updateCurrentPrice(price: number): void {
    this.currentPrice = price;
    this.recordMutation();
    this.queueEvent({ type: 'price_tick', price });
  }

  /**
   * Update market-state indicators from a lite 1m snapshot (in-position context-refresh).
   * Avoids requiring a full MarketSnapshot — only updates the indicator fields
   * that buildMarketState() actually reads.
   */
  updateLiteIndicators(indicators: {
    ema_9: number | null;
    ema_21: number | null;
    ema_50: number | null;
    vwap: number | null;
    atr_14: number | null;
    supertrend_direction: string | null;
  }, price: number): void {
    this.liteIndicators = { ...indicators, price };
  }

  updateDirectionalSignal(signal: DualDirectionResult): void {
    this.lastSignal = signal;
  }

  updatePerformance(stats: PerformanceStats): void {
    this.perfStats = stats;
  }

  recordTrade(trade: TradeRecord): void {
    this.recentTrades.push(trade);
    // Keep only last 50 trades in memory
    if (this.recentTrades.length > 50) {
      this.recentTrades = this.recentTrades.slice(-50);
    }
    // Update PnL history
    let cumPnl = this.pnlHistory.length > 0
      ? this.pnlHistory[this.pnlHistory.length - 1]!.cumulative_pnl
      : 0;
    cumPnl += trade.pnl_realized;
    this.pnlHistory.push({
      time_iso: trade.timestamp_exit,
      cumulative_pnl: Math.round(cumPnl * 100) / 100,
    });
    this.recordMutation();
    this.queueEvent({
      type: 'recent_trade_added',
      recent_trades: this.buildRecentTrades(),
      pnl_history: this.pnlHistory,
      kpis: this.buildKpis(),
    });
    this.emitUpdate();
  }

  updateRisk(state: RiskStateInput): void {
    this.riskState = state;
  }

  /** Update ML management decision state. */
  updateMlManagement(decision: import('../ml/types.js').MlDecision, config: import('../ml/types.js').MlManagementConfig): void {
    this.mlDecision = decision;
    this.mlConfig = config;
    this.mlDecisionCount++;
    if (decision.approved) this.mlApprovedCount++;
    this.recordMutation();
    this.queueEvent({ type: 'ml_decision', ml_management: this.buildMlManagement() });
  }

  /** Seed ML config without a decision — shows "enabled / awaiting first inference" in dashboard. */
  seedMlConfig(config: import('../ml/types.js').MlManagementConfig): void {
    if (!this.mlConfig) {
      this.mlConfig = config;
    }
  }

  /** Clear ML management state (e.g., when position closes). */
  clearMlManagement(): void {
    this.mlDecision = null;
    this.mlConfig = null; // Reset so next position gets fresh seed
  }

  incrementCycle(): void {
    this.cycleCount++;
  }

  /** Update engine phase snapshot (batched — emitted on next flush). */
  updateEnginePhase(snap: { phase: string; elapsed_ms: number; reason: string }): void {
    this.enginePhaseSnap = snap;
  }

  /** Update last quote info from the in-position monitor (batched — emitted on next flush). */
  updateQuoteInfo(info: { source: string; timestamp_unix_ms: number; is_stale: boolean; age_ms: number }): void {
    this.quoteInfo = info;
  }

  /** Update in-trade management metrics (PoP + EV). Batched via flush(). */
  updateManagement(metrics: ManagementMetrics): void {
    this.managementMetrics = metrics;
    this.recordMutation();
    this.queueEvent({
      type: 'management_update',
      management: this.buildManagement(),
      active_trade: this.buildActiveTrade(),
    });
  }

  /** Clear management metrics when position closes. */
  clearManagement(): void {
    this.managementMetrics = null;
  }

  /** Update freshness metadata from data collection results. */
  updateCollectionTiming(timing: {
    total_ms: number;
    htf_cache_hits: string[];
  }): void {
    this.dataGatheredAt = new Date().toISOString();
    this.dataGatherDurationMs = timing.total_ms;
    this.htfCacheHits = timing.htf_cache_hits;
  }

  /** Update freshness metadata for confidence computation. */
  updateConfidenceTiming(): void {
    this.confidenceUpdatedAt = new Date().toISOString();
  }

  /** Update analysis duration from scheduler metrics. */
  updateAnalysisTiming(durationMs: number, targetMs: number): void {
    this.lastAnalysisDurationMs = durationMs;
    this.analysisIntervalTargetMs = targetMs;
  }



  /**
   * Flush a single SSE broadcast after a batch of state updates.
   * The runner should call this once at the end of each analysis cycle
   * rather than emitting after every individual setter.
   */
  flush(): void {
    // Queue a market/app update if we have pending mutations but no specific typed event
    // covers them (e.g., regime change, analysis cycle completion)
    if (this.lifecycleEvents.length === 0 && this.coalescable.size === 0 && this.mutationSeq > 0) {
      this.queueEvent({
        type: 'app_update',
        app: this.buildAppMeta(),
      });
    }
    this.emitUpdate();
  }

  // ─── Snapshot builder ────────────────────────────────────────────────────

  getSnapshot(): DashboardSnapshot {
    this.snapshotVersion++;
    return {
      version: DASHBOARD_VERSION,
      app: this.buildAppMeta(),
      kpis: this.buildKpis(),
      active_trade: this.buildActiveTrade(),
      management: this.buildManagement(),
      market_state: this.buildMarketState(),
      directional: this.buildDirectional(),
      ml_management: this.buildMlManagement(),
      htf_context: this.buildHtfContext(),
      recent_trades: this.buildRecentTrades(),
      pnl_history: this.pnlHistory,
      freshness: this.buildFreshness(),
    };
  }

  // ─── Section builders ────────────────────────────────────────────────────

  private buildAppMeta(): DashboardAppMeta {
    const sessionBucket = this.sessionInfo?.bucket ?? 'unknown';
    return {
      symbol: this.appMeta?.symbol ?? 'N/A',
      mode: this.appMeta?.mode ?? 'paper',
      session_id: this.appMeta?.session_id ?? '',
      session_bucket: sessionBucket,
      exchange_state: this.sessionInfo?.exchange_state ?? 'CLOSED',
      strategy_bucket: this.sessionInfo?.strategy_bucket ?? 'UNKNOWN',
      last_updated_iso: new Date().toISOString(),
      connection_status: this.connectionStatus,
      engine_running: this.engineRunning,
      cycle_count: this.cycleCount,
      engine_phase: this.enginePhaseSnap?.phase ?? 'FLAT',
      engine_phase_elapsed_ms: this.enginePhaseSnap?.elapsed_ms ?? 0,
      engine_phase_reason: this.enginePhaseSnap?.reason ?? 'init',
      quote_source: this.quoteInfo?.source ?? null,
      quote_age_ms: this.quoteInfo ? (Date.now() - this.quoteInfo.timestamp_unix_ms) : null,
      quote_is_stale: this.quoteInfo?.is_stale ?? false,
      quote_updated_at: this.quoteInfo ? new Date(this.quoteInfo.timestamp_unix_ms).toISOString() : null,
    };
  }

  private buildKpis(): DashboardKpis {
    const stats = this.perfStats;
    const risk = this.riskState;
    const unrealizedPnl = this.calcUnrealizedPnl();
    const realizedPnl = stats?.total_pnl_usd ?? 0;

    // Remaining loss budget
    let remainingBudget: number | null = null;
    if (risk) {
      const maxLossDollar = this.accountEquity * (this.maxDailyLossPct / 100);
      remainingBudget = Math.round((maxLossDollar - Math.abs(Math.min(0, risk.daily_pnl_usd))) * 100) / 100;
    }

    return {
      closed_trades: stats?.total_trades ?? 0,
      entries_today: this.entryCount,
      total_pnl_usd: Math.round((realizedPnl + unrealizedPnl) * 100) / 100,
      realized_pnl_usd: Math.round(realizedPnl * 100) / 100,
      unrealized_pnl_usd: Math.round(unrealizedPnl * 100) / 100,
      win_rate_pct: stats?.win_rate ?? null,
      open_positions: this.position ? 1 : 0,
      remaining_daily_loss_budget: remainingBudget,
      consecutive_losses: risk?.consecutive_losses ?? 0,
      max_drawdown_pct: stats?.max_drawdown_pct ?? 0,
      avg_r: stats?.avg_r ?? null,
      profit_factor: stats?.profit_factor ?? null,
    };
  }

  private buildActiveTrade(): DashboardActiveTrade {
    const pos = this.position;
    if (!pos) {
      return {
        is_open: false,
        trade_id: null,
        side: null,
        setup_type: null,
        entry_price: null,
        stop_loss: null,
        stop_initial: null,
        target_1: null,
        target_2: null,
        target_3: null,
        current_price: null,
        unrealized_pnl_usd: null,
        unrealized_r: null,
        hold_time_seconds: null,
        mfe_pts: null,
        mae_pts: null,
        breakeven_armed: false,
        trailing_armed: false,
        trailing_ticks: null,
        quantity: null,
        quantity_remaining: null,
        management_profile: null,
        setup_family: null,
        atr_at_entry: null,
        pt1_resolved_pts: null,
        pt2_resolved_pts: null,
        trail_resolved_ticks: null,
        q_target: null,
        q_target_delta: null,
        q_target_action_kind: null,
        q_target_action_qty: null,
        q_target_bound_by: null,
        q_target_bound_by_all: null,
        q_risk_component: null,
        q_softcap_component: null,
        q_softcap_confidence_factor: null,
        q_softcap_confidence_raw: null,
        q_softcap_confidence_source: null,
        q_softcap_regime_factor: null,
        q_softcap_session_factor: null,
        q_softcap_drawdown_factor: null,
        q_target_from_stale_cache: null,
        q_target_bracket_sync_blocked: null,
      };
    }

    const price = this.currentPrice ?? pos.last_checked_price;
    const pnlPts = pos.side === 'short'
      ? pos.entry_price - price
      : price - pos.entry_price;
    // Fail fast: the dashboard must never silently fall back to an NQ
    // point_value (=20). If this fires, it means a position exists but the
    // contract was never registered on the state manager — a bug upstream.
    if (!this.contract) {
      throw new Error(
        'state-manager: cannot compute unrealized PnL — contract is not set. ' +
        'Check that setContract() is called before position updates arrive.',
      );
    }
    const pointValue = this.contract.point_value;
    const pnlUsd = pnlPts * pos.quantity_remaining * pointValue;
    const riskPts = Math.abs(pos.entry_price - pos.stop_initial);
    const unrealizedR = riskPts > 0 ? Math.round((pnlPts / riskPts) * 100) / 100 : 0;

    return {
      is_open: true,
      trade_id: pos.trade_id,
      side: pos.side,
      setup_type: pos.setup_type,
      entry_price: pos.entry_price,
      stop_loss: pos.stop_current,
      stop_initial: pos.stop_initial,
      target_1: pos.target_1,
      target_2: pos.target_2,
      target_3: pos.target_3,
      current_price: price,
      unrealized_pnl_usd: Math.round(pnlUsd * 100) / 100,
      unrealized_r: unrealizedR,
      hold_time_seconds: Math.round((Date.now() - pos.entry_time_unix) / 1000),
      mfe_pts: Math.round(pos.max_favorable_excursion * 100) / 100,
      mae_pts: Math.round(pos.max_adverse_excursion * 100) / 100,
      breakeven_armed: pos.stop_moved_to_be,
      trailing_armed: pos.trailing_active,
      trailing_ticks: pos.trailing_active ? pos.trail_distance_ticks : null,
      quantity: pos.quantity,
      quantity_remaining: pos.quantity_remaining,
      management_profile: pos.management_params?.profile_name ?? null,
      setup_family: pos.management_params?.family ?? null,
      atr_at_entry: pos.atr_at_entry ?? null,
      pt1_resolved_pts: pos.management_params?.pt1_offset_pts ?? null,
      pt2_resolved_pts: pos.management_params?.pt2_offset_pts ?? null,
      trail_resolved_ticks: pos.management_params?.trail_ticks_post_t1 ?? null,
      // ── Target-position fields (from last ManagementMetrics snapshot) ──
      q_target: this.managementMetrics?.target_position?.q_target ?? null,
      q_target_delta: this.managementMetrics?.target_position?.delta ?? null,
      q_target_action_kind: this.managementMetrics?.target_position?.action_kind ?? null,
      q_target_action_qty: this.managementMetrics?.target_position?.action_qty ?? null,
      q_target_bound_by: this.managementMetrics?.target_position?.bound_by ?? null,
      q_target_bound_by_all:
        this.managementMetrics?.target_position?.bound_by_all?.slice() ?? null,
      q_risk_component: this.managementMetrics?.target_position?.q_risk ?? null,
      q_softcap_component: this.managementMetrics?.target_position?.q_softcap ?? null,
      q_softcap_confidence_factor:
        this.managementMetrics?.target_position?.confidence_factor ?? null,
      q_softcap_confidence_raw:
        this.managementMetrics?.target_position?.confidence_raw ?? null,
      q_softcap_confidence_source:
        this.managementMetrics?.target_position?.confidence_source ?? null,
      q_softcap_regime_factor:
        this.managementMetrics?.target_position?.regime_factor ?? null,
      q_softcap_session_factor:
        this.managementMetrics?.target_position?.session_factor ?? null,
      q_softcap_drawdown_factor:
        this.managementMetrics?.target_position?.drawdown_factor ?? null,
      q_target_from_stale_cache:
        this.managementMetrics?.target_position?.from_stale_cache ?? null,
      q_target_bracket_sync_blocked:
        this.managementMetrics?.target_position?.bracket_sync_block_active ?? null,
    };
  }

  private buildManagement(): DashboardManagement {
    const m = this.managementMetrics;
    if (!m) {
      return {
        pop_target1_before_stop: null,
        pop_target2_before_stop: null,
        pop_runner_extension: null,
        expected_value_hold_usd: null,
        expected_value_exit_now_usd: null,
        expected_value_reduce_usd: null,
        management_state: null,
        management_state_reason: null,
        decision_factors: [],
        model_name: null,
        model_confidence: null,
        last_evaluated_at: null,
      };
    }
    return {
      pop_target1_before_stop: m.pop.pop_target1_before_stop,
      pop_target2_before_stop: m.pop.pop_target2_before_stop,
      pop_runner_extension: m.pop.pop_runner_extension,
      expected_value_hold_usd: m.expected_value_hold_usd,
      expected_value_exit_now_usd: m.expected_value_exit_now_usd,
      expected_value_reduce_usd: m.expected_value_reduce_usd,
      management_state: m.management_state,
      management_state_reason: m.management_state_reason,
      decision_factors: m.decision_factors,
      model_name: m.pop.model_name,
      model_confidence: m.pop.confidence_in_estimate,
      last_evaluated_at: m.timestamp_iso,
    };
  }

  private buildMarketState(): DashboardMarketState {
    const snap = this.lastSnap;
    // Prefer fresh lite indicators (from context-refresh lane, 5s cadence)
    // over stale full-snap indicators (from analysis lane, frozen during managing)
    const lite = this.liteIndicators;
    const ind = lite ?? snap?.indicators_1m ?? null;
    const refPrice = lite?.price ?? this.currentPrice ?? snap?.price ?? null;

    // Compute EMA stack description
    let emaStack: string | null = null;
    if (ind?.ema_9 != null && ind?.ema_21 != null && ind?.ema_50 != null) {
      if (ind.ema_9 > ind.ema_21 && ind.ema_21 > ind.ema_50) {
        emaStack = 'bullish_ordered';
      } else if (ind.ema_9 < ind.ema_21 && ind.ema_21 < ind.ema_50) {
        emaStack = 'bearish_ordered';
      } else {
        emaStack = 'mixed';
      }
    }

    // VWAP relationship
    let priceVsVwap: string | null = null;
    let vwapDist: number | null = null;
    if (refPrice != null && ind?.vwap != null) {
      vwapDist = Math.round((refPrice - ind.vwap) * 100) / 100;
      priceVsVwap = vwapDist > 0 ? 'above_vwap' : vwapDist < 0 ? 'below_vwap' : 'at_vwap';
    }

    // Bias from last signal
    const bias = this.lastSignal?.bias;

    return {
      regime: this.lastRegime,
      bias_1h: bias?.['1h'] ?? null,
      bias_15m: bias?.['15m'] ?? null,
      bias_5m: bias?.['5m'] ?? null,
      bias_1m: bias?.['1m'] ?? null,
      alignment_score: bias?.alignment_score ?? null,
      ema_stack: emaStack,
      supertrend_bias: ind?.supertrend_direction ?? null,
      price_vs_vwap: priceVsVwap,
      distance_from_vwap_pts: vwapDist,
      atr_1m: ind?.atr_14 != null ? Math.round(ind.atr_14 * 100) / 100 : null,
      current_price: this.currentPrice ?? refPrice,
      session: this.sessionInfo ?? null,
    };
  }

  private buildDirectional(): DashboardDirectionalAssessment {
    const sig = this.lastSignal;
    if (!sig) {
      return {
        best_long: null,
        best_short: null,
        engine_decision: null,
        engine_decision_reason: null,
        confidence: null,
        skip_reasons: [],
        htf_eval_long: null,
        htf_eval_short: null,
      };
    }

    // Map DirectionalCandidate to DirectionalSetupInfo shape
    const mapCandidate = (c: typeof sig.bestLong) => {
      if (!c) return null;
      return {
        setup_type: c.setup?.setup_type ?? null,
        valid: c.passedHardGates,
        score: c.score,
        structural_score: (c.scoreBreakdown.structural_level ?? 0) + (c.scoreBreakdown.swing_structure ?? 0),
        context_score: (c.scoreBreakdown.tf_alignment ?? 0) + (c.scoreBreakdown.htf_direction ?? 0) +
          (c.scoreBreakdown.regime_alignment ?? 0) + (c.scoreBreakdown.vwap_position ?? 0) +
          (c.scoreBreakdown.or_level ?? 0),
        trade_quality_score: (c.scoreBreakdown.rr_quality ?? 0) + (c.scoreBreakdown.supertrend ?? 0) +
          (c.scoreBreakdown.volume ?? 0),
        hard_reject_reasons: c.hardGateFailures,
        entry: c.setup ? (c.setup.entry_low + c.setup.entry_high) / 2 : null,
        stop: c.setup?.stop ?? null,
        t1: c.setup?.target_1 ?? null,
        t2: c.setup?.target_2 ?? null,
        rr: c.setup?.rr_t1 ?? null,
        confluence_factors: c.scoreBreakdown.factors ?? [],
      };
    };

    const mapHtfEval = (c: typeof sig.bestLong): DashboardHtfSetupEval | null => {
      if (!c?.htfEval) return null;
      return {
        first_obstacle_rr: c.htfEval.first_obstacle_rr,
        location_quality: c.htfEval.location_quality,
        score_adjustment: c.htfEval.score_adjustment,
        vetoed: c.htfEval.vetoed,
        veto_reason: c.htfEval.veto_reason,
        breakout_accepted: c.htfEval.breakout_accepted,
      };
    };

    return {
      best_long: mapCandidate(sig.bestLong),
      best_short: mapCandidate(sig.bestShort),
      engine_decision: sig.decision,
      engine_decision_reason: sig.decisionReason,
      confidence: sig.confidence ?? null,
      skip_reasons: sig.skipReasons,
      htf_eval_long: mapHtfEval(sig.bestLong),
      htf_eval_short: mapHtfEval(sig.bestShort),
    };
  }

  private buildHtfContext(): DashboardHtfContext | null {
    const htf = this.lastSnap?.htf_context;
    if (!htf || !htf.study_present) return null;

    const mapZone = (z: import('../types.js').HtfZone): DashboardHtfZone => ({
      timeframe: z.timeframe,
      kind: z.kind,
      level: z.level,
      top: z.top,
      bottom: z.bottom,
      distance_pts: z.distance_pts,
      distance_atr: z.distance_atr,
      contains_price: z.contains_price,
    });

    // Limit to top 3 nearest per kind for dashboard display
    const resZones = htf.resistance_zones.slice(0, 3).map(mapZone);
    const supZones = htf.support_zones.slice(0, 3).map(mapZone);

    return {
      study_present: true,
      resistance_zones: resZones,
      support_zones: supZones,
      nearest_resistance: htf.nearest_resistance ? mapZone(htf.nearest_resistance) : null,
      nearest_support: htf.nearest_support ? mapZone(htf.nearest_support) : null,
      inside_resistance_zone: htf.inside_resistance_zone,
      inside_support_zone: htf.inside_support_zone,
    };
  }

  private buildMlManagement(): import('./types.js').DashboardMlManagement {
    const d = this.mlDecision;
    const c = this.mlConfig;
    if (!c || !c.enabled) {
      return {
        enabled: false,
        model_name: null,
        model_version: null,
        latest_action: null,
        latest_confidence: null,
        latest_approved: null,
        latest_rejection_reason: null,
        prob_hold: null,
        ev_hold_r: null,
        ev_exit_now_r: null,
        inference_ms: null,
        last_evaluated_at: null,
        notes: [],
        decisions_this_session: 0,
        actions_approved_this_session: 0,
      };
    }
    return {
      enabled: true,
      model_name: d?.model_name ?? c.model_type,
      model_version: c.model_version,
      latest_action: d?.action ?? null,
      latest_confidence: d?.confidence ?? null,
      latest_approved: d?.approved ?? null,
      latest_rejection_reason: d?.rejection_reason ?? null,
      prob_hold: d?.prob_hold ?? null,
      ev_hold_r: d?.ev_hold_r ?? null,
      ev_exit_now_r: d?.ev_exit_now_r ?? null,
      inference_ms: d?.inference_ms ?? null,
      last_evaluated_at: d?.evaluated_at_iso ?? null,
      notes: d?.notes ?? [],
      decisions_this_session: this.mlDecisionCount,
      actions_approved_this_session: this.mlApprovedCount,
    };
  }

  private buildRecentTrades(): DashboardRecentTrade[] {
    return this.recentTrades.slice(-20).reverse().map(t => ({
      trade_id: t.trade_id,
      time: t.timestamp_exit,
      side: t.side,
      setup_type: t.setup_type,
      entry: t.entry_price_filled,
      // exit_price_actual may be absent in older trade records; fall back to null
      exit: t.exit_price_actual ?? null,
      pnl_usd: t.pnl_realized,
      r_multiple: t.r_multiple,
      exit_reason: t.exit_reason,
      hold_time_seconds: t.hold_time_seconds,
      outcome: t.outcome_class,
    }));
  }

  private buildFreshness(): FreshnessMetadata {
    return {
      snapshot_built_at: new Date().toISOString(),
      snapshot_version: this.snapshotVersion,
      publish_seq: this.publishSeq,
      mutation_seq: this.mutationSeq,
      last_mutation_iso: this.lastMutationIso,
      server_instance_id: this.serverInstanceId,
      data_gathered_at: this.dataGatheredAt,
      data_gather_duration_ms: this.dataGatherDurationMs,
      confidence_updated_at: this.confidenceUpdatedAt,
      analysis_interval_target_ms: this.analysisIntervalTargetMs,
      last_analysis_duration_ms: this.lastAnalysisDurationMs,
      htf_cache_hits: this.htfCacheHits,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private calcUnrealizedPnl(): number {
    const pos = this.position;
    if (!pos) return 0;
    const price = this.currentPrice ?? pos.last_checked_price;
    const pnlPts = pos.side === 'short'
      ? pos.entry_price - price
      : price - pos.entry_price;
    // Fail fast: see companion check in getPositionSection() above.
    if (!this.contract) {
      throw new Error(
        'state-manager: cannot compute unrealized PnL — contract is not set.',
      );
    }
    const pointValue = this.contract.point_value;
    return pnlPts * pos.quantity_remaining * pointValue;
  }

  private emitUpdate(): void {
    this.emit('update');
  }

  /** Record a mutation and timestamp. Called in every setter that changes state. */
  private recordMutation(): void {
    this.mutationSeq++;
    this.lastMutationIso = new Date().toISOString();
  }

  /** Queue a typed delta event for the next publish cycle. */
  queueEvent(event: DashboardDeltaEvent): void {
    if (DashboardStateManager.COALESCABLE_TYPES.has(event.type)) {
      // Coalescable: keep only the latest (overwrites previous of same type)
      this.coalescable.set(event.type, event);
    } else {
      // Lifecycle: preserve all instances in insertion order
      this.lifecycleEvents.push(event);
    }
  }

  /**
   * Atomically drain pending events into a single batch with one unique publishSeq.
   * Returns null if nothing to publish. Node.js single-threaded —
   * no await between snapshot-of-events and clear ensures atomicity.
   *
   * Ordering: lifecycle events first (in original order), then coalesced events.
   */
  publishEvents(): { batch: DashboardDeltaBatch; publishSeq: number } | null {
    if (this.lifecycleEvents.length === 0 && this.coalescable.size === 0) return null;
    this.publishSeq++;
    const seq = this.publishSeq;
    // Lifecycle events in original order, then coalesced (latest-only) events
    const events: DashboardDeltaEvent[] = [
      ...this.lifecycleEvents,
      ...this.coalescable.values(),
    ];
    this.lifecycleEvents = [];
    this.coalescable.clear();
    return { batch: { publish_seq: seq, events }, publishSeq: seq };
  }

  /** Get current publish sequence (for snapshot responses). */
  getPublishSeq(): number { return this.publishSeq; }
  /** Get current mutation sequence. */
  getMutationSeq(): number { return this.mutationSeq; }
  /** Get server instance ID. */
  getServerInstanceId(): string { return this.serverInstanceId; }

  /** Load trades from disk on startup for recent trades / pnl history. */
  loadTradesFromDisk(trades: TradeRecord[]): void {
    this.recentTrades = trades.slice(-50);
    let cumPnl = 0;
    this.pnlHistory = trades.map(t => {
      cumPnl += t.pnl_realized;
      return {
        time_iso: t.timestamp_exit,
        cumulative_pnl: Math.round(cumPnl * 100) / 100,
      };
    });

    // Hydrate entry count for today (ET-based trading day)
    const todayEt = getEtParts(new Date());
    const todayKey = `${todayEt.year}-${todayEt.month}-${todayEt.day}`;
    this.entryCount = trades.filter(t => {
      const entryEt = getEtParts(new Date(t.timestamp_entry));
      return `${entryEt.year}-${entryEt.month}-${entryEt.day}` === todayKey;
    }).length;
  }
}
