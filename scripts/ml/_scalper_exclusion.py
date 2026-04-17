"""
_scalper_exclusion.py — contamination firewall helper (Python runtime).

Canonical source of truth across three language mirrors:
  - scripts/_scalper-exclusion.mjs        (Node scripts)
  - scripts/ml/_scalper_exclusion.py      (this file — Python scripts)
  - src/shared/scalper-exclusion.ts       (TypeScript src tree)

Every Python builder that reads candidate_signals.jsonl / signals.jsonl /
signals_labeled.jsonl and produces a training artifact MUST filter
through this helper. That way the first time the lob_mbo_scalp
generator emits a candidate, legacy training pipelines drop it at
ingest without polluting existing datasets.

Also exposes a meta-row skip used by any future reader of
logs/lob_mbo_scalp_candidates.jsonl so the {"meta": true, ...}
header row convention is locked in early.

The three language versions must stay in lockstep. If you change the
match logic here, update the JS and TypeScript mirrors in the same
commit.
"""

from __future__ import annotations

from typing import Any, Iterable, Iterator, List


LOB_MBO_SCALP_FAMILY = "lob_mbo_scalp"

LOB_MBO_SCALP_SETUP_IDS = frozenset({
    "lob_mbo_scalp_long",
    "lob_mbo_scalp_short",
})

_SCALPER_ID_PREFIX = "lob_mbo_scalp_"


def is_lob_mbo_scalp_row(row: Any) -> bool:
    """
    Return True if the given row belongs to the lob_mbo_scalp family.

    Checks:
      - top-level row["setup_family"] == "lob_mbo_scalp"
      - top-level row["setup_type"] in LOB_MBO_SCALP_SETUP_IDS
      - nested row["candidate_setup"]["setup_family"]
      - nested row["candidate_setup"]["setup_type"]
      - defensive: any setup_type starting with "lob_mbo_scalp_" (future IDs)

    Non-dict inputs return False (non-throwing).
    """
    if not isinstance(row, dict):
        return False

    if row.get("setup_family") == LOB_MBO_SCALP_FAMILY:
        return True

    top_setup = row.get("setup_type")
    if isinstance(top_setup, str):
        if top_setup in LOB_MBO_SCALP_SETUP_IDS:
            return True
        if top_setup.startswith(_SCALPER_ID_PREFIX):
            return True

    cs = row.get("candidate_setup")
    if isinstance(cs, dict):
        if cs.get("setup_family") == LOB_MBO_SCALP_FAMILY:
            return True
        nested_setup = cs.get("setup_type")
        if isinstance(nested_setup, str):
            if nested_setup in LOB_MBO_SCALP_SETUP_IDS:
                return True
            if nested_setup.startswith(_SCALPER_ID_PREFIX):
                return True

    return False


def is_lob_mbo_scalp_meta_row(row: Any) -> bool:
    """
    Return True if the given row is a metadata header row.

    The lob_mbo_scalp_candidates.jsonl writer emits a metadata line at
    the top of the file (e.g. ``{"meta": true, "rejection_sample_rate": 50}``)
    that carries configuration signalling for the trainer. Every reader
    of that file must skip meta rows so they are never mistaken for
    candidate rows.
    """
    if not isinstance(row, dict):
        return False
    return row.get("meta") is True


def filter_scalper_rows(rows: Iterable[Any]) -> Iterator[Any]:
    """
    Generator that drops scalper rows and meta rows from an iterable of
    records. Order is preserved.

    Use as the first step in any builder that reads a shared log file::

        for row in filter_scalper_rows(read_jsonl(path)):
            ...
    """
    for row in rows:
        if is_lob_mbo_scalp_row(row):
            continue
        if is_lob_mbo_scalp_meta_row(row):
            continue
        yield row


def filter_scalper_rows_list(rows: Iterable[Any]) -> List[Any]:
    """Eager variant of :func:`filter_scalper_rows` returning a list."""
    return list(filter_scalper_rows(rows))
