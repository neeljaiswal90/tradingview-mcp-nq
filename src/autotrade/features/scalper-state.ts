/**
 * scalper-state.ts — TS domain layer for the lob_mbo_scalp strategy family.
 *
 * Owns three responsibilities:
 *
 *   1. `buildScalperStateVector(snap)` — wire-to-domain converter. Reads
 *      the snake_case `ScalpState` nested block off a LobSnapshot and
 *      returns a camelCase `ScalperStateVector`. Returns null when the
 *      block is missing so callers can bail cleanly.
 *
 *   2. `evaluateScalperDeterministicGate(vec, direction, config)` — the
 *      deterministic entry gate from plan §4, minus the ML and
 *      expectancy clauses which land in Phase 4 / 5. Fails safely (no
 *      throw) when any input subfield is null, returning a stable
 *      rejectReason string so telemetry has a canonical value to bucket.
 *
 *   3. `evaluateScalperPersistenceGate(state, direction, nowMs)` — the
 *      "two consecutive deterministic passes" gate, using a small
 *      per-direction state struct owned by the runner. Checks a timing
 *      window of 100–250 ms between the prior deterministic pass and
 *      now, per plan §4 ("Require persistence across 2 consecutive
 *      snapshots, separated by 100–250ms").
 *
 * Phase 2 guardrail: several ScalpState subfields (afi_*, hazard_*,
 * abs_*, refill_*) are intentionally None in Phase 1 and will remain
 * None until a future sidecar microstructure.py extension. The
 * deterministic gate MUST NOT crash on nulls, MUST reject with a
 * stable reason, and MUST be covered by a test locking the behavior.
 *
 * The real generator in strategies/lob-mbo-scalp.ts (Phase 3b) will
 * wire these three entry points in the order: build → deterministic
 * → persistence → (expectancy) → (ML) → shouldAllowScalperEntry.
 */

import type { LobSnapshot, ScalpState } from '../lob-client.js';

// ─── Domain vector (camelCase mirror of the wire ScalpState) ─────────────────

export interface ScalperStateVector {
  // Multi-level book snapshot (k=5; may have fewer if the book is thin)
  bidPx: number[];
  askPx: number[];
  bidSz: number[];
  askSz: number[];

  // Microprice + edge (in ticks)
  microprice: number | null;
  micropriceEdgeTicks: number | null;

  // Multi-level weighted queue imbalance
  qi1: number | null;
  qi3: number | null;
  qi5: number | null;

  // Cont-style event-level OFI
  ofi250ms: number | null;
  ofi1s: number | null;
  ofi3s: number | null;
  zOfi250ms: number | null;
  zOfi1s: number | null;
  zOfi3s: number | null;

  // Aggressive flow imbalance (deferred to Phase 1 microstructure.py remainder)
  afi250ms: number | null;
  afi1s: number | null;
  afi3s: number | null;

  // Queue hazard per side (deferred)
  hazardBid1s: number | null;
  hazardAsk1s: number | null;

  // Absorption per side (deferred)
  absBid1s: number | null;
  absAsk1s: number | null;

  // Refill / iceberg proxy per side (deferred)
  refillBid1s: number | null;
  refillAsk1s: number | null;

  // Micro-volatility (1s EWMA std of mid-tick differences)
  sigma1sTicks: number | null;

  // Spread in ticks
  spreadTicks: number | null;
}

/**
 * Convert the nested wire `ScalpState` block to the domain vector.
 *
 * Returns null when the snapshot does not carry a `scalp_state` block —
 * i.e. when the sidecar has not been asked to populate it, when the depth
 * book is empty, or when the scalp_state field was explicitly set to null.
 * Callers must handle null gracefully.
 */
