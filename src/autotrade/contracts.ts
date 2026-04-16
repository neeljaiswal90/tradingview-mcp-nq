/**
 * Futures Contract Specifications
 *
 * Centralizes all contract-level knowledge for equity-index futures so the
 * rest of the autotrade stack can reason in ticks, points, dollars, and
 * integer contract counts instead of leaking BTC/spot assumptions.
 *
 * Live trading: MNQ (Micro E-mini Nasdaq-100), MES (Micro E-mini S&P 500).
 * Historical / replay only: NQ, ES — retained in the registry so replay,
 * backtest, and log-parsing tools keep working, but gated off live routing
 * via `live_trading_allowed: false`.
 */

export type ContractRoot = 'NQ' | 'MNQ' | 'ES' | 'MES';

export interface ContractSpec {
  /** Futures root (e.g., "NQ"). */
  root: ContractRoot;
  /** Human-friendly display name. */
  display: string;
  /** Symbol to use when calling TradingView (e.g., "CME_MINI:NQ1!"). */
  tv_symbol: string;
  /** Short trading-app symbol (e.g., "NQ1!"). */
  app_symbol: string;
  /** Exchange / venue identifier. */
  venue: string;
  /** Dollar value of a 1.0-point move, per contract. */
  point_value: number;
  /** Minimum price increment in points. */
  tick_size: number;
  /** Dollar value of a single tick move, per contract. = point_value * tick_size. */
  tick_value: number;
  /** Number of decimal places to round prices to (for display/logging). */
  price_decimals: number;
  /** Whether this contract is a "micro" (1/10) product. */
  is_micro: boolean;
  /**
   * Round-trip fees in USD (commission + exchange). Consumed by the
   * Phase 6 expectancy engine via `c_R = (fees + slippage) / stopPts`
   * per plan §3.1/§10-11. Null means "unknown, fail closed" and the
   * expectancy engine emits `rejected_by_missing_cost_config`. Phase 7
   * moves these defaults into env.ts.
   */
  fees_per_round_trip_usd?: number | null;
  /**
   * Conservative slippage estimate in POINTS for each side of the
   * trade (round-trip total = 2 × this). Null means "unknown, fail
   * closed".
   */
  slippage_pts_per_side?: number | null;
  /**
   * Whether the entry gate is allowed to submit orders on this contract
   * in paper/live mode. Historical/replay contracts (NQ, ES) are kept in
   * the registry for log parsing and backtests but set to `false` so
   * risk.ts and the runner refuse to submit live orders against them.
   * Defaults to `false` if omitted — safest possible default.
   */
  live_trading_allowed?: boolean;
}

// ─── Registry ────────────────────────────────────────────────────────────────

const SPECS: Record<string, ContractSpec> = {
  NQ: {
    root: 'NQ',
    display: 'E-mini Nasdaq-100',
    tv_symbol: 'CME_MINI:NQ1!',
    app_symbol: 'NQ1!',
    venue: 'CME_MINI',
    point_value: 20,
    tick_size: 0.25,
    tick_value: 5.0, // 20 * 0.25
    price_decimals: 2,
    is_micro: false,
    // Phase 6 cost defaults (plan §3.1). Phase 7 moves these to env.ts.
    // NQ: ~$4.50 round-trip broker commission; 0.5 pts slippage per side
    // is a conservative estimate matching the fill-model slippage already
    // applied elsewhere in the runner.
    fees_per_round_trip_usd: 4.5,
    slippage_pts_per_side: 0.5,
    // Historical / replay only — live routing disabled after NQ→MNQ migration.
    live_trading_allowed: false,
  },
  MNQ: {
    root: 'MNQ',
    display: 'Micro E-mini Nasdaq-100',
    tv_symbol: 'CME_MINI:MNQ1!',
    app_symbol: 'MNQ1!',
    venue: 'CME_MINI',
    point_value: 2,
    tick_size: 0.25,
    tick_value: 0.5, // 2 * 0.25
    price_decimals: 2,
    is_micro: true,
    fees_per_round_trip_usd: 1.5,
    // Raised from 0.5 → 0.75 as the Phase 1 sizing-engine slippage buffer
    // for micros. Top-of-book on MNQ can be thinner than on NQ so a slightly
    // wider buffer is appropriate when computing realistic per-contract risk.
    slippage_pts_per_side: 0.75,
    live_trading_allowed: true,
  },
  ES: {
    root: 'ES',
    display: 'E-mini S&P 500',
    tv_symbol: 'CME_MINI:ES1!',
    app_symbol: 'ES1!',
    venue: 'CME_MINI',
    point_value: 50,
    tick_size: 0.25,
    tick_value: 12.5,
    price_decimals: 2,
    is_micro: false,
    fees_per_round_trip_usd: 4.5,
    slippage_pts_per_side: 0.5,
    // Historical / replay only — live routing disabled after ES→MES migration.
    live_trading_allowed: false,
  },
  MES: {
    root: 'MES',
    display: 'Micro E-mini S&P 500',
    tv_symbol: 'CME_MINI:MES1!',
    app_symbol: 'MES1!',
    venue: 'CME_MINI',
    point_value: 5,
    tick_size: 0.25,
    tick_value: 1.25,
    price_decimals: 2,
    is_micro: true,
    fees_per_round_trip_usd: 1.5,
    slippage_pts_per_side: 0.75,
    live_trading_allowed: true,
  },
};

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Map an input symbol/root to a contract spec.
 * Accepts many forms: "NQ", "NQ1!", "CME_MINI:NQ1!", "MNQ", "MNQ1!", etc.
 * Throws if the symbol cannot be mapped. Callers should validate once at boot.
 */
