# TradingView Indicator Deep Dive Report

**Date:** 2026-04-06
**Instrument:** CME_MINI:MNQ1! (Micro E-Mini Nasdaq 100 Futures)
**Chart Timeframe:** 1-minute
**Strategy:** Multi-TF confluence, dual-direction scoring, NQ intraday

---

## 1. Executive Summary

This report is a comprehensive audit of all 12 active TradingView indicators on the NQ trading chart, cross-referenced against actual strategy code consumption. The audit was performed with **direct live access** to TradingView via CDP/MCP tooling.

**Key Findings:**
- **12 indicators** active on chart; only **8 are consumed** by the autotrade strategy
- **3 indicators are completely unused** by any strategy logic (Reversal Detection v3.0, Predicta Futures, Orderblock Footprints)
- **2 are hidden** but still loaded (Predicta Futures, Orderblock Footprints) -- consuming chart resources for nothing
- **RSI 14** is read into the snapshot but **never used** in any scoring, setup generation, or regime detection
- **EMA 100** and **DMA 20/50/200** are computed and stored but **never referenced** in any decision logic
- The custom "Improved EMA+Super Strategy" indicator has **duplicate plot lines** (NovaWave Fast = EMA 9, NovaWave Slow = EMA 21) and **non-functional DMAs** (displacement = 0 = just SMAs)
- **3 new custom indicators** were designed and implemented to fill identified gaps: regime dashboard, entry lateness filter, and chop/trend quality meter

**Action Summary:**
| Action | Count |
|--------|-------|
| Keep as-is | 5 |
| Remove | 3 |
| Retune | 2 |
| Refactor | 1 |
| New custom indicators | 3 |

---

## 2. How Active Indicators Were Discovered

**Method: Direct TradingView access via CDP/MCP**

1. Connected to TradingView Desktop via Chrome DevTools Protocol (CDP)
2. Confirmed chart: `CME_MINI:MNQ1!` on 1-minute timeframe
3. Called `chart_get_state()` to enumerate all 12 active studies with entity IDs
4. Called `data_get_indicator()` on each study to extract settings and visibility
5. Called `data_get_study_values()` to get current numeric outputs
6. Called `data_get_pine_labels()`, `data_get_pine_lines()`, `data_get_pine_boxes()` to extract Pine graphics from key level indicators
7. Cross-referenced with `src/autotrade/data-collector.ts`, `strategy.ts`, `snapshot-builder.ts` to map every indicator field to its actual usage in scoring, regime detection, setup generation, and trade management

**All findings are based on live chart state + verified code consumption. No guessing.**

---

## 3. Inventory of Currently Active Indicators

| # | Indicator | Entity ID | Source Type | Visible | Consumed by Strategy |
|---|-----------|-----------|-------------|---------|---------------------|
| 1 | Volume Weighted Average Price | vnII84 | Built-in (STD;VWAP) | Yes | YES - scoring, Claude context |
| 2 | Opening Range with Breakouts & Targets [LuxAlgo] | T94vVj | Public | Yes | YES - OR data for 4 setup generators |
| 3 | Volume | 37yqdO | Built-in | Yes | YES - regime detection, scoring |
| 4 | RIPS Key Levels 2.2 | Gjxkme | Public | Yes | YES - key levels (Daily/Weekly Open, Monday H/L/M) |
| 5 | Smart Money Structure \| GainzAlgo | 1WeuEa | Public | Yes | YES - CHoCH/BOS for structure + targets |
| 6 | Reversal Detection v3.0 | o3uXvZ | Public | Yes | **NO** - not referenced anywhere |
| 7 | Pivot Levels [BigBeluga] | JpmBdM | Public | Yes | YES - primary target level source |
| 8 | Predicta Futures - Next Candle Predictor V4 | 3srgIG | Public | **Hidden** | **NO** - not referenced anywhere |
| 9 | Improved EMA+Super Strategy | uWeK2P | Custom (USER) | Yes | YES - EMAs, SuperTrend, NovaWave |
| 10 | Orderblock Footprints [AlgoAlpha] | p84iFp | Public | **Hidden** | **NO** - not referenced anywhere |
| 11 | Relative Strength Index | GggNPN | Built-in (STD;RSI) | Yes | **READ but UNUSED** in decisions |
| 12 | Average True Range | ADKJhx | Built-in (STD;ATR) | Yes | YES - regime, volatility, stops |

