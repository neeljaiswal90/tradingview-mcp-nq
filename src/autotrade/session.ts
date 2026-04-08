/**
 * NQ / equity-index futures session classification — CANONICAL MODULE.
 *
 * Two-layer model:
 *   Layer 1 — ExchangeSessionState: where is the CME Globex exchange right now?
 *             (RTH, ETH, MAINTENANCE, CLOSED)
 *   Layer 2 — StrategySessionBucket: which strategic trading context are we in?
 *             (ASIA, LONDON, NY_AM, NY_LUNCH, NY_PM, CLOSED, MAINTENANCE, UNKNOWN)
 *
 * All timezone logic uses Intl.DateTimeFormat with IANA tz IDs for DST-safe conversion.
 *
 * NOTE: Does not consult a holiday calendar. Accurate for normal trading days.
 *
 * CME Globex NQ hours (ET):
 *   Sunday 18:00 ET → Friday 17:00 ET
 *   Daily maintenance: 17:00–18:00 ET
 */

// ─── Canonical enums ─────────────────────────────────────────────────────────

/**
 * Layer 1: Exchange session state — describes the physical exchange status.
 */
export type ExchangeSessionState = 'RTH' | 'ETH' | 'MAINTENANCE' | 'CLOSED';

/**
 * Layer 2: Strategy session bucket — which strategic context applies.
 *
 * ASIA        — Tokyo equities session (20:00–02:00 ET, DST-aware via Asia/Tokyo)
 * LONDON      — London equities session (03:00–04:00 ET summer / 02:00–03:00 winter, DST-aware via Europe/London)
 * NY_AM       — NY morning including RTH open (09:30–12:00 ET)
 * NY_LUNCH    — Midday lull (12:00–14:00 ET)
 * NY_PM       — Afternoon session including power hour (14:00–16:00 ET)
 * CLOSED      — Weekend / post-Friday-close / pre-Sunday-open
 * MAINTENANCE — Daily 17:00–18:00 ET pause
 * UNKNOWN     — Cannot classify (safety fallback)
 */
export type StrategySessionBucket =
  | 'ASIA'
  | 'LONDON'
  | 'NY_AM'
  | 'NY_LUNCH'
  | 'NY_PM'
  | 'CLOSED'
  | 'MAINTENANCE'
  | 'UNKNOWN';

// ─── Legacy bucket type (backward compat) ────────────────────────────────────

/**
 * Legacy session bucket strings used by dashboard pipeline.
 * Mapped from StrategySessionBucket for backward compatibility.
 */
export type LegacySessionBucket =
  | 'premarket'
  | 'rth_open'
  | 'midday'
  | 'power_hour'
  | 'postmarket'
  | 'closed'
  | 'unknown';

// ─── SessionContext ──────────────────────────────────────────────────────────

export interface SessionContext {
  /** Session-local ISO timestamp (ET) at the instant of classification. */
  now_et_iso: string;
  /** Weekday 0–6 (0 = Sunday) in ET. */
  dow_et: number;
  /** Minutes since midnight in ET (0–1440). */
  minutes_of_day_et: number;

  // ── Layer 1: Exchange state ──
  /** Physical exchange session state. */
  exchange_state: ExchangeSessionState;

  // ── Layer 2: Strategy bucket ──
  /** Strategic session classification. */
  strategy_bucket: StrategySessionBucket;

  // ── Legacy boolean flags (kept for backward compat) ──
  /** True during US cash session 09:30–16:00 ET Mon–Fri. */
  is_rth: boolean;
  /** True outside RTH but within the active Globex window. */
  is_eth: boolean;
  /** True during the 09:30–09:45 ET opening window. */
  is_us_cash_open_window: boolean;
  /** True during the final 15 minutes of RTH (15:45–16:00 ET). */
  is_rth_closing_window: boolean;
  /** True on the weekend (market closed). */
  is_weekend: boolean;

  /** Minutes since RTH open (09:30 ET). Negative if pre-open. Null on weekends. */
  minutes_since_rth_open: number | null;
  /** Minutes until RTH close (16:00 ET). Negative if after close. Null on weekends. */
  minutes_to_rth_close: number | null;

  // ── Derived timezone context ──
  /** Current hour in Asia/Tokyo (for ASIA bucket derivation). */
  tokyo_hour: number;
  /** Current hour in Europe/London (for LONDON bucket derivation). */
  london_hour: number;