export function buildScalperStateVector(snap: LobSnapshot | null | undefined): ScalperStateVector | null {
  if (!snap) return null;
  const s: ScalpState | null | undefined = snap.scalp_state;
  if (!s) return null;

  return {
    bidPx: Array.isArray(s.bid_px) ? s.bid_px.slice() : [],
    askPx: Array.isArray(s.ask_px) ? s.ask_px.slice() : [],
    bidSz: Array.isArray(s.bid_sz) ? s.bid_sz.slice() : [],
    askSz: Array.isArray(s.ask_sz) ? s.ask_sz.slice() : [],

    microprice: s.microprice,
    micropriceEdgeTicks: s.microprice_edge_ticks,

    qi1: s.qi_1,
    qi3: s.qi_3,
    qi5: s.qi_5,

    ofi250ms: s.ofi_250ms,
    ofi1s: s.ofi_1s,
    ofi3s: s.ofi_3s,
    zOfi250ms: s.z_ofi_250ms,
    zOfi1s: s.z_ofi_1s,
    zOfi3s: s.z_ofi_3s,

    afi250ms: s.afi_250ms,
    afi1s: s.afi_1s,
    afi3s: s.afi_3s,

    hazardBid1s: s.hazard_bid_1s,
    hazardAsk1s: s.hazard_ask_1s,

    absBid1s: s.abs_bid_1s,
    absAsk1s: s.abs_ask_1s,

    refillBid1s: s.refill_bid_1s,
    refillAsk1s: s.refill_ask_1s,

    sigma1sTicks: s.sigma_1s_ticks,

    spreadTicks: s.spread_ticks,
  };
}

// ─── Deterministic gate ──────────────────────────────────────────────────────

export type ScalperDirection = 'long' | 'short';

/**
 * Configuration for `evaluateScalperDeterministicGate`. Defaults mirror the
 * initial priors from plan §4. They are NOT tuned constants — Phase 4
 * backtesting will replace them with calibrated values loaded from
 * config/indicator-config.json under the `lob_mbo_scalp` block.
 */
export interface ScalperDeterministicGateConfig {
  /** Maximum allowed spread in ticks (inclusive). */
  spreadMaxTicks: number;
  /** Minimum |QI(5)| required for entry. */
  qiMin: number;
  /** Minimum |microprice edge| in ticks required for entry. */
  edgeMinTicks: number;
  /** Minimum |z-OFI 250ms| threshold ("fast"). */
  zOfiFastMin: number;
  /** Minimum |z-OFI 1s| threshold ("slow"). */
  zOfiSlowMin: number;
  /** Minimum same-side absorption ratio for the disjunction branch. */
  absorptionMin: number;
  /** Minimum opposite-side hazard diff for the disjunction branch. */
  hazardDiffMin: number;
}

export const DEFAULT_SCALPER_GATE_CONFIG: ScalperDeterministicGateConfig = {
  spreadMaxTicks: 1,
  qiMin: 0.15,
  edgeMinTicks: 0.10,
  zOfiFastMin: 0.5,
  zOfiSlowMin: 0.25,
  absorptionMin: 0.55,
  hazardDiffMin: 0.10,
};

/**
 * Rejection reason strings are stable telemetry keys. Append-only — never
 * rename after they land, because downstream dashboards bucket on them.
 */
export type ScalperDeterministicRejectReason =
  | 'no_scalp_state'
  | 'spread_unavailable'
  | 'spread_too_wide'
  | 'qi_unavailable'
  | 'qi_below_threshold'
  | 'microprice_edge_unavailable'
  | 'microprice_edge_below_threshold'
  | 'ofi_warmup'
  | 'z_ofi_fast_below_threshold'
  | 'z_ofi_slow_below_threshold'
  | 'absorption_hazard_unavailable'
  | 'absorption_hazard_below_threshold';

export interface ScalperDeterministicVerdict {
  passed: boolean;
  rejectReason: ScalperDeterministicRejectReason | null;
}

/**
 * Evaluate the deterministic portion of the scalper entry gate.
 *
 * This function is side-effect-free, never throws, and fails safely on
 * missing inputs by returning a stable `rejectReason`. The ML and
 * expectancy clauses from plan §4 live in separate modules and are
 * combined in `shouldAllowScalperEntry` (Phase 5).
 *
 * Check order matches the rejectReason precedence documented at the
 * top of this file.
 */
