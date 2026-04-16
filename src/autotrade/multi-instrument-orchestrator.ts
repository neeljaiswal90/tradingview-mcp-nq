import { randomUUID } from 'crypto';
import { rmSync } from 'fs';
import { resolve } from 'path';

import type { AutotradeEnv } from './env.js';
import type { IndicatorConfig } from './types.js';
import { AccountRiskArbiter } from './account-risk-arbiter.js';
import { InstrumentEngine } from './instrument-engine.js';
import {
  normalizeMultiInstrumentConfig,
  resolveEnabledInstruments,
  validateMultiInstrumentConfig,
  type MultiInstrumentConfig,
  type ResolvedInstrumentRuntimeConfig,
} from './instrument-config.js';
import { InstrumentEventBus } from './instrument-event-bus.js';

export interface OrchestratorOptions {
  baseConfig: IndicatorConfig;
  multiConfig: MultiInstrumentConfig;
  env: AutotradeEnv;
  configDir: string;
  runnerEntrypoint?: string;
}

export class MultiInstrumentOrchestrator {
  private readonly opts: OrchestratorOptions;
  private readonly orchestratorSessionId: string;
  private readonly engines = new Map<string, InstrumentEngine>();
  private readonly instrumentConfigs: ResolvedInstrumentRuntimeConfig[];
  private readonly arbiter: AccountRiskArbiter;
  private readonly eventBus: InstrumentEventBus;
  private shutdownCalled = false;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.orchestratorSessionId =
      `ORCH_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${randomUUID().slice(0, 8)}`;

    const multiConfig = normalizeMultiInstrumentConfig(opts.multiConfig);
    validateMultiInstrumentConfig(multiConfig);
    this.instrumentConfigs = resolveEnabledInstruments(opts.baseConfig, multiConfig);

    const activeConfigs = this.instrumentConfigs.filter(config => config.role === 'active');
    if (activeConfigs.length > 1) {
      throw new Error(
        '[ORCHESTRATOR] This landing supports one active engine plus shadow engines only. ' +
        'Cross-process active-active arbitration is intentionally deferred until a follow-on cutover.',
      );
    }

    this.arbiter = new AccountRiskArbiter(multiConfig, opts.baseConfig.account_equity);
    this.eventBus = new InstrumentEventBus();

    console.log(
      `[ORCHESTRATOR] session=${this.orchestratorSessionId} enabled=${multiConfig.enabled} instruments=${this.instrumentConfigs.length}`,
    );
    for (const config of this.instrumentConfigs) {
      console.log(
        `[ORCHESTRATOR]   ${config.id}: role=${config.role} log_dir=${config.logDir} lob=${config.lobServiceUrl} dashboard=:${config.dashboardPort}`,
      );
    }
  }

  async initialize(): Promise<void> {
    const initialized: string[] = [];

    for (const instrumentConfig of this.instrumentConfigs) {
      const engine = new InstrumentEngine({
        runtimeConfig: instrumentConfig,
        baseConfigDir: this.opts.configDir,
        baseEnv: this.opts.env,
        multiConfig: normalizeMultiInstrumentConfig(this.opts.multiConfig),
        orchestratorSessionId: this.orchestratorSessionId,
        runnerEntrypoint: this.opts.runnerEntrypoint,
      });

      try {
        await engine.initialize();
        this.engines.set(instrumentConfig.id, engine);
        initialized.push(instrumentConfig.id);
      } catch (err) {
        console.error(`[ORCHESTRATOR] Engine ${instrumentConfig.id} failed during initialize():`, err);
        for (const initializedId of initialized) {
          await this.engines.get(initializedId)?.shutdown(`rollback_${instrumentConfig.id}_init_failed`);
        }
        this.engines.clear();
        throw err;
      }
    }

    console.log(`[ORCHESTRATOR] All ${initialized.length} engine(s) initialized.`);
  }

  async connectAndVerify(): Promise<void> {
    for (const instrumentConfig of this.instrumentConfigs) {
      const engine = this.engines.get(instrumentConfig.id);
      if (!engine) {
        throw new Error(`[ORCHESTRATOR] Missing engine for ${instrumentConfig.id}.`);
      }
      try {
        await engine.connectAndVerify();
      } catch (err) {
        console.error(`[ORCHESTRATOR] Engine ${instrumentConfig.id} failed during connectAndVerify():`, err);
        await this.shutdown(`connect_failed_${instrumentConfig.id}`);
        throw err;
      }
    }
    console.log('[ORCHESTRATOR] All engines reached ready state.');
  }

  async run(): Promise<void> {
    const promises = [...this.engines.entries()].map(([id, engine]) =>
      engine.runScheduler().catch(err => {
        console.error(`[ORCHESTRATOR] Engine ${id} exited with error:`, err);
        throw err;
      }),
    );
    await Promise.all(promises);
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;

    console.log(`[ORCHESTRATOR] shutdown reason=${reason}`);
    await Promise.all(
      [...this.engines.values()].map(engine =>
        engine.shutdown(reason).catch(err => {
          console.error('[ORCHESTRATOR] Engine shutdown failed:', err);
        }),
      ),
    );
    this.engines.clear();
    rmSync(
      resolve('.runtime', 'multi-instrument', this.orchestratorSessionId),
      { recursive: true, force: true },
    );
    this.eventBus.removeAllListeners();
  }

  getArbiter(): AccountRiskArbiter {
    return this.arbiter;
  }

  getEventBus(): InstrumentEventBus {
    return this.eventBus;
  }

  getInstrumentConfigs(): readonly ResolvedInstrumentRuntimeConfig[] {
    return this.instrumentConfigs;
  }
}
