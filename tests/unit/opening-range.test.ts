import { describe, it, expect } from 'vitest';
import { buildOpeningRange } from '../../src/autotrade/session.js';

/**
 * Helper: build a Date corresponding to a specific ET hour/minute on a known
 * non-DST weekday. 2025-02-18 = Tuesday, EST (UTC-5).
 */
function etDate(hourEt: number, minEt: number, day = 18): Date {
  return new Date(Date.UTC(2025, 1, day, hourEt + 5, minEt, 0));
}

/** Build a 1m bar at the given ET time on the given day. */
function bar(hourEt: number, minEt: number, high: number, low: number, day = 18) {
  return {
    time: Math.floor(etDate(hourEt, minEt, day).getTime() / 1000),
    high,
    low,
  };
}

describe('buildOpeningRange — date-filtering', () => {
  it('filters bars by same ET calendar date (multi-day bars)', () => {
    // Day 17 bars (yesterday) in the opening window — should be excluded.
    const yesterdayBars = Array.from({ length: 15 }, (_, m) =>
      bar(9, 30 + m, 21_000 + m, 20_900 + m, 17),
    );
    // Day 18 bars (today) in the opening window — should be included.
    const todayBars = Array.from({ length: 15 }, (_, m) =>
      bar(9, 30 + m, 20_100 + m, 20_050 + m, 18),
    );

    const allBars = [...yesterdayBars, ...todayBars];
    const or = buildOpeningRange(allBars, { now: etDate(9, 50, 18) });

    expect(or).not.toBeNull();
    // Only today's bars should be used.
    expect(or!.bars_used).toBe(15);
    // The range should reflect today's bars, not yesterday's higher values.
    expect(or!.high).toBe(20_114); // 20_100 + 14
    expect(or!.low).toBe(20_050);  // 20_050 + 0
  });

  it('returns null when fewer than minimum bars from the same day', () => {
    // Only 2 bars from today — not enough (min is max(3, floor(15/3)) = 5).
    const fewBars = [
      bar(9, 30, 20_100, 20_050, 18),
      bar(9, 31, 20_110, 20_060, 18),
    ];
    // Many bars from yesterday (should be ignored).
    const yesterdayBars = Array.from({ length: 15 }, (_, m) =>
      bar(9, 30 + m, 21_000 + m, 20_900 + m, 17),
    );

    const or = buildOpeningRange([...yesterdayBars, ...fewBars], { now: etDate(9, 50, 18) });
    expect(or).toBeNull();
  });

  it('computes high/low from single-day bars only', () => {
    // Yesterday: extreme range 18_000–22_000
    const yesterdayBar = bar(9, 35, 22_000, 18_000, 17);
    // Today: tight range 20_050–20_100
    const todayBars = Array.from({ length: 10 }, (_, m) =>
      bar(9, 30 + m, 20_100, 20_050, 18),
    );

    const or = buildOpeningRange([yesterdayBar, ...todayBars], { now: etDate(9, 50, 18) });
    expect(or).not.toBeNull();
    expect(or!.high).toBe(20_100);
    expect(or!.low).toBe(20_050);
  });

  it('computes opening_range_width correctly', () => {
    const todayBars = Array.from({ length: 15 }, (_, m) =>
      bar(9, 30 + m, 20_200, 20_100, 18),
    );

    const or = buildOpeningRange(todayBars, { now: etDate(9, 50, 18) });
    expect(or).not.toBeNull();
    expect(or!.opening_range_width).toBe(100); // 20_200 - 20_100
  });
});
