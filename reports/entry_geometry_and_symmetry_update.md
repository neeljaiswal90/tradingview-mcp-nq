# Entry Geometry & Directional Symmetry Update

## What Was Wrong

### 1. Extension Normalization Used Wrong Scale

**Root cause:** All spatial metrics (VWAP distance, room-to-structure, room-to-target) were normalized by 1-minute ATR(14), which for NQ/MNQ is ~7 points. Session-scale distances (price to VWAP, price to key levels) are typically 50-500+ points on trending days.

**Empirical evidence from candidate logs:**
- 1m ATR median: 7.35 pts
- VWAP distance median: 413 pts (completely normal trending-day distance)
- VWAP distance in 1m-ATR: median 49.8 (absurd — "50 ATR from VWAP")
- VWAP threshold: 2.0 ATR → 98.8% of candidates exceeded it
- Extension veto rate: 87.2% of all candidates vetoed

A threshold of "2 ATR from VWAP" with 1m ATR means "within 14 points of VWAP" — on any trending day, this blocks everything.

### 2. Directional Freshness Was Asymmetric

**Root cause:** `isUptrendFresh()` existed for long entries (checks 5m higher-low structure, SuperTrend, VWAP position) but there was no equivalent `isDowntrendFresh()` for shorts. Short generators relied only on EMA stack + SuperTrend direction without structural freshness validation.

**Impact:** Long entries were gated on trend freshness while short entries could fire on stale, extended downtrends.

## What Changed

### New Module: `src/autotrade/features/normalization.ts`

Introduces a normalization policy separating metrics into two families:
- **Micro metrics** (1m ATR): impulse size, 3-bar return, EMA9 distance — bar-scale measurements
- **Session metrics** (session ATR): VWAP distance, room-to-structure — session-scale measurements

Session ATR is computed as `atr_1m * sqrt(N)` where N defaults to 60 (1 hour of bars). When the actual session range (session_high - session_low) is larger, that's used instead. A floor of 20 pts prevents degenerate values.

For NQ with 1m ATR ≈ 7: session ATR ≈ 54 pts. So "2 ATR from VWAP" means ~108 pts, which is a reasonable threshold.

### Updated: `src/autotrade/features/extension.ts`

- Added `dist_from_vwap_session` (session-normalized VWAP distance)
- Added `upside_room_session` / `downside_room_session` (session-normalized room)
- Veto function now uses session-scaled values for VWAP distance and room checks
- Legacy `_atr` fields preserved for backward compatibility
- Normalization diagnostics (`normalization_mode`, `session_atr`, `micro_atr`) included in features

### Updated: `src/autotrade/strategy.ts`

- New `isTrendFresh(snap, direction)` function: unified directional freshness that works for both long and short
- Short freshness checks: 5m lower-highs structure, SuperTrend not flipped up + above EMA21, price below VWAP
- `genTrendPullbackShort` now gates on `isTrendFresh(snap, 'short')`
- Legacy `isUptrendFresh()` preserved as wrapper around `isTrendFresh(snap, 'long')`

## Files Changed

| File | What Changed |
|------|-------------|
| `src/autotrade/features/normalization.ts` | **New module**: session-scale ATR computation, normalization policy |
| `src/autotrade/features/extension.ts` | Session-normalized VWAP/room fields; veto uses session scale; normalization diagnostics |
| `src/autotrade/strategy.ts` | Unified `isTrendFresh()` for both directions; `genTrendPullbackShort` uses freshness gate |
| `tests/unit/extension-features.test.ts` | Updated VWAP veto tests for session-scale thresholds; added test proving old 1m-ATR veto is now fixed |
| `tests/unit/normalization-and-freshness.test.ts` | **New**: 17 tests for normalization + freshness symmetry |
| `reports/entry_geometry_and_symmetry_update.md` | This report |

## How the New Normalization Works

```
Metric Type          Normalizer              Example (ATR=7, session_range=400)
─────────────────    ──────────────────      ─────────────────────────────────
VWAP distance        session ATR (400)       400pts / 400 = 1.0 session-ATR
Room to structure    session ATR (400)       50pts / 400 = 0.125 session-ATR
3-bar return         micro ATR (7)           14pts / 7 = 2.0 micro-ATR
Impulse size         micro ATR (7)           21pts / 7 = 3.0 micro-ATR
EMA9 distance        micro ATR (7)           3pts / 7 = 0.43 micro-ATR
```

## How Freshness Is Now Symmetric

| Check | Long (isUptrendFresh) | Short (isDowntrendFresh) |
|-------|----------------------|--------------------------|
| 5m structure | Higher lows (recent min low > prior min low) | Lower highs (recent max high < prior max high) |
| SuperTrend | Not flipped down (exception: price above EMA21) | Not flipped up (exception: price below EMA21) |
| VWAP position | Price above VWAP | Price below VWAP |

## Validation

- TypeScript: clean typecheck
- Tests: 972 passing across 50 files
- New tests: 17 (normalization + freshness)
- Updated tests: 4 (VWAP veto → session-scale)
- Python tests: all passing (no Python changes)

## Remaining Risks / Follow-ups

1. **Threshold calibration**: The VWAP threshold of 2.0 session-ATR is now meaningful but may need tuning with live data. Monitor the veto rate in paper mode.
2. **Room threshold calibration**: The 1.0 session-ATR room threshold is conservative. On wide-range days (session range 400+), "1 session ATR of room" means 400 pts, which is very generous. May need a separate room-specific threshold.
3. **Normalization config**: The `session_scale_bars: 60` default is a modeling assumption. Could be made configurable per setup family if needed.
4. **No management changes**: This patch deliberately does not touch trailing, PT1/PT2, or management profiles. Entry geometry and directional symmetry are the focus.
