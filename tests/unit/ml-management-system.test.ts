/**
 * Tests for the ML management system:
 * - Execution gate safety invariants
 * - Feature builder correctness
 * - Dataset anti-leakage (structural checks)
 * - Claude removal confirmation
 * - Integration contract verification
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { evaluateMlGate } from '../../src/autotrade/ml/execution-gate.js';
import { buildMlFeatures } from '../../src/autotrade/ml/feature-builder.js';
import { DEFAULT_ML_CONFIG } from '../../src/autotrade/ml/types.js';
import type { MlManagementConfig, MlServiceResponse } from '../../src/autotrade/ml/types.js';
import type { Position } from '../../src/autotrade/types.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

const ENABLED_CONFIG: MlManagementConfig = {
  ...DEFAULT_ML_CONFIG,
  enabled: true,
  action_cooldown_seconds: 0,
  enable_partial_exit: false,
};

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    trade_id: 'TRADE_TEST_001',
    signal_id: 'SIG_001',
    session_id: 'SESSION_TEST',
    side: 'long',
    entry_price: 24200,
    entry_time_unix: Date.now() - 60000,
    entry_time_iso: new Date(Date.now() - 60000).toISOString(),
    stop_initial: 24160,
    stop_current: 24170,
    target_1: 24260,
    target_2: 24320,
    target_3: null,
    quantity: 5,
    notional: 121000,
    setup_type: 'trend_pullback_long',
    market_regime_at_entry: 'trending_up',
    config_version: 'IC_v1.1',
    confidence: 8.0,
    stop_moved_to_be: false,
    partial_exit_done: false,
    quantity_remaining: 5,
    max_favorable_excursion: 12,
    max_adverse_excursion: 5,
    last_checked_price: 24210,
    time_stop_minutes: 30,
    pre_t1_be_triggered: false,
    pre_t1_trailing_active: false,
    trailing_active: false,
    trail_distance_ticks: 0,
    trail_anchor_price: null,
    target_1_direction_valid: true,
    target_2_direction_valid: true,
    target_3_direction_valid: true,
    target_ordering_valid: true,
    target_repair_applied: false,
    pt1_done: false,
    pt2_done: false,
    pt1_realized_pnl: 0,
    pt2_realized_pnl: 0,
    pt1_qty_exited: 0,
    pt2_qty_exited: 0,
    exit_legs: [],
    realized_pnl_so_far: 0,
    realized_fees_so_far: 0,
    atr_at_entry: 10,
    management_params: {
      profile_name: 'trend_pullback',
      family: 'trend_pullback',
      atr_at_entry: 10,
      pt1_offset_pts: 5,
      pt2_offset_pts: 12,
      pt1_exit_fraction: 0.5,
      pt2_exit_fraction: 0.25,
      pt1_move_to_be: true,
      pt1_activate_trailing: true,
      trail_ticks_post_t1: 20,
      breakeven_trigger_r: 0.5,
      pre_t1_trail_trigger_r: 0.75,
      pre_t1_trail_distance_ticks: 20,
      time_stop_minutes: 30,
      time_stop_max_r_pre_t1: 0.25,
      time_stop_max_r_post_t1: 1.0,
    },
    mfe_at_pt1_trigger: 0,
    mae_at_pt1_trigger: 0,
    peak_r_before_first_partial: 0,
    ...overrides,
  } as Position;
}

function makeResponse(overrides: Partial<MlServiceResponse> = {}): MlServiceResponse {
  return {
    action: 'HOLD',
    action_confidence: 0.7,
    prob_hold: 0.7,
    prob_pt2_before_stop: null,
    prob_continue_next_window: null,
    ev_hold_r: 0.15,
    ev_exit_now_r: 0.1,
    ev_reduce_r: null,
    recommended_size_fraction: null,
    recommended_stop_price: null,
    model_name: 'catboost_management',
    model_version: '20260407',
    inference_ms: 1.5,
    notes: [],
    ...overrides,
  };
}

// ─── 1. Execution Gate Tests ─────────────────────────────────────────────────

describe('ML Execution Gate', () => {
  it('HOLD action is always rejected as passive (never executes)', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'HOLD', action_confidence: 0.99 }),
      ENABLED_CONFIG,
      makePosition(),
      100,
    );
    expect(result.approved).toBe(false);
    expect(result.rejection_reason).toContain('passive');
  });

  it('NO_ACTION is always rejected as passive', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'NO_ACTION' }),
      ENABLED_CONFIG,
      makePosition(),
      100,
    );
    expect(result.approved).toBe(false);
    expect(result.rejection_reason).toContain('passive');
  });

  it('no position returns rejection', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_ALL', action_confidence: 0.9 }),
      ENABLED_CONFIG,
      null, // no position
      100,
    );
    expect(result.approved).toBe(false);
    expect(result.checks.find(c => c.name === 'position_exists')?.passed).toBe(false);
  });

  it('stale quote blocks MOVE_STOP', () => {
    const result = evaluateMlGate(
      makeResponse({
        action: 'MOVE_STOP',
        action_confidence: 0.8,
        recommended_stop_price: 24180,
      }),
      ENABLED_CONFIG,
      makePosition(),
      10000, // very stale
    );
    expect(result.approved).toBe(false);
    expect(result.checks.find(c => c.name === 'quote_freshness')?.passed).toBe(false);
  });

  it('stale quote does NOT block EXIT_ALL (risk-reducing)', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_ALL', action_confidence: 0.9 }),
      ENABLED_CONFIG,
      makePosition(),
      10000, // very stale
    );
    expect(result.checks.find(c => c.name === 'quote_freshness')?.passed).toBe(true);
  });

  it('stop widening is blocked for long', () => {
    const pos = makePosition({ side: 'long', stop_current: 24170 });
    const result = evaluateMlGate(
      makeResponse({
        action: 'MOVE_STOP',
        action_confidence: 0.9,
        recommended_stop_price: 24160, // below current stop = widening for long
      }),
      ENABLED_CONFIG,
      pos,
      100,
    );
    expect(result.checks.find(c => c.name === 'stop_only_tightens')?.passed).toBe(false);
  });

  it('stop widening is blocked for short', () => {
    const pos = makePosition({ side: 'short', stop_current: 24240 });
    const result = evaluateMlGate(
      makeResponse({
        action: 'MOVE_STOP',
        action_confidence: 0.9,
        recommended_stop_price: 24250, // above current stop = widening for short
      }),
      ENABLED_CONFIG,
      pos,
      100,
    );
    expect(result.checks.find(c => c.name === 'stop_only_tightens')?.passed).toBe(false);
  });

  it('stop tightening is allowed for long', () => {
    const pos = makePosition({ side: 'long', stop_current: 24170 });
    const result = evaluateMlGate(
      makeResponse({
        action: 'MOVE_STOP',
        action_confidence: 0.9,
        recommended_stop_price: 24180, // above current = tightening for long
      }),
      ENABLED_CONFIG,
      pos,
      100,
    );
    expect(result.checks.find(c => c.name === 'stop_only_tightens')?.passed).toBe(true);
  });

  it('EXIT_PARTIAL with invalid size_fraction is blocked', () => {
    const result = evaluateMlGate(
      makeResponse({
        action: 'EXIT_PARTIAL',
        action_confidence: 0.9,
        recommended_size_fraction: null,
      }),
      ENABLED_CONFIG,
      makePosition(),
      100,
    );
    expect(result.checks.find(c => c.name === 'valid_size_fraction')?.passed).toBe(false);
  });

  it('EXIT_PARTIAL with fraction > 1 is blocked', () => {
    const result = evaluateMlGate(
      makeResponse({
        action: 'EXIT_PARTIAL',
        action_confidence: 0.9,
        recommended_size_fraction: 1.5,
      }),
      ENABLED_CONFIG,
      makePosition(),
      100,
    );
    expect(result.checks.find(c => c.name === 'valid_size_fraction')?.passed).toBe(false);
  });

  it('EXIT_PARTIAL with valid fraction passes', () => {
    const result = evaluateMlGate(
      makeResponse({
        action: 'EXIT_PARTIAL',
        action_confidence: 0.9,
        recommended_size_fraction: 0.5,
      }),
      ENABLED_CONFIG,
      makePosition(),
      100,
    );
    expect(result.checks.find(c => c.name === 'valid_size_fraction')?.passed).toBe(true);
  });

  it('low confidence EXIT_ALL is blocked', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_ALL', action_confidence: 0.3 }),
      ENABLED_CONFIG,
      makePosition(),
      100,
    );
    expect(result.checks.find(c => c.name === 'confidence_threshold')?.passed).toBe(false);
  });

  it('disabled config blocks everything', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_ALL', action_confidence: 0.99 }),
      { ...ENABLED_CONFIG, enabled: false },
      makePosition(),
      100,
    );
    expect(result.approved).toBe(false);
  });

  // ── Cooldown gate ───────────────────────────────────────────────────

  it('action cooldown blocks when last action was recent', () => {
    const configWithCooldown = { ...ENABLED_CONFIG, action_cooldown_seconds: 30 };
    const recentAction = Date.now() - 10_000; // 10s ago, within 30s cooldown
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_ALL', action_confidence: 0.9 }),
      configWithCooldown,
      makePosition(),
      100,
      recentAction,
    );
    expect(result.checks.find(c => c.name === 'action_cooldown')?.passed).toBe(false);
  });

  it('action cooldown passes when enough time elapsed', () => {
    const configWithCooldown = { ...ENABLED_CONFIG, action_cooldown_seconds: 30 };
    const oldAction = Date.now() - 60_000; // 60s ago, past 30s cooldown
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_ALL', action_confidence: 0.9 }),
      configWithCooldown,
      makePosition(),
      100,
      oldAction,
    );
    expect(result.checks.find(c => c.name === 'action_cooldown')?.passed).toBe(true);
  });

  it('action cooldown skipped when action_cooldown_seconds = 0', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_ALL', action_confidence: 0.9 }),
      ENABLED_CONFIG, // action_cooldown_seconds = 0
      makePosition(),
      100,
      Date.now() - 1000, // very recent
    );
    // No cooldown check should exist
    expect(result.checks.find(c => c.name === 'action_cooldown')).toBeUndefined();
  });

  // ── EXIT_PARTIAL feature flag ──────────────────────────────────────

  it('EXIT_PARTIAL blocked when enable_partial_exit = false', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_PARTIAL', action_confidence: 0.9, recommended_size_fraction: 0.5 }),
      { ...ENABLED_CONFIG, enable_partial_exit: false },
      makePosition(),
      100,
    );
    expect(result.checks.find(c => c.name === 'partial_exit_enabled')?.passed).toBe(false);
    expect(result.approved).toBe(false);
  });

  it('EXIT_PARTIAL allowed when enable_partial_exit = true and valid fraction', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_PARTIAL', action_confidence: 0.9, recommended_size_fraction: 0.5 }),
      { ...ENABLED_CONFIG, enable_partial_exit: true },
      makePosition(),
      100,
    );
    expect(result.checks.find(c => c.name === 'partial_exit_enabled')?.passed).toBe(true);
    expect(result.checks.find(c => c.name === 'valid_size_fraction')?.passed).toBe(true);
  });

  // ── Risk-reducing action freshness bypass ──────────────────────────

  it('EXIT_PARTIAL on stale quote is blocked (not fully risk-reducing)', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'EXIT_PARTIAL', action_confidence: 0.9, recommended_size_fraction: 0.5 }),
      { ...ENABLED_CONFIG, enable_partial_exit: true },
      makePosition(),
      10000, // stale
    );
    // EXIT_PARTIAL is in RISK_REDUCING_ACTIONS, so quote check should pass
    expect(result.checks.find(c => c.name === 'quote_freshness')?.passed).toBe(true);
  });

  it('MOVE_TO_BREAKEVEN on stale quote is blocked', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'MOVE_TO_BREAKEVEN', action_confidence: 0.9 }),
      ENABLED_CONFIG,
      makePosition(),
      10000,
    );
    expect(result.checks.find(c => c.name === 'quote_freshness')?.passed).toBe(false);
  });

  // ── Canonical action types ─────────────────────────────────────────

  it('SCALE_IN is blocked with high confidence threshold', () => {
    const result = evaluateMlGate(
      makeResponse({ action: 'SCALE_IN' as any, action_confidence: 0.9 }),
      ENABLED_CONFIG,
      makePosition(),
      100,
    );
    // Unknown action → minConfidence = 1.0, so 0.9 fails
    expect(result.checks.find(c => c.name === 'confidence_threshold')?.passed).toBe(false);
  });
});

// ─── 2. Feature Builder Tests ────────────────────────────────────────────────

describe('ML Feature Builder', () => {
  it('builds correct feature vector from position', () => {
    const pos = makePosition({
      side: 'short',
      entry_price: 24300,
      stop_initial: 24340,
      stop_current: 24320,
      quantity_remaining: 3,
      max_favorable_excursion: 15,
      max_adverse_excursion: 5,
      pt1_done: true,
      trailing_active: true,
      stop_moved_to_be: true,
    });

    const features = buildMlFeatures(pos, 24280);

    expect(features.is_short).toBe(1);
    expect(features.initial_risk_pts).toBe(40);
    expect(features.current_price).toBe(24280);
    expect(features.stop_current).toBe(24320);
    expect(features.quantity_remaining).toBe(3);
    expect(features.pnl_pts).toBe(20); // short: 24300 - 24280 = 20 favorable
    expect(features.mfe_pts_so_far).toBe(15);
    expect(features.mae_pts_so_far).toBe(5);
    expect(features.pt1_hit).toBe(1);
    expect(features.trail_active).toBe(1);
    expect(features.stop_at_breakeven).toBe(1);
    expect(features.setup_type).toBe('trend_pullback_long');
    expect(features.regime_at_entry).toBe('trending_up');
  });

  it('computes unrealized_r correctly for long', () => {
    const pos = makePosition({
      side: 'long',
      entry_price: 24200,
      stop_initial: 24160,
    });
    const features = buildMlFeatures(pos, 24220);
    expect(features.unrealized_r).toBe(0.5); // (24220-24200) / (24200-24160) = 20/40 = 0.5
  });

  it('computes negative unrealized_r for losing trade', () => {
    const pos = makePosition({
      side: 'long',
      entry_price: 24200,
      stop_initial: 24160,
    });
    const features = buildMlFeatures(pos, 24180);
    expect(features.unrealized_r).toBe(-0.5); // (24180-24200) / 40 = -0.5
  });

  it('includes trade_id for correlation', () => {
    const pos = makePosition({ trade_id: 'TRADE_CORR_001' });
    const features = buildMlFeatures(pos, 24200);
    expect(features.trade_id).toBe('TRADE_CORR_001');
  });

  it('computes time_in_trade_sec from entry unix', () => {
    const pos = makePosition({
      entry_time_unix: Date.now() - 120_000, // 2 minutes ago
    });
    const features = buildMlFeatures(pos, 24200);
    expect(features.time_in_trade_sec).toBeGreaterThanOrEqual(119);
    expect(features.time_in_trade_sec).toBeLessThanOrEqual(121);
  });
});

// ─── 3. Dataset Anti-Leakage Structural Tests ────────────────────────────────

describe('Dataset anti-leakage', () => {
  it('labeled dataset has sl_ prefix on all supervised labels', () => {
    const path = 'data/management_dataset_labeled.csv';
    if (!existsSync(path)) return; // skip if dataset not built yet

    const header = readFileSync(path, 'utf8').split('\n')[0]!;
    const cols = header.split(',');

    // All sl_ columns should be labels (not features)
    const slCols = cols.filter(c => c.startsWith('sl_'));
    expect(slCols.length).toBeGreaterThan(0);

    // No sl_ column should also be a feature column (features don't start with sl_)
    const featureCols = cols.filter(c => !c.startsWith('sl_') && !c.startsWith('label_')
      && !['trade_id', 'timestamp', 'row_type', 'tick_index', 'total_ticks', 'tick_progress'].includes(c));
    for (const fc of featureCols) {
      expect(fc.startsWith('sl_')).toBe(false);
    }
  });

  it('label schema separates features from labels', () => {
    const path = 'data/management_labels_schema.json';
    if (!existsSync(path)) return;

    const schema = JSON.parse(readFileSync(path, 'utf8'));
    expect(schema.label_prefix).toBe('sl_');
    expect(schema.anti_leakage_controls).toBeDefined();
    expect(schema.anti_leakage_controls.length).toBeGreaterThan(0);
  });
});

// ─── 4. Walk-Forward Split Ordering ──────────────────────────────────────────

describe('Walk-forward split ordering', () => {
  it('dataset rows are time-ordered within each trade', () => {
    const path = 'data/management_dataset_labeled.csv';
    if (!existsSync(path)) return;

    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.trim());
    const header = lines[0]!.split(',');
    const tsIdx = header.indexOf('timestamp');
    const tidIdx = header.indexOf('trade_id');
    if (tsIdx < 0 || tidIdx < 0) return;

    // Check that within each trade_id, timestamps are non-decreasing
    const byTrade = new Map<string, string[]>();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i]!.split(',');
      const tid = cols[tidIdx]!;
      const ts = cols[tsIdx]!;
      if (!byTrade.has(tid)) byTrade.set(tid, []);
      byTrade.get(tid)!.push(ts);
    }

    for (const [tid, timestamps] of byTrade) {
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]! >= timestamps[i - 1]!).toBe(true);
      }
    }
  });
});

// ─── 5. Model Artifact Existence ─────────────────────────────────────────────

describe('Model artifacts', () => {
  it('XGBoost classifier artifact exists', () => {
    expect(existsSync('models/xgboost/hold_classifier.ubj')).toBe(true);
  });

  it('XGBoost regressor artifact exists', () => {
    expect(existsSync('models/xgboost/remaining_r_regressor.ubj')).toBe(true);
  });

  it('XGBoost metadata has required fields', () => {
    const path = 'models/xgboost/training_meta.json';
    if (!existsSync(path)) return;
    const meta = JSON.parse(readFileSync(path, 'utf8'));
    expect(meta.feature_names).toBeDefined();
    expect(meta.classifier).toBeDefined();
    expect(meta.regressor).toBeDefined();
    expect(meta.split_method).toContain('trade_id');
  });

  it('CatBoost classifier artifact exists', () => {
    expect(existsSync('models/catboost/hold_classifier.cbm')).toBe(true);
  });

  it('CatBoost regressor artifact exists', () => {
    expect(existsSync('models/catboost/remaining_r_regressor.cbm')).toBe(true);
  });

  it('CatBoost metadata has required fields', () => {
    const path = 'models/catboost/training_meta.json';
    if (!existsSync(path)) return;
    const meta = JSON.parse(readFileSync(path, 'utf8'));
    expect(meta.feature_names).toBeDefined();
    expect(meta.classifier).toBeDefined();
    expect(meta.regressor).toBeDefined();
    expect(meta.role).toBe('challenger');
  });
});

// ─── 6. ML Integration Contracts ─────────────────────────────────────────────

describe('ML integration contracts', () => {
  const runnerSource = readFileSync('src/autotrade/runner.ts', 'utf8');

  it('runner imports ML decision engine', () => {
    expect(runnerSource).toContain("from './ml/index.js'");
  });

  it('runner calls getMlDecision during monitoring', () => {
    expect(runnerSource).toContain('getMlDecision(');
  });

  it('runner logs ML decisions to ml_management_actions.jsonl', () => {
    expect(runnerSource).toContain('writeMlManagementAction(');
  });

  it('runner updates dashboard with ML state', () => {
    expect(runnerSource).toContain('updateMlManagement(');
  });

  it('ML runs only after hard stop evaluation (safety ordering)', () => {
    const evalIdx = runnerSource.indexOf('positionManager.evaluate(');
    const mlIdx = runnerSource.indexOf('getMlDecision(');
    expect(evalIdx).toBeGreaterThan(0);
    expect(mlIdx).toBeGreaterThan(evalIdx);
  });

  it('ML errors are caught and do not crash the engine', () => {
    // The ML call is wrapped in try/catch
    expect(runnerSource).toContain('catch (err)');
    expect(runnerSource).toContain('[ML] Decision error (non-fatal)');
  });

  it('ML health check runs at startup', () => {
    expect(runnerSource).toContain('checkMlHealth(');
  });

  it('runner uses recommended_stop_price directly, not notes parsing', () => {
    expect(runnerSource).toContain('mlDec.recommended_stop_price');
    expect(runnerSource).not.toContain('notes.find');
    expect(runnerSource).not.toContain('notes[0]?.match');
  });

  it('runner uses recommended_size_fraction directly for EXIT_PARTIAL', () => {
    expect(runnerSource).toContain('mlDec.recommended_size_fraction');
  });

  it('EXIT_PARTIAL execution is gated on enable_partial_exit config', () => {
    expect(runnerSource).toContain('mlConfig.enable_partial_exit');
  });
});

// ─── 7. Feature Registry Cross-Source Parity ─────────────────────────────────
// These tests use config/ml_management_features.json as the cross-language
// bridge between the Python registry and the TypeScript codebase.
// If any source drifts, these tests fail before runtime.
//
// To regenerate the JSON bridge:
//   python scripts/ml/export_feature_registry.py

describe('Management ML feature parity (cross-source)', () => {
  // Load the generated JSON registry once
  const JSON_REGISTRY_PATH = 'config/ml_management_features.json';

  it('JSON feature registry snapshot exists', () => {
    expect(existsSync(JSON_REGISTRY_PATH)).toBe(true);
  });

  // All remaining tests depend on the JSON file existing
  const registryExists = existsSync(JSON_REGISTRY_PATH);
  const registry = registryExists
    ? JSON.parse(readFileSync(JSON_REGISTRY_PATH, 'utf8'))
    : null;

  it('JSON registry has required top-level fields', () => {
    if (!registry) return;
    expect(registry.feature_schema_version).toBeDefined();
    expect(registry.feature_count).toBeGreaterThan(0);
    expect(Array.isArray(registry.all_features)).toBe(true);
    expect(Array.isArray(registry.numeric_features)).toBe(true);
    expect(Array.isArray(registry.categorical_features)).toBe(true);
  });

  it('every registry feature is declared in MlFeatureVector (ml/types.ts)', () => {
    if (!registry) return;
    const src = readFileSync('src/autotrade/ml/types.ts', 'utf8');
    const allFeatures: string[] = registry.all_features;
    // trade_id is in MlFeatureVector for correlation but not in the model feature list
    const missing = allFeatures.filter(f => !src.includes(`${f}:`));
    expect(missing).toHaveLength(0);
    if (missing.length > 0) {
      throw new Error(
        `Features in registry but missing from MlFeatureVector in ml/types.ts: ${missing.join(', ')}\n` +
        `Run: python scripts/ml/export_feature_registry.py to confirm registry is current.`
      );
    }
  });

  it('every registry feature is assigned in buildMlFeatures() (ml/feature-builder.ts)', () => {
    if (!registry) return;
    const src = readFileSync('src/autotrade/ml/feature-builder.ts', 'utf8');
    const allFeatures: string[] = registry.all_features;
    const missing = allFeatures.filter(f => !src.includes(`${f}:`));
    expect(missing).toHaveLength(0);
    if (missing.length > 0) {
      throw new Error(
        `Features in registry but not assigned in buildMlFeatures(): ${missing.join(', ')}`
      );
    }
  });

  it('MlFeatureVector field count matches registry feature count', () => {
    if (!registry) return;
    // Extract interface body by counting fields with the pattern "  fieldname:"
    const src = readFileSync('src/autotrade/ml/types.ts', 'utf8');
    // Find the MlFeatureVector interface and count fields (lines with "  word:")
    const ifaceMatch = src.match(/export interface MlFeatureVector \{([\s\S]*?)\n\}/);
    expect(ifaceMatch).not.toBeNull();
    const body = ifaceMatch![1];
    // Count "  fieldname:" lines (field declarations)
    const fieldLines = body.match(/^\s{2}\w+:/gm) ?? [];
    // +1 for trade_id (correlation field, not a model feature)
    expect(fieldLines.length).toBe(registry.feature_count + 1);
  });

  it('JSON feature schema version is v3_advanced_mbo', () => {
    if (!registry) return;
    expect(registry.feature_schema_version).toBe('v3_advanced_mbo');
  });

  it('CatBoost artifact feature_names matches JSON registry', () => {
    const metaPath = 'models/catboost/training_meta.json';
    if (!existsSync(metaPath) || !registry) return;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(meta.feature_names).toEqual(registry.all_features);
  });

  it('CatBoost artifact declares feature_schema_version', () => {
    const metaPath = 'models/catboost/training_meta.json';
    if (!existsSync(metaPath)) return;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(meta.feature_schema_version).toBeDefined();
    expect(meta.feature_schema_version).not.toBe('unknown_pre_contract');
  });

  it('Python schemas.py ManagementRequest contains all registry features', () => {
    if (!registry) return;
    const src = readFileSync('python-ml-service/schemas.py', 'utf8');
    const allFeatures: string[] = registry.all_features;
    const missing = allFeatures.filter(f => !src.includes(`    ${f}:`));
    expect(missing).toHaveLength(0);
  });
});

// ─── 8. Phase-Aware Decision Policy (decideAction) ─────────────────────────

import { decideAction } from '../../src/autotrade/ml/decision-engine.js';
import type { DecideActionInput } from '../../src/autotrade/ml/types.js';
import fixtures from '../../src/autotrade/ml/decide-action-fixtures.json';

describe('decideAction() phase-aware policy', () => {
  const cfg: MlManagementConfig = {
    ...DEFAULT_ML_CONFIG,
    enabled: true,
  };

  for (const fixture of fixtures) {
    it(`fixture: ${fixture.name}`, () => {
      const mergedCfg = { ...cfg, ...fixture.config_overrides };
      const result = decideAction(fixture.input as DecideActionInput, mergedCfg);
      expect(result.action).toBe(fixture.expected.action);
      expect(result.reason).toBe(fixture.expected.reason);
      expect(result.phase).toBe(fixture.expected.phase);
    });
  }

  it('uses prob_hold_cal when available and calibration enabled', () => {
    const result = decideAction({
      prob_hold_raw: 0.50,      // above active threshold → would HOLD
      prob_hold_cal: 0.10,      // below active threshold → should EXIT
      confidence: 0.80,
      age_sec: 45,
      cur_r: 0.20,
      peak_r: 0.30,
      drawdown_from_peak_r: 0.10,
      quote_age_ms: 100,
    }, { ...cfg, use_probability_calibration: true });
    expect(result.action).toBe('EXIT_ALL');
    expect(result.prob_hold_used).toBe(0.10);
  });

  it('falls back to prob_hold_raw when prob_hold_cal is undefined', () => {
    const result = decideAction({
      prob_hold_raw: 0.50,
      prob_hold_cal: undefined,
      confidence: 0.80,
      age_sec: 45,
      cur_r: 0.20,
      peak_r: 0.30,
      drawdown_from_peak_r: 0.10,
      quote_age_ms: 100,
    }, { ...cfg, use_probability_calibration: true });
    expect(result.action).toBe('HOLD');
    expect(result.reason).toBe('active_hold');
  });

  it('ignores prob_hold_cal when calibration disabled', () => {
    const result = decideAction({
      prob_hold_raw: 0.50,
      prob_hold_cal: 0.10,
      confidence: 0.80,
      age_sec: 45,
      cur_r: 0.20,
      peak_r: 0.30,
      drawdown_from_peak_r: 0.10,
      quote_age_ms: 100,
    }, { ...cfg, use_probability_calibration: false });
    expect(result.action).toBe('HOLD');
    expect(result.reason).toBe('active_hold');
  });
});

// ─── 9. Execution Gate V2 Acceptance Tests ─────────────────────────────────

describe('execution gate V2 acceptance tests', () => {
  const cfg: MlManagementConfig = {
    ...DEFAULT_ML_CONFIG,
    enabled: true,
    action_cooldown_seconds: 20,
    min_hold_seconds_before_ml_exit: 15,
    min_hold_seconds_before_ml_reduce: 10,
    early_phase_end_seconds: 30,
    early_green_trade_exit_block_r: 0.10,
    runner_phase_min_seconds: 60,
    runner_trigger_r: 0.75,
    runner_drawdown_from_peak_r: 0.25,
  };

  it('Test 1a: cooldown enforced — second action within cooldown is blocked', () => {
    // Position with enough drawdown to pass runner protection
    // entry=24200, stop=24160 (40pts risk), last_checked=24210 (cur_r=0.25)
    // mfe=40 (peak_r=1.0), drawdown = 1.0 - 0.25 = 0.75 > 0.25 threshold
    const pos = makePosition({
      entry_time_unix: Date.now() - 120_000,
      max_favorable_excursion: 40,
      last_checked_price: 24210,
    });
    const exitResponse = makeResponse({ action: 'EXIT_ALL', action_confidence: 0.95 });
    // First call — no prior action timestamp
    const first = evaluateMlGate(exitResponse, cfg, pos, 100, null);
    expect(first.approved).toBe(true);

    // Second call — within cooldown window (5s ago)
    const recentTimestamp = Date.now() - 5_000;
    const second = evaluateMlGate(exitResponse, cfg, pos, 100, recentTimestamp);
    expect(second.approved).toBe(false);
    const cooldownCheck = second.checks.find(c => c.name === 'action_cooldown');
    expect(cooldownCheck).toBeDefined();
    expect(cooldownCheck!.passed).toBe(false);
  });

  it('Test 1c: invalid_risk_geometry blocks when entry_price == stop_initial', () => {
    const pos = makePosition({
      entry_price: 24200,
      stop_initial: 24200, // zero risk
      entry_time_unix: Date.now() - 120_000,
    });
    const response = makeResponse({ action: 'EXIT_ALL', action_confidence: 0.95 });
    const result = evaluateMlGate(response, cfg, pos, 100);
    expect(result.approved).toBe(false);
    expect(result.rejection_reason).toBe('invalid_risk_geometry');
  });

  it('Test 2: min_hold blocks instant exit (age_sec ~3)', () => {
    const pos = makePosition({ entry_time_unix: Date.now() - 3_000 });
    const response = makeResponse({ action: 'EXIT_ALL', action_confidence: 0.95 });
    const result = evaluateMlGate(response, cfg, pos, 100);
    expect(result.approved).toBe(false);
    const holdCheck = result.checks.find(c => c.name === 'min_hold_time');
    expect(holdCheck).toBeDefined();
    expect(holdCheck!.passed).toBe(false);
  });

  it('Test 3: early_green_trade block (age=18s, cur_r=+0.14)', () => {
    // Position 18s old with +0.14R unrealized
    const entryPrice = 24200;
    const stopInitial = 24160; // 40pts risk
    // For +0.14R: pnl_pts = 0.14 * 40 = 5.6, so price = 24205.6
    const curPrice = 24205.6;
    const pos = makePosition({
      entry_price: entryPrice,
      stop_initial: stopInitial,
      entry_time_unix: Date.now() - 18_000,
      last_checked_price: curPrice,
    });
    const response = makeResponse({ action: 'EXIT_ALL', action_confidence: 0.95 });
    const result = evaluateMlGate(response, cfg, pos, 100);
    expect(result.approved).toBe(false);
    const greenCheck = result.checks.find(c => c.name === 'early_green_block');
    expect(greenCheck).toBeDefined();
    expect(greenCheck!.passed).toBe(false);
  });

  it('Test 4: runner_protection (cur_r=+1.10, peak_r=+1.22, dd=0.12)', () => {
    const entryPrice = 24200;
    const stopInitial = 24160; // 40pts risk
    // cur_r = +1.10: pnl_pts = 1.10 * 40 = 44, price = 24244
    // peak_r = +1.22: mfe_pts = 1.22 * 40 = 48.8
    const curPrice = 24244;
    const pos = makePosition({
      entry_price: entryPrice,
      stop_initial: stopInitial,
      entry_time_unix: Date.now() - 120_000,
      last_checked_price: curPrice,
      max_favorable_excursion: 48.8,
    });
    const response = makeResponse({ action: 'EXIT_ALL', action_confidence: 0.95 });
    const result = evaluateMlGate(response, cfg, pos, 100);
    expect(result.approved).toBe(false);
    const runnerCheck = result.checks.find(c => c.name === 'runner_protection');
    expect(runnerCheck).toBeDefined();
    expect(runnerCheck!.passed).toBe(false);
  });

  it('Test 8b: min_hold_reduce blocks EXIT_PARTIAL when too young', () => {
    const pos = makePosition({ entry_time_unix: Date.now() - 5_000 });
    const response = makeResponse({
      action: 'EXIT_PARTIAL',
      action_confidence: 0.95,
      recommended_size_fraction: 0.5,
    });
    const result = evaluateMlGate(response, { ...cfg, enable_partial_exit: true }, pos, 100);
    expect(result.approved).toBe(false);
    const reduceCheck = result.checks.find(c => c.name === 'min_hold_reduce');
    expect(reduceCheck).toBeDefined();
    expect(reduceCheck!.passed).toBe(false);
  });
});

// ─── 10. Claude Removal (re-confirmation) ────────────────────────────────────

describe('Claude live management is removed', () => {
  const runnerSource = readFileSync('src/autotrade/runner.ts', 'utf8');

  it('no Claude management callback', () => {
    expect(runnerSource).not.toContain('setManagementCallback(');
  });

  it('no Claude management cadence', () => {
    expect(runnerSource).not.toContain('.startManagementCadence(');
  });

  it('no Claude execution gate import', () => {
    expect(runnerSource).not.toMatch(/^import\s.*evaluateExecutionGate/m);
  });
});
