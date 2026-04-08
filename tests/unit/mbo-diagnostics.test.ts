/**
 * Tests for MBO diagnostics extraction and health reporting.
 *
 * Covers:
 *   - extractMboDiagnostics with full MBO, partial MBO, and no MBO snapshots
 *   - buildMboTradeContext with present and absent MBO data
 *   - buildMboHealthSummary with new and old sidecar health responses
 *   - formatMboStatusLine for all status states
 *   - Backward compatibility when MBO fields are absent
 */
import { describe, it, expect } from 'vitest';
import {
  extractMboDiagnostics,
  buildMboTradeContext,
  buildMboHealthSummary,
  formatMboStatusLine,
} from '../../src/autotrade/mbo-diagnostics.js';
import type { LobSnapshot, LobHealthResult } from '../../src/autotrade/lob-client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid LobSnapshot with no MBO data. */
function makeBaseSnap(overrides: Partial<LobSnapshot> = {}): LobSnapshot {
  return {
    timestamp_ms: Date.now(),
    bbo_age_ms: 50,
    data_quality: 'full_depth',
    recording_context: 'session',
    bid: 24200.25, ask: 24200.50, mid: 24200.38,
    bid_size: 10, ask_size: 8,
    spread_pts: 0.25, spread_ticks: 1,
    depth_imbalance_5: 0.15, depth_imbalance_10: 0.10,
    total_bid_depth_10lvl: 200, total_ask_depth_10lvl: 180,
    large_bid_within_5pts: false, large_ask_within_5pts: false,
    cumulative_delta_10s: 5, cumulative_delta_30s: 12, cumulative_delta_60s: 20,
    trade_flow_imbalance_10s: 0.55, trade_flow_imbalance_30s: 0.52,
    // All MBO fields null by default
    cancel_add_ratio_10s: null, replenishment_rate_10s: null,
    absorption_rate_10s: null, mean_order_lifetime_top_book: null,
    aggressor_penetration_10s: null, sweep_count_10s: null,
    adv_cancel_replace_ratio_10s: null, adv_modify_rate_10s: null,
    adv_iceberg_suspicion_30s: null,
    adv_queue_deterioration_bid_10s: null, adv_queue_deterioration_ask_10s: null,
    adv_pull_cascade_count_10s: null, adv_lifetime_p50_ms: null,
    absorption_score_10s: null, absorption_bid_score_10s: null,
    absorption_ask_score_10s: null, strongest_absorption_price: null,
    sweep_volume_10s: null, max_sweep_levels_10s: null, last_sweep_side: null,
    footprint_delta_30s: null, footprint_delta_5s: null,
    footprint_imbalance_ratio_30s: null, footprint_stacked_imbalance_count_30s: null,
    dominant_aggressor_side: null,
    large_trade_count_10s: null, large_trade_volume_10s: null,
    largest_trade_size_30s: null, large_trade_buy_sell_imbalance_30s: null,
    session_vpoc: null, session_vah: null, session_val: null,
    distance_to_vpoc: null, inside_value_area: null,
    trade_id: null, signal_id: null,
    ...overrides,
  };
}

/** Snapshot with full MBO (basic + advanced). */
function makeFullMboSnap(): LobSnapshot {
  return makeBaseSnap({
    cancel_add_ratio_10s: 0.75,
    replenishment_rate_10s: 0.5,
    absorption_rate_10s: 0.3,
    mean_order_lifetime_top_book: 120.5,
    aggressor_penetration_10s: 1.8,
    sweep_count_10s: 2,
    adv_cancel_replace_ratio_10s: 0.82,
    adv_modify_rate_10s: 0.15,
    adv_iceberg_suspicion_30s: 1.5,
    adv_queue_deterioration_bid_10s: 0.9,
    adv_queue_deterioration_ask_10s: 0.7,
    adv_pull_cascade_count_10s: 3,
    adv_lifetime_p50_ms: 200.0,
  });
}

/** Snapshot with basic MBO only (no advanced). */
function makePartialMboSnap(): LobSnapshot {
  return makeBaseSnap({
    cancel_add_ratio_10s: 0.5,
    absorption_rate_10s: 0.2,
    sweep_count_10s: 1,
    // advanced fields remain null
  });
}

/** Minimal health response. */
function makeHealth(overrides: Partial<LobHealthResult> = {}): LobHealthResult {
  return {
    status: 'ok',
    source_connected: true,
    bbo_fresh: true,
    bbo_age_ms: 50,
    update_count: 1000,
    trade_count: 500,
    depth_levels_bid: 20,
    depth_levels_ask: 20,
    mbo_events_buffered: 0,
    active_trade_id: null,
    active_signal_id: null,
    recording_context: 'session',
    uptime_sec: 300,
    ...overrides,
  };
}

// ── extractMboDiagnostics ────────────────────────────────────────────────────

