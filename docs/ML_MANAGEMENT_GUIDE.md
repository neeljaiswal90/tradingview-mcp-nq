# ML Management System — Operator Guide

## Architecture Overview

```
                    +-------------------+
                    |  TradingView MCP  |
                    |   (price feed)    |
                    +--------+----------+
                             |
                    +--------v----------+
                    |   Trading Engine   |
                    |   (runner.ts)      |
                    |                    |
                    | 1. Quote fetch     |
                    | 2. Rules mgmt     |
                    | 3. Hard stops     |
                    | 4. ML advisory    |--->  Python FastAPI (localhost:5001)
                    | 5. Dashboard push |      CatBoost classifier + regressor
                    +-------------------+
                             |
                    +--------v----------+
                    |    Dashboard       |
                    |  ML Management     |
                    |     Panel          |
                    +-------------------+
```

**Priority chain:** Hard stops > Rules engine > ML advisory. ML can never override hard stops or widen risk.

---

## Quick Start

### 1. Build the Dataset

```bash
# Requires: Python 3.8+ (stdlib only)
python scripts/ml/build_management_dataset.py

# Custom paths:
python scripts/ml/build_management_dataset.py --log-dir ./logs --out-dir ./data
```

**Input:** `logs/trades.jsonl` + `logs/trade_path.jsonl`
**Output:** `data/management_dataset.csv` + `data/management_dataset_schema.json`

### 2. Build Labels

```bash
python scripts/ml/label_management_dataset.py

# Custom forward windows:
python scripts/ml/label_management_dataset.py --window-sec 30,60,120
```

**Input:** `data/management_dataset.csv`
**Output:** `data/management_dataset_labeled.csv` + `data/management_labels_schema.json`

### 3. Train XGBoost (baseline)

```bash
# Requires: pip install xgboost scikit-learn numpy
python scripts/ml/train_xgboost_management.py --device auto

# CPU only:
python scripts/ml/train_xgboost_management.py --device cpu
```

**Output:** `models/xgboost/hold_classifier.ubj`, `remaining_r_regressor.ubj`, `training_meta.json`

### 4. Train CatBoost (challenger — current winner)

```bash
# Requires: pip install catboost scikit-learn numpy
python scripts/ml/train_catboost_management.py --device auto
```

**Output:** `models/catboost/hold_classifier.cbm`, `remaining_r_regressor.cbm`, `training_meta.json`

### 5. Run Walk-Forward Evaluation

```bash
# Requires: both xgboost and catboost installed
python scripts/ml/walkforward_train_eval.py --device auto
```

**Output:** `reports/ml/walkforward_summary_*.md` + `reports/ml/model_comparison_*.md`

### 6. Start the ML Inference Service

```bash
# Requires: pip install fastapi uvicorn catboost numpy pydantic
python python-ml-service/app.py

# Or with custom port:
ML_SERVICE_PORT=5002 python python-ml-service/app.py

# Verify:
curl http://127.0.0.1:5001/health
```

### 7. Start the Trading App with ML Enabled

```bash
# 1. Start ML service (separate terminal):
python python-ml-service/app.py

# 2. Start trading engine (main terminal):
npm run auto
```

The engine checks ML service health at startup and logs the result. If the service is unreachable, ML decisions are skipped (non-fatal).

---

## Configuration

### Enable ML Management

In `config/indicator-config.json`:

```json
"ml_management": {
  "enabled": true,
  "service_url": "http://127.0.0.1:5001",
  "timeout_ms": 3000,
  "model_type": "catboost",
  "model_version": "20260407_171140",
  "min_confidence_exit": 0.6,
  "min_confidence_partial": 0.55,
  "min_confidence_stop_move": 0.5,
  "max_quote_age_ms": 5000
}
```

### Disable ML (fall back to pure rules)

```json
"ml_management": {
  "enabled": false
}
```

Or simply remove the `ml_management` block entirely. The system defaults to `enabled: false`.

### Confidence Thresholds

| Action | Config Key | Default | Effect |
|--------|-----------|---------|--------|
| EXIT_ALL | `min_confidence_exit` | 0.6 | ML needs 60%+ confidence to trigger full exit |
| EXIT_PARTIAL | `min_confidence_partial` | 0.55 | ML needs 55%+ to trigger partial |
| MOVE_STOP / BE | `min_confidence_stop_move` | 0.5 | ML needs 50%+ to tighten stop |

Higher thresholds = more conservative (fewer ML actions). Lower = more aggressive.

---

## Safety Invariants

These cannot be overridden by the ML model:

