/**
 * features/dynamic-reward-plan.ts — Unified dynamic reward planning.
 *
 * Replaces the fragmented target/RR system with a single canonical planner that:
 *   1. Computes a dynamic minimum RR gate (replaces blunt global min_rr)
 *   2. Resolves management-aligned PT1/PT2 offsets for each candidate
 *   3. Produces diagnostics so every decision is auditable
 *
 * The planner is setup-family-aware, regime-aware, and structure-aware.
 *
 * ── Canonical Source of Truth ──────────────────────────────────────────────
 *
 * BEFORE this patch:
 *   - Generator targets (strategy.ts) → static structural levels
 *   - Hard RR gate (strategy.ts applyHardGates) → config.min_rr (global 2.0)
 *   - Risk RR gate (risk.ts preTradeCheck) → config.min_rr (duplicate)
 *   - Management PT1/PT2 (management-profiles.ts) → ATR-relative, disconnected
 *
 * AFTER this patch:
 *   - Generator targets → unchanged (structural anchors, kept for reference)
 *   - Dynamic RR gate → buildDynamicRewardPlan().dynamic_min_rr (canonical)
 *   - Risk RR gate → uses the same dynamic_min_rr from the plan
 *   - Management PT1/PT2 → plan also resolves management-aligned offsets
 *
 * Design choice: "Plan drives management" (Option A)
 *   The dynamic plan is the canonical source. Management offsets are derived
 *   from the plan's ATR-relative profile at entry time. This ensures the RR
 *   gate and the management targets are always consistent.
 *
 * ── Dynamic Minimum RR Logic ──────────────────────────────────────────────
 *
 * The dynamic min RR is computed as:
 *   base (by setup family)
 *   + regime adjustment
 *   + structure/extension adjustment
 *   + optional microstructure adjustment
 *   → clamped to [FLOOR, CEILING]
 *
 * This moves the RR gate in BOTH directions:
 *   - Lower for high-quality setups in strong trends
 *   - Higher for weak/late/choppy setups
 */

import type { CandidateSetup, MarketRegime, MarketSnapshot, SetupFamily, IndicatorConfig } from '../types.js';
import type { ExtensionFeatures } from './extension.js';
import type { MicrostructureScoreResult } from './microstructure-score.js';
import { getSetupFamily, getManagementProfile, resolveProfile } from '../management-profiles.js';
import { getContractSpec } from '../contracts.js';

// ── Result Type ──────────────────────────────────────────────────────────────

export interface DynamicRewardPlan {
  // ── Dynamic minimum RR ─────────────────────────────────────────────────
  /** The canonical dynamic minimum RR for this candidate. */
  dynamic_min_rr: number;
  /** Whether the candidate's rr_t1 passes the dynamic gate. */
  rr_gate_pass: boolean;
  /** Base RR for this setup family before adjustments. */
  rr_base: number;
  /** Regime adjustment applied (positive = stricter). */
  rr_regime_adj: number;
  /** Structure/extension adjustment (positive = stricter). */
  rr_structure_adj: number;
  /** Microstructure adjustment (positive = stricter, negative = relaxed). */
  rr_micro_adj: number;
  /** Human-readable reason codes for the final RR. */
  rr_components: string[];

  // ── Management-aligned PT offsets ──────────────────────────────────────
  /** Resolved PT1 offset in points (ATR-relative when ATR available). */
  mgmt_pt1_offset_pts: number;
  /** Resolved PT2 offset in points. */
  mgmt_pt2_offset_pts: number;
  /** RR implied by PT1 offset (PT1_offset / risk_pts). */
  mgmt_pt1_implied_rr: number;

