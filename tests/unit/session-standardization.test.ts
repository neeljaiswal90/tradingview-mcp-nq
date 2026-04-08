/**
 * Session Standardization Tests
 *
 * Comprehensive tests for the two-layer session model:
 *   Layer 1: ExchangeSessionState (RTH/ETH/MAINTENANCE/CLOSED)
 *   Layer 2: StrategySessionBucket (ASIA/LONDON/NY_AM/NY_LUNCH/NY_PM/CLOSED/MAINTENANCE/UNKNOWN)
 *
 * Covers:
 *   - Exchange state classification for all time periods
 *   - Strategy bucket classification with international session awareness
 *   - DST-aware timezone derivation (Asia/Tokyo, Europe/London)
 *   - Legacy bucket mapping for backward compatibility
 *   - Boundary conditions (session transitions)
 *   - Weekend/holiday edge cases
 *   - Full classifySession() integration
 */

import { describe, it, expect } from 'vitest';
import {
  classifySession,
  classifyExchangeState,
  classifyStrategyBucket,
  mapToLegacyBucket,
  getTzHour,
  getTzHourMinute,
  getEtParts,
} from '../../src/autotrade/session.js';
import type {
  ExchangeSessionState,
  StrategySessionBucket,
  LegacySessionBucket,
} from '../../src/autotrade/session.js';

// ─── Helper: create a Date for a specific ET time ────────────────────────────

/**
 * Create a Date object for a specific ET time.
 * Uses a known date to avoid DST ambiguity for basic tests.
 * For DST-specific tests, use explicit dates.
 */
function etDate(year: number, month: number, day: number, hour: number, minute: number = 0): Date {
  // Create date in ET by using Intl to find UTC offset
  // Use a fixed approach: create UTC date and adjust
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const etFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  // Iteratively adjust to get correct ET time
  const parts = etFmt.formatToParts(utcGuess);
  const etHour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10) % 24;
  const etMin = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const diffMin = (hour * 60 + minute) - (etHour * 60 + etMin);
  return new Date(utcGuess.getTime() + diffMin * 60_000);
}

// ─── Layer 1: Exchange State ─────────────────────────────────────────────────

