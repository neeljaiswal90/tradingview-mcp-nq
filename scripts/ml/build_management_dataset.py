#!/usr/bin/env python3
"""
build_management_dataset.py — Build a supervised-learning dataset for
position management from trades.jsonl + trade_path.jsonl.

Each row is a decision point during an open trade, using ONLY information
available at that timestamp (no target leakage).

Output:
  data/management_dataset.csv           — the dataset
  data/management_dataset_schema.json   — column descriptions + metadata

Usage:
  python scripts/ml/build_management_dataset.py [--log-dir ./logs] [--out-dir ./data]

Requires: Python 3.8+ (stdlib only; no pandas/numpy dependency).
Optional: pip install pandas pyarrow  → also writes .parquet
"""

from __future__ import annotations

import argparse
import bisect
import csv
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ─── JSONL Reader ─────────────────────────────────────────────────────────────

def read_jsonl(path: str) -> list[dict]:
    """Read a .jsonl file into a list of dicts. Skips blank/corrupt lines."""
    if not os.path.exists(path):
        return []
    records = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


# ─── Timestamp helpers ────────────────────────────────────────────────────────

def parse_iso(ts: str | None) -> float | None:
    """Parse ISO timestamp to epoch seconds. Returns None on failure."""
    if not ts:
        return None
    try:
        # Handle both Z and +00:00 suffixes
        ts = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def hour_bucket(ts: str | None) -> int | None:
    """Extract UTC hour from ISO timestamp."""
    if not ts:
        return None
    try:
        ts = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts)
        return dt.hour
    except (ValueError, TypeError):
        return None


# ─── Feature extraction from a tick snapshot ──────────────────────────────────

def safe_float(val: Any) -> float | None:
    """Convert to float or return None."""
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def safe_int(val: Any) -> int | None:
    """Convert to int or return None."""
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def safe_bool(val: Any) -> int | None:
    """Convert to 0/1 int or return None."""
    if val is None:
        return None
    if isinstance(val, bool):
        return 1 if val else 0
    return 1 if val else 0


# ─── Import canonical feature lists from the shared registry ─────────────────

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'python-market-data-service'))
from lob_features.ml_feature_registry import (
    LOB_NUMERIC_FEATURES,
    ADVANCED_MBO_FEATURES,
    LOB_SNAPSHOT_FIELD_MAP,
    FEATURE_FAMILIES,
    FEATURE_METADATA,
)


# ─── LOB snapshot loading and nearest-timestamp join ─────────────────────────

def load_lob_snapshots(log_dir: str) -> dict[str, list[dict]]:
    """
    Load lob_snapshots.jsonl, index by trade_id, sort by timestamp_ms.
    Only includes records with recording_context=='trade' and a valid trade_id.
    """
    path = os.path.join(log_dir, "lob_snapshots.jsonl")
    records = read_jsonl(path)

    by_trade: dict[str, list[dict]] = {}
    skipped = 0
    for rec in records:
        tid = rec.get("trade_id")
        if not tid or rec.get("recording_context") != "trade":
            skipped += 1
            continue
        by_trade.setdefault(tid, []).append(rec)

    # Sort each trade's snapshots by timestamp_ms for binary search
    for tid in by_trade:
        by_trade[tid].sort(key=lambda r: r.get("timestamp_ms", 0))

    total = sum(len(v) for v in by_trade.values())
    print(f"[LOB-JOIN] Loaded {total} LOB snapshots across {len(by_trade)} trades (skipped {skipped} non-trade records)")
    return by_trade


def load_runtime_features(
    log_dir: str,
) -> tuple[dict[str, dict], dict[str, dict[str, dict]]]:
    """
    Load ml_management_features_*.jsonl (glob across rotated files).

    Returns two indices:
      by_request_id : { _request_id -> record }        — primary exact match
      by_trade_ts   : { trade_id -> { timestamp -> record } } — timestamp fallback

    Matching priority in enrich_row_with_lob():
      1. row._request_id present and found in by_request_id  (future dataset paths)
      2. (trade_id, timestamp) lookup in by_trade_ts          (current trade_path.jsonl path)
      3. timestamp join against lob_snapshots.jsonl
      4. position_only
    """
    pattern = os.path.join(log_dir, "ml_management_features*.jsonl")
    files = sorted(glob.glob(pattern))
    if not files:
        return {}, {}

    by_request_id: dict[str, dict] = {}
    by_trade_ts: dict[str, dict[str, dict]] = {}
    total = 0
    for fpath in files:
        records = read_jsonl(fpath)
        for rec in records:
            rid = rec.get("_request_id")
            if rid:
                by_request_id[rid] = rec

            tid = rec.get("_trade_id") or rec.get("trade_id")
            ts = rec.get("_timestamp")
            if tid and ts:
                by_trade_ts.setdefault(tid, {})[ts] = rec
                total += 1

    print(f"[LOB-JOIN] Loaded {total} runtime feature records from {len(files)} file(s) "
          f"({len(by_request_id)} with request_id)")
    return by_request_id, by_trade_ts


