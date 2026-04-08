/**
 * Dashboard types — canonical snapshot for the operator dashboard.
 *
 * This is the single coherent object the frontend renders.
 * Built from existing structured state (Position, PerformanceStats,
 * RiskState, decision snapshot, etc.) — never from log parsing.
 */

import type {
  MarketRegime,
  PerformanceStats,
  TradeRecord,
  SetupType,
  ExitReason,
} from '../types.js';
import type {
  SessionInfo,
  DirectionalAssessment,
} from '../types.js';

// ─── App Metadata ────────────────────────────────────────────────────────────

export interface DashboardAppMeta {
  symbol: string;
  mode: 'live' | 'paper' | 'signal_only';
  session_id: string;
  /** Legacy session bucket (premarket/rth_open/midday/power_hour/postmarket/closed). */
  session_bucket: string;
  /** Layer 1: Exchange state (RTH/ETH/MAINTENANCE/CLOSED). */
  exchange_state: string;
  /** Layer 2: Strategy bucket (ASIA/LONDON/NY_AM/NY_LUNCH/NY_PM/CLOSED/MAINTENANCE/UNKNOWN). */
  strategy_bucket: string;
  last_updated_iso: string;
  connection_status: 'connected' | 'disconnected' | 'unknown';
  engine_running: boolean;
  cycle_count: number;
  /** Current engine state machine phase (FLAT / ENTERING / MANAGING / EXITING / COOLDOWN). */
  engine_phase: string;
  /** How long the engine has been in the current phase (ms). */
  engine_phase_elapsed_ms: number;
  /** Reason for the last phase transition. */
  engine_phase_reason: string;
  /** Source of the last monitor price ('live' | 'bar_close' | 'fallback' | null before first quote). */
  quote_source: string | null;
  /** Age of the last fetched quote at snapshot build time (ms). null before first quote. */
  quote_age_ms: number | null;
  /** Whether the last quote was flagged as stale. */
  quote_is_stale: boolean;
  /** ISO timestamp when last quote was fetched. null before first quote. */
  quote_updated_at: string | null;
}

// ─── KPIs ────────────────────────────────────────────────────────────────────

export interface DashboardKpis {
  trades_today: number;
  total_pnl_usd: number;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  win_rate_pct: number | null;
  open_positions: number;
  remaining_daily_loss_budget: number | null;
  consecutive_losses: number;
  max_drawdown_pct: number;
  avg_r: number | null;
  profit_factor: number | null;
}

// ─── Active Trade ────────────────────────────────────────────────────────────

export interface DashboardActiveTrade {
  is_open: boolean;
  trade_id: string | null;
  side: 'long' | 'short' | null;
  setup_type: SetupType | null;
  entry_price: number | null;
  stop_loss: number | null;
  stop_initial: number | null;
  target_1: number | null;
  target_2: number | null;
  target_3: number | null;
  current_price: number | null;
  unrealized_pnl_usd: number | null;
  unrealized_r: number | null;
  hold_time_seconds: number | null;
  mfe_pts: number | null;
  mae_pts: number | null;
  breakeven_armed: boolean;
  trailing_armed: boolean;
  trailing_ticks: number | null;
  quantity: number | null;
  quantity_remaining: number | null;
  // Management profile (resolved at entry)
  management_profile: string | null;
  setup_family: string | null;
  atr_at_entry: number | null;
  pt1_resolved_pts: number | null;
  pt2_resolved_pts: number | null;
  trail_resolved_ticks: number | null;
}

// ─── Market State ────────────────────────────────────────────────────────────

export interface DashboardMarketState {
  regime: MarketRegime | null;
  bias_1h: string | null;
  bias_15m: string | null;
  bias_5m: string | null;
  bias_1m: string | null;
  alignment_score: number | null;
  ema_stack: string | null;
  supertrend_bias: string | null;
  price_vs_vwap: string | null;
  distance_from_vwap_pts: number | null;
  atr_1m: number | null;
  current_price: number | null;
  session: SessionInfo | null;
}

// ─── Directional Assessment ──────────────────────────────────────────────────

export interface DashboardDirectionalAssessment {
  best_long: DirectionalAssessment['best_long'];
  best_short: DirectionalAssessment['best_short'];
  engine_decision: string | null;
  engine_decision_reason: string | null;
  /** Overall confidence of the chosen candidate (0-10), null when no candidate. */
  confidence: number | null;
  skip_reasons: string[];
}

// ─── Recent Trade (for table) ────────────────────────────────────────────────

