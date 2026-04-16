/**
 * features/entry-state.ts — Build the canonical EntryStateVector that the
 * quant trend-pullback refactor freezes onto every emitted CandidateSetup.
 *
 * Phase 1 scope (this file as delivered):
 *   - Geometric z-scores (z_ema9, z_ema21, z_vwap) computed from the new
 *     blended sigma_pts volatility scale.
 *   - Volatility scales (micro/room/session ATR + sigma_pts).
 *   - Regime classification pass-through.
 *   - Pullback structure and orderflow fields emitted as null — they are
 *     populated by the Phase 3 generator rewrite and the Phase 2
 *     orderflow-state pipeline respectively.
 *
 * Phase 1 does not yet enforce the §4.4 LOB degradation matrix: every
 * vector emits `lob_state = 'missing'` and `ofi_reliability = 'unknown'`
 * until Phase 2 wires in the orderflow-state module. Phase 2 will start
 * returning null from this function under 'missing' / 'stale' /
 * 'misaligned' / 'invalid' LOB conditions as the matrix requires.
 *
 * Direction-aware sign convention (see EntryStateVector in types.ts):
 *   - For LONG candidates, z_ema9 = (price - ema9) / sigma_pts.
 *   - For SHORT candidates the sign is FLIPPED so mirrored snapshots
 *     produce mirrored z-scores — i.e. NEGATIVE always means "price has
 *     crossed past EMA9 against the setup direction" and POSITIVE means
 *     "price is still on the trend side of EMA9".
 *
 * That convention is the minimum guarantee the long/short geometric
 * symmetry property test relies on.
 */

import type {
  MarketSnapshot,
  EntryStateVector,
  SetupType,
  MarketRegime,
  OhlcvBar,
} from '../types.js';
import { ENTRY_STATE_VECTOR_SCHEMA_VERSION } from '../types.js';
import { tryGetContractSpec } from '../contracts.js';
import {
  computeNormalizers,
  computeSigmaPts,
  zScorePts,
  DEFAULT_NORMALIZATION_CONFIG,
  type NormalizationConfig,
} from './normalization.js';
import { detectSwings, type Bar as StructureBar } from './structure.js';

// ── Pullback geometry (Phase 3) ─────────────────────────────────────────────
//
// For a LONG trend-pullback: find the most recent confirmed swing HIGH on
// bars_1m (the impulse peak), then the most recent confirmed swing LOW
// that occurred strictly before it (the base of that impulse).
//   pullback_ratio = (impulse_high - current_price)
//                  / (impulse_high - base_low)
// 0.0 = at the peak (no pullback yet), 1.0 = back at the base,
// > 1.0 = past the base (trend broken).
//
// For a SHORT trend-pullback: mirror — find the most recent swing LOW
// (impulse valley) and the most recent swing HIGH before it (base).
//   pullback_ratio = (current_price - impulse_low)
//                  / (base_high - impulse_low)
//
// impulse_maturity_bars = number of 1m bars elapsed since the impulse
// swing was printed. Useful for stale-pullback detection.
//
// Returns nulls when there are not enough bars to detect a swing (the
// lookback window requires at least lookback*2 + 1 completed bars).

export interface PullbackGeometry {
  pullback_ratio: number | null;
  impulse_maturity_bars: number | null;
}

/**
 * Compute pullback geometry for the given direction. Exported for tests;
 * the production path calls this indirectly via buildEntryStateVector.
 */
export function computePullbackGeometry(
  bars1m: OhlcvBar[],
  currentPrice: number,
  direction: 'long' | 'short',
  lookback: number = 3,
): PullbackGeometry {
  if (!bars1m || bars1m.length < lookback * 2 + 2) {
    return { pullback_ratio: null, impulse_maturity_bars: null };
  }

  // detectSwings works on a structurally-identical Bar array.
  const swings = detectSwings(bars1m as StructureBar[], lookback);
  if (swings.length < 2) {
    return { pullback_ratio: null, impulse_maturity_bars: null };
  }

  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');

  if (direction === 'long') {
    // Most recent impulse = latest swing high; base = latest swing low
    // strictly before that high.
    if (highs.length === 0) {
      return { pullback_ratio: null, impulse_maturity_bars: null };
    }
    const impulse = highs[highs.length - 1]!;
    // Walk lows backward to find the most recent one before the impulse.
    let base = null;
    for (let i = lows.length - 1; i >= 0; i--) {
      if (lows[i]!.barIndex < impulse.barIndex) {
        base = lows[i]!;
        break;
      }
    }
    if (!base) {
      return { pullback_ratio: null, impulse_maturity_bars: null };
    }
    const impulseSize = impulse.price - base.price;
    if (!(impulseSize > 0)) {
      return { pullback_ratio: null, impulse_maturity_bars: null };
    }
    const retrace = impulse.price - currentPrice;
    const ratio = Math.round((retrace / impulseSize) * 10000) / 10000;
    const maturity = bars1m.length - 1 - impulse.barIndex;
    return { pullback_ratio: ratio, impulse_maturity_bars: maturity };
  } else {
    // Short: most recent impulse = latest swing low; base = latest swing
    // high strictly before it.
    if (lows.length === 0) {
      return { pullback_ratio: null, impulse_maturity_bars: null };
    }
    const impulse = lows[lows.length - 1]!;
    let base = null;
    for (let i = highs.length - 1; i >= 0; i--) {
      if (highs[i]!.barIndex < impulse.barIndex) {
        base = highs[i]!;
        break;
      }
    }
    if (!base) {
      return { pullback_ratio: null, impulse_maturity_bars: null };
    }
    const impulseSize = base.price - impulse.price;
    if (!(impulseSize > 0)) {
      return { pullback_ratio: null, impulse_maturity_bars: null };
    }
    const retrace = currentPrice - impulse.price;
    const ratio = Math.round((retrace / impulseSize) * 10000) / 10000;
    const maturity = bars1m.length - 1 - impulse.barIndex;
    return { pullback_ratio: ratio, impulse_maturity_bars: maturity };
  }
}

