# Management Dataset Label Definitions

**Generated:** 2026-04-08
**Script:** `scripts/ml/label_management_dataset.py`
**Input:** `data/management_dataset.csv` (1,298 rows, 42 trades)
**Output:** `data/management_dataset_labeled.csv` (1,298 rows, 110 columns, 43 new labels)

---

## Anti-Leakage Controls

| Control | Implementation |
|---------|----------------|
| Same-trade only | Labels computed from future ticks of the SAME trade. No cross-trade leakage. |
| Forward windows | Time-based windows (30s, 60s, 120s) only look ahead from current tick. |
| Incomplete window marking | `sl_window_Xs_complete=0` when window extends past trade end. |
| Last-tick marking | `sl_is_last_tick=1` flags degenerate rows where labels = final values. |
| Validity flag | `sl_labels_valid=0` when no future ticks exist (exclude from training). |
| Feature separation | All labels prefixed `sl_` — never mixed into feature columns. |
| Runner gating | Runner labels are `null` when `pt1_hit=0` (not applicable pre-PT1). |
| No modification | Original feature columns are never modified by the labeling script. |

**Training filter:** Always use `WHERE sl_labels_valid = 1` to exclude degenerate last-tick rows (42 rows, one per trade).

---

## Label Groups

### Group 1: Continuation Labels

These answer: *"Should the trade continue from this point?"*

| Label | Type | Description | Construction |
|-------|------|-------------|--------------|
| `sl_remaining_r` | float | R earned from this point to trade end | `label_final_r - unrealized_r` |
| `sl_future_mfe_pts` | float | Max favorable excursion AFTER this tick (pts) | Best future price vs current price, same side |
| `sl_future_mae_pts` | float | Max adverse excursion AFTER this tick (pts) | Worst future price vs current price, same side |
| `sl_hit_pt1_eventually` | 0/1 | Does PT1 fire at or after this tick? | `pt1_hit=1` at current tick OR any future tick |
| `sl_hit_pt2_before_stop` | 0/1 | Does PT2 fire before trade ends? | Quantity drops >1.5 units after this tick |
| `sl_best_r_next_30s` | float | Best R achievable in next 30 seconds | Max `unrealized_r` in [t, t+30s] window |
| `sl_worst_r_next_30s` | float | Worst R in next 30 seconds | Min `unrealized_r` in [t, t+30s] window |
| `sl_end_r_next_30s` | float | R at end of 30s window | `unrealized_r` of last tick in window |
| `sl_r_improves_next_30s` | 0/1 | Does R improve by >0.05 in next 30s? | `sl_best_r_next_30s > unrealized_r + 0.05` |
| `sl_window_30s_complete` | 0/1 | Is the full 30s window available? | 0 if trade ends before window completes |
| *(same for 60s and 120s windows)* | | | |

**Use cases:**
- Binary classification: "should I hold for the next 30 seconds?"
- Regression: "how much R can I expect in the next 60 seconds?"

### Group 2: Hold-vs-Exit Value Labels

These answer: *"Is holding or exiting more valuable right now?"*

| Label | Type | Description | Construction |
|-------|------|-------------|--------------|
| `sl_r_if_hold_to_end` | float | R realized by holding to natural trade end | `label_final_r` (constant per trade) |
| `sl_r_if_exit_now` | float | R realized by exiting at current price | `unrealized_r` (current tick value) |
| `sl_hold_advantage_r` | float | R gained by holding vs exiting now | `label_final_r - unrealized_r` |
| `sl_hold_is_better` | 0/1 | Was holding better than exiting? | `label_final_r > unrealized_r` |
| `sl_peak_r_remaining` | float | Best R still achievable after this tick | Max `unrealized_r` of all future ticks |
| `sl_trough_r_remaining` | float | Worst R after this tick (downside risk) | Min `unrealized_r` of all future ticks |
| `sl_exit_was_urgent` | 0/1 | Did holding cost >0.3R vs exiting now? | `label_final_r < unrealized_r - 0.3` |

**Key stat from current data:** `sl_hold_is_better=1` in 28.9% of valid rows. This means at 71% of decision points, exiting immediately would have been better than holding to trade end. Strongly suggests the management system holds too long on average.

### Group 3: Runner Quality Labels (Post-PT1 Only)

These answer: *"After PT1, is the runner worth keeping?"*

Only populated when `pt1_hit=1`. Null otherwise.

