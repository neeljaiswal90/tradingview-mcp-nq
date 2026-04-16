import { EventEmitter } from 'events';
import type { ContractRoot } from './contracts.js';

export interface PositionOpenedEvent {
  type: 'position_opened';
  instrument_id: ContractRoot;
  trade_id: string;
  side: 'long' | 'short';
  risk_usd: number;
  timestamp: string;
}

export interface PositionClosedEvent {
  type: 'position_closed';
  instrument_id: ContractRoot;
  trade_id: string;
  pnl_usd: number;
  exit_reason: string;
  timestamp: string;
}

export interface SignalGeneratedEvent {
  type: 'signal_generated';
  instrument_id: ContractRoot;
  signal_id: string;
  direction: 'long' | 'short' | 'none';
  confidence: number;
  verdict: string;
  timestamp: string;
}

export interface KillSwitchEvent {
  type: 'kill_switch';
  instrument_id: ContractRoot;
  activated: boolean;
  reason: string;
  timestamp: string;
}

export interface DailyLimitHitEvent {
  type: 'daily_limit_hit';
  instrument_id: ContractRoot;
  daily_pnl_usd: number;
  limit_pct: number;
  timestamp: string;
}

export type InstrumentEvent =
  | PositionOpenedEvent
  | PositionClosedEvent
  | SignalGeneratedEvent
  | KillSwitchEvent
  | DailyLimitHitEvent;

type EventHandler<T extends InstrumentEvent> = (event: T) => void;

export class InstrumentEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(20);
  }

  emit(event: InstrumentEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit('*', event);
  }

  on<T extends InstrumentEvent['type']>(
    type: T,
    handler: EventHandler<Extract<InstrumentEvent, { type: T }>>,
  ): void {
    this.emitter.on(type, handler as (event: InstrumentEvent) => void);
  }

  onAll(handler: (event: InstrumentEvent) => void): void {
    this.emitter.on('*', handler);
  }

  off<T extends InstrumentEvent['type']>(
    type: T,
    handler: EventHandler<Extract<InstrumentEvent, { type: T }>>,
  ): void {
    this.emitter.off(type, handler as (event: InstrumentEvent) => void);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
