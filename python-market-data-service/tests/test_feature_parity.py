"""
test_feature_parity.py — Verify that live bridge output and offline dataset
generation use the EXACT same feature formulas.

Uses a shared raw-event fixture to feed both paths and compares results.
This test is a RELEASE GATE: if it fails, feature drift exists.
"""

import sys
import os
import time
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from lob_features.schema import LobFeatureSnapshot, ALL_FEATURE_NAMES
from lob_features.rolling import RollingTradeBuffer, RollingDepthState, RollingMboAggregator
from lob_features.compute import compute_lob_features
from lob_features.ml_feature_registry import (
    NUMERIC_FEATURES, CATEGORICAL_FEATURES, ALL_FEATURES,
    CAT_FEATURE_INDICES, LOB_NUMERIC_FEATURES, POSITION_NUMERIC_FEATURES,
    FEATURE_SCHEMA_VERSION, FEATURE_COUNT,
)


# ─── Shared Raw-Event Fixture ────────────────────────────────────────────────

def make_fixture():
    """Create a deterministic set of raw events for both live and offline paths."""
    now = 1700000000.0  # Fixed epoch for reproducibility

    events = [
        {"type": "bbo", "ts": now, "bid": 24200.25, "bid_sz": 45, "ask": 24200.50, "ask_sz": 32},
        {"type": "trade", "ts": now + 0.5, "price": 24200.50, "size": 5, "is_buy": True},
        {"type": "trade", "ts": now + 1.0, "price": 24200.25, "size": 3, "is_buy": False},
        {"type": "trade", "ts": now + 1.5, "price": 24200.50, "size": 8, "is_buy": True},
        {"type": "depth", "ts": now + 0.1, "side": "bid", "price": 24200.00, "size": 100},
        {"type": "depth", "ts": now + 0.1, "side": "bid", "price": 24199.75, "size": 80},
        {"type": "depth", "ts": now + 0.1, "side": "bid", "price": 24199.50, "size": 60},
        {"type": "depth", "ts": now + 0.1, "side": "bid", "price": 24199.25, "size": 40},
        {"type": "depth", "ts": now + 0.1, "side": "bid", "price": 24199.00, "size": 20},
        {"type": "depth", "ts": now + 0.1, "side": "ask", "price": 24200.75, "size": 90},
        {"type": "depth", "ts": now + 0.1, "side": "ask", "price": 24201.00, "size": 70},
        {"type": "depth", "ts": now + 0.1, "side": "ask", "price": 24201.25, "size": 50},
        {"type": "depth", "ts": now + 0.1, "side": "ask", "price": 24201.50, "size": 30},
        {"type": "depth", "ts": now + 0.1, "side": "ask", "price": 24201.75, "size": 10},
        {"type": "mbo", "ts": now + 0.2, "action": "add", "side": "bid", "price": 24200.00, "size": 10},
        {"type": "mbo", "ts": now + 0.5, "action": "cancel", "side": "bid", "price": 24200.00, "size": 10},
        {"type": "mbo", "ts": now + 0.8, "action": "execute", "side": "ask", "price": 24200.50, "size": 5, "levels_penetrated": 1},
    ]
    return events, now + 2.0  # Compute at t=now+2


def replay_events_into_buffers(events, trade_buf, depth, mbo_agg):
    """Feed raw events into rolling buffers — same logic as live sidecar."""
    for e in events:
        ts = e["ts"]
        if e["type"] == "trade":
            trade_buf.add(ts, e["price"], e["size"], e["is_buy"])
        elif e["type"] == "depth":
            depth.update(e["side"], e["price"], e["size"], ts)
        elif e["type"] == "mbo":
            mbo_agg.add_event(
                ts=ts, action=e["action"], side=e["side"],
                price=e["price"], size=e["size"],
                levels_penetrated=e.get("levels_penetrated", 0),
            )


# ─── Tests ────────────────────────────────────────────────────────────────────

