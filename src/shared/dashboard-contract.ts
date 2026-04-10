import type {
  DirectionalAssessment as CoreDirectionalAssessment,
  DirectionalSetupInfo as CoreDirectionalSetupInfo,
  ExitReason,
  MarketRegime,
  SessionInfo as CoreSessionInfo,
  SetupType,
} from '../autotrade/types.js';

export type SessionInfo = CoreSessionInfo;
export type DirectionalSetupInfo = CoreDirectionalSetupInfo;

export interface DashboardAppMeta {
  symbol: string;
  mode: 'live' | 'paper' | 'signal_only';
  session_id: string;
  session_bucket: string;
  exchange_state: string;
  strategy_bucket: string;
  last_updated_iso: string;
  connection_status: 'connected' | 'disconnected' | 'unknown';
  engine_running: boolean;
  cycle_count: number;
  engine_phase: string;
  engine_phase_elapsed_ms: number;
  engine_phase_reason: string;
  quote_source: string | null;
  quote_age_ms: number | null;
  quote_is_stale: boolean;
  quote_updated_at: string | null;
}

export interface DashboardKpis {
  closed_trades: number;
  entries_today: number;
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
  management_profile: string | null;
  setup_family: string | null;
  atr_at_entry: number | null;
  pt1_resolved_pts: number | null;
  pt2_resolved_pts: number | null;
  trail_resolved_ticks: number | null;
}

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

export interface DashboardDirectionalAssessment {
  best_long: CoreDirectionalAssessment['best_long'];
  best_short: CoreDirectionalAssessment['best_short'];
  engine_decision: string | null;
  engine_decision_reason: string | null;
  confidence: number | null;
  skip_reasons: string[];
  htf_eval_long: DashboardHtfSetupEval | null;
  htf_eval_short: DashboardHtfSetupEval | null;
}

// ─── HTF Zone Dashboard Types ──────────────────────────────────────────────

export interface DashboardHtfZone {
  timeframe: string;
  kind: 'RES' | 'SUP';
  level: number;
  top: number;
  bottom: number;
  distance_pts: number | null;
  distance_atr: number | null;
  contains_price: boolean;
}

export interface DashboardHtfContext {
  study_present: boolean;
  resistance_zones: DashboardHtfZone[];
  support_zones: DashboardHtfZone[];
  nearest_resistance: DashboardHtfZone | null;
  nearest_support: DashboardHtfZone | null;
  inside_resistance_zone: boolean;
  inside_support_zone: boolean;
}

export interface DashboardHtfSetupEval {
  first_obstacle_rr: number | null;
  location_quality: 'good' | 'warning' | 'poor' | null;
  score_adjustment: number;
  vetoed: boolean;
  veto_reason: string | null;
  breakout_accepted: boolean;
}

export interface DashboardRecentTrade {
  trade_id: string;
  time: string;
  side: 'long' | 'short';
  setup_type: string;
  entry: number;
  exit: number | null;
  pnl_usd: number;
  r_multiple: number;
  exit_reason: ExitReason;
  hold_time_seconds: number;
  outcome: 'winner' | 'loser' | 'scratch';
}

export interface PnlPoint {
  time_iso: string;
  cumulative_pnl: number;
}

export interface FreshnessMetadata {
  snapshot_built_at: string;
  snapshot_version: number;
  /** Monotonic sequence incremented on every SSE publish commit. */
  publish_seq: number;
  /** Monotonic sequence incremented on every internal state mutation. */
  mutation_seq: number;
  /** ISO timestamp of last internal state mutation. */
  last_mutation_iso: string | null;
  /** Random UUID generated at server startup — detects restarts. */
  server_instance_id: string;
  data_gathered_at: string | null;
  data_gather_duration_ms: number | null;
  confidence_updated_at: string | null;
  analysis_interval_target_ms: number;
  last_analysis_duration_ms: number;
  htf_cache_hits: string[];
}

export interface DashboardManagement {
  pop_target1_before_stop: number | null;
  pop_target2_before_stop: number | null;
  pop_runner_extension: number | null;
  expected_value_hold_usd: number | null;
  expected_value_exit_now_usd: number | null;
  expected_value_reduce_usd: number | null;
  management_state: string | null;
  management_state_reason: string | null;
  decision_factors: string[];
  model_name: string | null;
  model_confidence: string | null;
  last_evaluated_at: string | null;
}

export interface DashboardMlManagement {
  enabled: boolean;
  model_name: string | null;
  model_version: string | null;
  latest_action: string | null;
  latest_confidence: number | null;
  latest_approved: boolean | null;
  latest_rejection_reason: string | null;
  prob_hold: number | null;
  ev_hold_r: number | null;
  ev_exit_now_r: number | null;
  inference_ms: number | null;
  last_evaluated_at: string | null;
  notes: string[];
  decisions_this_session: number;
  actions_approved_this_session: number;
}

export interface DashboardSnapshot {
  version: string;
  app: DashboardAppMeta;
  kpis: DashboardKpis;
  active_trade: DashboardActiveTrade;
  management: DashboardManagement;
  market_state: DashboardMarketState;
  directional: DashboardDirectionalAssessment;
  ml_management: DashboardMlManagement;
  htf_context: DashboardHtfContext | null;
  recent_trades: DashboardRecentTrade[];
  pnl_history: PnlPoint[];
  freshness: FreshnessMetadata;
}

// ─── Typed SSE Delta Events ──────────────────────────────────────────────────
// Each event carries a publish_seq for gap detection and a type discriminator.

export type DashboardDeltaEvent =
  | { type: 'price_tick'; price: number }
  | { type: 'position_opened'; active_trade: DashboardActiveTrade; kpis: DashboardKpis }
  | { type: 'position_cleared'; active_trade: DashboardActiveTrade; kpis: DashboardKpis }
  | { type: 'position_updated'; active_trade: DashboardActiveTrade }
  | { type: 'management_update'; management: DashboardManagement; active_trade: DashboardActiveTrade }
  | { type: 'ml_decision'; ml_management: DashboardMlManagement }
  | { type: 'trade_closed'; recent_trades: DashboardRecentTrade[]; pnl_history: PnlPoint[]; kpis: DashboardKpis }
  | { type: 'recent_trade_added'; recent_trades: DashboardRecentTrade[]; pnl_history: PnlPoint[]; kpis: DashboardKpis }
  | { type: 'market_update'; market_state: DashboardMarketState; directional: DashboardDirectionalAssessment; htf_context: DashboardHtfContext | null }
  | { type: 'app_update'; app: DashboardAppMeta }
  | { type: 'resync'; reason: string };

/** A batch of typed delta events — one SSE message, one unique publish_seq. */
export interface DashboardDeltaBatch {
  publish_seq: number;
  events: DashboardDeltaEvent[];
}

export const DASHBOARD_VERSION = 'dashboard_v1.7';
