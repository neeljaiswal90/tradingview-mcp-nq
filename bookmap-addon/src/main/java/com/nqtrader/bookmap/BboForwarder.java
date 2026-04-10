package com.nqtrader.bookmap;

import velox.api.layer1.annotations.Layer1ApiVersion;
import velox.api.layer1.annotations.Layer1ApiVersionValue;
import velox.api.layer1.annotations.Layer1SimpleAttachable;
import velox.api.layer1.annotations.Layer1StrategyName;
import velox.api.layer1.data.InstrumentInfo;
import velox.api.layer1.data.TradeInfo;
import velox.api.layer1.simplified.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * BboForwarder — Bookmap addon that forwards BBO, trade, depth, and MBO
 * events to a local Python sidecar via WebSocket.
 *
 * Keep this lightweight: serialize and forward, no computation.
 * The Python sidecar owns all feature math.
 *
 * Install: Settings > API plugins configuration > Add > select the JAR.
 * The sidecar must be running at ws://127.0.0.1:5010/ws/bookmap first.
 *
 * ── MBO (Market By Order) Support ──────────────────────────────────────
 *
 * Uses Bookmap's MarketByOrderDepthDataListener interface which provides
 * individual order lifecycle events:
 *
 *   send(orderId, isBid, price, size)   → new order placed (action="add")
 *   replace(orderId, price, size)       → order modified  (action="replace")
 *   cancel(orderId)                     → order cancelled (action="cancel")
 *
 * Limitations of the SDK interface:
 *   - replace() does NOT provide the side (bid/ask); we track it from send()
 *   - cancel() does NOT provide side, price, or size; we track from send()
 *   - Execute events come via onTrade() which has aggressorOrderId/passiveOrderId
 *     on TradeInfo; we emit separate MBO execute events from onTrade when available
 *   - is_top_of_book and levels_penetrated are NOT provided by the MBO callbacks;
 *     these fields are omitted (sidecar defaults to false/0)
 *
 * Order state is tracked in a ConcurrentHashMap so that cancel/replace events
 * can be enriched with the side, price, and size from the original send().
 * Stale entries are periodically cleaned by the heartbeat thread.
 */
