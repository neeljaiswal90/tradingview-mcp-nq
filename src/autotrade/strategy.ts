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
  CandidateGeneratorDiagnostic,
  TrendFreshnessResult,
  DirectionalFreshnessConfig,
  SetupFamily,
} from './types.js';
import type { LobSnapshot } from './lob-client.js';
import {
  computeLayeredScore,
  layeredToLegacyBreakdown,
  DEFAULT_LAYERED_SCORING_CONFIG,
  type LayeredScoringConfig,
  type LayeredScoreResult,
} from './features/layered-scoring.js';

import type { IndicatorConfig, HtfSetupEvaluation, HtfZonesConfig } from './types.js';
import type { ContractSpec } from './contracts.js';
import { roundToTickAwayFromEntry, priceToTicks } from './contracts.js';
// getSetupFamily was previously imported from management-profiles.ts but
// never referenced. Removed to keep the import surface minimal and to
// let management-profiles.ts safely import STRATEGY_REGISTRY from this
// file (used to derive its FAMILY_MAP) without a circular import.
import { buildDynamicRewardPlan, buildLegacyRewardPlan, DEFAULT_DYNAMIC_REWARD_CONFIG } from './features/dynamic-reward-plan.js';
import type { DynamicRewardPlan, DynamicRewardConfig } from './features/dynamic-reward-plan.js';
import { evaluateHtfForSetup, DEFAULT_HTF_ZONES_CONFIG } from './features/htf-zones.js';
import { computeNormalizers } from './features/normalization.js';
import { buildEntryStateVector } from './features/entry-state.js';
import { hydrateEntryStateVectorOrderflow } from './features/orderflow-state.js';
import { hydrateQuantRewardContract } from './features/initial-risk.js';
import type { ExpectancyBucketTable } from './features/expectancy-engine.js';
import { computeEntryStateVectorHash } from './features/state-vector-hash.js';
import {
  resolveQuantEntryConfig,
  isQuantEntryActiveForDirection,
} from './features/quant-entry-config.js';
import {
  buildQuantShadowDecision,
  type EntryMlVerdictSource,
} from './features/quant-shadow-decision.js';

// ── Phase 3 quant trend-pullback constants ─────────────────────────────────
//
// These are deliberately module-local for Phase 3. Phase 7 (plan §5) moves
// them into `env.ts` under `quant_entry` so they can be tuned per config.
//
// Sign convention (matches entry-state.ts Phase 1 header): for both long
// and short, z_ema9 POSITIVE = price is on the trend side of EMA9. The
// band below therefore applies identically to both directions — see
// user-confirmed decision in the Phase 3 implementation thread.
const QUANT_TP_Z_EMA9_MIN = 0.15;
const QUANT_TP_Z_EMA9_MAX = 1.25;
/** Pullback ratio band — Fibonacci-ish 25%–62%. */
const QUANT_TP_PULLBACK_RATIO_MIN = 0.25;
const QUANT_TP_PULLBACK_RATIO_MAX = 0.62;
/** Flow confirmation threshold (soft gate — null-safe). Starts wide per plan §5. */
const QUANT_TP_FLOW_CONFIRMATION_MIN = 0.20;
/** Entry band half-width in sigma units (replaces hardcoded ±5 offset). */
const QUANT_TP_ENTRY_HALF_BAND_SIGMA = 0.1;
/**
 * Volatility-based initial stop multiplier. Phase 4 will extend this with
 * the "tighter of structure and volatility" rule and refit k_sl from
 * historical MAE; Phase 3 ships this bootstrap value to keep the exit
 * criterion "no hardcoded ema21±20 constants" satisfied today.
 */
const QUANT_TP_K_SL = 1.05;
import { ema as computeEma, atr as computeAtr, supertrendDirection } from './features/indicators.js';

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

export type GeneratorEvaluation = {
  setupType: SetupType;
  setupFamily: SetupFamily;
  candidate: CandidateSetup | null;
  rejectionReasonPrimary: string | null;
  rejectionReasonAll: string[];
};

type ReversalBundleResult = {
  passed: boolean;
  reason: string;
  barsSinceFlip: number | null;
  structureDeteriorationPassed: boolean;
  emaFormationPassed: boolean;
  regimeFilterPassed: boolean;
};

const completedBarsCache = new WeakMap<MarketSnapshot, Partial<Record<'1m' | '5m' | '15m' | '1h', OhlcvBar[]>>>();
const reversalBundleCache = new WeakMap<MarketSnapshot, ReversalBundleResult>();

function getCompletedBars(
  snap: MarketSnapshot,
  timeframe: '1m' | '5m' | '15m' | '1h',
): OhlcvBar[] {
  const cached = completedBarsCache.get(snap)?.[timeframe];
  if (cached) return cached;

  const bars =
    timeframe === '1m' ? snap.bars_1m
      : timeframe === '5m' ? snap.bars_5m
        : timeframe === '15m' ? snap.bars_15m
          : snap.bars_1h;
  const timeframeSeconds =
    timeframe === '1m' ? 60
      : timeframe === '5m' ? 300
        : timeframe === '15m' ? 900
          : 3600;

  let completed = bars;
  const lastBar = last(bars);
  if (lastBar && snap.timestamp_unix < lastBar.time + timeframeSeconds) {
    completed = bars.slice(0, -1);
  }

  const entry = completedBarsCache.get(snap) ?? {};
  entry[timeframe] = completed;
  completedBarsCache.set(snap, entry);
  return completed;
}

function getSessionLabel(snap: MarketSnapshot): 'ETH' | 'RTH' | null {
  if (snap.session?.is_eth) return 'ETH';
  if (snap.session?.is_rth) return 'RTH';
  return null;
}

function getDirectionalFreshnessConfig(config: IndicatorConfig): DirectionalFreshnessConfig {
  return {
    enabled: true,
    long_vwap_mode: 'hard',
    short_vwap_mode: 'hard',
    short_above_vwap_allowance_session_atr: 0.35,
    short_above_vwap_penalty: 0.4,
    require_5m_structure: true,
    require_supertrend_or_ema21_exception: true,
    short_above_vwap_penalty_midpoint_atr: 0.20,
    short_above_vwap_penalty_slope_atr: 0.08,
    ...(config.directional_freshness ?? {}),
  };
}

/**
 * Shaped directional-freshness penalty for shorts allowed above VWAP.
 *
 *     π_fresh(z) = −λ · σ((z − a0) / b0)
 *
 * where z is the session-ATR VWAP distance (positive = above VWAP), λ is the
 * `short_above_vwap_penalty` config field, a0 is the midpoint and b0 is the
 * slope width. The result is clamped into [−λ, 0]. Replaces the earlier
 * flat penalty so borderline and near-VWAP setups get different discounts.
 */
export function computeShapedFreshnessPenalty(
  vwapDistanceSessionAtr: number,
  freshnessConfig: DirectionalFreshnessConfig,
): number {
  const lambda = Math.abs(freshnessConfig.short_above_vwap_penalty);
  if (lambda === 0) return 0;
  const a0 = freshnessConfig.short_above_vwap_penalty_midpoint_atr ?? 0.20;
  const b0Raw = freshnessConfig.short_above_vwap_penalty_slope_atr ?? 0.08;
  // Guard against zero/negative slope widths from misconfigured defaults.
  const b0 = b0Raw > 1e-6 ? b0Raw : 0.08;
  const u = (vwapDistanceSessionAtr - a0) / b0;
  const sigmoid = 1 / (1 + Math.exp(-u));
  const penalty = -lambda * sigmoid;
  // Safety clamp — sigmoid already lives in [0, 1], so penalty ∈ [−λ, 0].
  if (penalty < -lambda) return -lambda;
  if (penalty > 0) return 0;
  return penalty;
}

/**
 * Shaped reversal-transition bonus for the post-flip first pullback setup.
 *
 *     B_flip(b) = β · exp(−(b − b*)² / (2 σ²))
 *
 * where `b` is `bars_since_flip`, `b*` is the peak-bar sweet spot and σ is
 * the Gaussian width (both from scoring_weights). Returns `β` (full bonus)
 * when `bars_since_flip` is missing, preserving the pre-shaped behaviour so
 * that setups which don't track flip timing are unaffected.
 */
export function computeShapedReversalBonus(
  barsSinceFlip: number | null,
  weights: ScoringWeights,
): number {
  const beta = weights.reversal_transition_bonus;
  if (beta <= 0) return 0;
  if (barsSinceFlip === null || barsSinceFlip === undefined) return beta;
  const bStar = weights.reversal_bonus_peak_bars_since_flip ?? 7;
  const sigmaRaw = weights.reversal_bonus_sigma_bars ?? 3;
  const sigma = sigmaRaw > 1e-6 ? sigmaRaw : 3;
  const d = barsSinceFlip - bStar;
  const gaussian = Math.exp(-(d * d) / (2 * sigma * sigma));
  const bonus = beta * gaussian;
  if (bonus < 0) return 0;
  if (bonus > beta) return beta;
  return bonus;
}

function buildGeneratorRejection(
  setupType: SetupType,
  setupFamily: SetupFamily,
  ...reasons: Array<string | null | undefined>
): GeneratorEvaluation {
  const cleaned = reasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0);
  return {
    setupType,
    setupFamily,
    candidate: null,
    rejectionReasonPrimary: cleaned[0] ?? 'conditions_not_met',
    rejectionReasonAll: cleaned.length > 0 ? cleaned : ['conditions_not_met'],
  };
}

function attachGeneratorDiagnostic(
  setup: CandidateSetup,
  setupType: SetupType,
  setupFamily: SetupFamily,
): CandidateSetup {
  return {
    ...setup,
    generator_diagnostic: {
      setup_type: setupType,
      setup_family: setupFamily,
      accepted: true,
      rejection_reason_primary: null,
      rejection_reason_all: [],
    },
  };
}

function withSetupCandidate(
  setupType: SetupType,
  setupFamily: SetupFamily,
  setup: CandidateSetup,
): GeneratorEvaluation {
  return {
    setupType,
    setupFamily,
    candidate: attachGeneratorDiagnostic(setup, setupType, setupFamily),
    rejectionReasonPrimary: null,
    rejectionReasonAll: [],
  };
}

function getVwapDistanceSessionAtr(snap: MarketSnapshot, price: number): number | null {
  const vwap = snap.indicators_1m.vwap;
  if (vwap === null || vwap <= 0) return null;
  const norms = computeNormalizers(snap);
  if (norms === null) return null;
  const sessionAtr = norms.session_atr;
  if (!sessionAtr || sessionAtr <= 0) return null;
  return Math.round((Math.abs(price - vwap) / sessionAtr) * 100) / 100;
}

