/**
 * Tests for the Phase 4.2 sub-second forward labeler
 * (scripts/lob-mbo-forward-labeler.mjs).
 *
 * Covers, in order:
 *
 *   1. buildMidPriceTrack — construction, sort, dedup, filter
 *   2. firstIndexAfter — binary search correctness (strict >)
 *   3. sliceForwardWindow — window semantics `(T, T+H]`
 *   4. extractEntryMid — camelCase ScalperStateVector extraction
 *   5. computeScalperLabels — single candidate, all edge cases
 *   6. Direction-aware MFE / MAE — long vs short mirror invariant
 *   7. labelCandidates — batch + stats
 *   8. buildOutputMetaRow — carries forward rejection_sample_rate
 *   9. META-ROW GUARDRAIL (user-requested explicit section) — the
 *      labeler must skip {meta: true, ...} rows in BOTH the candidate
 *      stream and the tick stream BEFORE any schema validation or
 *      horizon logic touches them. Tests lock this path directly.
 *  10. Large-track binary search correctness against a linear baseline
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs script imported from TS test context (vitest transforms it)
import {
  FORWARD_RETURN_HORIZONS_SEC,
  TRAILING_COVERAGE_TOLERANCE_MS,
  LABEL_SOURCE,
  buildMidPriceTrack,
  firstIndexAfter,
  sliceForwardWindow,
  extractEntryMid,
  computeScalperLabels,
  labelCandidates,
  buildOutputMetaRow,
} from '../../scripts/lob-mbo-forward-labeler.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Minimal ScalperStateVector-shaped object with finite bidPx[0]/askPx[0].
 * Entry mid = (17000.00 + 17000.25) / 2 = 17000.125
 */
const STD_STATE_VECTOR = {
  bidPx: [17000.00, 16999.75],
  askPx: [17000.25, 17000.50],
  bidSz: [120, 80],
  askSz: [40, 30],
  qi5: 0.30,
  spreadTicks: 1.0,
};

/** The entry mid implied by STD_STATE_VECTOR. */
const ENTRY_MID = 17000.125;

/**
 * Build a candidate row shaped like the Phase 4.1 writer emits. Fields
 * not referenced by the labeler are omitted for brevity.
 */
function makeCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts_ms: 1_000_000,
    setup_type: 'lob_mbo_scalp_long',
    setup_family: 'lob_mbo_scalp',
    direction: 'long',
    scalper_state_vector: STD_STATE_VECTOR,
    reject_stage: 'persistence',
    reject_reason: 'persistence:no_prior_pass',
    sample_weight: 1,
    ...overrides,
  };
}

/**
 * Build a tick-stream row shaped like the Phase 1 sidecar emits to
 * logs/lob_top_of_book.jsonl. mid is computed on the fly by the labeler
 * from bid/ask, so the test fixtures specify bid/ask directly and let
 * the labeler do the math.
 */
function tick(ts_ms: number, bid: number, ask: number): Record<string, unknown> {
  return { ts_ms, bid, ask, bid_sz: 10, ask_sz: 10 };
}

/**
 * Build a dense track spanning `[startMs, endMs]` with mid centered on
 * `ENTRY_MID` drifting by `slope` points per 100 ms. Used for the
 * coverage + MFE / MAE tests.
 */
function makeTrack(
  startMs: number,
  endMs: number,
  stepMs: number,
  slopeMidPerStep: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let ts = startMs;
  let mid = ENTRY_MID;
  while (ts <= endMs) {
    // Ticks encode as bid/ask with tight spread around mid.
    const bid = mid - 0.125;
    const ask = mid + 0.125;
    out.push(tick(ts, bid, ask));
    ts += stepMs;
    mid += slopeMidPerStep;
  }
  return out;
}

// ─── 1. buildMidPriceTrack ─────────────────────────────────────────────────

