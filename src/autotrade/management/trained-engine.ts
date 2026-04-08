/**
 * trained-engine.ts — Trained logistic regression probability engine.
 *
 * Implements ProbabilityModel using weights produced by scripts/train-pop-model.mjs.
 * Drop-in replacement for RulesProbabilityEngine.
 *
 * Feature vector (16 features, must match build-training-dataset.mjs / train-pop-model.mjs):
 *   geo_ratio_t1, geo_ratio_t2, current_r, mfe_r, mae_r,
 *   t1_dist_r, t2_dist_r, stop_dist_r, partial_exit_done, hold_seconds_norm,
 *   is_long, setup_trend_pullback, setup_breakout_retest, setup_failed_break,
 *   regime_trending_up, regime_trending_down
 */

import type { ProbabilityModel, ManagementFeatures, TradePoP } from './types.js';

// ─── Weight file schema ────────────────────────────────────────────────────────

interface SubModel {
  weights: number[];
  bias: number;
  val_auc?: number;
  val_log_loss?: number;
  val_brier?: number;
}

export interface TrainedModelWeights {
  schema_version: string;
  model_name: string;
  model_version: string;
  trained_at: string;
  feature_names: string[];
  feature_means: number[];
  feature_stds: number[];
  t1_model: SubModel;
  t2_model: SubModel;
  runner_model: SubModel;
  min_pop: number;
  max_pop: number;
}

const EXPECTED_FEATURES = [
  'geo_ratio_t1', 'geo_ratio_t2',
  'current_r', 'mfe_r', 'mae_r',
  't1_dist_r', 't2_dist_r', 'stop_dist_r',
  'partial_exit_done', 'hold_seconds_norm',
  'is_long',
  'setup_trend_pullback', 'setup_breakout_retest', 'setup_failed_break',
  'regime_trending_up', 'regime_trending_down',
] as const;

const N_FEATURES = EXPECTED_FEATURES.length;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ─── TrainedProbabilityEngine ─────────────────────────────────────────────────

export class TrainedProbabilityEngine implements ProbabilityModel {
  readonly name: string;
  readonly version: string;

  private readonly w: TrainedModelWeights;

  private constructor(weights: TrainedModelWeights) {
    this.w = weights;
    this.name = weights.model_name;
    this.version = weights.model_version;
  }

  /**
   * Construct from a parsed JSON object (e.g. JSON.parse(readFileSync(...))).
   * Throws a descriptive error if the weights file is malformed.
   */
  static fromJson(json: unknown): TrainedProbabilityEngine {
    if (!json || typeof json !== 'object') {
      throw new Error('TrainedProbabilityEngine: weights must be a non-null object');
    }
    const w = json as Record<string, unknown>;

    const required = ['schema_version', 'model_name', 'model_version', 'feature_names',
      'feature_means', 'feature_stds', 't1_model', 't2_model', 'runner_model', 'min_pop', 'max_pop'];
    for (const k of required) {
      if (!(k in w)) throw new Error(`TrainedProbabilityEngine: missing required field '${k}'`);
    }

    const names = w['feature_names'] as string[];
    const means = w['feature_means'] as number[];
    const stds = w['feature_stds'] as number[];

    if (!Array.isArray(names) || names.length !== N_FEATURES) {
      throw new Error(`TrainedProbabilityEngine: feature_names must be array of length ${N_FEATURES}, got ${Array.isArray(names) ? names.length : typeof names}`);
    }
    if (!Array.isArray(means) || means.length !== N_FEATURES) {
      throw new Error(`TrainedProbabilityEngine: feature_means length mismatch (expected ${N_FEATURES})`);
    }
    if (!Array.isArray(stds) || stds.length !== N_FEATURES) {
      throw new Error(`TrainedProbabilityEngine: feature_stds length mismatch (expected ${N_FEATURES})`);
    }

    for (const modelKey of ['t1_model', 't2_model', 'runner_model'] as const) {
      const m = w[modelKey] as Record<string, unknown>;
      if (!m || typeof m !== 'object') throw new Error(`TrainedProbabilityEngine: missing ${modelKey}`);
      if (!Array.isArray(m['weights']) || (m['weights'] as number[]).length !== N_FEATURES) {
        throw new Error(`TrainedProbabilityEngine: ${modelKey}.weights length mismatch (expected ${N_FEATURES})`);
      }
      if (typeof m['bias'] !== 'number') {
        throw new Error(`TrainedProbabilityEngine: ${modelKey}.bias must be a number`);
      }
    }

    return new TrainedProbabilityEngine(w as unknown as TrainedModelWeights);
  }

