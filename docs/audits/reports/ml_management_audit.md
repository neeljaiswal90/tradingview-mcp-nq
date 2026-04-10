# ML Management Audit Report

**Generated:** 2026-04-08T18:30:35+00:00
**Period:** 2026-04-07T18:31:51 to 2026-04-08T18:05:20
**Total action records:** 13015
**Feature payload records:** 0
**Trade records:** 129

## 1. Action Distribution

| Action | Count | % | Avg Confidence |
|--------|-------|---|----------------|
| NO_ACTION | 13008 | 99.9% | 0.262 |
| EXIT_ALL | 7 | 0.1% | 0.649 |

## 2. Approval Rate

| Status | Count | % |
|--------|-------|---|
| Approved | 7 | 0.1% |
| Blocked | 13008 | 99.9% |

### Top Rejection Reasons

| Reason | Count |
|--------|-------|
| NO_ACTION is passive | 5745 |
| ML service call failed: fetch failed | 1661 |
| ML service returned 500: {"detail":"Inference error: Invalid type for cat_featur | 1122 |
| HOLD is passive | 1102 |
| ML service returned 500: {"detail":"Inference error: Invalid type for cat_featur | 788 |
| ML service returned 500: {"detail":"Inference error: Invalid type for cat_featur | 740 |
| ML service returned 500: {"detail":"Inference error: Invalid type for cat_featur | 371 |
| EXIT_PARTIAL blocked by enable_partial_exit=false | 340 |
| ML service returned 500: {"detail":"Inference error: Invalid type for cat_featur | 226 |
| ML service returned 500: {"detail":"Inference error: Invalid type for cat_featur | 167 |

## 3. Model Versions Used

| Version | Count | % |
|---------|-------|---|
| 20260407_171140 | 13015 | 100.0% |

## 4. Feature Coverage

*No runtime feature logs available (ml_management_features_*.jsonl not found).*

## 5. Tier Usage

| Tier | Count | % |
|------|-------|---|
| none | 13015 | 100.0% |

## 6. Splits by Trade Stage

| Stage | Actions | Avg Confidence | Approval Rate |
|-------|---------|----------------|---------------|
| error | 5811 | 0.0 | 0.0% |
| post_breakeven | 393 | 0.587 | 0.5% |
| pre_pt1 | 6811 | 0.468 | 0.1% |

## 7. Splits by Setup Family

| Setup | Actions | Dominant Tier | Approval Rate |
|-------|---------|---------------|---------------|
| trend_pullback_long | 8578 | none | 0.0% |
| trend_pullback_short | 3631 | none | 0.2% |
| failed_or_break_long | 404 | none | 0.2% |
| breakout_retest_long | 402 | none | 0.0% |

## 8. Realized Outcomes

| Category | Trades | Avg Final R | Win Rate |
|----------|--------|-------------|----------|
| All trades with ML | 65 | -0.011 | 80.0% |
| Had approved exit suggestion | 7 | 0.087 | 85.7% |
| All actions passive/hold | 58 | -0.023 | 79.3% |

## 9. Error Analysis

**Service errors:** 5811 (44.6%)

| Error Type | Count |
|-----------|-------|
| ML service returned 500: {"detail":"Inference error: Invalid | 4066 |
| ML service call failed: fetch failed | 1661 |
| ML service returned 404: {"detail":"Not Found"} | 82 |
| ML service returned 500: {"detail":"Inference error: must be | 2 |

## 10. Inference Latency

| Metric | Value |
|--------|-------|
| p50 | 1.2ms |
| p95 | 3.0ms |
| p99 | 3.0ms |
| max | 104ms |
| mean | 1.5ms |

## 11. Summary Classification

- **Service healthy + passive (HOLD/NO_ACTION):** 7197 (55.3%)
- **Service errors:** 5811 (44.6%)
- **Model suggested action, gate blocked:** 0 (0.0%)
- **Model suggested action, gate approved:** 7 (0.1%)

## 12. Model Artifacts

### flat
- Generated: 20260408_022433
- Features: 45
- Schema: v3_advanced_mbo
- Rows: 1256
- Trades: 38
- Classifier AUC: 0.8006
- Regressor R2: 0.1002