---

## 4. Ranked Review of Current Indicators

### Tier 1: CRITICAL (Score 9-10/10) -- Keep

#### 4.1 Improved EMA+Super Strategy (Custom)
- **Score: 9/10**
- **Category:** Trend, momentum, multi-indicator overlay
- **What it does:** Plots EMA 9/21/50/100/200, SuperTrend (factor 4, ATR 10), NovaWave cloud, DMAs, buy/sell signals
- **Strategy usage:** EMA stack alignment for regime detection, SuperTrend direction gates all trend setups, NovaWave for 1m momentum
- **Edge:** Core trend identification backbone -- without it, no trend pullback or breakout retest setups can fire
- **Issues found:**
  - NovaWave Fast EMA **IS** EMA 9 (same calculation: `ta.ema(close, 9)`) -- duplicate plot
  - NovaWave Slow EMA **IS** EMA 21 (same calculation: `ta.ema(close, 21)`) -- duplicate plot
  - DMA displacements are all 0, making them regular SMAs, not displaced MAs
  - Buy/Sell signal labels are visual noise (autotrade ignores them)
  - `request.security` to 15m for "Ideal Entry" is unused by autotrade and may cause subtle repaint
- **Action:** REFACTOR -- remove duplicate NovaWave plots, remove DMAs (unused), remove signal labels, remove request.security call
- **Repaint risk:** The `request.security("15")` call uses default barmerge which can repaint on real-time bars

#### 4.2 Smart Money Structure | GainzAlgo
- **Score: 9/10**
- **Category:** Market structure
- **Settings:** Swing length 5, BOS/CHoCH detection on 5M MTF
- **Strategy usage:** CHoCH Sell/Buy levels used as stop and target zones in breakdown retest and trend pullback setups; structural level bonus in scoring (+0.5 confidence)
- **Edge:** Provides actionable structural levels that define where trend breaks/continuations occur
- **Issues:** None significant. Labels can be noisy on 1m but the data window values are clean
- **Action:** KEEP
- **Repaint risk:** CHoCH/BOS levels are retroactively drawn when structure breaks -- this is inherent to structure detection and acceptable

#### 4.3 VWAP (Built-in)
- **Score: 9/10**
- **Category:** Orderflow proxy, value area
- **Settings:** Session VWAP, hlc3 source, 3 standard deviation bands
- **Strategy usage:** VWAP support/opposition scoring (+/-0.3 confidence), Claude advisory context, data quality gate
- **Edge:** Institutional reference level; price position relative to VWAP reveals directional bias quality
- **Action:** KEEP
- **Repaint risk:** None (anchored to session start)

#### 4.4 Pivot Levels [BigBeluga]
- **Score: 9/10**
- **Category:** Market structure, targets
- **Settings:** Multi-resolution pivots (5/25/50/100 bar lookbacks)
- **Strategy usage:** Primary target source for ALL setup types (T1, T2, T3 targets)
- **Edge:** Defines concrete price targets for trade management -- without this, target generation has no anchor
- **Action:** KEEP
- **Repaint risk:** Pivots are computed from confirmed bars -- minimal repaint risk

### Tier 2: IMPORTANT (Score 7-8/10) -- Keep with notes

#### 4.5 RIPS Key Levels 2.2
- **Score: 8/10**
- **Category:** Session/key levels
- **Settings:** Standard pivots, timezone UTC-6, sessions configured
- **Currently providing:** Daily Open (24093.25), Weekly Open (24093.25), Monday High/Low/Mid, Monthly Open, Quarterly Open, Prev Week/Month levels, Yearly Open
- **Strategy usage:** Daily Open and Weekly Open used as fallback targets; Monday H/L/M and Monthly Open stored but **currently unused**
- **Edge:** Rich set of institutional reference levels
- **Issues:** Many levels are stored but never consumed (Monday H/L/M, Monthly Open, Prev Month levels)
- **Action:** KEEP but RETUNE -- consider using Monday Mid and Monthly Open in scoring
- **Repaint risk:** None (derived from higher-timeframe closes)

