/**
 * management/scalper-exit-singleflight.ts — Phase 8 single-flight exit
 * guard for the lob_mbo_scalp strategy family.
 *
 * Why this exists (per plan Phase 6 "Single-flight exit guard —
 * mandatory: prevents double-close race in the fast loop"):
 *
 *   The scalper runs a 200-500 ms exit monitor alongside the existing
 *   slower trend monitor and the fill-event callback path. At sub-
 *   second scale, three concurrent callers can each observe an exit
 *   condition (hard cap fires, reversal fires, stop fires) within the
 *   same 50 ms window and race to dispatch EXIT_NOW orders. Without a
 *   guard, the runner:
 *
 *     - Can submit two exit orders for the same position.
 *     - Can corrupt Position state by updating bracket targets
 *       between the submission and acknowledgement of an exit.
 *     - Can tight-retry on broker rejects and saturate the order API.
 *
 *   This module provides a pure, testable, per-position single-flight
 *   mechanism that the runner consults BEFORE dispatching any scalper
 *   exit intent. The guard is per-module-instance (not per-position-
 *   struct) so the position type doesn't have to grow by three fields
 *   — the state lives in a Map keyed by a position ID the caller
 *   provides.
 *
 * Lifecycle of one flight:
 *
 *   1. Caller A observes an exit condition (e.g. hard cap at t=0).
 *   2. Caller A calls `tryAcquireScalperExitSlot(posId, reason)`.
 *   3. Guard records `{ inFlight: true, reason, acquiredAtMs }` and
 *      returns `{ acquired: true }`.
 *   4. Caller B observes a DIFFERENT exit condition (reversal at t=30ms).
 *   5. Caller B calls `tryAcquireScalperExitSlot(posId, reason)`.
 *   6. Guard finds the slot already held and returns
 *      `{ acquired: false, heldByReason: 'scalper_hard_cap' }`.
 *      Caller B logs `suppressed_inflight_exit` and returns HOLD.
 *   7. Broker acks caller A's order. Runner calls
 *      `releaseScalperExitSlot(posId, 'ack')` and the slot is free.
 *   8. If the broker REJECTS caller A's order instead, runner calls
 *      `releaseScalperExitSlot(posId, 'reject', { backoffMs })`.
 *      The slot is freed BUT a retry backoff window opens: any
 *      `tryAcquireScalperExitSlot` call before `backoffUntilMs` is
 *      refused with `{ acquired: false, heldByReason: 'backoff' }`.
 *      This prevents tight retry loops on a stuck exit order.
 *
 * Design invariants:
 *
 *   - PURE / NO I/O. The guard holds state in a module-level Map.
 *     No filesystem, no network, no threads, no timers. Tests drive
 *     it deterministically with an injected `nowMs` argument.
 *
 *   - NEVER THROWS. Every invalid input (null posId, empty reason,
 *     bad backoff) degrades to a safe no-op return rather than
 *     crashing the caller. Corrupting the guard would wedge the
 *     scalper exit dispatcher permanently.
 *
 *   - PER-POSITION. Positions are keyed by an opaque `posId`
 *     string the runner provides (typically `Position.trade_id`).
 *     Two different positions never share a slot.
 *
 *   - CLOCK-INJECTED. `tryAcquireScalperExitSlot` and
 *     `releaseScalperExitSlot` both take an optional `nowMs` so
 *     tests can drive the backoff window without timers.
 *
 *   - MEMORY-BOUNDED. A `purgeStaleSlots(nowMs, maxAgeMs)` helper
 *     lets the runner periodically drop slots for positions that
 *     were closed externally without going through the guard — e.g.
 *     after a session restart — so the map never grows unbounded.
 *
 *   - OBSERVABILITY. `peekScalperExitSlot(posId)` returns the
 *     current slot shape for logging / dashboard telemetry. Never
 *     mutates.
 *
 * The runner wiring is small:
 *
 *   - Before any scalper exit dispatch:
 *       const acq = tryAcquireScalperExitSlot(pos.trade_id, reason, Date.now());
 *       if (!acq.acquired) {
 *         log('suppressed_inflight_exit', { ...pos, wouldBeReason: reason, heldBy: acq.heldByReason });
 *         return;  // do not submit
 *       }
 *
 *   - On broker ack: releaseScalperExitSlot(pos.trade_id, 'ack', Date.now())
 *   - On broker reject: releaseScalperExitSlot(pos.trade_id, 'reject', Date.now(), 250)
 *   - On bracket update: the scalper monitor's first line is
 *       `if (getScalperExitSlotInFlight(pos.trade_id)) return;`
 *     — bracket updates skip when an exit is in flight.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The reason this slot was acquired. Typically the `ExitReason` enum
 * the exit engine chose (e.g. `scalper_hard_cap`, `scalper_reversal`,
 * `stop_loss`, `target_1`) but the guard does NOT enforce a specific
 * type — it just logs whatever the caller passes so the loser's log
 * line can record which caller won the race.
 */
