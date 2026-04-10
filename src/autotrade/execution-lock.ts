/**
 * execution-lock.ts — Async mutex for position-mutating operations.
 *
 * Prevents hard-risk and management lanes from racing on exits, partials,
 * stop moves, or phase transitions.
 *
 * The lock is NON-BLOCKING for callers that check exitInFlight first.
 *   Hard-risk lane: checks exitInFlight → skips if true (never blocks).
 *   Management lane: checks exitInFlight → skips mutating work if true.
 *
 * Only multi-step mutation sequences need the lock. Single-field reads/writes
 * of primitives are safe in single-threaded Node.js without synchronization.
 */

export interface ExecutionLockMetrics {
  /** Number of times a caller had to wait for the lock. */
  waitCount: number;
  /** Number of times a caller skipped because exitInFlight was true. */
  skipCount: number;
  /** Average lock hold time in ms. */
  avgLockHoldMs: number;
  /** Total lock acquisitions. */
  acquisitionCount: number;
}

export interface RunExclusiveOptions {
  /** Mark this operation as a full exit (sets exitInFlight while held). */
  isExit?: boolean;
  /** Mark this operation as a partial exit (sets partialInFlight while held). */
  isPartial?: boolean;
  /** If exitInFlight is already true, return null immediately instead of waiting. */
  skipIfExitInFlight?: boolean;
}

export class ExecutionLock {
  private locked = false;
  private queue: Array<() => void> = [];

  /** True if an exit order is currently in-flight (any lane). */
  exitInFlight = false;
  /** True if a partial exit is currently in-flight. */
  partialInFlight = false;

  // ── Contention metrics ──
  private _waitCount = 0;
  private _skipCount = 0;
  private _totalHoldMs = 0;
  private _acquisitionCount = 0;
  private _acquireTime = 0;

  get avgLockHoldMs(): number {
    return this._acquisitionCount > 0
      ? this._totalHoldMs / this._acquisitionCount
      : 0;
  }

  /** Snapshot of lock contention metrics. */
  metrics(): ExecutionLockMetrics {
    return {
      waitCount: this._waitCount,
      skipCount: this._skipCount,
      avgLockHoldMs: Math.round(this.avgLockHoldMs * 100) / 100,
      acquisitionCount: this._acquisitionCount,
    };
  }

  private async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      this._acquisitionCount++;
      this._acquireTime = Date.now();
      return;
    }
    // Must wait — another operation is in progress
    this._waitCount++;
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.locked = true;
        this._acquisitionCount++;
        this._acquireTime = Date.now();
        resolve();
      });
    });
  }

  private release(): void {
    // Record hold duration
    if (this._acquireTime > 0) {
      this._totalHoldMs += Date.now() - this._acquireTime;
      this._acquireTime = 0;
    }

    const next = this.queue.shift();
    if (next) {
      // Hand lock to next waiter (stays locked)
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Run a callback under the lock.
   *
   * If `opts.skipIfExitInFlight` is true and an exit is already in-flight,
   * returns null immediately without waiting (increments skipCount).
   *
   * Sets exitInFlight/partialInFlight while the callback is running if
   * the corresponding opts flags are set. Clears them on completion.
   */
  async runExclusive<T>(
    fn: () => Promise<T>,
    opts?: RunExclusiveOptions,
  ): Promise<T | null> {
    // Fast skip: another lane is already exiting
    if (opts?.skipIfExitInFlight && this.exitInFlight) {
      this._skipCount++;
      return null;
    }

    await this.acquire();
    try {
      if (opts?.isExit) this.exitInFlight = true;
      if (opts?.isPartial) this.partialInFlight = true;
      return await fn();
    } finally {
      if (opts?.isExit) this.exitInFlight = false;
      if (opts?.isPartial) this.partialInFlight = false;
      this.release();
    }
  }
}
