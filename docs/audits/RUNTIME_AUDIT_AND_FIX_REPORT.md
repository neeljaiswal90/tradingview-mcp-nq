# Runtime Audit and Fix Report

**Date:** 2026-04-06
**Scope:** Dashboard SSE refresh, confidence score propagation, snapshot consistency

---

## 1. Executive Summary

The dashboard loaded initial data correctly but never refreshed. Two root causes were identified and fixed:

1. **Stale frontend (no live refresh):** Most state-manager setters did not emit the `update` event that triggers SSE broadcasts. The runner called `flush()` at the end of the analysis cycle (added in a prior fix), but `updateMarketSnapshot()` was also emitting independently at the *start* of the cycle, broadcasting a snapshot with stale regime/directional/session data. This was removed in favor of a single coherent `flush()` at end-of-cycle.

2. **Confidence score stuck at 0:** The `DualDirectionResult.confidence` field (computed correctly by the strategy engine, 0-10 scale) was never extracted in `buildDirectional()`. The field was absent from both backend and frontend dashboard types, so it was never sent to the browser. The terminal printed it correctly via `printCycleSummary()`, but the dashboard simply didn't have it.

Both issues are now fixed. The dashboard refreshes every analysis cycle and shows the engine's confidence score.

---

## 2. Root Causes Found

### A. Frontend not refreshing

**Root cause:** Incomplete SSE event emission in the state manager.

The `DashboardStateManager` had 12 setter methods. Only 4 called `this.emitUpdate()`:
- `setEngineRunning()`, `setConnectionStatus()`, `updateMarketSnapshot()`, `updatePosition()`, `recordTrade()`, `updateClaude()`

The following never emitted:
- `updateRegime()`, `updateSessionInfo()`, `updatePerformance()`, `updateRisk()`, `incrementCycle()`, `updateDirectionalSignal()`, `updateCurrentPrice()`

The runner's `onAnalysis` function calls these setters in sequence during each cycle. Without `flush()`, the only SSE broadcast during a typical cycle (no trade open/close) came from `updateMarketSnapshot()` at the START of the cycle -- before regime, directional, session, and performance data was updated. The dashboard received one partial snapshot per cycle with stale data for most fields.

**Fix:** Removed the `emitUpdate()` from `updateMarketSnapshot()`. The runner now calls `dashboardState.flush()` once at the end of each analysis cycle, and once after trade closures in `onMonitor`. This ensures a single coherent broadcast per cycle with all state changes included.

### B. Confidence score not displayed

**Root cause:** Missing field in the dashboard data contract.

The confidence score flows through these steps:
1. `strategy.ts:scoreConfidenceDetailed()` computes a 0-10 score from 13 factors
2. `strategy.ts:generateSignal()` extracts `confidence = chosen?.score ?? 0`
3. `runner.ts` stores it in `DualDirectionResult.confidence`
4. `runner.ts` passes the full `DualDirectionResult` to `dashboardState.updateDirectionalSignal()`
5. `state-manager.ts:buildDirectional()` maps the signal to `DashboardDirectionalAssessment`

At step 5, `sig.confidence` was **never extracted**. The `DashboardDirectionalAssessment` type did not have a `confidence` field. The frontend `DirectionalAssessment` type also lacked it.

**Fix:** Added `confidence: number | null` to both backend and frontend types. `buildDirectional()` now extracts `confidence: sig.confidence ?? null`. The `DirectionalPanel` component displays it next to the engine decision.

### C. Prior `.toFixed()` crash (fixed earlier in session)

Two old trade records in `logs/trades.jsonl` were missing the `exit_price_actual` field. `buildRecentTrades()` mapped `exit: t.exit_price_actual` which became `undefined`, and `RecentTrades.tsx` called `.toFixed(2)` on it, crashing React. This was fixed earlier by:
- Adding `?? null` coalescion in the backend
- Creating shared `fmtPrice`/`fmtUsd`/etc. formatting helpers
- Updating all components to use safe formatters

---

## 3. Hypothesis Comparison

### Hypothesis 1: "The frontend only fetches once or is subscribed incorrectly"