export function evaluateScalperDeterministicGate(
  vec: ScalperStateVector | null,
  direction: ScalperDirection,
  config: ScalperDeterministicGateConfig = DEFAULT_SCALPER_GATE_CONFIG,
): ScalperDeterministicVerdict {
  if (vec === null) {
    return { passed: false, rejectReason: 'no_scalp_state' };
  }

  // 1. Spread
  if (vec.spreadTicks === null) {
    return { passed: false, rejectReason: 'spread_unavailable' };
  }
  if (vec.spreadTicks > config.spreadMaxTicks) {
    return { passed: false, rejectReason: 'spread_too_wide' };
  }

  // 2. Queue imbalance — direction-signed
  if (vec.qi5 === null) {
    return { passed: false, rejectReason: 'qi_unavailable' };
  }
  if (direction === 'long' && vec.qi5 <= config.qiMin) {
    return { passed: false, rejectReason: 'qi_below_threshold' };
  }
  if (direction === 'short' && vec.qi5 >= -config.qiMin) {
    return { passed: false, rejectReason: 'qi_below_threshold' };
  }

  // 3. Microprice edge — direction-signed
  if (vec.micropriceEdgeTicks === null) {
    return { passed: false, rejectReason: 'microprice_edge_unavailable' };
  }
  if (direction === 'long' && vec.micropriceEdgeTicks <= config.edgeMinTicks) {
    return { passed: false, rejectReason: 'microprice_edge_below_threshold' };
  }
  if (direction === 'short' && vec.micropriceEdgeTicks >= -config.edgeMinTicks) {
    return { passed: false, rejectReason: 'microprice_edge_below_threshold' };
  }

  // 4. z-OFI (both horizons) — direction-signed
  if (vec.zOfi250ms === null || vec.zOfi1s === null) {
    return { passed: false, rejectReason: 'ofi_warmup' };
  }
  if (direction === 'long' && vec.zOfi250ms <= config.zOfiFastMin) {
    return { passed: false, rejectReason: 'z_ofi_fast_below_threshold' };
  }
  if (direction === 'short' && vec.zOfi250ms >= -config.zOfiFastMin) {
    return { passed: false, rejectReason: 'z_ofi_fast_below_threshold' };
  }
  if (direction === 'long' && vec.zOfi1s <= config.zOfiSlowMin) {
    return { passed: false, rejectReason: 'z_ofi_slow_below_threshold' };
  }
  if (direction === 'short' && vec.zOfi1s >= -config.zOfiSlowMin) {
    return { passed: false, rejectReason: 'z_ofi_slow_below_threshold' };
  }

  // 5. Absorption / hazard disjunction (fail-safe on deferred nulls).
  //
  // Long wants bullish absorption at the bid OR a higher ask-side hazard
  // than bid-side hazard (asks more likely to cancel/execute first).
  // Short is the symmetric case.
  //
  // All four inputs are deferred to Phase 1 microstructure.py remainder.
  // If they are all null, we fail safely with
  // 'absorption_hazard_unavailable' — the gate rejects but never throws.
  const absSide = direction === 'long' ? vec.absBid1s : vec.absAsk1s;
  const hazardSameSide = direction === 'long' ? vec.hazardBid1s : vec.hazardAsk1s;
  const hazardOppSide = direction === 'long' ? vec.hazardAsk1s : vec.hazardBid1s;

  const absAvailable = absSide !== null;
  const hazardAvailable = hazardSameSide !== null && hazardOppSide !== null;

  if (!absAvailable && !hazardAvailable) {
    return { passed: false, rejectReason: 'absorption_hazard_unavailable' };
  }

  const absOk = absAvailable && (absSide as number) > config.absorptionMin;
  const hazardOk =
    hazardAvailable &&
    ((hazardOppSide as number) - (hazardSameSide as number)) > config.hazardDiffMin;

  if (!absOk && !hazardOk) {
    return { passed: false, rejectReason: 'absorption_hazard_below_threshold' };
  }

  return { passed: true, rejectReason: null };
}

// ─── Persistence gate ────────────────────────────────────────────────────────

/**
 * Per-direction entry in the runner-owned persistence state. Stores the
 * last deterministic-gate evaluation for this direction so the persistence
 * gate can require two consecutive passes separated by 100–250 ms.
 *
 * `passedDeterministic` is included explicitly so the state machine
 * distinguishes "a deterministic pass happened just now" from "an
 * evaluation happened but rejected" — only the former starts the
 * persistence window.
 *
 * `mlReady` (Phase 5) is the ML-ready flag observed on this cycle.
 * The shadow decision's consecutive-ready-cycles guard reads the
 * prior entry's `mlReady` to decide whether the CURRENT cycle's ML
 * probability is trustworthy — a single ready=true flicker is not
 * enough to carry an ML-backed allow. `null` means "no prior ML
 * evaluation on this record" (e.g. cold start, or the prior cycle
 * bailed pre-gate before the ML call).
 */
export interface ScalperPersistenceEntry {
  tsMs: number;
  passedDeterministic: boolean;
  mlReady: boolean | null;
}

/**
 * Runner-owned persistence state for the scalper. One entry per direction
 * so long and short are independent — a long pass at t=0 never satisfies
 * a short persistence check at t=150ms and vice versa.
 */
