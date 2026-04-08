/**
 * Tests for locally computed indicators and structure detection.
 * These replace TradingView study dependencies.
 */
import { describe, it, expect } from 'vitest';
import { ema, rsi, atr, vwap, adx, computeIndicators, type Bar } from '../../src/autotrade/features/indicators.js';
import { detectSwings, detectStructure } from '../../src/autotrade/features/structure.js';
import { computeSessionLevels } from '../../src/autotrade/features/session-levels.js';

function makeBar(close: number, i: number = 0, high?: number, low?: number): Bar {
  return {
    time: 1700000000 + i * 60,
    open: close - 0.5, high: high ?? close + 1, low: low ?? close - 1,
    close, volume: 100,
  };
}

function makeBars(closes: number[]): Bar[] {
  return closes.map((c, i) => makeBar(c, i));
}

describe('Local Indicators', () => {
  it('EMA computes correctly', () => {
    const vals = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = ema(vals, 9);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(100);
    expect(result!).toBeLessThan(120);
  });

  it('EMA returns null for insufficient data', () => {
    expect(ema([1, 2, 3], 9)).toBeNull();
  });

  it('RSI returns value in 0-100 range', () => {
    const vals = Array.from({ length: 20 }, (_, i) => 100 + i * 0.5);
    const result = rsi(vals, 14);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
    expect(result!).toBeLessThanOrEqual(100);
  });

  it('ATR computes from bars', () => {
    const bars = makeBars(Array.from({ length: 20 }, (_, i) => 100 + i));
    const result = atr(bars, 14);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });

  it('VWAP computes from bars', () => {
    const bars = makeBars([100, 101, 102, 103, 104]);
    const result = vwap(bars);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(99);
    expect(result!).toBeLessThan(105);
  });

  it('ADX returns all three components', () => {
    const bars = makeBars(Array.from({ length: 40 }, (_, i) => 100 + i * 0.5));
    const result = adx(bars, 14);
    expect(result.adx).not.toBeNull();
    expect(result.di_plus).not.toBeNull();
    expect(result.di_minus).not.toBeNull();
  });

  it('computeIndicators returns full snapshot', () => {
    const bars = makeBars(Array.from({ length: 250 }, (_, i) => 24000 + Math.sin(i / 10) * 50));
    const snap = computeIndicators(bars);
    expect(snap.ema_9).not.toBeNull();
    expect(snap.ema_21).not.toBeNull();
    expect(snap.rsi_14).not.toBeNull();
    expect(snap.atr_14).not.toBeNull();
    expect(snap.supertrend_direction).not.toBeNull();
  });
});

describe('Structure Detection', () => {
  it('detects swing highs and lows', () => {
    // Create a zigzag pattern
    const closes = [100, 102, 105, 103, 100, 98, 95, 97, 100, 102, 105, 108, 106, 103];
    const bars = makeBars(closes);
    const swings = detectSwings(bars, 2);
    const highs = swings.filter(s => s.type === 'high');
    const lows = swings.filter(s => s.type === 'low');
    expect(highs.length).toBeGreaterThan(0);
    expect(lows.length).toBeGreaterThan(0);
  });

  it('detectStructure returns complete structure', () => {
    const closes = [100, 102, 105, 103, 100, 98, 95, 97, 100, 103, 106, 109, 107, 104];
    const bars = makeBars(closes);
    const structure = detectStructure(bars, 2);
    expect(structure.recent_swing_highs.length).toBeGreaterThan(0);
    expect(structure.recent_swing_lows.length).toBeGreaterThan(0);
  });

  it('returns empty structure for insufficient data', () => {
    const bars = makeBars([100, 101]);
    const structure = detectStructure(bars, 3);
    expect(structure.swing_high).toBeNull();
    expect(structure.swing_low).toBeNull();
  });
});

describe('Session Levels', () => {
  it('computes basic session levels from bars', () => {
    const bars = makeBars(Array.from({ length: 30 }, (_, i) => 24000 + i * 2));
    const levels = computeSessionLevels(bars, 9, 15);
    expect(levels.daily_open).not.toBeNull();
    expect(levels.session_high).not.toBeNull();
    expect(levels.session_low).not.toBeNull();
    expect(levels.opening_range_high).not.toBeNull();
    expect(levels.opening_range_low).not.toBeNull();
  });

  it('returns null for empty bars', () => {
    const levels = computeSessionLevels([]);
    expect(levels.daily_open).toBeNull();
  });
});
