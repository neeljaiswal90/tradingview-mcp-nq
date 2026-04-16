/**
 * execution-policy/engine.ts — Deterministic execution policy engine.
 *
 * Converts decision-layer outputs into microstructure-aware execution behavior.
 * Uses Bookmap/Rithmic features for short-horizon execution decisions.
 * Falls back safely when microstructure data is unavailable.
 *
 * Policy rules (deterministic, no ML in this layer):
 *
 *   1. Spread risk gate: block non-urgent execution when spread is wide
 *   2. Stale quote gate: block non-risk-reducing actions on stale data
 *   3. Action cooldown: prevent rapid-fire execution
 *   4. Scale limits: enforce max position size and scale-in flag
 *   5. Stop tightening only: never widen stops
 *   6. Urgency classification: immediate/normal/patient based on microstructure
 *   7. Timing: now/delay/cancel based on spread + liquidity
 */

import type { ManagementAction, Position } from '../types.js';
import { PASSIVE_ACTIONS, RISK_REDUCING_ACTIONS } from '../types.js';
import type { LobSnapshot } from '../lob-client.js';
import type {
  ExecutionPolicyConfig,
  ExecutionPolicyResult,
  ExecutionIntent,
  ExecutionUrgency,
  ExecutionTiming,
  MicrostructureInputs,
  PolicyCheck,
} from './types.js';

export class ExecutionPolicyEngine {
  private lastExecutionTs: number = 0;
  private lastScaleOutTs: number = 0;

  constructor(private readonly config: ExecutionPolicyConfig) {}

