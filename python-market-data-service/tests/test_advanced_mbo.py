"""
Tests for advanced MBO analytics.
"""

import sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from lob_features.advanced_mbo import AdvancedMboAnalyzer, RichMboEvent
from lob_features.compute import compute_lob_features
from lob_features.rolling import RollingTradeBuffer, RollingDepthState, RollingMboAggregator
from lob_features.ml_feature_registry import ADVANCED_MBO_FEATURES, ALL_FEATURES, FEATURE_SCHEMA_VERSION


def test_empty_analyzer_returns_none_or_zero():
    a = AdvancedMboAnalyzer()
    features = a.compute_advanced_features()
    for key, val in features.items():
        # Count-type features return 0 when empty, ratio-type return None
        assert val is None or val == 0, f"{key} should be None or 0 on empty analyzer, got {val}"
    print("  PASS: empty analyzer returns None/0 for all features")


def test_cancel_replace_ratio():
    a = AdvancedMboAnalyzer()
    now = time.time()
    for i in range(10):
        a.add_event(RichMboEvent(ts=now - 5, action="add", side="bid", price=24200, size=5, order_id=f"o{i}"))
    for i in range(6):
        a.add_event(RichMboEvent(ts=now - 3, action="cancel", side="bid", price=24200, size=5, order_id=f"o{i}"))
    for i in range(2):
        a.add_event(RichMboEvent(ts=now - 2, action="replace", side="bid", price=24200, size=5, order_id=f"r{i}"))

    ratio = a.cancel_replace_ratio_10s(now)
    assert ratio is not None
    # 8 (cancels + replaces) / 10 adds = 0.8
    assert abs(ratio - 0.8) < 0.01
    print("  PASS: cancel_replace_ratio_10s")


def test_iceberg_suspicion():
    a = AdvancedMboAnalyzer()
    now = time.time()
    # Add 10 contracts visibly at 24200
    a.add_event(RichMboEvent(ts=now - 20, action="add", side="bid", price=24200, size=10, order_id="v1"))
    # Execute 50 contracts at 24200 (5x visible = strong iceberg signal)
    for i in range(10):
        a.add_event(RichMboEvent(ts=now - 10 + i * 0.1, action="execute", side="bid", price=24200, size=5, order_id=f"x{i}"))

    score = a.iceberg_suspicion_score(now)
    assert score is not None
    assert score > 1.0, f"Expected iceberg score > 1.0, got {score}"
    print(f"  PASS: iceberg_suspicion_score = {score}")


def test_queue_deterioration():
    a = AdvancedMboAnalyzer()
    now = time.time()
    # 5 adds, 8 cancels at top of book
    for i in range(5):
        a.add_event(RichMboEvent(ts=now - 5, action="add", side="bid", price=24200, size=5, is_top_of_book=True))
    for i in range(8):
        a.add_event(RichMboEvent(ts=now - 3, action="cancel", side="bid", price=24200, size=5, is_top_of_book=True))

    rate = a.queue_deterioration_rate("bid", 10, now)
    assert rate is not None
    assert rate > 1.0  # more consumed than added = thinning
    print(f"  PASS: queue_deterioration_rate = {rate}")


def test_pull_cascade():
    a = AdvancedMboAnalyzer()
    now = time.time()
    # 3 rapid cancels at consecutive prices within 200ms
    a.add_event(RichMboEvent(ts=now - 5, action="cancel", side="bid", price=24200.00, size=10))
    a.add_event(RichMboEvent(ts=now - 4.95, action="cancel", side="bid", price=24199.75, size=10))
    a.add_event(RichMboEvent(ts=now - 4.90, action="cancel", side="bid", price=24199.50, size=10))

    count = a.pull_cascade_count_10s(now)
    assert count is not None
    assert count >= 1
    print(f"  PASS: pull_cascade_count = {count}")


def test_lifetime_percentile():
    a = AdvancedMboAnalyzer()
    now = time.time()
    # Orders with varying lifetimes
    for i, lt_ms in enumerate([50, 100, 200, 500, 1000]):
        add_ts = now - 5
        cancel_ts = add_ts + lt_ms / 1000
        a.add_event(RichMboEvent(ts=add_ts, action="add", side="bid", price=24200, size=5, order_id=f"lt{i}"))
        a.add_event(RichMboEvent(ts=cancel_ts, action="cancel", side="bid", price=24200, size=5, order_id=f"lt{i}"))

    p50 = a.lifetime_percentile_ms(0.5, 30, now)
    assert p50 is not None
    assert 100 <= p50 <= 500  # median of [50, 100, 200, 500, 1000] = 200
    print(f"  PASS: lifetime_p50_ms = {p50}")


def test_advanced_features_in_registry():
    """Advanced MBO feature names must be in ALL_FEATURES."""
    for feat in ADVANCED_MBO_FEATURES:
        assert feat in ALL_FEATURES, f"Advanced feature '{feat}' not in ALL_FEATURES"
    print(f"  PASS: all {len(ADVANCED_MBO_FEATURES)} advanced features in registry (schema={FEATURE_SCHEMA_VERSION})")


def test_compute_lob_features_with_advanced():
    """compute_lob_features should populate advanced fields when analyzer is provided."""
    buf = RollingTradeBuffer()
    depth = RollingDepthState()
    mbo = RollingMboAggregator()
    adv = AdvancedMboAnalyzer()
    now = time.time()

    # Add some MBO data to advanced analyzer
    adv.add_event(RichMboEvent(ts=now - 3, action="add", side="bid", price=24200, size=10, order_id="a1"))
    adv.add_event(RichMboEvent(ts=now - 2, action="cancel", side="bid", price=24200, size=10, order_id="a1"))

    snap = compute_lob_features(
        24200.25, 24200.50, 10, 8,
        buf, depth, mbo, now=now, advanced_mbo=adv,
    )

    assert snap.adv_cancel_replace_ratio_10s is not None
    print("  PASS: compute_lob_features populates advanced fields")


def test_compute_without_advanced_is_none():
    """When no advanced analyzer is passed, advanced fields remain None."""
    buf = RollingTradeBuffer()
    depth = RollingDepthState()
    mbo = RollingMboAggregator()

    snap = compute_lob_features(24200.25, 24200.50, 10, 8, buf, depth, mbo)
    assert snap.adv_cancel_replace_ratio_10s is None
    assert snap.adv_iceberg_suspicion_30s is None
    print("  PASS: without advanced analyzer, fields are None")


def test_disabled_analyzer_is_noop():
    adv = AdvancedMboAnalyzer()
    adv.enabled = False
    adv.add_event(RichMboEvent(ts=time.time(), action="add", side="bid", price=24200, size=10))
    assert adv.event_count == 0  # disabled = no events stored
    print("  PASS: disabled analyzer is a no-op")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"  FAIL: {t.__name__}: {e}")
    print(f"\n{passed}/{len(tests)} advanced MBO tests passed")
    sys.exit(0 if passed == len(tests) else 1)
