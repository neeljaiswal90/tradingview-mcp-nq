/**
 * features/normalization.ts — Spatial normalization policy for NQ/MNQ.
 *
 * Provides THREE distinct scale families for different metric types:
 *
 *   1. MICRO (micro_atr): 1-minute ATR (~7 pts for NQ).
 *      For: impulse size, 3-bar return, EMA9 distance — bar-scale.
 *
 *   2. ROOM (room_atr): higher-timeframe ATR proxy (~17 pts for NQ).
 *      For: room-to-nearest-structure, room-to-target — local structural.
 *      Computed as atr_1m * sqrt(room_scale_bars), default sqrt(5) ≈ 2.24x.
 *      Capped to prevent degenerate values on wide-range days.
 *
 *   3. SESSION (session_atr): session-scale ATR (~54-400+ pts for NQ).
 *      For: VWAP distance — session-geometry.
 *      Computed as atr_1m * sqrt(session_scale_bars) or actual session range.
 *
 * Why room and session are separate:
 *   - VWAP distance is a session-scale measurement (100-500+ pts on trend days)
 *   - Room-to-structure is a local measurement (5-30 pts typically)
 *   - The prior patch correctly fixed VWAP by moving to session scale, but
 *     then applied the same session scale to room, making "1.0 session-ATR
 *     of room" require 59+ pts when median room is only 9 pts. That was a
 *     new calibration bug — room filters need their own intermediate scale.
 */

import type { MarketSnapshot, KeyLevels } from '../types.js';

// ── Configuration ────────────────────────────────────────────────────────────

export interface NormalizationConfig {
  // ── Session-scale (for VWAP distance) ──────────────────────────────────
  /** Bars to scale ATR by for session geometry. Default 60 (~1 hour). */
  session_scale_bars: number;
  /** Use actual session range when larger than sqrt estimate. */
  use_actual_session_range: boolean;
  /** Minimum session normalizer in points. */
  min_session_normalizer_pts: number;

  // ── Room-scale (for room-to-structure) ─────────────────────────────────
  /** Bars to scale ATR by for room filters. Default 5 (~5m equivalent).
   *  Room-to-nearest-level is a local structural measurement (~5-30 pts),
   *  much smaller than session geometry but larger than a single bar. */
  room_scale_bars: number;
  /** Maximum room normalizer in points. Prevents room filter from becoming
   *  trivially permissive on wide-range days. */
  max_room_normalizer_pts: number;
  /** Minimum room normalizer in points. */
  min_room_normalizer_pts: number;
}

export const DEFAULT_NORMALIZATION_CONFIG: NormalizationConfig = {
  // Session-scale: for VWAP distance. sqrt(60)*7 ≈ 54 pts.
  session_scale_bars: 60,
  use_actual_session_range: true,
  min_session_normalizer_pts: 20,
  // Room-scale: for room-to-structure. sqrt(5)*7 ≈ 17 pts.
  // This means "1.0 room-ATR of room" ≈ 17 pts — a reasonable minimum
  // distance to the nearest key level for NQ/MNQ.
  room_scale_bars: 5,
  max_room_normalizer_pts: 40, // cap prevents trivially loose room on wide days
  min_room_normalizer_pts: 8,  // floor prevents degenerate values
};

// ── Result ───────────────────────────────────────────────────────────────────

export interface NormalizationResult {
  /** 1-minute ATR, used for micro-scale normalization. */
  micro_atr: number;
  /** Session-scale normalizer, used for VWAP distance. */
  session_atr: number;
  /** How the session ATR was determined. */
  session_atr_source: 'sqrt_time' | 'session_range' | 'floor';
  /** Room-scale normalizer, used for room-to-structure filters. */
  room_atr: number;
  /** How the room ATR was determined. */
  room_atr_source: 'sqrt_time' | 'capped' | 'floor';
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

  // ── Session-scale normalizer (for VWAP distance) ────────────────────
  const sqrtEstimate = atr1m * Math.sqrt(config.session_scale_bars);

  const kl = snap.key_levels;
  let actualRange: number | null = null;
  if (kl?.session_high !== null && kl?.session_low !== null &&
      kl.session_high !== undefined && kl.session_low !== undefined) {
    const range = kl.session_high - kl.session_low;
    if (range > 0) actualRange = range;
  }

  let sessionAtr = sqrtEstimate;
  let sessionSource: NormalizationResult['session_atr_source'] = 'sqrt_time';

  if (config.use_actual_session_range && actualRange !== null && actualRange > sqrtEstimate) {
    sessionAtr = actualRange;
    sessionSource = 'session_range';
  }
  if (sessionAtr < config.min_session_normalizer_pts) {
    sessionAtr = config.min_session_normalizer_pts;
    sessionSource = 'floor';
  }

