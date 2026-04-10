# Post-Update Forensic Code Audit

**Date:** 2026-04-07
**Analyst:** Automated forensic audit (code-backed, evidence-based)
**Repo:** tradingview-mcp-nq
**Instrument:** MNQ (Micro E-mini Nasdaq-100)

---

## 1. Scope and Window Analyzed

### Post-Update Window (PRIMARY)
- **Config:** IC_v1.1_BASELINE_NQ with management profiles active
- **Period:** 2026-04-07 00:02 – 04:48 UTC
- **Trades:** 16
- **Identifier:** `management_profile` field populated (not null), `atr_at_entry` present
- **Profiles observed:** `trend_pullback` (12 trades), `breakout_retest` (4 trades)

### Pre-Profile IC_v1.1 Window (CONTROL)
- **Config:** IC_v1.1_BASELINE_NQ without profile resolution
- **Period:** 2026-04-06 14:20 – 20:37 UTC
- **Trades:** 6
- **Identifier:** `management_profile` is null/absent

### Pre-Update NQ Baseline
- **Config:** IC_v1.0_BASELINE_NQ
- **Period:** 2026-04-06 01:27 – 12:49 UTC
- **Trades:** 7

### Legacy BTC (excluded from comparison)
- **Config:** IC_v1.0_BASELINE
- **Trades:** 14 on BTCUSD — different instrument, not comparable

---

## 2. Executive Verdict

**Did the update improve the app?** MIXED

The management profile system is **mechanically functional** — profiles resolve correctly, ATR-relative PT1/PT2 offsets fire, partial exits are recorded with proper exit legs, and trade records include the new `management_profile` and `atr_at_entry` fields.

However, the **net effect on P&L is still negative**. The profile system transformed the exit behavior from "occasional large winners + large losers" to "many tiny winners + fewer large losers." Win rate jumped from 0% (pre-profile v1.1) to 75%, but average winner R collapsed from the prior baseline's +0.43R to +0.13R. Losers remain at -0.83R. The math does not work: you need 6.3 winners per loser at these ratios, and a 75% win rate only delivers 3 winners per loser.

**Root cause:** PT1 offset (0.5x ATR = 3-6 NQ points) and post-PT1 trail (0.3x ATR = 2-4 NQ points) are both too tight. PT1 scalps a tiny profit, then the trailing stop chokes the runner before it can reach meaningful targets.

---

## 3. Post-Update Metrics

### IC_v1.1_BASELINE_NQ — Profiles Active (16 trades)

| Metric | Value |
|--------|-------|
| Trades | 16 |
| Wins / Losses | 12 / 4 |
| Win Rate | 75.0% |
| Total PnL | -$705.00 |
| Total R | -1.73 |
| Avg R | -0.108 |
| Avg Winner R | +0.133 |
| Avg Loser R | -0.833 |
| Profit Factor | 0.48 |
| Expectancy | -0.108R |
| Avg Hold Time | 359s (6.0 min) |
| Avg MFE | 7.6 pts |
| Avg MAE | 10.6 pts |
| Avg Exit Legs | 1.9 |

### Exit Reason Distribution
| Exit Reason | Count | % |
|-------------|-------|---|
| stop_loss | 15 | 93.8% |
| time_stop | 1 | 6.2% |
| target_1 | 0 | 0% |
| target_2 | 0 | 0% |

**Critical observation:** Every single trade — including all 12 "winners" — exits via stop_loss. Zero target hits. The management system takes partials, then the trailing stop exits the runner. No trade ever reaches T1 or T2.

### Setup Type Distribution
| Setup | Count | Wins | Avg R |
|-------|-------|------|-------|
| trend_pullback_short | 9 | 8 | +0.05 |
| trend_pullback_long | 3 | 1 | -0.63 |
| breakout_retest_long | 4 | 3 | +0.08 |

