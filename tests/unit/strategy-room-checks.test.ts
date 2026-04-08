/**
 * Tests for hasRoomToUpside / hasRoomToDownside helpers and the symmetric
 * downside-room pre-check introduced in genTrendPullbackShort.
 *
 * Structure:
 *   1. hasRoomToDownside() unit tests (new helper)
 *   2. hasRoomToUpside() unit tests (symmetry baseline)
 *   3. Integration: generateSignal() respects the downside room gate
 *   4. Integration: long-side room gate is unchanged
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  hasRoomToUpside,
  hasRoomToDownside,
  generateSignal,
} from '../../src/autotrade/strategy.js';
import type {
  MarketSnapshot,
  IndicatorSnapshot,
  KeyLevels,
  IndicatorConfig,
} from '../../src/autotrade/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal MarketSnapshot sufficient for the room-check helpers.
 * Only indicators_1m.atr_14 and key_levels fields are accessed by the helpers.
 */
function roomSnap(
  atr: number | null,
  kl: Partial<KeyLevels> = {},
): MarketSnapshot {
  return {
    indicators_1m: { atr_14: atr } as IndicatorSnapshot,
    key_levels: {
      session_high: null,
      session_low: null,
      daily_open: null,
      weekly_open: null,
      monday_high: null,
      monday_low: null,
      monday_mid: null,
      monthly_open: null,
      pivot_resistance: [],
      pivot_support: [],
      choch_sell: null,
      choch_buy: null,
      bos_sell: null,
      bos_buy: null,
      overnight_high: null,
      overnight_low: null,
      prior_rth_high: null,
      prior_rth_low: null,
      opening_range_high: null,
      opening_range_low: null,
      opening_range_mid: null,
      session_vwap: null,
      ...kl,
    },
  } as MarketSnapshot;
}

// ─── Minimal config for generateSignal (all optional generators disabled) ────

const MIN_CONFIG: IndicatorConfig = {
  version: 'TEST',
  type: 'BASELINE',
  created_at: '2025-01-01T00:00:00Z',
  ema_fast: 9,
  ema_mid: 21,
  ema_slow: 50,
  rsi_period: 14,
  atr_period: 14,
  volume_sma_period: 20,
  min_confidence: 3.0,   // low threshold — we only care whether setup is generated
  max_confidence: 10.0,
  min_rr: 1.5,
  max_risk_per_trade_pct: 2.0,
  max_daily_loss_pct: 3.0,
  max_consecutive_losses: 5,
  account_equity: 25_000,
  time_stop_minutes: 30,
  time_stop_max_r_pre_t1: 0.25,
  time_stop_max_r_post_t1: 1.0,
  analysis_interval_seconds: 20,
  in_position_monitor_seconds: 2,
  opening_range_minutes: 15,
  trail_ticks_post_t1: 12,
  enable_momentum_continuation: false,
  enable_opening_drive: false,  // keeps optional generators quiet
  enable_failed_or_break: false,
  dual_min_score: 3.0,
  dual_score_margin: 1.0,
  dual_choppy_extra_margin: 0.5,
  cooldown_bars: 3,
  no_same_bar_reversal: true,
};

/**
 * Build a complete MarketSnapshot that satisfies all genTrendPullbackShort
 * preconditions (EMA stack, SuperTrend down, distToEma9 in range, valid R/R)
 * except the downside-room gate — that is controlled by sessionLow.
 *
 * Key numbers:
 *   price=19950, ema9=19970 → distToEma9=20 (< 80 ✓)
 *   entryLow=19950, entryHigh=19975, entryMid=19962.5
 *   stop=ema21+20=20010, riskPts=47.5
 *   T1=choch_buy=19880 → rrt1≈1.74 ✓
 *   T2=pivot_support[0]=19800 → rrt2≈3.42 ✓
 *   atr=10 → minRoom=10 pts
 *
 * Insufficient room:  sessionLow ≥ 19953  (≤ 9.5 pts below entryMid)
 * Sufficient room:    sessionLow ≤ 19950  (≥ 12.5 pts below entryMid)
 */
