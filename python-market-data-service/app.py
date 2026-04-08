#!/usr/bin/env python3
"""
Market Data Sidecar — Full Bookmap/Rithmic LOB bridge with:

  - WebSocket ingest from Bookmap addon (BBO, trades, depth, MBO)
  - Rolling feature computation via shared lob_features module
  - JSONL recording: session snapshots, trade snapshots, events, intents
  - Context endpoints for trade/signal correlation
  - REST snapshot endpoint for TypeScript fast-path consumption

Endpoints:
  GET  /lob/health              — service health + data freshness
  GET  /lob/snapshot            — full feature snapshot (all computed features)
  POST /trade_context/start     — mark trade open (high-frequency recording begins)
  POST /trade_context/end       — mark trade close (post-exit window, then resume session rate)
  POST /signal_context/start    — mark signal evaluation window (pre-entry capture)
  POST /signal_context/end      — end signal window

WebSocket:
  ws://127.0.0.1:5010/ws/bookmap  — ingest from Bookmap addon

Start:
  python python-market-data-service/app.py
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from lob_features.schema import LobFeatureSnapshot
from lob_features.rolling import RollingTradeBuffer, RollingDepthState, RollingMboAggregator
from lob_features.advanced_mbo import AdvancedMboAnalyzer, RichMboEvent
from lob_features.compute import compute_lob_features
from lob_features.microstructure import (
    AbsorptionDetector, SweepDetector, FootprintTracker,
    LargeTradeTracker, SessionVolumeProfile,
)

NQ_TICK_SIZE = 0.25

# ─── JSONL Writer ─────────────────────────────────────────────────────────────

LOG_DIR = os.environ.get("LOG_DIR", os.path.join(os.path.dirname(__file__), "..", "logs"))


def _ensure_log_dir():
    os.makedirs(LOG_DIR, exist_ok=True)


def append_jsonl(filename: str, record: dict) -> None:
    """Append one JSON line to a log file. Non-blocking, non-throwing."""
    try:
        path = os.path.join(LOG_DIR, filename)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, default=str) + "\n")
    except Exception as e:
        print(f"[LOG] Write error {filename}: {e}")


# ─── Global State ─────────────────────────────────────────────────────────────

class SidecarState:
    def __init__(self):
        self.bid: Optional[float] = None
        self.ask: Optional[float] = None
        self.bid_size: Optional[int] = None
        self.ask_size: Optional[int] = None
        self.last_bbo_ts: float = 0.0
        self.connected: bool = False
        self.update_count: int = 0
        self.trade_count: int = 0
        self.last_heartbeat_ts: float = 0.0

        # Rolling buffers (shared computation module)
        self.trade_buf = RollingTradeBuffer(max_window_sec=60.0)
        self.depth = RollingDepthState()
        self.mbo_agg = RollingMboAggregator(max_window_sec=60.0)
        self.advanced_mbo = AdvancedMboAnalyzer(max_window_sec=60.0)

        # MBO capability tracking
        self.mbo_ever_seen: bool = False       # True once any MBO event is received
        self.mbo_total_count: int = 0          # lifetime count (not windowed)
        self.last_mbo_ts: float = 0.0          # epoch seconds of last MBO event

        # Microstructure feature trackers
        self.absorption = AbsorptionDetector(window_sec=10.0)
        self.sweeps = SweepDetector(window_sec=10.0)
        self.footprint = FootprintTracker(max_window_sec=60.0)
        self.large_trades = LargeTradeTracker(threshold=20, max_window_sec=30.0)
        self.volume_profile = SessionVolumeProfile()

        # Context state
        self.active_trade_id: Optional[str] = None
        self.active_signal_id: Optional[str] = None
        self.trade_end_ts: Optional[float] = None  # for post-exit window

        # Recording cadence
        self.last_session_record_ts: float = 0.0
        self.last_trade_record_ts: float = 0.0

    @property
    def mid(self) -> Optional[float]:
        if self.bid is not None and self.ask is not None:
            return round((self.bid + self.ask) / 2, 2)
        return None

    @property
    def bbo_age_ms(self) -> float:
        if self.last_bbo_ts == 0:
            return 99999
        return round((time.time() - self.last_bbo_ts) * 1000, 1)

    @property
    def is_fresh(self) -> bool:
        return self.bbo_age_ms < 3000

    @property
    def mbo_age_ms(self) -> float:
        if self.last_mbo_ts == 0:
            return 99999
        return round((time.time() - self.last_mbo_ts) * 1000, 1)

    @property
    def mbo_status(self) -> str:
        """Honest MBO capability/freshness status."""
        if not self.mbo_ever_seen:
            return "idle"           # MBO support exists but no events received yet
        if self.mbo_age_ms < 5000:
            return "active"         # MBO flowing normally
        return "stale"              # MBO was seen but has gone quiet

    @property
    def recording_context(self) -> str:
        if self.active_trade_id:
            return "trade"
        if self.active_signal_id:
            return "pre_entry"
        if self.trade_end_ts and (time.time() - self.trade_end_ts) < 30:
            return "post_exit"
        return "session"

    def compute_snapshot(self) -> LobFeatureSnapshot:
        return compute_lob_features(
            bid=self.bid, ask=self.ask,
            bid_size=self.bid_size, ask_size=self.ask_size,
            trade_buf=self.trade_buf,
            depth=self.depth,
            mbo_agg=self.mbo_agg,
            now=time.time(),
            recording_context=self.recording_context,
            trade_id=self.active_trade_id,
            signal_id=self.active_signal_id,
            advanced_mbo=self.advanced_mbo,
            absorption=self.absorption,
            sweeps=self.sweeps,
            footprint=self.footprint,
            large_trades=self.large_trades,
            volume_profile=self.volume_profile,
            current_price=self.mid,
        )


state = SidecarState()
START_TIME = time.time()

# ─── Recording Policy ────────────────────────────────────────────────────────

SESSION_RECORD_INTERVAL_SEC = 5.0   # continuous low-frequency
TRADE_RECORD_INTERVAL_SEC = 1.0     # higher frequency during trades
POST_EXIT_WINDOW_SEC = 30.0         # continue recording after trade close


def maybe_record_snapshot():
    """Called after every event. Records based on context + cadence."""
    now = time.time()
    ctx = state.recording_context

    if ctx == "trade" or ctx == "pre_entry":
        if (now - state.last_trade_record_ts) >= TRADE_RECORD_INTERVAL_SEC:
            snap = state.compute_snapshot()
            append_jsonl("lob_snapshots.jsonl", snap.to_dict())
            state.last_trade_record_ts = now
    elif ctx == "post_exit":
        if (now - state.last_trade_record_ts) >= TRADE_RECORD_INTERVAL_SEC:
            snap = state.compute_snapshot()
            append_jsonl("lob_snapshots.jsonl", snap.to_dict())
            state.last_trade_record_ts = now
    # Always record session snapshots at low frequency
    if (now - state.last_session_record_ts) >= SESSION_RECORD_INTERVAL_SEC:
        snap = state.compute_snapshot()
        append_jsonl("lob_session_snapshots.jsonl", snap.to_dict())
        state.last_session_record_ts = now


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    _ensure_log_dir()
    print(f"[MKT-DATA] Sidecar starting, logs -> {LOG_DIR}")
    yield
    print("[MKT-DATA] Shutting down")


# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="NQ Market Data Sidecar",
    description="Bookmap/Rithmic LOB bridge with feature computation + recording",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── WebSocket Ingest ─────────────────────────────────────────────────────────

@app.websocket("/ws/bookmap")
async def bookmap_ingest(ws: WebSocket):
    await ws.accept()
    state.connected = True
    print("[MKT-DATA] Bookmap addon connected")

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
                msg_type = msg.get("type")
                ts_ms = msg.get("ts", int(time.time() * 1000))
                ts = ts_ms / 1000.0

                if msg_type == "bbo":
                    state.bid = msg["bid"]
                    state.ask = msg["ask"]
                    state.bid_size = msg["bid_sz"]
                    state.ask_size = msg["ask_sz"]
                    state.last_bbo_ts = ts
                    state.update_count += 1

                elif msg_type == "trade":
                    is_buy = msg.get("aggressor", "buy") == "buy"
                    trade_price = msg["price"]
                    trade_raw_price = msg.get("raw_price")
                    trade_size = msg["size"]
                    state.trade_buf.add(ts, trade_price, trade_size, is_buy)
                    state.trade_count += 1
                    # Feed microstructure trackers
                    state.absorption.add_trade(ts, trade_price, trade_size, is_buy)
                    state.footprint.add_trade(ts, trade_price, trade_size, is_buy)
                    state.large_trades.add_trade(ts, trade_price, trade_size, is_buy)
                    state.volume_profile.add_trade(trade_price, trade_size)
                    # Log compact trade event
                    event_record = {
                        "type": "trade", "ts": ts_ms,
                        "price": trade_price, "size": trade_size,
                        "aggressor": msg.get("aggressor"),
                        "trade_id": state.active_trade_id,
                    }
                    if isinstance(trade_raw_price, (int, float)):
                        event_record["raw_price"] = trade_raw_price
                    if "price_scale_source" in msg:
                        event_record["price_scale_source"] = msg.get("price_scale_source")
                    append_jsonl("lob_events_compact.jsonl", event_record)

                elif msg_type == "depth":
                    state.depth.update(msg["side"], msg["price"], msg["size"], ts)

                elif msg_type == "mbo":
                    # Robust parsing: all fields optional with safe defaults.
                    # The Java addon may omit price/size on cancel events if
                    # order state was not tracked, and side may be "unknown".
                    mbo_action = msg.get("action", "unknown")
                    mbo_side = msg.get("side", "unknown")
                    mbo_price = msg.get("price", 0.0)
                    mbo_size = msg.get("size", 0)
                    mbo_order_id = msg.get("order_id", "")
                    mbo_top = msg.get("top_of_book", False)
                    mbo_levels = msg.get("levels_penetrated", 0)

                    # Skip events with unknown side for aggregators that
                    # need bid/ask classification, but still count them.
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

                    # Track MBO capability state regardless of side validity
                    state.mbo_ever_seen = True
                    state.mbo_total_count += 1
                    state.last_mbo_ts = ts

                elif msg_type == "heartbeat":
                    state.last_heartbeat_ts = ts

                # Recording policy: check after every event
                maybe_record_snapshot()

            except (KeyError, TypeError, json.JSONDecodeError) as e:
                print(f"[MKT-DATA] Parse error: {e}")

    except WebSocketDisconnect:
        state.connected = False
        print("[MKT-DATA] Bookmap addon disconnected")


# ─── REST: Health ─────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: str
    source_connected: bool
    bbo_fresh: bool
    bbo_age_ms: float
    update_count: int
    trade_count: int
    depth_levels_bid: int
    depth_levels_ask: int
    # MBO status — honest capability reporting
    mbo_events_buffered: int        # windowed count (rolling 60s)
    mbo_total_count: int            # lifetime event count
    mbo_status: str                 # "idle" | "active" | "stale"
    mbo_age_ms: float               # ms since last MBO event (99999 if never)
    mbo_adv_event_count: int        # events in advanced analyzer window
    # Context
    active_trade_id: Optional[str]
    active_signal_id: Optional[str]
    recording_context: str
    uptime_sec: float


@app.get("/lob/health", response_model=HealthResponse)
def lob_health():
    return HealthResponse(
        status="ok" if state.connected and state.is_fresh else "degraded",
        source_connected=state.connected,
        bbo_fresh=state.is_fresh,
        bbo_age_ms=state.bbo_age_ms,
        update_count=state.update_count,
        trade_count=state.trade_count,
        depth_levels_bid=len(state.depth.bids),
        depth_levels_ask=len(state.depth.asks),
        mbo_events_buffered=state.mbo_agg.event_count,
        mbo_total_count=state.mbo_total_count,
        mbo_status=state.mbo_status,
        mbo_age_ms=state.mbo_age_ms,
        mbo_adv_event_count=state.advanced_mbo.event_count,
        active_trade_id=state.active_trade_id,
        active_signal_id=state.active_signal_id,
        recording_context=state.recording_context,
        uptime_sec=round(time.time() - START_TIME, 1),
    )


# ─── REST: Full Feature Snapshot ──────────────────────────────────────────────

@app.get("/lob/snapshot")
def lob_snapshot():
    snap = state.compute_snapshot()
    return snap.to_dict()


# ─── REST: Context Endpoints ─────────────────────────────────────────────────

class TradeContextRequest(BaseModel):
    trade_id: str
    side: Optional[str] = None
    entry_price: Optional[float] = None

class SignalContextRequest(BaseModel):
    signal_id: str
    direction: Optional[str] = None


@app.post("/trade_context/start")
def trade_context_start(req: TradeContextRequest):
    state.active_trade_id = req.trade_id
    state.trade_end_ts = None
    state.last_trade_record_ts = 0  # force immediate snapshot
    # Record the intent
    append_jsonl("execution_intents.jsonl", {
        "type": "trade_start", "ts": int(time.time() * 1000),
        "trade_id": req.trade_id, "side": req.side,
        "entry_price": req.entry_price,
    })
    # Immediate snapshot at trade start
    snap = state.compute_snapshot()
    append_jsonl("lob_snapshots.jsonl", snap.to_dict())
    print(f"[CTX] Trade started: {req.trade_id}")
    return {"status": "ok", "trade_id": req.trade_id, "recording_context": "trade"}


@app.post("/trade_context/end")
def trade_context_end(req: TradeContextRequest):
    # Final snapshot before clearing trade context
    snap = state.compute_snapshot()
    append_jsonl("lob_snapshots.jsonl", snap.to_dict())
    append_jsonl("execution_results.jsonl", {
        "type": "trade_end", "ts": int(time.time() * 1000),
        "trade_id": req.trade_id,
    })
    state.trade_end_ts = time.time()
    state.active_trade_id = None
    print(f"[CTX] Trade ended: {req.trade_id} (post-exit recording for {POST_EXIT_WINDOW_SEC}s)")
    return {"status": "ok", "trade_id": req.trade_id, "recording_context": "post_exit"}


@app.post("/signal_context/start")
def signal_context_start(req: SignalContextRequest):
    state.active_signal_id = req.signal_id
    state.last_trade_record_ts = 0  # force immediate snapshot
    snap = state.compute_snapshot()
    append_jsonl("lob_snapshots.jsonl", snap.to_dict())
    print(f"[CTX] Signal window started: {req.signal_id}")
    return {"status": "ok", "signal_id": req.signal_id}


@app.post("/signal_context/end")
def signal_context_end(req: SignalContextRequest):
    snap = state.compute_snapshot()
    append_jsonl("lob_snapshots.jsonl", snap.to_dict())
    state.active_signal_id = None
    print(f"[CTX] Signal window ended: {req.signal_id}")
    return {"status": "ok", "signal_id": req.signal_id}


# ─── Direct run ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("MKT_DATA_PORT", "5010"))
    print(f"[MKT-DATA] Starting on http://127.0.0.1:{port}")
    uvicorn.run("app:app", host="127.0.0.1", port=port, log_level="info")
