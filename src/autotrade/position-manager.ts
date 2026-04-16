/**
 * PositionManager — tracks the single open position per session,
 * updates MFE/MAE, checks stops/targets, and triggers exits.
 */

import type {
  Position,
  TradeRecord,
  MarketRegime,
  ExitReason,
  IndicatorConfig,
  SetupType,
  ExitLeg,
  ResolvedManagementParams,
  ManagementEvent,
  ManagementEventType,
} from './types.js';
import type { OrderResult } from './execution.js';
import type { ContractSpec } from './contracts.js';
import { roundToTick, ticksToPrice } from './contracts.js';
import {
  computeFailureExitState,
  evaluateFailureExit,
  type FailureExitCurves,
  type FailureExitState,
  type FailureExitLaneTrigger,
} from './failure-exit/index.js';
import { computeExitReasonDetailed, isStoppedOut } from './exit-labeling.js';
import { getSetupFamily } from './management-profiles.js';

// ── Risk-only evaluation types (Phase 1: pure evaluation for hard-risk lane) ──

/** Proposed position mutations from risk-only evaluation (applied under ExecutionLock). */
export interface RiskMutations {
  /** Move stop to breakeven (entry price). */
  moveStopToBE: boolean;
  /** Activate pre-T1 trailing stop. */
  activatePreT1Trail: boolean;
  /** Updated trail anchor price (null if no change). */
  newTrailAnchor: number | null;
  /** Tightened stop price from trail ratchet (null if no change). */
  newStopCurrent: number | null;
  /** Whether to emit a trail_ratchet management event. */
  emitTrailRatchetEvent: boolean;
  /** Previous stop price (for event emission). */
  previousStopForEvent: number;
}

/** Result of pure risk-only evaluation — no position mutations applied. */
export interface RiskEvalResult {
  /** True if stop was hit (hard stop after any proposed mutations). */
  shouldExit: boolean;
  /** Exit decision details (non-null only when shouldExit is true). */
  exitDecision: ExitDecision | null;
  /** Proposed mutations for the caller to apply under ExecutionLock. */
  proposedMutations: RiskMutations;
  /** Whether any mutation was actually proposed. */
  hasMutations: boolean;
}

export interface ExitDecision {
  shouldExit: boolean;
  reason: ExitReason | null;
  /** The actual market price at which the exit is being triggered. */
  exitPrice: number;
  /** The target/stop price that was hit (planned exit price). May differ from exitPrice. */
  plannedExitPrice: number;
  isPartial: boolean;
  partialQuantity: number;
}

/**
 * Decides whether a time-stop exit should be permitted given the current
 * profitability state of the trade.
 *
 * Rules:
 *   PRE-T1  — time stop fires only when unrealizedR <= config.time_stop_max_r_pre_t1
 *             (default 0.25). This prevents killing a trade that has moved into
 *             meaningful profit before the partial exit has had a chance to hit.
 *
 *   POST-T1 — stop is already at breakeven. Time stop is suppressed when
 *             unrealizedR > config.time_stop_max_r_post_t1 (default 1.0).
 *             A trade sitting above +1.0R with a protected stop is a good trade;
 *             forcing it out by the clock destroys expectancy.
 *             When unrealizedR falls to <= time_stop_max_r_post_t1, the trade has
 *             stalled in the "free zone" near BE and it is acceptable to close it.
 *
 * Returns { allowed: boolean, reason: string } for logging purposes.
 */
export function shouldAllowTimeStop(
  partialExitDone: boolean,
  unrealizedR: number,
  peakR: number,
  config: IndicatorConfig,
  mgmt?: ResolvedManagementParams,
): { allowed: boolean; reason: string } {
  if (!partialExitDone) {
    // PRE-T1: only kill stalled, near-breakeven trades
    const threshold = mgmt?.time_stop_max_r_pre_t1 ?? config.time_stop_max_r_pre_t1;
    if (unrealizedR <= threshold) {
      return {
        allowed: true,
        reason: `pre_t1 unrealizedR=${unrealizedR.toFixed(2)} <= threshold=${threshold}`,
      };
    }
    return {
      allowed: false,
      reason: `pre_t1 protected: unrealizedR=${unrealizedR.toFixed(2)} > threshold=${threshold}`,
    };
  }

  // POST-T1: stop is at BE — only close if stalled near breakeven
  const threshold = mgmt?.time_stop_max_r_post_t1 ?? config.time_stop_max_r_post_t1;
  if (unrealizedR <= threshold) {
    return {
      allowed: true,
      reason: `post_t1 stalled: unrealizedR=${unrealizedR.toFixed(2)} <= threshold=${threshold} (peakR=${peakR.toFixed(2)})`,
    };
  }
  return {
    allowed: false,
    reason: `post_t1 protected: unrealizedR=${unrealizedR.toFixed(2)} > threshold=${threshold} — let it run`,
  };
}

export class PositionManager {
  private position: Position | null = null;
  private readonly contract: ContractSpec;
  private readonly instrumentSymbol: string;
  private readonly venue: string;
  private onManagementEvent?: (event: ManagementEvent) => void;
  private onPositionChange?: (position: Position | null) => void;
  /**
   * Empirical winner-distribution curves keyed by family (or custom key via
   * ResolvedManagementParams.pre_t1_failure_curves_key). Null/empty map
   * makes Lane B of the Dead-Trade Guard a no-op; Lanes A and C still work.
   * Loaded once at startup from config/failure_exit_curves.json by the runner.
   */
  private failureCurves: Map<string, FailureExitCurves> | null = null;

  constructor(contract: ContractSpec, instrumentSymbol: string) {
    this.contract = contract;
    this.instrumentSymbol = instrumentSymbol;
    this.venue = contract.venue;
  }

  /** Register a handler for structured management events (PT1, trail ratchets, etc.). */
  setManagementEventHandler(handler: (event: ManagementEvent) => void): void {
    this.onManagementEvent = handler;
  }

  /**
   * Install the empirical failure-exit curves map. Called once at runner
   * startup. If never called (or called with null), Lane B is a no-op.
   */
  setFailureCurves(curves: Map<string, FailureExitCurves> | null): void {
    this.failureCurves = curves;
  }

  /** Register a handler for position state changes (for crash recovery persistence). */
  setPositionChangeHandler(handler: (position: Position | null) => void): void {
    this.onPositionChange = handler;
  }

  /** Emit position change if handler is registered (never throws). */
  private emitPositionChange(): void {
    try {
      this.onPositionChange?.(this.position);
    } catch { /* persistence must never break trading */ }
  }

  /** Build a ManagementEvent from current Position state. */
  private buildMgmtEvent(
    pos: Position,
    eventType: ManagementEventType,
    currentPrice: number,
    stopBefore: number,
    stopAfter: number,
    qtyBefore: number,
    qtyAfter: number,
  ): ManagementEvent {
    const isShort = pos.side === 'short';
    const favorableMove = isShort ? pos.entry_price - currentPrice : currentPrice - pos.entry_price;
    const initialRiskPts = Math.abs(pos.entry_price - pos.stop_initial);
    const mgmt = pos.management_params;
    const trailDistPts = pos.trailing_active && pos.trail_distance_ticks > 0
      ? ticksToPrice(pos.trail_distance_ticks, this.contract) : null;
    return {
      row_type: 'management_event',
      timestamp: new Date().toISOString(),
      trade_id: pos.trade_id,
      event_type: eventType,
      setup_type: pos.setup_type,
      management_profile: mgmt.profile_name,
      side: pos.side,
      entry_price: pos.entry_price,
      current_price: currentPrice,
      stop_before: stopBefore,
      stop_after: stopAfter,
      quantity_before: qtyBefore,
      quantity_after: qtyAfter,
      realized_pnl_so_far: Math.round(pos.realized_pnl_so_far * 100) / 100,
      unrealized_pnl_pts: Math.round(favorableMove * 100) / 100,
      unrealized_r: initialRiskPts > 0 ? Math.round((favorableMove / initialRiskPts) * 100) / 100 : 0,
      mfe_pts: Math.round(pos.max_favorable_excursion * 100) / 100,
      mae_pts: Math.round(pos.max_adverse_excursion * 100) / 100,
      atr_at_entry: pos.atr_at_entry,
      trail_distance_pts: trailDistPts !== null ? Math.round(trailDistPts * 100) / 100 : null,
      pt1_trigger_pts: mgmt.pt1_offset_pts > 0 ? Math.round(mgmt.pt1_offset_pts * 100) / 100 : null,
      pt2_trigger_pts: mgmt.pt2_offset_pts > 0 ? Math.round(mgmt.pt2_offset_pts * 100) / 100 : null,
    };
  }

