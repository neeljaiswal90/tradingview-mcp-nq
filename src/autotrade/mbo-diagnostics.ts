/**
 * mbo-diagnostics.ts — Extract compact MBO diagnostics from LOB snapshots.
 *
 * All values are either:
 *   (a) raw from sidecar snapshot (documented as "raw")
 *   (b) derived in TypeScript from raw sidecar fields (documented as "derived")
 *
 * Every field is nullable. When MBO is absent or sidecar unavailable,
 * all fields default to null and mbo_data_quality = 'unavailable'.
 *
 * This module NEVER fabricates MBO values — it only reshapes and summarizes
 * what the Python sidecar actually provides.
 */

import type { LobSnapshot, LobHealthResult } from './lob-client.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Compact MBO diagnostics block for candidate-signal logs.
 * Stable field set — safe to append to JSONL without breaking readers.
 */
export interface MboCandidateDiagnostics {
  // Capability / freshness
  mbo_data_quality: 'active' | 'partial' | 'unavailable';  // derived: from presence of MBO fields
  // Raw from sidecar: basic MBO aggregates (rolling 10s windows)
  mbo_cancel_add_ratio_10s: number | null;        // raw: cancel_add_ratio_10s
  mbo_replenishment_rate_10s: number | null;       // raw: replenishment_rate_10s
  mbo_absorption_rate_10s: number | null;          // raw: absorption_rate_10s
  mbo_sweep_count_10s: number | null;              // raw: sweep_count_10s
  mbo_aggressor_penetration_10s: number | null;    // raw: aggressor_penetration_10s
  mbo_mean_lifetime_ms: number | null;             // raw: mean_order_lifetime_top_book
  // Raw from sidecar: advanced MBO analytics
  mbo_adv_cancel_replace_ratio_10s: number | null; // raw: adv_cancel_replace_ratio_10s
  mbo_adv_modify_rate_10s: number | null;          // raw: adv_modify_rate_10s
  mbo_adv_iceberg_suspicion_30s: number | null;    // raw: adv_iceberg_suspicion_30s
  mbo_adv_queue_deterioration_bid: number | null;  // raw: adv_queue_deterioration_bid_10s
  mbo_adv_queue_deterioration_ask: number | null;  // raw: adv_queue_deterioration_ask_10s
  mbo_adv_pull_cascade_count: number | null;       // raw: adv_pull_cascade_count_10s
  mbo_adv_lifetime_p50_ms: number | null;          // raw: adv_lifetime_p50_ms
}

/**
 * Concise MBO context for trade/execution logs.
 * Captures the MBO state at a decision point.
 */
export interface MboTradeContext {
  data_quality: 'active' | 'partial' | 'unavailable';  // derived
  cancel_add_ratio: number | null;      // raw: cancel_add_ratio_10s
  absorption_rate: number | null;       // raw: absorption_rate_10s
  sweep_count: number | null;           // raw: sweep_count_10s
  aggressor_penetration: number | null; // raw: aggressor_penetration_10s
  iceberg_suspicion: number | null;     // raw: adv_iceberg_suspicion_30s
  queue_deterioration_bid: number | null; // raw: adv_queue_deterioration_bid_10s
  queue_deterioration_ask: number | null; // raw: adv_queue_deterioration_ask_10s
  pull_cascade_count: number | null;    // raw: adv_pull_cascade_count_10s
}

/**
 * MBO health summary for startup/status reporting.
 */
export interface MboHealthSummary {
  supported: boolean;           // derived: true when sidecar reports MBO fields
  status: string;               // raw: mbo_status from health, or 'unknown'
  events_buffered: number;      // raw: mbo_events_buffered
  total_count: number;          // raw: mbo_total_count
  age_ms: number;               // raw: mbo_age_ms
  adv_event_count: number;      // raw: mbo_adv_event_count
}

// ── Extractors ───────────────────────────────────────────────────────────────

/**
 * Determine MBO data quality from a LOB snapshot.
 *
 * - 'active':      At least one basic AND one advanced MBO field is non-null
 * - 'partial':     At least one basic MBO field is non-null but no advanced
 * - 'unavailable': No MBO fields populated (MBO events not flowing)
 */
function classifyMboQuality(snap: LobSnapshot): 'active' | 'partial' | 'unavailable' {
  const hasBasic = snap.cancel_add_ratio_10s !== null
    || snap.absorption_rate_10s !== null
    || snap.sweep_count_10s !== null
    || snap.replenishment_rate_10s !== null;

  const hasAdvanced = snap.adv_cancel_replace_ratio_10s !== null
    || snap.adv_iceberg_suspicion_30s !== null
    || snap.adv_queue_deterioration_bid_10s !== null
    || snap.adv_pull_cascade_count_10s !== null;

  if (hasBasic && hasAdvanced) return 'active';
  if (hasBasic) return 'partial';
  return 'unavailable';
}

/**
 * Extract compact MBO diagnostics from a LOB snapshot for candidate-signal logging.
 *
 * Returns a flat object suitable for spreading into a JSONL log record.
 * All values are nullable. When MBO is absent, mbo_data_quality = 'unavailable'
 * and all other fields are null.
 */
