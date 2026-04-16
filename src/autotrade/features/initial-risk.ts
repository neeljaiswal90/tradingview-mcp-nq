/**
 * features/initial-risk.ts — Phase 4 of the quant trend-pullback refactor.
 *
 * Owns the canonical initial-stop rule for the quant entry pipeline.
 *
 * Rule (plan §9 / §5 Phase 4): the tighter of
 *   1. Volatility stop  = entry ∓ k_sl · sigma_pts
 *   2. Structure stop   = nearest confirmed swing level ∓ one tick buffer
 *
 * "Tighter" means CLOSER to entry — i.e. the smaller risk distance. This is
 * the conservative choice: if a structural level gives a narrower stop,
 * use it; if volatility is tighter than the nearest swing, use sigma.
 *
 * All output prices are tick-rounded via ContractSpec.tick_size. Risk and
 * RR calculations in the orchestrator (`hydrateQuantRewardContract`)
 * happen AFTER tick rounding so replay reproduces live behavior exactly
 * — see plan §3.1 authoritative formulas.
 *
 * Phase 4 scope boundaries (user-confirmed):
 *   - k_sl = 1.05 as a bootstrap value. Per-side / per-session refit is
 *     a Phase 5 follow-up that calibrates on post-cost expectancy,
 *     stop-out frequency, and excursion distribution jointly — NOT a
 *     pure MAE fit.
 *   - Targets are cold-start only (0.7σ / 1.4σ). Empirical bucket
 *     targets are forbidden until Phase 6 — see the hard rule in
 *     dynamic-reward-plan.ts `computeQuantColdStartTargets`.
 *   - The LEGACY `setup.stop` field from the Phase 3 generator is NOT
 *     touched here (plan §3 no-overwrite rule). The quant output lives
 *     in `setup.stop_quant`. A single-assignment-point flip in Stage C
 *     later promotes the quant stop to the legacy field — but that is
 *     explicitly out of Phase 4 scope.
 */

import type { MarketSnapshot, CandidateSetup } from '../types.js';
import type { ContractSpec } from '../contracts.js';
import { detectStructure } from './structure.js';
import { computeQuantColdStartTargets } from './dynamic-reward-plan.js';
import {
  lookupExpectancy,
  attachQuantExpectancy,
  type ExpectancyBucketTable,
} from './expectancy-engine.js';
import type { QuantEntryConfig } from './quant-entry-config.js';

/** Bootstrap volatility multiplier. Phase 5 refit target. */
export const DEFAULT_K_SL = 1.05;

export type InitialStopSource = 'volatility' | 'structure';

export interface EstimateInitialStopInput {
  /** Entry mid (tick-aligned or raw — the output is always tick-rounded). */
  entry: number;
  direction: 'long' | 'short';
  /** Blended volatility scale from entry-state.ts sigma_pts. Must be > 0. */
  sigmaPts: number;
  /**
   * Structural level for the stop: swing_low for long, swing_high for
   * short. May be null when bars are insufficient — in that case the
   * result falls through to the volatility stop.
   */
  structureLevel: number | null;
  /** ContractSpec.tick_size. Must be > 0. */
  tickSize: number;
  /** Defaults to DEFAULT_K_SL. */
  kSl?: number;
}

export interface EstimateInitialStopResult {
  /** Final selected stop, tick-rounded. */
  stop: number;
  /** Which rule actually produced the final stop. */
  source: InitialStopSource;
  /** Volatility stop, tick-rounded, for diagnostics. */
  volatility_stop: number;
  /** Structure stop, tick-rounded, for diagnostics. Null if none. */
  structure_stop: number | null;
  /** k_sl that was used (explicit so replay can verify). */
  k_sl: number;
}

/**
 * Pure function implementing the tighter-of-both rule. Tick-rounds every
 * output price. Callers are responsible for feeding a sensible `entry`
 * and a trustworthy `sigmaPts` — if either is missing this function
 * should not be invoked.
 */
