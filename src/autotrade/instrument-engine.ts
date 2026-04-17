import { spawn, type ChildProcess } from 'child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { AutotradeEnv } from './env.js';
import type { MultiInstrumentConfig, ResolvedInstrumentRuntimeConfig } from './instrument-config.js';
import {
  forceTerminateChildProcess,
  requestGracefulShutdown,
} from './runner-ipc.js';
import type { IndicatorConfig } from './types.js';

const READY_TRADINGVIEW_CONNECTED = 'TradingView connected';
const READY_CHART_CONFIGURED = 'Chart configured';

export interface EngineReadyState {
  tradingViewConnected: boolean;
  chartConfigured: boolean;
}

export function createEngineReadyState(): EngineReadyState {
  return {
    tradingViewConnected: false,
    chartConfigured: false,
  };
}

export function observeEngineReadyLine(
  state: EngineReadyState,
  line: string,
): EngineReadyState {
  return {
    tradingViewConnected:
      state.tradingViewConnected || line.includes(READY_TRADINGVIEW_CONNECTED),
    chartConfigured:
      state.chartConfigured || line.includes(READY_CHART_CONFIGURED),
  };
}

export function isEngineReadyStateSatisfied(state: EngineReadyState): boolean {
  return state.tradingViewConnected && state.chartConfigured;
}

export interface InstrumentEngineOptions {
  runtimeConfig: ResolvedInstrumentRuntimeConfig;
  baseConfigDir: string;
  baseEnv: AutotradeEnv;
  multiConfig: MultiInstrumentConfig;
  orchestratorSessionId: string;
  runnerEntrypoint?: string;
  readyTimeoutMs?: number;
}

export interface PreparedInstrumentRuntime {
  runtimeRoot: string;
  configDir: string;
  indicatorConfigPath: string;
  childEnv: NodeJS.ProcessEnv;
  childConfig: IndicatorConfig;
}

function resolveDefaultRunnerEntrypoint(): string {
  return fileURLToPath(new URL('./runner.js', import.meta.url));
}

export function buildChildIndicatorConfig(
  runtimeConfig: ResolvedInstrumentRuntimeConfig,
  multiConfig: MultiInstrumentConfig,
): IndicatorConfig {
  return {
    ...runtimeConfig.effectiveConfig,
    execution_mode: runtimeConfig.role === 'shadow'
      ? 'shadow'
      : (runtimeConfig.effectiveConfig.execution_mode === 'live' ? 'live' : 'paper'),
    runner_v2_enabled: false,
    runner_v2_shadow_only: false,
    multi_instrument: {
      ...multiConfig,
      enabled: false,
    },
  };
}

export function buildInstrumentChildEnv(
  baseEnv: AutotradeEnv,
  runtimeConfig: ResolvedInstrumentRuntimeConfig,
  configDir: string,
): NodeJS.ProcessEnv {
  const childMode = runtimeConfig.role === 'shadow'
    ? (baseEnv.MODE === 'signal_only' ? 'signal_only' : 'paper')
    : baseEnv.MODE;

  return {
    ...process.env,
    MODE: childMode,
    LIVE_TRADING_ENABLED: childMode === 'live' ? 'true' : 'false',
    SYMBOL: runtimeConfig.contract.app_symbol,
    LOG_DIR: runtimeConfig.logDir,
    LOB_SERVICE_URL: runtimeConfig.lobServiceUrl,
    DASHBOARD_PORT: String(runtimeConfig.dashboardPort),
    ...(runtimeConfig.paneIndex != null
      ? { TV_PANE_INDEX: String(runtimeConfig.paneIndex) }
      : {}),
    AUTOTRADE_CONFIG_DIR: configDir,
    FORCE_LEGACY_RUNNER: '1',
    AUTOTRADE_RUNTIME_STATE_HARDENING: baseEnv.AUTOTRADE_RUNTIME_STATE_HARDENING ? '1' : '0',
    RUNTIME_HEARTBEAT_INTERVAL_MS: String(baseEnv.RUNTIME_HEARTBEAT_INTERVAL_MS),
    RUNTIME_HEARTBEAT_STALE_MS: String(baseEnv.RUNTIME_HEARTBEAT_STALE_MS),
    RESTART_MODE: baseEnv.RESTART_MODE,
  };
}

