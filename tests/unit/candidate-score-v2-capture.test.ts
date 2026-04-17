import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_BUILD_SHA, APP_VERSION, computeConfigHash } from '../../src/shared/app-version.js';
import { writeCandidateScoreV2Telemetry } from '../../src/autotrade/candidate-score-v2.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';
import { computeExtensionFeatures } from '../../src/autotrade/features/extension.js';
import { LogWriter } from '../../src/autotrade/log-writer.js';
import { DEFAULT_SCORING_WEIGHTS, generateSignal } from '../../src/autotrade/strategy.js';
import type {
  IndicatorConfig,
  IndicatorSnapshot,
  KeyLevels,
  MarketSnapshot,
} from '../../src/autotrade/types.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-score-v2-capture-'));
  tempDirs.push(dir);
  return dir;
}

function runAudit(targetPath: string): Record<string, unknown> {
  const result = spawnSync(
    'python',
    ['scripts/analysis/layered_score_shadow_audit.py', targetPath],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'audit script failed');
  }

  return JSON.parse(result.stdout);
}

const MNQ_CAPTURE_CONFIG: IndicatorConfig = {
  version: 'TEST_CAPTURE_V2',
  type: 'BASELINE',
  created_at: '2025-01-01T00:00:00Z',
  ema_fast: 9,
  ema_mid: 21,
  ema_slow: 50,
  rsi_period: 14,
  atr_period: 14,
  volume_sma_period: 20,
  min_confidence: 3.0,
  max_confidence: 10.0,
  min_rr: 1.5,
  max_risk_per_trade_pct: 2.0,
  max_daily_loss_pct: 3.0,
  max_consecutive_losses: 5,
  account_equity: 25_000,
  time_stop_minutes: 30,
  time_stop_max_r_pre_t1: 0.25,
  time_stop_max_r_post_t1: 1.0,
  analysis_interval_seconds: 20,
  in_position_monitor_seconds: 2,
  opening_range_minutes: 15,
  trail_ticks_post_t1: 12,
  enable_momentum_continuation: false,
  enable_opening_drive: false,
  enable_failed_or_break: false,
  dual_min_score: 3.0,
  dual_score_margin: 1.0,
  dual_choppy_extra_margin: 0.5,
  cooldown_bars: 3,
  no_same_bar_reversal: true,
  layered_scoring: {
    enabled: false,
    shadow_log: true,
  } as NonNullable<IndicatorConfig['layered_scoring']>,
};

