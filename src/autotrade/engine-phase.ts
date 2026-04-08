/**
 * EnginePhaseManager — deterministic state machine for the autotrade runner.
 *
 * Five phases gate what logic runs each tick:
 *   FLAT       → full analysis + entry evaluation
 *   ENTERING   → transient: order placement in flight
 *   MANAGING   → position open: exit evaluation only (no entry logic)
 *   EXITING    → transient: exit order + position close
 *   COOLDOWN   → post-exit: prevent immediate re-entry
 *
 * Transition validation prevents illegal jumps (e.g. FLAT → MANAGING).
 * Cooldown state is co-located here (migrated from runner.ts loose vars).
 */

import type { EnginePhase } from './types.js';

// ─── Legal transition edges ──────────────────────────────────────────────────

const LEGAL_TRANSITIONS: ReadonlyMap<EnginePhase, ReadonlySet<EnginePhase>> = new Map([
  ['FLAT',     new Set<EnginePhase>(['ENTERING'])],
  ['ENTERING', new Set<EnginePhase>(['MANAGING', 'FLAT'])],         // FLAT on rejection
  ['MANAGING', new Set<EnginePhase>(['EXITING', 'MANAGING'])],      // MANAGING on partial
  ['EXITING',  new Set<EnginePhase>(['COOLDOWN', 'FLAT'])],         // FLAT when cooldown=0
  ['COOLDOWN', new Set<EnginePhase>(['FLAT'])],
]);

// ─── Snapshot shape (for dashboard / logging) ────────────────────────────────

export interface EnginePhaseSnapshot {
  phase: EnginePhase;
  prev_phase: EnginePhase;
  entered_at_iso: string;
  reason: string;
  elapsed_ms: number;
}

// ─── Manager class ───────────────────────────────────────────────────────────

export class EnginePhaseManager {
  private phase: EnginePhase = 'FLAT';
  private prevPhase: EnginePhase = 'FLAT';
  private enteredAt: number = Date.now();
  private reason: string = 'init';

  // ── Cooldown state (migrated from runner.ts) ────────────────────────────
  private cooldownExitUnix: number | null = null;
  private cooldownExitDirection: 'long' | 'short' | null = null;

  // ── Queries ─────────────────────────────────────────────────────────────

  current(): EnginePhase { return this.phase; }
  previous(): EnginePhase { return this.prevPhase; }
  elapsedMs(): number { return Date.now() - this.enteredAt; }

  // ── Transitions ─────────────────────────────────────────────────────────

  transitionTo(next: EnginePhase, reason: string): void {
    if (next === this.phase && next !== 'MANAGING') return; // no-op for same-state (except MANAGING partial)

    const legal = LEGAL_TRANSITIONS.get(this.phase);
    if (!legal || !legal.has(next)) {
      throw new Error(
        `[STATE] Invalid transition: ${this.phase} -> ${next} (reason: ${reason})`,
      );
    }

    const prev = this.phase;
    this.prevPhase = prev;
    this.phase = next;
    this.enteredAt = Date.now();
    this.reason = reason;

    console.log(`[STATE] ${prev} -> ${next} (${reason})`);
  }

  // ── Cooldown helpers ────────────────────────────────────────────────────

  /**
   * Record an exit and transition to COOLDOWN (or FLAT if cooldown_bars is 0).
   */
  startCooldown(cooldownBars: number, exitDirection: 'long' | 'short'): void {
    this.cooldownExitUnix = Date.now();
    this.cooldownExitDirection = exitDirection;

    if (cooldownBars > 0) {
      this.transitionTo('COOLDOWN', `cooldown_start:${cooldownBars}_bars`);
    } else {
      this.transitionTo('FLAT', 'exit_no_cooldown');
    }
  }

  /**
   * Check whether the cooldown window has expired based on bars elapsed.
   * @param cooldownBars number of bars to wait (from config)
   * @param barDurationMs duration of one bar in ms (default 60_000 for 1m)
   */
  checkCooldownExpired(cooldownBars: number, barDurationMs = 60_000): boolean {
    if (this.cooldownExitUnix === null) return true;
    const barsSinceExit = Math.floor((Date.now() - this.cooldownExitUnix) / barDurationMs);
    return barsSinceExit >= cooldownBars;
  }

  /**
   * Returns a cooldown block string (for skip reasons) or null if no block.
   * Migrated from runner.ts lines 588-611.
   */
  getCooldownBlock(
    setupDirection: 'long' | 'short',
    noSameBarReversal: boolean,
    cooldownBars: number,
    barDurationMs = 60_000,
  ): string | null {
    if (this.cooldownExitUnix === null) return null;
    const barsSinceExit = Math.floor((Date.now() - this.cooldownExitUnix) / barDurationMs);

    // Same-bar reversal protection
    if (noSameBarReversal
      && this.cooldownExitDirection !== null
      && setupDirection !== this.cooldownExitDirection
      && barsSinceExit < 1) {
      return `same_bar_reversal:exited_${this.cooldownExitDirection}_${barsSinceExit}bars_ago`;
    }

    // Blanket cooldown
    if (cooldownBars > 0 && barsSinceExit < cooldownBars) {
      return `cooldown:${barsSinceExit}/${cooldownBars}_bars`;
    }

    return null;
  }

  // ── Snapshot (for dashboard + logging) ──────────────────────────────────

  snapshot(): EnginePhaseSnapshot {
    return {
      phase: this.phase,
      prev_phase: this.prevPhase,
      entered_at_iso: new Date(this.enteredAt).toISOString(),
      reason: this.reason,
      elapsed_ms: this.elapsedMs(),
    };
  }
}
