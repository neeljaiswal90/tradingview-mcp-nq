/**
 * Tests for EnginePhaseManager — the state machine that gates
 * what logic runs each tick in the autotrade runner.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EnginePhaseManager } from '../../src/autotrade/engine-phase.js';

describe('EnginePhaseManager', () => {
  let pm: EnginePhaseManager;

  beforeEach(() => {
    pm = new EnginePhaseManager();
  });

  // ─── Initial state ─────────────────────────────────────────────────────

  it('starts in FLAT', () => {
    expect(pm.current()).toBe('FLAT');
  });

  it('snapshot returns valid initial state', () => {
    const snap = pm.snapshot();
    expect(snap.phase).toBe('FLAT');
    expect(snap.prev_phase).toBe('FLAT');
    expect(snap.reason).toBe('init');
    expect(snap.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(snap.entered_at_iso).toBeTruthy();
  });

  // ─── Happy path: full lifecycle ────────────────────────────────────────

  describe('full lifecycle transitions', () => {
    it('FLAT → ENTERING → MANAGING → EXITING → FLAT (default: no cooldown)', () => {
      pm.transitionTo('ENTERING', 'signal_long_trend_pullback');
      expect(pm.current()).toBe('ENTERING');
      expect(pm.previous()).toBe('FLAT');

      pm.transitionTo('MANAGING', 'position_opened:TRADE_001');
      expect(pm.current()).toBe('MANAGING');
      expect(pm.previous()).toBe('ENTERING');

      pm.transitionTo('EXITING', 'exit:target_1');
      expect(pm.current()).toBe('EXITING');
      expect(pm.previous()).toBe('MANAGING');

      // Default behavior: cooldown_bars=0, goes directly to FLAT
      pm.startCooldown(0, 'long');
      expect(pm.current()).toBe('FLAT');
      expect(pm.previous()).toBe('EXITING');
    });

    it('FLAT → ENTERING → MANAGING → EXITING → COOLDOWN → FLAT (when cooldown_bars > 0)', () => {
      pm.transitionTo('ENTERING', 'signal_long_trend_pullback');
      pm.transitionTo('MANAGING', 'position_opened:TRADE_001');
      pm.transitionTo('EXITING', 'exit:target_1');

      pm.transitionTo('COOLDOWN', 'cooldown_start:3_bars');
      expect(pm.current()).toBe('COOLDOWN');
      expect(pm.previous()).toBe('EXITING');

      pm.transitionTo('FLAT', 'cooldown_expired');
      expect(pm.current()).toBe('FLAT');
      expect(pm.previous()).toBe('COOLDOWN');
    });

    it('ENTERING → FLAT on entry rejection', () => {
      pm.transitionTo('ENTERING', 'signal_short_breakout');
      pm.transitionTo('FLAT', 'entry_failed:order_rejected');
      expect(pm.current()).toBe('FLAT');
      expect(pm.previous()).toBe('ENTERING');
    });

    it('EXITING → FLAT when cooldown_bars=0', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop_loss');
      pm.transitionTo('FLAT', 'exit_no_cooldown');
      expect(pm.current()).toBe('FLAT');
    });

    it('MANAGING → MANAGING on partial exit (stays in MANAGING)', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      // Partial exit — phase stays MANAGING
      pm.transitionTo('MANAGING', 'partial_exit:target_1');
      expect(pm.current()).toBe('MANAGING');
    });
  });

  // ─── Invalid transitions throw ─────────────────────────────────────────

  describe('invalid transitions', () => {
    it('FLAT → MANAGING throws (must go through ENTERING)', () => {
      expect(() => pm.transitionTo('MANAGING', 'skip_entering')).toThrow(/Invalid transition/);
    });

    it('FLAT → EXITING throws', () => {
      expect(() => pm.transitionTo('EXITING', 'bad')).toThrow(/Invalid transition/);
    });

    it('FLAT → COOLDOWN throws', () => {
      expect(() => pm.transitionTo('COOLDOWN', 'bad')).toThrow(/Invalid transition/);
    });

    it('MANAGING → FLAT throws (must go through EXITING)', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      expect(() => pm.transitionTo('FLAT', 'bad')).toThrow(/Invalid transition/);
    });

    it('COOLDOWN → MANAGING throws', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.transitionTo('COOLDOWN', 'cooldown');
      expect(() => pm.transitionTo('MANAGING', 'bad')).toThrow(/Invalid transition/);
    });

    it('COOLDOWN → ENTERING throws', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.transitionTo('COOLDOWN', 'cooldown');
      expect(() => pm.transitionTo('ENTERING', 'bad')).toThrow(/Invalid transition/);
    });
  });

  // ─── Cooldown helpers ──────────────────────────────────────────────────

  describe('cooldown', () => {
    it('startCooldown transitions to COOLDOWN when cooldown_bars > 0', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(3, 'long');
      expect(pm.current()).toBe('COOLDOWN');
    });

    it('startCooldown transitions to FLAT when cooldown_bars = 0', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(0, 'long');
      expect(pm.current()).toBe('FLAT');
    });

    it('checkCooldownExpired returns false before bars elapsed', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(3, 'long');
      // Just started — 0 bars elapsed (with 60s bars, at time=now)
      expect(pm.checkCooldownExpired(3, 60_000)).toBe(false);
    });

    it('checkCooldownExpired returns true when no cooldown was started', () => {
      expect(pm.checkCooldownExpired(3)).toBe(true);
    });

    it('getCooldownBlock returns null when no exit has occurred', () => {
      expect(pm.getCooldownBlock('long', true, 3)).toBeNull();
    });

    it('getCooldownBlock returns cooldown block within cooldown_bars', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(3, 'long');
      // Still within cooldown (just started, barsSinceExit = 0)
      const block = pm.getCooldownBlock('long', true, 3);
      expect(block).toMatch(/cooldown:0\/3_bars/);
    });

    it('getCooldownBlock returns same_bar_reversal for opposite direction', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(3, 'long');
      // Trying to enter SHORT immediately after exiting LONG
      const block = pm.getCooldownBlock('short', true, 3);
      expect(block).toMatch(/same_bar_reversal/);
    });

    it('getCooldownBlock returns null for same direction when no_same_bar_reversal is false', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(3, 'long');
      // Same direction, no same-bar-reversal check, but still in cooldown
      const block = pm.getCooldownBlock('long', false, 3);
      expect(block).toMatch(/cooldown:0\/3_bars/);
    });

    // ── Default behavior: no cooldown blocking ──────────────────────────

    it('getCooldownBlock returns null when cooldown_bars=0 and no_same_bar_reversal=false', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(0, 'long');
      // Default config: cooldown_bars=0, no_same_bar_reversal=false
      // Attempting opposite direction immediately should NOT be blocked
      const block = pm.getCooldownBlock('short', false, 0);
      expect(block).toBeNull();
    });

    it('getCooldownBlock allows same-direction re-entry immediately when cooldown_bars=0', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(0, 'long');
      const block = pm.getCooldownBlock('long', false, 0);
      expect(block).toBeNull();
    });

    it('startCooldown(0) goes directly to FLAT, never enters COOLDOWN', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(0, 'short');
      expect(pm.current()).toBe('FLAT');
      // Verify it didn't pass through COOLDOWN
      expect(pm.previous()).toBe('EXITING');
    });

    it('same-bar reversal is allowed when no_same_bar_reversal=false, even with cooldown_bars > 0', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:stop');
      pm.startCooldown(3, 'long');
      // Opposite direction, but same-bar-reversal not enforced
      const block = pm.getCooldownBlock('short', false, 3);
      // Should still get cooldown block (bars > 0) but NOT same_bar_reversal
      expect(block).toMatch(/cooldown/);
      expect(block).not.toMatch(/same_bar_reversal/);
    });
  });

  // ─── Snapshot correctness ──────────────────────────────────────────────

  describe('snapshot', () => {
    it('reflects current phase and reason after transition', () => {
      pm.transitionTo('ENTERING', 'my_reason');
      const snap = pm.snapshot();
      expect(snap.phase).toBe('ENTERING');
      expect(snap.prev_phase).toBe('FLAT');
      expect(snap.reason).toBe('my_reason');
      expect(snap.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it('elapsed_ms increases over time', async () => {
      pm.transitionTo('ENTERING', 'signal');
      // Small delay to ensure elapsed > 0
      await new Promise(r => setTimeout(r, 10));
      expect(pm.elapsedMs()).toBeGreaterThan(0);
    });
  });

  // ─── Position / phase consistency ──────────────────────────────────────

  describe('phase consistency invariants', () => {
    it('a position open scenario requires MANAGING phase', () => {
      // Simulate: position opens → phase must be MANAGING
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      expect(pm.current()).toBe('MANAGING');
      // Cannot be FLAT while conceptually in position
      expect(pm.current()).not.toBe('FLAT');
    });

    it('cannot reach MANAGING without going through ENTERING', () => {
      expect(() => pm.transitionTo('MANAGING', 'skip')).toThrow();
    });

    it('after full exit lifecycle, returns to FLAT or COOLDOWN', () => {
      pm.transitionTo('ENTERING', 'signal');
      pm.transitionTo('MANAGING', 'opened');
      pm.transitionTo('EXITING', 'exit:target_2');
      pm.transitionTo('FLAT', 'no_cooldown');
      expect(pm.current()).toBe('FLAT');
    });
  });
});