  // ─── ProbabilityModel interface ──────────────────────────────────────────────

  computePoP(f: ManagementFeatures): TradePoP {
    const fv = this.buildFeatureVector(f);

    let popT1 = this.predict(this.w.t1_model, fv);
    let popT2 = this.predict(this.w.t2_model, fv);
    let popRunner = this.predict(this.w.runner_model, fv);

    // Boundary overrides — if events have already occurred, PoP is 1.0
    if (f.partial_exit_done || f.pt1_done || f.distance_to_t1_pts <= 0) {
      popT1 = 1.0;
    }
    if (f.pt2_done || f.distance_to_t2_pts <= 0) {
      popT2 = 1.0;
    }

    // Clamp to [min_pop, max_pop]
    const minP = this.w.min_pop;
    const maxP = this.w.max_pop;
    const t1Final = popT1 === 1.0 ? 1.0 : clamp(popT1, minP, maxP);
    // Monotonicity: P(T2) ≤ P(T1)
    const t2Final = popT2 === 1.0 ? 1.0 : clamp(Math.min(popT2, popT1), minP, maxP);
    // Runner capped at 0.75 (runners are exceptional)
    const runnerFinal = clamp(popRunner, minP, 0.75);

    // Confidence: the trained model uses only geometric features; it does not
    // benefit from ADX/RSI/VWAP. Report 'medium' unless market context is absent.
    const confidence_in_estimate: TradePoP['confidence_in_estimate'] =
      f.distance_to_stop_pts <= 0 ? 'low' : 'medium';

    return {
      pop_target1_before_stop: round2(t1Final),
      pop_target2_before_stop: round2(t2Final),
      pop_runner_extension: round2(runnerFinal),
      model_name: this.name,
      model_version: this.version,
      confidence_in_estimate,
    };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  private buildFeatureVector(f: ManagementFeatures): number[] {
    const stopDist = Math.max(f.distance_to_stop_pts, 0.01);
    const t1dist = Math.max(f.distance_to_t1_pts, 0.01);
    const t2dist = Math.max(f.distance_to_t2_pts, 0.01);

    // Use stored initial_risk_pts for normalization (clean — no reconstruction needed)
    const safeRisk = Math.max(f.initial_risk_pts, 0.01);

    const raw: number[] = [
      stopDist / (stopDist + t1dist),                       // geo_ratio_t1
      stopDist / (stopDist + t2dist),                       // geo_ratio_t2
      f.current_r,                                           // current_r
      f.mfe_r,                                               // mfe_r
      f.mae_r,                                               // mae_r
      t1dist / safeRisk,                                     // t1_dist_r
      t2dist / safeRisk,                                     // t2_dist_r
      stopDist / safeRisk,                                   // stop_dist_r
      f.partial_exit_done ? 1 : 0,                           // partial_exit_done
      Math.log1p(f.hold_seconds) / Math.log1p(3600),        // hold_seconds_norm
      f.side === 'long' ? 1 : 0,                             // is_long
      f.setup_type.includes('pullback') ? 1 : 0,            // setup_trend_pullback
      f.setup_type.includes('breakout') ? 1 : 0,            // setup_breakout_retest
      (f.setup_type.includes('failed') || (f.setup_type.includes('break') && !f.setup_type.includes('breakout'))) ? 1 : 0, // setup_failed_break
      f.regime === 'trending_up' ? 1 : 0,                   // regime_trending_up
      f.regime === 'trending_down' ? 1 : 0,                 // regime_trending_down
    ];

    // z-score normalize using stored training statistics
    return raw.map((x, i) => {
      const mean = this.w.feature_means[i] ?? 0;
      const std = this.w.feature_stds[i] ?? 1;
      return (x - mean) / (std + 1e-8);
    });
  }

  private predict(model: SubModel, fv: number[]): number {
    let z = model.bias;
    for (let i = 0; i < fv.length; i++) {
      z += (model.weights[i] ?? 0) * (fv[i] ?? 0);
    }
    return sigmoid(z);
  }
}
