/**
 * Scheduler — runs an async task on an adaptive interval.
 *
 * Supports a HYBRID cadence appropriate for futures trading:
 *   - Flat state: full strategy/analysis loop at config.analysis_interval_seconds
 *     (default 5s for NQ).
 *   - In-position state: fast monitor loop at config.in_position_monitor_seconds
 *     (default 2s), which only evaluates stops / targets / trailing updates.
 *
 * The consumer provides an `isInPosition` probe plus two callbacks:
 *   onAnalysis  — full cycle (regime, bias, signal, entries)
 *   onMonitor   — fast cycle (exit checks, trail updates)
 *
 * Safety guarantees:
 *   - Concurrent ticks are prevented via a busy flag.
 *   - Errors are logged; the loop continues.
 *   - SIGINT/SIGTERM triggers a graceful stop.
 *   - Tick duration is measured for observability.
 */

export type CycleFn = (cycleNumber: number) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// LaneScheduler — Multi-lane due-time scheduler for the v2 engine loop.
//
// Each lane runs at its own cadence with its own busy flag. Hard-risk is
// never blocked by other lanes. Management and context-refresh share a
// heavyBusy flag to prevent concurrent heavy work.
//
// The scheduler fires a single 250ms base timer and checks which lanes
// are "due" in priority order (lower priority number = higher priority).
// ─────────────────────────────────────────────────────────────────────────────

export interface LaneConfig {
  /** Lane name (for logging and metrics). */
  name: string;
  /** Base interval in milliseconds. */
  intervalMs: number;
  /** The lane callback. */
  callback: CycleFn;
  /** When this lane is active: only when in position, only when flat, or always. */
  activeWhen: 'in_position' | 'flat' | 'always';
  /** Priority: lower = higher priority. Checked in ascending order. */
  priority: number;
  /** If true, this lane has its own busy flag (never blocked by other lanes). */
  independentBusy: boolean;
  /** If set, boost priority after this many consecutive missed cycles. */
  overduePriorityBoostAfter?: number;
  /** Max duration before logging an overrun warning. */
  overrunThresholdMs?: number;
}

export interface LaneSchedulerOptions {
  /** Base timer resolution in ms (default 250). */
  baseTickMs: number;
  /** Probe: is the engine currently in a position? */
  isInPosition: () => boolean;
  /** Optional: dynamic interval override per lane (returns null to use default). */
  getPhaseInterval?: (lane: string) => number | null;
  /** Lane definitions. */
  lanes: LaneConfig[];
}

export interface LaneMetrics {
  name: string;
  cycleCount: number;
  skipCount: number;
  missedCount: number;
  lastRunAt: number;
  lastDurationMs: number;
  overrunCount: number;
  avgDurationMs: number;
}

interface LaneState {
  config: LaneConfig;
  busy: boolean;
  cycleCount: number;
  skipCount: number;
  missedCount: number;           // consecutive missed cycles (for starvation detection)
  lastRunAt: number;
  lastDurationMs: number;
  overrunCount: number;
  totalDurationMs: number;
  priorityBoosted: boolean;      // temporarily boosted due to starvation
}

export class LaneScheduler {
  private lanes: LaneState[] = [];
  private heavyBusy = false;      // shared busy flag for non-independent lanes
  private stopped = false;
  private readonly opts: LaneSchedulerOptions;

  constructor(opts: LaneSchedulerOptions) {
    this.opts = opts;
    this.lanes = opts.lanes
      .sort((a, b) => a.priority - b.priority)
      .map(config => ({
        config,
        busy: false,
        cycleCount: 0,
        skipCount: 0,
        missedCount: 0,
        lastRunAt: 0,
        lastDurationMs: 0,
        overrunCount: 0,
        totalDurationMs: 0,
        priorityBoosted: false,
      }));
  }

  /** Get metrics for all lanes. */
  getMetrics(): LaneMetrics[] {
    return this.lanes.map(l => ({
      name: l.config.name,
      cycleCount: l.cycleCount,
      skipCount: l.skipCount,
      missedCount: l.missedCount,
      lastRunAt: l.lastRunAt,
      lastDurationMs: l.lastDurationMs,
      overrunCount: l.overrunCount,
      avgDurationMs: l.cycleCount > 0
        ? Math.round(l.totalDurationMs / l.cycleCount)
        : 0,
    }));
  }