| Label | Type | Description | Construction |
|-------|------|-------------|--------------|
| `sl_runner_continues` | 0/1 | Does trade gain >0.1R after this tick? | `label_max_unrealized_r - unrealized_r > 0.1` |
| `sl_runner_giveback_r` | float | R given back from peak to trade end | `label_max_unrealized_r - label_final_r` |
| `sl_enough_followthrough` | 0/1 | Is future MFE > 0.5 x initial risk? | `sl_future_mfe_pts > 0.5 * initial_risk_pts` |
| `sl_runner_capture_frac` | float | Fraction of remaining opportunity captured | `remaining_r / peak_r_remaining` |
| `sl_trade_runner_capture_ratio` | float | Trade-level capture ratio (from record) | From `label_runner_capture_ratio` |
| `sl_trade_giveback_r` | float | Trade-level giveback (from record) | From `label_giveback_r` |
| `sl_trade_mfe_after_pt1` | float | Trade-level MFE after PT1 in pts | From `label_mfe_after_pt1` |

**Key stat from current data:** `sl_runner_continues=1` in 49.4% of post-PT1 rows. `sl_enough_followthrough=1` in only 11.4%. Average giveback is 0.269R.

### Group 4: Stop-Adjustment Utility Labels

These answer: *"Would changing the stop have helped?"*

| Label | Type | Description | Construction |
|-------|------|-------------|--------------|
| `sl_be_move_protects_profit` | 0/1 | Would BE stop trigger (protecting current gain)? | Simulated: would price cross entry after this tick? (only when `unrealized_r > 0`) |
| `sl_be_move_cuts_winner` | 0/1 | Would BE stop exit a trade that gained >0.2R more? | BE triggers AND `label_final_r > unrealized_r + 0.2` |
| `sl_tighter_stop_final_r` | float | Simulated final R with 50% tighter stop | First price that crosses the tighter stop level |
| `sl_tighter_stop_helped` | 0/1 | Did the tighter stop produce better R? | `sl_tighter_stop_final_r > label_final_r` |
| `sl_wider_stop_final_r` | float | Simulated final R with 50% wider stop | First price that crosses the wider stop level |
| `sl_wider_stop_helped` | 0/1 | Did the wider stop produce better R? | `sl_wider_stop_final_r > label_final_r` |

**Key stat from current data:** `sl_tighter_stop_helped=1` in 38.4% of rows. `sl_wider_stop_helped=1` in only 0.2%. This strongly suggests the current stop strategy is already too tight — tightening further would help 38% of the time, while widening almost never helps. This is consistent with the audit finding that winners are tiny because the trailing stop kills runners too fast.

---

## Meta Labels

| Label | Type | Description |
|-------|------|-------------|
| `sl_is_last_tick` | 0/1 | Last tick of trade (labels are degenerate — future = 0) |
| `sl_future_ticks_available` | int | How many future ticks are available |
| `sl_labels_valid` | 0/1 | 1 if at least 1 future tick exists |
| `sl_window_30s_complete` | 0/1 | Full 30s forward window available |
| `sl_window_60s_complete` | 0/1 | Full 60s forward window available |
| `sl_window_120s_complete` | 0/1 | Full 120s forward window available |

---

## Training Guidance

### Recommended feature/label separation

```python
# Features: everything that is NOT a label or identity
feature_cols = [c for c in df.columns
                if not c.startswith("sl_")
                and not c.startswith("label_")
                and c not in ["trade_id", "timestamp", "row_type", "tick_index", "total_ticks", "tick_progress"]]

# Labels: all sl_ prefixed columns
label_cols = [c for c in df.columns if c.startswith("sl_")]

# Filter to valid rows only
df_train = df[df["sl_labels_valid"] == 1]
```

### Suggested modeling tasks

| Task | Target | Type | Filter |
|------|--------|------|--------|
| Should I hold? | `sl_hold_is_better` | Binary classification | `sl_labels_valid=1` |
| Is this an urgent exit? | `sl_exit_was_urgent` | Binary classification | `sl_labels_valid=1` |
| How much R remains? | `sl_remaining_r` | Regression | `sl_labels_valid=1` |
| Will R improve in 30s? | `sl_r_improves_next_30s` | Binary classification | `sl_window_30s_complete=1` |
| Runner quality (post-PT1) | `sl_runner_continues` | Binary classification | `pt1_hit=1 AND sl_labels_valid=1` |
| Would tighter stop help? | `sl_tighter_stop_helped` | Binary classification | `sl_labels_valid=1` |

---

## Data Quality Notes

- 42 trades, 1,298 rows (1,256 valid after excluding last-tick rows)
- 30s window complete for 71.9% of valid rows
- 120s window complete for 89.5% of valid rows
- Runner labels available on 79 rows (pt1_hit=1)
- `management_profile` populated on only 7.6% of rows (newer trades only)
- `atr_at_entry` populated on 7.6% (same trades)
- As more trades accumulate with the instrumented codebase, coverage will increase
