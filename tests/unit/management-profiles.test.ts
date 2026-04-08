import { describe, it, expect } from 'vitest';
import {
  getSetupFamily,
  getManagementProfile,
  resolveProfile,
  buildDefaultProfileFromConfig,
} from '../../src/autotrade/management-profiles.js';
import { PositionManager } from '../../src/autotrade/position-manager.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';
import type {
  SetupType,
  IndicatorConfig,
  ManagementProfile,
  ResolvedManagementParams,
} from '../../src/autotrade/types.js';
import type { OrderResult } from '../../src/autotrade/execution.js';

const MNQ = getContractSpec('MNQ');

const BASE_CFG: IndicatorConfig = {
  version: 'TEST', type: 'BASELINE', created_at: '2026-01-01T00:00:00Z',
  ema_fast: 9, ema_mid: 21, ema_slow: 50,
  rsi_period: 14, atr_period: 14, volume_sma_period: 20,
  min_confidence: 7.5, max_confidence: 10, min_rr: 2.0,
  max_risk_per_trade_pct: 0.5, max_daily_loss_pct: 1.5, max_consecutive_losses: 5,
  account_equity: 25_000, time_stop_minutes: 30,
  time_stop_max_r_pre_t1: 0.25, time_stop_max_r_post_t1: 1.0,
  analysis_interval_seconds: 20, in_position_monitor_seconds: 2,
  opening_range_minutes: 15, trail_ticks_post_t1: 12,
  breakeven_trigger_r: 0.5, pre_t1_trail_trigger_r: 0.75, pre_t1_trail_distance_ticks: 20,
  pt1_offset_pts: 6, pt2_offset_pts: 15,
  pt1_exit_fraction: 0.5, pt2_exit_fraction: 0.25,
  pt1_move_to_be: true, pt1_activate_trailing: true,
  enable_momentum_continuation: false, enable_opening_drive: true, enable_failed_or_break: true,
  dual_min_score: 7.5, dual_score_margin: 1.0, dual_choppy_extra_margin: 0.5,
  cooldown_bars: 3, no_same_bar_reversal: true,
};

const TREND_PROFILE: ManagementProfile = {
  name: 'trend_pullback',
  family: 'trend_pullback',
  pt1_offset_atr: 0.5,
  pt2_offset_atr: 1.2,
  pt1_offset_pts_fallback: 6,
  pt2_offset_pts_fallback: 15,
  pt1_exit_fraction: 0.5,
  pt2_exit_fraction: 0.25,
  pt1_move_to_be: true,
  pt1_activate_trailing: true,
  trail_atr_post_t1: 0.3,
  trail_ticks_post_t1_fallback: 12,
  breakeven_trigger_r: 0.5,
  pre_t1_trail_trigger_r: 0.75,
  pre_t1_trail_atr: 0.4,
  pre_t1_trail_ticks_fallback: 20,
  time_stop_minutes: 30,
  time_stop_max_r_pre_t1: 0.25,
  time_stop_max_r_post_t1: 1.0,
};

const OPENING_DRIVE_PROFILE: ManagementProfile = {
  name: 'opening_drive',
  family: 'opening_drive',
  pt1_offset_atr: 0.7,
  pt2_offset_atr: 1.5,
  pt1_offset_pts_fallback: 8,
  pt2_offset_pts_fallback: 18,
  pt1_exit_fraction: 0.6,
  pt2_exit_fraction: 0.2,
  pt1_move_to_be: true,
  pt1_activate_trailing: true,
  trail_atr_post_t1: 0.4,
  trail_ticks_post_t1_fallback: 16,
  breakeven_trigger_r: 0.4,
  pre_t1_trail_trigger_r: 0.6,
  pre_t1_trail_atr: 0.5,
  pre_t1_trail_ticks_fallback: 18,
  time_stop_minutes: 20,
  time_stop_max_r_pre_t1: 0.2,
  time_stop_max_r_post_t1: 0.8,
};

// ── 1. Setup family mapping ────────────────────────────────────────────────

describe('getSetupFamily', () => {
  it('maps all 11 SetupType values to non-default families', () => {
    const allSetupTypes: SetupType[] = [
      'trend_pullback_long', 'trend_pullback_short',
      'breakout_retest_long', 'breakdown_retest_short',
      'momentum_continuation',
      'opening_drive_continuation_long', 'opening_drive_continuation_short',
      'or_retest_continuation_long', 'or_retest_continuation_short',
      'failed_or_break_short', 'failed_or_break_long',
    ];
    for (const st of allSetupTypes) {
      const family = getSetupFamily(st);
      expect(family).not.toBe('default');
      expect(typeof family).toBe('string');
    }
  });

  it('maps long/short variants to the same family', () => {
    expect(getSetupFamily('trend_pullback_long')).toBe(getSetupFamily('trend_pullback_short'));
    expect(getSetupFamily('opening_drive_continuation_long')).toBe(getSetupFamily('opening_drive_continuation_short'));
    expect(getSetupFamily('failed_or_break_long')).toBe(getSetupFamily('failed_or_break_short'));
  });
});

