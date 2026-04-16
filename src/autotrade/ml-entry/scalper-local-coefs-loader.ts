/**
 * ml-entry/scalper-local-coefs-loader.ts — Phase 6 TypeScript loader for the
 * six `{target}_coefs.json` artifacts produced by the Phase 4.4 trainer.
 *
 * Purpose: give the runner a SYNCHRONOUS, in-process ML decider for the
 * scalper family so the Phase 5 generator's `mlDecider` injection can be
 * satisfied without an HTTP round-trip on every tick.
 *
 * Why a TS loader in addition to the Python loader:
 *
 *   - Phase 4.5 built a Python-side loader (`python-ml-service/
 *     lob_mbo_scalp_loader.py`) + a TS-side pure-inference function
 *     (`src/autotrade/features/scalper-inference.ts::
 *     computeScalperLogisticInference`). The two are linked by the
 *     parity fixture test at `tests/unit/scalper-inference-parity.test.ts`.
 *
 *   - Phase 5 wired a sync `mlDecider` option on the scalper generator,
 *     but left the wiring stub. This loader closes the gap: at runner
 *     startup, resolve the model directory, parse all six coefs.json
 *     files, validate them, and expose a closure
 *     `buildScalperMlDecider(coefsSet)` that:
 *       (a) picks the coefs for the requested (direction, horizon),
 *       (b) calls `computeScalperLogisticInference(coefs, features)`,
 *       (c) wraps the result in a `ScalperMlDecision` that matches the
 *           HTTP client's shape.
 *
 *   - Zero HTTP, zero async, zero dependency on the Python service at
 *     live decision time. The Python `/predict_lob_mbo_scalp` endpoint
 *     stays available for offline verification and batch scoring but is
 *     not on the live path.
 *
 * Contract invariants (mirror of Python `lob_mbo_scalp_loader.py`):
 *
 *   1. ALL SIX coefs files must be present, parse-valid, schema-valid,
 *      and target-identity-valid. Any violation flips `loaded=false`.
 *   2. Per-target `feature_order` is preserved as-is.
 *   3. No silent defaults — missing features produce
 *      `missing_feature:<name>` reason strings from the pure inference
 *      function, which this module passes through verbatim into the
 *      `ScalperMlDecision.reason` field.
 *   4. Never throws. Callers inspect `status`.
 *
 * Resolution order at startup (matches Python loader):
 *
 *   1. `LOB_MBO_SCALP_MODEL_DIR` environment variable.
 *   2. `models/lob_mbo_scalp/promoted.json` (pointer file).
 *   3. Latest subdirectory under `models/lob_mbo_scalp/versions/`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import type { ScalperCoefs } from '../features/scalper-inference.js';
import { computeScalperLogisticInference } from '../features/scalper-inference.js';
import type { ScalperDirection } from '../features/scalper-state.js';
import type { ScalperHorizonSec } from '../features/scalper-expectancy-engine.js';
import type { ScalperMlDecision } from './lob-mbo-scalp-client.js';

// ─── Schema constants (must mirror trainer + Python loader) ────────────────

export const SCALPER_COEFS_SCHEMA_VERSION = '1.0';
export const SCALPER_EXPECTED_TARGETS: ReadonlyArray<{ direction: ScalperDirection; horizonSec: ScalperHorizonSec }> = [
  { direction: 'long', horizonSec: 1 },
  { direction: 'long', horizonSec: 3 },
  { direction: 'long', horizonSec: 5 },
  { direction: 'short', horizonSec: 1 },
  { direction: 'short', horizonSec: 3 },
  { direction: 'short', horizonSec: 5 },
];

function targetKey(direction: ScalperDirection, horizonSec: ScalperHorizonSec): string {
  return `${direction}_${horizonSec}s`;
}

// ─── Status + result types ─────────────────────────────────────────────────

export type ScalperCoefsLoaderStatus =
  | 'loaded'
  | 'model_dir_missing'
  | 'coefs_file_missing'
  | 'parse_error'
  | 'contract_violation';

export interface ScalperCoefsLoaderResult {
  status: ScalperCoefsLoaderStatus;
  modelDir: string | null;
  modelVersion: string;
  /** The six loaded coefs, keyed by target_key like 'long_3s'. Empty on any failure. */
  coefsByTargetKey: Record<string, ScalperCoefs>;
  detail: string;
  loadTimeMs: number;
}