### Side Distribution
| Side | Count | Wins | Avg R |
|------|-------|------|-------|
| Short | 9 | 8 | +0.01 |
| Long | 7 | 4 | -0.26 |

---

## 4. Before vs After Comparison

| Metric | Pre-Update NQ (v1.0, 7 trades) | Pre-Profile v1.1 (6 trades) | Post-Profile v1.1 (16 trades) | Direction |
|--------|------|------|------|------|
| Win Rate | 57.1% | 0.0% | 75.0% | improved |
| Avg R | -0.086 | -0.533 | -0.108 | improved vs v1.1 pre-profile |
| Total PnL | -$261.50 | -$1,293.00 | -$705.00 | improved vs v1.1 pre-profile |
| Avg Winner R | +0.432 | N/A | +0.133 | degraded |
| Avg Loser R | -0.777 | -0.533 | -0.833 | degraded |
| Profit Factor | 0.74 | 0.00 | 0.48 | degraded vs v1.0 |
| Avg Hold Time | 35.5 min | 23.7 min | 6.0 min | much faster |
| Exit Legs | 0.0 | 0.0 | 1.9 | new feature working |
| Target Hits | some (via T2) | 0 | 0 | no improvement |
| MFE Giveback | high (64.8pts→R=1.41) | N/A | extreme (7.6pts→R=0.13) | worse |

### Interpretation
The profile system made the strategy **faster and more active** (75% WR, 6-min holds, multi-leg exits). But it **traded away winner magnitude** for winner frequency. The pre-update v1.0 NQ baseline had a better profit factor (0.74 vs 0.48) because when it won, it won meaningfully (+0.43R avg). The profile system's winners are too small to overcome its losers.

---

## 5. Confirmed Improvements

### 5.1 Management Profiles Are Mechanically Correct (CONFIRMED)
- `management_profile` field populated on all 16 post-profile trades
- `atr_at_entry` field present with reasonable values (4.95 – 11.86)
- Profile selection maps correctly: `trend_pullback_long/short` → `trend_pullback`, `breakout_retest_long` → `breakout_retest`
- **Source:** `management-profiles.ts` getSetupFamily() + getManagementProfile() + resolveProfile()

### 5.2 Partial Exit Legs Work Correctly (CONFIRMED)
- Exit legs array properly records each partial: reason, quantity, fill_price, pnl_points, pnl_usd
- PT1 partial fires at 0.5x ATR offset (e.g., ATR=10 → PT1 at 5pts)
- PT2 partial fires at 1.2x ATR offset when reached
- PnL accounting is correct: sum of leg pnl_usd matches total pnl_realized
- **Source:** `position-manager.ts` applyPt1Exit(), applyPt2Exit(), recordPartialLeg()

### 5.3 State Machine Correctly Prevents Entry During Management (CONFIRMED)
- Zero evidence of entry signals executing during MANAGING phase
- No overlapping trade_ids in trade_path.jsonl
- Phase transitions follow expected sequence: FLAT → ENTERING → MANAGING → EXITING → COOLDOWN → FLAT
- **Source:** `runner.ts` onAnalysis() phase-gated routing (line 595-665), `engine-phase.ts`

### 5.4 Trailing Stop Mechanics Work as Designed (CONFIRMED)
- Post-PT1, trailing stop activates at configured distance
- Stop ratchets tighter (never loosens)
- stop_price_final in trade records reflects trailing movement
- **Source:** `position-manager.ts` evaluate() trailing stop block (lines 192-221)

### 5.5 ATR-Relative Thresholds Scale with Volatility (CONFIRMED)
- Low ATR trades (4.95): PT1 at ~2.5pts, tight management
- High ATR trades (11.86): PT1 at ~5.9pts, wider management
- Trailing distance scales proportionally
- **Source:** `management-profiles.ts` resolveProfile()

---

## 6. Confirmed Failures