  /** Emit a management event if handler is registered (never throws). */
  private emitMgmtEvent(event: ManagementEvent): void {
    try {
      this.onManagementEvent?.(event);
    } catch { /* management event logging must never break trading */ }
  }

  /**
   * Build a failure-exit management event decorated with the full state
   * snapshot (lane, reason, derived features, interpolated curve values).
   * Used for failure_review_soft / failure_exit / failure_exit_shadow events.
   */
  private buildFailureExitEvent(
    pos: Position,
    eventType: ManagementEventType,
    currentPrice: number,
    state: FailureExitState,
    trigger: FailureExitLaneTrigger,
  ): ManagementEvent {
    const base = this.buildMgmtEvent(
      pos,
      eventType,
      currentPrice,
      pos.stop_current,
      pos.stop_current,
      pos.quantity_remaining,
      pos.quantity_remaining,
    );
    return {
      ...base,
      failure_lane: trigger.lane,
      failure_reason: trigger.reason,
      hold_minutes_at_event: Math.round(state.tMin * 100) / 100,
      current_r_at_event: Math.round(state.currentR * 1000) / 1000,
      peak_r_at_event: Math.round(state.peakR * 1000) / 1000,
      mae_r_at_event: Math.round(state.maeR * 1000) / 1000,
      failure_ratio_at_event: Math.round(state.failureRatio * 1000) / 1000,
      progress_rate_at_event: Math.round(state.progressRate * 1000) / 1000,
      recovery_gap_at_event: Math.round(state.recoveryGap * 1000) / 1000,
      decay_rate_at_event: Math.round(state.decayRate * 1000) / 1000,
      q20_peak_at_event: trigger.q20_peak ?? null,
      q80_mae_at_event: trigger.q80_mae ?? null,
    };
  }

  hasOpenPosition(): boolean {
    return this.position !== null;
  }

  getPosition(): Position | null {
    return this.position;
  }

  openPosition(pos: Position): void {
    if (this.position) {
      throw new Error('PositionManager: a position is already open');
    }
    this.position = pos;
    this.emitPositionChange();
  }

