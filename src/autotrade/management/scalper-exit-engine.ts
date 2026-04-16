/**
 * management/scalper-exit-engine.ts — Phase 6 exit state machine for the
 * lob_mbo_scalp strategy family.
 *
 * This is the SINGLE source of truth for every scalper exit decision.
 * Per the plan's critical ownership rule, `position-manager.ts` MUST
 * NOT contain a second hard-coded scalper time check — it early-returns
 * when it sees a scalper family and defers entirely to this engine.
 * The engine owns:
 *
 *   - The effective hard cap (base vs extended — chosen from the Position's
 *     `scalper_extended_cap` flag and the management profile's two cap
 *     values).
 *   - The no-progress exit (hold > N seconds AND current PnL < 1 tick).
 *   - The microstructure stop (current PnL ≤ -stop_ticks).
 *   - The target-hit exit (current PnL ≥ target_ticks).
 *   - The reversal exit (≥2 of N microstructure signals flipped from
 *     entry, bucketed into `microstructure_edge_decay` when absorption
 *     flipped or `scalper_reversal` otherwise).
 *
 * Check order is STRICT and matches the plan Phase 6 exit engine spec:
 *
 *   1. effective_hard_cap_sec — unconditional time cap, always first
 *   2. no_progress            — hold > threshold AND pnl < 1 tick
 *   3. microstructure stop    — standard `stop_loss` enum
 *   4. target hit             — standard `target_hit` enum
 *   5. reversal               — 2-of-N signal flip, two distinct enums
 *
 * Phase 6 hard requirements (enforced by this file + tests):
 *
 *   - NEVER THROWS. Every invalid input (null features, missing
 *     fields) is handled by returning HOLD with a `factors.error`
 *     field. The engine never crashes a live position.
 *
 *   - PURE FUNCTION. `evaluate(features)` reads only the features
 *     argument. No module-level state, no clock reads. The caller
 *     computes `hold_ms` and `current_ticks_pnl` in the feature
 *     builder so tests can drive edge cases deterministically.
 *
 *   - STABLE REASON STRINGS. Each exit path writes a specific,
 *     append-only string into `reason` and a matching `ExitReason`
 *     enum into `exit_reason_enum`. Dashboards bucket on the enum;
 *     operators read the string.
 *
 *   - NO TREND CONTAMINATION. Zero imports from
 *     `management/types.ts`, `management/decision-engine.ts`, or
 *     `features/expectancy-engine.ts`. The engine is a closed loop
 *     around its own feature vector.
 */

import type { ScalperExitFeatures, ScalperExitDecision } from './scalper-features.js';
import { scalperHold, scalperExitNow } from './scalper-features.js';

/**
 * Default reversal signal threshold — how many of the N signals must
 * flip for a `scalper_reversal` exit. The plan calls for 2-of-N. Tests
 * can override via the config parameter on `evaluate`.
 */
export const DEFAULT_REVERSAL_SIGNALS_REQUIRED = 2;

/**
 * Config for `ScalperExitEngine.evaluate`. Threshold parameters live
 * here so Phase 8 can tune them without editing the engine. Every
 * field is REQUIRED — there are no defaults inside `evaluate` itself
 * (Phase 5 "no hidden thresholds" rule applied to exits).
 */
export interface ScalperExitEngineConfig {
  /** How many reversal signals must flip to fire. Plan default 2. */
  reversal_signals_required: number;
  /**
   * Minimum |z_ofi_250ms| delta magnitude on the CURRENT tick to count
   * the zOFI-250ms sign flip as a reversal signal. Without a magnitude
   * gate, noise near zero would constantly trip the rule.
   */
  zofi_250ms_reversal_min_abs: number;
  /**
   * Minimum ticks of spread widening (current - entry) to count the
   * "spread widens" reversal signal. Plan default 1 tick.
   */
  spread_widen_min_ticks: number;
}

export const DEFAULT_SCALPER_EXIT_ENGINE_CONFIG: ScalperExitEngineConfig = {
  reversal_signals_required: DEFAULT_REVERSAL_SIGNALS_REQUIRED,
  zofi_250ms_reversal_min_abs: 0.5,
  spread_widen_min_ticks: 1,
};

/**
 * Compare a CURRENT value against a frozen entry SIGN and return true
 * when the two disagree in sign (a "flip"). Null current or neutral
 * entry sign (0) is treated as NOT a flip — the caller never counts
 * undefined signals toward the 2-of-N threshold.
 */
function signFlipped(currentValue: number | null, entrySign: -1 | 0 | 1): boolean {
  if (entrySign === 0) return false;
  if (currentValue === null || !Number.isFinite(currentValue)) return false;
  if (entrySign > 0) return currentValue < 0;
  // entrySign < 0
  return currentValue > 0;
}

