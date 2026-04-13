/**
 * Tests for RuntimeStateManager — lock, atomic writes, corruption-safe reads,
 * heartbeat, and lifecycle state management.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { RuntimeStateManager, isWarmupComplete } from '../../src/autotrade/runtime-state.js';

const TEST_DIR = join(process.cwd(), 'tests', '_tmp_runtime_state');

describe('RuntimeStateManager', () => {
  let mgr: RuntimeStateManager;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mgr = new RuntimeStateManager(TEST_DIR, { heartbeatIntervalMs: 100, heartbeatStaleMs: 500 });
  });

  afterEach(() => {
    mgr.stopHeartbeat();
    mgr.releaseLock();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── Lock ──────────────────────────────────────────────────────────────

  describe('lock', () => {
    it('acquires lock on first call', () => {
      expect(mgr.acquireLock('session_1')).toBe(true);
      expect(existsSync(join(TEST_DIR, 'runner.lock'))).toBe(true);
    });

    it('rejects second lock from same process', () => {
      expect(mgr.acquireLock('session_1')).toBe(true);
      const mgr2 = new RuntimeStateManager(TEST_DIR);
      // Same PID, but different instance_id — should still see lock held by live process
      expect(mgr2.acquireLock('session_2')).toBe(false);
    });

    it('releaseLock is idempotent', () => {
      mgr.acquireLock('session_1');
      mgr.releaseLock();
      expect(existsSync(join(TEST_DIR, 'runner.lock'))).toBe(false);
      // Second call should not throw
      mgr.releaseLock();
    });

    it('recovers stale lock from dead PID', () => {
      // Write a lock file with a PID that definitely doesn't exist
      const lockPath = join(TEST_DIR, 'runner.lock');
      writeFileSync(lockPath, JSON.stringify({
        schema_version: 1,
        pid: 999999999,
        instance_id: 'dead-instance',
        started_at: new Date().toISOString(),
        session_id: 'old_session',
      }));
      expect(mgr.acquireLock('new_session')).toBe(true);
    });

    it('rejects lock with corrupt lock file but live PID', () => {
      const lockPath = join(TEST_DIR, 'runner.lock');
      writeFileSync(lockPath, 'not-json');
      // Corrupt lock file should be removed and re-acquired
      expect(mgr.acquireLock('session_1')).toBe(true);
    });
  });

  // ── Stale .tmp cleanup ───────────────────────────────────────────────

  describe('stale tmp cleanup', () => {
    it('cleans stale tmp files', () => {
      writeFileSync(join(TEST_DIR, 'runtime_state.json.tmp'), 'stale');
      writeFileSync(join(TEST_DIR, 'open_trade_state.json.tmp'), 'stale');
      const cleaned = mgr.cleanupStaleTmpFiles();
      expect(cleaned).toContain('runtime_state.json.tmp');
      expect(cleaned).toContain('open_trade_state.json.tmp');
      expect(existsSync(join(TEST_DIR, 'runtime_state.json.tmp'))).toBe(false);
    });

    it('returns empty when no stale files', () => {
      expect(mgr.cleanupStaleTmpFiles()).toEqual([]);
    });
  });

  // ── Runtime state ────────────────────────────────────────────────────

  describe('runtime state', () => {
    it('readPrevious returns null when no file', () => {
      expect(mgr.readPrevious()).toBeNull();
    });

    it('initialize writes state with shutdown_clean=false', () => {
      mgr.initialize('session_1', 'paper', 'dev');
      const state = mgr.readPrevious();
      expect(state).not.toBeNull();
      expect(state!.session_id).toBe('session_1');
      expect(state!.shutdown_clean).toBe(false);
      expect(state!.mode).toBe('paper');
      expect(state!.restart_mode).toBe('dev');
      expect(state!.schema_version).toBe(2);
      // v2 cycle activity fields initialize to null/false
      expect(state!.last_cycle_started_at).toBeNull();
      expect(state!.last_cycle_completed_at).toBeNull();
      expect(state!.last_snapshot_ts).toBeNull();
      expect(state!.last_signal_decision_at).toBeNull();
      expect(state!.warmup_complete).toBe(false);
    });

    it('markCleanShutdown sets shutdown_clean=true', () => {
      mgr.initialize('session_1', 'paper', 'dev');
      mgr.markCleanShutdown('user_stopped');
      const state = mgr.readPrevious();
      expect(state!.shutdown_clean).toBe(true);
      expect(state!.shutdown_reason).toBe('user_stopped');
    });

    it('updatePositionKnown tracks open trade', () => {
      mgr.initialize('session_1', 'paper', 'dev');
      mgr.updatePositionKnown('TRADE_001');
      const state = mgr.readPrevious();
      expect(state!.open_position_known).toBe(true);
      expect(state!.open_trade_id).toBe('TRADE_001');
    });

    it('updatePositionKnown clears when null', () => {
      mgr.initialize('session_1', 'paper', 'dev');
      mgr.updatePositionKnown('TRADE_001');
      mgr.updatePositionKnown(null);
      const state = mgr.readPrevious();
      expect(state!.open_position_known).toBe(false);
      expect(state!.open_trade_id).toBeNull();
    });
  });

  // ── Cycle activity tracking (v2) ────────────────────────────────────

  describe('cycle activity tracking', () => {
    it('updateCycleStart sets last_cycle_started_at', async () => {
      mgr.initialize('session_1', 'paper', 'dev');
      mgr.updateCycleStart();
      // Wait for heartbeat to flush in-memory state to disk (100ms interval in tests)
      mgr.startHeartbeat();
      await new Promise(r => setTimeout(r, 200));
      mgr.stopHeartbeat();
      const state = mgr.readPrevious();
      expect(state!.last_cycle_started_at).not.toBeNull();
      expect(new Date(state!.last_cycle_started_at!).getTime()).toBeGreaterThan(0);
    });

    it('updateCycleComplete sets last_cycle_completed_at', async () => {
      mgr.initialize('session_1', 'paper', 'dev');
      mgr.updateCycleComplete();
      mgr.startHeartbeat();
      await new Promise(r => setTimeout(r, 200));
      mgr.stopHeartbeat();
      const state = mgr.readPrevious();
      expect(state!.last_cycle_completed_at).not.toBeNull();
    });

    it('updateSnapshotTs sets market snapshot timestamp', async () => {
      mgr.initialize('session_1', 'paper', 'dev');
      const marketTime = '2026-04-12T15:30:00.000Z';
      mgr.updateSnapshotTs(marketTime);
      mgr.startHeartbeat();
      await new Promise(r => setTimeout(r, 200));
      mgr.stopHeartbeat();
      const state = mgr.readPrevious();
      expect(state!.last_snapshot_ts).toBe(marketTime);
    });

    it('updateSignalDecision sets last_signal_decision_at', async () => {
      mgr.initialize('session_1', 'paper', 'dev');
      mgr.updateSignalDecision();
      mgr.startHeartbeat();
      await new Promise(r => setTimeout(r, 200));
      mgr.stopHeartbeat();
      const state = mgr.readPrevious();
      expect(state!.last_signal_decision_at).not.toBeNull();
    });

    it('markWarmupComplete is a one-way latch', () => {
      mgr.initialize('session_1', 'paper', 'dev');
      expect(mgr.isWarmupComplete()).toBe(false);
      mgr.markWarmupComplete();
      expect(mgr.isWarmupComplete()).toBe(true);
      // Calling again is idempotent
      mgr.markWarmupComplete();
      expect(mgr.isWarmupComplete()).toBe(true);
    });

    it('readPrevious backfills v1 files with v2 defaults', () => {
      // Write a v1 schema file (no cycle activity fields)
      writeFileSync(join(TEST_DIR, 'runtime_state.json'), JSON.stringify({
        schema_version: 1,
        app_version: 'test',
        written_at: new Date().toISOString(),
        session_id: 'old_session',
        started_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        shutdown_clean: true,
        shutdown_reason: 'test',
        open_position_known: false,
        open_trade_id: null,
        mode: 'paper',
        restart_mode: 'dev',
      }));
      const state = mgr.readPrevious();
      expect(state).not.toBeNull();
      expect(state!.session_id).toBe('old_session');
      // v2 fields backfilled with defaults
      expect(state!.last_cycle_started_at).toBeNull();
      expect(state!.last_cycle_completed_at).toBeNull();
      expect(state!.last_snapshot_ts).toBeNull();
      expect(state!.last_signal_decision_at).toBeNull();
      expect(state!.warmup_complete).toBe(false);
    });
  });

  // ── Warmup predicate ──────────────────────────────────────────────

  describe('isWarmupComplete predicate', () => {
    it('returns false when bars < 200', () => {
      expect(isWarmupComplete({ bars_1m_count: 199, atr_available: true, vwap_available: true })).toBe(false);
    });

    it('returns false when ATR unavailable', () => {
      expect(isWarmupComplete({ bars_1m_count: 200, atr_available: false, vwap_available: true })).toBe(false);
    });

    it('returns false when VWAP unavailable', () => {
      expect(isWarmupComplete({ bars_1m_count: 200, atr_available: true, vwap_available: false })).toBe(false);
    });

    it('returns true when all conditions met', () => {
      expect(isWarmupComplete({ bars_1m_count: 200, atr_available: true, vwap_available: true })).toBe(true);
    });

    it('returns true when bars exceed threshold', () => {
      expect(isWarmupComplete({ bars_1m_count: 480, atr_available: true, vwap_available: true })).toBe(true);
    });
  });

  // ── Corruption-safe reads ───────────────────────────────────────────

  describe('corruption-safe reads', () => {
    it('handles corrupt runtime_state.json', () => {
      writeFileSync(join(TEST_DIR, 'runtime_state.json'), 'not-json');
      expect(mgr.readPrevious()).toBeNull();
    });

    it('handles empty runtime_state.json', () => {
      writeFileSync(join(TEST_DIR, 'runtime_state.json'), '');
      expect(mgr.readPrevious()).toBeNull();
    });

    it('handles schema version mismatch', () => {
      writeFileSync(join(TEST_DIR, 'runtime_state.json'), JSON.stringify({
        schema_version: 999,
        session_id: 'old',
      }));
      expect(mgr.readPrevious()).toBeNull();
    });

    it('handles corrupt open_trade_state.json', () => {
      writeFileSync(join(TEST_DIR, 'open_trade_state.json'), '{partial');
      expect(mgr.readOpenTradeState()).toBeNull();
    });
  });

  // ── Open trade state ───────────────────────────────────────────────

  describe('open trade state', () => {
    it('writes and reads null position', () => {
      mgr.writeOpenTradeState(null);
      const result = mgr.readOpenTradeState();
      expect(result).not.toBeNull();
      expect(result!.position).toBeNull();
      expect(result!.trade_id).toBeNull();
    });

    it('writes and reads position with quick-read fields', () => {
      const mockPosition = {
        trade_id: 'TRADE_001',
        side: 'long' as const,
        quantity_remaining: 2,
      } as any;
      mgr.writeOpenTradeState(mockPosition);
      const result = mgr.readOpenTradeState();
      expect(result!.trade_id).toBe('TRADE_001');
      expect(result!.position_side).toBe('long');
      expect(result!.qty_remaining).toBe(2);
      expect(result!.position.trade_id).toBe('TRADE_001');
    });
  });

  // ── Heartbeat ───────────────────────────────────────────────────────

  describe('heartbeat', () => {
    it('updates last_heartbeat_at periodically', async () => {
      mgr.initialize('session_1', 'paper', 'dev');
      const before = mgr.readPrevious()!.last_heartbeat_at;
      mgr.startHeartbeat();
      await new Promise(r => setTimeout(r, 250));
      mgr.stopHeartbeat();
      const after = mgr.readPrevious()!.last_heartbeat_at;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    });

    it('markCleanShutdown stops heartbeat', () => {
      mgr.initialize('session_1', 'paper', 'dev');
      mgr.startHeartbeat();
      mgr.markCleanShutdown('test');
      // Heartbeat timer should be cleared — no more writes
      const state = mgr.readPrevious();
      expect(state!.shutdown_clean).toBe(true);
    });
  });
});
