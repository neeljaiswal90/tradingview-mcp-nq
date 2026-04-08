/**
 * ml/decision-engine.ts — Orchestrates ML inference + gate evaluation.
 *
 * Calls the local FastAPI service, parses the response, and runs it
 * through the execution gate. Returns a structured MlDecision that
 * the runner can act on (or log and ignore).
 */

import type { Position } from '../types.js';
import type { LobSnapshot } from '../lob-client.js';
import type {
  MlManagementConfig,
  MlFeatureVector,
  MlServiceResponse,
  MlDecision,
} from './types.js';
import { buildMlFeatures } from './feature-builder.js';
import { evaluateMlGate } from './execution-gate.js';

/**
 * Call the ML service and return a gated decision.
 *
 * @param pos - Current open position
 * @param currentPrice - Latest quote price
 * @param quoteAgeMs - Age of the quote in milliseconds
 * @param config - ML management config
 * @param lobSnapshot - Latest LOB snapshot (null if sidecar unavailable)
 * @returns MlDecision with action, confidence, gate result, and notes
 */
export async function getMlDecision(
  pos: Position,
  currentPrice: number,
  quoteAgeMs: number,
  config: MlManagementConfig,
  lobSnapshot?: LobSnapshot | null,
): Promise<MlDecision> {
  const features = buildMlFeatures(pos, currentPrice, lobSnapshot);

  // Call the ML service
  let response: MlServiceResponse;
  const t0 = Date.now();
  try {
    const res = await fetch(`${config.service_url}/predict_management`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(features),
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return makeErrorDecision(`ML service returned ${res.status}: ${body}`, Date.now() - t0);
    }

    response = await res.json() as MlServiceResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeErrorDecision(`ML service call failed: ${msg}`, Date.now() - t0);
  }

  const inferenceMs = response.inference_ms ?? (Date.now() - t0);

  // Run through execution gate
  const gateResult = evaluateMlGate(response, config, pos, quoteAgeMs);

  return {
    action: gateResult.approved ? response.action : 'NO_ACTION',
    confidence: response.action_confidence,
    approved: gateResult.approved,
    rejection_reason: gateResult.rejection_reason,
    prob_hold: response.prob_hold,
    ev_hold_r: response.ev_hold_r,
    recommended_stop_price: response.recommended_stop_price,
    recommended_size_fraction: response.recommended_size_fraction,
    model_name: response.model_name,
    inference_ms: inferenceMs,
    gate_checks: gateResult.checks,
    notes: response.notes,
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
    recommended_stop_price: null,
    recommended_size_fraction: null,
    model_name: 'error',
    inference_ms: elapsedMs,
    gate_checks: [],
    notes: [reason],
  };
}
