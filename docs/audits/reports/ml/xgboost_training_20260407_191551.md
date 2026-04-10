# XGBoost Management Model Training Report

**Generated:** 20260407_191551
**Device:** cuda
**Dataset:** 1256 valid rows

---

## Models Trained

### 1. Hold Classifier (`sl_hold_is_better`)

Binary classification: should the trade be held (1) or exited (0)?

| Metric | Value |
|--------|-------|
| accuracy | 0.4897 |
| precision | 0.1685 |
| recall | 0.1685 |
| f1 | 0.1685 |
| roc_auc | 0.2794 |
| log_loss | 1.011 |
| best_iteration | 0 |
| training_time | 0.1s |
| train_samples | 966 |
| test_samples | 290 |
| class_balance (train) | 1:274 / 0:692 |

**Confusion Matrix (test):**

| | Pred 0 | Pred 1 |
|---|--------|--------|
| Actual 0 | 127 | 74 |
| Actual 1 | 74 | 15 |

**Top 10 Features by Gain:**

| Rank | Feature | Gain |
|------|---------|------|
| 1 | initial_risk_pts | 40.32 |
| 2 | mfe_pts_so_far | 20.51 |
| 3 | pnl_pts | 18.84 |
| 4 | distance_to_stop_pts | 17.26 |
| 5 | is_short | 16.13 |
| 6 | unrealized_r | 16.1 |
| 7 | tick_hour_utc | 15.06 |
| 8 | stop_current | 14.12 |
| 9 | quantity_remaining | 12.84 |
| 10 | entry_hour_utc | 12.35 |

### 2. Remaining-R Regressor (`sl_remaining_r`)

Regression: how much additional R will the trade capture?

| Metric | Value |
|--------|-------|
| rmse | 0.907 |
| mae | 0.7787 |
| r2 | -0.1594 |
| target_mean | -0.5376 |
| target_std | 0.8423 |
| pred_mean | -0.0895 |
| pred_std | 0.5464 |
| best_iteration | 15 |
| training_time | 0.09s |

**Top 10 Features by Gain:**

| Rank | Feature | Gain |
|------|---------|------|
| 1 | stop_current | 29.47 |
| 2 | initial_risk_pts | 23.04 |
| 3 | current_price | 21.64 |
| 4 | quantity_remaining | 12.64 |
| 5 | mae_pts_so_far | 11.88 |
| 6 | entry_hour_utc | 5.85 |
| 7 | mfe_pts_so_far | 3.05 |
| 8 | distance_to_stop_pts | 2.97 |
| 9 | unrealized_r | 2.49 |
| 10 | pnl_pts | 2.42 |

---

## Feature Schema

**Total features:** 45

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
| 44 | setup_type_enc | categorical_encoded |
| 45 | regime_at_entry_enc | categorical_encoded |

**Categorical Encoding Maps:**

- `setup_type`: {"breakdown_retest_short": 0, "breakout_retest_long": 1, "failed_or_break_long": 2, "failed_or_break_short": 3, "trend_pullback_long": 4, "trend_pullback_short": 5}
- `regime_at_entry`: {"range_bound": 0, "trending_down": 1, "trending_up": 2}

---

## Hyperparameters

**Classifier:**
```json
{
  "objective": "binary:logistic",
  "eval_metric": "logloss",
  "device": "cuda",
  "max_depth": 5,
  "learning_rate": 0.05,
  "subsample": 0.8,
  "colsample_bytree": 0.8,
  "min_child_weight": 3,
  "gamma": 0.1,
  "reg_alpha": 0.1,
  "reg_lambda": 1.0,
  "seed": 42,
  "verbosity": 1
}
```

**Regressor:**
```json
{
  "objective": "reg:squarederror",
  "eval_metric": "rmse",
  "device": "cuda",
  "max_depth": 5,
  "learning_rate": 0.05,
  "subsample": 0.8,
  "colsample_bytree": 0.8,
  "min_child_weight": 3,
  "gamma": 0.1,
  "reg_alpha": 0.1,
  "reg_lambda": 1.0,
  "seed": 42,
  "verbosity": 1
}
```

---

## Reproducibility

```bash
python scripts/ml/train_xgboost_management.py \
  --input data/management_dataset_labeled.csv \
  --device cuda \
  --seed 42
```