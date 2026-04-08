"""
Tests for MBO message ingestion, robust parsing, and health/status reporting.

Covers:
  - Parsing well-formed MBO messages into rolling aggregators
  - Handling partial/incomplete MBO payloads without crashing
  - Health endpoint reflecting MBO capability state transitions
  - Backward compatibility when no MBO messages arrive
"""

import sys
import os
import time
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from lob_features.rolling import RollingMboAggregator
from lob_features.advanced_mbo import AdvancedMboAnalyzer, RichMboEvent


# ── Helpers ──────────────────────────────────────────────────────────────────

def make_sidecar_state():
    """Create a minimal SidecarState-like object for testing MBO ingest."""

    class FakeState:
        def __init__(self):
            self.mbo_agg = RollingMboAggregator(max_window_sec=60.0)
            self.advanced_mbo = AdvancedMboAnalyzer(max_window_sec=60.0)
            self.mbo_ever_seen = False
            self.mbo_total_count = 0
            self.last_mbo_ts = 0.0

        @property
        def mbo_age_ms(self):
            if self.last_mbo_ts == 0:
                return 99999
            return round((time.time() - self.last_mbo_ts) * 1000, 1)

        @property
        def mbo_status(self):
            if not self.mbo_ever_seen:
                return "idle"
            if self.mbo_age_ms < 5000:
                return "active"
            return "stale"

    return FakeState()


def ingest_mbo_message(state, msg: dict) -> None:
    """Simulate the app.py MBO ingest path exactly."""
    ts_ms = msg.get("ts", int(time.time() * 1000))
    ts = ts_ms / 1000.0

    mbo_action = msg.get("action", "unknown")
    mbo_side = msg.get("side", "unknown")
    mbo_price = msg.get("price", 0.0)
    mbo_size = msg.get("size", 0)
    mbo_order_id = msg.get("order_id", "")
    mbo_top = msg.get("top_of_book", False)
    mbo_levels = msg.get("levels_penetrated", 0)

    if mbo_side in ("bid", "ask"):
        state.mbo_agg.add_event(
            ts=ts, action=mbo_action, side=mbo_side,
            price=mbo_price, size=mbo_size,
            order_id=mbo_order_id,
            is_top_of_book=mbo_top,
            levels_penetrated=mbo_levels,
        )
        state.advanced_mbo.add_event(RichMboEvent(
            ts=ts, action=mbo_action, side=mbo_side,
            price=mbo_price, size=mbo_size,
            order_id=mbo_order_id,
            is_top_of_book=mbo_top,
            levels_penetrated=mbo_levels,
        ))

    state.mbo_ever_seen = True
    state.mbo_total_count += 1
    state.last_mbo_ts = ts


# ── Test: Well-formed MBO messages ──────────────────────────────────────────

def test_add_event_increments_counts():
    """A well-formed MBO add event should increment all counters."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "action": "add", "side": "bid",
        "price": 24200.0, "size": 5,
        "order_id": "ORD001",
    })
    assert s.mbo_agg.event_count == 1
    assert s.advanced_mbo.event_count == 1
    assert s.mbo_total_count == 1
    assert s.mbo_ever_seen is True


def test_cancel_event_with_full_fields():
    """Cancel with all fields should be ingested normally."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "action": "add", "side": "ask",
        "price": 24201.0, "size": 10,
        "order_id": "ORD002",
    })
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms + 100,
        "action": "cancel", "side": "ask",
        "price": 24201.0, "size": 10,
        "order_id": "ORD002",
    })
    assert s.mbo_agg.event_count == 2
    assert s.mbo_total_count == 2


def test_replace_event():
    """Replace event should be tracked."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "action": "add", "side": "bid",
        "price": 24200.0, "size": 5,
        "order_id": "ORD003",
    })
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms + 50,
        "action": "replace", "side": "bid",
        "price": 24199.75, "size": 8,
        "order_id": "ORD003",
    })
    assert s.mbo_agg.event_count == 2
    assert s.advanced_mbo.event_count == 2


def test_execute_event():
    """Execute event should be tracked and count toward buffered."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "action": "execute", "side": "ask",
        "price": 24201.0, "size": 3,
        "order_id": "ORD004",
    })
    assert s.mbo_agg.event_count == 1
    assert s.mbo_total_count == 1


# ── Test: Partial/incomplete MBO payloads ───────────────────────────────────

def test_missing_action_defaults_to_unknown():
    """Missing action field should not crash; event still counted."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "side": "bid", "price": 24200.0, "size": 5,
        # action is missing
    })
    assert s.mbo_total_count == 1
    assert s.mbo_ever_seen is True
    # Still ingested to aggregators because side is valid
    assert s.mbo_agg.event_count == 1


def test_missing_side_skips_aggregator_but_counts():
    """Missing side should skip aggregators but still update MBO tracking."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "action": "cancel", "price": 24200.0, "size": 5,
        # side is missing → defaults to "unknown"
    })
    # Should NOT be fed to aggregators (unknown side)
    assert s.mbo_agg.event_count == 0
    assert s.advanced_mbo.event_count == 0
    # But MBO tracking should still update
    assert s.mbo_total_count == 1
    assert s.mbo_ever_seen is True


