// ─── Core Domain Types ──────────────────────────────────────────────────────

export type ExecutionMode = 'paper' | 'live' | 'signal_only';

export type RestartMode = 'dev' | 'prod';

export type EnginePhase = 'FLAT' | 'ENTERING' | 'MANAGING' | 'EXITING' | 'COOLDOWN';

export type MarketRegime =
  | 'trending_up'
  | 'trending_down'
  | 'range_bound'
  | 'breakout_attempt'
  | 'breakdown_attempt'
  | 'compression'
  | 'high_volatility_impulse'
  | 'choppy';

export type Direction = 'long' | 'short' | 'none';

// SetupType is the canonical union of strategy IDs. It is derived from
// src/shared/strategy-ids.ts so the type layer stays free of runtime
// dependencies on the registry. See Phase 2 of the scoring refactor.
export type { SetupType } from '../shared/strategy-ids.js';
import type { SetupType } from '../shared/strategy-ids.js';

// ── Setup Families (direction-agnostic grouping for management profiles) ────
export type SetupFamily =
  | 'trend_pullback'
  | 'breakout_retest'
  | 'opening_drive'
  | 'or_retest'
  | 'failed_or_break'
  | 'momentum_continuation'
  | 'lob_mbo_scalp'
  | 'default';

export type DecisionStage =
  | 'strategy_no_candidate'
  | 'strategy_hard_gates'
  | 'strategy_score_gate'
  | 'cooldown_gate'
  | 'extension_gate'
  | 'position_open_gate'
  | 'entry_ml_gate'
  | 'risk_gate'
  | 'executed';

export interface ReversalPackageTelemetry {
  reversal_package_suppressed_by_warmup?: boolean;
  reversal_package_suppressed_reason?: string | null;
  reversal_package_attributable?: boolean;
  reversal_package_attribution_flags?: string[];
}

export interface CandidateGeneratorDiagnostic {
  setup_type: SetupType;
  setup_family: SetupFamily;
  accepted: boolean;
  rejection_reason_primary: string | null;
  rejection_reason_all: string[];
}

export interface TrendFreshnessContext {
  vwap_distance_session_atr: number | null;
  above_vwap_allowed: boolean;
  reversal_bundle_name: string | null;
  reversal_bundle_passed: boolean;
  bars_since_flip: number | null;
  structure_deterioration_passed: boolean;
  ema_formation_passed: boolean;
  regime_filter_passed: boolean;
}

export interface TrendFreshnessResult {
  fresh: boolean;
  reason: string;
  soft_penalty: number;
  context: TrendFreshnessContext;
}

// ── Management Profiles (ATR-relative trade management templates) ───────────

/**
 * Defines how a trade should be managed (partials, trailing, time stop).
 * ATR-relative fields use the entry-time ATR to compute concrete values.
 * When an ATR field is 0, the corresponding _fallback value is used instead.
 */
export interface ManagementProfile {
  name: string;
  family: SetupFamily;
  // Partial-profit targets (ATR-relative with fixed fallbacks)
  pt1_offset_atr: number;
  pt2_offset_atr: number;
  pt1_offset_pts_fallback: number;
  pt2_offset_pts_fallback: number;
  pt1_exit_fraction: number;
  pt2_exit_fraction: number;
  // Post-partial behavior
  pt1_move_to_be: boolean;
  pt1_activate_trailing: boolean;
  trail_atr_post_t1: number;
  trail_ticks_post_t1_fallback: number;
  // Pre-T1 profit protection
  breakeven_trigger_r: number;
  pre_t1_trail_trigger_r: number;
  pre_t1_trail_atr: number;
  pre_t1_trail_ticks_fallback: number;
  // Time stop
  time_stop_minutes: number;
  time_stop_max_r_pre_t1: number;
  time_stop_max_r_post_t1: number;
  // ── Pre-T1 failure-to-launch exit (Dead-Trade Guard) ───────────────────
  // All optional: when unset, resolution defaults to the feature being OFF.
  // Units: all *_minutes fields in minutes, all *_rate_* fields in R/min.
  pre_t1_failure_exit_enabled?: boolean;
  pre_t1_failure_shadow_mode?: boolean;
  /** τ_decay: decayRate is forced to 0 until (t − t_peak) ≥ this gap. */
  pre_t1_failure_decay_min_gap_minutes?: number;
  /** λ for netProgress = currentR − λ · maeR. */
  pre_t1_failure_lambda_net?: number;
  // Lane A — soft review (logs only, never flattens)
  pre_t1_failure_soft_min_minutes?: number;
  pre_t1_failure_soft_progress_rate_max?: number;
  pre_t1_failure_soft_failure_ratio_min?: number;
  // Lane B — empirical quantile cut (requires failure_exit_curves.json)
  pre_t1_failure_hard_min_minutes?: number;
  /** currentR cap = α · Q20_peak_win(t), with α in [0.3, 0.5] typically. */
  pre_t1_failure_hard_current_r_alpha?: number;
  /** Curve family key to query (defaults to management profile family name). */
  pre_t1_failure_curves_key?: string;
  /** Per-bucket minimum observation count; buckets below this are low-confidence. */
  pre_t1_failure_min_n_per_bucket?: number;
  // Lane C — emergency shape cut (runs without curves)
  pre_t1_failure_emergency_min_minutes?: number;
  /** maeR floor: prevents flat-chop false fires when failureRatio is unstable. */
  pre_t1_failure_emergency_mae_r_floor?: number;
  pre_t1_failure_emergency_failure_ratio_min?: number;
  pre_t1_failure_emergency_peak_r_max?: number;
  /** Optional decayRate gate (R/min), only enforced when state.decayRate > 0. */
  pre_t1_failure_emergency_decay_rate_min?: number;
  // Expectancy inputs (v2 hook; inert in v1 engine code)
  /** c in EV formula: slippage + commissions + adverse execution cost (in R). */
  pre_t1_failure_cost_r?: number;

  // ── lob_mbo_scalp family (Phase 3a: additive; wired in Phase 6) ──────────
  // All fields are optional/nullable. ScalperExitEngine is the SINGLE owner
  // of every time-based scalper exit — `position-manager.ts` must NOT read
  // these fields to enforce a second hard-coded cap. See plan Phase 6.
  /**
   * Extended hold cap in whole seconds. Applied ONLY when the position was
   * entered with an absorption+refill confirmation flag
   * (Position.scalper_extended_cap === true). Must be ≥ scalper_hard_cap_seconds
   * or config load fails. Typical default: 10.
   */
  time_stop_seconds?: number | null;
  /**
   * Base unconditional hard cap in whole seconds applied to every scalper
   * position. Default: 5.
   */
  scalper_hard_cap_seconds?: number | null;
  /**
   * If hold time exceeds this and the current P&L is below 1 tick, the
   * position exits with reason `scalper_no_progress`. Default: 2.
   */
  scalper_no_progress_seconds?: number | null;
  /** Lower bound on the entry-time microstructure stop distance (ticks). */
  scalper_micro_stop_min_ticks?: number | null;
  /** Upper bound on the entry-time microstructure stop distance (ticks). */
  scalper_micro_stop_max_ticks?: number | null;
}

/**
 * Concrete (resolved) management params stored on Position at entry time.
 * All ATR multiples have been converted to points/ticks using entry-time ATR.
 */
export interface ResolvedManagementParams {
  profile_name: string;
  family: SetupFamily;
  atr_at_entry: number | null;
  // All concrete values — no ATR multiples remain
  pt1_offset_pts: number;
  pt2_offset_pts: number;
  pt1_exit_fraction: number;
  pt2_exit_fraction: number;
  pt1_move_to_be: boolean;
  pt1_activate_trailing: boolean;
  trail_ticks_post_t1: number;
  breakeven_trigger_r: number;
  pre_t1_trail_trigger_r: number;
  pre_t1_trail_distance_ticks: number;
  time_stop_minutes: number;
  time_stop_max_r_pre_t1: number;
  time_stop_max_r_post_t1: number;
  // ── Pre-T1 failure-to-launch (Dead-Trade Guard) — concrete resolved values.
  // Defaults are applied at resolveProfile(): when the profile does not set
  // pre_t1_failure_exit_enabled, resolved value is `false` and the engine
  // short-circuits before doing any state computation.
  pre_t1_failure_exit_enabled: boolean;
  pre_t1_failure_shadow_mode: boolean;
  pre_t1_failure_decay_min_gap_minutes: number;
  pre_t1_failure_lambda_net: number;
  // Lane A
  pre_t1_failure_soft_min_minutes: number;
  pre_t1_failure_soft_progress_rate_max: number;
  pre_t1_failure_soft_failure_ratio_min: number;
  // Lane B
  pre_t1_failure_hard_min_minutes: number;
  pre_t1_failure_hard_current_r_alpha: number;
  pre_t1_failure_curves_key: string;
  pre_t1_failure_min_n_per_bucket: number;
  // Lane C
  pre_t1_failure_emergency_min_minutes: number;
  pre_t1_failure_emergency_mae_r_floor: number;
  pre_t1_failure_emergency_failure_ratio_min: number;
  pre_t1_failure_emergency_peak_r_max: number;
  pre_t1_failure_emergency_decay_rate_min: number;
  // Expectancy hook
  pre_t1_failure_cost_r: number;

  // ── lob_mbo_scalp family resolved params (Phase 3a: additive; wired in Phase 6) ──
  // Frozen on Position.management_params at entry. ScalperExitEngine is the
  // single reader. All optional — non-scalper positions leave them null.
  time_stop_seconds?: number | null;
  scalper_hard_cap_seconds?: number | null;
  scalper_no_progress_seconds?: number | null;
  scalper_micro_stop_min_ticks?: number | null;
  scalper_micro_stop_max_ticks?: number | null;
}

export type ExitReason =
  | 'target_1'
  | 'target_2'
  | 'target_3'
  // ── Coarse stop label (legacy, preserved for backward compat) ────────────
  | 'stop_loss'
  // ── Granular stop labels (post-patch P3) ─────────────────────────────────
  /** Stop hit before any T1 partial: initial stop was never moved. */
  | 'stop_loss_initial'
  /** Stop hit after T1 partial, trailing NOT yet armed (stop resting at BE). */
  | 'stop_loss_breakeven'
  /** Stop hit after T1 partial, trailing WAS armed — a profitable or BE exit. */
  | 'stop_loss_trailing'
  /** Partial profit taken at PT1 (configurable point offset from entry). */
  | 'partial_profit_1'
  /** Partial profit taken at PT2 (configurable point offset from entry). */
  | 'partial_profit_2'
  /** Final runner exit — the remaining position after PT1+PT2 partials. */
  | 'final_runner_exit'
  | 'time_stop'
  /** Pre-PT1 failure-to-launch exit (Dead-Trade Guard: hard or emergency lane). */
  | 'failure_to_launch'
  /** ML management decided EXIT_ALL — full position closed by ML advisory. */
  | 'ml_exit_all'
  /** ML management decided EXIT_PARTIAL — partial reduction by ML advisory. */
  | 'ml_exit_partial'
  /** Target-position layer: partial reduce toward a lower q_target (V1a). */
  | 'target_position_reduce'
  /** Target-position layer: q_target hit 0 and flatten_on_zero_target was enabled. */
  | 'target_position_flatten'
  /** Target-position layer: proposed residual would be below min_residual_contracts. */
  | 'target_position_residual_below_minimum'
  | 'daily_loss_limit'
  | 'session_end'
  // ── lob_mbo_scalp family exit labels (Phase 3a: additive; wired in Phase 6) ──
  /** Scalper base or extended hard-cap on hold time (owned by ScalperExitEngine). */
  | 'scalper_hard_cap'
  /** Scalper early exit: 2-of-N microstructure reversal signals fired. */
  | 'scalper_reversal'
  /** Scalper early exit: specifically an absorption-driven reversal / edge decay. */
  | 'microstructure_edge_decay'
  /** Scalper early exit: hold time exceeded with no favorable progress. */
  | 'scalper_no_progress';

