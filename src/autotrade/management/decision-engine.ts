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
import type {
  ManagementFeatures,
  TradePoP,
  ManagementMetrics,
  ManagementState,
  ProbabilityModel,
  ManagementTargetPositionSnapshot,
} from './types.js';
import { RulesProbabilityEngine } from './probability-engine.js';
import {
  computeTargetPosition,
  describeTargetAction,
  logTargetPositionDecision,
  type PositionTargetConfig,
  type TargetPositionContext,
  type TargetPositionResult,
} from '../target-position.js';

// ── Thresholds (all in USD) ──────────────────────────────────────────────────
const HOLD_EDGE_THRESHOLD_USD = 5;  // Hold unless exit is better by this much
const REDUCE_THRESHOLD_USD = 3;     // Suggest reducing if it beats hold by this

// ── Urgency multipliers ──────────────────────────────────────────────────────
const TIME_STOP_URGENCY_SECS = 120; // < 2min remaining = flag urgency
const LOW_POP_THRESHOLD = 0.30;     // PoP below this = advisory concerns

// ───────────────────────────────────────────────────────────────────────────
// Target-position per-trade runtime state (private to the engine)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per-trade target-position state. Encapsulated inside the engine so callers
 * don't need to manage it — runner.ts calls beginTrade()/endTrade() around
 * trade boundaries and notifyReduceApplied() after successful reduce fills.
 */
interface TargetPositionRuntimeState {
  trade_id: string;
  /**
   * The most recent *computed* TargetPositionResult. null while the trade has
   * not yet had a successful recompute (cold-start, see plan "Prior-target
   * initialization" section). Used by the stale-input branch to hold prior target.
   */
  cached_result: TargetPositionResult | null;
  /** Small-delta persistence counter — increments on cycles where delta_drop is in [min_delta, large_threshold). */
  small_drop_cycles_consecutive: number;
  /** Unix ms timestamp of the last successful target-position reduce. 0 = never. */
  last_reduce_ts_ms: number;
  /** When true, further target-position reduces are suppressed until manually cleared. */
  bracket_sync_block_active: boolean;
}

export class ManagementDecisionEngine {
  private readonly model: ProbabilityModel;
  private readonly positionTargetConfig: PositionTargetConfig | null;
  /** Per-trade runtime state. null when flat (no open trade). */
  private targetPositionRuntime: TargetPositionRuntimeState | null = null;

  constructor(
    private readonly contract: ContractSpec,
    positionTargetConfig?: PositionTargetConfig | null,
    model?: ProbabilityModel,
  ) {
    this.model = model ?? new RulesProbabilityEngine();
    this.positionTargetConfig = positionTargetConfig ?? null;
  }

  // ── Target-position runtime lifecycle ─────────────────────────────────

  /** Seed fresh per-trade state at entry. Idempotent across re-calls with the same trade_id. */
  beginTrade(tradeId: string): void {
    if (this.targetPositionRuntime?.trade_id === tradeId) return;
    this.targetPositionRuntime = {
      trade_id: tradeId,
      cached_result: null,
      small_drop_cycles_consecutive: 0,
      last_reduce_ts_ms: 0,
      bracket_sync_block_active: false,
    };
  }

  /** Clear per-trade state after a trade exits. */
  endTrade(): void {
    this.targetPositionRuntime = null;
  }

  /** Runner calls this after a successful target-position reduce so the cooldown starts. */
  notifyReduceApplied(): void {
    if (!this.targetPositionRuntime) return;
    this.targetPositionRuntime.last_reduce_ts_ms = Date.now();
    this.targetPositionRuntime.small_drop_cycles_consecutive = 0;
  }

  /** Runner calls this when bracket amendment fails after a reduce fill. Blocks further target reduces. */
  notifyBracketSyncFailed(): void {
    if (!this.targetPositionRuntime) return;
    this.targetPositionRuntime.bracket_sync_block_active = true;
  }

  /** Runner calls this once it confirms the bracket is reconciled. */
  notifyBracketSyncReconciled(): void {
    if (!this.targetPositionRuntime) return;
    this.targetPositionRuntime.bracket_sync_block_active = false;
  }

  /** Test/diagnostic accessor for the current runtime state. */
  getTargetPositionRuntimeSnapshot(): Readonly<TargetPositionRuntimeState> | null {
    return this.targetPositionRuntime ? { ...this.targetPositionRuntime } : null;
  }

