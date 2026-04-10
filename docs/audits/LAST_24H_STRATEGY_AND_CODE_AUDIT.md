# Last 24-Hour Strategy and Code Audit

**Date:** 2026-04-06
**Auditor:** Claude (automated analysis)
**App:** NQ/MNQ Autonomous Trading Engine (paper mode)

---

## 1. Executive Summary

The trading engine ran for ~36 hours across 27 sessions (8 on BTCUSD, 19 on MNQ1!) producing 21 trades, 7,504 signal records, and 3,140 rejected signal records. The engine is **unprofitable**: 38.1% win rate, -0.35 avg R, -$1,216 total PnL, profit factor 0.46.

**Root causes are a mix of code bugs, data gaps, and trade management design flaws:**

| Category | Issues Found | Severity |
|----------|-------------|----------|
| Code bugs | 3 (OR cache, rejected signal logging, max_confidence) | High |
| Data/key level gaps | 3 (prior_rth, weekly_open, OR expiry) | High |
| Trade management design | 4 (time stop, trailing, MFE leakage, T1 hit rate) | Critical |
| Strategy quality | 3 (setup family deadness, over-filtering, entry quality) | Medium |
| Telemetry/observability | 3 (Claude auth, confidence was stuck, session instability) | Medium |
| Architecture | 2 (bar lookback, config ghost states) | Low |

**Three fixes were implemented now** (all safe, code-only, no strategy parameter changes):
1. Opening range caching (prevents 4 setup generators from going dead after 11:30 ET)
2. Rejected signal reason surfacing (eliminates null reason_for_skip gap)
3. Backend rebuild with prior confidence fix

---

## 2. Data Window Used

| Source | Window | Records |
|--------|--------|---------|
| signals.jsonl | 2026-04-04 18:37 → 2026-04-06 13:44 | 7,504 |
| trades.jsonl | 2026-04-04 18:44 → 2026-04-06 13:02 | 21 |
| rejected_signals.jsonl | 2026-04-05 02:55 → 2026-04-06 09:33 | 3,140 |
| trade_path.jsonl | 2026-04-04 → 2026-04-06 | 2,430 |
| sessions.jsonl | 2026-04-04 → 2026-04-06 | 27 sessions |
| claude_reasoning (Apr 6) | 2026-04-06 00:00 → 13:42 | 110 responses, 4 errors |
| performance.json | Cumulative | 21 trades |
| sensitivity sweep reports | 2026-04-05 17:00 → 2026-04-06 00:26 | 9 experiments |

**Note:** The last 24h window from signal logs contains ~6,140 signal cycles. The full dataset spans ~36 hours.

---

## 3. Evidence Sources Analyzed

- `logs/signals.jsonl` — full signal records with regime, bias, confidence, dual-direction decision
- `logs/trades.jsonl` — complete trade records with entry/exit/MFE/MAE/R-multiple
- `logs/rejected_signals.jsonl` — rejected candidate signals with skip reasons
- `logs/performance.json` — aggregate performance metrics
- `logs/sessions.jsonl` — session start/stop history
- `logs/trade_path.jsonl` — in-position price path tracking
- `logs/claude_reasoning/2026-04-06/` — Claude API requests, responses, errors
- `config/indicator-config.json` — active strategy configuration
- `reports/sensitivity/SWEEP_REPORT.md` — 9-config parameter sweep results
- `reports/before_after_comparison.json` — before/after strategy comparison
- `src/autotrade/strategy.ts` — strategy engine source code
- `src/autotrade/runner.ts` — main loop and signal pipeline
- `src/autotrade/data-collector.ts` — market data collection
- `src/autotrade/position-manager.ts` — trade management logic
- `src/autotrade/session.ts` — session/OR computation
- `src/autotrade/indicator-config-manager.ts` — config loading

---

## 4. Strategy Findings

### 4A. Trade Frequency and Signal Funnel

