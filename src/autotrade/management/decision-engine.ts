/**
 * decision-engine.ts — Combines PoP + EV to produce a management advisory.
 *
 * Expected Value model:
 *
 *   EV(hold) = P(T2) × pnl_at_t2 + P(runner) × pnl_at_runner
 *            + (1 - P(T2)) × pnl_at_stop
 *
 *   Where pnl values are in USD for the remaining quantity.
 *   We use a simplified two-outcome tree here (stop or T2).
 *
 *   EV(exit_now) = unrealized_pnl_usd  (lock in current mark-to-market)
 *
 *   EV(reduce_50pct) = 0.5 × unrealized_pnl_usd + 0.5 × EV(hold)
 *
 * Management state logic:
 *   HOLD       — EV(hold) ≥ EV(exit) + HOLD_EDGE_THRESHOLD
 *   REDUCE     — EV(reduce) > EV(hold) − REDUCE_THRESHOLD (capture some now)
 *   MOVE_STOP  — profitable position where stop can be tightened without exiting
 *   EXIT_NOW   — EV(exit) > EV(hold), or pop is collapsing, or time pressure
 *
 * Hard constraint: this engine never overrides the hard stop in position-manager.ts.
 * The stop-loss price is fixed; this layer only advises on discretionary actions.
 */

import type { ContractSpec } from '../contracts.js';
import type { ManagementFeatures, TradePoP, ManagementMetrics, ManagementState, ProbabilityModel } from './types.js';
import { RulesProbabilityEngine } from './probability-engine.js';

// ── Thresholds (all in USD) ──────────────────────────────────────────────────
const HOLD_EDGE_THRESHOLD_USD = 5;  // Hold unless exit is better by this much
const REDUCE_THRESHOLD_USD = 3;     // Suggest reducing if it beats hold by this

// ── Urgency multipliers ──────────────────────────────────────────────────────
const TIME_STOP_URGENCY_SECS = 120; // < 2min remaining = flag urgency
const LOW_POP_THRESHOLD = 0.30;     // PoP below this = advisory concerns

export class ManagementDecisionEngine {
  private readonly model: ProbabilityModel;

  constructor(
    private readonly contract: ContractSpec,
    model?: ProbabilityModel,
  ) {
    this.model = model ?? new RulesProbabilityEngine();
  }

  /**
   * Evaluate the active trade and produce a full ManagementMetrics snapshot.
   * Call every monitor cycle immediately after quote validation.
   *
   * @param features   Built by feature-builder.ts
   */
  evaluate(features: ManagementFeatures): ManagementMetrics {
    const pop = this.model.computePoP(features);
    const unrealized_pnl_usd = this.computeUnrealizedPnlUsd(features);
    const expected_value_hold_usd = this.computeEvHold(features, pop);
    const expected_value_exit_now_usd = unrealized_pnl_usd;
    const expected_value_reduce_usd =
      0.5 * unrealized_pnl_usd + 0.5 * expected_value_hold_usd;
    const ev_hold_vs_exit_delta = expected_value_hold_usd - expected_value_exit_now_usd;

    const { state, reason, factors } = this.determineState(
      features,
      pop,
      unrealized_pnl_usd,
      ev_hold_vs_exit_delta,
      expected_value_reduce_usd,
    );

    return {
      features,
      pop,
      unrealized_pnl_usd: Math.round(unrealized_pnl_usd * 100) / 100,
      expected_value_hold_usd: Math.round(expected_value_hold_usd * 100) / 100,
      expected_value_exit_now_usd: Math.round(expected_value_exit_now_usd * 100) / 100,
      expected_value_reduce_usd: Math.round(expected_value_reduce_usd * 100) / 100,
      ev_hold_vs_exit_delta: Math.round(ev_hold_vs_exit_delta * 100) / 100,
      management_state: state,
      management_state_reason: reason,
      decision_factors: factors,
      timestamp_iso: new Date().toISOString(),
    };
  }

  // ── EV helpers ──────────────────────────────────────────────────────────────

  private computeUnrealizedPnlUsd(f: ManagementFeatures): number {
    return f.unrealized_pnl_pts * f.quantity_remaining * this.contract.point_value;
  }

  private computeEvHold(f: ManagementFeatures, pop: TradePoP): number {
    const pv = this.contract.point_value;
    const qty = f.quantity_remaining;
    const isLong = f.side === 'long';

    // Payoffs at each scenario (from current price, for remaining qty)
    const pnlAtStop =
      (isLong ? -f.distance_to_stop_pts : -f.distance_to_stop_pts) * qty * pv;
    // distance_to_stop_pts is positive when price is above stop (for long),
    // so at stop we lose distance_to_stop_pts worth of points
    const pnlIfStopHit = -Math.abs(f.distance_to_stop_pts) * qty * pv;

    const pnlIfT2Hit = Math.abs(f.distance_to_t2_pts) * qty * pv;

    // Runner payoff: approximate as 50% beyond T2 (T2 distance extra)
    const pnlIfRunnerHit = (Math.abs(f.distance_to_t2_pts) * 1.5) * qty * pv;

    // Two-stage tree:
    // P(reaches T2) × pnl_t2 + P(runner) × runner_bonus + (1−P(T2)) × pnl_stop
    const ev =
      pop.pop_target2_before_stop * pnlIfT2Hit +
      pop.pop_runner_extension * (pnlIfRunnerHit - pnlIfT2Hit) + // marginal runner bonus
      (1 - pop.pop_target2_before_stop) * pnlIfStopHit;

    return ev;
  }

