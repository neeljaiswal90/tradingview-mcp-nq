import { describe, it, expect } from 'vitest';
import { buildOpeningRange, classifySession } from '../../src/autotrade/session.js';
import { Aligner } from '../../src/autotrade/historical/alignment.js';
import { buildHistoricalSnapshot } from '../../src/autotrade/historical/snapshot-builder.js';
import type { HistoricalBar } from '../../src/autotrade/historical/schema.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a Date in ET. Uses EST (UTC-5) for simplicity.
 * 2025-02-18 = Tuesday, EST.
 */
function etDate(hourEt: number, minEt: number, day = 18, month = 1 /* Feb */): Date {
  return new Date(Date.UTC(2025, month, day, hourEt + 5, minEt, 0));
}

/** Unix seconds for an ET time. */
function etUnix(hourEt: number, minEt: number, day = 18, month = 1): number {
  return Math.floor(etDate(hourEt, minEt, day, month).getTime() / 1000);
}

/** Create a minimal HistoricalBar at a given ET time. */
function makeBar(
  hourEt: number, minEt: number,
  opts: { high?: number; low?: number; close?: number; open?: number; day?: number; month?: number } = {},
): HistoricalBar {
  const { high = 20100, low = 20050, close = 20075, open = 20060, day = 18, month = 1 } = opts;
  const ts = etUnix(hourEt, minEt, day, month);
  return {
    timestamp: ts,
    open, high, low, close,
    volume: 1000,
    vwap: null,
    upper_band_1: null, upper_band_2: null, upper_band_3: null,
    lower_band_1: null, lower_band_2: null, lower_band_3: null,
  };
}

/** Generate N consecutive 1m bars starting at a given ET time. */
function makeBarSequence(
  startHour: number, startMin: number, count: number,
  opts: { highBase?: number; lowBase?: number; day?: number; month?: number } = {},
): HistoricalBar[] {
  const { highBase = 20100, lowBase = 20050, day = 18, month = 1 } = opts;
  const bars: HistoricalBar[] = [];
  for (let i = 0; i < count; i++) {
    const totalMin = startHour * 60 + startMin + i;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    bars.push(makeBar(h, m, {
      high: highBase + i * 2,
      low: lowBase + i,
      close: lowBase + i + 10,
      open: lowBase + i + 5,
      day,
      month,
    }));
  }
  return bars;
}

// ─── buildOpeningRange unit tests ───────────────────────────────────────────