// ── 2. Profile resolution with ATR ─────────────────────────────────────────

describe('resolveProfile', () => {
  it('resolves ATR multiples to concrete values (ATR=10)', () => {
    const result = resolveProfile(TREND_PROFILE, 10, MNQ);
    // pt1 = 0.5 * 10 = 5.0pts
    expect(result.pt1_offset_pts).toBeCloseTo(5.0, 1);
    // pt2 = 1.2 * 10 = 12.0pts
    expect(result.pt2_offset_pts).toBeCloseTo(12.0, 1);
    // trail = 0.3 * 10 = 3.0pts = 12 ticks (3.0 / 0.25)
    expect(result.trail_ticks_post_t1).toBe(12);
    expect(result.profile_name).toBe('trend_pullback');
    expect(result.atr_at_entry).toBe(10);
  });

  it('falls back to fixed values when ATR is null', () => {
    const result = resolveProfile(TREND_PROFILE, null, MNQ);
    expect(result.pt1_offset_pts).toBe(TREND_PROFILE.pt1_offset_pts_fallback);
    expect(result.pt2_offset_pts).toBe(TREND_PROFILE.pt2_offset_pts_fallback);
    expect(result.trail_ticks_post_t1).toBe(TREND_PROFILE.trail_ticks_post_t1_fallback);
    expect(result.atr_at_entry).toBeNull();
  });

  it('enforces PT2 > PT1 + 4 ticks safety', () => {
    // Create profile where ATR scaling makes PT2 close to PT1
    const tightProfile: ManagementProfile = {
      ...TREND_PROFILE,
      pt1_offset_atr: 0.5,
      pt2_offset_atr: 0.51, // barely above PT1
    };
    const result = resolveProfile(tightProfile, 10, MNQ);
    // PT1 = 5.0, PT2 raw = 5.1 → forced to 5.0 + 4*0.25 = 6.0
    expect(result.pt2_offset_pts).toBeGreaterThan(result.pt1_offset_pts + 0.99);
  });

  it('clamps offsets to minimum 1 tick', () => {
    const tinyProfile: ManagementProfile = {
      ...TREND_PROFILE,
      pt1_offset_atr: 0.001,  // nearly zero
    };
    const result = resolveProfile(tinyProfile, 1, MNQ);
    // 0.001 * 1 = 0.001pts → clamped to tick_size (0.25)
    expect(result.pt1_offset_pts).toBeGreaterThanOrEqual(MNQ.tick_size);
  });

  it('converts trail ATR to correct tick count for MNQ', () => {
    // trail_atr_post_t1 = 0.3, ATR = 12 → 3.6pts → 3.6/0.25 = 14.4 → 14 ticks
    const result = resolveProfile(TREND_PROFILE, 12, MNQ);
    expect(result.trail_ticks_post_t1).toBe(14);
  });
});

// ── 3. Different setup types produce different thresholds ───────────────────

describe('setup-specific thresholds', () => {
  it('opening_drive has wider PT1 and shorter time stop than trend_pullback', () => {
    const atr = 12;
    const tpResult = resolveProfile(TREND_PROFILE, atr, MNQ);
    const odResult = resolveProfile(OPENING_DRIVE_PROFILE, atr, MNQ);

    // Opening drive: 0.7 * 12 = 8.4 > trend pullback: 0.5 * 12 = 6.0
    expect(odResult.pt1_offset_pts).toBeGreaterThan(tpResult.pt1_offset_pts);
    // Opening drive: 20min < trend pullback: 30min
    expect(odResult.time_stop_minutes).toBeLessThan(tpResult.time_stop_minutes);
    // Opening drive: 0.6 exit fraction > trend pullback: 0.5
    expect(odResult.pt1_exit_fraction).toBeGreaterThan(tpResult.pt1_exit_fraction);
  });

  it('ATR scaling changes thresholds proportionally with volatility', () => {
    const lowVol = resolveProfile(TREND_PROFILE, 8, MNQ);
    const highVol = resolveProfile(TREND_PROFILE, 20, MNQ);

    // High vol PT1 should be ~2.5x low vol PT1
    expect(highVol.pt1_offset_pts / lowVol.pt1_offset_pts).toBeCloseTo(2.5, 1);
    // Both should have same R-relative settings
    expect(lowVol.breakeven_trigger_r).toBe(highVol.breakeven_trigger_r);
    expect(lowVol.time_stop_minutes).toBe(highVol.time_stop_minutes);
  });
});

// ── 4. Legacy fallback ─────────────────────────────────────────────────────

