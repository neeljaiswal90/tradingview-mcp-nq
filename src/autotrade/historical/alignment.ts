/**
 * Multi-timeframe alignment engine.
 *
 * At every 1m replay step, returns the latest HIGHER-timeframe bars that
 * were FULLY KNOWN at that timestamp — i.e. whose bar-CLOSE time is at or
 * before the current 1m bar's timestamp.
 *
 * Critical no-leak rule:
 *   A 5m bar labelled with unix=T covers [T, T+300).
 *   It is only "known" at T+300. Using it earlier leaks the future.
 *
 *   Bar.timestamp is the OPEN time. Bar.close_time = timestamp + TF_SECONDS.
 *   We include a higher-TF bar iff close_time <= current 1m timestamp + 60.
 *   (At the MOMENT the 1m bar at T has JUST closed, a higher-TF bar whose
 *   close time == T+60 is also safe to use.)
 *
 * This module never fabricates missing values — it returns null bars with
 * availability flags and lets strategy logic handle it defensively.
 */

import type { HistoricalBar, Timeframe } from './schema.js';
import { TF_SECONDS } from './schema.js';

export interface MultiTfBundle {
  bar_1m: HistoricalBar;
  bar_5m: HistoricalBar | null;
  bar_15m: HistoricalBar | null;
  bar_60m: HistoricalBar | null;
  /** True if any HTF bar was completed at or before this step. */
  availability: {
    '5m': boolean;
    '15m': boolean;
    '60m': boolean;
  };
  /** Index within the full series for each timeframe (for windowed lookups). */
  index: {
    '1m': number;
    '5m': number | null;
    '15m': number | null;
    '60m': number | null;
  };
}

/**
 * Monotonic pointer-advance aligner. O(N) over the entire replay.
 *
 * Usage:
 *   const aligner = new Aligner(bars1m, bars5m, bars15m, bars60m);
 *   for (let i = 0; i < bars1m.length; i++) {
 *     const bundle = aligner.advanceTo(i);
 *     // ... use bundle ...
 *   }
 */
export class Aligner {
  private readonly bars1m: HistoricalBar[];
  private readonly bars5m: HistoricalBar[];
  private readonly bars15m: HistoricalBar[];
  private readonly bars60m: HistoricalBar[];

  // Pointers into each HTF series (index of the most recent completed bar).
  private p5 = -1;
  private p15 = -1;
  private p60 = -1;

  constructor(
    bars1m: HistoricalBar[],
    bars5m: HistoricalBar[],
    bars15m: HistoricalBar[],
    bars60m: HistoricalBar[],
  ) {
    // Ensure chronological order — loader already sorts, but guard anyway.
    this.bars1m = bars1m;
    this.bars5m = bars5m;
    this.bars15m = bars15m;
    this.bars60m = bars60m;
  }

  /**
   * Advance all HTF pointers so they reference the latest bar whose CLOSE
   * time is <= (current 1m bar's timestamp + 60s). Returns the bundle.
   */
  advanceTo(index1m: number): MultiTfBundle {
    const bar = this.bars1m[index1m];
    if (!bar) throw new Error(`Aligner: 1m index ${index1m} out of range`);
    // The 1m bar at timestamp T closes at T+60. Any HTF bar whose close time
    // is <= T+60 is safe to reference.
    const knownUntil = bar.timestamp + TF_SECONDS['1m'];

    this.p5 = advancePointer(this.bars5m, this.p5, knownUntil, '5m');
    this.p15 = advancePointer(this.bars15m, this.p15, knownUntil, '15m');
    this.p60 = advancePointer(this.bars60m, this.p60, knownUntil, '60m');

    return {
      bar_1m: bar,
      bar_5m: this.p5 >= 0 ? (this.bars5m[this.p5] ?? null) : null,
      bar_15m: this.p15 >= 0 ? (this.bars15m[this.p15] ?? null) : null,
      bar_60m: this.p60 >= 0 ? (this.bars60m[this.p60] ?? null) : null,
      availability: {
        '5m': this.p5 >= 0,
        '15m': this.p15 >= 0,
        '60m': this.p60 >= 0,
      },
      index: {
        '1m': index1m,
        '5m': this.p5 >= 0 ? this.p5 : null,
        '15m': this.p15 >= 0 ? this.p15 : null,
        '60m': this.p60 >= 0 ? this.p60 : null,
      },
    };
  }

  /**
   * Return the most recent N bars of a timeframe that were completed at or
   * before the current cursor (exclusive of in-progress bars).
   */
  getRecentBars(tf: Timeframe, n: number, bundle: MultiTfBundle): HistoricalBar[] {
    if (tf === '1m') {
      const end = bundle.index['1m'] + 1;
      return this.bars1m.slice(Math.max(0, end - n), end);
    }
    const series = tf === '5m' ? this.bars5m : tf === '15m' ? this.bars15m : this.bars60m;
    const p = tf === '5m' ? bundle.index['5m']
            : tf === '15m' ? bundle.index['15m']
            : bundle.index['60m'];
    if (p === null) return [];
    const end = p + 1;
    return series.slice(Math.max(0, end - n), end);
  }
}

function advancePointer(
  series: HistoricalBar[],
  currentPtr: number,
  knownUntil: number,
  tf: Timeframe,
): number {
  const step = TF_SECONDS[tf];
  let p = currentPtr;
  // Advance while the NEXT bar's close time is still <= knownUntil.
  while (p + 1 < series.length) {
    const next = series[p + 1]!;
    const nextCloseTime = next.timestamp + step;
    if (nextCloseTime <= knownUntil) p++;
    else break;
  }
  // If we never advanced beyond -1, see if the very first bar is already safe
  if (p < 0 && series.length > 0) {
    const first = series[0]!;
    if (first.timestamp + step <= knownUntil) p = 0;
  }
  return p;
}