export type TfBias = 'bullish' | 'bearish' | 'neutral';

// ─── Market Data ────────────────────────────────────────────────────────────

export interface OhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Indicator values collected from TradingView for a single timeframe.
 *
 * Classification (see reports/strategy-feature-audit.md):
 *   @core         — Hard gate or high-weight scoring input
 *   @secondary    — Moderate scoring input (0.2-0.4 pts)
 *   @observational — Kept for logging/management only, not in entry scoring
 *   @deprecated    — Collection stopped; always null. Kept for schema compat.
 */
export interface IndicatorSnapshot {
  // ── CORE: EMA Stack (regime classification, trend setup gates) ───────────
  /** @core — Regime classification, trend pullback gates, multi-TF bias. */
  ema_9: number | null;
  /** @core — Regime classification, trend pullback gates. */
  ema_21: number | null;
  /** @core — Regime classification, trend pullback gates. */
  ema_50: number | null;
  /** @deprecated — Collected but never referenced in any decision logic. Always null. */
  ema_100: number | null;
  /** @core — HTF bias assessment (1h timeframe). ML features. */
  ema_200: number | null;
  // ── CORE: SuperTrend (regime, bias 2x weight, setup gates, scoring) ─────
  /** @core — Trend direction filter. 2x weight in bias. Hard-gates trend pullbacks. */
  supertrend_direction: 'up' | 'down' | null;
  /** @core — SuperTrend price level (used as potential stop reference). */
  supertrend_level: number | null;
  // ── OBSERVATIONAL: NovaWave (removed from live bias; kept for logging) ──
  /** @observational — Collected for logging. Redundant with EMA stack direction. */
  novawave_fast: number | null;
  /** @observational — Collected for logging. Redundant with EMA stack direction. */
  novawave_slow: number | null;
  /** @deprecated — Never referenced. Collection stopped. Always null. */
  novawave_signal: number | null;
  // ── DEPRECATED: DMA (never used in any decision logic) ──────────────────
  /** @deprecated — Collected but zero references in codebase. Always null. */
  dma_20: number | null;
  /** @deprecated — Collected but zero references in codebase. Always null. */
  dma_50: number | null;
  /** @deprecated — Collected but zero references in codebase. Always null. */
  dma_200: number | null;
  // ── CORE: Smart Money Structure (entry zones, targets, scoring +0.5) ────
  /** @core — T1 target for long pullbacks; structural level scoring. */
  smart_money_choch_sell: number | null;
  /** @core — Entry zone boundary; T1 target for short pullbacks. */
  smart_money_choch_buy: number | null;
  /** @core — Structural level scoring (+0.5 if at BOS). */
  smart_money_bos_sell: number | null;
  /** @core — Structural level scoring (+0.5 if at BOS). */
  smart_money_bos_buy: number | null;
  // ── SECONDARY: VWAP (scoring +/-0.3, management distance) ──────────────
  /** @secondary — Scoring +/-0.3. Management uses distance-to-VWAP. */
  vwap: number | null;
  // ── CORE: ATR (regime compression, stop widening, management profiles) ──
  /** @core — Compression detection, stop buffer, management profile resolution. */
  atr_14: number | null;
  // ── OBSERVATIONAL: RSI (management extreme penalty only) ────────────────
  /** @observational — Not in entry scoring. Management uses for extreme RSI penalty (-0.25). */
  rsi_14: number | null;
  // ── CORE: Volume (HVI regime trigger, scoring +/-0.5) ──────────────────
  /** @core — HVI regime trigger. Scoring +/-0.5 for volume quality. */
  volume: number | null;
  /** @core — Volume quality baseline. HVI spike detection. */
  volume_sma_20: number | null;
  // ── SECONDARY: ADX / DMI (regime confirmation, scoring +/-0.4) ─────────
  /** @secondary — Regime trending confirmation (ADX>25). Scoring +0.4/-0.3. */
  adx: number | null;
  /** @secondary — DI direction in bias (+/-1pt). ADX confirmation (+0.2). */
  di_plus: number | null;
  /** @secondary — DI direction in bias (+/-1pt). ADX confirmation (+0.2). */
  di_minus: number | null;
  // ── SECONDARY: TTM Squeeze (compression regime gate, scoring +/-0.3) ───
  /** @secondary — Squeeze release bonus. Compression regime detection. */
  ttm_squeeze_momentum: number | null;
  /** @secondary — Compression regime hard gate (firing=true -> 'compression'). */
  ttm_squeeze_firing: boolean | null;
  // ── SECONDARY: CVD (divergence -0.4, alignment +0.25, bias +/-1pt) ─────
  /** @secondary — Cumulative volume delta value. */
  cvd: number | null;
  /** @secondary — Bar-level delta. Divergence detection (-0.4 penalty). */
  cvd_delta: number | null;
  /** @secondary — Trend direction. Bias scoring +/-1pt, alignment bonus +0.25. */
  cvd_trend: 'up' | 'down' | null;
}

export interface KeyLevels {
  session_high: number | null;
  session_low: number | null;
  daily_open: number | null;
  weekly_open: number | null;
  monday_high: number | null;
  monday_low: number | null;
  monday_mid: number | null;
  monthly_open: number | null;
  pivot_resistance: number[];  // nearest above price
  pivot_support: number[];     // nearest below price
  choch_sell: number | null;
  choch_buy: number | null;
  bos_sell: number | null;
  bos_buy: number | null;
  // ── NQ / futures-specific levels (optional, populated when available) ──
  overnight_high: number | null;
  overnight_low: number | null;
  prior_rth_high: number | null;
  prior_rth_low: number | null;
  opening_range_high: number | null;
  opening_range_low: number | null;
  opening_range_mid: number | null;
  session_vwap: number | null;
}

// ─── Session & Event Context (NQ-specific) ──────────────────────────────────

export interface SessionState {
  is_rth: boolean;
  is_eth: boolean;
  is_us_cash_open_window: boolean;
  is_rth_closing_window: boolean;
  is_weekend: boolean;
  minutes_since_rth_open: number | null;
  minutes_to_rth_close: number | null;
}

export interface EventState {
  is_event_window: boolean;
  event_type: string | null;
  minutes_to_next_event: number | null;
  minutes_since_last_event: number | null;
  no_trade_due_to_event: boolean;
  suppression_reason: string;
}

// ─── HTF Zone Types (Higher-Timeframe Support/Resistance) ──────────────────

export type HtfZoneKind = 'RES' | 'SUP';

export interface HtfZone {
  /** Collision-safe identifier: `${kind}_${timeframe}_${level}_${source_ts ?? 'na'}` */
  id: string;
  kind: HtfZoneKind;
  timeframe: '15' | '60' | '240' | string;
  /** Zone midpoint price. */
  level: number;
  top: number;
  bottom: number;
  /** ATR value from the originating timeframe (null if absent). */
  atr: number | null;
  /** Pivot lookback length from Pine (null if absent). */
  pivot_len: number | null;
  /** Source timestamp (unix ms) from the Pine study (null if absent). */
  source_ts: number | null;
  /** Signed offset: zone.level - price. Positive = zone above, negative = below. */
  distance_pts: number | null;
  /** |distance_pts| / atr14 — absolute magnitude. */
  distance_atr: number | null;
  /** True when price is between zone.bottom and zone.top. */
  contains_price: boolean;
}

/**
 * Market-neutral HTF context: describes the zone landscape around current price.
 * No directional RR, veto, or quality — those are candidate-specific (see HtfSetupEvaluation).
 */
export interface HtfContext {
  study_present: boolean;
  study_name: string | null;
  fetched_at_iso: string | null;
  resistance_zones: HtfZone[];
  support_zones: HtfZone[];
  nearest_resistance: HtfZone | null;
  nearest_support: HtfZone | null;
  inside_resistance_zone: boolean;
  inside_support_zone: boolean;
}

/**
 * Candidate-specific HTF evaluation — computed per setup in strategy layer.
 * Contains first obstacle RR, location quality, veto reason, breakout acceptance.
 */
export interface HtfSetupEvaluation {
  /** (nearest_obstacle_edge - entry_mid) / risk_pts. null when risk_pts <= 0 or no obstacle. */
  first_obstacle_rr: number | null;
  location_quality: 'good' | 'warning' | 'poor' | null;
  score_adjustment: number;
  score_factors: string[];
  vetoed: boolean;
  veto_reason: string | null;
  breakout_accepted: boolean;
  nearest_obstacle: HtfZone | null;
  nearest_support_zone: HtfZone | null;
}

export interface HtfZonesConfig {
  enabled: boolean;
  study_filter: string;
  max_labels: number;
  hard_veto_enabled: boolean;
  hard_veto_timeframes: string[];
  min_first_obstacle_rr: number;
  warn_distance_atr: number;
  hard_veto_inside_major_zone: boolean;
  allow_breakout_acceptance_override: boolean;
  score_penalty_15m_res: number;
  score_penalty_1h_res: number;
  score_penalty_4h_res: number;
  score_penalty_obstacle_before_t1: number;
  score_bonus_near_support: number;
  score_bonus_reclaimed_support: number;
}

export interface MarketSnapshot {
  timestamp_unix: number;
  timestamp_iso: string;
  symbol: string;
  price: number;
  bars_1m: OhlcvBar[];
  bars_5m: OhlcvBar[];
  bars_15m: OhlcvBar[];
  bars_1h: OhlcvBar[];
  indicators_1m: IndicatorSnapshot;
  indicators_15m: IndicatorSnapshot;
  indicators_1h: IndicatorSnapshot;
  key_levels: KeyLevels;
  data_quality: DataQuality;
  /** NQ session context (RTH/ETH, opening window, closing window). */
  session?: SessionState;
  /** Macro-event state for NQ no-trade windows. */
  event?: EventState;
  /** Higher-timeframe support/resistance zone context (market-neutral). */
  htf_context?: HtfContext;
}

