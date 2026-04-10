/**
 * ml-entry/types.ts — Type definitions for ML entry confirmation.
 *
 * Separate from management ML (ml/types.ts).
 * Entry ML acts as a gated confirmer, not a sole trigger.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

export type EntryMlMode = 'off' | 'confirm_only' | 'rank_only';

export interface EntryMlConfig {
  /** ML entry mode: off | confirm_only | rank_only */
  mode: EntryMlMode;
  /** URL of the entry inference service. */
  service_url: string;
  /** Timeout for inference calls in ms. */
  timeout_ms: number;
  /** Minimum ML confidence to confirm an entry (confirm_only mode). */
  min_confirmation_confidence: number;
  /** Minimum expected R prediction to confirm (confirm_only mode). */
  min_expected_r: number;
}

export const DEFAULT_ENTRY_ML_CONFIG: EntryMlConfig = {
  mode: 'off',
  service_url: 'http://127.0.0.1:5001',
  timeout_ms: 2000,
  min_confirmation_confidence: 0.55,
  min_expected_r: 0.0,
};

// ─── Feature Vector ──────────────────────────────────────────────────────────

/**
 * Entry feature vector — describes market state at signal time.
 * Must match entry_feature_registry.py exactly.
 */
export interface EntryFeatureVector {
  // Signal context
  direction_is_short: number;
  confidence_score: number;
  rr_t1: number | null;
  rr_t2: number | null;
  risk_pts: number | null;
  alignment_score: number | null;
  dual_score_margin: number | null;
  entry_location_quality: number | null;

  // Market structure
  price_vs_vwap_pts: number | null;
  price_vs_ema9_pts: number | null;
  price_vs_ema21_pts: number | null;
  ema_stack_bullish: number | null;
  supertrend_confirms: number | null;
  atr_14: number | null;
  rsi_14: number | null;
  distance_to_or_high_pts: number | null;
  distance_to_or_low_pts: number | null;
  distance_to_session_high_pts: number | null;
  distance_to_session_low_pts: number | null;

  // Microstructure (nullable)
  lob_spread_ticks: number | null;
  lob_depth_imbalance_5: number | null;
  lob_depth_imbalance_10: number | null;
  lob_cumulative_delta_10s: number | null;
  lob_cumulative_delta_30s: number | null;
  lob_cumulative_delta_60s: number | null;
  lob_trade_flow_imbalance_10s: number | null;
  lob_trade_flow_imbalance_30s: number | null;
  lob_large_bid_within_5pts: number | null;
  lob_large_ask_within_5pts: number | null;
  lob_cancel_add_ratio_10s: number | null;
  lob_absorption_rate_10s: number | null;
  lob_sweep_count_10s: number | null;

  // Session
  hour_utc: number;
  minutes_since_rth_open: number | null;
  is_rth: number;
  is_opening_drive_window: number;

  // HTF zone context
  htf_inside_resistance_zone: 0 | 1 | null;
  htf_inside_support_zone: 0 | 1 | null;
  htf_distance_to_res_pts: number | null;
  htf_distance_to_sup_pts: number | null;
  htf_distance_to_res_atr: number | null;
  htf_distance_to_sup_atr: number | null;
  htf_first_obstacle_rr: number | null;
  /** Ordinal: 0=null, 1=15m, 2=1h, 3=4h */
  htf_nearest_res_tf_ord: number;
  /** Ordinal: 0=null, 1=15m, 2=1h, 3=4h */
  htf_nearest_sup_tf_ord: number;
  htf_breakout_accepted: 0 | 1 | null;

  // Categoricals
  setup_type: string;
  regime_at_signal: string;
}

/** Entry feature schema version — bump when adding/removing/renaming features. Retrain required. */
export const ENTRY_FEATURE_SCHEMA_VERSION = 'v2_htf_zones';

// ─── Service Response ────────────────────────────────────────────────────────

export interface EntryMlResponse {
  /** ML's assessment: confirm or reject the entry. */
  confirmed: boolean;
  /** Confidence in the confirmation decision (0-1). */
  confidence: number;
  /** Predicted R-multiple for this entry. */
  expected_r: number | null;
  /** Probability this is a quality entry (0-1). */
  entry_quality_prob: number | null;
  /** Model name. */
  model_name: string;
  /** Inference latency in ms. */
  inference_ms: number;
  /** Reasons for the decision. */
  reasons: string[];
}

// ─── Decision Result ─────────────────────────────────────────────────────────

export interface EntryMlDecision {
  /** Whether ML confirms the entry. */
  confirmed: boolean;
  /** Why (for logging). */
  reason: string;
  /** Raw response from service. */
  response: EntryMlResponse | null;
  /** Inference latency in ms. */
  inference_ms: number;
}
