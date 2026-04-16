/**
 * ml/decision-engine.ts — Orchestrates ML inference + gate evaluation.
 *
 * Calls the local FastAPI service, parses the response, and runs it
 * through the execution gate. Returns a structured MlDecisionResult that
 * includes the decision, the exact serialized request/response bodies,
 * and the feature vector for reproducible logging.
 */

import { randomUUID } from 'crypto';
import type { Position } from '../types.js';
import type { LobSnapshot } from '../lob-client.js';
import type {
  MlManagementConfig,
  MlFeatureVector,
  MlServiceResponse,
  MlDecision,
  MlDecisionResult,
  DecideActionInput,
  DecideActionResult,
  DevelopmentPhase,
} from './types.js';
import { buildMlFeatures } from './feature-builder.js';
import { evaluateMlGate } from './execution-gate.js';

/**
 * Call the ML service and return a gated decision with exact serialized payloads.
 *
 * @param pos - Current open position
 * @param currentPrice - Latest quote price
 * @param quoteAgeMs - Age of the quote in milliseconds
 * @param config - ML management config
 * @param lobSnapshot - Latest LOB snapshot (null if sidecar unavailable)
 * @returns MlDecisionResult with decision, serialized bodies, features, and request ID
 */
export async function getMlDecision(
  pos: Position,
  currentPrice: number,
  quoteAgeMs: number,
  config: MlManagementConfig,
  lobSnapshot?: LobSnapshot | null,
  lastMlActionTimestamp?: number | null,
): Promise<MlDecisionResult> {
  const requestId = randomUUID();
  const features = buildMlFeatures(pos, currentPrice, lobSnapshot);
  const serializedRequestBody = JSON.stringify(features);

  // Call the ML service
  let response: MlServiceResponse;
  let serializedResponseBody = '';
  const t0 = Date.now();
  try {
    const res = await fetch(`${config.service_url}/predict_management`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serializedRequestBody,
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      serializedResponseBody = body;
      const decision = makeErrorDecision(`ML service returned ${res.status}: ${body}`, Date.now() - t0);
      return {
        decision,
        serializedRequestBody,
        serializedResponseBody,
        features,
        requestId,
        requestLatencyMs: Date.now() - t0,
      };
    }

    serializedResponseBody = await res.text();
    response = JSON.parse(serializedResponseBody) as MlServiceResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const decision = makeErrorDecision(`ML service call failed: ${msg}`, Date.now() - t0);
    return {
      decision,
      serializedRequestBody,
      serializedResponseBody,
      features,
      requestId,
      requestLatencyMs: Date.now() - t0,
    };
  }

  const requestLatencyMs = Date.now() - t0;
  const inferenceMs = response.inference_ms ?? requestLatencyMs;
  const evaluatedAtIso = new Date().toISOString();

  // Run through execution gate (pass lastMlActionTimestamp for cooldown enforcement)
  const gateResult = evaluateMlGate(response, config, pos, quoteAgeMs, lastMlActionTimestamp);

  const decision: MlDecision = {
    action: gateResult.approved ? response.action : 'NO_ACTION',
    confidence: response.action_confidence,
    approved: gateResult.approved,
    rejection_reason: gateResult.rejection_reason,
    prob_hold: response.prob_hold,
    ev_hold_r: response.ev_hold_r,
    ev_exit_now_r: response.ev_exit_now_r,
    recommended_stop_price: response.recommended_stop_price,
    recommended_size_fraction: response.recommended_size_fraction,
    model_name: response.model_name,
    model_version: response.model_version,
    inference_ms: inferenceMs,
    evaluated_at_iso: evaluatedAtIso,
    gate_checks: gateResult.checks,
    notes: response.notes,
    tier_used: response.tier_used ?? null,
    // Use service-returned fallback_reason as the authoritative signal for fallback.
    // Deriving from tier_used !== 'tier3' was wrong: tier3 may not be the top tier
    // in all deployments, and the service explicitly signals fallback via this field.
    fallback_used: response.fallback_reason != null,
    fallback_reason: response.fallback_reason ?? null,
  };

  return {
    decision,
    serializedRequestBody,
    serializedResponseBody,
    features,
    requestId,
    requestLatencyMs,
  };
}

/**
 * Check if the ML service is reachable.
 */
export async function checkMlHealth(serviceUrl: string, timeoutMs: number = 2000): Promise<boolean> {
  const p = await probeMlManagementHealth(serviceUrl, timeoutMs);
  return p.ok && p.model_loaded;
}

