/**
 * target-position.ts — Dynamic target-position model (V1a).
 *
 * Computes a time-varying target position q*(t) = floor(min(q_risk, q_softcap, q_hardcap))
 * from a structural context object. Called from two places:
 *
 *   1. Entry path (runner.ts): context built from CandidateSetup + RiskManager state.
 *   2. Management cycle (management/decision-engine.ts): context built from live
 *      Position + ManagementFeatures + PoP output.
 *
 * V1a scope (see plan):
 *   - Only q_risk, q_softcap, q_hardcap (q_kelly deferred to V1b, q_liq to V1c).
 *   - Entry fills at full q*(t_0); no fractional entry.
 *   - Management cycle may only REDUCE toward target (scale-ins flag-gated off).
 *   - Every sizing decision logs which cap bound (risk / softcap / hardcap).
 */

import type { ContractSpec } from './contracts.js';
import { normalizeStopDistance, riskPerContract, priceToTicks } from './contracts.js';
import type { MarketRegime } from './types.js';

// ───────────────────────────────────────────────────────────────────────────
// Config type (referenced from IndicatorConfig as config.position_target)
// ───────────────────────────────────────────────────────────────────────────

export interface PositionTargetConfig {
  /** Master enable flag. When false, the target-position path is skipped entirely. */
  enabled: boolean;
  /** Absolute maximum contracts, overriding any soft computation. V1a default 10. */
  hard_cap: number;
  /** Base multiplier the softcap starts from before adaptive factors. */
  soft_cap_base: number;
  /** Regime → multiplier lookup. Missing regime falls back to `default`. */
  regime_factors: Record<string, number> & { default: number };
  /** Session bucket → multiplier lookup. Missing bucket falls back to `default`. */
  session_factors: Record<string, number> & { default: number };
  /** Confidence below which the softcap starts shrinking noticeably (diagnostic only in V1a). */
  min_confidence_for_full_size: number;
  /** Fractional entry flag (V1a default false — entry fills at full q*(t_0)). */
  enable_fractional_entry: boolean;
  fractional_entry_min_confidence: number;
  fractional_entry_mode: 'confidence_scaled' | 'fixed_fraction';
  /** Master enable for target recompute during management cycles. */
  management_recompute_enabled: boolean;
  /** Minimum delta_drop that can trigger a partial reduce. */
  management_reduce_min_delta: number;
  /** Cooldown (seconds) between target-position reduces on the same trade. */
  management_reduce_cooldown_sec: number;
  /** A delta_drop at or above this fires immediately without waiting for the persistence counter. */
  reduce_large_delta_threshold: number;
  /** Number of consecutive cycles a small delta_drop must persist before firing. */
  reduce_persistence_cycles_small_delta: number;
  /** Minimum residual contracts after a reduce. Below this → flatten instead. */
  min_residual_contracts: number;
  /** When true, q_target == 0 routes to full-exit instead of partial reduce. */
  flatten_on_zero_target: boolean;
  /** Maximum contracts shaved per cycle (flatten paths ignore this). */
  max_target_reduce_per_cycle: number;
  /** V1a default false — management layer may only tighten stops. */
  stop_widening_allowed: boolean;
  /** Policy for stale / missing inputs. V1a always 'hold_prior_target'. */
  stale_input_policy: 'hold_prior_target';
}

export const DEFAULT_POSITION_TARGET_CONFIG: PositionTargetConfig = {
  enabled: true,
  hard_cap: 10,
  soft_cap_base: 10,
  regime_factors: {
    trending_up: 1.0,
    trending_down: 1.0,
    range_bound: 0.8,
    breakout_attempt: 0.9,
    breakdown_attempt: 0.9,
    compression: 0.7,
    high_volatility_impulse: 0.6,
    choppy: 0.5,
    default: 0.8,
  },
  session_factors: {
    // Keys match StrategySessionBucket from session.ts (classifySession().strategy_bucket)
    NY_AM: 1.0,
    NY_PM: 0.95,
    NY_LUNCH: 0.85,
    LONDON: 0.9,
    ASIA: 0.85,
    default: 0.95,
  },
  min_confidence_for_full_size: 0.7,
  enable_fractional_entry: false,
  fractional_entry_min_confidence: 0.65,
  fractional_entry_mode: 'confidence_scaled',
  management_recompute_enabled: true,
  management_reduce_min_delta: 1,
  management_reduce_cooldown_sec: 20,
  reduce_large_delta_threshold: 2,
  reduce_persistence_cycles_small_delta: 2,
  min_residual_contracts: 1,
  flatten_on_zero_target: true,
  max_target_reduce_per_cycle: 2,
  stop_widening_allowed: false,
  stale_input_policy: 'hold_prior_target',
};