export interface ScalperPersistenceState {
  long: ScalperPersistenceEntry | null;
  short: ScalperPersistenceEntry | null;
}

export function emptyScalperPersistenceState(): ScalperPersistenceState {
  return { long: null, short: null };
}

export interface ScalperPersistenceConfig {
  /** Minimum ms since prior deterministic pass (inclusive). */
  minMs: number;
  /** Maximum ms since prior deterministic pass (inclusive). */
  maxMs: number;
}

export const DEFAULT_SCALPER_PERSISTENCE_CONFIG: ScalperPersistenceConfig = {
  minMs: 100,
  maxMs: 250,
};

export type ScalperPersistenceRejectReason =
  | 'no_prior_pass'
  | 'prior_did_not_pass_deterministic'
  | 'prior_too_recent'
  | 'prior_too_old';

export interface ScalperPersistenceVerdict {
  passed: boolean;
  rejectReason: ScalperPersistenceRejectReason | null;
  /** Wall-clock delta from prior pass, or null when no prior entry exists. */
  ageMs: number | null;
}

/**
 * Check whether a prior deterministic-passing evaluation exists for the
 * given direction in the 100–250 ms window ending at `nowMs`.
 *
 * This is a pure read of the state — it does NOT record the current
 * evaluation. The runner calls `recordScalperDeterministicResult` AFTER
 * running the deterministic gate to update the state for the NEXT cycle.
 */
export function evaluateScalperPersistenceGate(
  state: ScalperPersistenceState,
  direction: ScalperDirection,
  nowMs: number,
  config: ScalperPersistenceConfig = DEFAULT_SCALPER_PERSISTENCE_CONFIG,
): ScalperPersistenceVerdict {
  const entry = direction === 'long' ? state.long : state.short;
  if (entry === null) {
    return { passed: false, rejectReason: 'no_prior_pass', ageMs: null };
  }
  if (!entry.passedDeterministic) {
    return {
      passed: false,
      rejectReason: 'prior_did_not_pass_deterministic',
      ageMs: nowMs - entry.tsMs,
    };
  }
  const age = nowMs - entry.tsMs;
  if (age < config.minMs) {
    return { passed: false, rejectReason: 'prior_too_recent', ageMs: age };
  }
  if (age > config.maxMs) {
    return { passed: false, rejectReason: 'prior_too_old', ageMs: age };
  }
  return { passed: true, rejectReason: null, ageMs: age };
}

/**
 * Record the result of a deterministic gate evaluation for a given direction.
 * Mutates the state in place. The runner calls this after every scalper
 * generator cycle so the next cycle's persistence gate has fresh state.
 *
 * The `mlReady` parameter is the ML-ready flag observed on THIS cycle.
 * It is stored on the persistence entry so the NEXT cycle's shadow
 * decision consecutive-ready guard can read it via
 * `readScalperPriorMlReadiness`. A cycle that bailed pre-gate (before
 * the ML call) passes `null` — that records "no prior ML evaluation on
 * this cycle" so the guard on the following cycle fails closed.
 */
export function recordScalperDeterministicResult(
  state: ScalperPersistenceState,
  direction: ScalperDirection,
  nowMs: number,
  passedDeterministic: boolean,
  mlReady: boolean | null,
): void {
  const entry: ScalperPersistenceEntry = { tsMs: nowMs, passedDeterministic, mlReady };
  if (direction === 'long') {
    state.long = entry;
  } else {
    state.short = entry;
  }
}

/**
 * Read the prior-cycle ML-readiness snapshot for a given direction.
 * Returns the recorded `mlReady` flag plus the wall-clock delta from
 * the prior record, or `{ priorMlReady: null, priorAgeMs: null }` when
 * no prior entry exists for this direction. Pure read — does NOT
 * mutate the state.
 *
 * Used by the Phase 5 shadow decision builder to populate the
 * consecutive-ready guard input. The shadow decision's own
 * `shouldAllowScalperEntry` enforces the allow rule; this helper only
 * reports what was last seen.
 */
export function readScalperPriorMlReadiness(
  state: ScalperPersistenceState,
  direction: ScalperDirection,
  nowMs: number,
): { priorMlReady: boolean | null; priorAgeMs: number | null } {
  const entry = direction === 'long' ? state.long : state.short;
  if (entry === null) return { priorMlReady: null, priorAgeMs: null };
  return { priorMlReady: entry.mlReady, priorAgeMs: nowMs - entry.tsMs };
}
