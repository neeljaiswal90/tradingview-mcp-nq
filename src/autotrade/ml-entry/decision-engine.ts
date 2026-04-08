/**
 * ml-entry/decision-engine.ts — ML entry confirmation gate.
 *
 * Calls the entry inference service and returns a gated decision.
 * In confirm_only mode, rejects entries that fail ML quality threshold.
 * In rank_only mode, annotates but never blocks.
 */

import type { MarketSnapshot, CandidateSetup, MultiTfBias, MarketRegime } from '../types.js';
import type { LobSnapshot } from '../lob-client.js';
import type { EntryMlConfig, EntryMlResponse, EntryMlDecision } from './types.js';
import { buildEntryFeatures } from './feature-builder.js';

/**
 * Get ML entry confirmation for a candidate setup.
 *
 * Returns { confirmed: true } when:
 *   - mode is 'off' (no ML gating — always confirms)
 *   - mode is 'rank_only' (annotates but always confirms)
 *   - mode is 'confirm_only' AND ML confidence >= threshold AND expected_r >= threshold
 *
 * Returns { confirmed: false } when:
 *   - mode is 'confirm_only' AND ML rejects
 *   - service error in confirm_only mode (fail-safe: reject, not confirm)
 */
export async function getEntryMlDecision(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  bias: MultiTfBias,
  regime: MarketRegime,
  confidence: number,
  dualScoreMargin: number,
  config: EntryMlConfig,
  lobSnapshot?: LobSnapshot | null,
): Promise<EntryMlDecision> {
  // Off: always confirm
  if (config.mode === 'off') {
    return { confirmed: true, reason: 'entry_ml_off', response: null, inference_ms: 0 };
  }

  const features = buildEntryFeatures(setup, snap, bias, regime, confidence, dualScoreMargin, lobSnapshot);

  let response: EntryMlResponse;
  const t0 = Date.now();

  try {
    const res = await fetch(`${config.service_url}/predict_entry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(features),
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    if (!res.ok) {
      const elapsed = Date.now() - t0;
      if (config.mode === 'confirm_only') {
        return { confirmed: false, reason: `entry_ml_service_error:${res.status}`, response: null, inference_ms: elapsed };
      }
      return { confirmed: true, reason: `entry_ml_service_error_but_rank_only`, response: null, inference_ms: elapsed };
    }

    response = await res.json() as EntryMlResponse;
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    if (config.mode === 'confirm_only') {
      return { confirmed: false, reason: `entry_ml_error:${msg}`, response: null, inference_ms: elapsed };
    }
    return { confirmed: true, reason: `entry_ml_error_but_rank_only:${msg}`, response: null, inference_ms: elapsed };
  }

  const elapsed = Date.now() - t0;

  // rank_only: always confirm, just annotate
  if (config.mode === 'rank_only') {
    return {
      confirmed: true,
      reason: `rank_only:quality=${response.entry_quality_prob?.toFixed(2)??'n/a'}:r=${response.expected_r?.toFixed(2)??'n/a'}`,
      response,
      inference_ms: response.inference_ms ?? elapsed,
    };
  }

  // confirm_only: apply thresholds
  const confOk = response.confidence >= config.min_confirmation_confidence;
  const rOk = response.expected_r === null || response.expected_r >= config.min_expected_r;

  if (confOk && rOk) {
    return {
      confirmed: true,
      reason: `ml_confirmed:conf=${response.confidence.toFixed(2)}:r=${response.expected_r?.toFixed(2)??'n/a'}`,
      response,
      inference_ms: response.inference_ms ?? elapsed,
    };
  }

  const reasons: string[] = [];
  if (!confOk) reasons.push(`confidence_${response.confidence.toFixed(2)}_below_${config.min_confirmation_confidence}`);
  if (!rOk) reasons.push(`expected_r_${response.expected_r?.toFixed(2)??'null'}_below_${config.min_expected_r}`);

  return {
    confirmed: false,
    reason: `ml_rejected:${reasons.join(';')}`,
    response,
    inference_ms: response.inference_ms ?? elapsed,
  };
}
