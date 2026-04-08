/**
 * Tests for entry extension / chase detection features and veto logic.
 */
import { describe, it, expect } from 'vitest';
import {
  computeExtensionFeatures,
  evaluateExtensionVeto,
  isTrendPullbackSetup,
  DEFAULT_EXTENSION_FILTER_CONFIG,
} from '../../src/autotrade/features/extension.js';
import type {
  ExtensionFeatures,
} from '../../src/autotrade/features/extension.js';
import type { MarketSnapshot, OhlcvBar, IndicatorSnapshot, KeyLevels } from '../../src/autotrade/types.js';

function makeBar(close: number, i: number): OhlcvBar {
  return { time: 1700000000 + i * 60, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 100 };
}

function makeSnap(price: number, overrides: Partial<{ vwap: number | null; ema9: number | null; atr: number | null }> = {}): MarketSnapshot {
  const bars = Array.from({ length: 30 }, (_, i) => makeBar(price - 15 + i, i));
  return {
    timestamp_unix: Date.now(), timestamp_iso: new Date().toISOString(),
    symbol: 'NQ', price,
    bars_1m: bars, bars_5m: [], bars_15m: [], bars_1h: [],
    indicators_1m: {
      ema_9: overrides.ema9 ?? price - 2, ema_21: price - 5, ema_50: price - 10,
      ema_100: null, ema_200: null,
      supertrend_direction: 'up', supertrend_level: null,
      novawave_fast: null, novawave_slow: null, novawave_signal: null,
      dma_20: null, dma_50: null, dma_200: null,
      smart_money_choch_sell: null, smart_money_choch_buy: null,
      smart_money_bos_sell: null, smart_money_bos_buy: null,
      vwap: overrides.vwap ?? price - 3,
      atr_14: overrides.atr ?? 10,
      rsi_14: 55, volume: 100, volume_sma_20: 100,
      adx: null, di_plus: null, di_minus: null,
      ttm_squeeze_momentum: null, ttm_squeeze_firing: null,
      cvd: null, cvd_delta: null, cvd_trend: null,
    } as IndicatorSnapshot,
    indicators_15m: {} as IndicatorSnapshot,
    indicators_1h: {} as IndicatorSnapshot,
    key_levels: {
      session_high: price + 20, session_low: price - 30,
      daily_open: null, weekly_open: null, monday_high: null, monday_low: null,
      monday_mid: null, monthly_open: null,
      pivot_resistance: [price + 15], pivot_support: [price - 25],
      choch_sell: null, choch_buy: null, bos_sell: null, bos_buy: null,
      overnight_high: null, overnight_low: null,
      prior_rth_high: price + 25, prior_rth_low: price - 35,
      opening_range_high: price + 10, opening_range_low: price - 15,
      opening_range_mid: price - 2.5, session_vwap: null,
    },
    data_quality: { bars_1m_count: 30, bars_5m_count: 0, bars_15m_count: 0,
      bars_1h_count: 0, vwap_available: true, atr_available: true,
      rsi_available: true, missing_indicators: [] },
  } as MarketSnapshot;
}

describe('Extension Features', () => {
  it('computes distance from VWAP', () => {
    const snap = makeSnap(24200, { vwap: 24190, atr: 10 });
    const features = computeExtensionFeatures(snap, 24200, 'long');
    expect(features.dist_from_vwap_pts).toBe(10);
    expect(features.dist_from_vwap_atr).toBe(1);
  });

  it('computes impulse metrics', () => {
    const snap = makeSnap(24200);
    const features = computeExtensionFeatures(snap, 24200, 'long');
    expect(features.current_impulse_pts).toBeGreaterThanOrEqual(0);
    expect(features.bars_since_impulse_start).toBeGreaterThanOrEqual(0);
  });

  it('computes room left to levels', () => {
    const snap = makeSnap(24200);
    const features = computeExtensionFeatures(snap, 24200, 'long');
    expect(features.upside_room_pts).not.toBeNull();
    expect(features.downside_room_pts).not.toBeNull();
  });

  it('detects consecutive push bars', () => {
    const snap = makeSnap(24200);
    const features = computeExtensionFeatures(snap, 24200, 'long');
    expect(features.consecutive_push_bars).toBeGreaterThanOrEqual(0);
  });
});

