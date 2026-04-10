# Refresh and Data Gathering Optimization Report

## 1. Executive Summary

Optimized the full runtime pipeline from data gathering through frontend display to achieve a 5-second refresh cadence. Key improvements: 4x faster analysis interval (20s -> 5s), HTF data caching to eliminate redundant TF switches, fixed async tracking bug in Claude trigger scheduler, added freshness metadata throughout the pipeline, and added frontend staleness detection.

## 2. Baseline Timings Found

| Component | Before | After |
|---|---|---|
| Analysis interval (flat) | 20 seconds | **5 seconds** |
| Monitor interval (in-position) | 2 seconds | 2 seconds (unchanged, already fast) |
| Data collection per cycle | ~1.5-2s (4 TF switches x 300ms + reads) | **~300-500ms** (HTF cached, 150ms sleeps) |
| TF switch sleep | 300ms per switch | **150ms** per switch |
| Final restore sleep | 200ms | **100ms** |
| Claude reasoning cadence | 5 minutes | **30 seconds** (configurable via `CLAUDE_REASONING_INTERVAL_SECONDS`) |
| SSE broadcast throttle | 500ms | 500ms (unchanged, appropriate) |
| Frontend reconnect delay | 3 seconds | **2 seconds** |
| Frontend staleness detection | None | **15-second threshold** |
| Scheduler minimum interval | 2000ms | **1000ms** |

## 3. Bottlenecks Identified

### 3.1 Analysis Interval Too Slow (20s)
The `analysis_interval_seconds` in `indicator-config.json` was set to 20 seconds. This meant the dashboard only received fresh data every 20 seconds when flat.

### 3.2 Data Collection: Redundant TF Switches
Every analysis cycle performed 4 timeframe switches (1m -> 5m -> 15m -> 1h -> 1m), each with a 300ms sleep. Higher timeframe data (5m/15m/1h) changes slowly but was re-fetched every cycle.

### 3.3 Claude Trigger Scheduler Async Bug
`fireSafe()` used `queueMicrotask()` to call the async callback, but the `processingTrigger` flag was cleared in a `finally` block that executed synchronously (before the async callback resolved). This meant:
- Coalescing logic never worked (flag cleared instantly)
- Multiple Claude API calls could overlap
- Advisory results could overwrite each other in non-deterministic order

### 3.4 Claude Cadence Too Slow (5 minutes)
The default Claude reasoning interval was 5 minutes, making advisory data feel stale.

### 3.5 No Frontend Staleness Detection
The frontend displayed whatever last snapshot it received indefinitely, with no indication if the backend had stopped sending updates.

### 3.6 No Freshness Metadata
No way to observe whether data was fresh, how long collection took, or whether Claude was currently processing.

## 4. Root Causes of Stale/Slow Updates

1. **Config-driven slowness**: 20s analysis interval was the primary bottleneck
2. **Unnecessary I/O**: HTF data re-fetched every cycle despite changing slowly
3. **Async tracking bug**: Claude scheduler couldn't properly coalesce or prevent overlapping calls
4. **No observability**: No timestamps or version counters to diagnose freshness issues

## 5. Changes Implemented

### 5.1 `config/indicator-config.json`
- Changed `analysis_interval_seconds` from 20 to **5**

### 5.2 `src/autotrade/data-collector.ts` (rewritten)
- **HTF caching**: 5m (30s TTL), 15m (60s TTL), 1h (120s TTL) — only re-fetches when stale
- **Reduced TF switch sleep**: 300ms -> **150ms**
- **Reduced restore sleep**: 200ms -> **100ms**
- **Skip restore if no TF switches**: When all HTFs are cached, stays on 1m
- **Collection timing instrumentation**: `lastTiming` property exposes phase-by-phase timing
- **`invalidateHtfCache()`** method for forced refresh after significant events

### 5.3 `src/autotrade/scheduler.ts` (updated)
- Minimum interval reduced from 2000ms to **1000ms** (supports 5s cadence)
- Added **`SchedulerMetrics`** interface with: cycle_count, last_analysis_at, last_monitor_at, duration measurements, overrun counts, skip counts
- Added **`getMetrics()`** method for observability
- Analysis overrun warning threshold lowered from 15s to **10s** (closer to 5s target)

### 5.4 `src/autotrade/claude-reasoning/trigger-scheduler.ts` (rewritten)
- **Fixed async tracking bug**: `fireSafe()` now properly `await`s the callback Promise before clearing `processingTrigger`
- **Supports `interval_seconds` config**: Preferred over `interval_minutes` when set
- **Default cadence: 30 seconds** (via `CLAUDE_REASONING_INTERVAL_SECONDS` env var)
- Added **diagnostic metrics**: `triggerCount`, `coalescedCount`, `lastCompletedAt`, `processing`
- Added **`isProcessing()`** method for observability

### 5.5 `src/autotrade/claude-reasoning/types.ts`
- Added `interval_seconds?: number` to `ClaudeReasoningConfig`

### 5.6 `src/autotrade/env.ts`
- Added `CLAUDE_REASONING_INTERVAL_SECONDS` env var support (5-300s, default 30s)
- Updated env printout to show seconds-based interval

### 5.7 `src/autotrade/dashboard/types.ts`
- Added **`FreshnessMetadata`** interface with: snapshot_built_at, snapshot_version, data_gathered_at, data_gather_duration_ms, confidence_updated_at, claude_last_completed_at, claude_request_in_flight, analysis_interval_target_ms, last_analysis_duration_ms, htf_cache_hits
- Added `freshness` field to `DashboardSnapshot`
- Version bumped to `dashboard_v1.1`

