import { describe, expect, it } from 'vitest';

import type { LobBbo, LobHealthResult } from '../../src/autotrade/lob-client.js';
import {
  deriveContractRootFromAlias,
  formatMarketDataStartupFailure,
  resolveMarketDataStartupSelection,
} from '../../src/autotrade/market-data-source.js';

function makeHealth(overrides: Partial<LobHealthResult> = {}): LobHealthResult {
  return {
    status: 'ok',
    source_connected: true,
    bbo_fresh: true,
    bbo_age_ms: 25,
    update_count: 42,
    trade_count: 9,
    depth_levels_bid: 12,
    depth_levels_ask: 14,
    mbo_events_buffered: 0,
    mbo_total_count: 0,
    mbo_status: 'idle',
    mbo_age_ms: 99999,
    mbo_adv_event_count: 0,
    active_trade_id: null,
    active_signal_id: null,
    recording_context: 'session',
    uptime_sec: 12.3,
    source_alias: 'MNQM6.CME@RITHMIC',
    source_symbol_root: 'MNQ',
    feed_provider: 'bookmap_rithmic',
    ...overrides,
  };
}

function makeBbo(overrides: Partial<LobBbo> = {}): LobBbo {
  return {
    bid: 21000.25,
    ask: 21000.50,
    mid: 21000.375,
    spread_pts: 0.25,
    bbo_age_ms: 25,
    timestamp_ms: Date.now(),
    source_connected: true,
    update_count: 42,
    is_fresh: true,
    last_bbo_ts_ms: Date.now() - 25,
    ...overrides,
  };
}

function makeClient(opts?: {
  health?: LobHealthResult;
  bbo?: LobBbo;
  healthError?: Error;
  bboError?: Error;
}) {
  return {
    async getHealth(): Promise<LobHealthResult> {
      if (opts?.healthError) throw opts.healthError;
      return opts?.health ?? makeHealth();
    },
    async getBbo(): Promise<LobBbo> {
      if (opts?.bboError) throw opts.bboError;
      return opts?.bbo ?? makeBbo();
    },
  };
}

describe('deriveContractRootFromAlias', () => {
  it('extracts supported roots from Bookmap aliases', () => {
    expect(deriveContractRootFromAlias('MNQM6.CME@RITHMIC')).toBe('MNQ');
    expect(deriveContractRootFromAlias('MESM6.CME@RITHMIC')).toBe('MES');
    expect(deriveContractRootFromAlias('NQM6.CME@RITHMIC')).toBe('NQ');
    expect(deriveContractRootFromAlias('ESM6.CME@RITHMIC')).toBe('ES');
  });
});

describe('resolveMarketDataStartupSelection', () => {
  it('selects Bookmap when the sidecar is healthy', async () => {
    const selection = await resolveMarketDataStartupSelection({
      client: makeClient(),
      instrument: 'MNQ',
      configuredLobUrl: 'http://127.0.0.1:5010',
      expectedSymbolRoot: 'MNQ',
      config: {
        fallback_to_tradingview_on_unhealthy_lob: true,
        lob_required_feed: 'depth',
      },
    });

    expect(selection.market_data_source_selected).toBe('bookmap');
    expect(selection.startup_action).toBe('use_bookmap');
    expect(selection.lob_health_state).toBe('healthy');
    expect(selection.fallback_reason).toBeNull();
  });

  it('does not treat a stale sidecar as healthy even when reachable', async () => {
    const selection = await resolveMarketDataStartupSelection({
      client: makeClient({
        health: makeHealth({
          status: 'degraded',
          bbo_fresh: false,
          bbo_age_ms: 5_000,
        }),
        bbo: makeBbo({
          bbo_age_ms: 5_000,
          is_fresh: false,
        }),
      }),
      instrument: 'MNQ',
      configuredLobUrl: 'http://127.0.0.1:5010',
      expectedSymbolRoot: 'MNQ',
      config: {
        fallback_to_tradingview_on_unhealthy_lob: true,
        lob_max_staleness_ms: 1_500,
      },
    });

    expect(selection.market_data_source_selected).toBe('tradingview');
    expect(selection.startup_action).toBe('fallback_to_tradingview');
    expect(selection.lob_health_state).toBe('degraded');
    expect(selection.lob_health.issues).toContain('bbo_not_fresh');
    expect(selection.lob_health.issues).toContain('bbo_stale');
  });

  it('falls back to TradingView with an explicit reason when the BBO endpoint is invalid', async () => {
    const selection = await resolveMarketDataStartupSelection({
      client: makeClient({
        bboError: new Error('timeout'),
      }),
      instrument: 'MNQ',
      configuredLobUrl: 'http://127.0.0.1:5010',
      expectedSymbolRoot: 'MNQ',
      config: {
        fallback_to_tradingview_on_unhealthy_lob: true,
      },
    });

    expect(selection.market_data_source_selected).toBe('tradingview');
    expect(selection.startup_action).toBe('fallback_to_tradingview');
    expect(selection.lob_health_state).toBe('unhealthy');
    expect(selection.fallback_reason).toBe('bbo_endpoint_unreachable');
  });

  it('fails startup clearly when fallback is disabled', async () => {
    const selection = await resolveMarketDataStartupSelection({
      client: makeClient({
        health: makeHealth({
          source_connected: false,
          bbo_fresh: false,
        }),
        bbo: makeBbo({
          source_connected: false,
          is_fresh: false,
          bid: null,
          ask: null,
          mid: null,
        }),
      }),
      instrument: 'MNQ',
      configuredLobUrl: 'http://127.0.0.1:5010',
      expectedSymbolRoot: 'MNQ',
      config: {
        fallback_to_tradingview_on_unhealthy_lob: false,
      },
    });

    expect(selection.market_data_source_selected).toBeNull();
    expect(selection.startup_action).toBe('fail_startup');
    expect(formatMarketDataStartupFailure(selection)).toContain('Refusing to start MNQ');
  });

  it('evaluates MNQ and MES independently by reported symbol root', async () => {
    const client = makeClient({
      health: makeHealth({
        source_alias: 'MESM6.CME@RITHMIC',
        source_symbol_root: 'MES',
      }),
    });

    const mnqSelection = await resolveMarketDataStartupSelection({
      client,
      instrument: 'MNQ',
      configuredLobUrl: 'http://127.0.0.1:5010',
      expectedSymbolRoot: 'MNQ',
      config: {
        fallback_to_tradingview_on_unhealthy_lob: true,
      },
    });
    const mesSelection = await resolveMarketDataStartupSelection({
      client,
      instrument: 'MES',
      configuredLobUrl: 'http://127.0.0.1:5011',
      expectedSymbolRoot: 'MES',
      config: {
        fallback_to_tradingview_on_unhealthy_lob: true,
      },
    });

    expect(mnqSelection.market_data_source_selected).toBe('tradingview');
    expect(mnqSelection.lob_health.issues[0]).toContain('source_symbol_root_mismatch');
    expect(mesSelection.market_data_source_selected).toBe('bookmap');
    expect(mesSelection.lob_health_state).toBe('healthy');
  });
});
