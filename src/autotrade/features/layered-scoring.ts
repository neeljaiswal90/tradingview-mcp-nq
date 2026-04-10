/**
 * features/layered-scoring.ts — Layered scoring architecture V1.
 *
 * Separates candidate scoring into explicit layers:
 *   Layer 1: Hard validity (binary, unchanged — lives in strategy.ts)
 *   Layer 2: Structure score [0, 10] — thesis quality
 *   Layer 3: Order flow score [0, 10] — timing confirmation from LOB
 *   Layer 4: Lagging tie-breakers [-1.0, +1.0] — bounded adjustments
 *   Layer 5: Final rank [0, 10] — weighted combination
 *
 * V1 principles:
 *   - Ship in shadow mode only (enabled: false, shadow_log: true)
 *   - Promote only high-coverage flow features (directional, imbalance, queue, microprice)
 *   - Sparse MBO features (absorption, sweeps, footprint) are research-only
 *   - Lagging indicators bounded to ±1.0
 *   - Correlated trend factors (TF alignment + SuperTrend + regime) capped
 */

import type { LobSnapshot } from '../lob-client.js';
import type { CandidateSetup, MarketSnapshot, MultiTfBias, MarketRegime, IndicatorConfig, ScoreBreakdown, ScoringWeights } from '../types.js';
import { type SetupFamily, getSetupFamily } from './microstructure-score.js';

// Re-export SetupFamily for convenience
export type { SetupFamily };

// ── Configuration Types ─────────────────────────────────────────────────────

export interface MissingFlowPolicy {
  mode: 'renormalize_and_penalize';
  /** Penalty applied to final rank when flow data is unavailable. */
  confidence_penalty: number;
  /** Maximum rank achievable without flow data. */
  data_quality_cap: number;
}

export interface SetupScoringProfile {
  structure_weight: number;
  flow_weight: number;
}

export interface FlowComponentCaps {
  directional_flow: number;
  book_imbalance: number;
  queue_pressure: number;
  microprice: number;
  volume_profile: number;
}

export interface LayeredScoringConfig {
  /** Master enable switch. When true, layered score replaces flat scoring. */
  enabled: boolean;
  /** When true, compute and log layered scores alongside old scores (no behavioral change). */
  shadow_log: boolean;
  /** Maximum absolute value for lagging tie-breaker layer. */
  lagging_cap: number;
  /** Policy when LOB/flow data is unavailable. */
  missing_flow_policy: MissingFlowPolicy;
  /** Per-setup-family weight profiles. */
  setup_profiles: Record<string, SetupScoringProfile>;
  /** Feature readiness tiers. */
  flow_feature_tiers: {
    default_on: string[];
    soft_only: string[];
    research_only: string[];
  };
  /** Per-component caps for flow scoring. */
  flow_component_caps: FlowComponentCaps;
}

// ── Default Config ──────────────────────────────────────────────────────────

export const DEFAULT_LAYERED_SCORING_CONFIG: LayeredScoringConfig = {
  enabled: false,
  shadow_log: true,
  lagging_cap: 1.0,
  missing_flow_policy: {
    mode: 'renormalize_and_penalize',
    confidence_penalty: 0.35,
    data_quality_cap: 7.5,
  },
  setup_profiles: {
    trend_continuation:    { structure_weight: 0.60, flow_weight: 0.40 },
    breakout_continuation: { structure_weight: 0.50, flow_weight: 0.50 },
    reversal_reclaim:      { structure_weight: 0.55, flow_weight: 0.45 },
    session_structure:     { structure_weight: 0.60, flow_weight: 0.40 },
  },
  flow_feature_tiers: {
    default_on: ['directional_flow', 'book_imbalance', 'queue_pressure', 'microprice'],
    soft_only: ['volume_profile'],
    research_only: ['absorption', 'sweeps', 'footprint', 'large_trade', 'mbo_basic', 'iceberg'],
  },
  flow_component_caps: {
    directional_flow: 1.0,
    book_imbalance: 0.6,
    queue_pressure: 0.5,
    microprice: 0.5,
    volume_profile: 0.4,
  },
};

// ── Result Types ────────────────────────────────────────────────────────────