export interface DataQuality {
  bars_1m_count: number;
  bars_5m_count: number;
  bars_15m_count: number;
  bars_1h_count: number;
  vwap_available: boolean;
  atr_available: boolean;
  rsi_available: boolean;
  missing_indicators: string[];
}

// ─── Canonical Management Action (shared across all management sources) ──────

/**
 * The canonical set of executable management actions.
 * Used by: ML pipeline, rules engine, future Bookmap-based advisors.
 * HOLD and NO_ACTION are passive — they never trigger execution.
 */
export type ManagementAction =
  | 'HOLD'
  | 'EXIT_ALL'
  | 'EXIT_PARTIAL'
  | 'MOVE_STOP'
  | 'MOVE_TO_BREAKEVEN'
  | 'SCALE_IN'
  | 'SCALE_OUT'
  | 'NO_ACTION';

/** Actions that are passive: they never trigger execution. */
export const PASSIVE_ACTIONS: readonly ManagementAction[] = ['HOLD', 'NO_ACTION'] as const;

/** Actions that reduce risk: allowed even on stale quotes. */
export const RISK_REDUCING_ACTIONS: readonly ManagementAction[] = ['EXIT_ALL', 'EXIT_PARTIAL', 'SCALE_OUT'] as const;

// ─── Market Microstructure Snapshot (placeholder for Bookmap integration) ────

/**
 * Placeholder for order-book / microstructure data from an external source
 * (Bookmap + Rithmic LOB bridge). Currently unused — all fields are nullable.
 *
 * When populated, this data enriches ML features for management decisions
 * and provides depth-aware exit signals.
 *
 * See: reports/bookmap_integration_plan_20260408.md
 */
export interface MarketMicrostructureSnapshot {
  /** Source timestamp (Unix ms from the LOB bridge). */
  timestamp_ms: number | null;
  /** Best bid price. */
  bid: number | null;
  /** Best ask price. */
  ask: number | null;
  /** Best bid size (contracts). */
  bid_size: number | null;
  /** Best ask size (contracts). */
  ask_size: number | null;
  /** Spread in ticks. */
  spread_ticks: number | null;
  /** Bid-ask depth imbalance at 5 levels: (bid_depth - ask_depth) / total. Range [-1, 1]. */
  depth_imbalance_5: number | null;
  /** Cumulative delta over last 30 seconds (buy_vol - sell_vol). */
  cumulative_delta_30s: number | null;
  /** Trade flow imbalance over last 10 seconds: buy_vol / total_vol. Range [0, 1]. */
  trade_flow_imbalance_10s: number | null;
  /** Whether a large resting bid exists within 5 pts of price. */
  large_bid_near_price: boolean | null;
  /** Whether a large resting ask exists within 5 pts of price. */
  large_ask_near_price: boolean | null;
  /** Data quality: 'full_depth' | 'bbo_only' | 'unavailable'. */
  data_quality: 'full_depth' | 'bbo_only' | 'unavailable';
  /** Age of this snapshot in ms (computed by consumer). */
  age_ms: number | null;
}

// ─── Session Info (for dashboard use) ────────────────────────────────────────

import type { ExchangeSessionState, StrategySessionBucket, LegacySessionBucket } from './session.js';

export interface SessionInfo {
  bucket: LegacySessionBucket;
  exchange_state: ExchangeSessionState;
  strategy_bucket: StrategySessionBucket;
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
}

// ─── Strategy ───────────────────────────────────────────────────────────────

export interface MultiTfBias {
  '1h': TfBias;
  '15m': TfBias;
  '5m': TfBias;
  '1m': TfBias;
  aligned: boolean;
  alignment_score: number; // 0–4
}

// ─── Entry State Vector (Phase 1 of the quant trend-pullback refactor) ──────
//
// The EntryStateVector is the canonical frozen snapshot of the decision
// state at signal-generation time. It is populated by
// features/entry-state.ts, attached to CandidateSetup.entry_state_vector,
// and later consumed by the expectancy engine and the historical labeler.
//
// Phase 1 populates the geometric + volatility fields only. The orderflow
// fields (ofi_*, z_ofi_*, queue_imbalance_5, microprice_offset_pts) are
// reserved for Phase 2 and ship as `null`. The LOB degradation matrix in
// plan §4.4 is enforced in Phase 2; for Phase 1 every vector emits
// `lob_state = 'missing'` and `ofi_reliability = 'unknown'`.
//
// Schema versioning (plan §4.6): any field add/remove/rename or any change
// to how an existing field is computed or rounded MUST bump
// ENTRY_STATE_VECTOR_SCHEMA_VERSION so frozen rows from different commits
// are never silently merged.

export const ENTRY_STATE_VECTOR_SCHEMA_VERSION = '0.1.0';

/** LOB state classification from the §4.4 degradation matrix. */
export type EntryStateLobState =
  | 'missing'
  | 'stale'
  | 'misaligned'
  | 'invalid'
  | 'sparse'
  | 'fresh';

/** OFI reliability tag carried on the emitted vector. */
export type EntryStateOfiReliability = 'full' | 'sparse' | 'unknown';

export interface EntryStateVector {
  /** Bumped per plan §4.6 whenever any field semantic changes. */
  schema_version: string;
  /** Anchor timestamp — must match snap.timestamp_unix that produced it. */
  timestamp_unix: number;
  direction: 'long' | 'short';
  setup_type: SetupType;

  // ── Volatility scales ────────────────────────────────────────────────
  /** Blended volatility scale used for z-scoring and stop sizing. */
  sigma_pts: number;
  /** Raw 1m ATR_14 at signal time, passed through for diagnostics. */
  micro_atr: number | null;
  /** Room-scale ATR from existing three-family normalization. */
  room_atr: number | null;
  /** Session-scale ATR from existing three-family normalization. */
  session_atr: number | null;

  // ── Direction-aware geometric z-scores ───────────────────────────────
  //
  // Sign convention: for LONGS, z_ema9 = (price - ema9) / sigma_pts;
  // for SHORTS the sign is flipped so that both directions share the
  // same semantic: NEGATIVE = price has undercut EMA9 (past the pullback
  // tag), POSITIVE = price is still on the "trend" side of EMA9.
  //
  // This is the minimum convention the symmetry property test relies on:
  // mirrored price inputs produce mirrored z-scores on long and short.
  z_ema9: number | null;
  z_ema21: number | null;
  z_vwap: number | null;

  // ── Pullback structure (populated in Phase 3 rewrite) ────────────────
  /** (price − pullback_low) / (impulse_high − pullback_low), long sign. */
  pullback_ratio: number | null;
  /** Bars since the last impulse swing that initiated this pullback. */
  impulse_maturity_bars: number | null;

  // ── Regime hook (plan §2 regime field on day one) ────────────────────
  regime: MarketRegime | null;

  // ── Orderflow (Phase 2 populates; Phase 1 emits null) ────────────────
  ofi_10s: number | null;
  ofi_30s: number | null;
  z_ofi_10s: number | null;
  z_ofi_30s: number | null;
  /** Blended OFI score used as the third expectancy bucket dimension. */
  z_ofi_blend: number | null;
  queue_imbalance_5: number | null;
  /** Microprice − mid, in points, direction-signed like z_ema9. */
  microprice_offset_pts: number | null;

  // ── LOB provenance (§4.4) ────────────────────────────────────────────
  lob_state: EntryStateLobState;
  ofi_reliability: EntryStateOfiReliability;

  // ── Orderflow readiness (Phase 4) ───────────────────────────────────
  /** True when the rolling OFI buffer has enough samples for z-scores. */
  orderflow_buffer_ready?: boolean;
  /** Number of OFI window samples currently in the rolling buffer. */
  orderflow_buffer_sample_count?: number;
  /** True when the buffer was restored from disk (shutdown persist or LOB replay). */
  orderflow_buffer_restored?: boolean;
}

export interface CandidateSetup {
  direction: Direction;
  setup_type: SetupType;
  entry_low: number;
  entry_high: number;
  stop: number;
  target_1: number;
  target_2: number;
  target_3: number | null;
  risk_pts: number;
  rr_t1: number;
  rr_t2: number;
  confidence: number;
  confidence_factors: string[];
  reason: string;
  // Validation flags (added for data-integrity guarantees)
  target_1_direction_valid: boolean;
  target_2_direction_valid: boolean;
  target_3_direction_valid: boolean;
  rr_validation_passed: boolean;
  /**
   * True when T2 is further from entry than T1 (and T3 further than T2 if present).
   * False means partial-exit logic can misbehave (T2 exits before T1 partial fill).
   */
  target_ordering_valid: boolean;
  /**
   * True when any target was replaced with a computed fallback to restore correct ordering.
   */
  target_repair_applied: boolean;
  /** Human-readable description of any repairs made. Empty string if none. */
  target_repair_reason: string;
  /** Optional HTF zone evaluation attached during candidate scoring. */
  htfEval?: HtfSetupEvaluation | null;
  freshness?: TrendFreshnessResult | null;
  /**
   * Frozen entry state vector from features/entry-state.ts, attached at
   * signal-generation time by trend_pullback_long/short (Phase 1). Null
   * for strategies that have not yet been wired into the quant pipeline
   * — management and telemetry code must handle null gracefully.
   */
  entry_state_vector?: EntryStateVector | null;

  // ── Parallel quant reward contract (Phase 4 of the trend-pullback refactor) ──
  //
  // Populated for trend_pullback_long/short candidates when sigma_pts is
  // computable. These fields NEVER overwrite the legacy `stop` / `target_*`
  // / `rr_*` / `risk_pts` fields during Stages A and B — they live in
  // parallel until a Stage C single-assignment-point copy (plan §3).
  //
  // Nulls mean "quant pipeline did not produce a value" — either because
  // the state vector was unavailable or the strategy isn't part of the
  // Phase 4 rollout. Downstream consumers must handle nulls gracefully.
  /** Quant initial stop from features/initial-risk.ts (tighter-of-both). */
  stop_quant?: number | null;
  /** Cold-start target_1 — entry ± 0.7·sigma_pts. */
  target_1_quant?: number | null;
  /** Cold-start target_2 — entry ± 1.4·sigma_pts. */
  target_2_quant?: number | null;
  /** |entry − stop_quant|, computed AFTER tick rounding. */
  risk_pts_quant?: number | null;
  /** |target_1_quant − entry| / risk_pts_quant, computed AFTER tick rounding. */
  rr_t1_quant?: number | null;
  /** |target_2_quant − entry| / risk_pts_quant, computed AFTER tick rounding. */
  rr_t2_quant?: number | null;
  /**
   * Source tag for the quant expectancy estimate:
   *   - `'cold_start'`: no bucket table available — Phase 4 only.
   *   - `'full'` / `'backoff_1d'` / `'backoff_2d'` / `'side_prior'`:
   *     Phase 6 expectancy engine hierarchical fallback levels.
   *
   * Note on `target_*_quant` provenance: Phase 4's HARD RULE says
   * empirical bucket-conditioned targets are forbidden until a plan
   * update. So even when this field is `'full'`, the target_*_quant
   * values still come from the 0.7σ / 1.4σ cold-start formulas.
   * bucket_source_quant describes ONLY the source of the expectancy
   * estimate, not the targets.
   */
  bucket_source_quant?:
    | 'cold_start'
    | 'full'
    | 'backoff_1d'
    | 'backoff_2d'
    | 'side_prior'
    | null;