describe('classifyExchangeState', () => {
  it('returns RTH during US cash hours Mon-Fri', () => {
    // Monday 09:30
    expect(classifyExchangeState(1, 9 * 60 + 30)).toBe('RTH');
    // Tuesday 12:00
    expect(classifyExchangeState(2, 12 * 60)).toBe('RTH');
    // Wednesday 15:59
    expect(classifyExchangeState(3, 15 * 60 + 59)).toBe('RTH');
    // Thursday 10:00
    expect(classifyExchangeState(4, 10 * 60)).toBe('RTH');
    // Friday 14:30
    expect(classifyExchangeState(5, 14 * 60 + 30)).toBe('RTH');
  });

  it('returns ETH before RTH open on weekdays', () => {
    // Monday 03:00
    expect(classifyExchangeState(1, 3 * 60)).toBe('ETH');
    // Tuesday 09:29
    expect(classifyExchangeState(2, 9 * 60 + 29)).toBe('ETH');
    // Wednesday 07:00
    expect(classifyExchangeState(3, 7 * 60)).toBe('ETH');
  });

  it('returns ETH after RTH close before maintenance', () => {
    // Monday 16:00 (RTH ends, ETH)
    expect(classifyExchangeState(1, 16 * 60)).toBe('ETH');
    // Tuesday 16:30
    expect(classifyExchangeState(2, 16 * 60 + 30)).toBe('ETH');
    // Wednesday 16:59
    expect(classifyExchangeState(3, 16 * 60 + 59)).toBe('ETH');
  });

  it('returns MAINTENANCE during daily pause 17:00-18:00 Mon-Thu', () => {
    // Monday 17:00
    expect(classifyExchangeState(1, 17 * 60)).toBe('MAINTENANCE');
    // Tuesday 17:30
    expect(classifyExchangeState(2, 17 * 60 + 30)).toBe('MAINTENANCE');
    // Thursday 17:59
    expect(classifyExchangeState(4, 17 * 60 + 59)).toBe('MAINTENANCE');
  });

  it('returns ETH after maintenance Mon-Thu', () => {
    // Monday 18:00
    expect(classifyExchangeState(1, 18 * 60)).toBe('ETH');
    // Wednesday 20:00
    expect(classifyExchangeState(3, 20 * 60)).toBe('ETH');
    // Thursday 23:00
    expect(classifyExchangeState(4, 23 * 60)).toBe('ETH');
  });

  it('returns CLOSED on Saturday', () => {
    expect(classifyExchangeState(6, 0)).toBe('CLOSED');
    expect(classifyExchangeState(6, 12 * 60)).toBe('CLOSED');
    expect(classifyExchangeState(6, 23 * 60)).toBe('CLOSED');
  });

  it('returns CLOSED on Sunday before 18:00', () => {
    expect(classifyExchangeState(0, 0)).toBe('CLOSED');
    expect(classifyExchangeState(0, 12 * 60)).toBe('CLOSED');
    expect(classifyExchangeState(0, 17 * 60 + 59)).toBe('CLOSED');
  });

  it('returns ETH on Sunday at/after 18:00 (Globex open)', () => {
    expect(classifyExchangeState(0, 18 * 60)).toBe('ETH');
    expect(classifyExchangeState(0, 20 * 60)).toBe('ETH');
    expect(classifyExchangeState(0, 23 * 60)).toBe('ETH');
  });

  it('returns CLOSED on Friday after 17:00', () => {
    expect(classifyExchangeState(5, 17 * 60)).toBe('CLOSED');
    expect(classifyExchangeState(5, 18 * 60)).toBe('CLOSED');
    expect(classifyExchangeState(5, 23 * 60)).toBe('CLOSED');
  });

  // ── Boundary tests ──
  it('RTH boundary: 09:30 is RTH, 09:29 is ETH', () => {
    expect(classifyExchangeState(1, 9 * 60 + 30)).toBe('RTH');
    expect(classifyExchangeState(1, 9 * 60 + 29)).toBe('ETH');
  });

  it('RTH boundary: 16:00 is ETH (RTH ends at 16:00)', () => {
    expect(classifyExchangeState(1, 15 * 60 + 59)).toBe('RTH');
    expect(classifyExchangeState(1, 16 * 60)).toBe('ETH');
  });

  it('Maintenance boundary: 17:00 starts, 18:00 ends', () => {
    expect(classifyExchangeState(1, 16 * 60 + 59)).toBe('ETH');
    expect(classifyExchangeState(1, 17 * 60)).toBe('MAINTENANCE');
    expect(classifyExchangeState(1, 17 * 60 + 59)).toBe('MAINTENANCE');
    expect(classifyExchangeState(1, 18 * 60)).toBe('ETH');
  });
});

// ─── Layer 2: Strategy Bucket ────────────────────────────────────────────────

describe('classifyStrategyBucket', () => {
  it('returns NY_AM during 09:30-12:00 RTH', () => {
    expect(classifyStrategyBucket('RTH', 9 * 60 + 30, 1, 22, 14)).toBe('NY_AM');
    expect(classifyStrategyBucket('RTH', 11 * 60 + 59, 2, 0, 16)).toBe('NY_AM');
  });

  it('returns NY_LUNCH during 12:00-14:00 RTH', () => {
    expect(classifyStrategyBucket('RTH', 12 * 60, 1, 1, 17)).toBe('NY_LUNCH');
    expect(classifyStrategyBucket('RTH', 13 * 60 + 59, 3, 2, 18)).toBe('NY_LUNCH');
  });

  it('returns NY_PM during 14:00-16:00 RTH', () => {
    expect(classifyStrategyBucket('RTH', 14 * 60, 1, 3, 19)).toBe('NY_PM');
    expect(classifyStrategyBucket('RTH', 15 * 60 + 59, 4, 4, 20)).toBe('NY_PM');
  });

  it('returns CLOSED when exchange is CLOSED', () => {
    expect(classifyStrategyBucket('CLOSED', 12 * 60, 6, 1, 17)).toBe('CLOSED');
    expect(classifyStrategyBucket('CLOSED', 0, 0, 9, 5)).toBe('CLOSED');
  });

  it('returns MAINTENANCE when exchange is MAINTENANCE', () => {
    expect(classifyStrategyBucket('MAINTENANCE', 17 * 60 + 30, 1, 6, 22)).toBe('MAINTENANCE');
  });

  it('returns ASIA during Tokyo session hours in ETH', () => {
    // Tokyo is open (09:00-15:00 JST), London is closed
    expect(classifyStrategyBucket('ETH', 22 * 60, 1, 11, 3)).toBe('ASIA');
    expect(classifyStrategyBucket('ETH', 0, 2, 13, 5)).toBe('ASIA');
  });

  it('returns LONDON during London session hours in ETH', () => {
    // London is open (08:00-16:30 GMT/BST), takes priority over late Tokyo
    expect(classifyStrategyBucket('ETH', 4 * 60, 2, 14, 9)).toBe('LONDON');
    expect(classifyStrategyBucket('ETH', 8 * 60, 3, 21, 13)).toBe('LONDON');
  });

  it('LONDON takes priority over ASIA when both are open', () => {
    // Both Tokyo (09:00-15:00 JST) and London (08:00-16:30 GMT) overlap
    // Tokyo 09:00 = ~20:00 ET prev day, London 08:00 = ~03:00 ET
    // Overlap window: when tokyoHour >= 9 && < 15 AND londonHour >= 8 && < 16
    expect(classifyStrategyBucket('ETH', 5 * 60, 2, 14, 10)).toBe('LONDON');
  });

  it('returns NY_PM for post-RTH ETH wind-down (16:00-17:00)', () => {
    // After RTH close but before maintenance — still US context
    expect(classifyStrategyBucket('ETH', 16 * 60 + 15, 1, 5, 21)).toBe('NY_PM');
  });
});

