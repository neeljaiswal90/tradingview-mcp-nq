/**
 * lob-mbo-scalp-dataset-export.ts — Phase 7 scalper historical/audit
 * dataset exporter.
 *
 * Reads:  logs/lob_mbo_scalp_candidates.jsonl (the Phase 4.1 writer output)
 * Writes: data/lob_mbo_scalp_signals.csv
 *
 * This is the TYPESCRIPT historical/audit counterpart to the
 * Python-side training dataset builder at
 * `scripts/ml/build_lob_mbo_scalp_dataset.py`. The two exist side-by-
 * side on purpose:
 *
 *   - The Python builder produces the labeled CSV the Phase 4.4
 *     trainer reads. Its column set is the training contract — narrow,
 *     numerics-only, optimized for model consumption. See the
 *     `STATE_VECTOR_FIELD_MAP` + `COLUMNS` lists in that script.
 *
 *   - This TS exporter produces the OPERATOR / AUDIT CSV. Its column
 *     set is wide and transparency-first: every Phase 5 field the
 *     shadow decision saw, serialized as JSON inside single cells where
 *     appropriate so the whole decision record round-trips. Operators
 *     use this to re-run a shadow decision offline, bucket rejections
 *     by reason, and review scalper telemetry without spinning up a
 *     Python environment.
 *
 * Scope (tight, per Phase 7 "telemetry and dashboard isolation"):
 *
 *   1. READS ONLY the scalper-owned candidate log. Never reads
 *      `candidate_signals.jsonl` or `signals_labeled.jsonl` — those are
 *      trend-owned streams and the Phase 3 firewall already excludes
 *      scalper rows from them. This exporter is the scalper's OWN
 *      source of truth.
 *
 *   2. SKIPS META ROWS. The Phase 4.1 writer emits
 *      `{"meta": true, ...}` as the first line of every JSONL file.
 *      Every reader of `lob_mbo_scalp_candidates.jsonl` must filter
 *      that row out BEFORE touching any other field. Enforced here via
 *      `isLobMboScalpMetaRow` from the shared exclusion helper — same
 *      guardrail locked by tests across every reader in the Phase 4/5
 *      pipeline.
 *
 *   3. PRESERVES SAMPLE_WEIGHT verbatim. Rejection sampling can be
 *      enabled at runtime via the Phase 6 config block; each row
 *      carries a `sample_weight` field that must flow through to the
 *      CSV unchanged (empty cell when missing, NOT 0 — empty cells
 *      are what downstream consumers treat as "no ground truth").
 *
 *   4. SERIALIZES NESTED BLOCKS AS JSON CELLS. The state vector, the
 *      deterministic verdict, the persistence verdict, the expectancy
 *      snapshot, the ML decision, and the full shadow decision all
 *      live in nested JSON objects on the log rows. Rather than
 *      flatten every nested field (48+ columns and counting), this
 *      exporter keeps a small flat header of identity + key scalar
 *      fields AND five JSON-serialized columns that carry the full
 *      detail. CSV consumers decode the JSON when they need the detail.
 *
 *   5. NO TREND COLUMNS. The scalper family has a disjoint column
 *      schema from the trend `SIGNAL_COLUMNS` in
 *      `historical/dataset-export.ts`. Adding trend columns with null
 *      fills would defeat the Phase 3 isolation work — the whole point
 *      of two separate exporters is that neither sees the other's
 *      schema.
 *
 * Output column schema (stable — bump `SCALPER_SIGNAL_EXPORT_SCHEMA_VERSION`
 * on any change):
 *
 *   Identity:            ts_ms, setup_type, setup_family, direction
 *   Gate outcome:        all_gates_passed, reject_stage, reject_reason, sample_weight
 *   Expectancy summary:  expectancy_ready, expectancy_bucket_source, expectancy_bucket_id,
 *                        expectancy_bucket_sample_count, expectancy_max_ev_horizon_sec,
 *                        expectancy_max_ev_ticks_post_cost
 *   ML summary:          ml_ready, ml_p_favor_direction, ml_horizon_sec, ml_model_version, ml_reason
 *   JSON payloads:       scalper_state_vector_json, deterministic_verdict_json,
 *                        persistence_verdict_json, expectancy_json, ml_decision_json,
 *                        shadow_decision_json
 *
 * Usage:
 *
 *   import { exportLobMboScalpSignals } from './lob-mbo-scalp-dataset-export.js';
 *   exportLobMboScalpSignals({
 *     inPath:  'logs/lob_mbo_scalp_candidates.jsonl',
 *     outPath: 'data/lob_mbo_scalp_signals.csv',
 *   });
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { isLobMboScalpMetaRow } from '../../shared/scalper-exclusion.js';

// ─── Schema constants ──────────────────────────────────────────────────────

/** Bump on any change to `SCALPER_SIGNAL_COLUMNS`. */
export const SCALPER_SIGNAL_EXPORT_SCHEMA_VERSION = '1.0';

