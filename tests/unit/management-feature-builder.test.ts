import { describe, it, expect } from 'vitest';
import { buildManagementFeatures } from '../../src/autotrade/management/feature-builder.js';
import type { Position } from '../../src/autotrade/types.js';
import type { IndicatorSnapshot } from '../../src/autotrade/types.js';

const NOW_ISO = new Date().toISOString();
const NOW_UNIX = Date.now();

function makePos(overrides: Partial<Position> = {}): Position {
  return {
    trade_id: 'T1',
    signal_id: 'S1',
    session_id: 'SESS',
    side: 'long',
    entry_price: 20_000,
    entry_time_unix: NOW_UNIX - 120_000, // 2 minutes ago
    entry_time_iso: NOW_ISO,
    stop_initial: 19_990,
    stop_current: 19_990,
    target_1: 20_010,
    target_2: 20_020,
    target_3: null,
    quantity: 2,
    quantity_remaining: 2,
    notional: 80_000,
    setup_type: 'trend_pullback_long',
    market_regime_at_entry: 'trending_up',
    config_version: 'TEST',
    confidence: 8,
    stop_moved_to_be: false,
    pre_t1_be_triggered: false,
    pre_t1_trailing_active: false,
    trailing_active: false,
    trail_distance_ticks: 0,
    trail_anchor_price: null,
    partial_exit_done: false,
    pt1_done: false,
    pt2_done: false,
    pt1_realized_pnl: 0,
    pt2_realized_pnl: 0,
    pt1_qty_exited: 0,
    pt2_qty_exited: 0,
    max_favorable_excursion: 0,
    max_adverse_excursion: 0,
    last_checked_price: 20_000,
    time_stop_minutes: 30,
    target_1_direction_valid: true,
    target_2_direction_valid: true,
    target_3_direction_valid: true,
    target_ordering_valid: true,
    target_repair_applied: false,
    exit_legs: [],
    realized_pnl_so_far: 0,
    realized_fees_so_far: 0,
    ...overrides,
  };
}

function makeSnap(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    ema_9: 20_005, ema_21: 20_000, ema_50: 19_985,
    ema_100: null, ema_200: null,
    supertrend_direction: 'up', supertrend_level: 19_980,
    novawave_fast: null, novawave_slow: null, novawave_signal: null,
    dma_20: null, dma_50: null, dma_200: null,
    smart_money_choch_sell: null, smart_money_choch_buy: null,
    smart_money_bos_sell: null, smart_money_bos_buy: null,
    vwap: 19_998,
    atr_14: 8,
    rsi_14: 55,
    volume: 1_200, volume_sma_20: 1_000,
    adx: 28, di_plus: 30, di_minus: 18,
    ttm_squeeze_momentum: null, ttm_squeeze_firing: false,
    cvd: null, cvd_delta: null, cvd_trend: 'up',
    ...overrides,
  };
}