### 6.1 Winners Are Too Small — PT1 Offset Too Tight (CONFIRMED)
**Evidence:** Average winner R = +0.133. Every winner's exit leg breakdown shows:
- PT1 captures 3-6 points (0.5x ATR)
- Trailing stop exits runner at near-breakeven (1-4pts from entry)
- Total capture: +$23 to +$114 on 4-6 contract positions

**Example:** Trade TRADE_..._0531 (trend_pullback_short):
- Entry 24228.75, ATR=10.58
- PT1 fires at 24223.25 (5.5pts, qty=2) → $21
- Trailing stop exits at 24227.25 (1.5pts, qty=2) → $5
- Total: +$26 on a 4-contract position. R = +0.06

**Code source:** `config/indicator-config.json` trend_pullback profile: `pt1_offset_atr: 0.5`
**Fix location:** `config/indicator-config.json` management_profiles, all profiles' `pt1_offset_atr` values

### 6.2 Trail Distance Too Tight — Runner Dies Immediately (CONFIRMED)
**Evidence:** Post-PT1 trailing distance = 0.3x ATR ≈ 3pts for typical NQ ATR of 10. A 3-point NQ pullback is noise. The runner is stopped out within seconds of PT1 firing.

Average time between PT1 and final exit: ~15-40 seconds. The runner has zero chance of reaching T1 (which is 48-67 points away).

**Code source:** `config/indicator-config.json` trend_pullback profile: `trail_atr_post_t1: 0.3`
**Fix location:** Same — increase trail_atr_post_t1 across all profiles

### 6.3 Zero Target Hits (CONFIRMED)
**Evidence:** 0 of 16 post-profile trades hit T1 or T2. Exit reason is stop_loss on 15/16 trades, time_stop on 1/16.

**Root cause:** Trail is so tight that the runner is always stopped before reaching targets. T1 distances (40-80pts from entry) are unreachable when trail distance is 3pts.

### 6.4 Long Side Significantly Underperforms (CONFIRMED)
**Evidence:**
- Shorts: 8 wins / 1 loss, avg R = +0.01
- Longs: 4 wins / 3 losses, avg R = -0.26

**Likely cause:** Market was trending down during the analysis window (2026-04-07 overnight session). Long entries against the macro trend had higher MAE and more stop-outs. This may be a regime issue, not a code bug.

**Code source:** `strategy.ts` assessMultiTfBias(), classifyRegime() — regime detection may be allowing trend_pullback_long entries in a down-trending market because 1m regime briefly flips.

---

## 7. Suspicious / Inconclusive Areas

### 7.1 Pre-Profile v1.1 Trades Show No Profiles (POSSIBLE)
Six trades between 14:20-20:37 UTC on 2026-04-06 have `management_profile=null` despite running on IC_v1.1_BASELINE_NQ which has profiles defined. This suggests either:
- The code was deployed mid-session and these trades ran on old compiled code
- The runner was restarted between trades 27 and 28

**Confidence:** POSSIBLE — likely a deployment timing issue, not a bug

### 7.2 Sessions Show total_signals=0 (POSSIBLE)
All session records in sessions.jsonl show `total_signals: 0` despite signals.jsonl having 10,571 entries. The session close event may not be aggregating signal counts.

**Code source:** `runner.ts` — session record may only be written at startup without final update
**Confidence:** HIGHLY LIKELY — cosmetic logging issue, not affecting trading

### 7.3 Trade Path Events Missing Profile Info for Pre-Profile Trades (CONFIRMED)
Trade path events for pre-profile trades show `management_profile: null`. This is expected for the pre-profile period but means historical replay cannot reconstruct which management rules applied.

### 7.4 Hold Times Extremely Short (SUSPICIOUS)
Post-profile avg hold = 6 minutes. Several trades hold 19-40 seconds. This suggests the system is entering and exiting very rapidly. At 5s analysis interval + 2s monitor interval, the system may be:
- Entering on a momentary dip
- PT1 firing on the first 0.5×ATR bounce
- Trail stopping out within 2-3 monitor ticks

