/**
 * execution-policy/types.ts — Types for the execution policy layer.
 *
 * The execution policy sits between decisions (ML/rules) and execution (adapter).
 * It converts an approved action into microstructure-aware execution behavior.
 *
 * Decision layer says WHAT to do.
 * Execution policy says HOW and WHEN to do it.
 */

import type { ManagementAction } from '../types.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ExecutionPolicyConfig {
  /** Enable the execution policy layer (false = pass-through). */
  enabled: boolean;
  /** Maximum spread in ticks to allow non-urgent execution. */
  max_spread_ticks_normal: number;
  /** Maximum spread in ticks for urgent exits (EXIT_ALL). */
  max_spread_ticks_urgent: number;
  /** Minimum seconds between scale-out executions. */
  scale_out_cooldown_sec: number;
  /** Feature flag: enable SCALE_IN (paper only). */
  enable_scale_in: boolean;
  /** Maximum total position size (contracts) after any scale-in. */
  max_position_size: number;
  /** Minimum seconds between any execution policy actions. */
  action_cooldown_sec: number;
  /** Maximum quote age (ms) for non-risk-reducing execution. */
  max_quote_age_ms: number;
}

export const DEFAULT_EXECUTION_POLICY_CONFIG: ExecutionPolicyConfig = {
  enabled: false,
  max_spread_ticks_normal: 2,
  max_spread_ticks_urgent: 4,
  scale_out_cooldown_sec: 30,
  enable_scale_in: false,
  max_position_size: 10,
  action_cooldown_sec: 5,
  max_quote_age_ms: 3000,
};

// ─── Execution Intent ────────────────────────────────────────────────────────

export type ExecutionUrgency = 'immediate' | 'normal' | 'patient';
export type ExecutionTiming = 'now' | 'delay' | 'cancel';

export interface ExecutionIntent {
  /** The original approved action from decision layer. */
  source_action: ManagementAction;
  /** The policy-adjusted execution behavior. */
  execution_action: ManagementAction;
  /** Urgency classification. */
  urgency: ExecutionUrgency;
  /** Timing decision: execute now, delay, or cancel. */
  timing: ExecutionTiming;
  /** Quantity to execute (for partials/scale). */
  quantity: number | null;
  /** Stop price (for MOVE_STOP). */
  stop_price: number | null;
  /** Why this execution decision was made. */
  reasons: string[];
  /** Microstructure inputs used. */
  microstructure: MicrostructureInputs;
}

export interface MicrostructureInputs {
  spread_ticks: number | null;
  bid_size: number | null;
  ask_size: number | null;
  depth_imbalance_5: number | null;
  aggressor_penetration_10s: number | null;
  sweep_count_10s: number | null;
  absorption_rate_10s: number | null;
  replenishment_rate_10s: number | null;
  cancel_add_ratio_10s: number | null;
  quote_age_ms: number;
  data_quality: string;
}

// ─── Policy Check ────────────────────────────────────────────────────────────

export interface PolicyCheck {
  name: string;
  passed: boolean;
  reason: string;
}

export interface ExecutionPolicyResult {
  /** The final execution intent. */
  intent: ExecutionIntent;
  /** All policy checks performed. */
  checks: PolicyCheck[];
  /** Whether execution should proceed. */
  should_execute: boolean;
  /** If blocked, why. */
  block_reason: string | null;
}
