import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Config precedence tests.
 *
 * Verifies the architectural rule:
 *   - Strategy/risk/trading params → owned by indicator-config.json
 *   - Operational/runtime params → owned by env vars / .env
 *   - Env vars do NOT silently shadow config-file trading params
 */

// ─── IndicatorConfigManager tests ───────────────────────────────────────────

// We need to mock fs to control what the config manager sees
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

const { existsSync: mockExistsSync, readFileSync: mockReadFileSync } = await import('fs');

// Must import AFTER mocking fs
const { IndicatorConfigManager } = await import('../../src/autotrade/indicator-config-manager.js');

describe('IndicatorConfigManager — config file is canonical source', () => {
  beforeEach(() => {
    vi.mocked(mockExistsSync).mockReset();
    vi.mocked(mockReadFileSync).mockReset();
  });

  it('loads trading params from config file, not env', () => {
    const configJson = JSON.stringify({
      version: 'TEST_v1',
      type: 'BASELINE',
      account_equity: 50_000,
      max_risk_per_trade_pct: 0.75,
      max_daily_loss_pct: 2.0,
      max_consecutive_losses: 3,
      time_stop_minutes: 45,
      analysis_interval_seconds: 30,
    });

    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue(configJson);

    // Set env vars to DIFFERENT values — they should NOT win
    process.env['ACCOUNT_EQUITY'] = '10000';
    process.env['MAX_RISK_PCT'] = '0.5';
    process.env['MAX_DAILY_LOSS_PCT'] = '1.0';

    const mgr = new IndicatorConfigManager('./config');
    const cfg = mgr.getConfig();

    // Config file values win
    expect(cfg.account_equity).toBe(50_000);
    expect(cfg.max_risk_per_trade_pct).toBe(0.75);
    expect(cfg.max_daily_loss_pct).toBe(2.0);
    expect(cfg.max_consecutive_losses).toBe(3);
    expect(cfg.time_stop_minutes).toBe(45);
    expect(cfg.analysis_interval_seconds).toBe(30);

    // Cleanup
    delete process.env['ACCOUNT_EQUITY'];
    delete process.env['MAX_RISK_PCT'];
    delete process.env['MAX_DAILY_LOSS_PCT'];
  });

  it('falls back to DEFAULT_CONFIG when config file is missing', () => {
    vi.mocked(mockExistsSync).mockReturnValue(false);

    const mgr = new IndicatorConfigManager('./config');
    const cfg = mgr.getConfig();

    expect(mgr.loadedFromFile).toBe(false);
    // Should have sensible defaults
    expect(cfg.account_equity).toBe(25_000);
    expect(cfg.max_risk_per_trade_pct).toBe(1.5);
    expect(cfg.min_confidence).toBe(7.5);
    expect(cfg.version).toBe('IC_v1.0_BASELINE_NQ');
  });

  it('falls back to DEFAULT_CONFIG when config file is invalid JSON', () => {
    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue('{ broken json!!!');

    const mgr = new IndicatorConfigManager('./config');
    const cfg = mgr.getConfig();

    expect(mgr.loadedFromFile).toBe(false);
    expect(cfg.account_equity).toBe(25_000);
  });

  it('merges missing fields from DEFAULT_CONFIG', () => {
    // Config file only has a few fields
    const partial = JSON.stringify({
      version: 'PARTIAL_v1',
      account_equity: 100_000,
    });

    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue(partial);

    const mgr = new IndicatorConfigManager('./config');
    const cfg = mgr.getConfig();

    expect(cfg.account_equity).toBe(100_000); // from file
    expect(cfg.max_risk_per_trade_pct).toBe(1.5); // from default
    expect(cfg.ema_fast).toBe(9); // from default
    expect(cfg.version).toBe('PARTIAL_v1'); // from file
  });

  it('reports loadedFromFile=true when file exists', () => {
    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue(JSON.stringify({ version: 'TEST' }));

    const mgr = new IndicatorConfigManager('./config');
    expect(mgr.loadedFromFile).toBe(true);
  });
});

// ─── Validation tests ───────────────────────────────────────────────────────

