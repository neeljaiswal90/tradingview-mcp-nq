/**
 * score-v2.ts — Phase 4 scoring decomposition (shadow-only).
 *
 * Decomposes a candidate into three normalized submodels:
 *
 *   Structure (S) — thesis quality. Trend alignment, HTF agreement,
 *                   swing structure, zone context, regime alignment.
 *                   Implemented by rescaling layered-scoring.ts
 *                   computeStructureScore() output from [0,10] to [0,1].
 *
 *   Timing (T)    — entry location, pullback depth, extension state,
 *                   short-term flow, microstructure, local confirmation.
 *                   Implemented by blending the existing layered flow
 *                   score (LOB-based) with an extension-features signal
 *                   derived from the already-computed ExtensionFeatures.
 *
 *   Payoff (P)    — new Phase 4 submodel, not present in any existing
 *                   scoring path. Four components:
 *                     - room_to_target  [0,1]
 *                     - obstacle_free   [0,1]   (no BOS/OR in path to T1)
 *                     - realized_rr     [0,1]   (normalized against family
 *                                                baseline)
 *                     - adverse_distance[0,1]   (stop distance vs ATR)
 *
 * composite = clamp(w.s*S + w.t*T + w.p*P, 0, 1)
 * rank_100  = round(100 * composite)
 *
 * IMPORTANT: This file is SHADOW-ONLY. Its output is written to
 * candidate_scores_v2.jsonl but never drives execution. No function in
 * this file should ever be called from the live execution path —
 * runner.ts only reads the result into the telemetry payload.
 *
 * Reuses existing feature signals (ExtensionFeatures, MicrostructureScore,
 * DynamicRewardPlan, LayeredScoring sub-scores) rather than duplicating
 * extraction logic.
 */

import type {
  CandidateSetup,
  MarketSnapshot,
  MultiTfBias,
  MarketRegime,
  ScoringWeights,
  IndicatorConfig,
} from '../types.js';
import type { ExtensionFeatures } from '../features/extension.js';
import type { DynamicRewardPlan } from '../features/dynamic-reward-plan.js';
import {
  getSetupFamily as getScoreProfileFamily,
  type MicrostructureScoreResult,
  type SetupFamily as ScoreProfileFamily,
} from '../features/microstructure-score.js';
import type { LobSnapshot } from '../lob-client.js';
import {
  computeStructureScore,
  computeFlowScoreV1,
  DEFAULT_LAYERED_SCORING_CONFIG,
  type LayeredScoringConfig,
} from '../features/layered-scoring.js';
import type { ScoreV2Config } from './score-v2-config.js';
import { mergeScoreV2Config } from './score-v2-config.js';

// ── Result shape ───────────────────────────────────────────────────────────

