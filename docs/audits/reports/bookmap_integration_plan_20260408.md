# Bookmap + Rithmic Integration Plan

**Date:** 2026-04-08
**Status:** Design phase — no implementation yet

---

## 1. Current Repo Architecture

The trading engine is a TypeScript Node.js application that reads market data from TradingView Desktop via Chrome DevTools Protocol (CDP). Two data paths feed the trading logic:

**Fast path (1-2s, in-position):** `QuoteService.fetchFresh()` fetches a single price from TradingView's chart header DOM. This drives `PositionManager.evaluate()` (hard stops, targets, PT1/PT2, trailing) and the ML inference call (`getMlDecision()`). The quote has bid/ask fields but they are rarely populated by TradingView.

**Slow path (5-60s, flat or analysis):** `DataCollector.collect()` switches the TradingView chart across four timeframes (1m, 5m, 15m, 1h), collecting OHLCV bars, study values (EMA, ATR, RSI, VWAP, ADX, TTM, CVD, SuperTrend, Smart Money), Pine Script lines/labels, and session context. The result is a `MarketSnapshot` used by `generateSignal()` for entry decisions.

**ML pipeline:** A Python FastAPI service (port 5001) serves CatBoost management models. The TypeScript feature builder (`ml/feature-builder.ts`) constructs a 22-field vector from `Position` state and current price — no order book data is currently included. Training data is built offline from `trades.jsonl` + `trade_path.jsonl` by Python scripts under `scripts/ml/`.

**Key limitation:** The system has zero order-book visibility. No depth, no MBO, no trade flow, no bid-ask spread, no imbalance data. All price information comes from TradingView's rendered chart state, which is a single top-of-book price with up to 1-second staleness.

---

## 2. Where Bookmap Data Should Enter the System

Bookmap data provides three distinct value layers, each entering at a different point:

### Layer A: Real-Time BBO + Spread (fast path enrichment)

**What:** Best bid, best ask, spread, mid-price — updated on every BBO event (sub-100ms).
**Where it enters:** Alongside or replacing `QuoteService.fetchFresh()`. A new `BookmapQuoteProvider` would supply BBO data to the monitor loop, giving the Position Manager and ML inference access to bid/ask spread and mid-price instead of a single last-trade price.
**Files affected:** `src/autotrade/quote-service.ts` (add provider interface), `src/autotrade/runner.ts` (wire provider), `QuoteResult` type (bid/ask already optional fields).
**Latency requirement:** < 50ms from Bookmap to TypeScript.

### Layer B: LOB Features (ML enrichment)

**What:** Derived features computed from full depth: bid-ask imbalance ratio, depth-weighted mid-price, cumulative delta, large resting order detection, absorption rate, trade flow imbalance over rolling windows.
**Where it enters:** The ML feature vector (`MlFeatureVector` in `src/autotrade/ml/types.ts`) and the Python inference schema (`ManagementRequest` in `python-ml-service/schemas.py`). Features are joined at inference time, not at data collection time.
**Files affected:** `src/autotrade/ml/feature-builder.ts` (add LOB features), `src/autotrade/ml/types.ts` (extend vector), `python-ml-service/schemas.py` (extend request).
**Latency requirement:** < 200ms for feature snapshot. Can be pre-computed and cached.

### Layer C: Historical LOB Recording (training pipeline)

**What:** Full depth snapshots and trade-by-trade events recorded alongside every trade for offline training.
**Where it enters:** A new JSONL log file (`logs/lob_snapshots.jsonl`) written by the Bookmap bridge during open trades. The dataset builder (`scripts/ml/build_management_dataset.py`) joins LOB snapshots to trade-path rows by timestamp.
**Files affected:** New log file, new recording module, `scripts/ml/build_management_dataset.py` (join LOB data), training scripts (add LOB features).
**Latency requirement:** None (write-only, offline processing).

---

## 3. Bridge Architecture

