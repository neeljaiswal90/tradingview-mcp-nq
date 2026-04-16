/**
 * ml/types.ts — Type definitions for ML management integration.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

export interface MlManagementConfig {
  enabled: boolean;
  service_url: string;
  timeout_ms: number;
  model_type: string;
  model_version: string;
  /** Minimum action_confidence to execute EXIT_ALL. */
  min_confidence_exit: number;
  /** Minimum action_confidence to execute EXIT_PARTIAL. */
  min_confidence_partial: number;
  /** Minimum action_confidence to execute MOVE_STOP / MOVE_TO_BREAKEVEN. */
  min_confidence_stop_move: number;
  /** Max quote age in ms — no non-risk-reducing action on stale quotes. */
  max_quote_age_ms: number;
  /** Minimum seconds between ML-driven executable actions. 0 = disabled. */
  action_cooldown_seconds: number;
  /** Feature flag: enable EXIT_PARTIAL execution path. Default false. */
  enable_partial_exit: boolean;
  /** Minimum seconds a position must be held before ML can issue EXIT_ALL. 0 = disabled. */
  min_hold_seconds_before_ml_exit: number;

  // ── Runtime inference/gating config ───────────────────────────────────
  // Used by the live execution path (decideAction + execution gate).

  /** Minimum seconds before ML can issue EXIT_PARTIAL / SCALE_OUT. */
  min_hold_seconds_before_ml_reduce: number;
  /** Use Platt-calibrated probabilities for threshold decisions. */
  use_probability_calibration: boolean;
  /** Path to calibration artifact (Platt params JSON). */
  calibration_path?: string;
  /** End of EARLY phase in seconds from entry. */
  early_phase_end_seconds: number;
  /** Minimum age (seconds) to qualify for RUNNER phase on time alone. */
  runner_phase_min_seconds: number;
  /** Minimum cur_r to qualify for RUNNER phase on R alone. */
  runner_trigger_r: number;
  /** EARLY phase: prob_hold below this → EXIT_ALL candidate. */
  exit_threshold_early: number;
  /** ACTIVE phase: prob_hold below this → EXIT_ALL candidate. */
  exit_threshold_active: number;
  /** RUNNER phase: prob_hold below this → EXIT_ALL candidate. */
  exit_threshold_runner: number;
  /** EARLY phase: minimum confidence to execute exit. */
  min_confidence_to_exit_early: number;
  /** ACTIVE phase: minimum confidence to execute exit. */
  min_confidence_to_exit_active: number;
  /** RUNNER phase: minimum confidence to execute exit. */
  min_confidence_to_exit_runner: number;
  /** EARLY phase: block EXIT_ALL when cur_r > this (protect tiny green trades). */
  early_green_trade_exit_block_r: number;
  /** RUNNER phase: block EXIT_ALL when drawdown_from_peak < this. */
  runner_drawdown_from_peak_r: number;

  // ── Training/labeling config ──────────────────────────────────────────
  // Used ONLY by offline training/labeling scripts, NOT by the live path.

  /** Minimum seconds of trade development before a row is training-eligible. */
  train_min_development_seconds: number;
  /** Margin above cur_r for counterfactual hold to count as "better". */
  hold_label_margin_r: number;
  /** Max forward horizon (seconds) for counterfactual hold simulation. */
  counterfactual_max_horizon_seconds: number;
  /** Exclude training rows that occur after any ML action in the same trade. */
  exclude_rows_after_any_ml_action: boolean;
  /** Exclude training rows where a future ML exit/reduce occurs before close. */
  exclude_rows_with_future_ml_exit: boolean;
  /** Minimum seconds between sampled decision rows in the same trade. */
  decision_stride_seconds: number;

  /**
   * **ML management only** — feeds `resolveMlPolicy()` / `execution_enabled` for the
   * management-ML lane. Does **not** disable entry orders, rules/management exits,
   * hard-risk `placeExit`, or target-position broker paths.
   */
  broker_execution_enabled?: boolean;
}