// ─── Legacy Bucket Mapping ───────────────────────────────────────────────────

describe('mapToLegacyBucket', () => {
  it('maps NY_AM → rth_open', () => {
    expect(mapToLegacyBucket('NY_AM', 'RTH')).toBe('rth_open');
  });

  it('maps NY_LUNCH → midday', () => {
    expect(mapToLegacyBucket('NY_LUNCH', 'RTH')).toBe('midday');
  });

  it('maps NY_PM → power_hour', () => {
    expect(mapToLegacyBucket('NY_PM', 'RTH')).toBe('power_hour');
  });

  it('maps ASIA → premarket', () => {
    expect(mapToLegacyBucket('ASIA', 'ETH')).toBe('premarket');
  });

  it('maps LONDON → premarket', () => {
    expect(mapToLegacyBucket('LONDON', 'ETH')).toBe('premarket');
  });

  it('maps CLOSED → closed', () => {
    expect(mapToLegacyBucket('CLOSED', 'CLOSED')).toBe('closed');
  });

  it('maps MAINTENANCE → closed', () => {
    expect(mapToLegacyBucket('MAINTENANCE', 'MAINTENANCE')).toBe('closed');
  });

  it('maps UNKNOWN with ETH → premarket', () => {
    expect(mapToLegacyBucket('UNKNOWN', 'ETH')).toBe('premarket');
  });

  it('maps UNKNOWN without ETH → unknown', () => {
    expect(mapToLegacyBucket('UNKNOWN', 'CLOSED')).toBe('unknown');
  });
});

// ─── Timezone Helpers ────────────────────────────────────────────────────────

describe('getTzHour', () => {
  it('returns correct hour for Asia/Tokyo', () => {
    // Tokyo is UTC+9 (no DST)
    const d = new Date('2026-01-15T12:00:00Z'); // noon UTC = 21:00 JST
    expect(getTzHour(d, 'Asia/Tokyo')).toBe(21);
  });

  it('returns correct hour for Europe/London in winter (GMT)', () => {
    // London in January is UTC+0
    const d = new Date('2026-01-15T12:00:00Z'); // noon UTC = noon GMT
    expect(getTzHour(d, 'Europe/London')).toBe(12);
  });

  it('returns correct hour for Europe/London in summer (BST)', () => {
    // London in July is UTC+1 (BST)
    const d = new Date('2026-07-15T12:00:00Z'); // noon UTC = 13:00 BST
    expect(getTzHour(d, 'Europe/London')).toBe(13);
  });

  it('returns correct hour for America/New_York in winter (EST)', () => {
    // NY in January is UTC-5
    const d = new Date('2026-01-15T12:00:00Z'); // noon UTC = 07:00 EST
    expect(getTzHour(d, 'America/New_York')).toBe(7);
  });

  it('returns correct hour for America/New_York in summer (EDT)', () => {
    // NY in July is UTC-4
    const d = new Date('2026-07-15T12:00:00Z'); // noon UTC = 08:00 EDT
    expect(getTzHour(d, 'America/New_York')).toBe(8);
  });
});

