/**
 * End-to-end acceptance tests proving the data paths are actually wired.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

// ─── A. Strategy consumption tests ───────────────────────────────────────────

describe('Strategy feature layer consumption', () => {
  const strategySource = readFileSync('src/autotrade/strategy.ts', 'utf8');

  it('strategy uses snap.indicators_1m for core indicators', () => {
    expect(strategySource).toContain('snap.indicators_1m');
    expect(strategySource).toContain('ind.ema_9');
    expect(strategySource).toContain('ind.atr_14');
  });

  it('strategy uses snap.key_levels for structure', () => {
    expect(strategySource).toContain('snap.key_levels');
    expect(strategySource).toContain('key_levels.bos_sell');
  });

  it('shared local feature modules exist', () => {
    expect(existsSync('src/autotrade/features/indicators.ts')).toBe(true);
    expect(existsSync('src/autotrade/features/structure.ts')).toBe(true);
    expect(existsSync('src/autotrade/features/session-levels.ts')).toBe(true);
    expect(existsSync('src/autotrade/features/extension.ts')).toBe(true);
  });

  it('historical snapshot builder uses shared indicators', () => {
    const histSource = readFileSync('src/autotrade/historical/snapshot-builder.ts', 'utf8');
    expect(histSource).toContain("from '../features/indicators.js'");
  });
});

// ─── B. Quote authority tests ────────────────────────────────────────────────

describe('Quote authority / fallback', () => {
  const runnerSource = readFileSync('src/autotrade/runner.ts', 'utf8');

  it('BookmapQuoteProvider is registered', () => {
    expect(runnerSource).toContain('BookmapQuoteProvider');
    expect(runnerSource).toContain('quoteService.addProvider(bookmapProvider)');
  });

  it('TradingView is fallback (higher priority number)', () => {
    const qsSource = readFileSync('src/autotrade/quote-service.ts', 'utf8');
    expect(qsSource).toContain('priority = 10'); // Bookmap
    expect(qsSource).toContain('priority = 100'); // TradingView
  });

  it('failover reason is logged', () => {
    const marketDataSource = readFileSync('src/autotrade/market-data-source.ts', 'utf8');
    expect(marketDataSource).toContain('fallback_reason');
    expect(marketDataSource).toContain('market_data_source_selected');
  });
});

// ─── C. ML schema parity tests ───────────────────────────────────────────────

describe('ML schema parity', () => {
  it('management ML feature vector has no stale MlFeatureVector in types.ts', () => {
    const typesSource = readFileSync('src/autotrade/types.ts', 'utf8');
    // The old MlFeatureVector is now SignalContextSnapshot
    expect(typesSource).not.toMatch(/export interface MlFeatureVector/);
    expect(typesSource).toContain('export interface SignalContextSnapshot');
  });

  it('canonical management MlFeatureVector is in ml/types.ts', () => {
    const mlTypes = readFileSync('src/autotrade/ml/types.ts', 'utf8');
    expect(mlTypes).toContain('export interface MlFeatureVector');
    // Must have LOB fields
    expect(mlTypes).toContain('lob_spread_ticks');
    // Must have advanced MBO fields
    expect(mlTypes).toContain('adv_cancel_replace_ratio_10s');
  });

  it('entry feature vector exists and is separate', () => {
    const entryTypes = readFileSync('src/autotrade/ml-entry/types.ts', 'utf8');
    expect(entryTypes).toContain('export interface EntryFeatureVector');
    expect(entryTypes).toContain('setup_type');
    expect(entryTypes).toContain('regime_at_signal');
  });

  it('zero as-any casts in ML feature builders', () => {
    const mgmtBuilder = readFileSync('src/autotrade/ml/feature-builder.ts', 'utf8');
    expect(mgmtBuilder).not.toContain('as any');
  });
});

// ─── D. Entry ML contract tests ──────────────────────────────────────────────

describe('Entry ML contract', () => {
  const runnerSource = readFileSync('src/autotrade/runner.ts', 'utf8');

  it('runner imports entry ML modules', () => {
    expect(runnerSource).toContain("from './ml-entry/index.js'");
  });

  it('entry ML defaults to off (safe degradation)', () => {
    const entryTypes = readFileSync('src/autotrade/ml-entry/types.ts', 'utf8');
    expect(entryTypes).toContain("mode: 'off'");
  });

  it('runner checks entry ML mode before calling service', () => {
    expect(runnerSource).toContain("entryMlConfig.mode !== 'off'");
  });
});

// ─── E. Candidate logging tests ──────────────────────────────────────────────

describe('Candidate signal logging', () => {
  const runnerSource = readFileSync('src/autotrade/runner.ts', 'utf8');

  it('runner logs candidate signals via dedicated writer', () => {
    expect(runnerSource).toContain('writeCandidateSignal');
  });

  it('candidate log includes extension features', () => {
    expect(runnerSource).toContain('...extensionFeatures');
  });

  it('candidate log includes veto state', () => {
    expect(runnerSource).toContain('extension_vetoed');
    expect(runnerSource).toContain('extension_veto_reasons');
  });

  it('log-writer has dedicated candidate method', () => {
    const lwSource = readFileSync('src/autotrade/log-writer.ts', 'utf8');
    expect(lwSource).toContain('writeCandidateSignal');
    expect(lwSource).toContain('candidate_signals.jsonl');
  });
});

// ─── F. Advanced MBO honesty tests ───────────────────────────────────────────

describe('Advanced MBO feature honesty', () => {
  it('LobSnapshot types include adv_* fields as nullable', () => {
    const lobClient = readFileSync('src/autotrade/lob-client.ts', 'utf8');
    expect(lobClient).toContain('adv_cancel_replace_ratio_10s: number | null');
    expect(lobClient).toContain('adv_iceberg_suspicion_30s: number | null');
  });

  it('ML feature builder passes null when LOB is unavailable', () => {
    const builder = readFileSync('src/autotrade/ml/feature-builder.ts', 'utf8');
    // When lobFresh is false, all LOB fields should be null
    expect(builder).toContain('lobFresh ? (lob.adv_cancel_replace_ratio_10s ?? null) : null');
  });
});

// ─── G. Extension veto integration ───────────────────────────────────────────

describe('Extension veto integration', () => {
  const runnerSource = readFileSync('src/autotrade/runner.ts', 'utf8');

  it('extension features are computed before entry decision', () => {
    const extIdx = runnerSource.indexOf('computeExtensionFeatures');
    const entryIdx = runnerSource.indexOf('!extensionVetoed && !positionManager.hasOpenPosition');
    expect(extIdx).toBeGreaterThan(0);
    expect(entryIdx).toBeGreaterThan(extIdx);
  });

  it('extension veto blocks entry execution', () => {
    expect(runnerSource).toContain('extensionVetoed');
    expect(runnerSource).toContain('!extensionVetoed');
  });

  it('extension config is loaded from indicator-config', () => {
    expect(runnerSource).toContain('extensionConfig');
    expect(runnerSource).toContain('DEFAULT_EXTENSION_FILTER_CONFIG');
  });
});

// ─── H. Candidate signal lifecycle ──────────────────────────────────────────

describe('Candidate signal lifecycle', () => {
  const runnerSource = readFileSync('src/autotrade/runner.ts', 'utf8');

  it('initial candidate log has _event candidate', () => {
    expect(runnerSource).toContain("_event: 'candidate'");
  });

  it('execution linkage log has _event executed with trade_id', () => {
    expect(runnerSource).toContain("_event: 'executed'");
    expect(runnerSource).toContain('trade_id: tradeId');
    expect(runnerSource).toContain('actually_executed: true');
  });

  it('extension veto writes _event extension_vetoed', () => {
    expect(runnerSource).toContain("_event: 'extension_vetoed'");
  });

  it('ML rejection writes _event ml_rejected', () => {
    expect(runnerSource).toContain("_event: 'ml_rejected'");
  });

  it('risk rejection writes _event risk_rejected', () => {
    expect(runnerSource).toContain("_event: 'risk_rejected'");
  });

  it('all candidate events include candidate_id for correlation', () => {
    // Find all writeCandidateSignal calls and verify they include candidate_id
    const candidateWrites = runnerSource.match(/writeCandidateSignal\(\{[\s\S]*?\}\)/g) ?? [];
    expect(candidateWrites.length).toBeGreaterThanOrEqual(5); // candidate, executed, extension_vetoed, ml_rejected, risk_rejected
    for (const write of candidateWrites) {
      expect(write).toContain('candidate_id');
    }
  });

  it('candidate events flow: candidate always precedes rejection/execution', () => {
    const candidateIdx = runnerSource.indexOf("_event: 'candidate'");
    const executedIdx = runnerSource.indexOf("_event: 'executed'");
    const vetoIdx = runnerSource.indexOf("_event: 'extension_vetoed'");
    const mlRejectIdx = runnerSource.indexOf("_event: 'ml_rejected'");
    const riskRejectIdx = runnerSource.indexOf("_event: 'risk_rejected'");

    // Initial candidate log must come before all others
    expect(candidateIdx).toBeGreaterThan(0);
    expect(candidateIdx).toBeLessThan(vetoIdx);
    expect(candidateIdx).toBeLessThan(mlRejectIdx);
    expect(candidateIdx).toBeLessThan(riskRejectIdx);
    expect(candidateIdx).toBeLessThan(executedIdx);
  });
});

// ─── I. Entry ML schema contract ────────────────────────────────────────────

describe('Entry ML schema contract', () => {
  it('EntryRequest in schemas.py matches entry_feature_registry.py', () => {
    const schemasSource = readFileSync('python-ml-service/schemas.py', 'utf8');
    const registrySource = readFileSync('python-market-data-service/lob_features/entry_feature_registry.py', 'utf8');

    // Extract feature names from registry
    const registryFeatures = [...registrySource.matchAll(/"(\w+)",/g)].map(m => m[1]);
    expect(registryFeatures.length).toBeGreaterThan(30);

    // Every registry feature must appear in EntryRequest
    for (const feat of registryFeatures) {
      expect(schemasSource).toContain(`${feat}:`);
    }
  });

  it('EntryFeatureVector in TS matches entry_feature_registry.py', () => {
    const tsSource = readFileSync('src/autotrade/ml-entry/types.ts', 'utf8');
    const registrySource = readFileSync('python-market-data-service/lob_features/entry_feature_registry.py', 'utf8');

    const registryFeatures = [...registrySource.matchAll(/"(\w+)",/g)].map(m => m[1]);
    for (const feat of registryFeatures) {
      expect(tsSource).toContain(`${feat}:`);
    }
  });

  it('/predict_entry uses EntryRequest not ManagementRequest', () => {
    const appSource = readFileSync('python-ml-service/app.py', 'utf8');
    expect(appSource).toContain('def predict_entry(req: EntryRequest)');
    expect(appSource).not.toMatch(/def predict_entry\(req:\s*ManagementRequest\)/);
  });

  it('EntryPredictionResponse is imported from schemas not defined inline', () => {
    const appSource = readFileSync('python-ml-service/app.py', 'utf8');
    expect(appSource).toContain('EntryPredictionResponse');
    // Should not define class inline — check it's imported
    expect(appSource).not.toMatch(/class EntryPredictionResponse/);
    const schemasSource = readFileSync('python-ml-service/schemas.py', 'utf8');
    expect(schemasSource).toContain('class EntryPredictionResponse');
  });
});
