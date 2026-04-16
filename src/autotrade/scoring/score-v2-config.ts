/**
 * score-v2-config.ts — defaults and shape for the Phase 4 score-v2 system.
 *
 * Score v2 decomposes a candidate into three normalized submodels:
 *   Structure (S)  — thesis quality. trend alignment, HTF agreement,
 *                    swing structure, zone context, regime alignment.
 *   Timing (T)     — entry location, pullback depth, extension state,
 *                    short-term flow, microstructure, local confirmation.
 *   Payoff (P)     — room to target, obstacle before T1, realized RR,
 *                    adverse proximity.
 *
 * composite = clamp(w.structure*S + w.timing*T + w.payoff*P, 0, 1)
 * rank_100  = round(100 * composite)
 *
 * Phase 4 uses a simple linear composite. Phase 5 introduces cluster
 * caps inside computeScoreV2(). Phase 6 calibration determines whether
 * to promote score-v2 to drive execution — until then it is SHADOW ONLY.
 */

export interface ScoreV2Weights {
  structure: number;
  timing: number;
  payoff: number;
}

export interface ScoreV2ClusterCaps {
  trend: number;
  structure: number;
  context: number;
  timing: number;
  payoff: number;
  flow: number;
}

export interface ScoreV2Config {
  weights: ScoreV2Weights;
  /**
   * Phase 5 cluster caps. Present in the config so that Phase 5 can
   * enable them without schema churn. Phase 4 sets them but does not
   * apply them yet — `cluster_caps_active: false` in Phase 4 defaults.
   */
  cluster_caps: ScoreV2ClusterCaps;
  cluster_caps_active: boolean;
}

export const DEFAULT_SCORE_V2_CONFIG: Readonly<ScoreV2Config> = {
  weights: {
    structure: 0.45,
    timing: 0.35,
    payoff: 0.20,
  },
  cluster_caps: {
    trend: 0.30,
    structure: 0.25,
    context: 0.15,
    timing: 0.20,
    payoff: 0.20,
    flow: 0.15,
  },
  cluster_caps_active: false, // Phase 4: caps declared but inactive
};

/** Shallow-merge a user-supplied partial config over the defaults. */
export function mergeScoreV2Config(
  override?: Partial<ScoreV2Config>,
): ScoreV2Config {
  if (!override) return { ...DEFAULT_SCORE_V2_CONFIG };
  return {
    weights: { ...DEFAULT_SCORE_V2_CONFIG.weights, ...(override.weights ?? {}) },
    cluster_caps: { ...DEFAULT_SCORE_V2_CONFIG.cluster_caps, ...(override.cluster_caps ?? {}) },
    cluster_caps_active: override.cluster_caps_active ?? DEFAULT_SCORE_V2_CONFIG.cluster_caps_active,
  };
}