function makeTrendDownSnap(sessionLow: number | null): MarketSnapshot {
  const price = 19950;

  const ind: IndicatorSnapshot = {
    ema_9: 19970,
    ema_21: 19990,
    ema_50: 20020,
    ema_100: null,
    ema_200: null,
    supertrend_direction: 'down',
    supertrend_level: null,
    novawave_fast: null,
    novawave_slow: null,
    novawave_signal: null,
    dma_20: null,
    dma_50: null,
    dma_200: null,
    // choch_sell + bos_sell both null → genBreakdownRetestShort won't fire
    smart_money_choch_sell: null,
    smart_money_choch_buy: 19880,  // T1 for the short setup
    smart_money_bos_sell: null,
    smart_money_bos_buy: null,
    vwap: null,
    atr_14: 10,
    rsi_14: null,
    volume: null,
    volume_sma_20: null,
    adx: null,
    di_plus: null,
    di_minus: null,
    ttm_squeeze_momentum: null,
    ttm_squeeze_firing: null,
    cvd: null,
    cvd_delta: null,
    cvd_trend: null,
  };

  const kl: KeyLevels = {
    session_high: 20200,
    session_low: sessionLow,
    daily_open: null,
    weekly_open: null,
    monday_high: null,
    monday_low: null,
    monday_mid: null,
    monthly_open: null,
    pivot_resistance: [20050],
    pivot_support: [19800],  // T2 for the short setup
    // All breakdown/structural levels null → no competing short generators fire
    choch_sell: null,
    choch_buy: null,
    bos_sell: null,
    bos_buy: null,
    overnight_high: null,
    overnight_low: null,
    prior_rth_high: null,
    prior_rth_low: null,
    opening_range_high: null,
    opening_range_low: null,
    opening_range_mid: null,
    session_vwap: null,
  };

  return {
    timestamp_unix: Date.now(),
    timestamp_iso: new Date().toISOString(),
    symbol: 'NQ',
    price,
    bars_1m: [],
    bars_5m: [],
    bars_15m: [],
    bars_1h: [],
    indicators_1m: ind,
    indicators_15m: {} as IndicatorSnapshot,  // empty → assessTfBias returns 'neutral'
    indicators_1h: {} as IndicatorSnapshot,
    key_levels: kl,
    data_quality: {
      bars_1m_count: 0,
      bars_5m_count: 0,
      bars_15m_count: 0,
      bars_1h_count: 0,
      vwap_available: false,
      atr_available: true,
      rsi_available: false,
      missing_indicators: [],
    },
  };
}

// ─── 1. hasRoomToDownside unit tests ─────────────────────────────────────────

describe('hasRoomToDownside', () => {
  const ENTRY_MID = 20000;

  it('returns true when no support levels are detected', () => {
    const snap = roomSnap(10); // all key_levels null / empty
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(true);
  });

  it('returns true when ATR is null (cannot measure → do not block)', () => {
    const snap = roomSnap(null, { session_low: 19995 }); // only 5 pts below
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(true);
  });

  it('returns true when ATR is zero (cannot measure → do not block)', () => {
    const snap = roomSnap(0, { session_low: 19995 });
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(true);
  });

  it('returns true when nearest support is exactly at the minimum distance', () => {
    // entryMid=20000, atr=10, minRoomAtr=1.0 → needs 10 pts → 19990 is borderline
    const snap = roomSnap(10, { session_low: 19990 });
    expect(hasRoomToDownside(snap, ENTRY_MID, 1.0)).toBe(true); // 10 >= 10 ✓
  });

  it('returns true when nearest support is far enough away', () => {
    // 20000 - 19850 = 150 pts = 15 ATR → well above 1.0 ATR minimum
    const snap = roomSnap(10, { session_low: 19850 });
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(true);
  });

  it('returns false when session_low is too close', () => {
    // 20000 - 19995 = 5 pts < 10 ATR → insufficient
    const snap = roomSnap(10, { session_low: 19995 });
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(false);
  });

  it('returns false when opening_range_low is the nearest and too close', () => {
    const snap = roomSnap(10, {
      session_low: 19800,          // far away
      opening_range_low: 19995,   // near — this is the nearest support
    });
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(false);
  });

  it('returns false when prior_rth_low is the nearest and too close', () => {
    const snap = roomSnap(10, { prior_rth_low: 19996 });
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(false);
  });

  it('returns false when pivot_support[0] is the nearest and too close', () => {
    const snap = roomSnap(10, { pivot_support: [19997] });
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(false);
  });

  it('uses the NEAREST (highest) support when multiple levels are present', () => {
    // Multiple supports: 19600, 19800, 19997 → nearest = 19997 (highest below)
    const snap = roomSnap(10, {
      session_low: 19600,
      opening_range_low: 19800,
      prior_rth_low: 19997,       // nearest, too close
    });
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(false);
  });

  it('ignores support levels that are above or equal to entryMid', () => {
    // session_low=20005 is ABOVE entryMid=20000 → should not be counted as support
    const snap = roomSnap(10, { session_low: 20005 });
    // With no valid support below, result is true (no support detected → allow)
    expect(hasRoomToDownside(snap, ENTRY_MID)).toBe(true);
  });

  it('respects a custom minRoomAtr threshold', () => {
    // 20000 - 19990 = 10 pts; atr=10 → 1.0 ATR
    const snap = roomSnap(10, { session_low: 19990 });
    expect(hasRoomToDownside(snap, ENTRY_MID, 1.0)).toBe(true);  // 1.0 >= 1.0 ✓
    expect(hasRoomToDownside(snap, ENTRY_MID, 1.5)).toBe(false); // 1.0 < 1.5 ✗
  });
});