  /**
   * Evaluate current price against stops/targets.
   * Returns what action (if any) should be taken.
   */
  evaluate(currentPrice: number, config: IndicatorConfig): ExitDecision {
    const pos = this.position;
    if (!pos) {
      return { shouldExit: false, reason: null, exitPrice: currentPrice, plannedExitPrice: currentPrice, isPartial: false, partialQuantity: 0 };
    }

    const isShort = pos.side === 'short';

    // ── Target-direction safety: a target on the wrong side of entry would be
    // "instantly hit" and fabricate a fill. Guard by validating each target
    // before comparing. These should never fire if the signal gate is active.
    const t1Valid = isShort ? pos.target_1 < pos.entry_price : pos.target_1 > pos.entry_price;
    const t2Valid = isShort ? pos.target_2 < pos.entry_price : pos.target_2 > pos.entry_price;
    const t3Valid = pos.target_3 === null
      ? true
      : (isShort ? pos.target_3 < pos.entry_price : pos.target_3 > pos.entry_price);
    if (!t1Valid || !t2Valid || !t3Valid) {
      console.error(
        `[POS] 🚨 Invalid target direction detected for ${pos.side} entry=${pos.entry_price} ` +
        `t1=${pos.target_1}(${t1Valid ? 'ok' : 'BAD'}) ` +
        `t2=${pos.target_2}(${t2Valid ? 'ok' : 'BAD'}) ` +
        `t3=${pos.target_3}(${t3Valid ? 'ok' : 'BAD'}). ` +
        `Skipping target checks; only stop/time stop remain.`,
      );
    }

    // Update MFE / MAE
    const favorableMove = isShort
      ? pos.entry_price - currentPrice  // for short: profit when price falls
      : currentPrice - pos.entry_price; // for long: profit when price rises
    const adverseMove = isShort
      ? currentPrice - pos.entry_price  // for short: loss when price rises
      : pos.entry_price - currentPrice; // for long: loss when price falls

    if (favorableMove > pos.max_favorable_excursion) {
      pos.max_favorable_excursion = favorableMove;
    }
    if (adverseMove > pos.max_adverse_excursion) {
      pos.max_adverse_excursion = adverseMove;
    }

    pos.last_checked_price = currentPrice;

    // ── Pre-T1 profit protection ────────────────────────────────────────────
    const mgmt = pos.management_params;
    if (!pos.partial_exit_done) {
      const initialRiskPts = Math.abs(pos.entry_price - pos.stop_initial);
      const currentR = initialRiskPts > 0 ? favorableMove / initialRiskPts : 0;

      // 1) Breakeven trigger: move stop to BE once trade reaches breakeven_trigger_r
      if (!pos.pre_t1_be_triggered && mgmt.breakeven_trigger_r > 0 && currentR >= mgmt.breakeven_trigger_r) {
        const beStop = roundToTick(pos.entry_price, this.contract);
        // Only move if it actually tightens the stop
        const tightens = isShort ? beStop < pos.stop_current : beStop > pos.stop_current;
        if (tightens) {
          const prev = pos.stop_current;
          pos.stop_current = beStop;
          pos.pre_t1_be_triggered = true;
          pos.stop_moved_to_be = true;
          console.log(
            `[PRE-T1 BE] ${pos.side.toUpperCase()} stop ${prev.toFixed(this.contract.price_decimals)} → ` +
            `BE ${beStop.toFixed(this.contract.price_decimals)} (triggered at ${currentR.toFixed(2)}R >= ${mgmt.breakeven_trigger_r}R, profile=${mgmt.profile_name})`,
          );
          this.emitMgmtEvent(this.buildMgmtEvent(pos, 'pre_t1_be_move', currentPrice, prev, beStop, pos.quantity_remaining, pos.quantity_remaining));
        }
      }

      // 2) Pre-T1 trailing: start trailing once trade reaches pre_t1_trail_trigger_r
      if (!pos.pre_t1_trailing_active && mgmt.pre_t1_trail_trigger_r > 0 && currentR >= mgmt.pre_t1_trail_trigger_r) {
        pos.pre_t1_trailing_active = true;
        pos.trailing_active = true;
        pos.trail_distance_ticks = Math.max(0, Math.floor(mgmt.pre_t1_trail_distance_ticks));
        pos.trail_anchor_price = currentPrice;
        console.log(
          `[PRE-T1 TRAIL] ${pos.side.toUpperCase()} trailing armed at ${currentR.toFixed(2)}R >= ${mgmt.pre_t1_trail_trigger_r}R ` +
          `(trail=${pos.trail_distance_ticks}tk, anchor=${currentPrice.toFixed(this.contract.price_decimals)}, profile=${mgmt.profile_name})`,
        );
        this.emitMgmtEvent(this.buildMgmtEvent(pos, 'pre_t1_trail_activation', currentPrice, pos.stop_current, pos.stop_current, pos.quantity_remaining, pos.quantity_remaining));
      }
    }

    // ── Continuous peak-R tracking for follow-through instrumentation ─────
    if (!pos.pt1_done && !pos.partial_exit_done) {
      const riskPtsForPeakR = Math.abs(pos.entry_price - pos.stop_initial);
      const peakR = riskPtsForPeakR > 0 ? favorableMove / riskPtsForPeakR : 0;
      if (peakR > (pos.peak_r_before_first_partial ?? 0)) {
        pos.peak_r_before_first_partial = peakR;
        // Stamp the peak update time so decayRate in the failure-exit state
        // vector can measure R/min since peak. Single source of truth for
        // tPeakMin used by computeFailureExitState().
        const peakMinutes = (Date.now() - pos.entry_time_unix) / 60_000;
        pos.t_peak_r_minutes = peakMinutes;
        if (pos.time_to_peak_r_before_first_partial_minutes === null) {
          pos.time_to_peak_r_before_first_partial_minutes = peakMinutes;
        }
      }
      // First positive-R stamp (time-to-break-even-ish metric)
      if (pos.time_to_first_positive_r_minutes === null && peakR > 0) {
        pos.time_to_first_positive_r_minutes = (Date.now() - pos.entry_time_unix) / 60_000;
      }
    }

    // ── Trailing stop update (post-T1 or pre-T1 trailing) ─────────────────
    if (pos.trailing_active && pos.trail_distance_ticks > 0) {
      const trailDistPts = ticksToPrice(pos.trail_distance_ticks, this.contract);
      // Anchor moves in favor only
      if (pos.trail_anchor_price === null) {
        pos.trail_anchor_price = currentPrice;
      } else {
        const improved = isShort
          ? currentPrice < pos.trail_anchor_price
          : currentPrice > pos.trail_anchor_price;
        if (improved) pos.trail_anchor_price = currentPrice;
      }
      const rawTrail = isShort
        ? pos.trail_anchor_price + trailDistPts
        : pos.trail_anchor_price - trailDistPts;
      const trailStop = roundToTick(rawTrail, this.contract);
      // Only tighten the stop, never loosen it; never let it cross entry below BE
      const tighten = isShort
        ? trailStop < pos.stop_current
        : trailStop > pos.stop_current;
      if (tighten) {
        const prev = pos.stop_current;
        pos.stop_current = trailStop;
        console.log(
          `[TRAIL] ${pos.side.toUpperCase()} stop ${prev.toFixed(this.contract.price_decimals)} → ` +
          `${trailStop.toFixed(this.contract.price_decimals)} (anchor=${pos.trail_anchor_price.toFixed(this.contract.price_decimals)}, ` +
          `trail=${pos.trail_distance_ticks}tk)`,
        );
        this.emitMgmtEvent(this.buildMgmtEvent(pos, 'trail_ratchet', currentPrice, prev, trailStop, pos.quantity_remaining, pos.quantity_remaining));
      }
    }

    // ── Stop loss check ────────────────────────────────────────────────────
    const stopHit = isShort
      ? currentPrice >= pos.stop_current
      : currentPrice <= pos.stop_current;

    if (stopHit) {
      return { shouldExit: true, reason: 'stop_loss', exitPrice: currentPrice, plannedExitPrice: pos.stop_current, isPartial: false, partialQuantity: 0 };
    }

    // ── Target 2 check (full exit) ─────────────────────────────────────────
    if (t2Valid) {
      const t2Hit = isShort
        ? currentPrice <= pos.target_2
        : currentPrice >= pos.target_2;

      if (t2Hit) {
        return { shouldExit: true, reason: 'target_2', exitPrice: currentPrice, plannedExitPrice: pos.target_2, isPartial: false, partialQuantity: 0 };
      }
    }

    // ── Target 3 check (full exit) ─────────────────────────────────────────
    if (pos.target_3 !== null && t3Valid) {
      const t3Hit = isShort
        ? currentPrice <= pos.target_3
        : currentPrice >= pos.target_3;
      if (t3Hit) {
        return { shouldExit: true, reason: 'target_3', exitPrice: currentPrice, plannedExitPrice: pos.target_3, isPartial: false, partialQuantity: 0 };
      }
    }

    // ── PT1: Fixed-offset partial profit 1 ──────────────────────────────────
    if (!pos.pt1_done && mgmt.pt1_offset_pts > 0) {
      const pt1Hit = favorableMove >= mgmt.pt1_offset_pts;
      if (pt1Hit) {
        const pt1Qty = Math.max(1, Math.floor(pos.quantity * mgmt.pt1_exit_fraction));
        const maxQty = pos.quantity_remaining - 1; // always leave at least 1
        if (maxQty > 0) {
          return {
            shouldExit: true,
            reason: 'partial_profit_1',
            exitPrice: currentPrice,
            plannedExitPrice: isShort
              ? pos.entry_price - mgmt.pt1_offset_pts
              : pos.entry_price + mgmt.pt1_offset_pts,
            isPartial: true,
            partialQuantity: Math.min(pt1Qty, maxQty),
          };
        } else {
          // Only 1 contract — PT1 takes it as a full exit (no runner possible)
          return {
            shouldExit: true,
            reason: 'partial_profit_1',
            exitPrice: currentPrice,
            plannedExitPrice: isShort
              ? pos.entry_price - mgmt.pt1_offset_pts
              : pos.entry_price + mgmt.pt1_offset_pts,
            isPartial: false,
            partialQuantity: 0,
          };
        }
      }
    }

    // ── PT2: Fixed-offset partial profit 2 ──────────────────────────────────
    if (pos.pt1_done && !pos.pt2_done && mgmt.pt2_offset_pts > 0) {
      const pt2Hit = favorableMove >= mgmt.pt2_offset_pts;
      if (pt2Hit) {
        const pt2Qty = Math.max(1, Math.floor(pos.quantity * mgmt.pt2_exit_fraction));
        const maxQty = pos.quantity_remaining - 1; // leave at least 1 for runner
        if (maxQty > 0) {
          return {
            shouldExit: true,
            reason: 'partial_profit_2',
            exitPrice: currentPrice,
            plannedExitPrice: isShort
              ? pos.entry_price - mgmt.pt2_offset_pts
              : pos.entry_price + mgmt.pt2_offset_pts,
            isPartial: true,
            partialQuantity: Math.min(pt2Qty, maxQty),
          };
        }
      }
    }

    // ── Target 1 check (partial exit, move stop to BE) ─────────────────────
    if (!pos.partial_exit_done && t1Valid) {
      const t1Hit = isShort
        ? currentPrice <= pos.target_1
        : currentPrice >= pos.target_1;

      if (t1Hit) {
        return {
          shouldExit: true,
          reason: 'target_1',
          exitPrice: currentPrice,
          plannedExitPrice: pos.target_1,
          isPartial: true,
          // Integer contracts: at least 1 contract peels at T1, rest runs
          partialQuantity: Math.max(1, Math.floor(pos.quantity_remaining / 2)),
        };
      }
    }

    // ── Pre-T1 failure-to-launch exit (Dead-Trade Guard) ─────────────────
    // Runs only when still pre-PT1/pre-partial AND the feature is enabled on
    // this trade's resolved management params. Shadow mode logs events but
    // does NOT flatten. Live mode flattens on the first unfired non-soft lane
    // in deterministic precedence order (emergency > hard > soft).
    //
    // Placement rationale: hard stop + all profit-taking (PT1/PT2/T1) already
    // ran above, so by this point the trade is still open AND has not made
    // meaningful progress. Time stop still runs below as the outer backstop.
    if (!pos.partial_exit_done && !pos.pt1_done && mgmt.pre_t1_failure_exit_enabled) {
      const state = computeFailureExitState(
        pos,
        favorableMove,
        Date.now(),
        mgmt.pre_t1_failure_lambda_net,
        mgmt.pre_t1_failure_decay_min_gap_minutes,
      );
      // Stash derived state for journaling even if no lane fires.
      pos.last_progress_rate_r_per_min = state.progressRate;
      pos.last_drawdown_rate_r_per_min = state.drawdownRate;
      pos.last_failure_ratio = state.failureRatio;
      pos.last_net_progress = state.netProgress;
      pos.last_efficiency = state.efficiency;
      pos.last_recovery_gap = state.recoveryGap;
      pos.last_decay_rate_r_per_min = state.decayRate;
      pos.mae_r_before_first_partial = state.maeR;

      const curveKey = mgmt.pre_t1_failure_curves_key || mgmt.family;
      const curve = this.failureCurves?.get(curveKey) ?? null;
      const decision = evaluateFailureExit(state, mgmt, curve);

      if (decision.triggered.length > 0) {
        if (mgmt.pre_t1_failure_shadow_mode) {
          // SHADOW: record every unfired latch so the replay analyzer can see
          // which lane triggered first across many trades. Do NOT return —
          // fall through to time stop. Iterate in precedence order so
          // emergency wins same-cycle ties for the reason/time fields.
          for (const trig of decision.triggered) {
            if (trig.lane === 'soft' && !pos.failure_review_soft_emitted) {
              pos.failure_review_soft_emitted = true;
              this.emitMgmtEvent(
                this.buildFailureExitEvent(pos, 'failure_review_soft', currentPrice, state, trig),
              );
            } else if (trig.lane === 'hard' && !pos.failure_exit_hard_fired) {
              pos.failure_exit_hard_fired = true;
              pos.failure_exit_shadow_only = true;
              if (pos.failure_exit_reason === null) {
                pos.failure_exit_reason = trig.reason;
                pos.failure_exit_trigger_time_minutes = state.tMin;
              }
              this.emitMgmtEvent(
                this.buildFailureExitEvent(pos, 'failure_exit_shadow', currentPrice, state, trig),
              );
            } else if (trig.lane === 'emergency' && !pos.failure_exit_emergency_fired) {
              pos.failure_exit_emergency_fired = true;
              pos.failure_exit_shadow_only = true;
              if (pos.failure_exit_reason === null) {
                pos.failure_exit_reason = trig.reason;
                pos.failure_exit_trigger_time_minutes = state.tMin;
              }
              this.emitMgmtEvent(
                this.buildFailureExitEvent(pos, 'failure_exit_shadow', currentPrice, state, trig),
              );
            }
          }
          // falls through to time-stop
        } else {
          // LIVE: scan in precedence order (already sorted by evaluator).
          // Soft never flattens — it only logs. The first unfired hard OR
          // emergency wins and flattens the trade.
          for (const trig of decision.triggered) {
            if (trig.lane === 'soft') {
              if (!pos.failure_review_soft_emitted) {
                pos.failure_review_soft_emitted = true;
                this.emitMgmtEvent(
                  this.buildFailureExitEvent(pos, 'failure_review_soft', currentPrice, state, trig),
                );
              }
              continue;
            }
            if (trig.lane === 'hard' && !pos.failure_exit_hard_fired) {
              pos.failure_exit_hard_fired = true;
              pos.failure_exit_active_lane = 'hard';
              pos.failure_exit_reason = trig.reason;
              pos.failure_exit_trigger_time_minutes = state.tMin;
              this.emitMgmtEvent(
                this.buildFailureExitEvent(pos, 'failure_exit', currentPrice, state, trig),
              );
              console.log(
                `[FAILURE_EXIT] ${pos.side.toUpperCase()} lane=hard t=${state.tMin.toFixed(1)}min ` +
                `peakR=${state.peakR.toFixed(2)} currentR=${state.currentR.toFixed(2)} ` +
                `maeR=${state.maeR.toFixed(2)} reason="${trig.reason}"`,
              );
              return {
                shouldExit: true,
                reason: 'failure_to_launch',
                exitPrice: currentPrice,
                plannedExitPrice: currentPrice,
                isPartial: false,
                partialQuantity: 0,
              };
            }
            if (trig.lane === 'emergency' && !pos.failure_exit_emergency_fired) {
              pos.failure_exit_emergency_fired = true;
              pos.failure_exit_active_lane = 'emergency';
              pos.failure_exit_reason = trig.reason;
              pos.failure_exit_trigger_time_minutes = state.tMin;
              this.emitMgmtEvent(
                this.buildFailureExitEvent(pos, 'failure_exit', currentPrice, state, trig),
              );
              console.log(
                `[FAILURE_EXIT] ${pos.side.toUpperCase()} lane=emergency t=${state.tMin.toFixed(1)}min ` +
                `peakR=${state.peakR.toFixed(2)} maeR=${state.maeR.toFixed(2)} ` +
                `failureRatio=${state.failureRatio.toFixed(2)} reason="${trig.reason}"`,
              );
              return {
                shouldExit: true,
                reason: 'failure_to_launch',
                exitPrice: currentPrice,
                plannedExitPrice: currentPrice,
                isPartial: false,
                partialQuantity: 0,
              };
            }
          }
        }
      }
    }

    // ── Scalper family early-return (Phase 6) ─────────────────────────────
    //
    // The lob_mbo_scalp family owns ALL of its time-based exits via the
    // Phase 6 ScalperExitEngine (src/autotrade/management/scalper-exit-engine.ts).
    // The legacy minute-granular time_stop / pre_t1_failure_* paths are
    // BOTH inappropriate for 1-5 second scalp holds and would create
    // two competing owners for the same decision. Instead, we short-
    // circuit here: the runner's scalper exit loop is the single
    // source of truth for every scalper time cap, no-progress exit,
    // reversal, and microstructure stop.
    //
    // This MUST be the ONLY scalper-aware block in this file — if
    // another time-based check is added below, it must also be
    // guarded with the same early-return or it will silently bypass
    // the ScalperExitEngine. See plan Phase 6 "Critical ownership
    // rule: ScalperExitEngine is the single source of truth".
    if (getSetupFamily(pos.setup_type) === 'lob_mbo_scalp') {
      return {
        shouldExit: false,
        reason: null,
        exitPrice: currentPrice,
        plannedExitPrice: currentPrice,
        isPartial: false,
        partialQuantity: 0,
      };
    }

    // ── Time stop ─────────────────────────────────────────────────────────
    const holdMinutes = (Date.now() - pos.entry_time_unix) / 60_000;
    if (holdMinutes >= pos.time_stop_minutes) {
      const initialRiskPts = Math.abs(pos.entry_price - pos.stop_initial);
      const unrealizedR = initialRiskPts > 0 ? favorableMove / initialRiskPts : 0;
      const peakR = initialRiskPts > 0 ? pos.max_favorable_excursion / initialRiskPts : 0;
      // Any partial exit (T1-target, PT1 fixed-offset, or PT2) qualifies as
      // "post-partial" for the time stop gate — use the wider post-T1 threshold.
      const anyPartialDone = pos.partial_exit_done || pos.pt1_done || pos.pt2_done;
      const { allowed, reason: tReason } = shouldAllowTimeStop(
        anyPartialDone,
        unrealizedR,
        peakR,
        config,
        mgmt,
      );

      console.log(
        `[TIME_STOP] hold=${holdMinutes.toFixed(1)}min limit=${pos.time_stop_minutes}min ` +
        `unrealizedR=${unrealizedR.toFixed(2)} peakR=${peakR.toFixed(2)} ` +
        `postT1=${anyPartialDone} allowed=${allowed} reason="${tReason}"`,
      );

      if (allowed) {
        return { shouldExit: true, reason: 'time_stop', exitPrice: currentPrice, plannedExitPrice: currentPrice, isPartial: false, partialQuantity: 0 };
      }
    }

    return { shouldExit: false, reason: null, exitPrice: currentPrice, plannedExitPrice: currentPrice, isPartial: false, partialQuantity: 0 };
  }