export function extractMboDiagnostics(snap: LobSnapshot | null | undefined): MboCandidateDiagnostics {
  if (!snap || snap.data_quality === 'unavailable' || snap.bbo_age_ms > 5000) {
    return NULL_CANDIDATE_DIAGNOSTICS;
  }

  return {
    mbo_data_quality: classifyMboQuality(snap),
    // Basic MBO aggregates
    mbo_cancel_add_ratio_10s: snap.cancel_add_ratio_10s ?? null,
    mbo_replenishment_rate_10s: snap.replenishment_rate_10s ?? null,
    mbo_absorption_rate_10s: snap.absorption_rate_10s ?? null,
    mbo_sweep_count_10s: snap.sweep_count_10s ?? null,
    mbo_aggressor_penetration_10s: snap.aggressor_penetration_10s ?? null,
    mbo_mean_lifetime_ms: snap.mean_order_lifetime_top_book ?? null,
    // Advanced MBO analytics
    mbo_adv_cancel_replace_ratio_10s: snap.adv_cancel_replace_ratio_10s ?? null,
    mbo_adv_modify_rate_10s: snap.adv_modify_rate_10s ?? null,
    mbo_adv_iceberg_suspicion_30s: snap.adv_iceberg_suspicion_30s ?? null,
    mbo_adv_queue_deterioration_bid: snap.adv_queue_deterioration_bid_10s ?? null,
    mbo_adv_queue_deterioration_ask: snap.adv_queue_deterioration_ask_10s ?? null,
    mbo_adv_pull_cascade_count: snap.adv_pull_cascade_count_10s ?? null,
    mbo_adv_lifetime_p50_ms: snap.adv_lifetime_p50_ms ?? null,
  };
}

/**
 * Build a concise MBO context object for trade/execution logs.
 *
 * Captures the key MBO metrics at a decision point. Smaller than full
 * diagnostics — intended for embedding in execution intent and trade records.
 */
export function buildMboTradeContext(snap: LobSnapshot | null | undefined): MboTradeContext {
  if (!snap || snap.data_quality === 'unavailable' || snap.bbo_age_ms > 5000) {
    return NULL_TRADE_CONTEXT;
  }

  return {
    data_quality: classifyMboQuality(snap),
    cancel_add_ratio: snap.cancel_add_ratio_10s ?? null,
    absorption_rate: snap.absorption_rate_10s ?? null,
    sweep_count: snap.sweep_count_10s ?? null,
    aggressor_penetration: snap.aggressor_penetration_10s ?? null,
    iceberg_suspicion: snap.adv_iceberg_suspicion_30s ?? null,
    queue_deterioration_bid: snap.adv_queue_deterioration_bid_10s ?? null,
    queue_deterioration_ask: snap.adv_queue_deterioration_ask_10s ?? null,
    pull_cascade_count: snap.adv_pull_cascade_count_10s ?? null,
  };
}

/**
 * Build an MBO health summary from a sidecar health response.
 *
 * Handles old sidecars that may not report the new MBO health fields
 * by defaulting optional fields to safe zero/unknown values.
 */
export function buildMboHealthSummary(health: LobHealthResult | null | undefined): MboHealthSummary {
  if (!health) {
    return {
      supported: false,
      status: 'unknown',
      events_buffered: 0,
      total_count: 0,
      age_ms: 99999,
      adv_event_count: 0,
    };
  }

  // mbo_status is the authoritative field from new sidecars;
  // if missing (old sidecar), infer from mbo_events_buffered.
  const status = health.mbo_status
    ?? (health.mbo_events_buffered > 0 ? 'active' : 'idle');

  return {
    supported: true,  // Sidecar responded, so MBO path exists
    status,
    events_buffered: health.mbo_events_buffered ?? 0,
    total_count: health.mbo_total_count ?? 0,
    age_ms: health.mbo_age_ms ?? 99999,
    adv_event_count: health.mbo_adv_event_count ?? 0,
  };
}

/**
 * Format a one-line MBO status string for console diagnostics.
 *
 * Example outputs:
 *   "[MBO] active: 142 events buffered, 3847 total, age=12ms"
 *   "[MBO] idle: no MBO events received"
 *   "[MBO] unavailable: sidecar not connected"
 */
export function formatMboStatusLine(health: LobHealthResult | null | undefined): string {
  const summary = buildMboHealthSummary(health);
  if (!summary.supported) {
    return '[MBO] unavailable: sidecar not connected';
  }
  if (summary.status === 'idle') {
    return `[MBO] idle: no MBO events received (uptime=${health!.uptime_sec}s)`;
  }
  if (summary.status === 'stale') {
    return `[MBO] stale: last MBO event ${Math.round(summary.age_ms)}ms ago, ${summary.total_count} total`;
  }
  return `[MBO] active: ${summary.events_buffered} buffered, ${summary.total_count} total, age=${Math.round(summary.age_ms)}ms`;
}

// ── Null sentinels ───────────────────────────────────────────────────────────

const NULL_CANDIDATE_DIAGNOSTICS: MboCandidateDiagnostics = {
  mbo_data_quality: 'unavailable',
  mbo_cancel_add_ratio_10s: null,
  mbo_replenishment_rate_10s: null,
  mbo_absorption_rate_10s: null,
  mbo_sweep_count_10s: null,
  mbo_aggressor_penetration_10s: null,
  mbo_mean_lifetime_ms: null,
  mbo_adv_cancel_replace_ratio_10s: null,
  mbo_adv_modify_rate_10s: null,
  mbo_adv_iceberg_suspicion_30s: null,
  mbo_adv_queue_deterioration_bid: null,
  mbo_adv_queue_deterioration_ask: null,
  mbo_adv_pull_cascade_count: null,
  mbo_adv_lifetime_p50_ms: null,
};

const NULL_TRADE_CONTEXT: MboTradeContext = {
  data_quality: 'unavailable',
  cancel_add_ratio: null,
  absorption_rate: null,
  sweep_count: null,
  aggressor_penetration: null,
  iceberg_suspicion: null,
  queue_deterioration_bid: null,
  queue_deterioration_ask: null,
  pull_cascade_count: null,
};
