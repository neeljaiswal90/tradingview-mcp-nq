/**
 * QuoteService — multi-source quote aggregator for the in-position monitor loop.
 *
 * Quote priority chain (first healthy source wins):
 *   1. Bookmap/Rithmic BBO (via LOB bridge sidecar) — primary authority
 *   2. TradingView live DOM header price — migration fallback
 *   3. TradingView bar close — stale fallback
 *   4. Defensive fallback (lastSnap.price) — last resort
 *
 * The priority chain is traversed top-to-bottom. Each provider either returns
 * a fresh quote or throws/returns null, causing the next provider to be tried.
 * Failover reasons are logged for every tick.
 */

import * as tvData from '../core/tradingview/data.js';
import { LobClient } from './lob-client.js';

export type QuoteSource = 'bookmap_bbo' | 'live' | 'bar_close' | 'fallback';

export interface QuoteResult {
  price: number;
  source: QuoteSource;
  timestamp_iso: string;
  timestamp_unix_ms: number;
  /** Age at time of creation — 0 for freshly fetched results. */
  age_ms: number;
  is_stale: boolean;
  bid?: number;
  ask?: number;
  /** Spread in ticks (populated when bid+ask both available). */
  spread_ticks?: number;
  /** Why this source was selected (for observability). */
  failover_reason?: string;
}

/**
 * QuoteProvider — pluggable quote backend.
 *
 * Implementations:
 *   BookmapQuoteProvider — BBO from the LOB bridge sidecar
 *   TradingViewQuoteProvider — DOM/bar price from TradingView CDP
 */
export interface QuoteProvider {
  /** Name for logging. */
  readonly name: string;
  /** Priority: lower = preferred. Bookmap = 10, TradingView = 100. */
  readonly priority: number;
  /** Fetch a fresh quote. Returns null if unavailable (don't throw). */
  fetchQuote(): Promise<QuoteResult | null>;
}

// ─── BookmapQuoteProvider ────────────────────────────────────────────────────

export class BookmapQuoteProvider implements QuoteProvider {
  readonly name = 'bookmap_bbo';
  readonly priority = 10;

  constructor(
    private readonly lobClient: LobClient,
    private readonly maxStaleMs: number,
  ) {}

  async fetchQuote(): Promise<QuoteResult | null> {
    try {
      // Use lightweight /lob/bbo endpoint — avoids full feature computation
      const bbo = await this.lobClient.getBbo();

      // Reject if sidecar reports stale or no data
      const isFresh = bbo.bbo_age_ms < this.maxStaleMs;
      if (!isFresh) {
        return null;
      }

      // Need at least bid+ask for a meaningful BBO quote
      if (bbo.bid === null || bbo.ask === null || bbo.mid === null) {
        return null;
      }

      // Use mid price as the canonical price (most accurate for NQ)
      const now = Date.now();
      return {
        price: bbo.mid,
        source: 'bookmap_bbo',
        timestamp_unix_ms: bbo.timestamp_ms || now,
        timestamp_iso: new Date(bbo.timestamp_ms || now).toISOString(),
        age_ms: bbo.bbo_age_ms,
        is_stale: bbo.bbo_age_ms > this.maxStaleMs,
        bid: bbo.bid,
        ask: bbo.ask,
        spread_ticks: bbo.spread_pts !== null ? bbo.spread_pts / 0.25 : undefined,
      };
    } catch {
      return null; // sidecar unreachable — silent fallthrough
    }
  }
}

// ─── TradingViewQuoteProvider ────────────────────────────────────────────────

export class TradingViewQuoteProvider implements QuoteProvider {
  readonly name = 'tradingview';
  readonly priority = 100;

  constructor(
    private readonly timeoutMs: number,
    private readonly fetchImpl?: () => Promise<Record<string, unknown>>,
    private readonly paneIndex?: number,
  ) {}

