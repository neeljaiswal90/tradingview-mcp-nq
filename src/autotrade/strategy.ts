/**
 * Strategy Engine — classifies regime, assesses multi-TF bias,
 * generates candidate setups, and scores confidence for NQ / MNQ futures.
 *
 * Strategy families (priority order for NQ):
 *   1. trend pullback continuation (long + short)
 *   2. opening-drive / opening-range retest continuation
 *   3. failed break / failed breakdown reversal
 *   4. breakout/breakdown retest (generic)
 *   5. momentum continuation — GATED off by default (config flag)
 */

import type {
  MarketSnapshot,
  OhlcvBar,
  IndicatorSnapshot,
  MarketRegime,
  MultiTfBias,
  TfBias,
  CandidateSetup,
  Direction,
  SetupType,
  SignalContextSnapshot,
  DirectionalCandidate,
  ScoreBreakdown,
  ScoringWeights,
  DualDirectionDecision,
  DualDirectionResult,
} from './types.js';

import type { IndicatorConfig } from './types.js';
import type { ContractSpec } from './contracts.js';
import { roundToTickAwayFromEntry, priceToTicks } from './contracts.js';
import { buildDynamicRewardPlan, buildLegacyRewardPlan, DEFAULT_DYNAMIC_REWARD_CONFIG } from './features/dynamic-reward-plan.js';
import type { DynamicRewardPlan, DynamicRewardConfig } from './features/dynamic-reward-plan.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function barDir(b: OhlcvBar): 'up' | 'down' | 'doji' {
  const body = Math.abs(b.close - b.open);
  const range = b.high - b.low;
  if (range === 0) return 'doji';
  if (body / range < 0.15) return 'doji';
  return b.close >= b.open ? 'up' : 'down';
}

// ─── Regime Classification ────────────────────────────────────────────────────

export function classifyRegime(snap: MarketSnapshot): MarketRegime {
  const price = snap.price;
  const ind = snap.indicators_1m;
  const bars5 = snap.bars_5m;
  const bars15 = snap.bars_15m;

  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const stDir = ind.supertrend_direction;

  // Volume spike detection on 5m
  const vols5 = bars5.slice(-10).map(b => b.volume);
  const avgVol5 = avg(vols5);
  const lastVol5 = last(bars5)?.volume ?? 0;
  const volSpike = avgVol5 > 0 && lastVol5 > avgVol5 * 3;

  // EMA alignment checks
  const aboveAll = ema9 !== null && ema21 !== null && ema50 !== null
    && price > ema9 && ema9 > ema21 && ema21 > ema50;
  const belowAll = ema9 !== null && ema21 !== null && ema50 !== null
    && price < ema9 && ema9 < ema21 && ema21 < ema50;

  if (volSpike) return 'high_volatility_impulse';

  // ADX-confirmed trending: strong trend even without full EMA alignment
  const adx = ind.adx;
  const diPlus = ind.di_plus;
  const diMinus = ind.di_minus;

  if (belowAll && stDir === 'down') return 'trending_down';
  if (aboveAll && stDir === 'up') return 'trending_up';
  // ADX > 25 + DI confirms SuperTrend → trending even without full stack alignment
  if (adx !== null && adx > 25) {
    if (stDir === 'up' && diPlus !== null && diMinus !== null && diPlus > diMinus) return 'trending_up';
    if (stDir === 'down' && diPlus !== null && diMinus !== null && diMinus > diPlus) return 'trending_down';
  }

  // TTM Squeeze: canonical compression signal (more reliable than range-based check)
  if (ind.ttm_squeeze_firing === true) return 'compression';

  // Check for compression: narrow 1m range over last 10 bars
  const recent1m = snap.bars_1m.slice(-10);
  if (recent1m.length >= 5) {
    const hi = Math.max(...recent1m.map(b => b.high));
    const lo = Math.min(...recent1m.map(b => b.low));
    const rangePct = price > 0 ? (hi - lo) / price : 0;
    // Adaptive compression threshold: use 0.25% baseline, tighter if ATR available
    const compressionThreshold = ind.atr_14 !== null && price > 0
      ? (ind.atr_14 / price) * 0.5  // half of ATR as compression
      : 0.0025; // 0.25% default (was 0.15%)
    if (rangePct < compressionThreshold) return 'compression';
  }

  // Check 15m for breakout/breakdown attempt
  const l15 = last(bars15);
  const p15 = bars15[bars15.length - 2];
  if (l15 && p15) {
    const vol15Avg = avg(bars15.slice(-5).map(b => b.volume));
    if (l15.close > p15.high && l15.volume > vol15Avg * 2) return 'breakout_attempt';
    if (l15.close < p15.low && l15.volume > vol15Avg * 2) return 'breakdown_attempt';
  }

  // Check if trending down without full alignment
  if (stDir === 'down' && price < (ema9 ?? Infinity)) return 'trending_down';
  if (stDir === 'up' && price > (ema9 ?? 0)) return 'trending_up';

  // Detect choppy: too many direction reversals
  const dirs1m = snap.bars_1m.slice(-8).map(barDir);
  const changes = dirs1m.filter((d, i) => i > 0 && d !== 'doji' && d !== dirs1m[i - 1]).length;
  if (changes >= 4) return 'choppy';
  // ADX < 15 with 3+ direction changes → choppy (lower threshold when ADX confirms weak trend)
  if (adx !== null && adx < 15 && changes >= 3) return 'choppy';

  return 'range_bound';
}

// ─── Multi-TF Bias ────────────────────────────────────────────────────────────

export function assessMultiTfBias(snap: MarketSnapshot): MultiTfBias {
  const price = snap.price;

  const bias1h = assessTfBias(snap.bars_1h, snap.indicators_1h, price);
  const bias15m = assessTfBias(snap.bars_15m, snap.indicators_15m, price);
  const bias5m = assessTfBias5m(snap.bars_5m, price);
  const bias1m = assessBias1m(snap.indicators_1m, price);

  const biases = [bias1h, bias15m, bias5m, bias1m];
  const bearCount = biases.filter(b => b === 'bearish').length;
  const bullCount = biases.filter(b => b === 'bullish').length;

  return {
    '1h': bias1h,
    '15m': bias15m,
    '5m': bias5m,
    '1m': bias1m,
    aligned: bearCount === 4 || bullCount === 4,
    alignment_score: Math.max(bearCount, bullCount),
  };
}

function assessBias1m(ind: IndicatorSnapshot, price: number): TfBias {
  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const stDir = ind.supertrend_direction;

  let bearPts = 0;
  let bullPts = 0;

  if (ema9 !== null) { price < ema9 ? bearPts++ : bullPts++; }
  if (ema21 !== null) { price < ema21 ? bearPts++ : bullPts++; }
  if (ema50 !== null) { price < ema50 ? bearPts++ : bullPts++; }
  if (stDir === 'down') bearPts += 2;
  if (stDir === 'up') bullPts += 2;

  // NovaWave removed from live bias — redundant with EMA stack direction.
  // See reports/strategy-feature-audit.md for rationale.

  // DI directional confirmation
  if (ind.di_plus !== null && ind.di_minus !== null) {
    if (ind.di_plus > ind.di_minus) bullPts++;
    else if (ind.di_minus > ind.di_plus) bearPts++;
  }

  // CVD trend confirmation
  if (ind.cvd_trend === 'up') bullPts++;
  else if (ind.cvd_trend === 'down') bearPts++;

  if (bearPts > bullPts + 1) return 'bearish';
  if (bullPts > bearPts + 1) return 'bullish';
  return 'neutral';
}

function assessTfBias(bars: OhlcvBar[], ind: IndicatorSnapshot, price: number): TfBias {
  if (bars.length < 3) return 'neutral';

  const recent = bars.slice(-5);
  const upBars = recent.filter(b => b.close > b.open).length;
  const downBars = recent.filter(b => b.close < b.open).length;

  let bearPts = 0;
  let bullPts = 0;

  if (downBars > upBars + 1) bearPts++;
  if (upBars > downBars + 1) bullPts++;

  const ema9 = ind.ema_9;
  const ema200 = ind.ema_200;
  const stDir = ind.supertrend_direction;

  if (ema9 !== null) { price < ema9 ? bearPts++ : bullPts++; }
  if (ema200 !== null) { price < ema200 ? bearPts++ : bullPts++; }
  if (stDir === 'down') bearPts += 2;
  if (stDir === 'up') bullPts += 2;

  // Last bar's direction carries extra weight
  const lastBar = last(recent);
  if (lastBar) {
    if (barDir(lastBar) === 'down') bearPts++;
    else if (barDir(lastBar) === 'up') bullPts++;
  }

  if (bearPts > bullPts + 1) return 'bearish';
  if (bullPts > bearPts + 1) return 'bullish';
  return 'neutral';
}

function assessTfBias5m(bars: OhlcvBar[], price: number): TfBias {
  if (bars.length < 3) return 'neutral';
  const recent = bars.slice(-6);
  const highs = recent.map(b => b.high);
  const lows = recent.map(b => b.low);
  const avgHigh = avg(highs.slice(0, 3));
  const avgLow = avg(lows.slice(0, 3));
  const curHigh = avg(highs.slice(3));
  const curLow = avg(lows.slice(3));

  const lowerHighs = curHigh < avgHigh;
  const lowerLows = curLow < avgLow;
  const higherHighs = curHigh > avgHigh;
  const higherLows = curLow > avgLow;

  if (lowerHighs && lowerLows) return 'bearish';
  if (higherHighs && higherLows) return 'bullish';

  // Volume-weighted direction of last 3 bars
  const lastThree = recent.slice(-3);
  const volBear = lastThree.filter(b => b.close < b.open).reduce((s, b) => s + b.volume, 0);
  const volBull = lastThree.filter(b => b.close > b.open).reduce((s, b) => s + b.volume, 0);

  // Check price vs midpoint of last swing
  const swingHigh = Math.max(...recent.slice(-6).map(b => b.high));
  const swingLow = Math.min(...recent.slice(-6).map(b => b.low));
  const mid = (swingHigh + swingLow) / 2;
  if (price < mid && volBear > volBull * 1.2) return 'bearish';
  if (price > mid && volBull > volBear * 1.2) return 'bullish';
  return 'neutral';
}