  /**
   * Diagnostic tag describing the bucket lookup outcome. Always populated
   * when quant_entry is active. Used by the Stage A evaluator debug export.
   */
  bucket_lookup_status?:
    | 'full_match'
    | 'backoff_1d'
    | 'backoff_2d'
    | 'side_prior'
    | 'cold_start_no_match'
    | null;

  // ── Phase 6 quant expectancy contract ────────────────────────────────
  //
  // Populated by the expectancy engine (features/expectancy-engine.ts)
  // when a bucket table is loaded. `expected_r_30s_quant` is the
  // POST-COST expectancy at the 30-second horizon per plan §10/11:
  //   E[R_post] = E[R_raw] − (fees + slippage) / risk_pts_quant
  // `win_prob_30s_quant` is the raw (no cost subtraction) empirical
  // fraction of samples in the bucket with positive forward return.
  //
  // Nulls mean "bucket table unavailable or state vector missing".
  // `quality_band_quant` is derived from expected_r / win_prob and is
  // one of 'A' | 'B' | 'C' | 'D' — 'D' covers both cold buckets and
  // sub-threshold empirical buckets.
  /** Post-cost expected R at 30s from the expectancy engine. */
  expected_r_30s_quant?: number | null;
  /** Empirical win probability at 30s for the resolved bucket. */
  win_prob_30s_quant?: number | null;
  /** Quality band derived from expectancy + win probability. */
  quality_band_quant?: 'A' | 'B' | 'C' | 'D' | null;
  /** Canonical bucket id string (serialized 3D or fallback key). */
  bucket_id_quant?: string | null;
  /** Number of historical samples backing the resolved bucket. */
  bucket_sample_count_quant?: number | null;
  /**
   * Shadow telemetry tag written by the Phase 6 expectancy engine and
   * the Phase 8 `deriveExpectancyVerdict` helper. Phase 6 only POPULATES
   * this — it does not block execution. Phase 7 Stage A treats it as
   * pure telemetry; Phase 7 Stage B AND-gate consumes it via
   * `combineVerdicts` when `hybrid_gate = true`.
   * Values:
   *   - null when the candidate would pass (or when the engine is a no-op)
   *   - 'rejected_by_bucket_sparsity' when the terminal fallback is
   *     side_prior AND expected_r_30s_quant < side_prior_min_expected_r
   *   - 'rejected_by_expectancy_below_threshold' when a non-side-prior
   *     tier (full / backoff_1d / backoff_2d) resolves but the post-cost
   *     expectancy is below quant_entry.expectancy.min_expected_r_primary
   *     (Phase 8 Stage A operationalization — plan §11)
   *   - 'rejected_by_missing_cost_config' when ContractSpec fees /
   *     slippage are unavailable (fail-closed cost term)
   */
  quant_shadow_reject_reason?:
    | null
    | 'rejected_by_bucket_sparsity'
    | 'rejected_by_expectancy_below_threshold'
    | 'rejected_by_missing_cost_config';

  // ── Phase 7 telemetry ─────────────────────────────────────────────────
  //
  // Populated only when `quant_entry.enabled = true` (plan §5 Phase 7).
  // When the flag is off, both fields remain undefined and the logs
  // are diff-free relative to the post-Phase-6 baseline.
  /**
   * Reproducible hash over the canonically-serialized entry state
   * vector (plan §4.6 / §15). Used to link shadow and live rows to the
   * exact feature bundle that drove the decision across replay runs.
   */
  entry_state_vector_hash?: string | null;
  /**
   * Combined Phase 7 shadow decision — per-gate verdicts + reasons +
   * the overall AND-gate verdict that Stage B would produce. Phase 7
   * only POPULATES this; Phase 7 Stage B gate consumes
   * `shadow_decision.combined_verdict` when `hybrid_gate = true` to
   * modify `signal.no_trade` / `signal.reason_for_skip` in runner.ts.
   * Legacy `stop` / `target_*` / `rr_*` / `confidence` are never
   * touched regardless of the verdict.
   */
  quant_shadow_decision?:
    | import('./features/quant-shadow-decision.js').QuantShadowDecision
    | null;
  /**
   * Number of completed 1m bars since the last bearish 1m SuperTrend flip,
   * populated by setups that care about reversal timing (currently
   * post_flip_first_pullback_short). Used by the shaped reversal-transition
   * bonus in applyContextualScoreAdjustments(). Null/undefined when the
   * setup does not track flip timing.
   */
  bars_since_flip?: number | null;
  generator_diagnostic?: CandidateGeneratorDiagnostic | null;
  rejections_by_setup?: Record<string, string[]>;
  top_rejection_reason?: string | null;
  count_rejections_this_cycle?: number;

  // ── lob_mbo_scalp family (Phase 3a: additive; consumers land in Phase 3b+) ──
  //
  // The real types live in future files that do not yet exist:
  //   - ScalperStateVector      → src/autotrade/features/scalper-state.ts (Phase 2)
  //   - ScalperShadowDecision   → src/autotrade/features/scalper-shadow-decision.ts (Phase 5)
  //
  // They are typed `unknown | null` here so Phase 3a is compile-clean with
  // zero import dependency on unbuilt modules. When Phase 2 / Phase 5 land,
  // narrow these to the real interfaces in a single focused edit. Any
  // consumer that reads these fields MUST tolerate `unknown` (i.e. narrow
  // before use) until the narrowing happens.
  /**
   * Scalper microstructure state vector attached at signal-generation time
   * by the lob_mbo_scalp generators. Null on non-scalper candidates.
   */
  scalper_state_vector?: unknown | null;
  /**
   * Scalper shadow-decision record bundling deterministic gate, persistence
   * gate, ML gate, expectancy, and the single combined verdict from
   * `shouldAllowScalperEntry`. Null on non-scalper candidates.
   */
  scalper_shadow_decision?: unknown | null;
  /**
   * True iff the entry-side gate observed an absorption+refill confirmation
   * at candidate time. ScalperExitEngine uses this to pick between the base
   * `scalper_hard_cap_seconds` and the extended `time_stop_seconds` hold cap
   * when the trade is live. Null on non-scalper candidates.
   */
  scalper_extended_cap_eligible?: boolean | null;
}

// ─── Dual-Direction Confluence Model ────────────────────────────────────────

/**
 * Configurable scoring weights for the confidence scorer.
 *
 * Every field maps to a specific factor in scoreConfidenceDetailed().
 * All fields are optional — missing fields fall back to DEFAULT_SCORING_WEIGHTS
 * (defined in strategy.ts), which reproduce the original hardcoded behavior.
 */
export interface ScoringWeights {
  /** Starting score before any factors are applied. */
  base: number;

  // ── Timeframe alignment ──────────────────────────────────────────────────
  /** Bonus when all 4 TFs agree on direction. */
  tf_alignment_4tf: number;
  /** Bonus when 3 of 4 TFs agree. */
  tf_alignment_3tf: number;
  /** Bonus when 2 of 4 TFs agree. */
  tf_alignment_2tf: number;
  /** Penalty when fewer than 2 TFs agree. */
  tf_alignment_weak: number;

  // ── Higher-TF direction ──────────────────────────────────────────────────
  /** Penalty when 1h bias conflicts with trade direction. */
  htf_direction_conflict: number;

  // ── SuperTrend ───────────────────────────────────────────────────────────
  /** Bonus when SuperTrend confirms trade direction. */
  supertrend_confirms: number;
  /** Penalty when SuperTrend opposes trade direction. */
  supertrend_opposes: number;

  // ── Structural level ─────────────────────────────────────────────────────
  /** Bonus when price is at a favorable BOS structural level. */
  structural_level_bonus: number;

  // ── R:R quality ──────────────────────────────────────────────────────────
  /** Bonus for RR >= min_rr * 1.5 (excellent). */
  rr_excellent: number;
  /** Bonus for RR >= min_rr (acceptable). */
  rr_acceptable: number;
  /** Penalty for RR below min_rr. */
  rr_below_min: number;

  // ── Volume ───────────────────────────────────────────────────────────────
  /** Bonus for strong volume. */
  volume_strong: number;
  /** Penalty for thin volume. */
  volume_thin: number;

  // ── Missing indicators ───────────────────────────────────────────────────
  /** Penalty when >= 3 baseline indicators are missing. */
  missing_indicators_many: number;
  /** Penalty when 1-2 baseline indicators are missing. */
  missing_indicators_some: number;

  // ── Entry location ───────────────────────────────────────────────────────
  /** Penalty when price is far from the entry zone midpoint. */
  entry_location_suboptimal: number;

  // ── Regime ───────────────────────────────────────────────────────────────
  /** Bonus when regime aligns with trade direction (trending_X / breakout_attempt). */
  regime_aligned: number;
  /** Penalty in choppy or high-volatility-impulse regimes. */
  regime_adverse: number;

  // ── Swing structure ──────────────────────────────────────────────────────
  /** Bonus for trending swing structure (lower highs / higher lows on 5m). */
  swing_structure_trend: number;
  /** Bonus for price being below swing high (short) / above swing low (long). */
  swing_structure_level: number;

  // ── Direction-specific factors ─────────────────────────────────────────
  /** Bonus when VWAP supports the trade direction (price > VWAP for long, < VWAP for short). */
  vwap_supports: number;
  /** Penalty when VWAP opposes the trade direction (price < VWAP for long, > VWAP for short). */
  vwap_opposes: number;
  /** Bonus when price is near a favorable Opening Range level (OR_low for long, OR_high for short). */
  or_level_supports: number;

  // ── ADX / DMI ───────────────────────────────────────────────────────────
  /** Bonus when ADX > 25 and regime aligns with trade direction. */
  adx_strong_trend: number;
  /** Penalty when ADX < 15 (no directional conviction). */
  adx_weak_trend: number;
  /** Bonus when DI confirms trade direction (+DI > -DI for long, vice versa). */
  adx_di_confirms: number;

  // ── TTM Squeeze ─────────────────────────────────────────────────────────
  /** Penalty during active TTM Squeeze (compression, low volatility). */
  ttm_squeeze_penalty: number;
  /** Bonus when squeeze releases with momentum aligned to trade direction. */
  ttm_squeeze_release: number;