/**
 * Ordered list of output columns. The order is the CSV header — changes
 * here are schema-breaking for downstream consumers so bump the schema
 * version alongside any edit.
 */
export const SCALPER_SIGNAL_COLUMNS: readonly string[] = [
  // Identity / timing
  'ts_ms',
  'setup_type',
  'setup_family',
  'direction',

  // Gate outcome (summary)
  'all_gates_passed',
  'reject_stage',
  'reject_reason',
  'sample_weight',

  // Expectancy summary (flat fields that dashboards bucket on)
  'expectancy_ready',
  'expectancy_bucket_source',
  'expectancy_bucket_id',
  'expectancy_bucket_sample_count',
  'expectancy_max_ev_horizon_sec',
  'expectancy_max_ev_ticks_post_cost',

  // ML summary
  'ml_ready',
  'ml_p_favor_direction',
  'ml_horizon_sec',
  'ml_model_version',
  'ml_reason',

  // JSON payloads (each cell is a JSON blob — dashboards decode on demand)
  'scalper_state_vector_json',
  'deterministic_verdict_json',
  'persistence_verdict_json',
  'expectancy_json',
  'ml_decision_json',
  'shadow_decision_json',
];

// ─── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Read a JSONL file into an array of row objects. Same defensive
 * behavior as the trend exporter — missing file returns empty array,
 * corrupt lines are silently skipped.
 */