export interface BuildEntryStateVectorOptions {
  /** Optional — overrides symbol lookup. Tests pass an explicit tick size. */
  tickSize?: number;
  /** Optional — overrides the default three-family normalization config. */
  normalizationConfig?: NormalizationConfig;
  /**
   * Optional pre-computed regime. If not supplied the builder leaves
   * `regime = null` — callers that already classify regime for other
   * reasons should pass it in to avoid double work.
   */
  regime?: MarketRegime | null;
}

/**
 * Build a canonical EntryStateVector for the given snapshot + direction.
 *
 * Returns `null` if sigma_pts cannot be computed (missing ATR AND
 * insufficient bar history) — without a trustworthy volatility scale no
 * z-score field is meaningful, so the generator must fall back to legacy.
 *
 * Phase 1: does not take or consume a LobSnapshot argument. Phase 2 will
 * extend the signature with `lob: LobSnapshot | null` and add the §4.4
 * degradation-matrix checks. Keeping this signature minimal now avoids a
 * later schema bump when the orderflow fields actually start populating.
 */
export function buildEntryStateVector(
  snap: MarketSnapshot,
  direction: 'long' | 'short',
  setupType: SetupType,
  options: BuildEntryStateVectorOptions = {},
): EntryStateVector | null {
  // Resolve tick size. Tests pass an explicit value; production resolves
  // via contracts.ts. If neither is available we cannot apply the
  // `4 * tick` floor meaningfully — fail closed.
  let tickSize = options.tickSize;
  if (tickSize === undefined) {
    const spec = tryGetContractSpec(snap.symbol);
    tickSize = spec?.tick_size;
  }
  if (tickSize === undefined || !(tickSize > 0)) {
    return null;
  }

  const sigmaPts = computeSigmaPts(snap, tickSize);
  if (sigmaPts === null || !(sigmaPts > 0)) {
    return null;
  }

  // Three-family normalization is best-effort — if it fails we still
  // emit a vector, but with null micro/room/session scales. The plan
  // explicitly says the new sigma_pts is ADDITIONAL, not a replacement,
  // so the legacy scales ride alongside.
  const normConfig = options.normalizationConfig ?? DEFAULT_NORMALIZATION_CONFIG;
  const norms = computeNormalizers(snap, normConfig);

  // Direction sign multiplier for z-score mirroring.
  // long: price-above-ema9 is positive (trend side).
  // short: we flip so price-below-ema9 is positive (trend side).
  const dirSign = direction === 'long' ? 1 : -1;

  const ind = snap.indicators_1m;
  const price = snap.price;

  // ── Direction-aware geometric z-scores ─────────────────────────────
  const zEma9 = (ind?.ema_9 !== null && ind?.ema_9 !== undefined)
    ? zScorePts((price - ind.ema_9) * dirSign, sigmaPts)
    : null;
  const zEma21 = (ind?.ema_21 !== null && ind?.ema_21 !== undefined)
    ? zScorePts((price - ind.ema_21) * dirSign, sigmaPts)
    : null;
  const zVwap = (ind?.vwap !== null && ind?.vwap !== undefined)
    ? zScorePts((price - ind.vwap) * dirSign, sigmaPts)
    : null;

  const vector: EntryStateVector = {
    schema_version: ENTRY_STATE_VECTOR_SCHEMA_VERSION,
    timestamp_unix: snap.timestamp_unix,
    direction,
    setup_type: setupType,

    // Volatility
    sigma_pts: sigmaPts,
    micro_atr: norms?.micro_atr ?? null,
    room_atr: norms?.room_atr ?? null,
    session_atr: norms?.session_atr ?? null,

    // Geometric z-scores (direction-aware, sign-flipped for shorts)
    z_ema9: zEma9,
    z_ema21: zEma21,
    z_vwap: zVwap,

    // Pullback structure — populated from bars_1m swings (Phase 3).
    ...computePullbackGeometry(snap.bars_1m ?? [], price, direction),

    // Regime hook (null unless caller supplied)
    regime: options.regime ?? null,

    // Orderflow — Phase 2 populates
    ofi_10s: null,
    ofi_30s: null,
    z_ofi_10s: null,
    z_ofi_30s: null,
    z_ofi_blend: null,
    queue_imbalance_5: null,
    microprice_offset_pts: null,

    // LOB provenance — Phase 2 upgrades this; Phase 1 stays 'missing'/'unknown'
    lob_state: 'missing',
    ofi_reliability: 'unknown',
  };

  return vector;
}