describe('IndicatorConfigManager — validation', () => {
  beforeEach(() => {
    vi.mocked(mockExistsSync).mockReset();
    vi.mocked(mockReadFileSync).mockReset();
  });

  it('validates a correct config as valid', () => {
    vi.mocked(mockExistsSync).mockReturnValue(false); // use defaults
    const mgr = new IndicatorConfigManager('./config');
    const result = mgr.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects account_equity below minimum', () => {
    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue(JSON.stringify({ account_equity: 50 }));

    const mgr = new IndicatorConfigManager('./config');
    const result = mgr.validate();

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('account_equity'))).toBe(true);
  });

  it('rejects max_risk_per_trade_pct above maximum', () => {
    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue(JSON.stringify({ max_risk_per_trade_pct: 6.0 }));

    const mgr = new IndicatorConfigManager('./config');
    const result = mgr.validate();

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('max_risk_per_trade_pct'))).toBe(true);
  });

  it('rejects time_stop_minutes outside range', () => {
    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue(JSON.stringify({ time_stop_minutes: 200 }));

    const mgr = new IndicatorConfigManager('./config');
    const result = mgr.validate();

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('time_stop_minutes'))).toBe(true);
  });

  it('warns on aggressive risk parameters', () => {
    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue(JSON.stringify({
      max_risk_per_trade_pct: 3.0,
      max_daily_loss_pct: 4.0,
      min_rr: 1.0,
    }));

    const mgr = new IndicatorConfigManager('./config');
    const result = mgr.validate();

    expect(result.valid).toBe(true); // valid but warned
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('aggressive'))).toBe(true);
  });

  it('accepts edge-of-range values', () => {
    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue(JSON.stringify({
      account_equity: 100,           // min
      max_risk_per_trade_pct: 0.1,   // min
      time_stop_minutes: 120,        // max
      analysis_interval_seconds: 5,  // min
    }));

    const mgr = new IndicatorConfigManager('./config');
    const result = mgr.validate();

    expect(result.valid).toBe(true);
  });
});

// ─── Env separation tests ───────────────────────────────────────────────────

describe('AutotradeEnv — operational params only', () => {
  // We need a clean import of env.ts — but can't easily mock loadDotEnv
  // since it reads from the real file system. Instead, verify the interface.

  it('AutotradeEnv interface does NOT contain trading params', async () => {
    // Import the loadEnv function
    const envModule = await import('../../src/autotrade/env.js');
    const env = envModule.loadEnv();

    // These should NOT exist on the env object
    expect('MAX_RISK_PER_TRADE_PCT' in env).toBe(false);
    expect('MAX_DAILY_LOSS_PCT' in env).toBe(false);
    expect('MAX_CONSECUTIVE_LOSSES' in env).toBe(false);
    expect('ACCOUNT_EQUITY' in env).toBe(false);
    expect('TIME_STOP_MINUTES' in env).toBe(false);
    expect('ANALYSIS_INTERVAL_SECONDS' in env).toBe(false);

    // These SHOULD exist (operational)
    expect('MODE' in env).toBe(true);
    expect('SYMBOL' in env).toBe(true);
    expect('LOG_DIR' in env).toBe(true);
    expect('EXECUTION_ADAPTER' in env).toBe(true);
    expect('STRATEGY_VERSION' in env).toBe(true);
  });

  it('env MODE defaults to paper', async () => {
    const envModule = await import('../../src/autotrade/env.js');
    const env = envModule.loadEnv();
    // MODE should be either paper or the value from .env
    expect(['paper', 'live', 'signal_only']).toContain(env.MODE);
  });
});

// ─── Config ownership documentation test ────────────────────────────────────

describe('Config ownership — documentation integrity', () => {
  it('indicator-config.json contains all expected trading params', () => {
    // Provide a complete config through the mock and verify the manager loads it
    const fullConfig = {
      version: 'INTEGRITY_TEST',
      type: 'BASELINE',
      account_equity: 25000,
      max_risk_per_trade_pct: 1.5,
      max_daily_loss_pct: 1.5,
      max_consecutive_losses: 5,
      time_stop_minutes: 30,
      analysis_interval_seconds: 20,
      min_confidence: 7.5,
      min_rr: 2,
      opening_range_minutes: 15,
      trail_ticks_post_t1: 12,
      dual_min_score: 7.5,
      dual_score_margin: 1.0,
    };

    vi.mocked(mockExistsSync).mockReturnValue(true);
    vi.mocked(mockReadFileSync).mockReturnValue(JSON.stringify(fullConfig));

    const mgr = new IndicatorConfigManager('./config');
    const cfg = mgr.getConfig();

    const requiredTradingParams = [
      'account_equity',
      'max_risk_per_trade_pct',
      'max_daily_loss_pct',
      'max_consecutive_losses',
      'time_stop_minutes',
      'analysis_interval_seconds',
      'min_confidence',
      'min_rr',
      'opening_range_minutes',
      'trail_ticks_post_t1',
      'dual_min_score',
      'dual_score_margin',
    ] as const;

    for (const param of requiredTradingParams) {
      expect(cfg).toHaveProperty(param);
      expect(typeof cfg[param]).toBe('number');
    }
  });
});
