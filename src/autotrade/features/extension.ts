/**
 * features/extension.ts — Entry extension / chase detection.
 *
 * Quantifies how "extended" a candidate entry is from key reference levels,
 * measures impulse exhaustion, and provides deterministic veto logic.
 *
 * Used by strategy.ts to:
 *   1. Add extension features to every candidate signal
 *   2. Apply hard veto rules for obvious late/chase entries
 *   3. Add scoring penalties for borderline extension
 */

import type { OhlcvBar, MarketSnapshot, KeyLevels } from '../types.js';
import { computeNormalizers, normalizeMicro, normalizeSession, DEFAULT_NORMALIZATION_CONFIG } from './normalization.js';
import type { NormalizationConfig, NormalizationResult } from './normalization.js';

// ─── Extension Feature Snapshot ──────────────────────────────────────────────

export interface ExtensionFeatures {
  // A. Distance-from-mean
  //    - *_atr fields use 1m ATR (micro-scale, kept for backward compat)
  //    - *_session fields use session-scale ATR (the correct normalizer for
  //      session-geometry like VWAP distance and room-to-structure)
  dist_from_vwap_pts: number | null;
  dist_from_vwap_atr: number | null;       // micro-normalized (legacy)
  dist_from_vwap_session: number | null;    // session-normalized (primary for veto)
  dist_from_ema9_atr: number | null;
  dist_from_ema21_atr: number | null;
  dist_from_ema50_atr: number | null;

  // B. Impulse-extension (micro-scale: correctly uses 1m ATR)
  current_impulse_pts: number;
  current_impulse_atr: number | null;
  bars_since_impulse_start: number;
  last_3_bar_return_atr: number | null;
  last_5_bar_return_atr: number | null;

  // C. Exhaustion / push-count
  consecutive_push_bars: number;  // bull bars for long, bear bars for short
  bars_since_last_pullback: number;
  range_expansion_ratio: number | null;

  // D. Room-left (directional)
  upside_room_pts: number | null;
  upside_room_atr: number | null;           // micro-normalized (legacy)
  upside_room_session: number | null;       // session-normalized (primary for veto)
  downside_room_pts: number | null;
  downside_room_atr: number | null;         // micro-normalized (legacy)
  downside_room_session: number | null;     // session-normalized (primary for veto)

  // E. Reset / pullback
  reset_occurred: boolean;
  pullback_depth_pts: number;
  pullback_depth_pct_of_impulse: number | null;
  bars_in_pullback: number;
  no_reset_extension: boolean;

  // F. Normalization diagnostics
  normalization_mode: string;           // 'sqrt_time' | 'session_range' | 'floor'
  session_atr: number | null;           // the session-scale normalizer used
  micro_atr: number | null;             // the 1m ATR used
}

// ─── Veto Config ─────────────────────────────────────────────────────────────

export interface EntryExtensionFilterConfig {
  enabled: boolean;
  max_dist_from_vwap_atr_long: number;
  max_dist_from_vwap_atr_short: number;
  max_current_impulse_atr: number;
  min_upside_room_atr: number;
  min_downside_room_atr: number;
  require_reset_after_extension: boolean;
  max_consecutive_push_bars: number;
  max_last_3_bar_return_atr: number;
}

export const DEFAULT_EXTENSION_FILTER_CONFIG: EntryExtensionFilterConfig = {
  enabled: true,
  max_dist_from_vwap_atr_long: 2.0,
  max_dist_from_vwap_atr_short: 2.0,
  max_current_impulse_atr: 2.5,
  min_upside_room_atr: 1.0,
  min_downside_room_atr: 1.0,
  require_reset_after_extension: true,
  max_consecutive_push_bars: 6,
  max_last_3_bar_return_atr: 1.5,
};

// ─── Veto Result ─────────────────────────────────────────────────────────────

export interface ExtensionVetoResult {
  vetoed: boolean;
  reasons: string[];       // hard-veto reasons — backward-compatible
  soft_reasons: string[];  // informational flags; never make vetoed=true
}

// ─── Compute Extension Features ──────────────────────────────────────────────