describe('extractMboDiagnostics', () => {
  it('returns unavailable when snap is null', () => {
    const diag = extractMboDiagnostics(null);
    expect(diag.mbo_data_quality).toBe('unavailable');
    expect(diag.mbo_cancel_add_ratio_10s).toBeNull();
    expect(diag.mbo_adv_iceberg_suspicion_30s).toBeNull();
  });

  it('returns unavailable when snap is undefined', () => {
    const diag = extractMboDiagnostics(undefined);
    expect(diag.mbo_data_quality).toBe('unavailable');
  });

  it('returns unavailable when data_quality is unavailable', () => {
    const snap = makeBaseSnap({ data_quality: 'unavailable' });
    const diag = extractMboDiagnostics(snap);
    expect(diag.mbo_data_quality).toBe('unavailable');
  });

  it('returns unavailable when bbo_age_ms > 5000', () => {
    const snap = makeBaseSnap({ bbo_age_ms: 6000 });
    const diag = extractMboDiagnostics(snap);
    expect(diag.mbo_data_quality).toBe('unavailable');
  });

  it('returns unavailable when no MBO fields present (BBO-only)', () => {
    const snap = makeBaseSnap();
    const diag = extractMboDiagnostics(snap);
    expect(diag.mbo_data_quality).toBe('unavailable');
    expect(diag.mbo_cancel_add_ratio_10s).toBeNull();
  });

  it('returns partial when basic MBO present but no advanced', () => {
    const snap = makePartialMboSnap();
    const diag = extractMboDiagnostics(snap);
    expect(diag.mbo_data_quality).toBe('partial');
    expect(diag.mbo_cancel_add_ratio_10s).toBe(0.5);
    expect(diag.mbo_absorption_rate_10s).toBe(0.2);
    expect(diag.mbo_sweep_count_10s).toBe(1);
    expect(diag.mbo_adv_iceberg_suspicion_30s).toBeNull();
  });

  it('returns active when both basic and advanced MBO present', () => {
    const snap = makeFullMboSnap();
    const diag = extractMboDiagnostics(snap);
    expect(diag.mbo_data_quality).toBe('active');
    expect(diag.mbo_cancel_add_ratio_10s).toBe(0.75);
    expect(diag.mbo_absorption_rate_10s).toBe(0.3);
    expect(diag.mbo_sweep_count_10s).toBe(2);
    expect(diag.mbo_aggressor_penetration_10s).toBe(1.8);
    expect(diag.mbo_mean_lifetime_ms).toBe(120.5);
    expect(diag.mbo_adv_cancel_replace_ratio_10s).toBe(0.82);
    expect(diag.mbo_adv_modify_rate_10s).toBe(0.15);
    expect(diag.mbo_adv_iceberg_suspicion_30s).toBe(1.5);
    expect(diag.mbo_adv_queue_deterioration_bid).toBe(0.9);
    expect(diag.mbo_adv_queue_deterioration_ask).toBe(0.7);
    expect(diag.mbo_adv_pull_cascade_count).toBe(3);
    expect(diag.mbo_adv_lifetime_p50_ms).toBe(200.0);
  });

  it('all fields are present in the returned object (stable schema)', () => {
    const diag = extractMboDiagnostics(null);
    const keys = Object.keys(diag);
    expect(keys).toContain('mbo_data_quality');
    expect(keys).toContain('mbo_cancel_add_ratio_10s');
    expect(keys).toContain('mbo_replenishment_rate_10s');
    expect(keys).toContain('mbo_absorption_rate_10s');
    expect(keys).toContain('mbo_sweep_count_10s');
    expect(keys).toContain('mbo_aggressor_penetration_10s');
    expect(keys).toContain('mbo_mean_lifetime_ms');
    expect(keys).toContain('mbo_adv_cancel_replace_ratio_10s');
    expect(keys).toContain('mbo_adv_modify_rate_10s');
    expect(keys).toContain('mbo_adv_iceberg_suspicion_30s');
    expect(keys).toContain('mbo_adv_queue_deterioration_bid');
    expect(keys).toContain('mbo_adv_queue_deterioration_ask');
    expect(keys).toContain('mbo_adv_pull_cascade_count');
    expect(keys).toContain('mbo_adv_lifetime_p50_ms');
    expect(keys.length).toBe(14);
  });
});

// ── buildMboTradeContext ─────────────────────────────────────────────────────