def find_nearest_lob(
    tick_ts_ms: int,
    trade_id: str,
    lob_by_trade: dict[str, list[dict]],
    max_delta_ms: int = 2000,
) -> tuple[dict | None, dict]:
    """
    Binary search for nearest LOB snapshot within trade_id-indexed snapshots.

    Returns (snapshot_or_None, join_metadata).

    Quality gates before accepting a join:
    - data_quality != "unavailable"
    - bbo_age_ms < 5000 (matches runtime freshness check in feature-builder.ts:54)
    - |tick_ts - snapshot_ts| <= max_delta_ms
    """
    empty_meta = {
        "_lob_join_delta_ms": None,
        "_lob_join_method": "no_match",
        "_lob_join_success": False,
        "_lob_data_quality": None,
        "_lob_bbo_age_ms": None,
        "_lob_snapshot_ts_ms": None,
        "_lob_snapshot_source_file": None,
    }

    snaps = lob_by_trade.get(trade_id)
    if not snaps:
        return None, empty_meta

    # Binary search for nearest timestamp
    timestamps = [s.get("timestamp_ms", 0) for s in snaps]
    idx = bisect.bisect_left(timestamps, tick_ts_ms)

    # Check candidates: the one at idx and idx-1
    best_snap = None
    best_delta = max_delta_ms + 1
    for candidate_idx in [idx - 1, idx]:
        if 0 <= candidate_idx < len(snaps):
            delta = abs(timestamps[candidate_idx] - tick_ts_ms)
            if delta < best_delta:
                best_delta = delta
                best_snap = snaps[candidate_idx]

    if best_snap is None or best_delta > max_delta_ms:
        return None, empty_meta

    # Quality gates
    data_quality = best_snap.get("data_quality", "unavailable")
    bbo_age = best_snap.get("bbo_age_ms", 99999)

    if data_quality == "unavailable" or bbo_age >= 5000:
        return None, {
            "_lob_join_delta_ms": best_delta,
            "_lob_join_method": "trade_id_nearest",
            "_lob_join_success": False,
            "_lob_data_quality": data_quality,
            "_lob_bbo_age_ms": bbo_age,
            "_lob_snapshot_ts_ms": best_snap.get("timestamp_ms"),
            "_lob_snapshot_source_file": "lob_snapshots.jsonl",
        }

    return best_snap, {
        "_lob_join_delta_ms": best_delta,
        "_lob_join_method": "trade_id_nearest",
        "_lob_join_success": True,
        "_lob_data_quality": data_quality,
        "_lob_bbo_age_ms": bbo_age,
        "_lob_snapshot_ts_ms": best_snap.get("timestamp_ms"),
        "_lob_snapshot_source_file": "lob_snapshots.jsonl",
    }


def enrich_row_with_lob(
    row: dict,
    tick_ts_ms: int,
    trade_id: str,
    lob_by_trade: dict[str, list[dict]],
    runtime_by_request_id: dict[str, dict],
    runtime_by_trade_ts: dict[str, dict[str, dict]],
) -> None:
    """
    Add LOB/MBO feature columns to a dataset row.

    Priority:
    1. runtime_exact via _request_id — UUID exact match in runtime feature log
       (used when dataset is built directly from runtime payloads)
    2. runtime_exact via timestamp — (trade_id, timestamp) match in runtime feature log
       (current path: rows from trade_path.jsonl matched to runtime log by timestamp)
    3. joined_from_lob_logs — nearest-timestamp join against lob_snapshots.jsonl
    4. position_only — no LOB data available

    Modifies row in-place. Adds all LOB + advanced MBO feature columns (from registry)
    plus provenance metadata columns.
    """
    # Initialize all LOB columns to None (derived from registry, not hardcoded)
    all_lob_features = LOB_NUMERIC_FEATURES + ADVANCED_MBO_FEATURES
    for feat in all_lob_features:
        row[feat] = None

    ts = row.get("timestamp")

    # Try runtime_exact: request_id match (primary — UUID, no timestamp drift)
    rt_rec: dict | None = None
    request_id = row.get("_request_id")
    if request_id and request_id in runtime_by_request_id:
        rt_rec = runtime_by_request_id[request_id]

    # Try runtime_exact: timestamp match (fallback for trade_path.jsonl rows)
    if rt_rec is None and ts:
        rt_rec = runtime_by_trade_ts.get(trade_id, {}).get(ts)

    if rt_rec is not None:
        for feat in all_lob_features:
            val = rt_rec.get(feat)
            if val is not None:
                row[feat] = safe_float(val)
        row["_lob_data_source"] = "runtime_exact"
        row["_lob_join_delta_ms"] = None
        row["_lob_join_method"] = "runtime_exact_request_id" if request_id else "runtime_exact_timestamp"
        row["_lob_join_success"] = True
        row["_lob_data_quality"] = None
        row["_lob_bbo_age_ms"] = rt_rec.get("_bbo_age_ms")
        row["_lob_snapshot_ts_ms"] = None
        row["_lob_snapshot_source_file"] = None
        return

    # Fallback: timestamp join against lob_snapshots.jsonl
    snap, join_meta = find_nearest_lob(tick_ts_ms, trade_id, lob_by_trade)

    if snap and join_meta["_lob_join_success"]:
        # Map snapshot field names to registry feature names
        for snap_field, reg_field in LOB_SNAPSHOT_FIELD_MAP.items():
            val = snap.get(snap_field)
            if val is not None:
                row[reg_field] = safe_float(val)
        row["_lob_data_source"] = "joined_from_lob_logs"
    else:
        row["_lob_data_source"] = "position_only"

    # Always set join metadata
    row["_lob_join_delta_ms"] = join_meta["_lob_join_delta_ms"]
    row["_lob_join_method"] = join_meta["_lob_join_method"]
    row["_lob_join_success"] = join_meta["_lob_join_success"]
    row["_lob_data_quality"] = join_meta["_lob_data_quality"]
    row["_lob_bbo_age_ms"] = join_meta["_lob_bbo_age_ms"]
    row["_lob_snapshot_ts_ms"] = join_meta["_lob_snapshot_ts_ms"]
    row["_lob_snapshot_source_file"] = join_meta["_lob_snapshot_source_file"]