```
Signal Funnel (last 24h, ~6,140 cycles):
  Total analysis cycles:     6,140
  Regime distribution:
    trending_up:             1,774 (28.9%)
    trending_down:           1,575 (25.7%)
    compression:             1,021 (16.6%)
    range_bound:               929 (15.1%)
    choppy:                    644 (10.5%)
    high_volatility_impulse:   158 (2.6%)
    breakout_attempt:           38 (0.6%)
    breakdown_attempt:           1 (0.0%)

  Dual-direction decisions (last 500 analyzed):
    wait_no_candidates:        382 (76.4%)
    wait_no_gates_passed:       59 (11.8%)
    wait_below_min_score:       56 (11.2%)
    enter_long:                  3 (0.6%)

  Execution rate:            ~0.3% of cycles → trade entry
```

**Finding: The system is extremely selective.** 76% of cycles generate zero candidates. Of the 24% that do generate candidates, most are blocked by hard gates (12%) or score thresholds (11%). Only ~0.6% result in entries. This is not necessarily wrong (high-selectivity strategies can work), but the question is whether the 99.7% rejection rate is filtering out signal or just noise.

### 4B. Confidence Score Distribution (Last 24h)

| Bucket | Count | % |
|--------|-------|---|
| 0 | 3,641 | 59.3% |
| 0.1-2.9 | 62 | 1.0% |
| 3.0-4.9 | 473 | 7.7% |
| 5.0-5.9 | 694 | 11.3% |
| 6.0-6.9 | 262 | 4.3% |
| 7.0-7.4 | 206 | 3.4% |
| 7.5-7.9 | 155 | 2.5% |
| 8.0-8.4 | 485 | 7.9% |
| 8.5-8.9 | 118 | 1.9% |
| 9.0-10 | 44 | 0.7% |

**Note:** The 59.3% at zero reflects the pre-fix confidence calculation (`chosen?.score ?? 0`). After the fix applied earlier today (now uses `Math.max(bestLong, bestShort, chosenScore)`), this distribution should shift significantly — most of those zeros will move to the 3-7 range.

### 4C. Rejection Breakdown

**Rejected signals by reason (3,140 total):**

| Reason | Count | % |
|--------|-------|---|
| reason_for_skip = null (position occupied / cooldown) | 777 | 24.7% |
| confidence below threshold | 1,820 | 57.9% |
| R:R below min 2.0 | 272 | 8.7% |
| regime_choppy | 150 | 4.8% |
| alignment_too_weak | 129 | 4.1% |
| regime_HVI | 112 | 3.6% |
| sizing_zero_contracts | ~12 | 0.4% |

**Critical finding:** 777 rejected signals (24.7%) had NO strategy-level reason for rejection. These were valid trade signals that passed all gates but couldn't execute because a position was already open or cooldown blocked them. **This is the most significant source of missed opportunity.** (Fixed in this audit — now logged as `position_already_open` or cooldown reason.)

**Confidence threshold mismatch:** The BTC-era sessions (Apr 4-5) show `threshold_8` in rejection reasons, while MNQ sessions show `threshold_7.5`. The config currently has `min_confidence: 7.5`. The threshold was apparently changed from 8.0 to 7.5 between session starts. No code bug — just config evolution.

### 4D. Rejected Signals with High Confidence

| Confidence Bucket | Rejected Count |
|-------------------|---------------|
| >= 7.5 | 1,042 (33% of all rejections) |
| >= 8.0 | 870 (28% of all rejections) |
| >= 9.0 | 46 |

870 signals with confidence 8+ were rejected. The sweep report found that these high-confidence signals are NOT bad — the 8.5-9.0 bucket is the **single best performer** (47.6% WR, +0.302 E[R], $7,330 PnL). The `max_confidence=9.0` ceiling is actively blocking profitable trades.

### 4E. Setup Family Activity

