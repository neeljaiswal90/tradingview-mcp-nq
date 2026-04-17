/**
 * Tests for refresh cadence, freshness metadata, and scheduler behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LaneScheduler, type LaneConfig } from '../../src/autotrade/scheduler.js';
import { DashboardStateManager } from '../../src/autotrade/dashboard/state-manager.js';

function makeLaneScheduler(callback: () => Promise<void>, intervalMs = 500): LaneScheduler {
  const lanes: LaneConfig[] = [
    {
      name: 'analysis',
      intervalMs,
      callback: async () => {
        await callback();
      },
      activeWhen: 'flat',
      priority: 40,
      independentBusy: false,
      overrunThresholdMs: 5000,
    },
  ];

  return new LaneScheduler({
    baseTickMs: 100,
    isInPosition: () => false,
    lanes,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

// ─── Scheduler Tests ─────────────────────────────────────────────────────────

describe('LaneScheduler', () => {
  it('starts with zeroed metrics for the analysis lane', () => {
    const scheduler = makeLaneScheduler(async () => {});
    const metrics = scheduler.getLaneMetrics('analysis');
    expect(metrics?.cycleCount).toBe(0);
    expect(metrics?.skipCount).toBe(0);
  });

  it('accepts 5000ms (5s) analysis interval', () => {
    const scheduler = makeLaneScheduler(async () => {}, 5000);
    const metrics = scheduler.getLaneMetrics('analysis');
    expect(metrics?.cycleCount).toBe(0);
    expect(metrics?.overrunCount).toBe(0);
  });

  it('tracks metrics correctly after ticks', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const scheduler = makeLaneScheduler(async () => {
      callCount++;
    }, 100);
    const promise = scheduler.run();
    await vi.advanceTimersByTimeAsync(350);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(150);
    await promise;
    const metrics = scheduler.getLaneMetrics('analysis');
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(metrics?.cycleCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── DashboardStateManager Freshness Tests ──────────────────────────────────

describe('DashboardStateManager — freshness metadata', () => {
  let manager: DashboardStateManager;

  beforeEach(() => {
    manager = new DashboardStateManager();
    manager.setAppMeta(
      { symbol: 'NQ', mode: 'paper', session_id: 'TEST' },
      {
        root: 'NQ', display: 'E-mini NASDAQ', app_symbol: 'NQ1!',
        tv_symbol: 'CME_MINI:NQ1!', venue: 'CME', tick_size: 0.25,
        point_value: 20, tick_value: 5, price_decimals: 2,
      },
      25000,
    );
  });

  it('includes freshness field in snapshot', () => {
    const snap = manager.getSnapshot();
    expect(snap.freshness).toBeDefined();
    expect(snap.freshness.snapshot_version).toBeGreaterThan(0);
    expect(snap.freshness.snapshot_built_at).toBeTruthy();
  });

  it('increments snapshot version on each getSnapshot call', () => {
    const snap1 = manager.getSnapshot();
    const snap2 = manager.getSnapshot();
    expect(snap2.freshness.snapshot_version).toBe(snap1.freshness.snapshot_version + 1);
  });

  it('tracks data collection timing', () => {
    manager.updateCollectionTiming({ total_ms: 450, htf_cache_hits: ['5m', '15m'] });
    const snap = manager.getSnapshot();
    expect(snap.freshness.data_gathered_at).toBeTruthy();
    expect(snap.freshness.data_gather_duration_ms).toBe(450);
    expect(snap.freshness.htf_cache_hits).toEqual(['5m', '15m']);
  });

  it('tracks confidence timing', () => {
    manager.updateConfidenceTiming();
    const snap = manager.getSnapshot();
    expect(snap.freshness.confidence_updated_at).toBeTruthy();
  });

  it('tracks analysis timing', () => {
    manager.updateAnalysisTiming(1200, 5000);
    const snap = manager.getSnapshot();
    expect(snap.freshness.last_analysis_duration_ms).toBe(1200);
    expect(snap.freshness.analysis_interval_target_ms).toBe(5000);
    expect(snap.freshness.analysis_lane_segments_ms).toEqual({});
    expect(snap.freshness.analysis_lane_unattributed_ms).toBeNull();
  });

  it('tracks analysis lane segments when provided', () => {
    manager.updateAnalysisTiming(1200, 5000, {
      duration_ms: 1200,
      segments: {
        preflight: 75,
        data_collect: 640,
        signal_analysis: 320,
      },
      segments_sum_ms: 1035,
      unattributed_ms: 165,
    });
    const snap = manager.getSnapshot();
    expect(snap.freshness.analysis_lane_segments_ms).toEqual({
      preflight: 75,
      data_collect: 640,
      signal_analysis: 320,
    });
    expect(snap.freshness.analysis_lane_unattributed_ms).toBe(165);
  });

  it('starts with null/empty freshness values', () => {
    const snap = manager.getSnapshot();
    expect(snap.freshness.data_gathered_at).toBeNull();
    expect(snap.freshness.data_gather_duration_ms).toBeNull();
    expect(snap.freshness.confidence_updated_at).toBeNull();
    expect(snap.freshness.analysis_lane_segments_ms).toEqual({});
    expect(snap.freshness.analysis_lane_unattributed_ms).toBeNull();
    expect(snap.freshness.htf_cache_hits).toEqual([]);
  });
});

// ─── Analysis Interval Config Tests ──────────────────────────────────────────

describe('Analysis interval configuration', () => {
  it('indicator-config.json has 5s analysis interval', async () => {
    const { readFileSync } = await import('fs');
    const config = JSON.parse(readFileSync('./config/indicator-config.json', 'utf8'));
    expect(config.analysis_interval_seconds).toBe(5);
  });

  it('analysis interval produces valid scheduler timing', () => {
    const intervalMs = 5 * 1000;
    const scheduler = makeLaneScheduler(async () => {}, intervalMs);
    const metrics = scheduler.getLaneMetrics('analysis');
    expect(metrics?.cycleCount).toBe(0);
    expect(metrics?.overrunCount).toBe(0);
  });
});