describe('getTzHourMinute', () => {
  it('returns hour and minute for Tokyo', () => {
    const d = new Date('2026-03-15T14:30:00Z'); // 14:30 UTC = 23:30 JST
    const { hour, minute } = getTzHourMinute(d, 'Asia/Tokyo');
    expect(hour).toBe(23);
    expect(minute).toBe(30);
  });
});

describe('getEtParts', () => {
  it('returns correct ET parts for a known UTC time', () => {
    const d = new Date('2026-03-15T16:30:00Z'); // 16:30 UTC = 12:30 EDT (after spring forward)
    const parts = getEtParts(d);
    expect(parts.hour).toBe(12);
    expect(parts.minute).toBe(30);
    expect(parts.dow).toBe(0); // Sunday
  });

  it('correctly handles EST (winter)', () => {
    const d = new Date('2026-01-15T17:00:00Z'); // 17:00 UTC = 12:00 EST
    const parts = getEtParts(d);
    expect(parts.hour).toBe(12);
    expect(parts.minute).toBe(0);
  });
});

// ─── Full classifySession() Integration ──────────────────────────────────────

describe('classifySession — integration', () => {
  it('classifies a Monday RTH midday correctly', () => {
    // Monday 12:00 ET (summer: UTC-4 → 16:00 UTC)
    const d = new Date('2026-07-06T16:00:00Z'); // Monday July 6 2026, 12:00 EDT
    const sess = classifySession(d);

    expect(sess.exchange_state).toBe('RTH');
    expect(sess.strategy_bucket).toBe('NY_LUNCH');
    expect(sess.legacy_bucket).toBe('midday');
    expect(sess.is_rth).toBe(true);
    expect(sess.is_eth).toBe(false);
    expect(sess.is_weekend).toBe(false);
    expect(sess.minutes_of_day_et).toBe(12 * 60);
  });

  it('classifies a Tuesday premarket Asia session', () => {
    // Tuesday 22:00 ET (summer: UTC-4 → Wed 02:00 UTC)
    // Tokyo would be Wed 11:00 JST (open), London would be Wed 03:00 BST (closed)
    const d = new Date('2026-07-08T02:00:00Z'); // Tue 22:00 EDT = Wed 02:00 UTC
    const sess = classifySession(d);

    expect(sess.exchange_state).toBe('ETH');
    expect(sess.strategy_bucket).toBe('ASIA');
    expect(sess.legacy_bucket).toBe('premarket');
    expect(sess.is_rth).toBe(false);
    expect(sess.is_eth).toBe(true);
  });

  it('classifies a Saturday as CLOSED', () => {
    const d = new Date('2026-07-11T15:00:00Z'); // Saturday
    const sess = classifySession(d);

    expect(sess.exchange_state).toBe('CLOSED');
    expect(sess.strategy_bucket).toBe('CLOSED');
    expect(sess.legacy_bucket).toBe('closed');
    expect(sess.is_weekend).toBe(true);
    expect(sess.is_rth).toBe(false);
    expect(sess.is_eth).toBe(false);
  });

  it('classifies Sunday 18:00 ET as ETH (Globex open)', () => {
    // Sunday 18:00 EDT = Sunday 22:00 UTC (summer)
    const d = new Date('2026-07-05T22:00:00Z');
    const sess = classifySession(d);

    expect(sess.exchange_state).toBe('ETH');
    expect(sess.is_eth).toBe(true);
    // is_weekend is true (it IS Sunday) but exchange is open
    // This is intentional — is_weekend reflects DOW, exchange_state reflects market status
    expect(sess.is_weekend).toBe(true);
    expect(sess.dow_et).toBe(0);
  });

  it('classifies Sunday before 18:00 ET as CLOSED', () => {
    // Sunday 12:00 EDT = Sunday 16:00 UTC (summer)
    const d = new Date('2026-07-05T16:00:00Z');
    const sess = classifySession(d);

    expect(sess.exchange_state).toBe('CLOSED');
    expect(sess.strategy_bucket).toBe('CLOSED');
  });

  it('classifies Friday after 17:00 ET as CLOSED', () => {
    // Friday 17:30 EDT = Friday 21:30 UTC (summer)
    const d = new Date('2026-07-10T21:30:00Z');
    const sess = classifySession(d);

    expect(sess.exchange_state).toBe('CLOSED');
    expect(sess.strategy_bucket).toBe('CLOSED');
  });

  it('classifies maintenance window correctly', () => {
    // Monday 17:30 EDT = Monday 21:30 UTC (summer)
    const d = new Date('2026-07-06T21:30:00Z');
    const sess = classifySession(d);

    expect(sess.exchange_state).toBe('MAINTENANCE');
    expect(sess.strategy_bucket).toBe('MAINTENANCE');
    expect(sess.legacy_bucket).toBe('closed');
  });

  it('includes timezone context fields', () => {
    const d = new Date('2026-07-06T16:00:00Z'); // Monday 12:00 EDT
    const sess = classifySession(d);

    expect(typeof sess.tokyo_hour).toBe('number');
    expect(typeof sess.london_hour).toBe('number');
    expect(sess.tokyo_hour).toBeGreaterThanOrEqual(0);
    expect(sess.tokyo_hour).toBeLessThan(24);
    expect(sess.london_hour).toBeGreaterThanOrEqual(0);
    expect(sess.london_hour).toBeLessThan(24);
  });

  it('computes minutes_since_rth_open correctly', () => {
    // Monday 10:00 ET = 30 minutes after RTH open
    const d = new Date('2026-07-06T14:00:00Z'); // 10:00 EDT
    const sess = classifySession(d);

    expect(sess.minutes_since_rth_open).toBe(30); // 10:00 - 09:30 = 30
  });

  it('computes minutes_to_rth_close correctly', () => {
    // Monday 15:00 ET = 60 minutes before RTH close
    const d = new Date('2026-07-06T19:00:00Z'); // 15:00 EDT
    const sess = classifySession(d);

    expect(sess.minutes_to_rth_close).toBe(60); // 16:00 - 15:00 = 60
  });
});

