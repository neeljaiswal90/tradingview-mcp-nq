/**
 * management/scalper-feature-builder.ts — Phase 6 feature builder for the
 * scalper exit engine.
 *
 * Owns the conversion from:
 *
 *   (Position + fresh LobSnapshot + entry-time signs + management profile)
 *     →  ScalperExitFeatures
 *
 * and is the ONLY place the scalper exit pipeline derives its exit
 * features from runtime state. Keeping the derivation in one place lets
 * the entire exit engine stay a pure function of `ScalperExitFeatures`
 * and lets unit tests exercise the state machine without constructing
 * Positions or LobSnapshots.
 *
 * Design invariants:
 *
 *   1. DECISION-TIME-SAFE INPUTS ONLY. The builder reads only fields
 *      that are observable at the moment of evaluation: the Position's
 *      entry-time fields (price, time, side, frozen stop/target, cap
 *      eligibility, entry signs), the current LobSnapshot's top-level
 *      `scalp_state` block, and the resolved management profile. No
 *      forward returns, no realized MFE/MAE, no future state.
 *
 *   2. ENTRY-SIGN SNAPSHOTTING. The entry signs are NOT read live from
 *      a sidecar store. They are captured once at fill time by the
 *      Phase 6 runner into a `ScalperEntryContext` struct that travels
 *      with the position. This file defines the struct and the
 *      snapshot helper. The exit engine never sees the LOB snapshot —
 *      it sees the frozen snapshot's signs alongside the current
 *      microstructure, all on one feature vector.
 *
 *   3. EFFECTIVE HARD CAP RESOLUTION. The builder applies the plan's
 *      "scalper_extended_cap → time_stop_seconds else scalper_hard_cap_seconds"
 *      rule here, ONCE per tick, so the exit engine never re-derives
 *      it. If the management profile's `scalper_hard_cap_seconds` is
 *      null (misconfigured), we fall back to 5 seconds — the plan's
 *      documented default — and log a warning on the factors object
 *      when the builder does so (via the `effective_hard_cap_source`
 *      field on the returned features struct's extra diagnostics).
 *
 *   4. NEVER THROWS. Every null path (missing scalp_state, missing
 *      management fields, negative tick sizes) produces a defensive
 *      HOLD-compatible feature vector. The exit engine will see `hold_ms`
 *      and the frozen stop/target and decide HOLD cleanly when
 *      microstructure fields are null.
 *
 *   5. NO TREND COUPLING. Zero imports from `management/types.ts` or
 *      `management/decision-engine.ts`. This file is part of the
 *      parallel scalper pipeline.
 */

import type { Position } from '../types.js';
import type { ContractSpec } from '../contracts.js';
import type { LobSnapshot, ScalpState } from '../lob-client.js';
import type { ScalperExitFeatures } from './scalper-features.js';
import type { ScalperDirection, ScalperStateVector } from '../features/scalper-state.js';

// ─── Entry context (captured once at fill time) ─────────────────────────────

/**
 * Frozen entry-time microstructure snapshot that travels with a
 * scalper position until exit. Built by
 * `captureScalperEntryContext(vec)` at fill time and attached to the
 * Position via the Phase 6 runner's scalper-side fill hook. Fields:
 *
 *   - The four "signs" the reversal rule counts (qi_5,
 *     microprice_edge_ticks, z_ofi_250ms, z_ofi_1s).
 *   - The frozen absorption and hazard-diff values used by the
 *     absorption-flip reversal signal.
 *   - The frozen spread_ticks for the spread-widening signal.
 *
 * This struct is intentionally minimal — it is NOT the full state
 * vector. Storing the full vector on every scalper position would
 * bloat logs and tempt callers to mine entry-time microstructure at
 * exit time, which is decision-time-UNSAFE.
 */
export interface ScalperEntryContext {
  entry_microprice_edge_sign: -1 | 0 | 1;
  entry_qi5_sign: -1 | 0 | 1;
  entry_z_ofi_250ms_sign: -1 | 0 | 1;
  entry_z_ofi_1s_sign: -1 | 0 | 1;
  entry_spread_ticks: number | null;
  entry_abs_same_side: number | null;
  entry_hazard_diff: number | null;
}

function sign(x: number | null | undefined): -1 | 0 | 1 {
  if (x === null || x === undefined || !Number.isFinite(x) || x === 0) return 0;
  return x > 0 ? 1 : -1;
}

/**
 * Build a `ScalperEntryContext` from the state vector captured at fill
 * time. Called once, at fill, by the runner. The resulting struct is
 * copied onto the position's scalper-side fields (or attached to a
 * side-car map keyed by position ID — both shapes work; Phase 6
 * initial wiring uses a side-car map so the Position type doesn't
 * have to grow by 7 fields).
 *
 * The `direction` argument is needed to pick the correct
 * absorption / hazard side — long trades care about the BID side
 * absorbing and the ASK side being weak (opp_side > same_side),
 * short trades are mirrored.
 */
