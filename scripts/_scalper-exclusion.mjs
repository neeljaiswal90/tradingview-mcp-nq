/**
 * _scalper-exclusion.mjs — contamination firewall helper (JS/Node runtime).
 *
 * Canonical source of truth across three language mirrors:
 *   - scripts/_scalper-exclusion.mjs        (this file — Node scripts)
 *   - scripts/ml/_scalper_exclusion.py      (Python scripts)
 *   - src/shared/scalper-exclusion.ts       (TypeScript src tree)
 *
 * Every builder that reads candidate_signals.jsonl / signals.jsonl /
 * signals_labeled.jsonl and produces a training artifact MUST filter
 * through this helper. That way the first time the lob_mbo_scalp
 * generator emits a candidate, legacy pipelines drop it at ingest
 * without polluting existing training datasets, labeling artifacts,
 * or expectancy bucket tables.
 *
 * Also exposes a meta-row skip used by any future reader of
 * logs/lob_mbo_scalp_candidates.jsonl / _labeled.jsonl so the
 * {"meta": true, ...} header row convention is locked in early.
 *
 * The three language versions must stay in lockstep. If you change
 * the match logic here, update the Python and TypeScript mirrors in
 * the same commit.
 */

export const LOB_MBO_SCALP_FAMILY = 'lob_mbo_scalp';

export const LOB_MBO_SCALP_SETUP_IDS = new Set([
  'lob_mbo_scalp_long',
  'lob_mbo_scalp_short',
]);

const SCALPER_ID_PREFIX = 'lob_mbo_scalp_';

/**
 * Return true if the given row belongs to the lob_mbo_scalp family.
 *
 * Checks:
 *   - top-level row.setup_family === 'lob_mbo_scalp'
 *   - top-level row.setup_type in LOB_MBO_SCALP_SETUP_IDS
 *   - nested row.candidate_setup.setup_family
 *   - nested row.candidate_setup.setup_type
 *   - defensive: any setup_type starting with 'lob_mbo_scalp_' (future IDs)
 *
 * Rows that are not plain objects return false (non-throwing).
 */
export function isLobMboScalpRow(row) {
  if (!row || typeof row !== 'object') return false;

  if (row.setup_family === LOB_MBO_SCALP_FAMILY) return true;
  if (typeof row.setup_type === 'string') {
    if (LOB_MBO_SCALP_SETUP_IDS.has(row.setup_type)) return true;
    if (row.setup_type.startsWith(SCALPER_ID_PREFIX)) return true;
  }

  const cs = row.candidate_setup;
  if (cs && typeof cs === 'object') {
    if (cs.setup_family === LOB_MBO_SCALP_FAMILY) return true;
    if (typeof cs.setup_type === 'string') {
      if (LOB_MBO_SCALP_SETUP_IDS.has(cs.setup_type)) return true;
      if (cs.setup_type.startsWith(SCALPER_ID_PREFIX)) return true;
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
export function isLobMboScalpMetaRow(row) {
  if (!row || typeof row !== 'object') return false;
  return row.meta === true;
}

/**
 * Return a new array containing rows that should survive the firewall:
 * neither scalper rows nor meta rows. Order is preserved.
 *
 * Use as the first step in any builder that reads a shared log file:
 *
 *     const rows = filterScalperRows(readJsonl(path));
 */
export function filterScalperRows(rows) {
  const out = [];
  for (const row of rows) {
    if (isLobMboScalpRow(row)) continue;
    if (isLobMboScalpMetaRow(row)) continue;
    out.push(row);
  }
  return out;
}
