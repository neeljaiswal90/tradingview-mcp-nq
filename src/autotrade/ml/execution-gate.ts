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

function getPositionAgeSec(pos: Position): number {
  return Math.floor((Date.now() - pos.entry_time_unix) / 1000);
}

function getInitialRiskPts(pos: Position): number {
  return Math.abs(pos.entry_price - pos.stop_initial);
}

export function evaluateMlGate(
  response: MlServiceResponse,
  config: MlManagementConfig,
  position: Position | null,
  quoteAgeMs: number,
  lastActionTimestamp?: number | null,
): MlGateResult {
  const checks: MlGateCheck[] = [];
  const action = response.action as ManagementAction;

  // ── Gate 0: Invalid risk geometry ─────────────────────────────────
  // Block all executable ML actions when initial risk is zero/invalid
  // to prevent NaN/Infinity in R calculations.
  if (position !== null) {
    const riskPts = getInitialRiskPts(position);
    const riskOk = riskPts > 0;
    checks.push({
      name: 'valid_risk_geometry',
      passed: riskOk,
      reason: riskOk
        ? `initial risk ${riskPts.toFixed(2)} pts > 0`
        : `initial risk ${riskPts.toFixed(2)} pts <= 0 — entry_price equals stop_initial`,
    });
    if (!riskOk) {
      return {
        approved: false,
        action: response.action,
        rejection_reason: 'invalid_risk_geometry',
        checks,
      };
    }
  }

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

  // ── Gate 8: Minimum hold time before EXIT_ALL ─────────────────────
  if (action === 'EXIT_ALL' && config.min_hold_seconds_before_ml_exit > 0 && position) {
    const holdTimeSec = (Date.now() - position.entry_time_unix) / 1000;
    const holdOk = holdTimeSec >= config.min_hold_seconds_before_ml_exit;
    checks.push({
      name: 'min_hold_time',
      passed: holdOk,
      reason: holdOk
        ? `hold time ${holdTimeSec.toFixed(0)}s >= ${config.min_hold_seconds_before_ml_exit}s minimum`
        : `hold time ${holdTimeSec.toFixed(0)}s < ${config.min_hold_seconds_before_ml_exit}s — trade too young for ML exit`,
    });
  }

  // ── Gate 8b: Minimum hold time before REDUCE ──────────────────────
  if (
    (action === 'EXIT_PARTIAL' || action === 'SCALE_OUT') &&
    config.min_hold_seconds_before_ml_reduce > 0 &&
    position
  ) {
    const holdTimeSec = getPositionAgeSec(position);
    const holdOk = holdTimeSec >= config.min_hold_seconds_before_ml_reduce;
    checks.push({
      name: 'min_hold_reduce',
      passed: holdOk,
      reason: holdOk
        ? `hold time ${holdTimeSec}s >= ${config.min_hold_seconds_before_ml_reduce}s minimum for reduce`
        : `hold time ${holdTimeSec}s < ${config.min_hold_seconds_before_ml_reduce}s — trade too young for ML reduce`,
    });
  }

  // ── Gate 8c: Early green trade block ──────────────────────────────
  if (action === 'EXIT_ALL' && position && config.early_phase_end_seconds > 0) {
    const ageSec = getPositionAgeSec(position);
    if (ageSec < config.early_phase_end_seconds) {
      const riskPts = getInitialRiskPts(position);
      const isShort = position.side === 'short';
      const pnlPts = isShort
        ? position.entry_price - position.last_checked_price
        : position.last_checked_price - position.entry_price;
      const unrealizedR = riskPts > 0 ? pnlPts / riskPts : 0;
      const greenOk = unrealizedR <= config.early_green_trade_exit_block_r;
      checks.push({
        name: 'early_green_block',
        passed: greenOk,
        reason: greenOk
          ? `unrealized_r ${unrealizedR.toFixed(3)} <= ${config.early_green_trade_exit_block_r} in early phase (${ageSec}s)`
          : `unrealized_r ${unrealizedR.toFixed(3)} > ${config.early_green_trade_exit_block_r} in early phase (${ageSec}s) — blocking tiny green exit`,
      });
    }
  }

  // ── Gate 8d: Runner protection ────────────────────────────────────
  if (action === 'EXIT_ALL' && position) {
    const ageSec = getPositionAgeSec(position);
    const riskPts = getInitialRiskPts(position);
    const isShort = position.side === 'short';
    const pnlPts = isShort
      ? position.entry_price - position.last_checked_price
      : position.last_checked_price - position.entry_price;
    const curR = riskPts > 0 ? pnlPts / riskPts : 0;
    const peakR = riskPts > 0 ? position.max_favorable_excursion / riskPts : 0;
    const drawdown = peakR - curR;
    const inRunnerPhase =
      ageSec >= config.runner_phase_min_seconds ||
      curR >= config.runner_trigger_r;

    if (inRunnerPhase) {
      const ddOk = drawdown >= config.runner_drawdown_from_peak_r;
      checks.push({
        name: 'runner_protection',
        passed: ddOk,
        reason: ddOk
          ? `drawdown ${drawdown.toFixed(3)} >= ${config.runner_drawdown_from_peak_r} — runner exit allowed`
          : `drawdown ${drawdown.toFixed(3)} < ${config.runner_drawdown_from_peak_r} — protecting runner`,
      });
    }
  }

  // ── Gate 9: Stop can only tighten ──────────────────────────────────
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