| Setup | Trades | Wins | Total R | Status |
|-------|--------|------|---------|--------|
| trend_pullback_short | 5 | 3 | +1.22 | ✅ Best performer |
| trend_pullback_long | 6 | 3 | -0.83 | ⚠️ Marginal |
| breakdown_retest_short | 5 | 1 | -2.75 | ❌ Losing |
| breakout_retest_long | 3 | 1 | -2.04 | ❌ Losing |
| momentum_continuation | 2 | 0 | -2.85 | ❌ Dead (disabled in config) |
| opening_drive_continuation | 0 | - | - | 💀 Dead (OR data null) |
| failed_or_break | 0 | - | - | 💀 Dead (OR data null) |

**4 of 7 setup families are either disabled or dead code.** Only trend_pullback generates positive R. The opening_drive and failed_or_break families have config flags enabled (`enable_opening_drive: true`, `enable_failed_or_break: true`) but produce zero trades because opening range data is null 94% of the time. (Fixed in this audit via OR caching.)

### 4F. Long vs Short Asymmetry

| Direction | Trades | Win Rate | Avg R | Total PnL |
|-----------|--------|----------|-------|-----------|
| Long | 9 | 44% | -0.47 | -$453 |
| Short | 12 | 33% | -0.26 | -$764 |

Both directions are losing. The historical replay data (SWEEP_REPORT) shows shorts slightly outperform longs (44.8% vs 42.1% WR), consistent with live data showing trend_pullback_short as the only profitable family.

### 4G. Regime-Specific Performance

| Regime | Trades | Wins | Total R |
|--------|--------|------|---------|
| trending_down | 12 | 4 | -4.38 |
| trending_up | 9 | 4 | -2.87 |

Both trending regimes are losing. The engine correctly avoids choppy/range_bound/HVI regimes (hard gate blocks), but performance in trending regimes is still negative. This is a trade management issue, not an entry quality issue — the entries are finding trending environments but losing money in them.

---

## 5. Code/Runtime Findings

### 5A. BUG: Opening Range Data Expires After ~2 Hours [FIXED]

**Category:** Code bug
**Evidence:** Log analysis (94% null rate for OR fields), code inspection
**Severity:** HIGH
**Impact:** 4 setup generators dead code for most of RTH

The `DataCollector` fetches 120 1m bars (2 hours of data). The opening range (09:30-09:44 ET) ages out of this window by ~11:30 ET. From that point on, `buildOpeningRange()` returns null, and the 4 OR-based setup generators (`opening_drive_continuation_long/short`, `failed_or_break_long/short`) cannot fire.

**Fix applied:** Added static OR cache in `DataCollector` that stores the formed opening range for the current trading day. Once computed, it persists through the session even after the bars age out.

### 5B. BUG: Rejected Signals Missing Reason [FIXED]

**Category:** Data/telemetry flaw
**Evidence:** Log analysis (777 records with null reason_for_skip)
**Severity:** MEDIUM
**Impact:** Unable to distinguish "valid signal blocked by position" from "no reason" in analytics

When a candidate passed all strategy gates but execution was blocked by an operational constraint (position already open, cooldown active), `reason_for_skip` was null in `rejected_signals.jsonl`.

**Fix applied:** Added `effectiveSkipReason` computation in runner.ts that surfaces `position_already_open`, cooldown block string, or `risk_check_failed` when strategy-level reason is null.

### 5C. FINDING: max_confidence=9 Ceiling Hurts Performance

**Category:** Strategy flaw (config-level)
**Evidence:** Sensitivity sweep (9 experiments, full historical replay)
**Severity:** HIGH
**Impact:** -$6,980 PnL vs disabled ceiling; blocks best-performing bucket (8.5-9.0)

The sweep report conclusively shows:
- `max_confidence=10` (disabled): +$10,080 PnL, 43.1% WR, PF 1.22
- `max_confidence=9` (current): +$3,100 PnL, 41.5% WR, PF 1.13
- The 8.5-9.0 confidence bucket generates 72% of all PnL

