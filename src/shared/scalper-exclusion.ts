/**
 * scalper-exclusion.ts — contamination firewall helper (TypeScript runtime).
 *
 * Canonical source of truth across three language mirrors:
 *   - scripts/_scalper-exclusion.mjs        (Node scripts)
 *   - scripts/ml/_scalper_exclusion.py      (Python scripts)
 *   - src/shared/scalper-exclusion.ts       (this file — TypeScript src tree)
 *
 * Every TypeScript builder or exporter that reads candidate_signals.jsonl /
 * signals.jsonl / signals_labeled.jsonl and produces a training or
 * audit artifact MUST filter through this helper. That way the first
 * time the lob_mbo_scalp generator emits a candidate, legacy pipelines
 * drop it at ingest without polluting existing datasets.
 *
 * Also exposes a meta-row skip used by any future reader of
 * logs/lob_mbo_scalp_candidates.jsonl so the {"meta": true, ...}
 * header row convention is locked in early.
 *
 * The three language versions must stay in lockstep. If you change
 * the match logic here, update the JS and Python mirrors in the same
 * commit.
 */

export const LOB_MBO_SCALP_FAMILY = 'lob_mbo_scalp';

export const LOB_MBO_SCALP_SETUP_IDS: ReadonlySet<string> = new Set([
  'lob_mbo_scalp_long',
  'lob_mbo_scalp_short',
]);

const SCALPER_ID_PREFIX = 'lob_mbo_scalp_';

/**
 * Return true if the given row belongs to the lob_mbo_scalp family.
 *
 * Checks:
 *   - top-level `setup_family === 'lob_mbo_scalp'`
 *   - top-level `setup_type` in LOB_MBO_SCALP_SETUP_IDS
 *   - nested `candidate_setup.setup_family`
 *   - nested `candidate_setup.setup_type`
 *   - defensive: any `setup_type` starting with `'lob_mbo_scalp_'` (future IDs)
 *
 * Rows that are not plain objects return false (non-throwing).
 */
export function isLobMboScalpRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;

  if (r['setup_family'] === LOB_MBO_SCALP_FAMILY) return true;
  const topSetup = r['setup_type'];
  if (typeof topSetup === 'string') {
    if (LOB_MBO_SCALP_SETUP_IDS.has(topSetup)) return true;
    if (topSetup.startsWith(SCALPER_ID_PREFIX)) return true;
  }

  const cs = r['candidate_setup'];
  if (cs && typeof cs === 'object') {
    const c = cs as Record<string, unknown>;
    if (c['setup_family'] === LOB_MBO_SCALP_FAMILY) return true;
    const nestedSetup = c['setup_type'];
    if (typeof nestedSetup === 'string') {
      if (LOB_MBO_SCALP_SETUP_IDS.has(nestedSetup)) return true;
      if (nestedSetup.startsWith(SCALPER_ID_PREFIX)) return true;
    }
  }

  return false;
}

/**
 * Return true if the given row is a metadata header row.
 *
 * The lob_mbo_scalp_candidates.jsonl writer emits a metadata line at
 * the top of the file (e.g. `{"meta": true, "rejection_sample_rate": 50}`)
 * that carries configuration signalling for the trainer. Every reader
 * of that file must skip meta rows so they are never mistaken for
 * candidate rows.
 */
export function isLobMboScalpMetaRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  return (row as Record<string, unknown>)['meta'] === true;
}

/**
 * Return a new array containing rows that should survive the firewall:
 * neither scalper rows nor meta rows. Order is preserved.
 *
 * Use as the first step in any exporter that reads a shared log file.
 */
export function filterScalperRows<T>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    if (isLobMboScalpRow(row)) continue;
    if (isLobMboScalpMetaRow(row)) continue;
    out.push(row);
  }
  return out;
}
