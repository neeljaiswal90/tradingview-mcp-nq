import { describe, it, expect, beforeEach } from 'vitest';
import { DashboardStateManager } from '../../src/autotrade/dashboard/state-manager.js';
import type { TradeRecord, MarketRegime, DualDirectionResult, PerformanceStats, MarketSnapshot } from '../../src/autotrade/types.js';
import type { ContractSpec } from '../../src/autotrade/contracts.js';
import type { DASHBOARD_VERSION } from '../../src/autotrade/dashboard/types.js';

const mockContract: ContractSpec = {
  root: 'NQ',
  app_symbol: 'NQ',
  tv_symbol: 'NQ1!',
  display: 'E-mini NASDAQ 100',
  venue: 'CME',
  tick_size: 0.25,
  tick_value: 5,
  point_value: 20,
  price_decimals: 2,
  margin_day: 1000,
  margin_overnight: 18000,
};

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    trade_id: 'T001',
    parent_signal_id: 'SIG001',
    session_id: 'SESSION_1',
    strategy_version: 'v1',
    indicator_config_version: 'v1',
    mode: 'paper',
    timestamp_signal: '2024-01-01T10:00:00Z',
    timestamp_entry: '2024-01-01T10:00:00Z',
    timestamp_exit: '2024-01-01T10:30:00Z',
    symbol: 'NQ',
    venue: 'CME',
    side: 'long',
    setup_type: 'trend_pullback_long',
    market_regime: 'trending_up',
    confidence_score: 7.5,
    entry_price_planned: 17000,
    entry_price_filled: 17000,
    stop_price_initial: 16990,
    stop_price_final: 17000,
    target_1: 17020,
    target_2: 17040,
    target_3: null,
    quantity: 1,
    notional_value: 340000,
    fee_estimate: 4.5,
    fee_actual: 4.5,
    slippage_estimate: 0.25,
    slippage_actual: 0.25,
    pnl_realized: 150,
    pnl_percent: 0.04,
    r_multiple: 1.5,
    hold_time_seconds: 1800,
    exit_reason: 'target_1',
    exit_reason_detailed: 'target_1',
    mfe: 25,
    mae: 5,
    outcome_class: 'winner',
    hit_target_1: true,
    hit_target_2: false,
    stopped_out: false,
    exited_on_time_stop: false,
    regime_at_entry: 'trending_up',
    regime_at_exit: 'trending_up',
    confidence_bucket: 'medium',
    trend_alignment: true,
    config_type: 'BASELINE',
    notes: '',
    exit_price_planned: 17020,
    exit_price_actual: 17020,
    exit_slippage_vs_plan_pts: 0,
    max_unrealized_r: 2.5,
    max_drawdown_r: -0.5,
    target_1_direction_valid: true,
    target_2_direction_valid: true,
    target_3_direction_valid: true,
    target_ordering_valid: true,
    target_repair_applied: false,
    ...overrides,
  } as TradeRecord;
}

