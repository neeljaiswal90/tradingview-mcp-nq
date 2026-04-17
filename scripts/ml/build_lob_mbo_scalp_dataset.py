#!/usr/bin/env python3
"""
build_lob_mbo_scalp_dataset.py — Phase 4.3 scalper training dataset builder.

Reads:  logs/lob_mbo_scalp_candidates_labeled.jsonl (Phase 4.2 labeler output)
Writes: data/lob_mbo_scalp_dataset.csv             (Phase 4.4 trainer input)

Scope (kept intentionally tight):

  1. Skip metadata rows. The Phase 4.1 writer emits a `{"meta": true, ...}`
     header, and the Phase 4.2 labeler emits its own metadata header in the
     labeled file. Both are skipped via the canonical
     `is_lob_mbo_scalp_meta_row` helper BEFORE any schema validation —
     same guardrail as the labeler, locked by tests.

  2. sample_weight passthrough. The Phase 4.1 writer sets sample_weight on
     every row (1 for passes/unsampled rejects, N for sampled rejects).
     This builder preserves that value unchanged — no coercion, no
     default substitution. Missing/None sample_weight propagates to the
     CSV as an empty cell so the Phase 4.4 trainer can fail-closed.

  3. label_source constant column. Every output row carries
     `label_source='exact_lob_mbo'` — matching the value the Phase 4.2
     labeler stamps on every labeled row. Stamped defensively here in
     case an upstream path ever strips it.

  4. Null label preservation. Labels that were None in the JSONL (e.g.
     uncovered horizons) write as empty cells in the CSV, NOT as 0.
     This is critical because the Phase 4.4 trainer interprets empty
     cells as "no ground truth" and drops those rows per-horizon —
     emitting 0 would train on mislabeled data.

The column set is fixed (see COLUMNS below) and stable across versions.
Changes to the column set are schema-breaking and require a bump of
DATASET_SCHEMA_VERSION.

The file is importable: `flatten_row`, `flatten_rows`, `write_csv`, and
`build_dataset` are exposed as pure functions so tests can exercise
them without spawning a subprocess.

Usage:
  python scripts/ml/build_lob_mbo_scalp_dataset.py \
         [--input  logs/lob_mbo_scalp_candidates_labeled.jsonl] \
         [--output data/lob_mbo_scalp_dataset.csv]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

# Make `_scalper_exclusion` importable regardless of cwd.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _scalper_exclusion import is_lob_mbo_scalp_meta_row  # noqa: E402

# ─── Schema constants ───────────────────────────────────────────────────────

DATASET_SCHEMA_VERSION = "1.0"
LABEL_SOURCE = "exact_lob_mbo"

# Mapping from the camelCase ScalperStateVector fields in the JSONL
# (Phase 4.1 writer spreads the TypeScript interface) to the snake_case
# column names used in the Phase 4.4 Python trainer. This is the ONLY
# place the case mapping lives — changes here cascade to every consumer.
STATE_VECTOR_FIELD_MAP: dict[str, str] = {
    "qi1": "qi_1",
    "qi3": "qi_3",
    "qi5": "qi_5",
    "microprice": "microprice",
    "micropriceEdgeTicks": "microprice_edge_ticks",
    "ofi250ms": "ofi_250ms",
    "ofi1s": "ofi_1s",
    "ofi3s": "ofi_3s",
    "zOfi250ms": "z_ofi_250ms",
    "zOfi1s": "z_ofi_1s",
    "zOfi3s": "z_ofi_3s",
    "afi250ms": "afi_250ms",
    "afi1s": "afi_1s",
    "afi3s": "afi_3s",
    "hazardBid1s": "hazard_bid_1s",
    "hazardAsk1s": "hazard_ask_1s",
    "absBid1s": "abs_bid_1s",
    "absAsk1s": "abs_ask_1s",
    "refillBid1s": "refill_bid_1s",
    "refillAsk1s": "refill_ask_1s",
    "sigma1sTicks": "sigma_1s_ticks",
    "spreadTicks": "spread_ticks",
}

# Ordered list of output columns. Written as the CSV header and used
# by `write_csv` to project each flattened row into the stable column
# order. This is the Phase 4.3 dataset schema.
COLUMNS: list[str] = [
    # Identity / context
    "ts_ms",
    "setup_type",
    "setup_family",
    "direction",
    # Gate outcomes
    "all_gates_passed",
    "reject_stage",
    "reject_reason",
    "sample_weight",
    "expectancy_ready",
    "ml_ready",
    "det_passed",
    "det_reject_reason",
    "persist_passed",
    "persist_reject_reason",
    "persist_age_ms",
    # Scalper state vector (snake_case from STATE_VECTOR_FIELD_MAP)
    "qi_1",
    "qi_3",
    "qi_5",
    "microprice",
    "microprice_edge_ticks",
    "ofi_250ms",
    "ofi_1s",
    "ofi_3s",
    "z_ofi_250ms",
    "z_ofi_1s",
    "z_ofi_3s",
    "afi_250ms",
    "afi_1s",
    "afi_3s",
    "hazard_bid_1s",
    "hazard_ask_1s",
    "abs_bid_1s",
    "abs_ask_1s",
    "refill_bid_1s",
    "refill_ask_1s",
    "sigma_1s_ticks",
    "spread_ticks",
    # Forward labels
    "fwd_return_1s_pts",
    "fwd_return_3s_pts",
    "fwd_return_5s_pts",
    "mfe_1s_pts",
    "mfe_3s_pts",
    "mfe_5s_pts",
    "mae_1s_pts",
    "mae_3s_pts",
    "mae_5s_pts",
    "horizon_coverage_ms",
    # Provenance (constant)
    "label_source",
]


# ─── Internal helpers ───────────────────────────────────────────────────────

def _get_nested(row: dict, key: str) -> Any:
    """Return row[key] if present, else None. Never raises on missing keys."""
    if not isinstance(row, dict):
        return None
    return row.get(key)


def _passthrough(row: dict, key: str) -> Any:
    """
    Passthrough helper. Returns None when the key is missing so the CSV
    writer emits an empty cell. Crucial for the null-preservation rule.
    """
    if not isinstance(row, dict):
        return None
    return row.get(key, None)


# ─── Core flattening ────────────────────────────────────────────────────────

def flatten_row(row: Any) -> Optional[dict[str, Any]]:
    """
    Flatten one labeled-candidate JSONL row into a flat dict keyed by the
    canonical column names from COLUMNS.

    Returns None when the row should be skipped:
      - metadata row (`{"meta": true, ...}`)
      - non-dict input (defensive)

    Null values in the input remain None in the output — `write_csv`
    converts None to empty strings, preserving the null label semantics
    the Phase 4.4 trainer depends on.

    The column set is fixed by COLUMNS. Fields missing from the input
    become None in the output so every row has the full column schema.
    """
    if is_lob_mbo_scalp_meta_row(row):
        return None
    if not isinstance(row, dict):
        return None

    out: dict[str, Any] = {}

    # ── Identity / context ───────────────────────────────────────────────
    out["ts_ms"] = _passthrough(row, "ts_ms")
    out["setup_type"] = _passthrough(row, "setup_type")
    out["setup_family"] = _passthrough(row, "setup_family")
    out["direction"] = _passthrough(row, "direction")

    # ── Gate outcomes ────────────────────────────────────────────────────
    out["all_gates_passed"] = _passthrough(row, "all_gates_passed")
    out["reject_stage"] = _passthrough(row, "reject_stage")
    out["reject_reason"] = _passthrough(row, "reject_reason")
    # sample_weight passthrough — preserve None if missing so the Phase 4.4
    # trainer can enforce its fail-closed contract.
    out["sample_weight"] = _passthrough(row, "sample_weight")
    out["expectancy_ready"] = _passthrough(row, "expectancy_ready")
    out["ml_ready"] = _passthrough(row, "ml_ready")

    # Flatten deterministic_verdict { passed, rejectReason }
    det_verdict = _get_nested(row, "deterministic_verdict")
    if isinstance(det_verdict, dict):
        out["det_passed"] = det_verdict.get("passed", None)
        out["det_reject_reason"] = det_verdict.get("rejectReason", None)
    else:
        out["det_passed"] = None
        out["det_reject_reason"] = None

    # Flatten persistence_verdict { passed, rejectReason, ageMs }
    persist_verdict = _get_nested(row, "persistence_verdict")
    if isinstance(persist_verdict, dict):
        out["persist_passed"] = persist_verdict.get("passed", None)
        out["persist_reject_reason"] = persist_verdict.get("rejectReason", None)
        out["persist_age_ms"] = persist_verdict.get("ageMs", None)
    else:
        out["persist_passed"] = None
        out["persist_reject_reason"] = None
        out["persist_age_ms"] = None

    # ── Scalper state vector (camelCase → snake_case) ────────────────────
    ssv = _get_nested(row, "scalper_state_vector")
    if isinstance(ssv, dict):
        for camel, snake in STATE_VECTOR_FIELD_MAP.items():
            out[snake] = ssv.get(camel, None)
    else:
        for snake in STATE_VECTOR_FIELD_MAP.values():
            out[snake] = None

    # ── Forward labels (null preserved as None) ──────────────────────────
    for horizon in (1, 3, 5):
        out[f"fwd_return_{horizon}s_pts"] = _passthrough(row, f"fwd_return_{horizon}s_pts")
        out[f"mfe_{horizon}s_pts"] = _passthrough(row, f"mfe_{horizon}s_pts")
        out[f"mae_{horizon}s_pts"] = _passthrough(row, f"mae_{horizon}s_pts")
    out["horizon_coverage_ms"] = _passthrough(row, "horizon_coverage_ms")

    # ── Provenance (constant, defensive stamp) ───────────────────────────
    # Even though Phase 4.2 stamps label_source on every labeled row, we
    # set it unconditionally here so the column is always populated even
    # if an upstream rewrite ever strips it. If the input row has a
    # DIFFERENT label_source we still overwrite it — this column is a
    # constant at the Phase 4.3 dataset level by definition.
    out["label_source"] = LABEL_SOURCE

    return out


def flatten_rows(rows: Iterable[Any]) -> Iterator[dict[str, Any]]:
    """
    Generator: flatten an iterable of labeled-candidate rows. Skips meta
    rows and non-dict rows silently. The caller is responsible for any
    counting / stats / reporting.
    """
    for row in rows:
        flat = flatten_row(row)
        if flat is not None:
            yield flat


# ─── I/O ────────────────────────────────────────────────────────────────────

def read_jsonl(path: Path) -> list[Any]:
    """
    Read a JSONL file into a list of parsed objects. Silently skips
    blank lines and corrupt rows. Non-existent files return an empty list.
    """
    if not path.exists():
        return []
    out: list[Any] = []
    with path.open("r", encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                out.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    return out


def _cell(value: Any) -> str:
    """
    Format one cell value for CSV output.

    CRITICAL RULE: None must become an empty string, NOT the literal '0'
    or 'None' or 'null'. The Phase 4.4 trainer interprets empty cells as
    "no ground truth" and drops those rows per-horizon — coercing None to
    0 would train on mislabeled data. This function is the single point
    where that conversion happens, so the rule is enforced everywhere
    the CSV is written.

    Booleans are serialized as lowercase 'true' / 'false' for Python
    pandas compatibility (`bool` parse matches both).
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    # Numbers, strings, and other atoms use their natural string form.
    return str(value)