  /**
   * Apply a partial exit (T1 hit): reduce quantity and move stop to breakeven.
   */
  /**
   * Record one exit leg onto the position and accumulate running totals.
   * Must be called for every partial exit before closePosition(), so that
   * closePosition() can derive total realized PnL by summing all legs.
   */
  private recordPartialLeg(
    pos: Position,
    reason: ExitReason,
    quantity: number,
    fillPrice: number,
    fillTimeIso: string,
    feeUsd: number,
    slippagePts: number,
  ): void {
    const pnlPoints = pos.side === 'short'
      ? pos.entry_price - fillPrice
      : fillPrice - pos.entry_price;
    const pnlUsd = pnlPoints * quantity * this.contract.point_value - feeUsd;
    const leg: ExitLeg = {
      reason,
      quantity,
      fill_price: fillPrice,
      fill_time_iso: fillTimeIso,
      pnl_points: pnlPoints,
      pnl_usd: pnlUsd,
      fee_usd: feeUsd,
      slippage_pts: slippagePts,
    };
    pos.exit_legs.push(leg);
    pos.realized_pnl_so_far += pnlUsd;
    pos.realized_fees_so_far += feeUsd;
  }

  /**
   * Apply a partial exit (T1 hit). Reduce quantity, move stop to BE, and arm
   * the trailing-stop logic using config.trail_ticks_post_t1.
   */
  applyPartialExit(quantity: number, fillPrice: number, fillTimeIso: string, feeUsd: number, slippagePts: number, config: IndicatorConfig): void {
    const pos = this.position;
    if (!pos) return;
    this.recordPartialLeg(pos, 'target_1', quantity, fillPrice, fillTimeIso, feeUsd, slippagePts);
    pos.quantity_remaining = Math.max(0, pos.quantity_remaining - quantity);
    pos.partial_exit_done = true;
    // Move stop to breakeven (tick-rounded on the safe side)
    pos.stop_current = roundToTick(pos.entry_price, this.contract);
    pos.stop_moved_to_be = true;

    // Arm (or tighten) trailing stop for the post-T1 runner
    const trailTicks = Math.max(0, Math.floor(pos.management_params.trail_ticks_post_t1));
    if (trailTicks > 0) {
      pos.trailing_active = true;
      // Switch from pre-T1 trail distance (wider) to post-T1 trail distance (tighter)
      pos.trail_distance_ticks = trailTicks;
      // Keep existing anchor if pre-T1 trailing was already active and anchor is better
      if (!pos.pre_t1_trailing_active || pos.trail_anchor_price === null) {
        pos.trail_anchor_price = pos.last_checked_price;
      }
    }
    console.log(
      `[POS] Partial exit: ${quantity} ${this.contract.root} sold at T1. ` +
      `Stop → BE ${pos.stop_current.toFixed(this.contract.price_decimals)}. ` +
      `Remaining: ${pos.quantity_remaining} ct. ` +
      `Trail=${pos.trailing_active ? trailTicks + 'tk' : 'off'}.`,
    );
    this.emitPositionChange();
  }