# ─── Build a single row from a tick + trade context ──────────────────────────

def build_row(
    tick: dict,
    trade: dict,
    events_before: list[dict],
    row_type: str,
    tick_index: int,
    total_ticks: int,
) -> dict:
    """
    Build one dataset row from a trade_path tick + trade record context.
    Uses ONLY information available at tick.timestamp (no future leakage).

    The trade record supplies entry-time context (setup_type, confidence, etc.)
    that was known at entry and does not change during the trade.
    """
    entry_price = safe_float(tick.get("entry_price") or trade.get("entry_price_filled"))
    current_price = safe_float(tick.get("current_price"))
    stop_current = safe_float(tick.get("stop_current"))
    stop_initial = safe_float(trade.get("stop_price_initial"))
    side = tick.get("side") or trade.get("side")
    is_short = 1 if side == "short" else 0

    # Compute derived features
    initial_risk_pts = abs(entry_price - stop_initial) if entry_price and stop_initial else None
    distance_to_stop_pts = None
    if current_price is not None and stop_current is not None:
        distance_to_stop_pts = abs(current_price - stop_current)

    # How many events have occurred up to this point (no leakage: only events_before)
    pt1_events = [e for e in events_before if e.get("event_type") == "pt1_trigger"]
    pt2_events = [e for e in events_before if e.get("event_type") == "pt2_trigger"]
    be_events = [e for e in events_before if e.get("event_type") == "pre_t1_be_move"]
    trail_events = [e for e in events_before if e.get("event_type") in ("pre_t1_trail_activation", "post_pt1_trail_activation")]
    ratchet_events = [e for e in events_before if e.get("event_type") == "trail_ratchet"]

    # ATR: prefer management event field, fall back to trade record
    atr_at_entry = safe_float(trade.get("atr_at_entry"))
    # If the tick has atr_at_entry (enriched ticks), use it
    tick_atr = safe_float(tick.get("atr_at_entry"))
    if tick_atr is not None:
        atr_at_entry = tick_atr

    # Normalized features (ATR-relative)
    pnl_atr = None
    mfe_atr = None
    mae_atr = None
    distance_to_stop_atr = None
    if atr_at_entry and atr_at_entry > 0:
        pnl_pts = safe_float(tick.get("pnl_pts"))
        if pnl_pts is not None:
            pnl_atr = round(pnl_pts / atr_at_entry, 4)
        mfe = safe_float(tick.get("mfe_pts"))
        if mfe is not None:
            mfe_atr = round(mfe / atr_at_entry, 4)
        mae = safe_float(tick.get("mae_pts"))
        if mae is not None:
            mae_atr = round(mae / atr_at_entry, 4)
        if distance_to_stop_pts is not None:
            distance_to_stop_atr = round(distance_to_stop_pts / atr_at_entry, 4)

    row = {
        # ── Identity ──────────────────────────────────────────────────────
        "trade_id": tick.get("trade_id") or trade.get("trade_id"),
        "timestamp": tick.get("timestamp"),
        "row_type": row_type,  # tick | management_event | entry | pre_exit
        "tick_index": tick_index,
        "total_ticks": total_ticks,
        "tick_progress": round(tick_index / max(total_ticks, 1), 4),

        # ── Trade context (known at entry, no leakage) ────────────────────
        "side": side,
        "is_short": is_short,
        "setup_type": trade.get("setup_type"),
        "management_profile": trade.get("management_profile"),
        "management_variant": trade.get("management_variant"),
        "regime_at_entry": trade.get("regime_at_entry"),
        "confidence_at_entry": safe_float(trade.get("confidence_score")),
        "atr_at_entry": atr_at_entry,
        "entry_price": entry_price,
        "stop_initial": stop_initial,
        "initial_risk_pts": round(initial_risk_pts, 2) if initial_risk_pts else None,
        "target_1": safe_float(tick.get("target_1") or trade.get("target_1")),
        "target_2": safe_float(tick.get("target_2") or trade.get("target_2")),
        "quantity_original": safe_int(trade.get("quantity")),

        # ── Current state (changes every tick) ────────────────────────────
        "current_price": current_price,
        "stop_current": stop_current,
        "quantity_remaining": safe_float(tick.get("quantity_remaining")),
        "pnl_pts": safe_float(tick.get("pnl_pts")),
        "unrealized_r": safe_float(tick.get("unrealized_r")),
        "mfe_pts_so_far": safe_float(tick.get("mfe_pts")),
        "mae_pts_so_far": safe_float(tick.get("mae_pts")),
        "time_in_trade_sec": safe_int(tick.get("hold_seconds")),
        "distance_to_stop_pts": round(distance_to_stop_pts, 2) if distance_to_stop_pts is not None else None,

        # ── ATR-normalized features ───────────────────────────────────────
        "pnl_atr": pnl_atr,
        "mfe_atr": mfe_atr,
        "mae_atr": mae_atr,
        "distance_to_stop_atr": distance_to_stop_atr,

        # ── Management state flags (causal: only from events before this tick) ─
        "pt1_hit": 1 if len(pt1_events) > 0 else 0,
        "pt2_hit": 1 if len(pt2_events) > 0 else 0,
        "stop_at_breakeven": 1 if len(be_events) > 0 or len(pt1_events) > 0 else 0,
        "trail_active": 1 if len(trail_events) > 0 else 0,
        "trail_ratchet_count": len(ratchet_events),
        "management_events_count": len(events_before),

        # ── Enriched tick fields (present on newer data only) ─────────────
        "pt1_done_flag": safe_bool(tick.get("pt1_done")),
        "pt2_done_flag": safe_bool(tick.get("pt2_done")),
        "pre_t1_be_triggered_flag": safe_bool(tick.get("pre_t1_be_triggered")),
        "pre_t1_trailing_active_flag": safe_bool(tick.get("pre_t1_trailing_active")),
        "trailing_active_flag": safe_bool(tick.get("trailing_active")),
        "trail_distance_ticks": safe_float(tick.get("trail_distance_ticks")),

        # ── Session context ───────────────────────────────────────────────
        "entry_hour_utc": hour_bucket(trade.get("timestamp_entry")),
        "tick_hour_utc": hour_bucket(tick.get("timestamp")),

        # ── Labels (FUTURE INFORMATION — for supervised learning only) ────
        # These use the trade record which contains the final outcome.
        # MUST be excluded from model features during training.
        "label_final_r": safe_float(trade.get("r_multiple")),
        "label_outcome": trade.get("outcome_class"),
        "label_exit_reason": trade.get("exit_reason"),
        "label_hold_time_total_sec": safe_int(trade.get("hold_time_seconds")),
        "label_final_pnl_usd": safe_float(trade.get("pnl_realized")),
        "label_max_unrealized_r": safe_float(trade.get("max_unrealized_r")),
        "label_mfe_total": safe_float(trade.get("mfe")),
        "label_mae_total": safe_float(trade.get("mae")),
        "label_mfe_at_pt1": safe_float(trade.get("mfe_at_pt1")),
        "label_mfe_after_pt1": safe_float(trade.get("mfe_after_pt1")),
        "label_runner_capture_ratio": safe_float(trade.get("runner_capture_ratio")),
        "label_giveback_r": safe_float(trade.get("giveback_after_pt1_r")),
    }

    return row