describe('lob-mbo-forward-labeler: buildMidPriceTrack', () => {
  it('returns empty array for nullish / empty input', () => {
    expect(buildMidPriceTrack(null)).toEqual([]);
    expect(buildMidPriceTrack(undefined)).toEqual([]);
    expect(buildMidPriceTrack([])).toEqual([]);
  });

  it('computes mid = (bid + ask) / 2', () => {
    const track = buildMidPriceTrack([tick(100, 100.0, 100.5)]);
    expect(track).toEqual([{ ts_ms: 100, mid: 100.25 }]);
  });

  it('sorts unsorted input ascending by ts_ms', () => {
    const rows = [tick(300, 10, 10.5), tick(100, 12, 12.5), tick(200, 11, 11.5)];
    const track = buildMidPriceTrack(rows);
    expect(track.map((t) => t.ts_ms)).toEqual([100, 200, 300]);
  });

  it('filters rows with non-finite bid / ask / ts_ms', () => {
    const rows = [
      tick(100, 10, 10.5),
      { ts_ms: 200, bid: 'bad', ask: 10.5 },
      { ts_ms: 300, bid: 10, ask: NaN },
      { ts_ms: null, bid: 10, ask: 10.5 },
      tick(400, 11, 11.5),
    ];
    const track = buildMidPriceTrack(rows);
    expect(track.map((t) => t.ts_ms)).toEqual([100, 400]);
  });

  it('dedupes consecutive same-ts entries (keeps last)', () => {
    const rows = [
      tick(100, 10.0, 10.5),  // mid 10.25
      tick(100, 11.0, 11.5),  // mid 11.25 — newer, should win
      tick(200, 12.0, 12.5),
    ];
    const track = buildMidPriceTrack(rows);
    expect(track).toEqual([
      { ts_ms: 100, mid: 11.25 },
      { ts_ms: 200, mid: 12.25 },
    ]);
  });
});

// ─── 2. firstIndexAfter ────────────────────────────────────────────────────

describe('lob-mbo-forward-labeler: firstIndexAfter', () => {
  const track = [
    { ts_ms: 100, mid: 1 },
    { ts_ms: 200, mid: 2 },
    { ts_ms: 300, mid: 3 },
    { ts_ms: 400, mid: 4 },
  ];

  it('returns 0 for empty track', () => {
    expect(firstIndexAfter([], 100)).toBe(0);
  });

  it('returns 0 when target is before every element', () => {
    expect(firstIndexAfter(track, 50)).toBe(0);
  });

  it('returns track.length when target is at or after every element', () => {
    expect(firstIndexAfter(track, 400)).toBe(4);
    expect(firstIndexAfter(track, 500)).toBe(4);
  });

  it('returns first index with ts strictly greater than target', () => {
    expect(firstIndexAfter(track, 100)).toBe(1);  // 200 is first > 100
    expect(firstIndexAfter(track, 150)).toBe(1);
    expect(firstIndexAfter(track, 200)).toBe(2);  // strict >: 300 is first > 200
    expect(firstIndexAfter(track, 250)).toBe(2);
  });
});

// ─── 3. sliceForwardWindow ─────────────────────────────────────────────────

describe('lob-mbo-forward-labeler: sliceForwardWindow', () => {
  const track = [
    { ts_ms: 100, mid: 1 },
    { ts_ms: 200, mid: 2 },
    { ts_ms: 300, mid: 3 },
    { ts_ms: 400, mid: 4 },
    { ts_ms: 500, mid: 5 },
  ];

  it('returns empty samples when startIdx is past track.length', () => {
    const { samples } = sliceForwardWindow(track, 0, 10000, 999);
    expect(samples).toEqual([]);
  });

  it('includes samples where ts_ms <= T + horizon_ms (inclusive upper)', () => {
    // T=100, horizon=200ms → window (100, 300] → samples 200, 300
    const { samples } = sliceForwardWindow(track, 100, 200, 1);
    expect(samples.map((s) => s.ts_ms)).toEqual([200, 300]);
  });

  it('excludes samples at exactly T (exclusive lower via startIdx)', () => {
    // Caller is expected to pass startIdx = firstIndexAfter(track, 100) = 1
    const startIdx = firstIndexAfter(track, 100);
    const { samples } = sliceForwardWindow(track, 100, 400, startIdx);
    expect(samples.map((s) => s.ts_ms)).toEqual([200, 300, 400, 500]);
  });

  it('returns nextIdx just past the window end', () => {
    const { nextIdx } = sliceForwardWindow(track, 100, 200, 1);
    expect(nextIdx).toBe(3);  // 400 is first outside the (100, 300] window
  });
});