  /**
   * Apply a PT1 (fixed-offset partial profit 1) exit. Reduce quantity,
   * optionally move stop to BE, and optionally arm trailing.
   */
  applyPt1Exit(quantity: number, fillPrice: number, fillTimeIso: string, feeUsd: number, slippagePts: number, config: IndicatorConfig): void {
    const pos = this.position;
    if (!pos) return;
    this.recordPartialLeg(pos, 'partial_profit_1', quantity, fillPrice, fillTimeIso, feeUsd, slippagePts);
    const leg = pos.exit_legs[pos.exit_legs.length - 1]!;
    pos.quantity_remaining = Math.max(0, pos.quantity_remaining - quantity);
    const qtyBefore = pos.quantity_remaining + quantity; // quantity before this partial
    pos.pt1_done = true;
    pos.pt1_qty_exited = quantity;
    pos.pt1_realized_pnl = leg.pnl_usd;
    if (pos.first_partial_fill_price == null) {
      pos.first_partial_fill_price = fillPrice;
    }
    pos.effective_target_1 = pos.target_1;

    // Capture MFE/MAE state at PT1 for follow-through analysis
    pos.mfe_at_pt1_trigger = pos.max_favorable_excursion;
    pos.mae_at_pt1_trigger = pos.max_adverse_excursion;

    // Move stop to breakeven if configured
    const mgmt = pos.management_params;
    const stopBeforePt1 = pos.stop_current;
    if (mgmt.pt1_move_to_be) {
      pos.stop_current = roundToTick(pos.entry_price, this.contract);
      pos.stop_moved_to_be = true;
    }

    // Activate trailing if configured
    if (mgmt.pt1_activate_trailing) {
      const trailTicks = Math.max(0, Math.floor(mgmt.trail_ticks_post_t1));
      if (trailTicks > 0) {
        pos.trailing_active = true;
        pos.trail_distance_ticks = trailTicks;
        if (!pos.pre_t1_trailing_active || pos.trail_anchor_price === null) {
          pos.trail_anchor_price = pos.last_checked_price;
        }
      }
    }

    // Emit pt1_trigger event
    this.emitMgmtEvent(this.buildMgmtEvent(pos, 'pt1_trigger', fillPrice, stopBeforePt1, pos.stop_current, qtyBefore, pos.quantity_remaining));

    // Emit post_pt1_trail_activation if trailing was armed
    if (mgmt.pt1_activate_trailing && pos.trailing_active) {
      this.emitMgmtEvent(this.buildMgmtEvent(pos, 'post_pt1_trail_activation', fillPrice, pos.stop_current, pos.stop_current, pos.quantity_remaining, pos.quantity_remaining));
    }

    console.log(
      `[POS] PT1 partial: ${quantity} ${this.contract.root} exited at +${mgmt.pt1_offset_pts.toFixed(1)}pts. ` +
      `PnL=$${pos.pt1_realized_pnl.toFixed(2)}. ` +
      `Stop -> ${mgmt.pt1_move_to_be ? 'BE ' + pos.stop_current.toFixed(this.contract.price_decimals) : 'unchanged'}. ` +
      `Remaining: ${pos.quantity_remaining} ct. ` +
      `Trail=${pos.trailing_active ? pos.trail_distance_ticks + 'tk' : 'off'}. ` +
      `Profile=${mgmt.profile_name}.`,
    );
    this.emitPositionChange();
  }

  /**
   * Apply a PT2 (fixed-offset partial profit 2) exit. Reduce quantity for the runner.
   */
  applyPt2Exit(quantity: number, fillPrice: number, fillTimeIso: string, feeUsd: number, slippagePts: number, config: IndicatorConfig): void {
    const pos = this.position;
    if (!pos) return;
    const qtyBefore = pos.quantity_remaining;
    this.recordPartialLeg(pos, 'partial_profit_2', quantity, fillPrice, fillTimeIso, feeUsd, slippagePts);
    const leg = pos.exit_legs[pos.exit_legs.length - 1]!;
    pos.quantity_remaining = Math.max(0, pos.quantity_remaining - quantity);
    pos.pt2_done = true;
    pos.pt2_qty_exited = quantity;
    pos.pt2_realized_pnl = leg.pnl_usd;

    console.log(
      `[POS] PT2 partial: ${quantity} ${this.contract.root} exited at +${pos.management_params.pt2_offset_pts.toFixed(1)}pts. ` +
      `PnL=$${pos.pt2_realized_pnl.toFixed(2)}. ` +
      `Runner remaining: ${pos.quantity_remaining} ct. ` +
      `Profile=${pos.management_params.profile_name}.`,
    );
    this.emitMgmtEvent(this.buildMgmtEvent(pos, 'pt2_trigger', fillPrice, pos.stop_current, pos.stop_current, qtyBefore, pos.quantity_remaining));
    this.emitPositionChange();
  }

