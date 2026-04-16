/**
 * features/scalper-shadow-decision.ts — Phase 5 shadow decision engine for
 * the lob_mbo_scalp strategy family.
 *
 * This module is the SINGLE source of truth for "should this scalper
 * candidate be allowed to enter?" — it is the only place in the scalper
 * pipeline that combines the four verdicts (deterministic, persistence,
 * expectancy, ML) into a single allow / reject outcome with a stable
 * reason string. The generator, the log writer, and the Stage B
 * enforcement path all call `shouldAllowScalperEntry` and never copy
 * the rule.
 *
 * Phase 5 hard requirements (locked by tests):
 *
 *   1. DECISION-TIME-SAFE INPUTS ONLY. Every field read by the combined
 *      rule is captured at the moment of evaluation from the scalper
 *      state vector or the ML response. No forward labels, no realized
 *      returns, no look-ahead fields may appear here.
 *
 *   2. CONSECUTIVE-READY-CYCLES GUARD. An ML-backed shadow decision is
 *      considered only when BOTH the current cycle AND the immediately
 *      prior cycle (as tracked by the runner-owned persistence state)
 *      had `ml_ready === true`. This is orthogonal to the persistence
 *      gate's two-consecutive-deterministic rule — the ML ready flag
 *      can flicker independently, and a single ready cycle is not
 *      enough to trust the probability for gating. When the guard
 *      fails, the combined rule emits `ml_readiness_not_confirmed` and
 *      the ML probability is NOT consulted, regardless of its value.
 *
 *   3. EXPLICIT, HORIZON-AWARE EXPECTANCY. The expectancy input MUST
 *      carry `max_ev_horizon_sec`. The ML probability MUST be queried
 *      at that horizon (the generator enforces this by passing the
 *      expectancy-chosen horizon to `getScalperMlDecision`). If the
 *      two horizons disagree — e.g. expectancy says 3s but ML was
 *      evaluated at 5s — the combined rule rejects with
 *      `ml_horizon_mismatch`. Catches generator wiring drift early.
 *
 *   4. EVERY REJECT PATH HAS A STABLE REASON CODE. The type
 *      `ScalperShadowRejectReason` enumerates every possible rejection.
 *      Downstream log writers and dashboards key off these strings;
 *      they are append-only and must not be renamed.
 *
 *   5. FULL TRANSPARENCY IN LOGS. `buildScalperShadowDecision` produces
 *      a record that carries: the four raw verdicts, the ML probability
 *      at the chosen horizon, the thresholds in effect (theta_p,
 *      ev_floor_ticks, min_bucket_samples, cost_ticks), the expectancy
 *      inputs (dimensions bins, bucket_source, bucket_id,
 *      bucket_sample_count), the expectancy output (per-horizon breakdown
 *      and the max_ev winner), and the final combined verdict. The log
 *      writer in `log-writer.ts` spreads this record directly into the
 *      candidate row so every decision is reviewable without re-running
 *      the engine.
 *
 *   6. NO SILENT FALLBACK, NO HIDDEN THRESHOLDS, NO SOFT PASS. If the
 *      expectancy table is missing the rule fails closed with
 *      `expectancy_no_bucket_match`. If the ML response is `ready=false`
 *      the rule fails closed with `ml_unavailable`. If the
 *      consecutive-ready-cycles guard fails the rule fails closed with
 *      `ml_readiness_not_confirmed`. There is no "try anyway" path.
 *
 * Stage A vs Stage B (config `lob_mbo_scalp.hybrid_gate`):
 *
 *   Stage A (hybrid_gate=false) — `gate_active=false` in the decision
 *   record. The rule is still computed and logged, but the generator
 *   MUST emit every candidate as a shadow signal regardless of the
 *   allowed flag. The runner never executes a scalper candidate in
 *   this wave because the strategy is `status: 'shadow'`.
 *
 *   Stage B (hybrid_gate=true) — `gate_active=true`. `allowed === false`
 *   is a true rejection and the candidate is suppressed before reaching
 *   the runner. No other behavior changes.
 *
 * This file is import-only consumed by `strategies/lob-mbo-scalp.ts` and
 * the Phase 5 tests — it has zero runtime side effects of its own.
 */

import type {
  ScalperDirection,
  ScalperDeterministicVerdict,
  ScalperPersistenceVerdict,
  ScalperStateVector,
} from './scalper-state.js';
import type {
  ScalperExpectancyEstimate,
  ScalperHorizonSec,
  ScalperBucketSource,
} from './scalper-expectancy-engine.js';

// ─── Config interface ──────────────────────────────────────────────────────