  /**
   * Evaluate the active trade and produce a full ManagementMetrics snapshot.
   * Call every monitor cycle immediately after quote validation.
   *
   * @param features   Built by feature-builder.ts
   * @param tradeId    Trade identifier — used to detect new trades and reset runtime state.
   *                   If omitted, target-position recompute is skipped (legacy test callers).
   */
  evaluate(features: ManagementFeatures, tradeId?: string): ManagementMetrics {
    const pop = this.model.computePoP(features);
    const unrealized_pnl_usd = this.computeUnrealizedPnlUsd(features);
    const expected_value_hold_usd = this.computeEvHold(features, pop);
    const expected_value_exit_now_usd = unrealized_pnl_usd;
    const expected_value_reduce_usd =
      0.5 * unrealized_pnl_usd + 0.5 * expected_value_hold_usd;
    const ev_hold_vs_exit_delta = expected_value_hold_usd - expected_value_exit_now_usd;

    // ── Target-position recompute (V1a) ─────────────────────────────────
    // Auto-begin the trade if tradeId was provided and runtime state is fresh
    // or mismatched. This handles runner paths where beginTrade() wasn't called
    // explicitly (e.g. resumed after reload).
    if (tradeId && this.targetPositionRuntime?.trade_id !== tradeId) {
      this.beginTrade(tradeId);
    }
    const targetResult = this.recomputeTargetPosition(features, pop);

    // ── Determine state (target-position branches first, then legacy) ────
    const determined = this.determineState(
      features,
      pop,
      unrealized_pnl_usd,
      ev_hold_vs_exit_delta,
      expected_value_reduce_usd,
      targetResult,
    );

    // Build the target-position snapshot for ManagementMetrics output
    const targetSnapshot = this.buildTargetPositionSnapshot(features, targetResult);

    return {
      features,
      pop,
      unrealized_pnl_usd: Math.round(unrealized_pnl_usd * 100) / 100,
      expected_value_hold_usd: Math.round(expected_value_hold_usd * 100) / 100,
      expected_value_exit_now_usd: Math.round(expected_value_exit_now_usd * 100) / 100,
      expected_value_reduce_usd: Math.round(expected_value_reduce_usd * 100) / 100,
      ev_hold_vs_exit_delta: Math.round(ev_hold_vs_exit_delta * 100) / 100,
      management_state: determined.state,
      management_state_reason: determined.reason,
      decision_factors: determined.factors,
      timestamp_iso: new Date().toISOString(),
      target_position: targetSnapshot,
      requested_qty_to_exit: determined.requested_qty_to_exit ?? null,
    };
  }

  // ── Target-position recompute (V1a) ────────────────────────────────────

  /**
   * Attempt to compute q*(t) for the current cycle. Handles stale-input policy
   * (hold prior target), cold-start (skip entirely), config-disabled paths.
   *
   * Returns:
   *  - TargetPositionResult with `from_stale_cache = false` on fresh compute
   *  - TargetPositionResult with `from_stale_cache = true` when prior-target held
   *  - null when the recompute was skipped entirely (cold-start with stale inputs,
   *    or config disabled)
   */
  private recomputeTargetPosition(
    features: ManagementFeatures,
    pop: TradePoP,
  ): (TargetPositionResult & { from_stale_cache: boolean }) | null {
    const cfg = this.positionTargetConfig;
    if (!cfg || !cfg.enabled || !cfg.management_recompute_enabled) return null;
    const rt = this.targetPositionRuntime;
    if (!rt) return null;

    // Stale-input detection: any missing/NaN reading short-circuits the recompute.
    const inputsSane = this.targetInputsSane(features, pop);
    if (!inputsSane) {
      // Hold prior target if we have one (stale-input policy). If no prior
      // cache exists (brand-new trade), skip entirely — return null so the
      // decision path falls through to legacy HOLD/EV without a synthetic
      // 'target_position_stale_input' reason.
      if (rt.cached_result) {
        return { ...rt.cached_result, from_stale_cache: true };
      }
      return null;
    }

    // Canonical in-flight stop distance: |current_price - pos.stop_current|.
    // features.distance_to_stop_pts is signed by trade direction; abs() gives
    // the unsigned distance required by computeTargetPosition(). Gated by the
    // legacy "distance_to_stop_pts <= 0 → EXIT_NOW" branch in determineState
    // so we never reach this with a breached stop.
    const stopDistPts = Math.abs(features.distance_to_stop_pts);

    const ctx: TargetPositionContext = {
      stop_distance_pts: stopDistPts,
      contract: this.contract,
      equity: features.account_equity,
      max_risk_per_trade_pct: features.max_risk_per_trade_pct,
      confidence_raw: pop.pop_target2_before_stop,
      confidence_source: 'management_pop_t2',
      regime: features.regime,
      session_bucket: features.session_bucket,
      daily_loss_pct: features.daily_loss_pct,
      max_daily_loss_pct: features.max_daily_loss_pct,
      hard_cap: cfg.hard_cap,
      config: cfg,
    };
    const result = computeTargetPosition(ctx);

    // Emit [TARGET_POS][recompute] only when q_target changes, to avoid log spam.
    const priorTarget = rt.cached_result?.q_target ?? -1;
    if (result.q_target !== priorTarget) {
      logTargetPositionDecision(result, {
        tag: 'recompute',
        approved: result.q_target > 0,
        equity: features.account_equity,
        qCurrent: features.quantity_remaining,
      });
    }

    // Emit [TARGET_POS][would_scale_in] when target exceeds current — V1a
    // suppresses actual adds, so this is informational only. Gated on the
    // same "changed" check so we don't log every cycle.
    if (result.q_target > features.quantity_remaining && result.q_target !== priorTarget) {
      logTargetPositionDecision(result, {
        tag: 'would_scale_in',
        approved: false,
        equity: features.account_equity,
        qCurrent: features.quantity_remaining,
        deltaDrop: features.quantity_remaining - result.q_target, // negative
      });
    }

    rt.cached_result = result;
    return { ...result, from_stale_cache: false };
  }