export class InstrumentEngine {
  private readonly opts: InstrumentEngineOptions;
  private readonly runnerEntrypoint: string;
  private readonly readyTimeoutMs: number;
  private child: ChildProcess | null = null;
  private prepared: PreparedInstrumentRuntime | null = null;
  private exitPromise: Promise<void> | null = null;
  private exited = false;
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(opts: InstrumentEngineOptions) {
    this.opts = opts;
    this.runnerEntrypoint = opts.runnerEntrypoint ?? resolveDefaultRunnerEntrypoint();
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
  }

  log(stage: string, message: string): void {
    console.log(`[ENGINE:${this.opts.runtimeConfig.id}] [${stage}] ${message}`);
  }

  async initialize(): Promise<void> {
    const runtimeRoot = resolve(
      '.runtime',
      'multi-instrument',
      this.opts.orchestratorSessionId,
      this.opts.runtimeConfig.id.toLowerCase(),
    );
    const configDir = join(runtimeRoot, 'config');
    const indicatorConfigPath = join(configDir, 'indicator-config.json');

    rmSync(runtimeRoot, { recursive: true, force: true });
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(this.opts.runtimeConfig.logDir, { recursive: true });
    cpSync(this.opts.baseConfigDir, configDir, { recursive: true, force: true });

    const childConfig = buildChildIndicatorConfig(this.opts.runtimeConfig, this.opts.multiConfig);
    writeFileSync(indicatorConfigPath, JSON.stringify(childConfig, null, 2) + '\n', 'utf8');

    const childEnv = buildInstrumentChildEnv(
      this.opts.baseEnv,
      this.opts.runtimeConfig,
      configDir,
    );

    this.prepared = {
      runtimeRoot,
      configDir,
      indicatorConfigPath,
      childEnv,
      childConfig,
    };

    this.log(
      'INIT',
      `prepared config=${indicatorConfigPath} log_dir=${this.opts.runtimeConfig.logDir} lob=${this.opts.runtimeConfig.lobServiceUrl} dashboard=:${this.opts.runtimeConfig.dashboardPort} pane=${this.opts.runtimeConfig.paneIndex ?? 'auto'}`,
    );
  }