  /**
   * Close the position fully and produce a TradeRecord.
   */
  closePosition(
    exitResult: OrderResult,
    reason: ExitReason,
    regimeAtExit: MarketRegime,
    sessionId: string,
    stratVersion: string,
    plannedExitPrice: number,
    targetValidation: {
      target_1_direction_valid: boolean;
      target_2_direction_valid: boolean;
      target_3_direction_valid: boolean;
      target_ordering_valid: boolean;
      target_repair_applied: boolean;
    },
  ): TradeRecord {
    const pos = this.position;
    if (!pos) throw new Error('PositionManager: no open position to close');

    const isShort = pos.side === 'short';
    const entryPrice = pos.entry_price;
    const exitPrice = exitResult.fill_price;
    const fees = exitResult.fee_usd;

    // Points-per-unit for the final leg only (entry → final exit price)
    const pnlPerUnit = isShort
      ? entryPrice - exitPrice
      : exitPrice - entryPrice;

    // ── Fill-based accounting ────────────────────────────────────────────────
    // Final leg covers only the REMAINING contracts after all prior partials.
    const finalLegPnlUsd = pnlPerUnit * pos.quantity_remaining * this.contract.point_value - fees;
    const finalSlippagePts = Math.abs(exitPrice - plannedExitPrice);

    // Record the final leg on the position (so exit_legs is always complete)
    const partialExitCount = pos.exit_legs.length; // count before adding final
    const finalLeg: ExitLeg = {
      reason,
      quantity: pos.quantity_remaining,
      fill_price: exitPrice,
      fill_time_iso: exitResult.fill_time_iso,
      pnl_points: pnlPerUnit,
      pnl_usd: finalLegPnlUsd,
      fee_usd: fees,
      slippage_pts: finalSlippagePts,
    };
    pos.exit_legs.push(finalLeg);
    pos.realized_pnl_so_far += finalLegPnlUsd;
    pos.realized_fees_so_far += fees;

    // Total realized PnL = all legs accumulated
    const pnlRealized = pos.realized_pnl_so_far;
    const totalFees = pos.realized_fees_so_far;

    // R-multiple: total trade PnL relative to the initial dollar risk
    // of the FULL original position size (not just remaining contracts).
    const initialRiskPts = Math.abs(pos.entry_price - pos.stop_initial);
    const dollarRisk = initialRiskPts * pos.quantity * this.contract.point_value;
    const rMultiple = dollarRisk > 0
      ? Math.round((pnlRealized / dollarRisk) * 100) / 100
      : 0;

    const holdSeconds = Math.round((Date.now() - pos.entry_time_unix) / 1000);

    // Scratch threshold: 1 tick of dollar-value on the full position size.
    // This scales naturally with contract multiplier (NQ vs MNQ).
    const scratchDollar = this.contract.tick_value * Math.max(1, pos.quantity);
    const outcome: 'winner' | 'loser' | 'scratch' =
      pnlRealized > scratchDollar ? 'winner'
      : pnlRealized < -scratchDollar ? 'loser'
      : 'scratch';

    const confidenceBucket: 'high' | 'medium' | 'low' =
      pos.confidence >= 8.5 ? 'high' : pos.confidence >= 7.5 ? 'medium' : 'low';

    const record: TradeRecord = {
      trade_id: pos.trade_id,
      parent_signal_id: pos.signal_id,
      session_id: sessionId,
      strategy_version: stratVersion,
      indicator_config_version: pos.config_version,
      mode: exitResult.status === 'simulated' ? 'paper' : 'live',
      timestamp_signal: pos.entry_time_iso, // signal_ts approximated as entry_ts here
      timestamp_entry: pos.entry_time_iso,
      timestamp_exit: exitResult.fill_time_iso,
      symbol: this.instrumentSymbol,
      venue: this.venue,
      side: pos.side,
      setup_type: pos.setup_type,
      market_regime: pos.market_regime_at_entry,
      confidence_score: pos.confidence,
      entry_price_planned: pos.entry_price,
      entry_price_filled: pos.entry_price,
      stop_price_initial: pos.stop_initial,
      stop_price_final: pos.stop_current,
      target_1: pos.target_1,
      target_2: pos.target_2,
      target_3: pos.target_3,
      quantity: pos.quantity,
      notional_value: pos.notional,
      fee_estimate: totalFees,
      fee_actual: totalFees,
      slippage_estimate: exitResult.slippage_pts,
      slippage_actual: exitResult.slippage_pts,
      pnl_realized: Math.round(pnlRealized * 100) / 100,
      pnl_percent: pos.notional > 0
        ? Math.round((pnlRealized / pos.notional) * 10000) / 100
        : 0,
      r_multiple: rMultiple,
      hold_time_seconds: holdSeconds,
      exit_reason: reason,
      exit_reason_detailed: computeExitReasonDetailed(reason, pos.partial_exit_done, pos.trailing_active),
      mfe: Math.round(pos.max_favorable_excursion * 100) / 100,
      mae: Math.round(pos.max_adverse_excursion * 100) / 100,
      outcome_class: outcome,
      hit_target_1: pos.pt1_done || pos.partial_exit_done,
      planned_target_1: pos.planned_target_1 ?? pos.target_1,
      effective_target_1: pos.effective_target_1 ?? null,
      first_partial_fill_price: pos.first_partial_fill_price ?? null,
      hit_target_2: reason === 'target_2' || reason === 'target_3',
      stopped_out: isStoppedOut(computeExitReasonDetailed(reason, pos.partial_exit_done, pos.trailing_active)),
      exited_on_time_stop: reason === 'time_stop',
      regime_at_entry: pos.market_regime_at_entry,
      regime_at_exit: regimeAtExit,
      confidence_bucket: confidenceBucket,
      trend_alignment: true, // derived at signal time
      config_type: 'BASELINE',
      notes: `Exit reason: ${reason}. MFE: ${pos.max_favorable_excursion.toFixed(1)}pts. MAE: ${pos.max_adverse_excursion.toFixed(1)}pts.` +
        (pos.pt1_done ? ` PT1: $${pos.pt1_realized_pnl.toFixed(2)} (${pos.pt1_qty_exited}ct).` : '') +
        (pos.pt2_done ? ` PT2: $${pos.pt2_realized_pnl.toFixed(2)} (${pos.pt2_qty_exited}ct).` : ''),
      exit_price_planned: Math.round(plannedExitPrice * 100) / 100,
      exit_price_actual: exitPrice,
      exit_slippage_vs_plan_pts: Math.round(Math.abs(exitPrice - plannedExitPrice) * 100) / 100,
      max_unrealized_r: initialRiskPts > 0
        ? Math.round((pos.max_favorable_excursion / initialRiskPts) * 100) / 100
        : 0,
      max_drawdown_r: initialRiskPts > 0
        ? -Math.round((pos.max_adverse_excursion / initialRiskPts) * 100) / 100
        : 0,
      target_1_direction_valid: targetValidation.target_1_direction_valid,
      target_2_direction_valid: targetValidation.target_2_direction_valid,
      target_3_direction_valid: targetValidation.target_3_direction_valid,
      target_ordering_valid: targetValidation.target_ordering_valid,
      target_repair_applied: targetValidation.target_repair_applied,
      // ── Fill-based accounting ──────────────────────────────────────────────
      exit_legs: pos.exit_legs,
      exit_legs_count: pos.exit_legs.length,
      partial_exit_count: partialExitCount,
      pnl_pt1: pos.exit_legs.find(l => l.reason === 'partial_profit_1')?.pnl_usd ?? null,
      pnl_pt2: pos.exit_legs.find(l => l.reason === 'partial_profit_2')?.pnl_usd ?? null,
      pnl_runner: Math.round(finalLeg.pnl_usd * 100) / 100,
      total_fees_usd: Math.round(totalFees * 100) / 100,
      management_profile: pos.management_params.profile_name,
      atr_at_entry: pos.atr_at_entry,
      // ── Follow-through analytics ──────────────────────────────────────────
      mfe_at_pt1: pos.pt1_done ? Math.round((pos.mfe_at_pt1_trigger ?? 0) * 100) / 100 : null,
      mae_at_pt1: pos.pt1_done ? Math.round((pos.mae_at_pt1_trigger ?? 0) * 100) / 100 : null,
      unrealized_r_at_pt1: pos.pt1_done && initialRiskPts > 0
        ? Math.round(((pos.mfe_at_pt1_trigger ?? 0) / initialRiskPts) * 100) / 100 : null,
      mfe_after_pt1: pos.pt1_done
        ? Math.round((pos.max_favorable_excursion - (pos.mfe_at_pt1_trigger ?? 0)) * 100) / 100 : null,
      runner_capture_ratio: pos.pt1_done ? (() => {
        const postPt1Opp = pos.max_favorable_excursion - (pos.mfe_at_pt1_trigger ?? 0);
        if (postPt1Opp <= 0.01) return 0;
        const runnerLeg = pos.exit_legs.find(l => l.reason !== 'partial_profit_1' && l.reason !== 'partial_profit_2');
        const runnerPnlPts = runnerLeg ? runnerLeg.pnl_points : 0;
        return Math.round(Math.max(0, runnerPnlPts / postPt1Opp) * 100) / 100;
      })() : null,
      giveback_after_pt1_r: pos.pt1_done && initialRiskPts > 0 ? (() => {
        const peakRAfterPt1 = pos.max_favorable_excursion / initialRiskPts;
        return Math.round((peakRAfterPt1 - rMultiple) * 100) / 100;
      })() : null,
      peak_unrealized_r_before_first_partial: Math.round((pos.peak_r_before_first_partial ?? 0) * 100) / 100,
      management_variant: pos.management_variant ?? null,
      // ── Dead-Trade Guard telemetry (last-seen derived state + latches) ─
      time_to_first_positive_r_minutes: pos.time_to_first_positive_r_minutes,
      time_to_peak_r_before_first_partial_minutes: pos.time_to_peak_r_before_first_partial_minutes,
      mae_r_before_first_partial: Math.round(pos.mae_r_before_first_partial * 1000) / 1000,
      last_progress_rate_r_per_min: Math.round(pos.last_progress_rate_r_per_min * 1000) / 1000,
      last_drawdown_rate_r_per_min: Math.round(pos.last_drawdown_rate_r_per_min * 1000) / 1000,
      last_failure_ratio: Math.round(pos.last_failure_ratio * 1000) / 1000,
      last_net_progress: Math.round(pos.last_net_progress * 1000) / 1000,
      last_efficiency: Math.round(pos.last_efficiency * 1000) / 1000,
      last_recovery_gap: Math.round(pos.last_recovery_gap * 1000) / 1000,
      last_decay_rate_r_per_min: Math.round(pos.last_decay_rate_r_per_min * 1000) / 1000,
      failure_review_soft_emitted: pos.failure_review_soft_emitted,
      failure_exit_hard_fired: pos.failure_exit_hard_fired,
      failure_exit_emergency_fired: pos.failure_exit_emergency_fired,
      failure_exit_active_lane: pos.failure_exit_active_lane,
      failure_exit_reason: pos.failure_exit_reason,
      failure_exit_trigger_time_minutes: pos.failure_exit_trigger_time_minutes,
      failure_exit_shadow_only: pos.failure_exit_shadow_only,
    };

    // Emit final_runner_exit management event before clearing position
    this.emitMgmtEvent(this.buildMgmtEvent(pos, 'final_runner_exit', exitPrice, pos.stop_current, pos.stop_current, pos.quantity_remaining, 0));

    this.position = null;
    this.emitPositionChange();
    return record;
  }