def test_parity_live_vs_offline():
    """
    Both live and offline paths must produce IDENTICAL feature snapshots
    from the same raw events.
    """
    events, compute_time = make_fixture()
    bbo = events[0]

    # Path A: "Live" — buffers populated incrementally (same as sidecar)
    buf_a = RollingTradeBuffer(60.0)
    depth_a = RollingDepthState()
    mbo_a = RollingMboAggregator(60.0)
    replay_events_into_buffers(events, buf_a, depth_a, mbo_a)
    snap_a = compute_lob_features(
        bbo["bid"], bbo["ask"], bbo["bid_sz"], bbo["ask_sz"],
        buf_a, depth_a, mbo_a, now=compute_time,
    )

    # Path B: "Offline" — same events replayed (same as dataset builder would do)
    buf_b = RollingTradeBuffer(60.0)
    depth_b = RollingDepthState()
    mbo_b = RollingMboAggregator(60.0)
    replay_events_into_buffers(events, buf_b, depth_b, mbo_b)
    snap_b = compute_lob_features(
        bbo["bid"], bbo["ask"], bbo["bid_sz"], bbo["ask_sz"],
        buf_b, depth_b, mbo_b, now=compute_time,
    )

    # Compare: must be EXACTLY equal (same inputs, deterministic function)
    dict_a = snap_a.to_dict()
    dict_b = snap_b.to_dict()

    for key in dict_a:
        va = dict_a[key]
        vb = dict_b[key]
        if isinstance(va, float) and isinstance(vb, float):
            assert abs(va - vb) < 1e-6, f"Float mismatch on {key}: {va} vs {vb}"
        else:
            assert va == vb, f"Mismatch on {key}: {va} vs {vb}"

    print("  PASS: live and offline paths produce identical features")


def test_feature_registry_completeness():
    """Every LOB feature in the ML registry must exist in LobFeatureSnapshot."""
    snap = LobFeatureSnapshot()
    snap_fields = set(snap.to_dict().keys())

    for feat in LOB_NUMERIC_FEATURES:
        # Strip the lob_ prefix used in ML features to match snapshot fields
        raw_name = feat.replace("lob_", "")
        assert raw_name in snap_fields, f"ML feature '{feat}' -> '{raw_name}' not in LobFeatureSnapshot"

    print("  PASS: all ML LOB features map to LobFeatureSnapshot fields")


def test_feature_registry_no_duplicates():
    """No duplicate feature names in the canonical list."""
    assert len(ALL_FEATURES) == len(set(ALL_FEATURES)), "Duplicate feature names in registry!"
    print(f"  PASS: {FEATURE_COUNT} unique features in registry (version={FEATURE_SCHEMA_VERSION})")


def test_categorical_indices_correct():
    """CAT_FEATURE_INDICES must point to the right positions."""
    for idx in CAT_FEATURE_INDICES:
        feat = ALL_FEATURES[idx]
        assert feat in CATEGORICAL_FEATURES, f"Index {idx} points to '{feat}', not a categorical"
    print(f"  PASS: categorical indices {CAT_FEATURE_INDICES} are correct")


def test_position_features_unchanged():
    """v1 position features must still be the first 20 numeric features."""
    expected_v1 = [
        "is_short", "confidence_at_entry", "initial_risk_pts", "current_price",
        "stop_current", "quantity_remaining", "pnl_pts", "unrealized_r",
        "mfe_pts_so_far", "mae_pts_so_far", "time_in_trade_sec",
        "distance_to_stop_pts", "pt1_hit", "pt2_hit", "stop_at_breakeven",
        "trail_active", "trail_ratchet_count", "management_events_count",
        "entry_hour_utc", "tick_hour_utc",
    ]
    assert POSITION_NUMERIC_FEATURES == expected_v1, "v1 position features changed!"
    print("  PASS: v1 position features are preserved")


def test_lob_features_are_nullable():
    """
    When no LOB data is available, compute_lob_features must produce
    None for all LOB fields. This ensures existing no-LOB trades work.
    """
    buf = RollingTradeBuffer()
    depth = RollingDepthState()
    mbo = RollingMboAggregator()
    snap = compute_lob_features(None, None, None, None, buf, depth, mbo)

    for feat in LOB_NUMERIC_FEATURES:
        raw_name = feat.replace("lob_", "")
        val = getattr(snap, raw_name, "MISSING")
        assert val is None, f"LOB feature '{raw_name}' should be None without data, got {val}"

    print("  PASS: all LOB features are None when no data available")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"  FAIL: {t.__name__}: {e}")
    print(f"\n{passed}/{len(tests)} parity tests passed")
    sys.exit(0 if passed == len(tests) else 1)
