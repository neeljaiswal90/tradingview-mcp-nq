import { describe, it, expect } from 'vitest';
import { fmtPrice, fmtUsd, fmtPnlUsd, fmtPct, fmtNum, pnlClass } from '../../dashboard/src/format';

describe('dashboard format helpers', () => {
  describe('fmtPrice', () => {
    it('formats a normal number', () => {
      expect(fmtPrice(17250.5)).toBe('17250.50');
    });
    it('returns dash for null', () => {
      expect(fmtPrice(null)).toBe('\u2014');
    });
    it('returns dash for undefined', () => {
      expect(fmtPrice(undefined)).toBe('\u2014');
    });
    it('returns dash for NaN', () => {
      expect(fmtPrice(NaN)).toBe('\u2014');
    });
    it('returns dash for Infinity', () => {
      expect(fmtPrice(Infinity)).toBe('\u2014');
    });
    it('respects custom decimals', () => {
      expect(fmtPrice(1.2345, 3)).toBe('1.234');
    });
    it('handles zero', () => {
      expect(fmtPrice(0)).toBe('0.00');
    });
  });

  describe('fmtUsd', () => {
    it('formats positive with + sign', () => {
      expect(fmtUsd(123.456)).toBe('+$123.46');
    });
    it('formats negative with - sign', () => {
      expect(fmtUsd(-50)).toBe('$-50.00');
    });
    it('formats zero with + sign', () => {
      expect(fmtUsd(0)).toBe('+$0.00');
    });
    it('returns dash for null', () => {
      expect(fmtUsd(null)).toBe('\u2014');
    });
    it('returns dash for undefined', () => {
      expect(fmtUsd(undefined)).toBe('\u2014');
    });
  });

  describe('fmtPnlUsd', () => {
    it('formats positive without + sign', () => {
      expect(fmtPnlUsd(100)).toBe('$100.00');
    });
    it('formats negative', () => {
      expect(fmtPnlUsd(-75.5)).toBe('$-75.50');
    });
    it('returns dash for null', () => {
      expect(fmtPnlUsd(null)).toBe('\u2014');
    });
  });

  describe('fmtPct', () => {
    it('formats a percentage', () => {
      expect(fmtPct(52.3)).toBe('52.3%');
    });
    it('returns dash for null', () => {
      expect(fmtPct(null)).toBe('\u2014');
    });
  });

  describe('fmtNum', () => {
    it('formats a number with 1 decimal', () => {
      expect(fmtNum(7.56)).toBe('7.6');
    });
    it('returns dash for undefined', () => {
      expect(fmtNum(undefined)).toBe('\u2014');
    });
  });

  describe('pnlClass', () => {
    it('returns pnl-pos for positive', () => {
      expect(pnlClass(100)).toBe('pnl-pos');
    });
    it('returns pnl-neg for negative', () => {
      expect(pnlClass(-50)).toBe('pnl-neg');
    });
    it('returns pnl-zero for zero', () => {
      expect(pnlClass(0)).toBe('pnl-zero');
    });
    it('returns pnl-zero for null', () => {
      expect(pnlClass(null)).toBe('pnl-zero');
    });
    it('returns pnl-zero for undefined', () => {
      expect(pnlClass(undefined)).toBe('pnl-zero');
    });
  });
});
