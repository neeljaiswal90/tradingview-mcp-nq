/**
 * features/orderflow-state.ts — Phase 2 of the quant trend-pullback refactor.
 *
 * Produces the first-class orderflow fields that populate EntryStateVector:
 *   - snapshot-delta OFI over 10s / 30s rolling windows
 *   - rolling z-scores of those OFIs (z_ofi_10s, z_ofi_30s, z_ofi_blend)
 *   - queue_imbalance_5 (passed through from the sidecar's depth_imbalance_5)
 *   - microprice_offset_pts (direction-signed offset from mid)
 *
 * Snapshot-delta OFI is an explicit approximation. Per the Phase 0
 * locked decision (plan §1), the Python sidecar at
 * `python-market-data-service/app.py` emits /lob/snapshot as periodic
 * snapshots, not a book-event stream. We therefore compute e_k over
 * best-bid/best-ask changes between consecutive snapshots using the
 * Cont-Kukanov-Stoikov formulation. A future sidecar upgrade that
 * publishes raw book events can reuse this module's field names — only
 * the `computeOfiContribution` function below needs to change.
 *
 * Direction-aware sign convention (matches entry-state.ts):
 *   - For LONGS, positive OFI = buy pressure = confirmation.
 *   - For SHORTS, the sign is FLIPPED so sell pressure reads positive.
 *   - Same convention applies to microprice_offset_pts: positive = flow
 *     favoring the setup direction.
 *
 * Rolling state is held in OrderflowRollingBuffer (runtime-state.ts).
 * Callers pass a buffer reference; this module mutates it in place and
 * returns the derived features. `hydrateEntryStateVectorOrderflow()` is
 * the convenience entry point used from strategy.ts.
 */

import { existsSync, readFileSync } from 'fs';
import type { LobSnapshot } from '../lob-client.js';
import type { EntryStateVector, MarketSnapshot, EntryStateLobState } from '../types.js';
import type { OrderflowRollingBuffer } from '../runtime-state.js';
import {
  ORDERFLOW_HISTORY_MAX_SAMPLES,
  getOrderflowBuffer,
} from '../runtime-state.js';

// ── Configuration constants ─────────────────────────────────────────────────
//
// These match the §4.3 `quant_entry.orderflow` defaults in the plan.
// env.ts wiring is a Phase 7 task — for Phase 2 we hardcode them here
// with a clear pointer to where they will move.

/** Short rolling OFI window in milliseconds. */
export const ORDERFLOW_SHORT_WINDOW_MS = 10_000;
/** Long rolling OFI window in milliseconds. */
export const ORDERFLOW_LONG_WINDOW_MS = 30_000;
/** Samples required before OFI z-scores are emitted as non-null. */
export const ORDERFLOW_Z_WARMUP_SAMPLES = 30;

// ── Sparse-LOB reconciliation (Phase 6) ────────────────────────────────────
//
// Phase 2 of the refactor deferred the §4.4 `fresh-but-sparse` row of the
// LOB degradation matrix and classified every non-invalid fresh book as
// `fresh`. Phase 6 introduces the expectancy engine, which uses
// `z_ofi_blend` as one of three bucket dimensions — so sparse books must
// be detectable BEFORE that dimension is allowed to gate expectancy.
//
// Current sidecar snapshot fields that indicate depth health:
//   - total_bid_depth_10lvl
//   - total_ask_depth_10lvl
//   - depth_imbalance_5 / depth_imbalance_10
//
// We don't get a raw per-level ladder from the sidecar, so we
// approximate "fresh-but-sparse" as:
//   total_bid_depth_10lvl + total_ask_depth_10lvl < `min_total_depth`
// OR either side alone below the per-side floor.
//
// When this fires:
//   lob_state = 'sparse'
//   ofi_reliability = 'sparse'
// and the expectancy engine ignores `z_ofi_blend` for that candidate,
// forcing the bucket lookup to start at the 2D backoff level.
//
// The threshold is conservative on purpose for Phase 6; a per-session
// refit lands alongside Phase 7 `env.ts` wiring.