export type ScalperExitSlotReason = string;

/**
 * A held slot entry in the module-level map. `inFlight` is always
 * true — we delete the entry on release. `backoffUntilMs` is set when
 * a REJECT release opens a retry window.
 */
export interface ScalperExitSlot {
  /** The reason the currently-held (or last-held) caller acquired the slot. */
  reason: ScalperExitSlotReason;
  /** Wall-clock ms (Date.now()) when the slot was acquired. */
  acquiredAtMs: number;
  /**
   * When set, any `tryAcquireScalperExitSlot` call before this
   * timestamp is REFUSED even when the slot is otherwise free.
   * Opened by `releaseScalperExitSlot(..., 'reject', ..., backoffMs)`.
   * Null when no backoff is active.
   */
  backoffUntilMs: number | null;
}

// ─── Module state ──────────────────────────────────────────────────────────

/**
 * Map of position ID → slot. One entry per open scalper position that
 * has ever had an exit dispatched. Released slots (ack path) are
 * deleted entirely. Rejected slots stay in the map with
 * `backoffUntilMs` set until the backoff expires; the next `acquire`
 * call at/after `backoffUntilMs` clears the backoff and grants the
 * slot to a new caller.
 */
const _slots: Map<string, ScalperExitSlot> = new Map();

/** Test-only: reset the guard between cases. Never call from production. */
export function _resetScalperExitSlotsForTests(): void {
  _slots.clear();
}

// ─── Core API ──────────────────────────────────────────────────────────────

export interface TryAcquireResult {
  /** True iff the caller now holds the slot. False iff suppressed. */
  acquired: boolean;
  /** When `acquired=false`, carries the held reason or 'backoff' so logs can attribute the suppression. */
  heldByReason: ScalperExitSlotReason | 'backoff' | null;
  /** When `acquired=false` and the suppression is a backoff, the expiry timestamp. Null otherwise. */
  backoffUntilMs: number | null;
}

/**
 * Attempt to acquire the exit slot for a position. Returns
 * `{ acquired: true }` on first call and `{ acquired: false }` on
 * every subsequent call until `releaseScalperExitSlot` fires OR the
 * backoff window expires.
 *
 * `reason` is a free-form string describing the triggering exit
 * condition. Recorded on the slot so the loser's log line can
 * attribute the win.
 *
 * `nowMs` defaults to `Date.now()` so production calls can omit it;
 * tests pass it explicitly to drive backoff deterministically.
 */
export function tryAcquireScalperExitSlot(
  posId: string,
  reason: ScalperExitSlotReason,
  nowMs: number = Date.now(),
): TryAcquireResult {
  if (!posId || typeof posId !== 'string' || posId.length === 0) {
    return { acquired: false, heldByReason: null, backoffUntilMs: null };
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    return { acquired: false, heldByReason: null, backoffUntilMs: null };
  }
  if (!Number.isFinite(nowMs)) {
    return { acquired: false, heldByReason: null, backoffUntilMs: null };
  }

  const existing = _slots.get(posId);
  if (existing) {
    // Backoff window active?
    if (existing.backoffUntilMs !== null && nowMs < existing.backoffUntilMs) {
      return {
        acquired: false,
        heldByReason: 'backoff',
        backoffUntilMs: existing.backoffUntilMs,
      };
    }
    // Slot is held by another caller (not in backoff).
    if (existing.backoffUntilMs === null) {
      return {
        acquired: false,
        heldByReason: existing.reason,
        backoffUntilMs: null,
      };
    }
    // Backoff expired — fall through and let this caller take the slot.
  }

  _slots.set(posId, {
    reason,
    acquiredAtMs: nowMs,
    backoffUntilMs: null,
  });
  return { acquired: true, heldByReason: null, backoffUntilMs: null };
}

