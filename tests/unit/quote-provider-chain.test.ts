/**
 * Tests for the multi-source quote provider chain:
 * - Bookmap BBO as primary authority
 * - TradingView as fallback when sidecar is stale/down
 * - Stale Bookmap quotes rejected as authoritative
 * - Failover reason logging
 * - Graceful degradation
 */

import { describe, it, expect, vi } from 'vitest';
import {
  QuoteService,
  BookmapQuoteProvider,
  TradingViewQuoteProvider,
  type QuoteProvider,
  type QuoteResult,
} from '../../src/autotrade/quote-service.js';

// ─── Mock Providers ──────────────────────────────────────────────────────────

function makeMockProvider(
  name: string,
  priority: number,
  result: QuoteResult | null,
): QuoteProvider {
  return {
    name,
    priority,
    fetchQuote: vi.fn(async () => result),
  };
}

function freshBookmapQuote(price = 24200.375): QuoteResult {
  return {
    price,
    source: 'bookmap_bbo',
    timestamp_unix_ms: Date.now(),
    timestamp_iso: new Date().toISOString(),
    age_ms: 50,
    is_stale: false,
    bid: 24200.25,
    ask: 24200.50,
    spread_ticks: 1,
  };
}

function staleBookmapQuote(): QuoteResult {
  return {
    price: 24200.375,
    source: 'bookmap_bbo',
    timestamp_unix_ms: Date.now() - 10000,
    timestamp_iso: new Date(Date.now() - 10000).toISOString(),
    age_ms: 10000,
    is_stale: true,
    bid: 24200.25,
    ask: 24200.50,
  };
}