  // ── State determination ─────────────────────────────────────────────────────

  private determineState(
    f: ManagementFeatures,
    pop: TradePoP,
    unrealizedPnl: number,
    evDelta: number,
    evReduce: number,
  ): { state: ManagementState; reason: string; factors: string[] } {
    const factors: string[] = [];

    // ── Hard-constraint pass-through checks ───────────────────────────────
    // These don't override the position manager's hard stop — they flag it
    // in the advisory log so operators can verify behavior.
    if (f.distance_to_stop_pts <= 0) {
      return {
        state: 'EXIT_NOW',
        reason: 'Stop price breached — hard stop should have triggered',
        factors: ['stop_breached'],
      };
    }

    // ── Time pressure ──────────────────────────────────────────────────────
    if (
      f.time_stop_remaining_seconds > 0 &&
      f.time_stop_remaining_seconds < TIME_STOP_URGENCY_SECS &&
      f.current_r < 0.5
    ) {
      factors.push(`time_stop_imminent(${f.time_stop_remaining_seconds}s)`);
    }

    // ── PoP collapse signals ────────────────────────────────────────────────
    if (pop.pop_target1_before_stop < LOW_POP_THRESHOLD) {
      factors.push(`low_pop_t1(${pop.pop_target1_before_stop})`);
    }

    // ── Regime deterioration ─────────────────────────────────────────────
    if (
      f.regime !== null &&
      (f.regime === 'choppy' || f.regime === 'high_volatility_impulse')
    ) {
      factors.push(`adverse_regime(${f.regime})`);
    }

    // ── EV comparison ────────────────────────────────────────────────────────
    if (evDelta > HOLD_EDGE_THRESHOLD_USD) {
      factors.push(`ev_hold_better(+$${evDelta.toFixed(0)})`);
    } else if (evDelta < -HOLD_EDGE_THRESHOLD_USD) {
      factors.push(`ev_exit_better($${Math.abs(evDelta).toFixed(0)})`);
    } else {
      factors.push('ev_near_neutral');
    }

    // ── Determine state ─────────────────────────────────────────────────────

    // EXIT_NOW: EV clearly favors exit, or PoP has collapsed on a winning trade
    if (evDelta < -HOLD_EDGE_THRESHOLD_USD) {
      return {
        state: 'EXIT_NOW',
        reason: `EV(exit)=$${(-evDelta + unrealizedPnl).toFixed(0)} > EV(hold) by $${Math.abs(evDelta).toFixed(0)}`,
        factors,
      };
    }
    if (
      pop.pop_target1_before_stop < LOW_POP_THRESHOLD &&
      unrealizedPnl > 0
    ) {
      return {
        state: 'EXIT_NOW',
        reason: `PoP(T1)=${pop.pop_target1_before_stop} is low while trade is profitable — protect gains`,
        factors,
      };
    }
    if (
      f.time_stop_remaining_seconds > 0 &&
      f.time_stop_remaining_seconds < TIME_STOP_URGENCY_SECS &&
      f.current_r < 0.3
    ) {
      return {
        state: 'EXIT_NOW',
        reason: `Time stop imminent (${f.time_stop_remaining_seconds}s) with trade near flat`,
        factors,
      };
    }

    // MOVE_STOP: trade is solidly profitable but stop hasn't been moved to maximize protection
    if (
      f.current_r >= 0.5 &&
      !f.partial_exit_done &&
      !f.pt1_done &&
      f.distance_to_stop_pts > f.distance_to_t1_pts * 0.5 // stop still far behind
    ) {
      return {
        state: 'MOVE_STOP',
        reason: `Trade at ${f.current_r.toFixed(2)}R — consider moving stop to breakeven`,
        factors: [...factors, 'stop_not_at_be'],
      };
    }

    // REDUCE: EV(reduce) is meaningfully better than EV(hold), or PoP concerns
    // but trade is in profit (lock in some)
    if (
      evReduce > unrealizedPnl * 0.8 && // reduce locks in at least 80% of current mark
      pop.pop_target1_before_stop < 0.45 &&
      unrealizedPnl > 0
    ) {
      return {
        state: 'REDUCE',
        reason: `PoP(T1)=${pop.pop_target1_before_stop} low — reducing captures $${(unrealizedPnl * 0.5).toFixed(0)} while holding runner`,
        factors: [...factors, 'pop_below_threshold'],
      };
    }

    // HOLD: default when no adverse signals dominate
    const holdReason = factors.includes(`ev_hold_better(+$${Math.round(evDelta)}`)
      ? `EV(hold) exceeds EV(exit) by $${evDelta.toFixed(0)}`
      : `PoP(T1)=${pop.pop_target1_before_stop}, PoP(T2)=${pop.pop_target2_before_stop} — maintain position`;
    return {
      state: 'HOLD',
      reason: holdReason,
      factors,
    };
  }
}
