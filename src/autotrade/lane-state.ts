/**
 * lane-state.ts — Shared mutable state for multi-lane scheduler.
 *
 * Lanes read from and write to this object. No synchronization primitives
 * are needed for reads/writes of primitive fields in single-threaded Node.js.
 * The ExecutionLock serializes multi-step mutation sequences only.
 *
 * Field ownership:
 *   hard-risk lane   → writes: lastPrice, lastQuoteResult, lastQuoteAt, degradedSince
 *   management lane  → writes: lastMlDecision, lastMlCallAt, lastMlActionTimestamp, lastMgmtMetrics
 *   context-refresh  → writes: lastLiteSnap, lastLiteSnapAt, lastRegime, lastAlignmentScore, lastSessionCtx
 *   any lane on exit → writes: exitInFlight (via ExecutionLock)
 */

import type { LiteSnapshot } from './data-collector.js';

// Forward-declare types to avoid circular imports — consumers cast from their own imports.
// If full types are needed, import them at the call site.

/** Quote result from any provider. */
export interface QuoteResultRef {
  price: number;
  timestamp_unix_ms: number;
  source: string;
  is_stale: boolean;
  [key: string]: unknown;
}

export interface LaneSharedState {
  // ── Written by hard-risk lane, read by management/context-refresh ──

  /** Last known market price. null until first successful quote. */
  lastPrice: number | null;
  /** Full quote result from the most recent successful fetch. */
  lastQuoteResult: QuoteResultRef | null;
  /** Date.now() of last successful quote (0 = never received). */
  lastQuoteAt: number;
  /** Date.now() when degraded-data state entered (null = healthy). */
  degradedSince: number | null;

  // ── Written by context-refresh lane, read by management/shadow ──

  /** Latest lite snapshot from collectLite1m(). */
  lastLiteSnap: LiteSnapshot | null;
  /** Date.now() when lastLiteSnap was set. */
  lastLiteSnapAt: number;
  /** Current market regime from latest indicator refresh. */
  lastRegime: string;
  /** Latest alignment score from indicator refresh. */
  lastAlignmentScore: number;
  /** Latest session context. */
  lastSessionCtx: unknown | null;

  // ── Written by management lane, read by hard-risk (for exit guard) ──

  /** Last ML management decision (for logging/advisory). */
  lastMlDecision: unknown | null;
  /** Date.now() of last ML inference call (for throttling). */
  lastMlCallAt: number;
  /** Date.now() when an ML-suggested action was EXECUTED (for cooldown gate). */
  lastMlActionTimestamp: number;
  /** Last management metrics snapshot. */
  lastMgmtMetrics: unknown | null;

  // ── Written by any lane on exit, read by all lanes ──
  // (Also tracked on ExecutionLock — this is a convenience mirror.)

  /** True if an exit order is currently in-flight. */
  exitInFlight: boolean;

  // ── Key-levels recompute signaling (context-refresh → context-refresh) ──

  /** True when key_levels are stale and need recompute via full collect. */
  needsKeyLevelRecompute: boolean;
  /** True once the stale-entry log has been printed (prevents repeated logging). */
  keyLevelsStaleLogged: boolean;
  /** Date.now() of last full recompute attempt (success or failure). For throttling. */
  lastKeyLevelRecomputeAt: number;
}

/** Create a fresh LaneSharedState with safe defaults. */
export function createLaneSharedState(): LaneSharedState {
  return {
    lastPrice: null,       // null until first successful quote
    lastQuoteResult: null,
    lastQuoteAt: 0,        // 0 = never received
    degradedSince: null,   // null = healthy

    lastLiteSnap: null,
    lastLiteSnapAt: 0,
    lastRegime: 'unknown',
    lastAlignmentScore: 0,
    lastSessionCtx: null,

    lastMlDecision: null,
    lastMlCallAt: 0,
    lastMlActionTimestamp: 0,
    lastMgmtMetrics: null,

    exitInFlight: false,

    needsKeyLevelRecompute: false,
    keyLevelsStaleLogged: false,
    lastKeyLevelRecomputeAt: 0,
  };
}
