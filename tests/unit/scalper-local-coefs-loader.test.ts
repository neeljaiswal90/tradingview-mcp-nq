/**
 * Tests for src/autotrade/ml-entry/scalper-local-coefs-loader.ts.
 *
 * Scope (Phase 6g):
 *   1. resolveScalperModelDir — env override, promoted.json, latest fallback, null.
 *   2. loadScalperCoefsFromDir — happy all-six, missing file, parse error, contract.
 *   3. buildScalperMlDecider — returns a sync ScalperMlDecision, never throws,
 *      pure passthrough of inference reason strings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveScalperModelDir,
  loadScalperCoefsFromDir,
  buildScalperMlDecider,
  buildFallbackScalperMlDecider,
  SCALPER_BOOTSTRAP_NO_MODEL,
  SCALPER_COEFS_SCHEMA_VERSION,
} from '../../src/autotrade/ml-entry/scalper-local-coefs-loader.js';

// ─── Fixture builders ──────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'scalper-coefs-loader-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  // Restore env between tests
  delete process.env['LOB_MBO_SCALP_MODEL_DIR'];
});

function writeCoefs(
  dir: string,
  direction: 'long' | 'short',
  horizon: 1 | 3 | 5,
  overrides: Record<string, unknown> = {},
): void {
  const payload = {
    schema_version: SCALPER_COEFS_SCHEMA_VERSION,
    target_key: `${direction}_${horizon}s`,
    direction,
    horizon_sec: horizon,
    feature_order: ['qi_5', 'microprice_edge_ticks'],
    scaler_mean: [0.45, 0.2],
    scaler_scale: [0.1, 0.2],
    intercept: 0.5,
    coefficients: [2.0, 1.5],
    ...overrides,
  };
  writeFileSync(join(dir, `${direction}_${horizon}s_coefs.json`), JSON.stringify(payload));
}

function writeAllSix(dir: string, summary: Record<string, unknown> | null = { written_at: 'fixture_20260414_120000' }): void {
  writeCoefs(dir, 'long', 1);
  writeCoefs(dir, 'long', 3);
  writeCoefs(dir, 'long', 5);
  writeCoefs(dir, 'short', 1);
  writeCoefs(dir, 'short', 3);
  writeCoefs(dir, 'short', 5);
  if (summary) {
    writeFileSync(join(dir, 'training_summary.json'), JSON.stringify(summary));
  }
}

// ─── resolveScalperModelDir ─────────────────────────────────────────────────

describe('resolveScalperModelDir', () => {
  it('honors LOB_MBO_SCALP_MODEL_DIR env var when it points at an existing directory', () => {
    const envDir = join(tmp, 'env_model');
    mkdirSync(envDir, { recursive: true });
    process.env['LOB_MBO_SCALP_MODEL_DIR'] = envDir;
    const resolved = resolveScalperModelDir(join(tmp, 'repo'));
    expect(resolved).toBe(envDir);
  });

  it('falls through env when the env path does not exist', () => {
    process.env['LOB_MBO_SCALP_MODEL_DIR'] = join(tmp, 'does_not_exist');
    // Build a valid promoted.json chain instead
    const repo = join(tmp, 'repo');
    const versionsDir = join(repo, 'models', 'lob_mbo_scalp', 'versions', '20260414_120000');
    mkdirSync(versionsDir, { recursive: true });
    writeFileSync(
      join(repo, 'models', 'lob_mbo_scalp', 'promoted.json'),
      JSON.stringify({ version: '20260414_120000' }),
    );
    const resolved = resolveScalperModelDir(repo);
    expect(resolved).toBe(versionsDir);
  });

  it('reads promoted.json when env is unset', () => {
    const repo = join(tmp, 'repo');
    const versionsDir = join(repo, 'models', 'lob_mbo_scalp', 'versions', '20260414_120000');
    mkdirSync(versionsDir, { recursive: true });
    writeFileSync(
      join(repo, 'models', 'lob_mbo_scalp', 'promoted.json'),
      JSON.stringify({ version: '20260414_120000' }),
    );
    const resolved = resolveScalperModelDir(repo);
    expect(resolved).toBe(versionsDir);
  });

  it('falls through to latest subdirectory when promoted.json is missing', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, 'models', 'lob_mbo_scalp', 'versions', '20260401_000000'), { recursive: true });
    mkdirSync(join(repo, 'models', 'lob_mbo_scalp', 'versions', '20260414_120000'), { recursive: true });
    const resolved = resolveScalperModelDir(repo);
    expect(resolved).toBe(join(repo, 'models', 'lob_mbo_scalp', 'versions', '20260414_120000'));
  });

  it('returns null when nothing resolves', () => {
    const repo = join(tmp, 'empty_repo');
    mkdirSync(repo, { recursive: true });
    expect(resolveScalperModelDir(repo)).toBeNull();
  });
});

// ─── loadScalperCoefsFromDir ────────────────────────────────────────────────

describe('loadScalperCoefsFromDir', () => {
  it('returns model_dir_missing when the path does not exist', () => {
    const r = loadScalperCoefsFromDir(join(tmp, 'nope'));
    expect(r.status).toBe('model_dir_missing');
    expect(Object.keys(r.coefsByTargetKey).length).toBe(0);
  });

  it('returns coefs_file_missing when one of the six files is absent', () => {
    const dir = join(tmp, 'partial');
    mkdirSync(dir);
    writeCoefs(dir, 'long', 1);
    writeCoefs(dir, 'long', 3);
    // Missing long_5s
    const r = loadScalperCoefsFromDir(dir);
    expect(r.status).toBe('coefs_file_missing');
    expect(r.detail).toMatch(/long_5s_coefs\.json/);
  });

  it('returns parse_error on invalid JSON', () => {
    const dir = join(tmp, 'parse');
    mkdirSync(dir);
    writeAllSix(dir);
    writeFileSync(join(dir, 'long_3s_coefs.json'), '{not json');
    const r = loadScalperCoefsFromDir(dir);
    expect(r.status).toBe('parse_error');
  });

  it('returns contract_violation on schema_version drift', () => {
    const dir = join(tmp, 'schema');
    mkdirSync(dir);
    writeAllSix(dir);
    writeCoefs(dir, 'long', 3, { schema_version: '0.0.99' });
    const r = loadScalperCoefsFromDir(dir);
    expect(r.status).toBe('contract_violation');
    expect(r.detail).toMatch(/schema_version/);
  });

  it('returns contract_violation on target_key mismatch', () => {
    const dir = join(tmp, 'target');
    mkdirSync(dir);
    writeAllSix(dir);
    writeCoefs(dir, 'long', 3, { target_key: 'short_3s' });
    const r = loadScalperCoefsFromDir(dir);
    expect(r.status).toBe('contract_violation');
  });

  it('returns contract_violation on length mismatch', () => {
    const dir = join(tmp, 'len');
    mkdirSync(dir);
    writeAllSix(dir);
    writeCoefs(dir, 'long', 3, { scaler_mean: [0.45] });
    const r = loadScalperCoefsFromDir(dir);
    expect(r.status).toBe('contract_violation');
  });

  it('loads all six successfully with training_summary.json version', () => {
    const dir = join(tmp, 'happy');
    mkdirSync(dir);
    writeAllSix(dir);
    const r = loadScalperCoefsFromDir(dir);
    expect(r.status).toBe('loaded');
    expect(r.modelVersion).toBe('fixture_20260414_120000');
    expect(Object.keys(r.coefsByTargetKey).length).toBe(6);
    expect(r.coefsByTargetKey['long_3s']!.feature_order).toEqual(['qi_5', 'microprice_edge_ticks']);
  });

  it('falls back to the directory name when training_summary.json is absent', () => {
    const dir = join(tmp, '20260414_120000');
    mkdirSync(dir);
    writeAllSix(dir, null);
    const r = loadScalperCoefsFromDir(dir);
    expect(r.status).toBe('loaded');
    expect(r.modelVersion).toBe('20260414_120000');
  });
});

// ─── buildScalperMlDecider ─────────────────────────────────────────────────

describe('buildScalperMlDecider', () => {
  function happyDecider() {
    const dir = join(tmp, 'happy');
    mkdirSync(dir);
    writeAllSix(dir);
    const r = loadScalperCoefsFromDir(dir);
    expect(r.status).toBe('loaded');
    return buildScalperMlDecider({ coefsByTargetKey: r.coefsByTargetKey, modelVersion: r.modelVersion });
  }

  it('returns a ready=true decision for a well-formed feature dict', () => {
    const decider = happyDecider();
    const d = decider('long', 3, { qi_5: 0.7, microprice_edge_ticks: 0.5 });
    expect(d.ready).toBe(true);
    expect(d.pFavorDirection).not.toBeNull();
    expect(d.pFavorDirection!).toBeGreaterThan(0);
    expect(d.pFavorDirection!).toBeLessThanOrEqual(1);
    expect(d.direction).toBe('long');
    expect(d.horizonSec).toBe(3);
    expect(d.targetKey).toBe('long_3s');
    expect(d.modelVersion).toBe('fixture_20260414_120000');
    expect(d.reason).toBeNull();
  });

  it('returns ready=false with missing_feature reason when a required feature is absent', () => {
    const decider = happyDecider();
    const d = decider('long', 3, { qi_5: 0.7 });
    expect(d.ready).toBe(false);
    expect(d.pFavorDirection).toBeNull();
    expect(d.reason).toBe('missing_feature:microprice_edge_ticks');
  });

  it('returns target_not_loaded when the decider was given a partial coefs map', () => {
    const decider = buildScalperMlDecider({
      coefsByTargetKey: {}, // intentionally empty
      modelVersion: 'test',
    });
    const d = decider('long', 3, { qi_5: 0.7, microprice_edge_ticks: 0.5 });
    expect(d.ready).toBe(false);
    expect(d.reason).toBe('target_not_loaded:long_3s');
  });

  it('never throws on completely invalid features', () => {
    const decider = happyDecider();
    expect(() => decider('long', 3, { qi_5: Number.NaN })).not.toThrow();
    const d = decider('long', 3, { qi_5: Number.NaN, microprice_edge_ticks: 0.5 });
    expect(d.ready).toBe(false);
    expect(d.reason).toMatch(/^non_finite_feature/);
  });
});

// ─── Phase 8 Option B — bootstrap fallback decider ─────────────────────────

describe('buildFallbackScalperMlDecider', () => {
  it('always returns ready=false with the bootstrap sentinel reason', () => {
    const decider = buildFallbackScalperMlDecider();
    const d = decider('long', 3, { qi_5: 0.7, microprice_edge_ticks: 0.5 });
    expect(d.ready).toBe(false);
    expect(d.pFavorDirection).toBeNull();
    expect(d.reason).toBe(SCALPER_BOOTSTRAP_NO_MODEL);
    expect(d.modelVersion).toBe(SCALPER_BOOTSTRAP_NO_MODEL);
    expect(d.featureSchema).toEqual([]);
    expect(d.httpStatus).toBeNull();
  });

  it('stamps the target_key, direction, and horizonSec correctly', () => {
    const decider = buildFallbackScalperMlDecider();
    for (const direction of ['long', 'short'] as const) {
      for (const horizon of [1, 3, 5] as const) {
        const d = decider(direction, horizon, {});
        expect(d.direction).toBe(direction);
        expect(d.horizonSec).toBe(horizon);
        expect(d.targetKey).toBe(`${direction}_${horizon}s`);
      }
    }
  });

  it('never inspects the features argument — empty / malformed dicts are safe', () => {
    const decider = buildFallbackScalperMlDecider();
    // None of these should throw, all should return the same sentinel.
    const cases: Array<Record<string, number | null | undefined>> = [
      {},
      { qi_5: Number.NaN },
      { microprice_edge_ticks: null, qi_5: undefined },
      { random_key_the_model_never_saw: 42 },
    ];
    for (const features of cases) {
      const d = decider('long', 3, features);
      expect(d.ready).toBe(false);
      expect(d.reason).toBe(SCALPER_BOOTSTRAP_NO_MODEL);
    }
  });

  it('SCALPER_BOOTSTRAP_NO_MODEL is the literal "bootstrap_no_model" sentinel', () => {
    // Lock the exact string — dashboards, trainers, and labelers all
    // filter on this value to exclude bootstrap-mode rows from AUC /
    // calibration math. Any rename here breaks those consumers silently.
    expect(SCALPER_BOOTSTRAP_NO_MODEL).toBe('bootstrap_no_model');
  });
});
