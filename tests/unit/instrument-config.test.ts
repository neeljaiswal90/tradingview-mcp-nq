import { readFileSync } from 'fs';

import { describe, expect, it } from 'vitest';

import type { IndicatorConfig } from '../../src/autotrade/types.js';
import {
  normalizeMultiInstrumentConfig,
  resolveEnabledInstruments,
  validateMultiInstrumentConfig,
} from '../../src/autotrade/instrument-config.js';

function loadBaseConfig(): IndicatorConfig {
  return JSON.parse(
    readFileSync('config/indicator-config.json', 'utf8'),
  ) as IndicatorConfig;
}

describe('multi-instrument config resolution', () => {
  it('preserves nested config overrides for per-instrument effective configs', () => {
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
          config_overrides: {
            layered_scoring: {
              enabled: true,
            },
            market_data: {
              fallback_to_tradingview_on_unhealthy_lob: false,
            },
          },
        },
        MES: {
          enabled: true,
          role: 'shadow',
          log_dir: 'logs-mes',
          lob_url: 'http://127.0.0.1:5011',
          dashboard_port: 3901,
        },
      },
    });

    const resolved = resolveEnabledInstruments(baseConfig, multi);
    const mnq = resolved.find(config => config.id === 'MNQ');
    const mes = resolved.find(config => config.id === 'MES');

    expect(mnq?.effectiveConfig.layered_scoring?.enabled).toBe(true);
    expect(mnq?.effectiveConfig.layered_scoring?.shadow_log).toBe(true);
    expect(mnq?.effectiveConfig.market_data?.fallback_to_tradingview_on_unhealthy_lob).toBe(false);
    expect(mes?.effectiveConfig.market_data?.fallback_to_tradingview_on_unhealthy_lob).toBe(true);
    expect(mes?.effectiveConfig.execution_mode).toBe('shadow');
    expect(mnq?.effectiveConfig.execution_mode).toBe('paper');
    expect(mnq?.paneIndex).toBe(0);
    expect(mes?.paneIndex).toBe(1);
  });

  it('rejects symbol-scoped collision across log directories and dashboard ports', () => {
    const multi = normalizeMultiInstrumentConfig({
      enabled: true,
      instruments: {
        MNQ: {
          enabled: true,
          role: 'active',
          log_dir: 'logs-shared',
          lob_url: 'http://127.0.0.1:5010',
          dashboard_port: 3900,
        },
        MES: {
          enabled: true,
          role: 'shadow',
          log_dir: 'logs-shared',
          lob_url: 'http://127.0.0.1:5011',
          dashboard_port: 3900,
        },
      },
    });

    expect(() => validateMultiInstrumentConfig(multi)).toThrow(/collision/);
  });

  it('rejects pane index collisions across enabled instruments', () => {
    const multi = normalizeMultiInstrumentConfig({
      enabled: true,
      instruments: {
        MNQ: {
          enabled: true,
          role: 'active',
          log_dir: 'logs-mnq',
          lob_url: 'http://127.0.0.1:5010',
          dashboard_port: 3900,
          pane_index: 0,
        },
        MES: {
          enabled: true,
          role: 'shadow',
          log_dir: 'logs-mes',
          lob_url: 'http://127.0.0.1:5011',
          dashboard_port: 3901,
          pane_index: 0,
        },
      },
    });

    expect(() => validateMultiInstrumentConfig(multi)).toThrow(/pane_index collision/);
  });

  it('rejects active instruments that are not live-enabled', () => {
    const multi = normalizeMultiInstrumentConfig({
      enabled: true,
      live_enabled_instruments: ['MNQ', 'MES'],
      instruments: {
        NQ: {
          enabled: true,
          role: 'active',
          log_dir: 'logs-nq',
          lob_url: 'http://127.0.0.1:5020',
          dashboard_port: 3910,
        },
      },
    });

    expect(() => validateMultiInstrumentConfig(multi)).toThrow(/not live-enabled/);
  });
});
