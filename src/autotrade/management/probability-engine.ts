/**
 * probability-engine.ts — Rules-based in-trade PoP estimation.
 *
 * Architecture:
 * - Implements the ProbabilityModel interface so a trained model can be
 *   hot-swapped later without touching the decision engine or runner.
 * - Uses a signed additive score transformed via sigmoid to pseudo-probability.
 *   This is the same pattern as scoreConfidenceDetailed() in strategy.ts,
 *   but operates on in-trade context rather than pre-entry context.
 * - Final values clamped to [MIN_POP, MAX_POP] to avoid false certainty.
 *
 * Evolving to a trained model:
 * - Replace computePopT1/T2/Runner with a logistic regression (weights trained
 *   on historical (features, outcome) pairs from TradeRecord + ExitLeg data).
 * - The ProbabilityModel interface means no other file changes.
 * - Historical runner already emits the required features if you log them.
 */

import type { ManagementFeatures, TradePoP, ProbabilityModel } from './types.js';

// Probability bounds — never report 0% or 100% certainty from a rules model
const MIN_POP = 0.10;
const MAX_POP = 0.92;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Count how many non-null market context fields are present.
 * Used to decide confidence_in_estimate.
 */
function countAvailableContext(f: ManagementFeatures): number {
  let n = 0;
  if (f.atr_14 !== null) n++;
  if (f.adx !== null) n++;
  if (f.di_plus !== null && f.di_minus !== null) n++;
  if (f.vwap_distance_pts !== null) n++;
  if (f.cvd_trend !== null) n++;
  if (f.ema_alignment !== null) n++;
  if (f.regime !== null) n++;
  return n;
}

export class RulesProbabilityEngine implements ProbabilityModel {
  readonly name = 'rules_v1';
  readonly version = '1.0.0';

  computePoP(f: ManagementFeatures): TradePoP {
    const available = countAvailableContext(f);
    const confidence_in_estimate: TradePoP['confidence_in_estimate'] =
      available >= 5 ? 'high' : available >= 3 ? 'medium' : 'low';

    return {
      pop_target1_before_stop: round2(this.computePopT1(f)),
      pop_target2_before_stop: round2(this.computePopT2(f)),
      pop_runner_extension: round2(this.computePopRunner(f)),
      model_name: this.name,
      model_version: this.version,
      confidence_in_estimate,
    };
  }

  // ── PoP T1 before stop ──────────────────────────────────────────────────────

  private computePopT1(f: ManagementFeatures): number {
    // Already past T1 — PoP is 1 by definition
    if (f.partial_exit_done || f.pt1_done || f.distance_to_t1_pts <= 0) return 1.0;
    // Stop already breached — 0 (shouldn't happen during live trade)
    if (f.distance_to_stop_pts <= 0) return 0.0;

    // ── Base score from geometric distance ratio ──────────────────────────────
    // stop_distance / (stop_distance + t1_distance) → how much "room to lose"
    // vs "room to gain." 0.5 = equidistant, >0.5 = stop is further away.
    const t1dist = Math.max(f.distance_to_t1_pts, 0.01);
    const stopDist = Math.max(f.distance_to_stop_pts, 0.01);
    const geometricRatio = stopDist / (stopDist + t1dist); // [0, 1]
    // Map [0,1] → sigmoid input: neutral at 0.5 ratio → score 0, peaks at ±2
    let score = (geometricRatio - 0.5) * 4; // range: [-2, +2]

    // ── Current momentum ───────────────────────────────────────────────────
    if (f.current_r >= 0.75) score += 0.5;
    else if (f.current_r >= 0.3) score += 0.25;
    else if (f.current_r <= -0.3) score -= 0.5;

    // ── MFE as evidence of directional capacity ────────────────────────────
    // If price already reached 0.7R+ favorable, it has demonstrated strength
    if (f.mfe_r >= 0.7) score += 0.25;

    // ── ADX / trend strength ───────────────────────────────────────────────
    if (f.adx !== null) {
      if (f.adx >= 30) score += 0.5;
      else if (f.adx >= 22) score += 0.25;
      else if (f.adx < 15) score -= 0.4;
    }

    // ── DI directional alignment ───────────────────────────────────────────
    if (f.di_plus !== null && f.di_minus !== null) {
      const diAligned =
        (f.side === 'long' && f.di_plus > f.di_minus) ||
        (f.side === 'short' && f.di_minus > f.di_plus);
      score += diAligned ? 0.35 : -0.3;
    }

    // ── VWAP alignment ─────────────────────────────────────────────────────
    if (f.vwap_distance_pts !== null) {
      if (f.vwap_distance_pts > 0) score += 0.2;
      else score -= 0.2;
    }

    // ── CVD trend alignment ─────────────────────────────────────────────────
    if (f.cvd_trend !== null) {
      const cvdAligned =
        (f.side === 'long' && f.cvd_trend === 'up') ||
        (f.side === 'short' && f.cvd_trend === 'down');
      score += cvdAligned ? 0.25 : -0.2;
    }

    // ── EMA stack alignment ─────────────────────────────────────────────────
    if (f.ema_alignment !== null) {
      if (
        (f.side === 'long' && f.ema_alignment === 'bullish') ||
        (f.side === 'short' && f.ema_alignment === 'bearish')
      ) score += 0.3;
      else if (
        (f.side === 'long' && f.ema_alignment === 'bearish') ||
        (f.side === 'short' && f.ema_alignment === 'bullish')
      ) score -= 0.4;
    }

    // ── Market regime ──────────────────────────────────────────────────────
    if (f.regime !== null) {
      if (
        (f.side === 'long' && f.regime === 'trending_up') ||
        (f.side === 'short' && f.regime === 'trending_down')
      ) score += 0.4;
      else if (f.regime === 'choppy' || f.regime === 'high_volatility_impulse') score -= 0.4;
      else if (
        (f.side === 'long' && f.regime === 'trending_down') ||
        (f.side === 'short' && f.regime === 'trending_up')
      ) score -= 0.6;
    }

    // ── TTM Squeeze reduces directional conviction ─────────────────────────
    if (f.ttm_squeeze_firing === true) score -= 0.2;

    // ── RSI extremes suggest potential reversal ────────────────────────────
    if (f.rsi_14 !== null) {
      if (f.side === 'long' && f.rsi_14 > 75) score -= 0.25;
      if (f.side === 'short' && f.rsi_14 < 25) score -= 0.25;
    }

    return clamp(sigmoid(score), MIN_POP, MAX_POP);
  }