# ─── Main dataset builder ────────────────────────────────────────────────────

def build_dataset(log_dir: str) -> list[dict]:
    """
    Build the management dataset from logs.

    For each trade with path data:
      1. First tick → row_type='entry'
      2. Each management event → row_type='management_event'
      3. Every Nth tick → row_type='tick' (sampled to avoid redundancy)
      4. Last tick before exit → row_type='pre_exit'

    LOB/MBO features are enriched via:
      1. Exact runtime payloads (ml_management_features_*.jsonl) when available
      2. Nearest-timestamp join against lob_snapshots.jsonl as fallback
      3. Null (position_only) when no LOB data is available
    """
    trades_path = os.path.join(log_dir, "trades.jsonl")
    path_path = os.path.join(log_dir, "trade_path.jsonl")

    trades = read_jsonl(trades_path)
    path_records = read_jsonl(path_path)

    # Load LOB data sources for enrichment
    lob_by_trade = load_lob_snapshots(log_dir)
    runtime_by_request_id, runtime_by_trade_ts = load_runtime_features(log_dir)

    # Index by trade_id
    trade_by_id: dict[str, dict] = {}
    for t in trades:
        tid = t.get("trade_id")
        if tid:
            trade_by_id[tid] = t

    # Split path records into ticks and events, indexed by trade_id
    ticks_by_trade: dict[str, list[dict]] = {}
    events_by_trade: dict[str, list[dict]] = {}

    for rec in path_records:
        tid = rec.get("trade_id")
        if not tid:
            continue
        if rec.get("_record_type") == "management_event":
            events_by_trade.setdefault(tid, []).append(rec)
        else:
            ticks_by_trade.setdefault(tid, []).append(rec)

    # Sort ticks and events by timestamp
    for tid in ticks_by_trade:
        ticks_by_trade[tid].sort(key=lambda r: r.get("timestamp", ""))
    for tid in events_by_trade:
        events_by_trade[tid].sort(key=lambda r: r.get("timestamp", ""))

    rows: list[dict] = []
    trades_processed = 0
    trades_skipped = 0

    for tid, trade in trade_by_id.items():
        ticks = ticks_by_trade.get(tid, [])
        events = events_by_trade.get(tid, [])

        if len(ticks) < 2 and len(events) == 0:
            trades_skipped += 1
            continue

        trades_processed += 1
        total_ticks = max(len(ticks), 1)

        # Determine sampling rate: keep all if < 50 ticks, else sample ~50
        sample_interval = max(1, total_ticks // 50)

        for i, tick in enumerate(ticks):
            tick_ts = tick.get("timestamp", "")

            # Events that occurred BEFORE or AT this tick's timestamp (causal)
            events_before = [e for e in events if e.get("timestamp", "") <= tick_ts]

            # Determine row_type
            is_entry = (i == 0)
            is_pre_exit = (i == total_ticks - 1)
            is_management_event_tick = any(
                e.get("timestamp", "") == tick_ts for e in events
            )

            # Decide whether to include this tick
            if is_entry:
                row_type = "entry"
            elif is_pre_exit:
                row_type = "pre_exit"
            elif is_management_event_tick:
                row_type = "management_event"
            elif i % sample_interval == 0:
                row_type = "tick"
            else:
                continue  # Skip non-sampled ticks

            row = build_row(tick, trade, events_before, row_type, i, total_ticks)
            # Enrich with LOB/MBO features
            tick_ts_ms = int((parse_iso(tick.get("timestamp")) or 0) * 1000)
            enrich_row_with_lob(row, tick_ts_ms, tid, lob_by_trade,
                                runtime_by_request_id, runtime_by_trade_ts)
            rows.append(row)

        # Also add rows for management events that don't align with a tick timestamp
        for event in events:
            evt_ts = event.get("timestamp", "")
            # Check if we already have a row at this exact timestamp
            already_covered = any(
                r.get("timestamp") == evt_ts and r.get("trade_id") == tid
                for r in rows[-total_ticks:]  # only check recent rows for this trade
            )
            if already_covered:
                continue

            events_before = [e for e in events if e.get("timestamp", "") <= evt_ts]

            # Build a pseudo-tick from the management event (it has price data)
            pseudo_tick = {
                "trade_id": tid,
                "timestamp": evt_ts,
                "side": event.get("side"),
                "entry_price": event.get("entry_price"),
                "current_price": event.get("current_price"),
                "stop_current": event.get("stop_after"),
                "quantity_remaining": event.get("quantity_after"),
                "pnl_pts": event.get("unrealized_pnl_pts"),
                "unrealized_r": event.get("unrealized_r"),
                "mfe_pts": event.get("mfe_pts"),
                "mae_pts": event.get("mae_pts"),
                "atr_at_entry": event.get("atr_at_entry"),
            }

            row = build_row(
                pseudo_tick, trade, events_before,
                f"mgmt_{event.get('event_type', 'unknown')}",
                -1, total_ticks,
            )
            # Enrich with LOB/MBO features
            evt_ts_ms = int((parse_iso(evt_ts) or 0) * 1000)
            enrich_row_with_lob(row, evt_ts_ms, tid, lob_by_trade, runtime_by_trade)
            row["management_event_type"] = event.get("event_type")
            row["trail_distance_pts_at_event"] = safe_float(event.get("trail_distance_pts"))
            row["stop_before_event"] = safe_float(event.get("stop_before"))
            row["stop_after_event"] = safe_float(event.get("stop_after"))
            row["quantity_before_event"] = safe_float(event.get("quantity_before"))
            row["quantity_after_event"] = safe_float(event.get("quantity_after"))
            row["pt1_trigger_pts"] = safe_float(event.get("pt1_trigger_pts"))
            row["pt2_trigger_pts"] = safe_float(event.get("pt2_trigger_pts"))
            rows.append(row)

    # Sort final dataset by trade_id + timestamp
    rows.sort(key=lambda r: (r.get("trade_id", ""), r.get("timestamp", "")))

    print(f"[DATASET] Trades processed: {trades_processed}, skipped (no path data): {trades_skipped}")
    print(f"[DATASET] Total rows: {len(rows)}")
    print(f"[DATASET] Row types: {dict(sorted(count_values(rows, 'row_type').items()))}")

    return rows


def count_values(rows: list[dict], key: str) -> dict[str, int]:
    """Count occurrences of each value for a given key."""
    counts: dict[str, int] = {}
    for r in rows:
        v = str(r.get(key, ""))
        counts[v] = counts.get(v, 0) + 1
    return counts


# ─── Schema metadata ─────────────────────────────────────────────────────────

SCHEMA: dict[str, dict[str, str]] = {
    # Identity
    "trade_id":                     {"type": "string",  "category": "identity",  "description": "Unique trade identifier"},
    "timestamp":                    {"type": "string",  "category": "identity",  "description": "ISO timestamp of this decision point"},
    "row_type":                     {"type": "string",  "category": "identity",  "description": "Type: entry | tick | management_event | pre_exit | mgmt_*"},
    "tick_index":                   {"type": "int",     "category": "identity",  "description": "Index of this tick within the trade (0-based, -1 for event-only rows)"},
    "total_ticks":                  {"type": "int",     "category": "identity",  "description": "Total ticks recorded for this trade"},
    "tick_progress":                {"type": "float",   "category": "identity",  "description": "Normalized position in trade timeline (0.0 to 1.0)"},
    # Trade context
    "side":                         {"type": "string",  "category": "context",   "description": "Trade direction: long | short"},
    "is_short":                     {"type": "int",     "category": "context",   "description": "1 if short, 0 if long"},
    "setup_type":                   {"type": "string",  "category": "context",   "description": "Setup type that generated entry signal"},
    "management_profile":           {"type": "string",  "category": "context",   "description": "Management profile name used for this trade"},
    "management_variant":           {"type": "string",  "category": "context",   "description": "Management variant label for A/B comparison"},
    "regime_at_entry":              {"type": "string",  "category": "context",   "description": "Market regime classification at entry"},
    "confidence_at_entry":          {"type": "float",   "category": "context",   "description": "Signal confidence score at entry (0-10)"},
    "atr_at_entry":                 {"type": "float",   "category": "context",   "description": "ATR(14) at entry time in points"},
    "entry_price":                  {"type": "float",   "category": "context",   "description": "Entry fill price"},
    "stop_initial":                 {"type": "float",   "category": "context",   "description": "Initial stop-loss price at entry"},
    "initial_risk_pts":             {"type": "float",   "category": "context",   "description": "Distance from entry to initial stop in points"},
    "target_1":                     {"type": "float",   "category": "context",   "description": "Structural target 1 price (from strategy)"},
    "target_2":                     {"type": "float",   "category": "context",   "description": "Structural target 2 price (from strategy)"},
    "quantity_original":            {"type": "int",     "category": "context",   "description": "Original position size at entry"},
    # Current state
    "current_price":                {"type": "float",   "category": "feature",   "description": "Price at this decision point"},
    "stop_current":                 {"type": "float",   "category": "feature",   "description": "Current stop-loss price"},
    "quantity_remaining":           {"type": "float",   "category": "feature",   "description": "Contracts remaining after any partials"},
    "pnl_pts":                      {"type": "float",   "category": "feature",   "description": "Unrealized PnL in points at this tick"},
    "unrealized_r":                 {"type": "float",   "category": "feature",   "description": "Unrealized R-multiple at this tick"},
    "mfe_pts_so_far":               {"type": "float",   "category": "feature",   "description": "Max favorable excursion so far (points)"},
    "mae_pts_so_far":               {"type": "float",   "category": "feature",   "description": "Max adverse excursion so far (points)"},
    "time_in_trade_sec":            {"type": "int",     "category": "feature",   "description": "Seconds since entry"},
    "distance_to_stop_pts":         {"type": "float",   "category": "feature",   "description": "Distance from current price to current stop (points)"},
    # ATR-normalized
    "pnl_atr":                      {"type": "float",   "category": "feature",   "description": "Unrealized PnL normalized by ATR at entry"},
    "mfe_atr":                      {"type": "float",   "category": "feature",   "description": "MFE normalized by ATR at entry"},
    "mae_atr":                      {"type": "float",   "category": "feature",   "description": "MAE normalized by ATR at entry"},
    "distance_to_stop_atr":         {"type": "float",   "category": "feature",   "description": "Distance to stop normalized by ATR at entry"},
    # Management state
    "pt1_hit":                      {"type": "int",     "category": "feature",   "description": "1 if PT1 partial has been taken (causal)"},
    "pt2_hit":                      {"type": "int",     "category": "feature",   "description": "1 if PT2 partial has been taken (causal)"},
    "stop_at_breakeven":            {"type": "int",     "category": "feature",   "description": "1 if stop has been moved to breakeven"},
    "trail_active":                 {"type": "int",     "category": "feature",   "description": "1 if trailing stop is active"},
    "trail_ratchet_count":          {"type": "int",     "category": "feature",   "description": "Number of trail ratchets so far"},
    "management_events_count":      {"type": "int",     "category": "feature",   "description": "Total management events before this tick"},
    # Enriched tick fields (newer data only)
    "pt1_done_flag":                {"type": "int",     "category": "feature",   "description": "PT1 done flag from enriched tick (null if not available)"},
    "pt2_done_flag":                {"type": "int",     "category": "feature",   "description": "PT2 done flag from enriched tick"},
    "pre_t1_be_triggered_flag":     {"type": "int",     "category": "feature",   "description": "Pre-T1 breakeven triggered flag"},
    "pre_t1_trailing_active_flag":  {"type": "int",     "category": "feature",   "description": "Pre-T1 trailing active flag"},
    "trailing_active_flag":         {"type": "int",     "category": "feature",   "description": "Trailing stop active flag from tick"},
    "trail_distance_ticks":         {"type": "float",   "category": "feature",   "description": "Trail distance in ticks from enriched tick"},
    # Session
    "entry_hour_utc":               {"type": "int",     "category": "feature",   "description": "Hour of entry (UTC)"},
    "tick_hour_utc":                {"type": "int",     "category": "feature",   "description": "Hour of this tick (UTC)"},
    # Management event extras
    "management_event_type":        {"type": "string",  "category": "event",     "description": "Event type (pt1_trigger, trail_ratchet, etc.) — only for event rows"},
    "trail_distance_pts_at_event":  {"type": "float",   "category": "event",     "description": "Trail distance in pts at management event"},
    "stop_before_event":            {"type": "float",   "category": "event",     "description": "Stop before management event"},
    "stop_after_event":             {"type": "float",   "category": "event",     "description": "Stop after management event"},
    "quantity_before_event":        {"type": "float",   "category": "event",     "description": "Quantity before management event"},
    "quantity_after_event":         {"type": "float",   "category": "event",     "description": "Quantity after management event"},
    "pt1_trigger_pts":              {"type": "float",   "category": "event",     "description": "PT1 trigger distance in pts (from profile)"},
    "pt2_trigger_pts":              {"type": "float",   "category": "event",     "description": "PT2 trigger distance in pts (from profile)"},
    # LOB/MBO features (from LOB join or runtime exact payloads)
    "lob_spread_ticks":               {"type": "float",   "category": "feature",   "description": "LOB: bid-ask spread in ticks"},
    "lob_bid_size":                   {"type": "float",   "category": "feature",   "description": "LOB: top-of-book bid size"},
    "lob_ask_size":                   {"type": "float",   "category": "feature",   "description": "LOB: top-of-book ask size"},
    "lob_depth_imbalance_5":          {"type": "float",   "category": "feature",   "description": "LOB: 5-level depth imbalance"},
    "lob_depth_imbalance_10":         {"type": "float",   "category": "feature",   "description": "LOB: 10-level depth imbalance"},
    "lob_total_bid_depth_10lvl":      {"type": "float",   "category": "feature",   "description": "LOB: total bid depth 10 levels"},
    "lob_total_ask_depth_10lvl":      {"type": "float",   "category": "feature",   "description": "LOB: total ask depth 10 levels"},
    "lob_cumulative_delta_10s":       {"type": "float",   "category": "feature",   "description": "LOB: cumulative delta 10s window"},
    "lob_cumulative_delta_30s":       {"type": "float",   "category": "feature",   "description": "LOB: cumulative delta 30s window"},
    "lob_cumulative_delta_60s":       {"type": "float",   "category": "feature",   "description": "LOB: cumulative delta 60s window"},
    "lob_trade_flow_imbalance_10s":   {"type": "float",   "category": "feature",   "description": "LOB: trade flow imbalance 10s"},
    "lob_trade_flow_imbalance_30s":   {"type": "float",   "category": "feature",   "description": "LOB: trade flow imbalance 30s"},
    "lob_cancel_add_ratio_10s":       {"type": "float",   "category": "feature",   "description": "LOB: cancel/add ratio 10s"},
    "lob_replenishment_rate_10s":     {"type": "float",   "category": "feature",   "description": "LOB: replenishment rate 10s"},
    "lob_absorption_rate_10s":        {"type": "float",   "category": "feature",   "description": "LOB: absorption rate 10s"},
    "lob_sweep_count_10s":            {"type": "float",   "category": "feature",   "description": "LOB: sweep count 10s"},
    "adv_cancel_replace_ratio_10s":   {"type": "float",   "category": "feature",   "description": "ADV MBO: cancel/replace ratio 10s"},
    "adv_modify_rate_10s":            {"type": "float",   "category": "feature",   "description": "ADV MBO: order modify rate 10s"},
    "adv_iceberg_suspicion_30s":      {"type": "float",   "category": "feature",   "description": "ADV MBO: iceberg suspicion 30s"},
    "adv_queue_deterioration_bid_10s": {"type": "float",  "category": "feature",   "description": "ADV MBO: bid queue deterioration 10s"},
    "adv_queue_deterioration_ask_10s": {"type": "float",  "category": "feature",   "description": "ADV MBO: ask queue deterioration 10s"},
    "adv_pull_cascade_count_10s":     {"type": "float",   "category": "feature",   "description": "ADV MBO: pull cascade count 10s"},
    "adv_lifetime_p50_ms":            {"type": "float",   "category": "feature",   "description": "ADV MBO: median order lifetime ms"},
    # LOB join provenance metadata
    "_lob_data_source":               {"type": "string",  "category": "meta",      "description": "Data source: runtime_exact | joined_from_lob_logs | position_only"},
    "_lob_join_delta_ms":             {"type": "int",     "category": "meta",      "description": "Timestamp delta of LOB join in ms"},
    "_lob_join_method":               {"type": "string",  "category": "meta",      "description": "Join method: runtime_exact | trade_id_nearest | no_match"},
    "_lob_join_success":              {"type": "bool",    "category": "meta",      "description": "Whether a usable LOB snapshot was found"},
    "_lob_data_quality":              {"type": "string",  "category": "meta",      "description": "LOB data quality from snapshot"},
    "_lob_bbo_age_ms":                {"type": "int",     "category": "meta",      "description": "BBO age from LOB snapshot"},
    "_lob_snapshot_ts_ms":            {"type": "int",     "category": "meta",      "description": "Exact timestamp of matched LOB snapshot"},
    "_lob_snapshot_source_file":      {"type": "string",  "category": "meta",      "description": "Source file of matched LOB snapshot"},
    # Labels (FUTURE — supervised learning targets)
    "label_final_r":                {"type": "float",   "category": "label",     "description": "LABEL: Final R-multiple of the trade"},
    "label_outcome":                {"type": "string",  "category": "label",     "description": "LABEL: winner | loser | scratch"},
    "label_exit_reason":            {"type": "string",  "category": "label",     "description": "LABEL: Final exit reason"},
    "label_hold_time_total_sec":    {"type": "int",     "category": "label",     "description": "LABEL: Total trade hold time in seconds"},
    "label_final_pnl_usd":         {"type": "float",   "category": "label",     "description": "LABEL: Final realized PnL in USD"},
    "label_max_unrealized_r":       {"type": "float",   "category": "label",     "description": "LABEL: Peak unrealized R during trade"},
    "label_mfe_total":              {"type": "float",   "category": "label",     "description": "LABEL: Total MFE of the trade (points)"},
    "label_mae_total":              {"type": "float",   "category": "label",     "description": "LABEL: Total MAE of the trade (points)"},
    "label_mfe_at_pt1":             {"type": "float",   "category": "label",     "description": "LABEL: MFE at PT1 trigger"},
    "label_mfe_after_pt1":          {"type": "float",   "category": "label",     "description": "LABEL: Additional MFE after PT1"},
    "label_runner_capture_ratio":   {"type": "float",   "category": "label",     "description": "LABEL: Fraction of post-PT1 opportunity captured"},
    "label_giveback_r":             {"type": "float",   "category": "label",     "description": "LABEL: R given back after peak (peak_r - final_r)"},
}

# Columns that are labels (must be excluded from model features)
LABEL_COLUMNS = [k for k in SCHEMA if k.startswith("label_")]

# Columns that are identity/metadata (not features)
IDENTITY_COLUMNS = [k for k, v in SCHEMA.items() if v["category"] == "identity"]

# Columns that are actual features for modeling
FEATURE_COLUMNS = [k for k, v in SCHEMA.items() if v["category"] in ("context", "feature")]


# ─── Output writers ───────────────────────────────────────────────────────────

def write_csv(rows: list[dict], path: str) -> None:
    """Write rows to CSV. Uses all keys from SCHEMA as column order."""
    if not rows:
        print("[DATASET] No rows to write.")
        return

    # Use schema order, then any extra columns
    columns = list(SCHEMA.keys())
    extra = sorted(set().union(*(r.keys() for r in rows)) - set(columns))
    columns.extend(extra)

    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)

    print(f"[DATASET] Written {len(rows)} rows to {path}")