**Partially correct.** The frontend SSE subscription (EventSource) was wired correctly and stayed connected. The issue was on the backend side: most state changes never triggered the `update` event that the SSE server listens to. The subscription was fine; the events were missing.

### Hypothesis 2: "The confidence score is being defaulted/coerced to 0"

**Partially correct.** The confidence WAS correctly computed by the strategy engine and stored in `DualDirectionResult.confidence`. However, it was never extracted into the dashboard snapshot at all -- the field didn't exist in the dashboard type. The terminal correctly showed "Confidence: X/10" because it printed the value directly from the runner's local variable, bypassing the dashboard data path entirely. When the engine produces no candidate (decision = wait), confidence IS legitimately 0 -- that's correct behavior, not a bug.

### Hypothesis 3: "Duplicate or inconsistent snapshot builders"

**Incorrect.** There is only one snapshot builder (`DashboardStateManager.getSnapshot()`) and one state path. No duplicate builders or parallel state paths exist. The issue was simpler: missing fields and missing event emissions.

---

## 4. Files Changed

### Backend
| File | Change |
|------|--------|
| `src/autotrade/dashboard/types.ts` | Added `confidence: number \| null` to `DashboardDirectionalAssessment` |
| `src/autotrade/dashboard/state-manager.ts` | Extracted `sig.confidence` in `buildDirectional()`, removed early `emitUpdate()` from `updateMarketSnapshot()`, added `flush()` method |
| `src/autotrade/dashboard/server.ts` | Added SSE client connect/disconnect logging, broadcast count logging with confidence value |
| `src/autotrade/strategy.ts` | Changed confidence from `chosen?.score ?? 0` to `Math.max(bestLong?.score, bestShort?.score, chosenScore)` for operator visibility; trade gating uses `chosenScore` |
| `src/autotrade/runner.ts` | Added `dashboardState.flush()` at end of `onAnalysis` and after trade close in `onMonitor` |

### Frontend
| File | Change |
|------|--------|
| `dashboard/src/types.ts` | Added `confidence: number \| null` to `DirectionalAssessment`, changed `RecentTrade.exit` to `number \| null` |
| `dashboard/src/format.ts` | **New** -- safe formatting helpers (`fmtPrice`, `fmtUsd`, `fmtPnlUsd`, `fmtPct`, `fmtNum`, `pnlClass`) |
| `dashboard/src/components/DirectionalPanel.tsx` | Displays confidence score next to engine decision |
| `dashboard/src/components/RecentTrades.tsx` | Uses safe formatters |
| `dashboard/src/components/KpiCards.tsx` | Uses safe formatters |
| `dashboard/src/components/ActiveTrade.tsx` | Uses safe formatters |
| `dashboard/src/components/MarketStatePanel.tsx` | Uses safe formatters |
| `dashboard/src/components/PnlChart.tsx` | Filters non-finite values |
| `dashboard/src/styles.css` | Added `.decision-confidence` style |
| `dashboard/src/main.tsx` | Added React ErrorBoundary |

### Tests
| File | Change |
|------|--------|
| `tests/unit/dashboard-state-manager.test.ts` | Added 5 new tests: confidence propagation, null confidence, undefined confidence, flush-only pattern, old trade records |
| `tests/unit/dashboard-format.test.ts` | **New** -- 24 tests for all format helpers |

---

## 5. SSE Refresh Flow (After Fix)

```
Analysis Cycle:
  runner.ts:onAnalysis()
    1. collect market snapshot
    2. dashboardState.updateMarketSnapshot(snap)    -- stores, NO emit
    3. dashboardState.incrementCycle()               -- stores, NO emit
    4. dashboardState.updateRegime(regime)            -- stores, NO emit
    5. dashboardState.updateDirectionalSignal(result) -- stores, NO emit
    6. dashboardState.updateRisk(...)                 -- stores, NO emit
    7. dashboardState.updatePosition(...)             -- stores, emits only on trade change
    8. dashboardState.updatePerformance(...)          -- stores, NO emit
    9. dashboardState.updateSessionInfo(...)          -- stores, NO emit
   10. dashboardState.flush()                         -- EMITS once with all changes
                                |
                                v
   DashboardServer listens to 'update' event
                                |
                                v
   throttledBroadcast() → doBroadcast()
                                |
                                v
   SSE: event: snapshot\ndata: {full JSON}\n\n
                                |
                                v
   Frontend: useDashboard() EventSource → setSnapshot(data)
                                |
                                v
   React re-renders all components with fresh state
```

