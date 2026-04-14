/**
 * IndicatorConfigManager — loads, validates, and versions the indicator config.
 * Enforces the rule that only one parameter can change at a time,
 * and logs every change with a full audit trail.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { IndicatorConfig, IndicatorChangeRecord } from './types.js';
import type { LogWriter } from './log-writer.js';
import { DEFAULT_POSITION_TARGET_CONFIG } from './target-position.js';

/**
 * DEFAULT_CONFIG must stay in sync with config/indicator-config.json.
 * These defaults are used ONLY when the config file is missing or a field
 * is absent. The config file is the CANONICAL source of truth for ALL
 * strategy, risk, and trading parameters. Env vars do NOT override these.
 *
 * Config Precedence (highest → lowest):
 *   1. indicator-config.json (canonical — editable by user)
 *   2. DEFAULT_CONFIG below (fallback for missing fields only)
 *
 * Operational settings (mode, symbol, log_dir, adapter selection)
 * are separate — see env.ts.
 */
const DEFAULT_CONFIG: IndicatorConfig = {
  version: 'IC_v1.0_BASELINE_NQ',
  type: 'BASELINE',
  created_at: new Date().toISOString(),
  ema_fast: 9,
  ema_mid: 21,
  ema_slow: 50,
  rsi_period: 14,
  atr_period: 14,
  volume_sma_period: 20,
  min_confidence: 7.5,
  max_confidence: 10,
  min_rr: 2,
  max_risk_per_trade_pct: 1.5,
  max_daily_loss_pct: 1.5,
  account_equity: 25_000,
  time_stop_minutes: 30,
  time_stop_max_r_pre_t1: 0.25,
  time_stop_max_r_post_t1: 1.0,
  analysis_interval_seconds: 5,
  in_position_monitor_seconds: 2,
  opening_range_minutes: 15,
  trail_ticks_post_t1: 12,
  breakeven_trigger_r: 0.5,
  pre_t1_trail_trigger_r: 0.75,
  pre_t1_trail_distance_ticks: 20,
  pt1_offset_pts: 6,
  pt2_offset_pts: 15,
  pt1_exit_fraction: 0.5,
  pt2_exit_fraction: 0.25,
  pt1_move_to_be: true,
  pt1_activate_trailing: true,
  enable_momentum_continuation: false,
  enable_opening_drive: true,
  enable_failed_or_break: true,
  dual_min_score: 7.5,
  dual_score_margin: 1.0,
  dual_choppy_extra_margin: 0.5,
  startup_backfill_minutes: 60,
  cycle_stall_threshold_ms: 15_000,
  cycle_cusum_k: 0.5,
  cycle_cusum_h: 5.0,
  cycle_cusum_baseline_samples: 60,
  enable_post_flip_first_pullback_short: false,
  post_flip_first_pullback_short_max_retest_atr: 0.20,
  directional_freshness: {
    enabled: true,
    long_vwap_mode: 'hard',
    short_vwap_mode: 'hard',
    short_above_vwap_allowance_session_atr: 0.35,
    short_above_vwap_penalty: 0.4,
    require_5m_structure: true,
    require_supertrend_or_ema21_exception: true,
    short_above_vwap_penalty_midpoint_atr: 0.20,
    short_above_vwap_penalty_slope_atr: 0.08,
  },
  session_score_overrides: {},
  session_selection_floor_overrides: {},
  scoring_weights: {
    htf_conflict_transition_relief: 0.35,
    reversal_transition_bonus: 0.2,
    contextual_positive_cap: 0.5,
    reversal_bonus_peak_bars_since_flip: 7,
    reversal_bonus_sigma_bars: 3,
  },
  cooldown_bars: 0,
  no_same_bar_reversal: false,
  max_quote_age_ms_for_management: 3_000,
  quote_poll_timeout_ms: 1_000,
  htf_zones: {
    enabled: true,
    study_filter: 'APP HTF Pivot Zones',
    max_labels: 200,
    hard_veto_enabled: false,
    hard_veto_timeframes: ['60', '240'],
    min_first_obstacle_rr: 0.8,
    warn_distance_atr: 0.75,
    hard_veto_inside_major_zone: true,
    allow_breakout_acceptance_override: true,
    score_penalty_15m_res: -0.4,
    score_penalty_1h_res: -0.75,
    score_penalty_4h_res: -1.0,
    score_penalty_obstacle_before_t1: -1.25,
    score_bonus_near_support: 0.25,
    score_bonus_reclaimed_support: 0.5,
  },
  position_target: DEFAULT_POSITION_TARGET_CONFIG,
};

