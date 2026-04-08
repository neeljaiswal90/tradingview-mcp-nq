/**
 * Canonical historical-bar schemas.
 *
 * The CSVs produced by TradingView for NQ1! share the shape:
 *   time, open, high, low, close, VWAP,
 *   Upper Band #1, Lower Band #1,
 *   Upper Band #2, Lower Band #2,
 *   Upper Band #3, Lower Band #3,
 *   Volume
 *
 * `time` is always unix epoch seconds. Column names vary in case/spacing
 * across providers, so the loader normalizes headers (see normalize-columns.ts)
 * and then maps the normalized keys into these canonical types.
 */

/** A bare OHLCV bar (all timeframes have at least this). */
export interface HistoricalBarBase {
  /** Unix epoch seconds at bar-OPEN time. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Null when the provider did not include a Volume column. */
  volume: number | null;
}

/** A higher-timeframe bar with VWAP + 3 symmetric bands. */
export interface HistoricalBarWithBands extends HistoricalBarBase {
  vwap: number | null;
  upper_band_1: number | null;
  lower_band_1: number | null;
  upper_band_2: number | null;
  lower_band_2: number | null;
  upper_band_3: number | null;
  lower_band_3: number | null;
}

/** Alias used throughout the historical pipeline — all loaded bars are rich. */
export type HistoricalBar = HistoricalBarWithBands;

export type Timeframe = '1m' | '5m' | '15m' | '60m';

/** Seconds per bar for each timeframe. */
export const TF_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '60m': 3600,
};

/** Minutes per bar for each timeframe (convenience). */
export const TF_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '60m': 60,
};

export interface LoadSummary {
  file: string;
  tf: Timeframe;
  rows_total: number;
  rows_accepted: number;
  rows_skipped_malformed: number;
  rows_skipped_duplicate: number;
  first_timestamp: number | null;
  last_timestamp: number | null;
  first_iso: string | null;
  last_iso: string | null;
  has_volume: boolean;
  has_vwap: boolean;
  has_bands: boolean;
  gaps_detected: number;
}
