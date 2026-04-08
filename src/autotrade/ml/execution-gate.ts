/**
 * ml/execution-gate.ts — Hard execution gate for ML management actions.
 *
 * Every ML action must pass ALL gates before execution. The gates enforce
 * safety invariants that the ML model cannot override:
 *
 *   1. Feature enabled
 *   2. Position exists
 *   3. Action is executable (HOLD/NO_ACTION are passive)
 *   4. Action-specific feature flag (EXIT_PARTIAL requires enable_partial_exit)
 *   5. Confidence meets minimum threshold for the action type
 *   6. Quote is fresh enough for non-risk-reducing actions
 *   7. Action cooldown (if configured)
 *   8. Stop can only tighten, never widen
 *   9. Recommended stop price must be valid (if MOVE_STOP)
 *  10. Recommended size fraction must be valid (if EXIT_PARTIAL)
 */

import type { Position, ManagementAction } from '../types.js';
import { PASSIVE_ACTIONS, RISK_REDUCING_ACTIONS } from '../types.js';
import type {
  MlManagementConfig,
  MlServiceResponse,
  MlGateResult,
  MlGateCheck,
} from './types.js';

export function evaluateMlGate(
  response: MlServiceResponse,
  config: MlManagementConfig,
  position: Position | null,
  quoteAgeMs: number,
  lastActionTimestamp?: number | null,
): MlGateResult {
  const checks: MlGateCheck[] = [];
  const action = response.action as ManagementAction;

  // ── Gate 1: Feature enabled ────────────────────────────────────────
  checks.push({
    name: 'ml_enabled',
    passed: config.enabled,
    reason: config.enabled ? 'ML management enabled' : 'ML management disabled in config',
  });

  // ── Gate 2: Position exists ────────────────────────────────────────
  checks.push({
    name: 'position_exists',
    passed: position !== null,
    reason: position !== null ? 'Position open' : 'No open position',
  });

  // ── Gate 3: Action is executable ───────────────────────────────────
  const isPassive = (PASSIVE_ACTIONS as readonly string[]).includes(action);
  if (isPassive) {
    checks.push({
      name: 'action_is_passive',
      passed: false,
      reason: `${action} is passive — no execution needed`,
    });
    return {
      approved: false,
      action: response.action,
      rejection_reason: `${action} is passive`,
      checks,
    };
  }

  checks.push({
    name: 'action_is_executable',
    passed: true,
    reason: `${action} is an executable action`,
  });

  // ── Gate 4: Feature flag for EXIT_PARTIAL ──────────────────────────
  if (action === 'EXIT_PARTIAL') {
    const enabled = config.enable_partial_exit === true;
    checks.push({
      name: 'partial_exit_enabled',
      passed: enabled,
      reason: enabled
        ? 'EXIT_PARTIAL execution enabled'
        : 'EXIT_PARTIAL blocked by enable_partial_exit=false',
    });
  }

  // ── Gate 5: Confidence threshold ───────────────────────────────────
  let minConfidence: number;
  switch (action) {
    case 'EXIT_ALL':
      minConfidence = config.min_confidence_exit;
      break;
    case 'EXIT_PARTIAL':
    case 'SCALE_OUT':
      minConfidence = config.min_confidence_partial;
      break;
    case 'MOVE_STOP':
    case 'MOVE_TO_BREAKEVEN':
      minConfidence = config.min_confidence_stop_move;
      break;
    default:
      minConfidence = 1.0; // unknown actions blocked
  }

  const confOk = response.action_confidence >= minConfidence;
  checks.push({
    name: 'confidence_threshold',
    passed: confOk,
    reason: confOk
      ? `confidence ${response.action_confidence} >= ${minConfidence} for ${action}`
      : `confidence ${response.action_confidence} < ${minConfidence} required for ${action}`,
  });

  // ── Gate 6: Quote freshness ────────────────────────────────────────
  const isRiskReducing = (RISK_REDUCING_ACTIONS as readonly string[]).includes(action);
  const quoteOk = isRiskReducing || quoteAgeMs <= config.max_quote_age_ms;
  checks.push({
    name: 'quote_freshness',
    passed: quoteOk,
    reason: quoteOk
      ? isRiskReducing
        ? `${action} bypasses quote freshness (risk-reducing)`
        : `quote age ${quoteAgeMs}ms <= ${config.max_quote_age_ms}ms`
      : `quote age ${quoteAgeMs}ms > ${config.max_quote_age_ms}ms (stale)`,
  });

  // ── Gate 7: Action cooldown ────────────────────────────────────────
  if (config.action_cooldown_seconds > 0 && lastActionTimestamp != null) {
    const elapsed = (Date.now() - lastActionTimestamp) / 1000;
    const cooldownOk = elapsed >= config.action_cooldown_seconds;
    checks.push({
      name: 'action_cooldown',
      passed: cooldownOk,
      reason: cooldownOk
        ? `${elapsed.toFixed(0)}s since last action >= ${config.action_cooldown_seconds}s cooldown`
        : `${elapsed.toFixed(0)}s since last action < ${config.action_cooldown_seconds}s cooldown`,
    });
  }

  // ── Gate 8: Stop can only tighten ──────────────────────────────────
  if (action === 'MOVE_STOP' && response.recommended_stop_price !== null && position) {
    const isShort = position.side === 'short';
    const newStop = response.recommended_stop_price;
    const tightens = isShort ? newStop < position.stop_current : newStop > position.stop_current;
    checks.push({
      name: 'stop_only_tightens',
      passed: tightens,
      reason: tightens
        ? `new stop ${newStop} tightens from ${position.stop_current}`
        : `new stop ${newStop} would WIDEN from ${position.stop_current} — BLOCKED`,
    });
  }

  // ── Gate 9: Valid stop price ───────────────────────────────────────
  if (action === 'MOVE_STOP') {
    const hasPrice = response.recommended_stop_price !== null && response.recommended_stop_price > 0;
    checks.push({
      name: 'valid_stop_price',
      passed: hasPrice,
      reason: hasPrice
        ? `recommended stop price: ${response.recommended_stop_price}`
        : 'no valid recommended_stop_price provided',
    });
  }

  // ── Gate 10: Valid size fraction ───────────────────────────────────
  if (action === 'EXIT_PARTIAL') {
    const frac = response.recommended_size_fraction;
    const valid = frac !== null && frac > 0 && frac < 1;
    checks.push({
      name: 'valid_size_fraction',
      passed: valid,
      reason: valid
        ? `size fraction: ${frac}`
        : `invalid size fraction: ${frac}`,
    });
  }

  // ── Aggregate ──────────────────────────────────────────────────────
  const allPassed = checks.every(c => c.passed);
  const firstFailure = checks.find(c => !c.passed);

  return {
    approved: allPassed,
    action: response.action,
    rejection_reason: allPassed ? null : (firstFailure?.reason ?? 'unknown gate failure'),
    checks,
  };
}