**Confidence:** HIGHLY LIKELY — not a bug, but a symptom of the too-tight PT1/trail config

---

## 8. Trade-Path Forensic Examples

### Example A: Tiny Winner (Trade 0024, trend_pullback_short)
```
Entry: 24290.00, Stop: 24329.25, T1: 24239.25, T2: 24202.50
ATR: 6.27, Profile: trend_pullback

Timeline:
  00:02:00 — Entry at 24290.00
  00:02:05 — Price drops to 24285.50 (4.5pts favorable)
  00:02:05 — PT1 fires: 3 contracts sold at 24285.50 (+$25.50)
  00:02:05 — Trail activates: distance = 0.3×6.27 = 1.88pts ≈ 2pts
  00:02:15 — Price pulls back to 24288.25 (trail stop hit)
  00:02:40 — Final exit: 3 contracts at 24288.25 (+$9.00)

Total: +$34.50 (+0.07R) on a 6-contract position
MFE: 4.5pts. T1 was 50.75pts away. Runner captured 1.75pts of the remaining move.
```

### Example B: Full Stop Loss (Trade 0353_0608, trend_pullback_long)
```
Entry: 24220.25, Stop: 24198.00, T1: 24270.50, T2: 24333.25
ATR: 4.95, Profile: trend_pullback

Timeline:
  04:04:27 — Entry at 24220.25
  04:04:27 — Price never reaches PT1 (0.5×4.95 = 2.5pts above entry = 24222.75)
  04:14:00 — Price drops to 24198.00 (stop hit, full position)

Total: -$409.50 (-1.02R) on 1 leg, no partials taken
```

### Example C: Best Post-Profile Winner (Trade 0354, trend_pullback_short)
```
Entry: 24268.00, Stop: 24310.75, T1: 24208.50, T2: 24202.50
ATR: 11.56, Profile: trend_pullback

Timeline:
  01:12:56 — Entry at 24268.00
  01:13:20 — Price drops to 24260.50 (7.5pts favorable)
  01:13:20 — PT1 fires: 2 contracts at 24260.50 (+$29.00)
  01:13:50 — Price drops to 24252.75 (15.2pts favorable)
  01:13:50 — PT2 fires: 1 contract at 24252.75 (+$30.00)
  01:14:20 — Trail stops runner at 24254.00
  01:14:28 — Final exit: 2 contracts at 24254.00 (+$55.00)

Total: +$114.00 (+0.27R). MFE: 18.25pts. T1 was 59.5pts away.
Best trade in the set — and it only captured 0.27R.
```

---

## 9. Root-Cause Mapping Table

| Finding | Evidence from Logs | Likely Code Source | File | Function / Area | Confidence | Recommended Fix |
|---|---|---|---|---|---|---|
| Winners too small (avg +0.13R) | All 12 winners show R < +0.30; exit legs show PT1 at 3-6pts | PT1 offset at 0.5×ATR too tight for NQ | config/indicator-config.json | management_profiles.*.pt1_offset_atr | CONFIRMED | Increase pt1_offset_atr to 0.8-1.0 across all profiles |
| Trail kills runner immediately | Stop_final within 2-4pts of entry on all winners; avg 15-40s between PT1 and final exit | trail_atr_post_t1 at 0.3×ATR = 3pts, too tight | config/indicator-config.json | management_profiles.*.trail_atr_post_t1 | CONFIRMED | Increase to 0.5-0.7×ATR (5-7pts at ATR=10) |
| Zero target hits (0/16 trades reach T1) | exit_reason never shows target_1 or target_2 | Trail stops runner 50+ pts before T1 | config/indicator-config.json + position-manager.ts | Trail vs target distance imbalance | CONFIRMED | Either widen trail OR add trail-to-structure option |
| Pre-T1 trail too aggressive | pre_t1_trail_trigger_r=0.6-0.75, fires very early | Trailing activates at 0.6R, which is before PT1 in many cases | config/indicator-config.json | pre_t1_trail_trigger_r values | HIGHLY LIKELY | Set pre_t1_trail_trigger_r >= 1.0R to avoid pre-PT1 trailing |
| Long side bleeds (-0.26R avg) | 3 of 7 longs stopped at -1.0R, only 1 reached PT1+trail win | May be taking trend_pullback_long in down-trending market | strategy.ts | classifyRegime() + genTrendPullbackLong() | POSSIBLE | Regime may flip 1m trending_up briefly; need HTF regime override |
| Sessions show 0 signals | sessions.jsonl: total_signals=0 on all sessions | Session record written at open, not updated at close | runner.ts | Session write logic | HIGHLY LIKELY | Update session record at shutdown with actual counts |
| Performance.json session_id stale | Shows SESSION_2026-04-04T18-37-42 (first session ever) | Performance tracker uses first session ID, never updates | performance-tracker.ts | constructor / recordTrade() | CONFIRMED | Use current session_id or 'cumulative' |

