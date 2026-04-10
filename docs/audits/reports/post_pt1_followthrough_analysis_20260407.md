# Post-PT1 Follow-Through Analysis

**Generated:** 2026-04-07T06:58:25.492Z
**Trades analyzed:** 12 (with PT1 partial exits)
**Data source:** ./logs/trades.jsonl + trade_path.jsonl

## Key Question

> After PT1 fires, is there usually enough additional movement left to justify a wider trail?

## Aggregate Statistics

| Metric | Mean | Median |
|--------|------|--------|
| MFE at PT1 (pts) | 0 | 0 |
| MFE after PT1 (pts) | 0 | 0 |
| Runner capture ratio | 0 | 0 |
| Giveback R | 0.09 | 0.07 |
| Peak R before PT1 | 0 | 0 |

## Noise Exits

- **100%** of runner exits were within 1x ATR of PT1 trigger price (noise-level)
- **0%** would have benefited from wider trail (0.45x ATR)
- **0%** would have benefited from even wider trail (0.6x ATR)

## By Management Profile

| Profile | Trades | Noise Exit % | MFE After PT1 (median) | Runner Capture | Avg R | Wider Trail Helps |
|---------|--------|--------------|------------------------|----------------|-------|-------------------|
| trend_pullback | 9 | 100% | 0 pts | 0 | 0.14 | 0% |
| breakout_retest | 3 | 100% | 0 pts | 0 | 0.13 | 0% |

## Per-Trade Detail

| Trade ID | Side | Profile | MFE@PT1 | MFE After | Runner Capture | Noise? | R | Giveback R |
|----------|------|---------|---------|-----------|----------------|--------|---|------------|
| ...3_aeae8890_0024 | short | trend_pullback | 0 | 0 | 0 | YES | 0.07 | 0.04 |
| ...3_aeae8890_0025 | short | trend_pullback | 0 | 0 | 0 | YES | 0.14 | 0.16 |
| ...6_fe52016a_0353 | short | trend_pullback | 0 | 0 | 0 | YES | 0.15 | 0.12 |
| ...6_fe52016a_0354 | short | trend_pullback | 0 | 0 | 0 | YES | 0.27 | 0.16 |
| ...6_fe52016a_0531 | short | trend_pullback | 0 | 0 | 0 | YES | 0.06 | 0.04 |
| ...6_fe52016a_0533 | short | trend_pullback | 0 | 0 | 0 | YES | 0.07 | 0.04 |
| ...6_fe52016a_0538 | short | trend_pullback | 0 | 0 | 0 | YES | 0.06 | 0.07 |
| ...6_fe52016a_0542 | short | trend_pullback | 0 | 0 | 0 | YES | 0.25 | 0.05 |
| ...6_fe52016a_0831 | long | trend_pullback | 0 | 0 | 0 | YES | 0.15 | 0.1 |
| ...6_fe52016a_1168 | long | breakout_retest | 0 | 0 | 0 | YES | 0.15 | 0.06 |
| ...6_fe52016a_1169 | long | breakout_retest | 0 | 0 | 0 | YES | 0.08 | 0.06 |
| ...6_fe52016a_1170 | long | breakout_retest | 0 | 0 | 0 | YES | 0.15 | 0.12 |

## Diagnostic Interpretation

**Finding: Entries lack follow-through.** Median MFE after PT1 is only 0 pts. The market does not continue in the trade direction after PT1. Widening trail would NOT help. Focus on entry quality and strategy filters instead.

## Unresolved Questions

- Is the MFE after PT1 an artifact of brief spikes, or does it represent sustained movement?
- Would delayed PT1 (larger pt1_offset_atr) also improve outcomes?
- Are certain setup types better follow-through candidates than others?
- With 16 trades, all conclusions have wide confidence intervals.