export function computeExtensionFeatures(
  snap: MarketSnapshot,
  entryMid: number,
  direction: 'long' | 'short',
): ExtensionFeatures {
  // Two reference prices with distinct roles:
  //   entryMid  — the intended fill zone (limit mid-price).  Used for all
  //               fill-price-dependent metrics: distances from mean levels,
  //               upside/downside room.  Keeps veto logic honest — we judge
  //               extension at the place we actually intend to get filled,
  //               not at wherever the tape happens to be right now.
  //   snap.price — current market tape.  Used only for market-state metrics
  //               that describe what the market IS doing (impulse, bar shape,
  //               push counts).  These correctly live on the current bar.
  const ind = snap.indicators_1m;
  const bars = snap.bars_1m;
  const kl = snap.key_levels;
  const atr14 = ind.atr_14;
  const isLong = direction === 'long';

  // ── Compute normalizers ────────────────────────────────────────────────
  // micro_atr: 1m ATR, for bar-scale metrics (impulse, 3-bar return)
  // session_atr: session-scale normalizer, for VWAP distance and room-to-structure
  const norms = computeNormalizers(snap);
  const microAtr = norms?.micro_atr ?? (atr14 ?? 0);
  const sessionAtr = norms?.session_atr ?? microAtr; // fallback to micro if session unavailable
  const normMode = norms?.session_atr_source ?? 'fallback';

  // ── A. Distance from mean (measured from intended fill price) ──────────
  const vwapVal = ind.vwap;
  const dist_from_vwap_pts = vwapVal !== null ? round2(entryMid - vwapVal) : null;
  // Legacy micro-normalized (kept for backward compat and EMA metrics)
  const dist_from_vwap_atr = vwapVal !== null && microAtr > 0
    ? round2(Math.abs(entryMid - vwapVal) / microAtr) : null;
  // Session-normalized: the correct scale for VWAP distance veto
  const dist_from_vwap_session = vwapVal !== null && sessionAtr > 0
    ? round2(Math.abs(entryMid - vwapVal) / sessionAtr) : null;

  const dist_from_ema9_atr = ind.ema_9 !== null && microAtr > 0
    ? round2(Math.abs(entryMid - ind.ema_9) / microAtr) : null;
  const dist_from_ema21_atr = ind.ema_21 !== null && microAtr > 0
    ? round2(Math.abs(entryMid - ind.ema_21) / microAtr) : null;
  const dist_from_ema50_atr = ind.ema_50 !== null && microAtr > 0
    ? round2(Math.abs(entryMid - ind.ema_50) / microAtr) : null;

  // ── B. Impulse extension (market-state — current bars, not fill price) ─
  const impulse = measureImpulse(bars, isLong);

  const current_impulse_atr = atr14 !== null && atr14 > 0
    ? round2(impulse.impulse_pts / atr14) : null;

  const last3 = bars.slice(-3);
  const last5 = bars.slice(-5);
  const last_3_bar_return = last3.length >= 3
    ? last3[last3.length - 1]!.close - last3[0]!.open : 0;
  const last_5_bar_return = last5.length >= 5
    ? last5[last5.length - 1]!.close - last5[0]!.open : 0;

  const last_3_bar_return_atr = atr14 !== null && atr14 > 0
    ? round2(Math.abs(last_3_bar_return) / atr14) : null;
  const last_5_bar_return_atr = atr14 !== null && atr14 > 0
    ? round2(Math.abs(last_5_bar_return) / atr14) : null;

  // ── C. Exhaustion / push count (market-state — bar shapes, not fill price)
  const pushCount = countConsecutivePushBars(bars, isLong);
  const barsSincePullback = countBarsSincePullback(bars, isLong);

  // Range expansion: current bar range vs avg range of last 10
  const recentRanges = bars.slice(-10).map(b => b.high - b.low);
  const avgRange = recentRanges.length > 0
    ? recentRanges.reduce((s, r) => s + r, 0) / recentRanges.length : 0;
  const currentRange = bars.length > 0
    ? bars[bars.length - 1]!.high - bars[bars.length - 1]!.low : 0;
  const range_expansion = avgRange > 0 ? round2(currentRange / avgRange) : null;

  // ── D. Room left (measured from intended fill price) ──────────────────
  const room = computeRoomLeft(entryMid, kl, atr14);
  // Session-scaled room metrics
  const upside_room_session = room.upside_pts !== null && sessionAtr > 0
    ? round2(room.upside_pts / sessionAtr) : null;
  const downside_room_session = room.downside_pts !== null && sessionAtr > 0
    ? round2(room.downside_pts / sessionAtr) : null;

  // ── E. Reset / pullback detection ──────────────────────────────────────
  const reset = detectReset(bars, isLong, impulse.impulse_pts);

  return {
    dist_from_vwap_pts,
    dist_from_vwap_atr,
    dist_from_vwap_session,
    dist_from_ema9_atr,
    dist_from_ema21_atr,
    dist_from_ema50_atr,
    current_impulse_pts: round2(impulse.impulse_pts),
    current_impulse_atr,
    bars_since_impulse_start: impulse.bars_count,
    last_3_bar_return_atr,
    last_5_bar_return_atr,
    consecutive_push_bars: pushCount,
    bars_since_last_pullback: barsSincePullback,
    range_expansion_ratio: range_expansion,
    upside_room_pts: room.upside_pts,
    upside_room_atr: room.upside_atr,
    upside_room_session,
    downside_room_pts: room.downside_pts,
    downside_room_atr: room.downside_atr,
    downside_room_session,
    reset_occurred: reset.occurred,
    pullback_depth_pts: round2(reset.depth_pts),
    pullback_depth_pct_of_impulse: reset.pct_of_impulse,
    bars_in_pullback: reset.bars,
    no_reset_extension: !reset.occurred && impulse.impulse_pts > 0,
    // Normalization diagnostics
    normalization_mode: normMode,
    session_atr: norms?.session_atr ?? null,
    micro_atr: norms?.micro_atr ?? null,
  };
}

