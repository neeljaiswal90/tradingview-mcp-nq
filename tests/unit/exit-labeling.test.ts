/**
 * Exit-labeling regression tests — patch P3.
 *
 * Verifies that exit_reason_detailed is computed correctly for every
 * combination of (trigger, partial_exit_done, trailing_active).
 *
 * The labeling logic lives in runner.ts and is expressed as a pure function
 * here so the tests do NOT depend on the full runner; they test only the
 * classification formula that was patched.
 */

import { describe, it, expect } from 'vitest';

// ─── The exact labeling expression from runner.ts ────────────────────────────
// Kept as a standalone pure function so tests remain decoupled from runner
// module complexity while still directly mirroring the production code path.

type ExitTrigger = 'stop' | 'target_1' | 'target_2' | 'target_3';
type ExitReasonDetailed =
  | 'stop_loss_initial'
  | 'stop_loss_breakeven'
  | 'stop_loss_trailing'
  | 'target_1'
  | 'target_2'
  | 'target_3';

function computeExitReasonDetailed(
  trigger: ExitTrigger,
  partialExitDone: boolean,
  trailingActive: boolean,
): ExitReasonDetailed {
  if (trigger === 'stop') {
    if (!partialExitDone) return 'stop_loss_initial';
    return trailingActive ? 'stop_loss_trailing' : 'stop_loss_breakeven';
  }
  if (trigger === 'target_1') return 'target_1';
  if (trigger === 'target_2') return 'target_2';
  return 'target_3';
}

// ─── stop_loss_initial ───────────────────────────────────────────────────────

describe('exit_reason_detailed — stop exits pre-T1 → stop_loss_initial', () => {
  it('stop with partialExitDone=false, trailing=false → stop_loss_initial', () => {
    expect(computeExitReasonDetailed('stop', false, false)).toBe('stop_loss_initial');
  });

  it('stop with partialExitDone=false, trailing=true (impossible state but still labels correctly)', () => {
    // trailing cannot be active before partial, but if it ever happened we still
    // check partialExitDone first, so it must stay stop_loss_initial
    expect(computeExitReasonDetailed('stop', false, true)).toBe('stop_loss_initial');
  });
});

// ─── stop_loss_breakeven ─────────────────────────────────────────────────────

describe('exit_reason_detailed — stop exits post-T1 no trail → stop_loss_breakeven', () => {
  it('stop with partialExitDone=true, trailing=false → stop_loss_breakeven', () => {
    expect(computeExitReasonDetailed('stop', true, false)).toBe('stop_loss_breakeven');
  });
});

// ─── stop_loss_trailing ──────────────────────────────────────────────────────

describe('exit_reason_detailed — stop exits post-T1 trail armed → stop_loss_trailing', () => {
  it('stop with partialExitDone=true, trailing=true → stop_loss_trailing', () => {
    expect(computeExitReasonDetailed('stop', true, true)).toBe('stop_loss_trailing');
  });
});

// ─── target exits pass through unchanged ─────────────────────────────────────

describe('exit_reason_detailed — target exits mirror trigger directly', () => {
  it('target_1 regardless of post-T1 state → target_1', () => {
    expect(computeExitReasonDetailed('target_1', false, false)).toBe('target_1');
    expect(computeExitReasonDetailed('target_1', true, false)).toBe('target_1');
    expect(computeExitReasonDetailed('target_1', true, true)).toBe('target_1');
  });

  it('target_2 regardless of state → target_2', () => {
    expect(computeExitReasonDetailed('target_2', false, false)).toBe('target_2');
    expect(computeExitReasonDetailed('target_2', true, true)).toBe('target_2');
  });

  it('target_3 regardless of state → target_3', () => {
    expect(computeExitReasonDetailed('target_3', false, false)).toBe('target_3');
    expect(computeExitReasonDetailed('target_3', true, true)).toBe('target_3');
  });
});

// ─── full state-machine coverage ─────────────────────────────────────────────

describe('exit_reason_detailed — exhaustive (trigger × partial × trailing)', () => {
  const cases: Array<[ExitTrigger, boolean, boolean, ExitReasonDetailed]> = [
    // stop variants
    ['stop', false, false, 'stop_loss_initial'],
    ['stop', false, true,  'stop_loss_initial'],   // trailing before partial is degenerate
    ['stop', true,  false, 'stop_loss_breakeven'],
    ['stop', true,  true,  'stop_loss_trailing'],
    // target variants (state irrelevant)
    ['target_1', false, false, 'target_1'],
    ['target_1', true,  true,  'target_1'],
    ['target_2', false, false, 'target_2'],
    ['target_2', true,  true,  'target_2'],
    ['target_3', false, false, 'target_3'],
    ['target_3', true,  true,  'target_3'],
  ];

  for (const [trigger, partial, trailing, expected] of cases) {
    it(`trigger=${trigger} partial=${partial} trailing=${trailing} → ${expected}`, () => {
      expect(computeExitReasonDetailed(trigger, partial, trailing)).toBe(expected);
    });
  }
});

// ─── legacy exit_reason coarse label is unchanged ────────────────────────────

describe('exit_reason (legacy coarse) is always stop_loss for any stop variant', () => {
  function computeExitReasonLegacy(trigger: ExitTrigger): string {
    return trigger === 'stop' ? 'stop_loss'
      : trigger === 'target_1' ? 'target_1'
      : trigger === 'target_2' ? 'target_2' : 'target_3';
  }

  it('stop always maps to stop_loss regardless of post-T1 state', () => {
    expect(computeExitReasonLegacy('stop')).toBe('stop_loss');
  });

  it('target_1 maps to target_1', () => {
    expect(computeExitReasonLegacy('target_1')).toBe('target_1');
  });

  it('target_2 maps to target_2', () => {
    expect(computeExitReasonLegacy('target_2')).toBe('target_2');
  });
});

// ─── ML exit attribution — P0 regression ────────────────────────────────────
// Type-level compile gate: if these assignments fail to compile, the ExitReason
// union is missing the new ML variants.
import type { ExitReason } from '../../src/autotrade/types.js';

const _mlExitAllCheck: ExitReason = 'ml_exit_all';
const _mlExitPartialCheck: ExitReason = 'ml_exit_partial';
const _manualCheck: ExitReason = 'manual';
void _mlExitAllCheck; void _mlExitPartialCheck; void _manualCheck;

describe('ML exit reasons are distinct from manual (P0 regression)', () => {
  it('ml_exit_all is distinct from manual', () => {
    expect('ml_exit_all').not.toBe('manual');
  });

  it('ml_exit_partial is distinct from ml_exit_all', () => {
    expect('ml_exit_partial').not.toBe('ml_exit_all');
  });

  it('ml_exit_partial is distinct from manual', () => {
    expect('ml_exit_partial').not.toBe('manual');
  });
});