// ─── 4. extractEntryMid ────────────────────────────────────────────────────

describe('lob-mbo-forward-labeler: extractEntryMid', () => {
  it('computes mid from bidPx[0] and askPx[0]', () => {
    expect(extractEntryMid(makeCandidate())).toBe(ENTRY_MID);
  });

  it('returns null for null / non-object candidate', () => {
    expect(extractEntryMid(null)).toBeNull();
    expect(extractEntryMid(undefined)).toBeNull();
    expect(extractEntryMid('string')).toBeNull();
    expect(extractEntryMid(42)).toBeNull();
  });

  it('returns null when scalper_state_vector is missing', () => {
    const c = makeCandidate({ scalper_state_vector: undefined });
    expect(extractEntryMid(c)).toBeNull();
  });

  it('returns null when bidPx is empty or non-array', () => {
    expect(extractEntryMid(makeCandidate({ scalper_state_vector: { bidPx: [], askPx: [10] } }))).toBeNull();
    expect(extractEntryMid(makeCandidate({ scalper_state_vector: { bidPx: null, askPx: [10] } }))).toBeNull();
  });

  it('returns null when bidPx[0] or askPx[0] is non-finite', () => {
    expect(extractEntryMid(makeCandidate({
      scalper_state_vector: { bidPx: [NaN], askPx: [10] },
    }))).toBeNull();
    expect(extractEntryMid(makeCandidate({
      scalper_state_vector: { bidPx: [10], askPx: ['bad'] },
    }))).toBeNull();
  });
});

// ─── 5. computeScalperLabels — basic cases ─────────────────────────────────