function buildOneMinuteDerivedSeries(snap: MarketSnapshot): Array<{
  bar: OhlcvBar;
  ema9: number | null;
  ema21: number | null;
  atr14: number | null;
  stDirection: 'up' | 'down' | null;
}> {
  const completed = getCompletedBars(snap, '1m');
  return completed.map((bar, idx) => {
    const window = completed.slice(0, idx + 1);
    const closes = window.map(candidate => candidate.close);
    const ema9 = computeEma(closes, 9);
    const ema21 = computeEma(closes, 21);
    const atr14 = computeAtr(window as any, 14);
    return {
      bar,
      ema9,
      ema21,
      atr14,
      stDirection: supertrendDirection(ema9, ema21),
    };
  });
}

function evaluateEthShortReversalCore(snap: MarketSnapshot, regime: MarketRegime): ReversalBundleResult {
  const cached = reversalBundleCache.get(snap);
  if (cached) return cached;

  const completed1m = buildOneMinuteDerivedSeries(snap);
  const completed5m = getCompletedBars(snap, '5m');

  let barsSinceFlip: number | null = null;
  for (let i = completed1m.length - 1; i >= 1; i--) {
    const current = completed1m[i];
    const previous = completed1m[i - 1];
    if (current?.stDirection === 'down' && previous?.stDirection === 'up') {
      barsSinceFlip = completed1m.length - 1 - i;
      break;
    }
  }

  const flipPassed = barsSinceFlip !== null && barsSinceFlip <= 15;
  const structurePassed = completed5m.length >= 6
    ? Math.max(...completed5m.slice(-3).map(bar => bar.high)) <= Math.max(...completed5m.slice(-6, -3).map(bar => bar.high))
    : false;
  const regimePassed = regime !== 'trending_up' && regime !== 'breakout_attempt';

  let emaFormationPassed = false;
  if (flipPassed && barsSinceFlip !== null) {
    const startIndex = Math.max(0, completed1m.length - 1 - barsSinceFlip);
    const postFlipSeries = completed1m.slice(startIndex);
    const current = postFlipSeries[postFlipSeries.length - 1];
    const priorCandidates = postFlipSeries.slice(Math.max(0, postFlipSeries.length - 3), Math.max(0, postFlipSeries.length - 1));
    const relationHolds = (point: typeof current): boolean =>
      point !== undefined
      && point.bar.close <= (point.ema9 ?? Number.NEGATIVE_INFINITY)
      && point.ema9 !== null
      && point.ema21 !== null
      && point.atr14 !== null
      && point.ema9 <= point.ema21 + 0.15 * point.atr14;

    if (current && relationHolds(current)) {
      if (priorCandidates.length >= 2) {
        emaFormationPassed = priorCandidates.some(candidate => relationHolds(candidate));
      } else {
        emaFormationPassed = postFlipSeries.every(candidate => relationHolds(candidate));
      }
    }
  }

  const result: ReversalBundleResult =
    flipPassed && structurePassed && emaFormationPassed && regimePassed
      ? {
        passed: true,
        reason: 'eth_short_reversal_core_passed',
        barsSinceFlip,
        structureDeteriorationPassed: true,
        emaFormationPassed: true,
        regimeFilterPassed: true,
      }
      : {
        passed: false,
        reason:
          !flipPassed
            ? 'eth_short_reversal_core:flip_too_old_or_missing'
            : !structurePassed
              ? 'eth_short_reversal_core:5m_structure_not_broken'
              : !emaFormationPassed
                ? 'eth_short_reversal_core:ema_formation_not_confirmed'
                : 'eth_short_reversal_core:regime_still_up',
        barsSinceFlip,
        structureDeteriorationPassed: structurePassed,
        emaFormationPassed,
        regimeFilterPassed: regimePassed,
      };

  reversalBundleCache.set(snap, result);
  return result;
}

/**
 * Resolve the SELECTION floor — the score a candidate must beat to be logged
 * and forwarded into the dual-direction comparison. This can be below the
 * execution floor (`dual_min_score`); a candidate between the two is marked
 * `selection_only` and never executed.
 *
 * Lookup order: `session_selection_floor_overrides` (preferred) →
 * `session_score_overrides` (legacy fallback) → `dual_min_score`.
 */
function resolveSelectionFloor(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  config: IndicatorConfig,
): number {
  const base = config.dual_min_score;
  const label = getSessionLabel(snap);
  if (!label) return base;
  const preferred = config.session_selection_floor_overrides?.[label];
  const preferredOverrides =
    setup.direction === 'short' ? preferred?.short : preferred?.long;
  const preferredFloor = preferredOverrides?.[setup.setup_type];
  if (preferredFloor !== undefined) return preferredFloor;
  // Legacy fallback — keeps any historical `session_score_overrides` entries
  // honored until they are migrated to the new key.
  const legacy = config.session_score_overrides?.[label];
  const legacyOverrides =
    setup.direction === 'short' ? legacy?.short : legacy?.long;
  return legacyOverrides?.[setup.setup_type] ?? base;
}

/**
 * Resolve the EXECUTION floor — always the global `dual_min_score`. A
 * candidate that clears the selection floor but not the execution floor
 * is forwarded but not executed.
 */
function resolveExecutionFloor(config: IndicatorConfig): number {
  return config.dual_min_score;
}