  async connectAndVerify(): Promise<void> {
    if (!this.prepared) {
      throw new Error(`[ENGINE:${this.opts.runtimeConfig.id}] initialize() must run first.`);
    }
    if (this.child) return;
    if (!existsSync(this.runnerEntrypoint)) {
      throw new Error(
        `[ENGINE:${this.opts.runtimeConfig.id}] Runner entrypoint not found: ${this.runnerEntrypoint}. Build the project before launching the orchestrator.`,
      );
    }

    this.shutdownRequested = false;
    this.exited = false;
    this.child = spawn(process.execPath, [this.runnerEntrypoint], {
      cwd: process.cwd(),
      env: this.prepared.childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });

    let resolveExitPromise: (() => void) | null = null;
    let rejectExitPromise: ((error: Error) => void) | null = null;
    const lifecyclePromise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveExitPromise = resolvePromise;
      rejectExitPromise = rejectPromise;
    });
    void lifecyclePromise.catch(() => {});
    this.exitPromise = lifecyclePromise;

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = this.child!;
      let ready = false;
      let settled = false;
      let exitSettled = false;
      let readyState = createEngineReadyState();

      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };

      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      };

      const settleExitResolve = (): void => {
        if (exitSettled) return;
        exitSettled = true;
        resolveExitPromise?.();
      };

      const settleExitReject = (error: Error): void => {
        if (exitSettled) return;
        exitSettled = true;
        rejectExitPromise?.(error);
      };

      if (!child.stdout || !child.stderr) {
        const error = new Error(
          `[ENGINE:${this.opts.runtimeConfig.id}] child process did not expose stdout/stderr pipes.`,
        );
        settleExitReject(error);
        settleReject(error);
        return;
      }

      const onLine = (line: string, isError: boolean): void => {
        const prefix = `[ENGINE:${this.opts.runtimeConfig.id}] `;
        if (isError) {
          console.error(prefix + line);
        } else {
          console.log(prefix + line);
        }

        readyState = observeEngineReadyLine(readyState, line);
        if (!ready && isEngineReadyStateSatisfied(readyState)) {
          ready = true;
          clearTimeout(readyTimer);
          this.log('READY', 'startup checks reached TradingView-ready state');
          settleResolve();
        }
      };

      const forwardStream = (source: NodeJS.ReadableStream, isError: boolean): void => {
        let buffer = '';
        source.setEncoding('utf8');
        source.on('data', chunk => {
          buffer += chunk;
          while (true) {
            const newlineIdx = buffer.indexOf('\n');
            if (newlineIdx < 0) break;
            const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
            buffer = buffer.slice(newlineIdx + 1);
            if (line.length > 0) onLine(line, isError);
          }
        });
      };

      forwardStream(child.stdout, false);
      forwardStream(child.stderr, true);

      child.once('error', err => {
        clearTimeout(readyTimer);
        const error = err instanceof Error ? err : new Error(String(err));
        settleExitReject(error);
        settleReject(error);
      });

      child.once('exit', (code, signal) => {
        this.exited = true;
        this.child = null;
        clearTimeout(readyTimer);
        const message =
          `[ENGINE:${this.opts.runtimeConfig.id}] child exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
        if (!ready) {
          const error = new Error(message);
          settleExitReject(error);
          settleReject(error);
          return;
        }
        if (this.shutdownRequested) {
          console.log(message);
          settleExitResolve();
          return;
        }
        const error = new Error(`${message} before orchestrator shutdown`);
        console.error(error.message);
        settleExitReject(error);
      });

      const readyTimer = setTimeout(() => {
        if (ready) return;
        const error = new Error(
          `[ENGINE:${this.opts.runtimeConfig.id}] startup did not reach ready state within ${this.readyTimeoutMs}ms.`,
        );
        settleExitReject(error);
        settleReject(error);
      }, this.readyTimeoutMs);
      readyTimer.unref();
    });
  }

  async runScheduler(): Promise<void> {
    if (!this.exitPromise) {
      throw new Error(`[ENGINE:${this.opts.runtimeConfig.id}] connectAndVerify() must run first.`);
    }
    await this.exitPromise;
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.doShutdown(reason);
    return this.shutdownPromise;
  }

  private async doShutdown(reason: string): Promise<void> {
    const child = this.child;
    this.shutdownRequested = true;
    if (!child || this.exited) {
      this.cleanupPreparedRuntime();
      return;
    }

    this.log('SHUTDOWN', reason);
    try {
      const outcome = await requestGracefulShutdown(child, reason, {
        forceKill: () => {
          forceTerminateChildProcess(child);
        },
      });
      if (outcome === 'forced') {
        this.log('SHUTDOWN', 'graceful IPC timed out; forced child termination');
      }
    } catch (error) {
      this.log(
        'SHUTDOWN',
        `IPC shutdown failed; forcing child termination (${error instanceof Error ? error.message : String(error)})`,
      );
      forceTerminateChildProcess(child);
    }

    try {
      await (this.exitPromise ?? Promise.resolve());
    } finally {
      this.cleanupPreparedRuntime();
    }
  }

  private cleanupPreparedRuntime(): void {
    if (!this.prepared) return;
    rmSync(this.prepared.runtimeRoot, { recursive: true, force: true });
    this.prepared = null;
  }
}
