/**
 * Risk Manager — enforces daily loss limits,
 * pre-trade safety checks, and FUTURES-AWARE position sizing (integer
 * contracts sized from stop distance, tick value, and contract multiplier).
 */

import type { CandidateSetup, RiskState, IndicatorConfig, MarketRegime } from './types.js';
import type { ContractSpec } from './contracts.js';
import { normalizeStopDistance, riskPerContract, priceToTicks } from './contracts.js';
import {
  computeTargetPosition,
  DEFAULT_POSITION_TARGET_CONFIG,
  logTargetPositionDecision,
  type TargetPositionContext,
  type TargetPositionResult,
  type BoundBy,
} from './target-position.js';

/**
 * Invariant I2: max net open position per symbol. The sum of all currently
 * open contracts on a single symbol may never exceed this cap, regardless of
 * how it is reached (single entry, scale-in, or stop-and-reverse). This runs
 * independently of the execution-policy layer's max_position_size, which is
 * disabled by default. Raising this value requires ≥100 real paper trades of
 * per-symbol evidence — never raise on backtest alone.
 */
export const MAX_NET_POSITION_PER_SYMBOL = 10;

export interface SizingResult {
  /** Integer number of contracts to trade. */
  quantity: number;
  /** Dollar notional = quantity * entryMid * point_value. */
  notional: number;
  /** Dollars at risk given normalized stop distance * quantity. */
  risk_usd: number;
  /** Max dollars the risk budget permits per trade. */
  max_risk_usd: number;
  /** Normalized stop distance (points), tick-rounded, >= 2 ticks. */
  stop_distance_pts: number;
  /** Whole-tick count of the normalized stop distance. */
  stop_distance_ticks: number;
  /** Per-contract dollar risk. */
  risk_per_contract_usd: number;
  /** Reason the sizing was clamped/zeroed, if applicable. */
  reason: string;
  // ── Diagnostic fields (added for clearer rejection logging) ──────────────
  /** Exact account equity used for this sizing computation. */
  equity: number;
  /** max_risk_per_trade_pct value used for this computation. */
  max_risk_pct_used: number;
  /** budget / risk_per_contract before Math.floor — shows "how many contracts" in fractional terms. */
  contracts_raw: number;
  // ── Target-position fields (populated when calcTargetSizing path is used) ─
  /** Full TargetPositionResult if the target-position model produced this sizing. */
  target_position?: TargetPositionResult;
  /** Which cap bound — convenience shortcut for callers that don't want to reach into target_position. */
  bound_by?: BoundBy;
}

export class RiskManager {
  private state: RiskState;
  private readonly config: IndicatorConfig;
  private readonly contract: ContractSpec;

  constructor(config: IndicatorConfig, contract: ContractSpec) {
    this.config = config;
    this.contract = contract;
    this.state = {
      daily_pnl_usd: 0,
      daily_loss_pct: 0,
      consecutive_losses: 0,
      total_trades_today: 0,
      is_locked: false,
      lock_reason: null,
    };
  }

  getState(): Readonly<RiskState> {
    return { ...this.state };
  }

  isLocked(): boolean {
    return this.state.is_locked;
  }

  getLockReason(): string | null {
    return this.state.lock_reason;
  }

  /**
   * Run pre-trade safety checks. Returns null if OK, else a reason string.
   *
   * @param setup - The candidate setup to validate
   * @param dynamicMinRr - When provided, uses this instead of config.min_rr for the RR gate.
   *                        This is the canonical dynamic min RR from buildDynamicRewardPlan().
   *                        When null/undefined, falls back to config.min_rr (legacy behavior).
   * @param currentOpenQty - Current open contracts on this symbol (0 if no position).
   *                        Enforces invariant I2 (MAX_NET_POSITION_PER_SYMBOL).
   */
  preTradeCheck(
    setup: CandidateSetup,
    dynamicMinRr?: number | null,
    currentOpenQty: number = 0,
  ): string | null {
    if (this.state.is_locked) {
      return `risk_locked: ${this.state.lock_reason}`;
    }

    // Use dynamic min RR when provided (from reward plan), else legacy fixed value
    const effectiveMinRr = dynamicMinRr ?? this.config.min_rr;
    if (setup.rr_t1 < effectiveMinRr) {
      return `rr_insufficient: ${setup.rr_t1} < ${effectiveMinRr}`;
    }

    // Size the trade — reject if we cannot place even one contract within risk
    const sizing = this.calcPositionSize(setup);
    if (sizing.quantity <= 0) {
      return `sizing_zero_contracts: ${sizing.reason}`;
    }

    // Invariant I2: enforce max net open position per symbol. Runs after
    // sizing so the rejection reason includes the exact numbers.
    const projectedQty = currentOpenQty + sizing.quantity;
    if (projectedQty > MAX_NET_POSITION_PER_SYMBOL) {
      return `net_position_cap: ${currentOpenQty} + ${sizing.quantity} > ${MAX_NET_POSITION_PER_SYMBOL}`;
    }

    return null;
  }