/**
 * Validation rules for trading/risk parameters.
 * Each rule: [field, min, max, description].
 */
const VALIDATION_RULES: Array<[keyof IndicatorConfig, number, number, string]> = [
  ['account_equity', 100, 10_000_000, 'Account equity (USD)'],
  ['max_risk_per_trade_pct', 0.1, 5.0, 'Max risk per trade (%)'],
  ['max_daily_loss_pct', 0.5, 10.0, 'Max daily loss (%)'],
  ['time_stop_minutes', 5, 120, 'Time stop (minutes)'],
  ['analysis_interval_seconds', 5, 300, 'Analysis interval (seconds)'],
  ['startup_backfill_minutes', 5, 480, 'Startup backfill minutes'],
  ['min_confidence', 1, 10, 'Min confidence threshold'],
  ['min_rr', 0.5, 10, 'Min reward:risk ratio'],
  ['opening_range_minutes', 5, 60, 'Opening range window (minutes)'],
  ['trail_ticks_post_t1', 0, 100, 'Trailing stop ticks post-T1'],
  ['breakeven_trigger_r', 0, 5, 'Pre-T1 breakeven trigger (R)'],
  ['pre_t1_trail_trigger_r', 0, 5, 'Pre-T1 trailing trigger (R)'],
  ['pre_t1_trail_distance_ticks', 0, 200, 'Pre-T1 trailing distance (ticks)'],
  ['dual_min_score', 1, 10, 'Dual-direction min score'],
  ['dual_score_margin', 0, 5, 'Dual-direction score margin'],
  ['pt1_offset_pts', 0, 100, 'PT1 offset (points)'],
  ['pt2_offset_pts', 0, 200, 'PT2 offset (points)'],
  ['pt1_exit_fraction', 0, 1, 'PT1 exit fraction'],
  ['pt2_exit_fraction', 0, 1, 'PT2 exit fraction'],
  ['max_quote_age_ms_for_management', 500, 30_000, 'Max quote age for management (ms)'],
  ['quote_poll_timeout_ms', 100, 5_000, 'Quote poll timeout (ms)'],
  ['cycle_stall_threshold_ms', 5_000, 3_600_000, 'Cycle stall threshold (ms)'],
];

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class IndicatorConfigManager {
  private config: IndicatorConfig;
  private readonly configPath: string;
  private changeSeq: number = 0;
  /** True if config was loaded from file; false if using defaults. */
  readonly loadedFromFile: boolean;

  constructor(configDir: string = './config') {
    this.configPath = join(configDir, 'indicator-config.json');
    const result = this.load();
    this.config = result.config;
    this.loadedFromFile = result.fromFile;
  }

  getConfig(): Readonly<IndicatorConfig> {
    return { ...this.config };
  }

  /**
   * Validate the loaded config. Returns errors for out-of-range values
   * and warnings for suspicious but acceptable values.
   */
  validate(): ConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const [field, min, max, desc] of VALIDATION_RULES) {
      const val = this.config[field];
      if (typeof val !== 'number') continue;
      if (val < min || val > max) {
        errors.push(`${desc} (${field}): ${val} is outside valid range [${min}, ${max}]`);
      }
    }

    // Warn on suspicious but valid combinations
    if (this.config.max_risk_per_trade_pct > 2.0) {
      warnings.push(`max_risk_per_trade_pct=${this.config.max_risk_per_trade_pct}% is aggressive (>2%)`);
    }
    if (this.config.min_rr < 1.5) {
      warnings.push(`min_rr=${this.config.min_rr} is below recommended minimum of 1.5`);
    }
    if (this.config.max_daily_loss_pct > 3.0) {
      warnings.push(`max_daily_loss_pct=${this.config.max_daily_loss_pct}% is aggressive (>3%)`);
    }

    // Validate scoring_weights if present
    const sw = this.config.scoring_weights;
    if (sw) {
      for (const [key, val] of Object.entries(sw)) {
        if (typeof val !== 'number') {
          errors.push(`scoring_weights.${key}: expected number, got ${typeof val}`);
        } else if (val < -10 || val > 10) {
          warnings.push(`scoring_weights.${key}=${val} is outside typical range [-10, 10]`);
        }
      }
    }

    // Validate management_profiles if present
    const mp = this.config.management_profiles;
    if (mp) {
      for (const [family, profile] of Object.entries(mp)) {
        const pfx = `management_profiles.${family}`;
        if (profile.pt1_offset_atr < 0 || profile.pt1_offset_atr > 5) {
          errors.push(`${pfx}.pt1_offset_atr: ${profile.pt1_offset_atr} outside [0, 5]`);
        }
        if (profile.pt2_offset_atr < 0 || profile.pt2_offset_atr > 10) {
          errors.push(`${pfx}.pt2_offset_atr: ${profile.pt2_offset_atr} outside [0, 10]`);
        }
        if (profile.pt1_offset_atr > 0 && profile.pt2_offset_atr > 0 && profile.pt2_offset_atr <= profile.pt1_offset_atr) {
          errors.push(`${pfx}: pt2_offset_atr (${profile.pt2_offset_atr}) must exceed pt1_offset_atr (${profile.pt1_offset_atr})`);
        }
        if (profile.pt1_exit_fraction + profile.pt2_exit_fraction > 0.95) {
          errors.push(`${pfx}: pt1+pt2 exit fractions sum to ${profile.pt1_exit_fraction + profile.pt2_exit_fraction} (max 0.95)`);
        }
        if (profile.trail_atr_post_t1 < 0 || profile.trail_atr_post_t1 > 3) {
          errors.push(`${pfx}.trail_atr_post_t1: ${profile.trail_atr_post_t1} outside [0, 3]`);
        }
        if (profile.time_stop_minutes < 5 || profile.time_stop_minutes > 120) {
          errors.push(`${pfx}.time_stop_minutes: ${profile.time_stop_minutes} outside [5, 120]`);
        }
      }
    }

    // Validate position_target if present
    const pt = this.config.position_target;
    if (pt) {
      if (pt.hard_cap < 1 || pt.hard_cap > 100) {
        errors.push(`position_target.hard_cap: ${pt.hard_cap} outside [1, 100]`);
      }
      if (pt.soft_cap_base < 1 || pt.soft_cap_base > 100) {
        errors.push(`position_target.soft_cap_base: ${pt.soft_cap_base} outside [1, 100]`);
      }
      if (pt.min_confidence_for_full_size < 0 || pt.min_confidence_for_full_size > 1) {
        errors.push(`position_target.min_confidence_for_full_size: ${pt.min_confidence_for_full_size} outside [0, 1]`);
      }
      if (pt.management_reduce_min_delta < 1) {
        errors.push(`position_target.management_reduce_min_delta: must be >= 1`);
      }
      if (pt.management_reduce_cooldown_sec < 0) {
        errors.push(`position_target.management_reduce_cooldown_sec: must be >= 0`);
      }
      if (pt.reduce_large_delta_threshold < pt.management_reduce_min_delta) {
        errors.push(
          `position_target.reduce_large_delta_threshold (${pt.reduce_large_delta_threshold}) must be >= management_reduce_min_delta (${pt.management_reduce_min_delta})`,
        );
      }
      if (pt.reduce_persistence_cycles_small_delta < 1) {
        errors.push(`position_target.reduce_persistence_cycles_small_delta: must be >= 1`);
      }
      if (pt.min_residual_contracts < 0) {
        errors.push(`position_target.min_residual_contracts: must be >= 0`);
      }
      if (pt.max_target_reduce_per_cycle < 1) {
        errors.push(`position_target.max_target_reduce_per_cycle: must be >= 1`);
      }
      if (pt.stop_widening_allowed) {
        warnings.push(
          `position_target.stop_widening_allowed=true is not supported in V1a — target-position math may react unpredictably to stop widening`,
        );
      }
      // Regime factors must include 'default' and be finite numbers in [0, 2]
      if (!pt.regime_factors || typeof pt.regime_factors.default !== 'number') {
        errors.push(`position_target.regime_factors: missing 'default' fallback`);
      } else {
        for (const [key, val] of Object.entries(pt.regime_factors)) {
          if (typeof val !== 'number' || !Number.isFinite(val)) {
            errors.push(`position_target.regime_factors.${key}: expected number, got ${typeof val}`);
          } else if (val < 0 || val > 2) {
            warnings.push(`position_target.regime_factors.${key}=${val} outside typical [0, 2]`);
          }
        }
      }
      if (!pt.session_factors || typeof pt.session_factors.default !== 'number') {
        errors.push(`position_target.session_factors: missing 'default' fallback`);
      } else {
        for (const [key, val] of Object.entries(pt.session_factors)) {
          if (typeof val !== 'number' || !Number.isFinite(val)) {
            errors.push(`position_target.session_factors.${key}: expected number, got ${typeof val}`);
          } else if (val < 0 || val > 2) {
            warnings.push(`position_target.session_factors.${key}=${val} outside typical [0, 2]`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Print the effective trading config to stdout. Excludes secrets.
   * Call this at startup after loading config to make the active
   * parameter set fully transparent.
   */
  printEffectiveConfig(): void {
    const c = this.config;
    const source = this.loadedFromFile ? this.configPath : 'DEFAULT_CONFIG (no file found)';
    const riskBudget = (c.account_equity * c.max_risk_per_trade_pct / 100).toFixed(2);
    console.log('┌─ Trading Config (canonical: indicator-config.json) ──');
    console.log(`│  SOURCE:              ${source}`);
    console.log(`│  VERSION:             ${c.version}`);
    console.log(`│  ACCOUNT_EQUITY:      $${c.account_equity.toLocaleString()}`);
    console.log(`│  MAX_RISK_PCT:        ${c.max_risk_per_trade_pct}%  →  risk_budget=$${riskBudget}`);
    console.log(`│  MAX_DAILY_LOSS_PCT:  ${c.max_daily_loss_pct}%`);
    console.log(`│  MIN_CONFIDENCE:      ${c.min_confidence}`);
    console.log(`│  TIME_STOP:           ${c.time_stop_minutes}min`);
    console.log(`│  ANALYSIS_INTERVAL:   ${c.analysis_interval_seconds}s`);
    console.log(`│  OPENING_RANGE:       ${c.opening_range_minutes}min`);
    console.log(`│  DUAL_MIN_SCORE:      ${c.dual_min_score}`);
    console.log(`│  DUAL_MARGIN:         ${c.dual_score_margin}`);

    // ── Dynamic Reward Planning ──────────────────────────────────────────
    const drp = c.dynamic_reward_planning;
    const drpEnabled = drp?.enabled !== false; // default true when absent
    if (drpEnabled) {
      const baselines = drp?.family_baselines ?? {
        trend_pullback: 1.6, breakout_retest: 1.7, opening_drive: 1.5,
        failed_or_break: 1.8, default: 1.8,
      };
      const floor = drp?.rr_floor ?? 1.3;
      const ceiling = drp?.rr_ceiling ?? 3.0;
      console.log(`├─ Dynamic Reward Planning (ACTIVE) ────────────────────`);
      console.log(`│  RR_FLOOR:            ${floor}`);
      console.log(`│  RR_CEILING:          ${ceiling}`);
      console.log(`│  LEGACY_MIN_RR:       ${c.min_rr} (fallback only)`);
      const familyStrs = Object.entries(baselines)
        .map(([f, v]) => `${f}=${v}`)
        .join(' ');
      console.log(`│  BASELINES:           ${familyStrs}`);
    } else {
      console.log(`├─ Dynamic Reward Planning (DISABLED) ───────────────────`);
      console.log(`│  MIN_RR:              ${c.min_rr} (legacy fixed gate)`);
    }

    // ── Microstructure Overlay ────────────────────────────────────────────
    const micro = c.microstructure_overlay;
    const microEnabled = micro?.enabled !== false; // default true when absent
    console.log(`├─ Microstructure Overlay (${microEnabled ? 'ACTIVE' : 'DISABLED'}) ─────────────────`);
    if (microEnabled) {
      console.log(`│  MULTIPLIER:          ${micro?.multiplier ?? 0.5}`);
      console.log(`│  MIN_DATA_QUALITY:    ${micro?.require_min_data_quality ?? 'minimal'}`);
    }

    // ── Management ───────────────────────────────────────────────────────
    console.log(`├─ Trade Management ────────────────────────────────────`);
    console.log(`│  TRAIL_TICKS_POST_T1: ${c.trail_ticks_post_t1}`);
    console.log(`│  BE_TRIGGER_R:        ${c.breakeven_trigger_r}`);
    console.log(`│  PRE_T1_TRAIL_R:      ${c.pre_t1_trail_trigger_r}`);
    console.log(`│  PRE_T1_TRAIL_TICKS:  ${c.pre_t1_trail_distance_ticks}`);
    console.log(`│  PT1_EXIT_FRACTION:   ${c.pt1_exit_fraction}`);
    console.log(`│  PT2_EXIT_FRACTION:   ${c.pt2_exit_fraction}`);
    console.log(`│  PT1_MOVE_TO_BE:      ${c.pt1_move_to_be}`);
    console.log(`│  PT1_ACTIVATE_TRAIL:  ${c.pt1_activate_trailing}`);

    // Management profiles summary
    if (c.management_profiles) {
      const profiles = Object.entries(c.management_profiles);
      console.log(`├─ Management Profiles (${profiles.length}) ─────────────────────`);
      for (const [family, p] of profiles) {
        console.log(
          `│  ${family.padEnd(22)} PT1=${p.pt1_offset_atr}×ATR PT2=${p.pt2_offset_atr}×ATR ` +
          `Trail=${p.trail_atr_post_t1}×ATR TS=${p.time_stop_minutes}min`,
        );
      }
    } else {
      console.log('│  MANAGEMENT_PROFILES: none (using flat config as default)');
    }
    console.log('└──────────────────────────────────────────────────────');
  }

  private load(): { config: IndicatorConfig; fromFile: boolean } {
    if (!existsSync(this.configPath)) {
      console.log(`[CONFIG] No config found at ${this.configPath} — using defaults`);
      return { config: { ...DEFAULT_CONFIG }, fromFile: false };
    }
    try {
      const raw = readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<IndicatorConfig>;
      // Merge with defaults to handle missing fields
      return { config: { ...DEFAULT_CONFIG, ...parsed }, fromFile: true };
    } catch (err) {
      console.error('[CONFIG] Failed to parse indicator-config.json — using defaults:', err);
      return { config: { ...DEFAULT_CONFIG }, fromFile: false };
    }
  }

  save(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      console.error('[CONFIG] Failed to save config:', err);
    }
  }

  /**
   * Apply a controlled config change. Logs the change and bumps the version.
   * Only one "family" of parameters can change at a time (enforced by caller intent).
   */
  applyChange(
    paramChanges: Partial<IndicatorConfig>,
    reason: string,
    hypothesis: string,
    sampleSize: number,
    perfSummary: string,
    logWriter: LogWriter,
  ): string {
    const prevConfig = { ...this.config };
    const prevVersion = this.config.version;

    // Build exact diff
    const exactChanges: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(paramChanges)) {
      const key = k as keyof IndicatorConfig;
      if (prevConfig[key] !== v) {
        exactChanges[k] = { from: prevConfig[key], to: v };
      }
    }

    if (Object.keys(exactChanges).length === 0) {
      console.log('[CONFIG] No effective changes detected.');
      return prevVersion;
    }

    // Bump version
    this.changeSeq++;
    const newVersion = `IC_v${1 + Math.floor(this.changeSeq / 10)}.${this.changeSeq}_${paramChanges.type ?? this.config.type}`;
    const newConfig: IndicatorConfig = {
      ...this.config,
      ...paramChanges,
      version: newVersion,
      created_at: new Date().toISOString(),
    };

    const changeRecord: IndicatorChangeRecord = {
      change_id: `CHANGE_${Date.now()}_${this.changeSeq}`,
      timestamp: new Date().toISOString(),
      previous_version: prevVersion,
      new_version: newVersion,
      previous_config: prevConfig,
      new_config: newConfig,
      exact_parameter_changes: exactChanges,
      reason,
      sample_size_at_change: sampleSize,
      recent_performance_summary: perfSummary,
      expected_improvement_hypothesis: hypothesis,
      baseline_preserving: (paramChanges.type ?? this.config.type) === 'BASELINE',
      review_due_after_n_trades: 20,
    };

    logWriter.writeIndicatorChange(changeRecord);
    this.config = newConfig;
    this.save();

    console.log(`[CONFIG] 🔄 Config updated: ${prevVersion} → ${newVersion}`);
    return newVersion;
  }
}
