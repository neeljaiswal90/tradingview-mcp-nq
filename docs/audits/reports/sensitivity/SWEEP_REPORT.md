# Sensitivity Sweep Report — NQ Entry Filter
**Date:** 2026-04-05
**Experiments:** 9 configs x full historical replay (NQ1! 1m/5m/15m/60m)
**Codebase:** Post-OR-fix, post-P3 exit labeling, max_confidence gate active

---

## Full Results Table

| Label | Overrides | Trades | WR% | E[R] | PF | PnL($) | MaxDD($) | StopInit% | StopTrail% |
|-------|-----------|--------|-----|------|----|--------|----------|-----------|------------|
| **baseline** | (none) | 53 | 41.5 | +0.125 | 1.13 | +3,100 | 4,725 | 56.6 | 43.4 |
| rr_1.85 | min_rr=1.85 | 53 | 37.7 | -0.024 | 1.04 | +900 | 6,530 | 62.3 | 37.7 |
| rr_1.75 | min_rr=1.75 | 53 | 37.7 | -0.024 | 1.04 | +900 | 6,530 | 62.3 | 37.7 |
| conf_7.2 | min_conf=7.2 | 55 | 40.0 | +0.084 | 1.04 | +975 | 4,725 | 58.2 | 41.8 |
| conf_6.8 | min_conf=6.8 | 64 | 39.1 | +0.004 | 0.92 | -2,595 | 7,480 | 60.9 | 39.1 |
| **maxconf_disabled** | max_conf=10.0 | **102** | **43.1** | **+0.170** | **1.22** | **+10,080** | 8,530 | 54.9 | 45.1 |
| maxconf_8.9 | max_conf=8.9 | 86 | 43.0 | +0.128 | 1.19 | +7,335 | 6,720 | 55.8 | 44.2 |
| combined_rr1.85_conf7.2 | rr+conf | 146 | 36.3 | -0.068 | 0.91 | -6,365 | 11,945 | 63.7 | 36.3 |
| combined_rr1.75_conf6.8_mc8.9 | rr+conf+maxconf | 152 | 35.5 | -0.053 | 0.82 | -15,550 | 18,550 | 64.5 | 35.5 |

---

## Key Findings

### 1. The max_confidence ceiling at 9.0 is HURTING performance

The autoresearch identified 9.0+ confidence signals as the worst-performing bucket (29% WR, -0.28R). This led to adding a `max_confidence=9.0` gate. However, post-OR-fix replay data tells a different story:

- **Removing the ceiling** (`maxconf_disabled`) is the **best overall config**: +$10,080 PnL, 43.1% WR, E[R]=+0.17, PF=1.22
- The 9.0+ bucket IS still bad individually (33.3% WR, E[R]=-0.165, -$1,350 for 12 trades)
- But the ceiling creates a **cascading position-occupancy blockage**: blocking 12 direct trades also prevents ~37 subsequent profitable trades from executing (the system stays flat when it could be in a winner)

**Confidence bucket detail (maxconf_disabled):**
| Bucket | Trades | WR% | E[R] | PnL |
|--------|--------|-----|------|-----|
| 7.5-8.0 | 24 | 41.7% | +0.156 | +$1,150 |
| 8.0-8.5 | 24 | 41.7% | +0.119 | +$2,950 |
| 8.5-9.0 | 42 | 47.6% | +0.302 | +$7,330 |
| 9.0+ | 12 | 33.3% | -0.165 | -$1,350 |

The 8.5-9.0 bucket is the **single best performer** — it generates 72% of all PnL. The max_confidence gate at 9.0 was leaving money on the table in this bucket by cascading blockage effects.

### 2. Lowering min_rr DEGRADES performance

- rr_1.85 and rr_1.75 both produce identical results (53 trades, -0.024 E[R]) — worse than baseline
- The RR cliff-edge at 2.0 identified in autoresearch does cause 580 rejections, but the signals that would pass at lower RR thresholds are **low-quality entries** that drag down expectancy
- The rr floor at 2.0 is correctly filtering garbage — do NOT relax it