  /**
   * Move stop to a new price. Only allows tightening (reducing risk).
   * Returns true if stop was moved, false if rejected (would widen risk).
   */
  moveStopTo(newStop: number): boolean {
    const pos = this.position;
    if (!pos) return false;
    const isShort = pos.side === 'short';
    const tightens = isShort ? newStop < pos.stop_current : newStop > pos.stop_current;
    if (!tightens) return false;
    const prev = pos.stop_current;
    pos.stop_current = roundToTick(newStop, this.contract);
    console.log(
      `[POS] Stop moved (ML): ${prev.toFixed(this.contract.price_decimals)} → ` +
      `${pos.stop_current.toFixed(this.contract.price_decimals)} (${isShort ? 'short' : 'long'})`,
    );
    this.emitPositionChange();
    return true;
  }

  /**
   * Move stop to breakeven (entry price). Returns true if moved.
   */
  moveStopToBreakeven(): boolean {
    const pos = this.position;
    if (!pos) return false;
    if (pos.stop_moved_to_be) return false; // already at BE
    const beStop = roundToTick(pos.entry_price, this.contract);
    const isShort = pos.side === 'short';
    const tightens = isShort ? beStop < pos.stop_current : beStop > pos.stop_current;
    if (!tightens) return false;
    const prev = pos.stop_current;
    pos.stop_current = beStop;
    pos.stop_moved_to_be = true;
    console.log(
      `[POS] Stop → BE (ML): ${prev.toFixed(this.contract.price_decimals)} → ` +
      `${beStop.toFixed(this.contract.price_decimals)}`,
    );
    this.emitPositionChange();
    return true;
  }

  /**
   * Compute current unrealized R for the open position.
   */
  getUnrealizedR(currentPrice: number): number {
    const pos = this.position;
    if (!pos) return 0;
    const riskPts = Math.abs(pos.entry_price - pos.stop_initial);
    if (riskPts <= 0) return 0;
    const isShort = pos.side === 'short';
    const pnlPts = isShort ? pos.entry_price - currentPrice : currentPrice - pos.entry_price;
    return pnlPts / riskPts;
  }

  /**
   * Build a Position from a fill result and candidate setup.
   */
  static buildPosition(
    tradeId: string,
    signalId: string,
    sessionId: string,
    setup: {
      direction: string;
      setup_type: SetupType;
      stop: number;
      target_1: number;
      target_2: number;
      target_3: number | null;
      confidence: number;
      target_1_direction_valid: boolean;
      target_2_direction_valid: boolean;
      target_3_direction_valid: boolean;
      target_ordering_valid: boolean;
      target_repair_applied: boolean;
    },
    fill: OrderResult,
    quantity: number,
    notional: number,
    regime: MarketRegime,
    configVersion: string,
    timeStopMinutes: number,
    managementParams?: ResolvedManagementParams,
    atrAtEntry?: number | null,
  ): Position {
    // Fallback management params for backwards compatibility (all zeros/defaults).
    // The Dead-Trade Guard feature is OFF in the fallback — tests and legacy
    // flows that build Positions without explicit management params get
    // unchanged behavior. Live trades always pass explicit managementParams
    // resolved via management-profiles.resolveProfile().
    const mgmt: ResolvedManagementParams = managementParams ?? {
      profile_name: 'legacy_default',
      family: 'default',
      atr_at_entry: atrAtEntry ?? null,
      pt1_offset_pts: 6,
      pt2_offset_pts: 15,
      pt1_exit_fraction: 0.5,
      pt2_exit_fraction: 0.25,
      pt1_move_to_be: true,
      pt1_activate_trailing: true,
      trail_ticks_post_t1: 12,
      breakeven_trigger_r: 0.5,
      pre_t1_trail_trigger_r: 0.75,
      pre_t1_trail_distance_ticks: 20,
      time_stop_minutes: timeStopMinutes,
      time_stop_max_r_pre_t1: 0.25,
      time_stop_max_r_post_t1: 1.0,
      // Dead-Trade Guard — OFF in fallback
      pre_t1_failure_exit_enabled: false,
      pre_t1_failure_shadow_mode: true,
      pre_t1_failure_decay_min_gap_minutes: 0.5,
      pre_t1_failure_lambda_net: 1.0,
      pre_t1_failure_soft_min_minutes: 4,
      pre_t1_failure_soft_progress_rate_max: 0.05,
      pre_t1_failure_soft_failure_ratio_min: 2.0,
      pre_t1_failure_hard_min_minutes: 5,
      pre_t1_failure_hard_current_r_alpha: 0.4,
      pre_t1_failure_curves_key: 'default',
      pre_t1_failure_min_n_per_bucket: 20,
      pre_t1_failure_emergency_min_minutes: 3,
      pre_t1_failure_emergency_mae_r_floor: 0.20,
      pre_t1_failure_emergency_failure_ratio_min: 4.0,
      pre_t1_failure_emergency_peak_r_max: 0.10,
      pre_t1_failure_emergency_decay_rate_min: 0,
      pre_t1_failure_cost_r: 0.05,
    };

    console.log(
      `[MGMT] Position opened with profile='${mgmt.profile_name}' (family=${mgmt.family}). ` +
      `PT1=${mgmt.pt1_offset_pts.toFixed(1)}pts PT2=${mgmt.pt2_offset_pts.toFixed(1)}pts ` +
      `Trail=${mgmt.trail_ticks_post_t1}tk TimeStop=${mgmt.time_stop_minutes}min ` +
      `ATR=${mgmt.atr_at_entry?.toFixed(1) ?? 'n/a'}`,
    );

    return {
      trade_id: tradeId,
      signal_id: signalId,
      session_id: sessionId,
      side: setup.direction as 'long' | 'short',
      entry_price: fill.fill_price,
      entry_time_unix: Date.now(),
      entry_time_iso: fill.fill_time_iso,
      stop_initial: setup.stop,
      stop_current: setup.stop,
      target_1: setup.target_1,
      planned_target_1: setup.target_1,
      effective_target_1: null,
      first_partial_fill_price: null,
      target_2: setup.target_2,
      target_3: setup.target_3,
      quantity,
      notional,
      setup_type: setup.setup_type,
      market_regime_at_entry: regime,
      config_version: configVersion,
      confidence: setup.confidence,
      stop_moved_to_be: false,
      partial_exit_done: false,
      quantity_remaining: quantity,
      max_favorable_excursion: 0,
      max_adverse_excursion: 0,
      last_checked_price: fill.fill_price,
      time_stop_minutes: mgmt.time_stop_minutes,
      pre_t1_be_triggered: false,
      pre_t1_trailing_active: false,
      trailing_active: false,
      trail_distance_ticks: 0,
      trail_anchor_price: null,
      target_1_direction_valid: setup.target_1_direction_valid,
      target_2_direction_valid: setup.target_2_direction_valid,
      target_3_direction_valid: setup.target_3_direction_valid,
      target_ordering_valid: setup.target_ordering_valid,
      target_repair_applied: setup.target_repair_applied,
      pt1_done: false,
      pt2_done: false,
      pt1_realized_pnl: 0,
      pt2_realized_pnl: 0,
      pt1_qty_exited: 0,
      pt2_qty_exited: 0,
      exit_legs: [],
      realized_pnl_so_far: 0,
      realized_fees_so_far: 0,
      atr_at_entry: atrAtEntry ?? null,
      management_params: mgmt,
      // Follow-through instrumentation (initialized; captured at PT1 time)
      mfe_at_pt1_trigger: 0,
      mae_at_pt1_trigger: 0,
      peak_r_before_first_partial: 0,
      // Dead-Trade Guard telemetry + latches — all zeroed at entry.
      time_to_first_positive_r_minutes: null,
      t_peak_r_minutes: null,
      time_to_peak_r_before_first_partial_minutes: null,
      mae_r_before_first_partial: 0,
      last_progress_rate_r_per_min: 0,
      last_drawdown_rate_r_per_min: 0,
      last_failure_ratio: 0,
      last_net_progress: 0,
      last_efficiency: 0,
      last_recovery_gap: 0,
      last_decay_rate_r_per_min: 0,
      failure_review_soft_emitted: false,
      failure_exit_hard_fired: false,
      failure_exit_emergency_fired: false,
      failure_exit_active_lane: 'none',
      failure_exit_reason: null,
      failure_exit_trigger_time_minutes: null,
      failure_exit_shadow_only: false,
    };
  }

  // ── Pure risk-only evaluation (hard-risk lane) ────────────────────────────
  //
  // evaluateRiskOnly() returns proposed mutations WITHOUT modifying position.
  // The hard-risk lane applies these under ExecutionLock via applyRiskMutations().
  // This separation ensures evaluation is lock-free and fast, while all position
  // mutations are serialized to prevent races between lanes.

