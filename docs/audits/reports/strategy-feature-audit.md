# Strategy Feature & Indicator Audit

**Date:** 2026-04-06
**Scope:** All indicators collected and used in the NQ/MNQ autonomous trading engine
**Method:** Code-level trace of every indicator field from collection (data-collector.ts) through decision logic (strategy.ts), management (management/), and advisory (claude-reasoning/)

---

## Classification Legend

| Tag | Meaning |
|-----|---------|
| **CORE** | Hard gate or high-weight scoring input (>= 0.4pts). Removal would break setups or significantly alter entry quality. |
| **SECONDARY** | Moderate scoring input (0.2-0.4pts). Contributes to confidence but not gating. |
| **OBSERVATIONAL** | Collected for logging, management context, or Claude advisory. Not in entry scoring. |
| **UNUSED** | Collected from TradingView but never referenced in any decision logic. |
| **DEPRECATED** | Collection stopped. Field remains in schema as `null` for backwards compatibility. |

---

## Indicator Classification

### CORE — Do Not Remove

| Indicator | Fields | Collection TFs | Role | Impact |
|-----------|--------|---------------|------|--------|
| **EMA 9/21/50** | `ema_9`, `ema_21`, `ema_50` | 1m, 15m, 1h | Regime classification, trend setup hard gates, bias scoring | EMA stack gates ALL trend pullback/breakout setups. Regime trending requires alignment. |
| **EMA 200** | `ema_200` | 1m, 15m, 1h | HTF bias assessment (1h), ML features | 1h EMA200 contributes to alignment score (hard-gated at >=2). |
| **SuperTrend** | `supertrend_direction`, `supertrend_level` | 1m, 15m, 1h | Regime classification, bias (2x weight), setup hard gates, scoring (+/-0.5) | Gates trend pullbacks. 2x weight in multi-TF bias. Redundant with EMA stack for direction but kept for independent confirmation. |
| **ATR 14** | `atr_14` | 1m, 15m, 1h | Compression regime threshold, stop buffer widening, management normalization, management profile resolution | Adaptive thresholds. Critical for management profiles (ATR-relative PT1/PT2). |
| **CHoCH/BOS** | `smart_money_choch_sell/buy`, `smart_money_bos_sell/buy` | 1m (labels) | Setup entry zones, T1 targets, structural bonus (+0.5) | Defines entry zones for breakdown retest. Primary T1 source for trend pullbacks. |
| **Opening Range** | `opening_range_high/low/mid` | Derived from 1m bars | Hard gates for NQ-specific setups (opening drive, failed OR break) | Entire setup families cannot exist without OR. |
| **Key Levels** | `session_high/low`, `daily_open`, `weekly_open`, `pivot_resistance[]`, `pivot_support[]`, `overnight_high/low` | Labels + session logic | Target calculation (T2, T3), scoring (+0.4 near OR level) | Primary source for profit targets. |
| **Session/Regime** | `is_rth`, `is_eth`, timing fields | Derived | Hard gates (market closed, closing window, session-specific setups) | Gates entire setup families by schedule. |
| **Volume** | `volume`, `volume_sma_20` | 1m bars | HVI regime trigger (vol > avg x 3), scoring (+/-0.5) | Volume spike blocks non-momentum entries. |
| **Multi-TF Alignment** | Computed from bias across 1m/5m/15m/1h | All TFs | Hard gate (alignment >= 2), scoring (+2.0 for 4TF, +1.0 for 3TF) | Highest single scoring factor. Hard-gated. |

### SECONDARY — Keep, Lower Priority

| Indicator | Fields | Collection TFs | Role | Impact |
|-----------|--------|---------------|------|--------|
| **ADX** | `adx` | 1m, 15m, 1h | Regime trending confirmation (ADX>25), scoring (+0.4 strong, -0.3 weak) | Confirms trends without full EMA stack. Moderate scoring. |
| **DI+/DI-** | `di_plus`, `di_minus` | 1m, 15m, 1h | Bias scoring (+/-1pt), ADX confirmation (+0.2) | DI direction in bias. Small standalone scoring. |
| **TTM Squeeze** | `ttm_squeeze_momentum`, `ttm_squeeze_firing` | 1m | Compression regime hard gate, scoring (+/-0.3) | Compression blocks entries. Moderate scoring on release. |
| **VWAP** | `vwap` | 1m | Scoring (+/-0.3), management distance context | Moderate scoring. Management uses distance-to-VWAP. |
| **CVD** | `cvd`, `cvd_delta`, `cvd_trend` | 1m | Divergence detection (-0.4), alignment bonus (+0.25), bias (+/-1pt) | Order-flow confirmation. Divergence is highest single penalty in CVD scoring. |

### OBSERVATIONAL — Not in Entry Scoring

| Indicator | Fields | Where Used | Notes |
|-----------|--------|-----------|-------|
| **RSI 14** | `rsi_14` | Management only: extreme penalty (-0.25 at RSI >75 or <25) | Zero references in strategy.ts. Was marked "critical" in data quality checks (now demoted). |
| **NovaWave Fast/Slow** | `novawave_fast`, `novawave_slow` | assessBias1m() only: +/-1pt to bias tally | Redundant with EMA stack direction. Removed from live bias scoring. Fields still collected for logging. |

### DEPRECATED — Collection Stopped

