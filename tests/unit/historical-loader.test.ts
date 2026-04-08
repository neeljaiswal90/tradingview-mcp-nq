import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadCsvBars } from '../../src/autotrade/historical/data-loader.js';
import { buildHeaderMap, slugify } from '../../src/autotrade/historical/normalize-columns.js';

function writeTmpCsv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hist-loader-'));
  const path = join(dir, 'test.csv');
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('slugify / buildHeaderMap', () => {
  it('normalizes the actual NQ CSV headers', () => {
    const headers = [
      'time', 'open', 'high', 'low', 'close', 'VWAP',
      'Upper Band #1', 'Lower Band #1', 'Upper Band #2', 'Lower Band #2',
      'Upper Band #3', 'Lower Band #3', 'Volume',
    ];
    const map = buildHeaderMap(headers);
    expect(map.timestamp).toBe(0);
    expect(map.open).toBe(1);
    expect(map.close).toBe(4);
    expect(map.vwap).toBe(5);
    expect(map.upper_band_1).toBe(6);
    expect(map.lower_band_3).toBe(11);
    expect(map.volume).toBe(12);
  });

  it('handles weird capitalization and punctuation', () => {
    expect(slugify('Upper Band #1')).toBe('upper_band_1');
    expect(slugify('VWAP')).toBe('vwap');
    expect(slugify('DateTime')).toBe('datetime');
    expect(slugify('vol')).toBe('vol');
  });

  it('leaves missing fields as null', () => {
    const m = buildHeaderMap(['time', 'open', 'high', 'low', 'close']);
    expect(m.volume).toBeNull();
    expect(m.vwap).toBeNull();
  });
});

describe('loadCsvBars', () => {
  const full = [
    'time,open,high,low,close,VWAP,Upper Band #1,Lower Band #1,Upper Band #2,Lower Band #2,Upper Band #3,Lower Band #3,Volume',
    '1700000000,100,110,95,105,102,104,100,106,98,108,96,500',
    '1700000060,105,108,103,106,103,105,101,107,99,109,97,300',
    '1700000120,106,107,102,104,103.5,105,101,107,99,109,97,250',
  ].join('\n');

  it('parses full schema rows correctly', () => {
    const path = writeTmpCsv(full);
    const { bars, summary } = loadCsvBars(path, '1m');
    expect(summary.rows_accepted).toBe(3);
    expect(summary.has_volume).toBe(true);
    expect(summary.has_bands).toBe(true);
    expect(bars[0]!.timestamp).toBe(1_700_000_000);
    expect(bars[0]!.open).toBe(100);
    expect(bars[0]!.upper_band_1).toBe(104);
    expect(bars[2]!.volume).toBe(250);
  });

  it('drops malformed / sanity-violating rows', () => {
    const bad = [
      'time,open,high,low,close',
      '1700000000,100,95,110,105', // high<low → reject
      '1700000060,105,108,103,106', // ok
      'notanumber,1,2,1,2',         // reject ts
    ].join('\n');
    const path = writeTmpCsv(bad);
    const { bars, summary } = loadCsvBars(path, '1m');
    expect(bars.length).toBe(1);
    expect(summary.rows_skipped_malformed).toBe(2);
  });

  it('deduplicates identical timestamps', () => {
    const dupe = [
      'time,open,high,low,close',
      '1700000000,100,110,95,105',
      '1700000000,100,110,95,105',
      '1700000060,105,108,103,106',
    ].join('\n');
    const path = writeTmpCsv(dupe);
    const { bars, summary } = loadCsvBars(path, '1m');
    expect(bars.length).toBe(2);
    expect(summary.rows_skipped_duplicate).toBe(1);
  });

  it('sorts out-of-order rows chronologically', () => {
    const oo = [
      'time,open,high,low,close',
      '1700000120,106,107,102,104',
      '1700000000,100,110,95,105',
      '1700000060,105,108,103,106',
    ].join('\n');
    const path = writeTmpCsv(oo);
    const { bars } = loadCsvBars(path, '1m');
    expect(bars.map(b => b.timestamp)).toEqual([1_700_000_000, 1_700_000_060, 1_700_000_120]);
  });

  it('applies from/to filters', () => {
    const path = writeTmpCsv(full);
    const { bars } = loadCsvBars(path, '1m', { from_unix: 1_700_000_060 });
    expect(bars.length).toBe(2);
    expect(bars[0]!.timestamp).toBe(1_700_000_060);
  });

  it('detects gaps between bars', () => {
    const gap = [
      'time,open,high,low,close',
      '1700000000,100,110,95,105',
      '1700000060,105,108,103,106',
      '1700000900,110,115,108,112', // 14-minute gap
    ].join('\n');
    const path = writeTmpCsv(gap);
    const { summary } = loadCsvBars(path, '1m');
    expect(summary.gaps_detected).toBeGreaterThanOrEqual(1);
  });
});