export interface StructureBreakdown {
  tf_alignment: number;
  htf_direction: number;
  supertrend: number;
  structural_level: number;
  rr_quality: number;
  volume: number;
  missing_indicators: number;
  entry_location: number;
  regime_alignment: number;
  swing_structure: number;
  or_level: number;
  /** Raw sum of correlated trend factors before capping. */
  trend_cluster_raw: number;
  /** Capped sum of correlated trend factors [-1.5, +2.5]. */
  trend_cluster_capped: number;
  raw_sum: number;
  normalized: number;
}

export interface FlowBreakdown {
  directional_flow: number;
  book_imbalance: number;
  queue_pressure: number;
  microprice: number;
  volume_profile: number;
  /** Data quality of the LOB snapshot used. */
  data_quality: 'good' | 'partial' | 'minimal' | 'none';
  /** Which flow features were active in scoring. */
  active_flow_features: string[];
  /** Reasons why flow quality was degraded. */
  quality_degradation_reasons: string[];
  /** Actual flow weight after renormalization (for audit). */
  effective_weight: number;
  components_available: number;
  raw_sum: number;
  normalized: number;
}

export interface LaggingBreakdown {
  adx_trend: number;
  adx_di: number;
  ttm_squeeze: number;
  cvd_alignment: number;
  vwap_side: number;
  raw_sum: number;
  clamped: number;
}

