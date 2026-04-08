import { describe, it, expect } from 'vitest';
import {
  getContractSpec,
  tryGetContractSpec,
  roundToTick,
  roundToTickAwayFromEntry,
  priceToTicks,
  ticksToPrice,
  riskPerContract,
  normalizeStopDistance,
  pickDefaultSymbol,
} from '../../src/autotrade/contracts.js';

describe('getContractSpec', () => {
  it('resolves NQ from several aliases', () => {
    const a = getContractSpec('NQ');
    const b = getContractSpec('NQ1!');
    const c = getContractSpec('CME_MINI:NQ1!');
    expect(a.root).toBe('NQ');
    expect(b.root).toBe('NQ');
    expect(c.root).toBe('NQ');
    expect(a.point_value).toBe(20);
    expect(a.tick_size).toBe(0.25);
    expect(a.tick_value).toBe(5);
  });

  it('resolves MNQ and identifies it as micro', () => {
    const m = getContractSpec('MNQ1!');
    expect(m.root).toBe('MNQ');
    expect(m.point_value).toBe(2);
    expect(m.tick_value).toBe(0.5);
    expect(m.is_micro).toBe(true);
  });

  it('throws on unknown roots', () => {
    expect(() => getContractSpec('BTCUSD')).toThrow(/Unknown futures symbol/);
  });

  it('tryGetContractSpec returns null instead of throwing', () => {
    expect(tryGetContractSpec('WAT')).toBeNull();
  });

  it('pickDefaultSymbol returns MNQ1!', () => {
    expect(pickDefaultSymbol()).toBe('MNQ1!');
  });
});

describe('tick rounding', () => {
  const NQ = getContractSpec('NQ');

  it('roundToTick snaps to nearest 0.25', () => {
    expect(roundToTick(20000.10, NQ)).toBe(20000.00);
    expect(roundToTick(20000.13, NQ)).toBe(20000.25);
    expect(roundToTick(20000.26, NQ)).toBe(20000.25);
    expect(roundToTick(20000.38, NQ)).toBe(20000.50);
  });

  it('roundToTickAwayFromEntry pushes stop AWAY from entry', () => {
    // Long: entry 20000, stop below entry should round DOWN.
    const stopLong = roundToTickAwayFromEntry(19990.10, 20000, 'stop', 'long', NQ);
    expect(stopLong).toBe(19990.00);
    // Short: entry 20000, stop above entry should round UP.
    const stopShort = roundToTickAwayFromEntry(20010.10, 20000, 'stop', 'short', NQ);
    expect(stopShort).toBe(20010.25);
  });

  it('roundToTickAwayFromEntry pushes target AWAY from entry', () => {
    // Long: target above entry rounds UP.
    const tLong = roundToTickAwayFromEntry(20015.10, 20000, 'target', 'long', NQ);
    expect(tLong).toBe(20015.25);
    // Short: target below entry rounds DOWN.
    const tShort = roundToTickAwayFromEntry(19984.90, 20000, 'target', 'short', NQ);
    expect(tShort).toBe(19984.75);
  });

  it('priceToTicks / ticksToPrice roundtrip', () => {
    expect(priceToTicks(5.0, NQ)).toBe(20); // 5pts = 20 ticks
    expect(ticksToPrice(20, NQ)).toBe(5.0);
    expect(priceToTicks(0.30, NQ)).toBe(1); // rounds to nearest tick
  });
});

describe('risk / sizing math', () => {
  const NQ = getContractSpec('NQ');
  const MNQ = getContractSpec('MNQ');

  it('riskPerContract multiplies stop points × point_value', () => {
    expect(riskPerContract(10, NQ)).toBe(200); // 10pts × $20
    expect(riskPerContract(10, MNQ)).toBe(20); // 10pts × $2
  });

  it('normalizeStopDistance enforces at least 2 ticks', () => {
    expect(normalizeStopDistance(0.1, NQ)).toBe(0.5); // 2 ticks = 0.5
    expect(normalizeStopDistance(10, NQ)).toBe(10);
    // Weird floating point distance -> snapped
    expect(normalizeStopDistance(3.33, NQ)).toBe(3.25);
  });
});
