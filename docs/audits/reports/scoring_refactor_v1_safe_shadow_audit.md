# Layered Scoring V1 — Shadow Audit Report

**Date**: _TBD (run after collecting shadow data)_
**Config**: `layered_scoring.enabled = false`, `shadow_log = true`
**Data source**: Runner logs containing `[LAYERED_SHADOW]` lines

## Summary

_Fill after running `python scripts/analysis/layered_score_shadow_audit.py <log_path>`_

| Metric | Value |
|--------|-------|
| Total shadow records | |
| Spearman rank correlation (old vs new) | |
| Missing flow rate (overall) | |
| Trend cluster capped count | |
| Old accepted (>=7.5) | |
| New accepted at old threshold | |
| Delta (new - old accepted) | |

## Score Distributions

### All Candidates

| Percentile | Old Score | New Rank | Delta |
|------------|-----------|----------|-------|
| Min | | | |
| P10 | | | |
| P25 | | | |
| P50 (median) | | | |
| P75 | | | |
| P90 | | | |
| Max | | | |
| Mean | | | |

### Hard-Valid Only

_Repeat above for candidates that passed hard validity under both systems._

## Per-Setup-Family Analysis

| Family | Count | Missing Flow Rate | Old Median | New Median | Delta |
|--------|-------|-------------------|------------|------------|-------|
| trend_continuation | | | | | |
| breakout_continuation | | | | | |
| reversal_reclaim | | | | | |
| session_structure | | | | | |

## Flow Feature Coverage

| Feature | Coverage Rate | Notes |
|---------|---------------|-------|
| directional_flow | | |
| book_imbalance | | |
| queue_pressure | | |
| microprice | | |
| volume_profile | | |

## Threshold Calibration

| Zone | Count |
|------|-------|
| New rank 6.5-7.5 (near old threshold) | |
| New rank 7.5-8.5 (above old threshold) | |

**Recommended new thresholds**: _TBD based on distribution shift_

## Key Behavioral Changes

### Cases where lagging previously dominated
_Count and examples where |lagging| >= 0.5 and |new_rank - old_score| > 0.5_

### Cases where flow materially re-ranked
_Examples where strong flow moved rank up/down by >0.5 among valid candidates_

### Trend cluster capping effect
_Count of cases where correlated trend factors were capped_

## Decision

- [ ] Rank correlation > 0.7 (old and new broadly agree on ordering)
- [ ] No unexpected rejection zone shifts
- [ ] Missing flow rate acceptable per family
- [ ] Flow feature coverage adequate for default-on features
- [ ] Threshold calibration suggestions reviewed

**Ready to enable**: _Yes / No / Needs more data_
