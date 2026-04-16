/**
 * scalper-inference.ts — TypeScript mirror of the Python logistic inference
 * path in python-ml-service/lob_mbo_scalp_loader.py.
 *
 * Used for two purposes:
 *
 *   1. Phase 4.5 parity test. The TS math here is an independent
 *      implementation of the same formula as the Python loader. The
 *      parity test (tests/unit/scalper-inference-parity.test.ts) feeds
 *      the SAME fixture coefs + features to both and asserts the
 *      returned probabilities match to within 1e-12. That catches any
 *      drift between the two languages' interpretations of the trained
 *      model artifact.
 *
 *   2. Future local-inference fast path. Today the Phase 4.5 TS client
 *      (`src/autotrade/ml-entry/lob-mbo-scalp-client.ts`) calls the
 *      Python `/predict_lob_mbo_scalp` endpoint over HTTP. If a later
 *      phase wants to move inference into the TS process for sub-
 *      millisecond latency, it can swap the HTTP call for a direct call
 *      to `computeScalperLogisticInference()` without touching any
 *      other code. Having the formula in two places DOES force us to
 *      keep them in lockstep — that is what the parity test exists
 *      to enforce.
 *
 * Keep this file in sync with python-ml-service/lob_mbo_scalp_loader.py::
 * compute_scalper_logistic_inference. Any change to the formula or the
 * validation order must be mirrored in both languages AND the parity
 * test updated.
 */

/** Artifact shape produced by the Phase 4.4 trainer's `{target}_coefs.json`. */
export interface ScalperCoefs {
  readonly schema_version: string;
  readonly target_key: string;
  readonly direction: 'long' | 'short';
  readonly horizon_sec: number;
  readonly feature_order: readonly string[];
  readonly scaler_mean: readonly number[];
  readonly scaler_scale: readonly number[];
  readonly intercept: number;
  readonly coefficients: readonly number[];
}

/** Input feature payload — a flat dict of scalar values keyed by feature name. */
export type ScalperFeatureDict = Readonly<Record<string, number | null | undefined>>;

/** Result of a pure-TS inference attempt. */
export interface ScalperInferenceResult {
  /** True only when the formula produced a valid probability. */
  readonly ready: boolean;
  /** The computed probability, or null on any failure. */
  readonly pFavorDirection: number | null;
  /**
   * Stable reason string when `ready === false`. Matches the Python
   * loader's reason vocabulary one-to-one so telemetry can merge the
   * two implementations without special-casing.
   */
  readonly reason: string | null;
}

/** Small epsilon matching the Python SCALER_EPSILON constant. */
const SCALER_EPSILON = 1e-12;

/**
 * Numerically stable sigmoid. Mirrors the Python `_sigmoid` helper so
 * both implementations handle the same edge cases identically for
 * extreme logits.
 */
function sigmoid(logit: number): number {
  if (logit >= 0) {
    return 1 / (1 + Math.exp(-logit));
  }
  const e = Math.exp(logit);
  return e / (1 + e);
}

/**
 * Project a feature dict onto the model's feature_order, scale each
 * value by (x - mean) / max(scale, eps), compute the logit, and return
 * the sigmoid probability.
 *
 * Mirrors the Python `compute_scalper_logistic_inference` line for line:
 *
 *   - Required feature missing           → ready=false, reason='missing_feature:NAME'
 *   - Required feature is null/undefined → ready=false, reason='null_feature:NAME'
 *   - Required feature is non-numeric    → ready=false, reason='invalid_feature:NAME'
 *   - Required feature is non-finite     → ready=false, reason='non_finite_feature:NAME'
 *
 * The function NEVER throws — every error path returns a structured
 * ScalperInferenceResult. The caller reads `result.ready` to decide
 * whether `pFavorDirection` is usable.
 */
export function computeScalperLogisticInference(
  coefs: ScalperCoefs,
  features: ScalperFeatureDict,
): ScalperInferenceResult {
  // Shape sanity — the coefs object must be well-formed before we
  // dereference anything. This is the same defense the Python loader
  // does in `validate_coefs_payload` at load time; the TS mirror
  // repeats it so a hand-rolled coefs blob (from tests or a future
  // local fallback path) gets the same guarantees.
  if (!coefs || typeof coefs !== 'object') {
    return { ready: false, pFavorDirection: null, reason: 'coefs_not_object' };
  }
  const { feature_order, scaler_mean, scaler_scale, intercept, coefficients } = coefs;
  if (!Array.isArray(feature_order) || feature_order.length === 0) {
    return { ready: false, pFavorDirection: null, reason: 'feature_order_missing_or_empty' };
  }
  const n = feature_order.length;
  if (!Array.isArray(scaler_mean) || scaler_mean.length !== n) {
    return { ready: false, pFavorDirection: null, reason: 'scaler_mean_length_mismatch' };
  }
  if (!Array.isArray(scaler_scale) || scaler_scale.length !== n) {
    return { ready: false, pFavorDirection: null, reason: 'scaler_scale_length_mismatch' };
  }
  if (!Array.isArray(coefficients) || coefficients.length !== n) {
    return { ready: false, pFavorDirection: null, reason: 'coefficients_length_mismatch' };
  }
  if (typeof intercept !== 'number' || !Number.isFinite(intercept)) {
    return { ready: false, pFavorDirection: null, reason: 'intercept_non_finite' };
  }

  if (!features || typeof features !== 'object') {
    return { ready: false, pFavorDirection: null, reason: 'features_not_dict' };
  }

  let logit = intercept;

  for (let i = 0; i < n; i++) {
    const name = feature_order[i]!;
    if (!(name in features)) {
      return { ready: false, pFavorDirection: null, reason: `missing_feature:${name}` };
    }
    const raw = features[name];
    if (raw === null || raw === undefined) {
      return { ready: false, pFavorDirection: null, reason: `null_feature:${name}` };
    }
    // Match Python's `float(raw)` conversion semantics: accept numbers
    // and numeric strings, reject non-numeric strings/objects.
    let x: number;
    if (typeof raw === 'number') {
      x = raw;
    } else if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) {
        return { ready: false, pFavorDirection: null, reason: `invalid_feature:${name}` };
      }
      x = parsed;
    } else {
      return { ready: false, pFavorDirection: null, reason: `invalid_feature:${name}` };
    }
    if (!Number.isFinite(x)) {
      return { ready: false, pFavorDirection: null, reason: `non_finite_feature:${name}` };
    }

    const mean = scaler_mean[i]!;
    let scale = scaler_scale[i]!;
    if (typeof mean !== 'number' || !Number.isFinite(mean)) {
      return { ready: false, pFavorDirection: null, reason: `scaler_mean_non_finite:${name}` };
    }
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale === 0) {
      scale = SCALER_EPSILON;
    }
    const coef = coefficients[i]!;
    if (typeof coef !== 'number' || !Number.isFinite(coef)) {
      return { ready: false, pFavorDirection: null, reason: `coefficient_non_finite:${name}` };
    }

    const z = (x - mean) / scale;
    logit += coef * z;
  }

  const p = sigmoid(logit);
  return { ready: true, pFavorDirection: p, reason: null };
}