/**
 * Configuration for `shouldAllowScalperEntry`. Every threshold is
 * surfaced here so there are zero hidden constants inside the combined
 * rule. Tests pin the allow/reject outcome by constructing this config
 * explicitly; the generator plumbs it from
 * `config/indicator-config.json::lob_mbo_scalp` at runtime.
 *
 * Phase 5 does NOT invent threshold defaults — the generator is
 * responsible for supplying explicit values. Any caller that tries to
 * short-circuit with an undefined field gets a type error at build.
 */
export interface ScalperShadowDecisionConfig {
  /** Minimum ML probability of winning the chosen direction at the chosen horizon. */
  theta_p: number;
  /** Minimum post-cost expected ticks at the chosen horizon. */
  ev_floor_ticks: number;
  /** Minimum samples required to trust a resolved bucket. */
  min_bucket_samples: number;
  /** Flat round-turn cost subtracted from raw expectancy (passed through for logging). */
  cost_ticks: number;
  /** Stage A (false) logs-only; Stage B (true) rejects hard. */
  hybrid_gate: boolean;
}

// ─── Inputs from upstream stages ──────────────────────────────────────────

/**
 * ML verdict shape the shadow decision expects. Mirrors a subset of the
 * `ScalperMlDecision` shape from `ml-entry/lob-mbo-scalp-client.ts` —
 * the subset the combined rule needs to make a decision plus a copy of
 * the horizon the ML call was actually evaluated at so we can catch
 * horizon drift relative to expectancy.
 *
 * Kept as a local interface (rather than importing the client type) so
 * tests and future local-inference paths can feed the shadow decision
 * without coupling to the HTTP client shape.
 */
export interface ScalperShadowMlInput {
  ready: boolean;
  pFavorDirection: number | null;
  /** The horizon the ML call was evaluated at. Must equal the expectancy winner. */
  evaluatedHorizonSec: ScalperHorizonSec | null;
  /** Passthrough of the ML client's reason string (for log record). */
  reason: string | null;
  /** Passthrough of the ML model version (for audit). */
  modelVersion: string;
}

/**
 * Consecutive-ready-cycles input. The runner tracks per-direction
 * whether the immediately prior evaluation had `ml_ready === true`.
 * This field is the ONLY signal used for the consecutive guard —
 * `null` means "no prior cycle on record" and the guard fails.
 */
export interface ScalperPriorMlReadiness {
  /** The ml_ready flag observed on the prior cycle (for THIS direction). */
  priorMlReady: boolean | null;
  /** Wall-clock delta from the prior record, for log review. */
  priorAgeMs: number | null;
}

// ─── Rejection vocabulary ─────────────────────────────────────────────────

/**
 * Stable reject reasons emitted by the combined rule. Append-only. Never
 * rename — downstream log pipelines + dashboards bucket on these strings.
 *
 * Precedence (first-failing wins, evaluated in THIS order):
 *
 *   1. deterministic:<subreason>  — deterministic gate rejected
 *   2. persistence:<subreason>    — persistence gate rejected
 *   3. expectancy_no_bucket_match — lookup returned null bucket_source
 *   4. expectancy_below_min_samples — bucket found but n < min_bucket_samples
 *   5. expectancy_horizon_missing — max_ev_horizon_sec was null
 *   6. ml_readiness_not_confirmed — consecutive-ready guard failed
 *   7. ml_unavailable              — ready=false on the current cycle
 *   8. ml_horizon_mismatch         — ML evaluated at a different horizon
 *   9. ml_probability_invalid      — pFavorDirection not in [0, 1]
 *  10. ml_below_threshold          — p < theta_p
 *  11. ev_below_threshold          — post-cost EV < ev_floor_ticks
 *
 * `null` means "allowed" — no rejection.
 */
export type ScalperShadowRejectReason =
  | `deterministic:${string}`
  | `persistence:${string}`
  | 'expectancy_no_bucket_match'
  | 'expectancy_below_min_samples'
  | 'expectancy_horizon_missing'
  | 'ml_readiness_not_confirmed'
  | 'ml_unavailable'
  | 'ml_horizon_mismatch'
  | 'ml_probability_invalid'
  | 'ml_below_threshold'
  | 'ev_below_threshold';

// ─── Decision record ──────────────────────────────────────────────────────

