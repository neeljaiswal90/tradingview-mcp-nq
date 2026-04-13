/**
 * RuntimeStateManager — owns lifecycle marker files for shutdown/recovery hygiene.
 *
 * Files managed (all in LOG_DIR):
 *   runner.lock             — single-instance enforcement (exclusive-open)
 *   runtime_state.json      — process lifecycle marker with heartbeat
 *   open_trade_state.json   — current Position snapshot for crash recovery
 *   recovery_report.json    — startup recovery decision record
 */

import {
  openSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  closeSync,
  fsyncSync,
  constants,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import type { Position, ExecutionMode } from './types.js';
import type { RestartMode } from './types.js';

// ── Schema versions (bump when file shape changes) ─────────────────────────

const RUNTIME_STATE_SCHEMA_VERSION = 2;
const OPEN_TRADE_STATE_SCHEMA_VERSION = 1;
const LOCK_SCHEMA_VERSION = 1;

// ── Types ──────────────────────────────────────────────────────────────────

export interface RuntimeState {
  schema_version: number;
  app_version: string;
  written_at: string;
  session_id: string;
  started_at: string;
  last_heartbeat_at: string;
  shutdown_clean: boolean;
  shutdown_reason: string | null;
  open_position_known: boolean;
  open_trade_id: string | null;
  mode: ExecutionMode;
  restart_mode: RestartMode;
  // ── Cycle activity fields (v2) ──────────────────────────────────────────
  last_cycle_started_at: string | null;
  last_cycle_completed_at: string | null;
  /** Market snapshot timestamp — NOT wall clock. Answers "when was the latest market data produced." */
  last_snapshot_ts: string | null;
  last_signal_decision_at: string | null;
  /** One-way latch: transitions false → true when data quality meets readiness threshold. */
  warmup_complete: boolean;
}

/**
 * Canonical warmup readiness predicate. A runner is considered warmed up when
 * it has enough bars for the slowest indicator (EMA-200) and critical indicators
 * are available. This is a one-way latch — once true, it never reverts.
 */
export interface DataQualityForWarmup {
  bars_1m_count: number;
  atr_available: boolean;
  vwap_available: boolean;
}

export function isWarmupComplete(quality: DataQualityForWarmup): boolean {
  return quality.bars_1m_count >= 200  // enough for EMA-200
    && quality.atr_available
    && quality.vwap_available;
}

export interface OpenTradeStateFile {
  schema_version: number;
  written_at: string;
  trade_id: string | null;
  position_side: string | null;
  qty_remaining: number | null;
  position: Position | null;
}

export interface LockFileContent {
  schema_version: number;
  pid: number;
  instance_id: string;
  started_at: string;
  session_id: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getAppVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // On Windows, process.kill(pid, 0) may not work reliably for non-Node processes.
    // Fall back to tasklist.
    if (process.platform === 'win32') {
      try {
        const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8' });
        return out.includes(String(pid));
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Atomic write: write to .tmp → fsync → rename over target.
 * Ensures the target file is never partially written.
 */
function atomicWriteJson(targetPath: string, data: unknown): void {
  const tmpPath = targetPath + '.tmp';
  const json = JSON.stringify(data, null, 2) + '\n';
  const fd = openSync(tmpPath, 'w');
  try {
    writeFileSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
}

/**
 * Corruption-safe JSON read. Returns null on missing/empty/invalid/schema-mismatch.
 */
function safeReadJson<T>(filePath: string, expectedSchemaVersion: number): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.schema_version !== expectedSchemaVersion) {
      console.warn(`[RUNTIME-STATE] Schema mismatch in ${filePath}: expected v${expectedSchemaVersion}, got v${parsed.schema_version}. Treating as unreadable.`);
      return null;
    }
    return parsed as T;
  } catch (err) {
    console.warn(`[RUNTIME-STATE] Failed to read ${filePath}: ${err instanceof Error ? err.message : err}. Treating as unreadable.`);
    return null;
  }
}

// ── RuntimeStateManager ───────────────────────────────────────────────────

export class RuntimeStateManager {
  private readonly logDir: string;
  private readonly lockPath: string;
  private readonly runtimeStatePath: string;
  private readonly openTradeStatePath: string;
  private readonly recoveryReportPath: string;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatStaleMs: number;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private state: RuntimeState | null = null;
  private instanceId: string;
  private appVersion: string;
  private lockReleased = false;

  constructor(
    logDir: string,
    opts: { heartbeatIntervalMs?: number; heartbeatStaleMs?: number } = {},
  ) {
    this.logDir = logDir;
    this.lockPath = join(logDir, 'runner.lock');
    this.runtimeStatePath = join(logDir, 'runtime_state.json');
    this.openTradeStatePath = join(logDir, 'open_trade_state.json');
    this.recoveryReportPath = join(logDir, 'recovery_report.json');
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 10_000;
    this.heartbeatStaleMs = opts.heartbeatStaleMs ?? 40_000;
    this.instanceId = randomUUID();
    this.appVersion = getAppVersion();
  }

  // ── Lock ──────────────────────────────────────────────────────────────

  /**
   * Acquire exclusive lock. Returns true if lock acquired, false if another instance is running.
   * Uses O_CREAT | O_EXCL for atomicity — two concurrent starts cannot both succeed.
   */
  acquireLock(sessionId: string): boolean {
    const lockContent: LockFileContent = {
      schema_version: LOCK_SCHEMA_VERSION,
      pid: process.pid,
      instance_id: this.instanceId,
      started_at: new Date().toISOString(),
      session_id: sessionId,
    };

    // Try exclusive create first
    try {
      const fd = openSync(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        writeFileSync(fd, JSON.stringify(lockContent, null, 2) + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.lockReleased = false;
      return true;
    } catch (err: unknown) {
      // File exists — check if stale
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err; // unexpected error
      }
    }

    // Lock file exists — check staleness
    const existing = safeReadJson<LockFileContent>(this.lockPath, LOCK_SCHEMA_VERSION);
    if (!existing) {
      // Corrupt or unreadable lock — remove and re-acquire
      console.warn('[RUNTIME-STATE] Lock file corrupt or unreadable. Removing stale lock.');
      this.forceRemoveLock();
      return this.acquireLock(sessionId);
    }

    if (isPidAlive(existing.pid)) {
      // PID is alive — could be PID reuse. Check started_at age.
      const lockAge = Date.now() - new Date(existing.started_at).getTime();
      if (lockAge > 24 * 60 * 60 * 1000) {
        // Very old lock with reused PID — likely stale
        console.warn(`[RUNTIME-STATE] Lock held by PID ${existing.pid} but started_at is >24h old. Assuming stale.`);
        this.forceRemoveLock();
        return this.acquireLock(sessionId);
      }
      // PID alive and lock is recent — another instance is running
      console.error(`[RUNTIME-STATE] Lock held by active PID ${existing.pid} (session: ${existing.session_id}, started: ${existing.started_at}).`);
      return false;
    }

    // PID is dead — stale lock
    console.warn(`[RUNTIME-STATE] Stale lock detected (PID ${existing.pid} is dead). Removing.`);
    this.forceRemoveLock();
    return this.acquireLock(sessionId);
  }

  /**
   * Release lock. Idempotent and non-throwing.
   * Safe to call multiple times (timeout path + finally block).
   */
  releaseLock(): void {
    if (this.lockReleased) return;
    this.lockReleased = true;
    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // Best effort — ENOENT or permission errors are acceptable
    }
  }

  private forceRemoveLock(): void {
    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // ignore
    }
  }

  // ── Stale .tmp cleanup ───────────────────────────────────────────────

  cleanupStaleTmpFiles(): string[] {
    const cleaned: string[] = [];
    const tmpSuffixes = ['runtime_state.json.tmp', 'open_trade_state.json.tmp', 'recovery_report.json.tmp'];
    for (const suffix of tmpSuffixes) {
      const p = join(this.logDir, suffix);
      if (existsSync(p)) {
        try {
          unlinkSync(p);
          cleaned.push(suffix);
          console.warn(`[RUNTIME-STATE] Cleaned stale temp file: ${suffix}`);
        } catch {
          // ignore
        }
      }
    }
    return cleaned;
  }

  // ── Runtime state ────────────────────────────────────────────────────

  readPrevious(): RuntimeState | null {
    // Accept both v1 (pre-cycle-activity) and v2 (current) schema versions.
    // v1 files are missing cycle activity fields — backfill with defaults.
    if (!existsSync(this.runtimeStatePath)) return null;
    try {
      const raw = readFileSync(this.runtimeStatePath, 'utf8').trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const sv = parsed.schema_version;
      if (sv !== 1 && sv !== RUNTIME_STATE_SCHEMA_VERSION) {
        console.warn(`[RUNTIME-STATE] Schema mismatch in runtime_state.json: expected v1 or v${RUNTIME_STATE_SCHEMA_VERSION}, got v${sv}. Treating as unreadable.`);
        return null;
      }
      // Backfill v2 fields if reading a v1 file
      if (sv === 1) {
        parsed.last_cycle_started_at = parsed.last_cycle_started_at ?? null;
        parsed.last_cycle_completed_at = parsed.last_cycle_completed_at ?? null;
        parsed.last_snapshot_ts = parsed.last_snapshot_ts ?? null;
        parsed.last_signal_decision_at = parsed.last_signal_decision_at ?? null;
        parsed.warmup_complete = parsed.warmup_complete ?? false;
      }
      return parsed as RuntimeState;
    } catch (err) {
      console.warn(`[RUNTIME-STATE] Failed to read runtime_state.json: ${err instanceof Error ? err.message : err}. Treating as unreadable.`);
      return null;
    }
  }

  initialize(sessionId: string, mode: ExecutionMode, restartMode: RestartMode): void {
    const now = new Date().toISOString();
    this.state = {
      schema_version: RUNTIME_STATE_SCHEMA_VERSION,
      app_version: this.appVersion,
      written_at: now,
      session_id: sessionId,
      started_at: now,
      last_heartbeat_at: now,
      shutdown_clean: false,
      shutdown_reason: null,
      open_position_known: false,
      open_trade_id: null,
      mode,
      restart_mode: restartMode,
      last_cycle_started_at: null,
      last_cycle_completed_at: null,
      last_snapshot_ts: null,
      last_signal_decision_at: null,
      warmup_complete: false,
    };
    atomicWriteJson(this.runtimeStatePath, this.state);
  }

  // ── Heartbeat ────────────────────────────────────────────────────────

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.state) return;
      this.state.last_heartbeat_at = new Date().toISOString();
      this.state.written_at = new Date().toISOString();
      try {
        atomicWriteJson(this.runtimeStatePath, this.state);
      } catch (err) {
        console.error('[RUNTIME-STATE] Heartbeat write failed:', err);
      }
    }, this.heartbeatIntervalMs);
    // Don't keep process alive just for heartbeat
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Position tracking ───────────────────────────────────────────────

  updatePositionKnown(tradeId: string | null): void {
    if (!this.state) return;
    this.state.open_position_known = tradeId !== null;
    this.state.open_trade_id = tradeId;
    this.state.written_at = new Date().toISOString();
    try {
      atomicWriteJson(this.runtimeStatePath, this.state);
    } catch (err) {
      console.error('[RUNTIME-STATE] Position update write failed:', err);
    }
  }

  writeOpenTradeState(position: Position | null): void {
    const file: OpenTradeStateFile = {
      schema_version: OPEN_TRADE_STATE_SCHEMA_VERSION,
      written_at: new Date().toISOString(),
      trade_id: position?.trade_id ?? null,
      position_side: position?.side ?? null,
      qty_remaining: position?.quantity_remaining ?? null,
      position,
    };
    try {
      atomicWriteJson(this.openTradeStatePath, file);
    } catch (err) {
      console.error('[RUNTIME-STATE] Open trade state write failed:', err);
    }
  }

  readOpenTradeState(): OpenTradeStateFile | null {
    return safeReadJson<OpenTradeStateFile>(this.openTradeStatePath, OPEN_TRADE_STATE_SCHEMA_VERSION);
  }

  // ── Cycle activity tracking ─────────────────────────────────────────
  // These methods only mutate the in-memory state object. The existing 10s
  // heartbeat timer writes the full state to disk — no extra disk I/O needed.

  updateCycleStart(): void {
    if (!this.state) return;
    this.state.last_cycle_started_at = new Date().toISOString();
  }

  updateCycleComplete(): void {
    if (!this.state) return;
    this.state.last_cycle_completed_at = new Date().toISOString();
  }

  /** Set to the market snapshot timestamp (snap.timestamp_iso), NOT wall clock. */
  updateSnapshotTs(ts: string): void {
    if (!this.state) return;
    this.state.last_snapshot_ts = ts;
  }

  updateSignalDecision(): void {
    if (!this.state) return;
    this.state.last_signal_decision_at = new Date().toISOString();
  }

  /** One-way latch: once warmup is complete, it never reverts. */
  markWarmupComplete(): void {
    if (!this.state) return;
    this.state.warmup_complete = true;
  }

  isWarmupComplete(): boolean {
    return this.state?.warmup_complete ?? false;
  }

  // ── Clean shutdown ──────────────────────────────────────────────────

  /**
   * Mark shutdown as clean. Stops heartbeat first to prevent race.
   * All operations are synchronous.
   */
  markCleanShutdown(reason: string): void {
    this.stopHeartbeat();
    if (!this.state) return;
    this.state.shutdown_clean = true;
    this.state.shutdown_reason = reason;
    this.state.written_at = new Date().toISOString();
    atomicWriteJson(this.runtimeStatePath, this.state);
  }

  // ── Recovery report ─────────────────────────────────────────────────

  writeRecoveryReport(report: unknown): void {
    atomicWriteJson(this.recoveryReportPath, report);
  }

  // ── Accessors for recovery logic ────────────────────────────────────

  getHeartbeatStaleMs(): number {
    return this.heartbeatStaleMs;
  }

  getRuntimeStatePath(): string {
    return this.runtimeStatePath;
  }

  getOpenTradeStatePath(): string {
    return this.openTradeStatePath;
  }

  getLogDir(): string {
    return this.logDir;
  }
}
