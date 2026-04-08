import { describe, it, expect } from 'vitest';
import { RiskManager } from '../../src/autotrade/risk.js';
import { getContractSpec } from '../../src/autotrade/contracts.js';
import type { CandidateSetup, IndicatorConfig } from '../../src/autotrade/types.js';

const CFG: IndicatorConfig = {
  version: 'TEST', type: 'BASELINE', created_at: '2026-01-01T00:00:00Z',
  ema_fast: 9, ema_mid: 21, ema_slow: 50,
  rsi_period: 14, atr_period: 14, volume_sma_period: 20,
  min_confidence: 7.5, min_rr: 2.0,
  max_risk_per_trade_pct: 0.5,
  max_daily_loss_pct: 1.5, max_consecutive_losses: 5,
  account_equity: 25_000,
  time_stop_minutes: 30,
  time_stop_max_r_pre_t1: 0.25, time_stop_max_r_post_t1: 1.0,
  analysis_interval_seconds: 20, in_position_monitor_seconds: 2,
  opening_range_minutes: 15, trail_ticks_post_t1: 12,
  enable_momentum_continuation: false, enable_opening_drive: true, enable_failed_or_break: true,
  dual_min_score: 7.5, dual_score_margin: 1.0, dual_choppy_extra_margin: 0.5,
};

function mkSetup(stopPts: number, entryMid: number): CandidateSetup {
  return {
    direction: 'long', setup_type: 'trend_pullback_long',
    entry_low: entryMid - 1, entry_high: entryMid + 1,
    stop: entryMid - stopPts, target_1: entryMid + stopPts * 2,
    target_2: entryMid + stopPts * 3, target_3: null,
    risk_pts: stopPts, rr_t1: 2, rr_t2: 3,
    confidence: 8, confidence_factors: [], reason: '',
    target_1_direction_valid: true, target_2_direction_valid: true,
    target_3_direction_valid: true, rr_validation_passed: true,
    target_ordering_valid: true, target_repair_applied: false,
    target_repair_reason: '',
  };
}

describe('RiskManager futures sizing', () => {
  it('NQ: sizes integer contracts within risk budget', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG, nq);
    // Budget = 25000 * 0.5% = $125
    // Stop 10pts NQ = $200/contract → qty = floor(125/200) = 0
    let s = rm.calcPositionSize(mkSetup(10, 20_000));
    expect(s.quantity).toBe(0);

    // Stop 5pts NQ = $100/contract → qty = floor(125/100) = 1
    s = rm.calcPositionSize(mkSetup(5, 20_000));
    expect(s.quantity).toBe(1);
    expect(s.risk_usd).toBeCloseTo(100, 2);
    expect(s.stop_distance_ticks).toBe(20);
    expect(s.risk_per_contract_usd).toBeCloseTo(100, 2);
  });

  it('MNQ: much tighter sizing fits within same budget', () => {
    const mnq = getContractSpec('MNQ');
    const rm = new RiskManager(CFG, mnq);
    // Budget = $125; MNQ 10pts stop = $20/contract → qty = 6
    const s = rm.calcPositionSize(mkSetup(10, 20_000));
    expect(s.quantity).toBe(6);
    expect(s.risk_usd).toBeCloseTo(120, 2);
  });

  it('rejects sizing of zero-contract trades in preTradeCheck', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG, nq);
    const reason = rm.preTradeCheck(mkSetup(50, 20_000));
    expect(reason).toContain('sizing_zero_contracts');
  });

  it('hard-caps quantity at 20 contracts', () => {
    const mnq = getContractSpec('MNQ');
    const rm = new RiskManager({ ...CFG, account_equity: 1_000_000 }, mnq);
    const s = rm.calcPositionSize(mkSetup(1, 20_000));
    expect(s.quantity).toBeLessThanOrEqual(20);
  });

  it('normalizes degenerate stop distances to >= 2 ticks', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG, nq);
    const s = rm.calcPositionSize(mkSetup(0, 20_000));
    expect(s.stop_distance_ticks).toBeGreaterThanOrEqual(2);
  });

  // ── Diagnostic fields (added with budget patch) ──────────────────────────

  it('SizingResult exposes equity, max_risk_pct_used, and contracts_raw', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG, nq);
    // CFG has account_equity=25000, max_risk_per_trade_pct=0.5 → budget=$125
    const s = rm.calcPositionSize(mkSetup(5, 20_000));
    expect(s.equity).toBe(25_000);
    expect(s.max_risk_pct_used).toBe(0.5);
    expect(s.max_risk_usd).toBeCloseTo(125, 2);
    // contracts_raw = 125 / 100 = 1.25
    expect(s.contracts_raw).toBeCloseTo(1.25, 2);
    expect(s.quantity).toBe(1); // floor(1.25)
  });
});

