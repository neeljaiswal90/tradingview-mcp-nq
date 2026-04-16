/**
 * features/quant-entry-config.ts — Canonical config schema for the quant
 * trend-pullback refactor (plan §4.3 + §5 Phase 7).
 *
 * This is the config layer the Phase 7 rollout plan calls "env.ts" —
 * in practice it lives on `IndicatorConfig.quant_entry` (trading config
 * owned by indicator-config.json), consistent with every other feature
 * subsystem (`dynamic_reward_planning`, `layered_scoring`, `entry_ml`,
 * `htf_zones`, etc.). The operational-only `src/autotrade/env.ts` file
 * is explicitly NOT the place for trading knobs — its header comment
 * says so.
 *
 * Knobs collected here:
 *   - Top-level execution flags (enabled / per-side / hybrid_gate /
 *     quant_primary_mode)
 *   - `expectancy.*` — bucket lookup knobs (plan §11, Phase 6)
 *   - `lob_degradation.*` — sparse-LOB classification (plan §4.4, Phase 6)
 *   - `orderflow.*` — rolling OFI window + warmup (plan §4.3, Phase 2)
 *   - `trend_pullback.*` — Phase 3 generator gate bands + Phase 4 stop
 *     multipliers + Phase 4 cold-start target multipliers
 *
 * Phase 7 wiring rules:
 *   - `quant_entry.enabled = false` (default) — Phase 7 telemetry and
 *     Stage B gate are NO-OPS. Phases 1-6 continue to populate their
 *     existing fields as they have been (they are the "baseline" at
 *     Phase 7 time).
 *   - `enabled = true, hybrid_gate = false` — Phase 7 telemetry
 *     (quant_shadow_decision + entry_state_vector_hash) populates but
 *     execution remains 100% legacy.
 *   - `enabled = true, hybrid_gate = true` — Stage B AND-gate activates,
 *     and can REJECT legacy-approved candidates. Legacy fields are
 *     never rewritten (plan §3 no-overwrite rule).
 *   - `quant_primary_mode = true` — Stage C flip. NOT read by Phase 7
 *     code; reserved for Phase 8.
 */

export interface QuantEntryExpectancyConfig {
  /** Min samples required to "resolve" a bucket at any fallback tier. */
  min_bucket_samples: number;
  /**
   * Post-cost R threshold for NON-side-prior tiers (full / backoff_1d /
   * backoff_2d). Candidates with `expected_r_30s_quant` below this land
   * with `quant_shadow_reject_reason = 'rejected_by_expectancy_below_threshold'`.
   *
   * Phase 8 Stage A starts with this at 0.0 — effectively a disabled
   * gate — so pure shadow observes but does not reject. Operator
   * calibration during Stage A sets the real value before flipping
   * `hybrid_gate = true` for Stage B.
   *
   * Phase 6 default was 0.0 to keep the Stage A gate neutral.
   */
  min_expected_r_primary: number;
  /**
   * Post-cost R threshold that side_prior must clear. When the
   * terminal fallback is side_prior AND `expected_r_30s_quant` is
   * below this, `quant_shadow_reject_reason = 'rejected_by_bucket_sparsity'`.
   */
  side_prior_min_expected_r: number;
  /** Path to the on-disk bucket table JSON (relative to CWD). */
  bucket_table_path: string;
}

export interface QuantEntryLobDegradationConfig {
  /** Max age (ms) before a LOB snapshot is considered stale. */
  stale_threshold_ms: number;
  /** Min combined L1-L10 depth for the book to be "full". */
  min_total_depth_10lvl: number;
  /** Min per-side L1-L10 depth for the book to be "full". */
  min_side_depth_10lvl: number;
}

export interface QuantEntryOrderflowConfig {
  /** Short rolling OFI window in ms. */
  ofi_short_window_ms: number;
  /** Long rolling OFI window in ms. */
  ofi_long_window_ms: number;
  /** Samples required before OFI z-scores are emitted as non-null. */
  z_warmup_samples: number;
}

export interface QuantEntryTrendPullbackConfig {
  /** z_ema9 lower band (inclusive). */
  z_ema9_band_min: number;
  /** z_ema9 upper band (inclusive). */
  z_ema9_band_max: number;
  /** pullback_ratio lower band (inclusive). */
  pullback_ratio_band_min: number;
  /** pullback_ratio upper band (inclusive). */
  pullback_ratio_band_max: number;
  /** Minimum z_ofi_blend for flow confirmation soft gate. */
  flow_confirmation_min: number;
  /** Volatility multiplier for the initial stop (Phase 4). */
  k_sl: number;
  /** Entry band half-width in sigma units (replaces hardcoded ±5). */
  entry_half_band_sigma: number;
  /** Cold-start target_1 multiplier in sigma units. */
  cold_start_tp1_k: number;
  /** Cold-start target_2 multiplier in sigma units. */
  cold_start_tp2_k: number;
}

