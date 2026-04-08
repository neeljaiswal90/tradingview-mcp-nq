import { describe, it, expect } from 'vitest';
import {
  classifySession,
  buildOpeningRange,
  computePriorLevels,
} from '../../src/autotrade/session.js';
import { EventCalendar } from '../../src/autotrade/events.js';

// Helper: build a Date that corresponds to a specific ET hour/minute on a
// known non-DST weekday (2025-02-18 = Tuesday, EST). EST = UTC-5.
function etDate(hourEt: number, minEt: number, day = 18): Date {
  return new Date(Date.UTC(2025, 1, day, hourEt + 5, minEt, 0));
}

describe('classifySession', () => {
  it('identifies RTH and the cash-open window at 09:30 ET', () => {
    const s = classifySession(etDate(9, 30));
    expect(s.is_rth).toBe(true);
    expect(s.is_us_cash_open_window).toBe(true);
    expect(s.is_rth_closing_window).toBe(false);
    expect(s.minutes_since_rth_open).toBe(0);
    expect(s.minutes_to_rth_close).toBe(390);
  });

  it('leaves cash-open window after 09:45 ET', () => {
    const s = classifySession(etDate(9, 45));
    expect(s.is_rth).toBe(true);
    expect(s.is_us_cash_open_window).toBe(false);
  });

  it('identifies closing window 15:45–16:00 ET', () => {
    const s = classifySession(etDate(15, 50));
    expect(s.is_rth).toBe(true);
    expect(s.is_rth_closing_window).toBe(true);
  });

  it('marks pre-open at 08:00 ET as ETH (not RTH)', () => {
    const s = classifySession(etDate(8, 0));
    expect(s.is_rth).toBe(false);
    expect(s.is_eth).toBe(true);
  });

  it('flags Saturday as weekend', () => {
    const sat = classifySession(etDate(12, 0, 22)); // 2025-02-22 = Saturday
    expect(sat.is_weekend).toBe(true);
    expect(sat.is_rth).toBe(false);
  });
});

describe('buildOpeningRange', () => {
  it('returns null when no bars fall inside the window', () => {
    const or = buildOpeningRange([], { now: etDate(10, 0) });
    expect(or).toBeNull();
  });

  it('builds a range from 1m bars inside 09:30–09:45 ET', () => {
    const bars = [];
    for (let m = 0; m < 15; m++) {
      const t = Math.floor(etDate(9, 30 + m).getTime() / 1000);
      bars.push({ time: t, high: 20_000 + m, low: 19_990 + m });
    }
    const or = buildOpeningRange(bars, { now: etDate(9, 50) });
    expect(or).not.toBeNull();
    expect(or!.high).toBe(20_014);
    expect(or!.low).toBe(19_990);
    expect(or!.formed).toBe(true);
    expect(or!.bars_used).toBe(15);
  });
});

describe('computePriorLevels', () => {
  it('separates prior-RTH from overnight correctly', () => {
    // Bars: prior-day RTH at 14:00 ET, and overnight at 02:00 ET today.
    const priorRthBar = { time: Math.floor(etDate(14, 0, 17).getTime() / 1000), high: 21_000, low: 20_900 };
    const overnightBar = { time: Math.floor(etDate(2, 0, 18).getTime() / 1000), high: 21_100, low: 20_950 };
    const p = computePriorLevels([priorRthBar, overnightBar], etDate(10, 0, 18));
    expect(p.prior_rth_high).toBe(21_000);
    expect(p.prior_rth_low).toBe(20_900);
    expect(p.overnight_high).toBe(21_100);
    expect(p.overnight_low).toBe(20_950);
  });
});

describe('EventCalendar', () => {
  it('flags a pre-event window within configured minutes', () => {
    const now = new Date('2026-04-05T12:00:00Z');
    const cal = new EventCalendar({
      pre_window_minutes: 15,
      post_window_minutes: 10,
      events: [{ iso_utc: '2026-04-05T12:10:00Z', type: 'CPI' }],
    });
    const s = cal.evaluate(now);
    expect(s.is_event_window).toBe(true);
    expect(s.event_type).toBe('CPI');
    expect(s.no_trade_due_to_event).toBe(true);
    expect(s.suppression_reason).toContain('pre_event_window:CPI');
  });

  it('flags a post-event window', () => {
    const now = new Date('2026-04-05T12:05:00Z');
    const cal = new EventCalendar({
      pre_window_minutes: 15,
      post_window_minutes: 10,
      events: [{ iso_utc: '2026-04-05T12:00:00Z', type: 'FOMC' }],
    });
    const s = cal.evaluate(now);
    expect(s.is_event_window).toBe(true);
    expect(s.event_type).toBe('FOMC');
  });

  it('does not flag events outside windows', () => {
    const now = new Date('2026-04-05T08:00:00Z');
    const cal = new EventCalendar({
      pre_window_minutes: 15,
      post_window_minutes: 10,
      events: [{ iso_utc: '2026-04-05T12:00:00Z', type: 'CPI' }],
    });
    const s = cal.evaluate(now);
    expect(s.is_event_window).toBe(false);
    expect(s.no_trade_due_to_event).toBe(false);
  });

  it('returns empty calendar via static load() when file missing', () => {
    const cal = EventCalendar.load('./config-does-not-exist');
    expect(cal.size()).toBe(0);
    const s = cal.evaluate(new Date());
    expect(s.is_event_window).toBe(false);
  });
});
