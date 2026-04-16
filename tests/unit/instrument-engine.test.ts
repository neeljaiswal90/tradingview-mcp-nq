import { readFileSync } from 'fs';

import { describe, expect, it } from 'vitest';

import {
  buildChildIndicatorConfig,
  buildInstrumentChildEnv,
  createEngineReadyState,
  isEngineReadyStateSatisfied,
  observeEngineReadyLine,
} from '../../src/autotrade/instrument-engine.js';
import { normalizeMultiInstrumentConfig, resolveEnabledInstruments } from '../../src/autotrade/instrument-config.js';
import type { AutotradeEnv } from '../../src/autotrade/env.js';
import type { IndicatorConfig } from '../../src/autotrade/types.js';

function loadBaseConfig(): IndicatorConfig {
  return JSON.parse(
    readFileSync('config/indicator-config.json', 'utf8'),
  ) as IndicatorConfig;
}

const BASE_ENV: AutotradeEnv = {
  MODE: 'paper',
  LIVE_TRADING_ENABLED: false,
  SYMBOL: 'MNQ1!',
  LOG_DIR: './logs',
  STRATEGY_VERSION: 'STRAT_v1.0',
  RESTART_MODE: 'dev',
  RUNTIME_HEARTBEAT_INTERVAL_MS: 10000,
  RUNTIME_HEARTBEAT_STALE_MS: 40000,
  AUTOTRADE_RUNTIME_STATE_HARDENING: true,
};

describe('instrument engine runtime wiring', () => {
  it('builds child config that disables nested orchestrator relaunch and preserves overrides', () => {
    const baseConfig = loadBaseConfig();
    const multi = normalizeMultiInstrumentConfig({
      enabled: true,
      instruments: {
        MES: {
          enabled: true,
          role: 'shadow',
          log_dir: 'logs-mes',
          lob_url: 'http://127.0.0.1:5011',
          dashboard_port: 3901,
          config_overrides: {
            quant_entry: {
              enabled: true,
              hybrid_gate: false,
              quant_primary_mode: false,
            },
          },
        },
      },
    });

    const runtimeConfig = resolveEnabledInstruments(baseConfig, multi)
      .find(config => config.id === 'MES')!;
    const childConfig = buildChildIndicatorConfig(runtimeConfig, multi);

    expect(childConfig.multi_instrument?.enabled).toBe(false);
    expect(childConfig.runner_v2_enabled).toBe(false);
    expect(childConfig.runner_v2_shadow_only).toBe(false);
    expect(childConfig.execution_mode).toBe('shadow');
    expect(childConfig.quant_entry?.hybrid_gate).toBe(false);
  });

  it('builds child env with per-instrument overrides and force-legacy protection', () => {
    const baseConfig = loadBaseConfig();
    const multi = normalizeMultiInstrumentConfig({
      enabled: true,
      instruments: {
        MNQ: {
          enabled: true,
          role: 'active',
          log_dir: 'logs-mnq',
          lob_url: 'http://127.0.0.1:5010',
          dashboard_port: 3900,
        },
      },
    });

    const runtimeConfig = resolveEnabledInstruments(baseConfig, multi)[0]!;
    const env = buildInstrumentChildEnv(BASE_ENV, runtimeConfig, 'C:/tmp/mnq-config');

    expect(env['FORCE_LEGACY_RUNNER']).toBe('1');
    expect(env['AUTOTRADE_CONFIG_DIR']).toBe('C:/tmp/mnq-config');
    expect(env['SYMBOL']).toBe('MNQ1!');
    expect(env['LOG_DIR']).toBe('logs-mnq');
    expect(env['LOB_SERVICE_URL']).toBe('http://127.0.0.1:5010');
    expect(env['DASHBOARD_PORT']).toBe('3900');
    expect(env['TV_PANE_INDEX']).toBe('0');
  });

  it('requires both TradingView connection and chart configuration before declaring readiness', () => {
    let ready = createEngineReadyState();
    ready = observeEngineReadyLine(ready, '[STARTUP] ✅ TradingView connected');
    expect(isEngineReadyStateSatisfied(ready)).toBe(false);

    ready = observeEngineReadyLine(ready, '[STARTUP] ✅ Chart configured');
    expect(isEngineReadyStateSatisfied(ready)).toBe(true);
  });
});
