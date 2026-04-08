/**
 * Execution Adapter — abstracts paper, signal-only, and live order placement
 * for FUTURES contracts (NQ / MNQ). Quantities are integer contracts; fills
 * are tick-rounded against the active contract spec.
 *
 * Paper mode simulates fills and tracks PnL in-memory.
 * Live mode is a placeholder that requires explicit LIVE_TRADING_ENABLED=true.
 */

import type { CandidateSetup, ExecutionMode, OrderResult } from './types.js';
import type { ContractSpec } from './contracts.js';
import { roundToTick } from './contracts.js';

export type { OrderResult } from './types.js';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ExecutionAdapter {
  mode: ExecutionMode;
  placeEntry(setup: CandidateSetup, quantity: number, currentPrice: number): Promise<OrderResult>;
  placeExit(side: 'long' | 'short', quantity: number, currentPrice: number, reason: string): Promise<OrderResult>;
  isAvailable(): boolean;
}

// ─── Paper Adapter ────────────────────────────────────────────────────────────

export class PaperAdapter implements ExecutionAdapter {
  readonly mode: ExecutionMode = 'paper';
  private orderSeq = 0;
  private readonly contract: ContractSpec;
  /** Slippage, in ticks, applied to every simulated fill. */
  private readonly slippageTicks: number;
  /** Commission per contract, per side, in USD (round-trip approximation). */
  private readonly commissionPerContract: number;

  constructor(contract: ContractSpec, opts: { slippage_ticks?: number; commission_per_contract?: number } = {}) {
    this.contract = contract;
    this.slippageTicks = opts.slippage_ticks ?? 1;
    this.commissionPerContract = opts.commission_per_contract ?? (contract.is_micro ? 0.5 : 2.25);
  }

  isAvailable(): boolean {
    return true;
  }

  async placeEntry(
    setup: CandidateSetup,
    quantity: number,
    currentPrice: number,
  ): Promise<OrderResult> {
    const orderId = `PAPER-ENTRY-${Date.now()}-${++this.orderSeq}`;
    const slippagePts = this.slippageTicks * this.contract.tick_size;
    const rawFill = setup.direction === 'long'
      ? currentPrice + slippagePts
      : currentPrice - slippagePts;
    const fillPrice = roundToTick(rawFill, this.contract);

    const feeUsd = this.commissionPerContract * Math.abs(quantity);

    console.log(
      `[PAPER] ✅ Entry filled: ${setup.direction.toUpperCase()} ${quantity} ${this.contract.root} ` +
      `@ ${fillPrice.toFixed(this.contract.price_decimals)} | Stop: ${setup.stop} | T1: ${setup.target_1} ` +
      `| slip=${this.slippageTicks}tk fee=$${feeUsd.toFixed(2)}`,
    );

    return {
      order_id: orderId,
      fill_price: fillPrice,
      fill_time_iso: new Date().toISOString(),
      quantity,
      side: setup.direction as 'long' | 'short',
      slippage_pts: slippagePts,
      fee_usd: Math.round(feeUsd * 100) / 100,
      status: 'simulated',
    };
  }

  async placeExit(
    side: 'long' | 'short',
    quantity: number,
    currentPrice: number,
    reason: string,
  ): Promise<OrderResult> {
    const orderId = `PAPER-EXIT-${Date.now()}-${++this.orderSeq}`;
    const slippagePts = this.slippageTicks * this.contract.tick_size;
    const rawFill = side === 'long'
      ? currentPrice - slippagePts
      : currentPrice + slippagePts;
    const fillPrice = roundToTick(rawFill, this.contract);

    const feeUsd = this.commissionPerContract * Math.abs(quantity);

    console.log(
      `[PAPER] 🚪 Exit filled: ${side.toUpperCase()} ${quantity} ${this.contract.root} ` +
      `@ ${fillPrice.toFixed(this.contract.price_decimals)} | reason=${reason} ` +
      `slip=${this.slippageTicks}tk fee=$${feeUsd.toFixed(2)}`,
    );

    return {
      order_id: orderId,
      fill_price: fillPrice,
      fill_time_iso: new Date().toISOString(),
      quantity,
      side,
      slippage_pts: slippagePts,
      fee_usd: Math.round(feeUsd * 100) / 100,
      status: 'simulated',
    };
  }
}

// ─── Signal-Only Adapter ──────────────────────────────────────────────────────

export class SignalOnlyAdapter implements ExecutionAdapter {
  readonly mode: ExecutionMode = 'signal_only';
  private readonly contract: ContractSpec;

  constructor(contract: ContractSpec) {
    this.contract = contract;
  }

  isAvailable(): boolean { return true; }

  async placeEntry(setup: CandidateSetup, quantity: number, currentPrice: number): Promise<OrderResult> {
    console.log(
      `[SIGNAL] 📡 Signal: ${setup.direction.toUpperCase()} ${quantity} ${this.contract.root} ` +
      `@ ~${currentPrice.toFixed(this.contract.price_decimals)} ` +
      `| Entry: ${setup.entry_low}–${setup.entry_high} | Stop: ${setup.stop}`,
    );
    return {
      order_id: `SIGNAL-${Date.now()}`,
      fill_price: roundToTick(currentPrice, this.contract),
      fill_time_iso: new Date().toISOString(),
      quantity,
      side: setup.direction as 'long' | 'short',
      slippage_pts: 0,
      fee_usd: 0,
      status: 'simulated',
    };
  }

  async placeExit(side: 'long' | 'short', quantity: number, currentPrice: number, reason: string): Promise<OrderResult> {
    console.log(
      `[SIGNAL] 📡 Exit signal: ${side.toUpperCase()} ${quantity} ${this.contract.root} ` +
      `@ ~${currentPrice.toFixed(this.contract.price_decimals)} | ${reason}`,
    );
    return {
      order_id: `SIGNAL-EXIT-${Date.now()}`,
      fill_price: roundToTick(currentPrice, this.contract),
      fill_time_iso: new Date().toISOString(),
      quantity,
      side,
      slippage_pts: 0,
      fee_usd: 0,
      status: 'simulated',
    };
  }
}

// ─── Live Adapter (placeholder — disabled for futures in this task) ─────────

export class LiveAdapter implements ExecutionAdapter {
  readonly mode: ExecutionMode = 'live';

  isAvailable(): boolean {
    // Futures live trading is intentionally NOT implemented in this task.
    return false;
  }

  async placeEntry(_setup: CandidateSetup, _quantity: number, _price: number): Promise<OrderResult> {
    throw new Error('Live futures execution is not implemented. Paper-only in this task.');
  }

  async placeExit(_side: 'long' | 'short', _quantity: number, _price: number, _reason: string): Promise<OrderResult> {
    throw new Error('Live futures execution is not implemented. Paper-only in this task.');
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAdapter(
  mode: ExecutionMode,
  liveEnabled: boolean,
  contract: ContractSpec,
): ExecutionAdapter {
  if (mode === 'live') {
    if (!liveEnabled) {
      console.warn('[EXEC] ⚠️  MODE=live but LIVE_TRADING_ENABLED=false → downgrading to paper');
      return new PaperAdapter(contract);
    }
    const live = new LiveAdapter();
    if (!live.isAvailable()) {
      console.warn('[EXEC] ⚠️  Live futures adapter unavailable → downgrading to paper');
      return new PaperAdapter(contract);
    }
    return live;
  }
  if (mode === 'signal_only') {
    return new SignalOnlyAdapter(contract);
  }
  return new PaperAdapter(contract);
}