export function estimateInitialStop(
  input: EstimateInitialStopInput,
): EstimateInitialStopResult {
  const { entry, direction, sigmaPts, structureLevel, tickSize } = input;
  if (!(sigmaPts > 0)) {
    throw new Error('estimateInitialStop: sigmaPts must be > 0');
  }
  if (!(tickSize > 0)) {
    throw new Error('estimateInitialStop: tickSize must be > 0');
  }
  const kSl = input.kSl ?? DEFAULT_K_SL;

  // ── Volatility stop: entry ∓ k_sl · sigma ───────────────────────────
  const volStopRaw = direction === 'long'
    ? entry - kSl * sigmaPts
    : entry + kSl * sigmaPts;
  const volStop = roundToTick(volStopRaw, tickSize);

  // ── Structure stop: one tick beyond the nearest swing level ─────────
  let structStop: number | null = null;
  if (
    structureLevel !== null
    && Number.isFinite(structureLevel)
    && structureLevel > 0
  ) {
    // Long: stop just below swing_low. Short: stop just above swing_high.
    const candidate = direction === 'long'
      ? structureLevel - tickSize
      : structureLevel + tickSize;
    // Sanity: the structure stop must be on the correct side of entry.
    // If the swing level is ABOVE entry on a long (or below entry on a
    // short), the "structure stop" would imply negative risk — ignore it.
    const onCorrectSide = direction === 'long'
      ? candidate < entry
      : candidate > entry;
    if (onCorrectSide) {
      structStop = roundToTick(candidate, tickSize);
    }
  }

  // ── Tighter-of-both selection ────────────────────────────────────────
  // Tighter = smaller |entry − stop|. On ties, prefer the volatility
  // stop (more deterministic across replay — structure levels depend on
  // swing detection thresholds which might shift with bar history).
  let stop: number;
  let source: InitialStopSource;
  if (structStop === null) {
    stop = volStop;
    source = 'volatility';
  } else {
    const volRisk = Math.abs(entry - volStop);
    const structRisk = Math.abs(entry - structStop);
    if (structRisk < volRisk) {
      stop = structStop;
      source = 'structure';
    } else {
      stop = volStop;
      source = 'volatility';
    }
  }

  // Degenerate safety: if tick rounding pushed the stop onto the wrong
  // side of entry (e.g. entry equals the tick grid and kSl * sigma is
  // sub-tick), widen by one tick in the correct direction.
  if (direction === 'long' && stop >= entry) {
    stop = roundToTick(entry - tickSize, tickSize);
    source = 'volatility';
  }
  if (direction === 'short' && stop <= entry) {
    stop = roundToTick(entry + tickSize, tickSize);
    source = 'volatility';
  }

  return {
    stop,
    source,
    volatility_stop: volStop,
    structure_stop: structStop,
    k_sl: kSl,
  };
}

// ── Quant reward contract orchestration ─────────────────────────────────────
//
// `hydrateQuantRewardContract` is called from `generateSignal()` after
// `tickRoundCandidate` has run. It:
//   - Uses the (already tick-rounded) legacy entry mid as the entry price.
//   - Pulls sigma_pts from the Phase-1-frozen entry_state_vector.
//   - Detects structure (swing_low/high) from bars_1m via structure.ts.
//   - Invokes estimateInitialStop() and computeQuantColdStartTargets().
//   - Computes risk_pts_quant and rr_{t1,t2}_quant AFTER tick rounding.
//   - Writes every Phase 4 quant field onto the setup in place.
//
// Legacy fields (stop / target_1 / target_2 / risk_pts / rr_t1 / rr_t2)
// are NEVER touched — plan §3 no-overwrite rule. Non-trend_pullback
// setups and setups with no state vector are skipped (every quant field
// left explicitly null so downstream consumers don't see stale values).

