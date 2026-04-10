import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../dashboard/src/test-render';
import { StatusBar } from '../../dashboard/src/components/StatusBar';
import { ManagementPanel } from '../../dashboard/src/components/ManagementPanel';
import { ActiveTrade } from '../../dashboard/src/components/ActiveTrade';
import type { ActiveTrade as ActiveTradeType, AppMeta, FreshnessMetadata, Management } from '../../dashboard/src/types';

const baseFreshness: FreshnessMetadata = {
  snapshot_built_at: '2026-04-08T15:45:05.000Z',
  snapshot_version: 7,
  data_gathered_at: '2026-04-08T15:45:04.000Z',
  data_gather_duration_ms: 280,
  confidence_updated_at: '2026-04-08T15:45:04.500Z',
  analysis_interval_target_ms: 5000,
  last_analysis_duration_ms: 320,
  htf_cache_hits: ['1h'],
};

describe('dashboard components', () => {
  it('renders engine phase and quote freshness in the status bar', () => {
    const app: AppMeta = {
      symbol: 'NQ',
      mode: 'paper',
      session_id: 'SESSION_1',
      session_bucket: 'midday',
      exchange_state: 'RTH',
      strategy_bucket: 'NY_PM',
      last_updated_iso: '2026-04-08T15:45:05.000Z',
      connection_status: 'connected',
      engine_running: true,
      cycle_count: 42,
      engine_phase: 'MANAGING',
      engine_phase_elapsed_ms: 12000,
      engine_phase_reason: 'open_position',
      quote_source: 'live',
      quote_age_ms: 1200,
      quote_is_stale: true,
      quote_updated_at: '2026-04-08T15:45:04.000Z',
    };

    const html = renderComponent(StatusBar, {
      app,
      connected: true,
      isStale: false,
      freshness: baseFreshness,
    });

    expect(html).toContain('MANAGING');
    expect(html).toContain('open_position');
    expect(html).toContain('live');
    expect(html).toContain('Cycle #42');
    expect(html).toContain('Stale');
  });

  it('renders management advisory populated and empty states', () => {
    const populated: Management = {
      pop_target1_before_stop: 0.61,
      pop_target2_before_stop: 0.34,
      pop_runner_extension: 0.18,
      expected_value_hold_usd: 125,
      expected_value_exit_now_usd: 86,
      expected_value_reduce_usd: 103,
      management_state: 'HOLD',
      management_state_reason: 'Momentum intact',
      decision_factors: ['above_vwap', 'time_stop_buffer'],
      model_name: 'rules_v1',
      model_confidence: 'medium',
      last_evaluated_at: '2026-04-08T15:45:00.000Z',
    };

    const empty: Management = {
      pop_target1_before_stop: null,
      pop_target2_before_stop: null,
      pop_runner_extension: null,
      expected_value_hold_usd: null,
      expected_value_exit_now_usd: null,
      expected_value_reduce_usd: null,
      management_state: null,
      management_state_reason: null,
      decision_factors: [],
      model_name: null,
      model_confidence: null,
      last_evaluated_at: null,
    };

    const populatedHtml = renderComponent(ManagementPanel, { management: populated });
    const emptyHtml = renderComponent(ManagementPanel, { management: empty });

    expect(populatedHtml).toContain('Management Advisory');
    expect(populatedHtml).toContain('HOLD');
    expect(populatedHtml).toContain('Momentum intact');
    expect(populatedHtml).toContain('above_vwap');
    expect(emptyHtml).toContain('No active management advisory');
  });

  it('renders active trade management metadata', () => {
    const trade: ActiveTradeType = {
      is_open: true,
      trade_id: 'T001',
      side: 'long',
      setup_type: 'trend_pullback_long',
      entry_price: 17000,
      stop_loss: 17010,
      stop_initial: 16990,
      target_1: 17020,
      target_2: 17040,
      target_3: null,
      current_price: 17018,
      unrealized_pnl_usd: 180,
      unrealized_r: 0.9,
      hold_time_seconds: 180,
      mfe_pts: 12,
      mae_pts: 3,
      breakeven_armed: true,
      trailing_armed: true,
      trailing_ticks: 8,
      quantity: 2,
      quantity_remaining: 1,
      management_profile: 'trend_scaler',
      setup_family: 'pullback',
      atr_at_entry: 18,
      pt1_resolved_pts: 10,
      pt2_resolved_pts: 20,
      trail_resolved_ticks: 12,
    };

    const html = renderComponent(ActiveTrade, { trade });
    expect(html).toContain('trend_scaler');
    expect(html).toContain('pullback');
    expect(html).toContain('18.00');
    expect(html).toContain('10.00 pts');
    expect(html).toContain('20.00 pts');
    expect(html).toContain('12 tk');
  });
});