#### 4.6 Opening Range with Breakouts & Targets [LuxAlgo]
- **Score: 8/10**
- **Category:** Session, opening range
- **Settings:** 30-min OR window (but strategy uses 15-min internally), 0930-0945 custom time
- **Strategy usage:** OR High/Low data feeds 4 setup generators (opening drive long/short, failed OR break long/short)
- **Edge:** Critical for NQ-specific session setups -- opening range defines the trade playbook for the first 2+ hours
- **Issues:** The LuxAlgo indicator is configured for 30-minute OR but the strategy internally computes a 15-minute OR -- potential data mismatch. The strategy also has its own OR cache, so this indicator may be redundant for data purposes (visual reference only)
- **Action:** RETUNE -- align OR window setting with strategy's 15-minute config, or remove if strategy's internal OR cache is sufficient

#### 4.7 Volume (Built-in)
- **Score: 7/10**
- **Category:** Volume/participation
- **Strategy usage:** Volume spike detection for HV Impulse regime (3x avg), volume quality scoring (strong/thin: +/-0.5 confidence), 5m volume-weighted direction
- **Edge:** Differentiates real moves from low-participation fakeouts
- **Action:** KEEP
- **Repaint risk:** None

#### 4.8 Average True Range (Built-in)
- **Score: 7/10**
- **Category:** Volatility
- **Settings:** Period 14, RMA smoothing
- **Strategy usage:** Compression regime detection (adaptive threshold), momentum continuation stop sizing (ATR * 0.75), data quality critical gate
- **Edge:** Volatility context for adaptive stop sizing and regime detection
- **Action:** KEEP
- **Repaint risk:** None

### Tier 3: LOW VALUE (Score 2-4/10) -- Remove or Replace

#### 4.9 Relative Strength Index (Built-in)
- **Score: 3/10**
- **Category:** Momentum oscillator
- **Settings:** Period 14, close source
- **Strategy usage:** **READ into snapshot but NEVER used in any scoring, setup generation, or regime detection**
- **Edge:** Zero. The data is collected every cycle but discarded.
- **Why it's there:** The custom "Improved EMA+Super Strategy" computes RSI internally for its buy/sell signals, but those signals aren't consumed either.
- **Action:** REMOVE from chart (or integrate into scoring if you want momentum confirmation)
- **Repaint risk:** None

#### 4.10 Reversal Detection v3.0 - Real-Time Pro
- **Score: 2/10**
- **Category:** Reversal signals
- **Settings:** Confirmed + Preview mode, Medium sensitivity
- **Strategy usage:** **NOT consumed by any code path**
- **Edge:** Zero in current workflow. The strategy generates its own reversal candidates via failed OR break setups.
- **Issues:**
  - "Preview" mode means it shows tentative signals that may disappear -- this is repaint behavior
  - Visual clutter on 1m chart with labels and boxes
  - Encourages counter-trend entries which conflicts with the trend-continuation focus of the strategy
- **Action:** REMOVE
- **Repaint risk:** YES -- "Preview" mode explicitly shows unconfirmed signals

#### 4.11 Predicta Futures - Next Candle Predictor V4
- **Score: 1/10**
- **Category:** Prediction/forecasting
- **Settings:** Hidden (not visible on chart)
- **Strategy usage:** **NOT consumed by any code path**
- **Edge:** Zero. "Next candle prediction" is fundamentally at odds with a rules-based confluence strategy.
- **Issues:**
  - Hidden but still loaded -- consuming chart resources
  - Prediction-style indicators encourage anticipation rather than reaction
  - Unknown repaint characteristics
- **Action:** REMOVE immediately
- **Repaint risk:** UNKNOWN -- prediction indicators are inherently suspect

#### 4.12 Orderblock Footprints [AlgoAlpha]
- **Score: 2/10**
- **Category:** Orderflow/orderblocks
- **Settings:** Hidden (not visible), 100/500 bar lookbacks
- **Strategy usage:** **NOT consumed by any code path**
- **Edge:** Zero in current workflow. Could theoretically supplement Smart Money CHoCH/BOS for supply/demand zones, but the strategy already has structural levels.
- **Issues:**
  - Hidden but still loaded -- consuming resources
  - Overlaps significantly with Smart Money Structure indicator
  - 500-bar lookback on 1m is computationally heavy
- **Action:** REMOVE (or make visible and integrate if you want supply/demand zones)
- **Repaint risk:** Orderblocks can be retroactively invalidated

---

## 5. Redundant / Low-Value Indicators to Remove

