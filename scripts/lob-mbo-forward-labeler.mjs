/**
 * lob-mbo-forward-labeler.mjs — Phase 4.2 sub-second forward-return labeler.
 *
 * Pure functions only. No filesystem, no process-level side effects, no
 * transitive imports beyond the contamination-firewall helper. The CLI
 * driver in scripts/run-lob-mbo-forward-labeler.mjs handles file I/O
 * and exit codes.
 *
 * Inputs:
 *   - `lob_mbo_scalp_candidates.jsonl` rows (from Phase 4.1 writer)
 *   - `lob_top_of_book.jsonl` rows (from the Python sidecar tick stream)
 *
 * Output:
 *   - One labeled row per input candidate, spread over the candidate's
 *     fields plus per-horizon forward-return / MFE / MAE labels.
 *
 * Semantics (locked by tests):
 *
 *   1. Metadata rows (`{meta: true, ...}`) are skipped at EVERY read
 *      site before any schema validation or horizon logic. This is the
 *      Phase 4.2 guardrail — tests lock this path explicitly.
 *
 *   2. Forward window for horizon H is `(T, T + H*1000]` — strictly
 *      after the candidate ts, inclusive of the horizon target. Ticks
 *      at exactly T are NOT in the window (the candidate IS T; we want
 *      the FUTURE).
 *
 *   3. Per-horizon coverage rule: if the last sample in the window is
 *      more than `TRAILING_COVERAGE_TOLERANCE_MS` (default 250) before
 *      T+H*1000, the horizon is uncovered and every label for that
 *      horizon is null. This prevents mislabeled rows when the tick
 *      track ends early.
 *
 *   4. fwd_return_<H>s_pts is RAW price delta (last_mid - entry_mid),
 *      not direction-signed. The trainer applies the sign via the
 *      binary-classification label construction. One column, one
 *      meaning, no sign ambiguity between the labeler and the trainer.
 *
 *   5. MFE / MAE ARE direction-signed at the labeler stage because they
 *      are bounded magnitudes, not signed scalars — "max favorable"
 *      and "max adverse" are meaningful per-direction concepts:
 *        Long : MFE = max(mid) - entry,   MAE = entry - min(mid)
 *        Short: MFE = entry - min(mid),   MAE = max(mid) - entry
 *      Both are non-negative when the trade had any data.
 *
 *   6. Entry mid is computed from the candidate's own
 *      `scalper_state_vector.bidPx[0] / askPx[0]` — NOT from a join
 *      against the tick stream. This keeps the labeler self-contained
 *      at the entry point and eliminates nearest-neighbor ambiguity
 *      at T.
 *
 *   7. `horizon_coverage_ms` reports the distance from T to the LAST
 *      observed sample within the LARGEST horizon's window, or 0 if
 *      no forward data exists. Callers use it to filter rows for
 *      training at arbitrary coverage thresholds.
 */

import { isLobMboScalpMetaRow } from './_scalper-exclusion.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Forward-return horizons in seconds, per plan Phase 4. */
export const FORWARD_RETURN_HORIZONS_SEC = [1, 3, 5];

/** Maximum allowed gap between the last in-window sample and the horizon
 *  target. A horizon is "covered" only if `T + H*1000 - last_ts <= this`. */
export const TRAILING_COVERAGE_TOLERANCE_MS = 250;

/** Constant label-source tag stamped on every labeled row and in the meta
 *  header. Phase 4.3 dataset builder keys on this for cross-version audits. */
export const LABEL_SOURCE = 'exact_lob_mbo';

/** Schema + labeler version for the output meta row. */
export const LABELER_SCHEMA_VERSION = '1.0';
export const LABELER_VERSION = '1.0';

// ─── Internal helpers ───────────────────────────────────────────────────────

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ─── Price track construction ──────────────────────────────────────────────

