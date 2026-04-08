// ─── Core Domain Types ──────────────────────────────────────────────────────

export type ExecutionMode = 'paper' | 'live' | 'signal_only';

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

export type SetupType =
  | 'trend_pullback_long'
  | 'trend_pullback_short'
  | 'breakout_retest_long'
  | 'breakdown_retest_short'
  | 'momentum_continuation'
  // ── NQ-oriented setup families ─────────────────────────────────────────
  | 'opening_drive_continuation_long'
  | 'opening_drive_continuation_short'
  | 'or_retest_continuation_long'
  | 'or_retest_continuation_short'
  | 'failed_or_break_short'
  | 'failed_or_break_long';

// ── Setup Families (direction-agnostic grouping for management profiles) ────
export type SetupFamily =
  | 'trend_pullback'
  | 'breakout_retest'
  | 'opening_drive'
  | 'or_retest'
  | 'failed_or_break'
  | 'momentum_continuation'
  | 'default';

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
  | 'invalidation'
  | 'manual'
  | 'daily_loss_limit'
  | 'session_end';

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
  | 'final_runner_exit';

export interface ManagementEvent {
  _record_type: 'management_event';
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
  /** Management variant label for A/B comparison. */
  management_variant?: string;
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
  hit_target_1: boolean;
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
  max_consecutive_losses: number;
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
  /**
   * When true: if getQuote() fails or times out, fall back to lastSnap.price
   * rather than skipping the monitor tick. Default: false (skip on failure).
   */
  enable_stale_quote_fallback?: boolean;
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
  /** ML-based entry confirmation (gated confirmer, not sole trigger). */
  entry_ml?: import('./ml-entry/types.js').EntryMlConfig;
  /** Execution policy: microstructure-aware execution behavior. */
  execution_policy?: import('./execution-policy/types.js').ExecutionPolicyConfig;
  /** Anti-chase / entry extension filters. */
  entry_extension_filters?: import('./features/extension.js').EntryExtensionFilterConfig;
  /** Microstructure score overlay: setup-aware LOB/MBO confidence adjustment. */
  microstructure_overlay?: import('./features/microstructure-score.js').MicrostructureOverlayConfig;
  /** Dynamic reward planning: setup-family-aware RR gating and target alignment. */
  dynamic_reward_planning?: import('./features/dynamic-reward-plan.js').DynamicRewardConfig;
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