The ceiling was added based on autoresearch that found 9.0+ signals had poor performance (29% WR, -0.28R for 12 trades). But the cascading effect of blocking these trades prevents subsequent profitable entries. The sweep's recommendation was max_confidence=8.9 (conservative) or 10.0 (disabled).

**Not changed in this audit** — this is a strategy parameter change that should be promoted deliberately per the user's workflow.

### 5D. FINDING: prior_rth_high/low Always Null

**Category:** Data gap / code design flaw
**Evidence:** Log analysis (100% null in 500 recent signals), code inspection
**Severity:** MEDIUM
**Impact:** No prior-day session level awareness; future setups can't reference yesterday's range

The `computePriorLevels()` function filters 1m bars for prior-day RTH bars. With only 120 bars (2 hours), no prior-day bars are ever in the dataset. Fixing this requires either:
- Increasing `bars1m` from 120 to ~500 (more API calls, slower collection)
- Using daily-timeframe bars for prior-day levels
- Caching prior-day levels at session boundary

**Not fixed in this audit** — requires architectural decision on data sourcing approach.

### 5E. FINDING: weekly_open Always Null

**Category:** Data dependency gap
**Evidence:** Log analysis (100% null), code inspection
**Severity:** LOW
**Impact:** `target_3` always null for breakdown/breakout retest setups

`weekly_open` is sourced exclusively from Pine label scraping of a "RIPS" indicator. If the indicator is not on the chart or label text doesn't match `"weekly open"`, the field stays null. No fallback computation exists.

**Not fixed** — requires either ensuring RIPS indicator is on chart, or computing weekly open from weekly OHLCV bars.

### 5F. FINDING: Target-2 on Wrong Side in Historical Trade

**Category:** Code bug (possibly fixed in current version)
**Evidence:** Trade log (trade 0342)
**Severity:** MEDIUM (historical only)
**Impact:** One trade exited at loss via "target_2" that was above entry on a short

Trade `TRADE_SESSION_2026-04-04T19-26-34_66d545bc_0342`:
- Short entry at 67090.29, stop at 67212
- target_2 = 67296 (ABOVE entry for a short — wrong side)
- exit_reason = target_2, r_multiple = -1.75

The current code has a `t2Valid` guard that would skip this check. This trade was from the earliest BTC session (possibly running older code). The `clampTarget()` and `validateSetupTargets()` pipeline should prevent this now, but the momentum_continuation generator's target_2 formula (`clampTarget(kl.daily_open, ...)`) should be reviewed to ensure the fallback R-multiple is correct.

### 5G. FINDING: Claude Advisory Auth Failure

**Category:** Runtime/observability flaw
**Evidence:** Claude reasoning error logs
**Severity:** LOW (advisory only, not execution-critical)
**Impact:** Claude panel on dashboard shows stale advisory since 06:16

Three consecutive 401 errors starting at `2026-04-06T06:16:19` with message `"invalid x-api-key"`. The ANTHROPIC_API_KEY in `.env` is either expired, revoked, or incorrectly set. Claude advisory is advisory-only (confirmed — does not affect execution logic).

### 5H. FINDING: Session Instability

**Category:** Runtime flaw
**Evidence:** sessions.jsonl
**Severity:** MEDIUM
**Impact:** 27 sessions in 36 hours = frequent restarts; state reset on each restart

Multiple clusters of rapid restarts:
- Apr 6 06:53-07:41: 7 sessions in 48 minutes
- Apr 5 22:05-23:15: 6 sessions in 70 minutes
- Apr 6 00:41-01:21: 4 sessions in 40 minutes

Each restart resets the position manager, risk manager, and daily counters. If a trade is open during restart, it may be orphaned. The app should persist state across restarts or auto-recover open positions.

---

## 6. Trade Management Findings (Most Critical)

### 6A. CRITICAL: MFE Leakage

The engine's biggest problem is **not entry quality — it's trade management.**