// ─── Swing High/Low Detection ─────────────────────────────────────────────────

function findSwings(bars: OhlcvBar[], lookback = 5): { swingHigh: number; swingLow: number } {
  const subset = bars.slice(-Math.min(lookback * 2, bars.length));
  return {
    swingHigh: Math.max(...subset.map(b => b.high)),
    swingLow: Math.min(...subset.map(b => b.low)),
  };
}

// ─── Volume Quality ───────────────────────────────────────────────────────────

function volumeQuality(bars: OhlcvBar[]): 'strong' | 'average' | 'thin' {
  const vols = bars.slice(-20).map(b => b.volume);
  const avgVol = avg(vols);
  const lastVol = last(bars)?.volume ?? 0;
  if (avgVol < 0.5) return 'thin'; // Very thin market (e.g., Bitstamp spot)
  if (lastVol > avgVol * 1.5) return 'strong';
  if (lastVol < avgVol * 0.5) return 'thin';
  return 'average';
}

// ─── Target Validation Helpers ───────────────────────────────────────────────
// These guarantee that targets are on the favorable side of entry.
// A target on the WRONG side of entry is a bug that causes fabricated exits.

/**
 * Validates that a target is on the favorable side of entry for the given direction.
 * Returns true if target is null (no target) or correctly positioned.
 */
function isTargetDirectionValid(
  target: number | null,
  entryMid: number,
  direction: Direction,
): boolean {
  if (target === null) return true;
  if (direction === 'short') return target < entryMid;
  if (direction === 'long') return target > entryMid;
  return false;
}

/**
 * Returns a safe fallback target at a given R multiple from entry,
 * guaranteed to be on the favorable side.
 */
function fallbackTarget(
  entryMid: number,
  riskPts: number,
  rMultiple: number,
  direction: Direction,
): number {
  return direction === 'short'
    ? entryMid - riskPts * rMultiple
    : entryMid + riskPts * rMultiple;
}

/**
 * Clamp a candidate target: if it's on the wrong side of entry, replace
 * with a safe fallback. If it's on the correct side but closer than the
 * minimum R distance, leave it alone (close targets are still valid).
 */
function clampTarget(
  candidate: number | null,
  entryMid: number,
  riskPts: number,
  fallbackR: number,
  direction: Direction,
): number {
  if (candidate !== null && isTargetDirectionValid(candidate, entryMid, direction)) {
    return candidate;
  }
  return fallbackTarget(entryMid, riskPts, fallbackR, direction);
}

/**
 * Compute rr for a target, clamped to 0 if the target is on the wrong side.
 * (Should never happen if clampTarget was used, but provides defense-in-depth.)
 */
function computeRr(
  target: number,
  entryMid: number,
  riskPts: number,
  direction: Direction,
): number {
  if (riskPts <= 0) return 0;
  const rr = direction === 'short'
    ? (entryMid - target) / riskPts
    : (target - entryMid) / riskPts;
  return Math.round(rr * 100) / 100;
}

/**
 * Check whether T2 is further from entry than T1 (and T3 further than T2).
 * For SHORTS: prices must decrease — T1 > T2 > T3 (numerically, all below entry).
 * For LONGS:  prices must increase — T1 < T2 < T3 (numerically, all above entry).
 *
 * Returns true only when ordering is strict and correct.
 * A null T3 does not fail ordering.
 */
export function isTargetSequenceValid(
  t1: number,
  t2: number,
  t3: number | null,
  direction: Direction,
): boolean {
  if (direction === 'short') {
    // T2 must be strictly further below entry than T1
    if (t2 >= t1) return false;
    // T3 must be strictly further below entry than T2
    if (t3 !== null && t3 >= t2) return false;
  } else if (direction === 'long') {
    // T2 must be strictly further above entry than T1
    if (t2 <= t1) return false;
    // T3 must be strictly further above entry than T2
    if (t3 !== null && t3 <= t2) return false;
  }
  return true;
}

/**
 * Repair target ordering when T2 is on the wrong side of T1.
 * Strategy: keep T1 as-is (it passed direction validation), and push T2 further
 * out by the same distance T1 is from entry (i.e., 2× the T1 distance).
 * If T3 is also misordered relative to T2, apply the same push-out logic.
 *
 * Returns { t1, t2, t3, repaired, repairReason }.
 */
export function repairTargetOrdering(
  t1: number,
  t2: number,
  t3: number | null,
  entryMid: number,
  direction: Direction,
): { t1: number; t2: number; t3: number | null; repaired: boolean; repairReason: string } {
  const reasons: string[] = [];
  let rt2 = t2;
  let rt3 = t3;

  if (direction === 'short') {
    // T2 must be < T1 (further below entry)
    if (rt2 >= t1) {
      const t1Dist = entryMid - t1; // positive: how far below entry is T1
      rt2 = t1 - t1Dist; // push T2 to 2× T1 distance below entry
      reasons.push(`t2_misordered→repaired_to_${rt2.toFixed(2)}`);
    }
    // T3 must be < T2
    if (rt3 !== null && rt3 >= rt2) {
      const t2Dist = entryMid - rt2;
      rt3 = rt2 - t2Dist;
      reasons.push(`t3_misordered→repaired_to_${rt3.toFixed(2)}`);
    }
  } else if (direction === 'long') {
    // T2 must be > T1 (further above entry)
    if (rt2 <= t1) {
      const t1Dist = t1 - entryMid;
      rt2 = t1 + t1Dist;
      reasons.push(`t2_misordered→repaired_to_${rt2.toFixed(2)}`);
    }
    // T3 must be > T2
    if (rt3 !== null && rt3 <= rt2) {
      const t2Dist = rt2 - entryMid;
      rt3 = rt2 + t2Dist;
      reasons.push(`t3_misordered→repaired_to_${rt3.toFixed(2)}`);
    }
  }

  const repaired = reasons.length > 0;
  if (repaired) {
    console.warn(`[STRATEGY] ⚠️  Target ordering repair applied (${direction}): ${reasons.join('; ')}`);
  }
  return { t1, t2: rt2, t3: rt3, repaired, repairReason: reasons.join('; ') };
}

/**
 * Validate an entire setup's targets. Returns flags describing which targets
 * are directionally valid, whether they are sequentially ordered, and whether
 * any repair was applied. R:R values are recomputed after repair if needed.
 *
 * This is the single authoritative validation function. All generators call it.
 */
function validateAndNormalizeTargets(setup: {
  direction: Direction;
  entry_low: number;
  entry_high: number;
  target_1: number;
  target_2: number;
  target_3: number | null;
  rr_t1: number;
  rr_t2: number;
  risk_pts: number;
}): {
  target_1: number;
  target_2: number;
  target_3: number | null;
  rr_t1: number;
  rr_t2: number;
  target_1_direction_valid: boolean;
  target_2_direction_valid: boolean;
  target_3_direction_valid: boolean;
  rr_validation_passed: boolean;
  target_ordering_valid: boolean;
  target_repair_applied: boolean;
  target_repair_reason: string;
} {
  const entryMid = (setup.entry_low + setup.entry_high) / 2;
  const dir = setup.direction;

  // Step 1: direction validity (already guaranteed by clampTarget, but verify)
  const t1DirValid = isTargetDirectionValid(setup.target_1, entryMid, dir);
  const t2DirValid = isTargetDirectionValid(setup.target_2, entryMid, dir);
  const t3DirValid = isTargetDirectionValid(setup.target_3, entryMid, dir);

  // Step 2: sequence ordering check BEFORE repair
  const orderingOk = isTargetSequenceValid(setup.target_1, setup.target_2, setup.target_3, dir);

  // Step 3: repair if ordering is invalid (direction already ok after clampTarget)
  let { t1, t2, t3, repaired, repairReason } = orderingOk
    ? { t1: setup.target_1, t2: setup.target_2, t3: setup.target_3, repaired: false, repairReason: '' }
    : repairTargetOrdering(setup.target_1, setup.target_2, setup.target_3, entryMid, dir);

  // Step 4: recompute RR after any repair
  const riskPts = setup.risk_pts > 0 ? setup.risk_pts : 1;
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);

  // Step 5: final ordering check after repair
  const orderingAfterRepair = isTargetSequenceValid(t1, t2, t3, dir);

  const rrOk = rrt1 > 0 && rrt2 > 0;
  const rrPassAll = t1DirValid && t2DirValid && t3DirValid && rrOk && orderingAfterRepair;

  return {
    target_1: t1,
    target_2: t2,
    target_3: t3,
    rr_t1: rrt1,
    rr_t2: rrt2,
    target_1_direction_valid: t1DirValid,
    target_2_direction_valid: t2DirValid,
    target_3_direction_valid: t3DirValid,
    rr_validation_passed: rrPassAll,
    target_ordering_valid: orderingAfterRepair,
    target_repair_applied: repaired,
    target_repair_reason: repairReason,
  };
}

// Keep the old name as an alias for any call sites that use it, but now
// delegate to validateAndNormalizeTargets. All generators already spread
// the returned object so the extra fields are harmless.
function validateSetupTargets(setup: {
  direction: Direction;
  entry_low: number;
  entry_high: number;
  target_1: number;
  target_2: number;
  target_3: number | null;
  rr_t1: number;
  rr_t2: number;
  risk_pts: number;
}) {
  return validateAndNormalizeTargets(setup);
}

// ─── Long-Side Quality Filters ──────────────────────────────────────────────

/**
 * Fresh uptrend filter: require that the uptrend is ACTIVE, not just a lagging
 * EMA classification. Uses 5m bar structure + 1m bias + VWAP confirmation.
 *
 * Returns true only when:
 *   1. 5m bars show higher-lows (recent 3 bar lows > prior 3 bar lows), AND
 *   2. 1m bias is bullish or neutral (not bearish), AND
 *   3. Price is above VWAP (if available)
 *
 * This filters out the "lagging trending_up" scenario where EMA stack is bullish
 * but the market is already distributing (lower highs, bearish 1m, below VWAP).
 */
