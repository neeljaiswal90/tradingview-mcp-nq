/**
 * features/indicators.ts — Shared local indicator computation.
 *
 * SINGLE SOURCE OF TRUTH for EMA, RSI, ATR, ADX, VWAP, Volume SMA.
 * Used by both live data-collector and historical snapshot-builder.
 * No TradingView dependency — pure math on OHLCV bars.
 */

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k);
  }
  return e;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

export function rsi(values: number[], period: number = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gains += d; else losses -= d;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return losses === 0 ? 100 : 100 - 100 / (1 + rs);
}

// ─── ATR ─────────────────────────────────────────────────────────────────────

export function atr(bars: Bar[], period: number = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!, p = bars[i - 1]!;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

// ─── Volume SMA ──────────────────────────────────────────────────────────────

export function volumeSma(bars: Bar[], period: number = 20): number | null {
  const vols = bars.slice(-period).map(b => b.volume).filter(v => v > 0);
  return vols.length > 0 ? vols.reduce((s, v) => s + v, 0) / vols.length : null;
}

// ─── VWAP (session approximation from bars) ──────────────────────────────────

export function vwap(bars: Bar[]): number | null {
  if (bars.length === 0) return null;
  let cumPV = 0;
  let cumVol = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    cumPV += typical * b.volume;
    cumVol += b.volume;
  }
  return cumVol > 0 ? cumPV / cumVol : null;
}

// ─── SuperTrend Direction (EMA-based proxy) ──────────────────────────────────

export function supertrendDirection(ema9: number | null, ema21: number | null): 'up' | 'down' | null {
  if (ema9 === null || ema21 === null) return null;
  return ema9 > ema21 ? 'up' : ema9 < ema21 ? 'down' : null;
}

// ─── ADX / DI (Wilder's smoothing) ──────────────────────────────────────────

export function adx(bars: Bar[], period: number = 14): {
  adx: number | null;
  di_plus: number | null;
  di_minus: number | null;
} {
  if (bars.length < period + 1) return { adx: null, di_plus: null, di_minus: null };

  const dmPlus: number[] = [];
  const dmMinus: number[] = [];
  const trs: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const curr = bars[i]!, prev = bars[i - 1]!;
    const highDiff = curr.high - prev.high;
    const lowDiff = prev.low - curr.low;

    dmPlus.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    dmMinus.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    trs.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
  }

  if (dmPlus.length < period) return { adx: null, di_plus: null, di_minus: null };

  // Wilder's smoothing
  let smoothDmP = dmPlus.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothDmM = dmMinus.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothTr = trs.slice(0, period).reduce((s, v) => s + v, 0);

  const dxValues: number[] = [];
  for (let i = period; i < dmPlus.length; i++) {
    smoothDmP = smoothDmP - smoothDmP / period + dmPlus[i]!;
    smoothDmM = smoothDmM - smoothDmM / period + dmMinus[i]!;
    smoothTr = smoothTr - smoothTr / period + trs[i]!;

    const diP = smoothTr > 0 ? (smoothDmP / smoothTr) * 100 : 0;
    const diM = smoothTr > 0 ? (smoothDmM / smoothTr) * 100 : 0;
    const dx = (diP + diM) > 0 ? Math.abs(diP - diM) / (diP + diM) * 100 : 0;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return { adx: null, di_plus: null, di_minus: null };

  let adxVal = dxValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adxVal = (adxVal * (period - 1) + dxValues[i]!) / period;
  }

  const finalDiP = smoothTr > 0 ? (smoothDmP / smoothTr) * 100 : 0;
  const finalDiM = smoothTr > 0 ? (smoothDmM / smoothTr) * 100 : 0;

  return {
    adx: Math.round(adxVal * 100) / 100,
    di_plus: Math.round(finalDiP * 100) / 100,
    di_minus: Math.round(finalDiM * 100) / 100,
  };
}

// ─── Full indicator snapshot from bars ───────────────────────────────────────

export function computeIndicators(bars: Bar[]): {
  ema_9: number | null;
  ema_21: number | null;
  ema_50: number | null;
  ema_200: number | null;
  rsi_14: number | null;
  atr_14: number | null;
  vwap: number | null;
  volume_sma_20: number | null;
  supertrend_direction: 'up' | 'down' | null;
  adx: number | null;
  di_plus: number | null;
  di_minus: number | null;
} {
  const closes = bars.map(b => b.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const adxResult = adx(bars, 14);

  return {
    ema_9: ema9 !== null ? Math.round(ema9 * 100) / 100 : null,
    ema_21: ema21 !== null ? Math.round(ema21 * 100) / 100 : null,
    ema_50: ema50 !== null ? Math.round(ema50 * 100) / 100 : null,
    ema_200: ema200 !== null ? Math.round(ema200 * 100) / 100 : null,
    rsi_14: rsi(closes, 14) !== null ? Math.round(rsi(closes, 14)! * 100) / 100 : null,
    atr_14: atr(bars, 14) !== null ? Math.round(atr(bars, 14)! * 100) / 100 : null,
    vwap: vwap(bars) !== null ? Math.round(vwap(bars)! * 100) / 100 : null,
    volume_sma_20: volumeSma(bars, 20) !== null ? Math.round(volumeSma(bars, 20)! * 100) / 100 : null,
    supertrend_direction: supertrendDirection(ema9, ema21),
    adx: adxResult.adx,
    di_plus: adxResult.di_plus,
    di_minus: adxResult.di_minus,
  };
}
