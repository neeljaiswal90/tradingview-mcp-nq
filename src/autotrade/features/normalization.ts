/**
 * features/normalization.ts — Spatial normalization policy for NQ/MNQ.
 *
 * The core problem: the codebase was using 1-minute ATR (~7 pts for MNQ)
 * to normalize session-scale geometric distances (VWAP offset: ~400 pts,
 * room-to-structure: ~50-200 pts). This produced absurd ATR multiples
 * (e.g., "100 ATR from VWAP") and caused the extension veto to reject
 * 98.8% of candidates on trending days.
 *
 * This module introduces a normalization policy that separates metrics
 * into two families:
 *
 *   1. MICRO metrics: recent-bar volatility measures (3-bar return,
 *      impulse within a few bars, EMA9 distance). These correctly use
 *      1-minute ATR because the measurement window is bar-scale.
 *
 *   2. SESSION metrics: session-geometry measures (VWAP distance,
 *      room-to-structure, room-to-target). These need a session-scale
 *      normalizer that reflects how far NQ/MNQ typically moves in a
 *      session (~200-400 pts), not how far it moves in one bar (~7 pts).
 *
 * The session-scale normalizer is computed as:
 *   sessionAtr = atr_1m * sqrt(N)
 * where N is configurable (default 60 = ~1 hour of 1m bars).
 *
 * This is a standard volatility scaling assumption (square-root-of-time)
 * that converts bar-level ATR to a longer-horizon estimate. For NQ with
 * 1m ATR ~7 pts, sessionAtr ≈ 7 * sqrt(60) ≈ 54 pts, which makes
 * "2 ATR from VWAP" ≈ 108 pts — a reasonable threshold for a trending
 * day where VWAP is 200-500 pts away.
 *
 * When actual session range data is available, it can override the
 * sqrt-time estimate.
 */

import type { MarketSnapshot, KeyLevels } from '../types.js';

// ── Configuration ────────────────────────────────────────────────────────────

export interface NormalizationConfig {
  /**
   * Number of 1-minute bars to scale ATR by (via sqrt-of-time).
   * Default 60 = ~1 hour of bars.
   * Higher values → more generous session-scale thresholds.
   * Range: 15 (very tight) to 240 (very generous).
   */
  session_scale_bars: number;

  /**
   * When true, attempt to use actual session range (session_high - session_low)
   * as the session normalizer if available and larger than the sqrt estimate.
   * This grounds the normalizer in real observed range rather than a model.
   */
  use_actual_session_range: boolean;

  /**
   * Minimum session normalizer in points. Prevents degenerate values
   * during pre-market or thin conditions.
   */
  min_session_normalizer_pts: number;
}

export const DEFAULT_NORMALIZATION_CONFIG: NormalizationConfig = {
  session_scale_bars: 60,
  use_actual_session_range: true,
  min_session_normalizer_pts: 20, // ~80 ticks on NQ, reasonable floor
};

// ── Result ───────────────────────────────────────────────────────────────────

export interface NormalizationResult {
  /** 1-minute ATR, used for micro-scale normalization. */
  micro_atr: number;
  /** Session-scale normalizer, used for VWAP/room/structure metrics. */
  session_atr: number;
  /** How the session ATR was determined. */
  session_atr_source: 'sqrt_time' | 'session_range' | 'floor';
  /** The sqrt-time estimate before any override. */
  sqrt_time_estimate: number;
  /** Actual session range if available. */
  actual_session_range: number | null;
}

// ── Core Function ────────────────────────────────────────────────────────────

/**
 * Compute both micro-scale and session-scale normalizers from the snapshot.
 *
 * @param snap - Market snapshot with indicators and key levels
 * @param config - Normalization config (optional, uses defaults)
 * @returns Micro and session ATR values with diagnostics
 */
export function computeNormalizers(
  snap: MarketSnapshot,
  config: NormalizationConfig = DEFAULT_NORMALIZATION_CONFIG,
): NormalizationResult | null {
  const atr1m = snap.indicators_1m?.atr_14;
  if (!atr1m || atr1m <= 0) return null;

  // Sqrt-of-time scaling: ATR(1m) * sqrt(N bars)
  const sqrtEstimate = atr1m * Math.sqrt(config.session_scale_bars);

  // Actual session range as alternative
  const kl = snap.key_levels;
  let actualRange: number | null = null;
  if (kl?.session_high !== null && kl?.session_low !== null &&
      kl.session_high !== undefined && kl.session_low !== undefined) {
    const range = kl.session_high - kl.session_low;
    if (range > 0) actualRange = range;
  }

  // Determine session normalizer
  let sessionAtr = sqrtEstimate;
  let source: NormalizationResult['session_atr_source'] = 'sqrt_time';

  if (config.use_actual_session_range && actualRange !== null && actualRange > sqrtEstimate) {
    sessionAtr = actualRange;
    source = 'session_range';
  }

  if (sessionAtr < config.min_session_normalizer_pts) {
    sessionAtr = config.min_session_normalizer_pts;
    source = 'floor';
  }

  return {
    micro_atr: atr1m,
    session_atr: Math.round(sessionAtr * 100) / 100,
    session_atr_source: source,
    sqrt_time_estimate: Math.round(sqrtEstimate * 100) / 100,
    actual_session_range: actualRange !== null ? Math.round(actualRange * 100) / 100 : null,
  };
}

// ── Convenience: normalize a distance ────────────────────────────────────────

/** Normalize a point-distance by the micro ATR. For bar-scale metrics. */
export function normalizeMicro(distancePts: number, microAtr: number): number {
  if (microAtr <= 0) return 0;
  return Math.round(Math.abs(distancePts) / microAtr * 100) / 100;
}

/** Normalize a point-distance by the session ATR. For session-scale metrics. */
export function normalizeSession(distancePts: number, sessionAtr: number): number {
  if (sessionAtr <= 0) return 0;
  return Math.round(Math.abs(distancePts) / sessionAtr * 100) / 100;
}