// ───────────────────────────────────────────────────────────────────────────
// Context & result types
// ───────────────────────────────────────────────────────────────────────────

export type ConfidenceSource = 'entry_setup' | 'management_pop_t2' | 'management_pop_t1';

export type BoundBy = 'risk' | 'softcap' | 'hardcap';

export interface TargetPositionContext {
  // ── q_risk inputs ──────────────────────────────────────────────────────
  /**
   * Single authoritative stop distance, in points, always >= 0.
   *
   * Canonical definition (do NOT derive a hybrid):
   *   entry:       |entry_midpoint - setup.stop_price|
   *   management:  |features.current_price - pos.stop_current|
   *
   * The caller is responsible for computing this from the live Position +
   * current reference price; computeTargetPosition() applies normalizeStopDistance()
   * to snap to >= 2 whole ticks.
   */
  stop_distance_pts: number;
  contract: ContractSpec;
  equity: number;
  max_risk_per_trade_pct: number;

  // ── q_softcap inputs ───────────────────────────────────────────────────
  /** Raw confidence score; meaning depends on `confidence_source`. */
  confidence_raw: number;
  confidence_source: ConfidenceSource;
  regime: MarketRegime | null;
  session_bucket: string | null;
  /**
   * Positive drawdown magnitude (from RiskManager state).
   * Always >= 0 on flat/green days; grows positive as losses accumulate.
   * See risk.ts:228-230 for the canonical sign convention.
   */
  daily_loss_pct: number;
  max_daily_loss_pct: number;

  // ── q_hardcap ──────────────────────────────────────────────────────────
  /** Pulled from config.position_target.hard_cap (V1a default 10). */
  hard_cap: number;

  // ── PositionTargetConfig for soft-cap lookups ─────────────────────────
  /** The same config block used for regime_factors / session_factors / soft_cap_base. */
  config: PositionTargetConfig;
}

export interface TargetPositionResult {
  /** floor(min(q_risk, q_softcap, q_hardcap)) — the live target position. */
  q_target: number;
  q_risk: number;
  q_softcap: number;
  q_hardcap: number;

  /**
   * Single-value label. Stable precedence on tie (within 0.01 before floor):
   *   softcap > risk > hardcap
   * Rationale: softcap is the adaptive cap, so ties with structural caps are
   * labeled as softcap-driven — operators care which adaptive factor moved.
   */
  bound_by: BoundBy;
  /** Full binding set (may contain 1–3 entries). Exposed for structured logging. */
  bound_by_all: BoundBy[];

  // ── Factor breakdown (audit trail for dashboard + logs) ───────────────
  confidence_raw: number;
  confidence_factor: number; // c_t, normalized to [0, 1]
  confidence_source: ConfidenceSource;
  regime_factor: number; // ρ_t
  session_factor: number; // s_t
  drawdown_factor: number; // d_t