function summarizeRejections(
  diagnostics: CandidateGeneratorDiagnostic[],
): {
  rejectionsBySetup: Record<string, string[]>;
  topRejectionReason: string | null;
  countRejectionsThisCycle: number;
} {
  const rejectionsBySetup: Record<string, string[]> = {};
  const counts = new Map<string, number>();

  for (const diagnostic of diagnostics) {
    if (diagnostic.accepted) continue;
    rejectionsBySetup[diagnostic.setup_type] = diagnostic.rejection_reason_all;
    for (const reason of diagnostic.rejection_reason_all) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  let topRejectionReason: string | null = null;
  let topCount = -1;
  for (const [reason, count] of counts.entries()) {
    if (count > topCount) {
      topCount = count;
      topRejectionReason = reason;
    }
  }

  return {
    rejectionsBySetup,
    topRejectionReason,
    countRejectionsThisCycle: diagnostics.filter(diagnostic => !diagnostic.accepted).length,
  };
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
// ─── Unified Directional Freshness ──────────────────────────────────────────
//
// Both sides use the SAME conceptual framework:
//   1. 5m bar structure: higher lows (up) or lower highs (down)
//   2. 1m momentum: SuperTrend must not have flipped against the direction
//   3. Session bias: price must be on the correct side of VWAP
//
// This replaces the old asymmetry where isUptrendFresh existed but shorts
// had no equivalent freshness gate.

/**
 * Evaluate whether the current directional trend is "fresh" enough to
 * justify a pullback entry. Works for both long and short directions.
 *
 * @param snap - Market snapshot
 * @param direction - 'long' or 'short'
 * @returns Object with pass/fail and diagnostic reason
 */
export function isTrendFresh(
  snap: MarketSnapshot,
  direction: 'long' | 'short',
  config?: IndicatorConfig,
  setupType?: SetupType,
): TrendFreshnessResult {
  const isLong = direction === 'long';
  const freshnessConfig = getDirectionalFreshnessConfig(config ?? {} as IndicatorConfig);
  const bars5m = getCompletedBars(snap, '5m');
  const ind = snap.indicators_1m;
  const regime = classifyRegime(snap);
  const reversalCore = !isLong ? evaluateEthShortReversalCore(snap, regime) : null;
  const context = {
    vwap_distance_session_atr: getVwapDistanceSessionAtr(snap, snap.price),
    above_vwap_allowed: false,
    reversal_bundle_name: !isLong ? 'eth_short_reversal_core' : null,
    reversal_bundle_passed: reversalCore?.passed ?? false,
    bars_since_flip: reversalCore?.barsSinceFlip ?? null,
    structure_deterioration_passed: reversalCore?.structureDeteriorationPassed ?? false,
    ema_formation_passed: reversalCore?.emaFormationPassed ?? false,
    regime_filter_passed: reversalCore?.regimeFilterPassed ?? false,
  };

  // Check 1: 5m bar structure
  // Longs: require higher lows (recent 3 bars' min low > prior 3 bars' min low)
  // Shorts: require lower highs (recent 3 bars' max high < prior 3 bars' max high)
  if (bars5m.length >= 6) {
    const recent3 = bars5m.slice(-3);
    const prior3 = bars5m.slice(-6, -3);
    if (isLong) {
      const recentMinLow = Math.min(...recent3.map(b => b.low));
      const priorMinLow = Math.min(...prior3.map(b => b.low));
      if (recentMinLow <= priorMinLow) {
        return { fresh: false, reason: 'stale_uptrend:lower_lows_on_5m', soft_penalty: 0, context };
      }
    } else {
      const recentMaxHigh = Math.max(...recent3.map(b => b.high));
      const priorMaxHigh = Math.max(...prior3.map(b => b.high));
      if (recentMaxHigh >= priorMaxHigh) {
        return { fresh: false, reason: 'stale_downtrend:higher_highs_on_5m', soft_penalty: 0, context };
      }
    }
  }

  // Check 2: 1m SuperTrend must not have flipped against the direction
  // Exception: allow if price is still on the correct side of EMA21
  if (isLong && ind.supertrend_direction === 'down') {
    if (ind.ema_21 !== null && snap.price < ind.ema_21) {
      return { fresh: false, reason: 'stale_uptrend:supertrend_down_below_ema21', soft_penalty: 0, context };
    }
  }
  if (!isLong && ind.supertrend_direction === 'up') {
    if (ind.ema_21 !== null && snap.price > ind.ema_21) {
      return { fresh: false, reason: 'stale_downtrend:supertrend_up_above_ema21', soft_penalty: 0, context };
    }
  }

  // Check 3: Session VWAP bias
  // Longs: price should be above VWAP
  // Shorts: price should be below VWAP
  const vwap = ind.vwap;
  if (vwap !== null && vwap > 0) {
    if (isLong && snap.price < vwap) {
      return { fresh: false, reason: 'stale_uptrend:price_below_vwap', soft_penalty: 0, context };
    }
    if (!isLong && snap.price > vwap) {
      const softShortAllowed =
        freshnessConfig.enabled
        && freshnessConfig.short_vwap_mode === 'soft'
        && snap.session?.is_eth === true
        && (setupType === 'trend_pullback_short' || setupType === 'post_flip_first_pullback_short');

      if (!softShortAllowed) {
        return { fresh: false, reason: 'stale_downtrend:price_above_vwap', soft_penalty: 0, context };
      }

      const vwapDistance = context.vwap_distance_session_atr;
      if (
        vwapDistance === null
        || vwapDistance > freshnessConfig.short_above_vwap_allowance_session_atr
      ) {
        return {
          fresh: false,
          reason: 'stale_downtrend:price_above_vwap_allowance_exceeded',
          soft_penalty: 0,
          context,
        };
      }

      if (!reversalCore?.passed) {
        return {
          fresh: false,
          reason: reversalCore?.reason ?? 'stale_downtrend:reversal_bundle_missing',
          soft_penalty: 0,
          context,
        };
      }

      return {
        fresh: true,
        reason: 'trend_fresh_soft_vwap_short',
        soft_penalty: computeShapedFreshnessPenalty(vwapDistance, freshnessConfig),
        context: {
          ...context,
          above_vwap_allowed: true,
          reversal_bundle_passed: true,
        },
      };
    }
  }

  return { fresh: true, reason: 'trend_fresh', soft_penalty: 0, context };
}

/**
 * Legacy wrapper: returns boolean for backward-compatible call sites.
 * Delegates to the unified isTrendFresh().
 */
function isUptrendFresh(snap: MarketSnapshot, config?: IndicatorConfig): boolean {
  return isTrendFresh(snap, 'long', config).fresh;
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

export function genBreakdownRetestShort(snap: MarketSnapshot): GeneratorEvaluation {
  const setupType: SetupType = 'breakdown_retest_short';
  const setupFamily: SetupFamily = 'breakout_retest';
  const price = snap.price;
  const ind = snap.indicators_1m;
  const kl = snap.key_levels;

  const bossSell = ind.smart_money_bos_sell ?? kl.bos_sell;
  const chochSell = ind.smart_money_choch_sell ?? kl.choch_sell;
  const chochBuy = ind.smart_money_choch_buy ?? kl.choch_buy;

  // Resistance zone: just above current price
  const resistanceZoneLow = bossSell ?? chochSell;
  const resistanceZoneHigh = chochSell ?? bossSell;
  if (!resistanceZoneLow || !resistanceZoneHigh) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakdown_retest_short:resistance_zone_missing');
  }

  // Price must be below the resistance zone (broken support → now resistance)
  if (price >= resistanceZoneHigh) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakdown_retest_short:not_below_retest_zone');
  }
  // Price must be within striking distance (< 100 pts below resistance)
  if (resistanceZoneLow - price > 250) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakdown_retest_short:too_far_below_retest_zone');
  }
  // Price must be above CHoCH Buy support
  if (chochBuy !== null && price <= chochBuy) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakdown_retest_short:below_choch_buy');
  }

  // Entry at the lower edge of resistance zone
  const entryLow = Math.min(resistanceZoneLow, price + 10);
  const entryHigh = Math.max(resistanceZoneHigh, entryLow + 20);
  const entryMid = (entryLow + entryHigh) / 2;

  // Stop: above resistance zone + buffer
  const stopAbove = (ind.smart_money_choch_sell ?? resistanceZoneHigh) + 26;
  const stop = Math.max(stopAbove, entryHigh + 20);
  const riskPts = stop - entryMid;
  if (riskPts <= 0) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakdown_retest_short:non_positive_risk');
  }

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
  if (rrt1 < 1.0) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakdown_retest_short:rr_t1_below_structural_floor');
  }
  if (rrt1 <= 0 || rrt2 <= 0) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakdown_retest_short:targets_invalid');
  }

  const factors: string[] = ['breakdown_retest_zone_identified', 'bos_sell_overhead'];
  if (ind.supertrend_direction === 'down') factors.push('supertrend_down_confirming');

  const setup = {
    direction: dir,
    setup_type: setupType,
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
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

export function genTrendPullbackShort(snap: MarketSnapshot, config: IndicatorConfig): GeneratorEvaluation {
  const setupType: SetupType = 'trend_pullback_short';
  const setupFamily: SetupFamily = 'trend_pullback';
  const price = snap.price;
  const ind = snap.indicators_1m;

  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const stDir = ind.supertrend_direction;

  // ── Trend state gates (preserved: supertrend + EMA stack) ─────────────
  // SuperTrend remains as a trend-confirmation input per Phase 3 scope.
  if (stDir !== 'down') {
    return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_short:rejected_by_trend_state:supertrend_not_down');
  }
  if (!ema9 || !ema21 || !ema50) {
    return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_short:rejected_by_trend_state:ema_stack_missing');
  }
  if (!(ema9 < ema21 && ema21 < ema50)) {
    return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_short:rejected_by_trend_state:ema_stack_not_bearish');
  }

  // ── Freshness gate (PRESERVES 6964bd8 directional asymmetry) ─────────
  // isTrendFresh on the short side still enforces the ETH VWAP-allowance
  // soft-gate and the short reversal core bundle — do NOT inline or
  // duplicate the logic here.
  const freshness = isTrendFresh(snap, 'short', config, setupType);
  if (!freshness.fresh) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      `trend_pullback_short:rejected_by_freshness:${freshness.reason}`,
    );
  }

  // ── Build the canonical entry state vector (trend_pullback_short) ────
  const entryStateVector = buildEntryStateVector(snap, 'short', setupType, {
    regime: classifyRegime(snap),
  });
  if (!entryStateVector) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      'trend_pullback_short:rejected_by_trend_state:state_vector_unavailable',
    );
  }

  // ── Pullback geometry: z_ema9 band ────────────────────────────────────
  // Same sign-convention and band for long and short thanks to the
  // Phase 1 direction-aware z-score. Replaces the hardcoded
  // `0 < (ema9 - price) < 80pts` band with `[0.15, 1.25]` in sigma units.
  const zEma9 = entryStateVector.z_ema9;
  if (zEma9 === null) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      'trend_pullback_short:rejected_by_pullback_geometry:z_ema9_unavailable',
    );
  }
  if (zEma9 < QUANT_TP_Z_EMA9_MIN || zEma9 > QUANT_TP_Z_EMA9_MAX) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      `trend_pullback_short:rejected_by_pullback_geometry:z_ema9_out_of_band(${zEma9})`,
    );
  }

  // ── Pullback geometry: retracement ratio (soft if unavailable) ────────
  const pbRatio = entryStateVector.pullback_ratio;
  if (pbRatio !== null) {
    if (pbRatio < QUANT_TP_PULLBACK_RATIO_MIN || pbRatio > QUANT_TP_PULLBACK_RATIO_MAX) {
      return buildGeneratorRejection(
        setupType, setupFamily,
        `trend_pullback_short:rejected_by_pullback_geometry:ratio_out_of_band(${pbRatio})`,
      );
    }
  }

  // ── Flow confirmation (soft: null = pass) ─────────────────────────────
  const zFlow = entryStateVector.z_ofi_blend;
  if (zFlow !== null && zFlow < QUANT_TP_FLOW_CONFIRMATION_MIN) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      `trend_pullback_short:rejected_by_flow_confirmation:z_ofi_blend_below_threshold(${zFlow})`,
    );
  }

  // ── Volatility-based entry band + stop (replaces ±5 and ema21±20) ────
  const sigma = entryStateVector.sigma_pts;
  const entryHalfBand = sigma * QUANT_TP_ENTRY_HALF_BAND_SIGMA;
  const entryLow = price - entryHalfBand;
  const entryHigh = price + entryHalfBand;
  const entryMid = price;
  const stop = entryMid + sigma * QUANT_TP_K_SL;
  const riskPts = stop - entryMid;
  if (riskPts <= 0) {
    return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_short:non_positive_risk');
  }

  // ── Room-to-downside filter (PRESERVES 8c85383 room-filter path) ─────
  if (!hasRoomToDownside(snap, entryMid, 1.0)) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      'trend_pullback_short:rejected_by_room:insufficient_downside_room',
    );
  }

  const kl = snap.key_levels;
  const dir: Direction = 'short';
  const t1 = clampTarget(ind.smart_money_choch_buy, entryMid, riskPts, 2, dir);
  const t2 = clampTarget(kl.pivot_support[0] ?? null, entryMid, riskPts, 4, dir);

  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);

  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_short:rr_t1_below_structural_floor');
  if (rrt1 <= 0 || rrt2 <= 0) return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_short:targets_invalid');

  const setup = {
    direction: dir,
    setup_type: setupType,
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
    confidence_factors: ['trend_pullback', 'ema_stack_bearish', 'supertrend_down', 'fresh_downtrend_confirmed', 'downside_room_confirmed'],
    reason: `Trend pullback short into EMA cluster. Entry ${entryLow}–${entryHigh}, stop ${stop}`,
    freshness,
    entry_state_vector: entryStateVector,
  };
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