function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/** Escape one scalar or object for a CSV cell. */
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v).replace(/"/g, '""');
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize a nested block as a JSON string, preserving null for missing blocks. */
function jsonCell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/**
 * Safely read a nested field from a row. Returns `undefined` when the
 * path is missing at any level. Used for flat summary extraction so
 * callers can distinguish "block missing entirely" from "block present
 * with null field".
 */
function pick(row: Record<string, unknown>, ...path: string[]): unknown {
  let cur: unknown = row;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Flatten one JSONL row into the stable CSV column layout. This is
 * pure — no filesystem, no log writes. Exposed for testing so the
 * flatten logic can be exercised without spinning up the full CLI.
 *
 * Rows that fail to produce the minimal identity fields (missing
 * `ts_ms`, `setup_type`, etc.) are flattened anyway — empty cells
 * propagate through. That matches the trend exporter's "never drop
 * silently; let the downstream consumer decide" posture.
 */
export function flattenScalperRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ts_ms: row['ts_ms'] ?? null,
    setup_type: row['setup_type'] ?? null,
    setup_family: row['setup_family'] ?? null,
    direction: row['direction'] ?? null,

    // Gate outcome
    all_gates_passed: row['all_gates_passed'] ?? null,
    reject_stage: row['reject_stage'] ?? null,
    reject_reason: row['reject_reason'] ?? null,
    sample_weight: row['sample_weight'] ?? null,

    // Expectancy summary
    expectancy_ready: row['expectancy_ready'] ?? null,
    expectancy_bucket_source: pick(row, 'expectancy', 'bucket_source') ?? null,
    expectancy_bucket_id: pick(row, 'expectancy', 'bucket_id') ?? null,
    expectancy_bucket_sample_count: pick(row, 'expectancy', 'bucket_sample_count') ?? null,
    expectancy_max_ev_horizon_sec: pick(row, 'expectancy', 'max_ev_horizon_sec') ?? null,
    expectancy_max_ev_ticks_post_cost: pick(row, 'expectancy', 'max_ev_ticks_post_cost') ?? null,

    // ML summary
    ml_ready: row['ml_ready'] ?? null,
    ml_p_favor_direction: pick(row, 'ml_decision', 'p_favor_direction') ?? null,
    ml_horizon_sec: pick(row, 'ml_decision', 'horizon_sec') ?? null,
    ml_model_version: pick(row, 'ml_decision', 'model_version') ?? null,
    ml_reason: pick(row, 'ml_decision', 'reason') ?? null,

    // JSON payloads
    scalper_state_vector_json: jsonCell(row['scalper_state_vector']),
    deterministic_verdict_json: jsonCell(row['deterministic_verdict']),
    persistence_verdict_json: jsonCell(row['persistence_verdict']),
    expectancy_json: jsonCell(row['expectancy']),
    ml_decision_json: jsonCell(row['ml_decision']),
    shadow_decision_json: jsonCell(row['shadow_decision']),
  };
}

/**
 * Write rows to a CSV file using the stable `SCALPER_SIGNAL_COLUMNS` order.
 * Ensures the parent directory exists before writing.
 */
export function writeScalperSignalsCsv(
  outPath: string,
  rows: Array<Record<string, unknown>>,
): void {
  const parent = dirname(outPath);
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });

  const out: string[] = [];
  out.push(SCALPER_SIGNAL_COLUMNS.join(','));
  for (const r of rows) {
    out.push(SCALPER_SIGNAL_COLUMNS.map((c) => csvEscape(r[c])).join(','));
  }
  writeFileSync(outPath, out.join('\n'), 'utf8');
}

// ─── Main export ────────────────────────────────────────────────────────────

export interface ExportLobMboScalpSignalsInput {
  /** Path to the Phase 4.1 writer output (JSONL). */
  inPath: string;
  /** Path to write the CSV. Parent directory is created if absent. */
  outPath: string;
}

export interface ExportLobMboScalpSignalsResult {
  /** Total rows read from the JSONL (including meta rows). */
  total_read: number;
  /** Meta rows skipped. Always the leading {"meta": true} header if present. */
  meta_skipped: number;
  /** Data rows emitted to the CSV. */
  data_emitted: number;
  /** CSV path written to. */
  out_path: string;
}

/**
 * Read `inPath`, skip meta rows, flatten each row into the scalper
 * signal schema, and write a CSV to `outPath`. Returns provenance
 * stats so callers can log + sanity-check the run.
 *
 * Never throws on a missing input file — returns zeros + an empty CSV
 * instead. The exporter is meant to be safe to run even when the
 * scalper has produced zero candidates yet (e.g. during initial
 * bootstrap before any shadow signals land).
 */
export function exportLobMboScalpSignals(
  input: ExportLobMboScalpSignalsInput,
): ExportLobMboScalpSignalsResult {
  const raw = readJsonl(input.inPath);
  const total = raw.length;

  let metaSkipped = 0;
  const data: Array<Record<string, unknown>> = [];
  for (const row of raw) {
    if (isLobMboScalpMetaRow(row)) {
      metaSkipped++;
      continue;
    }
    data.push(flattenScalperRow(row));
  }

  writeScalperSignalsCsv(input.outPath, data);

  return {
    total_read: total,
    meta_skipped: metaSkipped,
    data_emitted: data.length,
    out_path: input.outPath,
  };
}