describe('lob-mbo-forward-labeler: computeScalperLabels core cases', () => {
  it('all nulls when track is empty', () => {
    const labels = computeScalperLabels(makeCandidate(), []);
    expect(labels.fwd_return_1s_pts).toBeNull();
    expect(labels.fwd_return_3s_pts).toBeNull();
    expect(labels.fwd_return_5s_pts).toBeNull();
    expect(labels.mfe_1s_pts).toBeNull();
    expect(labels.mae_1s_pts).toBeNull();
    expect(labels.horizon_coverage_ms).toBe(0);
    expect(labels.label_source).toBe(LABEL_SOURCE);
  });

  it('all nulls when entry mid cannot be extracted', () => {
    const c = makeCandidate({ scalper_state_vector: { bidPx: [], askPx: [] } });
    const labels = computeScalperLabels(c, buildMidPriceTrack(makeTrack(1_000_050, 1_006_000, 50, 0)));
    expect(labels.fwd_return_1s_pts).toBeNull();
    expect(labels.horizon_coverage_ms).toBe(0);
  });

  it('all nulls when direction is invalid', () => {
    const c = makeCandidate({ direction: 'sideways' });
    const labels = computeScalperLabels(c, buildMidPriceTrack(makeTrack(1_000_050, 1_006_000, 50, 0)));
    expect(labels.fwd_return_1s_pts).toBeNull();
  });

  it('all nulls when ts_ms is non-finite', () => {
    const c = makeCandidate({ ts_ms: 'not a number' });
    const labels = computeScalperLabels(c, buildMidPriceTrack(makeTrack(1_000_050, 1_006_000, 50, 0)));
    expect(labels.fwd_return_1s_pts).toBeNull();
  });

  it('flat price track: fwd_return=0, mfe=0, mae=0 at every horizon', () => {
    const raw = makeTrack(1_000_050, 1_006_000, 50, 0);
    const track = buildMidPriceTrack(raw);
    const labels = computeScalperLabels(makeCandidate(), track);
    expect(labels.fwd_return_1s_pts).toBe(0);
    expect(labels.fwd_return_3s_pts).toBe(0);
    expect(labels.fwd_return_5s_pts).toBe(0);
    expect(labels.mfe_1s_pts).toBe(0);
    expect(labels.mae_1s_pts).toBe(0);
  });

  it('track ending at T+2500 ms: 1s covered, 3s and 5s null', () => {
    // Track: dense ticks from T+50 to T+2500 → 1s horizon fully covered,
    // 3s and 5s uncovered (>250ms trailing gap).
    const raw = makeTrack(1_000_050, 1_002_500, 50, 0.01);
    const track = buildMidPriceTrack(raw);
    const labels = computeScalperLabels(makeCandidate(), track);
    expect(labels.fwd_return_1s_pts).not.toBeNull();
    expect(labels.fwd_return_3s_pts).toBeNull();
    expect(labels.fwd_return_5s_pts).toBeNull();
    expect(labels.horizon_coverage_ms).toBe(2500);
  });

  it('trailing tolerance 250ms edge: last sample at T+800, horizon=1000 covered', () => {
    // Last sample 200ms before horizon target (inside 250ms tolerance)
    const raw = makeTrack(1_000_050, 1_000_800, 50, 0);
    const track = buildMidPriceTrack(raw);
    const labels = computeScalperLabels(makeCandidate(), track);
    expect(labels.fwd_return_1s_pts).toBe(0);  // covered
  });

  it('trailing tolerance 250ms edge: last sample at T+700, horizon=1000 uncovered', () => {
    // Last sample 300ms before horizon target (outside 250ms tolerance)
    const raw = makeTrack(1_000_050, 1_000_700, 50, 0);
    const track = buildMidPriceTrack(raw);
    const labels = computeScalperLabels(makeCandidate(), track);
    expect(labels.fwd_return_1s_pts).toBeNull();
  });

  it('fwd_return is RAW price delta, not direction-signed', () => {
    // Track: flat at ENTRY_MID+5 for T+50..T+1050 → fwd_return=+5 for both directions
    const upTrack = buildMidPriceTrack([
      tick(1_000_050, ENTRY_MID + 5 - 0.125, ENTRY_MID + 5 + 0.125),
      tick(1_000_500, ENTRY_MID + 5 - 0.125, ENTRY_MID + 5 + 0.125),
      tick(1_001_000, ENTRY_MID + 5 - 0.125, ENTRY_MID + 5 + 0.125),
    ]);
    const longLabels = computeScalperLabels(makeCandidate({ direction: 'long' }), upTrack);
    const shortLabels = computeScalperLabels(makeCandidate({ direction: 'short' }), upTrack);
    expect(longLabels.fwd_return_1s_pts).toBe(5);
    expect(shortLabels.fwd_return_1s_pts).toBe(5);  // same raw delta, not sign-flipped
  });

  it('horizon_coverage_ms reflects the last observed sample across the largest horizon', () => {
    // Track goes to T+4200ms exactly (within 5s window)
    const raw = makeTrack(1_000_050, 1_004_200, 50, 0);
    const track = buildMidPriceTrack(raw);
    const labels = computeScalperLabels(makeCandidate(), track);
    expect(labels.horizon_coverage_ms).toBe(4200);
  });
});

// ─── 6. Direction-aware MFE / MAE ──────────────────────────────────────────

