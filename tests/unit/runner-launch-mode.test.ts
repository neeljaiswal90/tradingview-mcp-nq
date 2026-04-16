import { describe, expect, it } from 'vitest';

import { resolveRunnerLaunchMode } from '../../src/autotrade/runner-launch.js';

describe('runner launch precedence', () => {
  it('FORCE_LEGACY_RUNNER wins over explicit multi_instrument enablement', () => {
    const result = resolveRunnerLaunchMode(
      {
        multi_instrument: {
          enabled: true,
          default_pair: ['MNQ', 'MES'],
          live_enabled_instruments: ['MNQ', 'MES'],
          supported_instruments: ['MNQ', 'MES', 'NQ', 'ES'],
          instruments: {
            MNQ: {
              enabled: true,
              role: 'active',
              log_dir: 'logs-mnq',
              lob_url: 'http://127.0.0.1:5010',
              dashboard_port: 3900,
            },
          },
        },
      },
      { FORCE_LEGACY_RUNNER: '1' },
    );

    expect(result.mode).toBe('legacy');
    expect(result.reason).toBe('FORCE_LEGACY_RUNNER=1');
  });

  it('explicit multi_instrument section is authoritative over deprecated aliases', () => {
    const result = resolveRunnerLaunchMode({
      multi_instrument: {
        enabled: false,
        default_pair: ['MNQ', 'MES'],
        live_enabled_instruments: ['MNQ', 'MES'],
        supported_instruments: ['MNQ', 'MES', 'NQ', 'ES'],
        instruments: {
          MNQ: {
            enabled: true,
            role: 'active',
            log_dir: 'logs-mnq',
            lob_url: 'http://127.0.0.1:5010',
            dashboard_port: 3900,
          },
        },
      },
      runner_v2_enabled: true,
      runner_v2_shadow_only: true,
    });

    expect(result.mode).toBe('legacy');
    expect(result.reason).toBe('multi_instrument.enabled=false');
    expect(result.warnings[0]).toContain('runner_v2_*');
  });

  it('maps deprecated runner_v2 aliases into multi-instrument behavior when needed', () => {
    const result = resolveRunnerLaunchMode({
      runner_v2_enabled: true,
      runner_v2_shadow_only: true,
    });

    expect(result.mode).toBe('multi_instrument');
    expect(result.reason).toBe('deprecated_runner_v2_alias');
    expect(result.multiConfig.enabled).toBe(true);
    expect(result.multiConfig.instruments.MNQ?.role).toBe('shadow');
    expect(result.multiConfig.instruments.MES?.role).toBe('shadow');
  });

  it('falls back to legacy when no multi-instrument controls are present', () => {
    const result = resolveRunnerLaunchMode({});
    expect(result.mode).toBe('legacy');
    expect(result.reason).toBe('default_legacy_fallback');
  });
});