---

## 10. File-by-File Fix Priorities

### 1. `config/indicator-config.json` — HIGHEST PRIORITY
**What:** All management_profiles have pt1_offset_atr and trail_atr_post_t1 values that are too tight for NQ.
**Why:** This is the single biggest determinant of post-update PnL. At current values, the system cannot generate positive expectancy regardless of entry quality. Winners average +0.13R vs losers at -0.83R — mathematically impossible to profit.
**Specific changes needed:**
- `pt1_offset_atr`: 0.5 → 0.8-1.0 (target 8-10pts at ATR=10 instead of 5pts)
- `trail_atr_post_t1`: 0.3 → 0.5-0.7 (target 5-7pts at ATR=10 instead of 3pts)
- `pre_t1_trail_trigger_r`: 0.6-0.75 → 1.0+ (don't trail until trade has room to breathe)
- Consider larger `pt1_exit_fraction` reduction (0.5 → 0.35) to leave more contracts running
**Blocks further evaluation:** YES — cannot assess strategy quality until exit mechanics produce viable R-multiples

### 2. `src/autotrade/position-manager.ts` — MEDIUM PRIORITY
**What:** The trailing stop mechanism is pure distance-based. For NQ, a structure-aware trail (e.g., trail to nearest swing low instead of fixed ATR distance) would capture more of the move.
**Why:** Even with wider ATR trail, a fixed-distance trail will always get chopped out in NQ's noise. Structure-based trailing would let winners run to natural levels.
**Specific area:** evaluate() trailing stop block (lines 192-221), applyPartialExit() trail activation

### 3. `src/autotrade/strategy.ts` — MEDIUM PRIORITY
**What:** Long-side entries in down-trending markets. classifyRegime() may flip to trending_up on 1m data while the macro trend is down.
**Why:** 3 of 7 post-profile longs were full -1R stops. Regime detection may be too reactive to 1m noise.
**Specific area:** classifyRegime() (lines 56-131), genTrendPullbackLong() EMA stack gate

### 4. `src/autotrade/runner.ts` — LOW PRIORITY
**What:** Session records show total_signals=0. Session is written at startup but not updated at shutdown.
**Why:** Cosmetic, but makes session-level analysis unreliable.
**Specific area:** Session close handling (shutdown hook or graceful exit)

### 5. `src/autotrade/performance-tracker.ts` — LOW PRIORITY
**What:** session_id in performance.json is stale (first session, never updated). The tracker correctly hydrates from trades.jsonl, so stats are accurate, but the session attribution is misleading.
**Why:** Cosmetic — stats are correct, just labeled with wrong session.

---

## 11. Recommended Next Instrumentation

### 11.1 Log PT1/Trail Trigger Events in Trade Path
Currently trade_path.jsonl shows price snapshots every ~24s. Add explicit event entries for:
- PT1 trigger (with resolved offset, actual price, contracts exited)
- Trail activation (with anchor price, trail distance)
- Trail ratchet (old stop → new stop)
- Pre-T1 BE trigger

**Why:** Would allow post-hoc analysis of trail behavior without reconstructing from exit legs.

### 11.2 Add MFE-at-PT1 to Trade Record
Record the MFE at the moment PT1 fires, not just the overall trade MFE. This reveals how much of the move occurred after PT1 was taken.

### 11.3 Add Runner Capture Ratio
`runner_capture = (runner_exit_pnl / trade_mfe_at_runner_exit)` — shows what fraction of the available move the runner actually captured.

### 11.4 Log Regime at Each Monitor Tick
Currently regime is recorded at entry and exit only. Logging regime transitions during the trade would reveal whether regime flips during management (e.g., trade enters trending_up, regime flips to choppy during hold).

### 11.5 Add Feature Set Tag to Performance Bucketing
The `feature_set: 'full'` tag exists in ScoreBreakdown but is not yet bucketed in performance.json. Add `by_feature_set` to performance aggregation for future A/B comparison.

---

## 12. Final Verdict

### What Changed
The management profile system is deployed and mechanically correct. Trades now have setup-specific management with ATR-relative partials, multi-leg exit accounting, and profile-tagged trade records. The state machine correctly prevents entry during management. Partial exit PnL accounting is accurate.

### What Improved
1. **Win rate** jumped from 0% (pre-profile v1.1) and 57% (v1.0 NQ) to 75%
2. **Trade management** is now active — 1.9 exit legs per trade vs 0 previously
3. **Data quality** — trade records now include management_profile, atr_at_entry, exit_legs, and granular exit accounting
4. **System observability** improved significantly

### What Still Fails
1. **Winner R is too small** (+0.13R avg) because PT1 and trail are both too tight for NQ's volatility
2. **Zero trades reach targets** — T1/T2 are structurally unreachable given current trail distance
3. **Negative expectancy** (-0.108R) — the system loses money despite 75% win rate
4. **Long side bleeds** — possible regime detection issue allowing counter-trend entries

### Bottom Line
The plumbing works. The parameters don't. The highest-value next action is tuning `config/indicator-config.json` management_profiles to widen PT1 offset and trail distance. Until that is done, more paper testing will only accumulate more tiny winners and periodic large losers, confirming the same negative-expectancy pattern.

**More paper testing justified?** YES — but only after widening PT1 offset (pt1_offset_atr: 0.5 → 0.8+) and trail distance (trail_atr_post_t1: 0.3 → 0.5+). Running more trades at current parameters will not produce new information.

---

## Most Likely Next Patch Targets

### Target 1: `config/indicator-config.json` — management_profiles ATR multipliers
All 6 profiles need wider PT1 and trail values. Suggested starting point for trend_pullback:
- `pt1_offset_atr`: 0.5 → 1.0 (captures 10pts at ATR=10 instead of 5pts)
- `pt2_offset_atr`: 1.2 → 2.0 (meaningful second partial at 20pts)
- `trail_atr_post_t1`: 0.3 → 0.6 (6pt trail instead of 3pt — survives normal NQ noise)
- `pre_t1_trail_trigger_r`: 0.75 → 1.2 (don't trail until trade is clearly winning)

### Target 2: `src/autotrade/position-manager.ts` — evaluate() trailing stop
Consider adding a minimum trail distance floor (e.g., never less than 6 ticks / 1.5pts for MNQ) regardless of ATR calculation. This prevents the trail from being noise-level tight on low-ATR periods.

### Target 3: `src/autotrade/strategy.ts` — classifyRegime() HTF override
Add a check: if 1h bias is strongly bearish but 1m regime is trending_up, downgrade the 1m regime to range_bound. This would prevent counter-trend pullback entries during brief 1m rallies in a macro downtrend.
