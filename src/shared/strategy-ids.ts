/**
 * strategy-ids.ts — canonical list of strategy IDs.
 *
 * Lightweight, no runtime dependencies. `SetupType` is derived from this
 * list so every other module (generators, registry, profiles, tests) can
 * import IDs from here without pulling in the full runtime registry. This
 * split exists specifically to avoid circular imports between the type
 * layer and the registry that references generator functions.
 *
 * Phase 2 refactor: `or_retest_continuation_long` and
 * `or_retest_continuation_short` were removed from this list — their
 * types/family/profile were declared but no generator existed, so they
 * could never run at runtime. See reports/strategies/deprecated_strategies.md.
 */

export const STRATEGY_IDS = [
  'trend_pullback_long',
  'trend_pullback_short',
  'post_flip_first_pullback_short',
  'breakout_retest_long',
  'breakdown_retest_short',
  'opening_drive_continuation_long',
  'opening_drive_continuation_short',
  'failed_or_break_long',
  'failed_or_break_short',
  'momentum_continuation',
  // ── lob_mbo_scalp family (Phase 3a: registered as shadow with stub generator) ──
  // The real generator is wired in Phase 3b after the contamination firewall
  // lands. Until then the stub always returns "no candidate" so registration
  // is a runtime no-op.
  'lob_mbo_scalp_long',
  'lob_mbo_scalp_short',
] as const;

export type SetupType = typeof STRATEGY_IDS[number];

/** Type guard — use when narrowing arbitrary strings to SetupType. */
export function isKnownSetupType(s: string): s is SetupType {
  return (STRATEGY_IDS as readonly string[]).includes(s);
}
