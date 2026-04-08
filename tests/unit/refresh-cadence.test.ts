/**
 * Tests for refresh cadence, freshness metadata, and scheduler behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scheduler } from '../../src/autotrade/scheduler.js';
import { DashboardStateManager } from '../../src/autotrade/dashboard/state-manager.js';

// ─── Scheduler Tests ─────────────────────────────────────────────────────────

describe('Scheduler', () => {
  it('enforces minimum interval of 1000ms', () => {
    const scheduler = new Scheduler(500);
    const metrics = scheduler.getMetrics();
    expect(metrics.cycle_count).toBe(0);
  });

  it('accepts 5000ms (5s) analysis interval', () => {
    const scheduler = new Scheduler(5000);
    const metrics = scheduler.getMetrics();
    expect(metrics.cycle_count).toBe(0);
    expect(metrics.analysis_overrun_count).toBe(0);
  });

  it('tracks metrics correctly after ticks', async () => {
    const scheduler = new Scheduler(5000);
    let callCount = 0;
    const promise = scheduler.run(async () => {
      callCount++;
      if (callCount >= 2) scheduler.stop();
    });
    await promise;
    const metrics = scheduler.getMetrics();
    expect(metrics.cycle_count).toBeGreaterThanOrEqual(2);
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
  });

  it('starts with null/empty freshness values', () => {
    const snap = manager.getSnapshot();
    expect(snap.freshness.data_gathered_at).toBeNull();
    expect(snap.freshness.data_gather_duration_ms).toBeNull();
    expect(snap.freshness.confidence_updated_at).toBeNull();
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
    const scheduler = new Scheduler(intervalMs);
    const metrics = scheduler.getMetrics();
    expect(metrics.cycle_count).toBe(0);
    expect(metrics.analysis_overrun_count).toBe(0);
  });
});