def write_parquet(rows: list[dict], path: str) -> None:
    """Write rows to Parquet if pandas + pyarrow are available."""
    try:
        import pandas as pd
        df = pd.DataFrame(rows)
        df.to_parquet(path, index=False, engine="pyarrow")
        print(f"[DATASET] Written {len(rows)} rows to {path}")
    except ImportError:
        print("[DATASET] pandas/pyarrow not installed — skipping .parquet output.")
        print("          Install with: pip install pandas pyarrow")


def write_schema(path: str, row_count: int, trade_count: int) -> None:
    """Write schema metadata JSON."""
    meta = {
        "description": "Management decision-point dataset for NQ/MNQ autotrade system",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "row_count": row_count,
        "trade_count": trade_count,
        "total_columns": len(SCHEMA),
        "feature_columns": FEATURE_COLUMNS,
        "label_columns": LABEL_COLUMNS,
        "identity_columns": IDENTITY_COLUMNS,
        "leakage_warning": "All columns prefixed with 'label_' contain future information and MUST be excluded from model features during training.",
        "missing_fields_note": "Older trades may have null values for enriched fields (pt1_done_flag, atr_at_entry, etc.). These are documented honestly — do not impute without understanding the data generation timeline.",
        "columns": SCHEMA,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"[DATASET] Schema written to {path}")


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Build management ML dataset from trade logs")
    parser.add_argument("--log-dir", default="./logs", help="Directory containing trades.jsonl and trade_path.jsonl")
    parser.add_argument("--out-dir", default="./data", help="Output directory for dataset files")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    print(f"[DATASET] Reading logs from: {args.log_dir}")
    rows = build_dataset(args.log_dir)

    if not rows:
        print("[DATASET] No data to write. Check that logs/trades.jsonl and logs/trade_path.jsonl exist and have matching trade_ids.")
        sys.exit(1)

    # Count unique trades
    trade_ids = set(r.get("trade_id") for r in rows)

    # Write outputs
    csv_path = os.path.join(args.out_dir, "management_dataset.csv")
    write_csv(rows, csv_path)

    parquet_path = os.path.join(args.out_dir, "management_dataset.parquet")
    write_parquet(rows, parquet_path)

    schema_path = os.path.join(args.out_dir, "management_dataset_schema.json")
    write_schema(schema_path, len(rows), len(trade_ids))

    # Summary stats
    print(f"\n[DATASET] Summary:")
    print(f"  Trades:       {len(trade_ids)}")
    print(f"  Total rows:   {len(rows)}")
    print(f"  Features:     {len(FEATURE_COLUMNS)}")
    print(f"  Labels:       {len(LABEL_COLUMNS)}")
    print(f"  Row types:    {dict(sorted(count_values(rows, 'row_type').items()))}")

    # ── Feature coverage by family (from registry) ────────────────────────
    print(f"\n[DATASET] Feature coverage by family:")
    print(f"  {'Family':<20s} {'Features':>8s} {'Avg Non-Null %':>15s} {'Min Col %':>10s} {'Max Col %':>10s}")
    print(f"  {'-'*20} {'-'*8} {'-'*15} {'-'*10} {'-'*10}")
    for family, feat_names in FEATURE_FAMILIES.items():
        # Only report features that are in the dataset
        dataset_feats = [f for f in feat_names if f in SCHEMA]
        if not dataset_feats:
            continue
        coverages = []
        for col in dataset_feats:
            non_null = sum(1 for r in rows if r.get(col) is not None)
            coverages.append(round(non_null / len(rows) * 100, 1))
        avg_cov = round(sum(coverages) / len(coverages), 1) if coverages else 0.0
        min_cov = min(coverages) if coverages else 0.0
        max_cov = max(coverages) if coverages else 0.0
        print(f"  {family:<20s} {len(dataset_feats):>8d} {avg_cov:>14.1f}% {min_cov:>9.1f}% {max_cov:>9.1f}%")

    # ── LOB provenance breakdown ──────────────────────────────────────────
    provenance_counts: dict[str, int] = {}
    for r in rows:
        src = r.get("_lob_data_source", "unknown")
        provenance_counts[src] = provenance_counts.get(src, 0) + 1
    print(f"\n[DATASET] LOB provenance breakdown:")
    for src in ["runtime_exact", "joined_from_lob_logs", "position_only"]:
        count = provenance_counts.get(src, 0)
        pct = round(count / len(rows) * 100, 1)
        print(f"  {src:<30s} {count:>6d}  ({pct:.1f}%)")

    # ── Join quality metrics ──────────────────────────────────────────────
    join_deltas = [r.get("_lob_join_delta_ms") for r in rows if r.get("_lob_join_delta_ms") is not None]
    if join_deltas:
        avg_delta = round(sum(join_deltas) / len(join_deltas), 0)
        max_delta = max(join_deltas)
        join_successes = sum(1 for r in rows if r.get("_lob_join_success"))
        print(f"\n[DATASET] LOB join quality:")
        print(f"  Avg join delta: {avg_delta:.0f}ms")
        print(f"  Max join delta: {max_delta}ms")
        print(f"  Join success rate: {round(join_successes / len(rows) * 100, 1)}%")

    # ── Per-column coverage for LOB features ──────────────────────────────
    all_lob = LOB_NUMERIC_FEATURES + ADVANCED_MBO_FEATURES
    print(f"\n[DATASET] LOB/MBO feature coverage (per-column):")
    for col in all_lob:
        non_null = sum(1 for r in rows if r.get(col) is not None)
        pct = round(non_null / len(rows) * 100, 1)
        print(f"  {col:45s} {pct:6.1f}%  ({non_null}/{len(rows)})")

    # Warn if required families have very low coverage
    for family in ["lob_bbo", "lob_flow"]:
        feats = FEATURE_FAMILIES.get(family, [])
        if feats:
            avg = sum(
                sum(1 for r in rows if r.get(f) is not None) / len(rows) * 100
                for f in feats
            ) / len(feats)
            if avg < 10.0:
                print(f"\n  ⚠ WARNING: {family} family has only {avg:.1f}% average coverage")


if __name__ == "__main__":
    main()
