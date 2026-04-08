/**
 * Column-name normalization for heterogeneous CSV providers.
 *
 * TradingView exports use headers like:
 *   "time", "open", "high", "low", "close", "VWAP",
 *   "Upper Band #1", "Lower Band #1", "Upper Band #2", "Lower Band #2",
 *   "Upper Band #3", "Lower Band #3", "Volume"
 *
 * Other providers may use:
 *   "Time", "Date", "O", "H", "L", "C", "Vol", "vol",
 *   "upper_band_1", "upper band 1", etc.
 *
 * This module turns any incoming header into a canonical slug and exposes
 * a mapping to our canonical HistoricalBar field names.
 */

export type CanonicalField =
  | 'timestamp'
  | 'open' | 'high' | 'low' | 'close'
  | 'volume'
  | 'vwap'
  | 'upper_band_1' | 'lower_band_1'
  | 'upper_band_2' | 'lower_band_2'
  | 'upper_band_3' | 'lower_band_3';

/** Lowercased, alphanumeric slug from a raw header. */
export function slugify(header: string): string {
  return header
    .toLowerCase()
    .replace(/#/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const SLUG_TO_CANONICAL: Record<string, CanonicalField> = {
  // timestamps
  time: 'timestamp',
  timestamp: 'timestamp',
  unix: 'timestamp',
  unix_time: 'timestamp',
  date: 'timestamp',
  datetime: 'timestamp',

  // OHLC
  open: 'open', o: 'open',
  high: 'high', h: 'high',
  low: 'low', l: 'low',
  close: 'close', c: 'close',

  // volume
  volume: 'volume', vol: 'volume', v: 'volume',

  // vwap
  vwap: 'vwap', volume_weighted_average_price: 'vwap',

  // bands (handles "Upper Band #1", "upper_band_1", "upper band 1")
  upper_band_1: 'upper_band_1',
  upperband_1: 'upper_band_1',
  upper_1: 'upper_band_1',
  lower_band_1: 'lower_band_1',
  lowerband_1: 'lower_band_1',
  lower_1: 'lower_band_1',
  upper_band_2: 'upper_band_2',
  upperband_2: 'upper_band_2',
  upper_2: 'upper_band_2',
  lower_band_2: 'lower_band_2',
  lowerband_2: 'lower_band_2',
  lower_2: 'lower_band_2',
  upper_band_3: 'upper_band_3',
  upperband_3: 'upper_band_3',
  upper_3: 'upper_band_3',
  lower_band_3: 'lower_band_3',
  lowerband_3: 'lower_band_3',
  lower_3: 'lower_band_3',
};

/**
 * Given the raw header row, return a map from the canonical field name to
 * the original column index. Returns null for any canonical field that is
 * absent (the loader treats those as null-valued on every row).
 */
export function buildHeaderMap(headers: string[]): Record<CanonicalField, number | null> {
  const map: Record<CanonicalField, number | null> = {
    timestamp: null, open: null, high: null, low: null, close: null,
    volume: null, vwap: null,
    upper_band_1: null, lower_band_1: null,
    upper_band_2: null, lower_band_2: null,
    upper_band_3: null, lower_band_3: null,
  };

  headers.forEach((raw, idx) => {
    const slug = slugify(raw);
    const canon = SLUG_TO_CANONICAL[slug];
    if (canon && map[canon] === null) {
      map[canon] = idx;
    }
  });

  return map;
}

/** Which canonical fields are REQUIRED for a usable bar. */
export const REQUIRED_FIELDS: CanonicalField[] = ['timestamp', 'open', 'high', 'low', 'close'];
