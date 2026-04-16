/**
 * tv-ui-lock.ts — Cross-process advisory file lock for TradingView UI mutations.
 *
 * Any operation that depends on the _active_ pane (focus, setTimeframe,
 * setSymbol) must run under this lock when multiple runner processes share
 * a single Chrome/CDP session.
 *
 * Passive reads via cwc.getAll()[N] do NOT need the lock.
 *
 * Implementation: exclusive-create a lock file (flag: 'wx'). If the file
 * already exists, spin-wait with short sleeps. Stale-lock detection kicks in
 * after STALE_MS (process may have crashed without releasing).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const LOCK_FILE = path.join(os.tmpdir(), 'tv-ui-lock.lock');
const POLL_MS = Number(process.env['TV_UI_LOCK_POLL_MS'] ?? 50);
const TIMEOUT_MS = Number(process.env['TV_UI_LOCK_TIMEOUT_MS'] ?? 15_000);
const STALE_MS = Number(process.env['TV_UI_LOCK_STALE_MS'] ?? 60_000);

function tryAcquire(): boolean {
  try {
    fs.writeFileSync(LOCK_FILE, `${process.pid}:${Date.now()}`, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function release(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Already released or never acquired — safe to ignore.
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 probes process existence without killing it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(): { pid: number | null; acquiredAtMs: number | null; ageMs: number | null } {
  try {
    const stat = fs.statSync(LOCK_FILE);
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const [pidRaw, tsRaw] = raw.split(':');
    const pid = Number(pidRaw);
    const acquiredAtMs = Number(tsRaw);
    return {
      pid: Number.isFinite(pid) ? pid : null,
      acquiredAtMs: Number.isFinite(acquiredAtMs) ? acquiredAtMs : null,
      ageMs: Date.now() - stat.mtimeMs,
    };
  } catch {
    return { pid: null, acquiredAtMs: null, ageMs: null };
  }
}

function breakStale(): boolean {
  try {
    const stat = fs.statSync(LOCK_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    const owner = readOwner();
    // Never break a lock owned by a live process; this prevents false steals
    // when a long UI operation exceeds the stale threshold under contention.
    if (owner.pid !== null && isPidAlive(owner.pid)) {
      return false;
    }
    if (ageMs > STALE_MS || owner.pid === null) {
      fs.unlinkSync(LOCK_FILE);
      return true;
    }
  } catch {
    // File vanished between check and unlink — that is fine.
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class TvUiLock {
  /**
   * Run `fn` under the cross-process lock.
   * Throws if the lock cannot be acquired within TIMEOUT_MS.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + TIMEOUT_MS;

    while (!tryAcquire()) {
      if (Date.now() >= deadline) {
        // Last-ditch: try to break a stale lock once.
        breakStale();
        if (!tryAcquire()) {
          const owner = readOwner();
          const ownerPid = owner.pid ?? 'unknown';
          const ownerAge = owner.ageMs != null ? `${owner.ageMs}ms` : 'unknown';
          const ownerAlive = owner.pid != null ? String(isPidAlive(owner.pid)) : 'unknown';
          throw new Error(
            `[TvUiLock] Could not acquire lock within ${TIMEOUT_MS}ms. ` +
            `Lock file: ${LOCK_FILE}. owner_pid=${ownerPid} owner_alive=${ownerAlive} lock_age=${ownerAge}`,
          );
        }
        break;
      }
      // Check for stale lock each iteration.
      breakStale();
      await sleep(POLL_MS);
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Shared singleton — import and use directly. */
export const tvUiLock = new TvUiLock();
