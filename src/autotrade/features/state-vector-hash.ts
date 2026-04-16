/**
 * features/state-vector-hash.ts — Phase 7 reproducible state-vector hash.
 *
 * Plan §4.6 / §15 (Telemetry Fixes):
 *   > Specify that the hash is computed over a canonically-ordered JSON
 *   > serialization of the vector with 4-decimal rounding on all floats.
 *   > Document it in one place.
 *
 * This file IS that one place. Any change to the canonical form — field
 * order, rounding convention, null handling — must bump
 * ENTRY_STATE_VECTOR_HASH_VERSION so shadow windows from different
 * commits never mistake hash collisions for same-state decisions.
 *
 * The hash is a 32-bit FNV-1a digest expressed as an 8-character hex
 * string. FNV-1a is not cryptographic — we only need:
 *   - Deterministic across runs (same input → same output)
 *   - Cheap (no crypto library dependency)
 *   - Low collision rate over the ~100k-row signal dataset
 *
 * A 32-bit digest has a ~0.01% collision rate at 100k rows, which is
 * acceptable for telemetry linking. Cryptographic strength is not
 * required because the hash is never used for authentication.
 */

import type { EntryStateVector } from '../types.js';

/** Bumped when canonical serialization changes. */
export const ENTRY_STATE_VECTOR_HASH_VERSION = '0.1.0';

/**
 * Canonical field order. Anything not in this list is excluded from
 * the hash. Order matters — changing it bumps the hash version.
 *
 * `schema_version` IS included so a Phase 8 EntryStateVector schema
 * bump produces a different hash even if the field values are the same
 * — we want replay code to spot the difference.
 */
const HASH_FIELDS: readonly (keyof EntryStateVector)[] = [
  'schema_version',
  'timestamp_unix',
  'direction',
  'setup_type',
  'sigma_pts',
  'micro_atr',
  'room_atr',
  'session_atr',
  'z_ema9',
  'z_ema21',
  'z_vwap',
  'pullback_ratio',
  'impulse_maturity_bars',
  'regime',
  'ofi_10s',
  'ofi_30s',
  'z_ofi_10s',
  'z_ofi_30s',
  'z_ofi_blend',
  'queue_imbalance_5',
  'microprice_offset_pts',
  'lob_state',
  'ofi_reliability',
] as const;

/**
 * Canonicalize a single field value. Rules:
 *   - null / undefined → 'null'
 *   - booleans → 'true' / 'false'
 *   - finite numbers → rounded to 4 decimals, trimmed of trailing zeros
 *   - non-finite numbers → 'nan'  (never 'Infinity' to keep repr stable)
 *   - strings → verbatim (direction / setup_type / regime / lob_state etc.)
 */
function canonicalizeValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'nan';
    // Round to 4 decimals and strip trailing zeros / negative zero.
    const rounded = Math.round(v * 10000) / 10000;
    const normalized = Object.is(rounded, -0) ? 0 : rounded;
    return String(normalized);
  }
  if (typeof v === 'string') return v;
  // For any other type (shouldn't happen on a valid EntryStateVector)
  // fall back to a deterministic string form.
  try {
    return JSON.stringify(v);
  } catch {
    return 'unhashable';
  }
}

/**
 * Canonical serialized form of an EntryStateVector. Pure function for
 * tests to exercise; not exported from the main API to keep the
 * surface area minimal.
 */
export function canonicalSerializeEntryStateVector(vector: EntryStateVector): string {
  const parts: string[] = [];
  for (const field of HASH_FIELDS) {
    const value = (vector as unknown as Record<string, unknown>)[field];
    parts.push(`${field}=${canonicalizeValue(value)}`);
  }
  return parts.join('|');
}

/** 32-bit FNV-1a hash of a UTF-16 string, returned as 8-char hex. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime: 0x01000193 = 16777619
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Compute the reproducible hash for an EntryStateVector. Format:
 *   `esv1:<8-hex>` where `esv1` is the hash version tag.
 *
 * Bumping `ENTRY_STATE_VECTOR_HASH_VERSION` changes the prefix so old
 * hashes never collide with new ones.
 */
export function computeEntryStateVectorHash(vector: EntryStateVector): string {
  const canonical = canonicalSerializeEntryStateVector(vector);
  const digest = fnv1a32(canonical);
  return `esv${ENTRY_STATE_VECTOR_HASH_VERSION.replace(/\./g, '_')}:${digest}`;
}