| Indicator | Reason for Removal | Impact |
|-----------|-------------------|--------|
| Reversal Detection v3.0 | Not consumed, repaint risk (Preview mode), encourages counter-trend | Free up chart resources, reduce visual noise |
| Predicta Futures V4 | Not consumed, hidden, prediction-based (anti-pattern for rules-based trading) | Free up resources |
| Orderblock Footprints | Not consumed, hidden, overlaps with Smart Money Structure | Free up resources |
| RSI 14 (standalone) | Read but never used in any decision. Custom indicator already computes RSI internally | Reduce clutter |

**Estimated resource savings:** Removing 4 studies (3 completely unused, 1 read-but-unused) will reduce chart computation load and eliminate visual noise.

---

## 6. Indicators to Retune

### 6.1 Improved EMA+Super Strategy (REFACTOR NEEDED)

**Current problems:**
1. **NovaWave Fast EMA** is literally `ta.ema(close, 9)` -- identical to EMA 9. Two plot lines drawing the same value.
2. **NovaWave Slow EMA** is literally `ta.ema(close, 21)` -- identical to EMA 21. Two more duplicate lines.
3. **DMA 20/50/200** all have displacement=0, making them regular SMAs. The strategy never reads them.
4. **Buy/Sell signal labels** create visual clutter but autotrade ignores them completely.
5. **`request.security("15", ...)`** fetches 15m EMA for "Ideal Entry" which is never consumed, and may cause subtle repaint.
6. **Performance table** shows "Last Signal" and "Potential Profit %" which are misleading.

**Recommended refactor:**
- Remove NovaWave plots (keep the EMA 9/21 originals which are identical)
- Remove DMA 20/50/200 plots entirely
- Remove buy/sell label generation
- Remove `request.security` call
- Remove performance table (or replace with actual useful data)
- This reduces the indicator from 141 lines to ~50 lines and removes 7+ plot objects

### 6.2 Opening Range [LuxAlgo] -- Align Window

**Current:** Configured with `in_1 = "30"` (30-minute OR window)
**Strategy config:** `opening_range_minutes: 15`

These should match. Either change the LuxAlgo indicator to 15 minutes, or confirm the visual 30-min range is intentionally different from the strategy's internal 15-min calculation.

---

## 7. High-Value Built-In Indicators to Test

### 7.1 ADX / DMI (Average Directional Index)
- **Category:** Trend strength
- **Why:** Your regime detection uses EMA stack alignment + SuperTrend direction, but has no measure of trend **strength**. ADX fills this gap -- it answers "is this trend strong enough to trade?"
- **Overlap:** None. No current indicator measures trend strength quantitatively.
- **Fit:** HIGH for NQ intraday. ADX > 20 on 5m is a common filter for avoiding chop.
- **Integration path:** Add to confidence scoring: ADX > 25 = +0.3, ADX < 15 = -0.5
- **Rating: 9/10**

### 7.2 Bollinger Bands (Standard Deviation Bands)
- **Category:** Volatility envelope
- **Why:** Compression detection currently uses fixed/adaptive % thresholds. Bollinger Band width (squeeze) is a more standard and well-tested compression detector.
- **Overlap:** Partially overlaps with ATR-based compression detection
- **Fit:** MEDIUM. Useful for NQ squeeze detection before breakouts.
- **Integration path:** BB width percentile as compression signal; Keltner Channel + BB squeeze
- **Rating: 6/10**

### 7.3 Stochastic RSI
- **Category:** Momentum oscillator
- **Why:** RSI 14 is already on chart but unused. Stochastic RSI is faster and more responsive for 1m NQ entries -- can serve as overbought/oversold filter for entry timing.
- **Overlap:** Replaces unused RSI
- **Fit:** MEDIUM. Useful for pullback entry timing within trend.
- **Integration path:** StochRSI < 20 during bullish pullback = entry confirmation
- **Rating: 5/10**

---

## 8. High-Value Public/Community Indicators to Test

### 8.1 TTM Squeeze (by John Carter)
- **Category:** Volatility/momentum
- **Why:** Combines Bollinger Band squeeze detection with momentum direction. Directly addresses the "compression before breakout" pattern that your strategy detects but doesn't trade well.
- **TradingView search:** "TTM Squeeze" or "Squeeze Momentum Indicator [LazyBear]"
- **Overlap:** Partially with ATR compression detection
- **Fit:** HIGH for NQ. TTM Squeeze fires reliably before NQ volatility expansions.
- **Rating: 8/10**