| Gate | Rule | Rationale |
|------|------|-----------|
| Hard stops first | `positionManager.evaluate()` runs before ML | Hard stops/targets/PT1/PT2 always take priority |
| HOLD/NO_ACTION passive | Never trigger execution | ML cannot force a hold — it can only suggest exits |
| Stop never widens | Gate blocks any `MOVE_STOP` that increases risk | ML cannot increase exposure |
| Stale quotes block | Non-EXIT_ALL actions blocked on stale quotes | Prevents acting on outdated prices |
| EXIT_ALL exempt | EXIT_ALL always allowed even on stale quotes | Risk reduction is always permitted |
| ML failures non-fatal | Caught and logged, trading continues | ML service downtime does not break the engine |
| No position = no action | ML only runs when position is open | Prevents phantom actions |

---

## Logs and Observability

### Log File: `logs/ml_management_actions.jsonl`

Every ML decision writes one structured JSON line:

```json
{
  "timestamp": "2026-04-08T14:30:00Z",
  "trade_id": "TRADE_..._0042",
  "action": "EXIT_ALL",
  "action_confidence": 0.72,
  "model_name": "catboost_management",
  "model_version": "20260407_171140",
  "prob_hold": 0.28,
  "ev_hold_r": -0.15,
  "approved": true,
  "rejection_reason": null,
  "inference_ms": 1.5,
  "quote_age_ms": 450,
  "side": "long",
  "setup_type": "trend_pullback_long",
  "quantity_remaining": 3,
  "unrealized_r": 0.24
}
```

### Dashboard Panel

The ML Management panel in the dashboard shows:
- Active model name and version
- Latest action and confidence
- Gate result (APPROVED / REJECTED + reason)
- P(hold) and EV(hold R)
- Inference latency
- Session decision counts (total / approved)

### Trade Path Enrichment

Each tick in `logs/trade_path.jsonl` includes ML fields:
- `ml_action`, `ml_confidence`, `ml_prob_hold`, `ml_ev_hold_r`
- `ml_approved`, `ml_model`, `ml_inference_ms`

---

## Model Retraining

When enough new trades accumulate (50+ recommended):

```bash
# 1. Rebuild dataset from updated logs
python scripts/ml/build_management_dataset.py

# 2. Rebuild labels
python scripts/ml/label_management_dataset.py

# 3. Retrain both models
python scripts/ml/train_xgboost_management.py --device auto
python scripts/ml/train_catboost_management.py --device auto

# 4. Run walk-forward to compare
python scripts/ml/walkforward_train_eval.py --device auto

# 5. Restart ML service to pick up new models
# (stop and restart python-ml-service/app.py)
```

---

## File Map

```
scripts/ml/
  build_management_dataset.py     # Step 1: dataset from logs
  label_management_dataset.py     # Step 2: supervised labels
  train_xgboost_management.py     # Step 3a: XGBoost training
  train_catboost_management.py    # Step 3b: CatBoost training
  walkforward_train_eval.py       # Step 4: walk-forward comparison

python-ml-service/
  app.py                          # FastAPI inference service
  schemas.py                      # Pydantic request/response models
  loaders.py                      # Model loading + feature vector
  requirements.txt                # Python dependencies

src/autotrade/ml/
  types.ts                        # Config, request/response, gate types
  feature-builder.ts              # Build features from live Position
  execution-gate.ts               # 8-check hard safety gate
  decision-engine.ts              # HTTP client + gate orchestration
  index.ts                        # Public API

models/
  xgboost/                        # XGBoost artifacts
  catboost/                       # CatBoost artifacts (production)

data/
  management_dataset.csv          # Raw decision-point dataset
  management_dataset_labeled.csv  # Dataset with supervised labels
  management_dataset_schema.json  # Feature schema
  management_labels_schema.json   # Label definitions

reports/ml/
  xgboost_training_*.md           # Training reports
  catboost_training_*.md
  walkforward_summary_*.md        # Walk-forward results
  model_comparison_*.md           # Head-to-head comparison
  management_label_definitions_*.md
```

---

## Remaining Limitations

1. **Small training set** — 42 trades / 1,256 rows. Models need 200+ trades for production confidence.
2. **3-day walk-forward** — Only 2 folds possible. Need 2+ weeks for meaningful evaluation.
3. **EXIT_PARTIAL not implemented in runner** — ML can suggest it, gate validates it, but runner execution path is stubbed.
4. **No online learning** — Models are static until retrained. No incremental updates.
5. **Single inference service** — No redundancy. If the Python service crashes, ML silently degrades to rules-only.
6. **CatBoost regressor R2 is negative** — The remaining-R prediction is worse than a constant mean. Classifier is the only actionable model.
7. **No A/B framework** — No automated comparison between ML-on and ML-off performance. Must be done manually from logs.