// ─── 2. hasRoomToUpside unit tests (symmetry baseline) ───────────────────────

describe('hasRoomToUpside', () => {
  const ENTRY_MID = 20000;

  it('returns true when no resistance levels are detected', () => {
    expect(hasRoomToUpside(roomSnap(10), ENTRY_MID)).toBe(true);
  });

  it('returns true when ATR is null', () => {
    const snap = roomSnap(null, { session_high: 20003 });
    expect(hasRoomToUpside(snap, ENTRY_MID)).toBe(true);
  });

  it('returns true when nearest resistance is far enough away', () => {
    const snap = roomSnap(10, { session_high: 20150 }); // 150 pts = 15 ATR ✓
    expect(hasRoomToUpside(snap, ENTRY_MID)).toBe(true);
  });

  it('returns false when session_high is too close', () => {
    const snap = roomSnap(10, { session_high: 20005 }); // 5 pts < 10 ATR ✗
    expect(hasRoomToUpside(snap, ENTRY_MID)).toBe(false);
  });

  it('returns false when opening_range_high is nearest and too close', () => {
    const snap = roomSnap(10, { session_high: 20200, opening_range_high: 20003 });
    expect(hasRoomToUpside(snap, ENTRY_MID)).toBe(false);
  });

  it('uses the NEAREST (lowest) resistance when multiple levels are present', () => {
    const snap = roomSnap(10, {
      session_high: 20200,
      prior_rth_high: 20400,
      pivot_resistance: [20003],  // nearest, too close
    });
    expect(hasRoomToUpside(snap, ENTRY_MID)).toBe(false);
  });

  it('ignores resistance at or below entryMid', () => {
    const snap = roomSnap(10, { session_high: 19990 }); // below entryMid → ignored
    expect(hasRoomToUpside(snap, ENTRY_MID)).toBe(true);
  });
});

// ─── 3. Integration: trend_pullback_short downside-room gate ─────────────────

describe('trend_pullback_short downside room gate (via generateSignal)', () => {
  // Suppress the verbose confidence logging that generateSignal emits
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('generates trend_pullback_short when downside room is sufficient', () => {
    // entryMid=19962.5; session_low=19850 → 112.5 pts = 11.25 ATR ≥ 1.0 ✓
    const snap = makeTrendDownSnap(19850);
    const result = generateSignal(snap, MIN_CONFIG);
    expect(result.bestShort).not.toBeNull();
    expect(result.bestShort?.setup.setup_type).toBe('trend_pullback_short');
  });

  it('does NOT generate trend_pullback_short when session_low is too close to entryMid', () => {
    // entryMid=19962.5; session_low=19958 → 4.5 pts < 10 ATR ✗
    const snap = makeTrendDownSnap(19958);
    const result = generateSignal(snap, MIN_CONFIG);
    // No short setup should be generated at all (all other generators disabled)
    const shortType = result.bestShort?.setup.setup_type ?? null;
    expect(shortType).not.toBe('trend_pullback_short');
  });

  it('does NOT generate trend_pullback_short when session_low is null but pivot is too close', () => {
    // Override: session_low=null, but pivot_support[0] very close to entryMid
    const snap = makeTrendDownSnap(null);
    // Manually put a pivot right below entryMid
    snap.key_levels.pivot_support = [19960]; // 2.5 pts below entryMid → < 10 ATR ✗
    const result = generateSignal(snap, MIN_CONFIG);
    expect(result.bestShort?.setup.setup_type ?? null).not.toBe('trend_pullback_short');
  });

  it('generates trend_pullback_short when only session_low is present and is far enough', () => {
    // No pivot_support at all; session_low far below
    const snap = makeTrendDownSnap(19840); // 122.5 pts = 12.25 ATR ✓
    snap.key_levels.pivot_support = []; // remove pivot so only session_low is the guard
    const result = generateSignal(snap, MIN_CONFIG);
    expect(result.bestShort?.setup.setup_type).toBe('trend_pullback_short');
  });

  it('confidence_factors includes downside_room_confirmed when room check passes', () => {
    const snap = makeTrendDownSnap(19850);
    const result = generateSignal(snap, MIN_CONFIG);
    const factors = result.bestShort?.setup.confidence_factors ?? [];
    expect(factors).toContain('downside_room_confirmed');
  });
});

