# CatBoost Management Model Training Report

**Generated:** 20260408_022433
**Device:** GPU
**Dataset:** 1256 valid rows
**Role:** Challenger (vs XGBoost baseline)

---

## Head-to-Head: CatBoost vs XGBoost

### Classifier (`sl_hold_is_better`)

| Metric | XGBoost | CatBoost | Winner |
|--------|---------|----------|--------|
| accuracy | 0.4897 | 0.7483 | CatBoost |
| precision | 0.1685 | 0.629 | CatBoost |
| recall | 0.1685 | 0.4382 | CatBoost |
| f1 | 0.1685 | 0.5166 | CatBoost |
| roc_auc | 0.2794 | 0.8006 | CatBoost |
| log_loss | 1.011 | 0.5574 | CatBoost |

### Regressor (`sl_remaining_r`)

| Metric | XGBoost | CatBoost | Winner |
|--------|---------|----------|--------|
| rmse | 0.907 | 0.799 | CatBoost |
| mae | 0.7787 | 0.5232 | CatBoost |
| r2 | -0.1594 | 0.1002 | CatBoost |

---

## Classifier Detail

| Metric | Value |
|--------|-------|
| accuracy | 0.7483 |
| precision | 0.629 |
| recall | 0.4382 |
| f1 | 0.5166 |
| roc_auc | 0.8006 |
| log_loss | 0.5574 |
| best_iteration | 6 |
| training_time_sec | 1.04 |
| train_samples | 966 |
| test_samples | 290 |

**Confusion Matrix:**

| | Pred 0 | Pred 1 |
|---|--------|--------|
| Actual 0 | 178 | 23 |
| Actual 1 | 50 | 39 |

**Top 10 Features:**

| Rank | Feature | Importance |
|------|---------|------------|
| 1 | initial_risk_pts | 22.9971 |
| 2 | entry_hour_utc | 21.2846 |
| 3 | mfe_pts_so_far | 10.6554 |
| 4 | quantity_remaining | 9.8479 |
| 5 | stop_current | 8.7023 |
| 6 | distance_to_stop_pts | 6.9144 |
| 7 | current_price | 6.1046 |
| 8 | pnl_pts | 4.2874 |
| 9 | confidence_at_entry | 3.6024 |
| 10 | tick_hour_utc | 2.8831 |

## Regressor Detail

| Metric | Value |
|--------|-------|
| rmse | 0.799 |
| mae | 0.5232 |
| r2 | 0.1002 |
| target_mean | -0.5376 |
| target_std | 0.8423 |
| pred_mean | -0.3072 |
| pred_std | 0.2628 |
| best_iteration | 29 |
| training_time_sec | 0.99 |

**Top 10 Features:**

| Rank | Feature | Importance |
|------|---------|------------|
| 1 | initial_risk_pts | 49.5612 |
| 2 | stop_current | 14.4691 |
| 3 | quantity_remaining | 10.7633 |
| 4 | current_price | 6.0434 |
| 5 | entry_hour_utc | 4.9074 |
| 6 | mae_pts_so_far | 4.657 |
| 7 | tick_hour_utc | 2.2222 |
| 8 | unrealized_r | 1.7503 |
| 9 | mfe_pts_so_far | 1.7223 |
| 10 | distance_to_stop_pts | 1.7065 |

---

## Feature Schema (45 features)

| # | Feature | Type |
|---|---------|------|
| 1 | is_short | numeric |
| 2 | confidence_at_entry | numeric |
| 3 | initial_risk_pts | numeric |
| 4 | current_price | numeric |
| 5 | stop_current | numeric |
| 6 | quantity_remaining | numeric |
| 7 | pnl_pts | numeric |
| 8 | unrealized_r | numeric |
| 9 | mfe_pts_so_far | numeric |
| 10 | mae_pts_so_far | numeric |
| 11 | time_in_trade_sec | numeric |
| 12 | distance_to_stop_pts | numeric |
| 13 | pt1_hit | numeric |
| 14 | pt2_hit | numeric |
| 15 | stop_at_breakeven | numeric |
| 16 | trail_active | numeric |
| 17 | trail_ratchet_count | numeric |
| 18 | management_events_count | numeric |
| 19 | entry_hour_utc | numeric |
| 20 | tick_hour_utc | numeric |
| 21 | lob_spread_ticks | numeric |
| 22 | lob_bid_size | numeric |
| 23 | lob_ask_size | numeric |
| 24 | lob_depth_imbalance_5 | numeric |
| 25 | lob_depth_imbalance_10 | numeric |
| 26 | lob_total_bid_depth_10lvl | numeric |
| 27 | lob_total_ask_depth_10lvl | numeric |
| 28 | lob_cumulative_delta_10s | numeric |
| 29 | lob_cumulative_delta_30s | numeric |
| 30 | lob_cumulative_delta_60s | numeric |
| 31 | lob_trade_flow_imbalance_10s | numeric |
| 32 | lob_trade_flow_imbalance_30s | numeric |
| 33 | lob_cancel_add_ratio_10s | numeric |
| 34 | lob_replenishment_rate_10s | numeric |
| 35 | lob_absorption_rate_10s | numeric |
| 36 | lob_sweep_count_10s | numeric |
| 37 | adv_cancel_replace_ratio_10s | numeric |
| 38 | adv_modify_rate_10s | numeric |
| 39 | adv_iceberg_suspicion_30s | numeric |
| 40 | adv_queue_deterioration_bid_10s | numeric |
| 41 | adv_queue_deterioration_ask_10s | numeric |
| 42 | adv_pull_cascade_count_10s | numeric |
| 43 | adv_lifetime_p50_ms | numeric |
| 44 | setup_type | categorical (native) |
| 45 | regime_at_entry | categorical (native) |

---

## Reproducibility

```bash
python scripts/ml/train_catboost_management.py \
  --device gpu --seed 42
```