/**
 * cycle-cusum.ts — Delta 6 CUSUM watchdog layer
 *
 * One-sided positive CUSUM over cycle-completion intervals to detect small
 * persistent drifts in cycle duration that the simple hard `cycle_stall_threshold_ms`
 * threshold would miss.
 *
 *     z_t   = (duration_t − μ0) / σ0
 *     S+_t  = max(0, S+_{t-1} + z_t − k)
 *
 * The stall warning fires when S+_t first crosses h (edge-triggered). While
 * S+ stays above h, no additional stall log lines are emitted; instead a
 * `cycle_cusum_degraded=true` heartbeat field is surfaced. On the recovery
 * crossing (S+ back below h) a single `cycle_cusum_recovered` line is emitted.
 *
 * Baseline (μ0, σ0) is built from the first N completed cycles (default 60),
 * during which no CUSUM evaluation happens. Baseline is reset on:
 *   - process start (construction)
 *   - dirty recovery outcomes (via `resetBaseline('dirty_recovery')`)
 *   - warmup-incomplete startup (via `resetBaseline('warmup_incomplete')`)
 *   - prolonged idle gaps (via `resetBaseline('prolonged_idle')`)
 *
 * Baseline samples are NOT updated while the tracker is degraded — only
 * healthy cycles feed the running mean/variance.
 */

export interface CycleCusumConfig {
  /** CUSUM reference value — higher k = harder to trip, default 0.5. */
  cycle_cusum_k: number;
  /** Trip threshold on S+, default 5.0. */
  cycle_cusum_h: number;
  /** Number of baseline samples to collect before CUSUM starts evaluating. */
  cycle_cusum_baseline_samples: number;
}

export const DEFAULT_CYCLE_CUSUM_CONFIG: CycleCusumConfig = {
  cycle_cusum_k: 0.5,
  cycle_cusum_h: 5.0,
  cycle_cusum_baseline_samples: 60,
};

export type CusumEvent =
  | { kind: 'stall'; s_plus: number; duration_ms: number; z: number }
  | { kind: 'recovered'; s_plus: number }
  | { kind: 'baseline_reset'; reason: string }
  | { kind: 'baseline_ready'; mean_ms: number; std_ms: number };

export interface CycleCusumSnapshot {
  s_plus: number;
  degraded: boolean;
  baseline_samples: number;
  baseline_mean_ms: number | null;
  baseline_std_ms: number | null;
  last_duration_ms: number | null;
  last_reset_reason: string | null;
}

export class CycleCusumTracker {
  private config: CycleCusumConfig;
  private sPlus = 0;
  private degraded = false;
  // Running baseline — accumulated from healthy samples only.
  private baselineSamples: number[] = [];
  private mean = 0;
  private variance = 0;
  private lastDurationMs: number | null = null;
  private lastResetReason: string | null = null;

  constructor(config: Partial<CycleCusumConfig> = {}) {
    this.config = { ...DEFAULT_CYCLE_CUSUM_CONFIG, ...config };
  }

  /**
   * Reset the baseline and S+ state. Used on process start, dirty recovery,
   * warmup-incomplete, or prolonged idle. Emits a `baseline_reset` event so
   * the caller can log it.
   */
  resetBaseline(reason: string): CusumEvent {
    this.sPlus = 0;
    this.degraded = false;
    this.baselineSamples = [];
    this.mean = 0;
    this.variance = 0;
    this.lastResetReason = reason;
    return { kind: 'baseline_reset', reason };
  }

  /**
   * Feed a completed-cycle duration into the tracker. Returns any events
   * (stall trip, recovery, or baseline-ready signal) the caller should log.
   */
  observe(durationMs: number): CusumEvent[] {
    this.lastDurationMs = durationMs;
    const events: CusumEvent[] = [];

    // Build baseline from the first N healthy samples before evaluating CUSUM.
    if (this.baselineSamples.length < this.config.cycle_cusum_baseline_samples) {
      // Never contaminate the baseline while degraded — but during the very
      // first build we haven't tripped yet, so this is always healthy state.
      this.baselineSamples.push(durationMs);
      if (this.baselineSamples.length === this.config.cycle_cusum_baseline_samples) {
        const { mean, std } = this.computeStats(this.baselineSamples);
        this.mean = mean;
        // σ of zero would make z undefined — floor it at 1ms to keep the
        // tracker active; in practice cycle durations always vary.
        this.variance = Math.max(std * std, 1);
        events.push({ kind: 'baseline_ready', mean_ms: mean, std_ms: Math.sqrt(this.variance) });
      }
      return events;
    }

    // Baseline is ready — compute z and update S+.
    const sigma = Math.sqrt(this.variance);
    const z = (durationMs - this.mean) / (sigma > 0 ? sigma : 1);
    const k = this.config.cycle_cusum_k;
    const h = this.config.cycle_cusum_h;
    const previousSPlus = this.sPlus;
    this.sPlus = Math.max(0, this.sPlus + z - k);

    // Edge-triggered events
    if (!this.degraded && this.sPlus > h) {
      this.degraded = true;
      events.push({ kind: 'stall', s_plus: this.sPlus, duration_ms: durationMs, z });
    } else if (this.degraded && this.sPlus <= h) {
      this.degraded = false;
      events.push({ kind: 'recovered', s_plus: this.sPlus });
    }

    // Only healthy samples feed the baseline (well, the baseline is frozen
    // after initial build — this branch is here in case a future update
    // wants to adapt the baseline online; for now it's a no-op).
    void previousSPlus;

    return events;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  snapshot(): CycleCusumSnapshot {
    const sigma = this.baselineSamples.length >= this.config.cycle_cusum_baseline_samples
      ? Math.sqrt(this.variance)
      : null;
    return {
      s_plus: this.sPlus,
      degraded: this.degraded,
      baseline_samples: this.baselineSamples.length,
      baseline_mean_ms: sigma !== null ? this.mean : null,
      baseline_std_ms: sigma,
      last_duration_ms: this.lastDurationMs,
      last_reset_reason: this.lastResetReason,
    };
  }

  private computeStats(samples: number[]): { mean: number; std: number } {
    if (samples.length === 0) return { mean: 0, std: 0 };
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance =
      samples.reduce((s, x) => s + (x - mean) * (x - mean), 0) / samples.length;
    return { mean, std: Math.sqrt(variance) };
  }
}