/**
 * Full shadow decision record. Every field the combined rule consulted
 * is present here so the log row is a complete audit trail. Consumers
 * who need to re-derive a decision offline can read this record and
 * reproduce the allow/reject outcome bit-for-bit.
 *
 * Layout grouped by concern:
 *
 *   - Identity: direction, chosen horizon.
 *   - Config snapshot: thresholds + stage flag used for THIS decision.
 *   - Raw verdicts: deterministic + persistence verdicts carried
 *     verbatim so downstream doesn't recompute.
 *   - Expectancy snapshot: the full estimate record, including bucket
 *     source, bucket id, sample count, per-horizon breakdown, and
 *     max_ev winner.
 *   - ML snapshot: prior-ready flag, current ML verdict, horizon, p,
 *     model version, reason.
 *   - Combined outcome: gate_active (stage flag), allowed flag,
 *     rejectReason (null on allow).
 */
export interface ScalperShadowDecision {
  direction: ScalperDirection;
  chosen_horizon_sec: ScalperHorizonSec | null;

  /** Snapshot of the thresholds the combined rule saw. NOT mutable by callers. */
  config_snapshot: {
    theta_p: number;
    ev_floor_ticks: number;
    min_bucket_samples: number;
    cost_ticks: number;
    hybrid_gate: boolean;
  };

  deterministic_gate: ScalperDeterministicVerdict;
  persistence_gate: ScalperPersistenceVerdict;

  expectancy: {
    /** Echo of the estimate returned by lookupScalperExpectancy. */
    max_ev_ticks_post_cost: number | null;
    max_ev_horizon_sec: ScalperHorizonSec | null;
    per_horizon: ScalperExpectancyEstimate['per_horizon'];
    bucket_source: ScalperBucketSource | null;
    bucket_id: string | null;
    bucket_sample_count: number | null;
  };

  ml: {
    prior_ml_ready: boolean | null;
    prior_ml_age_ms: number | null;
    current_ml_ready: boolean;
    p_favor_direction: number | null;
    evaluated_horizon_sec: ScalperHorizonSec | null;
    model_version: string;
    reason: string | null;
  };

  /** True when Stage B (hybrid_gate=true) — the `allowed` flag hard-rejects candidates. */
  gate_active: boolean;

  /**
   * Combined verdict. `allowed=true` means every gate passed AND the
   * thresholds cleared. `rejectReason=null` iff allowed. In Stage A
   * `gate_active=false` and `allowed` is advisory only — the generator
   * still emits the candidate as a shadow signal.
   */
  allowed: boolean;
  rejectReason: ScalperShadowRejectReason | null;
}

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Inputs for `buildScalperShadowDecision`. Bundled into one parameter
 * object for stability — adding a new verdict kind or a new passthrough
 * field is a type addition, not a positional-arg refactor.
 */
export interface BuildScalperShadowDecisionInput {
  direction: ScalperDirection;
  /** Decision-time-safe scalper state vector. Carried here for parity audits; not itself consulted by the rule. */
  vec: ScalperStateVector;
  detVerdict: ScalperDeterministicVerdict;
  persistVerdict: ScalperPersistenceVerdict;
  expectancy: ScalperExpectancyEstimate;
  ml: ScalperShadowMlInput;
  priorReadiness: ScalperPriorMlReadiness;
  config: ScalperShadowDecisionConfig;
}

/**
 * Build a full `ScalperShadowDecision` record from the four verdicts plus
 * the config snapshot. This function does NOT emit the allow/reject
 * outcome — that decision is made exclusively by
 * `shouldAllowScalperEntry` below. The split exists so tests can
 * exercise the rule independently of the record shape, and so the log
 * writer can attach the outcome without re-running the rule.
 */
export function buildScalperShadowDecision(
  input: BuildScalperShadowDecisionInput,
): ScalperShadowDecision {
  const { direction, detVerdict, persistVerdict, expectancy, ml, priorReadiness, config } = input;

  // Preliminary record with allowed=false / rejectReason=null; the
  // combined rule will patch these two fields in-place below to keep
  // the log record a single source of truth for "what did the rule see
  // and what did it decide."
  const record: ScalperShadowDecision = {
    direction,
    chosen_horizon_sec: expectancy.max_ev_horizon_sec,
    config_snapshot: {
      theta_p: config.theta_p,
      ev_floor_ticks: config.ev_floor_ticks,
      min_bucket_samples: config.min_bucket_samples,
      cost_ticks: config.cost_ticks,
      hybrid_gate: config.hybrid_gate,
    },
    deterministic_gate: detVerdict,
    persistence_gate: persistVerdict,
    expectancy: {
      max_ev_ticks_post_cost: expectancy.max_ev_ticks_post_cost,
      max_ev_horizon_sec: expectancy.max_ev_horizon_sec,
      per_horizon: expectancy.per_horizon,
      bucket_source: expectancy.bucket_source,
      bucket_id: expectancy.bucket_id,
      bucket_sample_count: expectancy.bucket_sample_count,
    },
    ml: {
      prior_ml_ready: priorReadiness.priorMlReady,
      prior_ml_age_ms: priorReadiness.priorAgeMs,
      current_ml_ready: ml.ready,
      p_favor_direction: ml.pFavorDirection,
      evaluated_horizon_sec: ml.evaluatedHorizonSec,
      model_version: ml.modelVersion,
      reason: ml.reason,
    },
    gate_active: config.hybrid_gate,
    allowed: false,
    rejectReason: null,
  };

  const outcome = shouldAllowScalperEntry(record);
  record.allowed = outcome.allowed;
  record.rejectReason = outcome.rejectReason;
  return record;
}