export interface DashboardRecentTrade {
  trade_id: string;
  time: string;
  side: 'long' | 'short';
  setup_type: string;
  entry: number;
  /** May be null for older trade records that predate the exit_price_actual field. */
  exit: number | null;
  pnl_usd: number;
  r_multiple: number;
  exit_reason: ExitReason;
  hold_time_seconds: number;
  outcome: 'winner' | 'loser' | 'scratch';
}

// ─── PnL History Point (for chart) ──────────────────────────────────────────

export interface PnlPoint {
  time_iso: string;
  cumulative_pnl: number;
}

// ─── Freshness Metadata ─────────────────────────────────────────────────────

export interface FreshnessMetadata {
  /** When the snapshot was built/published. */
  snapshot_built_at: string;
  /** Monotonically increasing version counter. */
  snapshot_version: number;
  /** When the backend last gathered fresh market data. */
  data_gathered_at: string | null;
  /** Duration of last data collection in ms. */
  data_gather_duration_ms: number | null;
  /** When confidence was last recomputed. */
  confidence_updated_at: string | null;
  /** Scheduler metrics for observability. */
  analysis_interval_target_ms: number;
  last_analysis_duration_ms: number;
  /** HTF cache hits from last collection. */
  htf_cache_hits: string[];
}

// ─── In-Trade Management ─────────────────────────────────────────────────────

/**
 * In-trade probability and expected-value advisory.
 * Updated every monitor cycle when a position is open.
 * All fields are null when no position is active.
 */
export interface DashboardManagement {
  /** Probability price reaches T1 before the current stop. */
  pop_target1_before_stop: number | null;
  /** Probability price reaches T2 before the current stop (unconditional). */
  pop_target2_before_stop: number | null;
  /** Probability of meaningful extension beyond T2. */
  pop_runner_extension: number | null;
  /** EV of holding the remaining position to target (USD). */
  expected_value_hold_usd: number | null;
  /** EV of exiting now at current price (USD). */
  expected_value_exit_now_usd: number | null;
  /** EV of reducing position by 50% now, holding remainder (USD). */
  expected_value_reduce_usd: number | null;
  /** HOLD | REDUCE | MOVE_STOP | EXIT_NOW — advisory only, never overrides hard stop. */
  management_state: string | null;
  management_state_reason: string | null;
  /** Factors that drove the management_state decision. */
  decision_factors: string[];
  /** 'rules_v1' or future trained model name. */
  model_name: string | null;
  /** high | medium | low — depends on how much market context was available. */
  model_confidence: string | null;
  /** ISO timestamp of last management evaluation. */
  last_evaluated_at: string | null;
}

// ─── ML Management ──────────────────────────────────────────────────────────

export interface DashboardMlManagement {
  /** Whether ML management is enabled. */
  enabled: boolean;
  /** Active model name. */
  model_name: string | null;
  /** Active model version. */
  model_version: string | null;
  /** Latest action recommended by ML model. */
  latest_action: string | null;
  /** Confidence in the latest action (0-1). */
  latest_confidence: number | null;
  /** Whether the execution gate approved the latest action. */
  latest_approved: boolean | null;
  /** Rejection reason if gate blocked. */
  latest_rejection_reason: string | null;
  /** P(holding is better than exiting). */
  prob_hold: number | null;
  /** Expected R if holding to trade end. */
  ev_hold_r: number | null;
  /** Current unrealized R (exit now value). */
  ev_exit_now_r: number | null;
  /** Inference latency in milliseconds. */
  inference_ms: number | null;
  /** When the last ML decision was made. */
  last_evaluated_at: string | null;
  /** Notes from the model (policy reasons). */
  notes: string[];
  /** Total ML decisions made this session. */
  decisions_this_session: number;
  /** Total ML actions approved this session. */
  actions_approved_this_session: number;
}

// ─── Full Dashboard Snapshot ─────────────────────────────────────────────────

export interface DashboardSnapshot {
  /** Schema version for forward compatibility. */
  version: string;
  app: DashboardAppMeta;
  kpis: DashboardKpis;
  active_trade: DashboardActiveTrade;
  management: DashboardManagement;
  market_state: DashboardMarketState;
  directional: DashboardDirectionalAssessment;
  ml_management: DashboardMlManagement;
  recent_trades: DashboardRecentTrade[];
  pnl_history: PnlPoint[];
  /** Freshness metadata for observability. */
  freshness: FreshnessMetadata;
}

export const DASHBOARD_VERSION = 'dashboard_v1.6';