  async fetchQuote(): Promise<QuoteResult | null> {
    try {
      const pi = this.paneIndex;
      const fetchFn = this.fetchImpl
        ?? ((): Promise<Record<string, unknown>> => tvData.getQuote({ paneIndex: pi }) as Promise<Record<string, unknown>>);

      const raw = await Promise.race([
        fetchFn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('tv_quote_timeout')), this.timeoutMs),
        ),
      ]);

      const headerPrice = typeof raw['header_price'] === 'number' ? raw['header_price'] as number : null;
      const barClose = typeof raw['last'] === 'number' ? raw['last'] as number : null;
      const price = headerPrice ?? barClose;
      if (price === null || price === 0) return null;

      const source: QuoteSource = headerPrice !== null ? 'live' : 'bar_close';
      const now = Date.now();
      return {
        price,
        source,
        timestamp_unix_ms: now,
        timestamp_iso: new Date(now).toISOString(),
        age_ms: 0,
        is_stale: false,
        bid: typeof raw['bid'] === 'number' ? raw['bid'] as number : undefined,
        ask: typeof raw['ask'] === 'number' ? raw['ask'] as number : undefined,
      };
    } catch {
      return null;
    }
  }
}

// ─── QuoteService ────────────────────────────────────────────────────────────

export class QuoteService {
  private readonly providers: QuoteProvider[] = [];

  constructor(
    private readonly maxStaleMs: number,
    private readonly timeoutMs: number,
    /** Optional TradingView fetch override (tests). */
    fetchImpl?: () => Promise<Record<string, unknown>>,
  ) {
    // Default: TradingView as baseline provider
    this.providers.push(new TradingViewQuoteProvider(timeoutMs, fetchImpl));
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Register an additional quote provider. Providers are tried in priority
   * order (lowest number first).
   */
  addProvider(provider: QuoteProvider): void {
    this.providers.push(provider);
    this.providers.sort((a, b) => a.priority - b.priority);
    console.log(`[QUOTE] Provider registered: ${provider.name} (priority=${provider.priority})`);
  }

  /**
   * Set pane index on the TradingView provider after construction.
   * Used when pane discovery happens later in the startup sequence.
   */
  setPaneIndex(paneIndex: number): void {
    for (const p of this.providers) {
      if (p instanceof TradingViewQuoteProvider) {
        (p as any).paneIndex = paneIndex;
      }
    }
  }

  /**
   * Fetch a fresh quote by walking the provider chain.
   *
   * Tries each provider in priority order. First non-null, non-stale result wins.
   * If all providers fail, throws.
   *
   * The returned QuoteResult includes `failover_reason` explaining why higher-
   * priority providers were skipped (if any).
   */
  async fetchFresh(opts?: {
    timeoutMs?: number;
    perProviderTimeoutMs?: Record<string, number>;
  }): Promise<QuoteResult> {
    const failoverReasons: string[] = [];

    for (const provider of this.providers) {
      try {
        let resultPromise = provider.fetchQuote();
        // Per-provider timeout takes precedence, then global, then no timeout
        const effectiveTimeout = opts?.perProviderTimeoutMs?.[provider.name]
          ?? opts?.timeoutMs;
        if (effectiveTimeout !== undefined) {
          resultPromise = Promise.race([
            resultPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), effectiveTimeout)),
          ]);
        }
        const result = await resultPromise;
        if (result !== null && !result.is_stale) {
          // Annotate with failover context if we skipped higher-priority providers
          if (failoverReasons.length > 0) {
            result.failover_reason = failoverReasons.join('; ');
          }
          return result;
        }
        // Provider returned null or stale — record reason and try next
        failoverReasons.push(
          result === null
            ? `${provider.name}: unavailable`
            : `${provider.name}: stale (${result.age_ms}ms)`,
        );
      } catch (err) {
        failoverReasons.push(
          `${provider.name}: error (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    throw new Error(`All quote providers failed: ${failoverReasons.join('; ')}`);
  }

  /** Build a stale fallback result from a known price. */
  makeFallback(price: number): QuoteResult {
    const now = Date.now();
    return {
      price,
      source: 'fallback',
      timestamp_unix_ms: now,
      timestamp_iso: new Date(now).toISOString(),
      age_ms: 0,
      is_stale: true,
      failover_reason: 'all_providers_failed',
    };
  }

  /** Compute the current age (ms) of a previously fetched result. */
  computeAge(result: QuoteResult): number {
    return Date.now() - result.timestamp_unix_ms;
  }

  /** True when the result's age exceeds the configured staleness threshold. */
  isStale(result: QuoteResult): boolean {
    return this.computeAge(result) > this.maxStaleMs;
  }

  /** Get the list of registered providers (for diagnostics). */
  getProviders(): readonly QuoteProvider[] {
    return this.providers;
  }
}