function isUptrendFresh(snap: MarketSnapshot): boolean {
  // Check 1: 5m higher-low structure (the most reliable freshness signal)
  const bars5m = snap.bars_5m;
  if (bars5m.length >= 6) {
    const recent3Lows = bars5m.slice(-3).map(b => b.low);
    const prior3Lows = bars5m.slice(-6, -3).map(b => b.low);
    const recentMinLow = Math.min(...recent3Lows);
    const priorMinLow = Math.min(...prior3Lows);
    if (recentMinLow <= priorMinLow) return false; // lower lows = not fresh uptrend
  }

  // Check 2: 1m bias must not be bearish (allows bullish or neutral)
  const ind = snap.indicators_1m;
  if (ind.supertrend_direction === 'down') {
    // If 1m SuperTrend has flipped down, the uptrend is stale
    // (the EMA stack may still be bullish but momentum has reversed)
    // Exception: allow if price is still above EMA21 (just a dip, not a reversal)
    if (ind.ema_21 !== null && snap.price < ind.ema_21) return false;
  }

  // Check 3: Price above VWAP (if available) — session bias confirmation
  const vwap = ind.vwap;
  if (vwap !== null && vwap > 0 && snap.price < vwap) return false;

  return true;
}

/**
 * Room-to-upside filter for long entries: require that the nearest overhead
 * resistance is far enough away to justify taking the trade.
 *
 * Uses session_high, OR_high, pivot_resistance[0], and prior_rth_high as
 * resistance levels.  Returns true only when the nearest resistance is at
 * least `minRoomAtr` × ATR away.
 *
 * This prevents longs that are already near the top of the session range.
 */
export function hasRoomToUpside(snap: MarketSnapshot, entryMid: number, minRoomAtr: number = 1.0): boolean {
  const atr = snap.indicators_1m.atr_14;
  if (!atr || atr <= 0) return true; // can't measure, don't block

  const kl = snap.key_levels;
  const resistanceLevels: number[] = [];

  if (kl.session_high !== null && kl.session_high > entryMid) resistanceLevels.push(kl.session_high);
  if (kl.opening_range_high !== null && kl.opening_range_high > entryMid) resistanceLevels.push(kl.opening_range_high);
  if (kl.pivot_resistance.length > 0) {
    for (const r of kl.pivot_resistance) {
      if (r > entryMid) { resistanceLevels.push(r); break; } // nearest only
    }
  }
  if (kl.prior_rth_high !== null && kl.prior_rth_high > entryMid) resistanceLevels.push(kl.prior_rth_high);

  if (resistanceLevels.length === 0) return true; // no resistance detected, allow

  const nearestResistance = Math.min(...resistanceLevels);
  const roomPts = nearestResistance - entryMid;
  return roomPts >= atr * minRoomAtr;
}

/**
 * Room-to-downside filter for short entries — symmetric counterpart to
 * hasRoomToUpside().  Requires that the nearest underlying support is far
 * enough below the intended fill zone to justify taking the trade.
 *
 * Uses session_low, OR_low, pivot_support[0], and prior_rth_low as support
 * levels.  Returns true only when the nearest support is at least
 * `minRoomAtr` × ATR below entryMid.
 *
 * This prevents shorts that are already near the bottom of the session range
 * or sitting right above a major support that would stall the move.
 */
export function hasRoomToDownside(snap: MarketSnapshot, entryMid: number, minRoomAtr: number = 1.0): boolean {
  const atr = snap.indicators_1m.atr_14;
  if (!atr || atr <= 0) return true; // can't measure, don't block

  const kl = snap.key_levels;
  const supportLevels: number[] = [];

  if (kl.session_low !== null && kl.session_low < entryMid) supportLevels.push(kl.session_low);
  if (kl.opening_range_low !== null && kl.opening_range_low < entryMid) supportLevels.push(kl.opening_range_low);
  if (kl.pivot_support.length > 0) {
    for (const s of kl.pivot_support) {
      if (s < entryMid) { supportLevels.push(s); break; } // nearest only
    }
  }
  if (kl.prior_rth_low !== null && kl.prior_rth_low < entryMid) supportLevels.push(kl.prior_rth_low);

  if (supportLevels.length === 0) return true; // no support detected, allow

  const nearestSupport = Math.max(...supportLevels); // highest of the ones below = nearest
  const roomPts = entryMid - nearestSupport;
  return roomPts >= atr * minRoomAtr;
}

// ─── Setup Generators ─────────────────────────────────────────────────────────

function genBreakdownRetestShort(snap: MarketSnapshot): CandidateSetup | null {
  const price = snap.price;
  const ind = snap.indicators_1m;
  const kl = snap.key_levels;

  const bossSell = ind.smart_money_bos_sell ?? kl.bos_sell;
  const chochSell = ind.smart_money_choch_sell ?? kl.choch_sell;
  const chochBuy = ind.smart_money_choch_buy ?? kl.choch_buy;

  // Resistance zone: just above current price
  const resistanceZoneLow = bossSell ?? chochSell;
  const resistanceZoneHigh = chochSell ?? bossSell;
  if (!resistanceZoneLow || !resistanceZoneHigh) return null;

  // Price must be below the resistance zone (broken support → now resistance)
  if (price >= resistanceZoneHigh) return null;
  // Price must be within striking distance (< 100 pts below resistance)
  if (resistanceZoneLow - price > 250) return null;
  // Price must be above CHoCH Buy support
  if (chochBuy !== null && price <= chochBuy) return null;

  // Entry at the lower edge of resistance zone
  const entryLow = Math.min(resistanceZoneLow, price + 10);
  const entryHigh = Math.max(resistanceZoneHigh, entryLow + 20);
  const entryMid = (entryLow + entryHigh) / 2;

  // Stop: above resistance zone + buffer
  const stopAbove = (ind.smart_money_choch_sell ?? resistanceZoneHigh) + 26;
  const stop = Math.max(stopAbove, entryHigh + 20);
  const riskPts = stop - entryMid;
  if (riskPts <= 0) return null;

  // Targets — clamped to ensure they are on the favorable side of entry (below, for shorts)
  const dir: Direction = 'short';
  const t1 = clampTarget(chochBuy, entryMid, riskPts, 2, dir);
  const t2Raw = (kl.daily_open && kl.daily_open < t1)
    ? kl.daily_open
    : (kl.pivot_support[0] ?? null);
  const t2 = clampTarget(t2Raw, entryMid, riskPts, 4, dir);
  const t3Raw: number | null = kl.weekly_open ?? null;
  const t3: number | null = isTargetDirectionValid(t3Raw, entryMid, dir) ? t3Raw : null;

  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);

  // Structural sanity: target must be at least 1R from entry.
  // Policy-level RR gating is handled by the dynamic reward plan in applyHardGates().
  if (rrt1 < 1.0) return null;
  if (rrt1 <= 0 || rrt2 <= 0) return null;

  const factors: string[] = ['breakdown_retest_zone_identified', 'bos_sell_overhead'];
  if (ind.supertrend_direction === 'down') factors.push('supertrend_down_confirming');

  const setup = {
    direction: dir,
    setup_type: 'breakdown_retest_short' as SetupType,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: t3,
    risk_pts: riskPts,
    rr_t1: rrt1,
    rr_t2: rrt2,
    confidence: 0, // filled by scorer
    confidence_factors: factors,
    reason: `Breakdown retest short: entry ${entryLow}–${entryHigh}, stop ${stop}, T1 ${t1} (${rrt1.toFixed(1)}R), T2 ${t2} (${rrt2.toFixed(1)}R)`,
  };
  return { ...setup, ...validateSetupTargets(setup) };
}

function genTrendPullbackShort(snap: MarketSnapshot): CandidateSetup | null {
  const price = snap.price;
  const ind = snap.indicators_1m;

  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const stDir = ind.supertrend_direction;

  // Require clear downtrend alignment
  if (stDir !== 'down') return null;
  if (!ema9 || !ema21 || !ema50) return null;
  if (!(price < ema9 && ema9 < ema21 && ema21 < ema50)) return null;

  // Price should be bouncing into the EMA cluster (within 50 pts of ema9)
  const distToEma9 = ema9 - price;
  if (distToEma9 < 0 || distToEma9 > 80) return null;

  const entryLow = price;
  const entryHigh = ema9 + 5;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = ema21 + 20;
  const riskPts = stop - entryMid;
  if (riskPts <= 0) return null;

  // ── Room-to-downside filter: reject if too close to underlying support ──
  if (!hasRoomToDownside(snap, entryMid, 1.0)) return null;

  const kl = snap.key_levels;
  const dir: Direction = 'short';
  const t1 = clampTarget(ind.smart_money_choch_buy, entryMid, riskPts, 2, dir);
  const t2 = clampTarget(kl.pivot_support[0] ?? null, entryMid, riskPts, 4, dir);

  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);

  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return null;
  if (rrt1 <= 0 || rrt2 <= 0) return null;

  const setup = {
    direction: dir,
    setup_type: 'trend_pullback_short' as SetupType,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: null,
    risk_pts: riskPts,
    rr_t1: rrt1,
    rr_t2: rrt2,
    confidence: 0,
    confidence_factors: ['trend_pullback', 'ema_stack_bearish', 'supertrend_down', 'downside_room_confirmed'],
    reason: `Trend pullback short into EMA cluster. Entry ${entryLow}–${entryHigh}, stop ${stop}`,
  };
  return { ...setup, ...validateSetupTargets(setup) };
}

