/**
 * DataCollector — fetches multi-timeframe OHLCV, indicator values,
 * and key levels from TradingView by switching timeframes in sequence.
 *
 * Always restores the chart to 1m at the end.
 *
 * Performance notes:
 *   - TF switch sleeps reduced to 150ms (minimum for chart to settle)
 *   - HTF data (5m/15m/1h) cached with TTL; only re-fetched when stale
 *   - All reads within a single TF are parallelized via Promise.all
 *   - Timing instrumentation on each phase for observability
 *
 * Indicator sourcing:
 *   local_computed  — EMA 9/21/50/200, RSI 14, ATR 14, VWAP, Volume SMA, ADX, SuperTrend direction
 *   tradingview_study — SuperTrend level, NovaWave, SmartMoney BOS/CHoCH, TTM Squeeze, CVD
 *
 *   For the 1m snapshot both sources are merged; locally-computed values take precedence.
 *   For 15m and 1h snapshots only local computation is used — TV-only fields remain null.
 */

import * as chart from '../core/tradingview/chart.js';
import * as data from '../core/tradingview/data.js';
import * as pane from '../core/tradingview/pane.js';
import type {
  OhlcvBar,
  IndicatorSnapshot,
  KeyLevels,
  MarketSnapshot,
  DataQuality,
  HtfZonesConfig,
} from './types.js';
import { classifySession, buildOpeningRange, computePriorLevels } from './session.js';
import type { SessionContext } from './session.js';
import { computeIndicators } from './features/indicators.js';
import { buildHtfContext, emptyHtfContext, DEFAULT_HTF_ZONES_CONFIG } from './features/htf-zones.js';
import { tryGetContractSpec } from './contracts.js';
import type { ContractRoot } from './contracts.js';

// ─── Raw type helpers ────────────────────────────────────────────────────────

interface RawBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface RawStudyValues {
  success: boolean;
  studies: Array<{
    name: string;
    values: Record<string, string>;
  }>;
}

interface RawOhlcvResult {
  success: boolean;
  bars: RawBar[];
  bar_count: number;
}

interface RawPineLines {
  success: boolean;
  studies: Array<{
    name: string;
    horizontal_levels: number[];
  }>;
}

interface RawPineLabels {
  success: boolean;
  studies: Array<{
    name: string;
    labels: Array<{ text: string; price: number }>;
  }>;
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function parseTvFloat(val: string | undefined): number | null {
  if (!val) return null;
  // Normalize: strip commas, replace Unicode minus (U+2212) with ASCII hyphen
  const cleaned = val.replace(/,/g, '').replace(/\u2212/g, '-').trim();
  // Handle SI suffixes: "2.49 K" → 2490, "35.69 M" → 35690000
  const match = cleaned.match(/^([-\d.]+)\s*([KkMm]?)$/);
  if (!match || !match[1]) return null;
  const base = parseFloat(match[1]);
  if (isNaN(base)) return null;
  const suffix = (match[2] ?? '').toUpperCase();
  if (suffix === 'K') return base * 1000;
  if (suffix === 'M') return base * 1000000;
  return base;
}

function extractStudyValues(raw: RawStudyValues | null): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!raw?.studies) return out;
  for (const study of raw.studies) {
    for (const [key, val] of Object.entries(study.values)) {
      // Store both unprefixed (for backward compat) and prefixed (for disambiguation)
      out[key] = parseTvFloat(val);
      out[`${study.name}::${key}`] = parseTvFloat(val);
    }
  }
  return out;
}

// ─── Exported for unit testing ──────────────────────────────────────────────

/**
 * Build an IndicatorSnapshot using only local bar computation.
 * Source: local_computed for all numeric indicators.
 * TV-only fields (SmartMoney, NovaWave, TTM, CVD, SuperTrend level) remain null.
 *
 * Used for all timeframes where TV study extraction is not needed (5m, 15m, 1h).
 */