@Layer1ApiVersion(Layer1ApiVersionValue.VERSION2)
@Layer1SimpleAttachable
@Layer1StrategyName("NQ BBO Forwarder")
public class BboForwarder implements CustomModule,
        BboListener, TradeDataListener, DepthDataListener,
        MarketByOrderDepthDataListener {

    private static final String SIDECAR_URL = "ws://127.0.0.1:5010/ws/bookmap";
    private static final long HEARTBEAT_MS = 5000;
    private static final long RECONNECT_MS = 3000;
    private static final long ORDER_STATE_TTL_MS = 120_000; // 2 min TTL for tracked orders
    private static final int MAX_TRACKED_ORDERS = 50_000;   // cap to prevent unbounded growth
    private static final double EPSILON = 1e-9;

    private String alias = "";
    private double pips = 1.0;  // from InstrumentInfo: converts int ticks to display price
    private volatile double lastBidDisplay = Double.NaN;
    private volatile double lastAskDisplay = Double.NaN;
    private volatile double lastTradeDisplay = Double.NaN;

    private final AtomicReference<WebSocket> wsRef = new AtomicReference<>(null);
    private final AtomicLong lastSendMs = new AtomicLong(0);
    private volatile boolean running = false;
    private Thread heartbeatThread;

    // ── Batch queues for depth/MBO events ────────────────────────────────
    // BBO and trade events stay immediate (latency-sensitive).
    // Depth and MBO events are batched every 50ms to reduce WebSocket overhead.
    private static final long BATCH_FLUSH_MS = 50;
    private static final int BATCH_QUEUE_CAP = 5000;
    private final java.util.concurrent.ConcurrentLinkedQueue<String> depthQueue = new java.util.concurrent.ConcurrentLinkedQueue<>();
    private final java.util.concurrent.ConcurrentLinkedQueue<String> mboQueue = new java.util.concurrent.ConcurrentLinkedQueue<>();
    private final java.util.concurrent.atomic.AtomicInteger depthQueueSize = new java.util.concurrent.atomic.AtomicInteger(0);
    private final java.util.concurrent.atomic.AtomicInteger mboQueueSize = new java.util.concurrent.atomic.AtomicInteger(0);
    private final java.util.concurrent.atomic.AtomicLong depthDroppedCount = new java.util.concurrent.atomic.AtomicLong(0);
    private final java.util.concurrent.atomic.AtomicLong mboDroppedCount = new java.util.concurrent.atomic.AtomicLong(0);
    private Thread batchFlushThread;

    // ── MBO order state tracking ─────────────────────────────────────────
    // Tracks order_id -> {side, price, size, timestamp} so that cancel/replace
    // events (which lack side info) can be enriched.

    private static class OrderInfo {
        final String side;    // "bid" or "ask"
        volatile double price;
        volatile int size;
        volatile long lastUpdateMs;

        OrderInfo(String side, double price, int size) {
            this.side = side;
            this.price = price;
            this.size = size;
            this.lastUpdateMs = System.currentTimeMillis();
        }
    }

    private final ConcurrentHashMap<String, OrderInfo> orderState = new ConcurrentHashMap<>();

    // ── Lifecycle ────────────────────────────────────────────────────────

    @Override
    public void initialize(String alias, InstrumentInfo info, Api api, InitialState initialState) {
        this.alias = alias;
        this.pips = info.pips;
        this.running = true;

        System.out.println("[BBO_FWD] Initializing for " + alias + " (pips=" + pips + ")");
        connectWebSocket();
        startHeartbeat();
        startBatchFlusher();
    }

    @Override
    public void stop() {
        running = false;
        WebSocket ws = wsRef.getAndSet(null);
        if (ws != null) {
            ws.sendClose(1000, "addon_stop");
        }
        if (heartbeatThread != null) {
            heartbeatThread.interrupt();
        }
        if (batchFlushThread != null) {
            batchFlushThread.interrupt();
        }
        orderState.clear();
        System.out.println("[BBO_FWD] Stopped (depth_dropped=" + depthDroppedCount.get() + " mbo_dropped=" + mboDroppedCount.get() + ")");
    }

    // ── BBO Events ───────────────────────────────────────────────────────
    // bidPrice/askPrice are integer TICK values. Multiply by pips for display price.

    @Override
    public void onBbo(int bidPrice, int bidSize, int askPrice, int askSize) {
        double bid = normalizeLevelPrice(bidPrice);
        double ask = normalizeLevelPrice(askPrice);
        lastBidDisplay = bid;
        lastAskDisplay = ask;

        String json = "{\"type\":\"bbo\",\"ts\":" + System.currentTimeMillis()
            + ",\"bid\":" + bid
            + ",\"bid_sz\":" + bidSize
            + ",\"ask\":" + ask
            + ",\"ask_sz\":" + askSize
            + ",\"alias\":\"" + alias + "\"}";
        send(json);
    }

    // ── Trade Events ─────────────────────────────────────────────────────
    // The simplified API exposes trade price as a double, but the local SDK
    // wrapper passes it through without any visible pips conversion. Recent NQ
    // runtime traces show the raw callback value is still in the same level-
    // number domain as BBO/depth (about 100780 while mid is about 25195).
    //
    // To keep the websocket payload in the same display-price domain as BBO,
    // depth, and the sidecar's volume profile, normalize the trade price by
    // comparing raw vs raw*pips against the best display-price reference we
    // have (tracked MBO order price, current BBO mid, or last normalized
    // trade). MBO execute events reuse the same normalized display price.

    @Override
    public void onTrade(double price, int size, TradeInfo tradeInfo) {
        double normalizedPrice = normalizeTradePrice(price, tradeInfo);
        lastTradeDisplay = normalizedPrice;
        String side = tradeInfo.isBidAggressor ? "buy" : "sell";
        String json = "{\"type\":\"trade\",\"ts\":" + System.currentTimeMillis()
            + ",\"price\":" + normalizedPrice
            + ",\"raw_price\":" + price
            + ",\"price_scale_source\":\"" + tradePriceScaleSource(price, normalizedPrice) + "\""
            + ",\"size\":" + size
            + ",\"aggressor\":\"" + side + "\""
            + ",\"alias\":\"" + alias + "\"}";
        send(json);

        // Emit MBO execute events for both aggressor and passive sides if order IDs available
        try {
            if (tradeInfo.aggressorOrderId != null && !tradeInfo.aggressorOrderId.isEmpty()) {
                String mboSide = tradeInfo.isBidAggressor ? "bid" : "ask";
                emitMboExecute(tradeInfo.aggressorOrderId, mboSide, normalizedPrice, price, size);
            }
            if (tradeInfo.passiveOrderId != null && !tradeInfo.passiveOrderId.isEmpty()) {
                String mboSide = tradeInfo.isBidAggressor ? "ask" : "bid";
                emitMboExecute(tradeInfo.passiveOrderId, mboSide, normalizedPrice, price, size);
            }
        } catch (Exception e) {
            // Never let MBO enrichment break trade forwarding
            System.err.println("[BBO_FWD] MBO execute enrichment error: " + e.getMessage());
        }
    }

    // ── Depth Events ─────────────────────────────────────────────────────
    // price is integer TICK value; size=0 means level removed.

    @Override
    public void onDepth(boolean isBid, int price, int size) {
        double displayPrice = normalizeLevelPrice(price);
        String side = isBid ? "bid" : "ask";
        String json = "{\"type\":\"depth\",\"ts\":" + System.currentTimeMillis()
            + ",\"side\":\"" + side + "\""
            + ",\"price\":" + displayPrice
            + ",\"size\":" + size
            + ",\"alias\":\"" + alias + "\"}";
        enqueueDepth(json);
    }

    // ── MBO Events (MarketByOrderDepthDataListener) ─────────────────────
    //
    // send()    → new order placed: has orderId, isBid, price (ticks), size
    // replace() → order modified:   has orderId, price (ticks), size — NO side
    // cancel()  → order cancelled:  has orderId only — NO side/price/size
    //
    // We track order state from send() to enrich replace/cancel with side info.

    @Override
    public void send(String orderId, boolean isBid, int price, int size) {
        try {
            double displayPrice = normalizeLevelPrice(price);
            String side = isBid ? "bid" : "ask";
            long ts = System.currentTimeMillis();

            // Track this order for future cancel/replace enrichment
            if (orderState.size() < MAX_TRACKED_ORDERS) {
                orderState.put(orderId, new OrderInfo(side, displayPrice, size));
            }

            String json = "{\"type\":\"mbo\",\"ts\":" + ts
                + ",\"action\":\"add\""
                + ",\"side\":\"" + side + "\""
                + ",\"price\":" + displayPrice
                + ",\"size\":" + size
                + ",\"order_id\":\"" + escapeJson(orderId) + "\""
                + ",\"alias\":\"" + alias + "\"}";
            enqueueMbo(json);
        } catch (Exception e) {
            System.err.println("[BBO_FWD] MBO send error: " + e.getMessage());
        }
    }

    @Override
    public void replace(String orderId, int price, int size) {
        try {
            double displayPrice = normalizeLevelPrice(price);
            long ts = System.currentTimeMillis();

            // Look up tracked state for side info
            OrderInfo info = orderState.get(orderId);
            String side = (info != null) ? info.side : "unknown";

            // Update tracked state
            if (info != null) {
                info.price = displayPrice;
                info.size = size;
                info.lastUpdateMs = ts;
            }

            String json = "{\"type\":\"mbo\",\"ts\":" + ts
                + ",\"action\":\"replace\""
                + ",\"side\":\"" + side + "\""
                + ",\"price\":" + displayPrice
                + ",\"size\":" + size
                + ",\"order_id\":\"" + escapeJson(orderId) + "\""
                + ",\"alias\":\"" + alias + "\"}";
            enqueueMbo(json);
        } catch (Exception e) {
            System.err.println("[BBO_FWD] MBO replace error: " + e.getMessage());
        }
    }

    @Override
    public void cancel(String orderId) {
        try {
            long ts = System.currentTimeMillis();

            // Look up tracked state for side/price/size
            OrderInfo info = orderState.remove(orderId);
            String side = (info != null) ? info.side : "unknown";
            String priceField = (info != null) ? ",\"price\":" + info.price : "";
            String sizeField = (info != null) ? ",\"size\":" + info.size : ",\"size\":0";

            String json = "{\"type\":\"mbo\",\"ts\":" + ts
                + ",\"action\":\"cancel\""
                + ",\"side\":\"" + side + "\""
                + priceField
                + sizeField
                + ",\"order_id\":\"" + escapeJson(orderId) + "\""
                + ",\"alias\":\"" + alias + "\"}";
            enqueueMbo(json);
        } catch (Exception e) {
            System.err.println("[BBO_FWD] MBO cancel error: " + e.getMessage());
        }
    }

    /** Emit an MBO execute event derived from onTrade's order ID fields. */
    private void emitMboExecute(String orderId, String side, double normalizedPrice, double rawPrice, int size) {
        long ts = System.currentTimeMillis();
        // Remove from tracked orders (order is filled)
        orderState.remove(orderId);

        String json = "{\"type\":\"mbo\",\"ts\":" + ts
            + ",\"action\":\"execute\""
            + ",\"side\":\"" + side + "\""
            + ",\"price\":" + normalizedPrice
            + ",\"raw_price\":" + rawPrice
            + ",\"price_scale_source\":\"" + tradePriceScaleSource(rawPrice, normalizedPrice) + "\""
            + ",\"size\":" + size
            + ",\"order_id\":\"" + escapeJson(orderId) + "\""
            + ",\"alias\":\"" + alias + "\"}";
        enqueueMbo(json);
    }

    // ── WebSocket Client ─────────────────────────────────────────────────

    /** Convert Bookmap level numbers into display prices using InstrumentInfo.pips. */
    static double normalizeLevelPrice(int levelPrice, double pips) {
        return levelPrice * pips;
    }

    private double normalizeLevelPrice(int levelPrice) {
        return normalizeLevelPrice(levelPrice, pips);
    }

    /**
     * Normalize trade-like prices into the same display-price domain as BBO/depth.
     *
     * The best available display-price reference wins:
     *   1. tracked MBO order price for passive/aggressor order IDs
     *   2. current BBO mid
     *   3. last normalized trade price
     *
     * When no reference exists yet, fall back to raw*pips because InstrumentInfo.pips
     * is Bookmap's documented level-number -> display-price conversion and recent NQ
     * traces show this trade callback still arrives in that level-number domain.
     */
    static double normalizeTradePriceForWire(double rawPrice, double pips, Double displayReference) {
        if (!Double.isFinite(rawPrice) || !Double.isFinite(pips) || pips <= 0.0) {
            return rawPrice;
        }
        if (Math.abs(pips - 1.0) < EPSILON) {
            return rawPrice;
        }

        double scaledPrice = rawPrice * pips;
        if (displayReference != null && Double.isFinite(displayReference)) {
            double rawErr = Math.abs(rawPrice - displayReference);
            double scaledErr = Math.abs(scaledPrice - displayReference);
            double oneTick = Math.abs(pips);
            if (scaledErr + oneTick < rawErr) {
                return scaledPrice;
            }
            if (rawErr + oneTick < scaledErr) {
                return rawPrice;
            }
        }

        return scaledPrice;
    }

    private double normalizeTradePrice(double rawPrice, TradeInfo tradeInfo) {
        Double displayReference = pickTradeDisplayReference(tradeInfo);
        return normalizeTradePriceForWire(rawPrice, pips, displayReference);
    }

    private Double pickTradeDisplayReference(TradeInfo tradeInfo) {
        if (tradeInfo != null) {
            OrderInfo passive = getTrackedOrder(tradeInfo.passiveOrderId);
            if (passive != null) {
                return passive.price;
            }
            OrderInfo aggressor = getTrackedOrder(tradeInfo.aggressorOrderId);
            if (aggressor != null) {
                return aggressor.price;
            }
        }

        double mid = currentMidDisplay();
        if (Double.isFinite(mid)) {
            return mid;
        }
        return Double.isFinite(lastTradeDisplay) ? lastTradeDisplay : null;
    }

    private double currentMidDisplay() {
        if (!Double.isFinite(lastBidDisplay) || !Double.isFinite(lastAskDisplay)) {
            return Double.NaN;
        }
        return (lastBidDisplay + lastAskDisplay) / 2.0;
    }

    private OrderInfo getTrackedOrder(String orderId) {
        if (orderId == null || orderId.isEmpty()) {
            return null;
        }
        return orderState.get(orderId);
    }

    static String tradePriceScaleSource(double rawPrice, double normalizedPrice) {
        return Math.abs(rawPrice - normalizedPrice) < EPSILON ? "raw" : "raw_times_pips";
    }

    private void connectWebSocket() {
        try {
            HttpClient client = HttpClient.newHttpClient();
            WebSocket ws = client.newWebSocketBuilder()
                .buildAsync(URI.create(SIDECAR_URL), new WebSocket.Listener() {
                    @Override
                    public void onOpen(WebSocket webSocket) {
                        System.out.println("[BBO_FWD] Connected to " + SIDECAR_URL);
                        webSocket.request(Long.MAX_VALUE);
                    }

                    @Override
                    public CompletionStage<?> onClose(WebSocket webSocket, int code, String reason) {
                        System.out.println("[BBO_FWD] Disconnected: " + code + " " + reason);
                        wsRef.set(null);
                        scheduleReconnect();
                        return null;
                    }

                    @Override
                    public void onError(WebSocket webSocket, Throwable error) {
                        System.err.println("[BBO_FWD] Error: " + error.getMessage());
                        wsRef.set(null);
                        scheduleReconnect();
                    }
                })
                .join();
            wsRef.set(ws);
        } catch (Exception e) {
            System.err.println("[BBO_FWD] Connect failed: " + e.getMessage());
            scheduleReconnect();
        }
    }

    private void scheduleReconnect() {
        if (!running) return;
        new Thread(() -> {
            try {
                Thread.sleep(RECONNECT_MS);
                if (running && wsRef.get() == null) {
                    System.out.println("[BBO_FWD] Reconnecting...");
                    connectWebSocket();
                }
            } catch (InterruptedException ignored) {}
        }, "bbo-reconnect").start();
    }

    /**
     * Send a JSON string over the WebSocket. Used by BBO/trade/depth handlers.
     * Named "send" in original code, but conflicts with MBO's send(orderId,...)
     * so internal callers now use sendWs() for WebSocket dispatch.
     */
    private void send(String json) {
        sendWs(json);
    }

    /** Actually dispatch a string to the WebSocket. */
    private void sendWs(String json) {
        WebSocket ws = wsRef.get();
        if (ws != null) {
            try {
                ws.sendText(json, true);
                lastSendMs.set(System.currentTimeMillis());
            } catch (Exception e) {
                // Drop on failure, don't block Bookmap
            }
        }
    }

    // ── Batch Enqueue + Flusher ────────────────────────────────────────────

    private void enqueueDepth(String json) {
        if (depthQueueSize.get() >= BATCH_QUEUE_CAP) {
            depthDroppedCount.incrementAndGet();
            depthQueue.poll(); // drop oldest
            depthQueueSize.decrementAndGet();
        }
        depthQueue.add(json);
        depthQueueSize.incrementAndGet();
    }

    private void enqueueMbo(String json) {
        if (mboQueueSize.get() >= BATCH_QUEUE_CAP) {
            // MBO queue full — drop oldest MBO to make room
            mboQueue.poll();
            mboQueueSize.decrementAndGet();
            mboDroppedCount.incrementAndGet();
            // Also shed depth if backlogged (secondary pressure relief)
            if (depthQueueSize.get() > BATCH_QUEUE_CAP / 2) {
                depthQueue.poll();
                depthQueueSize.decrementAndGet();
                depthDroppedCount.incrementAndGet();
            }
        }
        mboQueue.add(json);
        mboQueueSize.incrementAndGet();
    }

    private void startBatchFlusher() {
        batchFlushThread = new Thread(() -> {
            StringBuilder sb = new StringBuilder(8192);
            while (running) {
                try {
                    Thread.sleep(BATCH_FLUSH_MS);
                    long flushStart = System.currentTimeMillis();

                    // Drain both queues into a single batch envelope
                    java.util.List<String> events = new java.util.ArrayList<>();
                    String msg;
                    while ((msg = depthQueue.poll()) != null) {
                        events.add(msg);
                        depthQueueSize.decrementAndGet();
                    }
                    while ((msg = mboQueue.poll()) != null) {
                        events.add(msg);
                        mboQueueSize.decrementAndGet();
                    }

                    if (events.isEmpty()) continue;

                    // Build JSON batch envelope: {"type":"batch","events":[...]}
                    sb.setLength(0);
                    sb.append("{\"type\":\"batch\",\"events\":[");
                    for (int i = 0; i < events.size(); i++) {
                        if (i > 0) sb.append(',');
                        sb.append(events.get(i));
                    }
                    sb.append("]}");
                    sendWs(sb.toString());

                    long flushMs = System.currentTimeMillis() - flushStart;
                    if (flushMs > 100) {
                        System.err.println("[BBO_FWD] Batch flush slow: " + flushMs + "ms (" + events.size() + " events)");
                    }

                    // Backpressure warning
                    int totalQueued = depthQueueSize.get() + mboQueueSize.get();
                    if (totalQueued > (int)(BATCH_QUEUE_CAP * 0.8)) {
                        System.err.println("[BBO_FWD] BACKPRESSURE: queue at " + totalQueued + "/" + BATCH_QUEUE_CAP
                            + " depth_dropped=" + depthDroppedCount.get() + " mbo_dropped=" + mboDroppedCount.get());
                    }
                } catch (InterruptedException ignored) { break; }
            }
        }, "bbo-batch-flush");
        batchFlushThread.setDaemon(true);
        batchFlushThread.start();
    }

    // ── Heartbeat + Order State Cleanup ──────────────────────────────────

    private void startHeartbeat() {
        heartbeatThread = new Thread(() -> {
            while (running) {
                try {
                    Thread.sleep(HEARTBEAT_MS);
                    long now = System.currentTimeMillis();
                    sendWs("{\"type\":\"heartbeat\",\"ts\":" + now
                        + ",\"alias\":\"" + alias
                        + "\",\"mbo_tracked_orders\":" + orderState.size() + "}");

                    // Purge stale order entries to prevent unbounded memory growth
                    long cutoff = now - ORDER_STATE_TTL_MS;
                    orderState.entrySet().removeIf(e -> e.getValue().lastUpdateMs < cutoff);
                } catch (InterruptedException ignored) { break; }
            }
        }, "bbo-heartbeat");
        heartbeatThread.setDaemon(true);
        heartbeatThread.start();
    }

    // ── Utility ──────────────────────────────────────────────────────────

    /** Minimal JSON string escaping for orderId values that may contain special chars. */
    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