describe('buildMboTradeContext', () => {
  it('returns unavailable context when snap is null', () => {
    const ctx = buildMboTradeContext(null);
    expect(ctx.data_quality).toBe('unavailable');
    expect(ctx.cancel_add_ratio).toBeNull();
    expect(ctx.iceberg_suspicion).toBeNull();
  });

  it('returns active context with full MBO snapshot', () => {
    const ctx = buildMboTradeContext(makeFullMboSnap());
    expect(ctx.data_quality).toBe('active');
    expect(ctx.cancel_add_ratio).toBe(0.75);
    expect(ctx.absorption_rate).toBe(0.3);
    expect(ctx.sweep_count).toBe(2);
    expect(ctx.aggressor_penetration).toBe(1.8);
    expect(ctx.iceberg_suspicion).toBe(1.5);
    expect(ctx.queue_deterioration_bid).toBe(0.9);
    expect(ctx.queue_deterioration_ask).toBe(0.7);
    expect(ctx.pull_cascade_count).toBe(3);
  });

  it('returns partial context with basic-only MBO', () => {
    const ctx = buildMboTradeContext(makePartialMboSnap());
    expect(ctx.data_quality).toBe('partial');
    expect(ctx.cancel_add_ratio).toBe(0.5);
    expect(ctx.iceberg_suspicion).toBeNull();
  });

  it('has a stable field set regardless of data quality', () => {
    const keys1 = Object.keys(buildMboTradeContext(null));
    const keys2 = Object.keys(buildMboTradeContext(makeFullMboSnap()));
    expect(keys1.sort()).toEqual(keys2.sort());
  });
});

// ── buildMboHealthSummary ────────────────────────────────────────────────────

describe('buildMboHealthSummary', () => {
  it('returns unsupported when health is null', () => {
    const s = buildMboHealthSummary(null);
    expect(s.supported).toBe(false);
    expect(s.status).toBe('unknown');
    expect(s.events_buffered).toBe(0);
    expect(s.total_count).toBe(0);
    expect(s.age_ms).toBe(99999);
  });

  it('returns supported + idle when sidecar has no MBO events', () => {
    const s = buildMboHealthSummary(makeHealth({
      mbo_events_buffered: 0,
      mbo_status: 'idle',
      mbo_total_count: 0,
      mbo_age_ms: 99999,
      mbo_adv_event_count: 0,
    }));
    expect(s.supported).toBe(true);
    expect(s.status).toBe('idle');
    expect(s.events_buffered).toBe(0);
    expect(s.total_count).toBe(0);
  });

  it('returns active when sidecar has flowing MBO events', () => {
    const s = buildMboHealthSummary(makeHealth({
      mbo_events_buffered: 142,
      mbo_status: 'active',
      mbo_total_count: 3847,
      mbo_age_ms: 12,
      mbo_adv_event_count: 130,
    }));
    expect(s.supported).toBe(true);
    expect(s.status).toBe('active');
    expect(s.events_buffered).toBe(142);
    expect(s.total_count).toBe(3847);
    expect(s.age_ms).toBe(12);
    expect(s.adv_event_count).toBe(130);
  });

  it('handles old sidecar without new MBO health fields', () => {
    // Old sidecar only reports mbo_events_buffered
    const oldHealth = makeHealth({ mbo_events_buffered: 50 });
    delete (oldHealth as Record<string, unknown>)['mbo_status'];
    delete (oldHealth as Record<string, unknown>)['mbo_total_count'];
    delete (oldHealth as Record<string, unknown>)['mbo_age_ms'];
    delete (oldHealth as Record<string, unknown>)['mbo_adv_event_count'];

    const s = buildMboHealthSummary(oldHealth);
    expect(s.supported).toBe(true);
    // Inferred from mbo_events_buffered > 0
    expect(s.status).toBe('active');
    expect(s.events_buffered).toBe(50);
    expect(s.total_count).toBe(0);
    expect(s.age_ms).toBe(99999);
    expect(s.adv_event_count).toBe(0);
  });
});

// ── formatMboStatusLine ──────────────────────────────────────────────────────

describe('formatMboStatusLine', () => {
  it('shows unavailable when health is null', () => {
    expect(formatMboStatusLine(null)).toContain('unavailable');
  });

  it('shows idle when no MBO events received', () => {
    const line = formatMboStatusLine(makeHealth({
      mbo_status: 'idle',
      mbo_events_buffered: 0,
    }));
    expect(line).toContain('idle');
    expect(line).toContain('no MBO events');
  });

  it('shows active with event counts', () => {
    const line = formatMboStatusLine(makeHealth({
      mbo_status: 'active',
      mbo_events_buffered: 142,
      mbo_total_count: 3847,
      mbo_age_ms: 12,
    }));
    expect(line).toContain('active');
    expect(line).toContain('142');
    expect(line).toContain('3847');
    expect(line).toContain('12ms');
  });

  it('shows stale when MBO has gone quiet', () => {
    const line = formatMboStatusLine(makeHealth({
      mbo_status: 'stale',
      mbo_events_buffered: 0,
      mbo_total_count: 500,
      mbo_age_ms: 8000,
    }));
    expect(line).toContain('stale');
    expect(line).toContain('8000ms');
    expect(line).toContain('500');
  });
});
