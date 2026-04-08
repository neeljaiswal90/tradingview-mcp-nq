/**
 * Safe numeric formatting helpers for the dashboard UI.
 *
 * All accept `number | null | undefined` and return a display string.
 * When the value is not a finite number, they return a dash placeholder.
 */

const DASH = '\u2014'; // em dash

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Format a price to fixed decimals (default 2). */
export function fmtPrice(v: number | null | undefined, decimals = 2): string {
  return isNum(v) ? v.toFixed(decimals) : DASH;
}

/** Format a USD value with sign: "+$123.45" / "-$45.00". */
export function fmtUsd(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return DASH;
  const sign = v >= 0 ? '+' : '';
  return `${sign}$${v.toFixed(decimals)}`;
}

/** Format a PnL value as "$-123.45" (no leading +, just $). */
export function fmtPnlUsd(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return DASH;
  return `$${v.toFixed(decimals)}`;
}

/** Format a percentage: "52.3%". */
export function fmtPct(v: number | null | undefined, decimals = 1): string {
  return isNum(v) ? `${v.toFixed(decimals)}%` : DASH;
}

/** Format a score or generic number. */
export function fmtNum(v: number | null | undefined, decimals = 1): string {
  return isNum(v) ? v.toFixed(decimals) : DASH;
}

/** Return a PnL CSS class. */
export function pnlClass(v: number | null | undefined): string {
  if (!isNum(v) || v === 0) return 'pnl-zero';
  return v > 0 ? 'pnl-pos' : 'pnl-neg';
}
