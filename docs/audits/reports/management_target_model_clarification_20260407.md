# Management Target Model Clarification

**Date:** 2026-04-07
**Context:** Post-update forensic audit found "zero target hits" on 16 post-profile trades. This note clarifies why that finding is expected behavior, not a failure signal.

---

## Two Distinct Exit Concepts

The system contains **two independent exit concepts** that share similar naming but operate differently:

### 1. Structural Targets: `target_1`, `target_2`, `target_3`

- **Source**: Strategy signal generation (`strategy.ts` setup generators)
- **What they are**: Absolute PRICE LEVELS derived from market structure (CHoCH/BOS, pivots, swing levels)
- **Typical distance**: 40-80 pts from entry for NQ
- **Set when**: Position is opened, copied from `CandidateSetup`
- **Exit behavior**: `target_1` hit triggers 50% partial + BE move + arm trailing. `target_2`/`target_3` hit triggers full exit.
- **Code location**: `position-manager.ts` evaluate() lines 310-327 (target_1), lines 235-254 (target_2/3)

### 2. Profile Partials: PT1, PT2

- **Source**: Management profiles in `indicator-config.json`, resolved via `management-profiles.ts`
- **What they are**: ATR-relative OFFSETS from entry price (e.g., 0.5 x ATR = 5 pts when ATR=10)
- **Typical distance**: 3-8 pts from entry for NQ
- **Set when**: Profile resolved at entry via `resolveProfile()`
- **Exit behavior**: PT1 fires partial + optionally moves stop to BE + optionally arms trailing. PT2 fires another partial.
- **Code location**: `position-manager.ts` evaluate() lines 257-287 (PT1), lines 290-308 (PT2)

---

## Evaluation Order in evaluate()

```
1. Stop loss check               (line 226)
2. Target 2 / Target 3 check     (line 235)  ← full exit at structural level
3. PT1 fixed-offset partial       (line 257)  ← fires at ~5 pts
4. PT2 fixed-offset partial       (line 290)  ← fires at ~12 pts
5. Target 1 partial               (line 310)  ← fires at ~40-80 pts
6. Time stop                      (line 329)
```

PT1 is checked BEFORE target_1. At current ATR levels (5-12 pts), PT1 fires at 3-6 pts from entry. target_1 is 40-80 pts away. PT1 always fires first.

---

## Why "Zero Target Hits" Is Expected

When PT1 fires:
1. It takes a partial exit (50% of position)
2. It moves the stop to breakeven
3. It arms a trailing stop at 0.3 x ATR = ~3 pts distance

The trailing stop then follows the runner. A 3-point NQ pullback is normal noise. The runner is stopped out within seconds to minutes.

For target_1 to be reached, the price would need to continue 35-75 MORE points in the same direction — without ever pulling back 3 points. This is unrealistic for NQ intraday.

**Conclusion**: "Zero target_1 hits" does not mean the strategy targets are wrong. It means the management profile (PT1 + tight trail) takes over the exit path before structural targets become relevant.

---

## Implications for Analysis

- **`exit_reason: 'stop_loss'` on a winner** is expected: it means the trailing stop captured profit, not the initial stop
- **`hit_target_1: false` on all trades** does not indicate strategy failure — PT1 preempts target_1 by design
- **`exit_reason_detailed: 'stop_loss_trailing'`** is the most common winner exit and is normal behavior

The real question is not "why don't we hit targets?" but rather:
1. Is PT1 firing too early (capturing too little of the move)?
2. Is the trail distance too tight (killing the runner before additional opportunity is captured)?
3. Or do entries simply not generate enough follow-through beyond PT1?

These questions require the new instrumentation (mfe_at_pt1, mfe_after_pt1, runner_capture_ratio) to answer with data.

---

## Field Reference

| Field | Source | Meaning |
|-------|--------|---------|
| `target_1` | Strategy setup | Structural price level (far) |
| `target_2` | Strategy setup | Structural price level (farther) |
| `pt1_offset_pts` | Management profile | ATR-offset from entry (near) |
| `pt2_offset_pts` | Management profile | ATR-offset from entry (medium) |
| `hit_target_1` | TradeRecord | Did price reach structural target_1? |
| `pnl_pt1` | TradeRecord | PnL from PT1 partial exit |
| `exit_reason` | TradeRecord | What caused the final exit |
| `exit_reason_detailed` | TradeRecord | Distinguishes initial/breakeven/trailing stop |
