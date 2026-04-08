/**
 * Frontend mirror of backend DashboardSnapshot types.
 * Kept in sync manually — the backend is the source of truth.
 */

export interface FreshnessMetadata {
  snapshot_built_at: string;
  snapshot_version: number;
  data_gathered_at: string | null;
  data_gather_duration_ms: number | null;
  confidence_updated_at: string | null;
  analysis_interval_target_ms: number;
  last_analysis_duration_ms: number;
  htf_cache_hits: string[];
}

export interface MlManagement {
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
  app: AppMeta;
  kpis: Kpis;
  active_trade: ActiveTrade;
  market_state: MarketState;
  directional: DirectionalAssessment;
  ml_management?: MlManagement;
  recent_trades: RecentTrade[];
  pnl_history: PnlPoint[];
  freshness?: FreshnessMetadata;
}

export interface AppMeta {
  symbol: string;
  mode: 'live' | 'paper' | 'signal_only';
  session_id: string;
  session_bucket: string;
  exchange_state?: string;
  strategy_bucket?: string;
  last_updated_iso: string;
  connection_status: 'connected' | 'disconnected' | 'unknown';
  engine_running: boolean;
  cycle_count: number;
}

export interface Kpis {
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

export interface ActiveTrade {
  is_open: boolean;
  trade_id: string | null;
  side: 'long' | 'short' | null;
  setup_type: string | null;
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
}

export interface MarketState {
  regime: string | null;
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

export interface SessionInfo {
  bucket: string;
  market_open: boolean | null;
  or_complete: boolean | null;
  or_high: number | null;
  or_low: number | null;
  or_mid: number | null;
  or_width: number | null;
}

export interface DirectionalSetupInfo {
  setup_type: string | null;
  valid: boolean | null;
  score: number | null;
  structural_score: number | null;
  context_score: number | null;
  trade_quality_score: number | null;
  hard_reject_reasons: string[];
  entry: number | null;
  stop: number | null;
  t1: number | null;
  t2: number | null;
  rr: number | null;
  confluence_factors: string[];
}

export interface DirectionalAssessment {
  best_long: DirectionalSetupInfo | null;
  best_short: DirectionalSetupInfo | null;
  engine_decision: string | null;
  engine_decision_reason: string | null;
  /** Overall confidence of the chosen candidate (0-10), null when no candidate. */
  confidence: number | null;
  skip_reasons: string[];
}

export interface RecentTrade {
  trade_id: string;
  time: string;
  side: 'long' | 'short';
  setup_type: string;
  entry: number;
  exit: number | null;
  pnl_usd: number;
  r_multiple: number;
  exit_reason: string;
  hold_time_seconds: number;
  outcome: 'winner' | 'loser' | 'scratch';
}

export interface PnlPoint {
  time_iso: string;
  cumulative_pnl: number;
}
