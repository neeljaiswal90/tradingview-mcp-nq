import type { IndicatorConfig } from './types.js';
import {
  DEFAULT_MULTI_INSTRUMENT_CONFIG,
  normalizeMultiInstrumentConfig,
  type MultiInstrumentConfig,
} from './instrument-config.js';

export type RunnerLaunchMode = 'legacy' | 'multi_instrument';

export interface RunnerLaunchResolution {
  mode: RunnerLaunchMode;
  reason: string;
  warnings: string[];
  multiConfig: MultiInstrumentConfig;
}

export function isForceLegacyRunnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FORCE_LEGACY_RUNNER'] === '1';
}

export function resolveRunnerLaunchMode(
  config: Pick<IndicatorConfig, 'multi_instrument' | 'runner_v2_enabled' | 'runner_v2_shadow_only'>,
  env: NodeJS.ProcessEnv = process.env,
): RunnerLaunchResolution {
  const warnings: string[] = [];

  if (isForceLegacyRunnerEnabled(env)) {
    return {
      mode: 'legacy',
      reason: 'FORCE_LEGACY_RUNNER=1',
      warnings,
      multiConfig: normalizeMultiInstrumentConfig(config.multi_instrument),
    };
  }

  if (config.multi_instrument) {
    if (config.runner_v2_enabled !== undefined || config.runner_v2_shadow_only !== undefined) {
      warnings.push(
        '[RUNNER] Deprecated runner_v2_* flags are ignored when multi_instrument is explicitly configured.',
      );
    }
    const multiConfig = normalizeMultiInstrumentConfig(config.multi_instrument);
    return {
      mode: multiConfig.enabled ? 'multi_instrument' : 'legacy',
      reason: multiConfig.enabled
        ? 'multi_instrument.enabled=true'
        : 'multi_instrument.enabled=false',
      warnings,
      multiConfig,
    };
  }

  if (config.runner_v2_enabled === true) {
    warnings.push(
      '[RUNNER] runner_v2_enabled is deprecated; migrate to multi_instrument.enabled.',
    );
    if (config.runner_v2_shadow_only === true) {
      warnings.push(
        '[RUNNER] runner_v2_shadow_only is deprecated; migrate to explicit multi_instrument.instruments[<root>].role values.',
      );
    }
    const multiConfig = normalizeMultiInstrumentConfig(undefined, {
      runner_v2_enabled: true,
      runner_v2_shadow_only: config.runner_v2_shadow_only,
    });
    return {
      mode: multiConfig.enabled ? 'multi_instrument' : 'legacy',
      reason: 'deprecated_runner_v2_alias',
      warnings,
      multiConfig,
    };
  }

  if (config.runner_v2_shadow_only === true) {
    warnings.push(
      '[RUNNER] runner_v2_shadow_only is ignored because runner_v2_enabled is not true.',
    );
  }

  return {
    mode: 'legacy',
    reason: 'default_legacy_fallback',
    warnings,
    multiConfig: normalizeMultiInstrumentConfig(DEFAULT_MULTI_INSTRUMENT_CONFIG),
  };
}