```
┌─────────────────────────────────────────┐
│          BOOKMAP DESKTOP                │
│  ┌─────────────────────────────────┐    │
│  │  Java Addon (LOB Bridge)        │    │
│  │  ├─ DepthDataListener           │    │
│  │  ├─ MarketByOrderDepthDataListener│   │
│  │  ├─ TradeDataListener           │    │
│  │  └─ BboListener                 │    │
│  └──────────┬──────────────────────┘    │
│             │ WebSocket (localhost)      │
└─────────────┼───────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  LOB Bridge Service (Python or Node.js) │
│  localhost:5010                          │
│                                         │
│  Responsibilities:                      │
│  ├─ WebSocket server for Bookmap addon  │
│  ├─ LOB feature computation             │
│  │   ├─ bid_ask_spread                  │
│  │   ├─ depth_imbalance_ratio           │
│  │   ├─ cumulative_delta_30s            │
│  │   ├─ large_order_near_price          │
│  │   ├─ trade_flow_imbalance_10s        │
│  │   └─ absorption_rate                 │
│  ├─ REST endpoint: GET /lob/snapshot    │
│  ├─ REST endpoint: GET /lob/health      │
│  └─ JSONL recording to disk             │
└──────────┬──────────────────────────────┘
           │ HTTP (localhost)
           ▼
┌─────────────────────────────────────────┐
│  TypeScript Trading Engine              │
│  (runner.ts)                            │
│                                         │
│  ├─ QuoteService (existing)             │
│  ├─ LobClient (new)                    │
│  │   └─ fetch /lob/snapshot             │
│  ├─ ML Feature Builder (extended)       │
│  │   └─ merge LOB features              │
│  └─ ML Service call (existing)          │
│      └─ extended feature vector         │
└─────────────────────────────────────────┘
```

### Why this three-tier design?

**Java addon → Bridge service → TypeScript** is the correct split because:

1. **Java addon must be lightweight.** Bookmap enforces strict threading rules — callbacks must not block. The addon's only job is to forward raw events over a WebSocket with minimal serialization. No feature computation in Java.

2. **Bridge service owns feature computation.** LOB feature extraction (rolling windows, imbalance ratios, delta accumulation) requires stateful computation with time-windowed buffers. Python is the natural choice because the ML training pipeline is already Python, and feature computation code can be shared between live inference and offline training.

3. **TypeScript engine remains a consumer.** The trading engine fetches a pre-computed LOB feature snapshot via HTTP, identical to how it already calls the ML service. No new protocol, no new dependency, no threading changes.

### Alternative considered: Java addon → TypeScript directly via WebSocket

Rejected because: (a) TypeScript would need to implement rolling-window feature computation that must exactly match the Python training pipeline, creating a feature-drift risk; (b) raw MBO events at 10,000+/second would overwhelm the Node.js event loop alongside TradingView CDP traffic.

---

## 4. Data Model

### 4a. Raw Events (Java Addon → Bridge, WebSocket JSON)

```
// BBO update
{ "type": "bbo", "ts": 1712345678123, "bid": 24200.25, "bid_sz": 45, "ask": 24200.50, "ask_sz": 32 }

// Depth update (MBP)
{ "type": "depth", "ts": 1712345678123, "side": "bid", "price": 24200.00, "size": 120 }

// Trade
{ "type": "trade", "ts": 1712345678123, "price": 24200.25, "size": 5, "aggressor": "buy" }

// MBO event
{ "type": "mbo", "ts": 1712345678123, "action": "add", "order_id": "...", "side": "bid", "price": 24200.00, "size": 10 }
```

### 4b. Computed LOB Snapshot (Bridge → TypeScript, REST JSON)

```json
{
  "timestamp_ms": 1712345678123,
  "symbol": "NQ",
  "mid_price": 24200.375,
  "bid": 24200.25,
  "ask": 24200.50,
  "spread_ticks": 1,
  "spread_pts": 0.25,
  "depth_imbalance_5": 0.62,
  "depth_imbalance_10": 0.55,
  "cumulative_delta_10s": 127,
  "cumulative_delta_30s": -45,
  "cumulative_delta_60s": 312,
  "trade_flow_imbalance_10s": 0.58,
  "trade_flow_imbalance_30s": 0.52,
  "large_bid_within_5pts": true,
  "large_ask_within_5pts": false,
  "absorption_buy_rate_10s": 0.73,
  "absorption_sell_rate_10s": 0.41,
  "total_bid_depth_10lvl": 890,
  "total_ask_depth_10lvl": 720,
  "vwap_bid_10lvl": 24199.80,
  "vwap_ask_10lvl": 24201.10,
  "age_ms": 12,
  "data_quality": "full_depth"
}
```

### 4c. Historical LOB Record (Bridge → disk, JSONL)

Same as 4b, plus `trade_id` when a position is open (set by TypeScript via a `/lob/set_trade_id` call). Written every 1-2 seconds during open trades.

---

## 5. Feature Extraction Plan

### Phase 1 Features (BBO-derived, simplest)