/**
 * Build a sorted mid-price track from an iterable of `lob_top_of_book.jsonl`
 * rows.
 *
 * - Skips metadata rows unconditionally (guardrail #1).
 * - Filters rows where ts_ms / bid / ask are not finite numbers.
 * - Computes mid = (bid + ask) / 2.
 * - Sorts ascending by ts_ms.
 * - Deduplicates consecutive same-ts entries (keeps the last value,
 *   matching "latest observation wins" semantics).
 *
 * Returns an array of `{ ts_ms: number, mid: number }` objects in
 * ascending order by ts_ms. Empty input → empty output.
 */
export function buildMidPriceTrack(rows) {
  if (!rows) return [];
  const track = [];
  for (const row of rows) {
    if (isLobMboScalpMetaRow(row)) continue;
    if (!row || typeof row !== 'object') continue;
    // Use `typeof === 'number'` rather than `Number(...)` because Number(null)
    // coerces to 0, which would wrongly accept `{ts_ms: null, ...}`. The wire
    // contract always emits numbers, so strict type-check is correct.
    const ts = row.ts_ms;
    const bid = row.bid;
    const ask = row.ask;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    if (typeof bid !== 'number' || !Number.isFinite(bid)) continue;
    if (typeof ask !== 'number' || !Number.isFinite(ask)) continue;
    track.push({ ts_ms: ts, mid: (bid + ask) / 2 });
  }
  track.sort((a, b) => a.ts_ms - b.ts_ms);
  // Dedupe consecutive same-ts: keep the LAST occurrence of each ts_ms
  const out = [];
  for (let i = 0; i < track.length; i++) {
    if (i + 1 < track.length && track[i + 1].ts_ms === track[i].ts_ms) continue;
    out.push(track[i]);
  }
  return out;
}

// ─── Search + slice ─────────────────────────────────────────────────────────

/**
 * Binary search: return the index of the first track element whose ts_ms
 * is strictly greater than `t_ms`. Returns `track.length` when every
 * element is at or before `t_ms`. O(log n).
 *
 * Note the strict inequality: this matches the `(T, T+H]` forward-window
 * semantic where the candidate's own timestamp is excluded from the
 * forward slice.
 */
