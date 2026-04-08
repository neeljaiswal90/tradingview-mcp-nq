/**
 * Tests for QuoteService — fresh price fetcher for the in-position monitor loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QuoteService } from '../../src/autotrade/quote-service.js';

describe('QuoteService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── fetchFresh() ──────────────────────────────────────────────────────────

  describe('fetchFresh()', () => {
    it('returns live price when header_price is present', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        header_price: 21500,
        last: 21499,
        bid: 21499.75,
        ask: 21500.25,
      });
      const svc = new QuoteService(3_000, 1_000, mockFetch);
      const result = await svc.fetchFresh();

      expect(result.price).toBe(21500);
      expect(result.source).toBe('live');
      expect(result.bid).toBe(21499.75);
      expect(result.ask).toBe(21500.25);
      expect(result.age_ms).toBe(0);
      expect(result.is_stale).toBe(false);
      expect(result.timestamp_iso).toBeTruthy();
      expect(result.timestamp_unix_ms).toBeGreaterThan(0);
    });

    it('falls back to bar_close when header_price is absent', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ last: 21499 });
      const svc = new QuoteService(3_000, 1_000, mockFetch);
      const result = await svc.fetchFresh();

      expect(result.price).toBe(21499);
      expect(result.source).toBe('bar_close');
      expect(result.bid).toBeUndefined();
      expect(result.ask).toBeUndefined();
    });

    it('throws when all providers fail (timeout)', async () => {
      const mockFetch = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 10_000)),
      );
      const svc = new QuoteService(3_000, 50, mockFetch);
      await expect(svc.fetchFresh()).rejects.toThrow('All quote providers failed');
    });

    it('throws when all providers fail (no price)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ symbol: 'NQ1!' });
      const svc = new QuoteService(3_000, 1_000, mockFetch);
      await expect(svc.fetchFresh()).rejects.toThrow('All quote providers failed');
    });

    it('throws when all providers fail (price is 0)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ last: 0 });
      const svc = new QuoteService(3_000, 1_000, mockFetch);
      await expect(svc.fetchFresh()).rejects.toThrow('All quote providers failed');
    });

    it('populates timestamp_iso as valid ISO string', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ header_price: 21500 });
      const svc = new QuoteService(3_000, 1_000, mockFetch);
      const result = await svc.fetchFresh();

      expect(() => new Date(result.timestamp_iso)).not.toThrow();
      expect(new Date(result.timestamp_iso).getTime()).toBeGreaterThan(0);
    });
  });

  // ─── makeFallback() ────────────────────────────────────────────────────────

  describe('makeFallback()', () => {
    it('returns a stale fallback result with the given price', () => {
      const svc = new QuoteService(3_000, 1_000);
      const result = svc.makeFallback(21450);

      expect(result.price).toBe(21450);
      expect(result.source).toBe('fallback');
      expect(result.is_stale).toBe(true);
      expect(result.age_ms).toBe(0);
      expect(result.timestamp_unix_ms).toBeGreaterThan(0);
    });
  });

  // ─── computeAge() ─────────────────────────────────────────────────────────

  describe('computeAge()', () => {
    it('returns ~0 for a result just created', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ last: 21500 });
      const svc = new QuoteService(3_000, 1_000, mockFetch);
      const result = await svc.fetchFresh();
      expect(svc.computeAge(result)).toBeLessThan(100);
    });

    it('returns elapsed time since timestamp_unix_ms', () => {
      vi.useFakeTimers();
      const svc = new QuoteService(3_000, 1_000);
      const result = svc.makeFallback(21500);

      vi.advanceTimersByTime(1_000);
      expect(svc.computeAge(result)).toBeCloseTo(1_000, -2); // within 100ms
    });
  });

  // ─── isStale() ────────────────────────────────────────────────────────────

  describe('isStale()', () => {
    it('returns false for a freshly fetched result', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ last: 21500 });
      const svc = new QuoteService(3_000, 1_000, mockFetch);
      const result = await svc.fetchFresh();
      expect(svc.isStale(result)).toBe(false);
    });

    it('returns false when age is below threshold', () => {
      vi.useFakeTimers();
      const svc = new QuoteService(3_000, 1_000);
      const result = svc.makeFallback(21500);
      // Override is_stale to test only the age check
      result.is_stale = false;

      vi.advanceTimersByTime(2_500); // 2500ms < 3000ms threshold
      expect(svc.isStale(result)).toBe(false);
    });

    it('returns true when age exceeds maxStaleMs', () => {
      vi.useFakeTimers();
      const svc = new QuoteService(3_000, 1_000);
      const result = svc.makeFallback(21500);
      result.is_stale = false; // test age-based detection only

      vi.advanceTimersByTime(3_001); // 3001ms > 3000ms threshold
      expect(svc.isStale(result)).toBe(true);
    });

    it('respects custom maxStaleMs threshold', () => {
      vi.useFakeTimers();
      const svc = new QuoteService(500, 1_000); // 500ms threshold
      const result = svc.makeFallback(21500);
      result.is_stale = false;

      vi.advanceTimersByTime(501);
      expect(svc.isStale(result)).toBe(true);
    });
  });
});
