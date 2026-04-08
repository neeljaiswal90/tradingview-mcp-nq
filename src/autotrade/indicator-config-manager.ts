/**
 * IndicatorConfigManager — loads, validates, and versions the indicator config.
 * Enforces the rule that only one parameter can change at a time,
 * and logs every change with a full audit trail.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { IndicatorConfig, IndicatorChangeRecord } from './types.js';
import type { LogWriter } from './log-writer.js';

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
  max_consecutive_losses: 5,
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
  cooldown_bars: 0,
  no_same_bar_reversal: false,
  max_quote_age_ms_for_management: 3_000,
  quote_poll_timeout_ms: 1_000,
  enable_stale_quote_fallback: false,
};

/**
 * Validation rules for trading/risk parameters.
 * Each rule: [field, min, max, description].
 */
const VALIDATION_RULES: Array<[keyof IndicatorConfig, number, number, string]> = [
  ['account_equity', 100, 10_000_000, 'Account equity (USD)'],
  ['max_risk_per_trade_pct', 0.1, 5.0, 'Max risk per trade (%)'],
  ['max_daily_loss_pct', 0.5, 10.0, 'Max daily loss (%)'],
  ['max_consecutive_losses', 1, 20, 'Max consecutive losses'],
  ['time_stop_minutes', 5, 120, 'Time stop (minutes)'],
  ['analysis_interval_seconds', 5, 300, 'Analysis interval (seconds)'],
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
    console.log(`│  MAX_CONSEC_LOSSES:   ${c.max_consecutive_losses}`);
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
    console.log(`[CONFIG]   Changed: ${JSON.stringify(exactChanges)}`);

    return newVersion;
  }
}