export function firstIndexAfter(track, t_ms) {
  if (!Array.isArray(track) || track.length === 0) return 0;
  let lo = 0;
  let hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (track[mid].ts_ms > t_ms) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/**
 * Slice the forward window `(t_ms, t_ms + horizon_ms]` starting from
 * `startIdx`. Caller provides a pre-computed startIdx (from
 * `firstIndexAfter(track, t_ms)`) so repeated horizon slices over the
 * same candidate share the same entry point and avoid duplicate
 * searches. Returns `{ samples, nextIdx }` where nextIdx is the index
 * just past the window end (useful for chaining successive horizons).
 */
export function sliceForwardWindow(track, t_ms, horizon_ms, startIdx = 0) {
  const endTs = t_ms + horizon_ms;
  const samples = [];
  let i = startIdx;
  while (i < track.length && track[i].ts_ms <= endTs) {
    samples.push(track[i]);
    i++;
  }
  return { samples, nextIdx: i };
}

// ─── Entry mid extraction ──────────────────────────────────────────────────

/**
 * Extract the entry mid from a candidate row's `scalper_state_vector`.
 * Returns null when the vector is missing or top-of-book prices are
 * not finite numbers. The caller treats null as "cannot label this
 * row" and emits null labels for every horizon.
 *
 * Reads the camelCase `bidPx` / `askPx` fields — the TypeScript
 * `ScalperStateVector` shape produced by Phase 2
 * `buildScalperStateVector`.
 */
export function extractEntryMid(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const vec = candidate.scalper_state_vector;
  if (!vec || typeof vec !== 'object') return null;
  const bidPx = vec.bidPx;
  const askPx = vec.askPx;
  if (!Array.isArray(bidPx) || bidPx.length === 0) return null;
  if (!Array.isArray(askPx) || askPx.length === 0) return null;
  const bid = Number(bidPx[0]);
  const ask = Number(askPx[0]);
  if (!isFiniteNum(bid) || !isFiniteNum(ask)) return null;
  return (bid + ask) / 2;
}

// ─── Per-candidate label computation ───────────────────────────────────────

/**
 * Build the null-label object for a candidate that cannot be labeled.
 * Every per-horizon field is null, coverage is 0, label_source is
 * still stamped so the dataset builder can still bucket the row.
 */
function buildNullLabels(horizons) {
  const out = {};
  for (const h of horizons) {
    out[`fwd_return_${h}s_pts`] = null;
    out[`mfe_${h}s_pts`] = null;
    out[`mae_${h}s_pts`] = null;
  }
  out.horizon_coverage_ms = 0;
  out.label_source = LABEL_SOURCE;
  return out;
}

/**
 * Compute forward labels for one candidate row against a pre-built
 * mid-price track.
 *
 * Returns an object with every per-horizon field populated (or null),
 * plus `horizon_coverage_ms` and `label_source`. Does NOT mutate the
 * input candidate — the CLI driver spreads this object over the
 * candidate to build the labeled row.
 *
 * Null-label fallback triggers on:
 *   - candidate is not a plain object
 *   - ts_ms is not a finite number
 *   - scalper_state_vector is missing or has non-finite bidPx[0]/askPx[0]
 *   - direction is not 'long' or 'short'
 *   - track is empty (no tick data)
 */
export function computeScalperLabels(
  candidate,
  track,
  horizons = FORWARD_RETURN_HORIZONS_SEC,
) {
  if (!candidate || typeof candidate !== 'object') {
    return buildNullLabels(horizons);
  }
  const ts_ms = Number(candidate.ts_ms);
  const direction = candidate.direction;
  const entryMid = extractEntryMid(candidate);

  if (!isFiniteNum(ts_ms)) return buildNullLabels(horizons);
  if (entryMid === null) return buildNullLabels(horizons);
  if (direction !== 'long' && direction !== 'short') return buildNullLabels(horizons);
  if (!Array.isArray(track) || track.length === 0) return buildNullLabels(horizons);

  const out = {};
  const startIdx = firstIndexAfter(track, ts_ms);

  // Compute horizon_coverage_ms over the LARGEST horizon window.
  // Uses a single slice sized to max(horizons) so we do not need to
  // re-walk the track per horizon. Per-horizon slices below reuse
  // startIdx but slice independently because their bounds differ.
  const maxHorizonMs = Math.max(...horizons) * 1000;
  const { samples: maxSamples } = sliceForwardWindow(track, ts_ms, maxHorizonMs, startIdx);
  if (maxSamples.length === 0) {
    out.horizon_coverage_ms = 0;
  } else {
    out.horizon_coverage_ms = maxSamples[maxSamples.length - 1].ts_ms - ts_ms;
  }

  // Per-horizon labels
  for (const h of horizons) {
    const horizonMs = h * 1000;
    const { samples } = sliceForwardWindow(track, ts_ms, horizonMs, startIdx);

    if (samples.length === 0) {
      out[`fwd_return_${h}s_pts`] = null;
      out[`mfe_${h}s_pts`] = null;
      out[`mae_${h}s_pts`] = null;
      continue;
    }

    const lastSample = samples[samples.length - 1];
    const trailingGapMs = (ts_ms + horizonMs) - lastSample.ts_ms;
    if (trailingGapMs > TRAILING_COVERAGE_TOLERANCE_MS) {
      // Track ended before the horizon target (with tolerance). Do not
      // emit a label that is actually shorter than the column name
      // claims — null instead so the trainer drops the row.
      out[`fwd_return_${h}s_pts`] = null;
      out[`mfe_${h}s_pts`] = null;
      out[`mae_${h}s_pts`] = null;
      continue;
    }

    // Raw price delta (not direction-signed — trainer applies sign).
    const fwdReturn = lastSample.mid - entryMid;

    // Direction-signed MFE / MAE.
    let maxMid = -Infinity;
    let minMid = Infinity;
    for (const s of samples) {
      if (s.mid > maxMid) maxMid = s.mid;
      if (s.mid < minMid) minMid = s.mid;
    }
    let mfe;
    let mae;
    if (direction === 'long') {
      mfe = maxMid - entryMid;
      mae = entryMid - minMid;
    } else {
      mfe = entryMid - minMid;
      mae = maxMid - entryMid;
    }

    out[`fwd_return_${h}s_pts`] = round4(fwdReturn);
    out[`mfe_${h}s_pts`] = round4(mfe);
    out[`mae_${h}s_pts`] = round4(mae);
  }

  out.label_source = LABEL_SOURCE;
  return out;
}

// ─── Batch labeling ────────────────────────────────────────────────────────

/**
 * Label an iterable of candidate rows against a pre-built track.
 *
 * Returns `{ labeledRows, stats }` where:
 *   - labeledRows: array of `{ ...candidate, ...labels }` objects.
 *     Meta rows are NEVER in this array (guardrail #1).
 *   - stats: summary counts for CLI reporting:
 *       total_candidates (data rows processed, excluding meta)
 *       skipped_meta_rows (count of meta rows dropped at ingest)
 *       skipped_invalid_rows (non-object rows; skipped defensively)
 *       labeled_rows (= labeledRows.length)
 *       covered_by_horizon: { "1s": n, "3s": n, "5s": n } — counts of
 *         rows where the per-horizon label is non-null
 *
 * The function does NOT filter by `horizon_coverage_ms`; it emits every
 * labeled row and lets the trainer apply its own coverage threshold.
 */
export function labelCandidates({
  candidates,
  track,
  horizons = FORWARD_RETURN_HORIZONS_SEC,
} = {}) {
  const labeledRows = [];
  const stats = {
    total_candidates: 0,
    skipped_meta_rows: 0,
    skipped_invalid_rows: 0,
    labeled_rows: 0,
    covered_by_horizon: {},
  };
  for (const h of horizons) stats.covered_by_horizon[`${h}s`] = 0;

  if (!candidates) return { labeledRows, stats };

  for (const candidate of candidates) {
    if (isLobMboScalpMetaRow(candidate)) {
      stats.skipped_meta_rows++;
      continue;
    }
    if (!candidate || typeof candidate !== 'object') {
      stats.skipped_invalid_rows++;
      continue;
    }
    stats.total_candidates++;

    const labels = computeScalperLabels(candidate, track, horizons);
    const labeled = { ...candidate, ...labels };
    labeledRows.push(labeled);
    stats.labeled_rows++;

    for (const h of horizons) {
      if (labels[`fwd_return_${h}s_pts`] !== null) {
        stats.covered_by_horizon[`${h}s`]++;
      }
    }
  }

  return { labeledRows, stats };
}

// ─── Output meta row ───────────────────────────────────────────────────────

/**
 * Build the metadata header row for the labeled output file.
 *
 * Carries forward the candidate log's `rejection_sample_rate` (if
 * present in the candidates meta row) so the Phase 4.3 dataset builder
 * and Phase 4.4 trainer can enforce the sample_weight contract from a
 * single meta row in the labeled file. Also stamps the labeler version
 * and horizons so downstream readers can version-gate their logic.
 */
export function buildOutputMetaRow({
  candidatesMeta = null,
  horizons = FORWARD_RETURN_HORIZONS_SEC,
  writtenAt = null,
} = {}) {
  const row = {
    meta: true,
    schema_version: LABELER_SCHEMA_VERSION,
    label_source: LABEL_SOURCE,
    horizons_sec: horizons.slice(),
    trailing_coverage_tolerance_ms: TRAILING_COVERAGE_TOLERANCE_MS,
    labeler_version: LABELER_VERSION,
    written_at: writtenAt || new Date().toISOString(),
  };

  if (candidatesMeta && typeof candidatesMeta === 'object') {
    if (typeof candidatesMeta.rejection_sample_rate === 'number') {
      row.rejection_sample_rate = candidatesMeta.rejection_sample_rate;
    }
    if (typeof candidatesMeta.schema_version === 'string') {
      row.candidates_schema_version = candidatesMeta.schema_version;
    }
  }

  return row;
}
