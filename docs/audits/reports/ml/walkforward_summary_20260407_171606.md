# Walk-Forward Evaluation Summary

**Generated:** 20260407_171606
**Folds:** 2
**Method:** Expanding window, date-boundary splits, no shuffle

---

## Fold Construction

| Fold | Train Dates | Train Trades | Train Rows | Val Dates | Val Trades | Val Rows |
|------|-------------|-------------|------------|-----------|------------|----------|
| 1 | 2026-04-05 | 12 | 637 | 2026-04-06 | 13 | 538 |
| 2 | 2026-04-05, 2026-04-06 | 25 | 1175 | 2026-04-07 | 13 | 81 |

## Fold-by-Fold Results

### Classifier (`sl_hold_is_better`)

| Fold | Model | N | Accuracy | AUC | F1 | Brier | Log Loss |
|------|-------|---|----------|-----|----|----- -|----------|
| 1 | xgb | 538 | 0.3067 | 0.3516 | 0.4089 | 0.3951 | 1.0145 |
| 1 | catboost | 538 | 0.5372 | 0.647 | 0.5685 | 0.2676 | 0.7298 |
| 2 | xgb | 81 | 0.7284 | 0.3838 | 0.0 | 0.1836 | 0.5514 |
| 2 | catboost | 81 | 0.8272 | 0.7159 | 0.0 | 0.1483 | 0.4751 |

### Regressor (`sl_remaining_r`)

| Fold | Model | N | RMSE | MAE | R2 |
|------|-------|---|------|-----|----|
| 1 | xgb | 538 | 1.3055 | 1.1429 | -7.294 |
| 1 | catboost | 538 | 0.4732 | 0.3861 | -0.0896 |
| 2 | xgb | 81 | 0.472 | 0.3512 | -10.1046 |
| 2 | catboost | 81 | 0.2307 | 0.2038 | -1.6533 |

---

## Aggregate Metrics (weighted by fold size)

### Classifier

| Metric | XGBoost | CatBoost | Winner |
|--------|---------|----------|--------|
| accuracy | 0.3619 | 0.5751 | CatBoost |
| brier | 0.3674 | 0.252 | CatBoost |
| class_1_rate | 0.3312 | 0.3312 | -- |
| f1 | 0.3554 | 0.4941 | CatBoost |
| log_loss | 0.9539 | 0.6965 | CatBoost |
| precision | 0.2548 | 0.3693 | CatBoost |
| pred_mean | 0.5918 | 0.5399 | -- |
| recall | 0.587 | 0.7462 | CatBoost |
| roc_auc | 0.3558 | 0.656 | CatBoost |

### Regressor

| Metric | XGBoost | CatBoost | Winner |
|--------|---------|----------|--------|
| mae | 1.0393 | 0.3622 | CatBoost |
| pred_mean | 0.6887 | -0.2985 | -- |
| r2 | -7.6618 | -0.2942 | CatBoost |
| rmse | 1.1964 | 0.4415 | CatBoost |
| target_mean | -0.1775 | -0.1775 | -- |