export function buildLocalIndicatorSnapshot(bars: OhlcvBar[]): IndicatorSnapshot {
  const local = computeIndicators(bars);
  return {
    // ── local_computed ───────────────────────────────────────────────────
    ema_9:               local.ema_9,
    ema_21:              local.ema_21,
    ema_50:              local.ema_50,
    ema_100:             null,             // @deprecated
    ema_200:             local.ema_200,
    rsi_14:              local.rsi_14,
    atr_14:              local.atr_14,
    vwap:                local.vwap,
    volume_sma_20:       local.volume_sma_20,
    adx:                 local.adx,
    di_plus:             local.di_plus,
    di_minus:            local.di_minus,
    supertrend_direction: local.supertrend_direction,
    // ── volume: last bar volume ───────────────────────────────────────────
    volume: bars.length > 0 ? (bars[bars.length - 1]?.volume ?? null) : null,
    // ── tradingview_study (no local equivalent — null for all HTF paths) ─
    supertrend_level:          null,
    novawave_fast:             null,
    novawave_slow:             null,
    novawave_signal:           null,  // @deprecated
    dma_20:                    null,  // @deprecated
    dma_50:                    null,  // @deprecated
    dma_200:                   null,  // @deprecated
    smart_money_choch_sell:    null,
    smart_money_choch_buy:     null,
    smart_money_bos_sell:      null,
    smart_money_bos_buy:       null,
    ttm_squeeze_momentum:      null,
    ttm_squeeze_firing:        null,
    cvd:                       null,
    cvd_delta:                 null,
    cvd_trend:                 null,
  };
}

/**
 * Extract TV-only study fields and overlay them onto a locally-computed snapshot.
 *
 * Used exclusively for the 1m snapshot where SmartMoney/NovaWave/TTM/CVD
 * must come from TradingView Pine Script studies. Locally-computed fields
 * (EMA, RSI, ATR, VWAP, ADX, SuperTrend direction) from the base snapshot
 * take precedence and are NOT overridden.
 */
export function overlayTvStudyFields(
  base: IndicatorSnapshot,
  tvVals: Record<string, number | null>,
): IndicatorSnapshot {
  // ── SuperTrend level (direction already in base from local computation) ─
  const stUp = tvVals['Up Trend'] ?? null;
  const stDown = tvVals['Down Trend'] ?? null;
  const supLevel = stUp ?? stDown ?? null;

  // ── TTM Squeeze ────────────────────────────────────────────────────────
  const ttmKey = Object.keys(tvVals).find(k =>
    k.includes('TTM Squeeze') && k.includes('::') && k.endsWith('::Plot')
  );
  const ttmMomentum = (ttmKey ? tvVals[ttmKey] : tvVals['Plot']) ?? null;
  const ttmFiring = ttmMomentum !== null ? Math.abs(ttmMomentum) < 0.5 : null;

  // ── CVD ───────────────────────────────────────────────────────────────
  const cvdKey = Object.keys(tvVals).find(k =>
    k.includes('CVD') && k.includes('::') && k.endsWith('::CVD')
  );
  const cvdVal = (cvdKey ? tvVals[cvdKey] : tvVals['CVD']) ?? null;
  const cvdDelta = tvVals['Volume delta for the bar'] ?? null;
  const cvdUpTrend = tvVals['Up trend'] ?? null;
  const cvdDnTrend = tvVals['Dn trend'] ?? null;
  const cvdTrend: 'up' | 'down' | null =
    cvdUpTrend !== null && cvdUpTrend !== 0 ? 'up' :
    cvdDnTrend !== null && cvdDnTrend !== 0 ? 'down' : null;

  return {
    // ── local_computed fields pass through unchanged ──────────────────────
    ema_9:               base.ema_9,
    ema_21:              base.ema_21,
    ema_50:              base.ema_50,
    ema_100:             null,         // @deprecated
    ema_200:             base.ema_200,
    rsi_14:              base.rsi_14,
    atr_14:              base.atr_14,
    vwap:                base.vwap,
    volume_sma_20:       base.volume_sma_20,
    adx:                 base.adx,
    di_plus:             base.di_plus,
    di_minus:            base.di_minus,
    supertrend_direction: base.supertrend_direction,  // local proxy (EMA9 vs EMA21)
    // ── volume: prefer TV bar volume, fall back to local ─────────────────
    volume: tvVals['Volume'] ?? base.volume,
    // ── tradingview_study fields (overlaid from Pine Script studies) ──────
    supertrend_level:          supLevel,
    novawave_fast:             tvVals['NovaWave Fast EMA'] ?? null,
    novawave_slow:             tvVals['NovaWave Slow EMA'] ?? null,
    novawave_signal:           null,  // @deprecated
    dma_20:                    null,  // @deprecated
    dma_50:                    null,  // @deprecated
    dma_200:                   null,  // @deprecated
    smart_money_choch_sell:    tvVals['CHoCH Sell'] ?? null,
    smart_money_choch_buy:     tvVals['CHoCH Buy'] ?? null,
    smart_money_bos_sell:      tvVals['BOS Sell'] ?? null,
    smart_money_bos_buy:       tvVals['BOS Buy'] ?? null,
    ttm_squeeze_momentum:      ttmMomentum,
    ttm_squeeze_firing:        ttmFiring,
    cvd:                       cvdVal,
    cvd_delta:                 cvdDelta,
    cvd_trend:                 cvdTrend,
  };
}