  private targetInputsSane(features: ManagementFeatures, pop: TradePoP): boolean {
    if (!Number.isFinite(features.current_price) || features.current_price <= 0) return false;
    if (!Number.isFinite(features.distance_to_stop_pts)) return false;
    if (features.distance_to_stop_pts <= 0) return false;
    if (!Number.isFinite(pop.pop_target2_before_stop)) return false;
    if (!Number.isFinite(features.daily_loss_pct)) return false;
    if (!Number.isFinite(features.max_daily_loss_pct) || features.max_daily_loss_pct <= 0) return false;
    return true;
  }

  /**
   * Build the ManagementTargetPositionSnapshot attached to ManagementMetrics
   * from a TargetPositionResult + runtime state. Returns null when recompute
   * was skipped entirely.
   */
  private buildTargetPositionSnapshot(
    features: ManagementFeatures,
    result: (TargetPositionResult & { from_stale_cache: boolean }) | null,
  ): ManagementTargetPositionSnapshot | null {
    if (!result) return null;
    const rt = this.targetPositionRuntime;
    const qCurrent = features.quantity_remaining;
    const delta = result.q_target - qCurrent;

    const cfg = this.positionTargetConfig;
    const cooldownSec = cfg?.management_reduce_cooldown_sec ?? 0;
    const elapsedSec = rt ? (Date.now() - rt.last_reduce_ts_ms) / 1000 : Infinity;
    const cooldownRemainingSec =
      rt && rt.last_reduce_ts_ms > 0 ? Math.max(0, cooldownSec - elapsedSec) : 0;
    const persistenceCounter = rt?.small_drop_cycles_consecutive ?? 0;

    const action = describeTargetAction(
      delta,
      result.q_target,
      persistenceCounter,
      cooldownRemainingSec,
      rt?.bracket_sync_block_active ?? false,
      result.from_stale_cache,
    );

    return {
      q_target: result.q_target,
      q_risk: result.q_risk,
      q_softcap: result.q_softcap,
      q_hardcap: result.q_hardcap,
      bound_by: result.bound_by,
      bound_by_all: result.bound_by_all,
      delta,
      action_kind: action.kind,
      action_qty: action.qty,
      confidence_raw: result.confidence_raw,
      confidence_factor: result.confidence_factor,
      confidence_source: result.confidence_source,
      regime_factor: result.regime_factor,
      session_factor: result.session_factor,
      drawdown_factor: result.drawdown_factor,
      from_stale_cache: result.from_stale_cache,
      small_drop_cycles_consecutive: persistenceCounter,
      cooldown_remaining_sec: Math.round(cooldownRemainingSec),
      bracket_sync_block_active: rt?.bracket_sync_block_active ?? false,
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
    targetResult: (TargetPositionResult & { from_stale_cache: boolean }) | null,
  ): {
    state: ManagementState;
    reason: string;
    factors: string[];
    requested_qty_to_exit?: number;
  } {
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

    // ── Target-position branches — fire BEFORE legacy EV/PoP logic ────────
    // Only evaluated when:
    //   - A fresh target result exists (not from stale cache) — stale cache
    //     holds the prior target and emits HOLD with a stale-input reason.
    //   - Config is present and enabled (implied by targetResult != null).
    //   - Runtime state is present (same condition).
    const rt = this.targetPositionRuntime;
    const ptCfg = this.positionTargetConfig;
    if (targetResult && rt && ptCfg) {
      // Stale-cache branch — hold prior target, no action.
      if (targetResult.from_stale_cache) {
        factors.push('target_position_stale_input');
        return {
          state: 'HOLD',
          reason: `target_position_stale_input (holding prior q_target=${targetResult.q_target})`,
          factors,
        };
      }

      // Fresh compute path — bracket-sync block short-circuits all reduces.
      if (rt.bracket_sync_block_active) {
        factors.push('bracket_sync_block_active');
        return {
          state: 'HOLD',
          reason: 'bracket_sync_block_active (suppressing target-position reduces until reconciled)',
          factors,
        };
      }

      const qCurrent = f.quantity_remaining;
      const qTarget = targetResult.q_target;
      const deltaDrop = qCurrent - qTarget; // positive = reduce wanted
      const postReduceResidual = qTarget;

      // ── (a) Flatten: q_target == 0 routes to full EXIT_NOW, not partial ─
      if (qTarget === 0 && ptCfg.flatten_on_zero_target) {
        factors.push(`target_position_flatten bound_by=${targetResult.bound_by}`);
        return {
          state: 'EXIT_NOW',
          reason: `target_position_flatten: q_target=0 (bound_by=${targetResult.bound_by})`,
          factors,
          // Exit-now path flattens the full position; no partial qty needed.
        };
      }

      // ── (b) Dust-residual: flatten rather than leave sub-minimum residual
      if (
        deltaDrop >= 1 &&
        postReduceResidual < ptCfg.min_residual_contracts
      ) {
        factors.push(
          `target_position_residual_below_minimum (residual=${postReduceResidual} < min=${ptCfg.min_residual_contracts})`,
        );
        return {
          state: 'EXIT_NOW',
          reason: `target_position_residual_below_minimum: q_target=${qTarget} < min_residual=${ptCfg.min_residual_contracts}`,
          factors,
        };
      }

      // ── (c) Partial reduce with hysteresis + cooldown + per-cycle cap ───
      if (deltaDrop >= ptCfg.management_reduce_min_delta) {
        const elapsedSec =
          rt.last_reduce_ts_ms > 0 ? (Date.now() - rt.last_reduce_ts_ms) / 1000 : Infinity;
        const cooldownOk = elapsedSec >= ptCfg.management_reduce_cooldown_sec;

        if (!cooldownOk) {
          factors.push(
            `target_reduce_cooldown (${elapsedSec.toFixed(0)}s < ${ptCfg.management_reduce_cooldown_sec}s)`,
          );
          return {
            state: 'HOLD',
            reason: `target_reduce_cooldown_active: ${elapsedSec.toFixed(0)}s < ${ptCfg.management_reduce_cooldown_sec}s`,
            factors,
          };
        }

        // Large-delta bypasses persistence; small-delta increments counter.
        let fireNow: boolean;
        if (deltaDrop >= ptCfg.reduce_large_delta_threshold) {
          fireNow = true;
        } else {
          rt.small_drop_cycles_consecutive += 1;
          fireNow =
            rt.small_drop_cycles_consecutive >= ptCfg.reduce_persistence_cycles_small_delta;
        }

        if (!fireNow) {
          factors.push(
            `pending_small_drop_persistence ${rt.small_drop_cycles_consecutive}/${ptCfg.reduce_persistence_cycles_small_delta}`,
          );
          return {
            state: 'HOLD',
            reason: `pending_small_drop_persistence ${rt.small_drop_cycles_consecutive}/${ptCfg.reduce_persistence_cycles_small_delta}`,
            factors,
          };
        }

        // Fire REDUCE — clamp qty by per-cycle cap. Reset the counter on fire.
        const cappedQty = Math.min(deltaDrop, ptCfg.max_target_reduce_per_cycle);
        rt.small_drop_cycles_consecutive = 0;
        factors.push(
          `target_position_reduce delta=${deltaDrop} capped=${cappedQty} bound_by=${targetResult.bound_by}`,
        );
        // Record that target-position reduce fired; the runner-up EV-reduce is
        // suppressed and logged as a decision factor for audit.
        factors.push('ev_reduce_suppressed_by_target_reduce');
        return {
          state: 'REDUCE',
          reason: `target_position_reduce: q_target=${qTarget} < q_current=${qCurrent} (delta=${deltaDrop}, capped=${cappedQty}, bound_by=${targetResult.bound_by})`,
          factors,
          requested_qty_to_exit: cappedQty,
        };
      }

      // No reduce wanted (delta_drop < min_delta) — reset persistence counter
      // so noisy flips don't accumulate across transient cycles.
      if (deltaDrop < ptCfg.management_reduce_min_delta) {
        rt.small_drop_cycles_consecutive = 0;
      }
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
