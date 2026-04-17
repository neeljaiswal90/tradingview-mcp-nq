"""
rolling.py — Time-windowed rolling buffers for trade flow, depth, and MBO aggregates.

All buffers are append-only with automatic expiry. No external dependencies.
Shared between live sidecar and offline replay.
"""

from __future__ import annotations

import math
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
        for t in list(self._trades):
            if t.ts >= cutoff:
                delta += t.size if t.is_buy else -t.size
        return delta

    def trade_flow_imbalance(self, window_sec: float, now: float | None = None) -> Optional[float]:
        """buy_volume / total_volume over the window. Range [0, 1]."""
        now = now or time.time()
        cutoff = now - window_sec
        buy_vol = 0
        total_vol = 0
        for t in list(self._trades):
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


# â”€â”€â”€ Rolling scalp-state / BBO flow state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@dataclass
class BboContribution:
    ts_ms: int
    e: float


@dataclass
class MidTickDelta:
    ts_ms: int
    delta_ticks: float


class RollingScalpState:
    """Rolling best-of-book state for the lob_mbo_scalp snapshot contract."""

    def __init__(
        self,
        max_window_sec: float = 3.0,
        z_warmup_samples: int = 30,
        history_limit: int = 300,
    ):
        self.max_window_ms = int(max_window_sec * 1000)
        self.z_warmup_samples = z_warmup_samples
        self.history_limit = history_limit

        self.last_ts_ms: Optional[int] = None
        self.last_best_bid: Optional[float] = None
        self.last_best_ask: Optional[float] = None
        self.last_bid_size: Optional[int] = None
        self.last_ask_size: Optional[int] = None

        self.contributions: Deque[BboContribution] = deque()
        self.mid_tick_deltas: Deque[MidTickDelta] = deque()
        self.ofi_250ms_history: Deque[float] = deque()
        self.ofi_1s_history: Deque[float] = deque()
        self.ofi_3s_history: Deque[float] = deque()

    def observe_bbo(
        self,
        ts_ms: int,
        bid: float,
        ask: float,
        bid_size: int,
        ask_size: int,
    ) -> None:
        if not self._valid_bbo(bid, ask, bid_size, ask_size):
            return
        if self.last_ts_ms is not None and ts_ms <= self.last_ts_ms:
            return

        prev_mid = None
        if self.last_best_bid is not None and self.last_best_ask is not None:
            prev_mid = (self.last_best_bid + self.last_best_ask) / 2.0

        if (
            self.last_best_bid is not None and
            self.last_best_ask is not None and
            self.last_bid_size is not None and
            self.last_ask_size is not None
        ):
            e_k = self._compute_ofi_contribution(
                self.last_best_bid,
                self.last_best_ask,
                self.last_bid_size,
                self.last_ask_size,
                bid,
                ask,
                bid_size,
                ask_size,
            )
            self.contributions.append(BboContribution(ts_ms=ts_ms, e=e_k))

        current_mid = (bid + ask) / 2.0
        if prev_mid is not None:
            self.mid_tick_deltas.append(
                MidTickDelta(ts_ms=ts_ms, delta_ticks=(current_mid - prev_mid) / NQ_TICK_SIZE)
            )

        self.last_ts_ms = ts_ms
        self.last_best_bid = bid
        self.last_best_ask = ask
        self.last_bid_size = bid_size
        self.last_ask_size = ask_size

        self._expire(ts_ms)
        self._append_history(self.ofi_250ms_history, self.window_total(250, ts_ms))
        self._append_history(self.ofi_1s_history, self.window_total(1000, ts_ms))
        self._append_history(self.ofi_3s_history, self.window_total(3000, ts_ms))

    def current_features(self, now_ms: int | None = None) -> dict[str, Optional[float]]:
        if now_ms is None:
            now_ms = self.last_ts_ms
        if now_ms is None:
            return {
                "ofi_250ms": None,
                "ofi_1s": None,
                "ofi_3s": None,
                "z_ofi_250ms": None,
                "z_ofi_1s": None,
                "z_ofi_3s": None,
                "sigma_1s_ticks": None,
            }

        self._expire(now_ms)
        ofi_250ms = self.window_total(250, now_ms)
        ofi_1s = self.window_total(1000, now_ms)
        ofi_3s = self.window_total(3000, now_ms)

        return {
            "ofi_250ms": round(ofi_250ms, 4),
            "ofi_1s": round(ofi_1s, 4),
            "ofi_3s": round(ofi_3s, 4),
            "z_ofi_250ms": self._zscore(self.ofi_250ms_history, ofi_250ms),
            "z_ofi_1s": self._zscore(self.ofi_1s_history, ofi_1s),
            "z_ofi_3s": self._zscore(self.ofi_3s_history, ofi_3s),
            "sigma_1s_ticks": self._sigma_1s_ticks(now_ms),
        }

    def window_total(self, window_ms: int, now_ms: int) -> float:
        cutoff = now_ms - window_ms
        total = 0.0
        for c in self.contributions:
            if c.ts_ms >= cutoff:
                total += c.e
        return total

    def _sigma_1s_ticks(self, now_ms: int) -> Optional[float]:
        cutoff = now_ms - 1000
        xs = [d.delta_ticks for d in self.mid_tick_deltas if d.ts_ms >= cutoff]
        if not xs:
            return None
        mean = sum(xs) / len(xs)
        variance = sum((x - mean) ** 2 for x in xs) / len(xs)
        return round(math.sqrt(max(0.0, variance)), 4)

    def _zscore(self, history: Deque[float], current: float) -> Optional[float]:
        if len(history) < self.z_warmup_samples:
            return None
        mean = sum(history) / len(history)
        variance = sum((x - mean) ** 2 for x in history) / len(history)
        std = math.sqrt(max(0.0, variance))
        if std <= 0:
            return 0.0
        return round((current - mean) / std, 4)

    def _append_history(self, history: Deque[float], value: float) -> None:
        history.append(value)
        while len(history) > self.history_limit:
            history.popleft()

    def _expire(self, now_ms: int) -> None:
        cutoff = now_ms - self.max_window_ms
        while self.contributions and self.contributions[0].ts_ms < cutoff:
            self.contributions.popleft()
        sigma_cutoff = now_ms - 1000
        while self.mid_tick_deltas and self.mid_tick_deltas[0].ts_ms < sigma_cutoff:
            self.mid_tick_deltas.popleft()

    @staticmethod
    def _valid_bbo(
        bid: float,
        ask: float,
        bid_size: int,
        ask_size: int,
    ) -> bool:
        return (
            isinstance(bid, (int, float)) and
            isinstance(ask, (int, float)) and
            isinstance(bid_size, int) and
            isinstance(ask_size, int) and
            bid > 0 and ask > bid and bid_size > 0 and ask_size > 0
        )

    @staticmethod
    def _compute_ofi_contribution(
        prev_bid: float,
        prev_ask: float,
        prev_bid_size: int,
        prev_ask_size: int,
        bid: float,
        ask: float,
        bid_size: int,
        ask_size: int,
    ) -> float:
        if bid > prev_bid:
            i_bid = bid_size
        elif bid == prev_bid:
            i_bid = bid_size - prev_bid_size
        else:
            i_bid = -prev_bid_size

        if ask < prev_ask:
            i_ask = ask_size
        elif ask == prev_ask:
            i_ask = ask_size - prev_ask_size
        else:
            i_ask = -prev_ask_size

        return float(i_bid - i_ask)


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
        for e in list(self._events):
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
        for e in list(self._events):
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
        for e in list(self._events):
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
        for e in list(self._events):
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
        for e in list(self._events):
            if e.ts >= cutoff and e.action == "execute" and e.levels_penetrated > 0:
                penetrations.append(e.levels_penetrated)
        return round(sum(penetrations) / len(penetrations), 2) if penetrations else None

    def sweep_count(self, window_sec: float, now: float | None = None) -> int:
        """Count of executions that penetrated 3+ levels (sweeps)."""
        now = now or time.time()
        cutoff = now - window_sec
        return sum(1 for e in list(self._events)
                   if e.ts >= cutoff and e.action == "execute" and e.levels_penetrated >= 3)

    @property
    def event_count(self) -> int:
        return len(self._events)