export const DEFAULT_ML_CONFIG: MlManagementConfig = {
  enabled: false,
  service_url: 'http://127.0.0.1:5001',
  timeout_ms: 3000,
  model_type: 'catboost',
  model_version: '',
  min_confidence_exit: 0.6,
  min_confidence_partial: 0.55,
  min_confidence_stop_move: 0.5,
  max_quote_age_ms: 5000,
  action_cooldown_seconds: 20,
  enable_partial_exit: false,
  min_hold_seconds_before_ml_exit: 15,
  // Runtime inference/gating
  min_hold_seconds_before_ml_reduce: 10,
  use_probability_calibration: true,
  early_phase_end_seconds: 30,
  runner_phase_min_seconds: 60,
  runner_trigger_r: 0.75,
  exit_threshold_early: 0.06,
  exit_threshold_active: 0.18,
  exit_threshold_runner: 0.10,
  min_confidence_to_exit_early: 0.85,
  min_confidence_to_exit_active: 0.75,
  min_confidence_to_exit_runner: 0.85,
  early_green_trade_exit_block_r: 0.10,
  runner_drawdown_from_peak_r: 0.25,
  // Training/labeling (offline only)
  train_min_development_seconds: 15,
  hold_label_margin_r: 0.05,
  counterfactual_max_horizon_seconds: 120,
  exclude_rows_after_any_ml_action: true,
  exclude_rows_with_future_ml_exit: false,
  decision_stride_seconds: 2,
};

// ─── ML Service Request/Response ─────────────────────────────────────────────

/**
 * ML feature vector for management inference.
 *
 * IMPORTANT: Field order and names must match the canonical registry at
 * python-market-data-service/lob_features/ml_feature_registry.py
 *
 * When adding features:
 *   1. Add to ml_feature_registry.py first
 *   2. Mirror here
 *   3. Add to schemas.py ManagementRequest
 *   4. Add to feature-builder.ts buildMlFeatures()
 *   5. Run feature parity tests
 */
export interface MlFeatureVector {
  trade_id: string;

  // ── Position-management features (v1) ──────────────────────────────────
  is_short: number;
  confidence_at_entry: number;
  initial_risk_pts: number;
  current_price: number;
  stop_current: number;
  quantity_remaining: number;
  pnl_pts: number;
  unrealized_r: number;
  mfe_pts_so_far: number;
  mae_pts_so_far: number;
  time_in_trade_sec: number;
  distance_to_stop_pts: number;
  pt1_hit: number;
  pt2_hit: number;
  stop_at_breakeven: number;
  trail_active: number;
  trail_ratchet_count: number;
  management_events_count: number;
  entry_hour_utc: number;
  tick_hour_utc: number;

  // ── LOB/MBO features (v2 — nullable when sidecar unavailable) ──────────
  lob_spread_ticks: number | null;
  lob_bid_size: number | null;
  lob_ask_size: number | null;
  lob_depth_imbalance_5: number | null;
  lob_depth_imbalance_10: number | null;
  lob_total_bid_depth_10lvl: number | null;
  lob_total_ask_depth_10lvl: number | null;
  lob_cumulative_delta_10s: number | null;
  lob_cumulative_delta_30s: number | null;
  lob_cumulative_delta_60s: number | null;
  lob_trade_flow_imbalance_10s: number | null;
  lob_trade_flow_imbalance_30s: number | null;
  lob_cancel_add_ratio_10s: number | null;
  lob_replenishment_rate_10s: number | null;
  lob_absorption_rate_10s: number | null;
  lob_sweep_count_10s: number | null;

  // ── Advanced MBO features (v3 — optional, null when analyzer unavailable) ──
  adv_cancel_replace_ratio_10s: number | null;
  adv_modify_rate_10s: number | null;
  adv_iceberg_suspicion_30s: number | null;
  adv_queue_deterioration_bid_10s: number | null;
  adv_queue_deterioration_ask_10s: number | null;
  adv_pull_cascade_count_10s: number | null;
  adv_lifetime_p50_ms: number | null;

