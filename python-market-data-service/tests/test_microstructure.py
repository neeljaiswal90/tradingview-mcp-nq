"""Tests for microstructure feature families."""
import sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lob_features.microstructure import (
    AbsorptionDetector, SweepDetector, FootprintTracker,
    LargeTradeTracker, SessionVolumeProfile,
)

def test_absorption_basic():
    a = AbsorptionDetector()
    now = time.time()
    # Heavy selling at 24200, absorbed (no price drop)
    for i in range(20):
        a.add_trade(now - 5 + i * 0.1, 24200.0, 5, is_buy=False)
    for i in range(5):
        a.add_trade(now - 5 + i * 0.1, 24200.0, 2, is_buy=True)
    score = a.absorption_bid_score(now)
    assert score is not None and score > 0
    print(f"  PASS: absorption_bid_score = {score}")

def test_sweep_tracking():
    s = SweepDetector()
    now = time.time()
    s.record_sweep(now - 3, "buy", 24200.0, 50, 4)
    s.record_sweep(now - 1, "sell", 24195.0, 30, 2)
    assert s.sweep_count(10, now) == 2
    assert s.sweep_volume(10, now) == 80
    assert s.max_sweep_levels(10, now) == 4
    assert s.last_sweep_side(now) == "sell"
    print("  PASS: sweep tracking")

def test_footprint_delta():
    f = FootprintTracker()
    now = time.time()
    for i in range(10):
        f.add_trade(now - 5, 24200.0, 5, is_buy=True)
    for i in range(3):
        f.add_trade(now - 3, 24200.0, 5, is_buy=False)
    assert f.delta(30, now) == 35  # 50 buy - 15 sell
    assert f.dominant_aggressor(10, now) == "buy"
    print("  PASS: footprint delta")

def test_large_trade_detection():
    lt = LargeTradeTracker(threshold=10)
    now = time.time()
    lt.add_trade(now - 5, 24200.0, 5, is_buy=True)   # below threshold
    lt.add_trade(now - 3, 24200.0, 15, is_buy=True)  # above
    lt.add_trade(now - 1, 24200.0, 25, is_buy=False)  # above
    assert lt.count(10, now) == 2
    assert lt.volume(10, now) == 40
    assert lt.largest_size(30, now) == 25
    print("  PASS: large trade detection")

def test_volume_profile():
    vp = SessionVolumeProfile(tick_size=0.25)
    # Build a profile with concentration at 24200
    for i in range(100):
        vp.add_trade(24200.0, 10)
    for i in range(30):
        vp.add_trade(24201.0, 5)
    for i in range(20):
        vp.add_trade(24199.0, 5)
    assert vp.vpoc == 24200.0
    val, vah = vp.value_area()
    assert val is not None and vah is not None
    assert val <= 24200.0 <= vah
    assert vp.inside_value_area(24200.0) == True
    dist = vp.distance_to_vpoc(24201.0)
    assert dist == 1.0
    print(f"  PASS: volume profile VPOC={vp.vpoc} VAL={val} VAH={vah}")

def test_features_in_snapshot():
    from lob_features.rolling import RollingTradeBuffer, RollingDepthState, RollingMboAggregator
    from lob_features.compute import compute_lob_features
    now = time.time()
    buf = RollingTradeBuffer()
    depth = RollingDepthState()
    mbo = RollingMboAggregator()
    ab = AbsorptionDetector()
    sw = SweepDetector()
    fp = FootprintTracker()
    lt = LargeTradeTracker(threshold=10)
    vp = SessionVolumeProfile()
    # Add some data
    for i in range(20):
        ab.add_trade(now - 2, 24200.0, 5, True)
        fp.add_trade(now - 2, 24200.0, 5, True)
        vp.add_trade(24200.0, 5)
    lt.add_trade(now - 1, 24200.0, 15, True)
    snap = compute_lob_features(
        24200.25, 24200.50, 10, 8, buf, depth, mbo, now=now,
        absorption=ab, sweeps=sw, footprint=fp, large_trades=lt, volume_profile=vp,
        current_price=24200.375,
    )
    assert snap.absorption_score_10s is not None
    assert snap.footprint_delta_30s is not None
    assert snap.large_trade_count_10s == 1
    assert snap.session_vpoc == 24200.0
    assert snap.distance_to_vpoc is not None
    print("  PASS: all microstructure features in snapshot")

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"  FAIL: {t.__name__}: {e}")
    print(f"\n{passed}/{len(tests)} microstructure tests passed")
    sys.exit(0 if passed == len(tests) else 1)