  // ── CVD ─────────────────────────────────────────────────────────────────
  /** Penalty when price direction and CVD diverge. */
  cvd_divergence: number;
  /** Bonus when CVD confirms trade direction. */
  cvd_aligned: number;
  /** Narrow ETH short reversal relief when HTF conflict is transitional, not disqualifying. */
  htf_conflict_transition_relief: number;
  /** Small contextual bonus for the first ETH reversal pullback after a fresh flip. */
  reversal_transition_bonus: number;
  /** Maximum total positive uplift from contextual reversal adjustments. */
  contextual_positive_cap: number;
  /**
   * Centre of the Gaussian shaping the reversal_transition_bonus by
   * bars_since_flip. The full `reversal_transition_bonus` is awarded at
   * exactly this many bars; fewer or more bars produce a smaller bonus.
   */
  reversal_bonus_peak_bars_since_flip?: number;
  /**
   * Standard deviation (in bars) of the Gaussian shaping the
   * reversal_transition_bonus. Larger σ → gentler rolloff.
   */
  reversal_bonus_sigma_bars?: number;
}

/**
 * Score breakdown for a directional candidate, showing every factor
 * that contributed to the final confidence score.
 */
export interface ScoreBreakdown {
  base: number;
  tf_alignment: number;
  htf_direction: number;
  supertrend: number;
  structural_level: number;
  rr_quality: number;
  volume: number;
  missing_indicators: number;
  entry_location: number;
  regime_alignment: number;
  swing_structure: number;
  vwap_position: number;
  or_level: number;
  adx_trend_strength: number;
  ttm_squeeze: number;
  cvd_alignment: number;
  pre_context_total?: number;
  vwap_soft_penalty?: number;
  htf_conflict_relief?: number;
  reversal_transition_bonus?: number;
  contextual_positive_cap_applied?: number;
  total: number;
  factors: string[];
  /**
   * Feature set tag for A/B comparison.
   * 'full' = all scoring factors active (current default).
   * 'simplified' = tier-3 factors zeroed out (future experiment).
   * Logged on every signal for post-hoc performance comparison.
   */
  feature_set: 'full' | 'simplified';
}

/**
 * A candidate setup enriched with a full score breakdown, used in
 * dual-direction comparison.
 */
export interface DirectionalCandidate {
  setup: CandidateSetup;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  hardGateFailures: string[];
  passedHardGates: boolean;
  score_pre_context?: number;
  score_post_context?: number;
  min_score_threshold?: number;
  score_passed?: boolean;
  vwap_soft_penalty?: number;
  htf_conflict_relief?: number;
  reversal_transition_bonus?: number;
  contextual_positive_cap_applied?: number;
  layered_pre_context_total?: number | null;
  layered_post_context_total?: number | null;
  /** Dynamic reward plan built at candidate evaluation time (null when disabled). */
  rewardPlan: import('./features/dynamic-reward-plan.js').DynamicRewardPlan | null;
  /** Layered score result (populated when layered_scoring shadow_log or enabled is true). */
  layered?: import('./features/layered-scoring.js').LayeredScoreResult;
  /** HTF zone evaluation for this candidate (null when study absent or HTF disabled). */
  htfEval?: HtfSetupEvaluation | null;
  generatorDiagnostics?: CandidateGeneratorDiagnostic[];
  rejection_reason_primary?: string | null;
  rejection_reason_all?: string[];
  rejections_by_setup?: Record<string, string[]>;
  top_rejection_reason?: string | null;
  count_rejections_this_cycle?: number;
  decision_stage?: DecisionStage;
  decision_reason_primary?: string | null;
  decision_reason_all?: string[];
  cooldown_passed?: boolean;
  extension_passed?: boolean;
  position_open_blocked?: boolean;
  execution_allowed_final?: boolean;
  selection_only?: boolean;
  reversal_package_suppressed_by_warmup?: boolean;
  reversal_package_suppressed_reason?: string | null;
  reversal_package_attributable?: boolean;
  reversal_package_attribution_flags?: string[];
}

/**
 * Decision outcome from the dual-direction comparison.
 */
export type DualDirectionDecision =
  | 'enter_long'
  | 'enter_short'
  | 'wait_no_candidates'
  | 'wait_no_gates_passed'
  | 'wait_below_min_score'
  | 'wait_below_execution_floor'
  | 'wait_insufficient_margin'
  | 'wait_both_weak'
  | 'wait_cooldown'
  | 'wait_same_bar_reversal';

/**
 * Result of the dual-direction evaluation for a single analysis cycle.
 * Both sides are always evaluated; the decision logic picks the winner.
 */
export interface DualDirectionResult {
  regime: MarketRegime;
  bias: MultiTfBias;
  /** Best long candidate (null if no long generators fired). */
  bestLong: DirectionalCandidate | null;
  /** Best short candidate (null if no short generators fired). */
  bestShort: DirectionalCandidate | null;
  /** The chosen side (null if WAIT). */
  chosen: DirectionalCandidate | null;
  /** The losing side for logging (null if no comparison). */
  opposing: DirectionalCandidate | null;
  /** Why this decision was made. */
  decision: DualDirectionDecision;
  /** Human-readable reason for the decision. */
  decisionReason: string;
  /** Score margin between chosen and opposing (0 if no comparison). */
  scoreMargin: number;
  /** Legacy: the best setup for backward-compat (same as chosen?.setup). */
  bestSetup: CandidateSetup | null;
  confidence: number;
  tradeAllowed: boolean;
  skipReasons: string[];
  mlFeatures: SignalContextSnapshot;
  score_passed?: boolean;
  cooldown_passed?: boolean;
  extension_passed?: boolean;
  position_open_blocked?: boolean;
  execution_allowed_final?: boolean;
  /**
   * True when the candidate passed its session-specific selection floor but
   * failed the global `dual_min_score` execution floor. Such candidates are
   * forwarded for logging/replay but NOT executed.
   */
  selection_only?: boolean;
  decision_stage?: DecisionStage;
  decision_reason_primary?: string | null;
  decision_reason_all?: string[];
  rejections_by_setup?: Record<string, string[]>;
  top_rejection_reason?: string | null;
  count_rejections_this_cycle?: number;
  candidate_diagnostics?: CandidateGeneratorDiagnostic[];
  /** Whether upstream dynamic RR was active for this signal cycle. */
  dynamicRrUpstreamActive: boolean;
  /** Source of the upstream dynamic RR config: 'default' | 'config' | 'argument' | 'explicit_disable'. */
  dynamicRrSource: string;
}

// ─── Signal (logged for every cycle) ────────────────────────────────────────

export interface Signal {
  signal_id: string;
  session_id: string;
  timestamp: string;
  unix_ts: number;
  symbol: string;
  mode: ExecutionMode;
  strategy_version: string;
  indicator_config_version: string;
  market_regime: MarketRegime;
  higher_timeframe_bias: MultiTfBias;
  current_price: number;
  indicator_snapshot_1m: IndicatorSnapshot;
  indicator_snapshot_1h: IndicatorSnapshot;
  key_levels: KeyLevels;
  candidate_setup: CandidateSetup | null;
  confidence: number;
  trade_allowed: boolean;
  reason_for_skip: string | null;
  execution_occurred: boolean;
  no_trade: boolean;
  near_miss_filters_failed: string[];
  score_passed?: boolean;
  cooldown_passed?: boolean;
  extension_passed?: boolean;
  position_open_blocked?: boolean;
  execution_allowed_final?: boolean;
  selection_only?: boolean;
  decision_stage?: DecisionStage;
  decision_reason_primary?: string | null;
  decision_reason_all?: string[];
  rejections_by_setup?: Record<string, string[]>;
  top_rejection_reason?: string | null;
  count_rejections_this_cycle?: number;
  score_pre_context?: number | null;
  score_post_context?: number | null;
  vwap_soft_penalty?: number | null;
  htf_conflict_relief?: number | null;
  reversal_transition_bonus?: number | null;
  contextual_positive_cap_applied?: number | null;
  reversal_package_suppressed_by_warmup?: boolean;
  reversal_package_suppressed_reason?: string | null;
  reversal_package_attributable?: boolean;
  reversal_package_attribution_flags?: string[];
  // ML features
  ml_features: SignalContextSnapshot;
  // filled after trade closes
  outcome_label: string | null;
  config_type: 'BASELINE' | 'EXPERIMENTAL';
  // ── Dual-direction fields ─────────────────────────────────────────────────
  dual_direction_decision?: DualDirectionDecision;
  dual_long_score?: number | null;
  dual_short_score?: number | null;
  dual_score_margin?: number;
}

/**
 * Signal-time context snapshot for logging and post-hoc analysis.
 * NOT used for ML inference — the canonical ML feature vectors are in:
 *   - src/autotrade/ml/types.ts (management inference)
 *   - src/autotrade/ml-entry/types.ts (entry inference)
 */
export interface SignalContextSnapshot {
  price_vs_ema9_1m: number | null;
  price_vs_ema21_1m: number | null;
  price_vs_ema50_1m: number | null;
  price_vs_ema200_1h: number | null;
  supertrend_dir_1m: string | null;
  supertrend_dir_1h: string | null;
  all_tf_aligned: boolean;
  alignment_score: number;
  session_high_distance_pts: number | null;
  session_low_distance_pts: number | null;
  choch_buy_distance_pts: number | null;
  choch_sell_distance_pts: number | null;
  bos_sell_distance_pts: number | null;
  volume_last_1m: number | null;
  regime: MarketRegime;
  htf_alignment: boolean;
  rr_t1: number | null;
  rr_t2: number | null;
  setup_type: SetupType | null;
  bar_direction_5m_last: 'up' | 'down' | 'doji' | null;
  bar_direction_15m_last: 'up' | 'down' | 'doji' | null;
  // HTF zone context
  htf_study_present: boolean | null;
  htf_inside_resistance: boolean | null;
  htf_inside_support: boolean | null;
  htf_nearest_res_tf: string | null;
  htf_nearest_sup_tf: string | null;
  htf_nearest_obstacle_tf: string | null;
  htf_nearest_obstacle_kind: string | null;
  htf_distance_res_pts: number | null;
  htf_distance_sup_pts: number | null;
  htf_distance_res_atr: number | null;
  htf_distance_sup_atr: number | null;
  htf_first_obstacle_rr: number | null;
  htf_location_quality: string | null;
  htf_veto_reason: string | null;
  htf_breakout_accepted: boolean | null;
}

// ─── Position & Trade ────────────────────────────────────────────────────────

/**
 * One discrete exit transaction — either a partial fill (PT1, PT2, T1-partial)
 * or the final close.  The sum of all legs' pnl_usd equals the trade's
 * total realized PnL.
 */
export interface ExitLeg {
  /** Exit reason that triggered this leg. */
  reason: ExitReason;
  /** Number of contracts exited in this leg. */
  quantity: number;
  /** Actual fill price for this leg. */
  fill_price: number;
  /** ISO timestamp of this leg's fill. */
  fill_time_iso: string;
  /** (fill_price − entry_price) × side_sign — signed points per unit. */
  pnl_points: number;
  /** Net USD realized from this leg (pnl_points × qty × point_value − fee_usd). */
  pnl_usd: number;
  /** Brokerage/exchange fee charged for this leg. */
  fee_usd: number;
  /** Absolute slippage vs. planned price (pts). 0 if unknown. */
  slippage_pts: number;
}