// ─── Model directory resolution ────────────────────────────────────────────

/**
 * Walk the resolution chain and return the first directory that exists.
 * Returns null when nothing resolves. Pure — caller provides the repo
 * root so tests can point at fixtures under tmpdir.
 *
 * Resolution:
 *   1. LOB_MBO_SCALP_MODEL_DIR env var (absolute or relative to cwd).
 *   2. <repoRoot>/models/lob_mbo_scalp/promoted.json
 *   3. Latest lexicographic subdirectory under
 *      <repoRoot>/models/lob_mbo_scalp/versions/
 */
export function resolveScalperModelDir(repoRoot: string): string | null {
  // 1. env override
  const envDir = process.env['LOB_MBO_SCALP_MODEL_DIR'];
  if (envDir) {
    const p = isAbsolute(envDir) ? envDir : resolve(process.cwd(), envDir);
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }

  // 2. promoted.json pointer
  const promotedPath = join(repoRoot, 'models', 'lob_mbo_scalp', 'promoted.json');
  if (existsSync(promotedPath)) {
    try {
      const raw = readFileSync(promotedPath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        const candidate = join(repoRoot, 'models', 'lob_mbo_scalp', 'versions', parsed.version);
        if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
      }
    } catch {
      // fall through to step 3
    }
  }

  // 3. latest subdirectory fallback
  const versionsDir = join(repoRoot, 'models', 'lob_mbo_scalp', 'versions');
  if (existsSync(versionsDir) && statSync(versionsDir).isDirectory()) {
    const entries = readdirSync(versionsDir).filter((name) => {
      try {
        return statSync(join(versionsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
    if (entries.length > 0) {
      entries.sort();
      return join(versionsDir, entries[entries.length - 1]!);
    }
  }

  return null;
}

// ─── Coefs validation ──────────────────────────────────────────────────────

/**
 * Validate a parsed coefs.json against the serving contract. Throws
 * `Error` with a descriptive message on the first violation. Mirrors
 * the Python `validate_coefs_payload` logic one-to-one.
 */
function validateCoefsPayload(
  payload: unknown,
  expectedDirection: ScalperDirection,
  expectedHorizonSec: ScalperHorizonSec,
): ScalperCoefs {
  const expectedKey = targetKey(expectedDirection, expectedHorizonSec);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${expectedKey}: payload is not an object`);
  }
  const p = payload as Record<string, unknown>;

  if (p['schema_version'] !== SCALPER_COEFS_SCHEMA_VERSION) {
    throw new Error(`${expectedKey}: schema_version=${JSON.stringify(p['schema_version'])} != '${SCALPER_COEFS_SCHEMA_VERSION}'`);
  }
  if (p['target_key'] !== expectedKey) {
    throw new Error(`${expectedKey}: target_key=${JSON.stringify(p['target_key'])} != '${expectedKey}'`);
  }
  if (p['direction'] !== expectedDirection) {
    throw new Error(`${expectedKey}: direction=${JSON.stringify(p['direction'])} != '${expectedDirection}'`);
  }
  if (p['horizon_sec'] !== expectedHorizonSec) {
    throw new Error(`${expectedKey}: horizon_sec=${JSON.stringify(p['horizon_sec'])} != ${expectedHorizonSec}`);
  }
  const fo = p['feature_order'];
  if (!Array.isArray(fo) || fo.length === 0) {
    throw new Error(`${expectedKey}: feature_order missing or empty`);
  }
  for (const name of fo) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${expectedKey}: feature_order has non-string or empty entry`);
    }
  }
  const n = fo.length;
  for (const listName of ['scaler_mean', 'scaler_scale', 'coefficients'] as const) {
    const arr = p[listName];
    if (!Array.isArray(arr)) throw new Error(`${expectedKey}: ${listName} is not an array`);
    if (arr.length !== n) {
      throw new Error(`${expectedKey}: ${listName} length ${arr.length} != feature_order length ${n}`);
    }
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`${expectedKey}: ${listName}[${i}] non-finite: ${JSON.stringify(v)}`);
      }
    }
  }
  const intercept = p['intercept'];
  if (typeof intercept !== 'number' || !Number.isFinite(intercept)) {
    throw new Error(`${expectedKey}: intercept non-finite: ${JSON.stringify(intercept)}`);
  }

  return {
    schema_version: SCALPER_COEFS_SCHEMA_VERSION,
    target_key: expectedKey,
    direction: expectedDirection,
    horizon_sec: expectedHorizonSec,
    feature_order: fo as string[],
    scaler_mean: p['scaler_mean'] as number[],
    scaler_scale: p['scaler_scale'] as number[],
    intercept: intercept,
    coefficients: p['coefficients'] as number[],
  };
}

