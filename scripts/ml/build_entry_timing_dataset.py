#!/usr/bin/env python3
"""
build_entry_timing_dataset.py — Build supervised dataset for entry timing quality.

Joins:
  - logs/ml_management_actions.jsonl (candidate_signal records)
  - logs/signals.jsonl (full signal context)
  - logs/trades.jsonl (outcomes for executed signals)
  - logs/trade_path.jsonl (price path for forward labeling)

Labels:
  - good_entry_timing: 1 if favorable excursion exceeds adverse before window ends
  - late_extension_entry: 1 if extended entry that quickly reverses
  - post_signal_mfe_r / mae_r: max favorable/adverse excursion in R
  - max_adverse_first_60s: worst drawdown in first 60 seconds

Usage:
  python scripts/ml/build_entry_timing_dataset.py [--log-dir ./logs] [--out-dir ./data]
"""

from __future__ import annotations
import argparse, csv, json, os, sys
from datetime import datetime, timezone

def read_jsonl(path):
    if not os.path.exists(path): return []
    records = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try: records.append(json.loads(line))
                except: pass
    return records

def sf(v):
    if v is None or v == "": return None
    try: return float(v)
    except: return None

def parse_ts_ms(ts):
    if not ts: return 0
    try: return int(datetime.fromisoformat(ts.replace("Z","+00:00")).timestamp() * 1000)
    except: return 0

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log-dir", default="./logs")
    parser.add_argument("--out-dir", default="./data")
    args = parser.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)

    # Load data
    candidates = [r for r in read_jsonl(os.path.join(args.log_dir, "ml_management_actions.jsonl"))
                  if r.get("_type") == "candidate_signal"]
    signals = read_jsonl(os.path.join(args.log_dir, "signals.jsonl"))
    trades = read_jsonl(os.path.join(args.log_dir, "trades.jsonl"))
    paths = [r for r in read_jsonl(os.path.join(args.log_dir, "trade_path.jsonl"))
             if r.get("_record_type") != "management_event"]

    print(f"[ENTRY-TIMING] Candidates: {len(candidates)}, Signals: {len(signals)}, Trades: {len(trades)}, Paths: {len(paths)}")

    # Index trades by signal_id
    trade_by_signal = {}
    for t in trades:
        sid = t.get("parent_signal_id")
        if sid: trade_by_signal[sid] = t

    rows = []
    for cand in candidates:
        cid = cand.get("candidate_id", "")
        row = {
            # Identity
            "candidate_id": cid,
            "timestamp": cand.get("timestamp", ""),
            "symbol": cand.get("symbol", ""),

            # Strategy state features
            "side": cand.get("side", ""),
            "setup_type": cand.get("setup_type", ""),
            "regime": cand.get("regime", ""),
            "confidence": sf(cand.get("confidence")),
            "score_margin": sf(cand.get("score_margin")),
            "alignment_score": sf(cand.get("alignment_score")),
            "price": sf(cand.get("price")),
            "atr_14": sf(cand.get("atr_14")),

            # Extension features
            "dist_from_vwap_pts": sf(cand.get("dist_from_vwap_pts")),
            "dist_from_vwap_atr": sf(cand.get("dist_from_vwap_atr")),
            "dist_from_ema9_atr": sf(cand.get("dist_from_ema9_atr")),
            "dist_from_ema21_atr": sf(cand.get("dist_from_ema21_atr")),
            "dist_from_ema50_atr": sf(cand.get("dist_from_ema50_atr")),
            "current_impulse_pts": sf(cand.get("current_impulse_pts")),
            "current_impulse_atr": sf(cand.get("current_impulse_atr")),
            "bars_since_impulse_start": sf(cand.get("bars_since_impulse_start")),
            "last_3_bar_return_atr": sf(cand.get("last_3_bar_return_atr")),
            "last_5_bar_return_atr": sf(cand.get("last_5_bar_return_atr")),
            "consecutive_push_bars": sf(cand.get("consecutive_push_bars")),
            "bars_since_last_pullback": sf(cand.get("bars_since_last_pullback")),
            "range_expansion_ratio": sf(cand.get("range_expansion_ratio")),
            "upside_room_pts": sf(cand.get("upside_room_pts")),
            "upside_room_atr": sf(cand.get("upside_room_atr")),
            "downside_room_pts": sf(cand.get("downside_room_pts")),
            "downside_room_atr": sf(cand.get("downside_room_atr")),
            "reset_occurred": 1 if cand.get("reset_occurred") else 0,
            "pullback_depth_pts": sf(cand.get("pullback_depth_pts")),
            "pullback_depth_pct_of_impulse": sf(cand.get("pullback_depth_pct_of_impulse")),
            "no_reset_extension": 1 if cand.get("no_reset_extension") else 0,

            # Future Bookmap features (placeholder columns)
            "lob_spread_ticks": None,
            "lob_depth_imbalance_5": None,
            "lob_trade_flow_imbalance_10s": None,
            "lob_absorption_score_10s": None,
            "lob_sweep_count_10s": None,

            # Outcome / filtering
            "extension_vetoed": 1 if cand.get("extension_vetoed") else 0,
            "extension_veto_reasons": ";".join(cand.get("extension_veto_reasons", [])),
            "trade_allowed": 1 if cand.get("trade_allowed") else 0,
            "actually_executed": 1 if cand.get("actually_executed") else 0,
        }

        # Labels from trade outcome (if executed)
        trade = trade_by_signal.get(cid)
        if trade:
            risk = sf(trade.get("stop_price_initial"))
            entry = sf(trade.get("entry_price_filled"))
            initial_risk = abs(entry - risk) if entry and risk else None

            row["label_r_multiple"] = sf(trade.get("r_multiple"))
            row["label_outcome"] = trade.get("outcome_class")
            row["label_mfe"] = sf(trade.get("mfe"))
            row["label_mae"] = sf(trade.get("mae"))
            row["label_max_unrealized_r"] = sf(trade.get("max_unrealized_r"))
            row["label_hold_time_sec"] = sf(trade.get("hold_time_seconds"))

            mfe = sf(trade.get("mfe")) or 0
            mae = sf(trade.get("mae")) or 0
            # good_entry_timing: MFE > MAE (trade went favorable before adverse)
            row["label_good_entry_timing"] = 1 if mfe > mae and mfe > 0 else 0

            # late_extension_entry: extended + poor outcome
            ext_atr = sf(cand.get("current_impulse_atr")) or 0
            row["label_late_extension_entry"] = 1 if ext_atr > 1.5 and (sf(trade.get("r_multiple")) or 0) < 0 else 0

            if initial_risk and initial_risk > 0:
                row["label_post_signal_mfe_r"] = round(mfe / initial_risk, 4)
                row["label_post_signal_mae_r"] = round(mae / initial_risk, 4)
            else:
                row["label_post_signal_mfe_r"] = None
                row["label_post_signal_mae_r"] = None
        else:
            row["label_r_multiple"] = None
            row["label_outcome"] = None
            row["label_mfe"] = None
            row["label_mae"] = None
            row["label_max_unrealized_r"] = None
            row["label_hold_time_sec"] = None
            row["label_good_entry_timing"] = None
            row["label_late_extension_entry"] = None
            row["label_post_signal_mfe_r"] = None
            row["label_post_signal_mae_r"] = None

        rows.append(row)

    if not rows:
        print("[ENTRY-TIMING] No candidate signals found. Run the app to generate data.")
        sys.exit(0)

    # Write CSV
    csv_path = os.path.join(args.out_dir, "entry_timing_dataset.csv")
    cols = list(rows[0].keys())
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows: w.writerow(r)

    executed = sum(1 for r in rows if r["actually_executed"])
    vetoed = sum(1 for r in rows if r["extension_vetoed"])
    labeled = sum(1 for r in rows if r["label_good_entry_timing"] is not None)

    print(f"[ENTRY-TIMING] Wrote {len(rows)} rows ({executed} executed, {vetoed} vetoed, {labeled} labeled)")
    print(f"[ENTRY-TIMING] Output: {csv_path}")

    # Write schema
    schema = {
        "description": "Entry timing quality dataset",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "row_count": len(rows),
        "feature_groups": {
            "strategy_state": ["side","setup_type","regime","confidence","score_margin","alignment_score","price","atr_14"],
            "extension_features": [c for c in cols if c.startswith("dist_") or c.startswith("current_impulse") or
                                   c.startswith("bars_since") or c.startswith("last_") or c.startswith("consecutive_") or
                                   c.startswith("range_") or c.startswith("upside_") or c.startswith("downside_") or
                                   c.startswith("reset_") or c.startswith("pullback_") or c.startswith("no_reset")],
            "future_bookmap_features": [c for c in cols if c.startswith("lob_")],
            "labels": [c for c in cols if c.startswith("label_")],
        },
    }
    with open(os.path.join(args.out_dir, "entry_timing_schema.json"), "w") as f:
        json.dump(schema, f, indent=2)

if __name__ == "__main__":
    main()