/**
 * Count how many of the five reversal signals have fired on this tick.
 * The five signals (per plan Phase 6):
 *
 *   1. QI(5) sign flipped from entry.
 *   2. microprice_edge_ticks sign flipped from entry.
 *   3. z_ofi_250ms sign flipped AND |current| ≥ zofi_250ms_reversal_min_abs.
 *   4. opposite-side hazard dominates same-side hazard (i.e. the book
 *      is now more likely to pull against the trade than with it).
 *   5. spread widens relative to entry by ≥ spread_widen_min_ticks.
 *
 * Returns a structured record listing which signals fired so tests and
 * the factors log can see the individual components.
 */
function countReversalSignals(
  features: ScalperExitFeatures,
  config: ScalperExitEngineConfig,
): { count: number; detail: Record<string, boolean>; absorption_flipped: boolean } {
  const detail: Record<string, boolean> = {};

  const qiFlip = signFlipped(features.qi_5, features.entry_qi5_sign);
  detail['qi_5_flip'] = qiFlip;

  const edgeFlip = signFlipped(features.microprice_edge_ticks, features.entry_microprice_edge_sign);
  detail['microprice_edge_flip'] = edgeFlip;

  // zOFI-250ms flip with magnitude gate.
  const zoFast = features.z_ofi_250ms;
  const zoFastFlipShape = signFlipped(zoFast, features.entry_z_ofi_250ms_sign);
  const zoFastMagOk =
    zoFast !== null && Number.isFinite(zoFast) && Math.abs(zoFast) >= config.zofi_250ms_reversal_min_abs;
  detail['z_ofi_250ms_flip_with_magnitude'] = zoFastFlipShape && zoFastMagOk;

  // Opposite-side hazard dominates same-side hazard.
  //
  // Entry captured `entry_hazard_diff = opp - same`. At exit time we
  // recompute `current_diff = hazard_opp_side - hazard_same_side` and
  // fire the signal when:
  //   (a) we had a positive entry_hazard_diff (opp > same at entry) —
  //       the trade was premised on the opposite side being softer —
  //       and now that gap has INVERTED (current_diff < 0 means same
  //       side is now weaker, contradicting the entry thesis).
  //   (b) OR we had a neutral/negative entry but now opp side dominates
  //       strongly (current_diff > entry_diff by a comfortable margin).
  //
  // Simpler operational form: fire when current_diff < entry_diff AND
  // current_diff < 0. That captures "hazard picture flipped against
  // us" without a magic magnitude constant.
  let hazardFlipped = false;
  if (
    features.hazard_opp_side !== null &&
    features.hazard_same_side !== null &&
    Number.isFinite(features.hazard_opp_side) &&
    Number.isFinite(features.hazard_same_side) &&
    features.entry_hazard_diff !== null &&
    Number.isFinite(features.entry_hazard_diff)
  ) {
    const currentDiff = features.hazard_opp_side - features.hazard_same_side;
    hazardFlipped = currentDiff < features.entry_hazard_diff && currentDiff < 0;
  }
  detail['hazard_flipped'] = hazardFlipped;

  // Spread widens >= config.spread_widen_min_ticks
  let spreadWidened = false;
  if (
    features.spread_ticks !== null &&
    features.entry_spread_ticks !== null &&
    Number.isFinite(features.spread_ticks) &&
    Number.isFinite(features.entry_spread_ticks)
  ) {
    spreadWidened = features.spread_ticks - features.entry_spread_ticks >= config.spread_widen_min_ticks;
  }
  detail['spread_widened'] = spreadWidened;

  // Absorption flip = same-side absorption that ANCHORED the entry is
  // gone. Fire when entry had healthy same-side absorption (> 0.5 is
  // a canonical threshold) and the current same-side absorption is
  // BELOW HALF of the entry value OR null. That indicates the queue
  // that was absorbing against us has collapsed.
  let absorptionFlipped = false;
  if (
    features.entry_abs_same_side !== null &&
    Number.isFinite(features.entry_abs_same_side) &&
    features.entry_abs_same_side >= 0.5
  ) {
    if (features.abs_same_side === null || !Number.isFinite(features.abs_same_side)) {
      absorptionFlipped = true;
    } else if (features.abs_same_side < features.entry_abs_same_side * 0.5) {
      absorptionFlipped = true;
    }
  }
  detail['absorption_flipped'] = absorptionFlipped;

  const count = [
    qiFlip,
    edgeFlip,
    detail['z_ofi_250ms_flip_with_magnitude'],
    hazardFlipped,
    spreadWidened,
    absorptionFlipped,
  ].filter(Boolean).length;

  return { count, detail, absorption_flipped: absorptionFlipped };
}

/**
 * The scalper exit engine. Stateless — every call reads the features
 * argument and returns a decision. The runner constructs one instance
 * per process (or per position — both are fine) and calls `evaluate`
 * on every scalper monitor tick.
 */
export class ScalperExitEngine {
  readonly config: ScalperExitEngineConfig;