// ─── DST Transition Tests ────────────────────────────────────────────────────

describe('DST awareness', () => {
  it('classifies correctly during US spring forward (March 2026)', () => {
    // US DST starts March 8, 2026 (second Sunday of March)
    // March 9, 2026 (Monday) is first weekday in EDT
    // 09:30 EDT = 13:30 UTC
    const d = new Date('2026-03-09T13:30:00Z');
    const sess = classifySession(d);

    expect(sess.exchange_state).toBe('RTH');
    expect(sess.strategy_bucket).toBe('NY_AM');
    expect(sess.minutes_of_day_et).toBe(9 * 60 + 30);
  });

  it('classifies correctly during US fall back (November 2026)', () => {
    // US DST ends November 1, 2026 (first Sunday of November)
    // November 2, 2026 (Monday) is first weekday in EST
    // 09:30 EST = 14:30 UTC
    const d = new Date('2026-11-02T14:30:00Z');
    const sess = classifySession(d);

    expect(sess.exchange_state).toBe('RTH');
    expect(sess.strategy_bucket).toBe('NY_AM');
    expect(sess.minutes_of_day_et).toBe(9 * 60 + 30);
  });

  it('London summer time affects LONDON bucket derivation', () => {
    // In summer (BST = UTC+1), London opens at 08:00 BST = 07:00 UTC = 03:00 EDT
    // In winter (GMT = UTC+0), London opens at 08:00 GMT = 08:00 UTC = 03:00 EST
    // Both map to roughly 03:00 ET, but the getTzHour() should reflect the difference
    const summer = new Date('2026-07-15T07:00:00Z'); // 03:00 EDT, London = 08:00 BST
    const winter = new Date('2026-01-15T08:00:00Z'); // 03:00 EST, London = 08:00 GMT

    expect(getTzHour(summer, 'Europe/London')).toBe(8);
    expect(getTzHour(winter, 'Europe/London')).toBe(8);
  });

  it('Tokyo has no DST — consistent year-round', () => {
    const summer = new Date('2026-07-15T00:00:00Z'); // 09:00 JST
    const winter = new Date('2026-01-15T00:00:00Z'); // 09:00 JST

    expect(getTzHour(summer, 'Asia/Tokyo')).toBe(9);
    expect(getTzHour(winter, 'Asia/Tokyo')).toBe(9);
  });
});

// ─── RTH Sub-bucket Boundary Tests ──────────────────────────────────────────