// ─── Management event instrumentation ──────────────────────────────────────

export type ManagementEventType =
  | 'pt1_trigger' | 'pt2_trigger'
  | 'pre_t1_be_move' | 'pre_t1_trail_activation'
  | 'post_pt1_trail_activation' | 'trail_ratchet'
  | 'final_runner_exit'
  // ── Dead-Trade Guard (pre-PT1 failure-to-launch) ──────────────────────
  /** Lane A: soft review — logs weak progress; never flattens. */
  | 'failure_review_soft'
  /** Lane B/C: live flatten via failure-to-launch. */
  | 'failure_exit'
  /** Lane B/C: shadow-mode hypothetical flatten (no real exit). */
  | 'failure_exit_shadow';

export interface ManagementEvent {
  row_type: 'management_event';
  timestamp: string;
  trade_id: string;
  event_type: ManagementEventType;
  setup_type: string;
  management_profile: string;
  side: 'long' | 'short';
  entry_price: number;
  current_price: number;
  stop_before: number;
  stop_after: number;
  quantity_before: number;
  quantity_after: number;
  realized_pnl_so_far: number;
  unrealized_pnl_pts: number;
  unrealized_r: number;
  mfe_pts: number;
  mae_pts: number;
  atr_at_entry: number | null;
  trail_distance_pts: number | null;
  pt1_trigger_pts: number | null;
  pt2_trigger_pts: number | null;
  // ── Dead-Trade Guard snapshot (set on failure_review_soft / failure_exit /
  //    failure_exit_shadow events only; null for all other event types) ────
  failure_lane?: 'soft' | 'hard' | 'emergency';
  failure_reason?: string | null;
  hold_minutes_at_event?: number;
  current_r_at_event?: number;
  peak_r_at_event?: number;
  mae_r_at_event?: number;
  failure_ratio_at_event?: number;
  progress_rate_at_event?: number;
  recovery_gap_at_event?: number;
  decay_rate_at_event?: number;
  /** Interpolated Q20_peak_win(t) at event time, or null if curve unavailable. */
  q20_peak_at_event?: number | null;
  /** Interpolated Q80_mae_win(t) at event time, or null if curve unavailable. */
  q80_mae_at_event?: number | null;
}

export interface Position {
  trade_id: string;
  signal_id: string;
  session_id: string;
  side: 'long' | 'short';
  entry_price: number;
  entry_time_unix: number;
  entry_time_iso: string;
  stop_initial: number;
  stop_current: number;
  target_1: number;
  /** Planned first profit target at entry (frozen from setup). */
  planned_target_1?: number;
  /** Effective first partial target after any intra-trade adjustments. */
  effective_target_1?: number | null;
  /** Fill price of the first partial exit (PT1), when taken. */
  first_partial_fill_price?: number | null;
  target_2: number;
  target_3: number | null;
  quantity: number;
  notional: number;
  setup_type: SetupType;
  market_regime_at_entry: MarketRegime;
  config_version: string;
  confidence: number;
  stop_moved_to_be: boolean;
  partial_exit_done: boolean;
  quantity_remaining: number;
  max_favorable_excursion: number; // pts
  max_adverse_excursion: number;   // pts
  last_checked_price: number;
  time_stop_minutes: number; // exit if stalled beyond this
  // ── Pre-T1 profit protection state ─────────────────────────────────────
  /** True once breakeven was triggered pre-T1 (via breakeven_trigger_r). */
  pre_t1_be_triggered: boolean;
  /** True once pre-T1 trailing is active (via pre_t1_trail_trigger_r). */
  pre_t1_trailing_active: boolean;
  // ── Trailing-stop state (post-T1) ───────────────────────────────────────
  /** True once trailing logic has engaged (after partial / at a profit peg). */
  trailing_active: boolean;
  /** Trailing stop distance expressed in whole ticks (0 if not set). */
  trail_distance_ticks: number;
  /** Peak favorable price used to anchor the trailing stop. */
  trail_anchor_price: number | null;
  // Target validity (copied from candidate setup at entry)
  target_1_direction_valid: boolean;
  target_2_direction_valid: boolean;
  target_3_direction_valid: boolean;
  target_ordering_valid: boolean;
  target_repair_applied: boolean;
  // ── Partial-profit scaling state ──────────────────────────────────────────
  /** True once PT1 partial has been taken. */
  pt1_done: boolean;
  /** True once PT2 partial has been taken. */
  pt2_done: boolean;
  /** USD realized from PT1 partial (for logging). */
  pt1_realized_pnl: number;
  /** USD realized from PT2 partial (for logging). */
  pt2_realized_pnl: number;
  /** Quantity exited at PT1. */
  pt1_qty_exited: number;
  /** Quantity exited at PT2. */
  pt2_qty_exited: number;
  // ── Fill-based accounting (accumulated across legs) ───────────────────────
  /** All exit legs recorded so far (partial fills + final close). */
  exit_legs: ExitLeg[];
  /** Running total of realized PnL from all completed exit legs (USD). */
  realized_pnl_so_far: number;
  /** Running total of fees from all completed exit legs (USD). */
  realized_fees_so_far: number;
  // ── Management profile (resolved at entry) ─────────────────────────────
  /** ATR(14) at entry time, used to resolve ATR-relative management params. */
  atr_at_entry: number | null;
  /** Resolved management params frozen at entry. All exit logic reads from here. */
  management_params: ResolvedManagementParams;
  // ── Follow-through instrumentation (captured at PT1/partial time) ─────
  /** MFE at the moment PT1 fires (captures how much of the move was available pre-PT1). */
  mfe_at_pt1_trigger: number;
  /** MAE at the moment PT1 fires. */
  mae_at_pt1_trigger: number;
  /** Continuously tracked peak R before any partial exit fires. */
  peak_r_before_first_partial: number;
  // ── Dead-Trade Guard telemetry (pre-PT1 failure-to-launch) ─────────────
  // All times in minutes; all rates in R/min. Updated every evaluation cycle.
  /** Minutes since entry at which currentR first became ≥ 0. Null until reached. */
  time_to_first_positive_r_minutes: number | null;
  /** Minutes since entry at which peak_r_before_first_partial was last updated. */
  t_peak_r_minutes: number | null;
  /** Minutes since entry at which peak was first observed (frozen after first peak). */
  time_to_peak_r_before_first_partial_minutes: number | null;
  /** MAE expressed in R (computed each cycle pre-partial; last-seen value). */
  mae_r_before_first_partial: number;
  /** Last-computed progressRate (R/min) from the failure-exit state vector. */
  last_progress_rate_r_per_min: number;
  /** Last-computed drawdownRate (R/min). */
  last_drawdown_rate_r_per_min: number;
  /** Last-computed failureRatio = (maeR + ε) / (peakR + ε). */
  last_failure_ratio: number;
  /** Last-computed netProgress = currentR − λ · maeR. */
  last_net_progress: number;
  /** Last-computed efficiency = peakR / (maeR + ε). */
  last_efficiency: number;
  /** Last-computed recoveryGap = peakR − currentR. */
  last_recovery_gap: number;
  /** Last-computed decayRate (R/min since peak; 0 if gating condition not met). */
  last_decay_rate_r_per_min: number;
  // ── Dead-Trade Guard per-lane single-fire latches ─────────────────────
  /** Lane A fired at least once (soft review was emitted). */
  failure_review_soft_emitted: boolean;
  /** Lane B fired at least once (shadow or live). */
  failure_exit_hard_fired: boolean;
  /** Lane C fired at least once (shadow or live). */
  failure_exit_emergency_fired: boolean;
  /**
   * Lane that caused the LIVE flatten, or 'none' if no live flatten occurred.
   * Soft is deliberately excluded: soft never flattens, so it is not a valid
   * value here (see plan §"same-cycle precedence").
   */
  failure_exit_active_lane: 'none' | 'hard' | 'emergency';
  /** Reason string from the first non-soft fire (shadow or live), or null. */
  failure_exit_reason: string | null;
  /** Minutes since entry at the first non-soft fire, or null. */
  failure_exit_trigger_time_minutes: number | null;
  /** True if ANY failure-exit fire was shadow-only (never flattened live). */
  failure_exit_shadow_only: boolean;
  /** Management variant label for A/B comparison. */
  management_variant?: string;

  // ── lob_mbo_scalp family (Phase 3a: additive; wired in Phase 6) ──────────
  // All fields are optional and null/false on non-scalper positions.
  /**
   * True if the entry-side gate observed absorption+refill confirmation,
   * allowing ScalperExitEngine to use the extended `time_stop_seconds` cap
   * instead of the base `scalper_hard_cap_seconds`. Copied from
   * CandidateSetup.scalper_extended_cap_eligible at fill time.
   */
  scalper_extended_cap?: boolean;
  /** Frozen microstructure stop distance in ticks (entry-time resolved). */
  scalper_stop_ticks?: number | null;
  /** Frozen microstructure target distance in ticks (entry-time resolved). */
  scalper_target_ticks?: number | null;
  /**
   * Single-flight exit guard for the fast scalper monitor loop. When true,
   * the runner suppresses any additional exit intents (from the scalper
   * monitor, trend monitor, or fill-event callback) until the broker acks
   * the in-flight order. See plan Phase 6 "Single-flight exit guard".
   */
  exit_intent_in_flight?: boolean;
  /** Reason tag of the exit intent currently in flight (for audit). */
  exit_intent_reason?: ExitReason | null;
  /**
   * Earliest wall-clock ms (Date.now()) at which a new exit intent may be
   * armed after a broker reject. Prevents tight retry loops. Null when no
   * retry backoff is active.
   */
  exit_retry_backoff_until_ms?: number | null;
}

export interface OrderResult {
  order_id: string;
  fill_price: number;
  fill_time_iso: string;
  quantity: number;
  side: 'long' | 'short';
  slippage_pts: number;
  fee_usd: number;
  status: 'filled' | 'rejected' | 'simulated';
}

