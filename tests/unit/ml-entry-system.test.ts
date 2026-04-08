/**
 * Tests for the ML entry confirmation system.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Entry ML integration contracts', () => {
  const runnerSource = readFileSync('src/autotrade/runner.ts', 'utf8');

  it('runner imports entry ML modules', () => {
    expect(runnerSource).toContain("from './ml-entry/index.js'");
  });

  it('runner resolves entryMlConfig from effectiveConfig', () => {
    expect(runnerSource).toContain('entryMlConfig');
    expect(runnerSource).toContain('DEFAULT_ENTRY_ML_CONFIG');
  });

  it('entry ML gate runs before risk check', () => {
    const mlGateIdx = runnerSource.indexOf('getEntryMlDecision(');
    const riskCheckIdx = runnerSource.indexOf('riskManager.preTradeCheck(bestSetup');
    expect(mlGateIdx).toBeGreaterThan(0);
    expect(riskCheckIdx).toBeGreaterThan(mlGateIdx);
  });

  it('entry ML gate runs after strategy signal generation', () => {
    const signalIdx = runnerSource.indexOf('generateSignal(snap, effectiveConfig');
    const mlGateIdx = runnerSource.indexOf('getEntryMlDecision(');
    expect(signalIdx).toBeGreaterThan(0);
    expect(mlGateIdx).toBeGreaterThan(signalIdx);
  });

  it('entry ML mode=off does not block (always confirms)', () => {
    // The decision engine returns { confirmed: true, reason: 'entry_ml_off' }
    const decisionSource = readFileSync('src/autotrade/ml-entry/decision-engine.ts', 'utf8');
    expect(decisionSource).toContain("mode === 'off'");
    expect(decisionSource).toContain("confirmed: true");
    expect(decisionSource).toContain("entry_ml_off");
  });

  it('entry ML mode=rank_only does not block (always confirms)', () => {
    const decisionSource = readFileSync('src/autotrade/ml-entry/decision-engine.ts', 'utf8');
    expect(decisionSource).toContain("mode === 'rank_only'");
  });

  it('entry ML rejection is logged to signals', () => {
    expect(runnerSource).toContain('entry_ml:');
    expect(runnerSource).toContain('[ENTRY-ML] Rejected');
  });

  it('entry ML confirmation is logged', () => {
    expect(runnerSource).toContain('[ENTRY-ML] Confirmed');
  });

  it('entry ML errors are non-fatal', () => {
    expect(runnerSource).toContain('[ENTRY-ML] Error (non-fatal)');
  });

  it('entry ML uses signal context (LOB sidecar)', () => {
    expect(runnerSource).toContain('lobClient.startSignalContext(');
    expect(runnerSource).toContain('lobClient.endSignalContext(');
  });

  it('entry ML decision is logged to ml_management_actions.jsonl', () => {
    expect(runnerSource).toContain('entry_ml_decision');
  });

  it('default entry_ml config has mode=off', () => {
    const typesSource = readFileSync('src/autotrade/ml-entry/types.ts', 'utf8');
    expect(typesSource).toContain("mode: 'off'");
  });

  it('entry ML is separate from management ML', () => {
    // Entry ML lives in ml-entry/, management ML in ml/
    const entryIndex = readFileSync('src/autotrade/ml-entry/index.ts', 'utf8');
    expect(entryIndex).toContain('getEntryMlDecision');
    expect(entryIndex).not.toContain('getMlDecision');

    const mgmtIndex = readFileSync('src/autotrade/ml/index.ts', 'utf8');
    expect(mgmtIndex).toContain('getMlDecision');
    expect(mgmtIndex).not.toContain('getEntryMlDecision');
  });
});