describe('RTH sub-bucket boundaries', () => {
  it('09:30 → NY_AM', () => {
    expect(classifyStrategyBucket('RTH', 9 * 60 + 30, 1, 0, 0)).toBe('NY_AM');
  });

  it('11:59 → NY_AM', () => {
    expect(classifyStrategyBucket('RTH', 11 * 60 + 59, 1, 0, 0)).toBe('NY_AM');
  });

  it('12:00 → NY_LUNCH', () => {
    expect(classifyStrategyBucket('RTH', 12 * 60, 1, 0, 0)).toBe('NY_LUNCH');
  });

  it('13:59 → NY_LUNCH', () => {
    expect(classifyStrategyBucket('RTH', 13 * 60 + 59, 1, 0, 0)).toBe('NY_LUNCH');
  });

  it('14:00 → NY_PM', () => {
    expect(classifyStrategyBucket('RTH', 14 * 60, 1, 0, 0)).toBe('NY_PM');
  });

  it('15:59 → NY_PM', () => {
    expect(classifyStrategyBucket('RTH', 15 * 60 + 59, 1, 0, 0)).toBe('NY_PM');
  });
});

// ─── All buckets reachable ──────────────────────────────────────────────────

describe('all strategy buckets are reachable', () => {
  const scenarios: Array<{
    bucket: StrategySessionBucket;
    exchange: ExchangeSessionState;
    minutesOfDay: number;
    dow: number;
    tokyoHour: number;
    londonHour: number;
  }> = [
    { bucket: 'ASIA',        exchange: 'ETH',         minutesOfDay: 22 * 60, dow: 1, tokyoHour: 11, londonHour: 3 },
    { bucket: 'LONDON',      exchange: 'ETH',         minutesOfDay: 5 * 60,  dow: 2, tokyoHour: 14, londonHour: 10 },
    { bucket: 'NY_AM',       exchange: 'RTH',         minutesOfDay: 10 * 60, dow: 1, tokyoHour: 23, londonHour: 15 },
    { bucket: 'NY_LUNCH',    exchange: 'RTH',         minutesOfDay: 13 * 60, dow: 3, tokyoHour: 2,  londonHour: 18 },
    { bucket: 'NY_PM',       exchange: 'RTH',         minutesOfDay: 15 * 60, dow: 4, tokyoHour: 4,  londonHour: 20 },
    { bucket: 'CLOSED',      exchange: 'CLOSED',      minutesOfDay: 12 * 60, dow: 6, tokyoHour: 1,  londonHour: 17 },
    { bucket: 'MAINTENANCE', exchange: 'MAINTENANCE', minutesOfDay: 17 * 60 + 30, dow: 2, tokyoHour: 6, londonHour: 22 },
  ];

  for (const s of scenarios) {
    it(`reaches ${s.bucket}`, () => {
      const result = classifyStrategyBucket(s.exchange, s.minutesOfDay, s.dow, s.tokyoHour, s.londonHour);
      expect(result).toBe(s.bucket);
    });
  }
});

// ─── Legacy compat: classifySession returns all expected fields ─────────────

describe('SessionContext completeness', () => {
  it('has all required fields', () => {
    const sess = classifySession(new Date());

    // Layer 1
    expect(['RTH', 'ETH', 'MAINTENANCE', 'CLOSED']).toContain(sess.exchange_state);

    // Layer 2
    expect(['ASIA', 'LONDON', 'NY_AM', 'NY_LUNCH', 'NY_PM', 'CLOSED', 'MAINTENANCE', 'UNKNOWN'])
      .toContain(sess.strategy_bucket);

    // Legacy bucket
    expect(['premarket', 'rth_open', 'midday', 'power_hour', 'postmarket', 'closed', 'unknown'])
      .toContain(sess.legacy_bucket);

    // Timezone fields
    expect(typeof sess.tokyo_hour).toBe('number');
    expect(typeof sess.london_hour).toBe('number');

    // Legacy boolean flags
    expect(typeof sess.is_rth).toBe('boolean');
    expect(typeof sess.is_eth).toBe('boolean');
    expect(typeof sess.is_weekend).toBe('boolean');
    expect(typeof sess.is_us_cash_open_window).toBe('boolean');
    expect(typeof sess.is_rth_closing_window).toBe('boolean');

    // ET timestamp
    expect(typeof sess.now_et_iso).toBe('string');
    expect(typeof sess.dow_et).toBe('number');
    expect(typeof sess.minutes_of_day_et).toBe('number');
  });
});
