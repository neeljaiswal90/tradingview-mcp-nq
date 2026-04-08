"""
microstructure.py — Derived microstructure features for NQ management/entry ML.

Five feature families, all computed from the rolling trade/depth/MBO buffers:
  A. Absorption scoring
  B. Enhanced sweep detection
  C. Footprint delta/imbalance
  D. Large trade clustering
  E. Session volume profile

All features are optional and return None when insufficient data exists.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional, Deque
from collections import deque

NQ_TICK_SIZE = 0.25
LARGE_TRADE_THRESHOLD = 20  # contracts — configurable


# ═══════════════════════════════════════════════════════════════════════════════
# A. ABSORPTION SCORING
# ═══════════════════════════════════════════════════════════════════════════════

class AbsorptionDetector:
    """
    Detects defended price levels where passive orders absorb aggressive flow
    without significant price displacement.

    Heuristic: at a given price level over a window, if executions are high
    but price doesn't move away, the level is being defended.
    """

    def __init__(self, window_sec: float = 10.0, tick_size: float = NQ_TICK_SIZE):
        self._trades: Deque[tuple[float, float, int, bool]] = deque()  # ts, price, size, is_buy
        self.window_sec = window_sec
        self.tick_size = tick_size

    def add_trade(self, ts: float, price: float, size: int, is_buy: bool) -> None:
        self._trades.append((ts, price, size, is_buy))
        self._expire(ts)

    def _expire(self, now: float) -> None:
        cutoff = now - self.window_sec
        while self._trades and self._trades[0][0] < cutoff:
            self._trades.popleft()

    def _level_scores(self, now: float) -> dict[float, dict]:
        """Group trades by price level and compute absorption metrics."""
        cutoff = now - self.window_sec
        levels: dict[float, dict] = defaultdict(lambda: {"buy_vol": 0, "sell_vol": 0, "count": 0})
        for ts, price, size, is_buy in list(self._trades):
            if ts >= cutoff:
                rounded = round(price / self.tick_size) * self.tick_size
                entry = levels[rounded]
                if is_buy:
                    entry["buy_vol"] += size
                else:
                    entry["sell_vol"] += size
                entry["count"] += 1
        return dict(levels)

    def absorption_score(self, now: float | None = None) -> Optional[float]:
        """Overall absorption score: max(bid_score, ask_score)."""
        now = now or time.time()
        bid = self.absorption_bid_score(now)
        ask = self.absorption_ask_score(now)
        if bid is None and ask is None:
            return None
        return max(bid or 0, ask or 0)

    def absorption_bid_score(self, now: float | None = None) -> Optional[float]:
        """Bid-side absorption: high sell volume absorbed without price drop."""
        now = now or time.time()
        levels = self._level_scores(now)
        if not levels:
            return None
        max_score = 0.0
        for price, data in levels.items():
            sell_vol = data["sell_vol"]
            buy_vol = data["buy_vol"]
            if sell_vol > 10:  # minimum threshold
                # Score: sell volume absorbed relative to displacement
                # Higher score = more absorption at this level
                max_score = max(max_score, sell_vol / max(buy_vol + 1, 1))
        return round(max_score, 4) if max_score > 0 else None

    def absorption_ask_score(self, now: float | None = None) -> Optional[float]:
        """Ask-side absorption: high buy volume absorbed without price rise."""
        now = now or time.time()
        levels = self._level_scores(now)
        if not levels:
            return None
        max_score = 0.0
        for price, data in levels.items():
            buy_vol = data["buy_vol"]
            sell_vol = data["sell_vol"]
            if buy_vol > 10:
                max_score = max(max_score, buy_vol / max(sell_vol + 1, 1))
        return round(max_score, 4) if max_score > 0 else None

    def strongest_absorption_price(self, now: float | None = None) -> Optional[float]:
        """Price with the highest total absorbed volume."""
        now = now or time.time()
        levels = self._level_scores(now)
        if not levels:
            return None
        best_price = max(levels, key=lambda p: levels[p]["buy_vol"] + levels[p]["sell_vol"])
        return best_price


# ═══════════════════════════════════════════════════════════════════════════════
# B. ENHANCED SWEEP DETECTION
# ═══════════════════════════════════════════════════════════════════════════════

class SweepDetector:
    """Detect aggressive multi-level penetrations (stop runs / liquidity grabs)."""

    def __init__(self, window_sec: float = 10.0):
        self._sweeps: Deque[tuple[float, str, float, int, int]] = deque()  # ts, side, price, vol, levels
        self.window_sec = window_sec

    def record_sweep(self, ts: float, side: str, price: float, volume: int, levels: int) -> None:
        self._sweeps.append((ts, side, price, volume, levels))
        cutoff = ts - self.window_sec * 3  # keep 3x window for lookback
        while self._sweeps and self._sweeps[0][0] < cutoff:
            self._sweeps.popleft()

    def sweep_volume(self, window_sec: float | None = None, now: float | None = None) -> int:
        now = now or time.time()
        ws = window_sec or self.window_sec
        return sum(v for ts, _, _, v, _ in list(self._sweeps) if ts >= now - ws)

    def max_sweep_levels(self, window_sec: float | None = None, now: float | None = None) -> int:
        now = now or time.time()
        ws = window_sec or self.window_sec
        recent = [lvl for ts, _, _, _, lvl in list(self._sweeps) if ts >= now - ws]
        return max(recent) if recent else 0

    def last_sweep_side(self, now: float | None = None) -> Optional[str]:
        now = now or time.time()
        recent = [(ts, side) for ts, side, _, _, _ in list(self._sweeps) if ts >= now - self.window_sec]
        return recent[-1][1] if recent else None

    def last_sweep_price(self, now: float | None = None) -> Optional[float]:
        now = now or time.time()
        recent = [(ts, price) for ts, _, price, _, _ in list(self._sweeps) if ts >= now - self.window_sec]
        return recent[-1][1] if recent else None

    def sweep_count(self, window_sec: float | None = None, now: float | None = None) -> int:
        now = now or time.time()
        ws = window_sec or self.window_sec
        return sum(1 for ts, _, _, _, _ in list(self._sweeps) if ts >= now - ws)


# ═══════════════════════════════════════════════════════════════════════════════
# C. FOOTPRINT DELTA / IMBALANCE
# ═══════════════════════════════════════════════════════════════════════════════

class FootprintTracker:
    """Rolling per-price trade flow tracker for footprint-style analysis."""

    def __init__(self, max_window_sec: float = 60.0, tick_size: float = NQ_TICK_SIZE):
        self._trades: Deque[tuple[float, float, int, bool]] = deque()  # ts, price, size, is_buy
        self.max_window_sec = max_window_sec
        self.tick_size = tick_size

    def add_trade(self, ts: float, price: float, size: int, is_buy: bool) -> None:
        self._trades.append((ts, price, size, is_buy))
        cutoff = ts - self.max_window_sec
        while self._trades and self._trades[0][0] < cutoff:
            self._trades.popleft()

    def delta(self, window_sec: float, now: float | None = None) -> float:
        """Buy volume - sell volume over window."""
        now = now or time.time()
        cutoff = now - window_sec
        return sum(sz if ib else -sz for ts, _, sz, ib in list(self._trades) if ts >= cutoff)

    def imbalance_ratio(self, window_sec: float, now: float | None = None) -> Optional[float]:
        """Absolute delta / total volume. 0 = balanced, 1 = fully one-sided."""
        now = now or time.time()
        cutoff = now - window_sec
        buy_vol = sum(sz for ts, _, sz, ib in list(self._trades) if ts >= cutoff and ib)
        sell_vol = sum(sz for ts, _, sz, ib in list(self._trades) if ts >= cutoff and not ib)
        total = buy_vol + sell_vol
        if total == 0:
            return None
        return round(abs(buy_vol - sell_vol) / total, 4)

    def stacked_imbalance_count(self, window_sec: float, threshold: float = 3.0,
                                 now: float | None = None) -> int:
        """Count price levels where buy/sell ratio exceeds threshold (stacked imbalance)."""
        now = now or time.time()
        cutoff = now - window_sec
        levels: dict[float, dict] = defaultdict(lambda: {"buy": 0, "sell": 0})
        for ts, price, size, is_buy in list(self._trades):
            if ts >= cutoff:
                rounded = round(price / self.tick_size) * self.tick_size
                if is_buy:
                    levels[rounded]["buy"] += size
                else:
                    levels[rounded]["sell"] += size

        count = 0
        for data in levels.values():
            b, s = data["buy"], data["sell"]
            if s > 0 and b / s >= threshold:
                count += 1
            elif b > 0 and s / b >= threshold:
                count += 1
        return count

    def dominant_aggressor(self, window_sec: float = 10.0, now: float | None = None) -> Optional[str]:
        """Which side is dominating recent flow."""
        now = now or time.time()
        d = self.delta(window_sec, now)
        if d > 5:
            return "buy"
        elif d < -5:
            return "sell"
        return "neutral"


# ═══════════════════════════════════════════════════════════════════════════════
# D. LARGE TRADE CLUSTERING
# ═══════════════════════════════════════════════════════════════════════════════

class LargeTradeTracker:
    """Track clustering of large prints in the trade stream."""

    def __init__(self, threshold: int = LARGE_TRADE_THRESHOLD, max_window_sec: float = 30.0):
        self._large: Deque[tuple[float, float, int, bool]] = deque()  # ts, price, size, is_buy
        self.threshold = threshold
        self.max_window_sec = max_window_sec

    def add_trade(self, ts: float, price: float, size: int, is_buy: bool) -> None:
        if size >= self.threshold:
            self._large.append((ts, price, size, is_buy))
        cutoff = ts - self.max_window_sec
        while self._large and self._large[0][0] < cutoff:
            self._large.popleft()

    def count(self, window_sec: float, now: float | None = None) -> int:
        now = now or time.time()
        return sum(1 for ts, _, _, _ in list(self._large) if ts >= now - window_sec)

    def volume(self, window_sec: float, now: float | None = None) -> int:
        now = now or time.time()
        return sum(sz for ts, _, sz, _ in list(self._large) if ts >= now - window_sec)

    def largest_size(self, window_sec: float, now: float | None = None) -> int:
        now = now or time.time()
        sizes = [sz for ts, _, sz, _ in list(self._large) if ts >= now - window_sec]
        return max(sizes) if sizes else 0

    def buy_sell_imbalance(self, window_sec: float, now: float | None = None) -> Optional[float]:
        """buy_vol / total_vol for large trades."""
        now = now or time.time()
        buy = sum(sz for ts, _, sz, ib in list(self._large) if ts >= now - window_sec and ib)
        sell = sum(sz for ts, _, sz, ib in list(self._large) if ts >= now - window_sec and not ib)
        total = buy + sell
        return round(buy / total, 4) if total > 0 else None


# ═══════════════════════════════════════════════════════════════════════════════
# E. SESSION VOLUME PROFILE
# ═══════════════════════════════════════════════════════════════════════════════

class SessionVolumeProfile:
    """
    Builds a running volume-at-price profile for the current session.
    Computes VPOC, VAH, VAL from accumulated trade data.
    """

    def __init__(self, tick_size: float = NQ_TICK_SIZE, value_area_pct: float = 0.70):
        self._profile: dict[float, int] = defaultdict(int)  # price_level -> total_volume
        self._total_volume = 0
        self.tick_size = tick_size
        self.value_area_pct = value_area_pct

    def add_trade(self, price: float, size: int) -> None:
        level = round(price / self.tick_size) * self.tick_size
        self._profile[level] += size
        self._total_volume += size

    def reset(self) -> None:
        self._profile.clear()
        self._total_volume = 0

    @property
    def vpoc(self) -> Optional[float]:
        """Volume Point of Control — price with highest volume."""
        if not self._profile:
            return None
        return max(self._profile, key=self._profile.get)  # type: ignore

    def value_area(self) -> tuple[Optional[float], Optional[float]]:
        """(VAL, VAH) — price range containing value_area_pct of total volume."""
        if not self._profile or self._total_volume == 0:
            return None, None

        poc = self.vpoc
        if poc is None:
            return None, None

        target = self._total_volume * self.value_area_pct
        sorted_levels = sorted(self._profile.keys())
        poc_idx = sorted_levels.index(poc)

        accumulated = self._profile[poc]
        low_idx = poc_idx
        high_idx = poc_idx

        while accumulated < target and (low_idx > 0 or high_idx < len(sorted_levels) - 1):
            expand_down = self._profile.get(sorted_levels[low_idx - 1], 0) if low_idx > 0 else 0
            expand_up = self._profile.get(sorted_levels[high_idx + 1], 0) if high_idx < len(sorted_levels) - 1 else 0

            if expand_down >= expand_up and low_idx > 0:
                low_idx -= 1
                accumulated += self._profile[sorted_levels[low_idx]]
            elif high_idx < len(sorted_levels) - 1:
                high_idx += 1
                accumulated += self._profile[sorted_levels[high_idx]]
            else:
                break

        return sorted_levels[low_idx], sorted_levels[high_idx]

    @property
    def val(self) -> Optional[float]:
        v, _ = self.value_area()
        return v

    @property
    def vah(self) -> Optional[float]:
        _, v = self.value_area()
        return v

    def distance_to_vpoc(self, current_price: float) -> Optional[float]:
        v = self.vpoc
        return round(current_price - v, 2) if v is not None else None

    def inside_value_area(self, price: float) -> Optional[bool]:
        lo, hi = self.value_area()
        if lo is None or hi is None:
            return None
        return lo <= price <= hi

    @property
    def level_count(self) -> int:
        return len(self._profile)