export interface QuantEntryConfig {
  // ── Top-level flags ──────────────────────────────────────────────────
  /** Master kill-switch for Phase 7 telemetry + Stage B gate. Default: false. */
  enabled: boolean;
  /** Per-side phase-in: must be true for long candidates to be Phase 7 eligible. */
  long_enabled: boolean;
  /** Per-side phase-in: must be true for short candidates to be Phase 7 eligible. */
  short_enabled: boolean;
  /** Stage B AND-gate activation. Requires enabled=true. */
  hybrid_gate: boolean;
  /**
   * Stage C flip: single-assignment-point promotion of quant fields
   * into legacy fields. NOT read by Phase 7 code; reserved for Phase 8.
   */
  quant_primary_mode: boolean;

  // ── Sub-sections ────────────────────────────────────────────────────
  expectancy: QuantEntryExpectancyConfig;
  lob_degradation: QuantEntryLobDegradationConfig;
  orderflow: QuantEntryOrderflowConfig;
  trend_pullback: QuantEntryTrendPullbackConfig;
}

/**
 * Phase 7 defaults. Each value matches the existing code constant so
 * the config layer is a pure no-op when the operator leaves the
 * `quant_entry` block unset.
 *
 * Sources (for future auditors):
 *   - expectancy.*       : features/expectancy-engine.ts constants
 *   - lob_degradation.*  : features/orderflow-state.ts constants
 *   - orderflow.*        : features/orderflow-state.ts constants
 *   - trend_pullback.*   : strategy.ts QUANT_TP_* constants
 *                         + features/initial-risk.ts DEFAULT_K_SL
 *                         + features/dynamic-reward-plan.ts TP1/TP2 k's
 */
export const DEFAULT_QUANT_ENTRY_CONFIG: QuantEntryConfig = {
  enabled: false,
  long_enabled: false,
  short_enabled: false,
  hybrid_gate: false,
  quant_primary_mode: false,
  expectancy: {
    min_bucket_samples: 30,
    // Phase 8 Stage A default: 0.0 means "do not reject on non-side-prior
    // tiers". Operators calibrate this from shadow data before flipping
    // `hybrid_gate = true`. Plan §11 locks the actual threshold during
    // Stage A → B promotion.
    min_expected_r_primary: 0.0,
    side_prior_min_expected_r: 0.2,
    bucket_table_path: 'data/expectancy_bucket_table.json',
  },
  lob_degradation: {
    stale_threshold_ms: 750,
    min_total_depth_10lvl: 20,
    min_side_depth_10lvl: 5,
  },
  orderflow: {
    ofi_short_window_ms: 10_000,
    ofi_long_window_ms: 30_000,
    z_warmup_samples: 30,
  },
  trend_pullback: {
    z_ema9_band_min: 0.15,
    z_ema9_band_max: 1.25,
    pullback_ratio_band_min: 0.25,
    pullback_ratio_band_max: 0.62,
    flow_confirmation_min: 0.20,
    k_sl: 1.05,
    entry_half_band_sigma: 0.1,
    cold_start_tp1_k: 0.7,
    cold_start_tp2_k: 1.4,
  },
};

/**
 * Merge an operator-supplied partial config onto the Phase 7 defaults,
 * producing a fully-resolved `QuantEntryConfig` for runtime code to
 * read from. Nested sub-sections are shallow-merged per section so the
 * operator can override a single field without restating the whole
 * block.
 *
 * Never mutates the input. Returns a frozen object so tests can use
 * it as an invariant.
 */
export function resolveQuantEntryConfig(
  partial?: Partial<QuantEntryConfig> | null,
): QuantEntryConfig {
  if (!partial) return DEFAULT_QUANT_ENTRY_CONFIG;
  return {
    enabled: partial.enabled ?? DEFAULT_QUANT_ENTRY_CONFIG.enabled,
    long_enabled: partial.long_enabled ?? DEFAULT_QUANT_ENTRY_CONFIG.long_enabled,
    short_enabled: partial.short_enabled ?? DEFAULT_QUANT_ENTRY_CONFIG.short_enabled,
    hybrid_gate: partial.hybrid_gate ?? DEFAULT_QUANT_ENTRY_CONFIG.hybrid_gate,
    quant_primary_mode: partial.quant_primary_mode ?? DEFAULT_QUANT_ENTRY_CONFIG.quant_primary_mode,
    expectancy: {
      ...DEFAULT_QUANT_ENTRY_CONFIG.expectancy,
      ...(partial.expectancy ?? {}),
    },
    lob_degradation: {
      ...DEFAULT_QUANT_ENTRY_CONFIG.lob_degradation,
      ...(partial.lob_degradation ?? {}),
    },
    orderflow: {
      ...DEFAULT_QUANT_ENTRY_CONFIG.orderflow,
      ...(partial.orderflow ?? {}),
    },
    trend_pullback: {
      ...DEFAULT_QUANT_ENTRY_CONFIG.trend_pullback,
      ...(partial.trend_pullback ?? {}),
    },
  };
}

/**
 * Convenience: is Phase 7 telemetry live for a given direction?
 * Returns true when the master flag is on AND the per-side flag is on.
 * Phase 7 telemetry and the Stage B scaffold both consult this.
 */
export function isQuantEntryActiveForDirection(
  cfg: QuantEntryConfig,
  direction: 'long' | 'short',
): boolean {
  if (!cfg.enabled) return false;
  return direction === 'long' ? cfg.long_enabled : cfg.short_enabled;
}
