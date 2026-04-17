import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AutotradeEnv } from '../../src/autotrade/env.js';
import {
  buildChildIndicatorConfig,
  buildInstrumentChildEnv,
  createEngineReadyState,
  InstrumentEngine,
  isEngineReadyStateSatisfied,
  observeEngineReadyLine,
} from '../../src/autotrade/instrument-engine.js';
import {
  normalizeMultiInstrumentConfig,
  resolveEnabledInstruments,
} from '../../src/autotrade/instrument-config.js';
import type { IndicatorConfig } from '../../src/autotrade/types.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function loadBaseConfig(): IndicatorConfig {
  return JSON.parse(
    readFileSync('config/indicator-config.json', 'utf8'),
  ) as IndicatorConfig;
}

function createFakeRunnerScript(rootDir: string): string {
  const runnerPath = join(rootDir, 'engine-fake-runner.mjs');
  writeFileSync(
    runnerPath,
    `import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const logDir = process.env.LOG_DIR;
const configDir = process.env.AUTOTRADE_CONFIG_DIR;
if (!logDir || !configDir) {
  console.error('[FAKE] missing LOG_DIR or AUTOTRADE_CONFIG_DIR');
  process.exit(1);
}
mkdirSync(logDir, { recursive: true });
writeFileSync(join(logDir, 'engine_manifest.json'), JSON.stringify({
  configDir,
  logDir,
  symbol: process.env.SYMBOL,
}, null, 2));
console.log('[STARTUP] TradingView connected');
console.log('[STARTUP] Chart configured');
let shutdownCount = 0;
process.on('message', message => {
  if (!message || message.type !== 'shutdown') {
    return;
  }
  shutdownCount += 1;
  writeFileSync(join(logDir, 'engine_shutdown.json'), JSON.stringify({
    reason: message.reason,
    shutdownCount,
  }, null, 2));
  if (typeof process.send === 'function') {
    process.send({ type: 'shutdownAck', reason: message.reason }, () => process.exit(0));
    return;
  }
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
    'utf8',
  );
  return runnerPath;
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    ready = observeEngineReadyLine(ready, '[STARTUP] TradingView connected');
    expect(isEngineReadyStateSatisfied(ready)).toBe(false);

    ready = observeEngineReadyLine(ready, '[STARTUP] Chart configured');
    expect(isEngineReadyStateSatisfied(ready)).toBe(true);
  });

  it('uses a single IPC shutdown path when the parent requests shutdown twice', async () => {
    const rootDir = makeTempDir('instrument-engine-ipc-');
    const runnerEntrypoint = createFakeRunnerScript(rootDir);
    const baseConfig = loadBaseConfig();
    const multi = normalizeMultiInstrumentConfig({
      enabled: true,
      instruments: {
        MNQ: {
          enabled: true,
          role: 'active',
          log_dir: join(rootDir, 'logs-mnq'),
          lob_url: 'http://127.0.0.1:5010',
          dashboard_port: 3900,
        },
      },
    });
    const runtimeConfig = resolveEnabledInstruments(baseConfig, multi)[0]!;

    const engine = new InstrumentEngine({
      runtimeConfig,
      baseConfigDir: join(process.cwd(), 'config'),
      baseEnv: {
        ...BASE_ENV,
        LOG_DIR: join(rootDir, 'legacy-logs'),
      },
      multiConfig: multi,
      orchestratorSessionId: 'TEST_ENGINE_SHUTDOWN',
      runnerEntrypoint,
      readyTimeoutMs: 5_000,
    });

    await engine.initialize();
    await engine.connectAndVerify();

    const manifest = JSON.parse(
      readFileSync(join(rootDir, 'logs-mnq', 'engine_manifest.json'), 'utf8'),
    ) as { configDir: string };

    await Promise.all([
      engine.shutdown('first_shutdown'),
      engine.shutdown('second_shutdown'),
    ]);

    const shutdown = JSON.parse(
      readFileSync(join(rootDir, 'logs-mnq', 'engine_shutdown.json'), 'utf8'),
    ) as { reason: string; shutdownCount: number };

    expect(shutdown).toEqual({ reason: 'first_shutdown', shutdownCount: 1 });
    expect(existsSync(dirname(manifest.configDir))).toBe(false);
  });
});
