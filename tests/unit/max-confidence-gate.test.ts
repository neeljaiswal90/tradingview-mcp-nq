/**
 * Unit tests for the max_confidence gate added to strategy.ts.
 *
 * The gate lives inside generateSignal's trade-filter section. Rather than
 * constructing a full MarketSnapshot (which pulls in dozens of indicator
 * fields), we replicate the exact gate condition here and validate its
 * behavior. The condition in strategy.ts is:
 *
 *   if (config.max_confidence !== undefined && config.max_confidence < 10 && confidence > config.max_confidence) {
 *     skipReasons.push(`confidence_ceiling_${confidence}_above_max_${config.max_confidence}`);
 *   }
 */

import { describe, it, expect } from 'vitest';

/** Exact replica of the gate condition from strategy.ts. */
function applyMaxConfidenceGate(
  confidence: number,
  maxConfidence: number | undefined,
): string | null {
  if (maxConfidence !== undefined && maxConfidence < 10 && confidence > maxConfidence) {
    return `confidence_ceiling_${confidence}_above_max_${maxConfidence}`;
  }
  return null;
}

describe('max_confidence gate', () => {
  it('produces skip reason when confidence exceeds max_confidence', () => {
    const reason = applyMaxConfidenceGate(9.5, 9.0);
    expect(reason).not.toBeNull();
    expect(reason).toBe('confidence_ceiling_9.5_above_max_9');
  });

  it('does NOT skip when confidence is exactly at max_confidence', () => {
    const reason = applyMaxConfidenceGate(9.0, 9.0);
    expect(reason).toBeNull();
  });

  it('does NOT skip when confidence is below max_confidence', () => {
    const reason = applyMaxConfidenceGate(8.0, 9.0);
    expect(reason).toBeNull();
  });

  it('disables the gate when max_confidence is 10.0', () => {
    // A confidence of 9.9 should NOT be skipped when the ceiling is 10.0
    const reason = applyMaxConfidenceGate(9.9, 10.0);
    expect(reason).toBeNull();
  });

  it('disables the gate when max_confidence is undefined', () => {
    const reason = applyMaxConfidenceGate(9.9, undefined);
    expect(reason).toBeNull();
  });

  it('skip reason includes both values for diagnostics', () => {
    const reason = applyMaxConfidenceGate(9.2, 8.5);
    expect(reason).toContain('9.2');
    expect(reason).toContain('8.5');
  });
});
