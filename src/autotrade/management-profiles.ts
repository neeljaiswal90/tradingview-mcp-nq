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
import { STRATEGY_REGISTRY } from './strategy.js';

// ── Setup family mapping ────────────────────────────────────────────────────
//
// Phase 2: FAMILY_MAP is DERIVED from STRATEGY_REGISTRY rather than
// hand-maintained. Adding a new strategy to the registry automatically
// updates the family mapping — no second inventory to keep in sync.
//
// The map is built LAZILY on first access because management-profiles.ts
// is indirectly imported by strategy.ts (via features/dynamic-reward-plan.ts),
// which creates a circular import. At module init time STRATEGY_REGISTRY
// is still undefined; by the first call to getSetupFamily() the circle
// has finished resolving and the array is populated.
//
// The 'or_retest' family remains declared in SetupFamily for historical
// config compatibility but no live setup maps to it.

let _familyMap: Record<SetupType, SetupFamily> | null = null;

function familyMap(): Record<SetupType, SetupFamily> {
  if (_familyMap) return _familyMap;
  const map = {} as Record<SetupType, SetupFamily>;
  for (const def of STRATEGY_REGISTRY) {
    map[def.strategy_id] = def.family;
  }
  _familyMap = map;
  return map;
}

/** Map a directional SetupType to its direction-agnostic family. */
export function getSetupFamily(setupType: SetupType): SetupFamily {
  return familyMap()[setupType] ?? 'default';
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

  // Phase 6: fail-loud validation for scalper profiles. Any rule
  // violation (extended cap < base cap, no-progress >= base cap,
  // negative thresholds) throws immediately so operators see the
  // problem at profile resolution — never silently at exit time.
  validateScalperManagementProfile(profile);

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
    // ── Dead-Trade Guard (pre-PT1 failure-to-launch) ──────────────────
    // Defaults: FEATURE OFF. Any profile or variant that sets
    // pre_t1_failure_exit_enabled=true supplies its own thresholds via
    // the optional fields below; the defaults here are inert when the
    // flag is off, and safe starting values if the flag flips on without
    // explicit overrides.
    pre_t1_failure_exit_enabled: profile.pre_t1_failure_exit_enabled ?? false,
    pre_t1_failure_shadow_mode: profile.pre_t1_failure_shadow_mode ?? true,
    pre_t1_failure_decay_min_gap_minutes: profile.pre_t1_failure_decay_min_gap_minutes ?? 0.5,
    pre_t1_failure_lambda_net: profile.pre_t1_failure_lambda_net ?? 1.0,
    // Lane A (soft review)
    pre_t1_failure_soft_min_minutes: profile.pre_t1_failure_soft_min_minutes ?? 4,
    pre_t1_failure_soft_progress_rate_max: profile.pre_t1_failure_soft_progress_rate_max ?? 0.05,
    pre_t1_failure_soft_failure_ratio_min: profile.pre_t1_failure_soft_failure_ratio_min ?? 2.0,
    // Lane B (empirical quantile cut)
    pre_t1_failure_hard_min_minutes: profile.pre_t1_failure_hard_min_minutes ?? 5,
    pre_t1_failure_hard_current_r_alpha: profile.pre_t1_failure_hard_current_r_alpha ?? 0.4,
    pre_t1_failure_curves_key: profile.pre_t1_failure_curves_key ?? profile.family,
    pre_t1_failure_min_n_per_bucket: profile.pre_t1_failure_min_n_per_bucket ?? 20,
    // Lane C (emergency shape cut)
    pre_t1_failure_emergency_min_minutes: profile.pre_t1_failure_emergency_min_minutes ?? 3,
    pre_t1_failure_emergency_mae_r_floor: profile.pre_t1_failure_emergency_mae_r_floor ?? 0.20,
    pre_t1_failure_emergency_failure_ratio_min:
      profile.pre_t1_failure_emergency_failure_ratio_min ?? 4.0,
    pre_t1_failure_emergency_peak_r_max: profile.pre_t1_failure_emergency_peak_r_max ?? 0.10,
    pre_t1_failure_emergency_decay_rate_min:
      profile.pre_t1_failure_emergency_decay_rate_min ?? 0,
    // Expectancy hook (v2)
    pre_t1_failure_cost_r: profile.pre_t1_failure_cost_r ?? 0.05,

    // ── lob_mbo_scalp family (Phase 6) ──────────────────────────────
    // Null-passthrough for non-scalper families. Scalper resolution
    // applies the plan defaults and runs the
    // validateScalperManagementProfile() check so a misconfigured
    // `time_stop_seconds < scalper_hard_cap_seconds` fails LOUDLY at
    // profile resolution rather than silently at exit time.
    time_stop_seconds:
      profile.family === 'lob_mbo_scalp'
        ? profile.time_stop_seconds ?? 10
        : profile.time_stop_seconds ?? null,
    scalper_hard_cap_seconds:
      profile.family === 'lob_mbo_scalp'
        ? profile.scalper_hard_cap_seconds ?? 5
        : profile.scalper_hard_cap_seconds ?? null,
    scalper_no_progress_seconds:
      profile.family === 'lob_mbo_scalp'
        ? profile.scalper_no_progress_seconds ?? 2
        : profile.scalper_no_progress_seconds ?? null,
    scalper_micro_stop_min_ticks:
      profile.family === 'lob_mbo_scalp'
        ? profile.scalper_micro_stop_min_ticks ?? 2
        : profile.scalper_micro_stop_min_ticks ?? null,
    scalper_micro_stop_max_ticks:
      profile.family === 'lob_mbo_scalp'
        ? profile.scalper_micro_stop_max_ticks ?? 6
        : profile.scalper_micro_stop_max_ticks ?? null,
  };
}

