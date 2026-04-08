"""
Tests for the shared LOB/MBO feature computation module.

Verifies that compute_lob_features and rolling buffers produce correct,
deterministic results — the same formulas used live and in training.
"""

import time
import sys
import os

# Add parent dir to path so lob_features is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from lob_features.schema import LobFeatureSnapshot, ALL_FEATURE_NAMES, MBO_FEATURE_NAMES
from lob_features.rolling import RollingTradeBuffer, RollingDepthState, RollingMboAggregator
from lob_features.compute import compute_lob_features, compute_mbo_features


def test_empty_snapshot_returns_unavailable():
    buf = RollingTradeBuffer()
    depth = RollingDepthState()
    mbo = RollingMboAggregator()
    snap = compute_lob_features(None, None, None, None, buf, depth, mbo)
    assert snap.data_quality == "unavailable"
    assert snap.spread_ticks is None
    assert snap.depth_imbalance_5 is None


def test_bbo_only_snapshot():
    buf = RollingTradeBuffer()
    depth = RollingDepthState()
    mbo = RollingMboAggregator()
    snap = compute_lob_features(24200.25, 24200.50, 10, 8, buf, depth, mbo)
    assert snap.bid == 24200.25
    assert snap.ask == 24200.50
    assert snap.mid == 24200.38  # (24200.25 + 24200.50) / 2 = 24200.375, rounded
    assert snap.spread_pts == 0.25
    assert snap.spread_ticks == 1
    assert snap.data_quality == "bbo_only"


def test_trade_buffer_cumulative_delta():
    buf = RollingTradeBuffer()
    now = time.time()
    buf.add(now - 5, 24200, 10, is_buy=True)
    buf.add(now - 3, 24200, 5, is_buy=False)
    buf.add(now - 1, 24200, 8, is_buy=True)

    delta = buf.cumulative_delta(10, now)
    assert delta == 13  # 10 - 5 + 8

    imbalance = buf.trade_flow_imbalance(10, now)
    assert imbalance is not None
    assert abs(imbalance - 18 / 23) < 0.01  # buy_vol=18, total=23


def test_trade_buffer_window_expiry():
    buf = RollingTradeBuffer(max_window_sec=10)
    now = time.time()
    buf.add(now - 15, 24200, 100, is_buy=True)  # outside window
    buf.add(now - 5, 24200, 10, is_buy=False)

    delta = buf.cumulative_delta(10, now)
    assert delta == -10  # only the -5s trade counts


def test_depth_imbalance():
    depth = RollingDepthState()
    now = time.time()
    # 5 bid levels
    for i in range(5):
        depth.update("bid", 24200 - i * 0.25, 20, now)
    # 5 ask levels (lighter)
    for i in range(5):
        depth.update("ask", 24200.25 + i * 0.25, 10, now)

    imb = depth.depth_imbalance(5)
    assert imb is not None
    # bid_depth=100, ask_depth=50, total=150 -> (100-50)/150 = 0.3333
    assert abs(imb - 0.3333) < 0.01


def test_depth_large_order():
    depth = RollingDepthState()
    now = time.time()
    depth.update("bid", 24198, 60, now)  # large (>50)
    depth.update("ask", 24202, 5, now)   # small

    assert depth.has_large_order("bid", 24200, 5.0, threshold=50)
    assert not depth.has_large_order("ask", 24200, 5.0, threshold=50)


def test_mbo_cancel_add_ratio():
    mbo = RollingMboAggregator()
    now = time.time()
    for i in range(10):
        mbo.add_event(now - 5, "add", "bid", 24200, 5)
    for i in range(7):
        mbo.add_event(now - 3, "cancel", "bid", 24200, 5)

    ratio = mbo.cancel_add_ratio(10, now)
    assert ratio is not None
    assert abs(ratio - 0.7) < 0.01


def test_mbo_sweep_count():
    mbo = RollingMboAggregator()
    now = time.time()
    mbo.add_event(now - 5, "execute", "ask", 24201, 20, levels_penetrated=1)
    mbo.add_event(now - 4, "execute", "ask", 24202, 30, levels_penetrated=4)  # sweep
    mbo.add_event(now - 3, "execute", "ask", 24203, 15, levels_penetrated=3)  # sweep

    assert mbo.sweep_count(10, now) == 2


def test_full_snapshot_with_all_sources():
    buf = RollingTradeBuffer()
    depth = RollingDepthState()
    mbo = RollingMboAggregator()
    now = time.time()

    # Add trade data
    buf.add(now - 2, 24200, 10, is_buy=True)
    buf.add(now - 1, 24200, 5, is_buy=False)

    # Add depth data
    for i in range(10):
        depth.update("bid", 24200 - i * 0.25, 15, now)
        depth.update("ask", 24200.50 + i * 0.25, 12, now)

    # Add MBO data
    mbo.add_event(now - 3, "add", "bid", 24200, 10)
    mbo.add_event(now - 2, "cancel", "bid", 24200, 10)

    snap = compute_lob_features(
        24200.25, 24200.50, 15, 12, buf, depth, mbo,
        now=now, recording_context="trade", trade_id="TRADE_001",
    )

    assert snap.data_quality == "full_depth"
    assert snap.recording_context == "trade"
    assert snap.trade_id == "TRADE_001"
    assert snap.spread_ticks == 1
    assert snap.depth_imbalance_5 is not None
    assert snap.cumulative_delta_10s is not None
    assert snap.cancel_add_ratio_10s is not None


def test_snapshot_schema_completeness():
    """All feature names from schema.py should be attributes of LobFeatureSnapshot."""
    snap = LobFeatureSnapshot()
    for name in ALL_FEATURE_NAMES:
        assert hasattr(snap, name), f"Missing attribute: {name}"


def test_compute_mbo_features_standalone():
    mbo = RollingMboAggregator()
    now = time.time()
    mbo.add_event(now - 5, "add", "bid", 24200, 10)
    mbo.add_event(now - 4, "execute", "ask", 24201, 5, levels_penetrated=2)

    features = compute_mbo_features(mbo, now)
    assert "cancel_add_ratio_10s" in features
    assert "sweep_count_10s" in features
    assert features["sweep_count_10s"] == 0  # only 2 levels, need 3+ for sweep


if __name__ == "__main__":
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    passed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS: {t.__name__}")
            passed += 1
        except Exception as e:
            print(f"  FAIL: {t.__name__}: {e}")
    print(f"\n{passed}/{len(tests)} tests passed")
    sys.exit(0 if passed == len(tests) else 1)