function genBreakdownMomentumShort(snap: MarketSnapshot): CandidateSetup | null {
  const price = snap.price;
  const ind = snap.indicators_1m;
  const kl = snap.key_levels;

  const chochBuy = kl.choch_buy ?? ind.smart_money_choch_buy;
  if (!chochBuy) return null;

  // Price must have just broken through CHoCH Buy (price is below it)
  if (price >= chochBuy) return null;
  if (chochBuy - price < 20) return null; // Too close to break — false break zone
  if (price < chochBuy - 100) return null; // Too far, momentum trade window passed

  // ── Momentum confirmation: require the last CLOSED 1m bar to close below
  //    the break level. This rejects wick-only false breaks.
  const bars1m = snap.bars_1m;
  const lastClosed = bars1m.length >= 2 ? bars1m[bars1m.length - 2] : undefined;
  if (!lastClosed || lastClosed.close >= chochBuy) return null;

  const entryLow = price - 20;
  const entryHigh = chochBuy; // Enter on any bounce back to the broken level
  const entryMid = (entryLow + entryHigh) / 2;
  // ATR-aware stop: widen the stop buffer in higher-volatility environments so
  // we are not stopped out by ordinary noise. Falls back to 60pts if no ATR.
  const atr = ind.atr_14 ?? null;
  const atrBuffer = atr !== null ? Math.max(40, Math.min(120, atr * 0.75)) : 60;
  const stop = chochBuy + atrBuffer;
  const riskPts = stop - entryMid;
  if (riskPts <= 0) return null;

  const dir: Direction = 'short';
  const t1 = clampTarget(kl.pivot_support[0] ?? null, entryMid, riskPts, 3, dir);
  const t2 = clampTarget(kl.daily_open ?? null, entryMid, riskPts, 5, dir);
  const t3Raw: number | null = kl.weekly_open ?? null;
  const t3: number | null = isTargetDirectionValid(t3Raw, entryMid, dir) ? t3Raw : null;

  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return null;
  if (rrt1 <= 0 || rrt2 <= 0) return null;

  const setup = {
    direction: dir,
    setup_type: 'momentum_continuation' as SetupType,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: t3,
    risk_pts: riskPts,
    rr_t1: rrt1,
    rr_t2: rrt2,
    confidence: 0,
    confidence_factors: ['choch_buy_broken', 'momentum_continuation', 'close_below_break_confirmed'],
    reason: `Momentum short below CHoCH Buy. Entry ${entryLow}–${entryHigh}, stop ${stop}`,
  };
  return { ...setup, ...validateSetupTargets(setup) };
}

function genTrendPullbackLong(snap: MarketSnapshot): CandidateSetup | null {
  const price = snap.price;
  const ind = snap.indicators_1m;

  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const stDir = ind.supertrend_direction;

  // Require clear uptrend alignment
  if (stDir !== 'up') return null;
  if (!ema9 || !ema21 || !ema50) return null;
  if (!(price > ema9 && ema9 > ema21 && ema21 > ema50)) return null;

  // ── Fresh uptrend filter: require actual higher-high/higher-low structure ──
  // EMA stack alone is lagging; recent bar structure proves the move is still live.
  if (!isUptrendFresh(snap)) return null;

  // Price should be pulling back toward the EMA cluster (within 80 pts above ema9)
  const distToEma9 = price - ema9;
  if (distToEma9 < 0 || distToEma9 > 80) return null;

  const entryLow = ema9 - 5;
  const entryHigh = price;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = ema21 - 20;
  const riskPts = entryMid - stop;
  if (riskPts <= 0) return null;

  // ── Room-to-upside filter: reject if too close to overhead resistance ──
  if (!hasRoomToUpside(snap, entryMid, 1.0)) return null;

  const kl = snap.key_levels;
  const dir: Direction = 'long';
  const t1 = clampTarget(ind.smart_money_choch_sell, entryMid, riskPts, 2, dir);
  const t2 = clampTarget(kl.pivot_resistance[0] ?? null, entryMid, riskPts, 4, dir);

  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);

  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return null;
  if (rrt1 <= 0 || rrt2 <= 0) return null;

  const setup = {
    direction: dir,
    setup_type: 'trend_pullback_long' as SetupType,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: null,
    risk_pts: riskPts,
    rr_t1: rrt1,
    rr_t2: rrt2,
    confidence: 0,
    confidence_factors: ['trend_pullback', 'ema_stack_bullish', 'supertrend_up', 'fresh_uptrend_confirmed', 'upside_room_confirmed'],
    reason: `Trend pullback long into EMA cluster. Entry ${entryLow}–${entryHigh}, stop ${stop}`,
  };
  return { ...setup, ...validateSetupTargets(setup) };
}

function genBreakoutRetestLong(snap: MarketSnapshot): CandidateSetup | null {
  const price = snap.price;
  const ind = snap.indicators_1m;

  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const stDir = ind.supertrend_direction;

  if (stDir !== 'up') return null;
  if (!ema9 || !ema21 || !ema50) return null;
  if (!(price > ema9 && ema9 > ema21 && ema21 > ema50)) return null;

  // ── Fresh uptrend filter ──
  if (!isUptrendFresh(snap)) return null;

  // Price should be close to EMA9 (within 60pts above)
  const distAboveEma9 = price - ema9;
  if (distAboveEma9 < 0 || distAboveEma9 > 60) return null;

  const kl = snap.key_levels;
  const entryLow = ema9 - 10;
  const entryHigh = price + 15;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = ema21 - 25;
  const riskPts = entryMid - stop;
  if (riskPts <= 0) return null;

  // ── Room-to-upside filter ──
  if (!hasRoomToUpside(snap, entryMid, 1.0)) return null;

  const dir: Direction = 'long';
  const resistance = kl.pivot_resistance[0] ?? null;
  if (!resistance) return null;
  const t1 = clampTarget(resistance, entryMid, riskPts, 2, dir);
  const t2 = clampTarget(kl.pivot_resistance[1] ?? null, entryMid, riskPts, 4, dir);
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return null;
  if (rrt1 <= 0 || rrt2 <= 0) return null;

  const setup = {
    direction: dir,
    setup_type: 'breakout_retest_long' as SetupType,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: null,
    risk_pts: riskPts,
    rr_t1: rrt1,
    rr_t2: rrt2,
    confidence: 0,
    confidence_factors: ['ema_pullback_long', 'supertrend_up', 'fresh_uptrend_confirmed', 'upside_room_confirmed'],
    reason: `EMA pullback long. Entry ${entryLow}–${entryHigh}, stop ${stop}`,
  };
  return { ...setup, ...validateSetupTargets(setup) };
}

// ─── NQ-specific setup generators ────────────────────────────────────────────

/**
 * Opening-drive continuation long: RTH opening range is being broken to the
 * upside and the drive has momentum (higher lows, close above OR_high on the
 * last closed 1m bar).
 */
function genOpeningDriveContinuationLong(snap: MarketSnapshot): CandidateSetup | null {
  const kl = snap.key_levels;
  const session = snap.session;
  if (!session?.is_rth) return null;
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh === null || orLow === null) return null;
  if (snap.price <= orHigh) return null;
  // Require last CLOSED 1m bar to close above OR high
  const closed = snap.bars_1m.length >= 2 ? snap.bars_1m[snap.bars_1m.length - 2] : undefined;
  if (!closed || closed.close <= orHigh) return null;

  const entryLow = orHigh;
  const entryHigh = snap.price + (orHigh - orLow) * 0.1;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = orLow; // failure of the opening range
  const riskPts = entryMid - stop;
  if (riskPts <= 0) return null;

  const dir: Direction = 'long';
  const orRange = orHigh - orLow;
  const t1 = entryMid + orRange; // 1× OR projection
  const t2 = entryMid + orRange * 1.75;
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return null;

  const setup = {
    direction: dir,
    setup_type: 'opening_drive_continuation_long' as SetupType,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: null,
    risk_pts: riskPts,
    rr_t1: rrt1,
    rr_t2: rrt2,
    confidence: 0,
    confidence_factors: ['opening_drive_long', 'closed_above_or_high'],
    reason: `Opening-drive long above OR_high=${orHigh}. Stop=${orLow}, T1=${t1.toFixed(2)}, T2=${t2.toFixed(2)}`,
  };
  return { ...setup, ...validateSetupTargets(setup) };
}

function genOpeningDriveContinuationShort(snap: MarketSnapshot): CandidateSetup | null {
  const kl = snap.key_levels;
  const session = snap.session;
  if (!session?.is_rth) return null;
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh === null || orLow === null) return null;
  if (snap.price >= orLow) return null;
  const closed = snap.bars_1m.length >= 2 ? snap.bars_1m[snap.bars_1m.length - 2] : undefined;
  if (!closed || closed.close >= orLow) return null;

  const entryHigh = orLow;
  const entryLow = snap.price - (orHigh - orLow) * 0.1;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = orHigh;
  const riskPts = stop - entryMid;
  if (riskPts <= 0) return null;

  const dir: Direction = 'short';
  const orRange = orHigh - orLow;
  const t1 = entryMid - orRange;
  const t2 = entryMid - orRange * 1.75;
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return null;

  const setup = {
    direction: dir,
    setup_type: 'opening_drive_continuation_short' as SetupType,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: null,
    risk_pts: riskPts,
    rr_t1: rrt1,
    rr_t2: rrt2,
    confidence: 0,
    confidence_factors: ['opening_drive_short', 'closed_below_or_low'],
    reason: `Opening-drive short below OR_low=${orLow}. Stop=${orHigh}, T1=${t1.toFixed(2)}, T2=${t2.toFixed(2)}`,
  };
  return { ...setup, ...validateSetupTargets(setup) };
}

/**
 * Failed opening-range break: price broke above OR_high, then failed back
 * inside the range. Fade short with stop above the failure high.
 */
function genFailedOrBreakShort(snap: MarketSnapshot): CandidateSetup | null {
  const kl = snap.key_levels;
  const session = snap.session;
  if (!session?.is_rth) return null;
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh === null || orLow === null) return null;

  // Need a recent bar that poked above OR_high but price is now back below
  if (snap.price >= orHigh) return null;
  const recent = snap.bars_1m.slice(-6);
  if (recent.length < 3) return null;
  const maxHigh = Math.max(...recent.map(b => b.high));
  if (maxHigh <= orHigh) return null; // no failed break
  // last closed bar must have closed back inside
  const closed = snap.bars_1m[snap.bars_1m.length - 2];
  if (!closed || closed.close >= orHigh) return null;

  const entryHigh = orHigh;
  const entryLow = snap.price;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = maxHigh; // above the failed high
  const riskPts = stop - entryMid;
  if (riskPts <= 0) return null;

  const dir: Direction = 'short';
  const t1 = (orHigh + orLow) / 2;
  const t2 = orLow;
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return null;

  const setup = {
    direction: dir,
    setup_type: 'failed_or_break_short' as SetupType,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: null,
    risk_pts: riskPts,
    rr_t1: rrt1,
    rr_t2: rrt2,
    confidence: 0,
    confidence_factors: ['failed_or_break_short', 'reclaimed_inside_range'],
    reason: `Failed OR break short: swept ${maxHigh}, back below OR_high ${orHigh}`,
  };
  return { ...setup, ...validateSetupTargets(setup) };
}