  /**
   * Evaluate an approved action and produce an execution intent.
   *
   * @param action - The approved action from the decision layer
   * @param position - Current open position
   * @param lobSnapshot - Latest LOB snapshot (null if unavailable)
   * @param quoteAgeMs - Age of the current quote in ms
   * @param requestedQty - Quantity to execute (for partials)
   * @param requestedStop - Stop price (for MOVE_STOP)
   */
  evaluate(
    action: ManagementAction,
    position: Position,
    lobSnapshot: LobSnapshot | null,
    quoteAgeMs: number,
    requestedQty?: number | null,
    requestedStop?: number | null,
  ): ExecutionPolicyResult {
    const checks: PolicyCheck[] = [];
    const reasons: string[] = [];

    // If policy is disabled, pass through
    if (!this.config.enabled) {
      return this.passThrough(action, lobSnapshot, quoteAgeMs, requestedQty, requestedStop);
    }

    // Passive actions never execute
    if ((PASSIVE_ACTIONS as readonly string[]).includes(action)) {
      return {
        intent: this.buildIntent(action, action, 'normal', 'cancel', null, null, ['passive_action'], lobSnapshot, quoteAgeMs),
        checks: [{ name: 'passive', passed: false, reason: `${action} is passive` }],
        should_execute: false,
        block_reason: `${action} is passive`,
        policy_verdict: 'rejected',
      };
    }

    // Build microstructure inputs
    const micro = this.extractMicro(lobSnapshot, quoteAgeMs);
    const isRiskReducing = (RISK_REDUCING_ACTIONS as readonly string[]).includes(action);

    // ── Check 1: Stale quote gate ────────────────────────────────────
    const quoteOk = isRiskReducing || quoteAgeMs <= this.config.max_quote_age_ms;
    checks.push({
      name: 'quote_freshness',
      passed: quoteOk,
      reason: quoteOk
        ? isRiskReducing ? `${action} bypasses (risk-reducing)` : `age ${quoteAgeMs}ms ok`
        : `age ${quoteAgeMs}ms > ${this.config.max_quote_age_ms}ms`,
    });

    // ── Check 2: Spread risk gate ────────────────────────────────────
    const spreadTicks = micro.spread_ticks;
    const urgency = this.classifyUrgency(action, position, micro);
    const maxSpread = urgency === 'immediate'
      ? this.config.max_spread_ticks_urgent
      : this.config.max_spread_ticks_normal;

    let spreadOk = true;
    if (spreadTicks !== null && !isRiskReducing) {
      spreadOk = spreadTicks <= maxSpread;
      checks.push({
        name: 'spread_risk',
        passed: spreadOk,
        reason: spreadOk
          ? `spread ${spreadTicks} ticks <= ${maxSpread} max`
          : `spread ${spreadTicks} ticks > ${maxSpread} max — too wide`,
      });
      if (!spreadOk) reasons.push(`spread_wide:${spreadTicks}tk`);
    } else if (spreadTicks !== null && isRiskReducing) {
      checks.push({
        name: 'spread_risk',
        passed: true,
        reason: `${action} bypasses spread gate (risk-reducing)`,
      });
    }

    // ── Check 3: Action cooldown ─────────────────────────────────────
    const now = Date.now();
    const sinceLastAction = (now - this.lastExecutionTs) / 1000;
    const cooldownOk = sinceLastAction >= this.config.action_cooldown_sec;
    checks.push({
      name: 'action_cooldown',
      passed: cooldownOk || isRiskReducing,
      reason: cooldownOk
        ? `${sinceLastAction.toFixed(0)}s since last action`
        : isRiskReducing
          ? `${action} bypasses cooldown (risk-reducing)`
          : `${sinceLastAction.toFixed(0)}s < ${this.config.action_cooldown_sec}s cooldown`,
    });

    // ── Check 4: Scale-out cooldown ──────────────────────────────────
    if (action === 'SCALE_OUT' || action === 'EXIT_PARTIAL') {
      const sinceScaleOut = (now - this.lastScaleOutTs) / 1000;
      const scaleOk = sinceScaleOut >= this.config.scale_out_cooldown_sec;
      checks.push({
        name: 'scale_out_cooldown',
        passed: scaleOk,
        reason: scaleOk
          ? `${sinceScaleOut.toFixed(0)}s since last scale-out`
          : `${sinceScaleOut.toFixed(0)}s < ${this.config.scale_out_cooldown_sec}s scale-out cooldown`,
      });
    }

    // ── Check 5: Scale-in eligibility ────────────────────────────────
    if (action === 'SCALE_IN') {
      const flagOk = this.config.enable_scale_in;
      checks.push({
        name: 'scale_in_enabled',
        passed: flagOk,
        reason: flagOk ? 'scale-in enabled' : 'scale-in disabled by config',
      });

      const sizeOk = (position.quantity_remaining + (requestedQty ?? 0)) <= this.config.max_position_size;
      checks.push({
        name: 'max_position_size',
        passed: sizeOk,
        reason: sizeOk
          ? `${position.quantity_remaining} + ${requestedQty ?? 0} <= ${this.config.max_position_size}`
          : `would exceed max_position_size ${this.config.max_position_size}`,
      });

      // Microstructure quality for scale-in: need fresh depth data
      const depthOk = micro.data_quality === 'full_depth' || micro.data_quality === 'bbo_only';
      checks.push({
        name: 'scale_in_data_quality',
        passed: depthOk,
        reason: depthOk ? `data_quality=${micro.data_quality}` : `insufficient data for scale-in: ${micro.data_quality}`,
      });
    }

    // ── Check 6: Stop only tightens ──────────────────────────────────
    if (action === 'MOVE_STOP' && requestedStop != null) {
      const isShort = position.side === 'short';
      const newStop = requestedStop;
      const tightens = isShort ? newStop < position.stop_current : newStop > position.stop_current;
      checks.push({
        name: 'stop_only_tightens',
        passed: tightens,
        reason: tightens
          ? `${newStop} tightens from ${position.stop_current}`
          : `${newStop} would WIDEN from ${position.stop_current}`,
      });
    }

    // ── Aggregate ────────────────────────────────────────────────────
    const allPassed = checks.every(c => c.passed);
    const firstFailure = checks.find(c => !c.passed);

    // Determine timing
    const timing = this.determineTiming(action, urgency, micro, allPassed);

    const intent = this.buildIntent(
      action,
      allPassed ? action : 'NO_ACTION',
      urgency,
      timing,
      requestedQty ?? null,
      requestedStop ?? null,
      allPassed ? reasons : [...reasons, firstFailure?.reason ?? 'policy_blocked'],
      lobSnapshot,
      quoteAgeMs,
    );

    return {
      intent,
      checks,
      should_execute: allPassed && timing === 'now',
      block_reason: allPassed ? null : (firstFailure?.reason ?? 'unknown'),
      policy_verdict: allPassed ? 'approved' : 'rejected',
    };
  }