  // ── Auxiliary numerics carried for logging parity with SizingResult ───
  risk_per_contract_usd: number;
  max_risk_usd: number;
  stop_distance_pts: number;
  stop_distance_ticks: number;
  /**
   * Short diagnostic string. 'ok' on the happy path; otherwise describes why
   * q_target was clamped or zeroed (e.g. 'risk_per_contract_non_positive').
   */
  reason: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Single adapter that normalizes a raw confidence value to [0, 1] based on its
 * source. Called from both entry and management so the entry→management
 * transition is auditable — the result carries both raw and normalized values.
 *
 * Note: setup.confidence is on a 0..10 scale; PoP values are already 0..1.
 * These are not identically calibrated — this is a known V1a limitation and
 * the one place to tune the mapping later (e.g. Platt calibration).
 */
export function normalizeConfidence(source: ConfidenceSource, raw: number): number {
  switch (source) {
    case 'entry_setup':
      return clamp01(raw / 10);
    case 'management_pop_t2':
      return clamp01(raw);
    case 'management_pop_t1':
      return clamp01(raw);
  }
}

function regimeFactor(
  regime: MarketRegime | null,
  factors: PositionTargetConfig['regime_factors'],
): number {
  if (regime == null) return factors.default;
  const v = factors[regime];
  return typeof v === 'number' && Number.isFinite(v) ? v : factors.default;
}

function sessionFactor(
  bucket: string | null,
  factors: PositionTargetConfig['session_factors'],
): number {
  if (bucket == null) return factors.default;
  const v = factors[bucket];
  return typeof v === 'number' && Number.isFinite(v) ? v : factors.default;
}

/**
 * Drawdown ratchet: 1.0 at zero drawdown, linearly falls to 0 at max_daily_loss.
 *
 * Sign convention (must not be flipped): daily_loss_pct is a POSITIVE MAGNITUDE
 * (see risk.ts:228-230). A negative input is treated as a malformed signal and
 * clamped to 0 (drawdown_factor = 1). Hard-zero on max_daily_loss_pct <= 0 to
 * avoid division-by-zero from misconfigured env.
 */
function drawdownFactor(dailyLossPct: number, maxDailyLossPct: number): number {
  if (!Number.isFinite(dailyLossPct) || !Number.isFinite(maxDailyLossPct)) return 1;
  if (maxDailyLossPct <= 0) return 1;
  // daily_loss_pct is a magnitude — negative values indicate caller error, clamp to 0.
  const dd = Math.max(0, dailyLossPct);
  const factor = 1 - dd / maxDailyLossPct;
  if (factor < 0) return 0;
  if (factor > 1) return 1;
  return factor;
}

/**
 * Resolve the tightest cap. Returns the single-label `bound_by` using stable
 * precedence (softcap > risk > hardcap) and the full binding set.
 */
function resolveBoundBy(qRisk: number, qSoft: number, qHard: number): {
  bound_by: BoundBy;
  bound_by_all: BoundBy[];
} {
  const min = Math.min(qRisk, qSoft, qHard);
  const EPS = 0.01;
  const hits: BoundBy[] = [];
  if (qSoft <= min + EPS) hits.push('softcap');
  if (qRisk <= min + EPS) hits.push('risk');
  if (qHard <= min + EPS) hits.push('hardcap');
  // Stable precedence on tie: softcap > risk > hardcap.
  const preferred: BoundBy = hits.includes('softcap')
    ? 'softcap'
    : hits.includes('risk')
      ? 'risk'
      : 'hardcap';
  return { bound_by: preferred, bound_by_all: hits };
}

// ───────────────────────────────────────────────────────────────────────────
// Core: computeTargetPosition
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute q*(t) = floor(min(q_risk, q_softcap, q_hardcap)).
 *
 * Pure function — no side effects, no I/O. Callers (entry path, management cycle)
 * build the context object from their own state and call this.
 */
export function computeTargetPosition(ctx: TargetPositionContext): TargetPositionResult {
  const cfg = ctx.config;

  // ── Normalize the stop distance (tick-snap, >= 2 ticks) ───────────────
  const rawStopPts = ctx.stop_distance_pts;
  const stopPts = normalizeStopDistance(rawStopPts, ctx.contract);
  const stopTicks = priceToTicks(stopPts, ctx.contract);
  const rpcUsd = riskPerContract(stopPts, ctx.contract);
  const maxRiskUsd = ctx.equity * (ctx.max_risk_per_trade_pct / 100);

  // ── Factor breakdown ──────────────────────────────────────────────────
  const cNorm = normalizeConfidence(ctx.confidence_source, ctx.confidence_raw);
  const rho = regimeFactor(ctx.regime, cfg.regime_factors);
  const s = sessionFactor(ctx.session_bucket, cfg.session_factors);
  const d = drawdownFactor(ctx.daily_loss_pct, ctx.max_daily_loss_pct);

  const qHardcap = Math.max(0, Math.floor(ctx.hard_cap));

  // ── Degenerate-stop guard (matches risk.ts:112-126 behavior) ──────────
  if (rpcUsd <= 0 || !Number.isFinite(rpcUsd)) {
    return {
      q_target: 0,
      q_risk: 0,
      q_softcap: 0,
      q_hardcap: qHardcap,
      bound_by: 'risk',
      bound_by_all: ['risk'],
      confidence_raw: ctx.confidence_raw,
      confidence_factor: cNorm,
      confidence_source: ctx.confidence_source,
      regime_factor: rho,
      session_factor: s,
      drawdown_factor: d,
      risk_per_contract_usd: 0,
      max_risk_usd: round2(maxRiskUsd),
      stop_distance_pts: stopPts,
      stop_distance_ticks: stopTicks,
      reason: 'risk_per_contract_non_positive',
    };
  }

  // ── Raw (pre-floor) cap values ────────────────────────────────────────
  const qRiskRaw = maxRiskUsd / rpcUsd;
  const qSoftRaw = cfg.soft_cap_base * cNorm * rho * s * d;

  // Tie labeling uses raw values (within 0.01) so two caps that floor to the
  // same integer but differ pre-floor are still distinguished by the numeric
  // bound that was actually tighter.
  const binding = resolveBoundBy(qRiskRaw, qSoftRaw, qHardcap);

  const qRisk = Math.max(0, Math.floor(qRiskRaw));
  const qSoft = Math.max(0, Math.floor(qSoftRaw));
  const qTarget = Math.max(0, Math.floor(Math.min(qRiskRaw, qSoftRaw, qHardcap)));

  let reason = 'ok';
  if (qTarget <= 0) {
    if (qSoftRaw <= 0) reason = `softcap_zero (d_t=${d.toFixed(2)} c_t=${cNorm.toFixed(2)})`;
    else if (qRiskRaw < 1) reason = `budget_$${maxRiskUsd.toFixed(2)}_lt_risk_per_contract_$${rpcUsd.toFixed(2)}`;
    else reason = 'target_zero';
  }

  return {
    q_target: qTarget,
    q_risk: qRisk,
    q_softcap: qSoft,
    q_hardcap: qHardcap,
    bound_by: binding.bound_by,
    bound_by_all: binding.bound_by_all,
    confidence_raw: ctx.confidence_raw,
    confidence_factor: cNorm,
    confidence_source: ctx.confidence_source,
    regime_factor: rho,
    session_factor: s,
    drawdown_factor: d,
    risk_per_contract_usd: round2(rpcUsd),
    max_risk_usd: round2(maxRiskUsd),
    stop_distance_pts: stopPts,
    stop_distance_ticks: stopTicks,
    reason,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Dashboard / log helper — describeTargetAction
// ───────────────────────────────────────────────────────────────────────────

export type TargetActionKind =
  | 'ON_TARGET'
  | 'REDUCE'
  | 'WOULD_ADD'
  | 'FLATTEN_PENDING'
  | 'HOLD_PERSISTENCE'
  | 'HOLD_COOLDOWN'
  | 'HOLD_BRACKET_SYNC'
  | 'HOLD_STALE_INPUT';

export interface TargetActionDescription {
  kind: TargetActionKind;
  /** |delta| for REDUCE/WOULD_ADD; 0 otherwise. */
  qty: number;
}

/**
 * Derive a single (kind, qty) pair describing what the target-position layer
 * wants to do this cycle. Shared by the dashboard contract and the log line so
 * they always agree.
 *
 * Semantics: the kind reflects the *effective* action this cycle. When the
 * layer wants to reduce but a block is active, the appropriate HOLD_* variant
 * is returned — so operators can tell from a single label whether the pause
 * is because of timing (cooldown/persistence), state inconsistency (bracket
 * sync), or stale inputs (frozen prior target).
 *
 * @param delta                 q_target - quantity_remaining (signed; negative = reduce)
 * @param qTarget               The live q_target value
 * @param persistenceCounter    Current small-drop persistence counter
 * @param cooldownRemainingSec  Seconds remaining on the reduce cooldown (<=0 if elapsed)
 * @param bracketSyncBlocked    True when bracket-sync guard is active
 * @param fromStaleCache        True when q_target is a held prior value (stale-input policy)
 */
export function describeTargetAction(
  delta: number,
  qTarget: number,
  persistenceCounter: number,
  cooldownRemainingSec: number,
  bracketSyncBlocked = false,
  fromStaleCache = false,
): TargetActionDescription {
  // Stale-input hold outranks everything else — the "target" is frozen and
  // doesn't reflect current conditions, so no action can be taken against it.
  if (fromStaleCache) return { kind: 'HOLD_STALE_INPUT', qty: 0 };
  if (qTarget === 0) return { kind: 'FLATTEN_PENDING', qty: 0 };
  if (delta === 0) return { kind: 'ON_TARGET', qty: 0 };
  if (delta > 0) return { kind: 'WOULD_ADD', qty: delta };
  // delta < 0 → reduce wanted — classify which block applies (if any)
  if (bracketSyncBlocked) return { kind: 'HOLD_BRACKET_SYNC', qty: Math.abs(delta) };
  if (cooldownRemainingSec > 0) return { kind: 'HOLD_COOLDOWN', qty: Math.abs(delta) };
  if (persistenceCounter > 0) return { kind: 'HOLD_PERSISTENCE', qty: Math.abs(delta) };
  return { kind: 'REDUCE', qty: Math.abs(delta) };
}

// ───────────────────────────────────────────────────────────────────────────
// Structured log helper
// ───────────────────────────────────────────────────────────────────────────

/**
 * Emit the canonical [TARGET_POS] structured log line used by entry, management
 * recompute, execution, and would-scale-in paths. The `tag` selects the line
 * variant; `approved` controls the icon.
 */
export function logTargetPositionDecision(
  result: TargetPositionResult,
  opts: {
    tag: 'entry' | 'recompute' | 'execute' | 'would_scale_in';
    approved: boolean;
    equity: number;
    qCurrent?: number;
    deltaDrop?: number;
    direction?: 'long' | 'short' | null;
    contractRoot?: string;
  },
): void {
  const icon = opts.approved ? '✅' : '🚫';
  const tag =
    opts.tag === 'entry'
      ? '[TARGET_POS][entry]'
      : opts.tag === 'recompute'
        ? '[TARGET_POS][recompute]'
        : opts.tag === 'execute'
          ? '[TARGET_POS][execute]'
          : '[TARGET_POS][would_scale_in]';

  const boundAll = result.bound_by_all.join(',');
  const dirPart = opts.direction ? `${opts.direction.toUpperCase()} ` : '';
  const contractPart = opts.contractRoot ? `${opts.contractRoot} ` : '';
  const currentPart =
    typeof opts.qCurrent === 'number'
      ? `q_current=${opts.qCurrent} delta=${typeof opts.deltaDrop === 'number' ? opts.deltaDrop : opts.qCurrent - result.q_target} `
      : '';

  console.log(
    `${tag} ${icon} ${dirPart}${contractPart}q_target=${result.q_target} ${currentPart}| ` +
      `q_risk=${result.q_risk} q_softcap=${result.q_softcap} q_hardcap=${result.q_hardcap} | ` +
      `bound_by=${result.bound_by} bound_by_all=[${boundAll}] | ` +
      `c_t_raw=${fmt(result.confidence_raw)} c_t_norm=${fmt(result.confidence_factor)} source=${result.confidence_source} ` +
      `ρ_t=${fmt(result.regime_factor)} s_t=${fmt(result.session_factor)} d_t=${fmt(result.drawdown_factor)} | ` +
      `equity=$${Math.round(opts.equity).toLocaleString()} risk_usd=$${result.max_risk_usd} ` +
      `stop=${result.stop_distance_pts}pts (${result.stop_distance_ticks}tk) | reason=${result.reason}`,
  );
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
