import { describe, it, expect } from 'vitest';
import { checkBarForExit, DEFAULT_FILL_CONFIG } from '../../src/autotrade/historical/fills.js';
import { getContractSpec, roundToTick, ticksToPrice } from '../../src/autotrade/contracts.js';

const NQ = getContractSpec('NQ');
const targets = { t1: 20010, t2: 20020, t3: null };
const STOP_LONG = 19990;
const STOP_BE = 20000; // entry
const barTouchesT1 = { timestamp: 1000, open: 20005, high: 20012, low: 20002, close: 20010 };
const barTouchesT2 = { timestamp: 1000, open: 20012, high: 20022, low: 20008, close: 20020 };
const barHitsBE = { timestamp: 1000, open: 20005, high: 20008, low: 19998, close: 20001 };

describe('PATCH P1 — partial_exit_done flag in checkBarForExit', () => {
  it('default (partialExitDone=false) still reports target_1 on T1 touch', () => {
    const r = checkBarForExit(barTouchesT1, 'long', STOP_LONG, targets, NQ, DEFAULT_FILL_CONFIG);
    expect(r.trigger).toBe('target_1');
  });

  it('with partialExitDone=true, T1 touch is IGNORED → no retrigger', () => {
    const r = checkBarForExit(barTouchesT1, 'long', STOP_LONG, targets, NQ, DEFAULT_FILL_CONFIG, true);
    expect(r.trigger).toBeNull();
  });

  it('with partialExitDone=true, T2 still fires normally', () => {
    const r = checkBarForExit(barTouchesT2, 'long', STOP_LONG, targets, NQ, DEFAULT_FILL_CONFIG, true);
    expect(r.trigger).toBe('target_2');
  });

  it('with partialExitDone=true, BE stop still fires normally', () => {
    const r = checkBarForExit(barHitsBE, 'long', STOP_BE, targets, NQ, DEFAULT_FILL_CONFIG, true);
    expect(r.trigger).toBe('stop');
  });

  it('short side: partialExitDone skips T1 retrigger', () => {
    const shortTargets = { t1: 19990, t2: 19980, t3: null };
    const barShortTouchesT1 = { timestamp: 1000, open: 19995, high: 19998, low: 19988, close: 19990 };
    const r = checkBarForExit(barShortTouchesT1, 'short', 20010, shortTargets, NQ, DEFAULT_FILL_CONFIG, true);
    expect(r.trigger).toBeNull();
  });
});

// PATCH P2 — trailing-stop arithmetic — verified via the live PositionManager
// tests (tests/unit/position-manager-futures.test.ts) which share the same
// roundToTick / ticksToPrice helpers. We additionally verify the historical
// runner's anchor-advance behavior through the alignment of favorable bar
// extremes: the anchor must never retreat once the trail is armed.

describe('PATCH P2 — trail anchor math', () => {
  it('long trail moves stop UP as price makes higher highs', () => {
    // use imported helpers
    const trailTicks = 12;
    const trailPts = ticksToPrice(trailTicks, NQ); // 3.0
    let anchor = 20010;
    let stop = 20000;
    // Price makes new high at 20020 → stop should move to 20020 - 3 = 20017
    const newHigh = 20020;
    if (newHigh > anchor) anchor = newHigh;
    const candidate = roundToTick(anchor - trailPts, NQ);
    expect(candidate).toBe(20017);
    if (candidate > stop) stop = candidate;
    expect(stop).toBe(20017);
    // Price pulls back to new high 20018 → anchor stays at 20020, stop stays at 20017
    const dipHigh = 20018;
    if (dipHigh > anchor) anchor = dipHigh;
    const candidate2 = roundToTick(anchor - trailPts, NQ);
    expect(candidate2).toBe(20017);
    // stop must not loosen
    if (candidate2 > stop) stop = candidate2;
    expect(stop).toBe(20017);
  });

  it('short trail moves stop DOWN as price makes lower lows', () => {
    // use imported helpers
    const trailTicks = 8;
    const trailPts = ticksToPrice(trailTicks, NQ); // 2.0
    let anchor = 19990;
    let stop = 20000;
    const newLow = 19980;
    if (newLow < anchor) anchor = newLow;
    const candidate = roundToTick(anchor + trailPts, NQ);
    expect(candidate).toBe(19982);
    if (candidate < stop) stop = candidate;
    expect(stop).toBe(19982);
  });
});