export function hydrateQuantRewardContract(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  contract: ContractSpec,
  expectancyTable: ExpectancyBucketTable | null = null,
  quantConfig: QuantEntryConfig | null = null,
): void {
  const vector = setup.entry_state_vector;
  if (!vector || !(vector.sigma_pts > 0)) {
    clearQuantFields(setup);
    return;
  }

  const direction = setup.direction === 'short' ? 'short' : 'long';
  const entry = (setup.entry_low + setup.entry_high) / 2;

  // Structure level: swing_low for long, swing_high for short.
  // detectStructure handles bars < lookback*2+2 gracefully (returns nulls),
  // in which case estimateInitialStop falls through to the volatility stop.
  const structure = detectStructure(snap.bars_1m ?? [], 3);
  const structureLevel = direction === 'long' ? structure.swing_low : structure.swing_high;

  const stopResult = estimateInitialStop({
    entry,
    direction,
    sigmaPts: vector.sigma_pts,
    structureLevel,
    tickSize: contract.tick_size,
  });

  const targets = computeQuantColdStartTargets(
    entry,
    vector.sigma_pts,
    direction,
    contract.tick_size,
  );

  // Risk + RR computed AFTER tick rounding per plan §3.1.
  const riskPts = Math.abs(entry - stopResult.stop);
  const rrT1 = riskPts > 0
    ? Math.abs(targets.target_1_quant - entry) / riskPts
    : 0;
  const rrT2 = riskPts > 0
    ? Math.abs(targets.target_2_quant - entry) / riskPts
    : 0;

  setup.stop_quant = stopResult.stop;
  setup.target_1_quant = targets.target_1_quant;
  setup.target_2_quant = targets.target_2_quant;
  setup.risk_pts_quant = round4(riskPts);
  setup.rr_t1_quant = round4(rrT1);
  setup.rr_t2_quant = round4(rrT2);
  setup.bucket_source_quant = targets.bucket_source_quant;

  // ── Phase 6 expectancy hydration ────────────────────────────────────
  //
  // Plan §3.1: c_R = (fees + slippage_per_side * 2) / stopPts.
  // Missing cost fields on the contract spec fail closed per §3.1
  // — the engine tags the candidate and skips expectancy entirely.
  // Legacy execution fields are never touched here.
  setup.expected_r_30s_quant = null;
  setup.win_prob_30s_quant = null;
  setup.quality_band_quant = null;
  setup.bucket_id_quant = null;
  setup.bucket_sample_count_quant = null;
  setup.quant_shadow_reject_reason = null;

  const feesUsd = contract.fees_per_round_trip_usd;
  const slipPtsPerSide = contract.slippage_pts_per_side;
  const feesValid = typeof feesUsd === 'number' && feesUsd >= 0;
  const slipValid = typeof slipPtsPerSide === 'number' && slipPtsPerSide >= 0;

  if (!feesValid || !slipValid) {
    // Fail closed on missing cost config.
    setup.quant_shadow_reject_reason = 'rejected_by_missing_cost_config';
    return;
  }
  if (riskPts <= 0) {
    // Cannot express cost in R units — also fail closed.
    setup.quant_shadow_reject_reason = 'rejected_by_missing_cost_config';
    return;
  }

  // Convert USD fees to points via ContractSpec.point_value, then to R
  // using the quant risk. Slippage is already in points per side; a
  // round-trip pays 2×.
  const feesPts = (feesUsd as number) / contract.point_value;
  const slipPts = (slipPtsPerSide as number) * 2;
  const costR = (feesPts + slipPts) / riskPts;

  const estimate = lookupExpectancy(expectancyTable, {
    direction,
    vector,
    cost_r: round4(costR),
    min_n: quantConfig?.expectancy.min_bucket_samples,
    side_prior_min_expected_r: quantConfig?.expectancy.side_prior_min_expected_r,
    min_expected_r_primary: quantConfig?.expectancy.min_expected_r_primary,
  });
  attachQuantExpectancy(setup, estimate);
}

function clearQuantFields(setup: CandidateSetup): void {
  setup.stop_quant = null;
  setup.target_1_quant = null;
  setup.target_2_quant = null;
  setup.risk_pts_quant = null;
  setup.rr_t1_quant = null;
  setup.rr_t2_quant = null;
  setup.bucket_source_quant = null;
}

// ── Local helpers ───────────────────────────────────────────────────────────

/**
 * Tick rounding used by estimateInitialStop. Kept local so the pure
 * math helper doesn't depend on a full ContractSpec object — tests can
 * call it directly with any tick size.
 *
 * Matches `roundPriceToTick` in dynamic-reward-plan.ts and the
 * Phase 1 4-decimal rounding convention.
 */
function roundToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  const ticks = Math.round(price / tickSize);
  return Math.round(ticks * tickSize * 10000) / 10000;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
