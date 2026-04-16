// ─── Empirical Winner-Distribution Curves ──────────────────────────────────
//
// Loads and queries the empirical Q20_peak_win(t) / Q80_mae_win(t) curves
// used by Lane B of the Dead-Trade Guard. Curves are built off-line by
// scripts/ml/build_failure_exit_curves.mjs from the archived trade corpus.
//
// Query semantics:
//   - Linear interpolation between adjacent non-low-confidence buckets.
//   - Out of range (tMin < first.t_min or tMin > last.t_min) → null.
//   - Either neighbor marked low_confidence → null (Lane B falls through).
//   - Missing family / missing file → null (Lane B is a no-op).
//
// See: .claude/plans/fluttering-weaving-pinwheel.md
//   ("V1 Rule: Empirical Shape-Based Trigger", "config/failure_exit_curves.json")
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';

export interface FailureExitBucket {
  /** Bucket center in minutes since entry. */
  t_min: number;
  /** Number of eventual-winner observations in this bucket. */
  n: number;
  /** True when n < min_n_per_bucket; queries return null for low-confidence neighbors. */
  low_confidence: boolean;
  /** 20th percentile of peakR among eventual winners at this hold time. */
  q20_peak_win: number;
  /** 80th percentile of maeR  among eventual winners at this hold time. */
  q80_mae_win: number;
  /** 50th percentile of peakR (diagnostic, not used by the runtime rule). */
  q50_peak_win?: number;
  /** 50th percentile of maeR  (diagnostic, not used by the runtime rule). */
  q50_mae_win?: number;
}

export interface FailureExitCurves {
  family: string;
  family_sample_size: number;
  family_low_confidence: boolean;
  min_n_per_bucket: number;
  /** Must be sorted ascending by t_min. */
  buckets: FailureExitBucket[];
  /** Optional regime metadata stored at build time (not used at runtime). */
  regime_metadata?: unknown;
}

export interface FailureExitCurvesFile {
  generated_at: string;
  source_corpus?: string;
  source?: { symbol_filter?: string; [key: string]: unknown };
  curves: Record<string, FailureExitCurves>;
}

/**
 * Load curves from disk and return a Map keyed by family name. Missing file
 * or malformed JSON returns an empty map, which makes Lane B a no-op.
 *
 * When `expectedSymbol` is provided (mandatory in paper/live modes), the
 * loader verifies that the file's `source.symbol_filter` matches. A mismatch
 * returns an empty map — Lane B disabled, preventing cross-symbol data from
 * driving execution.
 */
export function loadCurves(path: string, expectedSymbol?: string): Map<string, FailureExitCurves> {
  const map = new Map<string, FailureExitCurves>();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return map;
  }
  let parsed: FailureExitCurvesFile;
  try {
    parsed = JSON.parse(raw) as FailureExitCurvesFile;
  } catch {
    return map;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.curves) return map;

  // Symbol mismatch check — mandatory in paper/live modes.
  const fileSymbol = parsed.source?.symbol_filter ?? null;
  if (expectedSymbol && fileSymbol && fileSymbol !== expectedSymbol) {
    return map; // Symbol mismatch — Lane B disabled
  }
  for (const [family, curves] of Object.entries(parsed.curves)) {
    if (!curves || !Array.isArray(curves.buckets)) continue;
    // Defensive: ensure buckets are sorted ascending by t_min so the linear
    // search in queryCurve() is correct.
    const sorted = [...curves.buckets].sort((a, b) => a.t_min - b.t_min);
    map.set(family, { ...curves, buckets: sorted });
  }
  return map;
}

/**
 * Linearly interpolate Q20_peak_win / Q80_mae_win at hold time `tMin` between
 * the two adjacent buckets. Returns null when either side is low-confidence
 * or when tMin is out of range — in both cases Lane B falls through.
 *
 * Formula: Q(t) = Q_k + (t − t_k) / (t_{k+1} − t_k) · (Q_{k+1} − Q_k)
 *
 * Bucket-center semantics: exact match at a bucket center returns that
 * bucket's value. Halfway between two centers returns the midpoint.
 */
export function queryCurve(
  curves: FailureExitCurves,
  tMin: number,
): { q20_peak: number; q80_mae: number } | null {
  const { buckets } = curves;
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (first === undefined || last === undefined) return null;
  // Out of range: fail closed (Lane B no-op). No extrapolation.
  if (tMin < first.t_min || tMin > last.t_min) return null;

  // Find k such that buckets[k].t_min <= tMin <= buckets[k+1].t_min.
  for (let k = 0; k < buckets.length - 1; k++) {
    const a = buckets[k];
    const b = buckets[k + 1];
    if (a === undefined || b === undefined) continue;
    if (tMin >= a.t_min && tMin <= b.t_min) {
      // Either neighbor low-confidence → Lane B falls through.
      if (a.low_confidence || b.low_confidence) return null;
      // Exact match at left center: no interpolation needed.
      if (tMin === a.t_min) {
        return { q20_peak: a.q20_peak_win, q80_mae: a.q80_mae_win };
      }
      if (tMin === b.t_min) {
        return { q20_peak: b.q20_peak_win, q80_mae: b.q80_mae_win };
      }
      const span = b.t_min - a.t_min;
      if (span <= 0) {
        // Degenerate — treat as exact match at a.
        return { q20_peak: a.q20_peak_win, q80_mae: a.q80_mae_win };
      }
      const frac = (tMin - a.t_min) / span;
      return {
        q20_peak: a.q20_peak_win + frac * (b.q20_peak_win - a.q20_peak_win),
        q80_mae: a.q80_mae_win + frac * (b.q80_mae_win - a.q80_mae_win),
      };
    }
  }
  // tMin equals the last bucket center exactly (defensive fall-through).
  if (last.low_confidence) return null;
  return { q20_peak: last.q20_peak_win, q80_mae: last.q80_mae_win };
}
