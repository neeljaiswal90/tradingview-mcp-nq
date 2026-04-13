/**
 * Tests for PerformanceTracker normalization of partial / old performance.json files.
 *
 * The crash scenario: performance.json exists but is missing bucket maps
 * (by_setup, by_regime, by_hour, by_config_version, by_management_profile)
 * added in later schema versions. Without normalization, incrementBucket()
 * receives undefined and throws a TypeError.
 */

import { describe, it, expect, vi } from 'vitest';
import { PerformanceTracker } from '../../src/autotrade/performance-tracker.js';
import type { PerformanceStats, TradeRecord } from '../../src/autotrade/types.js';

// ─── Minimal mock LogWriter ─────────────────────────────────────────────────

function mockLogWriter(savedPerf: PerformanceStats | null = null, trades: TradeRecord[] = []) {
  return {
    readPerformance: vi.fn(() => savedPerf),
    readAllTrades: vi.fn(() => trades),
    writePerformance: vi.fn(),
    // Stubs for other methods (not called by PerformanceTracker)
    writeSignal: vi.fn(),
    writeTrade: vi.fn(),
    writeSession: vi.fn(),
    writeIndicatorChange: vi.fn(),
    writeTradePathPoint: vi.fn(),
    writeRejectedSignal: vi.fn(),
    writeManagementEvent: vi.fn(),
    updateSessionEnd: vi.fn(),
    writeClaudeManagementAction: vi.fn(),
  } as any;
}

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    trade_id: 'T001',
    parent_signal_id: 'SIG001',
    session_id: 'TEST',
    strategy_version: 'v1',
    indicator_config_version: 'IC_v1',
    mode: 'paper',
    timestamp_signal: '2024-01-01T10:00:00Z',
    timestamp_entry: '2024-01-01T10:00:00Z',
    timestamp_exit: '2024-01-01T10:05:00Z',
    symbol: 'NQ',
    venue: 'CME',
    side: 'long',
    setup_type: 'trend_pullback_long',
    market_regime: 'trending_up',
    confidence_score: 8,
    entry_price_planned: 20000,
    entry_price_filled: 20000,
    stop_price_initial: 19990,
    stop_price_final: 19995,
    target_1: 20020,
    target_2: 20040,
    target_3: null,
    quantity: 1,
    notional_value: 20000,
    fee_estimate: 2,
    fee_actual: 2,
    slippage_estimate: 0.5,
    slippage_actual: 0.25,
    pnl_realized: 50,
    pnl_percent: 0.25,
    r_multiple: 0.5,
    hold_time_seconds: 300,
    exit_reason: 'stop_loss',
    mfe: 5,
    mae: 3,
    outcome_class: 'winner',
    hit_target_1: false,
    hit_target_2: false,
    stopped_out: true,
    exited_on_time_stop: false,
    regime_at_entry: 'trending_up',
    regime_at_exit: 'trending_up',
    confidence_bucket: 'high',
    trend_alignment: true,
    config_type: 'BASELINE',
    notes: '',
    exit_price_planned: 19995,
    exit_price_actual: 19995,
    exit_slippage_vs_plan_pts: 0,
    max_unrealized_r: 0.5,
    max_drawdown_r: -0.3,
    target_1_direction_valid: true,
    target_2_direction_valid: true,
    target_3_direction_valid: true,
    target_ordering_valid: true,
    target_repair_applied: false,
    management_profile: 'trend_pullback',
    ...overrides,
  } as TradeRecord;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PerformanceTracker — normalization of partial performance.json', () => {

  it('starts cleanly when no saved performance exists', () => {
    const lw = mockLogWriter(null);
    const pt = new PerformanceTracker('TEST', lw, 25000);
    const stats = pt.getStats();
    expect(stats.total_trades).toBe(0);
    expect(stats.by_setup).toEqual({});
    expect(stats.by_regime).toEqual({});
    expect(stats.by_hour).toEqual({});
    expect(stats.by_config_version).toEqual({});
    expect(stats.by_management_profile).toEqual({});
  });

  it('does not crash when by_setup is missing from saved file', () => {
    const partial = {
      session_id: 'OLD',
      total_trades: 5,
      wins: 3,
      losses: 2,
      scratches: 0,
      win_rate: 60,
      total_pnl_usd: 100,
      max_drawdown_pct: 1.5,
      last_updated: '2024-01-01T00:00:00Z',
      // by_setup, by_regime, by_hour, by_config_version, by_management_profile ALL MISSING
    } as unknown as PerformanceStats;

    const lw = mockLogWriter(partial);
    const pt = new PerformanceTracker('TEST', lw, 25000);
    const stats = pt.getStats();

    // Headline values preserved from saved file
    expect(stats.total_trades).toBe(5);
    expect(stats.wins).toBe(3);
    expect(stats.total_pnl_usd).toBe(100);

    // Missing buckets backfilled
    expect(stats.by_setup).toEqual({});
    expect(stats.by_regime).toEqual({});
    expect(stats.by_hour).toEqual({});
    expect(stats.by_config_version).toEqual({});
    expect(stats.by_management_profile).toEqual({});
  });

  it('does not crash when only by_management_profile is missing (pre-profile schema)', () => {
    const partial = {
      session_id: 'OLD',
      total_trades: 2,
      wins: 1,
      losses: 1,
      scratches: 0,
      win_rate: 50,
      total_pnl_usd: -10,
      max_drawdown_pct: 0.5,
      last_updated: '2024-01-01T00:00:00Z',
      by_setup: { trend_pullback_long: { trades: 2, wins: 1, total_r: 0.2 } },
      by_regime: { trending_up: { trades: 2, wins: 1, total_r: 0.2 } },
      by_hour: { '10:00': { trades: 2, wins: 1, total_r: 0.2 } },
      by_config_version: { 'IC_v1': { trades: 2, wins: 1, total_r: 0.2 } },
      // by_management_profile MISSING
    } as unknown as PerformanceStats;

    const lw = mockLogWriter(partial);
    const pt = new PerformanceTracker('TEST', lw, 25000);
    const stats = pt.getStats();

    // Existing buckets preserved
    expect(stats.by_setup).toHaveProperty('trend_pullback_long');
    expect(stats.by_regime).toHaveProperty('trending_up');

    // Missing bucket backfilled
    expect(stats.by_management_profile).toEqual({});
  });

  it('records a trade successfully after normalizing a partial saved file', () => {
    const partial = {
      session_id: 'OLD',
      total_trades: 0,
      wins: 0,
      losses: 0,
      scratches: 0,
      win_rate: null,
      total_pnl_usd: 0,
      max_drawdown_pct: 0,
      last_updated: '2024-01-01T00:00:00Z',
      // ALL bucket maps missing
    } as unknown as PerformanceStats;

    const lw = mockLogWriter(partial);
    const pt = new PerformanceTracker('TEST', lw, 25000);

    // This was the crash: incrementBucket on undefined map
    const trade = makeTrade();
    pt.recordTrade(trade);

    const stats = pt.getStats();
    expect(stats.total_trades).toBe(1);
    expect(stats.wins).toBe(1);
    expect(stats.by_setup['trend_pullback_long']).toBeDefined();
    expect(stats.by_setup['trend_pullback_long']!.trades).toBe(1);
    expect(stats.by_regime['trending_up']).toBeDefined();
    expect(stats.by_management_profile['trend_pullback']).toBeDefined();
  });

  it('records multiple trades without crash when buckets were initially missing', () => {
    const partial = {
      session_id: 'OLD',
      total_trades: 3,
      wins: 2,
      losses: 1,
      scratches: 0,
      total_pnl_usd: 25,
      max_drawdown_pct: 0.2,
      last_updated: '2024-01-01T00:00:00Z',
    } as unknown as PerformanceStats;

    const lw = mockLogWriter(partial);
    const pt = new PerformanceTracker('TEST', lw, 25000);

    pt.recordTrade(makeTrade({ trade_id: 'T1', management_profile: 'trend_pullback' }));
    pt.recordTrade(makeTrade({ trade_id: 'T2', management_profile: 'breakout_retest', setup_type: 'breakout_retest_long' }));
    pt.recordTrade(makeTrade({ trade_id: 'T3', outcome_class: 'loser', pnl_realized: -30, r_multiple: -1.0 }));

    const stats = pt.getStats();
    expect(stats.total_trades).toBe(6); // 3 saved + 3 new
    expect(Object.keys(stats.by_setup).length).toBe(2);
    expect(Object.keys(stats.by_management_profile).length).toBe(2);
  });

  it('preserves existing bucket data from a complete saved file', () => {
    const complete: PerformanceStats = {
      session_id: 'FULL',
      total_trades: 10,
      wins: 6,
      losses: 3,
      scratches: 1,
      win_rate: 60,
      avg_r: 0.15,
      expectancy: 0.1,
      avg_winner_r: 0.5,
      avg_loser_r: -0.8,
      profit_factor: 1.2,
      max_drawdown_pct: 2.0,
      total_pnl_usd: 200,
      by_setup: { trend_pullback_long: { trades: 10, wins: 6, total_r: 1.5 } },
      by_regime: { trending_up: { trades: 10, wins: 6, total_r: 1.5 } },
      by_hour: { '10:00': { trades: 10, wins: 6, total_r: 1.5 } },
      by_config_version: { IC_v1: { trades: 10, wins: 6, total_r: 1.5 } },
      by_management_profile: { trend_pullback: { trades: 10, wins: 6, total_r: 1.5 } },
      last_updated: '2024-01-01T00:00:00Z',
    };

    const lw = mockLogWriter(complete);
    const pt = new PerformanceTracker('TEST', lw, 25000);
    const stats = pt.getStats();

    expect(stats.total_trades).toBe(10);
    expect(stats.by_setup['trend_pullback_long']!.trades).toBe(10);
    expect(stats.by_management_profile['trend_pullback']!.trades).toBe(10);
  });

  it('logs migration warning when fields are missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const partial = {
      session_id: 'OLD',
      total_trades: 1,
      wins: 1,
      losses: 0,
      scratches: 0,
      total_pnl_usd: 10,
      max_drawdown_pct: 0,
      last_updated: '2024-01-01T00:00:00Z',
    } as unknown as PerformanceStats;

    const lw = mockLogWriter(partial);
    new PerformanceTracker('TEST', lw, 25000);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('performance.json missing fields'),
    );

    warnSpy.mockRestore();
  });

  it('does not log migration warning when all fields are present', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const complete: PerformanceStats = {
      session_id: 'FULL',
      total_trades: 0,
      wins: 0,
      losses: 0,
      scratches: 0,
      win_rate: null,
      avg_r: null,
      expectancy: null,
      avg_winner_r: null,
      avg_loser_r: null,
      profit_factor: null,
      max_drawdown_pct: 0,
      total_pnl_usd: 0,
      by_setup: {},
      by_regime: {},
      by_hour: {},
      by_config_version: {},
      by_management_profile: {},
      last_updated: '2024-01-01T00:00:00Z',
    };

    const lw = mockLogWriter(complete);
    new PerformanceTracker('TEST', lw, 25000);

    // Should not warn about missing fields (may still warn about pnl divergence)
    const fieldWarnings = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('missing fields')
    );
    expect(fieldWarnings.length).toBe(0);

    warnSpy.mockRestore();
  });

  // ── Persist-on-backfill behavior ──────────────────────────────────────

  it('persists backfilled stats to disk immediately when fields were missing', () => {
    const partial = {
      session_id: 'OLD',
      total_trades: 5,
      wins: 3,
      losses: 2,
      scratches: 0,
      total_pnl_usd: 100,
      max_drawdown_pct: 1.5,
      last_updated: '2024-01-01T00:00:00Z',
      by_setup: {},
      by_regime: {},
      by_hour: {},
      by_config_version: {},
      // by_management_profile MISSING — triggers backfill
    } as unknown as PerformanceStats;

    const lw = mockLogWriter(partial);
    new PerformanceTracker('TEST', lw, 25000);

    // writePerformance called twice: once for normalization fix, once for startup stamp
    expect(lw.writePerformance).toHaveBeenCalledTimes(2);
    const written = lw.writePerformance.mock.calls[0][0];
    expect(written.by_management_profile).toEqual({});
    expect(written.total_trades).toBe(5); // headline preserved
  });

  it('writes performance.json once on startup to stamp session_id when all fields present', () => {
    const complete: PerformanceStats = {
      session_id: 'FULL',
      total_trades: 10,
      wins: 6,
      losses: 3,
      scratches: 1,
      win_rate: 60,
      avg_r: 0.15,
      expectancy: 0.1,
      avg_winner_r: 0.5,
      avg_loser_r: -0.8,
      profit_factor: 1.2,
      max_drawdown_pct: 2.0,
      total_pnl_usd: 200,
      by_setup: {},
      by_regime: {},
      by_hour: {},
      by_config_version: {},
      by_management_profile: {},
      last_updated: '2024-01-01T00:00:00Z',
    };

    const lw = mockLogWriter(complete);
    new PerformanceTracker('TEST', lw, 25000);

    // writePerformance is called once at startup to stamp the current session_id
    // (no normalization needed since all fields present)
    expect(lw.writePerformance).toHaveBeenCalledTimes(1);
  });

  it('writes performance.json on fresh start (no file on disk)', () => {
    const lw = mockLogWriter(null);
    new PerformanceTracker('TEST', lw, 25000);

    // Always writes at startup to stamp session_id
    expect(lw.writePerformance).toHaveBeenCalledTimes(1);
  });

  // ── Session identity freshness (P3 regression) ──────────────────────

  it('stamps current session_id over stale saved session_id', () => {
    const staleFile = {
      session_id: 'OLD_SESSION_2024',
      total_trades: 5,
      wins: 3,
      losses: 2,
      scratches: 0,
      win_rate: 60,
      total_pnl_usd: 100,
      max_drawdown_pct: 1.5,
      by_setup: {},
      by_regime: {},
      by_hour: {},
      by_config_version: {},
      by_management_profile: {},
      last_updated: '2024-01-01T00:00:00Z',
    } as unknown as PerformanceStats;

    const lw = mockLogWriter(staleFile);
    const pt = new PerformanceTracker('NEW_SESSION_2026', lw, 25000);
    const stats = pt.getStats();

    // Current session_id must overwrite the stale one
    expect(stats.session_id).toBe('NEW_SESSION_2026');
    // Cumulative metrics must be preserved
    expect(stats.total_trades).toBe(5);
    expect(stats.total_pnl_usd).toBe(100);
  });

  // ── Reset script schema parity ────────────────────────────────────────

  it('reset script schema has all keys expected by PerformanceStats', async () => {
    const { EMPTY_PERFORMANCE } = await import('../../scripts/reset-performance.mjs');
    const expectedKeys = [
      'session_id', 'total_trades', 'wins', 'losses', 'scratches',
      'win_rate', 'avg_r', 'expectancy', 'avg_winner_r', 'avg_loser_r',
      'profit_factor', 'max_drawdown_pct', 'total_pnl_usd',
      'by_setup', 'by_regime', 'by_hour', 'by_config_version',
      'by_management_profile', 'last_updated',
    ];
    for (const key of expectedKeys) {
      expect(EMPTY_PERFORMANCE).toHaveProperty(key);
    }
  });
});
