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

export interface HybridOptions {
  analysisIntervalMs: number;
  monitorIntervalMs: number;
  isInPosition: () => boolean;
  onAnalysis: CycleFn;
  onMonitor: CycleFn;
  /** Optional: called at 3x analysis interval when in-position for shadow/advisory analytics. */
  onShadowAnalysis?: CycleFn;
}

export interface SchedulerMetrics {
  cycle_count: number;
  last_analysis_at: number;
  last_monitor_at: number;
  last_analysis_duration_ms: number;
  last_monitor_duration_ms: number;
  analysis_overrun_count: number;
  monitor_overrun_count: number;
  skip_count: number;
}

export class Scheduler {
  private busy = false;
  private stopped = false;
  private cycleCount = 0;
  private readonly intervalMs: number;

  // ─── Observability metrics ────────────────────────────────────────────────
  private lastAnalysisAt = 0;
  private lastMonitorAt = 0;
  private lastAnalysisDurationMs = 0;
  private lastMonitorDurationMs = 0;
  private analysisOverrunCount = 0;
  private monitorOverrunCount = 0;
  private skipCount = 0;

  constructor(intervalMs: number) {
    // Allow intervals as low as 1000ms for the 5s target
    this.intervalMs = Math.max(1_000, intervalMs);
  }

  getMetrics(): SchedulerMetrics {
    return {
      cycle_count: this.cycleCount,
      last_analysis_at: this.lastAnalysisAt,
      last_monitor_at: this.lastMonitorAt,
      last_analysis_duration_ms: this.lastAnalysisDurationMs,
      last_monitor_duration_ms: this.lastMonitorDurationMs,
      analysis_overrun_count: this.analysisOverrunCount,
      monitor_overrun_count: this.monitorOverrunCount,
      skip_count: this.skipCount,
    };
  }

  /**
   * Simple fixed-interval loop (backwards-compatible with prior behavior).
   */
  async run(fn: CycleFn): Promise<void> {
    await this.tick(fn);
    return new Promise(resolve => {
      const interval = setInterval(async () => {
        if (this.stopped) {
          clearInterval(interval);
          resolve();
          return;
        }
        await this.tick(fn);
      }, this.intervalMs);
      const cleanup = () => {
        this.stopped = true;
        clearInterval(interval);
        resolve();
      };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
    });
  }

  /**
   * Hybrid loop: fast monitor ticks when in position, slow analysis ticks
   * when flat. Driven by a single high-resolution timer running at the
   * monitor cadence; each tick decides whether to run the analysis cycle
   * based on elapsed time and whether we are flat.
   */
  async runHybrid(opts: HybridOptions): Promise<void> {
    const monitorMs = Math.max(500, opts.monitorIntervalMs);
    const analysisMs = Math.max(monitorMs, opts.analysisIntervalMs);
    let lastAnalysisAt = 0;

    // Kick off an immediate analysis cycle
    await this.tick(opts.onAnalysis, 'analysis');
    lastAnalysisAt = Date.now();
    this.lastAnalysisAt = lastAnalysisAt;

    return new Promise(resolve => {
      const interval = setInterval(async () => {
        if (this.stopped) {
          clearInterval(interval);
          resolve();
          return;
        }
        if (this.busy) {
          this.skipCount++;
          return;
        }
        const inPos = opts.isInPosition();
        const now = Date.now();
        const sinceAnalysis = now - lastAnalysisAt;
        if (inPos) {
          // Fast monitor path
          await this.tick(opts.onMonitor, 'monitor');
          // Run shadow/advisory analysis at 3x interval when in-position.
          // This does NOT run entry logic — only generates advisory signals
          // for dashboard visibility and analytics.
          if (sinceAnalysis >= analysisMs * 3 && opts.onShadowAnalysis) {
            await this.tick(opts.onShadowAnalysis, 'shadow');
            lastAnalysisAt = Date.now();
            this.lastAnalysisAt = lastAnalysisAt;
          }
        } else {
          // Flat: run analysis at the configured cadence
          if (sinceAnalysis >= analysisMs) {
            await this.tick(opts.onAnalysis, 'analysis');
            lastAnalysisAt = Date.now();
            this.lastAnalysisAt = lastAnalysisAt;
          }
        }
      }, monitorMs);

      const cleanup = () => {
        this.stopped = true;
        clearInterval(interval);
        resolve();
      };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
    });
  }

  stop(): void { this.stopped = true; }

  private async tick(fn: CycleFn, label?: string): Promise<void> {
    if (this.busy) {
      this.skipCount++;
      console.warn(`[SCHEDULER] Tick skipped (${label ?? 'cycle'}) — previous still running`);
      return;
    }
    this.busy = true;
    this.cycleCount++;
    const cycleNum = this.cycleCount;
    const start = Date.now();
    try {
      await fn(cycleNum);
    } catch (err) {
      console.error(`[SCHEDULER] ${label ?? 'Cycle'} ${cycleNum} error:`, err);
    } finally {
      const elapsed = Date.now() - start;
      if (label === 'monitor') {
        this.lastMonitorAt = Date.now();
        this.lastMonitorDurationMs = elapsed;
        if (elapsed > 5_000) {
          this.monitorOverrunCount++;
          console.warn(`[SCHEDULER] Monitor tick ${cycleNum} took ${elapsed}ms`);
        }
      } else if (label === 'shadow') {
        // Shadow analysis: track timing but don't count as full analysis
        if (elapsed > 10_000) {
          console.warn(`[SCHEDULER] Shadow tick ${cycleNum} took ${elapsed}ms`);
        }
      } else if (label === 'analysis') {
        this.lastAnalysisAt = Date.now();
        this.lastAnalysisDurationMs = elapsed;
        if (elapsed > 10_000) {
          this.analysisOverrunCount++;
          console.warn(`[SCHEDULER] Analysis tick ${cycleNum} took ${elapsed}ms (target: <5s)`);
        }
      }
      this.busy = false;
    }
  }
}