// ── Budget patch validation — $150 per trade with account_equity=$10,000 ─────

describe('RiskManager — $150 risk budget (account_equity=10000, max_risk_per_trade_pct=1.5)', () => {
  const CFG_10K: typeof CFG = {
    ...CFG,
    account_equity: 10_000,
    max_risk_per_trade_pct: 1.5,
  };

  it('computes risk_budget of exactly $150', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG_10K, nq);
    const s = rm.calcPositionSize(mkSetup(5, 20_000));
    // 10000 * 1.5 / 100 = $150
    expect(s.max_risk_usd).toBeCloseTo(150, 2);
    expect(s.equity).toBe(10_000);
    expect(s.max_risk_pct_used).toBe(1.5);
  });

  it('NQ stop=5pts ($100/ct): qty=1, fits inside $150 budget', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG_10K, nq);
    // risk_per_contract = 5pts × $20/pt = $100; floor(150/100) = 1
    const s = rm.calcPositionSize(mkSetup(5, 20_000));
    expect(s.quantity).toBe(1);
    expect(s.risk_per_contract_usd).toBeCloseTo(100, 2);
    expect(s.contracts_raw).toBeCloseTo(1.5, 2);
    expect(s.reason).toBe('ok');
  });

  it('NQ stop=3.25pts ($65/ct): qty=2 fits, contracts_raw=2.3x', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG_10K, nq);
    // 3.25pts × $20 = $65/ct; floor(150/65) = 2
    const s = rm.calcPositionSize(mkSetup(3.25, 20_000));
    expect(s.quantity).toBe(2);
    expect(s.reason).toBe('ok');
  });

  it('NQ stop=10pts ($200/ct): still zero — stop is larger than budget', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG_10K, nq);
    // 10pts × $20 = $200/ct > $150 budget → 0 contracts
    const s = rm.calcPositionSize(mkSetup(10, 20_000));
    expect(s.quantity).toBe(0);
    expect(s.reason).toContain('budget_$150.00_lt_risk_per_contract_$200.00');
  });

  it('NQ stop=7.5pts ($150/ct exactly): qty=1, contracts_raw=1.0', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG_10K, nq);
    // 7.5pts × $20 = $150/ct; floor(150/150) = 1
    const s = rm.calcPositionSize(mkSetup(7.5, 20_000));
    expect(s.quantity).toBe(1);
    expect(s.contracts_raw).toBeCloseTo(1.0, 1);
    expect(s.reason).toBe('ok');
  });

  it('preTradeCheck passes for stop within $150 budget', () => {
    const nq = getContractSpec('NQ');
    const rm = new RiskManager(CFG_10K, nq);
    // Stop 5pts → $100/ct < $150 budget → should NOT block
    const block = rm.preTradeCheck(mkSetup(5, 20_000));
    expect(block).toBeNull();
  });

  it('MNQ stop=30pts ($60/ct): qty=2 with $150 budget', () => {
    const mnq = getContractSpec('MNQ');
    const rm = new RiskManager(CFG_10K, mnq);
    // 30pts × $2 = $60/ct; floor(150/60) = 2
    const s = rm.calcPositionSize(mkSetup(30, 20_000));
    expect(s.quantity).toBe(2);
    expect(s.risk_per_contract_usd).toBeCloseTo(60, 2);
  });
});
