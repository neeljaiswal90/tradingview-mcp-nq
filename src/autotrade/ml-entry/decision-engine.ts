/**
 * ml-entry/decision-engine.ts — ML entry confirmation gate.
 *
 * Calls the entry inference service and returns a gated decision.
 * In confirm_only mode, rejects entries that fail ML quality threshold.
 * In rank_only mode, annotates but never blocks.
 */

import type { MarketSnapshot, CandidateSetup, MultiTfBias, MarketRegime } from '../types.js';
import type { LobSnapshot } from '../lob-client.js';
import type { EntryMlConfig, EntryMlResponse, EntryMlDecision, EntryFeatureVector } from './types.js';
import { buildEntryFeatures } from './feature-builder.js';

function classifyServiceFailure(status: number, detail: string | null): EntryMlDecision['bypass_code'] {
  const lower = (detail ?? '').toLowerCase();
  if (lower.includes('insufficient_data')) return 'insufficient_data';
  if (lower.includes('observational_only')) return 'observational_only';
  if (lower.includes('contract incompatible')) return 'contract_mismatch';
  if (lower.includes('no promoted artifact') || lower.includes('unavailable') || lower.includes('not found')) {
    return 'model_unavailable';
  }
  return 'service_http_error';
}

function classifyThrownError(err: unknown): EntryMlDecision['bypass_code'] {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout/i.test(msg)) {
    return 'timeout';
  }
  return 'network_error';
}

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
  htfEval?: CandidateSetup['htfEval'] | null,
): Promise<EntryMlDecision> {
  const features: EntryFeatureVector = buildEntryFeatures(
    setup,
    snap,
    bias,
    regime,
    confidence,
    dualScoreMargin,
    lobSnapshot,
    htfEval,
  );

  // Off: always confirm, but still return the exact payload for observational logging.
  if (config.mode === 'off') {
    return {
      confirmed: true,
      bypass_code: 'disabled',
      reason: 'entry_ml_disabled',
      response: null,
      request_payload: features,
      inference_ms: 0,
    };
  }

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
      let detail: string | null = null;
      try {
        const body = await res.json() as { detail?: string };
        detail = body.detail ?? null;
      } catch {
        detail = null;
      }
      const bypassCode = classifyServiceFailure(res.status, detail);
      const reason = detail ? `${bypassCode}:${detail}` : `${bypassCode}:http_${res.status}`;
      if (config.mode === 'confirm_only') {
        return {
          confirmed: false,
          bypass_code: bypassCode,
          reason,
          response: null,
          request_payload: features,
          inference_ms: elapsed,
        };
      }
      return {
        confirmed: true,
        bypass_code: bypassCode,
        reason,
        response: null,
        request_payload: features,
        inference_ms: elapsed,
      };
    }

    response = await res.json() as EntryMlResponse;
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    const bypassCode = classifyThrownError(err);
    if (config.mode === 'confirm_only') {
      return {
        confirmed: false,
        bypass_code: bypassCode,
        reason: `${bypassCode}:${msg}`,
        response: null,
        request_payload: features,
        inference_ms: elapsed,
      };
    }
    return {
      confirmed: true,
      bypass_code: bypassCode,
      reason: `${bypassCode}:${msg}`,
      response: null,
      request_payload: features,
      inference_ms: elapsed,
    };
  }

  const elapsed = Date.now() - t0;

  // rank_only: always confirm, just annotate
  if (config.mode === 'rank_only') {
    return {
      confirmed: true,
      bypass_code: 'rank_only_advisory',
      reason: `rank_only_advisory:quality=${response.entry_quality_prob?.toFixed(2)??'n/a'}:r=${response.expected_r?.toFixed(2)??'n/a'}`,
      response,
      request_payload: features,
      inference_ms: response.inference_ms ?? elapsed,
    };
  }

  // confirm_only: apply thresholds
  const confOk = response.confidence >= config.min_confirmation_confidence;
  const rOk = response.expected_r === null || response.expected_r >= config.min_expected_r;

  if (confOk && rOk) {
    return {
      confirmed: true,
      bypass_code: 'confirmed',
      reason: `ml_confirmed:conf=${response.confidence.toFixed(2)}:r=${response.expected_r?.toFixed(2)??'n/a'}`,
      response,
      request_payload: features,
      inference_ms: response.inference_ms ?? elapsed,
    };
  }

  const reasons: string[] = [];
  if (!confOk) reasons.push(`confidence_${response.confidence.toFixed(2)}_below_${config.min_confirmation_confidence}`);
  if (!rOk) reasons.push(`expected_r_${response.expected_r?.toFixed(2)??'null'}_below_${config.min_expected_r}`);

  return {
    confirmed: false,
    bypass_code: 'threshold_reject',
    reason: `ml_rejected:${reasons.join(';')}`,
    response,
    request_payload: features,
    inference_ms: response.inference_ms ?? elapsed,
  };
}