describe('Extension Veto Rules', () => {
  it('vetoes long entry extended from VWAP (session-scaled)', () => {
    // With ATR=10, sessionAtr = 10*sqrt(60) ≈ 77.5, so need >155 pts from VWAP
    // to exceed the 2.0 session-ATR threshold.
    const snap = makeSnap(24400, { vwap: 24200, atr: 10 }); // 200 pts above VWAP
    const features = computeExtensionFeatures(snap, 24400, 'long');
    expect(features.dist_from_vwap_session).toBeGreaterThan(2.0);
    const veto = evaluateExtensionVeto(features, 'long', DEFAULT_EXTENSION_FILTER_CONFIG);
    expect(veto.vetoed).toBe(true);
    expect(veto.reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
  });

  it('vetoes short entry extended from VWAP (session-scaled)', () => {
    const snap = makeSnap(24000, { vwap: 24200, atr: 10 }); // 200 pts below VWAP
    const features = computeExtensionFeatures(snap, 24000, 'short');
    expect(features.dist_from_vwap_session).toBeGreaterThan(2.0);
    const veto = evaluateExtensionVeto(features, 'short', DEFAULT_EXTENSION_FILTER_CONFIG);
    expect(veto.vetoed).toBe(true);
    expect(veto.reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
  });

  it('does NOT veto entry close to VWAP (session-scaled)', () => {
    // 5 pts from VWAP with sessionAtr ~77.5 → 0.06 session-ATR — well under 2.0
    const snap = makeSnap(24205, { vwap: 24200, atr: 10 });
    const features = computeExtensionFeatures(snap, 24205, 'long');
    expect(features.dist_from_vwap_session).toBeLessThan(1.0);
    const veto = evaluateExtensionVeto(features, 'long', DEFAULT_EXTENSION_FILTER_CONFIG);
    expect(veto.reasons.filter(r => r.includes('extended_from_vwap'))).toHaveLength(0);
  });

  it('does NOT veto moderate VWAP distance that old 1m-ATR would have killed', () => {
    // 30 pts from VWAP: old system → 30/10 = 3.0 micro-ATR > 2.0 → VETOED
    // new system → 30/77.5 = 0.39 session-ATR < 2.0 → NOT VETOED
    const snap = makeSnap(24230, { vwap: 24200, atr: 10 });
    const features = computeExtensionFeatures(snap, 24230, 'long');
    expect(features.dist_from_vwap_atr).toBeGreaterThan(2.0); // old system would veto
    expect(features.dist_from_vwap_session).toBeLessThan(2.0); // new system does not
    const veto = evaluateExtensionVeto(features, 'long', DEFAULT_EXTENSION_FILTER_CONFIG);
    expect(veto.reasons.filter(r => r.includes('extended_from_vwap'))).toHaveLength(0);
  });

  it('vetoes too many consecutive push bars', () => {
    // Create bars that are all bullish
    const allBullBars = Array.from({ length: 30 }, (_, i) =>
      ({ time: 1700000000 + i * 60, open: 24100 + i * 2, high: 24103 + i * 2, low: 24099 + i * 2, close: 24102 + i * 2, volume: 100 }));
    const snap = makeSnap(24200);
    snap.bars_1m = allBullBars;
    const features = computeExtensionFeatures(snap, 24200, 'long');
    const config = { ...DEFAULT_EXTENSION_FILTER_CONFIG, max_consecutive_push_bars: 5 };
    const veto = evaluateExtensionVeto(features, 'long', config);
    expect(features.consecutive_push_bars).toBeGreaterThan(5);
    expect(veto.vetoed).toBe(true);
    expect(veto.reasons.some(r => r.includes('too_many_push_bars'))).toBe(true);
  });

  it('does not veto when disabled', () => {
    const snap = makeSnap(24230, { vwap: 24200, atr: 10 });
    const features = computeExtensionFeatures(snap, 24230, 'long');
    const config = { ...DEFAULT_EXTENSION_FILTER_CONFIG, enabled: false };
    const veto = evaluateExtensionVeto(features, 'long', config);
    expect(veto.vetoed).toBe(false);
  });
});

// ─── entryMid vs snap.price regression ───────────────────────────────────────
//
// These tests prove that fill-dependent metrics (VWAP/EMA distances, room left)
// are computed from entryMid (the intended fill zone), NOT from snap.price (the
// current tape).  Each test has an explicit "old behaviour" comment showing what
// the buggy value would have been.

describe('entryMid vs snap.price regression', () => {
  // Helper: build a snap with a specific tape price and optional key-level
  // overrides.  Key levels default to the ones makeSnap produces (relative to
  // snapPrice).  Pass levelOverrides to place exact boundaries.
  function makeRegressionSnap(
    snapPrice: number,
    opts: {
      vwap?: number;
      atr?: number;
      ema9?: number;
      ema21?: number;
      ema50?: number;
    } = {},
    levelOverrides: Partial<{
      session_high: number;
      session_low: number;
      opening_range_high: number;
      opening_range_low: number;
      prior_rth_high: number;
      prior_rth_low: number;
      pivot_resistance: number[];
      pivot_support: number[];
    }> = {},
  ) {
    const snap = makeSnap(snapPrice, {
      vwap: opts.vwap,
      atr: opts.atr ?? 10,
      ema9: opts.ema9,
    });
    // Apply optional EMA overrides not covered by makeSnap
    if (opts.ema21 !== undefined) snap.indicators_1m.ema_21 = opts.ema21;
    if (opts.ema50 !== undefined) snap.indicators_1m.ema_50 = opts.ema50;
    // Apply key-level overrides
    Object.assign(snap.key_levels, levelOverrides);
    return snap;
  }

  // ── Long: VWAP distance uses entryMid ──────────────────────────────────

  it('long: dist_from_vwap_pts reflects entryMid, not snap.price', () => {
    // snap.price = 24230 (3 ATR above VWAP), entryMid = 24210 (1 ATR above)
    const snap = makeRegressionSnap(24230, { vwap: 24200, atr: 10 });
    const features = computeExtensionFeatures(snap, 24210, 'long');
    // new (correct): 24210 − 24200 = 10 pts
    // old (buggy):   24230 − 24200 = 30 pts
    expect(features.dist_from_vwap_pts).toBe(10);
    expect(features.dist_from_vwap_atr).toBe(1.0);
  });

  it('long: no false VWAP veto when entryMid is within limit', () => {
    // snap.price is 3 ATR above VWAP (would have triggered the veto).
    // entryMid is only 1 ATR above — within the 2 ATR default limit.
    const snap = makeRegressionSnap(24230, { vwap: 24200, atr: 10 });
    const features = computeExtensionFeatures(snap, 24210, 'long');
    const veto = evaluateExtensionVeto(features, 'long', DEFAULT_EXTENSION_FILTER_CONFIG);
    // old code: vetoed because dist = 3.0 ATR > 2.0 limit
    // new code: not vetoed (dist = 1.0 ATR)
    expect(veto.reasons.filter(r => r.includes('extended_from_vwap'))).toHaveLength(0);
  });

  // ── Short: VWAP distance uses entryMid ────────────────────────────────

  it('short: dist_from_vwap_pts reflects entryMid, not snap.price', () => {
    // snap.price = 24170 (3 ATR below VWAP), entryMid = 24190 (1 ATR below)
    const snap = makeRegressionSnap(24170, { vwap: 24200, atr: 10 });
    const features = computeExtensionFeatures(snap, 24190, 'short');
    // new (correct): 24190 − 24200 = −10 pts (1 ATR below)
    // old (buggy):   24170 − 24200 = −30 pts (3 ATR below)
    expect(features.dist_from_vwap_pts).toBe(-10);
    expect(features.dist_from_vwap_atr).toBe(1.0);
  });

  it('short: no false VWAP veto when entryMid is within limit', () => {
    // snap.price is 3 ATR below VWAP; entryMid is 1 ATR below (within limit).
    const snap = makeRegressionSnap(24170, { vwap: 24200, atr: 10 });
    const features = computeExtensionFeatures(snap, 24190, 'short');
    const veto = evaluateExtensionVeto(features, 'short', DEFAULT_EXTENSION_FILTER_CONFIG);
    // old code: vetoed because |dist| = 3.0 ATR > 2.0 limit
    // new code: not vetoed (|dist| = 1.0 ATR)
    expect(veto.reasons.filter(r => r.includes('extended_from_vwap'))).toHaveLength(0);
  });

  // ── EMA distance metrics ───────────────────────────────────────────────

  it('dist_from_ema9/21/50_atr all use entryMid', () => {
    // snap.price = 24230, entryMid = 24210; EMAs at 24200/24195/24190
    const snap = makeRegressionSnap(24230, {
      atr: 10,
      ema9: 24200,
      ema21: 24195,
      ema50: 24190,
    });
    const features = computeExtensionFeatures(snap, 24210, 'long');
    // new: |24210 − 24200| / 10 = 1.0   old (buggy): |24230 − 24200| / 10 = 3.0
    expect(features.dist_from_ema9_atr).toBe(1.0);
    // new: |24210 − 24195| / 10 = 1.5   old: |24230 − 24195| / 10 = 3.5
    expect(features.dist_from_ema21_atr).toBe(1.5);
    // new: |24210 − 24190| / 10 = 2.0   old: |24230 − 24190| / 10 = 4.0
    expect(features.dist_from_ema50_atr).toBe(2.0);
  });

  // ── Short: downside room uses entryMid ────────────────────────────────

  it('short: captures nearby support between snap.price and entryMid', () => {
    // snap.price = 24165 (already below the support at 24175).
    // entryMid   = 24185 (the intended fill, above that support).
    // The support at 24175 is the nearest meaningful barrier for the fill zone
    // and must be captured.  With snap.price it would be missed entirely.
    const snap = makeRegressionSnap(
      24165,
      { atr: 10 },
      {
        session_low:        24100,  // far away
        opening_range_low:  24175,  // nearby support — between snap.price and entryMid
        prior_rth_low:      24050,
        pivot_support:      [24150],
      },
    );
    const features = computeExtensionFeatures(snap, 24185, 'short');
    // new: entryMid(24185) > opening_range_low(24175) → captured
    //      downside_pts = 24185 − 24175 = 10 (1 ATR)
    // old: snap.price(24165) < opening_range_low(24175) → NOT captured
    //      nearest = max(24100, 24050, 24150) = 24150 → downside_pts = 15
    expect(features.downside_room_pts).toBe(10);
    expect(features.downside_room_atr).toBe(1.0);
  });

  // ── Long: upside room uses entryMid ───────────────────────────────────

  it('long: captures nearby resistance between entryMid and snap.price', () => {
    // snap.price = 24230 (already past the resistance at 24220).
    // entryMid   = 24210 (the intended fill, below that resistance).
    // The resistance at 24220 correctly limits upside from the fill zone.
    const snap = makeRegressionSnap(
      24230,
      { atr: 10 },
      {
        session_high:        24300,
        opening_range_high:  24220,  // nearby resistance — between entryMid and snap.price
        prior_rth_high:      24350,
        pivot_resistance:    [24260],
      },
    );
    const features = computeExtensionFeatures(snap, 24210, 'long');
    // new: opening_range_high(24220) > entryMid(24210) → captured
    //      upside_pts = 24220 − 24210 = 10 (1 ATR)
    // old: opening_range_high(24220) > snap.price(24230) is false → NOT captured
    //      nearest = min(24300, 24350, 24260) = 24260 → upside_pts = 30
    expect(features.upside_room_pts).toBe(10);
    expect(features.upside_room_atr).toBe(1.0);
  });

  // ── Market-state metrics are unchanged (still use current bars) ────────

  it('market-state metrics are not affected by entryMid vs snap.price split', () => {
    // Use a snap where snap.price ≠ entryMid; bar-based metrics must be identical
    // regardless of which price we pass as entryMid.
    const snap1 = makeRegressionSnap(24230, { atr: 10 });
    const snap2 = makeRegressionSnap(24230, { atr: 10 }); // identical
    const fA = computeExtensionFeatures(snap1, 24210, 'long');
    const fB = computeExtensionFeatures(snap2, 24230, 'long'); // entryMid = snap.price
    // Bar-derived metrics must be identical
    expect(fA.current_impulse_pts).toBe(fB.current_impulse_pts);
    expect(fA.current_impulse_atr).toBe(fB.current_impulse_atr);
    expect(fA.bars_since_impulse_start).toBe(fB.bars_since_impulse_start);
    expect(fA.consecutive_push_bars).toBe(fB.consecutive_push_bars);
    expect(fA.bars_since_last_pullback).toBe(fB.bars_since_last_pullback);
    expect(fA.last_3_bar_return_atr).toBe(fB.last_3_bar_return_atr);
    expect(fA.last_5_bar_return_atr).toBe(fB.last_5_bar_return_atr);
    expect(fA.range_expansion_ratio).toBe(fB.range_expansion_ratio);
    expect(fA.reset_occurred).toBe(fB.reset_occurred);
    expect(fA.pullback_depth_pts).toBe(fB.pullback_depth_pts);
    // Fill-dependent metrics MUST differ when entryMid ≠ snap.price
    expect(fA.dist_from_vwap_pts).not.toBe(fB.dist_from_vwap_pts);
    expect(fA.upside_room_pts).not.toBe(fB.upside_room_pts);
  });
});

// ─── Trend Pullback Veto Logic ────────────────────────────────────────────────
//
// Tests that prove VWAP stretch is demoted to soft_reasons for trend pullbacks,
// while genuine chase conditions (no reset, fast move, push exhaustion) are
// still hard-vetoed.
//
// Uses a lightweight inline feature builder so each test is self-contained.

describe('isTrendPullbackSetup classifier', () => {
  it('returns true for trend_pullback_long and trend_pullback_short', () => {
    expect(isTrendPullbackSetup('trend_pullback_long')).toBe(true);
    expect(isTrendPullbackSetup('trend_pullback_short')).toBe(true);
  });

  it('returns false for all other setup types', () => {
    const others = [
      'breakout_retest_long', 'breakdown_retest_short',
      'momentum_continuation', 'opening_drive_continuation_long',
      'or_retest_continuation_short', '', 'unknown',
    ];
    for (const s of others) expect(isTrendPullbackSetup(s)).toBe(false);
  });
});

describe('Trend Pullback Veto Logic', () => {
  /**
   * Minimal feature builder — defaults represent a healthy, non-extended
   * setup.  Override only the fields relevant to each test.
   */
  function makeFeatures(overrides: Partial<ExtensionFeatures> = {}): ExtensionFeatures {
    return {
      dist_from_vwap_pts:            5,
      dist_from_vwap_atr:            0.5,
      dist_from_ema9_atr:            0.3,
      dist_from_ema21_atr:           0.5,
      dist_from_ema50_atr:           1.0,
      current_impulse_pts:           10,
      current_impulse_atr:           1.0,
      bars_since_impulse_start:      5,
      last_3_bar_return_atr:         0.5,
      last_5_bar_return_atr:         0.8,
      consecutive_push_bars:         2,
      bars_since_last_pullback:      3,
      range_expansion_ratio:         1.0,
      upside_room_pts:               20,
      upside_room_atr:               2.0,  // well above min_upside_room_atr=1.0
      downside_room_pts:             25,
      downside_room_atr:             2.5,  // well above min_downside_room_atr=1.0
      reset_occurred:                true,
      pullback_depth_pts:            5,
      pullback_depth_pct_of_impulse: 0.5,
      bars_in_pullback:              2,
      no_reset_extension:            false,
      ...overrides,
    };
  }

  // ── Long: VWAP stretch is soft, not hard ────────────────────────────────

  it('trend_pullback_long: large dist_from_vwap_atr alone does not hard-veto', () => {
    const f = makeFeatures({ dist_from_vwap_pts: 30, dist_from_vwap_atr: 3.0 });
    const v = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_long');
    expect(v.vetoed).toBe(false);
    expect(v.soft_reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
    expect(v.reasons.filter(r => r.includes('extended_from_vwap'))).toHaveLength(0);
  });

  it('trend_pullback_long: soft_reasons label is informational — vetoed stays false', () => {
    // Even at an extreme 5 ATR from VWAP the veto must not fire
    const f = makeFeatures({ dist_from_vwap_pts: 50, dist_from_vwap_atr: 5.0 });
    const v = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_long');
    expect(v.vetoed).toBe(false);
    expect(v.soft_reasons.length).toBeGreaterThan(0);
  });

  // ── Short: VWAP stretch is soft, not hard ───────────────────────────────

  it('trend_pullback_short: large dist_from_vwap_atr alone does not hard-veto', () => {
    // dist_from_vwap_pts negative = below VWAP = extended for short
    const f = makeFeatures({ dist_from_vwap_pts: -30, dist_from_vwap_atr: 3.0 });
    const v = evaluateExtensionVeto(f, 'short', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_short');
    expect(v.vetoed).toBe(false);
    expect(v.soft_reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
    expect(v.reasons.filter(r => r.includes('extended_from_vwap'))).toHaveLength(0);
  });

  it('trend_pullback_short: short-direction VWAP extension routes to soft_reasons', () => {
    const f = makeFeatures({ dist_from_vwap_pts: -40, dist_from_vwap_atr: 4.0 });
    const v = evaluateExtensionVeto(f, 'short', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_short');
    expect(v.soft_reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
  });

  // ── Long: genuine chase conditions still hard-veto ──────────────────────

  it('trend_pullback_long: no_reset + mature impulse + fast recent move = hard veto', () => {
    const f = makeFeatures({
      no_reset_extension:   true,
      current_impulse_atr:  3.5,   // > max 2.5
      last_3_bar_return_atr: 2.0,  // > max 1.5
      // VWAP extended too — should be soft only, not driving the veto
      dist_from_vwap_pts: 30, dist_from_vwap_atr: 3.0,
    });
    const v = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_long');
    expect(v.vetoed).toBe(true);
    expect(v.reasons.some(r => r.includes('recent_move_too_fast'))).toBe(true);
    expect(v.reasons.some(r => r.includes('no_reset_after_extension'))).toBe(true);
    // VWAP still in soft, not hard
    expect(v.reasons.filter(r => r.includes('extended_from_vwap'))).toHaveLength(0);
    expect(v.soft_reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
  });

  it('trend_pullback_long: mature impulse + no_reset alone = hard veto', () => {
    const f = makeFeatures({
      no_reset_extension:  true,
      current_impulse_atr: 3.0,  // > max 2.5
    });
    const v = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_long');
    expect(v.vetoed).toBe(true);
    expect(v.reasons.some(r => r.includes('impulse_already_mature'))).toBe(true);
    expect(v.reasons.some(r => r.includes('no_reset_after_extension'))).toBe(true);
  });

  it('trend_pullback_long: egregiously large impulse (>2× limit) vetoes even after reset', () => {
    const f = makeFeatures({
      no_reset_extension:  false,  // reset DID occur
      current_impulse_atr: 6.0,   // > 2 × 2.5 = 5.0
    });
    const v = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_long');
    expect(v.vetoed).toBe(true);
    expect(v.reasons.some(r => r.includes('impulse_already_mature'))).toBe(true);
  });

  it('trend_pullback_long: insufficient upside room = hard veto regardless', () => {
    const f = makeFeatures({ upside_room_atr: 0.5 }); // < min 1.0
    const v = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_long');
    expect(v.vetoed).toBe(true);
    expect(v.reasons.some(r => r.includes('insufficient_upside_room'))).toBe(true);
  });

  // ── Short: genuine chase conditions still hard-veto ─────────────────────

  it('trend_pullback_short: no_reset + mature impulse + too many push bars = hard veto', () => {
    const f = makeFeatures({
      no_reset_extension:   true,
      current_impulse_atr:  3.0,  // > max 2.5
      consecutive_push_bars: 9,   // > max 6
      dist_from_vwap_pts: -30, dist_from_vwap_atr: 3.0,
    });
    const v = evaluateExtensionVeto(f, 'short', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_short');
    expect(v.vetoed).toBe(true);
    expect(v.reasons.some(r => r.includes('too_many_push_bars'))).toBe(true);
    expect(v.reasons.some(r => r.includes('no_reset_after_extension'))).toBe(true);
    expect(v.reasons.filter(r => r.includes('extended_from_vwap'))).toHaveLength(0);
    expect(v.soft_reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
  });

  it('trend_pullback_short: insufficient downside room = hard veto regardless', () => {
    const f = makeFeatures({ downside_room_atr: 0.4 }); // < min 1.0
    const v = evaluateExtensionVeto(f, 'short', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_short');
    expect(v.vetoed).toBe(true);
    expect(v.reasons.some(r => r.includes('insufficient_downside_room'))).toBe(true);
  });

  it('trend_pullback_short: no_reset alone (small impulse) is NOT a hard veto', () => {
    // A small impulse with no reset is acceptable for an early-trend pullback
    const f = makeFeatures({
      no_reset_extension:  true,
      current_impulse_atr: 1.5,  // < max 2.5 (not mature)
    });
    const v = evaluateExtensionVeto(f, 'short', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_short');
    expect(v.vetoed).toBe(false);
  });

  // ── Non-trend-pullback setups: VWAP still hard-vetoes ───────────────────

  it('breakdown_retest_short: extended_from_vwap is a standalone hard veto', () => {
    const f = makeFeatures({ dist_from_vwap_pts: -30, dist_from_vwap_atr: 3.0 });
    const v = evaluateExtensionVeto(f, 'short', DEFAULT_EXTENSION_FILTER_CONFIG, 'breakdown_retest_short');
    expect(v.vetoed).toBe(true);
    expect(v.reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
    expect(v.soft_reasons).toHaveLength(0);
  });

  it('breakout_retest_long: extended_from_vwap is a standalone hard veto', () => {
    const f = makeFeatures({ dist_from_vwap_pts: 30, dist_from_vwap_atr: 3.0 });
    const v = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG, 'breakout_retest_long');
    expect(v.vetoed).toBe(true);
    expect(v.reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
    expect(v.soft_reasons).toHaveLength(0);
  });

  it('no setupType argument: defaults to non-trend-pullback (VWAP hard veto)', () => {
    const f = makeFeatures({ dist_from_vwap_pts: 30, dist_from_vwap_atr: 3.0 });
    // Backward-compat: callers that omit the 4th arg get the conservative path
    const v = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG);
    expect(v.vetoed).toBe(true);
    expect(v.reasons.some(r => r.includes('extended_from_vwap'))).toBe(true);
    expect(v.soft_reasons).toHaveLength(0);
  });

  // ── soft_reasons is always present (never undefined) ────────────────────

  it('soft_reasons is an array on every result shape', () => {
    const f = makeFeatures();
    const v1 = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG, 'trend_pullback_long');
    const v2 = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG, 'breakout_retest_long');
    const v3 = evaluateExtensionVeto(f, 'long', DEFAULT_EXTENSION_FILTER_CONFIG);
    const disabled = { ...DEFAULT_EXTENSION_FILTER_CONFIG, enabled: false };
    const v4 = evaluateExtensionVeto(f, 'long', disabled, 'trend_pullback_long');
    expect(Array.isArray(v1.soft_reasons)).toBe(true);
    expect(Array.isArray(v2.soft_reasons)).toBe(true);
    expect(Array.isArray(v3.soft_reasons)).toBe(true);
    expect(Array.isArray(v4.soft_reasons)).toBe(true);
  });
});

describe('Extension Integration', () => {
  const runnerSource = require('fs').readFileSync('src/autotrade/runner.ts', 'utf8');

  it('runner imports extension features', () => {
    expect(runnerSource).toContain("from './features/extension.js'");
  });

  it('runner computes extension features before entry', () => {
    expect(runnerSource).toContain('computeExtensionFeatures');
  });

  it('runner evaluates extension veto', () => {
    expect(runnerSource).toContain('evaluateExtensionVeto');
  });

  it('runner logs candidate signals via dedicated writer', () => {
    expect(runnerSource).toContain('writeCandidateSignal');
  });

  it('extension veto blocks entry execution', () => {
    const vetoIdx = runnerSource.indexOf('extensionVetoed');
    const execIdx = runnerSource.indexOf('!extensionVetoed && !positionManager.hasOpenPosition');
    expect(vetoIdx).toBeGreaterThan(0);
    expect(execIdx).toBeGreaterThan(vetoIdx);
  });
});