// ─── Main loader ───────────────────────────────────────────────────────────

/**
 * Load and validate all six scalper coefs artifacts from a model
 * directory. Never throws. Callers inspect `status` and use
 * `coefsByTargetKey` only when `status === 'loaded'`.
 *
 * On any failure (missing file, parse error, contract violation),
 * `coefsByTargetKey` is returned as an empty object — all-or-nothing
 * contract matching the Python loader.
 */
export function loadScalperCoefsFromDir(modelDir: string): ScalperCoefsLoaderResult {
  const t0 = Date.now();

  if (!existsSync(modelDir) || !statSync(modelDir).isDirectory()) {
    return {
      status: 'model_dir_missing',
      modelDir: null,
      modelVersion: '',
      coefsByTargetKey: {},
      detail: `Scalper model_dir not found: ${modelDir}`,
      loadTimeMs: Date.now() - t0,
    };
  }

  const out: Record<string, ScalperCoefs> = {};
  for (const { direction, horizonSec } of SCALPER_EXPECTED_TARGETS) {
    const key = targetKey(direction, horizonSec);
    const filePath = join(modelDir, `${key}_coefs.json`);
    if (!existsSync(filePath)) {
      return {
        status: 'coefs_file_missing',
        modelDir,
        modelVersion: '',
        coefsByTargetKey: {},
        detail: `missing coefs file: ${key}_coefs.json`,
        loadTimeMs: Date.now() - t0,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      return {
        status: 'parse_error',
        modelDir,
        modelVersion: '',
        coefsByTargetKey: {},
        detail: `${key}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
        loadTimeMs: Date.now() - t0,
      };
    }
    let coefs: ScalperCoefs;
    try {
      coefs = validateCoefsPayload(parsed, direction, horizonSec);
    } catch (err) {
      return {
        status: 'contract_violation',
        modelDir,
        modelVersion: '',
        coefsByTargetKey: {},
        detail: err instanceof Error ? err.message : String(err),
        loadTimeMs: Date.now() - t0,
      };
    }
    out[key] = coefs;
  }

  // Derive a model version string — prefer training_summary.written_at,
  // fall back to the trailing directory name. Never empty.
  let modelVersion = '';
  const summaryPath = join(modelDir, 'training_summary.json');
  if (existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
      const ver = summary['written_at'] ?? summary['schema_version'];
      if (typeof ver === 'string' && ver.length > 0) modelVersion = ver;
    } catch {
      // ignore; fall back below
    }
  }
  if (!modelVersion) {
    const parts = modelDir.split(/[\\/]/).filter((s) => s.length > 0);
    modelVersion = parts[parts.length - 1] ?? 'unknown';
  }

  return {
    status: 'loaded',
    modelDir,
    modelVersion,
    coefsByTargetKey: out,
    detail: `Loaded ${Object.keys(out).length} scalper coefs from ${modelDir}`,
    loadTimeMs: Date.now() - t0,
  };
}

// ─── ML decider closure ────────────────────────────────────────────────────

/**
 * Phase 8 bootstrap fallback version string. Any `ScalperMlDecision`
 * carrying this `modelVersion` is a sentinel from the no-artifacts
 * code path, NOT a real inference. Dashboards / audit tooling should
 * exclude rows with this version from AUC / calibration computations.
 */
export const SCALPER_BOOTSTRAP_NO_MODEL = 'bootstrap_no_model';

/**
 * Build a SYNC fallback `mlDecider` closure for the Phase 8 bootstrap
 * path. Used when no real coefs are loaded — the first-ever session,
 * before the trainer has run, or a session with stale / unreadable
 * artifacts.
 *
 * Every call returns `ready=false` with `reason='bootstrap_no_model'`
 * and `modelVersion='bootstrap_no_model'`. The Phase 5 shadow rule
 * consumes this as if the ML service were temporarily unavailable,
 * which lets the gate chain run end-to-end (deterministic + persistence
 * + expectancy) and WRITE candidate rows with honest telemetry.
 *
 * Why this exists: without it, the runner has to choose between (a)
 * refusing to register options at all — which makes the generator
 * emit `missing_shadow_config` on every cycle and skip the writer —
 * or (b) silently inventing a p-value, which Phase 5's "no silent
 * defaults" rule forbids. The fallback is the middle ground: the
 * ML gate is explicitly tagged as unavailable with a stable reason
 * string, the combined rule fails closed, but every OTHER verdict
 * (deterministic / persistence / expectancy) is real and writable.
 *
 * Tests in `tests/unit/scalper-local-coefs-loader.test.ts` lock the
 * sentinel contract. The runner in `runner.ts` uses this fallback
 * whenever `loadScalperCoefsFromDir` does not return `status='loaded'`.
 */
export function buildFallbackScalperMlDecider(): (
  direction: ScalperDirection,
  horizonSec: ScalperHorizonSec,
  features: Record<string, number | null | undefined>,
) => ScalperMlDecision {
  return (direction, horizonSec, _features) => ({
    ready: false,
    pFavorDirection: null,
    targetKey: targetKey(direction, horizonSec),
    direction,
    horizonSec,
    modelVersion: SCALPER_BOOTSTRAP_NO_MODEL,
    featureSchema: [],
    reason: SCALPER_BOOTSTRAP_NO_MODEL,
    inferenceMs: 0,
    httpStatus: null,
  });
}

/**
 * Build a SYNC `mlDecider` closure the Phase 5 scalper generator can
 * call on every tick. The closure captures a loaded `coefsByTargetKey`
 * map and a model version string for the resulting `ScalperMlDecision`.
 *
 * The closure:
 *   - Picks the coefs for the (direction, horizon) pair.
 *   - Calls `computeScalperLogisticInference` with the features dict.
 *   - Maps the result to the `ScalperMlDecision` shape the Phase 5
 *     shadow decision engine expects.
 *   - Passes the pure-inference `reason` string through verbatim on
 *     failure — matches the Python loader's vocabulary.
 *
 * Never throws. Missing coefs → `ready=false` with
 * `reason='target_not_loaded:<key>'`. Feature contract violations
 * (missing / null / non-finite) propagate through the pure inference
 * function's own reason strings.
 */
export function buildScalperMlDecider(params: {
  coefsByTargetKey: Record<string, ScalperCoefs>;
  modelVersion: string;
}): (
  direction: ScalperDirection,
  horizonSec: ScalperHorizonSec,
  features: Record<string, number | null | undefined>,
) => ScalperMlDecision {
  const { coefsByTargetKey, modelVersion } = params;

  return (direction, horizonSec, features) => {
    const start = Date.now();
    const key = targetKey(direction, horizonSec);
    const coefs = coefsByTargetKey[key];
    if (!coefs) {
      return {
        ready: false,
        pFavorDirection: null,
        targetKey: key,
        direction,
        horizonSec,
        modelVersion,
        featureSchema: [],
        reason: `target_not_loaded:${key}`,
        inferenceMs: Date.now() - start,
        httpStatus: null,
      };
    }
    const r = computeScalperLogisticInference(coefs, features);
    return {
      ready: r.ready,
      pFavorDirection: r.pFavorDirection,
      targetKey: key,
      direction,
      horizonSec,
      modelVersion,
      featureSchema: coefs.feature_order as string[],
      reason: r.reason,
      inferenceMs: Date.now() - start,
      httpStatus: null,
    };
  };
}
