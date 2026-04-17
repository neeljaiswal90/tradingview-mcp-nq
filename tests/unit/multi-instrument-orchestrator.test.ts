import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AutotradeEnv } from '../../src/autotrade/env.js';
import { normalizeMultiInstrumentConfig } from '../../src/autotrade/instrument-config.js';
import { MultiInstrumentOrchestrator } from '../../src/autotrade/multi-instrument-orchestrator.js';
import type { IndicatorConfig } from '../../src/autotrade/types.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function loadBaseConfig(): IndicatorConfig {
  return JSON.parse(readFileSync('config/indicator-config.json', 'utf8')) as IndicatorConfig;
}

function createFakeRunnerScript(rootDir: string): string {
  const runnerPath = join(rootDir, 'fake-runner.mjs');
  writeFileSync(
    runnerPath,
    `import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const logDir = process.env.LOG_DIR;
const configDir = process.env.AUTOTRADE_CONFIG_DIR;
if (!logDir || !configDir) {
  console.error('[FAKE] missing LOG_DIR or AUTOTRADE_CONFIG_DIR');
  process.exit(1);
}
mkdirSync(logDir, { recursive: true });
const config = JSON.parse(readFileSync(join(configDir, 'indicator-config.json'), 'utf8'));
writeFileSync(join(logDir, 'fake_runner_manifest.json'), JSON.stringify({
  symbol: process.env.SYMBOL,
  logDir,
  lobUrl: process.env.LOB_SERVICE_URL,
  dashboardPort: process.env.DASHBOARD_PORT,
  paneIndex: process.env.TV_PANE_INDEX,
  configDir,
  executionMode: config.execution_mode,
  forceLegacyRunner: process.env.FORCE_LEGACY_RUNNER,
}, null, 2));
console.log('[STARTUP] TradingView connected');
console.log('[STARTUP] Chart configured');
let shutdownCount = 0;
process.on('message', message => {
  if (!message || message.type !== 'shutdown') {
    return;
  }
  shutdownCount += 1;
  writeFileSync(join(logDir, 'fake_runner_shutdown.json'), JSON.stringify({
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

function buildBaseEnv(rootDir: string): AutotradeEnv {
  return {
    MODE: 'paper',
    LIVE_TRADING_ENABLED: false,
    SYMBOL: 'MNQ1!',
    LOG_DIR: join(rootDir, 'legacy-logs'),
    STRATEGY_VERSION: 'STRAT_v1.0',
    RESTART_MODE: 'dev',
    RUNTIME_HEARTBEAT_INTERVAL_MS: 10000,
    RUNTIME_HEARTBEAT_STALE_MS: 40000,
    AUTOTRADE_RUNTIME_STATE_HARDENING: true,
  };
}

async function launchSmoke(rootDir: string): Promise<Record<string, Record<string, string>>> {
  const fakeRunner = createFakeRunnerScript(rootDir);
  const baseConfig = loadBaseConfig();
  const multiConfig = normalizeMultiInstrumentConfig({
    enabled: true,
    instruments: {
      MNQ: {
        enabled: true,
        role: 'active',
        log_dir: join(rootDir, 'logs-mnq'),
        lob_url: 'http://127.0.0.1:5010',
        dashboard_port: 3900,
      },
      MES: {
        enabled: true,
        role: 'shadow',
        log_dir: join(rootDir, 'logs-mes'),
        lob_url: 'http://127.0.0.1:5011',
        dashboard_port: 3901,
      },
    },
  });

  const orchestrator = new MultiInstrumentOrchestrator({
    baseConfig,
    multiConfig,
    env: buildBaseEnv(rootDir),
    configDir: join(process.cwd(), 'config'),
    runnerEntrypoint: fakeRunner,
  });

  await orchestrator.initialize();
  await orchestrator.connectAndVerify();

  const manifests: Record<string, Record<string, string>> = {};
  for (const instrument of ['MNQ', 'MES']) {
    const logDir = join(rootDir, instrument === 'MNQ' ? 'logs-mnq' : 'logs-mes');
    manifests[instrument] = JSON.parse(
      readFileSync(join(logDir, 'fake_runner_manifest.json'), 'utf8'),
    ) as Record<string, string>;
  }

  await orchestrator.shutdown('test_complete');
  await orchestrator.shutdown('test_complete_duplicate');
  return manifests;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('multi-instrument orchestrator smoke', () => {
  it('starts MNQ active + MES shadow with isolated runtime paths and cleans temp configs', async () => {
    const rootDir = makeTempDir('multi-orch-smoke-');
    const manifests = await launchSmoke(rootDir);

    expect(manifests['MNQ']?.['symbol']).toBe('MNQ1!');
    expect(manifests['MES']?.['symbol']).toBe('MES1!');
    expect(manifests['MNQ']?.['executionMode']).toBe('paper');
    expect(manifests['MES']?.['executionMode']).toBe('shadow');
    expect(manifests['MNQ']?.['lobUrl']).toBe('http://127.0.0.1:5010');
    expect(manifests['MES']?.['lobUrl']).toBe('http://127.0.0.1:5011');
    expect(manifests['MNQ']?.['dashboardPort']).toBe('3900');
    expect(manifests['MES']?.['dashboardPort']).toBe('3901');
    expect(manifests['MNQ']?.['paneIndex']).toBe('0');
    expect(manifests['MES']?.['paneIndex']).toBe('1');
    expect(manifests['MNQ']?.['logDir']).not.toBe(manifests['MES']?.['logDir']);
    expect(manifests['MNQ']?.['configDir']).not.toBe(manifests['MES']?.['configDir']);
    expect(manifests['MNQ']?.['forceLegacyRunner']).toBe('1');
    expect(manifests['MES']?.['forceLegacyRunner']).toBe('1');

    const mnqRuntimeRoot = dirname(manifests['MNQ']!['configDir']!);
    const mesRuntimeRoot = dirname(manifests['MES']!['configDir']!);
    expect(existsSync(mnqRuntimeRoot)).toBe(false);
    expect(existsSync(mesRuntimeRoot)).toBe(false);

    const mnqShutdown = JSON.parse(
      readFileSync(join(rootDir, 'logs-mnq', 'fake_runner_shutdown.json'), 'utf8'),
    ) as { reason: string; shutdownCount: number };
    const mesShutdown = JSON.parse(
      readFileSync(join(rootDir, 'logs-mes', 'fake_runner_shutdown.json'), 'utf8'),
    ) as { reason: string; shutdownCount: number };
    expect(mnqShutdown).toEqual({ reason: 'test_complete', shutdownCount: 1 });
    expect(mesShutdown).toEqual({ reason: 'test_complete', shutdownCount: 1 });
  });

  it('uses unique resolved temp config dirs across reruns', async () => {
    const firstRoot = makeTempDir('multi-orch-first-');
    const secondRoot = makeTempDir('multi-orch-second-');

    const first = await launchSmoke(firstRoot);
    const second = await launchSmoke(secondRoot);

    expect(first['MNQ']?.['configDir']).not.toBe(second['MNQ']?.['configDir']);
    expect(first['MES']?.['configDir']).not.toBe(second['MES']?.['configDir']);
  });
});