def test_unknown_side_skips_aggregator():
    """Explicit 'unknown' side should skip aggregators."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "action": "cancel", "side": "unknown",
        "order_id": "ORD_STALE",
    })
    assert s.mbo_agg.event_count == 0
    assert s.mbo_total_count == 1


def test_missing_price_defaults_to_zero():
    """Missing price should default to 0.0, not crash."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "action": "cancel", "side": "bid",
        # price missing, size missing
        "order_id": "ORD005",
    })
    assert s.mbo_agg.event_count == 1
    assert s.mbo_total_count == 1


def test_missing_order_id_defaults_to_empty():
    """Missing order_id should default to empty string."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "action": "add", "side": "ask",
        "price": 24201.0, "size": 10,
        # order_id missing
    })
    assert s.mbo_agg.event_count == 1
    assert s.mbo_total_count == 1


def test_completely_minimal_mbo_message():
    """An MBO message with only type and ts should not crash."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {"type": "mbo", "ts": now_ms})
    # side is "unknown" → skips aggregator
    assert s.mbo_agg.event_count == 0
    assert s.mbo_total_count == 1
    assert s.mbo_ever_seen is True


# ── Test: Health/status reporting ───────────────────────────────────────────

def test_mbo_status_idle_before_any_events():
    """Before any MBO events, status should be 'idle'."""
    s = make_sidecar_state()
    assert s.mbo_status == "idle"
    assert s.mbo_age_ms == 99999
    assert s.mbo_ever_seen is False
    assert s.mbo_total_count == 0


def test_mbo_status_active_after_recent_event():
    """After a recent MBO event, status should be 'active'."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    ingest_mbo_message(s, {
        "type": "mbo", "ts": now_ms,
        "action": "add", "side": "bid",
        "price": 24200.0, "size": 5,
    })
    assert s.mbo_status == "active"
    assert s.mbo_age_ms < 5000


def test_mbo_status_stale_after_old_event():
    """If last MBO event is old, status should be 'stale'."""
    s = make_sidecar_state()
    old_ts_ms = int((time.time() - 10) * 1000)  # 10 seconds ago
    ingest_mbo_message(s, {
        "type": "mbo", "ts": old_ts_ms,
        "action": "add", "side": "bid",
        "price": 24200.0, "size": 5,
    })
    assert s.mbo_status == "stale"
    assert s.mbo_age_ms > 5000


def test_mbo_total_count_accumulates():
    """Total count should grow even if rolling window expires events."""
    s = make_sidecar_state()
    now_ms = int(time.time() * 1000)
    for i in range(100):
        ingest_mbo_message(s, {
            "type": "mbo", "ts": now_ms + i,
            "action": "add", "side": "bid",
            "price": 24200.0, "size": 1,
            "order_id": f"O{i}",
        })
    assert s.mbo_total_count == 100
    # Buffered count is also 100 since all within 60s window
    assert s.mbo_agg.event_count == 100


# ── Test: JSON serialization round-trip ─────────────────────────────────────

def test_addon_json_round_trip():
    """Simulate parsing a JSON string exactly like the addon would produce."""
    s = make_sidecar_state()
    raw_messages = [
        '{"type":"mbo","ts":1712534400000,"action":"add","side":"bid","price":24200.0,"size":5,"order_id":"A1","alias":"NQM5"}',
        '{"type":"mbo","ts":1712534400100,"action":"replace","side":"bid","price":24199.75,"size":8,"order_id":"A1","alias":"NQM5"}',
        '{"type":"mbo","ts":1712534400200,"action":"cancel","side":"bid","price":24199.75,"size":8,"order_id":"A1","alias":"NQM5"}',
        '{"type":"mbo","ts":1712534400300,"action":"execute","side":"ask","price":24201.0,"size":3,"order_id":"B1","alias":"NQM5"}',
    ]
    for raw in raw_messages:
        msg = json.loads(raw)
        ingest_mbo_message(s, msg)

    assert s.mbo_total_count == 4
    assert s.mbo_agg.event_count == 4
    assert s.mbo_ever_seen is True


def test_addon_cancel_without_price():
    """Addon may send cancel without price field when order state was lost."""
    s = make_sidecar_state()
    raw = '{"type":"mbo","ts":1712534400000,"action":"cancel","side":"bid","order_id":"STALE1","alias":"NQM5"}'
    msg = json.loads(raw)
    ingest_mbo_message(s, msg)
    # Should not crash; size defaults to 0, price to 0.0
    assert s.mbo_total_count == 1
    assert s.mbo_agg.event_count == 1


def test_addon_cancel_unknown_side():
    """Addon cancel with unknown side (order state lost) should not feed aggregators."""
    s = make_sidecar_state()
    raw = '{"type":"mbo","ts":1712534400000,"action":"cancel","side":"unknown","order_id":"LOST1","alias":"NQM5"}'
    msg = json.loads(raw)
    ingest_mbo_message(s, msg)
    assert s.mbo_total_count == 1
    assert s.mbo_agg.event_count == 0  # skipped due to unknown side


# ── Runner ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS: {t.__name__}")
            passed += 1
        except Exception as e:
            print(f"  FAIL: {t.__name__}: {e}")
            import traceback
            traceback.print_exc()
    print(f"\n{passed}/{len(tests)} tests passed")
    sys.exit(0 if passed == len(tests) else 1)