  /** Get metrics for a specific lane by name. */
  getLaneMetrics(name: string): LaneMetrics | null {
    const lane = this.lanes.find(l => l.config.name === name);
    if (!lane) return null;
    return {
      name: lane.config.name,
      cycleCount: lane.cycleCount,
      skipCount: lane.skipCount,
      missedCount: lane.missedCount,
      lastRunAt: lane.lastRunAt,
      lastDurationMs: lane.lastDurationMs,
      overrunCount: lane.overrunCount,
      avgDurationMs: lane.cycleCount > 0
        ? Math.round(lane.totalDurationMs / lane.cycleCount)
        : 0,
    };
  }

  /** Start the scheduler. Returns a promise that resolves when stopped. */
  async run(): Promise<void> {
    const baseTickMs = Math.max(100, this.opts.baseTickMs);

    return new Promise(resolve => {
      const interval = setInterval(() => {
        if (this.stopped) {
          clearInterval(interval);
          resolve();
          return;
        }
        this.tick();
      }, baseTickMs);

      const cleanup = () => {
        this.stopped = true;
        clearInterval(interval);
        resolve();
      };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
    });
  }

  stop(): void {
    this.stopped = true;
  }

  /** Single base tick: check all lanes in priority order. */
  private tick(): void {
    const now = Date.now();
    const inPos = this.opts.isInPosition();

    // Build a priority-sorted view, accounting for starvation boosts
    const sortedLanes = [...this.lanes].sort((a, b) => {
      const aPrio = a.priorityBoosted ? a.config.priority - 100 : a.config.priority;
      const bPrio = b.priorityBoosted ? b.config.priority - 100 : b.config.priority;
      return aPrio - bPrio;
    });

    for (const lane of sortedLanes) {
      // Check if lane is active given current position state
      const active =
        lane.config.activeWhen === 'always' ||
        (lane.config.activeWhen === 'in_position' && inPos) ||
        (lane.config.activeWhen === 'flat' && !inPos);
      if (!active) continue;

      // Check if lane is due
      const effectiveInterval = this.opts.getPhaseInterval?.(lane.config.name) ?? lane.config.intervalMs;
      const sinceLast = now - lane.lastRunAt;
      if (sinceLast < effectiveInterval) continue;

      // Check busy state
      if (lane.config.independentBusy) {
        // Independent lane (hardRisk): own busy flag
        if (lane.busy) {
          lane.skipCount++;
          continue;
        }
      } else {
        // Shared lanes: check heavyBusy
        if (this.heavyBusy) {
          lane.skipCount++;
          lane.missedCount++;
          // Starvation detection
          if (lane.config.overduePriorityBoostAfter &&
              lane.missedCount >= lane.config.overduePriorityBoostAfter) {
            lane.priorityBoosted = true;
          }
          continue;
        }
      }

      // Fire the lane
      lane.priorityBoosted = false;
      lane.missedCount = 0;
      this.fireLane(lane, now);
    }
  }

  /** Fire a lane callback (async, non-blocking to the base timer). */
  private fireLane(lane: LaneState, now: number): void {
    lane.busy = true;
    if (!lane.config.independentBusy) this.heavyBusy = true;
    lane.lastRunAt = now;
    lane.cycleCount++;
    const cycleNum = lane.cycleCount;
    const start = Date.now();

    lane.config.callback(cycleNum)
      .catch(err => {
        console.error(`[LANE:${lane.config.name}] Cycle ${cycleNum} error:`, err);
      })
      .finally(() => {
        const elapsed = Date.now() - start;
        lane.lastDurationMs = elapsed;
        lane.totalDurationMs += elapsed;
        lane.busy = false;
        if (!lane.config.independentBusy) this.heavyBusy = false;

        const threshold = lane.config.overrunThresholdMs ?? 5000;
        if (elapsed > threshold) {
          lane.overrunCount++;
          console.warn(
            `[LANE:${lane.config.name}] Cycle ${cycleNum} took ${elapsed}ms (threshold: ${threshold}ms)`,
          );
        }
      });
  }
}