| Feature | Computation | Where | Value for Management |
|---------|------------|-------|---------------------|
| `spread_ticks` | ask - bid in ticks | Bridge | Liquidity proxy; wide spread = danger |
| `depth_imbalance_5` | (bid_depth_5lvl - ask_depth_5lvl) / total | Bridge | Directional pressure |
| `trade_flow_imbalance_10s` | buy_volume / total_volume over 10s | Bridge | Who is aggressing |
| `cumulative_delta_30s` | sum(buy_vol - sell_vol) over 30s | Bridge | Net buying/selling pressure |

### Phase 2 Features (full depth)

| Feature | Computation | Where | Value for Management |
|---------|------------|-------|---------------------|
| `large_order_near_price` | Any resting order > 50 lots within 5 pts | Bridge | Support/resistance walls |
| `absorption_rate_10s` | Resting orders consumed / total at level | Bridge | Absorption = level holding |
| `depth_imbalance_10` | 10-level depth imbalance | Bridge | Deeper structural pressure |
| `vwap_bid_10lvl` | Volume-weighted avg bid price, 10 levels | Bridge | Fair value estimate |

### Phase 3 Features (MBO-derived)

| Feature | Computation | Where | Value for Management |
|---------|------------|-------|---------------------|
| `order_cancel_rate_10s` | Cancels / total orders over 10s | Bridge | Spoofing / thinning liquidity |
| `hidden_liquidity_detected` | Executions at prices with zero visible depth | Bridge | Iceberg orders |
| `mean_order_size_bid` | Average order size on bid side | Bridge | Retail vs institutional |

---

## 6. What Can Be Reused

| Existing Component | Reuse for Bookmap |
|---|---|
| `QuoteResult` interface | Already has optional `bid`/`ask` fields — can be populated from Bookmap BBO |
| `MlFeatureVector` type | Extend with LOB fields; existing fields unchanged |
| `MlManagementConfig` | Add `lob_service_url` and `lob_timeout_ms` |
| `python-ml-service/` FastAPI | Host LOB bridge alongside or as a second service |
| `scripts/ml/build_management_dataset.py` | Extend to join LOB snapshots from `logs/lob_snapshots.jsonl` |
| `scripts/ml/label_management_dataset.py` | Labels don't change — LOB features are inputs not targets |
| `logs/trade_path.jsonl` | Already has ML fields; add LOB fields alongside |
| Walk-forward evaluation script | Retrain with LOB features, same walk-forward splits |
| Execution gate (`ml/execution-gate.ts`) | Safety invariants unchanged; LOB data is informational only |
| Log-writer JSONL pattern | Same `appendLine()` pattern for LOB snapshots |

---

## 7. Historical Data Recording Strategy

Bookmap backfill is limited to top-of-book and 24-48 hours. This is insufficient for ML training. The strategy is:

### Primary: Live recording during trading sessions

The LOB bridge service records full-depth snapshots to `logs/lob_snapshots.jsonl` every 1-2 seconds during open trades (correlated by `trade_id`). Over 2-4 weeks of paper trading, this accumulates 100+ trades with LOB context.

### Secondary: Session-wide .bmf recording

Bookmap automatically records `.bmf` feed files during live sessions. These files contain full depth + BBO + trades. A Python converter (`scripts/ml/convert_bmf_to_jsonl.py`) can extract LOB snapshots from `.bmf` files for any time window, not just open-trade periods.

### Tertiary: Rithmic direct recording (future)

For deep historical training (months of data), a separate Rithmic API client records raw MBO events independently of Bookmap. This is a larger project and should be Phase 5+.

### Training pipeline change

```
Before:  trades.jsonl + trade_path.jsonl → dataset → labels → model
After:   trades.jsonl + trade_path.jsonl + lob_snapshots.jsonl → dataset → labels → model
                                           (joined by timestamp + trade_id)
```

The dataset builder adds an optional join step: for each trade-path row, find the nearest LOB snapshot within a configurable time window (default 2 seconds). Missing LOB data results in null features, which CatBoost handles natively.

---