/** Minimum combined L1-L10 depth (bid + ask) for a book to be "full". */
export const ORDERFLOW_MIN_TOTAL_DEPTH_10LVL = 20;
/** Minimum per-side L1-L10 depth for a book to be "full". */
export const ORDERFLOW_MIN_SIDE_DEPTH_10LVL = 5;

/**
 * Derive a stable session_id for the runtime-state buffer key from a
 * snapshot's timestamp_unix. Using the UTC date keeps a single buffer
 * alive across ETH→RTH transitions (they are continuous trading on
 * CME), and rolls the buffer at the once-a-day maintenance window.
 */
export function deriveOrderflowSessionId(snap: MarketSnapshot): string {
  const ms = snap.timestamp_unix * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Feature result type ─────────────────────────────────────────────────────

export interface OrderflowFeatures {
  ofi_10s: number | null;
  ofi_30s: number | null;
  z_ofi_10s: number | null;
  z_ofi_30s: number | null;
  z_ofi_blend: number | null;
  queue_imbalance_5: number | null;
  microprice_offset_pts: number | null;
  /** §4.4 classification for the LOB snapshot at this step. */
  lob_state: EntryStateLobState;
  ofi_reliability: 'full' | 'sparse' | 'unknown';
}

// ── Core snapshot-delta OFI ─────────────────────────────────────────────────

/**
 * Compute a single-step OFI contribution between a prior snapshot state
 * and a current snapshot, using the Cont-Kukanov-Stoikov best-of-book
 * formulation.
 *
 * Positive = buy pressure. Sign conventions:
 *   bid side:
 *     P_b_now > P_b_prev  → +q_b_now   (bid improved = new bid-side liquidity)
 *     P_b_now = P_b_prev  → q_b_now - q_b_prev  (size delta at the same bid)
 *     P_b_now < P_b_prev  → -q_b_prev  (bid pulled down — liquidity gone)
 *   ask side:
 *     P_a_now > P_a_prev  → -q_a_prev  (ask raised — old ask liquidity gone, meaning sellers less aggressive)
 *     P_a_now = P_a_prev  → q_a_prev - q_a_now  (size delta, NOTE the sign)
 *     P_a_now < P_a_prev  → +q_a_now  (ask dropped to a tighter level — new sell liquidity)
 *
 * Wait — that last one would be negative (new sells = sell pressure). Let me be careful:
 *   For the ASK side, the Cont formula is typically written to make the
 *   *sum* (bid contribution + ask contribution) represent net buy pressure.
 *   I_a = q_a_now if P_a_now < P_a_prev ELSE -q_a_prev if P_a_now > P_a_prev ELSE q_a_prev - q_a_now.
 *   We then do OFI = I_b - I_a so that "more ask liquidity = more sell
 *   pressure = subtract".
 *
 * This implementation follows that: OFI = I_bid - I_ask where I_bid and
 * I_ask are both "volume added to that side". Larger I_bid or smaller
 * I_ask ⇒ positive OFI ⇒ buy pressure.
 */
export function computeOfiContribution(
  prev: { bid: number; ask: number; bid_size: number; ask_size: number },
  curr: { bid: number; ask: number; bid_size: number; ask_size: number },
): number {
  // Bid-side additions to buy-side liquidity
  let iBid: number;
  if (curr.bid > prev.bid) {
    iBid = curr.bid_size;
  } else if (curr.bid === prev.bid) {
    iBid = curr.bid_size - prev.bid_size;
  } else {
    iBid = -prev.bid_size;
  }

  // Ask-side additions to sell-side liquidity
  let iAsk: number;
  if (curr.ask < prev.ask) {
    iAsk = curr.ask_size;
  } else if (curr.ask === prev.ask) {
    iAsk = curr.ask_size - prev.ask_size;
  } else {
    iAsk = -prev.ask_size;
  }

  // OFI = buy-side liquidity added - sell-side liquidity added.
  return iBid - iAsk;
}

// ── Rolling stats helpers ───────────────────────────────────────────────────

function meanOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function stdOf(xs: number[], mean: number): number {
  if (xs.length === 0) return 0;
  let acc = 0;
  for (const x of xs) {
    const d = x - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / xs.length);
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ── Microprice ──────────────────────────────────────────────────────────────

/**
 * Microprice = (ask * bid_size + bid * ask_size) / (bid_size + ask_size).
 * Derived directly from top-of-book. Returns null on degenerate inputs.
 */
export function computeMicroprice(
  bid: number,
  ask: number,
  bidSize: number,
  askSize: number,
): number | null {
  if (!(bid > 0) || !(ask > 0) || !(bidSize > 0) || !(askSize > 0)) return null;
  const total = bidSize + askSize;
  return (ask * bidSize + bid * askSize) / total;
}

// ── Main compute entry point ────────────────────────────────────────────────

/**
 * Mutate `buffer` with the new snapshot state and return the derived
 * OrderflowFeatures. If the snapshot is missing, out-of-order, or has
 * invalid BBO, `lob_state` and `ofi_reliability` are set accordingly
 * and OFI fields are null.
 *
 * Direction signs z_ofi and microprice_offset like entry-state.ts:
 * LONG = raw, SHORT = negated, so positive always means "flow favors
 * the setup direction".
 */
export function computeOrderflowFeatures(
  buffer: OrderflowRollingBuffer,
  lob: LobSnapshot | null,
  direction: 'long' | 'short',
): OrderflowFeatures {
  const dirSign = direction === 'long' ? 1 : -1;

  // ── Missing / invalid early-outs ────────────────────────────────────
  if (!lob) {
    return nullOrderflow('missing', 'unknown');
  }

  // data_quality from the sidecar is a coarse flag we pass through.
  if (lob.data_quality === 'unavailable') {
    return nullOrderflow('missing', 'unknown');
  }
  if (lob.data_quality === 'stale') {
    return nullOrderflow('stale', 'unknown');
  }

  const bid = lob.bid;
  const ask = lob.ask;
  const bidSize = lob.bid_size;
  const askSize = lob.ask_size;

  // Validity guard — must have numeric BBO and positive sizes.
  const bidValid = bid !== null && Number.isFinite(bid) && bid > 0;
  const askValid = ask !== null && Number.isFinite(ask) && ask > 0;
  const bidSizeValid = bidSize !== null && Number.isFinite(bidSize) && bidSize > 0;
  const askSizeValid = askSize !== null && Number.isFinite(askSize) && askSize > 0;
  if (!bidValid || !askValid || !bidSizeValid || !askSizeValid) {
    return nullOrderflow('invalid', 'unknown');
  }
  if ((bid as number) >= (ask as number)) {
    return nullOrderflow('invalid', 'unknown');
  }

  // Fresh-but-sparse classification per §4.4 (Phase 6 reconciliation).
  // The book is valid and fresh, but too shallow for z_ofi_blend to be a
  // trustworthy expectancy bucket dimension. OFI features still flow
  // through, but the reliability tag is demoted so the expectancy engine
  // forces a backoff on `z_ofi_blend`.
  const bidDepth10 = lob.total_bid_depth_10lvl;
  const askDepth10 = lob.total_ask_depth_10lvl;
  const bidDepthValid = typeof bidDepth10 === 'number' && bidDepth10 >= 0;
  const askDepthValid = typeof askDepth10 === 'number' && askDepth10 >= 0;
  let isSparse = false;
  if (bidDepthValid && askDepthValid) {
    const total = bidDepth10 + askDepth10;
    if (
      total < ORDERFLOW_MIN_TOTAL_DEPTH_10LVL ||
      bidDepth10 < ORDERFLOW_MIN_SIDE_DEPTH_10LVL ||
      askDepth10 < ORDERFLOW_MIN_SIDE_DEPTH_10LVL
    ) {
      isSparse = true;
    }
  } else {
    // If depth aggregates are missing we conservatively treat the book
    // as sparse — the expectancy engine will refuse to use OFI for it.
    isSparse = true;
  }

  // From here on the core BBO fields are guaranteed numeric.
  const bbo = {
    bid: bid as number,
    ask: ask as number,
    bid_size: bidSize as number,
    ask_size: askSize as number,
  };

  const nowMs = lob.timestamp_ms;
  // If the snapshot is the same ts or older than what we've seen, no-op.
  // We still compute non-OFI fields (QI passthrough, microprice) so the
  // caller gets something, but OFI stays null and lob_state is misaligned.
  const isDuplicate =
    buffer.last_snap_ts_ms !== null && nowMs <= buffer.last_snap_ts_ms;

  const mid = (bbo.bid + bbo.ask) / 2;
  const microprice = computeMicroprice(bbo.bid, bbo.ask, bbo.bid_size, bbo.ask_size);
  const microOffset = microprice === null
    ? null
    : round4((microprice - mid) * dirSign);

  const qi5 = lob.depth_imbalance_5; // Sidecar already computes this

  if (isDuplicate) {
    return {
      ofi_10s: null,
      ofi_30s: null,
      z_ofi_10s: null,
      z_ofi_30s: null,
      z_ofi_blend: null,
      queue_imbalance_5: qi5,
      microprice_offset_pts: microOffset,
      lob_state: 'misaligned',
      ofi_reliability: isSparse ? 'sparse' : 'unknown',
    };
  }

  // ── Snapshot-delta OFI contribution ─────────────────────────────────
  let eK: number | null = null;
  if (
    buffer.last_best_bid !== null &&
    buffer.last_best_ask !== null &&
    buffer.last_bid_size !== null &&
    buffer.last_ask_size !== null
  ) {
    eK = computeOfiContribution(
      {
        bid: buffer.last_best_bid,
        ask: buffer.last_best_ask,
        bid_size: buffer.last_bid_size,
        ask_size: buffer.last_ask_size,
      },
      bbo,
    );
    buffer.contributions.push({ ts_ms: nowMs, e: eK });
  }

  // Update the "previous snapshot" state for next call.
  buffer.last_snap_ts_ms = nowMs;
  buffer.last_best_bid = bbo.bid;
  buffer.last_best_ask = bbo.ask;
  buffer.last_bid_size = bbo.bid_size;
  buffer.last_ask_size = bbo.ask_size;

  // Evict entries outside the longest window (30s).
  const longCutoff = nowMs - ORDERFLOW_LONG_WINDOW_MS;
  while (buffer.contributions.length > 0 && buffer.contributions[0]!.ts_ms < longCutoff) {
    buffer.contributions.shift();
  }

  // First-snapshot bootstrap — no prior state, no OFI features yet.
  if (eK === null) {
    return {
      ofi_10s: null,
      ofi_30s: null,
      z_ofi_10s: null,
      z_ofi_30s: null,
      z_ofi_blend: null,
      queue_imbalance_5: qi5,
      microprice_offset_pts: microOffset,
      lob_state: isSparse ? 'sparse' : 'fresh',
      ofi_reliability: isSparse ? 'sparse' : 'unknown',
    };
  }

  // ── Window totals ───────────────────────────────────────────────────
  const shortCutoff = nowMs - ORDERFLOW_SHORT_WINDOW_MS;
  let ofi10 = 0;
  let ofi30 = 0;
  for (const c of buffer.contributions) {
    ofi30 += c.e;
    if (c.ts_ms >= shortCutoff) ofi10 += c.e;
  }

  // Push to history (bounded).
  buffer.ofi_10s_history.push(ofi10);
  buffer.ofi_30s_history.push(ofi30);
  if (buffer.ofi_10s_history.length > ORDERFLOW_HISTORY_MAX_SAMPLES) {
    buffer.ofi_10s_history.shift();
  }
  if (buffer.ofi_30s_history.length > ORDERFLOW_HISTORY_MAX_SAMPLES) {
    buffer.ofi_30s_history.shift();
  }

  // ── z-scores (require warmup) ───────────────────────────────────────
  const haveWarmup = buffer.ofi_10s_history.length >= ORDERFLOW_Z_WARMUP_SAMPLES;
  if (haveWarmup && !buffer.orderflow_buffer_ready) {
    buffer.orderflow_buffer_ready = true;
  }
  let z10: number | null = null;
  let z30: number | null = null;
  if (haveWarmup) {
    const mean10 = meanOf(buffer.ofi_10s_history);
    const std10 = stdOf(buffer.ofi_10s_history, mean10);
    z10 = std10 > 0 ? round4((ofi10 - mean10) / std10) : 0;

    const mean30 = meanOf(buffer.ofi_30s_history);
    const std30 = stdOf(buffer.ofi_30s_history, mean30);
    z30 = std30 > 0 ? round4((ofi30 - mean30) / std30) : 0;
  }
  const zBlend = z10 !== null && z30 !== null ? round4((z10 + z30) / 2) : null;

  // Direction-aware signing.
  const signedZ10 = z10 === null ? null : round4(z10 * dirSign);
  const signedZ30 = z30 === null ? null : round4(z30 * dirSign);
  const signedBlend = zBlend === null ? null : round4(zBlend * dirSign);

  return {
    ofi_10s: round4(ofi10 * dirSign),
    ofi_30s: round4(ofi30 * dirSign),
    z_ofi_10s: signedZ10,
    z_ofi_30s: signedZ30,
    z_ofi_blend: signedBlend,
    queue_imbalance_5: qi5,
    microprice_offset_pts: microOffset,
    lob_state: isSparse ? 'sparse' : 'fresh',
    ofi_reliability: isSparse ? 'sparse' : 'full',
  };
}

function nullOrderflow(
  lob_state: EntryStateLobState,
  ofi_reliability: 'full' | 'sparse' | 'unknown',
): OrderflowFeatures {
  return {
    ofi_10s: null,
    ofi_30s: null,
    z_ofi_10s: null,
    z_ofi_30s: null,
    z_ofi_blend: null,
    queue_imbalance_5: null,
    microprice_offset_pts: null,
    lob_state,
    ofi_reliability,
  };
}

// ── Convenience: hydrate an existing EntryStateVector ───────────────────────

/**
 * Populate the orderflow slots of an already-built EntryStateVector
 * in place, using the runtime-state buffer for (snap.symbol,
 * deriveOrderflowSessionId(snap)). `lob_state` and `ofi_reliability`
 * on the vector are overwritten with the current snapshot's
 * classification.
 *
 * Called from strategy.ts after the generator returns a candidate so
 * the orderflow fields stay null when no LOB is available and get
 * populated when a fresh snapshot arrives.
 */
export function hydrateEntryStateVectorOrderflow(
  vector: EntryStateVector,
  snap: MarketSnapshot,
  lob: LobSnapshot | null,
  direction: 'long' | 'short',
): void {
  const sessionId = deriveOrderflowSessionId(snap);
  const buffer = getOrderflowBuffer(snap.symbol, sessionId);
  const features = computeOrderflowFeatures(buffer, lob, direction);

  vector.ofi_10s = features.ofi_10s;
  vector.ofi_30s = features.ofi_30s;
  vector.z_ofi_10s = features.z_ofi_10s;
  vector.z_ofi_30s = features.z_ofi_30s;
  vector.z_ofi_blend = features.z_ofi_blend;
  vector.queue_imbalance_5 = features.queue_imbalance_5;
  vector.microprice_offset_pts = features.microprice_offset_pts;
  vector.lob_state = features.lob_state;
  vector.ofi_reliability = features.ofi_reliability;
  vector.orderflow_buffer_ready = buffer.orderflow_buffer_ready;
  vector.orderflow_buffer_sample_count = buffer.ofi_10s_history.length;
  vector.orderflow_buffer_restored = buffer.orderflow_buffer_init_source === 'restored';
}

// ── Startup buffer restoration ──────────────────────────────────────────────
//
// On runner startup the orderflow buffer is empty, so z_ofi_blend stays
// null for the first ORDERFLOW_Z_WARMUP_SAMPLES snapshots. This function
// replays historical LOB snapshots from disk to pre-seed the buffer,
// making z-scores available immediately (or nearly so) after restart.

/**
 * Minimal snapshot shape for restoration — only the fields the OFI
 * engine needs. Keeps the restore path decoupled from the full
 * LobSnapshot interface.
 */
export interface RestorationSnapshot {
  timestamp_ms: number;
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  data_quality?: string | null;
  total_bid_depth_10lvl?: number | null;
  total_ask_depth_10lvl?: number | null;
  depth_imbalance_5?: number | null;
}

export interface RestoreOrderflowBufferResult {
  snapshots_replayed: number;
  buffer_sample_count: number;
  buffer_ready: boolean;
  restored_from: string;
}

/**
 * Pre-seed an orderflow buffer by replaying historical LOB snapshots.
 * Snapshots must be sorted ascending by timestamp_ms. Only the most
 * recent `maxSnapshots` entries are replayed (the rest are older than
 * the 30s window and wouldn't contribute to the running z-score).
 *
 * Direction is fixed to 'long' for restoration because the sign only
 * affects the returned features (z_ofi_blend sign), not the buffer's
 * internal state (contributions, ofi_history). The buffer itself is
 * direction-agnostic.
 */
export function restoreOrderflowBuffer(
  instrument: string,
  sessionId: string,
  snapshots: RestorationSnapshot[],
  maxSnapshots: number = ORDERFLOW_HISTORY_MAX_SAMPLES,
): RestoreOrderflowBufferResult {
  const buffer = getOrderflowBuffer(instrument, sessionId);

  // If the buffer already has data, skip restoration.
  if (buffer.ofi_10s_history.length > 0) {
    return {
      snapshots_replayed: 0,
      buffer_sample_count: buffer.ofi_10s_history.length,
      buffer_ready: buffer.orderflow_buffer_ready,
      restored_from: 'skipped_already_populated',
    };
  }

  const tail = snapshots.length > maxSnapshots
    ? snapshots.slice(snapshots.length - maxSnapshots)
    : snapshots;

  let replayed = 0;
  for (const snap of tail) {
    // Build a minimal LobSnapshot with all fields the OFI engine reads.
    // Fields not relevant to OFI computation are null-filled. We use a
    // Partial<> + cast because LobSnapshot gains microstructure fields
    // over time that restoration doesn't need.
    const lob = {
      timestamp_ms: snap.timestamp_ms,
      bbo_age_ms: 0,
      data_quality: (snap.data_quality as LobSnapshot['data_quality']) ?? 'full_depth',
      recording_context: 'restoration',
      bid: snap.bid,
      ask: snap.ask,
      mid: snap.bid != null && snap.ask != null ? (snap.bid + snap.ask) / 2 : null,
      bid_size: snap.bid_size,
      ask_size: snap.ask_size,
      spread_pts: snap.bid != null && snap.ask != null ? snap.ask - snap.bid : null,
      spread_ticks: null,
      depth_imbalance_5: snap.depth_imbalance_5 ?? null,
      depth_imbalance_10: null,
      total_bid_depth_10lvl: snap.total_bid_depth_10lvl ?? null,
      total_ask_depth_10lvl: snap.total_ask_depth_10lvl ?? null,
      large_bid_within_5pts: null,
      large_ask_within_5pts: null,
      cumulative_delta_10s: null,
      cumulative_delta_30s: null,
      cumulative_delta_60s: null,
      trade_flow_imbalance_10s: null,
      trade_flow_imbalance_30s: null,
      cancel_add_ratio_10s: null,
      replenishment_rate_10s: null,
      absorption_rate_10s: null,
      mean_order_lifetime_top_book: null,
      aggressor_penetration_10s: null,
      sweep_count_10s: null,
      adv_cancel_replace_ratio_10s: null,
      adv_modify_rate_10s: null,
      adv_iceberg_suspicion_30s: null,
      adv_queue_deterioration_bid_10s: null,
      adv_queue_deterioration_ask_10s: null,
      adv_pull_cascade_count_10s: null,
      adv_lifetime_p50_ms: null,
      absorption_score_10s: null,
      absorption_bid_score_10s: null,
      absorption_ask_score_10s: null,
      strongest_absorption_price: null,
      sweep_volume_10s: null,
      max_sweep_levels_10s: null,
      last_sweep_side: null,
      footprint_delta_30s: null,
      footprint_delta_5s: null,
      footprint_imbalance_ratio_30s: null,
      footprint_stacked_imbalance_count_30s: null,
      dominant_aggressor_side: null,
      large_trade_count_10s: null,
      large_trade_volume_10s: null,
      largest_trade_size_30s: null,
      large_trade_buy_sell_imbalance_30s: null,
      session_vpoc: null,
      session_vah: null,
      session_val: null,
      distance_to_vpoc: null,
      inside_value_area: null,
      trade_id: null,
      signal_id: null,
    } satisfies LobSnapshot;
    computeOrderflowFeatures(buffer, lob, 'long');
    replayed++;
  }

  buffer.orderflow_buffer_ready = buffer.ofi_10s_history.length >= ORDERFLOW_Z_WARMUP_SAMPLES;
  if (replayed > 0) {
    buffer.orderflow_buffer_init_source = 'restored';
  }

  return {
    snapshots_replayed: replayed,
    buffer_sample_count: buffer.ofi_10s_history.length,
    buffer_ready: buffer.orderflow_buffer_ready,
    restored_from: replayed > 0 ? 'lob_session_snapshots' : 'no_data',
  };
}

/**
 * Read LOB session snapshots from a JSONL file and return parsed
 * RestorationSnapshot objects sorted ascending by timestamp_ms.
 * Returns an empty array if the file doesn't exist or can't be read.
 */
export function readLobSnapshotsForRestore(filePath: string): RestorationSnapshot[] {
  if (!existsSync(filePath)) return [];

  try {
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    const snaps: RestorationSnapshot[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (
          typeof obj.timestamp_ms === 'number' &&
          obj.timestamp_ms > 0
        ) {
          snaps.push({
            timestamp_ms: obj.timestamp_ms,
            bid: typeof obj.bid === 'number' ? obj.bid : null,
            ask: typeof obj.ask === 'number' ? obj.ask : null,
            bid_size: typeof obj.bid_size === 'number' ? obj.bid_size : null,
            ask_size: typeof obj.ask_size === 'number' ? obj.ask_size : null,
            data_quality: obj.data_quality ?? null,
            total_bid_depth_10lvl: typeof obj.total_bid_depth_10lvl === 'number' ? obj.total_bid_depth_10lvl : null,
            total_ask_depth_10lvl: typeof obj.total_ask_depth_10lvl === 'number' ? obj.total_ask_depth_10lvl : null,
            depth_imbalance_5: typeof obj.depth_imbalance_5 === 'number' ? obj.depth_imbalance_5 : null,
          });
        }
      } catch {
        // skip malformed lines
      }
    }

    snaps.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    return snaps;
  } catch {
    return [];
  }
}
