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
import type { Position, MarketSnapshot, DualDirectionResult, MarketRegime, TradeRecord, PerformanceStats } from '../types.js';
import type { ContractSpec } from '../contracts.js';
import type {
  DashboardSnapshot,
  DashboardAppMeta,
  DashboardKpis,
  DashboardActiveTrade,
  DashboardMarketState,
  DashboardDirectionalAssessment,
  DashboardManagement,
  DashboardRecentTrade,
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

  // Position
  private position: Position | null = null;
  private currentPrice: number | null = null;

  // Directional
  private lastSignal: DualDirectionResult | null = null;

  // Performance
  private perfStats: PerformanceStats | null = null;
  private recentTrades: TradeRecord[] = [];
  private pnlHistory: PnlPoint[] = [];

  // Risk
  private riskState: RiskStateInput | null = null;
  private accountEquity = 25_000;


  // ML Management
  private mlDecision: import('../ml/types.js').MlDecision | null = null;
  private mlConfig: import('../ml/types.js').MlManagementConfig | null = null;
  private mlDecisionCount = 0;
  private mlApprovedCount = 0;

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
    this.position = pos;
    this.emitUpdate();
  }

  updateCurrentPrice(price: number): void {
    this.currentPrice = price;
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
  }

  /** Clear ML management state (e.g., when position closes). */
  clearMlManagement(): void {
    this.mlDecision = null;
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
      const maxLossDollar = this.accountEquity * 0.015; // from config
      remainingBudget = Math.round((maxLossDollar - Math.abs(Math.min(0, risk.daily_pnl_usd))) * 100) / 100;
    }

    return {
      trades_today: stats?.total_trades ?? 0,
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
      };
    }

    const price = this.currentPrice ?? pos.last_checked_price;
    const pnlPts = pos.side === 'short'
      ? pos.entry_price - price
      : price - pos.entry_price;
    const pointValue = this.contract?.point_value ?? 20;
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
    const ind1m = snap?.indicators_1m;

    // Compute EMA stack description
    let emaStack: string | null = null;
    if (ind1m?.ema_9 != null && ind1m?.ema_21 != null && ind1m?.ema_50 != null) {
      if (ind1m.ema_9 > ind1m.ema_21 && ind1m.ema_21 > ind1m.ema_50) {
        emaStack = 'bullish_ordered';
      } else if (ind1m.ema_9 < ind1m.ema_21 && ind1m.ema_21 < ind1m.ema_50) {
        emaStack = 'bearish_ordered';
      } else {
        emaStack = 'mixed';
      }
    }

    // VWAP relationship
    let priceVsVwap: string | null = null;
    let vwapDist: number | null = null;
    if (snap && ind1m?.vwap != null) {
      vwapDist = Math.round((snap.price - ind1m.vwap) * 100) / 100;
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
      supertrend_bias: ind1m?.supertrend_direction ?? null,
      price_vs_vwap: priceVsVwap,
      distance_from_vwap_pts: vwapDist,
      atr_1m: ind1m?.atr_14 != null ? Math.round(ind1m.atr_14 * 100) / 100 : null,
      current_price: this.currentPrice ?? snap?.price ?? null,
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

    return {
      best_long: mapCandidate(sig.bestLong),
      best_short: mapCandidate(sig.bestShort),
      engine_decision: sig.decision,
      engine_decision_reason: sig.decisionReason,
      confidence: sig.confidence ?? null,
      skip_reasons: sig.skipReasons,
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
      ev_exit_now_r: null, // Populated from features at call time
      inference_ms: d?.inference_ms ?? null,
      last_evaluated_at: d ? new Date().toISOString() : null,
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
    const pointValue = this.contract?.point_value ?? 20;
    return pnlPts * pos.quantity_remaining * pointValue;
  }

  private emitUpdate(): void {
    this.emit('update');
  }

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
  }
}
