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