---

## 6. Confidence Score Display

**Updated 2026-04-06 (post-audit fix):** The original confidence formula `chosen?.score ?? 0` was always 0 when no candidate was chosen (vast majority of cycles). Over 4000+ cycles the dashboard showed 0.0/10 even when candidates existed but failed gates/thresholds.

**Fix in `strategy.ts:generateSignal()`:**
```typescript
// Before (broken):
const confidence = chosen?.score ?? 0;

// After (fixed):
const chosenScore = chosen?.score ?? 0;
const confidence = Math.max(bestLong?.score ?? 0, bestShort?.score ?? 0, chosenScore);
```

`confidence` now reflects the best available candidate score for operator visibility. Trade gating still uses `chosenScore` (the chosen candidate's score) for the `min_confidence` threshold check.

When the engine has a valid candidate:
- Displayed as "7.2/10" next to the engine decision badge
- Source: `DualDirectionResult.confidence` from `generateSignal()`

When no candidate is chosen but candidates were evaluated:
- `confidence` shows the best available score (e.g., 5.8/10)
- This tells the operator how close the market is to generating a trade signal

When no candidates exist at all:
- `confidence` is 0 (legitimate -- no long or short candidates generated)
- Dashboard shows "0.0/10"

---

## 7. Tests Performed

**44 tests total, all passing:**

- `dashboard-state-manager.test.ts` (20 tests):
  - Snapshot version, app meta, active trade open/close
  - Recent trades, PnL history, KPIs from stats
  - Event emission behavior (update, claude-update)
  - Confidence propagation from DualDirectionResult
  - Confidence null when no signal / undefined confidence
  - updateMarketSnapshot flush-only pattern
  - Old trade records with missing exit_price_actual
  - Disk hydration, 50-trade cap, market state

- `dashboard-format.test.ts` (24 tests):
  - fmtPrice: normal, null, undefined, NaN, Infinity, zero, custom decimals
  - fmtUsd: positive, negative, zero, null, undefined
  - fmtPnlUsd: positive, negative, null
  - fmtPct: normal, null
  - fmtNum: normal, undefined
  - pnlClass: positive, negative, zero, null, undefined

---

## 8. Remaining Risks / Follow-ups

1. **~~Confidence is legitimately 0 when no candidate passes hard gates~~ (FIXED).** The original `chosen?.score ?? 0` formula was replaced with `Math.max(bestLong?.score, bestShort?.score, chosenScore)`. Now shows best available candidate score even when no candidate is chosen. Only truly 0 when no candidates are generated at all.

2. **Pre-existing TypeScript errors** in `src/autotrade/historical/runner.ts` (lines 244, 246) produce compiler warnings but do not block emission since `noEmitOnError` is not set. Should be fixed separately.

3. **Opening Range reconstruction in replay** was flagged in prior analysis. Not verified or fixed here -- out of scope for this dashboard audit.

4. **Claude advisory remains advisory-only** -- confirmed. The `ClaudePanel` displays `(advisory only)` label and Claude state never touches execution logic.

---

## 9. Verification Steps

To verify the fixes are working:

1. Launch the app: `powershell -ExecutionPolicy Bypass -File scripts\launch-app.ps1`
2. Open `http://localhost:3900` in browser
3. Watch for:
   - "Updated Xs ago" in the status bar should refresh every analysis cycle
   - Cycle count should increment
   - Confidence score should appear next to "ENGINE DECISION" (0.0/10 when no setup, higher when candidates exist)
   - KPI cards should update with fresh PnL/trade data
   - Market state panel should show current regime, bias, alignment
4. In the terminal, look for:
   - `[DASHBOARD] SSE client connected (total: 1)`
   - `[DASHBOARD] SSE broadcast #1 -> 1 client(s) | cycle=N | conf=X`
5. If Claude is enabled (ANTHROPIC_API_KEY set), the Claude panel should refresh after each advisory
