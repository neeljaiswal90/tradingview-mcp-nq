import type { ContractRoot, ContractSpec } from './contracts.js';
import { getContractSpec, listSupportedRoots } from './contracts.js';
import type { IndicatorConfig } from './types.js';

export type InstrumentRole = 'active' | 'shadow';

export type CorrelatedExposurePolicy =
  | 'allow_both'
  | 'best_signal_only'
  | 'opposite_only';

export interface InstrumentConfigOverride {
  enabled: boolean;
  role: InstrumentRole;
  log_dir: string;
  lob_url: string;
  dashboard_port: number;
  pane_index?: number;
  config_overrides?: Partial<IndicatorConfig>;
}

export interface MultiInstrumentConfig {
  enabled: boolean;
  default_pair: ContractRoot[];
  live_enabled_instruments: ContractRoot[];
  supported_instruments: ContractRoot[];
  max_simultaneous_positions?: number;
  max_total_risk_pct?: number;
  correlated_exposure_policy?: CorrelatedExposurePolicy;
  global_kill_switch?: boolean;
  instruments: Partial<Record<ContractRoot, InstrumentConfigOverride>>;
}

export interface ResolvedInstrumentRuntimeConfig {
  id: ContractRoot;
  enabled: true;
  role: InstrumentRole;
  contract: ContractSpec;
  logDir: string;
  lobServiceUrl: string;
  dashboardPort: number;
  paneIndex?: number;
  effectiveConfig: IndicatorConfig;
}

export interface DeprecatedRunnerAliases {
  runner_v2_enabled?: boolean;
  runner_v2_shadow_only?: boolean;
}

const DEFAULT_SUPPORTED_INSTRUMENTS = listSupportedRoots();
const DEFAULT_LIVE_ENABLED_INSTRUMENTS: ContractRoot[] = ['MNQ', 'MES'];

export const DEFAULT_MULTI_INSTRUMENT_CONFIG: MultiInstrumentConfig = {
  enabled: false,
  default_pair: ['MNQ', 'MES'],
  live_enabled_instruments: DEFAULT_LIVE_ENABLED_INSTRUMENTS,
  supported_instruments: DEFAULT_SUPPORTED_INSTRUMENTS,
  max_simultaneous_positions: 2,
  max_total_risk_pct: 3.0,
  correlated_exposure_policy: 'best_signal_only',
  global_kill_switch: false,
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
      pane_index: 1,
    },
    NQ: {
      enabled: false,
      role: 'shadow',
      log_dir: 'logs-nq',
      lob_url: 'http://127.0.0.1:5020',
      dashboard_port: 3910,
      pane_index: 0,
    },
    ES: {
      enabled: false,
      role: 'shadow',
      log_dir: 'logs-es',
      lob_url: 'http://127.0.0.1:5021',
      dashboard_port: 3911,
      pane_index: 1,
    },
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cloneValue(item)) as T;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = cloneValue(child);
    }
    return result as T;
  }
  return value;
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return cloneValue(base);
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return cloneValue(override as T);
  }

  const result: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(override),
  ]);

  for (const key of keys) {
    const baseValue = (base as Record<string, unknown>)[key];
    const overrideValue = (override as Record<string, unknown>)[key];
    if (overrideValue === undefined) {
      result[key] = cloneValue(baseValue);
      continue;
    }
    if (baseValue === undefined) {
      result[key] = cloneValue(overrideValue);
      continue;
    }
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
      continue;
    }
    result[key] = cloneValue(overrideValue);
  }

  return result as T;
}

export function mergeInstrumentConfig(
  base: IndicatorConfig,
  overrides: Partial<IndicatorConfig> | undefined,
): IndicatorConfig {
  return deepMerge(base, overrides ?? {});
}

export function normalizeMultiInstrumentConfig(
  config?: Partial<MultiInstrumentConfig>,
  aliases: DeprecatedRunnerAliases = {},
): MultiInstrumentConfig {
  const normalized = cloneValue(DEFAULT_MULTI_INSTRUMENT_CONFIG);

  if (config) {
    normalized.enabled = config.enabled ?? normalized.enabled;
    normalized.default_pair = cloneValue(config.default_pair ?? normalized.default_pair);
    normalized.live_enabled_instruments = cloneValue(
      config.live_enabled_instruments ?? normalized.live_enabled_instruments,
    );
    normalized.supported_instruments = cloneValue(
      config.supported_instruments ?? normalized.supported_instruments,
    );
    normalized.max_simultaneous_positions =
      config.max_simultaneous_positions ?? normalized.max_simultaneous_positions;
    normalized.max_total_risk_pct =
      config.max_total_risk_pct ?? normalized.max_total_risk_pct;
    normalized.correlated_exposure_policy =
      config.correlated_exposure_policy ?? normalized.correlated_exposure_policy;
    normalized.global_kill_switch =
      config.global_kill_switch ?? normalized.global_kill_switch;

    const mergedInstruments: Partial<Record<ContractRoot, InstrumentConfigOverride>> = {
      ...normalized.instruments,
    };
    for (const root of DEFAULT_SUPPORTED_INSTRUMENTS) {
      const override = config.instruments?.[root];
      if (!override) continue;
      mergedInstruments[root] = {
        ...(normalized.instruments[root] ?? DEFAULT_MULTI_INSTRUMENT_CONFIG.instruments[root]!),
        ...override,
        config_overrides: mergeInstrumentConfig(
          {} as IndicatorConfig,
          override.config_overrides ?? {},
        ) as Partial<IndicatorConfig>,
      };
    }
    normalized.instruments = mergedInstruments;
  }

  if (!config && aliases.runner_v2_enabled === true) {
    normalized.enabled = true;
  }

  if (aliases.runner_v2_shadow_only === true) {
    const nextInstruments: Partial<Record<ContractRoot, InstrumentConfigOverride>> = {
      ...normalized.instruments,
    };
    for (const root of DEFAULT_SUPPORTED_INSTRUMENTS) {
      const instrument = nextInstruments[root];
      if (!instrument || !instrument.enabled) continue;
      nextInstruments[root] = {
        ...instrument,
        role: 'shadow',
      };
    }
    normalized.instruments = nextInstruments;
  }

  return normalized;
}

