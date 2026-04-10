# XGBoost Management Model Training Report

**Generated:** 20260407_170713
**Device:** cuda
**Dataset:** 1256 valid rows

---

## Models Trained

### 1. Hold Classifier (`sl_hold_is_better`)

Binary classification: should the trade be held (1) or exited (0)?

| Metric | Value |
|--------|-------|
| accuracy | 0.4828 |
| precision | 0.1648 |
| recall | 0.1685 |
| f1 | 0.1667 |
| roc_auc | 0.2898 |
| log_loss | 1.0258 |
| best_iteration | 0 |
| training_time | 0.09s |
| train_samples | 966 |
| test_samples | 290 |
| class_balance (train) | 1:274 / 0:692 |

**Confusion Matrix (test):**

| | Pred 0 | Pred 1 |
|---|--------|--------|
| Actual 0 | 125 | 76 |
| Actual 1 | 74 | 15 |

**Top 10 Features by Gain:**

| Rank | Feature | Gain |
|------|---------|------|
| 1 | initial_risk_pts | 37.12 |
| 2 | mfe_pts_so_far | 22.39 |
| 3 | quantity_remaining | 17.45 |
| 4 | unrealized_r | 15.71 |
| 5 | distance_to_stop_pts | 15.63 |
| 6 | current_price | 15.57 |
| 7 | pnl_pts | 15.02 |
| 8 | entry_hour_utc | 11.65 |
| 9 | mae_pts_so_far | 10.75 |
| 10 | is_short | 10.52 |

### 2. Remaining-R Regressor (`sl_remaining_r`)

Regression: how much additional R will the trade capture?

| Metric | Value |
|--------|-------|
| rmse | 0.9212 |
| mae | 0.8 |
| r2 | -0.1961 |
| target_mean | -0.5376 |
| target_std | 0.8423 |
| pred_mean | -0.077 |
| pred_std | 0.5652 |
| best_iteration | 9 |
| training_time | 0.09s |

**Top 10 Features by Gain:**

| Rank | Feature | Gain |
|------|---------|------|
| 1 | current_price | 25.33 |
| 2 | initial_risk_pts | 21.84 |
| 3 | quantity_remaining | 18.74 |
| 4 | mae_pts_so_far | 13.39 |
| 5 | stop_current | 10.52 |
| 6 | entry_hour_utc | 5.85 |
| 7 | pnl_pts | 3.08 |
| 8 | distance_to_stop_pts | 3.07 |
| 9 | unrealized_r | 2.76 |
| 10 | confidence_at_entry | 2.43 |

---

## Feature Schema

**Total features:** 22

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
| 21 | setup_type_enc | categorical_encoded |
| 22 | regime_at_entry_enc | categorical_encoded |

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