/**
 * Validate a lob_mbo_scalp management profile at config load time.
 *
 * Fails LOUDLY (throws) on misconfiguration so operators see the
 * problem at startup, never at exit time on a live position. Rules
 * (per plan Phase 6):
 *
 *   1. `time_stop_seconds` (extended cap) MUST be >= `scalper_hard_cap_seconds`
 *      (base cap). Putting the extended cap BELOW the base cap would
 *      demote positions that were entered with an absorption+refill
 *      confirmation — the exact opposite of what the flag means.
 *   2. `scalper_no_progress_seconds` must be strictly less than the
 *      base cap, otherwise the no-progress clause can never fire
 *      before the hard cap does (defensive; the engine would still
 *      behave correctly, but this catches a pointless config state).
 *   3. `scalper_micro_stop_min_ticks <= scalper_micro_stop_max_ticks`.
 *   4. Every field must be a positive finite integer or null.
 *
 * No-op for non-scalper families. Called by `getManagementProfile`
 * before returning a scalper profile.
 */
export function validateScalperManagementProfile(profile: ManagementProfile): void {
  if (profile.family !== 'lob_mbo_scalp') return;

  const base = profile.scalper_hard_cap_seconds ?? null;
  const extended = profile.time_stop_seconds ?? null;
  const noProgress = profile.scalper_no_progress_seconds ?? null;
  const minTicks = profile.scalper_micro_stop_min_ticks ?? null;
  const maxTicks = profile.scalper_micro_stop_max_ticks ?? null;

  const isPosFiniteNum = (x: number | null | undefined): x is number =>
    typeof x === 'number' && Number.isFinite(x) && x > 0;

  if (base !== null && !isPosFiniteNum(base)) {
    throw new Error(`[MGMT-CONFIG] lob_mbo_scalp profile '${profile.name}': scalper_hard_cap_seconds=${base} must be a positive finite number or null`);
  }
  if (extended !== null && !isPosFiniteNum(extended)) {
    throw new Error(`[MGMT-CONFIG] lob_mbo_scalp profile '${profile.name}': time_stop_seconds=${extended} must be a positive finite number or null`);
  }
  if (noProgress !== null && !isPosFiniteNum(noProgress)) {
    throw new Error(`[MGMT-CONFIG] lob_mbo_scalp profile '${profile.name}': scalper_no_progress_seconds=${noProgress} must be a positive finite number or null`);
  }
  if (minTicks !== null && !isPosFiniteNum(minTicks)) {
    throw new Error(`[MGMT-CONFIG] lob_mbo_scalp profile '${profile.name}': scalper_micro_stop_min_ticks=${minTicks} must be a positive finite number or null`);
  }
  if (maxTicks !== null && !isPosFiniteNum(maxTicks)) {
    throw new Error(`[MGMT-CONFIG] lob_mbo_scalp profile '${profile.name}': scalper_micro_stop_max_ticks=${maxTicks} must be a positive finite number or null`);
  }

  // Rule 1: extended cap ≥ base cap (when both present)
  if (isPosFiniteNum(extended) && isPosFiniteNum(base) && extended < base) {
    throw new Error(
      `[MGMT-CONFIG] lob_mbo_scalp profile '${profile.name}': time_stop_seconds=${extended} < scalper_hard_cap_seconds=${base}. ` +
      `The extended cap must be >= the base cap — otherwise an absorption+refill-confirmed entry would get a SHORTER hold budget than a normal entry.`,
    );
  }

  // Rule 2: no-progress < base (when both present)
  if (isPosFiniteNum(noProgress) && isPosFiniteNum(base) && noProgress >= base) {
    throw new Error(
      `[MGMT-CONFIG] lob_mbo_scalp profile '${profile.name}': scalper_no_progress_seconds=${noProgress} >= scalper_hard_cap_seconds=${base}. ` +
      `The no-progress trigger must fire STRICTLY before the hard cap or it is unreachable.`,
    );
  }

  // Rule 3: min_ticks ≤ max_ticks (when both present)
  if (isPosFiniteNum(minTicks) && isPosFiniteNum(maxTicks) && minTicks > maxTicks) {
    throw new Error(
      `[MGMT-CONFIG] lob_mbo_scalp profile '${profile.name}': scalper_micro_stop_min_ticks=${minTicks} > scalper_micro_stop_max_ticks=${maxTicks}.`,
    );
  }
}