### 3. Lowering min_confidence DEGRADES performance monotonically

- conf_7.2: +2 trades, WR drops to 40%, E[R] drops to +0.084
- conf_6.8: +11 trades, WR drops to 39.1%, E[R] collapses to +0.004, PnL goes negative
- The confidence floor at 7.5 is well-calibrated — do NOT relax it

### 4. Combined relaxations are CATASTROPHIC

- Relaxing multiple thresholds simultaneously produces the worst results
- combined_rr1.85_conf7.2: 146 trades but E[R]=-0.068, PnL=-$6,365, MaxDD=$11,945
- combined_rr1.75_conf6.8_maxconf8.9: 152 trades, E[R]=-0.053, PnL=-$15,550, MaxDD=$18,550
- This confirms the current thresholds are NOT overly conservative — they're correctly gating low-quality signals

### 5. Exit analysis: initial stops dominate losses

Across all configs, the exit pattern is binary:
- **stop_loss_initial** (pre-T1): 0% win rate, avg -1.008R — pure losers
- **stop_loss_trailing** (post-T1): 95-97% win rate, avg +1.6R — near-guaranteed winners
- **No breakeven stops** were observed in any experiment (0 count across 9 configs)
- The initial stop rate ranges from 54.9% (maxconf_disabled) to 64.5% (worst combined config)
- Reducing the initial stop rate from 55% to 45% would be worth ~$5,000+ in PnL

---

## Promotion Decision

### REJECT all threshold relaxations:
- min_rr: keep at 2.0 (both 1.85 and 1.75 degrade E[R] and MaxDD)
- min_confidence: keep at 7.5 (both 7.2 and 6.8 degrade monotonically)

### PROMOTE max_confidence change:
**Option A (aggressive):** Set max_confidence=10.0 (effectively disabled)
- +$6,980 PnL vs baseline, +0.045 E[R], +0.09 PF
- BUT MaxDD increases $4,725 -> $8,530 (+80%)

**Option B (conservative, RECOMMENDED):** Set max_confidence=8.9
- +$4,235 PnL vs baseline, +0.003 E[R], +0.06 PF
- MaxDD increases $4,725 -> $6,720 (+42%) — more tolerable

**Recommendation: Promote Option B (max_confidence=8.9)** — captures most of the PnL upside while keeping MaxDD below $7,000.

---

## Next Optimization Target: runner_management

**Rationale:**

1. **Entry filter is well-calibrated.** min_rr=2.0 and min_confidence=7.5 are optimal. Only max_confidence needed adjustment (from 9.0 to 8.9).

2. **The biggest lever is exit management, not entry selection.** The 55-65% initial stop rate across all configs means the majority of trades hit their initial stop before reaching T1. Improving trade management could convert some of these initial stops into partial wins.

3. **Specific runner_management parameters to sweep next:**
   - `trail_ticks_post_t1`: currently 12. Test 8, 10, 14, 16 — tighter trails capture more profit on winning trades
   - `time_stop_minutes`: currently 30. Test 20, 25, 35, 45 — shorter time stops cut losers faster
   - `time_stop_max_r_pre_t1`: currently 0.25. Test 0.15, 0.20, 0.35 — lower threshold exits pre-T1 losers sooner

4. **Expected impact:** Converting even 5% of initial stops to trailing stops would shift ~3 trades from -1.0R to +1.6R each = +7.8R = ~$4,000+ PnL improvement.

---

## Artifacts

- `reports/sensitivity/sweep_comparison.json` — full machine-readable comparison
- `reports/sensitivity/sweep_summary.csv` — headline metrics CSV
- `reports/sensitivity/<label>/` — per-experiment metrics, binned results
- `reports/sensitivity/sweep_manifest.json` — experiment configuration audit trail
