/**
 * lob-mbo-scalp-client.ts — Phase 4.5 TS HTTP client for the
 * `/predict_lob_mbo_scalp` endpoint served by python-ml-service.
 *
 * The scalper generator's ML placeholder hook (Phase 3b's
 * `mlPlaceholder` in strategies/lob-mbo-scalp.ts) calls
 * `getScalperMlDecision()` and treats the result as authoritative:
 *
 *   - `{ ready: true, pFavorDirection: <p>, ... }`
 *       The model is loaded, the feature payload passed, and
 *       `pFavorDirection` is a usable probability.
 *
 *   - `{ ready: false, reason: '<stable-key>' }`
 *       ANY failure. Network timeout, service down, loader cold,
 *       missing feature, invalid JSON — every error path returns
 *       ready=false with a stable reason string so downstream
 *       telemetry can bucket failures without string parsing.
 *
 * The client NEVER throws. Missing models, unreachable services,
 * malformed payloads, and abort-signal timeouts all flow through
 * the ready=false path. This matches the Python loader's contract.
 *
 * Design notes:
 *
 *   - The request payload shape matches
 *     `python-ml-service/schemas.py::LobMboScalpRequest`.
 *   - The response shape matches
 *     `python-ml-service/schemas.py::LobMboScalpResponse`.
 *   - Timeouts: configurable via `config.timeoutMs`, default 500ms
 *     (scalper budget is 200-500ms per generator cycle).
 *   - Reason strings from the service are passed through verbatim so
 *     the TS telemetry inherits the Python loader's stable vocabulary.
 *
 * For the Phase 4.5 parity test, see
 * `src/autotrade/features/scalper-inference.ts` which implements the
 * pure-TS inference formula as an independent reference. The tests at
 * `tests/unit/scalper-inference-parity.test.ts` compare it against the
 * Python loader's output on a shared fixture.
 */

import type { ScalperDirection } from '../features/scalper-state.js';

/** Horizons the scalper model serves — must match the trainer's TARGETS. */
export type ScalperHorizonSec = 1 | 3 | 5;

/**
 * Configuration passed to `getScalperMlDecision`. All fields optional with
 * production defaults. Callers typically thread this from a generator
 * options block so tests can override the endpoint URL.
 */
export interface ScalperMlClientConfig {
  /** Full URL to the Python ML service. Default: http://127.0.0.1:5001 */
  readonly baseUrl?: string;
  /** Request timeout in ms. Default: 500. */
  readonly timeoutMs?: number;
  /** Optional override for fetch — lets tests inject a mock. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Decision result returned by `getScalperMlDecision`. `ready === true`
 * means `pFavorDirection` is a usable probability; otherwise `reason`
 * carries a stable key and every other field is a safe default.
 *
 * The reason vocabulary mirrors the Python loader:
 *   - `loader_not_loaded:<detail>`    (cold service)
 *   - `missing_feature:<name>`        (feature dict missing a required key)
 *   - `null_feature:<name>`
 *   - `invalid_feature:<name>`
 *   - `non_finite_feature:<name>`
 *   - `invalid_direction:<value>`
 *   - `invalid_horizon_sec:<value>`
 * And TS-client-only reasons:
 *   - `http_error:<status>`           (5xx / 4xx response from service)
 *   - `network_error`                 (fetch threw / unreachable host)
 *   - `timeout`                       (AbortSignal fired)
 *   - `invalid_response_shape`        (service returned non-JSON or wrong keys)
 *   - `parse_error:<message>`         (JSON parse failed)
 */
export interface ScalperMlDecision {
  readonly ready: boolean;
  readonly pFavorDirection: number | null;
  readonly targetKey: string;
  readonly direction: ScalperDirection;
  readonly horizonSec: ScalperHorizonSec;
  readonly modelVersion: string;
  readonly featureSchema: readonly string[];
  readonly reason: string | null;
  readonly inferenceMs: number;
  readonly httpStatus: number | null;
}

/** Default client configuration constants. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:5001';
const DEFAULT_TIMEOUT_MS = 500;

/** Build a ready=false decision with a stable reason. Helper for every failure path. */
function failed(
  direction: ScalperDirection,
  horizonSec: ScalperHorizonSec,
  reason: string,
  httpStatus: number | null = null,
): ScalperMlDecision {
  return {
    ready: false,
    pFavorDirection: null,
    targetKey: `${direction}_${horizonSec}s`,
    direction,
    horizonSec,
    modelVersion: '',
    featureSchema: [],
    reason,
    inferenceMs: 0,
    httpStatus,
  };
}

/**
 * Validate a response body against the LobMboScalpResponse shape. Returns
 * null when the body is malformed — callers map that to an
 * `invalid_response_shape` reason.
 *
 * This is the only place the client trusts the wire payload, so the
 * check must reject silently-invalid bodies rather than hand a partial
 * object to the generator.
 */
function parseResponseBody(
  body: unknown,
  direction: ScalperDirection,
  horizonSec: ScalperHorizonSec,
  httpStatus: number,
): ScalperMlDecision | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as Record<string, unknown>;