  // ── Categoricals ───────────────────────────────────────────────────────
  setup_type: string;
  regime_at_entry: string;
}

export type MlAction =
  | 'HOLD'
  | 'EXIT_ALL'
  | 'EXIT_PARTIAL'
  | 'MOVE_STOP'
  | 'MOVE_TO_BREAKEVEN'
  | 'NO_ACTION';

export interface MlServiceResponse {
  action: MlAction;
  action_confidence: number;
  prob_hold: number | null;
  prob_pt2_before_stop: number | null;
  prob_continue_next_window: number | null;
  ev_hold_r: number | null;
  ev_exit_now_r: number | null;
  ev_reduce_r: number | null;
  recommended_size_fraction: number | null;
  recommended_stop_price: number | null;
  model_name: string;
  model_version: string;
  inference_ms: number;
  notes: string[];
  /** Tier selected by the ML service for this inference (null if not tiered). */
  tier_used?: string | null;
  /** Reason the service fell back to a lower tier. */
  fallback_reason?: string | null;
}

// ─── Execution Gate Result ───────────────────────────────────────────────────

export interface MlGateCheck {
  name: string;
  passed: boolean;
  reason: string;
}

export interface MlGateResult {
  approved: boolean;
  action: MlAction;
  rejection_reason: string | null;
  checks: MlGateCheck[];
}

// ─── ML Decision (enriched for logging) ──────────────────────────────────────

export interface MlDecision {
  action: MlAction;
  confidence: number;
  approved: boolean;
  rejection_reason: string | null;
  prob_hold: number | null;
  ev_hold_r: number | null;
  ev_exit_now_r: number | null;
  /** Recommended stop price for MOVE_STOP actions (from service response). */
  recommended_stop_price: number | null;
  /** Recommended exit fraction for EXIT_PARTIAL actions (from service response). */
  recommended_size_fraction: number | null;
  model_name: string;
  /** Actual model version from service response (not config). */
  model_version: string;
  inference_ms: number;
  evaluated_at_iso: string;
  gate_checks: MlGateCheck[];
  notes: string[];
  /** Tier selected by the ML service for this inference. */
  tier_used: string | null;
  /** Whether service fell back to a lower tier. */
  fallback_used: boolean;
  /** Reason for fallback (missing_required_fields | stale_bbo | etc). */
  fallback_reason: string | null;
}

// ─── Phase-Aware Decision Types ─────────────────────────────────────────────

/** Development phase for live policy decisions and training labels. */
export type DevelopmentPhase = 'EARLY' | 'ACTIVE' | 'RUNNER';

/**
 * Input to decideAction(). Phase is derived internally from age_sec, cur_r,
 * and config thresholds — no development_phase field to avoid competing
 * phase definitions between live policy and training labels.
 */
export type DecideActionInput = {
  prob_hold_raw: number;
  /** Only populated when the service explicitly returns a calibrated value. */
  prob_hold_cal?: number;
  confidence: number;
  age_sec: number;
  cur_r: number;
  peak_r: number;
  drawdown_from_peak_r: number;
  quote_age_ms: number;
};

export type DecideActionResult = {
  action: 'HOLD' | 'EXIT_ALL';
  reason: string;
  /** Computed phase, for logging/observability only. */
  phase: DevelopmentPhase;
  threshold_used?: number;
  prob_hold_used?: number;
};

/**
 * Result from getMlDecision — includes the decision, the exact serialized
 * request/response bodies for logging, and the feature vector.
 */
export interface MlDecisionResult {
  decision: MlDecision;
  /** The exact JSON body sent to the ML service (for reproducible logging). */
  serializedRequestBody: string;
  /** The exact JSON response from the ML service. */
  serializedResponseBody: string;
  /** The feature vector object (for programmatic access). */
  features: MlFeatureVector;
  /** Unique request ID for traceability. */
  requestId: string;
  /** Total request latency in ms (including network). */
  requestLatencyMs: number;
}
