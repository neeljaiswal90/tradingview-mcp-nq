/**
 * Tests for recovery logic — multi-signal evaluation, precedence, and replay helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RuntimeStateManager } from '../../src/autotrade/runtime-state.js';
import { TradeJournal } from '../../src/autotrade/trade-journal.js';
import {
  readRecoveryArtifacts,
  buildRecoveryReport,
  isRecoveryBlocked,
  getLatestOpenTradeEvidence,
  reconstructLastTradeState,
} from '../../src/autotrade/recovery.js';

const TEST_DIR = join(process.cwd(), 'tests', '_tmp_recovery');

describe('Recovery', () => {
  let runtimeState: RuntimeStateManager;
  let journal: TradeJournal;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    runtimeState = new RuntimeStateManager(TEST_DIR, { heartbeatIntervalMs: 10000, heartbeatStaleMs: 40000 });
    journal = new TradeJournal(TEST_DIR, 'SESSION_NEW');
  });

  afterEach(() => {
    runtimeState.stopHeartbeat();
    runtimeState.releaseLock();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── Clean start scenarios ────────────────────────────────────────────

  describe('clean start', () => {
    it('reports clean_start when no previous state', () => {
      const artifacts = readRecoveryArtifacts(runtimeState, journal);
      const report = buildRecoveryReport(artifacts, journal, 'dev', 'paper', 40000);
      expect(report.outcome).toBe('clean_start');
      expect(isRecoveryBlocked(report)).toBe(false);
    });

    it('reports clean_start when previous session ended cleanly', () => {
      runtimeState.initialize('OLD_SESSION', 'paper', 'dev');
      runtimeState.markCleanShutdown('user_stopped');
      runtimeState.writeOpenTradeState(null);

      const report = buildRecoveryReport(
        readRecoveryArtifacts(runtimeState, journal), journal, 'dev', 'paper', 40000,
      );
      expect(report.outcome).toBe('clean_start');
    });
  });

  // ── Dirty shutdown scenarios ──────────────────────────────────────────

  describe('dirty shutdown', () => {
    it('dirty shutdown without open trade → warn, proceed', () => {
      runtimeState.initialize('OLD_SESSION', 'paper', 'dev');
      // shutdown_clean is false (not marked clean)
      runtimeState.writeOpenTradeState(null);

      const report = buildRecoveryReport(
        readRecoveryArtifacts(runtimeState, journal), journal, 'dev', 'paper', 40000,
      );
      expect(report.outcome).toBe('dirty_restart_no_open_trade');
      expect(isRecoveryBlocked(report)).toBe(false);
    });

    it('dirty shutdown with open trade + dev + paper → auto-clear', () => {
      runtimeState.initialize('OLD_SESSION', 'paper', 'dev');
      runtimeState.writeOpenTradeState({ trade_id: 'TRADE_1', side: 'long', quantity_remaining: 1 } as any);

      const report = buildRecoveryReport(
        readRecoveryArtifacts(runtimeState, journal), journal, 'dev', 'paper', 40000,
      );
      expect(report.outcome).toBe('dirty_restart_open_trade_cleared_dev');
      expect(isRecoveryBlocked(report)).toBe(false);
      expect(report.open_trade_id).toBe('TRADE_1');
    });

    it('dirty shutdown with open trade + prod → blocked', () => {
      runtimeState.initialize('OLD_SESSION', 'paper', 'prod');
      runtimeState.writeOpenTradeState({ trade_id: 'TRADE_1', side: 'long', quantity_remaining: 1 } as any);

      const report = buildRecoveryReport(
        readRecoveryArtifacts(runtimeState, journal), journal, 'prod', 'paper', 40000,
      );
      expect(report.outcome).toBe('dirty_restart_blocked_prod');
      expect(isRecoveryBlocked(report)).toBe(true);
      expect(report.blocking_reason_code).toBe('dirty_shutdown_open_trade');
    });
  });

  // ── Corruption scenarios ──────────────────────────────────────────────

  describe('corrupted state', () => {
    it('corrupt runtime_state without open trade → warn', () => {
      writeFileSync(join(TEST_DIR, 'runtime_state.json'), 'corrupt');

      const report = buildRecoveryReport(
        readRecoveryArtifacts(runtimeState, journal), journal, 'dev', 'paper', 40000,
      );
      expect(report.outcome).toBe('corrupted_state_no_open_trade');
      expect(report.runtime_file_corrupt).toBe(true);
    });

    it('corrupt state + open trade + prod → blocked', () => {
      writeFileSync(join(TEST_DIR, 'runtime_state.json'), 'corrupt');
      runtimeState.writeOpenTradeState({ trade_id: 'TRADE_1', side: 'short', quantity_remaining: 1 } as any);

      const report = buildRecoveryReport(
        readRecoveryArtifacts(runtimeState, journal), journal, 'prod', 'paper', 40000,
      );
      expect(report.outcome).toBe('corrupted_state_blocked_prod');
      expect(isRecoveryBlocked(report)).toBe(true);
    });
  });

  // ── Precedence: corruption > dirty > stale ────────────────────────────

  describe('precedence', () => {
    it('corruption takes precedence over dirty shutdown', () => {
      // Both corrupt AND dirty
      writeFileSync(join(TEST_DIR, 'runtime_state.json'), 'corrupt');
      runtimeState.writeOpenTradeState({ trade_id: 'T1', side: 'long', quantity_remaining: 1 } as any);

      const report = buildRecoveryReport(
        readRecoveryArtifacts(runtimeState, journal), journal, 'dev', 'paper', 40000,
      );
      // Should classify as corrupted, not dirty
      expect(report.outcome).toContain('corrupted_state');
    });
  });

  // ── Journal orphan detection ──────────────────────────────────────────

  describe('journal orphan as evidence', () => {
    it('detects open trade from journal orphan even without open_trade_state', () => {
      runtimeState.initialize('OLD_SESSION', 'paper', 'dev');
      runtimeState.writeOpenTradeState(null); // state says no trade
      // But journal says a trade was opened and never closed
      const oldJournal = new TradeJournal(TEST_DIR, 'OLD_SESSION');
      oldJournal.append('trade_opened', 'TRADE_ORPHAN', 'runner', null, null);

      const newJournal = new TradeJournal(TEST_DIR, 'NEW_SESSION');
      const report = buildRecoveryReport(
        readRecoveryArtifacts(runtimeState, newJournal), newJournal, 'dev', 'paper', 40000,
      );
      // Journal orphan should be detected as evidence
      expect(report.journal_orphan_detected).toBe(true);
      expect(report.open_trade_detected).toBe(true);
    });
  });

  // ── Open trade evidence merging ─────────────────────────────────────

  describe('getLatestOpenTradeEvidence', () => {
    it('returns no evidence when everything is clean', () => {
      const evidence = getLatestOpenTradeEvidence(null, null, journal);
      expect(evidence.has_evidence).toBe(false);
    });

    it('merges signals from runtime + open_trade_state', () => {
      const runtime = {
        schema_version: 1, app_version: 'test', written_at: '', session_id: 'S1',
        started_at: '', last_heartbeat_at: '', shutdown_clean: false, shutdown_reason: null,
        open_position_known: true, open_trade_id: 'TRADE_1', mode: 'paper' as const, restart_mode: 'dev' as const,
      };
      const openTrade = {
        schema_version: 1, written_at: '', trade_id: 'TRADE_1',
        position_side: 'long', qty_remaining: 2, position: { trade_id: 'TRADE_1', side: 'long' } as any,
      };
      const evidence = getLatestOpenTradeEvidence(runtime, openTrade, journal);
      expect(evidence.has_evidence).toBe(true);
      expect(evidence.trade_id).toBe('TRADE_1');
      expect(evidence.sources).toContain('runtime_state');
      expect(evidence.sources).toContain('open_trade_state');
    });
  });

  // ── reconstructLastTradeState ────────────────────────────────────────

  describe('reconstructLastTradeState', () => {
    it('returns latest position snapshot from journal', () => {
      const mockPos = { trade_id: 'TRADE_1', side: 'long', quantity_remaining: 2 } as any;
      journal.append('trade_opened', 'TRADE_1', 'runner', null, mockPos);
      const updated = { ...mockPos, quantity_remaining: 1 };
      journal.append('partial_exit', 'TRADE_1', 'runner', 'pt1', updated);

      const result = reconstructLastTradeState(journal, 'TRADE_1');
      expect(result).not.toBeNull();
      expect(result!.quantity_remaining).toBe(1);
    });

    it('returns null for unknown trade', () => {
      expect(reconstructLastTradeState(journal, 'UNKNOWN')).toBeNull();
    });
  });
});