export function genPostFlipFirstPullbackShort(snap: MarketSnapshot, config: IndicatorConfig): GeneratorEvaluation {
  const setupType: SetupType = 'post_flip_first_pullback_short';
  const setupFamily: SetupFamily = 'trend_pullback';
  const ind = snap.indicators_1m;
  const price = snap.price;
  const atr14 = ind.atr_14;
  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;

  if (!config.enable_post_flip_first_pullback_short) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:disabled');
  }
  if (!snap.session?.is_eth) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:not_eth');
  }
  if (!ema9 || !ema21 || !ema50 || !atr14 || atr14 <= 0) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:ema_or_atr_missing');
  }

  const reversalCore = evaluateEthShortReversalCore(snap, classifyRegime(snap));
  if (!reversalCore.passed) {
    return buildGeneratorRejection(setupType, setupFamily, reversalCore.reason);
  }

  const completed1m = getCompletedBars(snap, '1m');
  if (completed1m.length < 3 || reversalCore.barsSinceFlip === null) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:flip_series_unavailable');
  }

  const flipIndex = completed1m.length - 1 - reversalCore.barsSinceFlip;
  const flipBar = completed1m[Math.max(0, flipIndex)];
  const currentImpulseAtr = flipBar ? Math.max(0, (flipBar.close - price) / atr14) : null;
  const last3 = completed1m.slice(-3);
  const last3BarReturnAtr = last3.length === 3
    ? Math.abs(last3[last3.length - 1]!.close - last3[0]!.open) / atr14
    : null;

  const bearishEmaForming = price <= ema9 && ema9 <= ema21 + 0.15 * atr14;
  if (!bearishEmaForming) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:bearish_ema_stack_not_forming');
  }

  const vwapDistance = getVwapDistanceSessionAtr(snap, price);
  const freshnessConfig = getDirectionalFreshnessConfig(config);
  if (
    vwapDistance !== null &&
    vwapDistance > freshnessConfig.short_above_vwap_allowance_session_atr
  ) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:vwap_allowance_exceeded');
  }

  const clusterHigh = Math.max(ema9, ema21);
  const retestDistance = Math.abs(price - clusterHigh);
  const maxRetestAtr = config.post_flip_first_pullback_short_max_retest_atr ?? 0.20;
  if (retestDistance > maxRetestAtr * atr14) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:retest_not_seen');
  }

  if (currentImpulseAtr !== null && currentImpulseAtr > 2.8) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:impulse_too_mature');
  }
  if (last3BarReturnAtr !== null && last3BarReturnAtr > 1.7) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:recent_move_too_fast');
  }

  const entryLow = Math.min(price, ema9 - 5);
  const entryHigh = Math.max(price, ema21 + 5);
  const entryMid = (entryLow + entryHigh) / 2;
  const recentHigh = Math.max(...completed1m.slice(-5).map(bar => bar.high));
  const stop = Math.max(ema50 + 15, recentHigh + 5);
  const riskPts = stop - entryMid;
  if (riskPts <= 0) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:non_positive_risk');
  }

  if (!hasRoomToDownside(snap, entryMid, 1.0)) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:insufficient_downside_room');
  }

  const dir: Direction = 'short';
  const kl = snap.key_levels;
  const t1 = clampTarget(ind.smart_money_choch_buy ?? kl.choch_buy, entryMid, riskPts, 2, dir);
  const t2 = clampTarget(kl.pivot_support[0] ?? kl.session_low ?? null, entryMid, riskPts, 4, dir);
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  if (rrt1 < 1.0) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:rr_t1_below_structural_floor');
  }
  if (rrt1 <= 0 || rrt2 <= 0) {
    return buildGeneratorRejection(setupType, setupFamily, 'post_flip_first_pullback_short:targets_invalid');
  }

  const freshness = isTrendFresh(snap, 'short', config, setupType);
  if (!freshness.fresh) {
    return buildGeneratorRejection(setupType, setupFamily, freshness.reason);
  }

  const setup = {
    direction: dir,
    setup_type: setupType,
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
    confidence_factors: [
      'post_flip_first_pullback_short',
      'eth_session',
      'recent_flip_down',
      '5m_deterioration',
      'ema_cluster_retest',
    ],
    reason: `ETH post-flip first pullback short. Entry ${entryLow}–${entryHigh}, stop ${stop}`,
    freshness,
    bars_since_flip: reversalCore.barsSinceFlip,
  };
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

export function genBreakdownMomentumShort(snap: MarketSnapshot): GeneratorEvaluation {
  const setupType: SetupType = 'momentum_continuation';
  const setupFamily: SetupFamily = 'momentum_continuation';
  const price = snap.price;
  const ind = snap.indicators_1m;
  const kl = snap.key_levels;

  const chochBuy = kl.choch_buy ?? ind.smart_money_choch_buy;
  if (!chochBuy) return buildGeneratorRejection(setupType, setupFamily, 'momentum_continuation:choch_buy_missing');

  // Price must have just broken through CHoCH Buy (price is below it)
  if (price >= chochBuy) return buildGeneratorRejection(setupType, setupFamily, 'momentum_continuation:not_below_choch_buy');
  if (chochBuy - price < 20) return buildGeneratorRejection(setupType, setupFamily, 'momentum_continuation:false_break_zone');
  if (price < chochBuy - 100) return buildGeneratorRejection(setupType, setupFamily, 'momentum_continuation:window_passed');

  // ── Momentum confirmation: require the last CLOSED 1m bar to close below
  //    the break level. This rejects wick-only false breaks.
  const bars1m = snap.bars_1m;
  const lastClosed = bars1m.length >= 2 ? bars1m[bars1m.length - 2] : undefined;
  if (!lastClosed || lastClosed.close >= chochBuy) {
    return buildGeneratorRejection(setupType, setupFamily, 'momentum_continuation:last_closed_bar_not_below_break');
  }

  const entryLow = price - 20;
  const entryHigh = chochBuy; // Enter on any bounce back to the broken level
  const entryMid = (entryLow + entryHigh) / 2;
  // ATR-aware stop: widen the stop buffer in higher-volatility environments so
  // we are not stopped out by ordinary noise. Falls back to 60pts if no ATR.
  const atr = ind.atr_14 ?? null;
  const atrBuffer = atr !== null ? Math.max(40, Math.min(120, atr * 0.75)) : 60;
  const stop = chochBuy + atrBuffer;
  const riskPts = stop - entryMid;
  if (riskPts <= 0) return buildGeneratorRejection(setupType, setupFamily, 'momentum_continuation:non_positive_risk');

  const dir: Direction = 'short';
  const t1 = clampTarget(kl.pivot_support[0] ?? null, entryMid, riskPts, 3, dir);
  const t2 = clampTarget(kl.daily_open ?? null, entryMid, riskPts, 5, dir);
  const t3Raw: number | null = kl.weekly_open ?? null;
  const t3: number | null = isTargetDirectionValid(t3Raw, entryMid, dir) ? t3Raw : null;

  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return buildGeneratorRejection(setupType, setupFamily, 'momentum_continuation:rr_t1_below_structural_floor');
  if (rrt1 <= 0 || rrt2 <= 0) return buildGeneratorRejection(setupType, setupFamily, 'momentum_continuation:targets_invalid');

  const setup = {
    direction: dir,
    setup_type: setupType,
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
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

export function genTrendPullbackLong(snap: MarketSnapshot, config: IndicatorConfig): GeneratorEvaluation {
  const setupType: SetupType = 'trend_pullback_long';
  const setupFamily: SetupFamily = 'trend_pullback';
  const price = snap.price;
  const ind = snap.indicators_1m;

  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const stDir = ind.supertrend_direction;

  // ── Trend state gates (preserved: supertrend + EMA stack) ─────────────
  // SuperTrend remains as a trend-confirmation input per Phase 3 scope.
  if (stDir !== 'up') {
    return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_long:rejected_by_trend_state:supertrend_not_up');
  }
  if (!ema9 || !ema21 || !ema50) {
    return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_long:rejected_by_trend_state:ema_stack_missing');
  }
  if (!(ema9 > ema21 && ema21 > ema50)) {
    return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_long:rejected_by_trend_state:ema_stack_not_bullish');
  }

  // ── Freshness gate (preserves long-side behavior; asymmetry lives in isTrendFresh) ──
  const freshness = isTrendFresh(snap, 'long', config, setupType);
  if (!freshness.fresh) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      `trend_pullback_long:rejected_by_freshness:${freshness.reason}`,
    );
  }

  // ── Build the canonical entry state vector (trend-pullback_long) ─────
  // If sigma_pts cannot be computed (missing ATR AND insufficient bars),
  // the vector returns null and the generator rejects — state-vector
  // gating is intentionally the primary gate now.
  const entryStateVector = buildEntryStateVector(snap, 'long', setupType, {
    regime: classifyRegime(snap),
  });
  if (!entryStateVector) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      'trend_pullback_long:rejected_by_trend_state:state_vector_unavailable',
    );
  }

  // ── Pullback geometry: z_ema9 band ────────────────────────────────────
  // Replaces the hardcoded `0 < distToEma9 < 80pts` band with a
  // sigma-normalized band [0.15, 1.25]. Same semantic (price is just
  // above EMA9 by a small amount), scaled to realized volatility.
  const zEma9 = entryStateVector.z_ema9;
  if (zEma9 === null) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      'trend_pullback_long:rejected_by_pullback_geometry:z_ema9_unavailable',
    );
  }
  if (zEma9 < QUANT_TP_Z_EMA9_MIN || zEma9 > QUANT_TP_Z_EMA9_MAX) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      `trend_pullback_long:rejected_by_pullback_geometry:z_ema9_out_of_band(${zEma9})`,
    );
  }

  // ── Pullback geometry: retracement ratio (soft if unavailable) ────────
  // detectSwings needs enough bars; early-session snapshots or fixture
  // tests may not have them, in which case the gate passes through.
  const pbRatio = entryStateVector.pullback_ratio;
  if (pbRatio !== null) {
    if (pbRatio < QUANT_TP_PULLBACK_RATIO_MIN || pbRatio > QUANT_TP_PULLBACK_RATIO_MAX) {
      return buildGeneratorRejection(
        setupType, setupFamily,
        `trend_pullback_long:rejected_by_pullback_geometry:ratio_out_of_band(${pbRatio})`,
      );
    }
  }

  // ── Flow confirmation (soft: null = pass) ─────────────────────────────
  // z_ofi_blend is direction-signed by orderflow-state.ts — positive
  // means flow favors the setup direction. Null during warmup / no LOB.
  const zFlow = entryStateVector.z_ofi_blend;
  if (zFlow !== null && zFlow < QUANT_TP_FLOW_CONFIRMATION_MIN) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      `trend_pullback_long:rejected_by_flow_confirmation:z_ofi_blend_below_threshold(${zFlow})`,
    );
  }

  // ── Volatility-based entry band + stop (replaces ±5 and ema21±20) ────
  const sigma = entryStateVector.sigma_pts;
  const entryHalfBand = sigma * QUANT_TP_ENTRY_HALF_BAND_SIGMA;
  const entryLow = price - entryHalfBand;
  const entryHigh = price + entryHalfBand;
  const entryMid = price;
  const stop = entryMid - sigma * QUANT_TP_K_SL;
  const riskPts = entryMid - stop;
  if (riskPts <= 0) {
    return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_long:non_positive_risk');
  }

  // ── Room-to-upside filter (preserved: 8c85383 normalization path) ────
  if (!hasRoomToUpside(snap, entryMid, 1.0)) {
    return buildGeneratorRejection(
      setupType, setupFamily,
      'trend_pullback_long:rejected_by_room:insufficient_upside_room',
    );
  }

  // ── Targets (unchanged structural math; Phase 4 replaces with cold-start σ targets) ──
  const kl = snap.key_levels;
  const dir: Direction = 'long';
  const t1 = clampTarget(ind.smart_money_choch_sell, entryMid, riskPts, 2, dir);
  const t2 = clampTarget(kl.pivot_resistance[0] ?? null, entryMid, riskPts, 4, dir);

  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);

  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_long:rr_t1_below_structural_floor');
  if (rrt1 <= 0 || rrt2 <= 0) return buildGeneratorRejection(setupType, setupFamily, 'trend_pullback_long:targets_invalid');

  const setup = {
    direction: dir,
    setup_type: setupType,
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
    freshness,
    entry_state_vector: entryStateVector,
  };
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