## 8. Risks and Unknowns

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Bookmap WebSocket throughput** — NQ generates 5,000-20,000 depth events/second during RTH. If the Java addon serializes every event as JSON, it may saturate the WebSocket. | High | Aggregate in the addon: send BBO updates at most every 50ms, batch depth into snapshots every 200ms, stream trades individually. Never forward raw MBO tick-by-tick over JSON. |
| **Feature parity between live and training** — If the bridge computes features differently than the offline dataset builder, the model will see different distributions in production vs training. | High | Share the Python feature computation code: the bridge service and the dataset builder both call the same `compute_lob_features()` function. |
| **Bookmap addon stability** — Java addons run inside Bookmap's JVM. A crash or memory leak in the addon takes down Bookmap. | Medium | Keep the addon minimal (forward events, no computation). Add a heartbeat; if the bridge service stops receiving, log a warning but continue trading with null LOB features. |
| **Clock synchronization** — Bookmap timestamps and TypeScript timestamps must align for trade-path joining. | Medium | Use Unix epoch milliseconds everywhere. The bridge service attaches its own receipt timestamp alongside Bookmap's event timestamp. |
| **Rithmic data licensing** — CME MBO data has exchange fees. The addon must not redistribute raw MBO data outside the local machine. | Low | All processing is localhost. No raw data leaves the machine. Derived features (imbalance ratios, deltas) are not subject to redistribution restrictions. |
| **Graceful degradation** — System must work when Bookmap is not running. | Low | LOB features are nullable in the ML vector. The feature builder fills them from the bridge if available, null otherwise. CatBoost handles missing features natively. The execution gate and hard stops are unaffected. |

---

## 9. Phased Implementation Order

### Phase 1: Bridge Skeleton + BBO Enrichment (1-2 days)

**Scope:** Java addon that forwards BBO to a Python bridge service. TypeScript fetches BBO and populates `QuoteResult.bid`/`QuoteResult.ask`.

**Deliverables:**
- `bookmap-addon/` — Minimal Java addon implementing `BboListener`, forwarding over WebSocket
- `python-lob-service/` — Python FastAPI service on port 5010 with `GET /lob/health` and `GET /lob/snapshot` (BBO only)
- `src/autotrade/lob-client.ts` — TypeScript HTTP client for the bridge
- Wire into `runner.ts` onMonitor: fetch LOB snapshot alongside quote, log `bid`/`ask`/`spread` to trade_path

**What it proves:** End-to-end data flow from Bookmap to TypeScript with measurable latency.

### Phase 2: Depth Features + LOB Recording (2-3 days)

**Scope:** Add `DepthDataListener` to the addon. Bridge computes Phase 1 features (spread, imbalance, delta, trade flow). Record to `logs/lob_snapshots.jsonl`.

**Deliverables:**
- Extended Java addon with depth + trade listeners
- Bridge feature computation (rolling windows, imbalance)
- LOB snapshot recording during open trades
- Extended `trade_path.jsonl` with LOB fields

**What it proves:** Feature computation pipeline and historical data recording work.

### Phase 3: ML Training with LOB Features (2-3 days)

**Scope:** Join LOB snapshots into training dataset. Retrain CatBoost with LOB features. Walk-forward evaluation to measure improvement.

**Deliverables:**
- Extended `build_management_dataset.py` with LOB join
- Extended feature vectors (MlFeatureVector + schemas.py)
- Retrained models with LOB features
- Walk-forward comparison report: with-LOB vs without-LOB

**What it proves:** Whether LOB features actually improve management decisions. If they don't, stop here.

### Phase 4: Live ML Inference with LOB (1-2 days)

**Scope:** Wire LOB features into live ML inference. The feature builder fetches the latest LOB snapshot and includes it in the prediction request.

**Deliverables:**
- Extended `ml/feature-builder.ts` to include LOB fields
- Extended `python-ml-service/schemas.py` to accept LOB fields
- Live inference using LOB-enhanced models

**What it proves:** Full production loop from Bookmap → Bridge → Features → ML → Management.

### Phase 5: MBO Features + Historical Depth (future)

**Scope:** Add `MarketByOrderDepthDataListener` for order-level analysis. Build `.bmf` converter for deep historical training.

**Deliverables:**
- MBO event processing in bridge (cancel rate, hidden liquidity, order sizing)
- `scripts/ml/convert_bmf_to_jsonl.py` for historical replay
- Deep historical training (weeks/months of data)

**What it proves:** Whether MBO-level features add value beyond aggregated depth.

---

## 10. Decision Required Before Implementation

**Bridge service language: Python vs Node.js?**

| | Python | Node.js |
|---|---|---|
| Shares code with ML training | Yes (critical for feature parity) | No (duplicate feature computation) |
| Async WebSocket handling | Good (asyncio + websockets) | Excellent (native) |
| Numerical computation | NumPy/Pandas available | Manual or import overhead |
| Already in repo | Yes (python-ml-service/) | Yes (main app) |
| Team familiarity | ML pipeline already Python | Core app already TypeScript |

**Recommendation: Python.** Feature parity between live and training is the highest-risk item. Using the same Python code for both eliminates an entire class of bugs. The bridge service can run alongside or be merged into `python-ml-service/` on a different port.