// ─── 4. Integration: long-side room gate is unchanged ────────────────────────

describe('trend_pullback_long upside room gate is preserved (via generateSignal)', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  /**
   * Build a snap that satisfies genTrendPullbackLong's preconditions:
   *   stDir='up', price > ema9 > ema21 > ema50, isUptrendFresh=true,
   *   distToEma9 in [0, 80], room above controlled by sessionHigh.
   *
   * price=20050, ema9=20030 → distToEma9=20 (< 80 ✓)
   * entryLow=ema9-5=20025, entryHigh=price=20050, entryMid=20037.5
   * stop=ema21-20=19970, riskPts=67.5
   * choch_sell=20160 → rrt1=(20160-20037.5)/67.5≈1.81 ✓
   * pivot_resistance[0]=20200 → rrt2≈2.41 ✓
   * atr=10 → minRoom=10 pts above entryMid
   */
  function makeTrendUpSnap(sessionHigh: number | null): MarketSnapshot {
    const price = 20050;

    const ind: IndicatorSnapshot = {
      ema_9: 20030,
      ema_21: 19990,
      ema_50: 19960,
      ema_100: null,
      ema_200: null,
      supertrend_direction: 'up',
      supertrend_level: null,
      novawave_fast: null,
      novawave_slow: null,
      novawave_signal: null,
      dma_20: null,
      dma_50: null,
      dma_200: null,
      smart_money_choch_sell: 20160,  // T1 for long
      smart_money_choch_buy: null,
      smart_money_bos_sell: null,
      smart_money_bos_buy: null,
      vwap: 20040,  // price above VWAP → isUptrendFresh check passes
      atr_14: 10,
      rsi_14: null,
      volume: null,
      volume_sma_20: null,
      adx: null,
      di_plus: null,
      di_minus: null,
      ttm_squeeze_momentum: null,
      ttm_squeeze_firing: null,
      cvd: null,
      cvd_delta: null,
      cvd_trend: null,
    };

    // 5m bars: need higher lows for isUptrendFresh check (recentMinLow > priorMinLow)
    // 6 bars: prior3Lows=[19980,19985,19988], recent3Lows=[19990,19993,19996] → higherLows ✓
    const make5mBar = (low: number, i: number) => ({
      time: 1700000000 + i * 300,
      open: low + 1, high: low + 5, low, close: low + 3, volume: 100,
    });
    const bars5m = [
      make5mBar(19980, 0), make5mBar(19985, 1), make5mBar(19988, 2),
      make5mBar(19990, 3), make5mBar(19993, 4), make5mBar(19996, 5),
    ];

    const kl: KeyLevels = {
      session_high: sessionHigh,
      session_low: 19800,
      daily_open: null,
      weekly_open: null,
      monday_high: null,
      monday_low: null,
      monday_mid: null,
      monthly_open: null,
      pivot_resistance: [20200],  // T2 for long
      pivot_support: [19900],
      choch_sell: null,
      choch_buy: null,
      bos_sell: null,
      bos_buy: null,
      overnight_high: null,
      overnight_low: null,
      prior_rth_high: null,
      prior_rth_low: null,
      opening_range_high: null,
      opening_range_low: null,
      opening_range_mid: null,
      session_vwap: null,
    };

    return {
      timestamp_unix: Date.now(),
      timestamp_iso: new Date().toISOString(),
      symbol: 'NQ',
      price,
      bars_1m: [],
      bars_5m: bars5m,
      bars_15m: [],
      bars_1h: [],
      indicators_1m: ind,
      indicators_15m: {} as IndicatorSnapshot,
      indicators_1h: {} as IndicatorSnapshot,
      key_levels: kl,
      data_quality: {
        bars_1m_count: 0, bars_5m_count: 6, bars_15m_count: 0, bars_1h_count: 0,
        vwap_available: true, atr_available: true, rsi_available: false,
        missing_indicators: [],
      },
    };
  }

  it('generates trend_pullback_long when upside room is sufficient', () => {
    // entryMid≈20037.5; session_high=20200 → 162.5 pts = 16.25 ATR ≥ 1.0 ✓
    const snap = makeTrendUpSnap(20200);
    const result = generateSignal(snap, MIN_CONFIG);
    expect(result.bestLong?.setup.setup_type).toBe('trend_pullback_long');
  });

  it('does NOT generate trend_pullback_long when upside room is insufficient', () => {
    // entryMid≈20037.5; session_high=20042 → 4.5 pts < 10 ATR ✗
    const snap = makeTrendUpSnap(20042);
    const result = generateSignal(snap, MIN_CONFIG);
    expect(result.bestLong?.setup.setup_type ?? null).not.toBe('trend_pullback_long');
  });
});