  if (typeof r['ready'] !== 'boolean') return null;
  if (typeof r['target_key'] !== 'string') return null;
  if (typeof r['direction'] !== 'string') return null;
  if (typeof r['horizon_sec'] !== 'number') return null;
  if (typeof r['model_version'] !== 'string') return null;
  if (!Array.isArray(r['feature_schema'])) return null;
  if (r['reason'] !== null && typeof r['reason'] !== 'string') return null;
  if (typeof r['inference_ms'] !== 'number') return null;

  // p_favor_direction is number|null
  const p = r['p_favor_direction'];
  if (p !== null && (typeof p !== 'number' || !Number.isFinite(p))) return null;

  // featureSchema must be all strings
  const schema = r['feature_schema'] as unknown[];
  if (!schema.every((s) => typeof s === 'string')) return null;

  return {
    ready: r['ready'] as boolean,
    pFavorDirection: p as number | null,
    targetKey: r['target_key'] as string,
    direction,
    horizonSec,
    modelVersion: r['model_version'] as string,
    featureSchema: schema as string[],
    reason: (r['reason'] as string | null) ?? null,
    inferenceMs: r['inference_ms'] as number,
    httpStatus,
  };
}

/**
 * Score one (direction, horizonSec) pair against the Phase 4.5
 * `/predict_lob_mbo_scalp` endpoint.
 *
 * Never throws. Every error path returns a `ready: false` decision
 * with a stable `reason` string and a best-effort `httpStatus` when
 * the service did respond. Timeouts are enforced via AbortSignal.
 */
export async function getScalperMlDecision(
  direction: ScalperDirection,
  horizonSec: ScalperHorizonSec,
  features: Readonly<Record<string, number | null | undefined>>,
  config: ScalperMlClientConfig = {},
): Promise<ScalperMlDecision> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? fetch;

  if (direction !== 'long' && direction !== 'short') {
    return failed(direction, horizonSec, `invalid_direction:${String(direction)}`);
  }
  if (horizonSec !== 1 && horizonSec !== 3 && horizonSec !== 5) {
    return failed(direction, horizonSec, `invalid_horizon_sec:${String(horizonSec)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/predict_lob_mbo_scalp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direction,
        horizon_sec: horizonSec,
        features,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const name = err instanceof Error ? err.name : '';
    const msg = err instanceof Error ? err.message : String(err);
    if (name === 'AbortError' || /abort/i.test(msg)) {
      return failed(direction, horizonSec, 'timeout');
    }
    return failed(direction, horizonSec, `network_error:${name || 'unknown'}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    // The service returns HTTP 422 for Pydantic validation errors and
    // 200 (with ready=false) for every other failure mode. Anything
    // else is a genuine server error — map to http_error:<code>.
    return failed(direction, horizonSec, `http_error:${res.status}`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failed(direction, horizonSec, `parse_error:${msg}`, res.status);
  }

  const parsed = parseResponseBody(body, direction, horizonSec, res.status);
  if (parsed === null) {
    return failed(direction, horizonSec, 'invalid_response_shape', res.status);
  }
  return parsed;
}