  /**
   * Compute a futures-aware position size.
   *
   * Approach:
   *   1. Normalize stop distance to whole ticks (≥ 2 ticks).
   *   2. Compute risk-per-contract in dollars (stop_ticks * tick_value).
   *   3. Budget = account_equity * max_risk_per_trade_pct.
   *   4. quantity = floor(budget / risk_per_contract), but ≥ 0.
   */
  calcPositionSize(setup: CandidateSetup): SizingResult {
    const equity = this.config.account_equity;
    const maxRiskUsd = equity * (this.config.max_risk_per_trade_pct / 100);
    const rawStopPts = setup.risk_pts;
    const stopPts = normalizeStopDistance(rawStopPts, this.contract);
    const stopTicks = priceToTicks(stopPts, this.contract);
    const riskPerK = riskPerContract(stopPts, this.contract);

    if (riskPerK <= 0) {
      return {
        quantity: 0,
        notional: 0,
        risk_usd: 0,
        max_risk_usd: round2(maxRiskUsd),
        stop_distance_pts: stopPts,
        stop_distance_ticks: stopTicks,
        risk_per_contract_usd: 0,
        reason: 'risk_per_contract_non_positive',
        equity,
        max_risk_pct_used: this.config.max_risk_per_trade_pct,
        contracts_raw: 0,
      };
    }

    const contractsRaw = maxRiskUsd / riskPerK;
    let qty = Math.floor(contractsRaw);
    let reason = 'ok';

    if (qty <= 0) {
      reason = `budget_$${maxRiskUsd.toFixed(2)}_lt_risk_per_contract_$${riskPerK.toFixed(2)}`;
    }

    // Invariant I1: absolute per-order cap (q_hardcap). Never exceed this
    // number of contracts regardless of risk budget, edge estimate, or
    // liquidity. Sized for MNQ/MES micros; raising requires ≥100 real paper
    // trades of per-symbol evidence — never raise on backtest alone.
    const HARD_CAP = 10;
    if (qty > HARD_CAP) {
      qty = HARD_CAP;
      reason = `capped_at_${HARD_CAP}`;
    }

    const entryMid = (setup.entry_low + setup.entry_high) / 2;
    const notional = qty * entryMid * this.contract.point_value;
    const riskUsd = qty * riskPerK;

    return {
      quantity: qty,
      notional: round2(notional),
      risk_usd: round2(riskUsd),
      max_risk_usd: round2(maxRiskUsd),
      stop_distance_pts: stopPts,
      stop_distance_ticks: stopTicks,
      risk_per_contract_usd: round2(riskPerK),
      reason,
      equity,
      max_risk_pct_used: this.config.max_risk_per_trade_pct,
      contracts_raw: round2(contractsRaw),
    };
  }

  /**
   * Build a TargetPositionContext for the entry path from a CandidateSetup.
   * The canonical entry stop-distance is |entry_midpoint - setup.stop| (same
   * midpoint used by legacy calcPositionSize at risk.ts:143), and the confidence
   * source is 'entry_setup' so normalizeConfidence() divides by 10.
   *
   * @param setup           The candidate setup being sized
   * @param regime          Current market regime (or null if unknown)
   * @param sessionBucket   Current session bucket (e.g. 'NY_AM', 'LUNCH') or null
   */
  buildTargetContextFromSetup(
    setup: CandidateSetup,
    regime: MarketRegime | null,
    sessionBucket: string | null,
  ): TargetPositionContext {
    const entryMid = (setup.entry_low + setup.entry_high) / 2;
    const stopDistPts = Math.abs(entryMid - setup.stop);
    const cfg = this.config.position_target ?? DEFAULT_POSITION_TARGET_CONFIG;

    return {
      stop_distance_pts: stopDistPts,
      contract: this.contract,
      equity: this.config.account_equity,
      max_risk_per_trade_pct: this.config.max_risk_per_trade_pct,
      confidence_raw: setup.confidence,
      confidence_source: 'entry_setup',
      regime,
      session_bucket: sessionBucket,
      daily_loss_pct: this.state.daily_loss_pct,
      max_daily_loss_pct: this.config.max_daily_loss_pct,
      hard_cap: cfg.hard_cap,
      config: cfg,
    };
  }