  constructor(config: ScalperExitEngineConfig = DEFAULT_SCALPER_EXIT_ENGINE_CONFIG) {
    this.config = config;
  }

  /**
   * Evaluate the exit state machine for one scalper position. Returns a
   * `ScalperExitDecision` with `state` ∈ {'HOLD','EXIT_NOW'}.
   *
   * Defensive — every invalid input (null / non-finite / missing field)
   * returns HOLD with a diagnostic factor. The engine never throws.
   */
  evaluate(features: ScalperExitFeatures | null): ScalperExitDecision {
    if (!features) {
      return scalperHold({ error: 'null_features' });
    }

    // Clause 1: effective hard cap — unconditional, always first
    if (
      Number.isFinite(features.hold_ms) &&
      Number.isFinite(features.effective_hard_cap_sec) &&
      features.hold_ms >= features.effective_hard_cap_sec * 1000
    ) {
      return scalperExitNow(
        `hard_cap_reached hold_ms=${features.hold_ms} cap_sec=${features.effective_hard_cap_sec}`,
        'scalper_hard_cap',
        {
          hold_ms: features.hold_ms,
          effective_hard_cap_sec: features.effective_hard_cap_sec,
          extended: features.effective_hard_cap_sec > 5, // diagnostic — plan baseline 5s cap
          current_ticks_pnl: features.current_ticks_pnl,
        },
      );
    }

    // Clause 2: no progress (hold > threshold AND pnl < 1 tick)
    if (
      Number.isFinite(features.hold_ms) &&
      Number.isFinite(features.no_progress_trigger_ms) &&
      features.hold_ms >= features.no_progress_trigger_ms &&
      Number.isFinite(features.current_ticks_pnl) &&
      features.current_ticks_pnl < 1
    ) {
      return scalperExitNow(
        `no_progress hold_ms=${features.hold_ms} pnl_ticks=${features.current_ticks_pnl}`,
        'scalper_no_progress',
        {
          hold_ms: features.hold_ms,
          no_progress_trigger_ms: features.no_progress_trigger_ms,
          current_ticks_pnl: features.current_ticks_pnl,
        },
      );
    }

    // Clause 3: microstructure stop (current pnl ≤ -stop_ticks)
    if (
      Number.isFinite(features.current_ticks_pnl) &&
      Number.isFinite(features.stop_ticks) &&
      features.stop_ticks > 0 &&
      features.current_ticks_pnl <= -features.stop_ticks
    ) {
      return scalperExitNow(
        `stop_loss hit_ticks=${features.current_ticks_pnl} stop_ticks=${features.stop_ticks}`,
        'stop_loss',
        {
          current_ticks_pnl: features.current_ticks_pnl,
          stop_ticks: features.stop_ticks,
        },
      );
    }

    // Clause 4: target hit (current pnl ≥ target_ticks)
    //
    // Scalpers are atomic — single target, no partials. Uses the
    // `target_1` ExitReason enum to align with the trade record's
    // existing target labels even though for a scalp it's the one
    // and only target, not the first of a PT1/PT2 sequence.
    if (
      Number.isFinite(features.current_ticks_pnl) &&
      Number.isFinite(features.target_ticks) &&
      features.target_ticks > 0 &&
      features.current_ticks_pnl >= features.target_ticks
    ) {
      return scalperExitNow(
        `target_hit pnl_ticks=${features.current_ticks_pnl} target_ticks=${features.target_ticks}`,
        'target_1',
        {
          current_ticks_pnl: features.current_ticks_pnl,
          target_ticks: features.target_ticks,
        },
      );
    }

    // Clause 5: reversal (2-of-N signals flipped). The enum distinguishes:
    //   - `microstructure_edge_decay` when absorption flipped (the entry
    //     premise was absorbing supply on the trade side and now that
    //     absorption is gone), because absorption is the strongest
    //     structural driver of a scalper edge.
    //   - `scalper_reversal` otherwise (a generic 2-of-N reversal).
    const rev = countReversalSignals(features, this.config);
    if (rev.count >= this.config.reversal_signals_required) {
      const enumVal = rev.absorption_flipped ? 'microstructure_edge_decay' : 'scalper_reversal';
      return scalperExitNow(
        `reversal count=${rev.count} required=${this.config.reversal_signals_required}`,
        enumVal,
        {
          reversal_count: rev.count,
          reversal_required: this.config.reversal_signals_required,
          ...rev.detail,
        },
      );
    }

    // HOLD factors include the full reversal detail so operators
    // reading a per-tick log can see which signals were close to
    // firing — matches the Phase 5 "observable in logs" principle
    // applied to exit decisions.
    return scalperHold({
      hold_ms: features.hold_ms,
      current_ticks_pnl: features.current_ticks_pnl,
      reversal_count: rev.count,
      effective_hard_cap_sec: features.effective_hard_cap_sec,
      ...rev.detail,
    });
  }
}