  /** Legacy bucket for dashboard pipeline compatibility. */
  legacy_bucket: LegacySessionBucket;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RTH_OPEN_MIN = 9 * 60 + 30;  // 09:30
const RTH_CLOSE_MIN = 16 * 60;     // 16:00
const CASH_OPEN_WINDOW_END_MIN = 9 * 60 + 45; // 09:45
const RTH_CLOSING_WINDOW_START_MIN = 15 * 60 + 45; // 15:45
const MAINTENANCE_START_MIN = 17 * 60; // 17:00
const MAINTENANCE_END_MIN = 18 * 60;  // 18:00

// Strategy bucket ET boundaries
const NY_AM_START = RTH_OPEN_MIN;     // 09:30
const NY_AM_END = 12 * 60;            // 12:00
const NY_LUNCH_END = 14 * 60;         // 14:00
const NY_PM_END = RTH_CLOSE_MIN;      // 16:00

/**
 * Build a session context for the given Date (defaults to now).
 */
export function classifySession(now: Date = new Date()): SessionContext {
  const etParts = getEtParts(now);
  const minutesOfDay = etParts.hour * 60 + etParts.minute;
  const dow = etParts.dow;
  const isWeekend = dow === 0 || dow === 6;

  // ── Layer 1: Exchange state ──
  const exchangeState = classifyExchangeState(dow, minutesOfDay);

  // ── Legacy boolean flags ──
  const isRth = exchangeState === 'RTH';
  const isEth = exchangeState === 'ETH';
  const isCashOpen = isRth && minutesOfDay >= RTH_OPEN_MIN && minutesOfDay < CASH_OPEN_WINDOW_END_MIN;
  const isClosing = isRth && minutesOfDay >= RTH_CLOSING_WINDOW_START_MIN && minutesOfDay < RTH_CLOSE_MIN;

  const minsSinceOpen = isWeekend ? null : minutesOfDay - RTH_OPEN_MIN;
  const minsToClose = isWeekend ? null : RTH_CLOSE_MIN - minutesOfDay;

  // ── Timezone derivation for international sessions ──
  const tokyoHour = getTzHour(now, 'Asia/Tokyo');
  const londonHour = getTzHour(now, 'Europe/London');

  // ── Layer 2: Strategy bucket ──
  const strategyBucket = classifyStrategyBucket(
    exchangeState, minutesOfDay, dow, tokyoHour, londonHour,
  );

  // ── Legacy bucket mapping ──
  const legacyBucket = mapToLegacyBucket(strategyBucket, exchangeState);

  return {
    now_et_iso: etParts.iso,
    dow_et: dow,
    minutes_of_day_et: minutesOfDay,
    exchange_state: exchangeState,
    strategy_bucket: strategyBucket,
    is_rth: isRth,
    is_eth: isEth,
    is_us_cash_open_window: isCashOpen,
    is_rth_closing_window: isClosing,
    is_weekend: isWeekend,
    minutes_since_rth_open: minsSinceOpen,
    minutes_to_rth_close: minsToClose,
    tokyo_hour: tokyoHour,
    london_hour: londonHour,
    legacy_bucket: legacyBucket,
  };
}

// ─── Layer 1: Exchange state classification ──────────────────────────────────

/**
 * Classify the CME Globex exchange state.
 *
 * Schedule (all times ET):
 *   RTH:         Mon–Fri 09:30–16:00
 *   Maintenance:  Daily 17:00–18:00 (except Sun)
 *   Closed:      Sat all day, Sun before 18:00, Fri after 17:00
 *   ETH:         Everything else within the Globex window
 */
export function classifyExchangeState(dow: number, minutesOfDay: number): ExchangeSessionState {
  // Saturday: fully closed
  if (dow === 6) return 'CLOSED';

  // Sunday: closed until 18:00, then ETH
  if (dow === 0) {
    return minutesOfDay >= MAINTENANCE_END_MIN ? 'ETH' : 'CLOSED';
  }

  // Friday: RTH 09:30-16:00, ETH before 09:30 and 16:00-17:00, closed after 17:00
  if (dow === 5) {
    if (minutesOfDay >= MAINTENANCE_START_MIN) return 'CLOSED';
    if (minutesOfDay >= RTH_OPEN_MIN && minutesOfDay < RTH_CLOSE_MIN) return 'RTH';
    return minutesOfDay < MAINTENANCE_START_MIN ? 'ETH' : 'CLOSED';
  }

  // Mon–Thu
  if (minutesOfDay >= RTH_OPEN_MIN && minutesOfDay < RTH_CLOSE_MIN) return 'RTH';
  if (minutesOfDay >= MAINTENANCE_START_MIN && minutesOfDay < MAINTENANCE_END_MIN) return 'MAINTENANCE';
  return 'ETH';
}

// ─── Layer 2: Strategy bucket classification ─────────────────────────────────

/**
 * Classify the strategic session bucket.
 *
 * During RTH: NY_AM (09:30–12:00), NY_LUNCH (12:00–14:00), NY_PM (14:00–16:00)
 * During ETH: derive from international session context
 *   - ASIA:   Tokyo stock hours mapped to ET (roughly 20:00–02:00 ET)
 *   - LONDON: London stock hours mapped to ET (roughly 03:00–04:00 ET pre-NY overlap)
 *   - Falls through to ASIA/LONDON based on which international market is open
 * Maintenance → MAINTENANCE
 * Closed → CLOSED
 */
export function classifyStrategyBucket(
  exchangeState: ExchangeSessionState,
  minutesOfDay: number,
  dow: number,
  tokyoHour: number,
  londonHour: number,
): StrategySessionBucket {
  if (exchangeState === 'CLOSED') return 'CLOSED';
  if (exchangeState === 'MAINTENANCE') return 'MAINTENANCE';

  // RTH: US equity session sub-buckets
  if (exchangeState === 'RTH') {
    if (minutesOfDay < NY_AM_END) return 'NY_AM';
    if (minutesOfDay < NY_LUNCH_END) return 'NY_LUNCH';
    return 'NY_PM';
  }

  // ETH: classify by international session
  // Tokyo Stock Exchange: 09:00–15:00 JST (mapped via Asia/Tokyo hour)
  const isTokyoOpen = tokyoHour >= 9 && tokyoHour < 15;

  // London Stock Exchange: 08:00–16:30 GMT/BST (mapped via Europe/London hour)
  // We use the pre-NY-overlap window: London open until NY RTH starts
  const isLondonOpen = londonHour >= 8 && londonHour < 16;

  // Priority: if London is open, we're in LONDON session (overlaps with late Tokyo)
  // London open hours in ET: ~03:00-11:00 ET (summer) or ~02:00-10:00 (winter)
  // But we only use LONDON for the pre-RTH portion (ETH)
  if (isLondonOpen) return 'LONDON';
  if (isTokyoOpen) return 'ASIA';

  // ETH but neither Tokyo nor London is open — early ETH or late-afternoon gap
  // This covers the ~16:00-20:00 ET gap (after RTH, before Asia opens)
  // and ~02:00-03:00 ET (after Tokyo close, before London open)
  // Default to the nearest sensible bucket:
  if (minutesOfDay >= RTH_CLOSE_MIN && minutesOfDay < MAINTENANCE_START_MIN) {
    return 'NY_PM'; // Post-RTH ETH wind-down, still US context
  }

  // Fallback for any uncategorized ETH window
  return 'UNKNOWN';
}

// ─── Legacy bucket mapping ───────────────────────────────────────────────────

/**
 * Map StrategySessionBucket → LegacySessionBucket for dashboard compatibility.
 * The dashboard pipeline uses the old bucket names; this provides a bridge.
 */
export function mapToLegacyBucket(
  bucket: StrategySessionBucket,
  exchangeState: ExchangeSessionState,
): LegacySessionBucket {
  switch (bucket) {
    case 'NY_AM':     return 'rth_open';
    case 'NY_LUNCH':  return 'midday';
    case 'NY_PM':     return 'power_hour';
    case 'ASIA':
    case 'LONDON':    return 'premarket';
    case 'CLOSED':    return 'closed';
    case 'MAINTENANCE': return 'closed';
    case 'UNKNOWN':
      // Best-effort: if exchange is ETH, it's premarket; else unknown
      return exchangeState === 'ETH' ? 'premarket' : 'unknown';
  }
}

// ─── Opening Range ───────────────────────────────────────────────────────────

export interface OpeningRange {
  high: number;
  low: number;
  midpoint: number;
  /** Width of the opening range in points (high - low). */
  opening_range_width: number;
  /** Number of 1m bars used to build the range. */
  bars_used: number;
  /** True if the current time is past the end of the opening-range window. */
  formed: boolean;
}

/**
 * Build the RTH opening range from 1m bars. Defaults to a 15-minute range
 * (09:30–09:45 ET). Returns null if insufficient bars fall inside the window.
 */
export function buildOpeningRange(
  bars1m: Array<{ time: number; high: number; low: number }>,
  opts: { windowMinutes?: number; now?: Date } = {},
): OpeningRange | null {
  const windowMin = opts.windowMinutes ?? 15;
  const now = opts.now ?? new Date();

  const nowParts = getEtParts(now);
  const nowDateKey = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;

  const openingBars = bars1m.filter(b => {
    const parts = getEtParts(new Date(b.time * 1000));
    const barDateKey = `${parts.year}-${parts.month}-${parts.day}`;
    if (barDateKey !== nowDateKey) return false;
    const mins = parts.hour * 60 + parts.minute;
    return mins >= RTH_OPEN_MIN && mins < RTH_OPEN_MIN + windowMin;
  });
  if (openingBars.length < Math.max(3, Math.floor(windowMin / 3))) return null;

  const high = Math.max(...openingBars.map(b => b.high));
  const low = Math.min(...openingBars.map(b => b.low));

  const sess = classifySession(now);
  const formed = (sess.minutes_since_rth_open ?? -1) >= windowMin;

  return {
    high,
    low,
    midpoint: (high + low) / 2,
    opening_range_width: high - low,
    bars_used: openingBars.length,
    formed,
  };
}

// ─── Prior-day levels ────────────────────────────────────────────────────────

export interface PriorLevels {
  prior_rth_high: number | null;
  prior_rth_low: number | null;
  overnight_high: number | null;
  overnight_low: number | null;
}

export function computePriorLevels(
  bars1m: Array<{ time: number; high: number; low: number }>,
  now: Date = new Date(),
): PriorLevels {
  if (bars1m.length === 0) {
    return { prior_rth_high: null, prior_rth_low: null, overnight_high: null, overnight_low: null };
  }

  const todayEt = dateKey(now);

  const priorRth = bars1m.filter(b => {
    const parts = getEtParts(new Date(b.time * 1000));
    const mins = parts.hour * 60 + parts.minute;
    const k = `${parts.year}-${parts.month}-${parts.day}`;
    return k !== todayEt && mins >= RTH_OPEN_MIN && mins < RTH_CLOSE_MIN;
  });

  const overnight = bars1m.filter(b => {
    const parts = getEtParts(new Date(b.time * 1000));
    const mins = parts.hour * 60 + parts.minute;
    return mins >= RTH_CLOSE_MIN || mins < RTH_OPEN_MIN;
  });

  return {
    prior_rth_high: priorRth.length ? Math.max(...priorRth.map(b => b.high)) : null,
    prior_rth_low: priorRth.length ? Math.min(...priorRth.map(b => b.low)) : null,
    overnight_high: overnight.length ? Math.max(...overnight.map(b => b.high)) : null,
    overnight_low: overnight.length ? Math.min(...overnight.map(b => b.low)) : null,
  };
}

function dateKey(d: Date): string {
  const p = getEtParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

// ─── ET helpers ──────────────────────────────────────────────────────────────

interface EtParts {
  year: string; month: string; day: string;
  hour: number; minute: number; dow: number;
  iso: string;
}

/** Extract ET date/time parts from a Date, DST-aware via Intl. */
export function getEtParts(d: Date): EtParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const hour = parseInt(get('hour'), 10) % 24;
  const minute = parseInt(get('minute'), 10);
  const weekday = get('weekday');
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[weekday] ?? 0;
  const year = get('year'), month = get('month'), day = get('day');
  const iso = `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${get('second')}-ET`;
  return { year, month, day, hour, minute, dow, iso };
}

// ─── Timezone helpers ────────────────────────────────────────────────────────

/**
 * Get the current hour (0–23) in a given IANA timezone.
 * DST-aware via Intl.DateTimeFormat.
 */
export function getTzHour(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const hourStr = parts.find(p => p.type === 'hour')?.value ?? '0';
  return parseInt(hourStr, 10) % 24;
}

/**
 * Get hour and minute in a given IANA timezone.
 */
export function getTzHourMinute(d: Date, tz: string): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const hourStr = parts.find(p => p.type === 'hour')?.value ?? '0';
  const minStr = parts.find(p => p.type === 'minute')?.value ?? '0';
  return {
    hour: parseInt(hourStr, 10) % 24,
    minute: parseInt(minStr, 10),
  };
}