describe('lob-mbo-forward-labeler: direction-signed MFE / MAE', () => {
  // Note: MFE and MAE are computed as raw magnitudes of the max/min
  // excursion, NOT clipped to >=0. When the price never crosses below
  // entry (long case) the MAE can be negative because `entry - min_mid`
  // is negative. This is intentional: the trainer / bucket builder can
  // interpret negative MAE as "no adverse excursion at all".

  it('monotonic up move: long MFE=max-entry, MAE=entry-min (negative allowed)', () => {
    const track = buildMidPriceTrack([
      tick(1_000_050, ENTRY_MID + 0.125, ENTRY_MID + 0.375),   // mid = entry + 0.25
      tick(1_001_000, ENTRY_MID + 3.875, ENTRY_MID + 4.125),   // mid = entry + 4.0
    ]);
    const longLabels = computeScalperLabels(makeCandidate({ direction: 'long' }), track);
    expect(longLabels.mfe_1s_pts).toBe(4);
    expect(longLabels.mae_1s_pts).toBe(-0.25);  // entry - (entry+0.25) = -0.25

    const shortLabels = computeScalperLabels(makeCandidate({ direction: 'short' }), track);
    // Short: MFE = entry - min = -0.25, MAE = max - entry = 4
    expect(shortLabels.mfe_1s_pts).toBe(-0.25);
    expect(shortLabels.mae_1s_pts).toBe(4);
  });

  it('monotonic down move: short MFE=max-of-favorable-excursion, long MAE=max-down', () => {
    const track = buildMidPriceTrack([
      tick(1_000_050, ENTRY_MID - 0.125, ENTRY_MID + 0.125),   // mid = entry
      tick(1_001_000, ENTRY_MID - 3.125, ENTRY_MID - 2.875),   // mid = entry - 3.0
    ]);
    const longLabels = computeScalperLabels(makeCandidate({ direction: 'long' }), track);
    // Long: MFE = max - entry = 0, MAE = entry - min = 3
    expect(longLabels.mfe_1s_pts).toBe(0);
    expect(longLabels.mae_1s_pts).toBe(3);

    const shortLabels = computeScalperLabels(makeCandidate({ direction: 'short' }), track);
    // Short: MFE = entry - min = 3, MAE = max - entry = 0
    expect(shortLabels.mfe_1s_pts).toBe(3);
    expect(shortLabels.mae_1s_pts).toBe(0);
  });

  it('long and short are mirror images on the same track (MFE_long == MAE_short, MAE_long == MFE_short)', () => {
    const raw = makeTrack(1_000_050, 1_005_000, 100, 0.05);  // drifting up
    const track = buildMidPriceTrack(raw);
    const longLabels = computeScalperLabels(makeCandidate({ direction: 'long' }), track);
    const shortLabels = computeScalperLabels(makeCandidate({ direction: 'short' }), track);
    expect(longLabels.mfe_1s_pts).toBe(shortLabels.mae_1s_pts);
    expect(longLabels.mae_1s_pts).toBe(shortLabels.mfe_1s_pts);
  });
});

// ─── 7. labelCandidates — batch + stats ────────────────────────────────────