  // ── Room-scale normalizer (for room-to-structure) ──────────────────
  // Uses a smaller sqrt scale (~5 bars = 5m equivalent) and is capped
  // so it doesn't grow too large on wide-range days.
  let roomAtr = atr1m * Math.sqrt(config.room_scale_bars);
  let roomSource: NormalizationResult['room_atr_source'] = 'sqrt_time';

  if (roomAtr > config.max_room_normalizer_pts) {
    roomAtr = config.max_room_normalizer_pts;
    roomSource = 'capped';
  }
  if (roomAtr < config.min_room_normalizer_pts) {
    roomAtr = config.min_room_normalizer_pts;
    roomSource = 'floor';
  }

  return {
    micro_atr: atr1m,
    session_atr: Math.round(sessionAtr * 100) / 100,
    session_atr_source: sessionSource,
    room_atr: Math.round(roomAtr * 100) / 100,
    room_atr_source: roomSource,
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

// ── Quant entry-state sigma (Phase 1 of the trend-pullback refactor) ────────
//
// sigma_pts is an ADDITIONAL blended volatility scale used only by the new
// EntryStateVector pipeline for stop sizing and z-scored entry geometry.
// It does NOT replace MICRO / ROOM / SESSION — those continue to serve
// their existing consumers (VWAP-distance filter, room-to-structure, etc.).
//
// Formula (from the refactor plan §5 / §4.3):
//     sigma_pts = max(ATR_14_1m, rv_20_pts, 4 * tick)
//
// where rv_20_pts is the root-mean-square of the last 20 close-to-close
// 1-minute deltas — a simple realized-volatility proxy on the same 1m bar
// stream that feeds ATR. The 4*tick floor prevents degenerate values in
// ultra-quiet conditions.

/**
 * Compute rv_20_pts — realized volatility proxy over the last N 1-minute
 * close-to-close deltas. Returns null if there are not enough bars.
 *
 * rv = sqrt((1/N) * sum(delta_p^2)) where delta_p = close[i] - close[i-1].
 */
export function computeRv20Pts(
  snap: MarketSnapshot,
  lookbackBars: number = 20,
): number | null {
  const bars = snap.bars_1m;
  if (!bars || bars.length < lookbackBars + 1) return null;

  // Use the most recent (lookbackBars + 1) bars to get exactly lookbackBars deltas.
  const recent = bars.slice(-(lookbackBars + 1));
  let sumSq = 0;
  let count = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    if (!prev || !curr) continue;
    const d = curr.close - prev.close;
    sumSq += d * d;
    count++;
  }
  if (count === 0) return null;
  const rv = Math.sqrt(sumSq / count);
  return Math.round(rv * 10000) / 10000;
}

/**
 * Compute sigma_pts, the blended volatility scale used by the quant
 * EntryStateVector. Returns null when the inputs are insufficient to
 * compute a trustworthy value (missing ATR and not enough bars for RV).
 *
 * @param snap - Market snapshot (needs bars_1m and indicators_1m.atr_14)
 * @param tickSize - Native contract tick size (e.g. 0.25 for NQ). Used for
 *                   the `4 * tick` floor.
 */
export function computeSigmaPts(
  snap: MarketSnapshot,
  tickSize: number,
): number | null {
  if (!(tickSize > 0)) return null;

  const atr14 = snap.indicators_1m?.atr_14;
  const atrVal = (atr14 !== null && atr14 !== undefined && atr14 > 0) ? atr14 : null;

  const rv20 = computeRv20Pts(snap, 20);

  // If neither ATR nor RV is available we cannot produce a meaningful
  // sigma — the 4*tick floor alone would be misleading.
  if (atrVal === null && rv20 === null) return null;

  const tickFloor = 4 * tickSize;
  const sigma = Math.max(
    atrVal ?? 0,
    rv20 ?? 0,
    tickFloor,
  );
  return Math.round(sigma * 10000) / 10000;
}

/**
 * z-score a signed point distance by sigma_pts. Unlike normalizeMicro /
 * normalizeSession, this does NOT take the absolute value — sign is
 * preserved so callers can express direction-aware geometry bands
 * (e.g. "price is 0.45 sigma above EMA9" vs "0.45 sigma below").
 *
 * Returns 0 when sigmaPts is non-positive, matching the conservative
 * behavior of the other normalizers.
 */
export function zScorePts(distancePts: number, sigmaPts: number): number {
  if (!(sigmaPts > 0)) return 0;
  return Math.round((distancePts / sigmaPts) * 10000) / 10000;
}
