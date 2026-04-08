import { describe, it, expect } from 'vitest';
import { computeEntryFill, checkBarForExit, DEFAULT_FILL_CONFIG } from '../../src/autotrade/historical/fills.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';

const NQ = getContractSpec('NQ');

describe('computeEntryFill', () => {
  const sig = { timestamp: 1000, open: 20000, high: 20010, low: 19995, close: 20005 };
  const nxt = { timestamp: 1060, open: 20008, high: 20020, low: 20003, close: 20015 };

  it('next_bar_open: long fills at next bar open + 1 tick slippage', () => {
    const f = computeEntryFill('long', sig, nxt, NQ, { ...DEFAULT_FILL_CONFIG, slippage_ticks: 1 });
    expect(f).not.toBeNull();
    expect(f!.fill_price).toBe(20008.25); // 20008 + 0.25
    expect(f!.fill_timestamp).toBe(1060);
  });

  it('next_bar_open: short fills at next bar open - 1 tick slippage', () => {
    const f = computeEntryFill('short', sig, nxt, NQ, { ...DEFAULT_FILL_CONFIG, slippage_ticks: 1 });
    expect(f!.fill_price).toBe(20007.75);
  });

  it('signal_close: long fills at signal bar close + slippage', () => {
    const f = computeEntryFill('long', sig, nxt, NQ, { ...DEFAULT_FILL_CONFIG, entry_model: 'signal_close', slippage_ticks: 2 });
    expect(f!.fill_price).toBe(20005.5);
    expect(f!.fill_timestamp).toBe(1000);
  });

  it('next_bar_open with no next bar returns null', () => {
    const f = computeEntryFill('long', sig, null, NQ, DEFAULT_FILL_CONFIG);
    expect(f).toBeNull();
  });
});

describe('checkBarForExit — OHLC ambiguity', () => {
  const barBoth = { timestamp: 1000, open: 20000, high: 20020, low: 19980, close: 20005 };
  const barTarget = { timestamp: 1000, open: 20000, high: 20020, low: 19995, close: 20015 };
  const barStop = { timestamp: 1000, open: 20000, high: 20005, low: 19980, close: 19985 };
  const barNothing = { timestamp: 1000, open: 20000, high: 20005, low: 19995, close: 20002 };

  const targets = { t1: 20010, t2: 20015, t3: null };
  const STOP = 19990;

  it('unambiguous target_1 hit on long', () => {
    const r = checkBarForExit(barTarget, 'long', STOP, targets, NQ, DEFAULT_FILL_CONFIG);
    expect(r.trigger).toBe('target_1');
    expect(r.ambiguous).toBe(false);
  });

  it('unambiguous stop hit on long', () => {
    const r = checkBarForExit(barStop, 'long', STOP, targets, NQ, DEFAULT_FILL_CONFIG);
    expect(r.trigger).toBe('stop');
    expect(r.ambiguous).toBe(false);
  });

  it('no trigger when neither level is touched', () => {
    const r = checkBarForExit(barNothing, 'long', STOP, targets, NQ, DEFAULT_FILL_CONFIG);
    expect(r.trigger).toBeNull();
  });

  it('CONSERVATIVE policy picks stop when both were touched', () => {
    const r = checkBarForExit(barBoth, 'long', STOP, targets, NQ, { ...DEFAULT_FILL_CONFIG, ambiguity_policy: 'conservative' });
    expect(r.trigger).toBe('stop');
    expect(r.ambiguous).toBe(true);
    expect(r.notes).toContain('conservative');
  });

  it('OPTIMISTIC policy picks target when both were touched', () => {
    const r = checkBarForExit(barBoth, 'long', STOP, targets, NQ, { ...DEFAULT_FILL_CONFIG, ambiguity_policy: 'optimistic' });
    expect(r.trigger).toBe('target_1');
    expect(r.ambiguous).toBe(true);
    expect(r.notes).toContain('optimistic');
  });

  it('SKIP policy returns ambiguous_skipped', () => {
    const r = checkBarForExit(barBoth, 'long', STOP, targets, NQ, { ...DEFAULT_FILL_CONFIG, ambiguity_policy: 'skip' });
    expect(r.trigger).toBe('ambiguous_skipped');
    expect(r.ambiguous).toBe(true);
  });

  it('applies slippage in the correct direction (long stop)', () => {
    const r = checkBarForExit(barStop, 'long', STOP, targets, NQ, { ...DEFAULT_FILL_CONFIG, slippage_ticks: 2 });
    expect(r.trigger).toBe('stop');
    expect(r.actual_fill_price).toBeCloseTo(STOP - 0.5, 2); // 2 ticks = 0.5
  });

  it('short-side exits mirror long-side logic', () => {
    const targetShort = { t1: 19990, t2: 19985, t3: null };
    const STOP_SHORT = 20010;
    const r = checkBarForExit(barTarget, 'short', STOP_SHORT, targetShort, NQ, DEFAULT_FILL_CONFIG);
    // barTarget has low=19995 which is > 19990, so NOT hit for short target
    // but high=20020 > STOP_SHORT=20010 → stop hit
    expect(r.trigger).toBe('stop');
  });
});
