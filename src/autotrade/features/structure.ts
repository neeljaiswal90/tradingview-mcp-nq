/**
 * features/structure.ts — Local market structure detection.
 *
 * Replaces dependency on Smart Money Pine indicator (BOS/CHoCH levels)
 * with locally computed swing highs/lows, break-of-structure, and
 * change-of-character detection from price bars.
 *
 * Used by both live and historical paths.
 */

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SwingPoint {
  type: 'high' | 'low';
  price: number;
  barIndex: number;
  time: number;
}

export interface StructureLevels {
  /** Most recent confirmed swing high. */
  swing_high: number | null;
  /** Most recent confirmed swing low. */
  swing_low: number | null;
  /** Price where a break of structure (BOS) occurred. Replaces Smart Money BOS. */
  bos_level: number | null;
  /** Direction of the last BOS: 'bullish' (broke above swing high) or 'bearish'. */
  bos_direction: 'bullish' | 'bearish' | null;
  /** Price where a change of character (CHoCH) occurred. Replaces Smart Money CHoCH. */
  choch_level: number | null;
  /** Direction of the CHoCH. */
  choch_direction: 'bullish' | 'bearish' | null;
  /** All recent swing highs for resistance scanning. */
  recent_swing_highs: number[];
  /** All recent swing lows for support scanning. */
  recent_swing_lows: number[];
}

/**
 * Detect swing highs and lows using a left/right lookback window.
 *
 * A swing high is a bar whose high is the highest within `lookback` bars
 * on both sides. Same logic inverted for swing lows.
 */
export function detectSwings(bars: Bar[], lookback: number = 3): SwingPoint[] {
  const swings: SwingPoint[] = [];
  if (bars.length < lookback * 2 + 1) return swings;

  for (let i = lookback; i < bars.length - lookback; i++) {
    const bar = bars[i]!;

    // Check swing high
    let isHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && bars[j]!.high >= bar.high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      swings.push({ type: 'high', price: bar.high, barIndex: i, time: bar.time });
    }

    // Check swing low
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && bars[j]!.low <= bar.low) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      swings.push({ type: 'low', price: bar.low, barIndex: i, time: bar.time });
    }
  }

  return swings;
}

/**
 * Detect market structure levels (BOS and CHoCH) from swing points.
 *
 * Break of Structure (BOS): Price breaks above the most recent swing high
 * (bullish BOS) or below the most recent swing low (bearish BOS).
 * This is a continuation signal — structure is intact but extending.
 *
 * Change of Character (CHoCH): After a trend, price breaks in the
 * opposite direction — e.g., after a series of higher highs, price
 * breaks below the last swing low. This signals potential reversal.
 */
export function detectStructure(bars: Bar[], lookback: number = 3): StructureLevels {
  const result: StructureLevels = {
    swing_high: null,
    swing_low: null,
    bos_level: null,
    bos_direction: null,
    choch_level: null,
    choch_direction: null,
    recent_swing_highs: [],
    recent_swing_lows: [],
  };

  if (bars.length < lookback * 2 + 2) return result;

  const swings = detectSwings(bars, lookback);
  if (swings.length < 2) return result;

  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  // Populate recent swing levels
  result.recent_swing_highs = highs.slice(-5).map(s => s.price);
  result.recent_swing_lows = lows.slice(-5).map(s => s.price);

  if (highs.length >= 1) result.swing_high = highs[highs.length - 1]!.price;
  if (lows.length >= 1) result.swing_low = lows[lows.length - 1]!.price;

  const currentPrice = bars[bars.length - 1]!.close;

  // Detect BOS: current price breaks the last swing high or low
  if (highs.length >= 2) {
    const lastHigh = highs[highs.length - 1]!;
    const prevHigh = highs[highs.length - 2]!;
    // Bullish BOS: current close above last swing high, higher than previous
    if (currentPrice > lastHigh.price && lastHigh.price > prevHigh.price) {
      result.bos_level = lastHigh.price;
      result.bos_direction = 'bullish';
    }
  }

  if (lows.length >= 2) {
    const lastLow = lows[lows.length - 1]!;
    const prevLow = lows[lows.length - 2]!;
    // Bearish BOS: current close below last swing low, lower than previous
    if (currentPrice < lastLow.price && lastLow.price < prevLow.price) {
      result.bos_level = lastLow.price;
      result.bos_direction = 'bearish';
    }
  }

  // Detect CHoCH: trend change detection
  if (highs.length >= 2 && lows.length >= 1) {
    const lastHigh = highs[highs.length - 1]!;
    const prevHigh = highs[highs.length - 2]!;
    const lastLow = lows[lows.length - 1]!;

    // Bearish CHoCH: was making higher highs, now broke below swing low
    if (prevHigh.price < lastHigh.price && currentPrice < lastLow.price) {
      result.choch_level = lastLow.price;
      result.choch_direction = 'bearish';
    }
  }

  if (lows.length >= 2 && highs.length >= 1) {
    const lastLow = lows[lows.length - 1]!;
    const prevLow = lows[lows.length - 2]!;
    const lastHigh = highs[highs.length - 1]!;

    // Bullish CHoCH: was making lower lows, now broke above swing high
    if (prevLow.price > lastLow.price && currentPrice > lastHigh.price) {
      result.choch_level = lastHigh.price;
      result.choch_direction = 'bullish';
    }
  }

  return result;
}
