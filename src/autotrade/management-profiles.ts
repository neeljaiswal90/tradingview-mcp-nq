/**
 * Management Profiles — setup-specific trade management with volatility normalization.
 *
 * Each setup family (trend_pullback, opening_drive, etc.) can define its own
 * partial-profit, trailing-stop, and time-stop parameters using ATR multiples.
 * At entry time the profile is resolved to concrete point/tick values using the
 * current ATR, then frozen on the Position for deterministic, auditable exits.
 */

import type {
  SetupType,
  SetupFamily,
  ManagementProfile,
  ResolvedManagementParams,
  IndicatorConfig,
  MarketRegime,
} from './types.js';
import type { ContractSpec } from './contracts.js';
import { priceToTicks } from './contracts.js';

// ── Setup family mapping ────────────────────────────────────────────────────

const FAMILY_MAP: Record<SetupType, SetupFamily> = {
  trend_pullback_long: 'trend_pullback',
  trend_pullback_short: 'trend_pullback',
  breakout_retest_long: 'breakout_retest',
  breakdown_retest_short: 'breakout_retest',
  momentum_continuation: 'momentum_continuation',
  opening_drive_continuation_long: 'opening_drive',
  opening_drive_continuation_short: 'opening_drive',
  or_retest_continuation_long: 'or_retest',
  or_retest_continuation_short: 'or_retest',
  failed_or_break_short: 'failed_or_break',
  failed_or_break_long: 'failed_or_break',
};

/** Map a directional SetupType to its direction-agnostic family. */
export function getSetupFamily(setupType: SetupType): SetupFamily {
  return FAMILY_MAP[setupType] ?? 'default';
}

// ── Profile selection ───────────────────────────────────────────────────────

/**
 * Select the management profile for a given setup type.
 *
 * Lookup order:
 * 1. config.management_profiles[family]  (family-specific)
 * 2. config.management_profiles['default']  (explicit default)
 * 3. buildDefaultProfileFromConfig(config)  (legacy flat-config synthesis)
 *
 * The `regime` parameter is logged but does not alter selection in v1.
 */
export function getManagementProfile(
  setupType: SetupType,
  regime: MarketRegime,
  config: IndicatorConfig,
): ManagementProfile {
  const family = getSetupFamily(setupType);
  const profiles = config.management_profiles;

  let profile: ManagementProfile | null = null;

  if (profiles) {
    if (profiles[family]) {
      profile = { ...profiles[family] };
      console.log(
        `[MGMT] Profile selected: '${profile.name}' for family='${family}' ` +
        `(setup=${setupType}, regime=${regime})`,
      );
    } else if (profiles['default']) {
      profile = { ...profiles['default'] };
      console.log(
        `[MGMT] No profile for family='${family}', using explicit default ` +
        `(setup=${setupType}, regime=${regime})`,
      );
    }
  }

  if (!profile) {
    console.log(
      `[MGMT] No management_profiles in config, synthesizing from flat params ` +
      `(setup=${setupType}, family=${family}, regime=${regime})`,
    );
    profile = buildDefaultProfileFromConfig(config);
  }

  // Apply variant overrides if active
  const variantName = config.active_management_variant;
  const variants = config.management_profile_variants;
  if (variantName && variants?.[variantName]?.[family]) {
    const overrides = variants[variantName][family];
    profile = { ...profile, ...overrides };
    console.log(`[MGMT-VARIANT] Applied "${variantName}" overrides to ${family}: ${JSON.stringify(overrides)}`);
  }

  return profile;
}

// ── Legacy profile synthesis ────────────────────────────────────────────────

/**
 * Synthesize a ManagementProfile from the flat IndicatorConfig fields.
 * All ATR fields are 0 (disabled), fallbacks match the flat config exactly.
 * Provides exact backwards compatibility when no management_profiles exist.
 */