export interface TradeRecord {
  trade_id: string;
  parent_signal_id: string;
  session_id: string;
  strategy_version: string;
  indicator_config_version: string;
  mode: ExecutionMode;
  timestamp_signal: string;
  timestamp_entry: string;
  timestamp_exit: string;
  symbol: string;
  venue: string;
  side: 'long' | 'short';
  setup_type: SetupType;
  market_regime: MarketRegime;
  confidence_score: number;
  entry_price_planned: number;
  entry_price_filled: number;
  stop_price_initial: number;
  stop_price_final: number;
  target_1: number;
  target_2: number;
  target_3: number | null;
  quantity: number;
  notional_value: number;
  fee_estimate: number;
  fee_actual: number;
  slippage_estimate: number;
  slippage_actual: number;
  pnl_realized: number;
  pnl_percent: number;
  r_multiple: number;
  hold_time_seconds: number;
  exit_reason: ExitReason;
  /**
   * Granular exit label added by patch P3.
   * For stop exits, distinguishes whether the stop was the initial stop
   * (pre-T1), a breakeven stop (post-T1, trailing not armed), or a
   * trailing stop (post-T1, trailing active). Non-stop exits mirror
   * exit_reason exactly.
   *
   * Older logs that predate P3 will not have this field; always coalesce
   * with exit_reason for backward-compatible reads.
   */
  exit_reason_detailed?: ExitReason;
  mfe: number;
  mae: number;
  // Outcome labels (ML)
  outcome_class: 'winner' | 'loser' | 'scratch';
  /**
   * True when the authoritative PT1 state completed (`pt1_done`) or legacy
   * `applyPartialExit` set `partial_exit_done` (target_1 partial).
   */
  hit_target_1: boolean;
  /** Planned PT1 price at entry (audit trail). */
  planned_target_1?: number | null;
  /** Effective PT1 price after any intra-trade adjustment (null if PT1 never armed). */
  effective_target_1?: number | null;
  /** Fill price of the first partial exit leg when present. */
  first_partial_fill_price?: number | null;
  hit_target_2: boolean;
  stopped_out: boolean;
  exited_on_time_stop: boolean;
  regime_at_entry: MarketRegime;
  regime_at_exit: MarketRegime;
  confidence_bucket: 'high' | 'medium' | 'low';
  trend_alignment: boolean;
  config_type: 'BASELINE' | 'EXPERIMENTAL';
  notes: string;
  // ── Extended fields (added for data integrity + audit) ───────────────────
  /** Target/stop price the exit decision intended to hit. */
  exit_price_planned: number;
  /** Actual market price at which the exit fill was requested. */
  exit_price_actual: number;
  /** Points between planned exit and actual exit (execution slippage proxy). */
  exit_slippage_vs_plan_pts: number;
  /** Best unrealized R achieved during hold. */
  max_unrealized_r: number;
  /** Worst unrealized R reached during hold (negative). */
  max_drawdown_r: number;
  /** Target validation flags copied from the originating candidate setup. */
  target_1_direction_valid: boolean;
  target_2_direction_valid: boolean;
  target_3_direction_valid: boolean;
  /** Whether targets were in the correct sequential order. */
  target_ordering_valid: boolean;
  /** True if any target was repaired before execution. */
  target_repair_applied: boolean;
  // ── Fill-based accounting (optional; absent on pre-refactor records) ──────
  /**
   * Ordered list of all exit fills: partial exits followed by the final close.
   * Sum of all leg pnl_usd === pnl_realized.
   */
  exit_legs?: ExitLeg[];
  /** Total number of exit legs (1 = single full close, 2+ = partials + runner). */
  exit_legs_count?: number;
  /** Number of partial exits before the final close (0 for plain full exits). */
  partial_exit_count?: number;
  /** Net USD realized at PT1 partial.  null when no PT1 partial occurred. */
  pnl_pt1?: number | null;
  /** Net USD realized at PT2 partial.  null when no PT2 partial occurred. */
  pnl_pt2?: number | null;
  /** Net USD realized at the final (runner) close. */
  pnl_runner?: number;
  /** Sum of all leg fees. */
  total_fees_usd?: number;
  // ── Management profile audit ──────────────────────────────────────────
  /** Name of the management profile used for this trade. */
  management_profile?: string;
  /** ATR(14) at entry time (null if unavailable). */
  atr_at_entry?: number | null;
  // ── Follow-through analytics (requires instrumented position-manager) ──
  /** MFE at the moment PT1 fired (null if no PT1). */
  mfe_at_pt1?: number | null;
  /** MAE at the moment PT1 fired (null if no PT1). */
  mae_at_pt1?: number | null;
  /** Unrealized R at PT1 trigger moment (null if no PT1). */
  unrealized_r_at_pt1?: number | null;
  /** Additional MFE available after PT1 fired: total_mfe - mfe_at_pt1 (null if no PT1). */
  mfe_after_pt1?: number | null;
  /** Fraction of post-PT1 opportunity captured by runner: runner_pnl_pts / mfe_after_pt1 (null if no PT1). */
  runner_capture_ratio?: number | null;
  /** R given back after PT1: (peak_r_after_pt1 - final_runner_r). High = trail too tight. */
  giveback_after_pt1_r?: number | null;
  /** Peak unrealized R before any partial exit fired. */
  peak_unrealized_r_before_first_partial?: number | null;
  /** Management variant label for A/B comparison (e.g., 'baseline_tight_exit', 'conservative_wider_exit'). */
  management_variant?: string | null;
  // ── Dead-Trade Guard telemetry (pre-PT1 failure-to-launch) ───────────
  // Null for trades that exited before/without the feature being enabled.
  // Units: all *_minutes fields in minutes; all *_rate_* fields in R/min.
  time_to_first_positive_r_minutes?: number | null;
  time_to_peak_r_before_first_partial_minutes?: number | null;
  mae_r_before_first_partial?: number | null;
  last_progress_rate_r_per_min?: number | null;
  last_drawdown_rate_r_per_min?: number | null;
  last_failure_ratio?: number | null;
  last_net_progress?: number | null;
  last_efficiency?: number | null;
  last_recovery_gap?: number | null;
  last_decay_rate_r_per_min?: number | null;
  // Per-lane single-fire latches (booleans; true if ever fired on this trade)
  failure_review_soft_emitted?: boolean | null;
  failure_exit_hard_fired?: boolean | null;
  failure_exit_emergency_fired?: boolean | null;
  /** Lane that caused the LIVE flatten ('none' | 'hard' | 'emergency'). */
  failure_exit_active_lane?: 'none' | 'hard' | 'emergency' | null;
  /** Reason string from the first non-soft fire. */
  failure_exit_reason?: string | null;
  /** Minutes since entry at the first non-soft fire. */
  failure_exit_trigger_time_minutes?: number | null;
  /** True if ANY fire was shadow-only (never flattened live). */
  failure_exit_shadow_only?: boolean | null;
}

// ─── Session ─────────────────────────────────────────────────────────────────

export interface SessionRecord {
  session_id: string;
  prompt_version: string;
  strategy_version: string;
  indicator_config_version: string;
  mode: ExecutionMode;
  symbol: string;
  venue: string;
  timestamp_start: string;
  timestamp_end: string | null;
  live_trading_enabled: boolean;
  total_signals: number;
  total_trades: number;
  wins: number;
  losses: number;
  scratches: number;
  total_pnl_usd: number;
  daily_loss_pct: number;
  daily_loss_limit_pct: number;
  shutdown_reason: string | null;
  // ── Recovery annotations (populated at startup) ───────────────────────────
  startup_mode?: 'normal' | 'recovery_cleared' | 'first_run';
  recovery_action?: string | null;
}

export interface DirectionalFreshnessConfig {
  enabled: boolean;
  long_vwap_mode: 'hard' | 'soft';
  short_vwap_mode: 'hard' | 'soft';
  short_above_vwap_allowance_session_atr: number;
  short_above_vwap_penalty: number;
  require_5m_structure: boolean;
  require_supertrend_or_ema21_exception: boolean;
  /**
   * Sigmoid midpoint (in session-ATR units) for the shaped short-above-VWAP
   * penalty. At z = midpoint the penalty is ≈ −penalty/2. Defaults to 0.20.
   */
  short_above_vwap_penalty_midpoint_atr?: number;
  /**
   * Sigmoid slope width (in session-ATR units) — larger values give a gentler
   * ramp, smaller values sharpen the transition. Defaults to 0.08.
   */
  short_above_vwap_penalty_slope_atr?: number;
}

export interface SessionScoreOverrides {
  ETH?: {
    short?: Partial<Record<SetupType, number>>;
    long?: Partial<Record<SetupType, number>>;
  };
  RTH?: {
    short?: Partial<Record<SetupType, number>>;
    long?: Partial<Record<SetupType, number>>;
  };
}

// ─── Indicator Config ────────────────────────────────────────────────────────