  // ── Quality assessment ─────────────────────────────────────────────────
  /** Overall entry quality band. */
  quality_band: 'high' | 'standard' | 'marginal';
  /** Setup family used for planning. */
  setup_family: SetupFamily;
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface DynamicRewardConfig {
  /** Master enable switch. When false, uses legacy config.min_rr everywhere. */
  enabled: boolean;
  /** Per-family baseline min RR. */
  family_baselines: Record<string, number>;
  /** Regime adjustments (added to baseline). */
  regime_adjustments: Record<string, number>;
  /** Absolute floor — dynamic RR never goes below this. */
  rr_floor: number;
  /** Absolute ceiling — dynamic RR never exceeds this. */
  rr_ceiling: number;
  /** Weight for microstructure score adjustment (0 = disabled). */
  micro_weight: number;
}

export const DEFAULT_DYNAMIC_REWARD_CONFIG: DynamicRewardConfig = {
  enabled: true,
  family_baselines: {
    // Trend pullbacks are the bread-and-butter — moderate baseline
    trend_pullback: 1.6,
    // Breakout/momentum setups need clear conviction
    breakout_retest: 1.7,
    momentum_continuation: 1.7,
    // Opening range setups use OR-relative targets, slightly lower bar
    opening_drive: 1.5,
    or_retest: 1.5,
    // Reversal/failed-break setups need higher conviction (riskier thesis)
    failed_or_break: 1.8,
    // Default fallback
    default: 1.8,
  },
  regime_adjustments: {
    // Strong trend reduces required RR (trend provides tailwind)
    trending_up: -0.1,
    trending_down: -0.1,
    // Choppy / range-bound increases required RR (lower continuation probability)
    choppy: +0.3,
    range_bound: +0.2,
    // Compression is ambiguous — slight increase
    compression: +0.1,
    // High volatility impulse — needs higher RR (wider stops, uncertain follow-through)
    high_volatility_impulse: +0.2,
  },
  rr_floor: 1.3,
  rr_ceiling: 3.0,
  micro_weight: 0.15,
};

// ── Internal Helpers ─────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Structure / Extension Adjustment ─────────────────────────────────────────
//
// Looks at extension features (when available) to adjust the required RR:
//   - Clean pullback + reset → lower RR (good entry location)
//   - Late / no-reset / overextended → higher RR (chasing penalty)
//   - Sufficient room → lower RR (realistic target attainable)
//   - Tight room → higher RR (target may be unreachable)

function computeStructureAdj(
  extension: ExtensionFeatures | null | undefined,
  direction: 'long' | 'short',
): { adj: number; reasons: string[] } {
  if (!extension) return { adj: 0, reasons: [] };

  let adj = 0;
  const reasons: string[] = [];

  // Pullback quality: reset occurred = good entry location
  if (extension.reset_occurred) {
    adj -= 0.1;
    reasons.push('reset_occurred(-0.1)');
  } else if (extension.no_reset_extension) {
    adj += 0.15;
    reasons.push('no_reset(+0.15)');
  }

  // Impulse maturity: mature impulse = chasing
  const impulseAtr = extension.current_impulse_atr;
  if (impulseAtr !== null && impulseAtr > 3.0) {
    adj += 0.15;
    reasons.push(`impulse_mature(+0.15,${impulseAtr.toFixed(1)}ATR)`);
  } else if (impulseAtr !== null && impulseAtr < 1.5) {
    adj -= 0.05;
    reasons.push('impulse_fresh(-0.05)');
  }

  // Room available: sufficient room = realistic target
  const roomAtr = direction === 'long'
    ? extension.upside_room_atr
    : extension.downside_room_atr;
  if (roomAtr !== null && roomAtr > 2.0) {
    adj -= 0.1;
    reasons.push(`good_room(-0.1,${roomAtr.toFixed(1)}ATR)`);
  } else if (roomAtr !== null && roomAtr < 1.0) {
    adj += 0.15;
    reasons.push(`tight_room(+0.15,${roomAtr.toFixed(1)}ATR)`);
  }

  // Recent move speed
  const last3 = extension.last_3_bar_return_atr;
  if (last3 !== null && last3 > 2.0) {
    adj += 0.1;
    reasons.push(`fast_move(+0.1,${last3.toFixed(1)}ATR)`);
  }

  // Consecutive push bars without pullback
  if (extension.consecutive_push_bars > 6) {
    adj += 0.1;
    reasons.push(`push_bars(+0.1,${extension.consecutive_push_bars})`);
  }

  return { adj: round2(clamp(adj, -0.3, 0.4)), reasons };
}

// ── Management PT Offset Resolution ──────────────────────────────────────────
//
// Uses the CANONICAL resolveProfile() from management-profiles.ts to compute
// PT1/PT2 offsets. This ensures the reward plan and live management use
// exactly the same resolution path — no duplicate ATR/fallback logic.

interface PtOffsets {
  pt1_offset_pts: number;
  pt2_offset_pts: number;
}

function resolvePtOffsets(
  setupType: string,
  regime: MarketRegime,
  atr: number | null,
  config: IndicatorConfig,
): PtOffsets {
  // Use the same profile lookup + ATR resolution as live management.
  // Resolve the live MNQ contract spec (the default live contract for micros)
  // from the registry rather than embedding a hand-built NQ stub, so shadow
  // mode and live mode resolve PT offsets against the same tick size and
  // point value. If the migration ever targets a different default, update
  // pickDefaultSymbol() in contracts.ts — this code path follows that.
  const profile = getManagementProfile(setupType as import('../types.js').SetupType, regime, config);
  const contract = getContractSpec('MNQ');
  const resolved = resolveProfile(profile, atr, contract);
  return {
    pt1_offset_pts: round2(resolved.pt1_offset_pts),
    pt2_offset_pts: round2(resolved.pt2_offset_pts),
  };
}

// ── Quality Band Classification ──────────────────────────────────────────────

function classifyQuality(dynamicMinRr: number, actualRr: number, structureAdj: number): 'high' | 'standard' | 'marginal' {
  const headroom = actualRr - dynamicMinRr;
  if (headroom >= 0.5 && structureAdj <= 0) return 'high';
  if (headroom >= 0) return 'standard';
  return 'marginal';
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Build a dynamic reward plan for a candidate setup.
 *
 * This is the canonical source of truth for:
 *   - Whether the candidate passes the minimum RR gate
 *   - What management PT1/PT2 offsets to use
 *   - Quality assessment for logging
 *
 * @param setup - The candidate setup from a generator
 * @param snap - Current market snapshot (for ATR)
 * @param regime - Current market regime classification
 * @param config - Indicator config (for management profiles, legacy min_rr)
 * @param extension - Extension features (null if not yet computed)
 * @param microScore - Microstructure overlay result (null if unavailable)
 * @param dynamicConfig - Dynamic reward planning config
 */
export function buildDynamicRewardPlan(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  regime: MarketRegime,
  config: IndicatorConfig,
  extension?: ExtensionFeatures | null,
  microScore?: MicrostructureScoreResult | null,
  dynamicConfig: DynamicRewardConfig = DEFAULT_DYNAMIC_REWARD_CONFIG,
): DynamicRewardPlan {
  const family = getSetupFamily(setup.setup_type);
  const direction = setup.direction as 'long' | 'short';
  const atr = snap.indicators_1m?.atr_14 ?? null;

  // ── Step 1: Resolve baseline min RR by family ───────────────────────
  const rr_base = dynamicConfig.family_baselines[family]
    ?? dynamicConfig.family_baselines['default']
    ?? 1.8;

  // ── Step 2: Regime adjustment ───────────────────────────────────────
  const rr_regime_adj = dynamicConfig.regime_adjustments[regime] ?? 0;

  // ── Step 3: Structure / extension adjustment ────────────────────────
  const structResult = computeStructureAdj(extension, direction);
  const rr_structure_adj = structResult.adj;

  // ── Step 4: Microstructure adjustment (optional) ────────────────────
  let rr_micro_adj = 0;
  if (microScore && dynamicConfig.micro_weight > 0 && microScore.data_quality !== 'none') {
    // Positive microScore.total = supportive → lower required RR
    // Negative microScore.total = contradictory → higher required RR
    rr_micro_adj = round2(-microScore.total * dynamicConfig.micro_weight);
  }

  // ── Step 5: Combine and clamp ───────────────────────────────────────
  const rawMinRr = rr_base + rr_regime_adj + rr_structure_adj + rr_micro_adj;
  const dynamic_min_rr = round2(clamp(rawMinRr, dynamicConfig.rr_floor, dynamicConfig.rr_ceiling));

  // ── Step 6: Gate check ──────────────────────────────────────────────
  const rr_gate_pass = setup.rr_t1 >= dynamic_min_rr;

  // ── Step 7: Resolve management-aligned PT offsets ───────────────────
  const pt = resolvePtOffsets(setup.setup_type, regime, atr, config);
  const mgmt_pt1_implied_rr = setup.risk_pts > 0
    ? round2(pt.pt1_offset_pts / setup.risk_pts)
    : 0;

  // ── Step 8: Build reason codes ──────────────────────────────────────
  const rr_components: string[] = [
    `base:${rr_base}(${family})`,
  ];
  if (rr_regime_adj !== 0) rr_components.push(`regime:${rr_regime_adj > 0 ? '+' : ''}${rr_regime_adj}(${regime})`);
  if (rr_structure_adj !== 0) rr_components.push(...structResult.reasons);
  if (rr_micro_adj !== 0) rr_components.push(`micro:${rr_micro_adj > 0 ? '+' : ''}${rr_micro_adj}`);
  rr_components.push(`→${dynamic_min_rr}(actual=${setup.rr_t1}${rr_gate_pass ? '✓' : '✗'})`);

  // ── Step 9: Quality band ────────────────────────────────────────────
  const quality_band = classifyQuality(dynamic_min_rr, setup.rr_t1, rr_structure_adj);

  return {
    dynamic_min_rr,
    rr_gate_pass,
    rr_base,
    rr_regime_adj,
    rr_structure_adj,
    rr_micro_adj,
    rr_components,
    mgmt_pt1_offset_pts: pt.pt1_offset_pts,
    mgmt_pt2_offset_pts: pt.pt2_offset_pts,
    mgmt_pt1_implied_rr,
    quality_band,
    setup_family: family,
  };
}

// ── Quant cold-start targets (Phase 4 of the trend-pullback refactor) ─────
//
// Per plan §5 Phase 4 HARD RULE: Phase 4 ships with cold-start targets ONLY.
// Bucket-conditioned empirical targets are a Phase 6 payload. Attempting to
// feed empirical bucket values into target_*_quant before Phase 6 is
// contraband — it will contaminate the Stage A comparison distribution.
//
// Formulas (plan §10 cold-start, authoritative):
//   target_1_quant = entry ± 0.7 · sigma_t
//   target_2_quant = entry ± 1.4 · sigma_t
//   bucket_source_quant = 'cold_start'
//
// Tick-rounded via ContractSpec.tickSize per plan §3.1. Subsequent
// risk/RR computations must happen AFTER these rounded values land so
// replay reproduces live behavior exactly.

/** Cold-start multiplier for target_1 in sigma units. */
export const QUANT_COLD_START_TP1_K = 0.7;
/** Cold-start multiplier for target_2 in sigma units. */
export const QUANT_COLD_START_TP2_K = 1.4;

export interface QuantColdStartTargets {
  target_1_quant: number;
  target_2_quant: number;
  bucket_source_quant: 'cold_start';
}

/**
 * Compute the cold-start quant targets for a trend_pullback candidate.
 *
 * @param entry      Entry price (tick-aligned or raw — output is rounded).
 * @param sigmaPts   Blended volatility scale from entry-state.ts.
 * @param direction  Setup direction.
 * @param tickSize   ContractSpec.tick_size for rounding.
 */
export function computeQuantColdStartTargets(
  entry: number,
  sigmaPts: number,
  direction: 'long' | 'short',
  tickSize: number,
): QuantColdStartTargets {
  if (!(sigmaPts > 0)) {
    throw new Error('computeQuantColdStartTargets: sigmaPts must be > 0');
  }
  if (!(tickSize > 0)) {
    throw new Error('computeQuantColdStartTargets: tickSize must be > 0');
  }
  const sign = direction === 'long' ? 1 : -1;
  const t1Raw = entry + sign * QUANT_COLD_START_TP1_K * sigmaPts;
  const t2Raw = entry + sign * QUANT_COLD_START_TP2_K * sigmaPts;
  return {
    target_1_quant: roundPriceToTick(t1Raw, tickSize),
    target_2_quant: roundPriceToTick(t2Raw, tickSize),
    bucket_source_quant: 'cold_start',
  };
}

function roundPriceToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  const ticks = Math.round(price / tickSize);
  // Clean floating-point residue with 4-decimal rounding — matches the
  // tick-rounding helper used by estimateInitialStop().
  return Math.round(ticks * tickSize * 10000) / 10000;
}

/**
 * Build a legacy-compatible plan that exactly replicates the old fixed min_rr behavior.
 * Used as fallback when dynamic reward planning is disabled.
 */
export function buildLegacyRewardPlan(
  setup: CandidateSetup,
  config: IndicatorConfig,
  snap: MarketSnapshot,
): DynamicRewardPlan {
  const family = getSetupFamily(setup.setup_type);
  const atr = snap.indicators_1m?.atr_14 ?? null;
  const regime: MarketRegime = 'trending_up'; // legacy plan doesn't vary by regime
  const pt = resolvePtOffsets(setup.setup_type, regime, atr, config);

  return {
    dynamic_min_rr: config.min_rr,
    rr_gate_pass: setup.rr_t1 >= config.min_rr,
    rr_base: config.min_rr,
    rr_regime_adj: 0,
    rr_structure_adj: 0,
    rr_micro_adj: 0,
    rr_components: [`legacy_fixed:${config.min_rr}`],
    mgmt_pt1_offset_pts: pt.pt1_offset_pts,
    mgmt_pt2_offset_pts: pt.pt2_offset_pts,
    mgmt_pt1_implied_rr: setup.risk_pts > 0 ? round2(pt.pt1_offset_pts / setup.risk_pts) : 0,
    quality_band: setup.rr_t1 >= config.min_rr * 1.5 ? 'high' : setup.rr_t1 >= config.min_rr ? 'standard' : 'marginal',
    setup_family: family,
  };
}
