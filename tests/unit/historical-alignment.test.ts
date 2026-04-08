import { describe, it, expect } from 'vitest';
import { Aligner } from '../../src/autotrade/historical/alignment.js';
import type { HistoricalBar } from '../../src/autotrade/historical/schema.js';

function bar(ts: number): HistoricalBar {
  return {
    timestamp: ts, open: 100, high: 101, low: 99, close: 100, volume: 1,
    vwap: 100,
    upper_band_1: 102, lower_band_1: 98,
    upper_band_2: 103, lower_band_2: 97,
    upper_band_3: 104, lower_band_3: 96,
  };
}

describe('Aligner — no future leakage', () => {
  // Build a clean minute stream, with 5m / 15m / 60m bars that open on exact boundaries.
  const bars1m: HistoricalBar[] = [];
  for (let i = 0; i < 120; i++) bars1m.push(bar(i * 60)); // 120 minutes
  const bars5m: HistoricalBar[] = [];
  for (let i = 0; i < 24; i++) bars5m.push(bar(i * 300));
  const bars15m: HistoricalBar[] = [];
  for (let i = 0; i < 8; i++) bars15m.push(bar(i * 900));
  const bars60m: HistoricalBar[] = [];
  for (let i = 0; i < 2; i++) bars60m.push(bar(i * 3600));

  it('at 1m index 0 (time=0), no HTF bars are yet completed', () => {
    const a = new Aligner(bars1m, bars5m, bars15m, bars60m);
    const b = a.advanceTo(0);
    expect(b.availability['5m']).toBe(false);
    expect(b.availability['15m']).toBe(false);
    expect(b.availability['60m']).toBe(false);
  });

  it('at 1m index 4 (time=240s, closes at 300s), 5m bar #0 just closed', () => {
    const a = new Aligner(bars1m, bars5m, bars15m, bars60m);
    const b = a.advanceTo(4);
    // 5m bar #0 opened at 0, closes at 300 → close == 1m-close time of 300 → SAFE
    expect(b.availability['5m']).toBe(true);
    expect(b.bar_5m!.timestamp).toBe(0);
    expect(b.availability['15m']).toBe(false);
    expect(b.availability['60m']).toBe(false);
  });

  it('at 1m index 5 (time=300s, closes at 360s), 5m bar #0 still most recent completed', () => {
    const a = new Aligner(bars1m, bars5m, bars15m, bars60m);
    const b = a.advanceTo(5);
    // 5m bar #1 opens at 300, closes at 600 → not yet complete at 360
    expect(b.bar_5m!.timestamp).toBe(0);
  });

  it('at 1m index 14 (time=840, closes at 900), 15m bar #0 just closed', () => {
    const a = new Aligner(bars1m, bars5m, bars15m, bars60m);
    const b = a.advanceTo(14);
    expect(b.availability['15m']).toBe(true);
    expect(b.bar_15m!.timestamp).toBe(0);
    expect(b.availability['60m']).toBe(false);
  });

  it('at 1m index 59 (time=3540, closes at 3600), 60m bar #0 just closed', () => {
    const a = new Aligner(bars1m, bars5m, bars15m, bars60m);
    const b = a.advanceTo(59);
    expect(b.availability['60m']).toBe(true);
    expect(b.bar_60m!.timestamp).toBe(0);
  });

  it('never references a 5m bar whose close is in the future', () => {
    const a = new Aligner(bars1m, bars5m, bars15m, bars60m);
    for (let i = 0; i < bars1m.length; i++) {
      const b = a.advanceTo(i);
      if (b.bar_5m) {
        const closeTime = b.bar_5m.timestamp + 300;
        const knownUntil = b.bar_1m.timestamp + 60;
        expect(closeTime).toBeLessThanOrEqual(knownUntil);
      }
    }
  });

  it('handles HTF series starting LATER than the 1m series', () => {
    // 5m series starts 1 hour into 1m series
    const late5m = bars5m.map(b => ({ ...b, timestamp: b.timestamp + 3600 }));
    const a = new Aligner(bars1m, late5m, bars15m, bars60m);
    const b = a.advanceTo(30);
    expect(b.availability['5m']).toBe(false);
    // After the late-start, eventually it should become available
    const c = a.advanceTo(70);
    expect(c.availability['5m']).toBe(true);
  });

  it('handles HTF series starting EARLIER than the 1m series (60m case)', () => {
    const early60m = [bar(-7200), bar(-3600), ...bars60m];
    const a = new Aligner(bars1m, bars5m, bars15m, early60m);
    const b = a.advanceTo(0);
    // Earliest 60m bar closed at -3600 (before t=0) → already safe at step 0
    expect(b.availability['60m']).toBe(true);
    expect(b.bar_60m!.timestamp).toBe(-3600);
  });

  it('getRecentBars returns bars inclusive of the cursor, not beyond', () => {
    const a = new Aligner(bars1m, bars5m, bars15m, bars60m);
    const b = a.advanceTo(10);
    const recent = a.getRecentBars('1m', 5, b);
    expect(recent.length).toBe(5);
    expect(recent[recent.length - 1]!.timestamp).toBe(bars1m[10]!.timestamp);
  });
});