/** Full /health probe for startup gating and version checks. */
export async function probeMlManagementHealth(
  serviceUrl: string,
  timeoutMs: number = 2000,
): Promise<{ ok: boolean; model_loaded: boolean; model_version: string; status: string }> {
  try {
    const res = await fetch(`${serviceUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, model_loaded: false, model_version: '', status: `http_${res.status}` };
    }
    const body = await res.json() as {
      status: string;
      model_loaded: boolean;
      model_version?: string;
    };
    const ok = body.status === 'ok';
    return {
      ok,
      model_loaded: body.model_loaded === true,
      model_version: typeof body.model_version === 'string' ? body.model_version : '',
      status: body.status,
    };
  } catch {
    return { ok: false, model_loaded: false, model_version: '', status: 'fetch_error' };
  }
}

// ─── Phase-Aware Decision Policy ────────────────────────────────────────────

/**
 * Phase-aware exit decision. Derives phase internally from age_sec, cur_r,
 * and config thresholds — callers do NOT pass a development_phase field.
 *
 * This is the live policy function. For training labels, use
 * computeTrainingDevelopmentPhase() which uses train_min_development_seconds.
 */
export function decideAction(
  input: DecideActionInput,
  cfg: MlManagementConfig,
): DecideActionResult {
  const pHold =
    cfg.use_probability_calibration && input.prob_hold_cal != null
      ? input.prob_hold_cal
      : input.prob_hold_raw;

  // ── Pre-check: minimum hold time ─────────────────────────────────────
  if (input.age_sec < cfg.min_hold_seconds_before_ml_exit) {
    return { action: 'HOLD', reason: 'min_hold', phase: 'EARLY' };
  }

  // ── EARLY phase ──────────────────────────────────────────────────────
  if (input.age_sec < cfg.early_phase_end_seconds) {
    if (input.cur_r > cfg.early_green_trade_exit_block_r) {
      return { action: 'HOLD', reason: 'early_green_block', phase: 'EARLY' };
    }
    if (
      pHold < cfg.exit_threshold_early &&
      input.confidence >= cfg.min_confidence_to_exit_early
    ) {
      return {
        action: 'EXIT_ALL',
        reason: 'early_exit_threshold',
        phase: 'EARLY',
        threshold_used: cfg.exit_threshold_early,
        prob_hold_used: pHold,
      };
    }
    return { action: 'HOLD', reason: 'early_hold', phase: 'EARLY' };
  }

  // ── RUNNER phase ─────────────────────────────────────────────────────
  const inRunnerPhase =
    input.age_sec >= cfg.runner_phase_min_seconds ||
    input.cur_r >= cfg.runner_trigger_r;

  if (inRunnerPhase) {
    if (input.drawdown_from_peak_r < cfg.runner_drawdown_from_peak_r) {
      return { action: 'HOLD', reason: 'runner_protection', phase: 'RUNNER' };
    }
    if (
      pHold < cfg.exit_threshold_runner &&
      input.confidence >= cfg.min_confidence_to_exit_runner
    ) {
      return {
        action: 'EXIT_ALL',
        reason: 'runner_exit_threshold',
        phase: 'RUNNER',
        threshold_used: cfg.exit_threshold_runner,
        prob_hold_used: pHold,
      };
    }
    return { action: 'HOLD', reason: 'runner_hold', phase: 'RUNNER' };
  }

  // ── ACTIVE phase (default) ───────────────────────────────────────────
  if (
    pHold < cfg.exit_threshold_active &&
    input.confidence >= cfg.min_confidence_to_exit_active
  ) {
    return {
      action: 'EXIT_ALL',
      reason: 'active_exit_threshold',
      phase: 'ACTIVE',
      threshold_used: cfg.exit_threshold_active,
      prob_hold_used: pHold,
    };
  }
  return { action: 'HOLD', reason: 'active_hold', phase: 'ACTIVE' };
}

/**
 * Compute development phase for TRAINING labels only.
 * Uses train_min_development_seconds for the EARLY threshold (differs from
 * the live early_phase_end_seconds). NOT used in live execution.
 */
export function computeTrainingDevelopmentPhase(
  ageSec: number,
  curR: number,
  cfg: MlManagementConfig,
): DevelopmentPhase {
  if (ageSec < cfg.train_min_development_seconds) return 'EARLY';
  if (
    ageSec >= cfg.runner_phase_min_seconds ||
    curR >= cfg.runner_trigger_r
  ) {
    return 'RUNNER';
  }
  return 'ACTIVE';
}

// ─── Error Helpers ──────────────────────────────────────────────────────────

function makeErrorDecision(reason: string, elapsedMs: number): MlDecision {
  return {
    action: 'NO_ACTION',
    confidence: 0,
    approved: false,
    rejection_reason: reason,
    prob_hold: null,
    ev_hold_r: null,
    ev_exit_now_r: null,
    recommended_stop_price: null,
    recommended_size_fraction: null,
    model_name: 'error',
    model_version: '',
    inference_ms: elapsedMs,
    evaluated_at_iso: new Date().toISOString(),
    gate_checks: [],
    notes: [reason],
    tier_used: null,
    fallback_used: false,
    fallback_reason: null,
  };
}
