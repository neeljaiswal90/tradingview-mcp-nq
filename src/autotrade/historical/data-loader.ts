/**
 * Streaming CSV loader for historical NQ OHLCV + VWAP/band data.
 *
 * Handles:
 *   - heterogeneous header capitalization / spacing / "#" characters
 *   - optional Volume / VWAP / band columns
 *   - unix-epoch-seconds OR ISO timestamps in the "time" column
 *   - duplicate timestamps (keeps first occurrence)
 *   - malformed rows (drops them with a count)
 *   - out-of-order rows (sorts chronologically before returning)
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import type { HistoricalBar, LoadSummary, Timeframe } from './schema.js';
import { TF_SECONDS } from './schema.js';
import {
  buildHeaderMap,
  REQUIRED_FIELDS,
  type CanonicalField,
} from './normalize-columns.js';

export interface LoadOptions {
  /** Drop bars with timestamp < this unix-seconds value. */
  from_unix?: number | null;
  /** Drop bars with timestamp > this unix-seconds value. */
  to_unix?: number | null;
  /** Max rows to load (useful for smoke tests). 0 = no limit. */
  limit?: number;
}

export interface LoadResult {
  bars: HistoricalBar[];
  summary: LoadSummary;
}

/** Parse one CSV line, respecting double-quoted commas. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s === '' || s.toUpperCase() === 'NAN' || s === 'null') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s === '') return null;
  // If purely numeric, treat as unix seconds or ms.
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    // Heuristic: > 10^12 implies milliseconds
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  // Try ISO date fallback
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return null;
}

export function loadCsvBars(
  filePath: string,
  tf: Timeframe,
  opts: LoadOptions = {},
): LoadResult {
  const raw = readFileSync(filePath, 'utf8');
  // Strip BOM
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);

  // Skip blank leading lines
  let headerIdx = 0;
  while (headerIdx < lines.length && (lines[headerIdx] ?? '').trim() === '') headerIdx++;
  if (headerIdx >= lines.length) {
    throw new Error(`Empty CSV: ${filePath}`);
  }
  const headers = parseCsvLine(lines[headerIdx]!);
  const map = buildHeaderMap(headers);

  for (const req of REQUIRED_FIELDS) {
    if (map[req] === null) {
      throw new Error(
        `CSV ${basename(filePath)} missing required column '${req}'. ` +
        `Headers seen: [${headers.join(', ')}]`,
      );
    }
  }

  const has_volume = map.volume !== null;
  const has_vwap = map.vwap !== null;
  const has_bands =
    map.upper_band_1 !== null && map.lower_band_1 !== null &&
    map.upper_band_2 !== null && map.lower_band_2 !== null &&
    map.upper_band_3 !== null && map.lower_band_3 !== null;

  const getCol = (cols: string[], field: CanonicalField): string | undefined => {
    const idx = map[field];
    return idx === null ? undefined : cols[idx];
  };

  const bars: HistoricalBar[] = [];
  const seen = new Set<number>();
  let malformed = 0;
  let duplicates = 0;
  let total = 0;
  const limit = opts.limit ?? 0;

  for (let li = headerIdx + 1; li < lines.length; li++) {
    const line = lines[li];
    if (line === undefined || line.trim() === '') continue;
    total++;

    const cols = parseCsvLine(line);
    const ts = parseTimestamp(getCol(cols, 'timestamp'));
    const open = parseNum(getCol(cols, 'open'));
    const high = parseNum(getCol(cols, 'high'));
    const low = parseNum(getCol(cols, 'low'));
    const close = parseNum(getCol(cols, 'close'));

    if (ts === null || open === null || high === null || low === null || close === null) {
      malformed++;
      continue;
    }
    // Basic sanity: high >= low, high >= open/close, low <= open/close
    if (high < low || high < open - 1e-9 || high < close - 1e-9
        || low > open + 1e-9 || low > close + 1e-9) {
      malformed++;
      continue;
    }
    // Time-range filter
    if (opts.from_unix != null && ts < opts.from_unix) continue;
    if (opts.to_unix != null && ts > opts.to_unix) continue;
    // Dedup
    if (seen.has(ts)) { duplicates++; continue; }
    seen.add(ts);

    bars.push({
      timestamp: ts,
      open, high, low, close,
      volume: has_volume ? parseNum(getCol(cols, 'volume')) : null,
      vwap: has_vwap ? parseNum(getCol(cols, 'vwap')) : null,
      upper_band_1: parseNum(getCol(cols, 'upper_band_1')),
      lower_band_1: parseNum(getCol(cols, 'lower_band_1')),
      upper_band_2: parseNum(getCol(cols, 'upper_band_2')),
      lower_band_2: parseNum(getCol(cols, 'lower_band_2')),
      upper_band_3: parseNum(getCol(cols, 'upper_band_3')),
      lower_band_3: parseNum(getCol(cols, 'lower_band_3')),
    });

    if (limit > 0 && bars.length >= limit) break;
  }

  bars.sort((a, b) => a.timestamp - b.timestamp);

  // Gap detection against the expected cadence
  const expectedStep = TF_SECONDS[tf];
  let gaps = 0;
  for (let i = 1; i < bars.length; i++) {
    const delta = bars[i]!.timestamp - bars[i - 1]!.timestamp;
    if (delta > expectedStep * 1.5) gaps++;
  }

  const first = bars[0]?.timestamp ?? null;
  const last = bars[bars.length - 1]?.timestamp ?? null;

  const summary: LoadSummary = {
    file: filePath,
    tf,
    rows_total: total,
    rows_accepted: bars.length,
    rows_skipped_malformed: malformed,
    rows_skipped_duplicate: duplicates,
    first_timestamp: first,
    last_timestamp: last,
    first_iso: first !== null ? new Date(first * 1000).toISOString() : null,
    last_iso: last !== null ? new Date(last * 1000).toISOString() : null,
    has_volume, has_vwap, has_bands,
    gaps_detected: gaps,
  };

  return { bars, summary };
}

/** Format a summary for human-readable logs. */
export function formatSummary(s: LoadSummary): string {
  return (
    `[${s.tf}] ${basename(s.file)}\n` +
    `  rows: ${s.rows_accepted}/${s.rows_total} accepted ` +
    `(skip malformed=${s.rows_skipped_malformed}, dup=${s.rows_skipped_duplicate}, gaps=${s.gaps_detected})\n` +
    `  range: ${s.first_iso ?? 'n/a'} → ${s.last_iso ?? 'n/a'}\n` +
    `  has_volume=${s.has_volume} has_vwap=${s.has_vwap} has_bands=${s.has_bands}`
  );
}