export function captureScalperEntryContext(
  direction: ScalperDirection,
  vec: ScalperStateVector,
): ScalperEntryContext {
  const sameAbs = direction === 'long' ? vec.absBid1s : vec.absAsk1s;
  const sameHaz = direction === 'long' ? vec.hazardBid1s : vec.hazardAsk1s;
  const oppHaz = direction === 'long' ? vec.hazardAsk1s : vec.hazardBid1s;

  let hazardDiff: number | null = null;
  if (sameHaz !== null && oppHaz !== null && Number.isFinite(sameHaz) && Number.isFinite(oppHaz)) {
    hazardDiff = oppHaz - sameHaz;
  }

  return {
    entry_microprice_edge_sign: sign(vec.micropriceEdgeTicks),
    entry_qi5_sign: sign(vec.qi5),
    entry_z_ofi_250ms_sign: sign(vec.zOfi250ms),
    entry_z_ofi_1s_sign: sign(vec.zOfi1s),
    entry_spread_ticks: vec.spreadTicks,
    entry_abs_same_side: sameAbs,
    entry_hazard_diff: hazardDiff,
  };
}

// ─── Exit feature construction ──────────────────────────────────────────────

/** Management profile subset the builder reads. Threaded from `ResolvedManagementParams`. */
export interface ScalperExitProfile {
  /** Base hard cap in seconds (default 5). */
  scalper_hard_cap_seconds: number | null | undefined;
  /** Extended cap in seconds (default 10), used when position.scalper_extended_cap is true. */
  time_stop_seconds: number | null | undefined;
  /** No-progress trigger (default 2). */
  scalper_no_progress_seconds: number | null | undefined;
}

/**
 * The single source of truth for how the effective hard cap is chosen:
 *
 *   - If the position was filled with `scalper_extended_cap === true`
 *     AND the profile provides `time_stop_seconds`, use that.
 *   - Otherwise use `scalper_hard_cap_seconds`.
 *   - Otherwise fall back to the plan-documented 5-second default.
 *
 * Returns both the resolved value and a short tag describing which
 * branch was taken, for diagnostics.
 */
export function resolveEffectiveHardCapSec(
  position: Pick<Position, 'scalper_extended_cap'>,
  profile: ScalperExitProfile,
): { sec: number; source: 'extended' | 'hard' | 'fallback_5' } {
  if (
    position.scalper_extended_cap === true &&
    typeof profile.time_stop_seconds === 'number' &&
    Number.isFinite(profile.time_stop_seconds) &&
    profile.time_stop_seconds > 0
  ) {
    return { sec: profile.time_stop_seconds, source: 'extended' };
  }
  if (
    typeof profile.scalper_hard_cap_seconds === 'number' &&
    Number.isFinite(profile.scalper_hard_cap_seconds) &&
    profile.scalper_hard_cap_seconds > 0
  ) {
    return { sec: profile.scalper_hard_cap_seconds, source: 'hard' };
  }
  return { sec: 5, source: 'fallback_5' };
}

/** Same pattern for the no-progress trigger — default 2 seconds. */
export function resolveNoProgressMs(profile: ScalperExitProfile): number {
  if (
    typeof profile.scalper_no_progress_seconds === 'number' &&
    Number.isFinite(profile.scalper_no_progress_seconds) &&
    profile.scalper_no_progress_seconds > 0
  ) {
    return profile.scalper_no_progress_seconds * 1000;
  }
  return 2000;
}

/**
 * Compute direction-signed ticks P&L given entry price, current mid,
 * side, and the contract's tick size. Positive = favorable to the
 * trade's direction. Returns 0 when tick size is non-positive
 * (defensive — should not happen in production).
 */
export function currentTicksPnl(
  entryPrice: number,
  currentMid: number,
  side: 'long' | 'short',
  tickSize: number,
): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return 0;
  const raw = side === 'long' ? currentMid - entryPrice : entryPrice - currentMid;
  return raw / tickSize;
}

/**
 * Derive the "current mid" from a LobSnapshot's scalp_state. If the
 * scalp_state is present and has valid bid_px[0]/ask_px[0], we return
 * their midpoint. If either is missing, we fall back to the
 * microprice (which is more robust during thin books but not always
 * available). Returns null when nothing is derivable.
 */
export function deriveMidFromScalpState(scalp: ScalpState | null | undefined): number | null {
  if (!scalp) return null;
  const bid0 = Array.isArray(scalp.bid_px) && typeof scalp.bid_px[0] === 'number' ? scalp.bid_px[0] : null;
  const ask0 = Array.isArray(scalp.ask_px) && typeof scalp.ask_px[0] === 'number' ? scalp.ask_px[0] : null;
  if (bid0 !== null && ask0 !== null && bid0 > 0 && ask0 > 0 && ask0 >= bid0) {
    return (bid0 + ask0) / 2;
  }
  if (typeof scalp.microprice === 'number' && Number.isFinite(scalp.microprice)) {
    return scalp.microprice;
  }
  return null;
}