function makeMnqTrendUpSnap(sessionHigh: number | null): MarketSnapshot {
  const price = 20050;

  const indicators1m: IndicatorSnapshot = {
    ema_9: 20030,
    ema_21: 19990,
    ema_50: 19960,
    ema_100: null,
    ema_200: null,
    supertrend_direction: 'up',
    supertrend_level: null,
    novawave_fast: null,
    novawave_slow: null,
    novawave_signal: null,
    dma_20: null,
    dma_50: null,
    dma_200: null,
    smart_money_choch_sell: 20160,
    smart_money_choch_buy: null,
    smart_money_bos_sell: null,
    smart_money_bos_buy: null,
    vwap: 20040,
    atr_14: 10,
    rsi_14: null,
    volume: null,
    volume_sma_20: null,
    adx: null,
    di_plus: null,
    di_minus: null,
    ttm_squeeze_momentum: null,
    ttm_squeeze_firing: null,
    cvd: null,
    cvd_delta: null,
    cvd_trend: null,
  };

  const bars5m = [
    { time: 1700000000, open: 19981, high: 19985, low: 19980, close: 19983, volume: 100 },
    { time: 1700000300, open: 19986, high: 19990, low: 19985, close: 19988, volume: 100 },
    { time: 1700000600, open: 19989, high: 19993, low: 19988, close: 19991, volume: 100 },
    { time: 1700000900, open: 19991, high: 19995, low: 19990, close: 19993, volume: 100 },
    { time: 1700001200, open: 19994, high: 19998, low: 19993, close: 19996, volume: 100 },
    { time: 1700001500, open: 19997, high: 20001, low: 19996, close: 19999, volume: 100 },
  ];

  const keyLevels: KeyLevels = {
    session_high: sessionHigh,
    session_low: 19800,
    daily_open: null,
    weekly_open: null,
    monday_high: null,
    monday_low: null,
    monday_mid: null,
    monthly_open: null,
    pivot_resistance: [20200],
    pivot_support: [19900],
    choch_sell: null,
    choch_buy: null,
    bos_sell: null,
    bos_buy: null,
    overnight_high: null,
    overnight_low: null,
    prior_rth_high: null,
    prior_rth_low: null,
    opening_range_high: null,
    opening_range_low: null,
    opening_range_mid: null,
    session_vwap: null,
  };

  return {
    timestamp_unix: 1700001800,
    timestamp_iso: new Date(1700001800 * 1000).toISOString(),
    symbol: 'MNQ1!',
    price,
    bars_1m: [],
    bars_5m: bars5m as MarketSnapshot['bars_5m'],
    bars_15m: [],
    bars_1h: [],
    indicators_1m: indicators1m,
    indicators_15m: {} as IndicatorSnapshot,
    indicators_1h: {} as IndicatorSnapshot,
    key_levels: keyLevels,
    data_quality: {
      bars_1m_count: 0,
      bars_5m_count: 6,
      bars_15m_count: 0,
      bars_1h_count: 0,
      vwap_available: true,
      atr_available: true,
      rsi_available: false,
      missing_indicators: [],
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('candidate_scores_v2 deterministic MNQ capture', () => {
  it('emits a real MNQ candidate_scores_v2 row and the audit script consumes it', () => {
    const snap = makeMnqTrendUpSnap(20200);
    const contract = getContractSpec('MNQ');
    const result = generateSignal(snap, MNQ_CAPTURE_CONFIG, contract);

    expect(result.bestSetup).not.toBeNull();
    expect(result.chosen).not.toBeNull();

    const bestSetup = result.bestSetup!;
    const chosen = result.chosen!;
    const logDir = join(makeTempDir(), 'logs-mnq');
    const logWriter = new LogWriter(logDir);
    const configHash = computeConfigHash().short;
    const signalId = 'TEST_MNQ_SCORE_V2_0001';
    const entryMid = (bestSetup.entry_low + bestSetup.entry_high) / 2;

    writeCandidateScoreV2Telemetry({
      logWriter,
      signalId,
      sessionId: 'TEST_CAPTURE_SESSION',
      symbol: 'MNQ1!',
      snap,
      bias: result.bias,
      regime: result.regime,
      bestSetup,
      chosenCandidate: chosen,
      indicatorConfig: MNQ_CAPTURE_CONFIG,
      scoringWeights: DEFAULT_SCORING_WEIGHTS,
      extension: computeExtensionFeatures(
        snap,
        entryMid,
        bestSetup.direction as 'long' | 'short',
        MNQ_CAPTURE_CONFIG.normalization,
      ),
      microstructure: null,
      lob: null,
      rewardPlan: chosen.rewardPlan,
      appVersion: APP_VERSION,
      buildSha: APP_BUILD_SHA,
      configHash,
      selectedForExecution: true,
      executionAllowedFinal: result.tradeAllowed,
      shadowReason: null,
      registryEffectiveStatus: 'active',
      vetoFlags: [],
      reasonCodes: result.decision_reason_primary ? [result.decision_reason_primary] : [],
    });
    logWriter.destroy();

    const candidatePath = join(logDir, 'candidate_scores_v2.jsonl');
    expect(existsSync(candidatePath)).toBe(true);

    const rows = readFileSync(candidatePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.['symbol']).toBe('MNQ1!');
    expect(rows[0]?.['score_v2_source']).toBe('score_v2');
    expect(rows[0]?.['layered_shadow_score']).not.toBeNull();

    const audit = runAudit(logDir);
    expect(audit['source']).toBe('candidate_scores_v2');
    expect((audit['total_records'] as number) >= 1).toBe(true);
  });
});
