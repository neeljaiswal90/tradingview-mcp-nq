#!/usr/bin/env python3
"""
Verify that Bookmap trade prices, BBO mids, and session volume-profile levels
all live in the same display-price domain.

Run this after restarting the addon + sidecar on fresh logs.
"""

from __future__ import annotations

import argparse
import bisect
import json
import statistics
import sys
from pathlib import Path


def read_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def nearest_mid(ts_ms: int, snapshot_ts: list[int], mids: list[float]) -> float | None:
    idx = bisect.bisect_left(snapshot_ts, ts_ms)
    best_mid = None
    best_dist = None
    for probe in (idx - 1, idx, idx + 1):
        if 0 <= probe < len(snapshot_ts):
            dist = abs(snapshot_ts[probe] - ts_ms)
            if best_dist is None or dist < best_dist:
                best_dist = dist
                best_mid = mids[probe]
    return best_mid


def summarize(values: list[float]) -> str:
    if not values:
        return "n/a"
    return (
        f"count={len(values)} "
        f"median={statistics.median(values):.2f} "
        f"mean={statistics.fmean(values):.2f} "
        f"max={max(values):.2f}"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--logs-dir", default=str(Path(__file__).resolve().parents[1] / "logs"))
    parser.add_argument("--trade-sample", type=int, default=500)
    parser.add_argument("--snapshot-sample", type=int, default=200)
    parser.add_argument("--max-trade-mid-diff", type=float, default=20.0)
    parser.add_argument("--max-profile-mid-diff", type=float, default=500.0)
    args = parser.parse_args()

    logs_dir = Path(args.logs_dir)
    trades_path = logs_dir / "lob_events_compact.jsonl"
    snapshots_path = logs_dir / "lob_session_snapshots.jsonl"

    if not trades_path.exists() or not snapshots_path.exists():
        print("FAIL missing log files", file=sys.stderr)
        return 1

    snapshot_rows = []
    for row in read_jsonl(snapshots_path):
        ts_ms = row.get("ts")
        if not isinstance(ts_ms, int):
            ts_ms = row.get("timestamp_ms")
        if isinstance(ts_ms, int) and isinstance(row.get("mid"), (int, float)):
            row = dict(row)
            row["ts"] = ts_ms
            snapshot_rows.append(row)
    if not snapshot_rows:
        print("FAIL no timestamped session snapshots with mid", file=sys.stderr)
        return 1

    trade_rows = [
        row for row in read_jsonl(trades_path)
        if row.get("type") == "trade"
        and isinstance(row.get("ts"), int)
        and isinstance(row.get("price"), (int, float))
    ]
    if not trade_rows:
        print("FAIL no trade events", file=sys.stderr)
        return 1

    snapshot_rows = snapshot_rows[-args.snapshot_sample :]
    trade_rows = trade_rows[-args.trade_sample :]
    snapshot_ts = [row["ts"] for row in snapshot_rows]
    mids = [float(row["mid"]) for row in snapshot_rows]

    normalized_trade_diffs: list[float] = []
    raw_trade_diffs: list[float] = []
    for row in trade_rows:
        mid = nearest_mid(row["ts"], snapshot_ts, mids)
        if mid is None:
            continue
        normalized_trade_diffs.append(abs(float(row["price"]) - mid))
        raw_price = row.get("raw_price")
        if isinstance(raw_price, (int, float)):
            raw_trade_diffs.append(abs(float(raw_price) - mid))

    profile_rows = [
        row for row in snapshot_rows
        if isinstance(row.get("mid"), (int, float))
        and any(isinstance(row.get(field), (int, float)) for field in ("session_vpoc", "session_val", "session_vah"))
    ]
    vpoc_diffs = [
        abs(float(row["session_vpoc"]) - float(row["mid"]))
        for row in profile_rows
        if isinstance(row.get("session_vpoc"), (int, float))
    ]
    val_diffs = [
        abs(float(row["session_val"]) - float(row["mid"]))
        for row in profile_rows
        if isinstance(row.get("session_val"), (int, float))
    ]
    vah_diffs = [
        abs(float(row["session_vah"]) - float(row["mid"]))
        for row in profile_rows
        if isinstance(row.get("session_vah"), (int, float))
    ]

    print("Trade vs nearest mid:", summarize(normalized_trade_diffs))
    if raw_trade_diffs:
        print("Raw trade vs nearest mid:", summarize(raw_trade_diffs))
    print("VPOC vs mid:", summarize(vpoc_diffs))
    print("VAL vs mid:", summarize(val_diffs))
    print("VAH vs mid:", summarize(vah_diffs))

    latest_trade = trade_rows[-1]
    print("Latest trade sample:", {
        "ts": latest_trade["ts"],
        "price": latest_trade["price"],
        "raw_price": latest_trade.get("raw_price"),
        "price_scale_source": latest_trade.get("price_scale_source"),
    })
    if profile_rows:
        latest_profile = profile_rows[-1]
        print("Latest profile sample:", {
            "ts": latest_profile["ts"],
            "mid": latest_profile.get("mid"),
            "session_vpoc": latest_profile.get("session_vpoc"),
            "session_val": latest_profile.get("session_val"),
            "session_vah": latest_profile.get("session_vah"),
        })

    trade_ok = bool(normalized_trade_diffs) and statistics.median(normalized_trade_diffs) <= args.max_trade_mid_diff
    profile_ok = True
    for diffs in (vpoc_diffs, val_diffs, vah_diffs):
        if diffs and statistics.median(diffs) > args.max_profile_mid_diff:
            profile_ok = False

    raw_better_check = True
    if raw_trade_diffs:
        raw_better_check = statistics.median(normalized_trade_diffs) < statistics.median(raw_trade_diffs)

    if trade_ok and profile_ok and raw_better_check:
        print("PASS price domains are aligned")
        return 0

    print("FAIL price domains are still inconsistent", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