export function validateMultiInstrumentConfig(config: MultiInstrumentConfig): void {
  const supported = new Set(config.supported_instruments);
  const liveEnabled = new Set(config.live_enabled_instruments);

  for (const root of config.default_pair) {
    if (!supported.has(root)) {
      throw new Error(
        `[MULTI_INSTRUMENT] default_pair contains unsupported instrument "${root}".`,
      );
    }
  }

  const enabledRoots = Object.entries(config.instruments)
    .filter(([, instrument]) => instrument?.enabled === true)
    .map(([root]) => root as ContractRoot);

  if (config.enabled && enabledRoots.length === 0) {
    throw new Error(
      '[MULTI_INSTRUMENT] enabled=true but no instruments are enabled.',
    );
  }

  const seenLogDirs = new Map<string, ContractRoot>();
  const seenPorts = new Map<number, ContractRoot>();
  const seenLobUrls = new Map<string, ContractRoot>();
  const seenPaneIndexes = new Map<number, ContractRoot>();

  for (const root of enabledRoots) {
    if (!supported.has(root)) {
      throw new Error(
        `[MULTI_INSTRUMENT] Instrument "${root}" is enabled but not in supported_instruments.`,
      );
    }

    const instrument = config.instruments[root];
    if (!instrument) continue;

    if (instrument.role === 'active' && !liveEnabled.has(root)) {
      throw new Error(
        `[MULTI_INSTRUMENT] Instrument "${root}" is active but not live-enabled.`,
      );
    }

    const priorLogDir = seenLogDirs.get(instrument.log_dir);
    if (priorLogDir) {
      throw new Error(
        `[MULTI_INSTRUMENT] log_dir collision: ${root} and ${priorLogDir} both use "${instrument.log_dir}".`,
      );
    }
    seenLogDirs.set(instrument.log_dir, root);

    const priorPort = seenPorts.get(instrument.dashboard_port);
    if (priorPort) {
      throw new Error(
        `[MULTI_INSTRUMENT] dashboard_port collision: ${root} and ${priorPort} both use ${instrument.dashboard_port}.`,
      );
    }
    seenPorts.set(instrument.dashboard_port, root);

    const priorLobUrl = seenLobUrls.get(instrument.lob_url);
    if (priorLobUrl) {
      throw new Error(
        `[MULTI_INSTRUMENT] lob_url collision: ${root} and ${priorLobUrl} both use "${instrument.lob_url}".`,
      );
    }
    seenLobUrls.set(instrument.lob_url, root);

    if (instrument.pane_index != null) {
      if (!Number.isInteger(instrument.pane_index) || instrument.pane_index < 0) {
        throw new Error(
          `[MULTI_INSTRUMENT] Instrument "${root}" has invalid pane_index=${instrument.pane_index}. Expected a non-negative integer.`,
        );
      }
      const priorPane = seenPaneIndexes.get(instrument.pane_index);
      if (priorPane) {
        throw new Error(
          `[MULTI_INSTRUMENT] pane_index collision: ${root} and ${priorPane} both use pane ${instrument.pane_index}.`,
        );
      }
      seenPaneIndexes.set(instrument.pane_index, root);
    }
  }
}

export function resolveEnabledInstruments(
  baseConfig: IndicatorConfig,
  multiConfig: MultiInstrumentConfig,
): ResolvedInstrumentRuntimeConfig[] {
  validateMultiInstrumentConfig(multiConfig);

  const enabled: ResolvedInstrumentRuntimeConfig[] = [];
  for (const root of multiConfig.supported_instruments) {
    const instrument = multiConfig.instruments[root];
    if (!instrument?.enabled) continue;

    const contract = getContractSpec(root);
    const effectiveConfig = mergeInstrumentConfig(baseConfig, instrument.config_overrides);
    effectiveConfig.execution_mode = instrument.role === 'shadow'
      ? 'shadow'
      : (effectiveConfig.execution_mode === 'live' ? 'live' : 'paper');

    enabled.push({
      id: root,
      enabled: true,
      role: instrument.role,
      contract,
      logDir: instrument.log_dir,
      lobServiceUrl: instrument.lob_url,
      dashboardPort: instrument.dashboard_port,
      paneIndex: instrument.pane_index,
      effectiveConfig,
    });
  }

  return enabled;
}