### 8.2 Cumulative Delta Volume
- **Category:** Orderflow
- **Why:** Your strategy uses volume quantity but not buy/sell pressure. Cumulative delta reveals whether buyers or sellers are dominant, even when price is flat.
- **TradingView search:** "Cumulative Delta Volume" (built-in on some plans, or community versions)
- **Overlap:** None. No current indicator measures buy/sell pressure.
- **Fit:** HIGH. NQ intraday moves are driven by aggressive buyers/sellers; delta confirms real demand.
- **Rating: 8/10**

### 8.3 Market Sessions Highlighter
- **Category:** Session awareness
- **Why:** Your strategy already has session detection in code, but no visual session boundaries on chart. Visualizing London/NY AM/Lunch/PM helps avoid entering during low-quality windows.
- **TradingView search:** "Sessions" or "Market Sessions"
- **Overlap:** None on chart (exists in code)
- **Fit:** HIGH for visual confirmation of session-based decisions
- **Rating: 7/10**

### 8.4 Anchored VWAP from Session Markers
- **Category:** Value area
- **Why:** Standard VWAP resets daily. Anchored VWAP from Monday's open or weekly open provides institutional-grade anchors for multi-day NQ levels.
- **Overlap:** Partially with VWAP
- **Fit:** MEDIUM. Adds longer-term institutional anchors.
- **Rating: 6/10**

---

## 9. Proposed Custom Indicators

### 9.1 NQ Regime & Confluence Dashboard (IMPLEMENTED)
- **Problem:** No single view shows regime, alignment, extension, and entry quality simultaneously. Trader must mentally combine 8+ separate indicators.
- **Why existing indicators fail:** Each indicator shows one dimension. The strategy scoring combines 12+ factors in TypeScript, but there's no visual equivalent on the chart.
- **Inputs:** EMA settings, SuperTrend settings, regime thresholds
- **Outputs:** Confluence score histogram (0-10), regime label, TF alignment breakdown, EMA stack status, VWAP distance, extension level, volume quality, RSI, ATR
- **How it fits:** Replaces mental arithmetic with at-a-glance dashboard. Score tracks the TypeScript scoring logic so trader can see what the system sees.
- **File:** `scripts/pine/nq_regime_confluence_dashboard.pine`

### 9.2 NQ Entry Lateness Filter (IMPLEMENTED)
- **Problem:** Strategy generates valid-looking setups after price has already extended 2-3 ATRs from key anchors. These "late entries" have poor R:R because the move already happened.
- **Why existing indicators fail:** No indicator on the chart measures composite extension from multiple anchors. EMA distance alone doesn't capture VWAP extension or OR extension.
- **Inputs:** EMA lengths, ATR length, extension thresholds (warning/danger/extreme in ATR multiples)
- **Outputs:** Directional extension histogram, composite extension score, IDEAL/CAUTION/LATE/EXTREME zones
- **How it fits:** Acts as a gate: if extension is in LATE or EXTREME zone, new entries should be avoided regardless of other signals. Directly addresses the late-chase problem.
- **File:** `scripts/pine/nq_session_extension_filter.pine`

### 9.3 NQ Chop vs Trend Quality Meter (IMPLEMENTED)
- **Problem:** The biggest losses come from trading chop. Strategy has basic chop detection (direction changes in 8 bars) but it's binary and crude. Many choppy conditions slip through.
- **Why existing indicators fail:** No single existing indicator combines ADX trend strength + Choppiness Index + EMA slope consistency + bar direction analysis + volume confirmation. Each alone has blind spots.
- **Inputs:** ADX length, Choppiness Index length, slope lookback, bar consistency window, scoring thresholds
- **Outputs:** Trend quality score 0-100, STRONG TREND/TRADEABLE/CAUTION/CHOPPY/SIT OUT labels, component breakdown
- **How it fits:** Replaces the binary "choppy = true/false" regime gate with a graduated quality score. Score < 40 = sit on hands. Score > 60 = trade. This alone could eliminate a large portion of losing trades.
- **File:** `scripts/pine/nq_chop_trend_quality.pine`

### 9.4 Long/Short Confluence Score (PROPOSED -- NOT YET IMPLEMENTED)
- **Problem:** Strategy evaluates long and short candidates separately, then compares. A visual indicator showing both scores simultaneously would let the trader see what the system is thinking.
- **Why not implemented:** This would need to replicate most of the TypeScript scoring logic in Pine, which is complex and would diverge from the source of truth. Better to expose this from the TypeScript system via the dashboard WebSocket.

