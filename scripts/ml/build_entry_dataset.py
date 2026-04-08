#!/usr/bin/env python3
"""
build_entry_dataset.py — Build supervised-learning dataset for entry decisions.

Joins:
  - signals.jsonl (all strategy signals — executed and skipped)
  - rejected_signals.jsonl (near-miss candidates)
  - trades.jsonl (outcomes for executed signals)
  - lob_session_snapshots.jsonl (session-wide Bookmap context)
  - lob_snapshots.jsonl (pre-entry window snapshots)

Labels:
  - entry_quality: 1 if the signal led to a winning trade (or would have)
  - expected_r: final R-multiple of the trade (null for non-executed signals)
  - followthrough_10m: did price move favorably by 1+ ATR within 10 minutes?

Usage:
  python scripts/ml/build_entry_dataset.py [--log-dir ./logs] [--out-dir ./data]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone

# Add sidecar to path for feature registry
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'python-market-data-service'))
from lob_features.entry_feature_registry import (
    ENTRY_ALL_FEATURES, ENTRY_NUMERIC_FEATURES, ENTRY_CATEGORICAL_FEATURES,
    ENTRY_FEATURE_SCHEMA_VERSION, ENTRY_FEATURE_COUNT,
)


def read_jsonl(path):
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


def safe_float(val):
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def parse_iso_ms(ts):
    if not ts:
        return 0
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError):
        return 0


def find_nearest_lob(lob_snaps, target_ts_ms, max_delta_ms=5000):
    """Find the LOB snapshot closest to target timestamp within max_delta_ms."""
    best = None
    best_delta = max_delta_ms + 1
    for snap in lob_snaps:
        snap_ts = snap.get("timestamp_ms", 0)
        delta = abs(snap_ts - target_ts_ms)
        if delta < best_delta:
            best = snap
            best_delta = delta
    return best if best_delta <= max_delta_ms else None


def build_entry_row(signal, trade, lob_snap, snap_context):
    """Build one entry dataset row from a signal + optional trade outcome + LOB context."""
    row = {}

    setup = signal.get("candidate_setup") or {}
    direction = setup.get("direction", signal.get("direction", ""))
    is_short = 1 if direction == "short" else 0

    # ── Signal features ───────────────────────────────────────────────────
    row["direction_is_short"] = is_short
    row["confidence_score"] = safe_float(signal.get("confidence") or setup.get("confidence"))
    row["rr_t1"] = safe_float(setup.get("rr_t1"))
    row["rr_t2"] = safe_float(setup.get("rr_t2"))
    row["risk_pts"] = safe_float(setup.get("risk_pts"))

    bias = signal.get("higher_timeframe_bias") or {}
    row["alignment_score"] = safe_float(bias.get("alignment_score"))
    row["dual_score_margin"] = safe_float(signal.get("dual_score_margin"))

    # Entry location quality: how close is price to entry zone midpoint
    entry_low = safe_float(setup.get("entry_low"))
    entry_high = safe_float(setup.get("entry_high"))
    price = safe_float(signal.get("current_price"))
    if entry_low and entry_high and price and setup.get("risk_pts"):
        entry_mid = (entry_low + entry_high) / 2
        row["entry_location_quality"] = round(abs(price - entry_mid) / float(setup["risk_pts"]), 4)
    else:
        row["entry_location_quality"] = None

    # ── Market structure ──────────────────────────────────────────────────
    ind = signal.get("indicator_snapshot_1m") or {}
    vwap = safe_float(ind.get("vwap"))
    ema9 = safe_float(ind.get("ema_9"))
    ema21 = safe_float(ind.get("ema_21"))
    ema50 = safe_float(ind.get("ema_50"))

    row["price_vs_vwap_pts"] = round(price - vwap, 2) if price and vwap else None
    row["price_vs_ema9_pts"] = round(price - ema9, 2) if price and ema9 else None
    row["price_vs_ema21_pts"] = round(price - ema21, 2) if price and ema21 else None

    if ema9 and ema21 and ema50:
        row["ema_stack_bullish"] = 1 if ema9 > ema21 > ema50 else 0
    else:
        row["ema_stack_bullish"] = None

    st_dir = ind.get("supertrend_direction")
    if st_dir and direction:
        row["supertrend_confirms"] = 1 if (
            (direction == "long" and st_dir == "up") or
            (direction == "short" and st_dir == "down")
        ) else 0
    else:
        row["supertrend_confirms"] = None

    row["atr_14"] = safe_float(ind.get("atr_14"))
    row["rsi_14"] = safe_float(ind.get("rsi_14"))

    kl = signal.get("key_levels") or {}
    or_high = safe_float(kl.get("opening_range_high"))
    or_low = safe_float(kl.get("opening_range_low"))
    s_high = safe_float(kl.get("session_high"))
    s_low = safe_float(kl.get("session_low"))

    row["distance_to_or_high_pts"] = round(or_high - price, 2) if price and or_high else None
    row["distance_to_or_low_pts"] = round(price - or_low, 2) if price and or_low else None
    row["distance_to_session_high_pts"] = round(s_high - price, 2) if price and s_high else None
    row["distance_to_session_low_pts"] = round(price - s_low, 2) if price and s_low else None

    # ── Microstructure from LOB snapshot ──────────────────────────────────
    lob = lob_snap or {}
    row["lob_spread_ticks"] = safe_float(lob.get("spread_ticks"))
    row["lob_depth_imbalance_5"] = safe_float(lob.get("depth_imbalance_5"))
    row["lob_depth_imbalance_10"] = safe_float(lob.get("depth_imbalance_10"))
    row["lob_cumulative_delta_10s"] = safe_float(lob.get("cumulative_delta_10s"))
    row["lob_cumulative_delta_30s"] = safe_float(lob.get("cumulative_delta_30s"))
    row["lob_cumulative_delta_60s"] = safe_float(lob.get("cumulative_delta_60s"))
    row["lob_trade_flow_imbalance_10s"] = safe_float(lob.get("trade_flow_imbalance_10s"))
    row["lob_trade_flow_imbalance_30s"] = safe_float(lob.get("trade_flow_imbalance_30s"))
    row["lob_large_bid_within_5pts"] = 1 if lob.get("large_bid_within_5pts") else (0 if "large_bid_within_5pts" in lob else None)
    row["lob_large_ask_within_5pts"] = 1 if lob.get("large_ask_within_5pts") else (0 if "large_ask_within_5pts" in lob else None)
    row["lob_cancel_add_ratio_10s"] = safe_float(lob.get("cancel_add_ratio_10s"))
    row["lob_absorption_rate_10s"] = safe_float(lob.get("absorption_rate_10s"))
    row["lob_sweep_count_10s"] = safe_float(lob.get("sweep_count_10s"))

    # ── Session context ───────────────────────────────────────────────────
    ts = signal.get("timestamp") or signal.get("timestamp_iso", "")
    if ts:
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            row["hour_utc"] = dt.hour
        except ValueError:
            row["hour_utc"] = None
    else:
        row["hour_utc"] = None

    session = snap_context or {}
    row["minutes_since_rth_open"] = safe_float(session.get("minutes_since_rth_open"))
    row["is_rth"] = 1 if session.get("is_rth") else 0
    row["is_opening_drive_window"] = 1 if (
        session.get("minutes_since_rth_open") is not None and
        float(session.get("minutes_since_rth_open", 999)) <= 15
    ) else 0

    # ── Categoricals ──────────────────────────────────────────────────────
    row["setup_type"] = setup.get("setup_type", signal.get("setup_type", "unknown"))
    row["regime_at_signal"] = signal.get("market_regime", "unknown")

    # ── Identity (not features) ───────────────────────────────────────────
    row["_signal_id"] = signal.get("signal_id", "")
    row["_timestamp"] = ts
    row["_executed"] = 1 if signal.get("execution_occurred") else 0

    # ── Labels (FUTURE — for supervised learning) ─────────────────────────
    if trade:
        row["label_outcome"] = trade.get("outcome_class")
        row["label_r_multiple"] = safe_float(trade.get("r_multiple"))
        row["label_pnl_usd"] = safe_float(trade.get("pnl_realized"))
        row["label_hold_time_sec"] = safe_float(trade.get("hold_time_seconds"))
        row["label_mfe"] = safe_float(trade.get("mfe"))
        row["label_mae"] = safe_float(trade.get("mae"))
        row["label_entry_quality"] = 1 if trade.get("outcome_class") == "winner" else 0
    else:
        row["label_outcome"] = None
        row["label_r_multiple"] = None
        row["label_pnl_usd"] = None
        row["label_hold_time_sec"] = None
        row["label_mfe"] = None
        row["label_mae"] = None
        row["label_entry_quality"] = None

    return row


def main():
    parser = argparse.ArgumentParser(description="Build entry ML dataset")
    parser.add_argument("--log-dir", default="./logs")
    parser.add_argument("--out-dir", default="./data")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    print(f"[ENTRY-DS] Reading logs from: {args.log_dir}")

    signals = read_jsonl(os.path.join(args.log_dir, "signals.jsonl"))
    rejected = read_jsonl(os.path.join(args.log_dir, "rejected_signals.jsonl"))
    trades = read_jsonl(os.path.join(args.log_dir, "trades.jsonl"))
    lob_session = read_jsonl(os.path.join(args.log_dir, "lob_session_snapshots.jsonl"))
    lob_snaps = read_jsonl(os.path.join(args.log_dir, "lob_snapshots.jsonl"))

    all_lob = lob_session + lob_snaps

    print(f"[ENTRY-DS] Signals: {len(signals)}, Rejected: {len(rejected)}, Trades: {len(trades)}")
    print(f"[ENTRY-DS] LOB snapshots: {len(all_lob)}")

    # Index trades by signal_id
    trade_by_signal = {}
    for t in trades:
        sid = t.get("parent_signal_id")
        if sid:
            trade_by_signal[sid] = t

    # Build rows from executed + high-confidence rejected signals
    rows = []

    for sig in signals:
        if not sig.get("candidate_setup"):
            continue

        sig_id = sig.get("signal_id", "")
        sig_ts = parse_iso_ms(sig.get("timestamp"))
        trade = trade_by_signal.get(sig_id)
        lob = find_nearest_lob(all_lob, sig_ts, max_delta_ms=5000)

        session_ctx = sig.get("session") if isinstance(sig.get("session"), dict) else {}
        row = build_entry_row(sig, trade, lob, session_ctx)
        rows.append(row)

    # Also include rejected signals with setups (near-misses for training)
    for rej in rejected:
        if not rej.get("setup_type"):
            continue
        rej_ts = parse_iso_ms(rej.get("timestamp"))
        lob = find_nearest_lob(all_lob, rej_ts, max_delta_ms=5000)
        # Build a minimal signal-like dict from rejected signal
        pseudo_sig = {
            "signal_id": rej.get("signal_id", ""),
            "timestamp": rej.get("timestamp", ""),
            "candidate_setup": {
                "direction": rej.get("direction", ""),
                "setup_type": rej.get("setup_type", ""),
                "risk_pts": rej.get("risk_pts"),
                "rr_t1": rej.get("rr_t1"),
                "rr_t2": rej.get("rr_t2"),
            },
            "confidence": rej.get("confidence"),
            "market_regime": rej.get("regime"),
            "higher_timeframe_bias": {"alignment_score": rej.get("alignment_score")},
            "current_price": rej.get("current_price"),
            "execution_occurred": False,
        }
        row = build_entry_row(pseudo_sig, None, lob, {})
        rows.append(row)

    print(f"[ENTRY-DS] Total rows: {len(rows)} ({sum(1 for r in rows if r['_executed'])} executed)")

    if not rows:
        print("[ENTRY-DS] No data to write.")
        sys.exit(1)

    # Write CSV
    csv_path = os.path.join(args.out_dir, "entry_dataset.csv")
    columns = [c for c in rows[0].keys()]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)

    print(f"[ENTRY-DS] Written to {csv_path}")

    # Write schema
    schema_path = os.path.join(args.out_dir, "entry_dataset_schema.json")
    schema = {
        "description": "Entry decision dataset for NQ/MNQ autotrade system",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "row_count": len(rows),
        "feature_schema_version": ENTRY_FEATURE_SCHEMA_VERSION,
        "feature_count": ENTRY_FEATURE_COUNT,
        "feature_names": ENTRY_ALL_FEATURES,
        "categorical_features": ENTRY_CATEGORICAL_FEATURES,
        "label_columns": [c for c in columns if c.startswith("label_")],
        "identity_columns": [c for c in columns if c.startswith("_")],
    }
    with open(schema_path, "w", encoding="utf-8") as f:
        json.dump(schema, f, indent=2)

    print(f"[ENTRY-DS] Schema written to {schema_path}")


if __name__ == "__main__":
    main()
