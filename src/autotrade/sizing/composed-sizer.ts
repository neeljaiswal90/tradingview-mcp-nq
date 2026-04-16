/**
 * composed-sizer.ts — Phase 1 composed position sizer.
 *
 * Computes `q_final = ⌊min(q_risk, q_liq, q_softcap, q_hardcap)⌋` with every
 * component logged so operators can see which cap bound the decision.
 *
 * Design rationale (see plan `majestic-plotting-hamster.md` §"Sizing Model"):
 *   - q_risk    — hard dollar-risk budget: equity × risk% ÷ r_per_contract
 *   - q_liq     — liquidity cap from live LOB (D_2ticks, V_1s) with hysteresis
 *   - q_softcap — dynamic soft cap scaled by regime, confidence, liquidity,
 *                 and drawdown. Only ratchets downward in Phase 1.
 *   - q_hardcap — absolute per-order ceiling (= HARD_CAP in risk.ts = I1).
 *
 * Phase 1 intentionally does NOT include a Kelly term (`q_kelly`). Edge
 * estimates enter only through the soft-cap confidence/regime factors, which
 * cannot inflate size. Phase 2 adds q_kelly behind a feature flag once real
 * paper-trade calibration exists.
 *
 * `r_per_contract` is the realistic all-in dollar risk for one contract:
 *   r = (stop_pts + slippage_buffer_pts) × point_value + fees_per_round_trip_usd
 * floored at (2 × tick_value) + fees so a degenerate stop cannot produce a
 * below-tick risk estimate.
 */

import type { ContractSpec } from '../contracts.js';
import { MAX_NET_POSITION_PER_SYMBOL } from '../risk.js';

// ── Phase 1 default constants ───────────────────────────────────────────────
//
// These mirror the "Initial defaults (Phase 1 launch)" table in the approved
// plan. Tuning should happen via code review — not silent config edits — until
// Phase 2 introduces the `sizing` block in indicator-config.json alongside the
// Kelly term. Raising C_abs / C_base requires ≥100 real paper trades of
// per-symbol evidence.
export const PHASE1_SIZING_DEFAULTS = {
  /** q_hardcap: absolute per-order ceiling. Mirrors risk.ts HARD_CAP (I1). */
  C_abs: 10,
  /** q_softcap base: equal to C_abs at launch so the soft cap only shrinks. */
  C_base: 10,
  /** Confidence shrinkage: c_support = n / (n + k). */
  c_support_k: 100,
  /** Fixed placeholder until a real calibration diagram is built (Phase 2). */
  c_calibration_placeholder: 0.7,
  /** Fixed placeholder until an ensemble lands (Phase 2). */
  c_agreement_placeholder: 0.8,
  /** Liquidity participation rate (η): never take more than this share of depth. */
  eta_liq: 0.07,
  /** q_liq hysteresis: number of cycles a new target must persist before committing. */
  liq_hysteresis_cycles: 3,
  /** Rate-limit q_liq *increases* (decreases commit immediately). */
  liq_increase_cooldown_sec: 30,
  /** Drawdown ratchet floor (d_min): at max drawdown, size is still d_min × base. */
  d_min: 0.25,
  /** Drawdown ratchet slope (γ): higher = faster shrink pre-lockout. */
  gamma: 0.75,
  /** Slippage buffer in points for the `r` formula (bumped from 0.5 → 0.75 for micros). */
  slippage_buffer_pts: 0.75,
  /** Regime → [0,1] map. Conservative initial values; tune only with evidence. */
  regime_scores: {
    strong_trend: 0.9,
    mixed: 0.5,
    chop: 0.3,
    unknown: 0.3,
  } as Record<string, number>,
} as const;

// ── Types ────────────────────────────────────────────────────────────────────

export type ExecutionMode = 'paper' | 'live' | 'signal_only' | 'shadow';

/** Per-component sizing result — every field logged for operator review. */
export interface ComposedSizingResult {
  // Final answer
  q_final: number;
  binding_cap: 'q_risk' | 'q_liq' | 'q_softcap' | 'q_hardcap' | 'net_position' | 'reject';
  reject_reason: string | null;

  // Components
  q_risk: number;
  q_liq: number;
  q_liq_raw: number;
  q_softcap: number;
  q_hardcap: number;