export interface LayeredScoreResult {
  structure_score: number;
  flow_score: number;
  lagging_adjustment: number;
  final_rank: number;
  profile_used: SetupScoringProfile;
  setup_family: SetupFamily;
  missing_flow_policy_applied: boolean;
  structure_breakdown: StructureBreakdown;
  flow_breakdown: FlowBreakdown;
  lagging_breakdown: LaggingBreakdown;
  factors: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function safe(v: number | null | undefined): number {
  if (v === null || v === undefined || Number.isNaN(v)) return 0;
  return v;
}

function available(v: number | null | undefined): boolean {
  return v !== null && v !== undefined && !Number.isNaN(v);
}

// ── Layer 2: Structure Score ────────────────────────────────────────────────

/**
 * Compute structure score [0, 10] — thesis quality before micro-timing.
 * Same factors as scoreConfidenceDetailed() Tier 1 + Tier 2, but with
 * correlated trend factor capping.
 */
export function computeStructureScore(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  bias: MultiTfBias,
  regime: MarketRegime,
  w: ScoringWeights,
  config: IndicatorConfig,
): StructureBreakdown {
  const price = snap.price;
  const ind = snap.indicators_1m;
  const isShort = setup.direction === 'short';

  const bd: StructureBreakdown = {
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
    or_level: 0,
    trend_cluster_raw: 0,
    trend_cluster_capped: 0,
    raw_sum: 0,
    normalized: 0,
  };

  // ── TF alignment ──────────────────────────────────────────────────────────
  if (bias.alignment_score === 4) {
    bd.tf_alignment = w.tf_alignment_4tf;
  } else if (bias.alignment_score === 3) {
    bd.tf_alignment = w.tf_alignment_3tf;
  } else if (bias.alignment_score === 2) {
    bd.tf_alignment = w.tf_alignment_2tf;
  } else {
    bd.tf_alignment = w.tf_alignment_weak;
  }

  // ── HTF direction ─────────────────────────────────────────────────────────
  const tfAligned = isShort ? bias['1h'] === 'bearish' : bias['1h'] === 'bullish';
  if (!tfAligned) {
    bd.htf_direction = w.htf_direction_conflict;
  }

  // ── SuperTrend ────────────────────────────────────────────────────────────
  const stConfirms = (isShort && ind.supertrend_direction === 'down')
    || (!isShort && ind.supertrend_direction === 'up');
  if (stConfirms) {
    bd.supertrend = w.supertrend_confirms;
  } else if (ind.supertrend_direction !== null) {
    bd.supertrend = w.supertrend_opposes;
  }

  // ── Structural level ──────────────────────────────────────────────────────
  const bossSellSet = snap.key_levels.bos_sell !== null;
  const bosBuySet = snap.key_levels.bos_buy !== null;
  const structKl = snap.key_levels;

  let atStructure = false;
  if (isShort) {
    atStructure = bossSellSet && price < snap.key_levels.bos_sell!;
  } else {
    if (bosBuySet && price > snap.key_levels.bos_buy!) {
      atStructure = true;
    } else if (ind.vwap !== null && price > ind.vwap
      && structKl.daily_open !== null && price > structKl.daily_open) {
      atStructure = true;
    } else if (structKl.opening_range_high !== null && price > structKl.opening_range_high) {
      atStructure = true;
    } else if (structKl.prior_rth_low !== null && price > structKl.prior_rth_low
      && ind.ema_50 !== null && price > ind.ema_50) {
      atStructure = true;
    }
  }
  if (atStructure) {
    bd.structural_level = w.structural_level_bonus;
  }

  // ── R:R quality ───────────────────────────────────────────────────────────
  if (setup.rr_t1 >= config.min_rr * 1.5) {
    bd.rr_quality = w.rr_excellent;
  } else if (setup.rr_t1 >= config.min_rr) {
    bd.rr_quality = w.rr_acceptable;
  } else {
    bd.rr_quality = w.rr_below_min;
  }

  // ── Volume quality ────────────────────────────────────────────────────────
  const bars1m = snap.bars_1m;
  if (bars1m.length >= 20) {
    const recent = bars1m.slice(-5);
    const older = bars1m.slice(-20, -5);
    const avgRecent = recent.reduce((s, b) => s + b.volume, 0) / recent.length;
    const avgOlder = older.reduce((s, b) => s + b.volume, 0) / older.length;
    if (avgOlder > 0) {
      if (avgRecent > avgOlder * 1.5) bd.volume = w.volume_strong;
      else if (avgRecent < avgOlder * 0.5) bd.volume = w.volume_thin;
    }
  }

  // ── Missing indicators ────────────────────────────────────────────────────
  const missing = snap.data_quality.missing_indicators.length;
  if (missing >= 3) {
    bd.missing_indicators = w.missing_indicators_many;
  } else if (missing > 0) {
    bd.missing_indicators = w.missing_indicators_some;
  }

  // ── Entry location ────────────────────────────────────────────────────────
  const entryMid = (setup.entry_low + setup.entry_high) / 2;
  const entryQuality = setup.risk_pts > 0 ? Math.abs(price - entryMid) / setup.risk_pts : 0;
  if (entryQuality > 0.5) {
    bd.entry_location = w.entry_location_suboptimal;
  }

  // ── Regime alignment ──────────────────────────────────────────────────────
  const regimeAligned = (isShort && (regime === 'trending_down' || regime === 'breakdown_attempt'))
    || (!isShort && (regime === 'trending_up' || regime === 'breakout_attempt'));
  if (regimeAligned) {
    bd.regime_alignment = w.regime_aligned;
  } else if (regime === 'choppy' || regime === 'high_volatility_impulse') {
    bd.regime_alignment = w.regime_adverse;
  }

  // ── Swing structure ───────────────────────────────────────────────────────
  const { swingHigh, swingLow } = findSwingsLocal(snap.bars_15m, 5);
  if (isShort) {
    const recent5 = snap.bars_5m.slice(-6);
    if (recent5.length >= 6) {
      const recentHigh = Math.max(...recent5.slice(-3).map(b => b.high));
      const prevHigh = Math.max(...recent5.slice(0, 3).map(b => b.high));
      if (recentHigh < prevHigh) {
        bd.swing_structure += w.swing_structure_trend;
      }
    }
    if (swingHigh > 0 && price < swingHigh * 0.9995) {
      bd.swing_structure += w.swing_structure_level;
    }
  } else {
    const recent5 = snap.bars_5m.slice(-6);
    if (recent5.length >= 6) {
      const recentLow = Math.min(...recent5.slice(-3).map(b => b.low));
      const prevLow = Math.min(...recent5.slice(0, 3).map(b => b.low));
      if (recentLow > prevLow) {
        bd.swing_structure += w.swing_structure_trend;
      }
    }
    if (swingLow > 0 && price > swingLow * 1.0005) {
      bd.swing_structure += w.swing_structure_level;
    }
  }

  // ── OR proximity ──────────────────────────────────────────────────────────
  const kl = snap.key_levels;
  const orHigh = kl.opening_range_high;
  const orLow = kl.opening_range_low;
  if (orHigh !== null && orLow !== null) {
    const orRange = orHigh - orLow;
    const proximityThreshold = orRange > 0 ? orRange * 0.3 : 5;
    if (!isShort && orLow > 0 && Math.abs(price - orLow) <= proximityThreshold) {
      bd.or_level = w.or_level_supports;
    } else if (isShort && orHigh > 0 && Math.abs(price - orHigh) <= proximityThreshold) {
      bd.or_level = w.or_level_supports;
    }
  }

  // ── Correlated trend factor cap ───────────────────────────────────────────
  // TF alignment, SuperTrend, and regime alignment all partly measure
  // "is the trend strong/aligned." Cap their combined contribution.
  bd.trend_cluster_raw = bd.tf_alignment + bd.supertrend + bd.regime_alignment;
  bd.trend_cluster_capped = clamp(bd.trend_cluster_raw, -1.5, 2.5);
  const trendClusterDelta = bd.trend_cluster_capped - bd.trend_cluster_raw;

  // ── Final structure score ─────────────────────────────────────────────────
  // Non-trend factors sum independently
  const nonTrend = bd.htf_direction + bd.structural_level + bd.rr_quality + bd.volume
    + bd.missing_indicators + bd.entry_location + bd.swing_structure + bd.or_level;

  bd.raw_sum = bd.trend_cluster_capped + nonTrend;
  bd.normalized = clamp(round1(w.base + bd.raw_sum), 0, 10);

  return bd;
}

// ── Layer 3: Order Flow Score ───────────────────────────────────────────────

/**
 * Compute order flow score [0, 10] — timing confirmation from LOB data.
 * V1 uses only high-coverage features: directional flow, book imbalance,
 * queue pressure, microprice edge, and volume profile (soft).
 */
export function computeFlowScoreV1(
  snap: LobSnapshot | null | undefined,
  setupFamily: SetupFamily,
  direction: 'long' | 'short',
  lsConfig: LayeredScoringConfig,
): FlowBreakdown {
  const caps = lsConfig.flow_component_caps;
  const tiers = lsConfig.flow_feature_tiers;

  const bd: FlowBreakdown = {
    directional_flow: 0,
    book_imbalance: 0,
    queue_pressure: 0,
    microprice: 0,
    volume_profile: 0,
    data_quality: 'none',
    active_flow_features: [],
    quality_degradation_reasons: [],
    effective_weight: 0,
    components_available: 0,
    raw_sum: 0,
    normalized: 5.0,
  };

  // No LOB data at all
  if (!snap || snap.data_quality === 'unavailable' || snap.bbo_age_ms > 5000) {
    if (!snap) bd.quality_degradation_reasons.push('no_lob_snapshot');
    else if (snap.data_quality === 'unavailable') bd.quality_degradation_reasons.push('sidecar_unavailable');
    else bd.quality_degradation_reasons.push('bbo_stale_' + snap.bbo_age_ms + 'ms');
    return bd;
  }

  const sign = direction === 'long' ? 1 : -1;
  let componentsAvailable = 0;

  // ── A. Directional Flow ───────────────────────────────────────────────────
  if (tiers.default_on.includes('directional_flow')) {
    const delta10 = snap.cumulative_delta_10s;
    const delta30 = snap.cumulative_delta_30s;
    const flowImb = snap.trade_flow_imbalance_10s;

    if (available(delta10) || available(delta30) || available(flowImb)) {
      componentsAvailable++;
      bd.active_flow_features.push('directional_flow');
      let raw = 0;

      if (setupFamily === 'reversal_reclaim') {
        // Reversal: reward flow that has flipped toward our direction
        if (available(flowImb)) {
          const flowBias = (flowImb! - 0.5) * 2;
          const aligned = flowBias * sign;
          if (aligned > 0.1) raw += clamp(aligned * 0.45, 0, 0.45);
          else if (aligned < -0.2) raw += clamp(aligned * 0.35, -0.35, 0);
        }
        if (available(delta10)) {
          raw += Math.sign(safe(delta10)) === sign ? 0.20 : -0.15;
        }
      } else {
        // Continuation / session: reward aligned delta
        if (available(flowImb)) {
          const flowBias = (flowImb! - 0.5) * 2;
          raw += clamp(flowBias * sign * 0.35, -0.35, 0.35);
        }
        if (available(delta10)) {
          raw += Math.sign(safe(delta10)) === sign ? 0.20 : -0.15;
        }
        if (available(delta30) && available(delta10)) {
          const momentumBuilding = Math.abs(safe(delta10)) > Math.abs(safe(delta30)) * 0.6;
          if (momentumBuilding && Math.sign(safe(delta10)) === sign) {
            raw += 0.15;
          }
        }
      }
      bd.directional_flow = clamp(round2(raw), -caps.directional_flow, caps.directional_flow);
    }
  }

  // ── B. Book Imbalance ─────────────────────────────────────────────────────
  if (tiers.default_on.includes('book_imbalance')) {
    const imb5 = snap.depth_imbalance_5;
    const bidSz = snap.bid_size;
    const askSz = snap.ask_size;

    if (available(imb5) || (available(bidSz) && available(askSz))) {
      componentsAvailable++;
      bd.active_flow_features.push('book_imbalance');
      let raw = 0;

      if (available(imb5)) {
        raw += clamp(imb5! * sign * 0.40, -0.40, 0.40);
      }
      if (available(bidSz) && available(askSz)) {
        const total = bidSz! + askSz!;
        if (total > 0) {
          const bboSkew = (bidSz! - askSz!) / total;
          raw += clamp(bboSkew * sign * 0.10, -0.10, 0.10);
        }
      }
      bd.book_imbalance = clamp(round2(raw), -caps.book_imbalance, caps.book_imbalance);
    } else {
      bd.quality_degradation_reasons.push('missing_depth_data');
    }
  }

  // ── C. Queue Pressure ─────────────────────────────────────────────────────
  if (tiers.default_on.includes('queue_pressure')) {
    const qdBid = snap.adv_queue_deterioration_bid_10s;
    const qdAsk = snap.adv_queue_deterioration_ask_10s;
    const car = snap.cancel_add_ratio_10s;
    const replenish = snap.replenishment_rate_10s;

    if (available(qdBid) || available(qdAsk) || available(car) || available(replenish)) {
      componentsAvailable++;
      bd.active_flow_features.push('queue_pressure');
      let raw = 0;

      if (available(qdBid) && available(qdAsk)) {
        if (direction === 'long') {
          if (qdAsk! > 1.0) raw += clamp((qdAsk! - 0.8) * 0.15, 0, 0.20);
          if (qdBid! > 1.0) raw -= clamp((qdBid! - 0.8) * 0.15, 0, 0.20);
        } else {
          if (qdBid! > 1.0) raw += clamp((qdBid! - 0.8) * 0.15, 0, 0.20);
          if (qdAsk! > 1.0) raw -= clamp((qdAsk! - 0.8) * 0.15, 0, 0.20);
        }
      }
      if (available(car) && car! > 2.0) {
        raw -= clamp((car! - 1.5) * 0.08, 0, 0.15);
      }
      if (available(replenish) && setupFamily !== 'reversal_reclaim' && replenish! > 1.0) {
        raw += 0.08;
      }

      bd.queue_pressure = clamp(round2(raw), -caps.queue_pressure, caps.queue_pressure);
    } else {
      bd.quality_degradation_reasons.push('missing_queue_fields');
    }
  }

  // ── D. Microprice Edge ────────────────────────────────────────────────────
  if (tiers.default_on.includes('microprice')) {
    const bid = snap.bid;
    const ask = snap.ask;
    const bidSz = snap.bid_size;
    const askSz = snap.ask_size;

    if (available(bid) && available(ask) && available(bidSz) && available(askSz)
      && bidSz! + askSz! > 0) {
      componentsAvailable++;
      bd.active_flow_features.push('microprice');

      const microprice = (ask! * bidSz! + bid! * askSz!) / (bidSz! + askSz!);
      const mid = (bid! + ask!) / 2;
      const tickSize = 0.25; // NQ tick size
      const edgeTicks = (microprice - mid) / tickSize;

      // Direction-signed edge: positive = microprice favors our direction
      const dirEdge = edgeTicks * sign;
      // Scale: 1 tick edge → ~0.15 score, 3+ ticks → capped
      bd.microprice = clamp(round2(dirEdge * 0.12), -caps.microprice, caps.microprice);
    } else {
      bd.quality_degradation_reasons.push('bbo_only');
    }
  }

  // ── E. Volume Profile (soft-only) ─────────────────────────────────────────
  if (tiers.soft_only.includes('volume_profile')) {
    const vpoc = snap.session_vpoc;
    const vah = snap.session_vah;
    const val = snap.session_val;
    const distVpoc = snap.distance_to_vpoc;
    const insideVA = snap.inside_value_area;
    const mid = snap.mid;

    if (available(vpoc) && available(vah) && available(val) && available(mid)) {
      componentsAvailable++;
      bd.active_flow_features.push('volume_profile');
      let raw = 0;

      if (available(distVpoc)) {
        const vpocAlignment = Math.sign(distVpoc!) === sign;
        if (vpocAlignment && Math.abs(distVpoc!) > 5) raw += 0.12;
        else if (!vpocAlignment && Math.abs(distVpoc!) > 10) raw -= 0.06;
      }
      if (insideVA === false) {
        if (direction === 'long' && mid! > vah!) raw += 0.12;
        else if (direction === 'short' && mid! < val!) raw += 0.12;
        else raw -= 0.06;
      }

      bd.volume_profile = clamp(round2(raw), -caps.volume_profile, caps.volume_profile);
    } else {
      bd.quality_degradation_reasons.push('vp_unavailable');
    }
  }

  // ── Assess data quality ───────────────────────────────────────────────────
  bd.components_available = componentsAvailable;
  if (componentsAvailable >= 4) bd.data_quality = 'good';
  else if (componentsAvailable >= 2) bd.data_quality = 'partial';
  else if (componentsAvailable >= 1) bd.data_quality = 'minimal';
  else bd.data_quality = 'none';

  // ── Normalize to [0, 10] ──────────────────────────────────────────────────
  bd.raw_sum = round2(bd.directional_flow + bd.book_imbalance + bd.queue_pressure
    + bd.microprice + bd.volume_profile);
  bd.normalized = clamp(round1(5.0 + bd.raw_sum), 0, 10);

  return bd;
}

// ── Layer 4: Lagging Tie-Breakers ───────────────────────────────────────────

/**
 * Compute lagging tie-breakers [-1.0, +1.0] — bounded secondary adjustments.
 * ADX/DI, TTM squeeze, CVD divergence, and simple VWAP side-of-price.
 */
export function computeLaggingTieBreakers(
  snap: MarketSnapshot,
  direction: 'long' | 'short',
  regime: MarketRegime,
  laggingCap: number,
): LaggingBreakdown {
  const ind = snap.indicators_1m;
  const isShort = direction === 'short';

  const bd: LaggingBreakdown = {
    adx_trend: 0,
    adx_di: 0,
    ttm_squeeze: 0,
    cvd_alignment: 0,
    vwap_side: 0,
    raw_sum: 0,
    clamped: 0,
  };

  // ── ADX / DI ──────────────────────────────────────────────────────────────
  const regimeAligned = (isShort && (regime === 'trending_down' || regime === 'breakdown_attempt'))
    || (!isShort && (regime === 'trending_up' || regime === 'breakout_attempt'));

  const adxVal = ind.adx;
  if (adxVal !== null) {
    if (adxVal > 25 && regimeAligned) {
      bd.adx_trend = 0.30;
    } else if (adxVal < 15) {
      bd.adx_trend = -0.20;
    }
    if (ind.di_plus !== null && ind.di_minus !== null) {
      const diConfirms = isShort ? ind.di_minus > ind.di_plus : ind.di_plus > ind.di_minus;
      if (diConfirms) {
        bd.adx_di = 0.15;
      }
    }
  }

  // ── TTM Squeeze ───────────────────────────────────────────────────────────
  if (ind.ttm_squeeze_firing === true) {
    bd.ttm_squeeze = -0.20;
  } else if (ind.ttm_squeeze_firing === false && ind.ttm_squeeze_momentum !== null) {
    const momAligns = isShort
      ? ind.ttm_squeeze_momentum < 0
      : ind.ttm_squeeze_momentum > 0;
    if (momAligns) {
      bd.ttm_squeeze = 0.20;
    }
  }

  // ── CVD (slower confirmation) ─────────────────────────────────────────────
  if (ind.cvd_delta !== null) {
    const lastBar = snap.bars_1m[snap.bars_1m.length - 1];
    const prevBar = snap.bars_1m[snap.bars_1m.length - 2];
    if (lastBar && prevBar) {
      const priceUp = lastBar.close > prevBar.close;
      const priceDown = lastBar.close < prevBar.close;
      const cvdBullish = ind.cvd_delta > 0 || ind.cvd_trend === 'up';
      const cvdBearish = ind.cvd_delta < 0 || ind.cvd_trend === 'down';
      const divergence = (priceUp && cvdBearish && !isShort)
        || (priceDown && cvdBullish && isShort);
      if (divergence) {
        bd.cvd_alignment = -0.30;
      } else {
        const cvdConfirms = isShort ? cvdBearish : cvdBullish;
        if (cvdConfirms) {
          bd.cvd_alignment = 0.15;
        }
      }
    }
  }

  // ── VWAP side-of-price (simple above/below check only) ────────────────────
  const vwap = ind.vwap;
  if (vwap !== null && vwap > 0) {
    const vwapSupports = (isShort && snap.price < vwap) || (!isShort && snap.price > vwap);
    const vwapOpposes = (isShort && snap.price > vwap) || (!isShort && snap.price < vwap);
    if (vwapSupports) bd.vwap_side = 0.20;
    else if (vwapOpposes) bd.vwap_side = -0.20;
  }

  // ── Clamp total ───────────────────────────────────────────────────────────
  bd.raw_sum = round2(bd.adx_trend + bd.adx_di + bd.ttm_squeeze + bd.cvd_alignment + bd.vwap_side);
  bd.clamped = clamp(round2(bd.raw_sum), -laggingCap, laggingCap);

  return bd;
}

// ── Layer 5: Final Rank ─────────────────────────────────────────────────────

/**
 * Combine structure, flow, and lagging into a final rank [0, 10].
 * Applies missing-flow policy when flow data is unavailable.
 */
export function computeFinalRank(
  structureScore: number,
  flowScore: number,
  laggingAdj: number,
  profile: SetupScoringProfile,
  flowDataQuality: FlowBreakdown['data_quality'],
  missingFlowPolicy: MissingFlowPolicy,
): { rank: number; missingFlowApplied: boolean; effectiveFlowWeight: number } {
  let missingFlowApplied = false;
  let effectiveFlowWeight = profile.flow_weight;
  let rank: number;

  if (flowDataQuality === 'none') {
    // Missing flow: renormalize to structure-only + penalty + cap
    missingFlowApplied = true;
    effectiveFlowWeight = 0;
    rank = structureScore + laggingAdj - missingFlowPolicy.confidence_penalty;
    rank = Math.min(rank, missingFlowPolicy.data_quality_cap);
  } else {
    rank = profile.structure_weight * structureScore
      + profile.flow_weight * flowScore
      + laggingAdj;
  }

  rank = clamp(round1(rank), 0, 10);
  return { rank, missingFlowApplied, effectiveFlowWeight };
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Compute the full layered score for a candidate setup.
 * This is the main function called from strategy.ts.
 */
export function computeLayeredScore(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  bias: MultiTfBias,
  regime: MarketRegime,
  config: IndicatorConfig,
  w: ScoringWeights,
  lobSnapshot: LobSnapshot | null | undefined,
  lsConfig: LayeredScoringConfig,
): LayeredScoreResult {
  const setupFamily = getSetupFamily(setup.setup_type);
  const profile: SetupScoringProfile = lsConfig.setup_profiles[setupFamily]
    ?? lsConfig.setup_profiles['trend_continuation']
    ?? DEFAULT_LAYERED_SCORING_CONFIG.setup_profiles.trend_continuation!;

  // Layer 2: Structure
  const structBd = computeStructureScore(setup, snap, bias, regime, w, config);

  // Layer 3: Order flow
  const flowBd = computeFlowScoreV1(
    lobSnapshot,
    setupFamily,
    setup.direction as 'long' | 'short',
    lsConfig,
  );

  // Layer 4: Lagging tie-breakers
  const laggingBd = computeLaggingTieBreakers(
    snap,
    setup.direction as 'long' | 'short',
    regime,
    lsConfig.lagging_cap,
  );

  // Layer 5: Final rank
  const { rank, missingFlowApplied, effectiveFlowWeight } = computeFinalRank(
    structBd.normalized,
    flowBd.normalized,
    laggingBd.clamped,
    profile,
    flowBd.data_quality,
    lsConfig.missing_flow_policy,
  );

  // Set effective weight in flow breakdown for audit
  flowBd.effective_weight = effectiveFlowWeight;

  // Build factor strings for logging
  const factors: string[] = [];
  factors.push(`structure:${structBd.normalized.toFixed(1)}`);
  factors.push(`flow:${flowBd.normalized.toFixed(1)}(q=${flowBd.data_quality})`);
  factors.push(`lagging:${laggingBd.clamped > 0 ? '+' : ''}${laggingBd.clamped.toFixed(2)}`);
  factors.push(`rank:${rank.toFixed(1)}`);
  factors.push(`profile:${setupFamily}(s=${profile.structure_weight},f=${effectiveFlowWeight})`);
  if (structBd.trend_cluster_raw !== structBd.trend_cluster_capped) {
    factors.push(`trend_cap:${structBd.trend_cluster_raw.toFixed(2)}->${structBd.trend_cluster_capped.toFixed(2)}`);
  }
  if (missingFlowApplied) {
    factors.push('missing_flow_policy_applied');
  }
  if (flowBd.quality_degradation_reasons.length > 0) {
    factors.push(`flow_degraded:[${flowBd.quality_degradation_reasons.join(',')}]`);
  }

  return {
    structure_score: structBd.normalized,
    flow_score: flowBd.normalized,
    lagging_adjustment: laggingBd.clamped,
    final_rank: rank,
    profile_used: profile,
    setup_family: setupFamily,
    missing_flow_policy_applied: missingFlowApplied,
    structure_breakdown: structBd,
    flow_breakdown: flowBd,
    lagging_breakdown: laggingBd,
    factors,
  };
}

/**
 * Map a LayeredScoreResult back to a legacy ScoreBreakdown for backward compat.
 * This populates the old flat breakdown from the layered structure + lagging layers.
 */
export function layeredToLegacyBreakdown(
  result: LayeredScoreResult,
  base: number,
): ScoreBreakdown {
  const s = result.structure_breakdown;
  const l = result.lagging_breakdown;
  return {
    base,
    tf_alignment: s.tf_alignment,
    htf_direction: s.htf_direction,
    supertrend: s.supertrend,
    structural_level: s.structural_level,
    rr_quality: s.rr_quality,
    volume: s.volume,
    missing_indicators: s.missing_indicators,
    entry_location: s.entry_location,
    regime_alignment: s.regime_alignment,
    swing_structure: s.swing_structure,
    vwap_position: l.vwap_side,
    or_level: s.or_level,
    adx_trend_strength: l.adx_trend + l.adx_di,
    ttm_squeeze: l.ttm_squeeze,
    cvd_alignment: l.cvd_alignment,
    total: result.final_rank,
    factors: result.factors,
    feature_set: 'full',
  };
}

// ── Local Helpers ───────────────────────────────────────────────────────────

/** Find swing high/low from bar data (replicates findSwings from strategy.ts). */
function findSwingsLocal(bars: Array<{ high: number; low: number }>, lookback: number): { swingHigh: number; swingLow: number } {
  if (bars.length < lookback * 2 + 1) return { swingHigh: 0, swingLow: 0 };
  let swingHigh = 0;
  let swingLow = Infinity;
  for (let i = lookback; i < bars.length - lookback; i++) {
    const bar = bars[i]!;
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      const prev = bars[i - j]!;
      const next = bars[i + j]!;
      if (prev.high >= bar.high || next.high >= bar.high) isSwingHigh = false;
      if (prev.low <= bar.low || next.low <= bar.low) isSwingLow = false;
    }
    if (isSwingHigh && bar.high > swingHigh) swingHigh = bar.high;
    if (isSwingLow && bar.low < swingLow) swingLow = bar.low;
  }
  if (swingLow === Infinity) swingLow = 0;
  return { swingHigh, swingLow };
}