  /** Record that an execution occurred (for cooldown tracking). */
  recordExecution(action: ManagementAction): void {
    this.lastExecutionTs = Date.now();
    if (action === 'SCALE_OUT' || action === 'EXIT_PARTIAL') {
      this.lastScaleOutTs = Date.now();
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private classifyUrgency(
    action: ManagementAction,
    position: Position,
    micro: MicrostructureInputs,
  ): ExecutionUrgency {
    // EXIT_ALL is always immediate
    if (action === 'EXIT_ALL') return 'immediate';

    // Sweep pressure = immediate
    if (micro.sweep_count_10s !== null && micro.sweep_count_10s >= 2) return 'immediate';

    // Aggressor penetration > 2 levels = immediate
    if (micro.aggressor_penetration_10s !== null && micro.aggressor_penetration_10s > 2) return 'immediate';

    // High cancel/add ratio (possible spoofing) = patient
    if (micro.cancel_add_ratio_10s !== null && micro.cancel_add_ratio_10s > 3.0) return 'patient';

    // Strong absorption = patient (level likely holds)
    if (micro.absorption_rate_10s !== null && micro.absorption_rate_10s > 0.8) return 'patient';

    return 'normal';
  }

  private determineTiming(
    action: ManagementAction,
    urgency: ExecutionUrgency,
    micro: MicrostructureInputs,
    checksPass: boolean,
  ): ExecutionTiming {
    if (!checksPass) return 'cancel';
    if (urgency === 'immediate') return 'now';

    // Wide spread + patient urgency = delay
    if (urgency === 'patient' && micro.spread_ticks !== null && micro.spread_ticks > 1) {
      return 'delay';
    }

    // Good replenishment = delay (level refilling, let it settle)
    if (micro.replenishment_rate_10s !== null && micro.replenishment_rate_10s > 1.5 && urgency === 'patient') {
      return 'delay';
    }

    return 'now';
  }

  private extractMicro(lob: LobSnapshot | null, quoteAgeMs: number): MicrostructureInputs {
    if (!lob || lob.data_quality === 'unavailable') {
      return {
        spread_ticks: null, bid_size: null, ask_size: null,
        depth_imbalance_5: null, aggressor_penetration_10s: null,
        sweep_count_10s: null, absorption_rate_10s: null,
        replenishment_rate_10s: null, cancel_add_ratio_10s: null,
        quote_age_ms: quoteAgeMs, data_quality: 'unavailable',
      };
    }
    return {
      spread_ticks: lob.spread_ticks,
      bid_size: lob.bid_size,
      ask_size: lob.ask_size,
      depth_imbalance_5: lob.depth_imbalance_5,
      aggressor_penetration_10s: lob.aggressor_penetration_10s ?? null,
      sweep_count_10s: lob.sweep_count_10s ?? null,
      absorption_rate_10s: lob.absorption_rate_10s ?? null,
      replenishment_rate_10s: lob.replenishment_rate_10s ?? null,
      cancel_add_ratio_10s: lob.cancel_add_ratio_10s ?? null,
      quote_age_ms: quoteAgeMs,
      data_quality: lob.data_quality,
    };
  }

  private buildIntent(
    source: ManagementAction, exec: ManagementAction,
    urgency: ExecutionUrgency, timing: ExecutionTiming,
    qty: number | null, stop: number | null,
    reasons: string[], lob: LobSnapshot | null, quoteAgeMs: number,
  ): ExecutionIntent {
    return {
      source_action: source,
      execution_action: exec,
      urgency,
      timing,
      quantity: qty,
      stop_price: stop,
      reasons,
      microstructure: this.extractMicro(lob, quoteAgeMs),
    };
  }

  private passThrough(
    action: ManagementAction, lob: LobSnapshot | null,
    quoteAgeMs: number, qty?: number | null, stop?: number | null,
  ): ExecutionPolicyResult {
    const isPassive = (PASSIVE_ACTIONS as readonly string[]).includes(action);
    return {
      intent: this.buildIntent(action, action, 'normal', isPassive ? 'cancel' : 'now', qty ?? null, stop ?? null, ['policy_not_enforced'], lob, quoteAgeMs),
      checks: [{ name: 'policy_not_enforced', passed: true, reason: 'execution policy not enabled — no checks applied' }],
      should_execute: !isPassive,
      block_reason: null,
      policy_verdict: 'not_enforced',
    };
  }
}
