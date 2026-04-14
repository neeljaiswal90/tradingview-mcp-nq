/**
 * order-outcome.ts — Shared normalization for adapter exit results.
 *
 * All consumers of `adapter.placeExit()` should pass the result through
 * `normalizeExitOutcome()` before acting on it. This guarantees:
 *
 *   1. Successful paper fills (status='simulated') are accepted.
 *   2. Successful live fills (status='filled') are accepted.
 *   3. Future partial-fill statuses ('partially_filled', 'partial_fill') are
 *      accepted without code changes at every call site.
 *   4. Rejected orders are never silently applied to local state.
 *   5. The applied quantity never exceeds what was requested, even if a
 *      broker adapter returns a larger filled_qty than requested.
 *
 * Call sites (V1a, as of rollout):
 *   - runner.ts target-position REDUCE consumer
 *   - runner.ts ML partial-exit consumer (EXIT_PARTIAL action)
 *
 * PT1/PT2 / full-exit paths intentionally NOT using this helper yet — they
 * already trust the adapter result unconditionally and have different state
 * plumbing. Folding them in is a separate refactor.
 */

import type { OrderResult } from './types.js';

/**
 * Statuses that mean "the order succeeded in some form." Extend this set
 * when new broker adapters introduce new success variants.
 */
const ACCEPTED_STATUSES = new Set<string>([
  'filled',
  'simulated',
  // Forward-compat — no current adapter emits these, but when live broker
  // adapters land (V1b+) they will likely use one of these variants.
  'partially_filled',
  'partial_fill',
]);

export interface NormalizedExitOutcome {
  /** True when the outcome should be applied to local position state. */
  accepted: boolean;
  /**
   * Quantity to apply to `positionManager.applyPartialExit()` or similar.
   * Clamped to `[0, requestedQty]` so we never over-decrement local state if
   * a future adapter returns a larger quantity than requested.
   *
   * NOTE: Always use this field when updating local state — never use the
   * originally-requested quantity, because a partial fill may be smaller.
   */
  filledQty: number;
  /**
   * Fill price for the decrement. Null only when the adapter omits price info
   * entirely; callers should fall back to the submission price in that case.
   */
  fillPrice: number | null;
  /** The raw status string, for logging. */
  status: string;
  /**
   * When `accepted === false`, a short human-readable reason string for
   * structured rejection logs. Undefined on accepted outcomes.
   */
  reason?: string;
}

/**
 * Normalize an adapter exit result into a uniform success/failure structure
 * that all exit consumers can handle identically.
 *
 * @param result       The raw OrderResult returned by adapter.placeExit().
 * @param requestedQty The quantity passed into adapter.placeExit(). Used as a
 *                     fallback for simulated fills (which may not echo filled
 *                     quantity) and as the clamp ceiling.
 */
export function normalizeExitOutcome(
  result: OrderResult,
  requestedQty: number,
): NormalizedExitOutcome {
  const status = result.status ?? 'unknown';

  // Quantity extraction: prefer the adapter's reported quantity. For simulated
  // fills that report 0 (edge case), fall back to the requested qty so the
  // paper path still progresses. A real broker adapter reporting 0 with a
  // success status would be wrong, but the clamp below bounds the damage.
  let filledQty = Number.isFinite(result.quantity) ? result.quantity : 0;
  if (filledQty <= 0 && status === 'simulated') {
    filledQty = requestedQty;
  }

  // Always clamp: never decrement local state by more than we asked for.
  if (filledQty > requestedQty) filledQty = requestedQty;
  if (filledQty < 0) filledQty = 0;

  const fillPrice =
    typeof result.fill_price === 'number' && Number.isFinite(result.fill_price)
      ? result.fill_price
      : null;

  const accepted = ACCEPTED_STATUSES.has(status) && filledQty > 0;

  return {
    accepted,
    filledQty: accepted ? filledQty : 0,
    fillPrice,
    status,
    reason: accepted ? undefined : `status=${status}${filledQty <= 0 ? ' qty=0' : ''}`,
  };
}