// ─── The single combined rule ──────────────────────────────────────────────

/**
 * Outcome from the combined rule — lightweight so tests can assert on
 * it without manufacturing a full decision record.
 */
export interface ScalperShadowRuleOutcome {
  allowed: boolean;
  rejectReason: ScalperShadowRejectReason | null;
}

/**
 * The single source of truth for scalper allow / reject.
 *
 * Evaluates the six clauses in strict precedence order, assigning the
 * rejectReason from the first failing clause and short-circuiting the
 * rest. When every clause passes, returns `{ allowed: true,
 * rejectReason: null }`.
 *
 * The function is intentionally PURE w.r.t. its input: it reads the
 * already-populated decision record (including config snapshot,
 * expectancy snapshot, ml snapshot, and raw verdicts) and decides.
 * This decouples threshold values from the rule itself — the decision
 * record is the entire context the rule can consult.
 */
export function shouldAllowScalperEntry(
  decision: ScalperShadowDecision,
): ScalperShadowRuleOutcome {
  // Clause 1: deterministic gate
  if (!decision.deterministic_gate.passed) {
    return {
      allowed: false,
      rejectReason: `deterministic:${decision.deterministic_gate.rejectReason}` as ScalperShadowRejectReason,
    };
  }

  // Clause 2: persistence gate
  if (!decision.persistence_gate.passed) {
    return {
      allowed: false,
      rejectReason: `persistence:${decision.persistence_gate.rejectReason}` as ScalperShadowRejectReason,
    };
  }

  // Clause 3: expectancy — no resolved bucket at any level
  if (decision.expectancy.bucket_source === null) {
    return { allowed: false, rejectReason: 'expectancy_no_bucket_match' };
  }

  // Clause 4: expectancy — resolved bucket is below min samples
  // (defensive — the lookup already enforces this, but the combined
  // rule rechecks against the config snapshot so a future change to the
  // lookup's own default cannot silently alter the gate)
  if (
    decision.expectancy.bucket_sample_count === null ||
    decision.expectancy.bucket_sample_count < decision.config_snapshot.min_bucket_samples
  ) {
    return { allowed: false, rejectReason: 'expectancy_below_min_samples' };
  }

  // Clause 5: expectancy — no horizon winner
  if (decision.expectancy.max_ev_horizon_sec === null) {
    return { allowed: false, rejectReason: 'expectancy_horizon_missing' };
  }

  // Clause 6: consecutive ready cycles
  //
  // The prior cycle's ML ready flag MUST be true. A null prior (no
  // prior record for this direction) fails the guard. A prior cycle
  // that was explicitly ready=false also fails.
  if (decision.ml.prior_ml_ready !== true) {
    return { allowed: false, rejectReason: 'ml_readiness_not_confirmed' };
  }

  // Clause 7: current ML ready
  if (decision.ml.current_ml_ready !== true) {
    return { allowed: false, rejectReason: 'ml_unavailable' };
  }

  // Clause 8: ML horizon must match the expectancy-chosen horizon
  if (decision.ml.evaluated_horizon_sec !== decision.expectancy.max_ev_horizon_sec) {
    return { allowed: false, rejectReason: 'ml_horizon_mismatch' };
  }

  // Clause 9: probability value sanity
  const p = decision.ml.p_favor_direction;
  if (p === null || !Number.isFinite(p) || p < 0 || p > 1) {
    return { allowed: false, rejectReason: 'ml_probability_invalid' };
  }

  // Clause 10: probability meets the theta_p threshold
  if (p < decision.config_snapshot.theta_p) {
    return { allowed: false, rejectReason: 'ml_below_threshold' };
  }

  // Clause 11: post-cost EV meets the floor
  const ev = decision.expectancy.max_ev_ticks_post_cost;
  if (ev === null || !Number.isFinite(ev) || ev < decision.config_snapshot.ev_floor_ticks) {
    return { allowed: false, rejectReason: 'ev_below_threshold' };
  }

  return { allowed: true, rejectReason: null };
}
