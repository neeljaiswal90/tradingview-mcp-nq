/**
 * features/microstructure-score.ts — Setup-aware microstructure score overlay.
 *
 * Computes a bounded score in [-2.0, +2.0] from LOB/MBO/microstructure
 * features, with different weighting logic per setup family.
 *
 * Design principles:
 *   - Additive overlay on existing confidence score, not a replacement
 *   - Graceful degradation: missing features → zero contribution, not crash
 *   - Setup-aware: continuation setups reward aligned flow; reversal setups
 *     reward absorption + reclaim evidence
 *   - Small bounded sub-scores prevent one noisy feature from dominating
 *   - All raw fields sourced from LobSnapshot (Python sidecar truth)
 *   - No fabrication: if a field is null, its contribution is 0
 *
 * Score components:
 *   A. Directional flow   [-0.5, +0.5]  — delta/flow aligned with trade direction
 *   B. Book imbalance     [-0.3, +0.3]  — depth imbalance supports direction
 *   C. Absorption         [-0.4, +0.4]  — defended level / exhaustion detection
 *   D. Queue pressure     [-0.3, +0.3]  — queue deterioration in relevant side
 *   E. Sweep behavior     [-0.3, +0.3]  — sweep follow-through or failed sweep
 *   F. Volume profile     [-0.2, +0.2]  — acceptance/rejection at value boundaries
 *   Total range: [-2.0, +2.0]
 */

import type { LobSnapshot } from '../lob-client.js';

// ── Setup Family Classification ─────────────────────────────────────────────

/**
 * Setup families group setup types by their market thesis so the overlay
 * can apply different scoring rules.
 *
 * 'trend_continuation'    — pullback entries expecting trend resumption
 * 'breakout_continuation' — momentum entries after structural break
 * 'reversal_reclaim'      — failed-break / trap setups expecting mean reversion
 * 'session_structure'     — opening-range driven setups
 * 'scalp_high_frequency'  — lob_mbo_scalp family (1–10s holds). Scored
 *                           like a continuation setup by default, with
 *                           volume profile suppressed (no meaning at
 *                           sub-second horizons) and a slightly
 *                           boosted-weight sweep branch reflecting the
 *                           strategy's dependence on recent follow-through.
 *                           Weights are NOT calibrated yet — Phase 4/5
 *                           backtesting will tune them against labeled
 *                           sub-second forward returns.
 */
export type SetupFamily =
  | 'trend_continuation'
  | 'breakout_continuation'
  | 'reversal_reclaim'
  | 'session_structure'
  | 'scalp_high_frequency';

/**
 * Map a setup_type string to its family. Explicit mapping — no wildcards.
 * Returns 'trend_continuation' as the safe default for unknown types.
 */
export function getSetupFamily(setupType: string): SetupFamily {
  switch (setupType) {
    // Trend pullbacks: expecting trend to resume after a pullback
    case 'trend_pullback_long':
    case 'trend_pullback_short':
      return 'trend_continuation';

    // Breakout/breakdown: expecting aggressive continuation after structural break
    case 'breakout_retest_long':
    case 'breakdown_retest_short':
    case 'momentum_continuation':
      return 'breakout_continuation';

    // Failed-break / reclaim: expecting reversal back through the level
    case 'failed_or_break_long':
    case 'failed_or_break_short':
      return 'reversal_reclaim';

    // Session-structure: opening-range-driven breakout/continuation
    case 'opening_drive_continuation_long':
    case 'opening_drive_continuation_short':
      return 'session_structure';

    // LOB/MBO sub-second scalper: treated like continuation for scoring
    // but with suppressed volume profile in the component scorer.
    case 'lob_mbo_scalp_long':
    case 'lob_mbo_scalp_short':
      return 'scalp_high_frequency';

    default:
      return 'trend_continuation';
  }
}

/**
 * Tests + internal helpers use this to check whether a family should
 * receive continuation-style scoring in the component scorers. Keeping
 * the predicate in one place means the three existing continuation
 * disjunctions and any future family addition stay in lockstep.
 */
export function isContinuationFamily(family: SetupFamily): boolean {
  return (
    family === 'trend_continuation' ||
    family === 'breakout_continuation' ||
    family === 'session_structure' ||
    family === 'scalp_high_frequency'
  );
}

// ── Score Result ─────────────────────────────────────────────────────────────

