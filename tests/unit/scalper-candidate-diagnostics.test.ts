import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateSignal } from '../../src/autotrade/strategy.js';
import type {
  IndicatorConfig,
  IndicatorSnapshot,
  KeyLevels,
  MarketSnapshot,
} from '../../src/autotrade/types.js';
import type { LobSnapshot } from '../../src/autotrade/lob-client.js';

const BASE_CONFIG: IndicatorConfig = {
  version: 'TEST_SCALPER_DIAG',
  type: 'BASELINE',
  created_at: '2025-01-01T00:00:00Z',
  ema_fast: 9,
  ema_mid: 21,
  ema_slow: 50,
  rsi_period: 14,
  atr_period: 14,
  volume_sma_period: 20,
  min_confidence: 3.0,
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
  enable_opening_drive: false,
  enable_failed_or_break: false,
  dual_min_score: 3.0,
  dual_score_margin: 1.0,
  dual_choppy_extra_margin: 0.5,
  cooldown_bars: 1,
  no_same_bar_reversal: true,
};

function makeSnap(): MarketSnapshot {
  const indicators1m: IndicatorSnapshot = {
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
    smart_money_choch_sell: 20160,
    smart_money_choch_buy: null,
    smart_money_bos_sell: null,
    smart_money_bos_buy: null,
    vwap: 20040,
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

  const keyLevels: KeyLevels = {
    session_high: 20200,
    session_low: 19800,
    daily_open: null,
    weekly_open: null,
    monday_high: null,
    monday_low: null,
    monday_mid: null,
    monthly_open: null,
    pivot_resistance: [20200],
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
    timestamp_unix: 1700001800,
    timestamp_iso: new Date(1700001800 * 1000).toISOString(),
    symbol: 'MNQ1!',
    price: 20050,
    bars_1m: [],
    bars_5m: [
      { time: 1700000000, open: 19981, high: 19985, low: 19980, close: 19983, volume: 100 },
      { time: 1700000300, open: 19986, high: 19990, low: 19985, close: 19988, volume: 100 },
      { time: 1700000600, open: 19989, high: 19993, low: 19988, close: 19991, volume: 100 },
      { time: 1700000900, open: 19991, high: 19995, low: 19990, close: 19993, volume: 100 },
      { time: 1700001200, open: 19994, high: 19998, low: 19993, close: 19996, volume: 100 },
      { time: 1700001500, open: 19997, high: 20001, low: 19996, close: 19999, volume: 100 },
    ] as MarketSnapshot['bars_5m'],
    bars_15m: [],
    bars_1h: [],
    indicators_1m: indicators1m,
    indicators_15m: {} as IndicatorSnapshot,
    indicators_1h: {} as IndicatorSnapshot,
    key_levels: keyLevels,
    data_quality: {
      bars_1m_count: 0,
      bars_5m_count: 6,
      bars_15m_count: 0,
      bars_1h_count: 0,
      vwap_available: true,
      atr_available: true,
      rsi_available: false,
      missing_indicators: [],
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateSignal scalper candidate diagnostics', () => {
  it('surfaces no_lob_snapshot when the scalper family is invoked without a LOB snapshot', () => {
    const result = generateSignal(makeSnap(), BASE_CONFIG);
    const scalperDiagnostics = result.candidate_diagnostics?.filter(
      (diag) => diag.setup_family === 'lob_mbo_scalp',
    ) ?? [];

    expect(scalperDiagnostics).toHaveLength(2);
    expect(scalperDiagnostics.every((diag) => diag.accepted === false)).toBe(true);
    expect(scalperDiagnostics.map((diag) => diag.rejection_reason_primary)).toEqual([
      'no_lob_snapshot',
      'no_lob_snapshot',
    ]);
    expect(result.rejections_by_setup?.['lob_mbo_scalp_long']).toEqual(['no_lob_snapshot']);
    expect(result.top_rejection_reason).toBeTruthy();
  });

  it('surfaces no_scalp_state when a live LOB snapshot lacks the nested scalp_state block', () => {
    const lobSnapshot: LobSnapshot = {
      timestamp_ms: 1700001800000,
      bbo_age_ms: 10,
      data_quality: 'full_depth',
      recording_context: 'session',
      bid: 20050,
      ask: 20050.25,
      mid: 20050.125,
      bid_size: 5,
      ask_size: 4,
      spread_pts: 0.25,
      spread_ticks: 1,
      depth_imbalance_5: 0.2,
      depth_imbalance_10: 0.1,
      total_bid_depth_10lvl: 100,
      total_ask_depth_10lvl: 90,
      large_bid_within_5pts: false,
      large_ask_within_5pts: false,
      cumulative_delta_10s: null,
      cumulative_delta_30s: null,
      cumulative_delta_60s: null,
      trade_flow_imbalance_10s: null,
      trade_flow_imbalance_30s: null,
      cancel_add_ratio_10s: 0.4,
      replenishment_rate_10s: 0.3,
      absorption_rate_10s: 0.2,
      mean_order_lifetime_top_book: 120,
      aggressor_penetration_10s: 1.2,
      sweep_count_10s: 1,
      adv_cancel_replace_ratio_10s: null,
      adv_modify_rate_10s: null,
      adv_iceberg_suspicion_30s: null,
      adv_queue_deterioration_bid_10s: null,
      adv_queue_deterioration_ask_10s: null,
      adv_pull_cascade_count_10s: null,
      adv_lifetime_p50_ms: null,
      absorption_score_10s: null,
      absorption_bid_score_10s: null,
      absorption_ask_score_10s: null,
      strongest_absorption_price: null,
      sweep_volume_10s: null,
      max_sweep_levels_10s: null,
      last_sweep_side: null,
      footprint_delta_30s: null,
      footprint_delta_5s: null,
      footprint_imbalance_ratio_30s: null,
      footprint_stacked_imbalance_count_30s: null,
      dominant_aggressor_side: null,
      large_trade_count_10s: null,
      large_trade_volume_10s: null,
      largest_trade_size_30s: null,
      large_trade_buy_sell_imbalance_30s: null,
      session_vpoc: null,
      session_vah: null,
      session_val: null,
      distance_to_vpoc: null,
      inside_value_area: null,
      trade_id: null,
      signal_id: null,
    };

    const result = generateSignal(makeSnap(), BASE_CONFIG, undefined, undefined, lobSnapshot);
    const scalperDiagnostics = result.candidate_diagnostics?.filter(
      (diag) => diag.setup_family === 'lob_mbo_scalp',
    ) ?? [];

    expect(scalperDiagnostics).toHaveLength(2);
    expect(scalperDiagnostics.map((diag) => diag.rejection_reason_primary)).toEqual([
      'no_scalp_state',
      'no_scalp_state',
    ]);
    expect(result.rejections_by_setup?.['lob_mbo_scalp_short']).toEqual(['no_scalp_state']);
  });
});
