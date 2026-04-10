# Model Comparison: XGBoost vs CatBoost

**Generated:** 20260407_171606
**Method:** Walk-forward (expanding window, date splits)
**Folds:** 2

---

## Production Recommendation

| Task | XGBoost | CatBoost | Walk-Forward Winner |
|------|---------|----------|---------------------|
| Classifier (AUC) | 0.3558 | 0.656 | **CatBoost** |
| Regressor (R2) | -7.6618 | -0.2942 | **CatBoost** |

**Overall walk-forward winner: CatBoost**

## Calibration Assessment

| Model | Mean Predicted P(hold) | Actual Hold Rate | Brier Score |
|-------|------------------------|------------------|-------------|
| XGBoost | 0.5918 | 0.3312 | 0.3674 |
| CatBoost | 0.5399 | 0.3312 | 0.252 |

*Brier score: lower is better. Perfect calibration = pred_mean matches actual rate.*

---

## Action-Policy Simulation

Simple threshold policy: EXIT when model P(hold) <= 0.5, otherwise HOLD.

### XGBoost

- Trades evaluated: 13
- Model triggered early exit: 6/13 (46.2%)
- Actual avg R: 0.2569
- Policy avg R: 0.2331
- Avg improvement: -0.0238R per trade
- Policy underperforms actual management

### CatBoost

- Trades evaluated: 13
- Model triggered early exit: 13/13 (100.0%)
- Actual avg R: 0.2569
- Policy avg R: 0.2408
- Avg improvement: -0.0162R per trade
- Policy underperforms actual management

---

## Data Limitations

- **38 trades across 3 days** is far below the minimum needed for statistical confidence
- Walk-forward folds have 12-25 train trades and 13 validation trades
- Results should be treated as directional indicators, not definitive rankings
- Both models need 200+ trades across diverse market conditions to be production-trusted
- The walk-forward winner is the better *candidate*, not a proven production model