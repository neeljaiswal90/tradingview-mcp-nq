/**
 * Tests for execution_mode — the canonical runtime control.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeExecutionMode,
  shouldAllowExecutionSideEffects,
  shouldRequireStrictSymbolArtifacts,
} from '../../src/autotrade/execution-mode.js';

describe('execution_mode normalization', () => {
  it('uses execution_mode directly when set to shadow', () => {
    expect(normalizeExecutionMode({ execution_mode: 'shadow' })).toBe('shadow');
  });

  it('uses execution_mode directly when set to paper', () => {
    expect(normalizeExecutionMode({ execution_mode: 'paper' })).toBe('paper');
  });

  it('uses execution_mode directly when set to live', () => {
    expect(normalizeExecutionMode({ execution_mode: 'live' })).toBe('live');
  });

  it('defaults to paper when execution_mode is absent', () => {
    expect(normalizeExecutionMode({})).toBe('paper');
  });
});

describe('execution_mode policy', () => {
  it('does not require strict symbol-scoped artifacts for shadow engines even when env MODE is paper', () => {
    expect(shouldRequireStrictSymbolArtifacts('paper', 'shadow')).toBe(false);
  });

  it('still requires strict symbol-scoped artifacts for active paper engines', () => {
    expect(shouldRequireStrictSymbolArtifacts('paper', 'paper')).toBe(true);
  });

  it('disables execution side effects for shadow engines', () => {
    expect(shouldAllowExecutionSideEffects('shadow')).toBe(false);
  });

  it('allows execution side effects for active paper engines', () => {
    expect(shouldAllowExecutionSideEffects('paper')).toBe(true);
  });
});