export function getContractSpec(symbol: string): ContractSpec {
  const normalized = symbol.toUpperCase().trim();

  // Strip venue prefix
  const noVenue = normalized.includes(':') ? normalized.split(':').pop()! : normalized;
  // Strip continuous-contract suffix (1!, 2!, etc.)
  const root = noVenue.replace(/[0-9]+!?$/, '').replace(/!$/, '');

  const spec = SPECS[root];
  if (!spec) {
    throw new Error(
      `Unknown futures symbol: "${symbol}" (normalized root "${root}"). ` +
      `Supported: ${Object.keys(SPECS).join(', ')}.`,
    );
  }
  return spec;
}

/** Safer lookup that returns null instead of throwing. */
export function tryGetContractSpec(symbol: string): ContractSpec | null {
  try {
    return getContractSpec(symbol);
  } catch {
    return null;
  }
}

/**
 * List supported contract roots.
 *
 * @param opts.liveOnly - When true, return only roots where
 *                       `live_trading_allowed === true`. Used by the entry
 *                       gate and runner startup. Default false (used by
 *                       replay/backtest tools that legitimately need NQ/ES).
 */
export function listSupportedRoots(opts: { liveOnly?: boolean } = {}): ContractRoot[] {
  const all = Object.keys(SPECS) as ContractRoot[];
  if (!opts.liveOnly) return all;
  return all.filter(r => SPECS[r]?.live_trading_allowed === true);
}

/**
 * Throws if the given contract is not allowed for live/paper trading.
 * Called from the runner startup path and the entry gate.
 */
export function assertLiveTradingAllowed(contract: ContractSpec): void {
  if (contract.live_trading_allowed !== true) {
    throw new Error(
      `Contract ${contract.root} (${contract.app_symbol}) is not allowed ` +
      `for live or paper trading (live_trading_allowed=${contract.live_trading_allowed}). ` +
      `This contract is retained for replay/backtest only. ` +
      `Set SYMBOL to a live-enabled contract (e.g., MNQ1!, MES1!).`,
    );
  }
}

// ─── Tick / Point Math ───────────────────────────────────────────────────────

/** Round a price to the nearest valid tick for this contract. */
export function roundToTick(price: number, contract: ContractSpec): number {
  const ticks = Math.round(price / contract.tick_size);
  const rounded = ticks * contract.tick_size;
  // Clean up floating-point residue
  const factor = Math.pow(10, contract.price_decimals);
  return Math.round(rounded * factor) / factor;
}

/**
 * Round a stop/target away from entry so the effective distance is not
 * understated. For longs: round stop DOWN, target UP. For shorts: inverse.
 */
export function roundToTickAwayFromEntry(
  price: number,
  entry: number,
  kind: 'stop' | 'target',
  direction: 'long' | 'short',
  contract: ContractSpec,
): number {
  // Work out whether "away from entry" means round UP or DOWN
  const isShort = direction === 'short';
  let roundDown: boolean;
  if (kind === 'stop') {
    // Stop is on the unfavorable side of entry.
    // Long → stop below entry → round DOWN (further below).
    // Short → stop above entry → round UP (further above).
    roundDown = !isShort;
  } else {
    // Target is on the favorable side of entry.
    // Long → target above entry → round UP (further above).
    // Short → target below entry → round DOWN (further below).
    roundDown = isShort;
  }

  const raw = price / contract.tick_size;
  const ticks = roundDown ? Math.floor(raw) : Math.ceil(raw);
  const rounded = ticks * contract.tick_size;
  // Ensure we never crossed entry by the rounding step
  if (!crossedEntry(entry, price, rounded, direction, kind)) {
    return cleanDecimals(rounded, contract.price_decimals);
  }
  // Fallback: snap to the other side and accept the approximation
  return cleanDecimals(Math.round(raw) * contract.tick_size, contract.price_decimals);
}

function crossedEntry(
  entry: number,
  original: number,
  rounded: number,
  direction: 'long' | 'short',
  kind: 'stop' | 'target',
): boolean {
  // A rounded price "crosses entry" if it sits on the wrong side of entry
  // relative to where the original price was. We only flag when the ROUND
  // move changed its sign relative to entry.
  const origSide = Math.sign(original - entry);
  const rndSide = Math.sign(rounded - entry);
  if (origSide === 0 || rndSide === 0) return false;
  if (origSide === rndSide) return false;
  // Signs differ — meaningful only if original was already on correct side
  void direction; void kind;
  return true;
}

function cleanDecimals(price: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(price * factor) / factor;
}

/** Convert a point delta into an integer number of ticks (absolute). */
export function priceToTicks(deltaPts: number, contract: ContractSpec): number {
  return Math.round(Math.abs(deltaPts) / contract.tick_size);
}

/** Convert a tick count into a point delta. */
export function ticksToPrice(ticks: number, contract: ContractSpec): number {
  return ticks * contract.tick_size;
}

/** Dollar risk per contract given a stop distance in points. */
export function riskPerContract(stopDistancePts: number, contract: ContractSpec): number {
  return Math.abs(stopDistancePts) * contract.point_value;
}

/**
 * Normalize a raw stop distance: snap to whole ticks and enforce a minimum
 * of 2 ticks so positions cannot be sized with a degenerate stop.
 */
export function normalizeStopDistance(stopDistancePts: number, contract: ContractSpec): number {
  const ticks = Math.max(2, priceToTicks(stopDistancePts, contract));
  return ticksToPrice(ticks, contract);
}

// ─── Default deployment selection ────────────────────────────────────────────

/**
 * Pick the safest default contract when SYMBOL is not explicitly set.
 * MNQ is chosen for paper-trade evaluation because tick-value is 10x smaller
 * than NQ, keeping dollar-risk small while the strategy is being validated.
 */
export function pickDefaultSymbol(): string {
  return 'MNQ1!';
}