export type ScalperExitReleaseReason = 'ack' | 'reject';

export interface ReleaseOptions {
  /**
   * On a REJECT release, open a backoff window of this many ms.
   * Subsequent `tryAcquireScalperExitSlot` calls before the window
   * expires are refused with `heldByReason='backoff'`. Default 250 ms
   * per plan Phase 6 "avoid a tight retry loop on a stuck order".
   * Ignored on `ack` releases.
   */
  backoffMs?: number;
}

/**
 * Release the exit slot for a position. Always called once per slot
 * acquired, from the runner's broker ack/reject handler.
 *
 * On `ack`: the slot is deleted outright — the next exit attempt for
 * this position (if any) starts with a clean slate.
 *
 * On `reject`: the slot is updated to carry a `backoffUntilMs` value
 * `nowMs + backoffMs`. Subsequent acquire attempts are refused
 * until the backoff expires. This prevents a tight retry loop when
 * the broker returns a persistent error on the exit order.
 *
 * Unknown `posId` is a no-op (safe — the runner may release a slot
 * that never existed if the guard was reset mid-session).
 */
export function releaseScalperExitSlot(
  posId: string,
  releaseReason: ScalperExitReleaseReason,
  nowMs: number = Date.now(),
  options: ReleaseOptions = {},
): void {
  if (!posId || typeof posId !== 'string') return;

  if (releaseReason === 'ack') {
    _slots.delete(posId);
    return;
  }

  if (releaseReason === 'reject') {
    const backoffMs = typeof options.backoffMs === 'number' && Number.isFinite(options.backoffMs) && options.backoffMs > 0
      ? options.backoffMs
      : 250;
    const existing = _slots.get(posId);
    if (!existing) return;
    _slots.set(posId, {
      reason: existing.reason,
      acquiredAtMs: existing.acquiredAtMs,
      backoffUntilMs: nowMs + backoffMs,
    });
    return;
  }
}

/**
 * Read the current slot state for a position without mutating it.
 * Returns null when no slot exists. Used by the scalper monitor's
 * first-line check and by dashboards / log writers for observability.
 */
export function peekScalperExitSlot(posId: string): ScalperExitSlot | null {
  if (!posId || typeof posId !== 'string') return null;
  const slot = _slots.get(posId);
  if (!slot) return null;
  // Return a copy so callers cannot mutate the internal state.
  return {
    reason: slot.reason,
    acquiredAtMs: slot.acquiredAtMs,
    backoffUntilMs: slot.backoffUntilMs,
  };
}

/**
 * Convenience predicate: "is there an exit in flight for this
 * position right now?" Distinct from "is there a slot" — a slot with
 * only a backoffUntilMs and no fresh hold is NOT in-flight for the
 * purposes of bracket updates. The scalper monitor uses this for the
 * "skip feature build" first-line check.
 *
 * `nowMs` defaults to `Date.now()` so production callers omit it.
 */
export function getScalperExitSlotInFlight(posId: string, nowMs: number = Date.now()): boolean {
  const slot = _slots.get(posId);
  if (!slot) return false;
  if (slot.backoffUntilMs !== null) {
    // In backoff — not in flight but not acquirable either.
    return nowMs < slot.backoffUntilMs ? false : false;
  }
  return true;
}

/**
 * Purge slots older than `maxAgeMs`. Called periodically by the
 * runner (e.g. once per minute) so positions that were closed
 * externally — session restart, recovery replay, operator kill —
 * don't leave stale guards in the map indefinitely.
 *
 * Returns the number of slots removed. Pure — no side effects beyond
 * the internal map mutation.
 */
export function purgeStaleSlots(nowMs: number, maxAgeMs: number): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;
  let removed = 0;
  for (const [posId, slot] of _slots.entries()) {
    const age = nowMs - slot.acquiredAtMs;
    if (age > maxAgeMs) {
      _slots.delete(posId);
      removed++;
    }
  }
  return removed;
}

/** Test helper: how many slots are currently held? */
export function countScalperExitSlots(): number {
  return _slots.size;
}