describe('buildManagementFeatures', () => {
  it('computes correct R metrics for a long position in profit', () => {
    const pos = makePos();
    const f = buildManagementFeatures(pos, 20_005, makeSnap(), 'trending_up', 'NY_AM');

    // unrealized = 5pts, risk = 10pts → R = 0.5
    expect(f.current_r).toBeCloseTo(0.5, 3);
    expect(f.unrealized_pnl_pts).toBeCloseTo(5, 3);
    expect(f.side).toBe('long');
    expect(f.setup_type).toBe('trend_pullback_long');
  });

  it('computes correct R metrics for a short position', () => {
    const pos = makePos({
      side: 'short',
      entry_price: 20_000,
      stop_initial: 20_010,
      stop_current: 20_010,
      target_1: 19_990,
      target_2: 19_980,
    });
    const f = buildManagementFeatures(pos, 19_995, makeSnap(), 'trending_down', 'NY_AM');

    // short: unrealized = entry - price = 20000 - 19995 = 5pts, risk = 10pts → R = 0.5
    expect(f.unrealized_pnl_pts).toBeCloseTo(5, 3);
    expect(f.current_r).toBeCloseTo(0.5, 3);
  });

  it('computes distance to levels correctly (long)', () => {
    const pos = makePos();
    // current price = 20005, stop = 19990, T1 = 20010, T2 = 20020
    const f = buildManagementFeatures(pos, 20_005, makeSnap(), 'trending_up', 'NY_AM');

    expect(f.distance_to_stop_pts).toBeCloseTo(15, 3); // 20005 - 19990
    expect(f.distance_to_t1_pts).toBeCloseTo(5, 3);    // 20010 - 20005
    expect(f.distance_to_t2_pts).toBeCloseTo(15, 3);   // 20020 - 20005
  });

  it('normalizes distances by ATR', () => {
    const pos = makePos();
    const snap = makeSnap({ atr_14: 10 });
    const f = buildManagementFeatures(pos, 20_005, snap, 'trending_up', 'NY_AM');

    // stop distance = 15pts / 10atr = 1.5
    expect(f.distance_to_stop_atr).toBeCloseTo(1.5, 3);
    expect(f.distance_to_t1_atr).toBeCloseTo(0.5, 3);
  });

  it('returns null ATR distances when ATR is unavailable', () => {
    const f = buildManagementFeatures(makePos(), 20_005, makeSnap({ atr_14: null }), 'trending_up', 'NY_AM');
    expect(f.distance_to_stop_atr).toBeNull();
    expect(f.distance_to_t1_atr).toBeNull();
  });

  it('computes VWAP distance as positive when above VWAP for long', () => {
    const snap = makeSnap({ vwap: 19_995 });
    const f = buildManagementFeatures(makePos(), 20_000, snap, 'trending_up', 'NY_AM');
    // 20000 - 19995 = +5 (favorable for long)
    expect(f.vwap_distance_pts).toBeCloseTo(5, 3);
  });

  it('computes VWAP distance as positive when below VWAP for short', () => {
    const pos = makePos({ side: 'short', entry_price: 20_000, stop_initial: 20_010, stop_current: 20_010, target_1: 19_990, target_2: 19_980 });
    const snap = makeSnap({ vwap: 20_005 });
    const f = buildManagementFeatures(pos, 20_000, snap, 'trending_down', 'NY_AM');
    // short: vwap - price = 20005 - 20000 = +5 (favorable: vwap is above price)
    expect(f.vwap_distance_pts).toBeCloseTo(5, 3);
  });

  it('detects bullish EMA alignment (9 > 21 > 50)', () => {
    const snap = makeSnap({ ema_9: 20_010, ema_21: 20_005, ema_50: 19_995 });
    const f = buildManagementFeatures(makePos(), 20_005, snap, 'trending_up', 'NY_AM');
    expect(f.ema_alignment).toBe('bullish');
  });

  it('detects bearish EMA alignment (9 < 21 < 50)', () => {
    const snap = makeSnap({ ema_9: 19_995, ema_21: 20_000, ema_50: 20_010 });
    const f = buildManagementFeatures(makePos(), 20_000, snap, 'trending_down', 'NY_AM');
    expect(f.ema_alignment).toBe('bearish');
  });

  it('detects mixed EMA alignment', () => {
    const snap = makeSnap({ ema_9: 20_005, ema_21: 20_010, ema_50: 20_003 });
    const f = buildManagementFeatures(makePos(), 20_005, snap, 'range_bound', null);
    expect(f.ema_alignment).toBe('mixed');
  });

  it('computes volume ratio', () => {
    const snap = makeSnap({ volume: 1_500, volume_sma_20: 1_000 });
    const f = buildManagementFeatures(makePos(), 20_000, snap, null, null);
    expect(f.volume_ratio).toBeCloseTo(1.5, 3);
  });

  it('returns null volume ratio when volume_sma is zero', () => {
    const snap = makeSnap({ volume: 1_000, volume_sma_20: 0 });
    const f = buildManagementFeatures(makePos(), 20_000, snap, null, null);
    expect(f.volume_ratio).toBeNull();
  });

  it('handles null snapshot gracefully — all context fields are null', () => {
    const f = buildManagementFeatures(makePos(), 20_000, null, null, null);
    expect(f.atr_14).toBeNull();
    expect(f.adx).toBeNull();
    expect(f.vwap_distance_pts).toBeNull();
    expect(f.ema_alignment).toBeNull();
    expect(f.cvd_trend).toBeNull();
    // Core position fields still present
    expect(f.current_r).toBeDefined();
    expect(f.distance_to_stop_pts).toBeGreaterThanOrEqual(0);
  });

  it('computes hold_seconds from entry_time_unix', () => {
    const twoMinsAgo = Date.now() - 120_000;
    const pos = makePos({ entry_time_unix: twoMinsAgo });
    const f = buildManagementFeatures(pos, 20_000, null, null, null);
    expect(f.hold_seconds).toBeGreaterThanOrEqual(115);
    expect(f.hold_seconds).toBeLessThanOrEqual(125);
  });

  it('computes time_stop_remaining_seconds correctly', () => {
    // 30min stop, 2 min elapsed → ~28min remaining
    const twoMinsAgo = Date.now() - 120_000;
    const pos = makePos({ entry_time_unix: twoMinsAgo, time_stop_minutes: 30 });
    const f = buildManagementFeatures(pos, 20_000, null, null, null);
    expect(f.time_stop_remaining_seconds).toBeGreaterThanOrEqual(1_675);
    expect(f.time_stop_remaining_seconds).toBeLessThanOrEqual(1_685);
  });

  it('clamps time_stop_remaining to 0 when time is past', () => {
    const fortyMinsAgo = Date.now() - 40 * 60 * 1_000;
    const pos = makePos({ entry_time_unix: fortyMinsAgo, time_stop_minutes: 30 });
    const f = buildManagementFeatures(pos, 20_000, null, null, null);
    expect(f.time_stop_remaining_seconds).toBe(0);
  });

  it('MFE and MAE correctly converted to R', () => {
    const pos = makePos({
      max_favorable_excursion: 8,   // 8pts / 10pts risk = 0.8R
      max_adverse_excursion: 3,     // 3pts / 10pts risk = 0.3R
    });
    const f = buildManagementFeatures(pos, 20_000, null, null, null);
    expect(f.mfe_r).toBeCloseTo(0.8, 3);
    expect(f.mae_r).toBeCloseTo(0.3, 3);
  });
});