  /**
   * Futures-aware sizing via the dynamic target-position model (V1a).
   *
   * Computes q*(t) = floor(min(q_risk, q_softcap, q_hardcap)) and returns a
   * SizingResult-shaped object so the entry path can drop this in wherever
   * calcPositionSize() was used. The full TargetPositionResult is attached on
   * the `target_position` field so downstream code (logging, dashboard) can
   * inspect factors without recomputing.
   *
   * V1a policy: entry fills at the full q*(t_0) — no fractional entry. If
   * position_target is disabled in config, falls back to legacy calcPositionSize.
   */
  calcTargetSizing(
    setup: CandidateSetup,
    regime: MarketRegime | null,
    sessionBucket: string | null,
  ): SizingResult {
    const cfg = this.config.position_target;
    if (!cfg || !cfg.enabled) {
      // Target-position disabled — preserve legacy behavior verbatim.
      return this.calcPositionSize(setup);
    }

    const ctx = this.buildTargetContextFromSetup(setup, regime, sessionBucket);
    const tp = computeTargetPosition(ctx);

    const qty = tp.q_target;
    const entryMid = (setup.entry_low + setup.entry_high) / 2;
    const notional = qty * entryMid * this.contract.point_value;
    const riskUsd = qty * tp.risk_per_contract_usd;
    const contractsRaw =
      tp.risk_per_contract_usd > 0 ? tp.max_risk_usd / tp.risk_per_contract_usd : 0;

    // Compose reason that distinguishes legacy budget-block from target clamping.
    let reason = tp.reason;
    if (qty <= 0 && reason === 'ok') reason = 'target_zero';
    else if (qty > 0 && tp.bound_by !== 'risk') reason = `bound_by_${tp.bound_by}`;

    return {
      quantity: qty,
      notional: round2(notional),
      risk_usd: round2(riskUsd),
      max_risk_usd: round2(tp.max_risk_usd),
      stop_distance_pts: tp.stop_distance_pts,
      stop_distance_ticks: tp.stop_distance_ticks,
      risk_per_contract_usd: round2(tp.risk_per_contract_usd),
      reason,
      equity: this.config.account_equity,
      max_risk_pct_used: this.config.max_risk_per_trade_pct,
      contracts_raw: round2(contractsRaw),
      target_position: tp,
      bound_by: tp.bound_by,
    };
  }

  /**
   * Emit the [TARGET_POS][entry] structured log line for an entry-sized trade.
   * Mirrors logSizingDecision() in calling convention so the entry path can
   * call both (legacy [SIZING] line + new [TARGET_POS] line) until the legacy
   * line is phased out.
   */
  logTargetSizingDecision(
    sizing: SizingResult,
    direction: 'long' | 'short',
    contractRoot: string,
    approved: boolean,
  ): void {
    if (!sizing.target_position) return; // Nothing to log if target-position path wasn't used
    logTargetPositionDecision(sizing.target_position, {
      tag: 'entry',
      approved,
      equity: sizing.equity,
      direction,
      contractRoot,
    });
  }

  /**
   * Emit a structured sizing log line containing every input and output
   * that affects the position-size decision. Call this for both approved
   * and rejected trades so operators can diagnose budget issues at a glance.
   *
   * @param sizing   Result of calcPositionSize().
   * @param direction 'long' | 'short'
   * @param contractRoot  e.g. 'NQ' or 'MNQ'
   * @param pointValue  Contract point value ($/pt), e.g. 20 for NQ, 2 for MNQ.
   * @param approved  true = trade will fire; false = blocked.
   */
  logSizingDecision(
    sizing: SizingResult,
    direction: 'long' | 'short',
    contractRoot: string,
    pointValue: number,
    approved: boolean,
  ): void {
    const icon = approved ? '✅' : '🚫';
    const tag = approved ? '[SIZING]' : '[SIZING_BLOCKED]';
    console.log(
      `${tag} ${icon} ${direction.toUpperCase()} ${contractRoot} ` +
      `account_equity=$${sizing.equity.toLocaleString()} ` +
      `max_risk_pct=${sizing.max_risk_pct_used}% ` +
      `risk_budget=$${sizing.max_risk_usd} ` +
      `stop=${sizing.stop_distance_pts}pts (${sizing.stop_distance_ticks}tk) ` +
      `point_value=$${pointValue}/pt ` +
      `risk_per_contract=$${sizing.risk_per_contract_usd} ` +
      `contracts_raw=${sizing.contracts_raw} ` +
      `contracts_final=${sizing.quantity} ` +
      `reason=${sizing.reason}`,
    );
  }

  recordTradeOpen(): void {
    this.state.total_trades_today++;
  }

  recordTradeClose(pnlUsd: number, outcomeClass: 'winner' | 'loser' | 'scratch' = 'scratch'): void {
    this.state.daily_pnl_usd += pnlUsd;
    this.state.daily_loss_pct =
      Math.abs(Math.min(0, this.state.daily_pnl_usd)) /
      this.config.account_equity * 100;

    if (outcomeClass === 'loser') {
      this.state.consecutive_losses++;
    } else if (outcomeClass === 'winner') {
      this.state.consecutive_losses = 0;
    }

    if (this.state.daily_loss_pct >= this.config.max_daily_loss_pct) {
      this.lock(`daily_loss_limit_${this.state.daily_loss_pct.toFixed(2)}%`);
    }
  }

  resetDaily(): void {
    this.state = {
      daily_pnl_usd: 0,
      daily_loss_pct: 0,
      consecutive_losses: 0,
      total_trades_today: 0,
      is_locked: false,
      lock_reason: null,
    };
  }

  private lock(reason: string): void {
    this.state.is_locked = true;
    this.state.lock_reason = reason;
    console.warn(`[RISK] 🔒 Risk lock activated: ${reason}`);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