describe('lob-mbo-forward-labeler: labelCandidates batch', () => {
  const fullTrack = buildMidPriceTrack(makeTrack(1_000_050, 1_006_000, 50, 0));

  it('returns empty result for empty input', () => {
    const result = labelCandidates({ candidates: [], track: fullTrack });
    expect(result.labeledRows).toEqual([]);
    expect(result.stats.total_candidates).toBe(0);
    expect(result.stats.labeled_rows).toBe(0);
  });

  it('labels every non-meta candidate and spreads labels onto the row', () => {
    const candidates = [
      makeCandidate({ ts_ms: 1_000_000 }),
      makeCandidate({ ts_ms: 1_000_100 }),
      makeCandidate({ ts_ms: 1_000_200 }),
    ];
    const { labeledRows, stats } = labelCandidates({ candidates, track: fullTrack });
    expect(labeledRows.length).toBe(3);
    expect(stats.total_candidates).toBe(3);
    expect(stats.labeled_rows).toBe(3);
    for (const row of labeledRows) {
      // Original candidate fields still present
      expect(row.setup_type).toBe('lob_mbo_scalp_long');
      expect(row.direction).toBe('long');
      // Label fields merged in
      expect('fwd_return_1s_pts' in row).toBe(true);
      expect(row.label_source).toBe(LABEL_SOURCE);
    }
  });

  it('stats track per-horizon coverage counts', () => {
    // Two candidates: one fully covered, one partially
    const shortTrack = buildMidPriceTrack(makeTrack(1_000_050, 1_002_000, 50, 0));  // only 2s coverage
    const candidates = [
      makeCandidate({ ts_ms: 1_000_000 }),
    ];
    const { stats } = labelCandidates({ candidates, track: shortTrack });
    expect(stats.covered_by_horizon['1s']).toBe(1);
    expect(stats.covered_by_horizon['3s']).toBe(0);
    expect(stats.covered_by_horizon['5s']).toBe(0);
  });

  it('skips non-object rows defensively', () => {
    const candidates = [makeCandidate(), null, 'string', 42, makeCandidate({ ts_ms: 1_000_100 })];
    const { labeledRows, stats } = labelCandidates({ candidates, track: fullTrack });
    expect(labeledRows.length).toBe(2);
    expect(stats.skipped_invalid_rows).toBe(3);
  });
});

// ─── 8. buildOutputMetaRow ────────────────────────────────────────────────

describe('lob-mbo-forward-labeler: buildOutputMetaRow', () => {
  it('returns a labeler-only meta row when no candidates meta is supplied', () => {
    const row = buildOutputMetaRow({ writtenAt: '2026-04-14T00:00:00.000Z' });
    expect(row.meta).toBe(true);
    expect(row.schema_version).toBe('1.0');
    expect(row.label_source).toBe(LABEL_SOURCE);
    expect(row.horizons_sec).toEqual(FORWARD_RETURN_HORIZONS_SEC);
    expect(row.trailing_coverage_tolerance_ms).toBe(TRAILING_COVERAGE_TOLERANCE_MS);
    expect(row.labeler_version).toBe('1.0');
    expect(row.written_at).toBe('2026-04-14T00:00:00.000Z');
    expect('rejection_sample_rate' in row).toBe(false);
  });

  it('carries forward rejection_sample_rate from the candidates meta', () => {
    const candidatesMeta = { meta: true, rejection_sample_rate: 50, schema_version: '1.0' };
    const row = buildOutputMetaRow({ candidatesMeta });
    expect(row.rejection_sample_rate).toBe(50);
    expect(row.candidates_schema_version).toBe('1.0');
  });

  it('ignores non-numeric rejection_sample_rate', () => {
    const candidatesMeta = { meta: true, rejection_sample_rate: '50' };
    const row = buildOutputMetaRow({ candidatesMeta });
    expect('rejection_sample_rate' in row).toBe(false);
  });
});

// ─── 9. META-ROW GUARDRAIL (explicit, user-requested) ─────────────────────
//
// The labeler MUST skip {meta: true, ...} rows in BOTH the candidate
// stream and the tick stream BEFORE any schema validation or horizon
// logic. Tests lock this path directly because a mislabeled meta row
// would produce NaN labels, throw on missing fields, or pollute the
// trainer with header garbage.