  // ── PoP T2 before stop (unconditional — price reaches T2 before any stop) ──

  private computePopT2(f: ManagementFeatures): number {
    // Past T2 already
    if (f.distance_to_t2_pts <= 0) return 1.0;
    if (f.distance_to_stop_pts <= 0) return 0.0;

    // Base from T1 PoP: reaching T2 requires first reaching T1
    // Apply a multiplicative discount since T2 is further
    const popT1 = this.computePopT1(f);

    // Probability of going T1→T2 given T1 is hit:
    // After T1 stop moves to BE, so now risk is entry price (lower risk).
    // Use adjusted geometric ratio based on (t2dist - t1dist) vs (t1dist as new
    // stop offset from current position).
    const t2dist = Math.max(f.distance_to_t2_pts, 0.01);
    const t1dist = Math.max(f.distance_to_t1_pts, 0.01);
    const stopDist = Math.max(f.distance_to_stop_pts, 0.01);

    // Remaining to T2 beyond T1, vs existing stop distance as a proxy for
    // post-T1 risk (stop moves to BE = current stop distance from T1 level)
    const remainingToT2 = Math.max(t2dist - t1dist, 0.01);
    const beStopDistance = t1dist; // after T1, BE stop is at entry = t1dist away
    const t2ConditionalRatio = beStopDistance / (beStopDistance + remainingToT2);

    let conditionalScore = (t2ConditionalRatio - 0.5) * 3;

    // Strong trend carries through T1 → T2
    if (f.adx !== null && f.adx >= 30) conditionalScore += 0.4;
    if (f.regime !== null) {
      if (
        (f.side === 'long' && f.regime === 'trending_up') ||
        (f.side === 'short' && f.regime === 'trending_down')
      ) conditionalScore += 0.35;
      else if (f.regime === 'choppy') conditionalScore -= 0.35;
    }
    if (f.cvd_trend !== null) {
      const aligned =
        (f.side === 'long' && f.cvd_trend === 'up') ||
        (f.side === 'short' && f.cvd_trend === 'down');
      conditionalScore += aligned ? 0.2 : -0.15;
    }

    const popT2GivenT1 = clamp(sigmoid(conditionalScore), MIN_POP, MAX_POP);

    // Joint: P(T2 before stop) = P(T1 before stop) × P(T2 given T1)
    // Also: if T1 already hit, P(T1) = 1, so pop_t2 = popT2GivenT1
    const effectivePopT1 = f.partial_exit_done || f.pt1_done ? 1.0 : popT1;
    return clamp(effectivePopT1 * popT2GivenT1, MIN_POP, MAX_POP);
  }

  // ── PoP runner extension beyond T2 ─────────────────────────────────────────

  private computePopRunner(f: ManagementFeatures): number {
    if (f.distance_to_stop_pts <= 0) return 0.0;

    // Base: below-average expectation (runners are exceptional, not the norm)
    let score = -0.5;

    // Trend must be strong and sustained
    if (f.adx !== null) {
      if (f.adx >= 35) score += 0.8;
      else if (f.adx >= 28) score += 0.5;
      else if (f.adx >= 22) score += 0.2;
    }

    if (f.regime !== null) {
      if (
        (f.side === 'long' && f.regime === 'trending_up') ||
        (f.side === 'short' && f.regime === 'trending_down')
      ) score += 0.5;
      else if (f.regime === 'choppy' || f.regime === 'range_bound') score -= 0.5;
    }

    // MFE shows the trade has been running — good sign for runner potential
    if (f.mfe_r >= 1.5) score += 0.3;
    else if (f.mfe_r >= 1.0) score += 0.15;

    // EMA momentum
    if (
      (f.side === 'long' && f.ema_alignment === 'bullish') ||
      (f.side === 'short' && f.ema_alignment === 'bearish')
    ) score += 0.25;

    // CVD continuation
    if (f.cvd_trend !== null) {
      const aligned =
        (f.side === 'long' && f.cvd_trend === 'up') ||
        (f.side === 'short' && f.cvd_trend === 'down');
      score += aligned ? 0.2 : -0.2;
    }

    return clamp(sigmoid(score), MIN_POP, 0.75); // runners are rare, cap lower
  }
}
