/**
 * Management layer types — in-trade probability and expected-value metrics.
 *
 * Design principles:
 * - Entry confidence (strategy.ts scoreConfidenceDetailed) and in-trade PoP are
 *   completely separate. Never call the entry score a "probability."
 * - All PoP values are calibrated pseudo-probabilities in [0, 1].
 * - EV values are in USD, using the contract's point_value.
 * - ManagementState is advisory only — hard stops in position-manager.ts always
 *   take precedence.
 */

import type { MarketRegime, SetupType } from '../types.js';

// ─── Feature Vector ───────────────────────────────────────────────────────────

/**
 * All inputs the management layer uses to compute PoP and EV.
 * Built by feature-builder.ts each monitor cycle.
 */
export interface ManagementFeatures {
  // ── Position identity ──────────────────────────────────────────────────────
  side: 'long' | 'short';
  setup_type: SetupType;

  // ── Price / R metrics ──────────────────────────────────────────────────────
  current_price: number;
  /** Signed points from entry: positive = favorable. */
  unrealized_pnl_pts: number;
  /** Absolute distance from entry to initial stop, in points. Always > 0. */
  initial_risk_pts: number;
  /** Unrealized PnL as a multiple of initial risk. Positive = winning. */
  current_r: number;
  /** Peak favorable excursion since entry, in R units. */
  mfe_r: number;
  /** Peak adverse excursion since entry, in R units (positive = loss depth). */
  mae_r: number;

  // ── Time ──────────────────────────────────────────────────────────────────
  hold_seconds: number;
  /** Seconds remaining before time stop fires (may be 0 when disabled). */
  time_stop_remaining_seconds: number;

  // ── Distances to key levels (always ≥ 0 from current price) ──────────────
  /** Pts from current price to active stop. 0 or negative = stop breached. */
  distance_to_stop_pts: number;
  /** Stop distance in ATR units. null when ATR unavailable. */
  distance_to_stop_atr: number | null;
  /** Pts from current price to T1. Negative = T1 already passed. */
  distance_to_t1_pts: number;
  distance_to_t1_atr: number | null;
  /** Pts from current price to T2. */
  distance_to_t2_pts: number;
  distance_to_t2_atr: number | null;

  // ── Partial exit state ─────────────────────────────────────────────────────
  partial_exit_done: boolean;
  pt1_done: boolean;
  pt2_done: boolean;
  quantity_remaining: number;
  quantity_original: number;
  realized_pnl_usd: number;

  // ── Market context (all nullable — may be absent in fast monitor loop) ─────
  atr_14: number | null;
  adx: number | null;
  di_plus: number | null;
  di_minus: number | null;
  rsi_14: number | null;
  /** Signed: positive = price is favorable vs VWAP for the trade direction. */
  vwap_distance_pts: number | null;
  vwap_distance_atr: number | null;
  ema_alignment: 'bullish' | 'bearish' | 'mixed' | null;
  ema_9_21_gap_pts: number | null;
  cvd_trend: 'up' | 'down' | null;
  /** volume / volume_sma_20. null when either unavailable. */
  volume_ratio: number | null;
  regime: MarketRegime | null;
  session_bucket: string | null;
  ttm_squeeze_firing: boolean | null;
}

// ─── Probability of Profit ────────────────────────────────────────────────────

/**
 * PoP estimates for the active trade.
 * All values in [0, 1]. These are pseudo-probabilities from a rules model,
 * not frequentist empirical probabilities.
 */
export interface TradePoP {
  /** Probability price reaches T1 before the current stop. */
  pop_target1_before_stop: number;
  /** Probability price reaches T2 before the current stop (unconditional). */
  pop_target2_before_stop: number;
  /**
   * Probability of a meaningful extension beyond T2 — via trailing stop
   * or T3 target. Represents "runner value."
   */
  pop_runner_extension: number;
  model_name: string;
  model_version: string;
  /** Reflects how much market context was available to inform the estimate. */
  confidence_in_estimate: 'high' | 'medium' | 'low';
}

// ─── Pluggable Model Interface ────────────────────────────────────────────────

/**
 * Interface all probability models must implement.
 * Allows swapping the rules engine for a trained model later without
 * changing the decision engine or runner.
 */
export interface ProbabilityModel {
  readonly name: string;
  readonly version: string;
  computePoP(features: ManagementFeatures): TradePoP;
}

// ─── Management Decision ──────────────────────────────────────────────────────

/**
 * Advisory state for the active trade.
 * This is a recommendation only — hard stops are never overridden.
 */
export type ManagementState = 'HOLD' | 'REDUCE' | 'MOVE_STOP' | 'EXIT_NOW';

/**
 * Full management metrics snapshot computed each monitor cycle.
 */
export interface ManagementMetrics {
  features: ManagementFeatures;
  pop: TradePoP;
  /** Current unrealized PnL in USD (quantity_remaining only — excludes realized legs). */
  unrealized_pnl_usd: number;
  /** EV of holding the remaining position to target. */
  expected_value_hold_usd: number;
  /** EV of exiting now at current price (locks in unrealized_pnl_usd). */
  expected_value_exit_now_usd: number;
  /** EV of reducing position size by 50% now, holding remainder. */
  expected_value_reduce_usd: number;
  /** Delta: positive = hold is better than exit now. */
  ev_hold_vs_exit_delta: number;
  management_state: ManagementState;
  management_state_reason: string;
  /** Factors that drove the management_state decision. */
  decision_factors: string[];
  timestamp_iso: string;
}
