export interface LaneSegmentSnapshot {
  duration_ms: number;
  segments: Record<string, number>;
  segments_sum_ms: number;
  unattributed_ms: number;
}

export class LaneSegmentTimer {
  private readonly startedAt: number;
  private lastMarkAt: number;
  private readonly segments: Record<string, number> = {};
  private snapshot: LaneSegmentSnapshot | null = null;

  constructor() {
    this.startedAt = Date.now();
    this.lastMarkAt = this.startedAt;
  }

  mark(label: string): void {
    if (this.snapshot !== null) {
      throw new Error(
        `LaneSegmentTimer: mark('${label}') called after finalize() â€” timer is frozen.`,
      );
    }
    const now = Date.now();
    const delta = now - this.lastMarkAt;
    this.segments[label] = (this.segments[label] ?? 0) + delta;
    this.lastMarkAt = now;
  }

  finalize(): LaneSegmentSnapshot {
    if (this.snapshot !== null) {
      return this.snapshot;
    }
    const duration_ms = Date.now() - this.startedAt;
    const segments = { ...this.segments };
    const segments_sum_ms = Object.values(segments).reduce((sum, value) => sum + value, 0);
    const unattributed_ms = Math.max(0, duration_ms - segments_sum_ms);
    this.snapshot = { duration_ms, segments, segments_sum_ms, unattributed_ms };
    return this.snapshot;
  }

  hasSegments(): boolean {
    return Object.keys(this.segments).length > 0;
  }

  get finalized(): boolean {
    return this.snapshot !== null;
  }
}
