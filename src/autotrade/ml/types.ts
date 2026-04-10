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
  action_cooldown_seconds: 0,
  enable_partial_exit: false,
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