function genFailedOrBreakLong(snap: MarketSnapshot): CandidateSetup | null {
  const kl = snap.key_levels;
  const session = snap.session;
  if (!session?.is_rth) return null;
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh === null || orLow === null) return null;
  if (snap.price <= orLow) return null;
  const recent = snap.bars_1m.slice(-6);
  if (recent.length < 3) return null;
  const minLow = Math.min(...recent.map(b => b.low));
  if (minLow >= orLow) return null;
  const closed = snap.bars_1m[snap.bars_1m.length - 2];
  if (!closed || closed.close <= orLow) return null;

  const entryLow = orLow;
  const entryHigh = snap.price;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = minLow;
  const riskPts = entryMid - stop;
  if (riskPts <= 0) return null;

  const dir: Direction = 'long';
  const t1 = (orHigh + orLow) / 2;
  const t2 = orHigh;
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return null;

  const setup = {
    direction: dir,
    setup_type: 'failed_or_break_long' as SetupType,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop,
    target_1: t1,
    target_2: t2,
    target_3: null,
    risk_pts: riskPts,
    rr_t1: rrt1,
    rr_t2: rrt2,
    confidence: 0,
    confidence_factors: ['failed_or_break_long', 'reclaimed_inside_range'],
    reason: `Failed OR breakdown long: swept ${minLow}, back above OR_low ${orLow}`,
  };
  return { ...setup, ...validateSetupTargets(setup) };
}

// ─── Scoring Weights ────────────────────────────────────────────────────────

/**
 * Default scoring weights — exactly reproduce the original hardcoded values.
 * Exported so tests can verify parity and config can override individual fields.
 */
export const DEFAULT_SCORING_WEIGHTS: Readonly<ScoringWeights> = {
  base: 5.0,

  tf_alignment_4tf: 2.0,
  tf_alignment_3tf: 1.0,
  tf_alignment_2tf: 0.3,
  tf_alignment_weak: -0.5,

  htf_direction_conflict: -1.0,

  supertrend_confirms: 0.5,
  supertrend_opposes: -0.5,

  structural_level_bonus: 0.5,

  rr_excellent: 0.5,
  rr_acceptable: 0.25,
  rr_below_min: -0.5,

  volume_strong: 0.5,
  volume_thin: -0.5,

  missing_indicators_many: -0.5,
  missing_indicators_some: -0.25,

  entry_location_suboptimal: -0.3,

  regime_aligned: 0.3,
  regime_adverse: -1.0,

  swing_structure_trend: 0.3,
  swing_structure_level: 0.2,

  vwap_supports: 0.3,
  vwap_opposes: -0.3,
  or_level_supports: 0.4,

  // ADX / DMI
  adx_strong_trend: 0.4,
  adx_weak_trend: -0.3,
  adx_di_confirms: 0.2,
  // TTM Squeeze
  ttm_squeeze_penalty: -0.3,
  ttm_squeeze_release: 0.3,
  // CVD
  cvd_divergence: -0.4,
  cvd_aligned: 0.25,
};

/**
 * Resolve effective scoring weights by merging config overrides over defaults.
 * Any field not specified in config falls back to DEFAULT_SCORING_WEIGHTS.
 */
export function resolveScoringWeights(config: IndicatorConfig): ScoringWeights {
  return { ...DEFAULT_SCORING_WEIGHTS, ...(config.scoring_weights ?? {}) };
}

// ─── Confidence Scorer ────────────────────────────────────────────────────────

/**
 * Score a candidate setup and return a detailed breakdown of every factor.
 * Used by the dual-direction model to compare long vs short transparently.
 *
 * All scoring weights are read from config.scoring_weights (merged over
 * DEFAULT_SCORING_WEIGHTS). No hardcoded magic numbers in this function.
 */