describe('DashboardStateManager', () => {
  let manager: DashboardStateManager;

  beforeEach(() => {
    manager = new DashboardStateManager();
    manager.setAppMeta(
      { symbol: 'NQ', mode: 'paper', session_id: 'TEST_SESSION' },
      mockContract,
      25000,
    );
  });

  it('returns a valid snapshot with version', () => {
    const snap = manager.getSnapshot();
    expect(snap.version).toBe('dashboard_v1.6');
    expect(snap.app.symbol).toBe('NQ');
    expect(snap.app.mode).toBe('paper');
  });

  it('returns empty active trade when no position', () => {
    const snap = manager.getSnapshot();
    expect(snap.active_trade.is_open).toBe(false);
    expect(snap.active_trade.trade_id).toBeNull();
    expect(snap.active_trade.side).toBeNull();
  });

  it('returns active trade when position is open', () => {
    manager.updatePosition({
      trade_id: 'T001',
      signal_id: 'SIG001',
      session_id: 'TEST',
      side: 'long',
      entry_price: 17000,
      entry_time_unix: Date.now() - 60000,
      entry_time_iso: new Date().toISOString(),
      stop_initial: 16990,
      stop_current: 17000,
      target_1: 17020,
      target_2: 17040,
      target_3: null,
      quantity: 1,
      notional: 340000,
      setup_type: 'trend_pullback_long',
      market_regime_at_entry: 'trending_up',
      config_version: 'v1',
      confidence: 7.5,
      stop_moved_to_be: true,
      partial_exit_done: false,
      quantity_remaining: 1,
      max_favorable_excursion: 15,
      max_adverse_excursion: 3,
      last_checked_price: 17010,
      time_stop_minutes: 30,
      trailing_active: false,
      trail_distance_ticks: 0,
      trail_anchor_price: null,
      target_1_direction_valid: true,
      target_2_direction_valid: true,
      target_3_direction_valid: true,
      target_ordering_valid: true,
      target_repair_applied: false,
    });
    manager.updateCurrentPrice(17010);

    const snap = manager.getSnapshot();
    expect(snap.active_trade.is_open).toBe(true);
    expect(snap.active_trade.side).toBe('long');
    expect(snap.active_trade.entry_price).toBe(17000);
    expect(snap.active_trade.stop_loss).toBe(17000);
    expect(snap.active_trade.target_1).toBe(17020);
    expect(snap.active_trade.breakeven_armed).toBe(true);
  });

  it('correctly clears active trade on position close', () => {
    manager.updatePosition({
      trade_id: 'T001',
      signal_id: 'SIG001',
      session_id: 'TEST',
      side: 'short',
      entry_price: 17000,
      entry_time_unix: Date.now(),
      entry_time_iso: new Date().toISOString(),
      stop_initial: 17010,
      stop_current: 17010,
      target_1: 16980,
      target_2: 16960,
      target_3: null,
      quantity: 1,
      notional: 340000,
      setup_type: 'trend_pullback_short',
      market_regime_at_entry: 'trending_down',
      config_version: 'v1',
      confidence: 8.0,
      stop_moved_to_be: false,
      partial_exit_done: false,
      quantity_remaining: 1,
      max_favorable_excursion: 0,
      max_adverse_excursion: 0,
      last_checked_price: 17000,
      time_stop_minutes: 30,
      trailing_active: false,
      trail_distance_ticks: 0,
      trail_anchor_price: null,
      target_1_direction_valid: true,
      target_2_direction_valid: true,
      target_3_direction_valid: true,
      target_ordering_valid: true,
      target_repair_applied: false,
    });

    expect(manager.getSnapshot().active_trade.is_open).toBe(true);

    manager.updatePosition(null);
    expect(manager.getSnapshot().active_trade.is_open).toBe(false);
  });

  it('tracks recent trades and PnL history', () => {
    const trade1 = makeTrade({ trade_id: 'T1', pnl_realized: 100 });
    const trade2 = makeTrade({ trade_id: 'T2', pnl_realized: -50, outcome_class: 'loser' });

    manager.recordTrade(trade1);
    manager.recordTrade(trade2);

    const snap = manager.getSnapshot();
    expect(snap.recent_trades).toHaveLength(2);
    expect(snap.recent_trades[0]!.trade_id).toBe('T2'); // Most recent first
    expect(snap.recent_trades[1]!.trade_id).toBe('T1');

    expect(snap.pnl_history).toHaveLength(2);
    expect(snap.pnl_history[0]!.cumulative_pnl).toBe(100);
    expect(snap.pnl_history[1]!.cumulative_pnl).toBe(50); // 100 - 50
  });

  it('updates KPIs from performance stats', () => {
    const stats: PerformanceStats = {
      session_id: 'TEST',
      total_trades: 5,
      wins: 3,
      losses: 2,
      scratches: 0,
      win_rate: 60,
      avg_r: 0.8,
      expectancy: 0.5,
      avg_winner_r: 1.5,
      avg_loser_r: -0.7,
      profit_factor: 2.1,
      max_drawdown_pct: 1.2,
      total_pnl_usd: 350,
      by_setup: {},
      by_regime: {},
      by_hour: {},
      by_config_version: {},
      last_updated: new Date().toISOString(),
    };
    manager.updatePerformance(stats);

    const snap = manager.getSnapshot();
    expect(snap.kpis.trades_today).toBe(5);
    expect(snap.kpis.win_rate_pct).toBe(60);
    expect(snap.kpis.avg_r).toBe(0.8);
    expect(snap.kpis.realized_pnl_usd).toBe(350);
  });

  it('emits update events on state changes', () => {
    let updateCount = 0;
    manager.on('update', () => { updateCount++; });

    manager.updatePosition(null);
    manager.updateRegime('trending_up');  // Does not emit individually
    manager.setConnectionStatus('connected');

    // updatePosition and setConnectionStatus both emit
    expect(updateCount).toBe(2);
  });

  it('flush() emits update so batched setters reach the frontend', () => {
    let updateCount = 0;
    manager.on('update', () => { updateCount++; });

    // These setters do not emit individually
    manager.updateRegime('trending_up');
    manager.updatePerformance({
      session_id: 'TEST', total_trades: 1, wins: 1, losses: 0, scratches: 0,
      win_rate: 100, avg_r: 1.5, expectancy: 1.5, avg_winner_r: 1.5, avg_loser_r: 0,
      profit_factor: Infinity, max_drawdown_pct: 0, total_pnl_usd: 100,
      by_setup: {}, by_regime: {}, by_hour: {}, by_config_version: {},
      last_updated: new Date().toISOString(),
    });
    manager.incrementCycle();

    expect(updateCount).toBe(0); // Nothing emitted yet

    manager.flush();
    expect(updateCount).toBe(1); // Single batched emission
  });

  it('handles empty directional assessment with null confidence', () => {
    const snap = manager.getSnapshot();
    expect(snap.directional.best_long).toBeNull();
    expect(snap.directional.best_short).toBeNull();
    expect(snap.directional.engine_decision).toBeNull();
    expect(snap.directional.confidence).toBeNull();
  });

  it('propagates confidence from DualDirectionResult to dashboard snapshot', () => {
    const mockSignal = {
      regime: 'trending_up' as const,
      bias: { '1h': 'bullish', '15m': 'bullish', '5m': 'bullish', '1m': 'bullish', alignment_score: 4 },
      bestLong: null,
      bestShort: null,
      chosen: null,
      confidence: 7.2,
      tradeAllowed: true,
      skipReasons: [],
      decision: 'wait_no_candidates' as const,
      decisionReason: 'No setup',
      bestSetup: null,
    } as unknown as DualDirectionResult;

    manager.updateDirectionalSignal(mockSignal);
    const snap = manager.getSnapshot();
    expect(snap.directional.confidence).toBe(7.2);
  });

  it('confidence is null when no signal has been set', () => {
    const snap = manager.getSnapshot();
    expect(snap.directional.confidence).toBeNull();
  });

  it('confidence is null when signal has undefined confidence', () => {
    const mockSignal = {
      regime: 'range_bound' as const,
      bias: { '1h': 'neutral', '15m': 'neutral', '5m': 'neutral', '1m': 'neutral', alignment_score: 0 },
      bestLong: null,
      bestShort: null,
      chosen: null,
      confidence: undefined,
      tradeAllowed: false,
      skipReasons: ['risk_locked'],
      decision: 'wait_risk_locked' as const,
      decisionReason: 'Risk locked',
      bestSetup: null,
    } as unknown as DualDirectionResult;

    manager.updateDirectionalSignal(mockSignal);
    const snap = manager.getSnapshot();
    expect(snap.directional.confidence).toBeNull();
  });

  it('updateMarketSnapshot does not emit update (flush-only pattern)', () => {
    let updateCount = 0;
    manager.on('update', () => { updateCount++; });

    // Simulate a market snapshot — should NOT emit by itself
    const mockSnap = { price: 17500 } as unknown as MarketSnapshot;
    manager.updateMarketSnapshot(mockSnap);
    expect(updateCount).toBe(0);

    // flush should emit
    manager.flush();
    expect(updateCount).toBe(1);
  });

  it('handles loading trades from disk', () => {
    const trades = [
      makeTrade({ trade_id: 'T1', pnl_realized: 100 }),
      makeTrade({ trade_id: 'T2', pnl_realized: -30 }),
      makeTrade({ trade_id: 'T3', pnl_realized: 200 }),
    ];
    manager.loadTradesFromDisk(trades);

    const snap = manager.getSnapshot();
    expect(snap.recent_trades).toHaveLength(3);
    expect(snap.pnl_history).toHaveLength(3);
    expect(snap.pnl_history[2]!.cumulative_pnl).toBe(270); // 100 - 30 + 200
  });

  it('caps recent trades at 50', () => {
    for (let i = 0; i < 60; i++) {
      manager.recordTrade(makeTrade({ trade_id: `T${i}`, pnl_realized: 10 }));
    }
    // Internal storage is capped at 50, recent_trades display shows last 20
    const snap = manager.getSnapshot();
    expect(snap.recent_trades.length).toBeLessThanOrEqual(20);
  });

  it('builds market state from snapshot and signal', () => {
    manager.updateRegime('trending_up');
    manager.updateCurrentPrice(17500);

    const snap = manager.getSnapshot();
    expect(snap.market_state.regime).toBe('trending_up');
  });

  it('normalizes exit to null when exit_price_actual is missing from old trade records', () => {
    // Simulate an old trade record that predates the exit_price_actual field.
    // When loaded from disk via JSON.parse, missing keys become `undefined`.
    const oldTrade = makeTrade({ trade_id: 'OLD_1', pnl_realized: -80 });
    // Delete the field to simulate a record that never had it
    delete (oldTrade as Record<string, unknown>)['exit_price_actual'];
    delete (oldTrade as Record<string, unknown>)['exit_price_planned'];

    manager.recordTrade(oldTrade);
    const snap = manager.getSnapshot();
    const recent = snap.recent_trades[0]!;

    // The backend should have normalized undefined → null
    expect(recent.exit).toBeNull();
    // Other fields that always exist should still be present
    expect(recent.entry).toBe(17000);
    expect(recent.pnl_usd).toBe(-80);
  });

  it('handles loadTradesFromDisk with old records missing exit_price_actual', () => {
    const oldTrade = makeTrade({ trade_id: 'OLD_DISK_1', pnl_realized: -50 });
    delete (oldTrade as Record<string, unknown>)['exit_price_actual'];

    const normalTrade = makeTrade({ trade_id: 'NEW_1', pnl_realized: 100 });

    manager.loadTradesFromDisk([oldTrade, normalTrade]);
    const snap = manager.getSnapshot();

    // Both trades should be in the snapshot without errors
    expect(snap.recent_trades).toHaveLength(2);
    // Old trade has null exit
    const old = snap.recent_trades.find(t => t.trade_id === 'OLD_DISK_1')!;
    expect(old.exit).toBeNull();
    // New trade has valid exit
    const normal = snap.recent_trades.find(t => t.trade_id === 'NEW_1')!;
    expect(normal.exit).toBe(17020);
  });
});
