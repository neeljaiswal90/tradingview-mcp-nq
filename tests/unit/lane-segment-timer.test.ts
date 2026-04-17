import { describe, expect, it, vi } from 'vitest';

import { LaneSegmentTimer } from '../../src/autotrade/lane-segment-timer.js';

describe('LaneSegmentTimer', () => {
  it('captures segment durations and unattributed time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:00:00Z'));

    const timer = new LaneSegmentTimer();
    vi.advanceTimersByTime(15);
    timer.mark('preflight');
    vi.advanceTimersByTime(40);
    timer.mark('collect');
    vi.advanceTimersByTime(10);
    const snapshot = timer.finalize();

    expect(snapshot.duration_ms).toBe(65);
    expect(snapshot.segments).toEqual({
      preflight: 15,
      collect: 40,
    });
    expect(snapshot.segments_sum_ms).toBe(55);
    expect(snapshot.unattributed_ms).toBe(10);

    vi.useRealTimers();
  });

  it('returns the frozen snapshot on repeat finalize calls', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:00:00Z'));

    const timer = new LaneSegmentTimer();
    vi.advanceTimersByTime(20);
    timer.mark('preflight');
    vi.advanceTimersByTime(5);

    const first = timer.finalize();
    vi.advanceTimersByTime(100);
    const second = timer.finalize();

    expect(second).toEqual(first);

    vi.useRealTimers();
  });

  it('throws when mark is called after finalize', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:00:00Z'));

    const timer = new LaneSegmentTimer();
    vi.advanceTimersByTime(20);
    timer.finalize();

    expect(() => timer.mark('late')).toThrow(/called after finalize/);

    vi.useRealTimers();
  });
});