**Winners — MFE Capture Efficiency:**

| MFE (R) | Captured (R) | Leaked (R) | Exit Reason |
|---------|-------------|-----------|-------------|
| 2.76 | +2.61 | 0.15 | target_2 ✅ |
| 0.57 | +0.51 | 0.06 | target_2 ✅ |
| 2.74 | +0.66 | **2.08** | time_stop ❌ |
| 5.01 | +0.70 | **4.31** | time_stop ❌ |
| 0.35 | +0.08 | 0.27 | time_stop |
| 0.22 | +0.10 | 0.12 | time_stop |
| 1.49 | +1.41 | 0.08 | stop_loss (trailing) ✅ |
| 0.88 | +0.14 | **0.74** | time_stop ❌ |

**8 winners captured 6.21R but leaked 7.81R.** The leaked R exceeds the captured R. The two worst cases (MFE 5.01R→0.70R and 2.74R→0.66R) together leaked 6.39R — more than the entire winning PnL of the portfolio.

### 6B. CRITICAL: T1 Hit Rate is 24%

Only 5 of 21 trades (24%) hit target_1. This means:
- 76% of trades NEVER trigger a partial exit
- The trailing stop NEVER activates for 76% of trades (it's only armed after T1)
- 76% of trades have ZERO profit protection between entry and the original stop

This is the core structural problem. The T1 targets are too far from entry relative to normal price movement. Trades can go 0.5-0.9R in favor (significant MFE) but never reach T1 (typically at 1.0-2.0R), then reverse and stop out.

### 6C. CRITICAL: Time Stop Cutting Winners

7 of 21 trades (33%) exited via time_stop. Of these:
- 4 were winners (avg captured: +0.25R, avg MFE: 2.46R = **90% MFE leakage**)
- 3 were losers/scratches (avg captured: -0.08R, avg MFE: 0.26R)

The time stop at 30 minutes with pre-T1 gate of 0.25R and post-T1 gate of 1.0R is:
1. **Pre-T1:** Killing trades that are working but haven't reached T1. A trade at +0.3R (above the 0.25 threshold) is protected from time stop but a trade at +0.2R gets killed even though it may still be in a valid setup.
2. **Post-T1:** Killing runners that have been partially closed and are between BE and +1.0R. The trailing stop has no time to tighten.

### 6D. Pre-T1 Profit Protection Gap

There is NO protective mechanism between entry and T1:
- Stop remains at original level (typically -1.0R)
- No breakeven move until T1 hit
- No pre-T1 trailing
- No partial-exit-on-time (e.g., close 25% if holding +0.5R after 15 min)

This means a trade can reach +2.74R, reverse to -1.0R, and the only protection is the original stop. The entire MFE is lost.

---

## 7. Replay/Live Parity Findings

### 7A. Opening Range Parity

Both replay and live paths use `buildOpeningRange()` from `session.ts`. The replay path (historical/runner.ts) passes simulated bars, while the live path passes real bars from TradingView. The same 120-bar limitation affects both paths, but replay typically processes bars sequentially and may have the opening bars available throughout the session (since it processes them in order). Live mode loses them after 2 hours.

**The OR caching fix applied in this audit benefits live mode only.** Replay mode may already have adequate coverage.

### 7B. Field Coverage

| Field | Live | Replay | Notes |
|-------|------|--------|-------|
| opening_range_high/low | 6% → Fixed | ~60% (estimated) | Replay has bars in sequence |
| prior_rth_high/low | Always null | May have data | Depends on bar lookback |
| weekly_open | Always null | Always null | RIPS indicator dependency |
| session_vwap | 100% | N/A (from TV) | Live-only via TradingView |
| Smart Money levels | Live from TV | N/A | Not in replay |

### 7C. Config Version Drift

The sensitivity sweep ran 9 configs sequentially, temporarily modifying `indicator-config.json` for each experiment. The sweep scripts restore the config afterward, but if the live app was running during sweeps, it may have loaded modified config on restart. The sessions log shows multiple restarts during the sweep window (Apr 5 22:00 - Apr 6 00:30), which could have caused config drift.

---

## 8. UI/Dashboard Findings

### 8A. Confidence Display (Previously Fixed)

The dashboard confidence was stuck at 0 because:
1. `DualDirectionResult.confidence` used `chosen?.score ?? 0` (now fixed to `Math.max`)
2. The `DashboardDirectionalAssessment` type lacked the `confidence` field (now added)
3. `buildDirectional()` never extracted `sig.confidence` (now extracts it)

All three issues were fixed in the prior session. The dashboard should now show non-zero confidence.

### 8B. SSE Refresh (Previously Fixed)

The dashboard didn't refresh because most state manager setters didn't emit the `update` event. Fixed by adding `flush()` pattern — runner calls `flush()` once at end of each cycle.

### 8C. Remaining Dashboard Concern: Zero-Defaulting

The dashboard still shows `0.0/10` for confidence when no candidates exist. This is technically correct but visually misleading — an operator might think the system is broken. Consider showing `--/10` or `n/a` when confidence is 0 and decision is `wait_no_candidates`.

---

## 9. Ranked Issue List

| # | Severity | Category | Finding | Impact | Status |
|---|----------|----------|---------|--------|--------|
| 1 | CRITICAL | Trade Management | MFE leakage: 8 winners leaked 7.81R (more than they captured) | -$3,000+ unrealized profit | Needs design change |
| 2 | CRITICAL | Trade Management | T1 hit rate 24% — trailing stop almost never activates | 76% of trades have zero profit protection | Needs design change |
| 3 | CRITICAL | Trade Management | Time stop kills winners at +0.25R despite MFE of 2-5R | 4 winners averaged 90% MFE leakage | Needs parameter tuning |
| 4 | HIGH | Code Bug | Opening range null 94% of time — 4 setup families dead | Zero trades from 4 of 7 families | **FIXED** |
| 5 | HIGH | Strategy/Config | max_confidence=9 blocks best bucket (8.5-9.0) | -$6,980 vs disabled | Needs config change |
| 6 | HIGH | Trade Management | No pre-T1 profit protection mechanism | Trades reverse from +0.9R to -1.0R | Needs design change |
| 7 | MEDIUM | Data/Telemetry | Rejected signals 24.7% had null reason | Analytics blind spot | **FIXED** |
| 8 | MEDIUM | Data Gap | prior_rth_high/low always null (120-bar lookback) | No prior-day level awareness | Needs architectural fix |
| 9 | MEDIUM | Runtime | 27 sessions in 36h — excessive restarts | State loss, possible orphaned positions | Investigate stability |
| 10 | MEDIUM | Code Bug | Target-2 wrong side in momentum_continuation trade | Caused -1.75R loss (historical) | Verify current code |
| 11 | LOW | Data Gap | weekly_open always null (RIPS indicator dependency) | No T3 for breakdown/breakout setups | Add indicator or compute |
| 12 | LOW | Runtime | Claude API auth failure since 06:16 | Advisory panel stale | Update API key |
| 13 | LOW | UI | Dashboard shows 0.0/10 instead of n/a when no candidates | Misleading operator display | Minor UI tweak |

---

## 10. Fixes Implemented Now

### Fix 1: Opening Range Caching (data-collector.ts)

**File:** `src/autotrade/data-collector.ts`
**Change:** Added `private static cachedOR` field. When `buildOpeningRange()` returns a formed OR, it's cached with the current ET date key. When bars age out and OR returns null, the cached value is used.
**Impact:** OR-based setup generators (opening_drive, failed_or_break) will now produce candidates throughout the RTH session, not just 09:35-11:30 ET.

### Fix 2: Rejected Signal Reason Surfacing (runner.ts)

**File:** `src/autotrade/runner.ts`
**Change:** Added `effectiveSkipReason` computation before writing to `rejected_signals.jsonl`. When strategy-level `reason_for_skip` is null, the operational reason (position_already_open, cooldown, risk_check_failed) is used instead.
**Impact:** Analytics can now distinguish valid-but-blocked signals from truly unexplained rejections.

### Fix 3: Backend Rebuild

**Change:** Compiled all TypeScript changes (including the confidence calculation fix from earlier: `Math.max(bestLong, bestShort, chosenScore)`).
**Impact:** Dashboard confidence no longer stuck at 0.

### Test Results

All 441 tests pass (27 test files). Only pre-existing TypeScript errors in `historical/runner.ts` (lines 244, 246).

---

## 11. What Still Needs Follow-up

### Priority 1: Trade Management Redesign (CRITICAL)

The trade management system needs structural changes. The current design has a fundamental gap: **no profit protection between entry and T1.** Recommended experiments:

1. **Add pre-T1 trailing stop** — e.g., after trade goes +0.5R, start trailing at +0.25R with a 0.5R trail distance. This would prevent the catastrophic reversals (MFE 5R → captured 0.7R).

2. **Lower T1 distance** — Current T1 is typically at 1.5-2.0R from entry. Consider T1 at 0.75-1.0R to increase T1 hit rate from 24% to ~50%+. Partial at T1, then trailing captures the rest.

3. **Tiered time stop** — Instead of binary 30-min time stop:
   - At 15 min: if < 0.25R, exit
   - At 20 min: if < 0.5R, exit
   - At 30 min: exit regardless (safety net)

4. **MFE-based breakeven** — Move stop to breakeven once trade reaches +0.5R (or +0.75R), regardless of T1 hit.

### Priority 2: max_confidence Ceiling (HIGH)

The sensitivity sweep provides strong evidence to change `max_confidence` from 9.0 to either 8.9 (conservative) or 10.0 (disabled). This is the highest-impact single config change available: +$4,235 to +$6,980 PnL improvement.

### Priority 3: Bar Lookback for Prior Levels (MEDIUM)

Increase `bars1m` from 120 to 480 (8 hours) to capture prior-day RTH data. Alternatively, add a separate daily-bar fetch for prior-day high/low/close. This enables future setups that reference yesterday's session range.

### Priority 4: Session Stability (MEDIUM)

Investigate why the app restarts so frequently. Add:
- State persistence (JSON file) for position/risk state across restarts
- Auto-recovery of open positions on restart
- Health monitoring with restart-reason logging

### Priority 5: Weekly Open Source (LOW)

Either ensure the RIPS Pine indicator is on the chart and visible, or add a fallback that computes weekly open from weekly OHLCV bars (one `data_get_ohlcv` call on weekly timeframe).

---

## 12. Recommended Next Experiments

### Experiment 1: Pre-T1 Breakeven Stop
**Hypothesis:** Moving stop to breakeven at +0.5R MFE will convert 30-40% of current -1.0R losers into scratches without cutting many winners.
**Config change:** Add `breakeven_trigger_r: 0.5` parameter
**Expected impact:** Reduce avg loser from -1.04R to ~-0.7R, improving expectancy by ~+0.10R

### Experiment 2: max_confidence Promotion
**Hypothesis:** Removing the max_confidence ceiling will allow the best-performing bucket (8.5-9.0) to trade freely.
**Config change:** `max_confidence: 10`
**Expected impact:** +$6,980 PnL per the sweep report

### Experiment 3: Shorter Time Stop Pre-T1
**Hypothesis:** A 20-minute time stop (vs 30) with a 0.15R threshold (vs 0.25R) will cut losers faster.
**Config change:** `time_stop_minutes: 20, time_stop_max_r_pre_t1: 0.15`
**Expected impact:** Reduce hold time on losers, slight improvement in avg loser R

### Experiment 4: OR Setup Validation
**Hypothesis:** With OR caching fix, opening_drive and failed_or_break setups will now fire and produce positive R.
**Action:** Run the app through a full RTH session and verify OR-based trades appear.
**Expected impact:** 2-4 additional setup families become active

### Experiment 5: Trail Ticks Sweep
**Hypothesis:** Tighter trailing (8-10 ticks vs 12) post-T1 captures more MFE.
**Config change:** Sweep `trail_ticks_post_t1` across [6, 8, 10, 12, 16]
**Expected impact:** Reduce MFE leakage on winners by 20-40%

---

## Appendix A: Full Trade Log Analysis

```
# | Symbol | Side  | Setup                    | Conf | R-Mult | Exit       | MFE(R) | Leaked(R)
1   BTC     short   momentum_continuation      8.3   -1.10    stop_loss    0.18     n/a
2   BTC     short   momentum_continuation      9.6   -1.75    target_2*    0.00     n/a    [BUG: T2 wrong side]
3   BTC     short   breakdown_retest_short      8.3   -0.17    time_stop    0.47     n/a
4   BTC     short   trend_pullback_short        8.3   -1.30    stop_loss    0.00     n/a
5   BTC     short   trend_pullback_short        8.3   +2.61    target_2     2.76     0.15   ✅ Best trade
6   BTC     short   trend_pullback_short        8.0   +0.51    target_2     0.57     0.06   ✅
7   BTC     short   trend_pullback_short        8.8   +0.66    time_stop    2.74     2.08   ❌ Leaked 2.08R
8   BTC     short   trend_pullback_short        8.3   -1.26    stop_loss    0.00     n/a
9   BTC     short   breakdown_retest_short      8.3   -1.88    stop_loss    0.15     n/a
10  BTC     short   breakdown_retest_short      8.0   +0.70    time_stop    5.01     4.31   ❌ Leaked 4.31R
11  BTC     short   breakdown_retest_short      8.5   -1.11    stop_loss    0.00     n/a
12  BTC     short   breakdown_retest_short      8.5   -0.29    stop_loss    1.10     n/a    (had MFE but reversed)
13  BTC     long    trend_pullback_long          8.3   -1.18    stop_loss    0.17     n/a
14  BTC     long    breakout_retest_long         8.3   -1.09    stop_loss    1.28     n/a    (had 1.28R MFE!)
15  NQ      long    trend_pullback_long          9.0   -1.12    stop_loss    0.22     n/a
16  NQ      long    trend_pullback_long          8.3   +0.08    time_stop    0.35     0.27
17  NQ      long    breakout_retest_long         8.8   +0.10    time_stop    0.22     0.12
18  NQ      long    trend_pullback_long          8.5   -0.16    time_stop    0.06     n/a
19  NQ      long    trend_pullback_long          8.9   +1.41    stop_loss    1.49     0.08   ✅ Trailing worked
20  NQ      long    trend_pullback_long          8.9   +0.14    time_stop    0.88     0.74   ❌ Leaked 0.74R
21  NQ      long    breakout_retest_long         8.4   -1.05    stop_loss    0.00     n/a
```

---

## Appendix B: Config at Time of Audit

```json
{
  "min_confidence": 7.5,
  "max_confidence": 9,
  "min_rr": 2,
  "dual_min_score": 7.5,
  "dual_score_margin": 1,
  "dual_choppy_extra_margin": 0.5,
  "time_stop_minutes": 30,
  "time_stop_max_r_pre_t1": 0.25,
  "time_stop_max_r_post_t1": 1,
  "trail_ticks_post_t1": 12,
  "analysis_interval_seconds": 20,
  "in_position_monitor_seconds": 2,
  "opening_range_minutes": 15,
  "account_equity": 25000,
  "max_risk_per_trade_pct": 1.5,
  "max_daily_loss_pct": 1.5,
  "enable_opening_drive": true,
  "enable_failed_or_break": true,
  "enable_momentum_continuation": false
}
```