// ─── Setup classification ─────────────────────────────────────────────────────

/**
 * Returns true for direction-specific trend pullback setups.
 *
 * On strong trend days session VWAP drifts far from price, but a pullback to
 * EMA9/21 can still be a valid entry.  These setups therefore receive
 * differentiated veto logic: VWAP stretch becomes a soft signal rather than a
 * hard block.  All other real chase conditions (no reset + mature impulse, fast
 * recent move, exhausted push) are still hard-vetoed.
 */
export function isTrendPullbackSetup(setupType: string): boolean {
  return setupType === 'trend_pullback_long' || setupType === 'trend_pullback_short';
}

// ─── Deterministic Veto ──────────────────────────────────────────────────────

/**
 * Evaluate extension veto rules for a candidate entry.
 *
 * @param setupType  Optional setup identifier.  Defaults to '' which gives
 *                   conservative (non-trend-pullback) behaviour — fully
 *                   backward-compatible with callers that omit the argument.
 */
export function evaluateExtensionVeto(
  features: ExtensionFeatures,
  direction: 'long' | 'short',
  config: EntryExtensionFilterConfig,
  setupType: string = '',
): ExtensionVetoResult {
  if (!config.enabled) return { vetoed: false, reasons: [], soft_reasons: [] };

  const isLong = direction === 'long';
  const trendPullback = isTrendPullbackSetup(setupType);
  const hard: string[] = [];
  const soft: string[] = [];

  // ── 1. VWAP distance ────────────────────────────────────────────────────────
  // Uses SESSION-SCALED normalization (dist_from_vwap_session) so that a
  // normal trending-day VWAP distance of ~400 pts registers as ~2-4 session-ATR
  // rather than the absurd 50-100+ micro-ATR that the old 1m normalization
  // produced. The config thresholds (max_dist_from_vwap_atr_long/short) are
  // applied against the session-scaled value.
  //
  // Trend pullbacks: VWAP can legitimately be far on strong trend days → soft.
  // All other setups: hard veto.
  const vwapDist = features.dist_from_vwap_session ?? features.dist_from_vwap_atr;
  if (vwapDist !== null) {
    const maxDist = isLong
      ? config.max_dist_from_vwap_atr_long
      : config.max_dist_from_vwap_atr_short;
    const signedDist = features.dist_from_vwap_pts ?? 0;
    const extendedInDirection = isLong ? signedDist > 0 : signedDist < 0;
    if (extendedInDirection && vwapDist > maxDist) {
      const scale = features.dist_from_vwap_session !== null ? 'session' : 'micro';
      const msg = `extended_from_vwap:${vwapDist.toFixed(1)}${scale}ATR>${maxDist}`;
      if (trendPullback) soft.push(msg);
      else               hard.push(msg);
    }
  }

  // ── Pre-compute chase-condition flags (shared by both paths) ────────────────

  // Impulse already mature
  const impulseMature =
    features.current_impulse_atr !== null &&
    features.current_impulse_atr > config.max_current_impulse_atr;
  const impulseMsg = impulseMature
    ? `impulse_already_mature:${features.current_impulse_atr!.toFixed(1)}ATR>${config.max_current_impulse_atr}`
    : '';

  // No reset after a meaningful extension
  const noReset =
    config.require_reset_after_extension &&
    features.no_reset_extension &&
    features.current_impulse_atr !== null &&
    features.current_impulse_atr > 1.0;
  const noResetMsg = noReset
    ? `no_reset_after_extension:impulse=${features.current_impulse_atr!.toFixed(1)}ATR`
    : '';

  // Too many consecutive push bars
  const tooManyPush = features.consecutive_push_bars > config.max_consecutive_push_bars;
  const pushMsg = tooManyPush
    ? `too_many_push_bars:${features.consecutive_push_bars}>${config.max_consecutive_push_bars}`
    : '';

  // Recent move too fast
  const tooFast =
    features.last_3_bar_return_atr !== null &&
    features.last_3_bar_return_atr > config.max_last_3_bar_return_atr;
  const fastMsg = tooFast
    ? `recent_move_too_fast:${features.last_3_bar_return_atr!.toFixed(1)}ATR>${config.max_last_3_bar_return_atr}`
    : '';

  // ── Apply veto rules ────────────────────────────────────────────────────────

  if (trendPullback) {
    _vetoTrendPullback(
      features, isLong, config, hard,
      { impulseMature, impulseMsg, noReset, noResetMsg, tooFast, fastMsg, tooManyPush, pushMsg },
    );
  } else {
    // Non-trend-pullback: every condition is an independent hard veto.
    // This is the original behaviour, preserved exactly.
    if (impulseMature) hard.push(impulseMsg);

    // Room checks: prefer session-scaled values, fall back to micro-scaled
    const upsideRoom = features.upside_room_session ?? features.upside_room_atr;
    const downsideRoom = features.downside_room_session ?? features.downside_room_atr;
    if (isLong && upsideRoom !== null && upsideRoom < config.min_upside_room_atr) {
      const scale = features.upside_room_session !== null ? 'session' : 'micro';
      hard.push(`insufficient_upside_room:${upsideRoom.toFixed(1)}${scale}ATR<${config.min_upside_room_atr}`);
    }
    if (!isLong && downsideRoom !== null && downsideRoom < config.min_downside_room_atr) {
      const scale = features.downside_room_session !== null ? 'session' : 'micro';
      hard.push(`insufficient_downside_room:${downsideRoom.toFixed(1)}${scale}ATR<${config.min_downside_room_atr}`);
    }

    if (noReset)     hard.push(noResetMsg);
    if (tooManyPush) hard.push(pushMsg);
    if (tooFast)     hard.push(fastMsg);
  }

  // Deduplicate — paired-condition paths can push the same message twice
  const reasons = [...new Set(hard)];

  return { vetoed: reasons.length > 0, reasons, soft_reasons: soft };
}

