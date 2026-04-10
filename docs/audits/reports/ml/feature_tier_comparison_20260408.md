# Feature Tier Comparison: No LOB vs LOB vs LOB+MBO vs LOB+Advanced MBO

**Date:** 2026-04-08
**Feature schema version:** v3_advanced_mbo

## Feature Tiers

| Tier | Features | Data Source | Availability | Status |
|------|----------|-------------|-------------|--------|
| **Tier 0: Position-only** | 20 numeric + 2 categorical = 22 | Position state, strategy output | Always | Production (baseline) |
| **Tier 1: + LOB (BBO/Depth)** | + 7 BBO + 4 depth = +11 | Bookmap BBO/depth | When sidecar running | Stable |
| **Tier 2: + Early MBO aggregates** | + 5 trade flow + 4 MBO = +9 | Bookmap trades + basic MBO | When sidecar running | Stable |
| **Tier 3: + Advanced MBO** | + 7 advanced = +7 | Rich MBO with order_id + modify | When MBO listener active | Optional |
| **Total** | 22 + 11 + 9 + 7 = **49 features** | | | |

## Tier 0: Position-Only (Baseline — 22 features)

Available on all trades. No external dependency.

```
is_short, confidence_at_entry, initial_risk_pts, current_price, stop_current,
quantity_remaining, pnl_pts, unrealized_r, mfe_pts_so_far, mae_pts_so_far,
time_in_trade_sec, distance_to_stop_pts, pt1_hit, pt2_hit, stop_at_breakeven,
trail_active, trail_ratchet_count, management_events_count, entry_hour_utc,
tick_hour_utc, setup_type, regime_at_entry
```

**Expected value:** Captures position lifecycle and strategy context. Weak on market state.

## Tier 1: + LOB BBO/Depth (11 additional features)

Requires Bookmap/Rithmic sidecar. Nullable when unavailable.

```
lob_spread_ticks, lob_bid_size, lob_ask_size,
lob_depth_imbalance_5, lob_depth_imbalance_10,
lob_total_bid_depth_10lvl, lob_total_ask_depth_10lvl,
lob_cumulative_delta_10s, lob_cumulative_delta_30s, lob_cumulative_delta_60s,
lob_trade_flow_imbalance_10s
```

**Expected value:** Directional pressure, liquidity quality, spread risk. Should improve exit timing.

## Tier 2: + Early MBO Aggregates (9 additional features)

Requires Bookmap MBO listener. Uses the basic `RollingMboAggregator`.

```
lob_trade_flow_imbalance_30s,
lob_cancel_add_ratio_10s, lob_replenishment_rate_10s,
lob_absorption_rate_10s, lob_sweep_count_10s
```

**Expected value:** Spoofing detection, level defense quality, aggressive flow. Should improve both entry and exit decisions.

## Tier 3: + Advanced MBO (7 additional features)

Requires rich MBO data with order_id, modify events, and size tracking. Optional layer.

```
adv_cancel_replace_ratio_10s   — Refined cancel/replace pressure
adv_modify_rate_10s            — Aggressive repricing detection
adv_iceberg_suspicion_30s      — Hidden liquidity score (>1.0 = likely iceberg)
adv_queue_deterioration_bid_10s — Top-of-book thinning on bid side
adv_queue_deterioration_ask_10s — Same for ask side
adv_pull_cascade_count_10s      — Coordinated liquidity withdrawal events
adv_lifetime_p50_ms             — Median order lifetime (short = HFT, long = patient)
```

**Expected value:** Institutional flow detection, queue dynamics, hidden liquidity. Highest-alpha features but highest data requirement.

## Implementation Notes

| Concern | Implementation |
|---------|----------------|
| **Nullable handling** | All LOB/MBO features are nullable. CatBoost handles missing values natively. |
| **Feature parity** | All tiers share the same `compute_lob_features()` function. Live and offline paths are identical. |
| **Backward compatibility** | Models trained on Tier 0 still work — extra features are ignored. |
| **Retraining** | Each tier addition requires model retraining to use new features. |
| **Isolation** | Advanced MBO analyzer has an `enabled` flag. When disabled, no events are stored. |
| **Historical data** | Bookmap .bmf files may provide replay data for Tiers 1-2. Tier 3 requires live recording. |

## Recommended Evaluation Plan

1. **Current baseline:** Tier 0 only (no LOB). Establish win rate, expectancy, R metrics.
2. **After Bookmap integration live:** Record 50+ trades with Tiers 1-2 features.
3. **Retrain with LOB:** Compare walk-forward metrics: Tier 0 vs Tier 0+1+2.
4. **If Tier 2 improves metrics:** Enable Tier 3 recording. After 50+ trades, compare Tier 0+1+2 vs Tier 0+1+2+3.
5. **If Tier 3 does not improve:** Keep Tier 3 disabled to save compute. Early aggregates are sufficient.

## Data Requirements per Tier

| Tier | Min Trades for Training | Event Rate | Storage (per session) |
|------|------------------------|------------|----------------------|
| 0 | 50 | N/A | ~2 KB/trade |
| 1 | 50 | BBO: ~50/s | ~5 MB/hour |
| 2 | 100 | Trades: ~10/s, MBO: ~100/s | ~20 MB/hour |
| 3 | 200+ | MBO with order_id: ~500/s | ~100 MB/hour |

## Remaining Uncertainty

- **Tier 3 features are unproven.** Iceberg detection and queue deterioration are theoretically high-alpha but require enough live NQ data to validate.
- **Historical .bmf parsing is undocumented.** Converter is flagged as experimental.
- **Order_id availability** depends on Rithmic's MBO data subscription and Bookmap's `MarketByOrderDepthDataListener` API.