export function scoreConfidenceDetailed(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  bias: MultiTfBias,
  regime: MarketRegime,
  config: IndicatorConfig,
): ScoreBreakdown {
  const w = resolveScoringWeights(config);
  const factors = [...setup.confidence_factors];
  const price = snap.price;
  const ind = snap.indicators_1m;
  const volQ = volumeQuality(snap.bars_1m);
  const { swingHigh, swingLow } = findSwings(snap.bars_15m, 5);

  const breakdown: ScoreBreakdown = {
    base: w.base,
    tf_alignment: 0,
    htf_direction: 0,
    supertrend: 0,
    structural_level: 0,
    rr_quality: 0,
    volume: 0,
    missing_indicators: 0,
    entry_location: 0,
    regime_alignment: 0,
    swing_structure: 0,
    vwap_position: 0,
    or_level: 0,
    adx_trend_strength: 0,
    ttm_squeeze: 0,
    cvd_alignment: 0,
    total: 0,
    factors,
    feature_set: 'full',
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1: Core Decision Inputs — hard gates or high weight (>= 0.5 pts)
  // These factors most strongly determine whether a setup is tradeable.
  // See reports/strategy-feature-audit.md for full classification.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── TF alignment bonus ────────────────────────────────────────────────────
  if (bias.alignment_score === 4) {
    breakdown.tf_alignment = w.tf_alignment_4tf;
    factors.push(`full_4tf_alignment(+${w.tf_alignment_4tf})`);
  } else if (bias.alignment_score === 3) {
    breakdown.tf_alignment = w.tf_alignment_3tf;
    factors.push(`3tf_alignment(+${w.tf_alignment_3tf})`);
  } else if (bias.alignment_score === 2) {
    breakdown.tf_alignment = w.tf_alignment_2tf;
    factors.push(`2tf_alignment(+${w.tf_alignment_2tf})`);
  } else {
    breakdown.tf_alignment = w.tf_alignment_weak;
    factors.push(`weak_tf_alignment(${w.tf_alignment_weak})`);
  }

  // 1h alignment check for direction
  const isShort = setup.direction === 'short';
  const tfAligned = isShort ? bias['1h'] === 'bearish' : bias['1h'] === 'bullish';
  if (!tfAligned) {
    breakdown.htf_direction = w.htf_direction_conflict;
    factors.push(`1h_conflicts_direction(${w.htf_direction_conflict})`);
  }

  // ── SuperTrend confirmation ───────────────────────────────────────────────
  const stConfirms = (isShort && ind.supertrend_direction === 'down')
    || (!isShort && ind.supertrend_direction === 'up');
  if (stConfirms) {
    breakdown.supertrend = w.supertrend_confirms;
    factors.push(`supertrend_confirms(+${w.supertrend_confirms})`);
  } else if (ind.supertrend_direction !== null) {
    breakdown.supertrend = w.supertrend_opposes;
    factors.push(`supertrend_opposes(${w.supertrend_opposes})`);
  }

  // ── Structural level ──────────────────────────────────────────────────────
  // For shorts: price below BOS_SELL confirms bearish structure.
  // For longs: BOS_BUY is often unavailable, so we accept alternative confirmations:
  //   - Price above VWAP AND above daily/weekly open (session reclaim)
  //   - Price above opening range high (OR breakout hold)
  //   - Price holding above prior RTH low (structural support)
  const bossSellSet = snap.key_levels.bos_sell !== null;
  const bosBuySet  = snap.key_levels.bos_buy  !== null;
  const structKl = snap.key_levels;

  let atStructure: boolean;
  let structureSource = '';

  if (isShort) {
    atStructure = bossSellSet && price < snap.key_levels.bos_sell!;
    structureSource = atStructure ? 'bos_sell' : '';
  } else {
    // Primary: BOS_BUY
    if (bosBuySet && price > snap.key_levels.bos_buy!) {
      atStructure = true;
      structureSource = 'bos_buy';
    }
    // Alternative 1: price above VWAP AND above daily open (session bias reclaim)
    else if (ind.vwap !== null && price > ind.vwap
      && structKl.daily_open !== null && price > structKl.daily_open) {
      atStructure = true;
      structureSource = 'vwap_daily_open_reclaim';
    }
    // Alternative 2: price holding above OR high (opening range breakout hold)
    else if (structKl.opening_range_high !== null && price > structKl.opening_range_high) {
      atStructure = true;
      structureSource = 'or_high_hold';
    }
    // Alternative 3: price above prior RTH low (structural floor intact)
    else if (structKl.prior_rth_low !== null && price > structKl.prior_rth_low
      && ind.ema_50 !== null && price > ind.ema_50) {
      atStructure = true;
      structureSource = 'prior_rth_support';
    }
    else {
      atStructure = false;
    }
  }

  if (atStructure) {
    breakdown.structural_level = w.structural_level_bonus;
    factors.push(`at_structural_level:${structureSource}(+${w.structural_level_bonus})`);
  } else if (isShort && !bossSellSet) {
    factors.push('bos_sell_unavailable(0)');
  } else if (!isShort && !bosBuySet) {
    factors.push('bos_buy_unavailable:no_alt_confirmed(0)');
  }

  // ── R:R quality ───────────────────────────────────────────────────────────
  if (setup.rr_t1 >= config.min_rr * 1.5) {
    breakdown.rr_quality = w.rr_excellent;
    factors.push(`rr_excellent_${setup.rr_t1}(+${w.rr_excellent})`);
  } else if (setup.rr_t1 >= config.min_rr) {
    breakdown.rr_quality = w.rr_acceptable;
    factors.push(`rr_acceptable_${setup.rr_t1}(+${w.rr_acceptable})`);
  } else {
    breakdown.rr_quality = w.rr_below_min;
    factors.push(`rr_below_min_${setup.rr_t1}(${w.rr_below_min})`);
  }

  // ── Volume quality ────────────────────────────────────────────────────────
  if (volQ === 'strong') {
    breakdown.volume = w.volume_strong;
    factors.push(`volume_strong(+${w.volume_strong})`);
  } else if (volQ === 'thin') {
    breakdown.volume = w.volume_thin;
    factors.push(`volume_thin(${w.volume_thin})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: Secondary Confirmation — moderate scoring (0.2-0.4 pts)
  // These factors refine confidence but rarely flip a decision alone.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Missing baseline indicators ───────────────────────────────────────────
  const missing = snap.data_quality.missing_indicators.length;
  if (missing >= 3) {
    breakdown.missing_indicators = w.missing_indicators_many;
    factors.push(`missing_${missing}_indicators(${w.missing_indicators_many})`);
  } else if (missing > 0) {
    breakdown.missing_indicators = w.missing_indicators_some;
    factors.push(`missing_${missing}_indicators(${w.missing_indicators_some})`);
  }

  // ── Entry location quality ────────────────────────────────────────────────
  const entryMid = (setup.entry_low + setup.entry_high) / 2;
  const entryQuality = setup.risk_pts > 0 ? Math.abs(price - entryMid) / setup.risk_pts : 0;
  if (entryQuality > 0.5) {
    breakdown.entry_location = w.entry_location_suboptimal;
    factors.push(`entry_location_suboptimal(${w.entry_location_suboptimal})`);
  }

  // ── Regime alignment ──────────────────────────────────────────────────────
  const regimeAligned = (isShort && (regime === 'trending_down' || regime === 'breakdown_attempt'))
    || (!isShort && (regime === 'trending_up' || regime === 'breakout_attempt'));
  if (regimeAligned) {
    breakdown.regime_alignment = w.regime_aligned;
    factors.push(`regime_aligned(+${w.regime_aligned})`);
  } else if (regime === 'choppy' || regime === 'high_volatility_impulse') {
    breakdown.regime_alignment = w.regime_adverse;
    factors.push(`regime_adverse(${w.regime_adverse})`);
  }

  // ── Structure: lower high / lower low for short ───────────────────────────
  if (isShort) {
    const recent5 = snap.bars_5m.slice(-6);
    if (recent5.length >= 6) {
      const recentHigh = Math.max(...recent5.slice(-3).map(b => b.high));
      const prevHigh = Math.max(...recent5.slice(0, 3).map(b => b.high));
      if (recentHigh < prevHigh) {
        breakdown.swing_structure += w.swing_structure_trend;
        factors.push(`lower_high_structure(+${w.swing_structure_trend})`);
      }
    }
    if (swingHigh > 0 && price < swingHigh * 0.9995) {
      breakdown.swing_structure += w.swing_structure_level;
      factors.push(`below_swing_high(+${w.swing_structure_level})`);
    }
  }

  if (!isShort) {
    const recent5 = snap.bars_5m.slice(-6);
    if (recent5.length >= 6) {
      const recentLow = Math.min(...recent5.slice(-3).map(b => b.low));
      const prevLow = Math.min(...recent5.slice(0, 3).map(b => b.low));
      if (recentLow > prevLow) {
        breakdown.swing_structure += w.swing_structure_trend;
        factors.push(`higher_low_structure(+${w.swing_structure_trend})`);
      }
    }
    if (swingLow > 0 && price > swingLow * 1.0005) {
      breakdown.swing_structure += w.swing_structure_level;
      factors.push(`above_swing_low(+${w.swing_structure_level})`);
    }
  }

  // ── VWAP direction support ──────────────────────────────────────────────
  const vwap = ind.vwap;
  if (vwap !== null && vwap > 0) {
    const vwapSupports = (isShort && price < vwap) || (!isShort && price > vwap);
    const vwapOpposes = (isShort && price > vwap) || (!isShort && price < vwap);
    if (vwapSupports) {
      breakdown.vwap_position = w.vwap_supports;
      factors.push(`vwap_supports_${isShort ? 'short' : 'long'}(+${w.vwap_supports})`);
    } else if (vwapOpposes) {
      breakdown.vwap_position = w.vwap_opposes;
      factors.push(`vwap_opposes_${isShort ? 'short' : 'long'}(${w.vwap_opposes})`);
    }
  }

  // ── Opening Range level proximity ─────────────────────────────────────────
  const kl = snap.key_levels;
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh !== null && orLow !== null) {
    const orRange = orHigh - orLow;
    const proximityThreshold = orRange > 0 ? orRange * 0.3 : 5; // within 30% of OR range
    if (!isShort && orLow > 0 && Math.abs(price - orLow) <= proximityThreshold) {
      // Long near OR low (support)
      breakdown.or_level = w.or_level_supports;
      factors.push(`or_low_supports_long(+${w.or_level_supports})`);
    } else if (isShort && orHigh > 0 && Math.abs(price - orHigh) <= proximityThreshold) {
      // Short near OR high (resistance)
      breakdown.or_level = w.or_level_supports;
      factors.push(`or_high_supports_short(+${w.or_level_supports})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 3: Supporting Context — minor adjustments (< 0.3 pts individually)
  // These factors provide nuance but contribute minimal scoring delta.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── ADX / DMI trend strength ─────────────────────────────────────────────
  const adxVal = ind.adx;
  if (adxVal !== null) {
    if (adxVal > 25 && regimeAligned) {
      breakdown.adx_trend_strength += w.adx_strong_trend;
      factors.push(`adx_${adxVal.toFixed(0)}_strong_trend(+${w.adx_strong_trend})`);
    } else if (adxVal < 15) {
      breakdown.adx_trend_strength += w.adx_weak_trend;
      factors.push(`adx_${adxVal.toFixed(0)}_weak(${w.adx_weak_trend})`);
    }
    // DI confirms direction
    if (ind.di_plus !== null && ind.di_minus !== null) {
      const diConfirms = isShort
        ? ind.di_minus > ind.di_plus
        : ind.di_plus > ind.di_minus;
      if (diConfirms) {
        breakdown.adx_trend_strength += w.adx_di_confirms;
        factors.push(`di_confirms_${isShort ? 'short' : 'long'}(+${w.adx_di_confirms})`);
      }
    }
  }

  // ── TTM Squeeze ─────────────────────────────────────────────────────────
  if (ind.ttm_squeeze_firing === true) {
    breakdown.ttm_squeeze = w.ttm_squeeze_penalty;
    factors.push(`ttm_squeeze_active(${w.ttm_squeeze_penalty})`);
  } else if (ind.ttm_squeeze_firing === false && ind.ttm_squeeze_momentum !== null) {
    // Squeeze released: reward if momentum aligns with direction
    const momAligns = isShort
      ? ind.ttm_squeeze_momentum < 0
      : ind.ttm_squeeze_momentum > 0;
    if (momAligns) {
      breakdown.ttm_squeeze = w.ttm_squeeze_release;
      factors.push(`ttm_squeeze_release_aligned(+${w.ttm_squeeze_release})`);
    }
  }

  // ── CVD (Cumulative Volume Delta) ───────────────────────────────────────
  if (ind.cvd_delta !== null) {
    const lastBar = snap.bars_1m[snap.bars_1m.length - 1];
    const prevBar = snap.bars_1m[snap.bars_1m.length - 2];
    if (lastBar && prevBar) {
      const priceUp = lastBar.close > prevBar.close;
      const priceDown = lastBar.close < prevBar.close;
      const cvdBullish = ind.cvd_delta > 0 || ind.cvd_trend === 'up';
      const cvdBearish = ind.cvd_delta < 0 || ind.cvd_trend === 'down';
      // Divergence: price and CVD disagree
      const divergence = (priceUp && cvdBearish && isShort === false)
        || (priceDown && cvdBullish && isShort === true);
      if (divergence) {
        breakdown.cvd_alignment = w.cvd_divergence;
        factors.push(`cvd_divergence(${w.cvd_divergence})`);
      } else {
        // CVD confirms direction
        const cvdConfirms = isShort ? cvdBearish : cvdBullish;
        if (cvdConfirms) {
          breakdown.cvd_alignment = w.cvd_aligned;
          factors.push(`cvd_aligned(+${w.cvd_aligned})`);
        }
      }
    }
  }

  const rawScore = breakdown.base
    + breakdown.tf_alignment
    + breakdown.htf_direction
    + breakdown.supertrend
    + breakdown.structural_level
    + breakdown.rr_quality
    + breakdown.volume
    + breakdown.missing_indicators
    + breakdown.entry_location
    + breakdown.regime_alignment
    + breakdown.swing_structure
    + breakdown.vwap_position
    + breakdown.or_level
    + breakdown.adx_trend_strength
    + breakdown.ttm_squeeze
    + breakdown.cvd_alignment;

  breakdown.total = Math.max(0, Math.min(10, Math.round(rawScore * 10) / 10));
  breakdown.factors = factors;
  breakdown.feature_set = 'full';

  return breakdown;
}

/**
 * Legacy scoreConfidence wrapper — scores and mutates setup.confidence_factors,
 * returns the final clamped score. Delegates to scoreConfidenceDetailed().
 */
export function scoreConfidence(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  bias: MultiTfBias,
  regime: MarketRegime,
  config: IndicatorConfig,
): number {
  const breakdown = scoreConfidenceDetailed(setup, snap, bias, regime, config);
  setup.confidence_factors = breakdown.factors;

  // Factor breakdown log — shows every contributing factor so asymmetries are visible
  console.log(
    `[CONFIDENCE] ${setup.direction.toUpperCase()} ${setup.setup_type} ` +
    `raw=${(breakdown.total).toFixed(1)} final=${breakdown.total} ` +
    `factors=[${breakdown.factors.join(', ')}]`,
  );

  return breakdown.total;
}

// ─── Dual-Direction Hard Gates ──────────────────────────────────────────────

/**
 * Apply per-candidate hard gates. Returns a list of failure reasons.
 * Empty array = all gates passed.
 */
export function applyHardGates(
  setup: CandidateSetup,
  confidence: number,
  bias: MultiTfBias,
  regime: MarketRegime,
  snap: MarketSnapshot,
  config: IndicatorConfig,
  rewardPlan?: DynamicRewardPlan | null,
): string[] {
  const failures: string[] = [];

  if (!setup.rr_validation_passed) {
    failures.push('rr_validation_failed_invalid_targets');
  }
  if (setup.rr_t1 <= 0) {
    failures.push(`rr_t1_non_positive_${setup.rr_t1}`);
  }
  if (setup.rr_t2 <= 0) {
    failures.push(`rr_t2_non_positive_${setup.rr_t2}`);
  }
  if (!setup.target_1_direction_valid) {
    failures.push('target_1_wrong_side_of_entry');
  }
  if (!setup.target_2_direction_valid) {
    failures.push('target_2_wrong_side_of_entry');
  }
  if (!setup.target_ordering_valid) {
    failures.push(`target_ordering_invalid:${setup.target_repair_reason || 'unknown'}`);
  }
  if (config.max_confidence !== undefined && config.max_confidence < 10 && confidence > config.max_confidence) {
    failures.push(`confidence_ceiling_${confidence}_above_max_${config.max_confidence}`);
  }
  // ── RR gate: use dynamic plan when available, else fall back to fixed config.min_rr ──
  if (rewardPlan) {
    if (!rewardPlan.rr_gate_pass) {
      failures.push(`rr_${setup.rr_t1}_below_dynamic_min_${rewardPlan.dynamic_min_rr}`);
    }
  } else {
    if (setup.rr_t1 < config.min_rr) {
      failures.push(`rr_${setup.rr_t1}_below_min_${config.min_rr}`);
    }
  }
  if (regime === 'choppy') {
    failures.push('regime_choppy');
  }
  if (regime === 'high_volatility_impulse' && setup.setup_type !== 'momentum_continuation') {
    failures.push('regime_high_volatility_impulse_too_risky');
  }
  if (bias.alignment_score < 2) {
    failures.push(`alignment_too_weak_${bias.alignment_score}_of_4`);
  }
  if (snap.session && !snap.session.is_rth && !snap.session.is_eth) {
    failures.push('market_closed');
  }
  if (snap.session?.is_rth_closing_window) {
    failures.push('rth_closing_window_no_new_trades');
  }
  if (snap.event?.no_trade_due_to_event) {
    failures.push(`event_window:${snap.event.suppression_reason}`);
  }

  return failures;
}

// ─── Dual-Direction Decision Logic ──────────────────────────────────────────

/**
 * Compare the best long and best short candidates and decide which (if any)
 * to enter. Implements the dual-direction confluence model.
 */
export function compareSides(
  bestLong: DirectionalCandidate | null,
  bestShort: DirectionalCandidate | null,
  regime: MarketRegime,
  config: IndicatorConfig,
): { decision: DualDirectionDecision; chosen: DirectionalCandidate | null; opposing: DirectionalCandidate | null; reason: string; margin: number } {
  const minScore = config.dual_min_score;
  let requiredMargin = config.dual_score_margin;

  // Extra margin in choppy/HVI regimes
  if (regime === 'choppy' || regime === 'high_volatility_impulse') {
    requiredMargin += config.dual_choppy_extra_margin;
  }

  const longValid = bestLong?.passedHardGates === true;
  const shortValid = bestShort?.passedHardGates === true;
  const longScore = bestLong?.score ?? 0;
  const shortScore = bestShort?.score ?? 0;

  // No candidates at all
  if (!bestLong && !bestShort) {
    return { decision: 'wait_no_candidates', chosen: null, opposing: null, reason: 'No candidate setups generated on either side', margin: 0 };
  }

  // Neither side passes hard gates
  if (!longValid && !shortValid) {
    const longGates = bestLong?.hardGateFailures.join(', ') ?? 'no_candidate';
    const shortGates = bestShort?.hardGateFailures.join(', ') ?? 'no_candidate';
    return {
      decision: 'wait_no_gates_passed',
      chosen: null, opposing: null,
      reason: `Both sides failed hard gates. Long: [${longGates}] Short: [${shortGates}]`,
      margin: 0,
    };
  }

  // Only one side valid
  if (longValid && !shortValid) {
    if (longScore >= minScore) {
      return { decision: 'enter_long', chosen: bestLong, opposing: bestShort, reason: `Long valid (${longScore}) ≥ minScore (${minScore}), short failed gates`, margin: longScore - shortScore };
    }
    return { decision: 'wait_below_min_score', chosen: null, opposing: null, reason: `Long valid but score ${longScore} < minScore ${minScore}`, margin: 0 };
  }

  if (shortValid && !longValid) {
    if (shortScore >= minScore) {
      return { decision: 'enter_short', chosen: bestShort, opposing: bestLong, reason: `Short valid (${shortScore}) ≥ minScore (${minScore}), long failed gates`, margin: shortScore - longScore };
    }
    return { decision: 'wait_below_min_score', chosen: null, opposing: null, reason: `Short valid but score ${shortScore} < minScore ${minScore}`, margin: 0 };
  }

  // Both valid — compare with margin
  const margin = Math.abs(longScore - shortScore);
  const marginFormatted = Math.round(margin * 10) / 10;

  if (longScore >= minScore && longScore > shortScore && margin >= requiredMargin) {
    return { decision: 'enter_long', chosen: bestLong, opposing: bestShort, reason: `Long wins: ${longScore} vs ${shortScore} (margin ${marginFormatted} ≥ ${requiredMargin})`, margin };
  }

  if (shortScore >= minScore && shortScore > longScore && margin >= requiredMargin) {
    return { decision: 'enter_short', chosen: bestShort, opposing: bestLong, reason: `Short wins: ${shortScore} vs ${longScore} (margin ${marginFormatted} ≥ ${requiredMargin})`, margin };
  }

  // Both valid but neither has enough margin or score
  if (longScore < minScore && shortScore < minScore) {
    return { decision: 'wait_both_weak', chosen: null, opposing: null, reason: `Both below minScore: long=${longScore} short=${shortScore} (min=${minScore})`, margin };
  }

  return { decision: 'wait_insufficient_margin', chosen: null, opposing: null, reason: `Margin ${marginFormatted} < required ${requiredMargin}. Long=${longScore} Short=${shortScore}`, margin };
}

// ─── Tick Rounding Helper ────────────────────────────────────────────────────

function tickRoundCandidate(setup: CandidateSetup, contract: ContractSpec): void {
  const entryMid = (setup.entry_low + setup.entry_high) / 2;
  setup.stop = roundToTickAwayFromEntry(setup.stop, entryMid, 'stop', setup.direction as 'long' | 'short', contract);
  setup.target_1 = roundToTickAwayFromEntry(setup.target_1, entryMid, 'target', setup.direction as 'long' | 'short', contract);
  setup.target_2 = roundToTickAwayFromEntry(setup.target_2, entryMid, 'target', setup.direction as 'long' | 'short', contract);
  if (setup.target_3 !== null) {
    setup.target_3 = roundToTickAwayFromEntry(setup.target_3, entryMid, 'target', setup.direction as 'long' | 'short', contract);
  }
  setup.risk_pts = Math.abs(entryMid - setup.stop);
  setup.rr_t1 = computeRr(setup.target_1, entryMid, setup.risk_pts, setup.direction);
  setup.rr_t2 = computeRr(setup.target_2, entryMid, setup.risk_pts, setup.direction);
  console.log(
    `[TICKS] ${setup.direction.toUpperCase()} rounded stop=${setup.stop} t1=${setup.target_1} t2=${setup.target_2} ` +
    `risk=${priceToTicks(setup.risk_pts, contract)}tk rr=${setup.rr_t1}/${setup.rr_t2}`,
  );
}

// ─── Build ML Features ──────────────────────────────────────────────────────

function buildMlFeatures(
  snap: MarketSnapshot,
  bias: MultiTfBias,
  regime: MarketRegime,
  best: CandidateSetup | null,
): SignalContextSnapshot {
  const price = snap.price;
  const ind = snap.indicators_1m;
  const kl = snap.key_levels;
  return {
    price_vs_ema9_1m: ind.ema_9 !== null ? price - ind.ema_9 : null,
    price_vs_ema21_1m: ind.ema_21 !== null ? price - ind.ema_21 : null,
    price_vs_ema50_1m: ind.ema_50 !== null ? price - ind.ema_50 : null,
    price_vs_ema200_1h: snap.indicators_1h.ema_200 !== null ? price - snap.indicators_1h.ema_200 : null,
    supertrend_dir_1m: ind.supertrend_direction,
    supertrend_dir_1h: snap.indicators_1h.supertrend_direction,
    all_tf_aligned: bias.aligned,
    alignment_score: bias.alignment_score,
    session_high_distance_pts: kl.session_high !== null ? kl.session_high - price : null,
    session_low_distance_pts: kl.session_low !== null ? price - kl.session_low : null,
    choch_buy_distance_pts: kl.choch_buy !== null ? price - kl.choch_buy : null,
    choch_sell_distance_pts: kl.choch_sell !== null ? kl.choch_sell - price : null,
    bos_sell_distance_pts: kl.bos_sell !== null ? kl.bos_sell - price : null,
    volume_last_1m: last(snap.bars_1m)?.volume ?? null,
    regime,
    htf_alignment: bias['1h'] !== 'neutral',
    rr_t1: best?.rr_t1 ?? null,
    rr_t2: best?.rr_t2 ?? null,
    setup_type: best?.setup_type ?? null,
    bar_direction_5m_last: (() => { const b = last(snap.bars_5m); return b ? barDir(b) : null; })(),
    bar_direction_15m_last: (() => { const b = last(snap.bars_15m); return b ? barDir(b) : null; })(),
  };
}

// ─── Dual-Direction Console Log ─────────────────────────────────────────────

function formatCandidate(c: DirectionalCandidate | null, label: string): string {
  if (!c) return `${label}: none`;
  const gateStr = c.passedHardGates
    ? 'PASS'
    : `FAIL(${c.hardGateFailures.slice(0, 2).join(', ')}${c.hardGateFailures.length > 2 ? '...' : ''})`;
  const bd = c.scoreBreakdown;
  const activeFactors: string[] = [];
  if (bd.tf_alignment !== 0) activeFactors.push(`tf=${bd.tf_alignment > 0 ? '+' : ''}${bd.tf_alignment}`);
  if (bd.htf_direction !== 0) activeFactors.push(`htf=${bd.htf_direction}`);
  if (bd.vwap_position !== 0) activeFactors.push(`vwap=${bd.vwap_position > 0 ? '+' : ''}${bd.vwap_position}`);
  if (bd.or_level !== 0) activeFactors.push(`or=${bd.or_level > 0 ? '+' : ''}${bd.or_level}`);
  if (bd.adx_trend_strength !== 0) activeFactors.push(`adx=${bd.adx_trend_strength > 0 ? '+' : ''}${bd.adx_trend_strength}`);
  if (bd.ttm_squeeze !== 0) activeFactors.push(`ttm=${bd.ttm_squeeze > 0 ? '+' : ''}${bd.ttm_squeeze}`);
  if (bd.cvd_alignment !== 0) activeFactors.push(`cvd=${bd.cvd_alignment > 0 ? '+' : ''}${bd.cvd_alignment}`);
  if (bd.supertrend !== 0) activeFactors.push(`st=${bd.supertrend > 0 ? '+' : ''}${bd.supertrend}`);
  if (bd.regime_alignment !== 0) activeFactors.push(`reg=${bd.regime_alignment > 0 ? '+' : ''}${bd.regime_alignment}`);
  const factorSummary = activeFactors.length > 0 ? ` [${activeFactors.join(' ')}]` : '';
  return `${label}: ${c.setup.setup_type} score=${c.score} gates=${gateStr}${factorSummary}`;
}

function printDualDirectionSummary(
  bestLong: DirectionalCandidate | null,
  bestShort: DirectionalCandidate | null,
  decision: DualDirectionDecision,
  reason: string,
  margin: number,
  longCount: number,
  shortCount: number,
): void {
  console.log('┌─ Dual-Direction Evaluation ─────────────────────────────────');
  console.log(`│  ${formatCandidate(bestLong, 'LONG')}`);
  if (longCount > 1) console.log(`│    (${longCount} long candidates evaluated)`);
  console.log(`│  ${formatCandidate(bestShort, 'SHORT')}`);
  if (shortCount > 1) console.log(`│    (${shortCount} short candidates evaluated)`);
  console.log(`│  MARGIN:   ${Math.round(margin * 10) / 10}`);
  console.log(`│  DECISION: ${decision}`);
  console.log(`│  REASON:   ${reason}`);
  console.log('└─────────────────────────────────────────────────────────────');
}

// ─── Main Signal Generator ────────────────────────────────────────────────────

export function generateSignal(
  snap: MarketSnapshot,
  config: IndicatorConfig,
  contract?: ContractSpec,
  dynamicRewardConfig?: DynamicRewardConfig | null,
): DualDirectionResult {
  const regime = classifyRegime(snap);
  const bias = assessMultiTfBias(snap);
  // Resolve dynamic reward config.
  //
  // Priority order:
  //   1. Explicit argument (passed by caller, e.g., tests)
  //   2. Config-embedded block (merged with defaults for any missing fields)
  //   3. DEFAULT_DYNAMIC_REWARD_CONFIG (active by default when config is silent)
  //
  // Dynamic RR is ONLY disabled when config.dynamic_reward_planning.enabled === false.
  // Absence of the config block means "use defaults" — NOT "disable."
  // This is consistent with the config printer and runner, which both treat
  // absence as active.
  let drpSource: 'argument' | 'config' | 'default' | 'explicit_disable' = 'default';
  const drpConfig: DynamicRewardConfig | null = (() => {
    // 1. Explicit argument takes precedence
    if (dynamicRewardConfig !== undefined) {
      drpSource = dynamicRewardConfig === null ? 'explicit_disable' : 'argument';
      return dynamicRewardConfig;
    }
    // 2. Config block present — merge with defaults, respect enabled flag
    if (config.dynamic_reward_planning) {
      const merged = { ...DEFAULT_DYNAMIC_REWARD_CONFIG, ...config.dynamic_reward_planning };
      if (!merged.enabled) { drpSource = 'explicit_disable'; return null; }
      drpSource = 'config';
      return merged;
    }
    // 3. Config block absent — active by default
    drpSource = 'default';
    return DEFAULT_DYNAMIC_REWARD_CONFIG;
  })();

  // ── Step 1: Generate all candidate setups ────────────────────────────────
  const generators: Array<(s: MarketSnapshot) => CandidateSetup | null> = [
    genTrendPullbackShort,
    genTrendPullbackLong,
    genBreakdownRetestShort,
    genBreakoutRetestLong,
  ];
  if (config.enable_opening_drive) {
    generators.push(genOpeningDriveContinuationLong, genOpeningDriveContinuationShort);
  }
  if (config.enable_failed_or_break) {
    generators.push(genFailedOrBreakShort, genFailedOrBreakLong);
  }
  if (config.enable_momentum_continuation) {
    generators.push(genBreakdownMomentumShort);
  }

  // Track candidates alongside their pre-computed score breakdowns so we
  // never call scoreConfidenceDetailed() twice for the same candidate.
  type ScoredCandidate = { setup: CandidateSetup; breakdown: ScoreBreakdown };
  const longCandidates: ScoredCandidate[] = [];
  const shortCandidates: ScoredCandidate[] = [];

  for (const gen of generators) {
    const s = gen(snap);
    if (s) {
      // Tick-round before scoring (rr may change after rounding)
      if (contract) tickRoundCandidate(s, contract);
      // Score ONCE — breakdown is stored and reused downstream
      const breakdown = scoreConfidenceDetailed(s, snap, bias, regime, config);
      s.confidence = breakdown.total;
      s.confidence_factors = breakdown.factors;

      console.log(
        `[CONFIDENCE] ${s.direction.toUpperCase()} ${s.setup_type} ` +
        `score=${breakdown.total} factors=[${breakdown.factors.join(', ')}]`,
      );

      if (s.direction === 'long') {
        longCandidates.push({ setup: s, breakdown });
      } else {
        shortCandidates.push({ setup: s, breakdown });
      }
    }
  }

  // ── Step 2: Pick best per side ───────────────────────────────────────────
  longCandidates.sort((a, b) => b.setup.confidence - a.setup.confidence);
  shortCandidates.sort((a, b) => b.setup.confidence - a.setup.confidence);

  function buildDirectionalCandidate(scored: ScoredCandidate | undefined): DirectionalCandidate | null {
    if (!scored) return null;
    const { setup, breakdown } = scored;

    // Build dynamic reward plan for THIS candidate (family+regime aware).
    // Extension features and microstructure score are not yet available at
    // strategy time — they'll be added as a second-pass refinement in runner.ts.
    // The core family baseline + regime adjustment is sufficient for the RR gate.
    let rewardPlan: DynamicRewardPlan | null = null;
    if (drpConfig && drpConfig.enabled) {
      rewardPlan = buildDynamicRewardPlan(
        setup, snap, regime, config,
        null,  // extension features (not yet computed)
        null,  // microstructure score (not yet available)
        drpConfig,
      );
    }

    // Reuse the pre-computed breakdown — no second scoreConfidenceDetailed() call
    const gates = applyHardGates(setup, setup.confidence, bias, regime, snap, config, rewardPlan);
    return {
      setup,
      score: setup.confidence,
      scoreBreakdown: breakdown,
      hardGateFailures: gates,
      passedHardGates: gates.length === 0,
      rewardPlan,
    };
  }

  const bestLong = buildDirectionalCandidate(longCandidates[0]);
  const bestShort = buildDirectionalCandidate(shortCandidates[0]);

  // ── Step 3: Dual-direction decision ──────────────────────────────────────
  const { decision, chosen, opposing, reason, margin } = compareSides(bestLong, bestShort, regime, config);

  printDualDirectionSummary(bestLong, bestShort, decision, reason, margin, longCandidates.length, shortCandidates.length);

  // ── Step 4: Build skip reasons for backward compat ───────────────────────
  const skipReasons: string[] = [];
  const bestSetup = chosen?.setup ?? null;
  const chosenScore = chosen?.score ?? 0;
  // confidence reflects the best available candidate score (for operator visibility),
  // even when no candidate is chosen.  chosenScore is used for trade gating.
  const confidence = Math.max(bestLong?.score ?? 0, bestShort?.score ?? 0, chosenScore);

  if (!bestSetup) {
    if (decision === 'wait_no_candidates') {
      skipReasons.push('no_candidate_setup_generated');
    } else if (decision === 'wait_no_gates_passed') {
      // Include both sides' gate failures
      if (bestLong) skipReasons.push(...bestLong.hardGateFailures.map(f => `long:${f}`));
      if (bestShort) skipReasons.push(...bestShort.hardGateFailures.map(f => `short:${f}`));
    } else if (decision === 'wait_below_min_score') {
      skipReasons.push(`dual_below_min_score:${reason}`);
    } else if (decision === 'wait_insufficient_margin') {
      skipReasons.push(`dual_insufficient_margin:${reason}`);
    } else if (decision === 'wait_both_weak') {
      skipReasons.push(`dual_both_weak:${reason}`);
    }
  } else {
    // Chosen side passed hard gates, but still apply min_confidence from legacy config
    if (chosenScore < config.min_confidence) {
      skipReasons.push(`confidence_${chosenScore}_below_threshold_${config.min_confidence}`);
    }
  }

  const tradeAllowed = skipReasons.length === 0 && bestSetup !== null;

  // ── Step 5: ML features ──────────────────────────────────────────────────
  const mlFeatures = buildMlFeatures(snap, bias, regime, bestSetup);

  return {
    regime,
    bias,
    bestLong,
    bestShort,
    chosen,
    opposing,
    decision,
    decisionReason: reason,
    scoreMargin: margin,
    bestSetup,
    confidence,
    tradeAllowed,
    skipReasons,
    mlFeatures,
    dynamicRrUpstreamActive: drpConfig !== null,
    dynamicRrSource: drpSource,
  };
}