describe('lob-mbo-forward-labeler: meta-row guardrail', () => {
  it('buildMidPriceTrack skips meta rows in the tick stream', () => {
    const rows = [
      { meta: true, schema_version: '1.0', rejection_sample_rate: 1 },
      tick(100, 10, 10.5),
      { meta: true, some_other_meta: 'xyz' },
      tick(200, 11, 11.5),
    ];
    const track = buildMidPriceTrack(rows);
    expect(track.length).toBe(2);
    expect(track.map((t) => t.ts_ms)).toEqual([100, 200]);
  });

  it('labelCandidates skips meta rows in the candidate stream and counts them', () => {
    const track = buildMidPriceTrack(makeTrack(1_000_050, 1_006_000, 50, 0));
    const candidates = [
      { meta: true, schema_version: '1.0', rejection_sample_rate: 1 },
      makeCandidate({ ts_ms: 1_000_000 }),
      { meta: true, rejection_sample_rate: 50 },
      makeCandidate({ ts_ms: 1_000_100 }),
    ];
    const { labeledRows, stats } = labelCandidates({ candidates, track });
    expect(labeledRows.length).toBe(2);
    expect(stats.skipped_meta_rows).toBe(2);
    expect(stats.labeled_rows).toBe(2);
    // No meta row leaked into the labeled output
    for (const row of labeledRows) {
      expect(row.meta).not.toBe(true);
    }
  });

  it('does not throw when a meta row has no candidate-shaped fields at all', () => {
    const track = buildMidPriceTrack(makeTrack(1_000_050, 1_006_000, 50, 0));
    // This meta row has NO ts_ms, NO scalper_state_vector, NO direction — the
    // labeler MUST skip it before any field access / validation.
    const metaOnly = { meta: true };
    expect(() => {
      labelCandidates({ candidates: [metaOnly], track });
    }).not.toThrow();

    const { labeledRows, stats } = labelCandidates({ candidates: [metaOnly], track });
    expect(labeledRows).toEqual([]);
    expect(stats.skipped_meta_rows).toBe(1);
  });

  it('does not crash if meta row appears mid-stream between real candidates', () => {
    const track = buildMidPriceTrack(makeTrack(1_000_050, 1_006_000, 50, 0));
    const candidates = [
      makeCandidate({ ts_ms: 1_000_000 }),
      { meta: true },
      makeCandidate({ ts_ms: 1_000_100 }),
      { meta: true, rejection_sample_rate: 50 },
      makeCandidate({ ts_ms: 1_000_200 }),
    ];
    const { labeledRows, stats } = labelCandidates({ candidates, track });
    expect(labeledRows.length).toBe(3);
    expect(stats.skipped_meta_rows).toBe(2);
  });

  it('meta rows in the tick stream do not break computeScalperLabels indirectly', () => {
    // Feed a tick stream that starts with a meta row; buildMidPriceTrack
    // should filter it before handing the track to computeScalperLabels.
    const rawTicks = [
      { meta: true, schema_version: '1.0' },
      ...makeTrack(1_000_050, 1_002_000, 50, 0),
    ];
    const track = buildMidPriceTrack(rawTicks);
    const labels = computeScalperLabels(makeCandidate(), track);
    // 1s covered (horizon fully inside the 2s track), 3s / 5s uncovered
    expect(labels.fwd_return_1s_pts).not.toBeNull();
    expect(labels.fwd_return_3s_pts).toBeNull();
    expect(labels.fwd_return_5s_pts).toBeNull();
  });
});

// ─── 10. Large-track binary search correctness ────────────────────────────

describe('lob-mbo-forward-labeler: large track binary search', () => {
  it('firstIndexAfter matches a linear-scan baseline on a 10k-row track', () => {
    const track = [];
    for (let i = 0; i < 10_000; i++) {
      track.push({ ts_ms: i * 10, mid: 1000 + i * 0.01 });
    }
    // Linear baseline for comparison
    const linearFirstAfter = (t: number) => {
      for (let i = 0; i < track.length; i++) {
        if (track[i]!.ts_ms > t) return i;
      }
      return track.length;
    };

    const targets = [-1, 0, 1, 10, 11, 99_999, 99_990, 50_000, 50_001, 100_000];
    for (const t of targets) {
      expect(firstIndexAfter(track, t)).toBe(linearFirstAfter(t));
    }
  });
});