| Indicator | Fields | Reason |
|-----------|--------|--------|
| **EMA 100** | `ema_100` | Collected for 1m but zero references in any file. No strategy, management, or advisory usage. |
| **DMA 20/50/200** | `dma_20`, `dma_50`, `dma_200` | Collected for 1m but zero references anywhere in codebase. |
| **NovaWave Signal** | `novawave_signal` | Collected but never referenced (only fast/slow were used, and those are now observational). |

---

## Scoring Factor Tiers

Factors in `scoreConfidenceDetailed()` ranked by impact:

### Tier 1 — Core Decision Inputs (>= 0.5 pts or hard gate)
| Factor | Max Impact | Indicators |
|--------|-----------|------------|
| Multi-TF alignment | +2.0 / -0.5 | All TF bias indicators |
| HTF direction conflict | -1.0 | 1h bias vs setup direction |
| Regime alignment | +0.3 / -1.0 | classifyRegime() output |
| SuperTrend confirmation | +0.5 / -0.5 | supertrend_direction |
| Structural level | +0.5 | BOS/CHoCH price proximity |
| R:R quality | +0.5 / -0.5 | Computed from targets/stop |
| Volume quality | +0.5 / -0.5 | volume vs volume_sma_20 |

### Tier 2 — Secondary Confirmation (0.3-0.4 pts)
| Factor | Max Impact | Indicators |
|--------|-----------|------------|
| ADX trend strength | +0.4 / -0.3 | adx, regime |
| Opening range level | +0.4 | opening_range_high/low |
| CVD divergence | -0.4 / +0.25 | cvd_delta, cvd_trend |
| VWAP position | +0.3 / -0.3 | vwap |
| Swing structure | +0.3 + 0.2 | 5m/15m bar highs/lows |
| TTM squeeze | +0.3 / -0.3 | ttm_squeeze_firing, momentum |
| Entry location | -0.3 | price vs entry zone |

### Tier 3 — Supporting Context (< 0.3 pts)
| Factor | Max Impact | Indicators |
|--------|-----------|------------|
| DI confirms | +0.2 | di_plus, di_minus |
| Missing indicators | -0.25 / -0.5 | Data quality count |

---

## Trained Model (PoP) Features

The logistic regression probability model uses **16 geometric features only**:
geo_ratio_t1/t2, current_r, mfe_r, mae_r, t1/t2/stop_dist_r, partial_exit_done, hold_seconds_norm, is_long, setup type flags, regime flags.

**No raw indicator values** are in the trained model. ATR, RSI, VWAP, ADX, CVD, TTM — none are model inputs. The model operates on position geometry and regime context.

---

## Redundancy Notes

1. **SuperTrend + EMA Stack:** Both check trend direction. Trend pullback setups require BOTH as gates. SuperTrend is a composite (ATR-based trailing) while EMAs show raw price structure. The redundancy is intentional (belt-and-suspenders) but means removing one would not lose directional information. Keep both: SuperTrend for direction, EMA stack for trend structure quality.

2. **DI in Bias + ADX in Scoring:** DI+/DI- contributes +/-1pt to the multi-TF bias tally. ADX>25 with DI confirmation adds +0.2 in scoring. These are low-overlap because bias aggregation and confidence scoring are separate stages. Both kept but documented as minor.

3. **NovaWave vs EMA Stack:** NovaWave fast/slow crossover checks the same thing as EMA 9/21 crossover. In assessBias1m(), EMA stack contributes ±3pts while NovaWave adds only ±1pt. NovaWave removed from bias scoring as redundant.

---

## Changes Made

1. **Stopped collection** of EMA 100, DMA 20/50/200, NovaWave Signal (data-collector.ts)
2. **Removed NovaWave** from assessBias1m() scoring (strategy.ts)
3. **Demoted RSI** from critical data quality check (data-collector.ts)
4. **Added tier annotations** to scoreConfidenceDetailed() (strategy.ts)
5. **Added feature_set instrumentation** for A/B comparison (strategy.ts)
6. **Added JSDoc classifications** to IndicatorSnapshot fields (types.ts)

---

## Which Indicators Matter Most for NQ

For NQ/MNQ intraday futures trading in this architecture:

1. **Multi-TF Directional Bias** (the single most impactful factor at +2.0) — NQ trends hard when institutional flow aligns across timeframes. 4TF alignment is the strongest edge signal.

2. **Structure / CHoCH / BOS** — NQ respects smart money levels. Break of structure defines entry zones; CHoCH levels define reversal targets. Critical for all pullback setups.

3. **Opening Range** — The first 15 minutes of RTH establish the day's reference frame. OR breakout/failure is the basis of 4 setup types. NQ's OR is one of the most reliable intraday patterns.

4. **ATR / Volatility Context** — NQ's volatility varies dramatically (8pt ATR on quiet days, 25pt on FOMC). ATR-relative management (via management profiles) prevents fixed-point targets from being too tight or too wide.

5. **SuperTrend** — A clean directional filter. When SuperTrend agrees with EMA stack, trend continuation has higher probability.

6. **Volume** — Volume spikes trigger HVI regime (blocks entries). Volume quality gates distinguish real moves from noise. Critical for NQ where institutional activity creates distinct volume signatures.

7. **CVD** — Divergence detection warns when price movement lacks volume confirmation. The -0.4 divergence penalty is the strongest single CVD signal and has genuine alpha in NQ where spoofing creates price/volume disagreements.