### 5.8 `src/autotrade/dashboard/state-manager.ts`
- Added freshness tracking fields and setter methods
- `getSnapshot()` now increments `snapshotVersion` and builds freshness metadata
- New methods: `updateCollectionTiming()`, `updateConfidenceTiming()`, `updateAnalysisTiming()`, `setClaudeRequestInFlight()`

### 5.9 `src/autotrade/runner.ts`
- Wires collection timing to dashboard state manager
- Wires confidence timing to dashboard state manager
- Wires analysis duration to dashboard state manager
- Tracks Claude request in-flight status around trigger handler
- Logs collection timing every 10th cycle (HTF cache hits/misses)

### 5.10 `dashboard/src/types.ts` (frontend)
- Added `FreshnessMetadata` type
- Added `freshness?` field to `DashboardSnapshot`
- Added `exchange_state?` and `strategy_bucket?` to `AppMeta`

### 5.11 `dashboard/src/hooks/useDashboard.ts` (rewritten)
- Tracks `lastReceivedAt` timestamp
- Added **staleness detection**: `isStale` flag triggers after 15 seconds with no update
- Staleness check runs every 3 seconds
- Reconnect delay reduced from 3s to 2s
- Returns `lastReceivedAt` and `isStale` in hook result

### 5.12 `dashboard/src/components/StatusBar.tsx` (updated)
- Shows strategy_bucket when available
- Shows exchange_state badge
- Shows data gather duration in ms
- Shows **STALE badge** when no update received in 15+ seconds
- Connection indicator shows "Live" / "Stale" / "Disconnected"
- Freshness tooltip on cycle count shows snapshot version, gather time, analysis time, HTF cache status

### 5.13 `dashboard/src/App.tsx`
- Passes `isStale` and `freshness` props to StatusBar
- Adds `dashboard-stale` CSS class when stale for visual feedback

## 6. New Refresh Cadence

| Path | Cadence | Notes |
|---|---|---|
| Backend data gathering | **5 seconds** (when flat) | HTF cached; only 1m data fetched fresh every cycle |
| Backend data gathering | **2 seconds** (in-position) | Monitor-only: health check + exit evaluation |
| Dashboard snapshot publish | **5 seconds** (event-driven via SSE) | Throttled to max 2/sec |
| Frontend state update | **Instant** (SSE push) | No polling; event-driven |
| Claude reasoning | **30 seconds** (default) | Configurable via `CLAUDE_REASONING_INTERVAL_SECONDS` |
| Claude trade entry trigger | **Immediate** | Fires instantly on position open |

## 7. Claude Scheduling Changes

- Default cadence reduced from 5 minutes to **30 seconds**
- Fixed async bug that prevented proper coalescing of overlapping triggers
- `processingTrigger` flag now correctly tracks async callback completion
- Added `interval_seconds` config option (preferred over `interval_minutes`)
- Added diagnostic metrics for monitoring trigger health
- In-flight status tracked and exposed in dashboard freshness metadata

## 8. Frontend Refresh Changes

- SSE remains the primary transport (event-driven, no polling needed)
- Added **staleness detection** — visual indicator after 15 seconds without update
- Reconnect delay reduced from 3s to 2s
- Freshness metadata visible in StatusBar tooltip
- Data gather duration shown inline

## 9. Confidence Freshness Changes

- Confidence is recomputed every analysis cycle (now every 5 seconds)
- `confidence_updated_at` timestamp tracked in freshness metadata
- Dashboard receives fresh confidence via SSE push on each `flush()`

## 10. Tests/Validation Performed

### New Tests (18 tests in `tests/unit/refresh-cadence.test.ts`)

**Scheduler tests (3):**
- Minimum interval enforcement (1000ms)
- 5000ms interval acceptance
- Metric tracking after ticks

**Claude Trigger Scheduler tests (6):**
- `interval_seconds` support
- Fallback to `interval_minutes`
- Async processing state tracking
- Trigger count across multiple fires
- Disabled state (no-op)
- Diagnostic metrics exposure

**Dashboard Freshness tests (7):**
- Freshness field presence in snapshot
- Snapshot version incrementing
- Data collection timing tracking
- Confidence timing tracking
- Claude in-flight status tracking
- Analysis timing tracking
- Initial null/empty freshness values

**Config tests (2):**
- Indicator config has 5s analysis interval
- 5s interval produces valid scheduler timing

### Existing Tests
All 526 existing tests continue to pass (only the version string check was updated from `dashboard_v1.0` to `dashboard_v1.1`).

**Total: 544 tests passing across 27 test files.**

## 11. Remaining Limitations / Follow-ups

1. **HTF cache is in-memory only** — resets on restart. Could persist to disk for faster cold starts.

2. **Claude 30s cadence may be too frequent** for API rate limits — monitor usage and adjust `CLAUDE_REASONING_INTERVAL_SECONDS` if needed. Can be set to any value 5-300.

3. **TF switch sleep (150ms) is empirical** — on slower machines, the chart may need more settling time. If indicators read null frequently, increase `TF_SWITCH_SLEEP_MS`.

4. **Frontend CSS for stale state** — the `dashboard-stale` and `stale-badge` CSS classes are added but not styled. Add CSS rules to visually dim the dashboard or highlight the badge.

5. **Data collection could be further parallelized** if TradingView supported reading multiple TFs without chart switching (e.g., via REST API). Currently limited by the single-chart-panel architecture.

6. **`recentEventLog` array in runner.ts** grows unbounded — should cap at a reasonable limit (e.g., 100 entries).

7. **Opening range cache** — consider adding a freshness timestamp to detect stale OR values.

8. **Dashboard build** — the frontend `dashboard/dist/` may need rebuilding after the types/components changes. Run `npm run dashboard:build` to update the static assets.