function extractBars(raw: RawOhlcvResult | null): OhlcvBar[] {
  if (!raw?.bars || !Array.isArray(raw.bars)) return [];
  return raw.bars.map(b => ({
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

function extractKeyLevels(
  lines: RawPineLines | null,
  labels: RawPineLabels | null,
  price: number,
): KeyLevels {
  const levels: KeyLevels = {
    session_high: null,
    session_low: null,
    daily_open: null,
    weekly_open: null,
    monday_high: null,
    monday_low: null,
    monday_mid: null,
    monthly_open: null,
    pivot_resistance: [],
    pivot_support: [],
    choch_sell: null,
    choch_buy: null,
    bos_sell: null,
    bos_buy: null,
    overnight_high: null,
    overnight_low: null,
    prior_rth_high: null,
    prior_rth_low: null,
    opening_range_high: null,
    opening_range_low: null,
    opening_range_mid: null,
    session_vwap: null,
  };

  // Parse RIPS Key Levels labels
  if (labels?.studies) {
    for (const study of labels.studies) {
      if (!study.name.includes('RIPS')) continue;
      for (const lbl of study.labels) {
        const txt = lbl.text.toLowerCase();
        const p = lbl.price;
        if (txt.includes('daily open')) levels.daily_open = p;
        else if (txt.includes('weekly open')) levels.weekly_open = p;
        else if (txt.includes('monday high')) levels.monday_high = p;
        else if (txt.includes('monday low')) levels.monday_low = p;
        else if (txt.includes('monday mid')) levels.monday_mid = p;
        else if (txt.includes('monthly open') || txt.includes('quarterly open')) levels.monthly_open = p;
      }
    }
  }

  // Parse SmartMoney BOS/CHoCH from lines
  if (lines?.studies) {
    for (const study of lines.studies) {
      if (study.name.includes('Smart Money')) {
        const sorted = [...study.horizontal_levels].sort((a, b) => a - b);
        // Find the levels closest to price from SmartMoney indicator
        // We'll take the nearest above and below as the BOS/CHoCH levels
        const above = sorted.filter(l => l > price);
        const below = sorted.filter(l => l <= price);
        const aboveFirst = above[0];
        const belowLast = below[below.length - 1];
        if (aboveFirst !== undefined) levels.choch_sell = aboveFirst;
        if (belowLast !== undefined) levels.choch_buy = belowLast;
      }
    }
    // Pivot Levels [BigBeluga] — nearest pivots above/below
    for (const study of lines.studies) {
      if (!study.name.includes('Pivot')) continue;
      const sorted = [...study.horizontal_levels].sort((a, b) => a - b);
      const above = sorted.filter(l => l > price).slice(0, 3);
      const below = sorted.filter(l => l <= price).slice(-3);
      levels.pivot_resistance = above;
      levels.pivot_support = below;
    }
  }

  // Derive session high/low from bigbeluga pivots or labels
  const allPivots = [...levels.pivot_resistance, ...levels.pivot_support].sort((a, b) => a - b);
  if (allPivots.length > 0) {
    levels.session_high = allPivots[allPivots.length - 1] ?? null;
    levels.session_low = allPivots[0] ?? null;
  }

  return levels;
}

// ─── HTF Cache ──────────────────────────────────────────────────────────────

interface HtfCacheEntry {
  bars: OhlcvBar[];
  indicators: IndicatorSnapshot;
  fetchedAt: number;
}

/** Minimum milliseconds before re-fetching a higher timeframe. */
const HTF_CACHE_TTL: Record<string, number> = {
  '5':  30_000,  // 5m bars: refresh every 30s
  '15': 60_000,  // 15m bars: refresh every 60s
  '60': 120_000, // 1h bars: refresh every 120s
};

// ─── Collection Timing ──────────────────────────────────────────────────────

/** Per-timeframe sub-phase split on the miss path. Populated only under COLLECT_DIAG=1. */
export interface HtfMissDetail {
  /** chart.setTimeframe duration incl. internal waitForChartReady */
  stf_ms: number;
  /** data.getOhlcv duration */
  goh_ms: number;
}

export interface CollectionTiming {
  total_ms: number;
  phase_1m_ms: number;
  phase_5m_ms: number;
  phase_15m_ms: number;
  phase_1h_ms: number;
  phase_restore_ms: number;
  phase_enrich_ms: number;
  htf_cache_hits: string[];
  htf_cache_misses: string[];
  /** Sub-phase miss diagnostics. Only populated when COLLECT_DIAG=1 and at least one HTF missed. */
  miss_detail?: {
    tf_5m?: HtfMissDetail;
    tf_15m?: HtfMissDetail;
    tf_1h?: HtfMissDetail;
  };
}

// ─── Lite Snapshot (in-position context refresh) ────────────────────────────

/**
 * Lightweight snapshot for in-position context refresh.
 * Only fetches 1m data (no HTF switching). ~150-200ms typical.
 */
export interface LiteSnapshot {
  timestamp_unix: number;
  timestamp_iso: string;
  price: number;
  bars_1m: OhlcvBar[];
  indicators_1m: IndicatorSnapshot;
  session: SessionContext;
  /** Carried forward from last full collect(). */
  key_levels: KeyLevels;
  /** Age in ms since last full collect() populated key_levels. */
  key_levels_age_ms: number;
}

// ─── TF Switch Sleep ────────────────────────────────────────────────────────

/** Reduced from 300ms → 150ms. TradingView chart settles in ~100-150ms. */
const TF_SWITCH_SLEEP_MS = 150;

/** Final restore to 1m needs minimal delay. */
const RESTORE_SLEEP_MS = 100;

// ─── Main collector ──────────────────────────────────────────────────────────

export class DataCollector {
  /**
   * Cache the opening range once formed so it survives after the opening bars
   * age out of the 1m bar window (~2 hours after open).
   */
  private static cachedOR: {
    dateKey: string;
    or: { high: number; low: number; midpoint: number };
  } | null = null;

  private readonly barCount1m: number;
  private readonly barCount5m: number;
  private readonly barCount15m: number;
  private readonly barCount1h: number;

  /** HTF cache to avoid redundant TF switches on every cycle. */
  private htfCache = new Map<string, HtfCacheEntry>();

  /**
   * Tracked timeframe — updated after every setTimeframe() call.
   * Used by ensureTimeframe() to skip redundant TF switches.
   * Set to 'unknown' on switch failure to force re-switch next call.
   */
  private lastKnownTimeframe: string = 'unknown';

  /** Last key_levels from a full collect() — carried forward to lite snapshots. */
  private lastFullKeyLevels: KeyLevels | null = null;
  /** Date.now() when lastFullKeyLevels was set. */
  private lastFullKeyLevelsAt = 0;

  /** Last collection timing for observability. */
  private _lastTiming: CollectionTiming | null = null;
  get lastTiming(): CollectionTiming | null { return this._lastTiming; }

  /**
   * Pane index for multi-pane TradingView layouts.
   * When set, all data reads target `cwc.getAll()[paneIndex]` directly
   * (no focus needed). Timeframe switches go through the TvUiLock.
   * When undefined (default), uses the active chart (single-pane mode).
   */
  paneIndex?: number;

  /**
   * Expected contract root (e.g. 'NQ') for post-read symbol validation.
   * Set alongside paneIndex; used to detect stale pane assignments.
   */
  expectedRoot?: ContractRoot;

  /** Callback invoked when pane re-discovery is needed (symbol mismatch). */
  onPaneMismatch?: () => Promise<number | undefined>;

  constructor(opts: {
    bars1m?: number;
    bars5m?: number;
    bars15m?: number;
    bars1h?: number;
    paneIndex?: number;
    expectedRoot?: ContractRoot;
    onPaneMismatch?: () => Promise<number | undefined>;
  } = {}) {
    this.barCount1m = opts.bars1m ?? 60;
    this.barCount5m = opts.bars5m ?? 30;
    this.barCount15m = opts.bars15m ?? 20;
    this.barCount1h = opts.bars1h ?? 12;
    this.paneIndex = opts.paneIndex;
    this.expectedRoot = opts.expectedRoot;
    this.onPaneMismatch = opts.onPaneMismatch;
  }

  async collect(symbol: string): Promise<MarketSnapshot> {
    const t0 = Date.now();
    const tsUnix = t0;
    const tsIso = new Date(tsUnix).toISOString();

    const cacheHits: string[] = [];
    const cacheMisses: string[] = [];
    const diag = process.env.COLLECT_DIAG === '1';
    const missDetail: {
      tf_5m?: HtfMissDetail;
      tf_15m?: HtfMissDetail;
      tf_1h?: HtfMissDetail;
    } = {};

    // ── Step 1: Ensure 1m (always fresh — this is the primary TF) ───────
    const t1 = Date.now();
    const pi = this.paneIndex;
    await chart.setTimeframe({ timeframe: '1', paneIndex: pi });
    this.lastKnownTimeframe = '1';
    await sleep(TF_SWITCH_SLEEP_MS);

    const htfConfig: HtfZonesConfig = (this as any).htfZonesConfig ?? DEFAULT_HTF_ZONES_CONFIG;

    const [quote1m, raw1mBars, raw1mStudies, rawLines, rawLabels, rawHtfLabels] = await Promise.all([
      data.getQuote({ paneIndex: pi }).catch(() => null),
      data.getOhlcv({ count: this.barCount1m, paneIndex: pi }).catch(() => null),
      data.getStudyValues({ paneIndex: pi }).catch(() => null),
      data.getPineLines({ paneIndex: pi }).catch(() => null),
      data.getPineLabels({ study_filter: 'RIPS', paneIndex: pi }).catch(() => null),
      htfConfig.enabled
        ? data.getPineLabels({ study_filter: htfConfig.study_filter, max_labels: htfConfig.max_labels, paneIndex: pi }).catch(() => null)
        : Promise.resolve(null),
    ]);

    // ── Post-read symbol validation (multi-pane self-healing) ──────────
    if (pi != null && this.expectedRoot && quote1m) {
      const quoteSymbol = (quote1m as Record<string, unknown>)?.symbol as string | undefined;
      if (quoteSymbol) {
        const quoteSpec = tryGetContractSpec(quoteSymbol);
        if (quoteSpec && quoteSpec.root !== this.expectedRoot) {
          console.warn(
            `[COLLECT] Symbol mismatch: expected ${this.expectedRoot}, ` +
            `got ${quoteSpec.root} (symbol=${quoteSymbol}). Re-discovering pane...`,
          );
          if (this.onPaneMismatch) {
            const newIdx = await this.onPaneMismatch();
            if (newIdx != null) this.paneIndex = newIdx;
          }
        }
      }
    }

    const bars1m = extractBars(raw1mBars as RawOhlcvResult | null);
    const price = (quote1m as Record<string, unknown> | null)?.last as number
      ?? bars1m[bars1m.length - 1]?.close
      ?? 0;

    // 1m indicators: compute locally first, then overlay TV-only study fields.
    // local_computed: EMA, RSI, ATR, VWAP, ADX, SuperTrend direction, Volume SMA
    // tradingview_study: SmartMoney BOS/CHoCH, NovaWave, TTM Squeeze, CVD, SuperTrend level
    const localIndicators1m = buildLocalIndicatorSnapshot(bars1m);
    const tvVals1m = extractStudyValues(raw1mStudies as RawStudyValues | null);
    const indicators1m = overlayTvStudyFields(localIndicators1m, tvVals1m);
    const keyLevels = extractKeyLevels(
      rawLines as RawPineLines | null,
      rawLabels as RawPineLabels | null,
      price
    );

    // Populate CHoCH/BOS from indicator snapshot (more accurate than line scan)
    if (indicators1m.smart_money_choch_sell !== null) keyLevels.choch_sell = indicators1m.smart_money_choch_sell;
    if (indicators1m.smart_money_choch_buy !== null) keyLevels.choch_buy = indicators1m.smart_money_choch_buy;
    if (indicators1m.smart_money_bos_sell !== null) keyLevels.bos_sell = indicators1m.smart_money_bos_sell;
    if (indicators1m.smart_money_bos_buy !== null) keyLevels.bos_buy = indicators1m.smart_money_bos_buy;

    // HTF zone context (market-neutral — no directional evaluation here)
    const htfContext = htfConfig.enabled
      ? buildHtfContext(rawHtfLabels as RawPineLabels | null, price, indicators1m.atr_14)
      : emptyHtfContext();
    const phase1m = Date.now() - t1;

    // ── Step 2: 5m (cached) ─────────────────────────────────────────────
    const t2 = Date.now();
    let bars5m: OhlcvBar[];
    const cached5m = this.getCachedHtf('5');
    if (cached5m) {
      bars5m = cached5m.bars;
      cacheHits.push('5m');
    } else {
      const tStf5 = diag ? Date.now() : 0;
      await chart.setTimeframe({ timeframe: '5', paneIndex: pi });
      const stfMs5 = diag ? Date.now() - tStf5 : 0;
      this.lastKnownTimeframe = '5';
      await sleep(TF_SWITCH_SLEEP_MS);
      const tGoh5 = diag ? Date.now() : 0;
      const raw5mBars = await data.getOhlcv({ count: this.barCount5m, paneIndex: pi }).catch(() => null);
      const gohMs5 = diag ? Date.now() - tGoh5 : 0;
      bars5m = extractBars(raw5mBars as RawOhlcvResult | null);
      this.htfCache.set('5', {
        bars: bars5m,
        indicators: buildLocalIndicatorSnapshot(bars5m), // local_computed only
        fetchedAt: Date.now(),
      });
      cacheMisses.push('5m');
      if (diag) missDetail.tf_5m = { stf_ms: stfMs5, goh_ms: gohMs5 };
    }
    const phase5m = Date.now() - t2;

    // ── Step 3: 15m (cached) ────────────────────────────────────────────
    const t3 = Date.now();
    let bars15m: OhlcvBar[];
    let indicators15m: IndicatorSnapshot;
    const cached15m = this.getCachedHtf('15');
    if (cached15m) {
      bars15m = cached15m.bars;
      indicators15m = cached15m.indicators;
      cacheHits.push('15m');
    } else {
      const tStf15 = diag ? Date.now() : 0;
      await chart.setTimeframe({ timeframe: '15', paneIndex: pi });
      const stfMs15 = diag ? Date.now() - tStf15 : 0;
      this.lastKnownTimeframe = '15';
      await sleep(TF_SWITCH_SLEEP_MS);
      // 15m: OHLCV only — indicators computed locally (no getStudyValues call)
      // tradingview_study fields are not needed at this timeframe
      const tGoh15 = diag ? Date.now() : 0;
      const raw15mBars = await data.getOhlcv({ count: this.barCount15m, paneIndex: pi }).catch(() => null);
      const gohMs15 = diag ? Date.now() - tGoh15 : 0;
      bars15m = extractBars(raw15mBars as RawOhlcvResult | null);
      indicators15m = buildLocalIndicatorSnapshot(bars15m);
      this.htfCache.set('15', {
        bars: bars15m,
        indicators: indicators15m,
        fetchedAt: Date.now(),
      });
      cacheMisses.push('15m');
      if (diag) missDetail.tf_15m = { stf_ms: stfMs15, goh_ms: gohMs15 };
    }
    const phase15m = Date.now() - t3;

    // ── Step 4: 1h (cached) ─────────────────────────────────────────────
    const t4 = Date.now();
    let bars1h: OhlcvBar[];
    let indicators1h: IndicatorSnapshot;
    const cached1h = this.getCachedHtf('60');
    if (cached1h) {
      bars1h = cached1h.bars;
      indicators1h = cached1h.indicators;
      cacheHits.push('1h');
    } else {
      const tStf60 = diag ? Date.now() : 0;
      await chart.setTimeframe({ timeframe: '60', paneIndex: pi });
      const stfMs60 = diag ? Date.now() - tStf60 : 0;
      this.lastKnownTimeframe = '60';
      await sleep(TF_SWITCH_SLEEP_MS);
      // 1h: OHLCV only — indicators computed locally (no getStudyValues call)
      // tradingview_study fields are not needed at this timeframe
      const tGoh60 = diag ? Date.now() : 0;
      const raw1hBars = await data.getOhlcv({ count: this.barCount1h, paneIndex: pi }).catch(() => null);
      const gohMs60 = diag ? Date.now() - tGoh60 : 0;
      bars1h = extractBars(raw1hBars as RawOhlcvResult | null);
      indicators1h = buildLocalIndicatorSnapshot(bars1h);
      this.htfCache.set('60', {
        bars: bars1h,
        indicators: indicators1h,
        fetchedAt: Date.now(),
      });
      cacheMisses.push('1h');
      if (diag) missDetail.tf_1h = { stf_ms: stfMs60, goh_ms: gohMs60 };
    }
    const phase1h = Date.now() - t4;

    // ── Step 5: Restore 1m ──────────────────────────────────────────────
    const tRestore = Date.now();
    // Only restore if we actually switched away
    if (cacheMisses.length > 0) {
      await chart.setTimeframe({ timeframe: '1', paneIndex: pi });
      this.lastKnownTimeframe = '1';
      await sleep(RESTORE_SLEEP_MS);
    }
    const phaseRestore = Date.now() - tRestore;

    // ── Data quality ─────────────────────────────────────────────────────
    const missing: string[] = [];
    if (!indicators1m.vwap) missing.push('VWAP');
    if (!indicators1m.atr_14) missing.push('ATR_14');
    // RSI demoted from critical: not used in entry scoring, only management extremes
    if (!indicators1m.volume_sma_20) missing.push('Volume_SMA_20');

    const quality: DataQuality = {
      bars_1m_count: bars1m.length,
      bars_5m_count: bars5m.length,
      bars_15m_count: bars15m.length,
      bars_1h_count: bars1h.length,
      vwap_available: indicators1m.vwap !== null,
      atr_available: indicators1m.atr_14 !== null,
      rsi_available: indicators1m.rsi_14 !== null,
      missing_indicators: missing,
    };

    // ── Enrich key_levels with NQ session-derived levels ───────────
    const tEnrich = Date.now();
    const now = new Date();
    const session = classifySession(now);
    const prior = computePriorLevels(bars1m, now);
    keyLevels.overnight_high = prior.overnight_high;
    keyLevels.overnight_low = prior.overnight_low;
    keyLevels.prior_rth_high = prior.prior_rth_high;
    keyLevels.prior_rth_low = prior.prior_rth_low;
    const todayKey = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    let or = buildOpeningRange(bars1m, { now });
    if (or && or.formed) {
      // Cache the formed opening range so it persists after bars age out
      DataCollector.cachedOR = {
        dateKey: todayKey,
        or: { high: or.high, low: or.low, midpoint: or.midpoint },
      };
    } else if (!or && DataCollector.cachedOR?.dateKey === todayKey) {
      // Bars no longer contain the opening period — use cached value
      keyLevels.opening_range_high = DataCollector.cachedOR.or.high;
      keyLevels.opening_range_low = DataCollector.cachedOR.or.low;
      keyLevels.opening_range_mid = DataCollector.cachedOR.or.midpoint;
    }
    if (or) {
      keyLevels.opening_range_high = or.high;
      keyLevels.opening_range_low = or.low;
      keyLevels.opening_range_mid = or.midpoint;
    }
    keyLevels.session_vwap = indicators1m.vwap;
    const phaseEnrich = Date.now() - tEnrich;

    // ── Cache key_levels for lite snapshots ──────────────────────────────
    this.lastFullKeyLevels = { ...keyLevels, pivot_resistance: [...keyLevels.pivot_resistance], pivot_support: [...keyLevels.pivot_support] };
    this.lastFullKeyLevelsAt = Date.now();

    // ── Timing instrumentation ───────────────────────────────────────────
    this._lastTiming = {
      total_ms: Date.now() - t0,
      phase_1m_ms: phase1m,
      phase_5m_ms: phase5m,
      phase_15m_ms: phase15m,
      phase_1h_ms: phase1h,
      phase_restore_ms: phaseRestore,
      phase_enrich_ms: phaseEnrich,
      htf_cache_hits: cacheHits,
      htf_cache_misses: cacheMisses,
      ...(diag && cacheMisses.length > 0 ? { miss_detail: missDetail } : {}),
    };

    return {
      timestamp_unix: tsUnix,
      timestamp_iso: tsIso,
      symbol,
      price,
      bars_1m: bars1m,
      bars_5m: bars5m,
      bars_15m: bars15m,
      bars_1h: bars1h,
      indicators_1m: indicators1m,
      indicators_15m: indicators15m,
      indicators_1h: indicators1h,
      key_levels: keyLevels,
      data_quality: quality,
      session: {
        is_rth: session.is_rth,
        is_eth: session.is_eth,
        is_us_cash_open_window: session.is_us_cash_open_window,
        is_rth_closing_window: session.is_rth_closing_window,
        is_weekend: session.is_weekend,
        minutes_since_rth_open: session.minutes_since_rth_open,
        minutes_to_rth_close: session.minutes_to_rth_close,
      },
      htf_context: htfContext,
    };
  }

  // ─── HTF Cache Helpers ─────────────────────────────────────────────────────

  private getCachedHtf(tf: string): HtfCacheEntry | null {
    const entry = this.htfCache.get(tf);
    if (!entry) return null;
    const ttl = HTF_CACHE_TTL[tf] ?? 30_000;
    if (Date.now() - entry.fetchedAt > ttl) return null;
    return entry;
  }

  /** Force-invalidate HTF cache (e.g., after a significant event). */
  invalidateHtfCache(): void {
    this.htfCache.clear();
  }

  // ─── Timeframe Safety ───────────────────────────────────────────────────────

  /**
   * Ensure the chart is on the given timeframe. Fast no-op if already there.
   * On failure, sets lastKnownTimeframe to 'unknown' to force re-switch next call.
   */
  private async ensureTimeframe(tf: string): Promise<void> {
    if (this.lastKnownTimeframe === tf) return;
    try {
      await chart.setTimeframe({ timeframe: tf, paneIndex: this.paneIndex });
      await sleep(TF_SWITCH_SLEEP_MS);
      this.lastKnownTimeframe = tf;
    } catch {
      this.lastKnownTimeframe = 'unknown';
      throw new Error(`ensureTimeframe('${tf}') failed`);
    }
  }

  // ─── Lightweight In-Position Collector ──────────────────────────────────────

  /**
   * Collect a lightweight 1m-only snapshot for in-position context refresh.
   *
   * Does NOT switch to higher timeframes (5m/15m/1h).
   * Carries forward key_levels from the last full collect() with a TTL.
   * Cost: ~150-200ms typical vs 300-500ms for full collect().
   */
  async collectLite1m(): Promise<LiteSnapshot> {
    const t0 = Date.now();

    // Ensure we're on the 1m timeframe
    await this.ensureTimeframe('1');

    // Parallel fetch: quote + bars + TV study values (1m only)
    const pi = this.paneIndex;
    const [quote1m, raw1mBars, raw1mStudies] = await Promise.all([
      data.getQuote({ paneIndex: pi }).catch(() => null),
      data.getOhlcv({ count: this.barCount1m, paneIndex: pi }).catch(() => null),
      data.getStudyValues({ paneIndex: pi }).catch(() => null),
    ]);

    const bars1m = extractBars(raw1mBars as RawOhlcvResult | null);
    const price = (quote1m as Record<string, unknown> | null)?.last as number
      ?? bars1m[bars1m.length - 1]?.close
      ?? 0;

    // Build local indicators, overlay TV-only fields
    const localIndicators1m = buildLocalIndicatorSnapshot(bars1m);
    const tvVals1m = extractStudyValues(raw1mStudies as RawStudyValues | null);
    const indicators1m = overlayTvStudyFields(localIndicators1m, tvVals1m);

    // Session context
    const now = new Date();
    const session = classifySession(now);

    // Key levels: carry forward from last full collect() with age tracking
    const keyLevels = this.lastFullKeyLevels ?? this.emptyKeyLevels();
    const keyLevelsAgeMs = this.lastFullKeyLevelsAt > 0
      ? Date.now() - this.lastFullKeyLevelsAt
      : Infinity;

    // Update session VWAP from fresh indicators
    keyLevels.session_vwap = indicators1m.vwap;

    return {
      timestamp_unix: t0,
      timestamp_iso: new Date(t0).toISOString(),
      price,
      bars_1m: bars1m,
      indicators_1m: indicators1m,
      session,
      key_levels: keyLevels,
      key_levels_age_ms: keyLevelsAgeMs === Infinity ? -1 : keyLevelsAgeMs,
    };
  }

  /** Empty key levels placeholder when no full collect() has run yet. */
  private emptyKeyLevels(): KeyLevels {
    return {
      session_high: null, session_low: null,
      daily_open: null, weekly_open: null,
      monday_high: null, monday_low: null, monday_mid: null,
      monthly_open: null,
      pivot_resistance: [], pivot_support: [],
      choch_sell: null, choch_buy: null,
      bos_sell: null, bos_buy: null,
      overnight_high: null, overnight_low: null,
      prior_rth_high: null, prior_rth_low: null,
      opening_range_high: null, opening_range_low: null, opening_range_mid: null,
      session_vwap: null,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