export interface ScoreV2Result {
  /** Normalized structure submodel in [0, 1]. */
  structure: number;
  /** Normalized timing submodel in [0, 1]. */
  timing: number;
  /** Normalized payoff submodel in [0, 1]. */
  payoff: number;
  /** Weighted composite in [0, 1]. */
  composite: number;
  /** `round(100 * composite)` — display rank. */
  rank_100: number;
  /**
   * Raw sub-factor contributions. Used by Phase 5 cluster caps and by
   * Phase 6 calibration analysis to understand which factors drove the
   * composite for each candidate.
   */
  components: Record<string, number>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Linear fall-off from `good` → `bad`, mapped to [1, 0]. */
function linearFalloff(value: number, good: number, bad: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (good === bad) return value <= good ? 1 : 0;
  if (good < bad) {
    // lower is better
    if (value <= good) return 1;
    if (value >= bad) return 0;
    return 1 - (value - good) / (bad - good);
  }
  // higher is better
  if (value >= good) return 1;
  if (value <= bad) return 0;
  return 1 - (good - value) / (good - bad);
}

// ── Structure submodel ─────────────────────────────────────────────────────

function structureFromLayered(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  bias: MultiTfBias,
  regime: MarketRegime,
  scoringWeights: ScoringWeights,
  config: IndicatorConfig,
  components: Record<string, number>,
): number {
  const sb = computeStructureScore(setup, snap, bias, regime, scoringWeights, config);
  // Record the underlying cluster totals so Phase 5 / Phase 6 can audit them
  components['structure.trend_cluster_raw'] = sb.trend_cluster_raw;
  components['structure.trend_cluster_capped'] = sb.trend_cluster_capped;
  components['structure.htf_direction'] = sb.htf_direction;
  components['structure.structural_level'] = sb.structural_level;
  components['structure.rr_quality'] = sb.rr_quality;
  components['structure.swing_structure'] = sb.swing_structure;
  components['structure.or_level'] = sb.or_level;
  components['structure.entry_location'] = sb.entry_location;
  components['structure.raw_sum'] = sb.raw_sum;
  components['structure.normalized_10'] = sb.normalized;
  // Rescale [0, 10] → [0, 1]
  return clamp01(sb.normalized / 10);
}

// ── Timing submodel ────────────────────────────────────────────────────────

function timingFromSignals(
  setup: CandidateSetup,
  extension: ExtensionFeatures | null,
  micro: MicrostructureScoreResult | null,
  lob: LobSnapshot | null,
  scoreProfileFamily: ScoreProfileFamily,
  lsConfig: LayeredScoringConfig,
  components: Record<string, number>,
): number {
  // Component 1 — entry location (how close to VWAP/EMA9, 0.0 ATR = perfect)
  // Use ATR-normalized distance: ≤ 0.3 ATR = 1.0, ≥ 1.5 ATR = 0.0
  const vwapDist = extension?.dist_from_vwap_atr;
  const ema9Dist = extension?.dist_from_ema9_atr;
  const entryLoc = Math.max(
    vwapDist != null ? linearFalloff(Math.abs(vwapDist), 0.3, 1.5) : 0.5,
    ema9Dist != null ? linearFalloff(Math.abs(ema9Dist), 0.3, 1.5) : 0.5,
  );
  components['timing.entry_location'] = entryLoc;

  // Component 2 — pullback depth / reset state
  // Reset occurred = 1.0, not reset but pullback present = 0.5, no pullback = 0.0
  let pullbackScore: number;
  if (extension?.reset_occurred) {
    pullbackScore = 1.0;
  } else if (extension && extension.pullback_depth_pts > 0) {
    pullbackScore = 0.5;
  } else {
    pullbackScore = 0.0;
  }
  components['timing.pullback'] = pullbackScore;

  // Component 3 — extension state (impulse exhaustion)
  // current_impulse_atr ≤ 1.0 = 1.0, ≥ 3.0 = 0.0
  const impulseAtr = extension?.current_impulse_atr;
  const extensionScore = impulseAtr != null ? linearFalloff(impulseAtr, 1.0, 3.0) : 0.5;
  components['timing.extension_state'] = extensionScore;

  // Component 4 — short-term flow (reuse layered flow score, rescaled to [0,1])
  // computeFlowScoreV1 returns a FlowBreakdown with a `normalized` field in [0,10]
  let flowScore = 0.5;
  try {
    const fb = computeFlowScoreV1(lob ?? undefined, scoreProfileFamily, setup.direction as 'long' | 'short', lsConfig);
    flowScore = clamp01(fb.normalized / 10);
    components['timing.flow_normalized_10'] = fb.normalized;
    components['timing.flow_directional'] = fb.directional_flow;
    components['timing.flow_book_imbalance'] = fb.book_imbalance;
  } catch {
    // Flow computation should not throw, but guard to keep score-v2 robust.
  }
  components['timing.flow'] = flowScore;

  // Component 5 — microstructure overlay
  //
  // Linear rescale from the overlay's native range [-2, +2] (see
  // features/microstructure-score.ts; `total` is a bounded sum of
  // directional/imbalance/absorption/queue/sweep/profile sub-components)
  // to [0, 1]:
  //
  //   microScore = (microTotal + 2.0) / 4.0    ∀ microTotal ∈ [-2, +2]
  //
  // Fixed points:  -2.0 → 0.0    0.0 → 0.5    +2.0 → 1.0
  //
  // Transform is deterministic and stable — any Phase 6 calibration
  // script analysing candidate_scores_v2.jsonl can invert this if it
  // needs the native value back. The rescale parameters live here (not
  // in config) so they are part of the immutable scoring contract.
  // Null microstructure → neutral 0.5, never 0, so missing-data rows
  // are not penalised relative to present-data rows with zero signal.
  const microTotal = micro?.total;
  const microScore = microTotal != null
    ? clamp01((microTotal + 2.0) / 4.0)
    : 0.5;
  components['timing.microstructure'] = microScore;
  components['timing.microstructure_raw'] = microTotal ?? 0;

  // Timing composite — simple average of the five components
  const timing = (entryLoc + pullbackScore + extensionScore + flowScore + microScore) / 5;
  return clamp01(timing);
}

// ── Payoff submodel ────────────────────────────────────────────────────────

function payoffFromPlanAndRoom(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  extension: ExtensionFeatures | null,
  rewardPlan: DynamicRewardPlan | null,
  components: Record<string, number>,
): number {
  const isLong = setup.direction === 'long';
  const target1 = setup.target_1;
  const entry = setup.entry_high != null && setup.entry_low != null
    ? (isLong ? setup.entry_low : setup.entry_high)
    : snap.price;

  // Component 1 — room to target
  // How much directional room remains vs the distance to T1.
  // room >= 1.5 * distance_to_T1  →  1.0
  // room <= distance_to_T1        →  0.0
  const distanceToT1 = Math.abs((target1 ?? entry) - entry);
  const roomPts = isLong
    ? (extension?.upside_room_pts ?? null)
    : (extension?.downside_room_pts ?? null);
  let roomScore = 0.5;
  if (roomPts != null && distanceToT1 > 0) {
    const ratio = roomPts / distanceToT1;
    roomScore = linearFalloff(ratio, 1.5, 1.0); // higher ratio = better
  }
  components['payoff.room_to_target'] = roomScore;
  components['payoff.room_pts'] = roomPts ?? 0;
  components['payoff.distance_to_t1_pts'] = distanceToT1;

  // Component 2 — obstacle-free path to T1
  // Scan key_levels and penalize any BOS/OR/pivot that sits between entry
  // and T1 in the direction of the trade. Reuses already-available levels.
  const kl = snap.key_levels;
  const inPath = (lvl: number | null | undefined): boolean => {
    if (lvl == null || !Number.isFinite(lvl)) return false;
    if (target1 == null) return false;
    const lo = Math.min(entry, target1);
    const hi = Math.max(entry, target1);
    return lvl > lo && lvl < hi;
  };
  let obstacleCount = 0;
  if (kl) {
    const candidates = [
      kl.bos_buy, kl.bos_sell,
      kl.choch_buy, kl.choch_sell,
      kl.opening_range_high, kl.opening_range_low,
      kl.prior_rth_high, kl.prior_rth_low,
      kl.daily_open,
    ];
    for (const lvl of candidates) {
      if (inPath(lvl as number | null | undefined)) obstacleCount++;
    }
  }
  // 0 obstacles = 1.0, ≥ 3 = 0.0
  const obstacleFree = Math.max(0, 1 - obstacleCount / 3);
  components['payoff.obstacle_count'] = obstacleCount;
  components['payoff.obstacle_free'] = obstacleFree;

  // Component 3 — realized RR vs family baseline
  // dynamic_min_rr in [1.3, 3.0] → map to [0, 1]
  // Family baselines are 1.5-1.8; dynamic_min_rr higher than baseline means
  // the setup is "paying well" after adjustments.
  const dynMinRr = rewardPlan?.dynamic_min_rr ?? null;
  const realizedRr = dynMinRr != null
    ? clamp01((dynMinRr - 1.3) / (3.0 - 1.3))
    : 0.5;
  components['payoff.realized_rr'] = realizedRr;
  components['payoff.dynamic_min_rr'] = dynMinRr ?? 0;

  // Component 4 — adverse distance (stop distance vs ATR)
  // Longer stops mean more room to be right, but also more risk.
  // Normalize against 1m ATR: 0.5 ATR → 1.0, 2.0 ATR → 0.0 (too wide)
  const stopPts = Math.abs((setup.stop ?? entry) - entry);
  const atr14 = snap.indicators_1m?.atr_14 ?? null;
  let adverseDistance = 0.5;
  if (atr14 != null && atr14 > 0) {
    const stopAtr = stopPts / atr14;
    adverseDistance = linearFalloff(stopAtr, 0.5, 2.0);
  }
  components['payoff.adverse_distance'] = adverseDistance;
  components['payoff.stop_pts'] = stopPts;

  // Payoff composite — average of the four components
  const payoff = (roomScore + obstacleFree + realizedRr + adverseDistance) / 4;
  return clamp01(payoff);
}

// ── Phase 5: factor cluster caps ───────────────────────────────────────────
//
// The Phase 4 composite is a simple weighted average of S/T/P. That lets
// correlated factors in the same cluster (e.g. EMA stack + SuperTrend +
// regime_aligned + 4TF alignment are all "the trend is aligned") stack
// into a much larger contribution than their independent information
// content justifies.
//
// Phase 5 groups raw factor contributions into clusters and caps each
// cluster's total contribution. Caps are applied to the UNDERLYING raw
// contributions (via the components map from Phase 4) and the submodels
// are RECOMPUTED from the capped cluster values — not by post-multiplying
// the already-aggregated S/T/P scalars. That preserves interpretability
// and makes the cap behaviour auditable per cluster.
//
// When `cluster_caps_active` is false (Phase 4 default), this code is a
// no-op and the Phase 4 composite formula is used unchanged.

type ClusterName = 'trend' | 'structure' | 'context' | 'timing' | 'payoff' | 'flow';

interface ClusterMember {
  key: string;
  /** Maps a raw component value into [0, 1] for cluster averaging. */
  norm: (raw: number) => number;
}

/**
 * Cluster membership map. Each cluster lists the component keys that
 * belong to it plus a normaliser that maps their raw value into [0, 1].
 *
 * Structure-family components (`structure.*`) come from layered-scoring.ts
 * and carry their raw additive contributions (roughly in [-1, +2.5]), so
 * they need explicit per-factor normalisation. Timing/payoff components
 * are already in [0, 1] (see Phase 4 submodels) and use the identity.
 *
 * Keep the total of cluster caps ≤ ~1.25 so the summed contribution can
 * reach or exceed 1.0 before clamping, matching the plan's numbers.
 */
const CLUSTER_DEFINITIONS: Record<ClusterName, ClusterMember[]> = {
  // Trend cluster — what `computeStructureScore()` already caps internally
  // to [-1.5, +2.5]. We map that raw capped value into [0, 1] via a linear
  // shift so "flat / neutral" (0) lands near 0.375 and "max trend" (+2.5)
  // lands at 1.0.
  trend: [
    { key: 'structure.trend_cluster_capped', norm: (x) => clamp01((x + 1.5) / 4.0) },
  ],
  // Structure cluster — pure-structure factors independent of the trend.
  structure: [
    { key: 'structure.structural_level', norm: (x) => clamp01(x / 0.5) },
    { key: 'structure.swing_structure', norm: (x) => clamp01(x / 0.5) },
    { key: 'structure.rr_quality', norm: (x) => clamp01((x + 0.5) / 1.0) },
  ],
  // Context cluster — HTF agreement, opening-range alignment, entry location.
  context: [
    { key: 'structure.htf_direction', norm: (x) => clamp01(x + 1.0) },
    { key: 'structure.or_level', norm: (x) => clamp01(x / 0.4) },
    { key: 'structure.entry_location', norm: (x) => clamp01((x + 0.3) / 0.3) },
  ],
  // Timing cluster — already [0, 1] from Phase 4 timing submodel internals.
  timing: [
    { key: 'timing.entry_location', norm: (x) => clamp01(x) },
    { key: 'timing.pullback', norm: (x) => clamp01(x) },
    { key: 'timing.extension_state', norm: (x) => clamp01(x) },
  ],
  // Flow cluster — short-term LOB + microstructure overlay, already [0, 1].
  flow: [
    { key: 'timing.flow', norm: (x) => clamp01(x) },
    { key: 'timing.microstructure', norm: (x) => clamp01(x) },
  ],
  // Payoff cluster — already [0, 1] from Phase 4 payoff submodel internals.
  payoff: [
    { key: 'payoff.room_to_target', norm: (x) => clamp01(x) },
    { key: 'payoff.obstacle_free', norm: (x) => clamp01(x) },
    { key: 'payoff.realized_rr', norm: (x) => clamp01(x) },
    { key: 'payoff.adverse_distance', norm: (x) => clamp01(x) },
  ],
};

/**
 * Compute the normalised [0, 1] average score for a single cluster by
 * reading raw contributions out of the components map. Missing components
 * default to 0.5 (neutral) so missing data does not falsely penalise the
 * cluster score. The return value is always in [0, 1].
 */
function computeClusterAverage(
  clusterName: ClusterName,
  components: Record<string, number>,
): number {
  const members = CLUSTER_DEFINITIONS[clusterName];
  if (members.length === 0) return 0.5;
  let sum = 0;
  for (const m of members) {
    const raw = components[m.key];
    if (raw == null || !Number.isFinite(raw)) {
      sum += 0.5;
    } else {
      sum += m.norm(raw);
    }
  }
  return clamp01(sum / members.length);
}

interface ClusterContributions {
  trend: number;
  structure: number;
  context: number;
  timing: number;
  payoff: number;
  flow: number;
}

/**
 * Turn the raw components map into per-cluster CAPPED contributions. The
 * capped contribution for a cluster is:
 *
 *   capped_contribution = cluster_average * cluster_cap
 *
 * i.e. the cluster cap is the maximum contribution that cluster can make
 * to the composite. Adding more correlated factors to the cluster cannot
 * push its contribution above the cap.
 */
function applyClusterCaps(
  components: Record<string, number>,
  caps: import('./score-v2-config.js').ScoreV2ClusterCaps,
): ClusterContributions {
  return {
    trend: computeClusterAverage('trend', components) * caps.trend,
    structure: computeClusterAverage('structure', components) * caps.structure,
    context: computeClusterAverage('context', components) * caps.context,
    timing: computeClusterAverage('timing', components) * caps.timing,
    payoff: computeClusterAverage('payoff', components) * caps.payoff,
    flow: computeClusterAverage('flow', components) * caps.flow,
  };
}

// ── Public entry point ────────────────────────────────────────────────────

export interface ScoreV2Inputs {
  setup: CandidateSetup;
  snap: MarketSnapshot;
  bias: MultiTfBias;
  regime: MarketRegime;
  scoringWeights: ScoringWeights;
  indicatorConfig: IndicatorConfig;
  extension: ExtensionFeatures | null;
  microstructure: MicrostructureScoreResult | null;
  lob: LobSnapshot | null;
  rewardPlan: DynamicRewardPlan | null;
  /** Optional — defaults to DEFAULT_SCORE_V2_CONFIG. */
  config?: Partial<ScoreV2Config>;
  /** Optional — defaults to DEFAULT_LAYERED_SCORING_CONFIG for flow score. */
  layeredScoringConfig?: LayeredScoringConfig;
}

/**
 * Compute the Phase 4 score-v2 decomposition for a candidate.
 *
 * This function is SHADOW-ONLY. Callers must never feed the result back
 * into the execution path. The only consumer is the candidate_scores_v2
 * telemetry log (written once per evaluation in runner.ts).
 */
export function computeScoreV2(inputs: ScoreV2Inputs): ScoreV2Result {
  const cfg = mergeScoreV2Config(inputs.config);
  const lsCfg = inputs.layeredScoringConfig ?? DEFAULT_LAYERED_SCORING_CONFIG;

  const components: Record<string, number> = {};

  const structure = structureFromLayered(
    inputs.setup,
    inputs.snap,
    inputs.bias,
    inputs.regime,
    inputs.scoringWeights,
    inputs.indicatorConfig,
    components,
  );
  components['submodel.structure'] = structure;

  const scoreProfileFamily = getScoreProfileFamily(inputs.setup.setup_type);
  const timing = timingFromSignals(
    inputs.setup,
    inputs.extension,
    inputs.microstructure,
    inputs.lob,
    scoreProfileFamily,
    lsCfg,
    components,
  );
  components['submodel.timing'] = timing;

  const payoff = payoffFromPlanAndRoom(
    inputs.setup,
    inputs.snap,
    inputs.extension,
    inputs.rewardPlan,
    components,
  );
  components['submodel.payoff'] = payoff;

  // Phase 5 cluster caps (opt-in). When active, the composite is the
  // sum of per-cluster capped contributions, and the S/T/P submodel
  // values emitted in the result are RECOMPUTED as cluster-based views
  // so they stay consistent with the composite. When inactive, the
  // Phase 4 weighted-average composite is used unchanged.
  let structureOut = structure;
  let timingOut = timing;
  let payoffOut = payoff;
  let composite: number;

  if (cfg.cluster_caps_active) {
    const capped = applyClusterCaps(components, cfg.cluster_caps);
    // Record the capped cluster contributions so Phase 6 analysis can
    // audit exactly how much each cluster contributed per candidate.
    components['cluster.trend'] = capped.trend;
    components['cluster.structure'] = capped.structure;
    components['cluster.context'] = capped.context;
    components['cluster.timing'] = capped.timing;
    components['cluster.payoff'] = capped.payoff;
    components['cluster.flow'] = capped.flow;
    components['cluster.trend_cap'] = cfg.cluster_caps.trend;
    components['cluster.structure_cap'] = cfg.cluster_caps.structure;
    components['cluster.context_cap'] = cfg.cluster_caps.context;
    components['cluster.timing_cap'] = cfg.cluster_caps.timing;
    components['cluster.payoff_cap'] = cfg.cluster_caps.payoff;
    components['cluster.flow_cap'] = cfg.cluster_caps.flow;

    composite = clamp01(
      capped.trend + capped.structure + capped.context +
      capped.timing + capped.payoff + capped.flow,
    );

    // Recompute S/T/P as views consistent with the capped contributions.
    // Each view is the cluster sum for its family divided by the max
    // possible contribution from those clusters, giving a [0, 1] scalar
    // that Phase 6 can still interpret as "how much of Structure was
    // captured" etc.
    const sMax = cfg.cluster_caps.trend + cfg.cluster_caps.structure + cfg.cluster_caps.context;
    const tMax = cfg.cluster_caps.timing + cfg.cluster_caps.flow;
    const pMax = cfg.cluster_caps.payoff;
    structureOut = sMax > 0 ? clamp01((capped.trend + capped.structure + capped.context) / sMax) : 0;
    timingOut = tMax > 0 ? clamp01((capped.timing + capped.flow) / tMax) : 0;
    payoffOut = pMax > 0 ? clamp01(capped.payoff / pMax) : 0;

    components['submodel.structure'] = structureOut;
    components['submodel.timing'] = timingOut;
    components['submodel.payoff'] = payoffOut;
  } else {
    composite = clamp01(
      cfg.weights.structure * structure +
      cfg.weights.timing * timing +
      cfg.weights.payoff * payoff,
    );
  }

  const rank_100 = Math.round(100 * composite);

  components['composite.cluster_caps_active'] = cfg.cluster_caps_active ? 1 : 0;
  components['composite.weight_structure'] = cfg.weights.structure;
  components['composite.weight_timing'] = cfg.weights.timing;
  components['composite.weight_payoff'] = cfg.weights.payoff;
  components['composite.value'] = composite;

  return {
    structure: structureOut,
    timing: timingOut,
    payoff: payoffOut,
    composite,
    rank_100,
    components,
  };
}
