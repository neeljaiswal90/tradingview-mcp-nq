#!/usr/bin/env python3
"""
label_management_dataset.py — Add supervised-learning labels to the
management decision-point dataset.

Reads:  data/management_dataset.csv  (from build_management_dataset.py)
Writes: data/management_dataset_labeled.csv
        data/management_labels_schema.json

Label groups:
  1. Continuation labels    — will the trade reach favorable thresholds?
  2. Hold-vs-exit value     — what R is realized if we hold / exit / reduce now?
  3. Runner quality         — how does the runner perform after PT1?
  4. Stop-adjustment utility — did tightening/loosening the stop help?

Anti-leakage controls:
  - Labels are computed from FUTURE ticks within the SAME trade only
  - Labels are clearly prefixed with 'sl_' (supervised label)
  - Original feature columns are never modified
  - Forward windows are defined in tick-count or seconds, documented precisely
  - Rows where a forward window extends past trade end are marked, not dropped

Usage:
  python scripts/ml/label_management_dataset.py [--input data/management_dataset.csv]
                                                 [--out-dir data/]
                                                 [--window-sec 30,60,120]

Requires: Python 3.8+ (stdlib only).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any


# ─── Helpers ──────────────────────────────────────────────────────────────────

def safe_float(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def safe_int(val: Any) -> int | None:
    if val is None or val == "":
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def parse_iso(ts: str | None) -> float | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


# ─── Label computation ────────────────────────────────────────────────────────

def compute_labels(
    rows_by_trade: dict[str, list[dict]],
    window_seconds: list[int],
) -> list[dict]:
    """
    For each row in the dataset, compute forward-looking labels using
    ONLY future ticks within the same trade.

    Returns the full row list with new 'sl_' prefixed columns appended.
    """
    labeled_rows: list[dict] = []
    stats = {
        "total_rows": 0,
        "labeled_rows": 0,
        "trades_processed": 0,
        "rows_past_trade_end": 0,
    }

    for trade_id, trade_rows in rows_by_trade.items():
        stats["trades_processed"] += 1

        # Sort by timestamp within trade
        trade_rows.sort(key=lambda r: r.get("timestamp", ""))

        # Parse timestamps and key values for the full trade timeline
        timeline: list[dict] = []
        for r in trade_rows:
            timeline.append({
                "epoch": parse_iso(r.get("timestamp")),
                "time_sec": safe_int(r.get("time_in_trade_sec")),
                "unrealized_r": safe_float(r.get("unrealized_r")),
                "pnl_pts": safe_float(r.get("pnl_pts")),
                "mfe_pts": safe_float(r.get("mfe_pts_so_far")),
                "mae_pts": safe_float(r.get("mae_pts_so_far")),
                "stop_current": safe_float(r.get("stop_current")),
                "current_price": safe_float(r.get("current_price")),
                "entry_price": safe_float(r.get("entry_price")),
                "pt1_hit": safe_int(r.get("pt1_hit")),
                "quantity_remaining": safe_float(r.get("quantity_remaining")),
            })

        # Trade-level data (constant across all rows of this trade)
        final_r = safe_float(trade_rows[0].get("label_final_r"))
        final_mfe = safe_float(trade_rows[0].get("label_mfe_total"))
        final_mae = safe_float(trade_rows[0].get("label_mae_total"))
        final_outcome = trade_rows[0].get("label_outcome")
        exit_reason = trade_rows[0].get("label_exit_reason")
        max_r = safe_float(trade_rows[0].get("label_max_unrealized_r"))
        hold_total_sec = safe_int(trade_rows[0].get("label_hold_time_total_sec"))
        label_mfe_after_pt1 = safe_float(trade_rows[0].get("label_mfe_after_pt1"))
        label_runner_capture = safe_float(trade_rows[0].get("label_runner_capture_ratio"))
        label_giveback_r = safe_float(trade_rows[0].get("label_giveback_r"))
        initial_risk_pts = safe_float(trade_rows[0].get("initial_risk_pts"))
        side = trade_rows[0].get("side")
        is_short = side == "short"

        n = len(trade_rows)

        for i, row in enumerate(trade_rows):
            stats["total_rows"] += 1
            labels: dict[str, Any] = {}

            cur = timeline[i]
            cur_epoch = cur["epoch"]
            cur_time_sec = cur["time_sec"]
            cur_r = cur["unrealized_r"]
            cur_mfe = cur["mfe_pts"]
            cur_mae = cur["mae_pts"]
            cur_stop = cur["stop_current"]
            cur_price = cur["current_price"]
            cur_pt1 = cur["pt1_hit"]

            # Future ticks: everything after index i in this trade
            future = timeline[i + 1:]

            # ════════════════════════════════════════════════════════════════
            # GROUP 1: CONTINUATION LABELS
            # ════════════════════════════════════════════════════════════════

            # 1a. remaining_r: how much additional R is earned from this point to trade end
            if cur_r is not None and final_r is not None:
                labels["sl_remaining_r"] = round(final_r - cur_r, 4)
            else:
                labels["sl_remaining_r"] = None

            # 1b. future_mfe_pts: max favorable excursion AFTER this tick (within same trade)
            future_prices = [f["current_price"] for f in future if f["current_price"] is not None]
            if future_prices and cur_price is not None:
                if is_short:
                    future_mfe_pts = round(cur_price - min(future_prices), 2)
                else:
                    future_mfe_pts = round(max(future_prices) - cur_price, 2)
                labels["sl_future_mfe_pts"] = max(0, future_mfe_pts)
            else:
                labels["sl_future_mfe_pts"] = None

            # 1c. future_mae_pts: max adverse excursion AFTER this tick
            if future_prices and cur_price is not None:
                if is_short:
                    future_mae_pts = round(max(future_prices) - cur_price, 2)
                else:
                    future_mae_pts = round(cur_price - min(future_prices), 2)
                labels["sl_future_mae_pts"] = max(0, future_mae_pts)
            else:
                labels["sl_future_mae_pts"] = None

            # 1d. hit_pt1_eventually: does PT1 fire at some point after this tick?
            future_pt1 = any(f["pt1_hit"] == 1 for f in future)
            labels["sl_hit_pt1_eventually"] = 1 if (cur_pt1 == 1 or future_pt1) else 0

            # 1e. hit_pt2_before_stop: does PT2 fire before trade ends?
            # (approximated: if any future row shows quantity dropped further after pt1)
            future_qty = [f["quantity_remaining"] for f in future if f["quantity_remaining"] is not None]
            cur_qty = cur["quantity_remaining"]
            if cur_qty is not None and future_qty:
                min_future_qty = min(future_qty)
                # If quantity drops by more than 1 unit after current, PT2 likely fired
                labels["sl_hit_pt2_before_stop"] = 1 if (cur_qty - min_future_qty) > 1.5 else 0
            else:
                labels["sl_hit_pt2_before_stop"] = None

            # 1f. Window-based continuation: does R improve by at least X in next N seconds?
            for window_sec in window_seconds:
                window_future = [
                    f for f in future
                    if f["time_sec"] is not None and cur_time_sec is not None
                    and f["time_sec"] <= cur_time_sec + window_sec
                ]
                if window_future and cur_r is not None:
                    best_r_in_window = max(
                        (f["unrealized_r"] for f in window_future if f["unrealized_r"] is not None),
                        default=None,
                    )
                    worst_r_in_window = min(
                        (f["unrealized_r"] for f in window_future if f["unrealized_r"] is not None),
                        default=None,
                    )
                    end_r = window_future[-1]["unrealized_r"]

                    labels[f"sl_best_r_next_{window_sec}s"] = round(best_r_in_window, 4) if best_r_in_window is not None else None
                    labels[f"sl_worst_r_next_{window_sec}s"] = round(worst_r_in_window, 4) if worst_r_in_window is not None else None
                    labels[f"sl_end_r_next_{window_sec}s"] = round(end_r, 4) if end_r is not None else None
                    labels[f"sl_r_improves_next_{window_sec}s"] = (
                        1 if (best_r_in_window is not None and best_r_in_window > cur_r + 0.05) else 0
                    )
                    labels[f"sl_window_{window_sec}s_complete"] = 1  # full window available
                else:
                    labels[f"sl_best_r_next_{window_sec}s"] = None
                    labels[f"sl_worst_r_next_{window_sec}s"] = None
                    labels[f"sl_end_r_next_{window_sec}s"] = None
                    labels[f"sl_r_improves_next_{window_sec}s"] = None
                    labels[f"sl_window_{window_sec}s_complete"] = 0
                    if window_future is not None and len(window_future) == 0 and len(future) > 0:
                        stats["rows_past_trade_end"] += 1

            # ════════════════════════════════════════════════════════════════
            # GROUP 2: HOLD-VS-EXIT VALUE LABELS
            # ════════════════════════════════════════════════════════════════

            # 2a. r_if_hold_to_end: the R you'd realize by holding to trade end
            labels["sl_r_if_hold_to_end"] = final_r

            # 2b. r_if_exit_now: the R you'd realize by exiting at current price
            labels["sl_r_if_exit_now"] = cur_r

            # 2c. hold_advantage_r: how much better is holding vs exiting now?
            if cur_r is not None and final_r is not None:
                labels["sl_hold_advantage_r"] = round(final_r - cur_r, 4)
            else:
                labels["sl_hold_advantage_r"] = None

            # 2d. hold_is_better: binary — was holding better than exiting now?
            if cur_r is not None and final_r is not None:
                labels["sl_hold_is_better"] = 1 if final_r > cur_r else 0
            else:
                labels["sl_hold_is_better"] = None

            # 2e. peak_r_remaining: max R still achievable after this point
            future_rs = [f["unrealized_r"] for f in future if f["unrealized_r"] is not None]
            if future_rs:
                labels["sl_peak_r_remaining"] = round(max(future_rs), 4)
            else:
                labels["sl_peak_r_remaining"] = final_r  # at trade end, peak = final

            # 2f. trough_r_remaining: worst R before trade end (risk of holding)
            if future_rs:
                labels["sl_trough_r_remaining"] = round(min(future_rs), 4)
            else:
                labels["sl_trough_r_remaining"] = final_r

            # 2g. exit_urgency: 1 if holding led to significantly worse outcome (final_r < cur_r - 0.3)
            if cur_r is not None and final_r is not None:
                labels["sl_exit_was_urgent"] = 1 if final_r < cur_r - 0.3 else 0
            else:
                labels["sl_exit_was_urgent"] = None

            # ════════════════════════════════════════════════════════════════
            # GROUP 3: RUNNER QUALITY LABELS (post-PT1)
            # ════════════════════════════════════════════════════════════════

            # These labels are only meaningful when pt1 has fired
            if cur_pt1 == 1:
                # 3a. runner_continues: did the trade make at least 0.1R more after this point?
                if cur_r is not None and max_r is not None:
                    labels["sl_runner_continues"] = 1 if (max_r - cur_r) > 0.1 else 0
                else:
                    labels["sl_runner_continues"] = None

                # 3b. runner_giveback_r: how much R was given back from peak to final
                if max_r is not None and final_r is not None:
                    labels["sl_runner_giveback_r"] = round(max_r - final_r, 4)
                else:
                    labels["sl_runner_giveback_r"] = None

                # 3c. enough_post_pt1_followthrough: was there meaningful movement after PT1?
                # Defined as: future MFE > 0.5 × initial_risk_pts
                if labels.get("sl_future_mfe_pts") is not None and initial_risk_pts and initial_risk_pts > 0:
                    labels["sl_enough_followthrough"] = (
                        1 if labels["sl_future_mfe_pts"] > 0.5 * initial_risk_pts else 0
                    )
                else:
                    labels["sl_enough_followthrough"] = None

                # 3d. runner_capture_vs_opportunity: what fraction of remaining opportunity was captured?
                if labels.get("sl_future_mfe_pts") is not None and labels["sl_future_mfe_pts"] > 0:
                    remaining_captured_pts = safe_float(row.get("pnl_pts"))
                    if remaining_captured_pts is not None and final_r is not None and cur_r is not None:
                        remaining_r = final_r - cur_r
                        peak_remaining_r = labels.get("sl_peak_r_remaining")
                        if peak_remaining_r is not None and peak_remaining_r > 0:
                            labels["sl_runner_capture_frac"] = round(
                                max(0, remaining_r) / peak_remaining_r, 4
                            )
                        else:
                            labels["sl_runner_capture_frac"] = None
                    else:
                        labels["sl_runner_capture_frac"] = None
                else:
                    labels["sl_runner_capture_frac"] = None

                # 3e. Trade-level runner metrics (from trade record, constant per trade)
                labels["sl_trade_runner_capture_ratio"] = label_runner_capture
                labels["sl_trade_giveback_r"] = label_giveback_r
                labels["sl_trade_mfe_after_pt1"] = label_mfe_after_pt1
            else:
                labels["sl_runner_continues"] = None
                labels["sl_runner_giveback_r"] = None
                labels["sl_enough_followthrough"] = None
                labels["sl_runner_capture_frac"] = None
                labels["sl_trade_runner_capture_ratio"] = None
                labels["sl_trade_giveback_r"] = None
                labels["sl_trade_mfe_after_pt1"] = None

            # ════════════════════════════════════════════════════════════════
            # GROUP 4: STOP-ADJUSTMENT UTILITY LABELS
            # ════════════════════════════════════════════════════════════════

            # 4a. move_to_be_helped: if stop were moved to entry price now, would it have
            #     captured the exit (i.e., did price EVER go below entry after this point for longs)?
            entry_price = cur.get("entry_price") or safe_float(row.get("entry_price"))
            if entry_price is not None and future_prices and cur_stop is not None:
                # Would BE stop have been hit?
                if is_short:
                    be_would_trigger = any(p >= entry_price for p in future_prices)
                else:
                    be_would_trigger = any(p <= entry_price for p in future_prices)

                # Current stop: would it have been hit?
                if is_short:
                    original_would_trigger = any(p >= cur_stop for p in future_prices)
                else:
                    original_would_trigger = any(p <= cur_stop for p in future_prices)

                # BE helped if: BE triggers AND current stop doesn't (tighter exit captured profit)
                # OR: BE doesn't trigger AND trade runs further
                if cur_r is not None and cur_r > 0:
                    # We're in profit — moving to BE protects it
                    labels["sl_be_move_protects_profit"] = 1 if be_would_trigger else 0
                    labels["sl_be_move_cuts_winner"] = (
                        1 if (be_would_trigger and final_r is not None and final_r > cur_r + 0.2) else 0
                    )
                else:
                    labels["sl_be_move_protects_profit"] = None
                    labels["sl_be_move_cuts_winner"] = None
            else:
                labels["sl_be_move_protects_profit"] = None
                labels["sl_be_move_cuts_winner"] = None

            # 4b. tighter_stop_helped: if stop were X% tighter, would final R improve?
            # Simulate stop 50% closer to current price
            if cur_stop is not None and cur_price is not None and future_prices and initial_risk_pts and initial_risk_pts > 0:
                half_dist = abs(cur_price - cur_stop) * 0.5
                if is_short:
                    tighter_stop = cur_price + half_dist
                else:
                    tighter_stop = cur_price - half_dist

                # Would the tighter stop have been hit?
                if is_short:
                    tighter_hits = [p for p in future_prices if p >= tighter_stop]
                else:
                    tighter_hits = [p for p in future_prices if p <= tighter_stop]

                if tighter_hits:
                    # Tighter stop triggers — compute R at that exit
                    tighter_exit_price = tighter_hits[0]  # first trigger
                    if is_short:
                        tighter_pnl_pts = entry_price - tighter_exit_price if entry_price else 0
                    else:
                        tighter_pnl_pts = tighter_exit_price - entry_price if entry_price else 0
                    tighter_r = round(tighter_pnl_pts / initial_risk_pts, 4)
                    labels["sl_tighter_stop_final_r"] = tighter_r
                    labels["sl_tighter_stop_helped"] = 1 if (final_r is not None and tighter_r > final_r) else 0
                else:
                    # Tighter stop never hit — trade ran to same end
                    labels["sl_tighter_stop_final_r"] = final_r
                    labels["sl_tighter_stop_helped"] = 0
            else:
                labels["sl_tighter_stop_final_r"] = None
                labels["sl_tighter_stop_helped"] = None

            # 4c. wider_stop_survived: if stop were 50% wider, would trade have survived to a better R?
            if cur_stop is not None and cur_price is not None and future_prices and initial_risk_pts and initial_risk_pts > 0:
                extra_dist = abs(cur_price - cur_stop) * 0.5
                if is_short:
                    wider_stop = cur_stop + extra_dist
                else:
                    wider_stop = cur_stop - extra_dist

                # Would the wider stop have been hit?
                if is_short:
                    wider_hits = [p for p in future_prices if p >= wider_stop]
                else:
                    wider_hits = [p for p in future_prices if p <= wider_stop]

                if wider_hits:
                    wider_exit_price = wider_hits[0]
                    if is_short:
                        wider_pnl_pts = entry_price - wider_exit_price if entry_price else 0
                    else:
                        wider_pnl_pts = wider_exit_price - entry_price if entry_price else 0
                    wider_r = round(wider_pnl_pts / initial_risk_pts, 4)
                    labels["sl_wider_stop_final_r"] = wider_r
                else:
                    # Wider stop never hit — trade reached same end or better
                    labels["sl_wider_stop_final_r"] = final_r

                if final_r is not None and labels["sl_wider_stop_final_r"] is not None:
                    labels["sl_wider_stop_helped"] = (
                        1 if labels["sl_wider_stop_final_r"] > final_r else 0
                    )
                else:
                    labels["sl_wider_stop_helped"] = None
            else:
                labels["sl_wider_stop_final_r"] = None
                labels["sl_wider_stop_helped"] = None

            # ════════════════════════════════════════════════════════════════
            # META: ROW VALIDITY FLAGS
            # ════════════════════════════════════════════════════════════════

            labels["sl_is_last_tick"] = 1 if i == n - 1 else 0
            labels["sl_future_ticks_available"] = len(future)
            labels["sl_labels_valid"] = 1 if len(future) > 0 else 0

            # Merge labels into row
            merged = dict(row)
            merged.update(labels)
            labeled_rows.append(merged)
            if len(future) > 0:
                stats["labeled_rows"] += 1

    return labeled_rows, stats


# ─── Schema for new labels ────────────────────────────────────────────────────

LABEL_SCHEMA: dict[str, dict[str, str]] = {
    # Continuation
    "sl_remaining_r":                {"group": "continuation", "type": "float",  "description": "R earned from this point to trade end (final_r - current_r)"},
    "sl_future_mfe_pts":             {"group": "continuation", "type": "float",  "description": "Max favorable excursion in pts AFTER this tick"},
    "sl_future_mae_pts":             {"group": "continuation", "type": "float",  "description": "Max adverse excursion in pts AFTER this tick"},
    "sl_hit_pt1_eventually":         {"group": "continuation", "type": "int",    "description": "1 if PT1 fires at or after this tick"},
    "sl_hit_pt2_before_stop":        {"group": "continuation", "type": "int",    "description": "1 if PT2 fires (quantity drops >1.5 units) after this tick"},
    # Hold vs exit
    "sl_r_if_hold_to_end":           {"group": "hold_vs_exit", "type": "float",  "description": "Final R of the trade (same as label_final_r)"},
    "sl_r_if_exit_now":              {"group": "hold_vs_exit", "type": "float",  "description": "R if exited at current price (same as unrealized_r)"},
    "sl_hold_advantage_r":           {"group": "hold_vs_exit", "type": "float",  "description": "final_r - current_r (positive = holding was better)"},
    "sl_hold_is_better":             {"group": "hold_vs_exit", "type": "int",    "description": "1 if holding to end produced better R than exiting now"},
    "sl_peak_r_remaining":           {"group": "hold_vs_exit", "type": "float",  "description": "Best R achievable after this tick"},
    "sl_trough_r_remaining":         {"group": "hold_vs_exit", "type": "float",  "description": "Worst R after this tick (downside risk of holding)"},
    "sl_exit_was_urgent":            {"group": "hold_vs_exit", "type": "int",    "description": "1 if holding cost >0.3R vs exiting now (final_r < cur_r - 0.3)"},
    # Runner quality (post-PT1 only)
    "sl_runner_continues":           {"group": "runner",       "type": "int",    "description": "1 if trade gains >0.1R after this tick (post-PT1 only)"},
    "sl_runner_giveback_r":          {"group": "runner",       "type": "float",  "description": "R given back from peak to final (post-PT1 only)"},
    "sl_enough_followthrough":       {"group": "runner",       "type": "int",    "description": "1 if future MFE > 0.5 × initial_risk (post-PT1 only)"},
    "sl_runner_capture_frac":        {"group": "runner",       "type": "float",  "description": "Fraction of remaining peak R captured (post-PT1 only)"},
    "sl_trade_runner_capture_ratio": {"group": "runner",       "type": "float",  "description": "Trade-level runner capture ratio (post-PT1 only)"},
    "sl_trade_giveback_r":           {"group": "runner",       "type": "float",  "description": "Trade-level giveback R (post-PT1 only)"},
    "sl_trade_mfe_after_pt1":        {"group": "runner",       "type": "float",  "description": "Trade-level MFE after PT1 in pts (post-PT1 only)"},
    # Stop adjustment
    "sl_be_move_protects_profit":    {"group": "stop_adjust",  "type": "int",    "description": "1 if BE stop would trigger (protecting current profit)"},
    "sl_be_move_cuts_winner":        {"group": "stop_adjust",  "type": "int",    "description": "1 if BE stop would exit a trade that eventually gained 0.2R+ more"},
    "sl_tighter_stop_final_r":       {"group": "stop_adjust",  "type": "float",  "description": "Simulated final R with 50% tighter stop"},
    "sl_tighter_stop_helped":        {"group": "stop_adjust",  "type": "int",    "description": "1 if tighter stop produced better R than actual"},
    "sl_wider_stop_final_r":         {"group": "stop_adjust",  "type": "float",  "description": "Simulated final R with 50% wider stop"},
    "sl_wider_stop_helped":          {"group": "stop_adjust",  "type": "int",    "description": "1 if wider stop produced better R than actual"},
    # Meta
    "sl_is_last_tick":               {"group": "meta",         "type": "int",    "description": "1 if this is the last tick of the trade (labels are degenerate)"},
    "sl_future_ticks_available":     {"group": "meta",         "type": "int",    "description": "Number of future ticks available for label computation"},
    "sl_labels_valid":               {"group": "meta",         "type": "int",    "description": "1 if at least 1 future tick exists (labels are meaningful)"},
}


# ─── Output ───────────────────────────────────────────────────────────────────

def write_csv(rows: list[dict], path: str) -> None:
    if not rows:
        return
    columns = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    print(f"[LABELS] Written {len(rows)} rows to {path}")


def write_schema(path: str, stats: dict, window_seconds: list[int]) -> None:
    # Add window-based labels to schema
    dynamic_labels = {}
    for ws in window_seconds:
        dynamic_labels[f"sl_best_r_next_{ws}s"] = {"group": "continuation", "type": "float", "description": f"Best R in next {ws}s window"}
        dynamic_labels[f"sl_worst_r_next_{ws}s"] = {"group": "continuation", "type": "float", "description": f"Worst R in next {ws}s window"}
        dynamic_labels[f"sl_end_r_next_{ws}s"] = {"group": "continuation", "type": "float", "description": f"R at end of {ws}s window"}
        dynamic_labels[f"sl_r_improves_next_{ws}s"] = {"group": "continuation", "type": "int", "description": f"1 if R improves by >0.05 in next {ws}s"}
        dynamic_labels[f"sl_window_{ws}s_complete"] = {"group": "meta", "type": "int", "description": f"1 if full {ws}s window available"}

    all_labels = {**LABEL_SCHEMA, **dynamic_labels}

    meta = {
        "description": "Supervised learning labels for NQ/MNQ management dataset",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stats": stats,
        "window_seconds": window_seconds,
        "label_prefix": "sl_",
        "label_count": len(all_labels),
        "label_groups": {
            "continuation": [k for k, v in all_labels.items() if v["group"] == "continuation"],
            "hold_vs_exit": [k for k, v in all_labels.items() if v["group"] == "hold_vs_exit"],
            "runner": [k for k, v in all_labels.items() if v["group"] == "runner"],
            "stop_adjust": [k for k, v in all_labels.items() if v["group"] == "stop_adjust"],
            "meta": [k for k, v in all_labels.items() if v["group"] == "meta"],
        },
        "anti_leakage_controls": [
            "All sl_ labels computed from FUTURE ticks within the SAME trade only",
            "No cross-trade information leaks into labels",
            "Window-based labels mark incomplete windows (sl_window_Xs_complete=0)",
            "Last tick of each trade is marked (sl_is_last_tick=1) with degenerate labels",
            "sl_labels_valid=0 when no future ticks exist (exclude from training)",
            "Original feature columns are never modified by the labeling script",
            "Runner labels (sl_runner_*) are null when pt1_hit=0 (not applicable)",
        ],
        "training_guidance": {
            "exclude_from_features": "All columns starting with 'sl_' or 'label_'",
            "filter_valid_rows": "WHERE sl_labels_valid = 1",
            "binary_classification_targets": [
                "sl_hold_is_better", "sl_exit_was_urgent", "sl_runner_continues",
                "sl_enough_followthrough", "sl_r_improves_next_30s",
                "sl_tighter_stop_helped", "sl_wider_stop_helped",
            ],
            "regression_targets": [
                "sl_remaining_r", "sl_hold_advantage_r", "sl_future_mfe_pts",
                "sl_peak_r_remaining", "sl_trough_r_remaining",
            ],
            "runner_analysis_filter": "WHERE pt1_hit = 1 AND sl_labels_valid = 1",
        },
        "labels": all_labels,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"[LABELS] Schema written to {path}")


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Add supervised labels to management dataset")
    parser.add_argument("--input", default="data/management_dataset.csv")
    parser.add_argument("--out-dir", default="data/")
    parser.add_argument("--window-sec", default="30,60,120", help="Comma-separated forward window sizes in seconds")
    args = parser.parse_args()

    window_seconds = [int(x) for x in args.window_sec.split(",")]

    os.makedirs(args.out_dir, exist_ok=True)

    print(f"[LABELS] Reading: {args.input}")
    print(f"[LABELS] Forward windows: {window_seconds}s")

    with open(args.input, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    if not rows:
        print("[LABELS] No rows in input.")
        sys.exit(1)

    # Group by trade
    from collections import defaultdict
    by_trade: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_trade[r["trade_id"]].append(r)

    print(f"[LABELS] Input: {len(rows)} rows, {len(by_trade)} trades")

    labeled, stats = compute_labels(by_trade, window_seconds)

    # Write outputs
    csv_path = os.path.join(args.out_dir, "management_dataset_labeled.csv")
    write_csv(labeled, csv_path)

    schema_path = os.path.join(args.out_dir, "management_labels_schema.json")
    write_schema(schema_path, stats, window_seconds)

    # Summary
    valid = [r for r in labeled if r.get("sl_labels_valid") == 1]
    print(f"\n[LABELS] Summary:")
    print(f"  Total rows:   {len(labeled)}")
    print(f"  Valid rows:   {len(valid)} (have future ticks)")
    print(f"  Invalid:      {len(labeled) - len(valid)} (last tick / no future)")
    print(f"  Trades:       {stats['trades_processed']}")

    # Label distribution for key binary labels
    for col in ["sl_hold_is_better", "sl_exit_was_urgent", "sl_hit_pt1_eventually",
                "sl_runner_continues", "sl_enough_followthrough",
                "sl_tighter_stop_helped", "sl_wider_stop_helped"]:
        ones = sum(1 for r in valid if r.get(col) == 1)
        zeros = sum(1 for r in valid if r.get(col) == 0)
        total = ones + zeros
        if total > 0:
            print(f"  {col:40s} 1:{ones:5d}  0:{zeros:5d}  rate:{round(ones/total*100,1):5.1f}%")
        else:
            print(f"  {col:40s} (no valid data)")


if __name__ == "__main__":
    main()
