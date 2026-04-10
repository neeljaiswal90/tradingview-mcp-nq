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
  try {
    const res = await fetch(`${serviceUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json() as { status: string; model_loaded: boolean };
    return body.status === 'ok' && body.model_loaded === true;
  } catch {
    return false;
  }
}

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