  /**
   * Pure risk-only evaluation for the hard-risk lane.
   *
   * Evaluates breakeven trigger, pre-T1 trailing activation, trail ratchet,
   * and hard stop — but does NOT mutate position state.
   * Returns proposed mutations and an exit decision.
   *
   * Does NOT evaluate: PT1/PT2/T1 targets, time stop, MFE/MAE updates.
   * Those remain in the full evaluate() method, called by the management lane.
   */
  evaluateRiskOnly(currentPrice: number): RiskEvalResult {
    const noMutations: RiskMutations = {
      moveStopToBE: false,
      activatePreT1Trail: false,
      newTrailAnchor: null,
      newStopCurrent: null,
      emitTrailRatchetEvent: false,
      previousStopForEvent: 0,
    };
    const noExit: RiskEvalResult = {
      shouldExit: false,
      exitDecision: null,
      proposedMutations: noMutations,
      hasMutations: false,
    };

    const pos = this.position;
    if (!pos) return noExit;

    const isShort = pos.side === 'short';
    const mgmt = pos.management_params;
    const favorableMove = isShort
      ? pos.entry_price - currentPrice
      : currentPrice - pos.entry_price;

    const mutations: RiskMutations = { ...noMutations, previousStopForEvent: pos.stop_current };
    // Effective stop starts at current; mutations may tighten it
    let effectiveStop = pos.stop_current;

    // ── 1. Breakeven trigger ────────────────────────────────────────────
    if (!pos.partial_exit_done && !pos.pre_t1_be_triggered && mgmt.breakeven_trigger_r > 0) {
      const initialRiskPts = Math.abs(pos.entry_price - pos.stop_initial);
      const currentR = initialRiskPts > 0 ? favorableMove / initialRiskPts : 0;
      if (currentR >= mgmt.breakeven_trigger_r) {
        const beStop = roundToTick(pos.entry_price, this.contract);
        const tightens = isShort ? beStop < effectiveStop : beStop > effectiveStop;
        if (tightens) {
          mutations.moveStopToBE = true;
          effectiveStop = beStop;
        }
      }
    }

    // ── 2. Pre-T1 trailing activation ───────────────────────────────────
    if (!pos.partial_exit_done && !pos.pre_t1_trailing_active && mgmt.pre_t1_trail_trigger_r > 0) {
      const initialRiskPts = Math.abs(pos.entry_price - pos.stop_initial);
      const currentR = initialRiskPts > 0 ? favorableMove / initialRiskPts : 0;
      if (currentR >= mgmt.pre_t1_trail_trigger_r) {
        mutations.activatePreT1Trail = true;
      }
    }

    // ── 3. Trail ratchet ────────────────────────────────────────────────
    // Check against actual position state (trailing may already be active) or
    // the proposed activation above. If pre-T1 trail was JUST proposed, we use
    // currentPrice as the initial anchor.
    const trailingWillBeActive = pos.trailing_active || mutations.activatePreT1Trail;
    const trailTicks = mutations.activatePreT1Trail
      ? Math.max(0, Math.floor(mgmt.pre_t1_trail_distance_ticks))
      : pos.trail_distance_ticks;

    if (trailingWillBeActive && trailTicks > 0) {
      const trailDistPts = ticksToPrice(trailTicks, this.contract);

      // Compute effective anchor: existing or initial from activation
      let anchor = pos.trail_anchor_price ?? currentPrice;
      if (mutations.activatePreT1Trail) {
        anchor = currentPrice; // fresh activation — anchor is current price
      }

      // Anchor moves in favor only
      const improved = isShort ? currentPrice < anchor : currentPrice > anchor;
      if (improved) {
        mutations.newTrailAnchor = currentPrice;
        anchor = currentPrice;
      } else if (mutations.activatePreT1Trail) {
        mutations.newTrailAnchor = currentPrice; // set initial anchor
      }

      const rawTrail = isShort ? anchor + trailDistPts : anchor - trailDistPts;
      const trailStop = roundToTick(rawTrail, this.contract);
      const tighten = isShort ? trailStop < effectiveStop : trailStop > effectiveStop;
      if (tighten) {
        mutations.newStopCurrent = trailStop;
        mutations.emitTrailRatchetEvent = true;
        mutations.previousStopForEvent = effectiveStop;
        effectiveStop = trailStop;
      }
    }

    // ── 4. Hard stop check (against effective stop including proposals) ──
    const stopHit = isShort
      ? currentPrice >= effectiveStop
      : currentPrice <= effectiveStop;

    const hasMutations = mutations.moveStopToBE
      || mutations.activatePreT1Trail
      || mutations.newTrailAnchor !== null
      || mutations.newStopCurrent !== null;

    if (stopHit) {
      return {
        shouldExit: true,
        exitDecision: {
          shouldExit: true,
          reason: 'stop_loss',
          exitPrice: currentPrice,
          plannedExitPrice: effectiveStop,
          isPartial: false,
          partialQuantity: 0,
        },
        proposedMutations: mutations,
        hasMutations,
      };
    }

    return {
      shouldExit: false,
      exitDecision: null,
      proposedMutations: mutations,
      hasMutations,
    };
  }

  /**
   * Apply risk mutations proposed by evaluateRiskOnly().
   * MUST be called under ExecutionLock.
   *
   * Applies: breakeven move, pre-T1 trail activation, trail ratchet stop tightening.
   * Emits management events for observability.
   */
  applyRiskMutations(mutations: RiskMutations, currentPrice: number): void {
    const pos = this.position;
    if (!pos) return;

    const isShort = pos.side === 'short';
    const mgmt = pos.management_params;

    // ── Breakeven trigger ──
    if (mutations.moveStopToBE) {
      const beStop = roundToTick(pos.entry_price, this.contract);
      const prev = pos.stop_current;
      pos.stop_current = beStop;
      pos.pre_t1_be_triggered = true;
      pos.stop_moved_to_be = true;
      console.log(
        `[PRE-T1 BE] ${pos.side.toUpperCase()} stop ${prev.toFixed(this.contract.price_decimals)} → ` +
        `BE ${beStop.toFixed(this.contract.price_decimals)} (profile=${mgmt.profile_name})`,
      );
      this.emitMgmtEvent(this.buildMgmtEvent(pos, 'pre_t1_be_move', currentPrice, prev, beStop, pos.quantity_remaining, pos.quantity_remaining));
    }

    // ── Pre-T1 trailing activation ──
    if (mutations.activatePreT1Trail) {
      pos.pre_t1_trailing_active = true;
      pos.trailing_active = true;
      pos.trail_distance_ticks = Math.max(0, Math.floor(mgmt.pre_t1_trail_distance_ticks));
      pos.trail_anchor_price = mutations.newTrailAnchor ?? currentPrice;
      console.log(
        `[PRE-T1 TRAIL] ${pos.side.toUpperCase()} trailing armed ` +
        `(trail=${pos.trail_distance_ticks}tk, anchor=${pos.trail_anchor_price.toFixed(this.contract.price_decimals)}, profile=${mgmt.profile_name})`,
      );
      this.emitMgmtEvent(this.buildMgmtEvent(pos, 'pre_t1_trail_activation', currentPrice, pos.stop_current, pos.stop_current, pos.quantity_remaining, pos.quantity_remaining));
    }

    // ── Trail anchor update (without stop change) ──
    if (!mutations.activatePreT1Trail && mutations.newTrailAnchor !== null) {
      pos.trail_anchor_price = mutations.newTrailAnchor;
    }

    // ── Trail ratchet stop tightening ──
    if (mutations.newStopCurrent !== null) {
      const prev = pos.stop_current;
      pos.stop_current = mutations.newStopCurrent;
      console.log(
        `[TRAIL] ${pos.side.toUpperCase()} stop ${prev.toFixed(this.contract.price_decimals)} → ` +
        `${mutations.newStopCurrent.toFixed(this.contract.price_decimals)} (anchor=${pos.trail_anchor_price?.toFixed(this.contract.price_decimals) ?? '?'}, ` +
        `trail=${pos.trail_distance_ticks}tk)`,
      );
      if (mutations.emitTrailRatchetEvent) {
        this.emitMgmtEvent(this.buildMgmtEvent(pos, 'trail_ratchet', currentPrice, mutations.previousStopForEvent, mutations.newStopCurrent, pos.quantity_remaining, pos.quantity_remaining));
      }
    }

    // Emit position change if any mutation was applied
    const hasMutations = mutations.moveStopToBE || mutations.activatePreT1Trail
      || mutations.newTrailAnchor !== null || mutations.newStopCurrent !== null;
    if (hasMutations) {
      this.emitPositionChange();
    }
  }
}