def write_csv(rows: Iterable[dict[str, Any]], out_path: Path, columns: list[str] = COLUMNS) -> int:
    """
    Write a sequence of flattened rows to CSV at `out_path`. Returns the
    number of data rows written (excluding the header).

    Uses the stable column order from `columns`. Missing keys are
    written as empty cells (via the `_cell` null-preservation rule).
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with out_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(columns)
        for row in rows:
            writer.writerow([_cell(row.get(col)) for col in columns])
            count += 1
    return count


# ─── End-to-end driver ──────────────────────────────────────────────────────

def build_dataset(input_path: Path, output_path: Path) -> dict[str, Any]:
    """
    End-to-end: read the labeled JSONL, flatten, write the CSV.

    Returns a stats dict suitable for CLI printing:
      {
        "input_rows": int,         # total lines read from JSONL
        "skipped_meta_rows": int,  # meta rows dropped at flatten time
        "skipped_invalid_rows": int,  # non-dict rows dropped
        "data_rows_written": int,  # rows that appear in the CSV
      }
    """
    raw_rows = read_jsonl(input_path)
    stats = {
        "input_rows": len(raw_rows),
        "skipped_meta_rows": 0,
        "skipped_invalid_rows": 0,
        "data_rows_written": 0,
    }

    flat_rows: list[dict[str, Any]] = []
    for row in raw_rows:
        if is_lob_mbo_scalp_meta_row(row):
            stats["skipped_meta_rows"] += 1
            continue
        if not isinstance(row, dict):
            stats["skipped_invalid_rows"] += 1
            continue
        flat = flatten_row(row)
        # flat is never None here because we already checked meta/dict
        # above, but defensive: skip if it somehow comes back None.
        if flat is None:
            stats["skipped_invalid_rows"] += 1
            continue
        flat_rows.append(flat)

    stats["data_rows_written"] = write_csv(flat_rows, output_path)
    return stats


# ─── CLI ────────────────────────────────────────────────────────────────────

def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the Phase 4.3 lob_mbo_scalp training dataset CSV.",
    )
    parser.add_argument(
        "--input",
        default="logs/lob_mbo_scalp_candidates_labeled.jsonl",
        help="Path to the Phase 4.2 labeled JSONL file (default: logs/lob_mbo_scalp_candidates_labeled.jsonl)",
    )
    parser.add_argument(
        "--output",
        default="data/lob_mbo_scalp_dataset.csv",
        help="Path to the output CSV (default: data/lob_mbo_scalp_dataset.csv)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()

    if not input_path.exists():
        print(f"[DATASET] Input file not found: {input_path}", file=sys.stderr)
        return 1

    print(f"[DATASET] Reading:  {input_path}")
    print(f"[DATASET] Writing:  {output_path}")

    try:
        stats = build_dataset(input_path, output_path)
    except Exception as exc:  # noqa: BLE001
        print(f"[DATASET] Unexpected error: {exc}", file=sys.stderr)
        return 2

    print(f"[DATASET] Stats:")
    print(f"  schema_version:       {DATASET_SCHEMA_VERSION}")
    print(f"  label_source:         {LABEL_SOURCE}")
    print(f"  input_rows:           {stats['input_rows']}")
    print(f"  skipped_meta_rows:    {stats['skipped_meta_rows']}")
    print(f"  skipped_invalid_rows: {stats['skipped_invalid_rows']}")
    print(f"  data_rows_written:    {stats['data_rows_written']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
