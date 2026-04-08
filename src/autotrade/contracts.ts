/**
 * Futures Contract Specifications
 *
 * Centralizes all contract-level knowledge for equity-index futures so the
 * rest of the autotrade stack can reason in ticks, points, dollars, and
 * integer contract counts instead of leaking BTC/spot assumptions.
 *
 * Currently supports NQ (E-mini Nasdaq-100) and MNQ (Micro E-mini Nasdaq-100).
 * Extendable to ES / MES / RTY / MRTY / YM / MYM if needed.
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

export function listSupportedRoots(): ContractRoot[] {
  return Object.keys(SPECS) as ContractRoot[];
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