### 9.5 MFE/MAE Trade Management Overlay (PROPOSED -- NOT YET IMPLEMENTED)
- **Problem:** Current T1 hit rate is 47.6% (should be 70-80%). The PT1/PT2/trailing triggers may be suboptimal. An overlay showing historical MFE/MAE distributions would inform better target placement.
- **Why not implemented:** Requires trade history data that's in JSONL logs, not easily accessible from Pine. Better implemented as a dashboard panel or offline analysis.

---

## 10. Custom Indicators Implemented

| Indicator | File | Lines | Purpose |
|-----------|------|-------|---------|
| NQ Regime & Confluence Dashboard v1.0 | `scripts/pine/nq_regime_confluence_dashboard.pine` | 198 | All-in-one regime + alignment + scoring dashboard |
| NQ Entry Lateness Filter v1.0 | `scripts/pine/nq_session_extension_filter.pine` | 147 | Extension-from-anchors gate to prevent late entries |
| NQ Chop vs Trend Quality v1.0 | `scripts/pine/nq_chop_trend_quality.pine` | 164 | Multi-factor chop detection replacing binary regime gate |

All three indicators:
- Use `barmerge.lookahead_off` for all `request.security` calls (no repaint)
- Are configurable via input parameters
- Include info tables for at-a-glance reading
- Include alert conditions for automation
- Are designed for NQ 1-minute intraday charts

---

## 11. Risks / Repaint Notes / Limitations

### Repaint Risks in Current Setup
| Indicator | Repaint Risk | Details |
|-----------|-------------|---------|
| Improved EMA+Super Strategy | **MODERATE** | `request.security("15", ...)` without explicit `barmerge.lookahead_off` -- may repaint on live bars |
| Reversal Detection v3.0 | **HIGH** | "Confirmed + Preview" mode explicitly shows unconfirmed signals that may disappear |
| Smart Money Structure | **LOW** | CHoCH/BOS levels retroactively drawn when structure breaks -- standard behavior, acceptable |
| All others | **NONE** | Standard calculations on confirmed bars |

### Limitations of New Custom Indicators
1. **Confluence Dashboard:** Multi-TF data may lag by 1 bar on the higher timeframe due to `barmerge.lookahead_off`. This is the correct trade-off (no repaint vs slight lag).
2. **Entry Lateness Filter:** OR detection uses time-based logic that assumes RTH session; may not work correctly during holidays or early closes.
3. **Chop Quality Meter:** ADX is inherently lagging (smoothed twice). Score transitions may be late by 3-5 bars. The EMA(3) smoothing adds minimal additional lag but reduces flicker.

### Unused Data Fields
The following indicator fields are collected every analysis cycle but never consumed:
- `ema_100` -- EMA 100 value
- `dma_20`, `dma_50`, `dma_200` -- Displaced Moving Averages (displacement=0)
- `rsi` -- RSI 14 value
- `monday_high`, `monday_low`, `monday_mid` -- from RIPS Key Levels
- `monthly_open` -- from RIPS Key Levels

**Recommendation:** Either integrate these into scoring or remove them from the data collection loop to reduce noise and processing time.

---

## 12. Recommended Next Testing Plan

### Phase 1: Clean Up (Do First)
1. **Remove** Reversal Detection v3.0 from chart
2. **Remove** Predicta Futures V4 from chart
3. **Remove** Orderblock Footprints from chart
4. **Remove** standalone RSI indicator from chart (the custom indicator already computes it internally)
5. **Refactor** Improved EMA+Super Strategy to remove duplicate plots, unused DMAs, and signal labels

### Phase 2: Add New Custom Indicators
1. Push `nq_chop_trend_quality.pine` to TradingView and add to chart
2. Push `nq_session_extension_filter.pine` and add to chart
3. Push `nq_regime_confluence_dashboard.pine` and add to chart
4. Run for 1-2 trading sessions in observation mode (no live trading changes)
5. Compare Chop Quality Meter readings vs actual regime classification in `signals.jsonl`

### Phase 3: Integration Testing
1. Compare Chop Quality score with strategy's `is_choppy` boolean -- how often does the graduated score catch chop that the binary detector misses?
2. Compare Entry Lateness composite extension with actual trade MFE -- do "LATE" entries have worse MFE/MAE?
3. Compare Dashboard confluence score with strategy confidence -- do they correlate?

