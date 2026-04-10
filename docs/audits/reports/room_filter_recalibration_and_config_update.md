# Room Filter Recalibration & Config Update

## What Was Still Wrong After the Prior Geometry Patch

The prior patch correctly fixed VWAP distance by introducing session-scale normalization.
However, it applied the **same session-scale normalizer** to room-to-structure metrics.

**Empirical evidence:**
- Median upside room = **9.1 pts** (typical for NQ setups near key levels)
- Session ATR (sqrt(60) * 7) = **58.9 pts**
- Room / session_atr = 9.1 / 58.9 = **0.15** — fails the 1.0 threshold
- On a 400pt session range day: 9.1 / 400 = **0.023** — absurd

The room filter effectively required **59+ pts of room** when real setups have 5-30 pts.
This silently replaced the old VWAP false-veto with a new room false-veto.

## How Room Scaling Is Now Determined

Three distinct scale families, each for its measurement domain:

| Scale Family | Normalizer | Typical NQ Value | Used For |
|---|---|---|---|
| **Micro** | 1m ATR | ~7 pts | Impulse, 3-bar return, EMA distance |
| **Room** | sqrt(room_scale_bars) * 1m ATR | ~17 pts | Room-to-structure, room-to-target |
| **Session** | sqrt(session_scale_bars) * 1m ATR or actual range | ~54-400+ pts | VWAP distance |

Room normalizer defaults:
- `room_scale_bars: 5` → sqrt(5) * 7 ≈ 17 pts
- `max_room_normalizer_pts: 40` → prevents trivially loose room on volatile days
- `min_room_normalizer_pts: 8` → prevents degenerate values

Under the new calibration:
- "1.0 room-ATR of room" ≈ **17 pts** — a reasonable minimum gap to nearest structure
- Median room (9.1 pts) = 0.53 room-ATR → would need slightly more room or a lower threshold
- Typical acceptable room (15-30 pts) = 0.9-1.8 room-ATR → passes cleanly

## How Config Now Controls Normalization Policy

New optional config field on `IndicatorConfig`:
```json
"normalization": {
  "session_scale_bars": 60,
  "use_actual_session_range": true,
  "min_session_normalizer_pts": 20,
  "room_scale_bars": 5,
  "max_room_normalizer_pts": 40,
  "min_room_normalizer_pts": 8
}
```

All fields are optional — defaults in code match the table above.

## Files Changed

| File | What Changed |
|------|-------------|
| `src/autotrade/features/normalization.ts` | Added `room_atr` as third scale family with cap/floor; updated config, result, and compute function |
| `src/autotrade/features/extension.ts` | Room metrics use `room_atr` not `session_atr`; added `room_scale_atr` diagnostic; accepts normConfig parameter |
| `src/autotrade/types.ts` | Added `normalization?: NormalizationConfig` to IndicatorConfig |
| `tests/unit/normalization-and-freshness.test.ts` | Added 4 room-scale tests; updated room-metric test |
| `reports/room_filter_recalibration_and_config_update.md` | This report |

## Before/After Room Filter Diagnostics

| Metric | Old (micro ATR) | Prior Patch (session ATR) | This Patch (room ATR) |
|---|---|---|---|
| Normalizer for room | ~7 pts | ~59 pts | ~17 pts |
| "1.0 ATR of room" means | 7 pts | 59 pts | 17 pts |
| Median room (9.1 pts) passes? | Yes (1.2x) | **No (0.15x)** | Borderline (0.53x) |
| Typical room (20 pts) passes? | Yes (2.9x) | **No (0.34x)** | Yes (1.2x) |

## Remaining Risks and Follow-ups

1. **Threshold 1.0 may be too strict for room**: With room_atr ≈ 17 pts, threshold 1.0 requires 17 pts of room. The median upside room in real candidates is only 9 pts. Consider lowering `min_upside_room_atr` to 0.5 or renaming the config field to reflect room-scale.
2. **Config field naming**: `min_upside_room_atr` still uses the name "atr" which is now ambiguous (which ATR?). A future cleanup should rename to `min_upside_room_scaled` or add a comment clarifying it's room-ATR.
3. **Downside room is generous**: Median downside room is 49.9 pts — well above threshold. The calibration issue primarily affects upside room for long setups.
