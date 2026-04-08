"""
advanced_mbo.py — Advanced MBO-derived features beyond the early aggregates.

Builds on top of RollingMboAggregator (rolling.py) which provides the
foundational cancel_add_ratio, replenishment, absorption, sweep metrics.

Advanced features here are OPTIONAL — the live path works without them.
They require richer MBO event data (order_id, original_size, modify events).

Feature groups:
  1. Refined cancel/replace pressure
  2. Hidden liquidity / iceberg suspicion
  3. Queue deterioration metrics
  4. Liquidity pull cascades
  5. Deeper order-lifetime distributions
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional, Deque


@dataclass
class RichMboEvent:
    """Extended MBO event with fields needed for advanced analytics."""
    ts: float
    action: str          # add | cancel | modify | execute | replace
    side: str            # bid | ask
    price: float
    size: int
    order_id: str = ""
    original_size: int = 0    # size at add time (for partial fill tracking)
    is_top_of_book: bool = False
    levels_penetrated: int = 0
    prev_price: float = 0.0   # for modify/replace: old price
    prev_size: int = 0        # for modify/replace: old size


class AdvancedMboAnalyzer:
    """
    Advanced MBO analytics. Optional layer on top of the basic aggregator.
    All methods return None when insufficient data exists.
    """

    def __init__(self, max_window_sec: float = 60.0):
        self.max_window_sec = max_window_sec
        self._events: Deque[RichMboEvent] = deque()
        self._order_state: dict[str, dict] = {}  # order_id -> {add_ts, add_price, add_size, side}
        self._execution_volumes: dict[float, int] = {}  # price -> executed_volume (for iceberg detection)
        self._level_sizes: dict[str, dict[float, int]] = {"bid": {}, "ask": {}}  # side -> price -> visible_size
        self.enabled = True

    def _snapshot_events(self) -> list[RichMboEvent]:
        """Return a safe copy of _events for iteration.

        The WebSocket ingest handler appends to _events on the async event
        loop while snapshot computation (REST endpoints, recording timer)
        iterates it.  Iterating a deque that is concurrently mutated raises
        ``RuntimeError: deque mutated during iteration``.  Taking a list
        copy is O(n) but n is bounded by max_window_sec (~60 s of events)
        and avoids the need for locks in this single-process async design.
        """
        return list(self._events)

    def add_event(self, evt: RichMboEvent) -> None:
        if not self.enabled:
            return
        self._events.append(evt)
        self._expire(evt.ts)
        self._update_state(evt)

    def _expire(self, now: float) -> None:
        cutoff = now - self.max_window_sec
        while self._events and self._events[0].ts < cutoff:
            self._events.popleft()
        stale_orders = [k for k, v in self._order_state.items() if v.get("add_ts", 0) < cutoff]
        for k in stale_orders:
            del self._order_state[k]

    def _update_state(self, evt: RichMboEvent) -> None:
        oid = evt.order_id
        if not oid:
            return

        if evt.action == "add":
            self._order_state[oid] = {
                "add_ts": evt.ts, "add_price": evt.price,
                "add_size": evt.size, "side": evt.side,
                "modify_count": 0, "partial_fill_count": 0,
            }
            side_book = self._level_sizes[evt.side]
            side_book[evt.price] = side_book.get(evt.price, 0) + evt.size

        elif evt.action == "cancel":
            state = self._order_state.pop(oid, None)
            if state:
                side_book = self._level_sizes[state["side"]]
                p = state["add_price"]
                if p in side_book:
                    side_book[p] = max(0, side_book[p] - state.get("current_size", state["add_size"]))

        elif evt.action == "modify" or evt.action == "replace":
            state = self._order_state.get(oid)
            if state:
                state["modify_count"] = state.get("modify_count", 0) + 1
                if evt.size != state.get("current_size", state["add_size"]):
                    state["current_size"] = evt.size

        elif evt.action == "execute":
            self._execution_volumes[evt.price] = self._execution_volumes.get(evt.price, 0) + evt.size
            state = self._order_state.get(oid)
            if state:
                state["partial_fill_count"] = state.get("partial_fill_count", 0) + 1

    # ─── Feature 1: Cancel/Replace Pressure ───────────────────────────────

    def cancel_replace_ratio_10s(self, now: float | None = None) -> Optional[float]:
        """(cancels + replaces) / adds. Refined version of cancel_add_ratio."""
        now = now or time.time()
        cutoff = now - 10
        adds = cr = 0
        for e in self._snapshot_events():
            if e.ts >= cutoff:
                if e.action == "add": adds += 1
                elif e.action in ("cancel", "replace"): cr += 1
        return round(cr / adds, 4) if adds > 0 else None

    def modify_rate_10s(self, now: float | None = None) -> Optional[float]:
        """Modify events / total events. High = aggressive repricing."""
        now = now or time.time()
        cutoff = now - 10
        modifies = total = 0
        for e in self._snapshot_events():
            if e.ts >= cutoff:
                total += 1
                if e.action == "modify": modifies += 1
        return round(modifies / total, 4) if total > 0 else None

    # ─── Feature 2: Hidden Liquidity / Iceberg Suspicion ──────────────────

    def iceberg_suspicion_score(self, now: float | None = None) -> Optional[float]:
        """
        Detect likely iceberg orders: executions at a price level that exceed
        the visible resting size. Score = executed_vol / visible_vol at level.
        Score > 1.0 strongly suggests hidden liquidity.
        """
        now = now or time.time()
        cutoff = now - 30
        level_executed: dict[float, int] = {}
        level_visible: dict[float, int] = {}

        for e in self._snapshot_events():
            if e.ts >= cutoff:
                if e.action == "add":
                    level_visible[e.price] = level_visible.get(e.price, 0) + e.size
                elif e.action == "execute":
                    level_executed[e.price] = level_executed.get(e.price, 0) + e.size

        if not level_executed:
            return None

        max_ratio = 0.0
        for price, exec_vol in level_executed.items():
            vis_vol = level_visible.get(price, 1)
            ratio = exec_vol / max(vis_vol, 1)
            max_ratio = max(max_ratio, ratio)

        return round(max_ratio, 4)

    # ─── Feature 3: Queue Deterioration ───────────────────────────────────

    def queue_deterioration_rate(self, side: str, window_sec: float = 10, now: float | None = None) -> Optional[float]:
        """
        Rate at which the queue at the top level is being consumed.
        (cancels + executions at top) / (adds at top) over the window.
        High = top of book is thinning. Low = being defended.
        """
        now = now or time.time()
        cutoff = now - window_sec
        top_adds = top_consumed = 0

        for e in self._snapshot_events():
            if e.ts >= cutoff and e.side == side and e.is_top_of_book:
                if e.action == "add":
                    top_adds += 1
                elif e.action in ("cancel", "execute"):
                    top_consumed += 1

        return round(top_consumed / top_adds, 4) if top_adds > 0 else None

    # ─── Feature 4: Liquidity Pull Cascades ───────────────────────────────

    def pull_cascade_count_10s(self, now: float | None = None) -> Optional[int]:
        """
        Count of cascade events: 3+ cancels within 200ms at consecutive price levels.
        Indicates coordinated liquidity withdrawal.
        """
        now = now or time.time()
        cutoff = now - 10
        cancels = [(e.ts, e.price, e.side) for e in self._snapshot_events()
                   if e.ts >= cutoff and e.action == "cancel"]

        if len(cancels) < 3:
            return 0

        cascades = 0
        for i in range(len(cancels) - 2):
            ts0, p0, s0 = cancels[i]
            ts2, p2, s2 = cancels[i + 2]
            if s0 == s2 and (ts2 - ts0) < 0.2:  # 200ms window, same side
                cascades += 1

        return cascades

    # ─── Feature 5: Order-Lifetime Distribution ───────────────────────────

    def lifetime_percentile_ms(self, percentile: float = 0.5, window_sec: float = 30, now: float | None = None) -> Optional[float]:
        """
        Percentile of order lifetimes (add-to-cancel/execute) in milliseconds.
        p50 = median lifetime. Short = HFT activity. Long = patient flow.
        """
        now = now or time.time()
        cutoff = now - window_sec
        lifetimes: list[float] = []

        add_times: dict[str, float] = {}
        for e in self._snapshot_events():
            if e.ts >= cutoff and e.order_id:
                if e.action == "add":
                    add_times[e.order_id] = e.ts
                elif e.action in ("cancel", "execute") and e.order_id in add_times:
                    lt = (e.ts - add_times.pop(e.order_id)) * 1000
                    lifetimes.append(lt)

        if not lifetimes:
            return None

        lifetimes.sort()
        idx = int(len(lifetimes) * percentile)
        idx = min(idx, len(lifetimes) - 1)
        return round(lifetimes[idx], 1)

    # ─── Composite Snapshot ───────────────────────────────────────────────

    def compute_advanced_features(self, now: float | None = None) -> dict:
        """Compute all advanced MBO features. Returns dict with None for unavailable."""
        now = now or time.time()
        return {
            "adv_cancel_replace_ratio_10s": self.cancel_replace_ratio_10s(now),
            "adv_modify_rate_10s": self.modify_rate_10s(now),
            "adv_iceberg_suspicion_30s": self.iceberg_suspicion_score(now),
            "adv_queue_deterioration_bid_10s": self.queue_deterioration_rate("bid", 10, now),
            "adv_queue_deterioration_ask_10s": self.queue_deterioration_rate("ask", 10, now),
            "adv_pull_cascade_count_10s": self.pull_cascade_count_10s(now),
            "adv_lifetime_p25_ms": self.lifetime_percentile_ms(0.25, 30, now),
            "adv_lifetime_p50_ms": self.lifetime_percentile_ms(0.50, 30, now),
            "adv_lifetime_p75_ms": self.lifetime_percentile_ms(0.75, 30, now),
        }

    @property
    def event_count(self) -> int:
        return len(self._events)