export interface MicrostructureScoreResult {
  /** Total overlay score, bounded [-2.0, +2.0]. */
  total: number;
  /** Sub-scores by component. */
  directional: number;
  imbalance: number;
  absorption: number;
  queue: number;
  sweep: number;
  profile: number;
  /** Human-readable reasons for significant contributions. */
  reasons: string[];
  /** Warnings about data quality or missing features. */
  warnings: string[];
  /** Data quality assessment for the score. */
  data_quality: 'good' | 'partial' | 'minimal' | 'none';
  /** Which setup family was used for scoring. */
  setup_family: SetupFamily;
  /** How many of the 6 sub-score components had data to work with. */
  components_available: number;
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface MicrostructureOverlayConfig {
  /** Master enable switch. When false, computeMicrostructureScore returns zero. */
  enabled: boolean;
  /**
   * Multiplier applied to the total score before it's added to confidence.
   * Default 0.5 means the ±2.0 raw range becomes ±1.0 confidence adjustment.
   * Set to 0 to log diagnostics without affecting scoring.
   */
  multiplier: number;
  /**
   * Maximum positive confidence adjustment allowed.
   * Caps the upward boost so micro can't promote a weak setup too far.
   */
  max_positive_adj: number;
  /**
   * Maximum negative confidence adjustment allowed (as a positive number).
   * Caps the downward penalty so micro can't hard-veto a structurally valid setup.
   */
  max_negative_adj: number;
  /**
   * Minimum data quality to produce a non-zero score.
   * 'minimal' = at least directional flow available.
   * 'partial' = at least 2 sub-components have data.
   * 'good' = at least 4 sub-components have data.
   */
  require_min_data_quality: 'none' | 'minimal' | 'partial' | 'good';
}

export const DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG: MicrostructureOverlayConfig = {
  enabled: true,
  multiplier: 0.5,
  max_positive_adj: 0.8,   // max +0.8 confidence boost
  max_negative_adj: 0.6,   // max -0.6 confidence penalty (asymmetric — harder to demote than promote)
  require_min_data_quality: 'minimal',
};

// ── Confidence Adjustment Helper ─────────────────────────────────────────────

/**
 * Compute the bounded confidence adjustment from a microstructure score result.
 *
 * This is the canonical function for translating a raw microstructure score
 * into a confidence delta that can be applied to bestSetup.confidence.
 *
 * Returns an object with:
 *   - adjustment: the bounded delta (positive = boost, negative = penalty)
 *   - applied: whether the adjustment is non-zero and should be used
 *   - base: the pre-adjustment confidence (for logging)
 *   - final: the post-adjustment confidence (for logging)
 *   - reason: human-readable explanation
 */
export interface MicroAdjustmentResult {
  adjustment: number;
  applied: boolean;
  base_confidence: number;
  final_confidence: number;
  reason: string;
}

export function computeMicroAdjustment(
  score: MicrostructureScoreResult,
  baseConfidence: number,
  config: MicrostructureOverlayConfig,
): MicroAdjustmentResult {
  const noOp: MicroAdjustmentResult = {
    adjustment: 0,
    applied: false,
    base_confidence: baseConfidence,
    final_confidence: baseConfidence,
    reason: 'no_adjustment',
  };

  if (!config.enabled || config.multiplier === 0) {
    return { ...noOp, reason: 'overlay_disabled_or_zero_multiplier' };
  }
  if (score.data_quality === 'none') {
    return { ...noOp, reason: 'no_lob_data' };
  }

  // Raw adjustment = score × multiplier
  let rawAdj = score.total * config.multiplier;

  // Apply asymmetric bounds
  if (rawAdj > 0) {
    rawAdj = Math.min(rawAdj, config.max_positive_adj);
  } else {
    rawAdj = Math.max(rawAdj, -config.max_negative_adj);
  }

  // Round to 0.1 precision (same as confidence scoring)
  const adjustment = Math.round(rawAdj * 10) / 10;

  if (adjustment === 0) {
    return { ...noOp, reason: 'adjustment_rounds_to_zero' };
  }

  const finalConf = Math.max(0, Math.min(10, Math.round((baseConfidence + adjustment) * 10) / 10));

  return {
    adjustment,
    applied: true,
    base_confidence: baseConfidence,
    final_confidence: finalConf,
    reason: `micro:${adjustment > 0 ? '+' : ''}${adjustment.toFixed(1)}(raw=${score.total.toFixed(2)}×${config.multiplier})`,
  };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/** Clamp a value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Safe read: returns 0 if value is null/undefined/NaN. */
function safe(v: number | null | undefined): number {
  if (v === null || v === undefined || Number.isNaN(v)) return 0;
  return v;
}

/** Returns true if value is a real number (not null/undefined/NaN). */
function available(v: number | null | undefined): boolean {
  return v !== null && v !== undefined && !Number.isNaN(v);
}

/** Returns true if value is a real string (not null/undefined/empty). */
function availableStr(v: string | null | undefined): boolean {
  return v !== null && v !== undefined && v !== '';
}

/** Returns 1 for long, -1 for short. */
function dirSign(direction: 'long' | 'short'): number {
  return direction === 'long' ? 1 : -1;
}

// ── Component Scorers ────────────────────────────────────────────────────────
//
// Each component scorer returns a bounded sub-score and a boolean indicating
// whether it had sufficient data to produce a meaningful result.
//
// The scoring logic varies by setup family — that's the key design decision.

export interface ComponentResult {
  score: number;
  hasData: boolean;
  reason: string | null;
}

// ── A. Directional Flow Score [-0.5, +0.5] ──────────────────────────────────
//
// Uses: cumulative_delta_10s/30s, trade_flow_imbalance_10s
// For continuation setups: aligned delta = positive
// For reversal setups: delta divergence from prior move = positive

export function scoreDirectionalFlow(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  family: SetupFamily,
): ComponentResult {
  const delta10 = snap.cumulative_delta_10s;
  const delta30 = snap.cumulative_delta_30s;
  const flowImb = snap.trade_flow_imbalance_10s;

  if (!available(delta10) && !available(delta30) && !available(flowImb)) {
    return { score: 0, hasData: false, reason: null };
  }

  const sign = dirSign(direction);
  let score = 0;

  if (isContinuationFamily(family)) {
    // Continuation: reward aligned delta, penalize opposing
    // trade_flow_imbalance_10s: 0.5 = balanced, >0.5 = buy-heavy, <0.5 = sell-heavy
    if (available(flowImb)) {
      // Transform to [-1, +1] where positive = buy pressure
      const flowBias = (flowImb! - 0.5) * 2;
      // Aligned flow helps, opposing hurts
      score += clamp(flowBias * sign * 0.25, -0.25, 0.25);
    }
    // Rolling delta confirms direction
    if (available(delta10)) {
      const deltaSign = delta10! > 0 ? 1 : delta10! < 0 ? -1 : 0;
      score += deltaSign * sign * 0.15;
    }
    // Longer delta for trend confirmation (skipped for scalp_high_frequency:
    // 30-second momentum building is meaningless at a 1–5 second hold).
    if (family !== 'scalp_high_frequency'
        && available(delta30) && available(delta10)) {
      // Short-term delta stronger than long-term = momentum building
      const momentumBuilding = Math.abs(safe(delta10)) > Math.abs(safe(delta30)) * 0.6;
      if (momentumBuilding && Math.sign(safe(delta10)) === sign) {
        score += 0.10;
      }
    }
  } else if (family === 'reversal_reclaim') {
    // Reversal: reward flow that has FLIPPED toward our direction
    // (prior move was against us, now flow is turning)
    if (available(flowImb)) {
      const flowBias = (flowImb! - 0.5) * 2;
      // Moderate flow toward our direction after a failed move = strong
      const aligned = flowBias * sign;
      if (aligned > 0.1) {
        score += clamp(aligned * 0.35, 0, 0.35);
      } else if (aligned < -0.2) {
        // Flow still heavily in prior direction = bad reversal
        score += clamp(aligned * 0.30, -0.30, 0);
      }
    }
    if (available(delta10)) {
      const deltaAligned = Math.sign(safe(delta10)) === sign;
      score += deltaAligned ? 0.15 : -0.10;
    }
  }

  const finalScore = clamp(Math.round(score * 100) / 100, -0.5, 0.5);
  let reason: string | null = null;
  if (Math.abs(finalScore) >= 0.1) {
    reason = `directional:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}`;
    if (available(flowImb)) reason += `(flow=${flowImb!.toFixed(2)})`;
  }
  return { score: finalScore, hasData: true, reason };
}

// ── B. Book Imbalance Score [-0.3, +0.3] ─────────────────────────────────────
//
// Uses: depth_imbalance_5, bid_size, ask_size
// Positive imbalance in trade direction = supportive

export function scoreBookImbalance(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  _family: SetupFamily,
): ComponentResult {
  const imb5 = snap.depth_imbalance_5;
  const bidSz = snap.bid_size;
  const askSz = snap.ask_size;

  if (!available(imb5) && !(available(bidSz) && available(askSz))) {
    return { score: 0, hasData: false, reason: null };
  }

  const sign = dirSign(direction);
  let score = 0;

  // depth_imbalance_5: range [-1, +1], positive = bid-heavy
  // For longs: bid-heavy is supportive. For shorts: ask-heavy (negative imbalance) is supportive.
  if (available(imb5)) {
    score += clamp(imb5! * sign * 0.25, -0.25, 0.25);
  }

  // BBO size skew: if our direction's resting size is larger, supportive
  if (available(bidSz) && available(askSz)) {
    const total = bidSz! + askSz!;
    if (total > 0) {
      const bboSkew = (bidSz! - askSz!) / total; // [-1, +1]
      score += clamp(bboSkew * sign * 0.05, -0.05, 0.05);
    }
  }

  const finalScore = clamp(Math.round(score * 100) / 100, -0.3, 0.3);
  let reason: string | null = null;
  if (Math.abs(finalScore) >= 0.05) {
    reason = `imbalance:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}`;
  }
  return { score: finalScore, hasData: true, reason };
}

// ── C. Absorption Score [-0.4, +0.4] ─────────────────────────────────────────
//
// Uses: absorption_rate_10s, absorption_bid_score_10s, absorption_ask_score_10s
// For continuation: opposing absorption = bad (level defended against us)
// For reversal: opposing absorption = good (prior move absorbed, supports reversal)

function scoreAbsorption(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  family: SetupFamily,
): ComponentResult {
  const absRate = snap.absorption_rate_10s;
  const absBid = snap.absorption_bid_score_10s;
  const absAsk = snap.absorption_ask_score_10s;

  if (!available(absRate) && !available(absBid) && !available(absAsk)) {
    return { score: 0, hasData: false, reason: null };
  }

  let score = 0;

  if (isContinuationFamily(family)) {
    // Continuation: high absorption against our direction means a defended level
    // is blocking our move — negative signal.
    // For longs: ask-side absorption (sellers absorbed) is good, bid-side absorption is bad
    // For shorts: bid-side absorption (buyers absorbed) is good, ask-side absorption is bad
    if (direction === 'long') {
      if (available(absAsk) && absAsk! > 2.0) {
        // Sellers being absorbed = supportive for longs
        score += clamp((absAsk! - 1.0) * 0.10, 0, 0.25);
      }
      if (available(absBid) && absBid! > 2.0) {
        // Buyers being absorbed = someone defending against our pullback entry
        // Actually this means sellers are absorbing buy flow = negative for longs
        score -= clamp((absBid! - 1.0) * 0.10, 0, 0.20);
      }
    } else {
      if (available(absBid) && absBid! > 2.0) {
        score += clamp((absBid! - 1.0) * 0.10, 0, 0.25);
      }
      if (available(absAsk) && absAsk! > 2.0) {
        score -= clamp((absAsk! - 1.0) * 0.10, 0, 0.20);
      }
    }
    // General absorption_rate: high overall absorption = market is digesting, not trending
    if (available(absRate) && absRate! > 0.8) {
      score -= 0.10; // slowing momentum
    }
  } else if (family === 'reversal_reclaim') {
    // Reversal: absorption AT the extreme is positive (prior move hit a wall)
    // For longs (reclaiming after sweep down): bid-side absorption = buyers defended = good
    // For shorts (reclaiming after sweep up): ask-side absorption = sellers defended = good
    if (direction === 'long' && available(absBid) && absBid! > 1.5) {
      score += clamp((absBid! - 1.0) * 0.15, 0, 0.35);
    }
    if (direction === 'short' && available(absAsk) && absAsk! > 1.5) {
      score += clamp((absAsk! - 1.0) * 0.15, 0, 0.35);
    }
    // High general absorption supports the reversal thesis
    if (available(absRate) && absRate! > 0.6) {
      score += clamp((absRate! - 0.5) * 0.10, 0, 0.10);
    }
  }

  const finalScore = clamp(Math.round(score * 100) / 100, -0.4, 0.4);
  let reason: string | null = null;
  if (Math.abs(finalScore) >= 0.05) {
    reason = `absorption:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}`;
  }
  return { score: finalScore, hasData: true, reason };
}

// ── D. Queue Pressure Score [-0.3, +0.3] ─────────────────────────────────────
//
// Uses: adv_queue_deterioration_bid_10s, adv_queue_deterioration_ask_10s,
//       cancel_add_ratio_10s, replenishment_rate_10s
// Queue deterioration on our side = bad (our support is thinning)
// Queue deterioration on opposing side = good (their defense is crumbling)

export function scoreQueuePressure(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  family: SetupFamily,
): ComponentResult {
  const qdBid = snap.adv_queue_deterioration_bid_10s;
  const qdAsk = snap.adv_queue_deterioration_ask_10s;
  const car = snap.cancel_add_ratio_10s;
  const replenish = snap.replenishment_rate_10s;

  if (!available(qdBid) && !available(qdAsk) && !available(car) && !available(replenish)) {
    return { score: 0, hasData: false, reason: null };
  }

  let score = 0;

  // Queue deterioration scoring — applies to all families
  if (available(qdBid) && available(qdAsk)) {
    if (direction === 'long') {
      // For longs: ask-side deterioration (sellers pulling) = good, bid deterioration = bad
      if (qdAsk! > 1.0) score += clamp((qdAsk! - 0.8) * 0.10, 0, 0.15);
      if (qdBid! > 1.0) score -= clamp((qdBid! - 0.8) * 0.10, 0, 0.15);
    } else {
      // For shorts: bid-side deterioration (buyers pulling) = good, ask deterioration = bad
      if (qdBid! > 1.0) score += clamp((qdBid! - 0.8) * 0.10, 0, 0.15);
      if (qdAsk! > 1.0) score -= clamp((qdAsk! - 0.8) * 0.10, 0, 0.15);
    }
  }

  // Cancel/add ratio: high = lots of cancellation (spoofing or thinning)
  if (available(car)) {
    if (car! > 2.0) {
      // Very high cancel rate indicates unstable book — slight negative
      score -= clamp((car! - 1.5) * 0.05, 0, 0.10);
    }
  }

  // Replenishment after executions: high = level being defended
  if (available(replenish) && family !== 'reversal_reclaim') {
    if (replenish! > 1.0) {
      // High replenishment = someone is defending, could be supportive
      score += 0.05;
    }
  }

  const finalScore = clamp(Math.round(score * 100) / 100, -0.3, 0.3);
  let reason: string | null = null;
  if (Math.abs(finalScore) >= 0.05) {
    reason = `queue:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}`;
  }
  return { score: finalScore, hasData: true, reason };
}

// ── E. Sweep Behavior Score [-0.3, +0.3] ─────────────────────────────────────
//
// Uses: sweep_count_10s, sweep_volume_10s, max_sweep_levels_10s, last_sweep_side
// For continuation: aligned sweep + follow-through = positive
// For reversal: opposing sweep that failed = positive (trap)

function scoreSweepBehavior(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  family: SetupFamily,
): ComponentResult {
  const sweepCount = snap.sweep_count_10s;
  const sweepVol = snap.sweep_volume_10s;
  const lastSweepSide = snap.last_sweep_side;

  if (!available(sweepCount) && !availableStr(lastSweepSide)) {
    return { score: 0, hasData: false, reason: null };
  }

  let score = 0;
  const hasSweeps = available(sweepCount) && sweepCount! > 0;

  if (!hasSweeps) {
    // No recent sweeps — neutral for most setups
    return { score: 0, hasData: true, reason: null };
  }

  // Determine sweep alignment: was the last sweep in our direction or opposing?
  const sweepAligned = (direction === 'long' && lastSweepSide === 'buy')
    || (direction === 'short' && lastSweepSide === 'sell');

  if (isContinuationFamily(family)) {
    // Continuation: aligned sweep = aggressive follow-through = positive
    if (sweepAligned) {
      score += 0.15;
      if (available(sweepVol) && sweepVol! > 100) score += 0.10; // large sweep volume
      // Scalper: very recent aligned sweep is an exceptionally strong
      // short-horizon signal — add a small extra bonus (still inside the
      // ±0.3 cap applied by the clamp below).
      if (family === 'scalp_high_frequency') score += 0.05;
    } else {
      // Opposing sweep during our setup = headwind
      score -= 0.15;
    }
  } else if (family === 'reversal_reclaim') {
    // Reversal: opposing sweep (the move that failed) is positive — it created the trap
    if (!sweepAligned) {
      // The sweep went against our direction and failed → trapped participants
      score += 0.20;
      if (available(sweepCount) && sweepCount! >= 2) score += 0.10; // multiple failed sweeps
    } else {
      // Sweep in our direction during a reversal setup = weakens the thesis
      score -= 0.10;
    }
  }

  const finalScore = clamp(Math.round(score * 100) / 100, -0.3, 0.3);
  let reason: string | null = null;
  if (Math.abs(finalScore) >= 0.05) {
    const sweepDir = sweepAligned ? 'aligned' : 'opposing';
    reason = `sweep:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}(${sweepDir},n=${sweepCount})`;
  }
  return { score: finalScore, hasData: true, reason };
}

// ── F. Volume Profile Score [-0.2, +0.2] ─────────────────────────────────────
//
// Uses: session_vpoc, session_vah, session_val, distance_to_vpoc, inside_value_area
// Light context only — not a dominating factor.
// Acceptance above value = bullish context; rejection at boundaries can confirm setups.

export function scoreVolumeProfile(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  family: SetupFamily,
): ComponentResult {
  // Suppressed for the scalper family: VPOC / value-area acceptance has
  // no meaningful signal at a 1–5 second hold horizon and would just
  // add noise to the overlay. Returning hasData=false keeps the data
  // quality count honest (the scalper gets 5/6 components, not 6/6).
  if (family === 'scalp_high_frequency') {
    return { score: 0, hasData: false, reason: null };
  }

  const vpoc = snap.session_vpoc;
  const vah = snap.session_vah;
  const val = snap.session_val;
  const distVpoc = snap.distance_to_vpoc;
  const insideVA = snap.inside_value_area;

  if (!available(vpoc) || !available(vah) || !available(val)) {
    return { score: 0, hasData: false, reason: null };
  }

  let score = 0;
  const mid = snap.mid;
  if (!available(mid)) return { score: 0, hasData: false, reason: null };

  const sign = dirSign(direction);

  // Price position relative to value area
  if (available(distVpoc)) {
    // Above VPOC for longs = trading in favorable territory
    // Below VPOC for shorts = trading in favorable territory
    const vpocAlignment = Math.sign(distVpoc!) === sign;
    if (vpocAlignment && Math.abs(distVpoc!) > 5) {
      score += 0.10;
    } else if (!vpocAlignment && Math.abs(distVpoc!) > 10) {
      score -= 0.05;
    }
  }

  // Acceptance above/below value area
  if (insideVA === false) {
    // Outside value area: if price is above VAH for longs or below VAL for shorts,
    // this suggests acceptance of new value = continuation support
    if (direction === 'long' && mid! > vah!) {
      score += 0.10;
    } else if (direction === 'short' && mid! < val!) {
      score += 0.10;
    } else {
      // Outside value area in wrong direction
      score -= 0.05;
    }
  }

  const finalScore = clamp(Math.round(score * 100) / 100, -0.2, 0.2);
  let reason: string | null = null;
  if (Math.abs(finalScore) >= 0.05) {
    reason = `profile:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}`;
  }
  return { score: finalScore, hasData: true, reason };
}

// ── G. Microprice Edge Score ─────────────────────────────────────────────────
//
// Uses: bid, ask, bid_size, ask_size (stable BBO data)
// Computes: microprice = (ask * bid_size + bid * ask_size) / (bid_size + ask_size)
// Edge = (microprice - mid) / tick_size, direction-signed
// For all families: microprice edge in trade direction = supportive

export function scoreMicropriceEdge(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  cap: number = 0.5,
): ComponentResult {
  const bid = snap.bid;
  const ask = snap.ask;
  const bidSz = snap.bid_size;
  const askSz = snap.ask_size;

  if (!available(bid) || !available(ask) || !available(bidSz) || !available(askSz)
    || bidSz! + askSz! === 0) {
    return { score: 0, hasData: false, reason: null };
  }

  const microprice = (ask! * bidSz! + bid! * askSz!) / (bidSz! + askSz!);
  const mid = (bid! + ask!) / 2;
  const tickSize = 0.25; // NQ tick size
  const edgeTicks = (microprice - mid) / tickSize;
  const sign = direction === 'long' ? 1 : -1;

  // Direction-signed edge: positive = microprice favors our direction
  const dirEdge = edgeTicks * sign;
  // Scale: 1 tick edge → ~0.12 score, 4+ ticks → capped
  const score = clamp(Math.round(dirEdge * 0.12 * 100) / 100, -cap, cap);

  let reason: string | null = null;
  if (Math.abs(score) >= 0.05) {
    reason = `microprice:${score > 0 ? '+' : ''}${score.toFixed(2)}(edge=${edgeTicks.toFixed(1)}t)`;
  }
  return { score, hasData: true, reason };
}

// ── Data Quality Assessment ──────────────────────────────────────────────────

function assessDataQuality(componentsAvailable: number): 'good' | 'partial' | 'minimal' | 'none' {
  if (componentsAvailable >= 4) return 'good';
  if (componentsAvailable >= 2) return 'partial';
  if (componentsAvailable >= 1) return 'minimal';
  return 'none';
}

function meetsMinQuality(
  quality: 'good' | 'partial' | 'minimal' | 'none',
  required: 'none' | 'minimal' | 'partial' | 'good',
): boolean {
  const rank = { none: 0, minimal: 1, partial: 2, good: 3 };
  return rank[quality] >= rank[required];
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Compute a setup-aware microstructure score overlay.
 *
 * @param snap - Latest LOB snapshot from sidecar (null if unavailable)
 * @param direction - 'long' or 'short'
 * @param setupType - The setup_type string from the candidate
 * @param config - Overlay configuration
 * @returns Bounded score result with diagnostics
 */
export function computeMicrostructureScore(
  snap: LobSnapshot | null | undefined,
  direction: 'long' | 'short',
  setupType: string,
  config: MicrostructureOverlayConfig = DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG,
): MicrostructureScoreResult {
  const family = getSetupFamily(setupType);
  const nullResult: MicrostructureScoreResult = {
    total: 0,
    directional: 0,
    imbalance: 0,
    absorption: 0,
    queue: 0,
    sweep: 0,
    profile: 0,
    reasons: [],
    warnings: [],
    data_quality: 'none',
    setup_family: family,
    components_available: 0,
  };

  // Early exits
  if (!config.enabled) {
    return { ...nullResult, warnings: ['overlay_disabled'] };
  }

  if (!snap || snap.data_quality === 'unavailable' || snap.bbo_age_ms > 5000) {
    return { ...nullResult, warnings: ['no_lob_data'], data_quality: 'none' };
  }

  // Compute each component
  const directional = scoreDirectionalFlow(snap, direction, family);
  const imbalance = scoreBookImbalance(snap, direction, family);
  const absorption = scoreAbsorption(snap, direction, family);
  const queue = scoreQueuePressure(snap, direction, family);
  const sweep = scoreSweepBehavior(snap, direction, family);
  const profile = scoreVolumeProfile(snap, direction, family);

  const components = [directional, imbalance, absorption, queue, sweep, profile];
  const componentsAvailable = components.filter(c => c.hasData).length;
  const dataQuality = assessDataQuality(componentsAvailable);

  // Check minimum data quality requirement
  if (!meetsMinQuality(dataQuality, config.require_min_data_quality)) {
    return {
      ...nullResult,
      data_quality: dataQuality,
      components_available: componentsAvailable,
      warnings: [`insufficient_data_quality:${dataQuality}<${config.require_min_data_quality}`],
    };
  }

  // Sum sub-scores
  const rawTotal = directional.score + imbalance.score + absorption.score
    + queue.score + sweep.score + profile.score;
  const total = clamp(Math.round(rawTotal * 100) / 100, -2.0, 2.0);

  // Collect reasons
  const reasons: string[] = [];
  for (const c of components) {
    if (c.reason) reasons.push(c.reason);
  }

  // Collect warnings
  const warnings: string[] = [];
  if (componentsAvailable < 3) {
    warnings.push(`sparse_data:${componentsAvailable}/6_components`);
  }

  return {
    total,
    directional: directional.score,
    imbalance: imbalance.score,
    absorption: absorption.score,
    queue: queue.score,
    sweep: sweep.score,
    profile: profile.score,
    reasons,
    warnings,
    data_quality: dataQuality,
    setup_family: family,
    components_available: componentsAvailable,
  };
}