export interface IndicatorConfig {
  version: string;
  type: 'BASELINE' | 'EXPERIMENTAL';
  created_at: string;
  ema_fast: number;
  ema_mid: number;
  ema_slow: number;
  rsi_period: number;
  atr_period: number;
  volume_sma_period: number;
  // Strategy filters
  min_confidence: number;
  /**
   * Max confidence ceiling — setups scoring above this are rejected as
   * likely overextended. Set to 10.0 to disable. (Patch autoresearch H2.)
   */
  max_confidence: number;
  min_rr: number;
  // Risk controls
  max_risk_per_trade_pct: number;
  max_daily_loss_pct: number;
  account_equity: number;
  time_stop_minutes: number;
  /**
   * Pre-T1 time-stop gate: the time stop may only fire if current unrealized R
   * is AT OR BELOW this value. Set to 0.25 so a trade at +0.3R is protected.
   * Set to 0 to allow time stop at any profit level pre-T1.
   */
  time_stop_max_r_pre_t1: number;
  /**
   * Post-T1 time-stop gate: after partial exit and stop-at-BE, the time stop
   * is suppressed if current unrealized R is ABOVE this value. Set to 1.0 to
   * let a +1.0R+ trade run freely without forced liquidation.
   */
  time_stop_max_r_post_t1: number;
  // Interval (flat-state analysis cadence)
  analysis_interval_seconds: number;
  /** Fast in-position monitoring cadence, in seconds. */
  in_position_monitor_seconds: number;
  /** Opening-range length in minutes (NQ RTH, from 09:30 ET). */
  opening_range_minutes: number;
  /**
   * After T1 is hit, the trailing stop is set this many ticks behind the
   * most-favorable excursion. 0 disables the trail (stop stays at BE).
   */
  trail_ticks_post_t1: number;
  // ── Pre-T1 profit protection ──────────────────────────────────────────────
  /**
   * Move stop to breakeven once the trade reaches this R-multiple in
   * unrealized profit (pre-T1). 0 disables pre-T1 breakeven.
   * Example: 0.5 means "move stop to BE once trade is +0.5R in favor".
   */
  breakeven_trigger_r: number;
  /**
   * Start a pre-T1 trailing stop once the trade reaches this R-multiple.
   * The trail distance is `pre_t1_trail_distance_ticks`. 0 disables.
   * Must be >= breakeven_trigger_r to avoid conflict.
   */
  pre_t1_trail_trigger_r: number;
  /**
   * Trail distance in ticks for the pre-T1 trailing stop.
   * Only active when trade has reached pre_t1_trail_trigger_r.
   */
  pre_t1_trail_distance_ticks: number;
  // ── Partial-profit scaling ────────────────────────────────────────────────
  /** PT1: take first partial at this many points of favorable excursion. 0 = disabled. */
  pt1_offset_pts: number;
  /** PT2: take second partial at this many points. 0 = disabled. Must be > pt1_offset_pts. */
  pt2_offset_pts: number;
  /** Fraction of position to exit at PT1 (0.0-1.0). E.g., 0.5 = 50%. */
  pt1_exit_fraction: number;
  /** Fraction of ORIGINAL position to exit at PT2 (0.0-1.0). E.g., 0.25 = 25%. */
  pt2_exit_fraction: number;
  /** Move stop to breakeven after PT1 partial. */
  pt1_move_to_be: boolean;
  /** Activate trailing stop after PT1. */
  pt1_activate_trailing: boolean;
  /** Enable/disable high-risk strategy families. */
  enable_momentum_continuation: boolean;
  enable_opening_drive: boolean;
  enable_failed_or_break: boolean;
  // ── Dual-direction confluence model ───────────────────────────────────────
  /**
   * Minimum confidence score for any side to be considered for entry.
   * A candidate scoring below this is treated as "no valid setup".
   */
  dual_min_score: number;
  /**
   * Minimum score margin the winning side must have over the losing side
   * when BOTH sides pass hard gates. Prevents entering when confluence
   * is ambiguous.
   */
  dual_score_margin: number;
  /**
   * Extra margin added in choppy/high-volatility regimes to require
   * even stronger conviction before entering.
   */
  dual_choppy_extra_margin: number;
  /**
   * Configurable scoring weights for scoreConfidenceDetailed().
   * Optional — when absent or partially specified, missing fields fall back
   * to DEFAULT_SCORING_WEIGHTS which reproduce the original hardcoded behavior.
   */
  scoring_weights?: Partial<ScoringWeights>;
  // ── Safety controls ──────────────────────────────────────────────────────
  /**
   * Minimum number of 1m bars to wait after a trade exit before allowing a
   * new entry. 0 disables cooldown. Prevents chop flip-flops.
   */
  cooldown_bars: number;
  /**
   * When true, prevents entering the opposite direction on the same bar
   * a trade was closed. Requires at least 1 bar of separation.
   */
  no_same_bar_reversal: boolean;
  /** Minutes of historical bars to reconstruct before live cycles resume after a dirty restart. */
  startup_backfill_minutes?: number;
  /** Explicit cycle-stall threshold in milliseconds. */
  cycle_stall_threshold_ms?: number;
  /** CUSUM reference value k (higher = harder to trip). */
  cycle_cusum_k?: number;
  /** CUSUM trip threshold h on S+. */
  cycle_cusum_h?: number;
  /** Samples required to build the CUSUM baseline before evaluation starts. */
  cycle_cusum_baseline_samples?: number;
  /** Enables the ETH first-pullback reversal short setup. */
  enable_post_flip_first_pullback_short?: boolean;
  /**
   * Maximum distance (in session ATR units) from the EMA9/21 cluster high
   * allowed for the post-flip-first-pullback retest gate. Controls how close
   * price must be to the cluster before a pullback entry is allowed. Default
   * 0.20 (tightened from legacy max(25 pts, 0.75 × ATR)).
   */
  post_flip_first_pullback_short_max_retest_atr?: number;
  /** Direction-aware freshness rules for above-VWAP handling. */
  directional_freshness?: DirectionalFreshnessConfig;
  /**
   * Legacy: session/direction/setup-specific selection-floor overrides.
   * Kept for backwards compatibility — NEW code should use
   * `session_selection_floor_overrides` instead. Entries here are treated
   * as a lower-priority fallback to that new key.
   */
  session_score_overrides?: SessionScoreOverrides;
  /**
   * Session/direction/setup-specific SELECTION floor overrides.
   *
   * A candidate whose final score is below the global `dual_min_score`
   * (execution floor) but at or above this per-setup selection floor will
   * still be logged/forwarded for replay + observability — but its decision
   * is demoted to `wait_below_execution_floor` so it is NOT executed. This
   * makes near-miss candidates visible in replay metrics without relaxing
   * live trading discipline.
   */
  session_selection_floor_overrides?: SessionScoreOverrides;
  // ── In-position quote freshness ──────────────────────────────────────────
  /**
   * Max age (ms) of a quote before onMonitor refuses to act on it.
   * Default: 3000ms. Set 0 to disable the check (not recommended).
   */
  max_quote_age_ms_for_management?: number;
  /**
   * Timeout (ms) for the getQuote() call in onMonitor.
   * Default: 1000ms — must stay well under in_position_monitor_seconds.
   */
  quote_poll_timeout_ms?: number;
  // ── Management profiles (setup-specific trade management) ─────────────
  /**
   * Per-setup-family management profiles with ATR-relative thresholds.
   * Keys are SetupFamily values (e.g. 'trend_pullback', 'opening_drive').
   * A 'default' key provides fallback for unrecognized setup families.
   * When absent, the system synthesizes a default profile from the flat
   * management params above (exact backwards compatibility).
   */
  management_profiles?: Record<string, ManagementProfile>;
  /** Active management variant name. When set, applies overrides from management_profile_variants. */
  active_management_variant?: string;
  /** Named variant sets containing per-family parameter overrides. */
  management_profile_variants?: Record<string, Record<string, Partial<ManagementProfile>>>;
  /** ML-based position management via local inference service. */
  ml_management?: import('./ml/types.js').MlManagementConfig;
  /** Canonical ML execution policy (Track B). When omitted, derived from `ml_management`. */
  ml_policy?: import('./ml-policy.js').MlPolicyConfig;
  /** ML-based entry confirmation (gated confirmer, not sole trigger). */
  entry_ml?: import('./ml-entry/types.js').EntryMlConfig;
  /** Execution policy: microstructure-aware execution behavior. */
  execution_policy?: import('./execution-policy/types.js').ExecutionPolicyConfig;
  /** Dynamic target-position model (V1a): q*(t) = floor(min(q_risk, q_softcap, q_hardcap)). */
  position_target?: import('./target-position.js').PositionTargetConfig;
  /** Anti-chase / entry extension filters. */
  entry_extension_filters?: import('./features/extension.js').EntryExtensionFilterConfig;
  /** Microstructure score overlay: setup-aware LOB/MBO confidence adjustment. */
  microstructure_overlay?: import('./features/microstructure-score.js').MicrostructureOverlayConfig;
  /** Dynamic reward planning: setup-family-aware RR gating and target alignment. */
  dynamic_reward_planning?: import('./features/dynamic-reward-plan.js').DynamicRewardConfig;
  /** Spatial normalization policy: controls scale families for VWAP/room/micro metrics. */
  normalization?: import('./features/normalization.js').NormalizationConfig;
  /** Layered scoring architecture: separates structure, flow, and lagging into distinct layers. */
  layered_scoring?: import('./features/layered-scoring.js').LayeredScoringConfig;
  /** HTF zone awareness: higher-timeframe support/resistance scoring and veto. */
  htf_zones?: HtfZonesConfig;
  /**
   * Quant trend-pullback config (Phase 7 of the refactor — plan §4.3/§5).
   * Controls Stage A telemetry activation, Stage B hybrid-gate
   * scaffolding, and every code constant from the Phase 1-6 rollout
   * (stop multiplier, cold-start target multipliers, band thresholds,
   * expectancy bucket rules, LOB degradation thresholds, orderflow
   * windows). When absent, `DEFAULT_QUANT_ENTRY_CONFIG` is used — which
   * disables all Phase 7 new-telemetry paths AND leaves every Phase 1-6
  * code constant at its current value, so the system remains a pure
  * no-op relative to the post-Phase-6 baseline.
  */
  quant_entry?: import('./features/quant-entry-config.js').QuantEntryConfig;
  /**
   * Multi-instrument orchestration config. Explicitly separates supported
   * instruments, live-enabled policy, and per-instrument runtime wiring.
   */
  multi_instrument?: import('./instrument-config.js').MultiInstrumentConfig;
  /**
   * Deprecated compatibility alias for one integration cycle.
   * Replaced by multi_instrument.enabled.
   */
  runner_v2_enabled?: boolean;
  /**
   * Deprecated compatibility alias for one integration cycle.
   * Replaced by explicit per-instrument role='shadow'.
   */
  runner_v2_shadow_only?: boolean;
  // ── V2 Multi-Lane Engine ─────────────────────────────────────────────────
  /** Canonical runtime control: 'shadow' | 'paper' | 'live'. Default: 'paper'. */
  execution_mode?: 'shadow' | 'paper' | 'live';
  /** Per-lane timing overrides for the v2 scheduler. */
  lane_timing?: {
    hard_risk_interval_ms?: number;
    hard_risk_quote_timeout_bbo_ms?: number;
    hard_risk_quote_timeout_tv_ms?: number;
    hard_risk_stale_full_risk_ms?: number;
    hard_risk_stale_stop_only_ms?: number;
    management_interval_ms?: number;
    management_stale_threshold_ms?: number;
    context_refresh_interval_ms?: number;
    context_refresh_starvation_boost_after?: number;
    shadow_interval_ms?: number;
    ml_management_interval_ms?: number;
    opening_drive_analysis_interval_ms?: number;
    midday_analysis_interval_ms?: number;
    /** Max staleness (ms) of full snapshot before shadow signal skips. Default 300000 (5min). */
    shadow_snap_stale_ms?: number;
    /** Warn when a full management lane callback exceeds this wall time (ms). */
    management_cycle_budget_warn_ms?: number;
  };
}

export interface IndicatorChangeRecord {
  change_id: string;
  timestamp: string;
  previous_version: string | null;
  new_version: string;
  previous_config: Partial<IndicatorConfig> | null;
  new_config: Partial<IndicatorConfig>;
  exact_parameter_changes: Record<string, { from: unknown; to: unknown }>;
  reason: string;
  sample_size_at_change: number;
  recent_performance_summary: string;
  expected_improvement_hypothesis: string;
  baseline_preserving: boolean;
  review_due_after_n_trades: number;
}

// ─── Risk State ───────────────────────────────────────────────────────────────

export interface RiskState {
  daily_pnl_usd: number;
  daily_loss_pct: number;
  consecutive_losses: number;
  total_trades_today: number;
  is_locked: boolean;
  lock_reason: string | null;
}

// ─── Performance ─────────────────────────────────────────────────────────────

export interface PerformanceStats {
  session_id: string;
  total_trades: number;
  wins: number;
  losses: number;
  scratches: number;
  win_rate: number | null;
  avg_r: number | null;
  expectancy: number | null;
  avg_winner_r: number | null;
  avg_loser_r: number | null;
  profit_factor: number | null;
  max_drawdown_pct: number;
  total_pnl_usd: number;
  by_setup: Record<string, SetupStats>;
  by_regime: Record<string, SetupStats>;
  by_hour: Record<string, SetupStats>;
  by_config_version: Record<string, SetupStats>;
  by_management_profile: Record<string, SetupStats>;
  last_updated: string;
}

export interface SetupStats {
  trades: number;
  wins: number;
  total_r: number;
}
