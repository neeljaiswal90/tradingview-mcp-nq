/**
 * strategy-registry.ts — types + helpers for the canonical strategy registry.
 *
 * The actual STRATEGY_REGISTRY array (with generator function references)
 * lives in src/autotrade/strategy.ts because the generator functions are
 * defined there. This split exists specifically to avoid a circular import
 * between strategy.ts (which would otherwise import from here) and this
 * file (which would otherwise import the generators).
 *
 * Phase 2 of the scoring refactor. See docs at the top of strategy.ts for
 * how the registry is used, and reports/strategies/strategy_inventory_latest.md
 * for the current inventory.
 *
 * Status semantics:
 *   - active     → fully wired; can win compareSides and execute
 *   - shadow     → generator runs, candidate is scored and ranked, can win
 *                  compareSides for telemetry purposes, but the final
 *                  execution eligibility step in runner.ts blocks it
 *                  (execution_allowed_final = false, shadow_reason set)
 *   - disabled   → generator is not called at all
 *   - deprecated → reserved state for entries we want to keep typed but
 *                  blocked; currently unused
 *
 * IMPORTANT: compareSides() does NOT filter by registry status. Shadow
 * strategies must traverse the entire scoring and telemetry path so their
 * candidates are directly comparable to active ones in the calibration
 * report. The status gate lives only in runner.ts at the execution
 * eligibility step.
 */

import type { SetupType } from '../shared/strategy-ids.js';
import type {
  SetupFamily,
  IndicatorConfig,
  MarketSnapshot,
} from './types.js';
import type { LobSnapshot } from './lob-client.js';

// Forward-declared structural type — matches strategy.ts GeneratorEvaluation.
// Kept structural (not imported) to avoid a circular dep with strategy.ts.
export interface StrategyGeneratorEvaluation {
  setupType: SetupType;
  setupFamily: SetupFamily;
  candidate: unknown;
  rejectionReasonPrimary: string | null;
  rejectionReasonAll: string[];
}

export type StrategyStatus = 'active' | 'shadow' | 'disabled' | 'deprecated';

export interface StrategyDefinition {
  strategy_id: SetupType;
  family: SetupFamily;
  direction: 'long' | 'short';
  status: StrategyStatus;
  /** ML model reference, null = rules-only */
  entry_model: string | null;
  /** score profile key used by layered/score-v2 systems */
  score_profile: string;
  /** documentation-only list of hard gates */
  hard_gates: string[];
  /**
   * Invokes the strategy generator against the current snapshot.
   *
   * The `lobSnapshot` arg is optional: existing trend-family generators
   * ignore it (their 2-arg signature is assignable to this 3-arg type via
   * TypeScript function variance). The lob_mbo_scalp family requires it
   * and returns a null-candidate rejection when it is missing.
   */
  generator: (
    snap: MarketSnapshot,
    config: IndicatorConfig,
    lobSnapshot?: LobSnapshot | null,
  ) => StrategyGeneratorEvaluation;
  /**
   * Reporting-only metadata flag. When true, this strategy is part of the
   * non-primary baseline group retained for paper-vs-shadow comparison
   * during the quant trend-pullback refactor. Does not affect execution
   * eligibility, status, or registration — it exists purely so reporting
   * can separate primary-quant candidates from baseline candidates.
   */
  non_primary_baseline?: boolean;
  notes?: string;
}

// ── Status helpers ─────────────────────────────────────────────────────────

/**
 * Apply config soft overrides on top of the registry status. The existing
 * `enable_*` boolean config flags are kept as soft overrides that can
 * demote a registry entry from `active` to `disabled` but cannot promote.
 * This is a one-release compatibility shim — the flags will be removed
 * once the registry is the canonical source.
 */
export function effectiveStatus(
  def: StrategyDefinition,
  config: IndicatorConfig,
): StrategyStatus {
  const flags = config as unknown as {
    enable_opening_drive?: boolean;
    enable_failed_or_break?: boolean;
    enable_momentum_continuation?: boolean;
    enable_post_flip_first_pullback_short?: boolean;
  };

  // Config can only demote from active, never promote shadow/disabled.
  if (def.status !== 'active') return def.status;

  if (
    (def.family === 'opening_drive' && flags.enable_opening_drive === false) ||
    (def.family === 'failed_or_break' && flags.enable_failed_or_break === false) ||
    (def.family === 'momentum_continuation' && flags.enable_momentum_continuation === false) ||
    (def.strategy_id === 'post_flip_first_pullback_short' &&
      flags.enable_post_flip_first_pullback_short === false)
  ) {
    return 'disabled';
  }
  return 'active';
}

/** Strategies whose generator should run. active + shadow. */
export function listRunnableStrategies(
  registry: readonly StrategyDefinition[],
  config: IndicatorConfig,
): StrategyDefinition[] {
  return registry.filter((s) => {
    const status = effectiveStatus(s, config);
    return status === 'active' || status === 'shadow';
  });
}

/**
 * True if a given setup is allowed to actually execute (i.e. effective
 * status is 'active'). Called in runner.ts at the final execution
 * eligibility step to decide execution_allowed_final for each winner.
 */
export function isExecutable(
  def: StrategyDefinition | undefined,
  config: IndicatorConfig,
): boolean {
  if (!def) return false;
  return effectiveStatus(def, config) === 'active';
}

// ── Registry snapshot artifact ─────────────────────────────────────────────

export interface RegistrySnapshot {
  written_at: string;
  total: number;
  active: number;
  shadow: number;
  disabled: number;
  deprecated: number;
  strategies: Array<{
    strategy_id: string;
    family: string;
    direction: string;
    status: StrategyStatus;
    effective_status: StrategyStatus;
    score_profile: string;
    notes?: string;
  }>;
}

export function buildRegistrySnapshot(
  registry: readonly StrategyDefinition[],
  config: IndicatorConfig,
): RegistrySnapshot {
  const rows = registry.map((s) => ({
    strategy_id: s.strategy_id,
    family: s.family,
    direction: s.direction,
    status: s.status,
    effective_status: effectiveStatus(s, config),
    score_profile: s.score_profile,
    notes: s.notes,
  }));
  const counts = { active: 0, shadow: 0, disabled: 0, deprecated: 0 };
  for (const r of rows) counts[r.effective_status]++;
  return {
    written_at: new Date().toISOString(),
    total: rows.length,
    ...counts,
    strategies: rows,
  };
}