export function buildDefaultProfileFromConfig(config: IndicatorConfig): ManagementProfile {
  return {
    name: 'legacy_default',
    family: 'default',
    pt1_offset_atr: 0,
    pt2_offset_atr: 0,
    pt1_offset_pts_fallback: config.pt1_offset_pts,
    pt2_offset_pts_fallback: config.pt2_offset_pts,
    pt1_exit_fraction: config.pt1_exit_fraction,
    pt2_exit_fraction: config.pt2_exit_fraction,
    pt1_move_to_be: config.pt1_move_to_be,
    pt1_activate_trailing: config.pt1_activate_trailing,
    trail_atr_post_t1: 0,
    trail_ticks_post_t1_fallback: config.trail_ticks_post_t1,
    breakeven_trigger_r: config.breakeven_trigger_r,
    pre_t1_trail_trigger_r: config.pre_t1_trail_trigger_r,
    pre_t1_trail_atr: 0,
    pre_t1_trail_ticks_fallback: config.pre_t1_trail_distance_ticks,
    time_stop_minutes: config.time_stop_minutes,
    time_stop_max_r_pre_t1: config.time_stop_max_r_pre_t1,
    time_stop_max_r_post_t1: config.time_stop_max_r_post_t1,
  };
}

// ── ATR resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a ManagementProfile into concrete ResolvedManagementParams.
 *
 * For each ATR-relative field:
 * - If the ATR multiple is > 0 AND atr is valid (> 0): compute concrete value
 * - Otherwise: use the _fallback value
 *
 * Safety enforcements:
 * - All offsets are clamped to a minimum of 1 tick
 * - PT2 must exceed PT1 by at least 4 ticks
 * - Trail and pre-T1 trail distances are at least 1 tick
 */
export function resolveProfile(
  profile: ManagementProfile,
  atr: number | null,
  contract: ContractSpec,
): ResolvedManagementParams {
  const atrValid = atr !== null && atr > 0;
  const tickSize = contract.tick_size;
  const minOffset = tickSize; // 1 tick minimum

  // ── Resolve ATR-relative or fallback ──────────────────────────────────

  const pt1Raw = (profile.pt1_offset_atr > 0 && atrValid)
    ? atr * profile.pt1_offset_atr
    : profile.pt1_offset_pts_fallback;

  const pt2Raw = (profile.pt2_offset_atr > 0 && atrValid)
    ? atr * profile.pt2_offset_atr
    : profile.pt2_offset_pts_fallback;

  // If both raw values are 0, PT scaling is disabled — preserve 0
  const ptDisabled = pt1Raw === 0 && pt2Raw === 0;

  const trailPtsRaw = (profile.trail_atr_post_t1 > 0 && atrValid)
    ? atr * profile.trail_atr_post_t1
    : null; // null means use tick fallback directly

  const preT1TrailPtsRaw = (profile.pre_t1_trail_atr > 0 && atrValid)
    ? atr * profile.pre_t1_trail_atr
    : null;

  // ── Clamp to minimums (unless PT scaling is explicitly disabled) ────

  const pt1Pts = ptDisabled ? 0 : Math.max(minOffset, pt1Raw);
  let pt2Pts = ptDisabled ? 0 : Math.max(minOffset, pt2Raw);

  // Safety: PT2 must exceed PT1 by at least 4 ticks (when enabled)
  if (!ptDisabled) {
    const minPt2 = pt1Pts + 4 * tickSize;
    if (pt2Pts <= minPt2) {
      pt2Pts = minPt2;
    }
  }

  // Trail: convert points to ticks, fallback to tick count directly
  const trailTicks = trailPtsRaw !== null
    ? Math.max(1, priceToTicks(trailPtsRaw, contract))
    : Math.max(1, profile.trail_ticks_post_t1_fallback);

  const preT1TrailTicks = preT1TrailPtsRaw !== null
    ? Math.max(1, priceToTicks(preT1TrailPtsRaw, contract))
    : Math.max(1, profile.pre_t1_trail_ticks_fallback);

  return {
    profile_name: profile.name,
    family: profile.family,
    atr_at_entry: atr,
    pt1_offset_pts: pt1Pts,
    pt2_offset_pts: pt2Pts,
    pt1_exit_fraction: profile.pt1_exit_fraction,
    pt2_exit_fraction: profile.pt2_exit_fraction,
    pt1_move_to_be: profile.pt1_move_to_be,
    pt1_activate_trailing: profile.pt1_activate_trailing,
    trail_ticks_post_t1: trailTicks,
    breakeven_trigger_r: profile.breakeven_trigger_r,
    pre_t1_trail_trigger_r: profile.pre_t1_trail_trigger_r,
    pre_t1_trail_distance_ticks: preT1TrailTicks,
    time_stop_minutes: profile.time_stop_minutes,
    time_stop_max_r_pre_t1: profile.time_stop_max_r_pre_t1,
    time_stop_max_r_post_t1: profile.time_stop_max_r_post_t1,
  };
}