export function genBreakoutRetestLong(snap: MarketSnapshot, config: IndicatorConfig): GeneratorEvaluation {
  const setupType: SetupType = 'breakout_retest_long';
  const setupFamily: SetupFamily = 'breakout_retest';
  const price = snap.price;
  const ind = snap.indicators_1m;

  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const stDir = ind.supertrend_direction;

  if (stDir !== 'up') return buildGeneratorRejection(setupType, setupFamily, 'breakout_retest_long:supertrend_not_up');
  if (!ema9 || !ema21 || !ema50) return buildGeneratorRejection(setupType, setupFamily, 'breakout_retest_long:ema_stack_missing');
  if (!(price > ema9 && ema9 > ema21 && ema21 > ema50)) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakout_retest_long:ema_stack_not_bullish');
  }

  // ── Fresh uptrend filter ──
  const freshness = isTrendFresh(snap, 'long', config, setupType);
  if (!freshness.fresh) return buildGeneratorRejection(setupType, setupFamily, freshness.reason);

  // Price should be close to EMA9 (within 60pts above)
  const distAboveEma9 = price - ema9;
  if (distAboveEma9 < 0 || distAboveEma9 > 60) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakout_retest_long:not_near_ema9');
  }

  const kl = snap.key_levels;
  const entryLow = ema9 - 10;
  const entryHigh = price + 15;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = ema21 - 25;
  const riskPts = entryMid - stop;
  if (riskPts <= 0) return buildGeneratorRejection(setupType, setupFamily, 'breakout_retest_long:non_positive_risk');

  // ── Room-to-upside filter ──
  if (!hasRoomToUpside(snap, entryMid, 1.0)) {
    return buildGeneratorRejection(setupType, setupFamily, 'breakout_retest_long:insufficient_upside_room');
  }

  const dir: Direction = 'long';
  const resistance = kl.pivot_resistance[0] ?? null;
  if (!resistance) return buildGeneratorRejection(setupType, setupFamily, 'breakout_retest_long:nearest_resistance_missing');
  const t1 = clampTarget(resistance, entryMid, riskPts, 2, dir);
  const t2 = clampTarget(kl.pivot_resistance[1] ?? null, entryMid, riskPts, 4, dir);
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return buildGeneratorRejection(setupType, setupFamily, 'breakout_retest_long:rr_t1_below_structural_floor');
  if (rrt1 <= 0 || rrt2 <= 0) return buildGeneratorRejection(setupType, setupFamily, 'breakout_retest_long:targets_invalid');

  const setup = {
    direction: dir,
    setup_type: setupType,
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
    freshness,
  };
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

// ─── NQ-specific setup generators ────────────────────────────────────────────

/**
 * Opening-drive continuation long: RTH opening range is being broken to the
 * upside and the drive has momentum (higher lows, close above OR_high on the
 * last closed 1m bar).
 */