describe('buildDefaultProfileFromConfig', () => {
  it('produces values matching flat config exactly', () => {
    const profile = buildDefaultProfileFromConfig(BASE_CFG);
    expect(profile.name).toBe('legacy_default');
    expect(profile.family).toBe('default');
    // All ATR fields should be 0
    expect(profile.pt1_offset_atr).toBe(0);
    expect(profile.pt2_offset_atr).toBe(0);
    expect(profile.trail_atr_post_t1).toBe(0);
    expect(profile.pre_t1_trail_atr).toBe(0);
    // Fallbacks match flat config
    expect(profile.pt1_offset_pts_fallback).toBe(BASE_CFG.pt1_offset_pts);
    expect(profile.pt2_offset_pts_fallback).toBe(BASE_CFG.pt2_offset_pts);
    expect(profile.trail_ticks_post_t1_fallback).toBe(BASE_CFG.trail_ticks_post_t1);
    expect(profile.breakeven_trigger_r).toBe(BASE_CFG.breakeven_trigger_r);
    expect(profile.time_stop_minutes).toBe(BASE_CFG.time_stop_minutes);
  });

  it('resolving legacy profile with any ATR still uses fallback values', () => {
    const profile = buildDefaultProfileFromConfig(BASE_CFG);
    const resolved = resolveProfile(profile, 15, MNQ);
    // Since all ATR multiples are 0, should use fallbacks
    expect(resolved.pt1_offset_pts).toBe(BASE_CFG.pt1_offset_pts);
    expect(resolved.pt2_offset_pts).toBe(BASE_CFG.pt2_offset_pts);
    expect(resolved.trail_ticks_post_t1).toBe(BASE_CFG.trail_ticks_post_t1);
  });
});

// ── 5. Profile selection ────────────────────────────────────────────────────

describe('getManagementProfile', () => {
  it('returns family-specific profile when config has one', () => {
    const cfg: IndicatorConfig = {
      ...BASE_CFG,
      management_profiles: {
        trend_pullback: TREND_PROFILE,
        default: { ...TREND_PROFILE, name: 'default', family: 'default' },
      },
    };
    const profile = getManagementProfile('trend_pullback_long', 'trending_up', cfg);
    expect(profile.name).toBe('trend_pullback');
  });

  it('falls back to default profile when family not found', () => {
    const cfg: IndicatorConfig = {
      ...BASE_CFG,
      management_profiles: {
        default: { ...TREND_PROFILE, name: 'explicit_default', family: 'default' },
      },
    };
    const profile = getManagementProfile('failed_or_break_long', 'range_bound', cfg);
    expect(profile.name).toBe('explicit_default');
  });

  it('synthesizes from flat config when no management_profiles exist', () => {
    const profile = getManagementProfile('trend_pullback_short', 'trending_down', BASE_CFG);
    expect(profile.name).toBe('legacy_default');
    expect(profile.pt1_offset_pts_fallback).toBe(BASE_CFG.pt1_offset_pts);
  });
});

// ── 6. PositionManager reads from management_params ─────────────────────────

describe('PositionManager uses management_params', () => {
  it('uses profile PT1 offset instead of flat config', () => {
    const pm = new PositionManager(MNQ, 'MNQ1!');
    // Build a profile with PT1 at 8pts (not the config default of 6)
    const mgmt: ResolvedManagementParams = {
      profile_name: 'test_profile',
      family: 'opening_drive',
      atr_at_entry: 12,
      pt1_offset_pts: 8,
      pt2_offset_pts: 18,
      pt1_exit_fraction: 0.6,
      pt2_exit_fraction: 0.2,
      pt1_move_to_be: true,
      pt1_activate_trailing: true,
      trail_ticks_post_t1: 16,
      breakeven_trigger_r: 0.4,
      pre_t1_trail_trigger_r: 0.6,
      pre_t1_trail_distance_ticks: 18,
      time_stop_minutes: 20,
      time_stop_max_r_pre_t1: 0.2,
      time_stop_max_r_post_t1: 0.8,
    };
    const setup = {
      direction: 'long',
      setup_type: 'opening_drive_continuation_long' as SetupType,
      stop: 19_990, target_1: 20_020, target_2: 20_040, target_3: null, confidence: 8,
      target_1_direction_valid: true, target_2_direction_valid: true,
      target_3_direction_valid: true, target_ordering_valid: true,
      target_repair_applied: false,
    };
    const fill: OrderResult = {
      order_id: 'X', fill_price: 20_000, fill_time_iso: new Date().toISOString(),
      quantity: 2, side: 'long', slippage_pts: 0, fee_usd: 0, status: 'simulated',
    };
    const pos = PositionManager.buildPosition(
      'T1', 'S1', 'SESS', setup, fill, 2, 80_000,
      'trending_up', 'V1', 20, mgmt, 12,
    );
    pm.openPosition(pos);

    // Price at +7pts (below PT1=8) — should NOT trigger PT1
    const dec7 = pm.evaluate(20_007, BASE_CFG);
    expect(dec7.shouldExit).toBe(false);

    // Price at +8pts — should trigger PT1 from management_params
    const dec8 = pm.evaluate(20_008, BASE_CFG);
    expect(dec8.shouldExit).toBe(true);
    expect(dec8.reason).toBe('partial_profit_1');
  });
});