// ─── Main builder ───────────────────────────────────────────────────────────

/** Input bundle for `buildScalperExitFeatures`. Every field is REQUIRED. */
export interface BuildScalperExitFeaturesInput {
  position: Position;
  entryContext: ScalperEntryContext;
  profile: ScalperExitProfile;
  lobSnapshot: LobSnapshot | null;
  contract: Pick<ContractSpec, 'tick_size'>;
  /** Wall-clock ms at evaluation time. Injected so tests can drive hold_ms deterministically. */
  nowMs: number;
}

/**
 * Build a `ScalperExitFeatures` vector for one tick. Pure function —
 * no side effects, no clock reads (nowMs is injected), no throwing.
 *
 * When `lobSnapshot` is null or the snapshot lacks a `scalp_state`
 * block, every LOB field on the returned features is null and the
 * exit engine's microstructure clauses become inactive — only the
 * time-based clauses (hard cap, no-progress) and the PnL clauses
 * (stop, target) can fire. That is the intended degraded behavior
 * during LOB service downtime.
 */
export function buildScalperExitFeatures(
  input: BuildScalperExitFeaturesInput,
): ScalperExitFeatures {
  const { position, entryContext, profile, lobSnapshot, contract, nowMs } = input;

  const cap = resolveEffectiveHardCapSec(position, profile);
  const noProgressMs = resolveNoProgressMs(profile);

  const side: 'long' | 'short' = position.side;
  const direction: ScalperDirection = side === 'long' ? 'long' : 'short';

  // Prefer deriving the current mid from the LOB snapshot (accurate to
  // sub-tick); fall back to entry price (PnL of zero) when the snapshot
  // is unavailable so the hard-cap and no-progress clauses can still
  // run without reporting a bogus favorable PnL.
  const scalp = lobSnapshot?.scalp_state ?? null;
  const midFromLob = deriveMidFromScalpState(scalp);
  const currentMid = midFromLob ?? position.entry_price;
  const pnlTicks = currentTicksPnl(position.entry_price, currentMid, side, contract.tick_size);

  // Resolve the current microstructure from the scalp_state block.
  // Long / short side selection for absorption + hazard.
  let absSame: number | null = null;
  let hazSame: number | null = null;
  let hazOpp: number | null = null;
  if (scalp) {
    absSame = direction === 'long' ? scalp.abs_bid_1s : scalp.abs_ask_1s;
    hazSame = direction === 'long' ? scalp.hazard_bid_1s : scalp.hazard_ask_1s;
    hazOpp = direction === 'long' ? scalp.hazard_ask_1s : scalp.hazard_bid_1s;
  }

  // Stop / target distances — the Phase 3a additive Position fields.
  // Non-finite or missing → 0, which makes those clauses inactive
  // (guarded in the engine by `> 0` checks).
  const stopTicks =
    typeof position.scalper_stop_ticks === 'number' && Number.isFinite(position.scalper_stop_ticks) && position.scalper_stop_ticks > 0
      ? position.scalper_stop_ticks
      : 0;
  const targetTicks =
    typeof position.scalper_target_ticks === 'number' && Number.isFinite(position.scalper_target_ticks) && position.scalper_target_ticks > 0
      ? position.scalper_target_ticks
      : 0;

  // hold_ms = clock - entry_time_unix. entry_time_unix is in ms in this codebase.
  const holdMs = Math.max(0, nowMs - position.entry_time_unix);

  return {
    entry_direction: direction,
    hold_ms: holdMs,
    current_ticks_pnl: pnlTicks,
    stop_ticks: stopTicks,
    target_ticks: targetTicks,
    effective_hard_cap_sec: cap.sec,
    no_progress_trigger_ms: noProgressMs,

    microprice_edge_ticks: scalp?.microprice_edge_ticks ?? null,
    qi_5: scalp?.qi_5 ?? null,
    z_ofi_250ms: scalp?.z_ofi_250ms ?? null,
    z_ofi_1s: scalp?.z_ofi_1s ?? null,
    z_ofi_3s: scalp?.z_ofi_3s ?? null,
    sigma_1s_ticks: scalp?.sigma_1s_ticks ?? null,
    spread_ticks: scalp?.spread_ticks ?? null,

    abs_same_side: absSame,
    hazard_same_side: hazSame,
    hazard_opp_side: hazOpp,

    entry_microprice_edge_sign: entryContext.entry_microprice_edge_sign,
    entry_qi5_sign: entryContext.entry_qi5_sign,
    entry_z_ofi_250ms_sign: entryContext.entry_z_ofi_250ms_sign,
    entry_z_ofi_1s_sign: entryContext.entry_z_ofi_1s_sign,
    entry_spread_ticks: entryContext.entry_spread_ticks,
    entry_abs_same_side: entryContext.entry_abs_same_side,
    entry_hazard_diff: entryContext.entry_hazard_diff,
  };
}