### Phase 4: Evaluate External Indicators
1. Add TTM Squeeze indicator to chart; compare with ATR compression detection
2. Test Cumulative Delta Volume for buy/sell pressure confirmation
3. Add Market Sessions highlighter for visual session awareness

### Phase 5: Code Integration
1. If Chop Quality Meter proves valuable, integrate its logic into the TypeScript regime classifier
2. If Entry Lateness Filter proves valuable, add extension scoring to confidence calculation
3. Consider removing Monday H/L/M and Monthly Open from data collection if no integration planned

---

## Appendix A: Current Indicator Settings Snapshot

### VWAP (vnII84)
- Source: hlc3
- Anchor: Session
- Bands: 1/2/3 SD enabled

### Opening Range [LuxAlgo] (T94vVj)
- Window: 30 minutes (mismatch with strategy's 15 min)
- Time: 0930-0945, UTC-5
- Breakout targets: Adaptive, EMA 50

### RIPS Key Levels (Gjxkme)
- Mode: Standard
- Timezone: UTC-6
- Enabled: Daily Open, Weekly Open, Monday H/L/M, Monthly Open, Prev Week/Month, Quarterly, Yearly

### Smart Money Structure (1WeuEa)
- Swing Length: 5
- CHoCH/BOS detection: 5M MTF
- Showing: Both CHoCH and BOS

### Pivot Levels [BigBeluga] (JpmBdM)
- Resolutions: 5/25/50/100 bars
- Types: Both (support + resistance)

### Improved EMA+Super Strategy (uWeK2P)
- EMAs: 9/21/50/100/200 on close
- SuperTrend: Factor 4.0, ATR 10
- NovaWave Signal MA: SMA 10
- RSI: 14
- Volume: 20-period SMA, 1.5x multiplier
- DMAs: 20/50/200 displacement 0

### RSI (GggNPN)
- Period: 14
- Source: close

### ATR (ADKJhx)
- Period: 14
- Smoothing: RMA

---

## Appendix B: Indicator-to-Strategy Usage Matrix

| Indicator Field | Regime | Multi-TF Bias | Setup Generation | Confidence Score | Data Quality | Claude Advisory |
|----------------|--------|---------------|------------------|-----------------|-------------|-----------------|
| EMA 9 | YES | YES (1m,15m) | YES (all trend) | indirect | YES | YES |
| EMA 21 | YES | YES (all TFs) | YES (stops) | indirect | YES | YES |
| EMA 50 | YES | YES (1m) | YES (trend) | indirect | YES | YES |
| EMA 100 | - | - | - | - | - | - |
| EMA 200 | - | YES (15m,1h) | - | - | - | YES |
| SuperTrend | YES | YES (all TFs) | YES (gate) | YES (+/-0.5) | - | YES |
| NovaWave | - | YES (1m only) | - | - | - | - |
| CHoCH/BOS | - | - | YES (targets,entry) | YES (+0.5) | - | YES |
| VWAP | - | - | - | YES (+/-0.3) | YES (critical) | YES |
| ATR | YES | - | YES (stops) | - | YES (critical) | YES |
| RSI | - | - | - | - | tracked | - |
| Volume | YES | YES (5m) | - | YES (+/-0.5) | - | - |
| Pivot Levels | - | - | YES (all targets) | - | - | - |
| Daily Open | - | - | YES (fallback T2) | - | - | - |
| Weekly Open | - | - | YES (fallback T3) | - | - | - |
| Opening Range | - | - | YES (4 generators) | YES (+0.4) | YES | YES |
| DMA 20/50/200 | - | - | - | - | - | - |
| Monday H/L/M | - | - | - | - | - | - |
| Monthly Open | - | - | - | - | - | - |

---

## Appendix C: Files Created

| File | Type | Description |
|------|------|-------------|
| `scripts/pine/nq_regime_confluence_dashboard.pine` | Pine Script | Multi-factor regime + confluence dashboard |
| `scripts/pine/nq_session_extension_filter.pine` | Pine Script | Entry lateness / extension filter |
| `scripts/pine/nq_chop_trend_quality.pine` | Pine Script | Chop vs trend quality meter |
| `TRADINGVIEW_INDICATOR_DEEP_DIVE_REPORT.md` | Report | This report |

---

*Report generated by automated indicator audit via TradingView CDP/MCP direct access.*