describe('buildOpeningRange — session reset across days', () => {
  it('resets OR for a new trading day', () => {
    // Day 1 bars (Feb 18) - OR window
    const day1Bars = makeBarSequence(9, 30, 15, { highBase: 20000, lowBase: 19900, day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    // Day 2 bars (Feb 19) - different OR window
    const day2Bars = makeBarSequence(9, 30, 15, { highBase: 20200, lowBase: 20100, day: 19 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    const allBars = [...day1Bars, ...day2Bars];

    // Query for day 2 should only use day 2 bars
    const or = buildOpeningRange(allBars, { now: etDate(10, 0, 19) });
    expect(or).not.toBeNull();
    expect(or!.high).toBeGreaterThanOrEqual(20200);
    expect(or!.low).toBe(20100);

    // Query for day 1 should only use day 1 bars
    const or1 = buildOpeningRange(allBars, { now: etDate(10, 0, 18) });
    expect(or1).not.toBeNull();
    expect(or1!.low).toBe(19900);
  });

  it('returns null for a day with no OR bars', () => {
    // Only day 18 bars exist
    const day1Bars = makeBarSequence(9, 30, 15, { day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    // Query for day 19 should find nothing
    const or = buildOpeningRange(day1Bars, { now: etDate(10, 0, 19) });
    expect(or).toBeNull();
  });
});

describe('buildOpeningRange — pre/post OR completion', () => {
  it('marks formed=false when queried during the OR window', () => {
    const bars = makeBarSequence(9, 30, 10, { day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    // Query at 09:40 — only 10 minutes in, window is 15 min
    const or = buildOpeningRange(bars, { now: etDate(9, 40, 18) });
    expect(or).not.toBeNull();
    expect(or!.formed).toBe(false);
    expect(or!.bars_used).toBe(10);
  });

  it('marks formed=true when queried after the OR window', () => {
    const bars = makeBarSequence(9, 30, 15, { day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    // Query at 09:50 — past the 15-minute window
    const or = buildOpeningRange(bars, { now: etDate(9, 50, 18) });
    expect(or).not.toBeNull();
    expect(or!.formed).toBe(true);
    expect(or!.bars_used).toBe(15);
  });

  it('returns null with fewer than 5 bars in a 15-minute window', () => {
    const bars = makeBarSequence(9, 30, 4, { day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    const or = buildOpeningRange(bars, { now: etDate(9, 40, 18) });
    expect(or).toBeNull(); // min threshold = max(3, floor(15/3)) = 5
  });

  it('returns valid OR with exactly 5 bars', () => {
    const bars = makeBarSequence(9, 30, 5, { day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    const or = buildOpeningRange(bars, { now: etDate(9, 36, 18) });
    expect(or).not.toBeNull();
    expect(or!.bars_used).toBe(5);
  });
});

describe('buildOpeningRange — custom window sizes', () => {
  it('respects a custom windowMinutes=10', () => {
    // 15 bars from 09:30–09:44, but only first 10 should be used with window=10
    const bars = makeBarSequence(9, 30, 15, { day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    const or = buildOpeningRange(bars, { windowMinutes: 10, now: etDate(9, 50, 18) });
    expect(or).not.toBeNull();
    expect(or!.bars_used).toBe(10); // only 09:30–09:39
  });

  it('respects a custom windowMinutes=5', () => {
    const bars = makeBarSequence(9, 30, 15, { day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    const or = buildOpeningRange(bars, { windowMinutes: 5, now: etDate(9, 50, 18) });
    expect(or).not.toBeNull();
    expect(or!.bars_used).toBe(5); // only 09:30–09:34
  });
});

describe('buildOpeningRange — ETH bars excluded', () => {
  it('ignores pre-market bars (before 09:30)', () => {
    // Mix of pre-market and OR window bars
    const preMarket = makeBarSequence(8, 0, 90, { highBase: 21000, lowBase: 20900, day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));
    const orBars = makeBarSequence(9, 30, 15, { highBase: 20100, lowBase: 20050, day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    const or = buildOpeningRange([...preMarket, ...orBars], { now: etDate(10, 0, 18) });
    expect(or).not.toBeNull();
    // Should NOT include the higher pre-market bars
    expect(or!.high).toBeLessThan(21000);
    expect(or!.bars_used).toBe(15);
  });

  it('ignores post-close bars', () => {
    const orBars = makeBarSequence(9, 30, 15, { highBase: 20100, lowBase: 20050, day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));
    const afterClose = makeBarSequence(16, 30, 30, { highBase: 22000, lowBase: 21900, day: 18 })
      .map(b => ({ time: b.timestamp, high: b.high, low: b.low }));

    const or = buildOpeningRange([...orBars, ...afterClose], { now: etDate(17, 0, 18) });
    expect(or).not.toBeNull();
    expect(or!.high).toBeLessThan(22000);
    expect(or!.bars_used).toBe(15);
  });
});

// ─── Historical snapshot builder integration ────────────────────────────────

describe('buildHistoricalSnapshot — OR population', () => {
  /**
   * Build a complete 1m bar series that covers the OR window.
   * Returns bars from 09:00 ET to 10:00 ET (60 bars), giving enough
   * data for the snapshot builder to find the 09:30–09:45 window.
   */
  function buildTestBars(day = 18): HistoricalBar[] {
    // 2 hours of 1m bars: 08:00 to 10:00 ET (120 bars)
    return makeBarSequence(8, 0, 120, {
      highBase: 20050,
      lowBase: 20000,
      day,
    });
  }

  it('populates OR levels in snapshot during RTH after OR window', () => {
    const bars1m = buildTestBars();
    const aligner = new Aligner(bars1m, [], [], []);

    // Advance to a bar after 09:45 (index for 10:00 - 08:00 = 120 bars, pick bar at ~09:50)
    // 09:50 ET = 110 minutes after 08:00 = index 110
    const barIndex = 110; // 09:50 ET
    const bundle = aligner.advanceTo(barIndex);

    const snap = buildHistoricalSnapshot(bundle, {
      symbol: 'NQ1!',
      aligner,
      window_1m: 60,
      window_5m: 0,
      window_15m: 0,
      window_60m: 0,
      opening_range_minutes: 15,
    });

    // OR should be populated — we have 15 bars in the 09:30–09:44 window
    expect(snap.key_levels.opening_range_high).not.toBeNull();
    expect(snap.key_levels.opening_range_low).not.toBeNull();
    expect(snap.key_levels.opening_range_mid).not.toBeNull();

    // Midpoint should be average of high and low
    if (snap.key_levels.opening_range_high !== null && snap.key_levels.opening_range_low !== null) {
      expect(snap.key_levels.opening_range_mid).toBe(
        (snap.key_levels.opening_range_high + snap.key_levels.opening_range_low) / 2,
      );
    }
  });

  it('populates OR levels during the OR window (partial, >=5 bars)', () => {
    const bars1m = buildTestBars();
    const aligner = new Aligner(bars1m, [], [], []);

    // Bar at 09:35 ET = index 95 (95 minutes after 08:00)
    // At this point we have 5 bars: 09:30, 09:31, 09:32, 09:33, 09:34
    const barIndex = 95;
    const bundle = aligner.advanceTo(barIndex);

    const snap = buildHistoricalSnapshot(bundle, {
      symbol: 'NQ1!',
      aligner,
      window_1m: 60,
      window_5m: 0,
      window_15m: 0,
      window_60m: 0,
      opening_range_minutes: 15,
    });

    // Should have partial OR (5 bars available in the window: 09:30-09:34)
    // The aligner returns bars up to and including the current index
    // At index 95, bars 90 (09:30) through 95 (09:35) are available = 6 bars in OR window
    expect(snap.key_levels.opening_range_high).not.toBeNull();
    expect(snap.key_levels.opening_range_low).not.toBeNull();
  });

  it('returns null OR before sufficient bars (pre-09:34)', () => {
    const bars1m = buildTestBars();
    const aligner = new Aligner(bars1m, [], [], []);

    // Bar at 09:33 ET = index 93 (93 minutes after 08:00)
    // Only 4 bars in OR window: 09:30, 09:31, 09:32, 09:33
    const barIndex = 93;
    const bundle = aligner.advanceTo(barIndex);

    const snap = buildHistoricalSnapshot(bundle, {
      symbol: 'NQ1!',
      aligner,
      window_1m: 60,
      window_5m: 0,
      window_15m: 0,
      window_60m: 0,
      opening_range_minutes: 15,
    });

    // Only 4 bars available in OR window — below the threshold of 5
    expect(snap.key_levels.opening_range_high).toBeNull();
    expect(snap.key_levels.opening_range_low).toBeNull();
    expect(snap.key_levels.opening_range_mid).toBeNull();
  });

  it('OR is null for pre-market bars (no bars in 09:30–09:45 window)', () => {
    const bars1m = makeBarSequence(8, 0, 60, { day: 18 }); // 08:00–08:59 only
    const aligner = new Aligner(bars1m, [], [], []);

    const barIndex = 59; // 08:59 ET
    const bundle = aligner.advanceTo(barIndex);

    const snap = buildHistoricalSnapshot(bundle, {
      symbol: 'NQ1!',
      aligner,
      window_1m: 60,
      window_5m: 0,
      window_15m: 0,
      window_60m: 0,
    });

    expect(snap.key_levels.opening_range_high).toBeNull();
    expect(snap.key_levels.opening_range_low).toBeNull();
  });

  it('OR resets across trading days in a multi-day replay', () => {
    // Day 1: full series from 08:00–16:00
    const day1 = makeBarSequence(8, 0, 480, { highBase: 19800, lowBase: 19750, day: 18 });
    // Day 2: full series from 08:00–16:00
    const day2 = makeBarSequence(8, 0, 480, { highBase: 20200, lowBase: 20150, day: 19 });
    const allBars = [...day1, ...day2];
    const aligner = new Aligner(allBars, [], [], []);

    // Check day 2 at 10:00 ET (index = 480 + 120 = 600)
    const day2Index = 480 + 120;
    const bundle = aligner.advanceTo(day2Index);

    const snap = buildHistoricalSnapshot(bundle, {
      symbol: 'NQ1!',
      aligner,
      window_1m: 60,
      window_5m: 0,
      window_15m: 0,
      window_60m: 0,
      opening_range_minutes: 15,
    });

    // OR should be from day 2 levels, not day 1
    expect(snap.key_levels.opening_range_high).not.toBeNull();
    expect(snap.key_levels.opening_range_low).not.toBeNull();
    // Day 2 base is 20200/20150, day 1 base is 19800/19750
    expect(snap.key_levels.opening_range_low!).toBeGreaterThan(20000);
  });

  it('passes opening_range_minutes through to buildOpeningRange', () => {
    // Use a 10-minute window
    const bars1m = buildTestBars();
    const aligner = new Aligner(bars1m, [], [], []);

    const barIndex = 110; // 09:50 ET
    const bundle = aligner.advanceTo(barIndex);

    const snap = buildHistoricalSnapshot(bundle, {
      symbol: 'NQ1!',
      aligner,
      window_1m: 60,
      window_5m: 0,
      window_15m: 0,
      window_60m: 0,
      opening_range_minutes: 10,
    });

    // OR should still be populated (we have >= 3 bars in 10-min window)
    expect(snap.key_levels.opening_range_high).not.toBeNull();
  });
});

// ─── Session state parity checks ────────────────────────────────────────────

describe('snapshot session state — OR context', () => {
  it('session.is_rth is true during RTH bars', () => {
    const bars1m = makeBarSequence(9, 30, 30, { day: 18 });
    const aligner = new Aligner(bars1m, [], [], []);
    const bundle = aligner.advanceTo(15); // 09:45 ET

    const snap = buildHistoricalSnapshot(bundle, {
      symbol: 'NQ1!',
      aligner,
      window_1m: 30,
      window_5m: 0,
      window_15m: 0,
      window_60m: 0,
    });

    expect(snap.session?.is_rth).toBe(true);
    expect(snap.session?.minutes_since_rth_open).toBe(15);
  });

  it('session.is_us_cash_open_window is true during 09:30-09:45', () => {
    const bars1m = makeBarSequence(9, 30, 30, { day: 18 });
    const aligner = new Aligner(bars1m, [], [], []);

    // 09:40 ET = index 10
    const bundle = aligner.advanceTo(10);
    const snap = buildHistoricalSnapshot(bundle, {
      symbol: 'NQ1!',
      aligner,
      window_1m: 30,
      window_5m: 0,
      window_15m: 0,
      window_60m: 0,
    });

    expect(snap.session?.is_us_cash_open_window).toBe(true);
  });

  it('session.is_us_cash_open_window is false after 09:45', () => {
    const bars1m = makeBarSequence(9, 30, 30, { day: 18 });
    const aligner = new Aligner(bars1m, [], [], []);

    // 09:50 ET = index 20
    const bundle = aligner.advanceTo(20);
    const snap = buildHistoricalSnapshot(bundle, {
      symbol: 'NQ1!',
      aligner,
      window_1m: 30,
      window_5m: 0,
      window_15m: 0,
      window_60m: 0,
    });

    expect(snap.session?.is_us_cash_open_window).toBe(false);
  });
});

// ─── OR values correctness ──────────────────────────────────────────────────

describe('buildOpeningRange — value correctness', () => {
  it('high is the max of all bars in the window', () => {
    const bars = [
      { time: etUnix(9, 30), high: 20100, low: 20050 },
      { time: etUnix(9, 31), high: 20090, low: 20040 },
      { time: etUnix(9, 32), high: 20150, low: 20060 }, // highest high
      { time: etUnix(9, 33), high: 20120, low: 20070 },
      { time: etUnix(9, 34), high: 20110, low: 20030 }, // lowest low
    ];

    const or = buildOpeningRange(bars, { now: etDate(9, 50) });
    expect(or).not.toBeNull();
    expect(or!.high).toBe(20150);
    expect(or!.low).toBe(20030);
    expect(or!.midpoint).toBe((20150 + 20030) / 2);
    expect(or!.opening_range_width).toBe(120);
  });

  it('handles flat bars (all same high/low)', () => {
    const bars = Array.from({ length: 15 }, (_, i) => ({
      time: etUnix(9, 30 + i),
      high: 20100,
      low: 20100,
    }));

    const or = buildOpeningRange(bars, { now: etDate(9, 50) });
    expect(or).not.toBeNull();
    expect(or!.high).toBe(20100);
    expect(or!.low).toBe(20100);
    expect(or!.opening_range_width).toBe(0);
    expect(or!.midpoint).toBe(20100);
  });
});
