"""
rolling.py — Time-windowed rolling buffers for trade flow, depth, and MBO aggregates.

All buffers are append-only with automatic expiry. No external dependencies.
Shared between live sidecar and offline replay.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional, Deque

NQ_TICK_SIZE = 0.25
LARGE_ORDER_THRESHOLD = 50  # contracts


# ─── Rolling Trade Buffer ─────────────────────────────────────────────────────

@dataclass
class TradeEvent:
    ts: float       # epoch seconds
    price: float
    size: int
    is_buy: bool    # aggressor side


class RollingTradeBuffer:
    """Fixed-window rolling buffer of trade events for delta/flow computation."""

    def __init__(self, max_window_sec: float = 60.0):
        self.max_window_sec = max_window_sec
        self._trades: Deque[TradeEvent] = deque()

    def add(self, ts: float, price: float, size: int, is_buy: bool) -> None:
        self._trades.append(TradeEvent(ts=ts, price=price, size=size, is_buy=is_buy))
        self._expire(ts)

    def _expire(self, now: float) -> None:
        cutoff = now - self.max_window_sec
        while self._trades and self._trades[0].ts < cutoff:
            self._trades.popleft()

    def cumulative_delta(self, window_sec: float, now: float | None = None) -> float:
        """Sum of (buy_volume - sell_volume) over the window."""
        now = now or time.time()
        cutoff = now - window_sec
        delta = 0.0
        for t in self._trades:
            if t.ts >= cutoff:
                delta += t.size if t.is_buy else -t.size
        return delta

    def trade_flow_imbalance(self, window_sec: float, now: float | None = None) -> Optional[float]:
        """buy_volume / total_volume over the window. Range [0, 1]."""
        now = now or time.time()
        cutoff = now - window_sec
        buy_vol = 0
        total_vol = 0
        for t in self._trades:
            if t.ts >= cutoff:
                total_vol += t.size
                if t.is_buy:
                    buy_vol += t.size
        return round(buy_vol / total_vol, 4) if total_vol > 0 else None

    @property
    def count(self) -> int:
        return len(self._trades)


# ─── Rolling Depth State ──────────────────────────────────────────────────────

class RollingDepthState:
    """Maintains current depth book from incremental updates."""

    def __init__(self):
        self.bids: dict[float, int] = {}  # price -> size
        self.asks: dict[float, int] = {}  # price -> size
        self.last_update_ts: float = 0.0

    def update(self, side: str, price: float, size: int, ts: float) -> None:
        book = self.bids if side == "bid" else self.asks
        if size <= 0:
            book.pop(price, None)
        else:
            book[price] = size
        self.last_update_ts = ts

    def top_n_bid(self, n: int) -> list[tuple[float, int]]:
        """Top N bid levels sorted descending by price."""
        return sorted(self.bids.items(), key=lambda x: -x[0])[:n]

    def top_n_ask(self, n: int) -> list[tuple[float, int]]:
        """Top N ask levels sorted ascending by price."""
        return sorted(self.asks.items(), key=lambda x: x[0])[:n]

    def depth_imbalance(self, levels: int) -> Optional[float]:
        """(bid_depth - ask_depth) / total for top N levels. Range [-1, 1]."""
        bid_depth = sum(sz for _, sz in self.top_n_bid(levels))
        ask_depth = sum(sz for _, sz in self.top_n_ask(levels))
        total = bid_depth + ask_depth
        return round((bid_depth - ask_depth) / total, 4) if total > 0 else None

    def total_depth(self, side: str, levels: int) -> int:
        entries = self.top_n_bid(levels) if side == "bid" else self.top_n_ask(levels)
        return sum(sz for _, sz in entries)

    def has_large_order(self, side: str, ref_price: float, range_pts: float, threshold: int = LARGE_ORDER_THRESHOLD) -> bool:
        book = self.bids if side == "bid" else self.asks
        for price, size in book.items():
            if abs(price - ref_price) <= range_pts and size >= threshold:
                return True
        return False


# ─── Rolling MBO Aggregator ──────────────────────────────────────────────────

@dataclass
class MboEvent:
    ts: float
    action: str     # add | cancel | modify | execute
    side: str       # bid | ask
    price: float
    size: int
    is_top_of_book: bool = False
    levels_penetrated: int = 0  # for executions


class RollingMboAggregator:
    """Compact rolling MBO aggregate statistics."""

    def __init__(self, max_window_sec: float = 60.0):
        self.max_window_sec = max_window_sec
        self._events: Deque[MboEvent] = deque()
        self._order_add_times: dict[str, float] = {}  # order_key -> add_ts

    def add_event(self, ts: float, action: str, side: str, price: float, size: int,
                  order_id: str | None = None, is_top_of_book: bool = False,
                  levels_penetrated: int = 0) -> None:
        evt = MboEvent(ts=ts, action=action, side=side, price=price, size=size,
                       is_top_of_book=is_top_of_book, levels_penetrated=levels_penetrated)
        self._events.append(evt)
        self._expire(ts)

        # Track order lifetimes
        if order_id:
            key = f"{side}:{order_id}"
            if action == "add":
                self._order_add_times[key] = ts
            elif action in ("cancel", "execute"):
                self._order_add_times.pop(key, None)

    def _expire(self, now: float) -> None:
        cutoff = now - self.max_window_sec
        while self._events and self._events[0].ts < cutoff:
            self._events.popleft()
        # Also expire stale order tracking entries
        to_remove = [k for k, v in self._order_add_times.items() if v < cutoff]
        for k in to_remove:
            del self._order_add_times[k]

    def cancel_add_ratio(self, window_sec: float, now: float | None = None) -> Optional[float]:
        """Cancels / adds over window. High = spoofing / thinning."""
        now = now or time.time()
        cutoff = now - window_sec
        adds = cancels = 0
        for e in self._events:
            if e.ts >= cutoff:
                if e.action == "add":
                    adds += 1
                elif e.action == "cancel":
                    cancels += 1
        return round(cancels / adds, 4) if adds > 0 else None

    def replenishment_rate(self, window_sec: float, now: float | None = None) -> Optional[float]:
        """Adds after executions / executions. High = level being defended."""
        now = now or time.time()
        cutoff = now - window_sec
        execs = adds_after_exec = 0
        last_exec_ts = 0.0
        for e in self._events:
            if e.ts >= cutoff:
                if e.action == "execute":
                    execs += 1
                    last_exec_ts = e.ts
                elif e.action == "add" and last_exec_ts > 0 and (e.ts - last_exec_ts) < 1.0:
                    adds_after_exec += 1
        return round(adds_after_exec / execs, 4) if execs > 0 else None

    def absorption_rate(self, window_sec: float, now: float | None = None) -> Optional[float]:
        """Executions consumed / total resting at that level. High = level holding."""
        now = now or time.time()
        cutoff = now - window_sec
        executed_vol = 0
        total_add_vol = 0
        for e in self._events:
            if e.ts >= cutoff:
                if e.action == "execute":
                    executed_vol += e.size
                elif e.action == "add":
                    total_add_vol += e.size
        return round(executed_vol / total_add_vol, 4) if total_add_vol > 0 else None

    def mean_order_lifetime_ms(self, window_sec: float, now: float | None = None) -> Optional[float]:
        """Average time from add to cancel/execute for top-of-book orders."""
        now = now or time.time()
        cutoff = now - window_sec
        lifetimes: list[float] = []
        add_times: dict[str, float] = {}
        for e in self._events:
            if e.ts >= cutoff and e.is_top_of_book:
                key = f"{e.side}:{e.price}"
                if e.action == "add":
                    add_times[key] = e.ts
                elif e.action in ("cancel", "execute") and key in add_times:
                    lt = (e.ts - add_times.pop(key)) * 1000
                    lifetimes.append(lt)
        return round(sum(lifetimes) / len(lifetimes), 1) if lifetimes else None

    def aggressor_penetration(self, window_sec: float, now: float | None = None) -> Optional[float]:
        """Average number of levels penetrated by aggressive executions."""
        now = now or time.time()
        cutoff = now - window_sec
        penetrations: list[int] = []
        for e in self._events:
            if e.ts >= cutoff and e.action == "execute" and e.levels_penetrated > 0:
                penetrations.append(e.levels_penetrated)
        return round(sum(penetrations) / len(penetrations), 2) if penetrations else None

    def sweep_count(self, window_sec: float, now: float | None = None) -> int:
        """Count of executions that penetrated 3+ levels (sweeps)."""
        now = now or time.time()
        cutoff = now - window_sec
        return sum(1 for e in self._events
                   if e.ts >= cutoff and e.action == "execute" and e.levels_penetrated >= 3)

    @property
    def event_count(self) -> int:
        return len(self._events)