// ─── Trend-pullback hard-veto helper ─────────────────────────────────────────

/**
 * Applies hard-veto rules that are specific to trend pullback setups.
 * Mutates the `hard` array in place.
 *
 * Rules (plain English):
 *   1. Insufficient room in trade direction → always hard (direction-aware).
 *   2. Mature impulse AND no reset → both pushed (paired condition).
 *   3. Mature impulse alone, if egregious (>2× limit) → standalone hard veto.
 *   4. Recent move too fast AND (no reset OR mature impulse) → hard.
 *   5. Too many push bars AND (no reset OR mature impulse) → hard.
 *
 * Notes:
 *   - VWAP stretch is handled in the caller (goes to soft_reasons).
 *   - No-reset alone, without either fast move or mature impulse, is NOT a hard
 *     veto for trend pullbacks (a fresh early-trend leg with no reset is fine).
 */
function _vetoTrendPullback(
  features: ExtensionFeatures,
  isLong: boolean,
  config: EntryExtensionFilterConfig,
  hard: string[],
  flags: {
    impulseMature: boolean; impulseMsg: string;
    noReset: boolean;       noResetMsg: string;
    tooFast: boolean;       fastMsg: string;
    tooManyPush: boolean;   pushMsg: string;
  },
): void {
  const { impulseMature, impulseMsg, noReset, noResetMsg, tooFast, fastMsg, tooManyPush, pushMsg } = flags;

  // 1. Room: unconditional hard veto — uses session-scaled room when available
  const upsideRoom = features.upside_room_session ?? features.upside_room_atr;
  const downsideRoom = features.downside_room_session ?? features.downside_room_atr;
  if (isLong && upsideRoom !== null && upsideRoom < config.min_upside_room_atr) {
    const scale = features.upside_room_session !== null ? 'session' : 'micro';
    hard.push(`insufficient_upside_room:${upsideRoom.toFixed(1)}${scale}ATR<${config.min_upside_room_atr}`);
  }
  if (!isLong && downsideRoom !== null && downsideRoom < config.min_downside_room_atr) {
    const scale = features.downside_room_session !== null ? 'session' : 'micro';
    hard.push(`insufficient_downside_room:${downsideRoom.toFixed(1)}${scale}ATR<${config.min_downside_room_atr}`);
  }

  // 2. Mature impulse + no reset: combined chase signal
  if (impulseMature && noReset) {
    hard.push(impulseMsg, noResetMsg);
  } else if (impulseMature && features.current_impulse_atr! > 2 * config.max_current_impulse_atr) {
    // Egregiously large impulse (>2× limit) is a standalone hard veto even
    // after a reset — something went very wrong with the setup timing.
    hard.push(impulseMsg);
  }

  // 3. Recent bars too fast: hard when paired with any chase condition
  if (tooFast && (noReset || impulseMature)) {
    hard.push(fastMsg);
    if (noReset)     hard.push(noResetMsg);
    if (impulseMature) hard.push(impulseMsg);
  }

  // 4. Too many push bars: hard when paired with any chase condition
  if (tooManyPush && (noReset || impulseMature)) {
    hard.push(pushMsg);
    if (noReset)     hard.push(noResetMsg);
    if (impulseMature) hard.push(impulseMsg);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function measureImpulse(bars: OhlcvBar[], isLong: boolean): {
  impulse_pts: number;
  bars_count: number;
} {
  if (bars.length < 3) return { impulse_pts: 0, bars_count: 0 };

  const current = bars[bars.length - 1]!;
  let impulseStart = current.close;
  let barsCount = 0;

  // Walk backward to find where the current directional move started
  for (let i = bars.length - 2; i >= Math.max(0, bars.length - 20); i--) {
    const bar = bars[i]!;
    if (isLong) {
      if (bar.close < impulseStart) {
        impulseStart = bar.close;
        barsCount = bars.length - 1 - i;
      }
      if (bar.close > current.close) break; // move reversed
    } else {
      if (bar.close > impulseStart) {
        impulseStart = bar.close;
        barsCount = bars.length - 1 - i;
      }
      if (bar.close < current.close) break;
    }
  }

  const impulsePts = Math.abs(current.close - impulseStart);
  return { impulse_pts: impulsePts, bars_count: barsCount };
}

function countConsecutivePushBars(bars: OhlcvBar[], isLong: boolean): number {
  let count = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i]!;
    const isBullish = bar.close > bar.open;
    if ((isLong && isBullish) || (!isLong && !isBullish)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function countBarsSincePullback(bars: OhlcvBar[], isLong: boolean): number {
  for (let i = bars.length - 1; i >= 1; i--) {
    const bar = bars[i]!;
    const isBullish = bar.close > bar.open;
    // A pullback bar is a bar against the trend direction
    if ((isLong && !isBullish) || (!isLong && isBullish)) {
      return bars.length - 1 - i;
    }
  }
  return bars.length;
}

function computeRoomLeft(price: number, kl: KeyLevels, atr14: number | null): {
  upside_pts: number | null;
  upside_atr: number | null;
  downside_pts: number | null;
  downside_atr: number | null;
} {
  // Find nearest resistance above for upside room
  const resistanceLevels: number[] = [];
  if (kl.session_high !== null && kl.session_high > price) resistanceLevels.push(kl.session_high);
  if (kl.opening_range_high !== null && kl.opening_range_high > price) resistanceLevels.push(kl.opening_range_high);
  if (kl.prior_rth_high !== null && kl.prior_rth_high > price) resistanceLevels.push(kl.prior_rth_high);
  for (const r of kl.pivot_resistance) {
    if (r > price) { resistanceLevels.push(r); break; }
  }

  // Find nearest support below for downside room
  const supportLevels: number[] = [];
  if (kl.session_low !== null && kl.session_low < price) supportLevels.push(kl.session_low);
  if (kl.opening_range_low !== null && kl.opening_range_low < price) supportLevels.push(kl.opening_range_low);
  if (kl.prior_rth_low !== null && kl.prior_rth_low < price) supportLevels.push(kl.prior_rth_low);
  for (const s of kl.pivot_support) {
    if (s < price) { supportLevels.push(s); break; }
  }

  const nearestResistance = resistanceLevels.length > 0 ? Math.min(...resistanceLevels) : null;
  const nearestSupport = supportLevels.length > 0 ? Math.max(...supportLevels) : null;

  const upside_pts = nearestResistance !== null ? round2(nearestResistance - price) : null;
  const downside_pts = nearestSupport !== null ? round2(price - nearestSupport) : null;

  return {
    upside_pts,
    upside_atr: upside_pts !== null && atr14 !== null && atr14 > 0 ? round2(upside_pts / atr14) : null,
    downside_pts,
    downside_atr: downside_pts !== null && atr14 !== null && atr14 > 0 ? round2(downside_pts / atr14) : null,
  };
}

function detectReset(bars: OhlcvBar[], isLong: boolean, impulsePts: number): {
  occurred: boolean;
  depth_pts: number;
  pct_of_impulse: number | null;
  bars: number;
} {
  if (bars.length < 5 || impulsePts <= 0) {
    return { occurred: false, depth_pts: 0, pct_of_impulse: null, bars: 0 };
  }

  // Look for a pullback (counter-trend move) within the last 10 bars
  let maxPullback = 0;
  let pullbackBars = 0;

  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 10); i--) {
    const bar = bars[i]!;
    if (isLong) {
      // For longs, a pullback is a close-to-close move downward
      if (i < bars.length - 1) {
        const nextBar = bars[i + 1]!;
        const drop = nextBar.close - bar.close;
        if (drop < 0) {
          const pullback = Math.abs(drop);
          if (pullback > maxPullback) {
            maxPullback = pullback;
            pullbackBars = bars.length - 1 - i;
          }
        }
      }
    } else {
      if (i < bars.length - 1) {
        const nextBar = bars[i + 1]!;
        const rise = bar.close - nextBar.close;
        if (rise < 0) {
          const pullback = Math.abs(rise);
          if (pullback > maxPullback) {
            maxPullback = pullback;
            pullbackBars = bars.length - 1 - i;
          }
        }
      }
    }
  }

  const pctOfImpulse = impulsePts > 0 ? round2(maxPullback / impulsePts) : null;
  // A reset is meaningful if pullback > 20% of the impulse
  const occurred = pctOfImpulse !== null && pctOfImpulse > 0.2;

  return {
    occurred,
    depth_pts: maxPullback,
    pct_of_impulse: pctOfImpulse,
    bars: pullbackBars,
  };
}