function freshTvQuote(price = 24201.00): QuoteResult {
  return {
    price,
    source: 'live',
    timestamp_unix_ms: Date.now(),
    timestamp_iso: new Date().toISOString(),
    age_ms: 0,
    is_stale: false,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('QuoteService provider chain', () => {

  it('uses Bookmap BBO when available and fresh', async () => {
    const bookmap = makeMockProvider('bookmap_bbo', 10, freshBookmapQuote());
    const tv = makeMockProvider('tradingview', 100, freshTvQuote());

    const qs = new QuoteService(3000, 1000, async () => ({ last: 24201 }));
    // Replace default TV provider
    (qs as any).providers.length = 0;
    qs.addProvider(bookmap);
    qs.addProvider(tv);

    const result = await qs.fetchFresh();
    expect(result.source).toBe('bookmap_bbo');
    expect(result.bid).toBe(24200.25);
    expect(result.ask).toBe(24200.50);
    expect(result.spread_ticks).toBe(1);
    expect(result.failover_reason).toBeUndefined();
    expect(bookmap.fetchQuote).toHaveBeenCalledOnce();
    // TradingView should NOT be called when Bookmap succeeds
    expect(tv.fetchQuote).not.toHaveBeenCalled();
  });

  it('falls back to TradingView when Bookmap returns null', async () => {
    const bookmap = makeMockProvider('bookmap_bbo', 10, null);
    const tv = makeMockProvider('tradingview', 100, freshTvQuote(24201));

    const qs = new QuoteService(3000, 1000, async () => ({ last: 24201 }));
    (qs as any).providers.length = 0;
    qs.addProvider(bookmap);
    qs.addProvider(tv);

    const result = await qs.fetchFresh();
    expect(result.source).toBe('live');
    expect(result.price).toBe(24201);
    expect(result.failover_reason).toBe('bookmap_bbo: unavailable');
  });

  it('falls back to TradingView when Bookmap quote is stale', async () => {
    const bookmap = makeMockProvider('bookmap_bbo', 10, staleBookmapQuote());
    const tv = makeMockProvider('tradingview', 100, freshTvQuote(24202));

    const qs = new QuoteService(3000, 1000, async () => ({ last: 24202 }));
    (qs as any).providers.length = 0;
    qs.addProvider(bookmap);
    qs.addProvider(tv);

    const result = await qs.fetchFresh();
    expect(result.source).toBe('live');
    expect(result.failover_reason).toContain('bookmap_bbo: stale');
  });

  it('throws when all providers fail', async () => {
    const bookmap = makeMockProvider('bookmap_bbo', 10, null);
    const tv = makeMockProvider('tradingview', 100, null);

    const qs = new QuoteService(3000, 1000, async () => ({ last: 24201 }));
    (qs as any).providers.length = 0;
    qs.addProvider(bookmap);
    qs.addProvider(tv);

    await expect(qs.fetchFresh()).rejects.toThrow('All quote providers failed');
  });

  it('catches provider errors and tries next', async () => {
    const errorProvider: QuoteProvider = {
      name: 'broken',
      priority: 5,
      fetchQuote: vi.fn(async () => { throw new Error('network_down'); }),
    };
    const tv = makeMockProvider('tradingview', 100, freshTvQuote(24203));

    const qs = new QuoteService(3000, 1000, async () => ({ last: 24203 }));
    (qs as any).providers.length = 0;
    qs.addProvider(errorProvider);
    qs.addProvider(tv);

    const result = await qs.fetchFresh();
    expect(result.source).toBe('live');
    expect(result.failover_reason).toContain('broken: error (network_down)');
  });

  it('providers are sorted by priority (lowest first)', () => {
    const qs = new QuoteService(3000, 1000, async () => ({ last: 1 }));
    const p1 = makeMockProvider('high', 200, null);
    const p2 = makeMockProvider('low', 5, null);

    qs.addProvider(p1);
    qs.addProvider(p2);

    const providers = qs.getProviders();
    expect(providers[0]!.name).toBe('low');
    expect(providers[providers.length - 1]!.name).toBe('high');
  });

  it('Bookmap bid/ask/spread flow through to QuoteResult', async () => {
    const bookmap = makeMockProvider('bookmap_bbo', 10, {
      price: 24250.125,
      source: 'bookmap_bbo',
      timestamp_unix_ms: Date.now(),
      timestamp_iso: new Date().toISOString(),
      age_ms: 20,
      is_stale: false,
      bid: 24250.00,
      ask: 24250.25,
      spread_ticks: 1,
    });

    const qs = new QuoteService(3000, 1000, async () => ({ last: 1 }));
    (qs as any).providers.length = 0;
    qs.addProvider(bookmap);

    const result = await qs.fetchFresh();
    expect(result.bid).toBe(24250.00);
    expect(result.ask).toBe(24250.25);
    expect(result.spread_ticks).toBe(1);
  });

  it('stale Bookmap quote is NOT treated as authoritative', async () => {
    // This is the critical safety test: a stale Bookmap quote must not drive
    // stop evaluation or ML decisions.
    const stale = staleBookmapQuote();
    expect(stale.is_stale).toBe(true);

    const bookmap = makeMockProvider('bookmap_bbo', 10, stale);
    const tv = makeMockProvider('tradingview', 100, freshTvQuote(24205));

    const qs = new QuoteService(3000, 1000, async () => ({ last: 24205 }));
    (qs as any).providers.length = 0;
    qs.addProvider(bookmap);
    qs.addProvider(tv);

    const result = await qs.fetchFresh();
    // Must NOT use the stale Bookmap quote
    expect(result.source).not.toBe('bookmap_bbo');
    expect(result.source).toBe('live');
  });
});

describe('QuoteService fallback helpers', () => {
  it('makeFallback creates a stale result', () => {
    const qs = new QuoteService(3000, 1000);
    const result = qs.makeFallback(24200);
    expect(result.source).toBe('fallback');
    expect(result.is_stale).toBe(true);
    expect(result.price).toBe(24200);
  });

  it('computeAge returns elapsed time', async () => {
    const qs = new QuoteService(3000, 1000);
    const result: QuoteResult = {
      price: 100,
      source: 'live',
      timestamp_unix_ms: Date.now() - 500,
      timestamp_iso: '',
      age_ms: 0,
      is_stale: false,
    };
    const age = qs.computeAge(result);
    expect(age).toBeGreaterThanOrEqual(490);
    expect(age).toBeLessThanOrEqual(600);
  });

  it('isStale returns true when age exceeds threshold', () => {
    const qs = new QuoteService(1000, 1000); // 1s max stale
    const result: QuoteResult = {
      price: 100,
      source: 'live',
      timestamp_unix_ms: Date.now() - 2000, // 2s old
      timestamp_iso: '',
      age_ms: 0,
      is_stale: false,
    };
    expect(qs.isStale(result)).toBe(true);
  });
});
