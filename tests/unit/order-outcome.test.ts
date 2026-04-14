/**
 * order-outcome.test.ts — Regression tests for the shared exit-outcome
 * normalizer. Pins the paper-fill contract so the target-position REDUCE and
 * ML partial-exit paths can never diverge on success-detection semantics.
 *
 * Why this file exists: an earlier version of the target-position REDUCE
 * consumer checked `status === 'filled'` directly, which broke in paper mode
 * because successful paper fills use `status === 'simulated'`. The resulting
 * infinite rejection loop ran for dozens of cycles before being caught. This
 * test suite pins the contract so any future refactor that re-introduces
 * strict status checks trips a unit test before shipping.
 */

import { describe, it, expect } from 'vitest';
import { normalizeExitOutcome } from '../../src/autotrade/order-outcome.js';
import type { OrderResult } from '../../src/autotrade/types.js';

function mkResult(overrides: Partial<OrderResult>): OrderResult {
  return {
    order_id: 'TEST_ORDER',
    fill_price: 100.5,
    fill_time_iso: '2026-04-14T12:00:00Z',
    quantity: 2,
    side: 'long',
    slippage_pts: 0,
    fee_usd: 0.5,
    status: 'filled',
    ...overrides,
  };
}

describe('normalizeExitOutcome — accepted statuses', () => {
  it('accepts status=filled with quantity > 0', () => {
    const out = normalizeExitOutcome(mkResult({ status: 'filled', quantity: 2 }), 2);
    expect(out.accepted).toBe(true);
    expect(out.filledQty).toBe(2);
    expect(out.fillPrice).toBe(100.5);
    expect(out.status).toBe('filled');
    expect(out.reason).toBeUndefined();
  });

  it('accepts status=simulated with quantity > 0 (the paper-mode regression guard)', () => {
    const out = normalizeExitOutcome(mkResult({ status: 'simulated', quantity: 2 }), 2);
    expect(out.accepted).toBe(true);
    expect(out.filledQty).toBe(2);
    expect(out.status).toBe('simulated');
  });

  it('accepts status=partially_filled (forward-compat with live adapters)', () => {
    const out = normalizeExitOutcome(
      mkResult({ status: 'partially_filled' as OrderResult['status'], quantity: 1 }),
      2,
    );
    expect(out.accepted).toBe(true);
    expect(out.filledQty).toBe(1);
  });

  it('accepts status=partial_fill (alternate spelling some adapters use)', () => {
    const out = normalizeExitOutcome(
      mkResult({ status: 'partial_fill' as OrderResult['status'], quantity: 1 }),
      2,
    );
    expect(out.accepted).toBe(true);
    expect(out.filledQty).toBe(1);
  });
});

describe('normalizeExitOutcome — rejected statuses', () => {
  it('rejects status=rejected', () => {
    const out = normalizeExitOutcome(mkResult({ status: 'rejected', quantity: 0 }), 2);
    expect(out.accepted).toBe(false);
    expect(out.filledQty).toBe(0);
    expect(out.reason).toMatch(/status=rejected/);
  });

  it('rejects accepted status with quantity <= 0 (except simulated — see next test)', () => {
    const out = normalizeExitOutcome(mkResult({ status: 'filled', quantity: 0 }), 2);
    expect(out.accepted).toBe(false);
    expect(out.filledQty).toBe(0);
    expect(out.reason).toMatch(/qty=0/);
  });

  it('rejects unknown status strings', () => {
    const out = normalizeExitOutcome(
      mkResult({ status: 'cancelled' as OrderResult['status'], quantity: 2 }),
      2,
    );
    expect(out.accepted).toBe(false);
    expect(out.reason).toMatch(/status=cancelled/);
  });
});

describe('normalizeExitOutcome — quantity extraction and clamping', () => {
  it('uses result.quantity as the primary source', () => {
    const out = normalizeExitOutcome(mkResult({ status: 'filled', quantity: 3 }), 5);
    expect(out.filledQty).toBe(3);
  });

  it('falls back to requestedQty for simulated fills reporting 0', () => {
    // Edge case: a paper adapter that returns status='simulated' but quantity=0.
    // The helper falls back to requestedQty so the paper path still progresses.
    const out = normalizeExitOutcome(mkResult({ status: 'simulated', quantity: 0 }), 4);
    expect(out.accepted).toBe(true);
    expect(out.filledQty).toBe(4);
  });

  it('does NOT fall back to requestedQty for filled/partial statuses reporting 0 (those are real rejections)', () => {
    const filled = normalizeExitOutcome(mkResult({ status: 'filled', quantity: 0 }), 4);
    expect(filled.accepted).toBe(false);
    const partial = normalizeExitOutcome(
      mkResult({ status: 'partially_filled' as OrderResult['status'], quantity: 0 }),
      4,
    );
    expect(partial.accepted).toBe(false);
  });

  it('clamps filledQty to requestedQty (never over-decrement local state)', () => {
    // Defensive: if a broker adapter ever echoes back more than requested,
    // the helper must never let us apply more than we asked for.
    const out = normalizeExitOutcome(mkResult({ status: 'filled', quantity: 10 }), 3);
    expect(out.accepted).toBe(true);
    expect(out.filledQty).toBe(3);
  });

  it('never returns a negative filledQty', () => {
    const out = normalizeExitOutcome(mkResult({ status: 'filled', quantity: -5 }), 3);
    // Negative quantities are treated as rejection (no fill happened).
    expect(out.accepted).toBe(false);
    expect(out.filledQty).toBe(0);
  });

  it('handles NaN quantity from malformed adapter results', () => {
    const out = normalizeExitOutcome(mkResult({ status: 'filled', quantity: NaN }), 3);
    expect(out.accepted).toBe(false);
    expect(out.filledQty).toBe(0);
  });
});

describe('normalizeExitOutcome — fillPrice extraction', () => {
  it('returns result.fill_price when finite', () => {
    const out = normalizeExitOutcome(mkResult({ fill_price: 102.25 }), 2);
    expect(out.fillPrice).toBe(102.25);
  });

  it('returns null when fill_price is NaN', () => {
    const out = normalizeExitOutcome(mkResult({ fill_price: NaN }), 2);
    expect(out.fillPrice).toBeNull();
  });
});