  // Inputs used
  r_per_contract: number;
  b_max_usd: number;
  equity: number;

  // Soft-cap factors
  rho: number;
  c_support: number;
  c_calibration: number;
  c_agreement: number;
  ell: number;
  d: number;

  // Phase 2 placeholders — always null in Phase 1, kept for schema stability.
  q_kelly: number | null;
  mu_R: number | null;
  sigma_R: number | null;
  f_kelly: number | null;
}

/** Liquidity inputs from the LOB snapshot. Any field may be null if stale/missing. */
export interface LiquidityInputs {
  /** Same-side visible depth across first 2 ticks from best. */
  d_2ticks: number | null;
  /** Short-horizon executable flow (1-second rolling median of trade size). */
  v_1s: number | null;
  /** Rolling session median of d_2ticks (for ell normalization). */
  d_median_session: number | null;
  /** true when the snapshot is fresh and healthy. */
  is_fresh: boolean;
}

/** Hysteresis state for q_liq (kept across cycles by the caller). */
export interface QLiqHysteresisState {
  committed: number | null;
  pending_target: number | null;
  pending_cycles: number;
  last_increase_at_ms: number | null;
}

export function makeQLiqHysteresisState(): QLiqHysteresisState {
  return {
    committed: null,
    pending_target: null,
    pending_cycles: 0,
    last_increase_at_ms: null,
  };
}

/** Market / decision-time inputs. */
export interface SizingInputs {
  equity: number;
  max_risk_per_trade_pct: number;
  /** Normalized stop distance in points (≥ 2 ticks). */
  stop_pts: number;
  /** Current open qty on this symbol (0 if flat). Enforces I2 clamp. */
  current_open_qty: number;
  /** Current drawdown for the day in USD (positive number = unrealized+realized loss). */
  drawdown_today_usd: number;
  /** Daily loss limit in USD (= equity × max_daily_loss_pct / 100). */
  daily_loss_limit_usd: number;
  /** Regime label from the current regime detector. */
  regime: string;
  /** Effective sample count for the current decision bucket (shrinks c_support). */
  n_eff: number;
  /** Current execution mode (drives stale-LOB policy). */
  mode: ExecutionMode;
  /** Liquidity snapshot from LOB client (may be null if unavailable). */
  liquidity: LiquidityInputs | null;
  /** Current wall clock (ms) — enables q_liq increase rate limit. */
  now_ms: number;
  /** Hysteresis state for q_liq — mutated in place. */
  hysteresis: QLiqHysteresisState;
}

// ── Main sizer ──────────────────────────────────────────────────────────────

