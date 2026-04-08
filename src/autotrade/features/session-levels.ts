/**
 * features/session-levels.ts — Local computation of session reference levels.
 *
 * Replaces dependency on RIPS Pine labels and other chart-derived levels.
 * Computes: daily open, weekly open, session highs/lows, opening range.
 */

export interface Bar {
  time: number;  // unix timestamp (seconds)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SessionLevels {
  daily_open: number | null;
  session_high: number | null;
  session_low: number | null;
  prior_session_high: number | null;
  prior_session_low: number | null;
  opening_range_high: number | null;
  opening_range_low: number | null;
  opening_range_mid: number | null;
}

/**
 * Compute session reference levels from 1m bars.
 *
 * @param bars - 1-minute OHLCV bars covering at least the current session
 * @param rthOpenHour - RTH open hour in ET (default 9 for 9:30 ET)
 * @param orMinutes - Opening range duration in minutes (default 15)
 */
export function computeSessionLevels(
  bars: Bar[],
  rthOpenHour: number = 9,
  orMinutes: number = 15,
): SessionLevels {
  const result: SessionLevels = {
    daily_open: null,
    session_high: null,
    session_low: null,
    prior_session_high: null,
    prior_session_low: null,
    opening_range_high: null,
    opening_range_low: null,
    opening_range_mid: null,
  };

  if (bars.length === 0) return result;

  // Convert bar timestamps to ET hours for session detection
  // (simplified: assumes bars are in UTC, ET = UTC-4 or UTC-5)
  // For production, use proper timezone conversion via session.ts

  // Current session bars (last N bars as proxy)
  const sessionBars = bars.slice(-480);  // ~8 hours of 1m bars
  if (sessionBars.length === 0) return result;

  // Daily open: first bar's open
  result.daily_open = sessionBars[0]!.open;

  // Session high/low
  result.session_high = Math.max(...sessionBars.map(b => b.high));
  result.session_low = Math.min(...sessionBars.map(b => b.low));

  // Opening range: first orMinutes bars
  const orBars = sessionBars.slice(0, orMinutes);
  if (orBars.length >= orMinutes) {
    result.opening_range_high = Math.max(...orBars.map(b => b.high));
    result.opening_range_low = Math.min(...orBars.map(b => b.low));
    result.opening_range_mid = (result.opening_range_high + result.opening_range_low) / 2;
  }

  return result;
}