export function genOpeningDriveContinuationLong(snap: MarketSnapshot): GeneratorEvaluation {
  const setupType: SetupType = 'opening_drive_continuation_long';
  const setupFamily: SetupFamily = 'opening_drive';
  const kl = snap.key_levels;
  const session = snap.session;
  if (!session?.is_rth) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_long:not_rth');
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh === null || orLow === null) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_long:opening_range_missing');
  if (snap.price <= orHigh) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_long:not_above_or_high');
  // Require last CLOSED 1m bar to close above OR high
  const closed = snap.bars_1m.length >= 2 ? snap.bars_1m[snap.bars_1m.length - 2] : undefined;
  if (!closed || closed.close <= orHigh) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_long:last_closed_not_above_or_high');

  const entryLow = orHigh;
  const entryHigh = snap.price + (orHigh - orLow) * 0.1;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = orLow; // failure of the opening range
  const riskPts = entryMid - stop;
  if (riskPts <= 0) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_long:non_positive_risk');

  const dir: Direction = 'long';
  const orRange = orHigh - orLow;
  const t1 = entryMid + orRange; // 1× OR projection
  const t2 = entryMid + orRange * 1.75;
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_long:rr_t1_below_structural_floor');

  const setup = {
    direction: dir,
    setup_type: setupType,
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
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

export function genOpeningDriveContinuationShort(snap: MarketSnapshot): GeneratorEvaluation {
  const setupType: SetupType = 'opening_drive_continuation_short';
  const setupFamily: SetupFamily = 'opening_drive';
  const kl = snap.key_levels;
  const session = snap.session;
  if (!session?.is_rth) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_short:not_rth');
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh === null || orLow === null) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_short:opening_range_missing');
  if (snap.price >= orLow) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_short:not_below_or_low');
  const closed = snap.bars_1m.length >= 2 ? snap.bars_1m[snap.bars_1m.length - 2] : undefined;
  if (!closed || closed.close >= orLow) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_short:last_closed_not_below_or_low');

  const entryHigh = orLow;
  const entryLow = snap.price - (orHigh - orLow) * 0.1;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = orHigh;
  const riskPts = stop - entryMid;
  if (riskPts <= 0) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_short:non_positive_risk');

  const dir: Direction = 'short';
  const orRange = orHigh - orLow;
  const t1 = entryMid - orRange;
  const t2 = entryMid - orRange * 1.75;
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return buildGeneratorRejection(setupType, setupFamily, 'opening_drive_continuation_short:rr_t1_below_structural_floor');

  const setup = {
    direction: dir,
    setup_type: setupType,
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
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

/**
 * Failed opening-range break: price broke above OR_high, then failed back
 * inside the range. Fade short with stop above the failure high.
 */
export function genFailedOrBreakShort(snap: MarketSnapshot): GeneratorEvaluation {
  const setupType: SetupType = 'failed_or_break_short';
  const setupFamily: SetupFamily = 'failed_or_break';
  const kl = snap.key_levels;
  const session = snap.session;
  if (!session?.is_rth) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_short:not_rth');
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh === null || orLow === null) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_short:opening_range_missing');

  // Need a recent bar that poked above OR_high but price is now back below
  if (snap.price >= orHigh) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_short:not_back_below_or_high');
  const recent = snap.bars_1m.slice(-6);
  if (recent.length < 3) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_short:insufficient_recent_bars');
  const maxHigh = Math.max(...recent.map(b => b.high));
  if (maxHigh <= orHigh) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_short:no_failed_break_sweep');
  // last closed bar must have closed back inside
  const closed = snap.bars_1m[snap.bars_1m.length - 2];
  if (!closed || closed.close >= orHigh) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_short:last_closed_not_back_inside_range');

  const entryHigh = orHigh;
  const entryLow = snap.price;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = maxHigh; // above the failed high
  const riskPts = stop - entryMid;
  if (riskPts <= 0) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_short:non_positive_risk');

  const dir: Direction = 'short';
  const t1 = (orHigh + orLow) / 2;
  const t2 = orLow;
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_short:rr_t1_below_structural_floor');

  const setup = {
    direction: dir,
    setup_type: setupType,
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
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

export function genFailedOrBreakLong(snap: MarketSnapshot): GeneratorEvaluation {
  const setupType: SetupType = 'failed_or_break_long';
  const setupFamily: SetupFamily = 'failed_or_break';
  const kl = snap.key_levels;
  const session = snap.session;
  if (!session?.is_rth) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_long:not_rth');
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh === null || orLow === null) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_long:opening_range_missing');
  if (snap.price <= orLow) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_long:not_back_above_or_low');
  const recent = snap.bars_1m.slice(-6);
  if (recent.length < 3) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_long:insufficient_recent_bars');
  const minLow = Math.min(...recent.map(b => b.low));
  if (minLow >= orLow) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_long:no_failed_breakdown_sweep');
  const closed = snap.bars_1m[snap.bars_1m.length - 2];
  if (!closed || closed.close <= orLow) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_long:last_closed_not_back_inside_range');

  const entryLow = orLow;
  const entryHigh = snap.price;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = minLow;
  const riskPts = entryMid - stop;
  if (riskPts <= 0) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_long:non_positive_risk');

  const dir: Direction = 'long';
  const t1 = (orHigh + orLow) / 2;
  const t2 = orHigh;
  const rrt1 = computeRr(t1, entryMid, riskPts, dir);
  const rrt2 = computeRr(t2, entryMid, riskPts, dir);
  // Structural sanity floor (1.0R). Policy-level RR gating via dynamic reward plan.
  if (rrt1 < 1.0) return buildGeneratorRejection(setupType, setupFamily, 'failed_or_break_long:rr_t1_below_structural_floor');

  const setup = {
    direction: dir,
    setup_type: setupType,
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
  return withSetupCandidate(setupType, setupFamily, { ...setup, ...validateSetupTargets(setup) });
}

// ─── Strategy Registry ──────────────────────────────────────────────────────
//
// Canonical list of strategies with metadata. The registry lives here
// (alongside the generator functions) rather than in strategy-registry.ts
// because generator references must be bound at module init without
// creating a circular import. Types/helpers are in strategy-registry.ts.

import type { StrategyDefinition } from './strategy-registry.js';
import {
  effectiveStatus,
  listRunnableStrategies,
} from './strategy-registry.js';
import {
  generateLobMboScalpLong,
  generateLobMboScalpShort,
} from './strategies/lob-mbo-scalp.js';

export const STRATEGY_REGISTRY: ReadonlyArray<StrategyDefinition> = [
  {
    strategy_id: 'trend_pullback_long',
    family: 'trend_pullback',
    direction: 'long',
    status: 'active',
    entry_model: null,
    score_profile: 'trend_continuation',
    hard_gates: [
      'supertrend_up', 'bullish_ema_stack', 'fresh_uptrend',
      'within_80pts_of_ema9', 'upside_room', 'rr_gte_1',
    ],
    generator: (snap, config) => genTrendPullbackLong(snap, config),
  },
  {
    strategy_id: 'trend_pullback_short',
    family: 'trend_pullback',
    direction: 'short',
    status: 'active',
    entry_model: null,
    score_profile: 'trend_continuation',
    hard_gates: [
      'supertrend_down', 'bearish_ema_stack', 'fresh_downtrend',
      'within_80pts_of_ema9', 'downside_room', 'rr_gte_1',
    ],
    generator: (snap, config) => genTrendPullbackShort(snap, config),
  },
  {
    strategy_id: 'breakout_retest_long',
    family: 'breakout_retest',
    direction: 'long',
    status: 'active',
    entry_model: null,
    score_profile: 'breakout_continuation',
    hard_gates: [
      'supertrend_up', 'bullish_ema_stack', 'fresh_uptrend',
      'within_60pts_of_ema9', 'upside_room', 'pivot_resistance_exists', 'rr_gte_1',
    ],
    generator: (snap, config) => genBreakoutRetestLong(snap, config),
    non_primary_baseline: true,
  },
  {
    strategy_id: 'breakdown_retest_short',
    family: 'breakout_retest',
    direction: 'short',
    status: 'active',
    entry_model: null,
    score_profile: 'breakout_continuation',
    hard_gates: [
      'resistance_zone_exists', 'price_below_zone', 'within_250pts',
      'above_choch_buy', 'rr_gte_1',
    ],
    generator: (snap, _config) => genBreakdownRetestShort(snap),
    non_primary_baseline: true,
  },
  {
    strategy_id: 'post_flip_first_pullback_short',
    family: 'trend_pullback',
    direction: 'short',
    status: 'shadow',
    entry_model: null,
    score_profile: 'reversal_reclaim',
    hard_gates: [
      'eth_session_only', 'reversal_bundle_passed',
      'bearish_ema_formation', 'vwap_dist_ok', 'retest_dist_ok',
      'impulse_under_2_8_atr', 'downside_room',
    ],
    generator: (snap, config) => genPostFlipFirstPullbackShort(snap, config),
    notes: 'ETH reversal — needs more volume before re-activation',
  },
  {
    strategy_id: 'opening_drive_continuation_long',
    family: 'opening_drive',
    direction: 'long',
    status: 'shadow',
    entry_model: null,
    score_profile: 'session_structure',
    hard_gates: [
      'rth_session', 'or_high_exists', 'price_above_or_high',
      'last_bar_closes_above', 'rr_gte_1',
    ],
    generator: (snap, _config) => genOpeningDriveContinuationLong(snap),
    notes: 'RTH-only, insufficient sample',
  },
  {
    strategy_id: 'opening_drive_continuation_short',
    family: 'opening_drive',
    direction: 'short',
    status: 'shadow',
    entry_model: null,
    score_profile: 'session_structure',
    hard_gates: [
      'rth_session', 'or_low_exists', 'price_below_or_low',
      'last_bar_closes_below', 'rr_gte_1',
    ],
    generator: (snap, _config) => genOpeningDriveContinuationShort(snap),
    notes: 'RTH-only, insufficient sample',
  },
  {
    strategy_id: 'failed_or_break_long',
    family: 'failed_or_break',
    direction: 'long',
    status: 'shadow',
    entry_model: null,
    score_profile: 'reversal_reclaim',
    hard_gates: [
      'rth_session', 'or_low_exists', 'price_above_or_low',
      'recent_sweep_below', 'last_bar_closes_above_or_low', 'rr_gte_1',
    ],
    generator: (snap, _config) => genFailedOrBreakLong(snap),
    notes: 'RTH-only, insufficient sample',
  },
  {
    strategy_id: 'failed_or_break_short',
    family: 'failed_or_break',
    direction: 'short',
    status: 'shadow',
    entry_model: null,
    score_profile: 'reversal_reclaim',
    hard_gates: [
      'rth_session', 'or_high_exists', 'price_below_or_high',
      'recent_sweep_above', 'last_bar_closes_below_or_high', 'rr_gte_1',
    ],
    generator: (snap, _config) => genFailedOrBreakShort(snap),
    notes: 'RTH-only, insufficient sample',
  },
  {
    strategy_id: 'momentum_continuation',
    family: 'momentum_continuation',
    direction: 'short',
    status: 'shadow',
    entry_model: null,
    score_profile: 'breakout_continuation',
    hard_gates: [
      'choch_buy_exists', 'price_below_choch_buy',
      'dist_20_100pts', 'last_bar_closes_below', 'rr_gte_1',
    ],
    generator: (snap, _config) => genBreakdownMomentumShort(snap),
    notes: 'previously gated off by default via enable_momentum_continuation=false',
  },
  // ── lob_mbo_scalp family (Phase 3b: real generator wired, status still shadow) ──
  //
  // The generator lives in src/autotrade/strategies/lob-mbo-scalp.ts and
  // runs the full deterministic + persistence gate chain against the
  // LobSnapshot passed through from generateSignal(). Phase 4 (writer +
  // ML) and Phase 5 (expectancy) are placeholder-rejected — every cycle
  // returns candidate: null with a structured reject reason visible in
  // telemetry. Registry status stays 'shadow' so isExecutable() blocks
  // the family from live execution until Phase 8 promotion.
  //
  // `getSetupFamily()` in features/microstructure-score.ts still falls
  // through to its 'trend_continuation' default for these IDs — that is
  // harmless because the generator never returns a candidate that could
  // be scored. A dedicated scoring branch lands in the next Phase 3
  // task.
  {
    strategy_id: 'lob_mbo_scalp_long',
    family: 'lob_mbo_scalp',
    direction: 'long',
    status: 'shadow',
    entry_model: null,
    score_profile: 'scalp_high_frequency',
    hard_gates: [
      'scalp_quality_ok', 'spread_ok', 'persistence_ok',
      'ev_positive', 'microstructure_score_ok',
    ],
    generator: (snap, config, lobSnapshot) =>
      generateLobMboScalpLong(snap, config, lobSnapshot) as GeneratorEvaluation,
    notes: 'Phase 3b minimal — deterministic + persistence gates live; Phase 4/5 placeholder-rejected',
  },
  {
    strategy_id: 'lob_mbo_scalp_short',
    family: 'lob_mbo_scalp',
    direction: 'short',
    status: 'shadow',
    entry_model: null,
    score_profile: 'scalp_high_frequency',
    hard_gates: [
      'scalp_quality_ok', 'spread_ok', 'persistence_ok',
      'ev_positive', 'microstructure_score_ok',
    ],
    generator: (snap, config, lobSnapshot) =>
      generateLobMboScalpShort(snap, config, lobSnapshot) as GeneratorEvaluation,
    notes: 'Phase 3b minimal — deterministic + persistence gates live; Phase 4/5 placeholder-rejected',
  },
];

/** Cached lookup. */
const STRATEGY_BY_ID = new Map<SetupType, StrategyDefinition>(
  STRATEGY_REGISTRY.map((s) => [s.strategy_id, s]),
);

export function getStrategyDefinition(id: SetupType): StrategyDefinition | undefined {
  return STRATEGY_BY_ID.get(id);
}

/** Resolved effective status for a given setup id, honouring config soft overrides. */
export function getStrategyEffectiveStatus(id: SetupType, config: IndicatorConfig): 'active' | 'shadow' | 'disabled' | 'deprecated' {
  const def = STRATEGY_BY_ID.get(id);
  if (!def) return 'disabled';
  return effectiveStatus(def, config);
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
  htf_conflict_transition_relief: 0.35,
  reversal_transition_bonus: 0.2,
  contextual_positive_cap: 0.5,
  reversal_bonus_peak_bars_since_flip: 7,
  reversal_bonus_sigma_bars: 3,
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
  htfEval?: HtfSetupEvaluation | null,
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

  // HTF zone veto (when evaluated)
  if (htfEval?.vetoed && htfEval.veto_reason) {
    failures.push(htfEval.veto_reason);
  }

  return failures;
}

function applyContextualScoreAdjustments(
  setup: CandidateSetup,
  breakdown: ScoreBreakdown,
  snap: MarketSnapshot,
  bias: MultiTfBias,
  regime: MarketRegime,
  config: IndicatorConfig,
): {
  scorePreContext: number;
  scorePostContext: number;
  vwapSoftPenalty: number;
  htfConflictRelief: number;
  reversalTransitionBonus: number;
  contextualPositiveCapApplied: number;
  attributionFlags: string[];
} {
  const weights = resolveScoringWeights(config);
  const scorePreContext = breakdown.total;
  const attributionFlags: string[] = [];
  const vwapSoftPenalty = Math.min(0, setup.freshness?.soft_penalty ?? 0);
  if (vwapSoftPenalty !== 0) {
    attributionFlags.push('VWAP soft survival');
  }

  const eligibleEthShortReversalSetup =
    getSessionLabel(snap) === 'ETH'
    && setup.direction === 'short'
    && (setup.setup_type === 'trend_pullback_short' || setup.setup_type === 'post_flip_first_pullback_short');

  let htfConflictRelief = 0;
  if (
    eligibleEthShortReversalSetup
    && breakdown.htf_direction < 0
    && bias['1m'] === 'bearish'
    && bias['5m'] === 'bearish'
    && bias['15m'] === 'neutral'
    && (regime === 'trending_down' || regime === 'breakdown_attempt')
  ) {
    htfConflictRelief = weights.htf_conflict_transition_relief;
    attributionFlags.push('HTF conflict relief');
  }

  let reversalTransitionBonus = 0;
  if (eligibleEthShortReversalSetup && setup.setup_type === 'post_flip_first_pullback_short') {
    reversalTransitionBonus = computeShapedReversalBonus(setup.bars_since_flip ?? null, weights);
    if (reversalTransitionBonus > 0) {
      attributionFlags.push('reversal transition bonus');
      attributionFlags.push('post_flip_first_pullback_short');
    }
  }

  const contextualPositiveCapApplied = Math.min(
    htfConflictRelief + reversalTransitionBonus,
    weights.contextual_positive_cap,
  );
  const scorePostContext = Math.max(
    0,
    Math.min(10, Math.round((scorePreContext + vwapSoftPenalty + contextualPositiveCapApplied) * 100) / 100),
  );

  return {
    scorePreContext,
    scorePostContext,
    vwapSoftPenalty,
    htfConflictRelief,
    reversalTransitionBonus,
    contextualPositiveCapApplied,
    attributionFlags,
  };
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
): {
  decision: DualDirectionDecision;
  chosen: DirectionalCandidate | null;
  opposing: DirectionalCandidate | null;
  reason: string;
  margin: number;
  selection_only?: boolean;
  decision_reason_primary?: string;
  execution_allowed_final?: boolean;
} {
  let requiredMargin = config.dual_score_margin;

  // Extra margin in choppy/HVI regimes
  if (regime === 'choppy' || regime === 'high_volatility_impulse') {
    requiredMargin += config.dual_choppy_extra_margin;
  }

  const executionFloor = resolveExecutionFloor(config);

  const longValid = bestLong?.passedHardGates === true;
  const shortValid = bestShort?.passedHardGates === true;
  const longScore = bestLong?.score ?? 0;
  const shortScore = bestShort?.score ?? 0;
  // Selection floor (per-session/direction/setup override, can be below exec floor)
  const longMinScore = bestLong?.min_score_threshold ?? executionFloor;
  const shortMinScore = bestShort?.min_score_threshold ?? executionFloor;

  /**
   * Demote an `enter_*` intent to `wait_below_execution_floor` when the
   * winning score cleared the selection floor but not the execution floor.
   * The candidate is still returned as `chosen` so replay/logging can see
   * which setup would have fired; the `selection_only` flag distinguishes
   * it from a real execution.
   */
  function demoteIfBelowExecutionFloor(
    intent: 'enter_long' | 'enter_short',
    chosenSide: DirectionalCandidate,
    opposingSide: DirectionalCandidate | null,
    reason: string,
    margin: number,
  ): ReturnType<typeof compareSides> {
    if (chosenSide.score >= executionFloor) {
      return {
        decision: intent,
        chosen: chosenSide,
        opposing: opposingSide,
        reason,
        margin,
        selection_only: false,
        execution_allowed_final: true,
      };
    }
    return {
      decision: 'wait_below_execution_floor',
      chosen: chosenSide,
      opposing: opposingSide,
      reason: `${reason} — demoted: score ${chosenSide.score} < execution floor ${executionFloor}`,
      margin,
      selection_only: true,
      decision_reason_primary: 'below_execution_floor',
      execution_allowed_final: false,
    };
  }

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
    if (longScore >= longMinScore) {
      return demoteIfBelowExecutionFloor(
        'enter_long',
        bestLong!,
        bestShort,
        `Long valid (${longScore}) >= minScore (${longMinScore}), short failed gates`,
        longScore - shortScore,
      );
    }
    return { decision: 'wait_below_min_score', chosen: null, opposing: null, reason: `Long valid but score ${longScore} < minScore ${longMinScore}`, margin: 0 };
  }

  if (shortValid && !longValid) {
    if (shortScore >= shortMinScore) {
      return demoteIfBelowExecutionFloor(
        'enter_short',
        bestShort!,
        bestLong,
        `Short valid (${shortScore}) >= minScore (${shortMinScore}), long failed gates`,
        shortScore - longScore,
      );
    }
    return { decision: 'wait_below_min_score', chosen: null, opposing: null, reason: `Short valid but score ${shortScore} < minScore ${shortMinScore}`, margin: 0 };
  }

  // Both valid — compare with margin
  const margin = Math.abs(longScore - shortScore);
  const marginFormatted = Math.round(margin * 10) / 10;

  if (longScore >= longMinScore && longScore > shortScore && margin >= requiredMargin) {
    return demoteIfBelowExecutionFloor(
      'enter_long',
      bestLong!,
      bestShort,
      `Long wins: ${longScore} vs ${shortScore} (margin ${marginFormatted} >= ${requiredMargin})`,
      margin,
    );
  }

  if (shortScore >= shortMinScore && shortScore > longScore && margin >= requiredMargin) {
    return demoteIfBelowExecutionFloor(
      'enter_short',
      bestShort!,
      bestLong,
      `Short wins: ${shortScore} vs ${longScore} (margin ${marginFormatted} >= ${requiredMargin})`,
      margin,
    );
  }

  // Both valid but neither has enough margin or score
  if (longScore < longMinScore && shortScore < shortMinScore) {
    return { decision: 'wait_both_weak', chosen: null, opposing: null, reason: `Both below minScore: long=${longScore}/${longMinScore} short=${shortScore}/${shortMinScore}`, margin };
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
  chosenCandidate?: DirectionalCandidate | null,
): SignalContextSnapshot {
  const price = snap.price;
  const ind = snap.indicators_1m;
  const kl = snap.key_levels;
  const htf = snap.htf_context;
  const htfEval = chosenCandidate?.htfEval;

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
    // HTF zone context (market-neutral)
    htf_study_present: htf?.study_present ?? null,
    htf_inside_resistance: htf?.inside_resistance_zone ?? null,
    htf_inside_support: htf?.inside_support_zone ?? null,
    htf_nearest_res_tf: htf?.nearest_resistance?.timeframe ?? null,
    htf_nearest_sup_tf: htf?.nearest_support?.timeframe ?? null,
    htf_nearest_obstacle_tf: htfEval?.nearest_obstacle?.timeframe ?? null,
    htf_nearest_obstacle_kind: htfEval?.nearest_obstacle?.kind ?? null,
    htf_distance_res_pts: htf?.nearest_resistance?.distance_pts ?? null,
    htf_distance_sup_pts: htf?.nearest_support?.distance_pts ?? null,
    htf_distance_res_atr: htf?.nearest_resistance?.distance_atr ?? null,
    htf_distance_sup_atr: htf?.nearest_support?.distance_atr ?? null,
    // HTF candidate-specific evaluation
    htf_first_obstacle_rr: htfEval?.first_obstacle_rr ?? null,
    htf_location_quality: htfEval?.location_quality ?? null,
    htf_veto_reason: htfEval?.veto_reason ?? null,
    htf_breakout_accepted: htfEval?.breakout_accepted ?? null,
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
  lobSnapshot?: LobSnapshot | null,
  expectancyTable?: ExpectancyBucketTable | null,
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
  // Both active and shadow strategies run. Shadow strategies are fully
  // scored and ranked so their candidates are comparable in the Phase 6
  // calibration report. The final execution-eligibility gate lives in
  // runner.ts — see src/autotrade/strategy-registry.ts for semantics.
  const runnable = listRunnableStrategies(STRATEGY_REGISTRY, config);
  // Note: lobSnapshot is captured from the generateSignal() scope so trend
  // generators can safely ignore it (their 2-arg sigs are assignable to the
  // 3-arg type) while the lob_mbo_scalp family reads it as the primary
  // input. See strategies/lob-mbo-scalp.ts for the scalper consumer.
  const generators: Array<(s: MarketSnapshot) => GeneratorEvaluation> =
    runnable.map((def) => (s) => def.generator(s, config, lobSnapshot ?? null) as GeneratorEvaluation);

  // Track candidates alongside their pre-computed score breakdowns so we
  // never call scoreConfidenceDetailed() twice for the same candidate.
  type ScoredCandidate = {
    setup: CandidateSetup;
    breakdown: ScoreBreakdown;
    layered?: LayeredScoreResult;
    htfEval?: HtfSetupEvaluation | null;
    scorePreContext: number;
    scorePostContext: number;
    vwapSoftPenalty: number;
    htfConflictRelief: number;
    reversalTransitionBonus: number;
    contextualPositiveCapApplied: number;
    layeredPreContextTotal: number | null;
    layeredPostContextTotal: number | null;
    attributionFlags: string[];
  };
  const longCandidates: ScoredCandidate[] = [];
  const shortCandidates: ScoredCandidate[] = [];
  const generatorDiagnostics: CandidateGeneratorDiagnostic[] = [];

  // Resolve layered scoring config
  const lsConfig: LayeredScoringConfig = config.layered_scoring
    ? { ...DEFAULT_LAYERED_SCORING_CONFIG, ...config.layered_scoring }
    : DEFAULT_LAYERED_SCORING_CONFIG;
  const layeredActive = lsConfig.enabled || lsConfig.shadow_log;

  for (const gen of generators) {
    const evaluation = gen(snap);
    generatorDiagnostics.push({
      setup_type: evaluation.setupType,
      setup_family: evaluation.setupFamily,
      accepted: evaluation.candidate !== null,
      rejection_reason_primary: evaluation.rejectionReasonPrimary,
      rejection_reason_all: evaluation.rejectionReasonAll,
    });

    const s = evaluation.candidate;
    if (s) {
      // Tick-round before scoring (rr may change after rounding)
      if (contract) tickRoundCandidate(s, contract);

      // Phase 2 of the quant refactor: hydrate the Phase-1-built
      // EntryStateVector with orderflow fields derived from the current
      // LOB snapshot. Only trend_pullback_* setups carry a vector right
      // now (Phase 1 wiring) — guarding on the vector presence keeps
      // non-quant strategies untouched and keeps the lobSnapshot null
      // path a pure no-op.
      if (
        s.entry_state_vector &&
        (s.setup_type === 'trend_pullback_long' || s.setup_type === 'trend_pullback_short')
      ) {
        hydrateEntryStateVectorOrderflow(
          s.entry_state_vector,
          snap,
          lobSnapshot ?? null,
          s.direction as 'long' | 'short',
        );
      }

      // Phase 4 + 6: populate the parallel quant reward contract
      // (stop_quant / target_1_quant / target_2_quant / risk_pts_quant
      // / rr_t1_quant / rr_t2_quant / bucket_source_quant) AND the
      // Phase 6 expectancy fields (expected_r_30s_quant /
      // win_prob_30s_quant / quality_band_quant / bucket_id_quant /
      // bucket_sample_count_quant / quant_shadow_reject_reason).
      // Runs AFTER tickRoundCandidate so entry mid is tick-aligned
      // before the quant formulas consume it. Legacy fields
      // (stop / target_* / rr_* / risk_pts) are never touched — plan
      // §3 no-overwrite rule. The expectancy table is optional: when
      // null the engine returns null fields and the candidate still
      // ships with Phase 4 cold-start metadata.
      if (
        contract &&
        s.entry_state_vector &&
        (s.setup_type === 'trend_pullback_long' || s.setup_type === 'trend_pullback_short')
      ) {
        // Resolve the quant config once so Phase 8 thresholds (loaded
        // from `quant_entry.expectancy.*`) flow through to the engine.
        // When quant_entry is absent, defaults make the primary gate a
        // no-op — Phase 8 Stage A calibrates the real threshold from
        // shadow data before turning on `hybrid_gate`.
        const quantCfgForHydration = resolveQuantEntryConfig(config.quant_entry);
        hydrateQuantRewardContract(s, snap, contract, expectancyTable ?? null, quantCfgForHydration);
      }

      // ── Phase 7 Stage A telemetry ──────────────────────────────────
      //
      // When `quant_entry.enabled = true` (and the per-side flag is
      // on), attach:
      //   (a) entry_state_vector_hash — canonical reproducibility tag
      //   (b) quant_shadow_decision   — per-gate verdicts + combined
      //                                 AND-gate result (Phase 7 only
      //                                 records it; runner.ts decides
      //                                 whether to act on it based on
      //                                 hybrid_gate in Stage B).
      //
      // When the flag is off, both fields stay `undefined` and the
      // logs remain diff-free versus the post-Phase-6 baseline.
      //
      // entry_ml verdict is NOT yet known at this point (runner.ts
      // runs entry_ml after generateSignal returns). Phase 7 seeds
      // the decision with entry_ml status `no_data`; the runner
      // rebuilds the decision after entry_ml produces its verdict.
      const quantCfg = resolveQuantEntryConfig(config.quant_entry);
      if (
        quantCfg.enabled &&
        s.entry_state_vector &&
        (s.setup_type === 'trend_pullback_long' || s.setup_type === 'trend_pullback_short') &&
        isQuantEntryActiveForDirection(quantCfg, s.direction as 'long' | 'short')
      ) {
        s.entry_state_vector_hash = computeEntryStateVectorHash(s.entry_state_vector);
        const direction = s.direction as 'long' | 'short';
        const entryMlStub: EntryMlVerdictSource = {
          disabled: false,
          confirmed: false,
          no_data: true,
          reason: null,
        };
        s.quant_shadow_decision = buildQuantShadowDecision({
          setup: s,
          direction,
          quantConfig: quantCfg,
          entryMl: entryMlStub,
        });
      }

      // Score ONCE — breakdown is stored and reused downstream
      const w = resolveScoringWeights(config);
      let breakdown: ScoreBreakdown;
      let layeredResult: LayeredScoreResult | undefined;

      if (lsConfig.enabled) {
        // Layered scoring is primary — compute layered, map to legacy breakdown
        layeredResult = computeLayeredScore(s, snap, bias, regime, config, w, lobSnapshot, lsConfig);
        breakdown = layeredToLegacyBreakdown(layeredResult, w.base);
      } else {
        // Old flat scoring is primary
        breakdown = scoreConfidenceDetailed(s, snap, bias, regime, config);

        // Shadow mode: also compute layered score for comparison logging
        if (lsConfig.shadow_log && layeredActive) {
          layeredResult = computeLayeredScore(s, snap, bias, regime, config, w, lobSnapshot, lsConfig);

          console.log(
            `[LAYERED_SHADOW] ${s.direction.toUpperCase()} ${s.setup_type} ` +
            `old_score=${breakdown.total} new_rank=${layeredResult.final_rank} ` +
            `structure=${layeredResult.structure_score.toFixed(1)} ` +
            `flow=${layeredResult.flow_score.toFixed(1)}(q=${layeredResult.flow_breakdown.data_quality}) ` +
            `lagging=${layeredResult.lagging_adjustment > 0 ? '+' : ''}${layeredResult.lagging_adjustment.toFixed(2)} ` +
            `profile=${layeredResult.setup_family}(s=${layeredResult.profile_used.structure_weight},f=${layeredResult.flow_breakdown.effective_weight}) ` +
            `${layeredResult.missing_flow_policy_applied ? 'MISSING_FLOW ' : ''}` +
            `trend_cap=${layeredResult.structure_breakdown.trend_cluster_raw.toFixed(2)}->${layeredResult.structure_breakdown.trend_cluster_capped.toFixed(2)} ` +
            `flow_features=[${layeredResult.flow_breakdown.active_flow_features.join(',')}] ` +
            `flow_degradation=[${layeredResult.flow_breakdown.quality_degradation_reasons.join(',')}]`,
          );
        }
      }

      const htfConfig = config.htf_zones ?? DEFAULT_HTF_ZONES_CONFIG;
      const htfEval = snap.htf_context?.study_present
        ? evaluateHtfForSetup(snap.htf_context, s, snap, htfConfig)
        : null;
      if (htfEval && htfEval.score_adjustment !== 0) {
        breakdown.total = Math.max(0, Math.min(10, breakdown.total + htfEval.score_adjustment));
      }

      const contextual = applyContextualScoreAdjustments(s, breakdown, snap, bias, regime, config);
      breakdown.pre_context_total = contextual.scorePreContext;
      breakdown.vwap_soft_penalty = contextual.vwapSoftPenalty;
      breakdown.htf_conflict_relief = contextual.htfConflictRelief;
      breakdown.reversal_transition_bonus = contextual.reversalTransitionBonus;
      breakdown.contextual_positive_cap_applied = contextual.contextualPositiveCapApplied;
      breakdown.total = contextual.scorePostContext;

      if (contextual.vwapSoftPenalty !== 0) {
        breakdown.factors.push(`vwap_soft_penalty(${contextual.vwapSoftPenalty})`);
      }
      if (contextual.htfConflictRelief !== 0) {
        breakdown.factors.push(`htf_conflict_relief(+${contextual.htfConflictRelief})`);
      }
      if (contextual.reversalTransitionBonus !== 0) {
        breakdown.factors.push(`reversal_transition_bonus(+${contextual.reversalTransitionBonus})`);
      }

      const layeredPreContextTotal = layeredResult
        ? Math.max(0, Math.min(10, layeredResult.final_rank + (htfEval?.score_adjustment ?? 0)))
        : null;
      const layeredPostContextTotal = layeredPreContextTotal === null
        ? null
        : Math.max(0, Math.min(10, Math.round((layeredPreContextTotal + contextual.vwapSoftPenalty + contextual.contextualPositiveCapApplied) * 100) / 100));

      s.confidence = contextual.scorePostContext;
      s.confidence_factors = breakdown.factors;

      console.log(
        `[CONFIDENCE] ${s.direction.toUpperCase()} ${s.setup_type} ` +
        `raw=${contextual.scorePreContext} adjusted=${breakdown.total} factors=[${breakdown.factors.join(', ')}]`,
      );

      const entry = {
        setup: s,
        breakdown,
        layered: layeredResult,
        htfEval,
        scorePreContext: contextual.scorePreContext,
        scorePostContext: contextual.scorePostContext,
        vwapSoftPenalty: contextual.vwapSoftPenalty,
        htfConflictRelief: contextual.htfConflictRelief,
        reversalTransitionBonus: contextual.reversalTransitionBonus,
        contextualPositiveCapApplied: contextual.contextualPositiveCapApplied,
        layeredPreContextTotal,
        layeredPostContextTotal,
        attributionFlags: contextual.attributionFlags,
      };
      if (s.direction === 'long') {
        longCandidates.push(entry);
      } else {
        shortCandidates.push(entry);
      }
    }
  }

  // ── Step 2: Pick best per side ───────────────────────────────────────────
  longCandidates.sort((a, b) => b.setup.confidence - a.setup.confidence);
  shortCandidates.sort((a, b) => b.setup.confidence - a.setup.confidence);

  function buildDirectionalCandidate(scored: ScoredCandidate | undefined): DirectionalCandidate | null {
    if (!scored) return null;
    const { setup, breakdown, layered } = scored;

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

    // HTF zone evaluation (candidate-specific)
    const htfConfig = config.htf_zones ?? DEFAULT_HTF_ZONES_CONFIG;
    const htfEval = snap.htf_context?.study_present
      ? evaluateHtfForSetup(snap.htf_context, setup, snap, htfConfig)
      : null;

    // Apply HTF score adjustment to confidence
    let adjustedScore = setup.confidence;
    if (htfEval && htfEval.score_adjustment !== 0) {
      adjustedScore = Math.max(0, Math.min(10, adjustedScore + htfEval.score_adjustment));
    }

    // Reuse the pre-computed breakdown — no second scoreConfidenceDetailed() call
    const gates = applyHardGates(setup, adjustedScore, bias, regime, snap, config, rewardPlan, htfEval);
    const minScoreThreshold = resolveSelectionFloor(setup, snap, config);
    return {
      setup,
      score: adjustedScore,
      scoreBreakdown: breakdown,
      hardGateFailures: gates,
      passedHardGates: gates.length === 0,
      min_score_threshold: minScoreThreshold,
      rewardPlan,
      layered,
      htfEval,
    };
  }

  const bestLong = buildDirectionalCandidate(longCandidates[0]);
  const bestShort = buildDirectionalCandidate(shortCandidates[0]);

  // ── Step 3: Dual-direction decision ──────────────────────────────────────
  const comparison = compareSides(bestLong, bestShort, regime, config);
  const { decision, chosen, opposing, reason, margin } = comparison;
  const selectionOnly = comparison.selection_only === true;
  const decisionReasonPrimary = comparison.decision_reason_primary;
  const executionAllowedFinal = comparison.execution_allowed_final;

  printDualDirectionSummary(bestLong, bestShort, decision, reason, margin, longCandidates.length, shortCandidates.length);

  // ── Step 4: Build skip reasons for backward compat ───────────────────────
  const skipReasons: string[] = [];
  // Selection-only candidates still populate `bestSetup` so the runner's
  // candidate log, extension features and diagnostics all run as normal. The
  // `below_execution_floor` skip reason below forces `tradeAllowed = false`
  // so the candidate is logged but never executed.
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
    if (selectionOnly) {
      // Candidate is logged/forwarded but blocked from execution.
      skipReasons.push(`below_execution_floor:score_${chosenScore}_<_${config.dual_min_score}`);
    }
    // Chosen side passed hard gates, but still apply min_confidence from legacy config
    if (chosenScore < config.min_confidence) {
      skipReasons.push(`confidence_${chosenScore}_below_threshold_${config.min_confidence}`);
    }
  }

  const tradeAllowed = skipReasons.length === 0 && bestSetup !== null;
  const rejectionsBySetup: Record<string, string[]> = {};
  const rejectionCounts = new Map<string, number>();
  let countRejectionsThisCycle = 0;
  for (const diag of generatorDiagnostics) {
    if (diag.rejection_reason_all.length > 0) {
      rejectionsBySetup[diag.setup_type] = [...diag.rejection_reason_all];
    }
    if (!diag.accepted) {
      countRejectionsThisCycle += 1;
    }
    if (diag.rejection_reason_primary) {
      rejectionCounts.set(
        diag.rejection_reason_primary,
        (rejectionCounts.get(diag.rejection_reason_primary) ?? 0) + 1,
      );
    }
  }
  let topRejectionReason: string | null = null;
  let topRejectionCount = -1;
  for (const [reasonKey, count] of rejectionCounts.entries()) {
    if (count > topRejectionCount) {
      topRejectionReason = reasonKey;
      topRejectionCount = count;
    }
  }

  // ── Step 5: ML features ──────────────────────────────────────────────────
  const mlFeatures = buildMlFeatures(snap, bias, regime, bestSetup, chosen);

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
    selection_only: selectionOnly,
    execution_allowed_final: executionAllowedFinal,
    decision_reason_primary: decisionReasonPrimary ?? null,
    rejections_by_setup: rejectionsBySetup,
    top_rejection_reason: topRejectionReason,
    count_rejections_this_cycle: countRejectionsThisCycle,
    candidate_diagnostics: generatorDiagnostics,
    dynamicRrUpstreamActive: drpConfig !== null,
    dynamicRrSource: drpSource,
  };
}