export function computeComposedSizing(
  inputs: SizingInputs,
  contract: ContractSpec,
  cfg: typeof PHASE1_SIZING_DEFAULTS = PHASE1_SIZING_DEFAULTS,
): ComposedSizingResult {
  // 1) Realistic per-contract risk
  const r = computeRPerContract(inputs.stop_pts, contract, cfg.slippage_buffer_pts);

  // 2) q_risk — hard dollar-risk budget (preserves current behavior)
  const b_max_usd = inputs.equity * (inputs.max_risk_per_trade_pct / 100);
  const q_risk = r > 0 ? Math.floor(b_max_usd / r) : 0;

  // 3) Soft-cap factors: ρ, c, ℓ, d
  const rho = resolveRegimeScore(inputs.regime, cfg.regime_scores);
  const c_support = inputs.n_eff / (inputs.n_eff + cfg.c_support_k);
  const c_calibration = cfg.c_calibration_placeholder;
  const c_agreement = cfg.c_agreement_placeholder;
  const c_x = clamp01(c_calibration * c_support * c_agreement);
  const d = computeDrawdownRatchet(
    inputs.drawdown_today_usd,
    inputs.daily_loss_limit_usd,
    cfg.d_min,
    cfg.gamma,
  );

  // 4) q_liq — liquidity cap with mode-dependent stale policy + hysteresis
  const liqResult = computeQLiq(
    inputs.liquidity,
    inputs.mode,
    cfg.eta_liq,
    inputs.hysteresis,
    cfg.liq_hysteresis_cycles,
    cfg.liq_increase_cooldown_sec,
    inputs.now_ms,
  );
  const q_liq = liqResult.q_liq;
  const q_liq_raw = liqResult.q_liq_raw;

  // 5) ell — normalized liquidity for q_softcap (uses d_2ticks / median)
  const ell = computeEll(inputs.liquidity);

  // 6) q_softcap — dynamic soft cap. Floor with a tiny epsilon so that
  // products like (10 × 1 × 1 × 1 × 0.4) which evaluate to 3.9999999999996
  // due to IEEE-754 round to 4 instead of falling to 3.
  const q_softcap = floorWithEpsilon(cfg.C_base * rho * c_x * ell * d);

  // 7) q_hardcap — absolute ceiling (= I1)
  const q_hardcap = cfg.C_abs;

  // 8) Take the minimum. Tie-breaking: when two caps yield the same value,
  // the **most fundamental** safety cap wins (q_hardcap > q_risk > q_softcap > q_liq).
  // Operationally this means "show the operator the most authoritative reason"
  // even when multiple caps coincide at the same number.
  const candidates: Array<{ name: ComposedSizingResult['binding_cap']; value: number }> = [
    { name: 'q_softcap', value: q_softcap },
    { name: 'q_liq', value: q_liq },
    { name: 'q_risk', value: q_risk },
    { name: 'q_hardcap', value: q_hardcap },
  ];
  let q_final = Number.POSITIVE_INFINITY;
  let binding: ComposedSizingResult['binding_cap'] = 'q_hardcap';
  // Forward pass with `<=` so later (more fundamental) caps win ties.
  for (const c of candidates) {
    if (c.value <= q_final) {
      q_final = c.value;
      binding = c.name;
    }
  }
  q_final = Math.max(0, Math.floor(q_final));

  // 9) Clamp against net-position cap (I2)
  const net_headroom = Math.max(0, MAX_NET_POSITION_PER_SYMBOL - inputs.current_open_qty);
  let reject_reason: string | null = null;
  if (q_final > net_headroom) {
    q_final = net_headroom;
    binding = 'net_position';
  }

  // 10) Reject if zero
  if (q_final < 1) {
    if (liqResult.rejected_reason) {
      reject_reason = liqResult.rejected_reason;
      binding = 'reject';
    } else if (q_risk < 1) {
      reject_reason = `budget_$${b_max_usd.toFixed(2)}_lt_r_$${r.toFixed(2)}`;
      binding = 'reject';
    } else if (net_headroom < 1) {
      reject_reason = `net_position_cap: ${inputs.current_open_qty} >= ${MAX_NET_POSITION_PER_SYMBOL}`;
      binding = 'net_position';
    } else {
      reject_reason = `q_final_zero_bound_by_${binding}`;
      binding = 'reject';
    }
  }

  return {
    q_final,
    binding_cap: binding,
    reject_reason,
    q_risk,
    q_liq,
    q_liq_raw,
    q_softcap,
    q_hardcap,
    r_per_contract: round2(r),
    b_max_usd: round2(b_max_usd),
    equity: inputs.equity,
    rho,
    c_support: round4(c_support),
    c_calibration,
    c_agreement,
    ell: round4(ell),
    d: round4(d),
    // Phase 2 placeholders
    q_kelly: null,
    mu_R: null,
    sigma_R: null,
    f_kelly: null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Realistic per-contract risk including slippage buffer and fees. Floored at
 * (2 × tick_value) + fees so a degenerate stop cannot produce a below-tick
 * risk estimate.
 */
export function computeRPerContract(
  stop_pts: number,
  contract: ContractSpec,
  slippage_buffer_pts: number,
): number {
  const fees = contract.fees_per_round_trip_usd ?? 0;
  // Use contract's own slippage buffer when it exceeds the caller-passed one;
  // this lets contracts.ts override the default via slippage_pts_per_side.
  const effective_buffer = Math.max(
    slippage_buffer_pts,
    contract.slippage_pts_per_side ?? 0,
  );
  const raw = (stop_pts + effective_buffer) * contract.point_value + fees;
  const floor = 2 * contract.tick_value + fees;
  return Math.max(raw, floor);
}

/**
 * Drawdown-aware scaling: d(x) = max(d_min, 1 − γ × drawdown / limit).
 * drawdown_today_usd is passed as a non-negative number (magnitude of loss).
 */
export function computeDrawdownRatchet(
  drawdown_today_usd: number,
  daily_loss_limit_usd: number,
  d_min: number,
  gamma: number,
): number {
  if (daily_loss_limit_usd <= 0) return d_min;
  const drawdown_fraction = Math.max(
    0,
    Math.min(1, drawdown_today_usd / daily_loss_limit_usd),
  );
  return Math.max(d_min, 1 - gamma * drawdown_fraction);
}

/**
 * Normalized liquidity factor for q_softcap.
 *   ell = min(1, d_2ticks / d_median_session)
 * Returns 0.5 as a mid-conservative default when data is missing so the
 * soft cap doesn't flap on missing telemetry.
 */
export function computeEll(liquidity: LiquidityInputs | null): number {
  if (!liquidity || !liquidity.is_fresh) return 0.5;
  if (liquidity.d_2ticks == null || liquidity.d_median_session == null) return 0.5;
  if (liquidity.d_median_session <= 0) return 0.5;
  return Math.max(0, Math.min(1, liquidity.d_2ticks / liquidity.d_median_session));
}

export interface QLiqResult {
  q_liq: number;
  q_liq_raw: number;
  rejected_reason: string | null;
}

/**
 * Liquidity-bounded contract count with mode-dependent stale handling +
 * hysteresis so the committed value does not flap as depth oscillates.
 */
export function computeQLiq(
  liquidity: LiquidityInputs | null,
  mode: ExecutionMode,
  eta: number,
  state: QLiqHysteresisState,
  hysteresis_cycles: number,
  increase_cooldown_sec: number,
  now_ms: number,
): QLiqResult {
  // Stale-LOB policy — mode-dependent
  if (!liquidity || !liquidity.is_fresh) {
    if (mode === 'paper' || mode === 'live') {
      return { q_liq: 0, q_liq_raw: 0, rejected_reason: 'lob_stale' };
    }
    // shadow / signal_only: keep the sizer alive with minimum size
    return { q_liq: 1, q_liq_raw: 1, rejected_reason: null };
  }
  const d = liquidity.d_2ticks ?? 0;
  const v = liquidity.v_1s ?? 0;
  const capacity = Math.min(d, v);
  const raw = Math.max(0, Math.floor(eta * capacity));

  // Hysteresis: first commit seeds the state and skips the dwell check
  if (state.committed == null) {
    state.committed = raw;
    state.pending_target = null;
    state.pending_cycles = 0;
    return { q_liq: raw, q_liq_raw: raw, rejected_reason: null };
  }

  // Decreases commit immediately (shrink fast)
  if (raw < state.committed) {
    state.committed = raw;
    state.pending_target = null;
    state.pending_cycles = 0;
    return { q_liq: raw, q_liq_raw: raw, rejected_reason: null };
  }

  // Within ±1: keep current commit (no chatter)
  if (Math.abs(raw - state.committed) < 1) {
    state.pending_target = null;
    state.pending_cycles = 0;
    return { q_liq: state.committed, q_liq_raw: raw, rejected_reason: null };
  }

  // Persistent upward move: require dwell time + cooldown between increases
  if (state.pending_target === raw) {
    state.pending_cycles += 1;
  } else {
    state.pending_target = raw;
    state.pending_cycles = 1;
  }
  const dwell_ok = state.pending_cycles >= hysteresis_cycles;
  const cooldown_ok =
    state.last_increase_at_ms == null ||
    now_ms - state.last_increase_at_ms >= increase_cooldown_sec * 1000;
  if (dwell_ok && cooldown_ok) {
    state.committed = raw;
    state.last_increase_at_ms = now_ms;
    state.pending_target = null;
    state.pending_cycles = 0;
    return { q_liq: raw, q_liq_raw: raw, rejected_reason: null };
  }
  return { q_liq: state.committed, q_liq_raw: raw, rejected_reason: null };
}

function resolveRegimeScore(
  regime: string | null | undefined,
  scores: Record<string, number>,
): number {
  if (!regime) return scores['unknown'] ?? 0.3;
  const key = regime.toLowerCase();
  return scores[key] ?? scores['unknown'] ?? 0.3;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Floor with a tiny epsilon so floating-point noise of ~1e-9 doesn't drop the
 * result by 1. e.g., 3.9999999999996 → 4, but 3.9 → 3.
 */
function floorWithEpsilon(n: number): number {
  return Math.floor(n + 1e-9);
}
