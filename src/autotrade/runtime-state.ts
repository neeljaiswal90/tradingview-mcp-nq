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
import { APP_BUILD_SHA } from '../shared/app-version.js';
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
  last_cycle_number: number | null;
  /** One-way latch: transitions false → true when data quality meets readiness threshold. */
  warmup_complete: boolean;
  warmup_completed_at: string | null;
  warmup_features_valid: boolean;
  /** Resolved ML policy mode for audit (optional — added by runner after config merge). */
  ml_policy_mode?: string | null;
  /** Configured management model version string at startup. */
  ml_model_version?: string | null;
  /** Short config content hash (see computeConfigHash). */
  config_sha_short?: string | null;
  /** Git / build SHA for this binary. */
  code_sha?: string | null;
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

// getAppVersion() now lives in src/shared/app-version.ts as APP_BUILD_SHA.
// The runtime-state file keeps using the git short SHA as its "app_version"
// field for continuity with existing runtime_state.json files.

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeIsoString(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? fallback : value;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeMode(value: unknown): ExecutionMode {
  return value === 'live' || value === 'signal_only' ? value : 'paper';
}

function normalizeRestartMode(value: unknown): RestartMode {
  return value === 'prod' ? 'prod' : 'dev';
}

function normalizeRuntimeStateRecord(raw: unknown, appVersion: string): RuntimeState | null {
  if (!isPlainRecord(raw)) return null;
  const schemaVersion = raw['schema_version'];
  if (schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION) {
    return null;
  }

  const writtenAt = normalizeIsoString(raw['written_at'], new Date().toISOString());
  const startedAt = normalizeIsoString(raw['started_at'], writtenAt);
  const lastHeartbeatAt = normalizeIsoString(raw['last_heartbeat_at'], writtenAt);
  const sessionId = typeof raw['session_id'] === 'string' && raw['session_id'].trim().length > 0
    ? raw['session_id']
    : 'unknown_session';

  return {
    schema_version: RUNTIME_STATE_SCHEMA_VERSION,
    app_version: typeof raw['app_version'] === 'string' && raw['app_version'].trim().length > 0
      ? raw['app_version']
      : appVersion,
    written_at: writtenAt ?? new Date().toISOString(),
    session_id: sessionId,
    started_at: startedAt ?? new Date().toISOString(),
    last_heartbeat_at: lastHeartbeatAt ?? new Date().toISOString(),
    shutdown_clean: raw['shutdown_clean'] === true,
    shutdown_reason: normalizeNullableString(raw['shutdown_reason']),
    open_position_known: raw['open_position_known'] === true,
    open_trade_id: normalizeNullableString(raw['open_trade_id']),
    mode: normalizeMode(raw['mode']),
    restart_mode: normalizeRestartMode(raw['restart_mode']),
    last_cycle_started_at: normalizeIsoString(raw['last_cycle_started_at']),
    last_cycle_completed_at: normalizeIsoString(raw['last_cycle_completed_at']),
    last_snapshot_ts: normalizeNullableString(raw['last_snapshot_ts']),
    last_signal_decision_at: normalizeIsoString(raw['last_signal_decision_at']),
    last_cycle_number: normalizeNullableNumber(raw['last_cycle_number']),
    warmup_complete: raw['warmup_complete'] === true,
    warmup_completed_at: normalizeIsoString(raw['warmup_completed_at']),
    warmup_features_valid: raw['warmup_features_valid'] === true,
  };
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
  private readonly hardeningEnabled: boolean;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private state: RuntimeState | null = null;
  private instanceId: string;
  private appVersion: string;
  private lockReleased = false;

  constructor(
    logDir: string,
    opts: { heartbeatIntervalMs?: number; heartbeatStaleMs?: number; hardeningEnabled?: boolean } = {},
  ) {
    this.logDir = logDir;
    this.lockPath = join(logDir, 'runner.lock');
    this.runtimeStatePath = join(logDir, 'runtime_state.json');
    this.openTradeStatePath = join(logDir, 'open_trade_state.json');
    this.recoveryReportPath = join(logDir, 'recovery_report.json');
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 10_000;
    this.heartbeatStaleMs = opts.heartbeatStaleMs ?? 40_000;
    this.hardeningEnabled = opts.hardeningEnabled ?? (process.env['AUTOTRADE_RUNTIME_STATE_HARDENING'] === '1');
    this.instanceId = randomUUID();
    this.appVersion = APP_BUILD_SHA;
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
    if (!this.hardeningEnabled) {
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
          parsed.last_cycle_number = parsed.last_cycle_number ?? null;
          parsed.warmup_complete = parsed.warmup_complete ?? false;
          parsed.warmup_completed_at = parsed.warmup_completed_at ?? null;
          parsed.warmup_features_valid = parsed.warmup_features_valid ?? false;
        }
        return parsed as RuntimeState;
      } catch (err) {
        console.warn(`[RUNTIME-STATE] Failed to read runtime_state.json: ${err instanceof Error ? err.message : err}. Treating as unreadable.`);
        return null;
      }
    }
    if (!existsSync(this.runtimeStatePath)) {
      return null;
    }

    try {
      const raw = readFileSync(this.runtimeStatePath, 'utf8').trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      const normalized = normalizeRuntimeStateRecord(parsed, this.appVersion);
      if (normalized) {
        console.warn('[RUNTIME-STATE] Recovered partial runtime_state.json using fallback defaults.');
        return normalized;
      }
    } catch (err) {
      console.warn(
        `[RUNTIME-STATE] Hardening fallback could not recover ${this.runtimeStatePath}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }

    return null;
  }

  private persistState(): void {
    if (!this.state) return;
    this.state.written_at = new Date().toISOString();
    atomicWriteJson(this.runtimeStatePath, this.state);
  }

  private patchState(patch: Partial<RuntimeState>): void {
    if (!this.state) return;
    this.state = {
      ...this.state,
      ...patch,
      written_at: new Date().toISOString(),
    };
    try {
      atomicWriteJson(this.runtimeStatePath, this.state);
    } catch (err) {
      console.error('[RUNTIME-STATE] State update write failed:', err);
    }
  }

  /** Stamp ML governance fields for single-file provenance answers. */
  patchMlGovernance(patch: {
    ml_policy_mode: string;
    ml_model_version: string | null;
    config_sha_short: string;
    code_sha: string;
  }): void {
    this.patchState({
      ml_policy_mode: patch.ml_policy_mode,
      ml_model_version: patch.ml_model_version,
      config_sha_short: patch.config_sha_short,
      code_sha: patch.code_sha,
    });
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
      last_cycle_number: null,
      warmup_complete: false,
      warmup_completed_at: null,
      warmup_features_valid: false,
    };
    atomicWriteJson(this.runtimeStatePath, this.state);
  }

  // ── Heartbeat ────────────────────────────────────────────────────────

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.state) return;
      this.state.last_heartbeat_at = new Date().toISOString();
      try {
        this.persistState();
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
    this.patchState({
      open_position_known: tradeId !== null,
      open_trade_id: tradeId,
    });
  }

  markSnapshotAcquired(snapshotTimestamp: string | null, cycleNumber?: number): void {
    this.patchState({
      last_snapshot_ts: snapshotTimestamp,
      last_cycle_number: cycleNumber ?? this.state?.last_cycle_number ?? null,
    });
  }

  markSignalDecision(cycleNumber?: number): void {
    this.patchState({
      last_signal_decision_at: new Date().toISOString(),
      last_cycle_number: cycleNumber ?? this.state?.last_cycle_number ?? null,
    });
  }

  markCycleCompleted(cycleNumber?: number): void {
    this.patchState({
      last_cycle_completed_at: new Date().toISOString(),
      last_cycle_number: cycleNumber ?? this.state?.last_cycle_number ?? null,
    });
  }

  setWarmupStatus(opts: {
    warmup_complete: boolean;
    warmup_features_valid: boolean;
    warmup_completed_at?: string | null;
  }): void {
    this.patchState({
      warmup_complete: opts.warmup_complete,
      warmup_features_valid: opts.warmup_features_valid,
      warmup_completed_at:
        opts.warmup_complete
          ? (opts.warmup_completed_at ?? new Date().toISOString())
          : (opts.warmup_completed_at ?? null),
    });
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

  /** One-way latch: once warmup is complete, it never reverts. Persisted to disk. */
  markWarmupComplete(): void {
    if (!this.state) return;
    if (this.state.warmup_complete) return; // already latched
    this.patchState({
      warmup_complete: true,
      warmup_completed_at: new Date().toISOString(),
    });
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
    this.persistState();
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

// ─── Orderflow Runtime State ─────────────────────────────────────────────────
//
// Phase 2 of the quant trend-pullback refactor (plan §4.1 row for
// `runtime-state.ts` and §4.3 `orderflow` config subsection).
//
// This is a tightly-scoped, in-memory-only container for rolling LOB
// derived features (OFI contributions, z-score history). It is NOT
// persisted to disk — it rebuilds from scratch on every process launch
// and session rollover. It lives in this file so every generator call
// site has one obvious place to reach for rolling orderflow state.
//
// Scope rules (enforced by convention, not types):
//   - ONLY orderflow rolling buffers live here. This is not a generic
//     "dump anything runtime-ish" bag. Adding a new field requires
//     editing fizzy-skipping-wind.md first.
//   - Every buffer entry is keyed by (instrument, session_id) and carries
//     an explicit `last_snap_ts_ms` so callers can detect gaps / resets.
//   - History arrays are capped to `ORDERFLOW_HISTORY_MAX_SAMPLES` so
//     memory usage is bounded even if a session runs unusually long.

/** Max number of per-window OFI samples retained for z-score stats. */
export const ORDERFLOW_HISTORY_MAX_SAMPLES = 300;

/** One snapshot-delta OFI contribution, timestamped. */
export interface OrderflowContribution {
  ts_ms: number;
  /** OFI contribution for this snapshot step (snapshot-delta). */
  e: number;
}

/** Per-(instrument, session) rolling buffer for the orderflow engine. */
export interface OrderflowRollingBuffer {
  instrument: string;
  session_id: string;
  /** ms timestamp of the most recent snapshot fed into this buffer. */
  last_snap_ts_ms: number | null;
  last_best_bid: number | null;
  last_best_ask: number | null;
  last_bid_size: number | null;
  last_ask_size: number | null;
  /** Ordered-ascending window contributions, all within the last 30s. */
  contributions: OrderflowContribution[];
  /** Historical window totals, used to compute rolling mean/std for z. */
  ofi_10s_history: number[];
  ofi_30s_history: number[];
  /**
   * True when the z-score history has reached the warmup threshold
   * (ORDERFLOW_Z_WARMUP_SAMPLES). Set by the orderflow engine after
   * enough snapshots have been processed, or by the startup restoration
   * path when replaying historical LOB snapshots.
   */
  orderflow_buffer_ready: boolean;
  /** Source of the buffer's initial state: 'cold' (default), 'restored' (from logs). */
  orderflow_buffer_init_source: 'cold' | 'restored';
}

const orderflowRuntimeState = new Map<string, OrderflowRollingBuffer>();

function orderflowKey(instrument: string, sessionId: string): string {
  return `${instrument}::${sessionId}`;
}

/**
 * Fetch (or lazily create) the orderflow rolling buffer for a given
 * (instrument, session_id) pair. The buffer is mutated in place by
 * features/orderflow-state.ts. Callers should not hold on to the
 * returned reference across session boundaries.
 */
export function getOrderflowBuffer(
  instrument: string,
  sessionId: string,
): OrderflowRollingBuffer {
  const key = orderflowKey(instrument, sessionId);
  let buf = orderflowRuntimeState.get(key);
  if (!buf) {
    buf = {
      instrument,
      session_id: sessionId,
      last_snap_ts_ms: null,
      last_best_bid: null,
      last_best_ask: null,
      last_bid_size: null,
      last_ask_size: null,
      contributions: [],
      ofi_10s_history: [],
      ofi_30s_history: [],
      orderflow_buffer_ready: false,
      orderflow_buffer_init_source: 'cold',
    };
    orderflowRuntimeState.set(key, buf);
  }
  return buf;
}

/**
 * Drop every orderflow buffer — primarily for tests and hot-reload
 * scenarios. Production code should never need to call this.
 */
export function resetOrderflowRuntimeState(): void {
  orderflowRuntimeState.clear();
}

// ── Orderflow buffer persistence ──────────────────────────────────────────
//
// Phase 4: persist the rolling buffer on clean shutdown so the next startup
// can restore z-score state instantly, without replaying LOB snapshots from
// disk (which only helps if the snapshot log is recent enough).

export interface PersistedOrderflowBuffer {
  instrument: string;
  session_id: string;
  last_snap_ts_ms: number | null;
  last_best_bid: number | null;
  last_best_ask: number | null;
  last_bid_size: number | null;
  last_ask_size: number | null;
  contributions: { ts_ms: number; e: number }[];
  ofi_10s_history: number[];
  ofi_30s_history: number[];
  orderflow_buffer_ready: boolean;
  persisted_at: string;
}

export interface PersistedOrderflowState {
  schema_version: 1;
  buffers: PersistedOrderflowBuffer[];
}

/**
 * Serialize all active orderflow buffers to a JSON-compatible object.
 * Called at clean shutdown.
 */
export function serializeOrderflowBuffers(): PersistedOrderflowState {
  const buffers: PersistedOrderflowBuffer[] = [];
  const now = new Date().toISOString();
  for (const buf of orderflowRuntimeState.values()) {
    buffers.push({
      instrument: buf.instrument,
      session_id: buf.session_id,
      last_snap_ts_ms: buf.last_snap_ts_ms,
      last_best_bid: buf.last_best_bid,
      last_best_ask: buf.last_best_ask,
      last_bid_size: buf.last_bid_size,
      last_ask_size: buf.last_ask_size,
      contributions: buf.contributions.slice(),
      ofi_10s_history: buf.ofi_10s_history.slice(),
      ofi_30s_history: buf.ofi_30s_history.slice(),
      orderflow_buffer_ready: buf.orderflow_buffer_ready,
      persisted_at: now,
    });
  }
  return { schema_version: 1, buffers };
}

/**
 * Restore orderflow buffers from a previously persisted state. Only
 * restores buffers that don't already exist in the runtime state
 * (i.e., won't overwrite a buffer that was already populated by
 * LOB snapshot replay).
 *
 * Returns the number of buffers actually restored.
 */
export function restoreOrderflowBuffersFromPersisted(
  state: PersistedOrderflowState,
  maxAgeMs: number = 3_600_000,
): number {
  if (state.schema_version !== 1) return 0;
  const now = Date.now();
  let restored = 0;

  for (const pb of state.buffers) {
    const persistedTs = new Date(pb.persisted_at).getTime();
    if (now - persistedTs > maxAgeMs) continue;

    const key = orderflowKey(pb.instrument, pb.session_id);
    if (orderflowRuntimeState.has(key)) {
      const existing = orderflowRuntimeState.get(key)!;
      if (existing.ofi_10s_history.length > 0) continue;
    }

    const buf: OrderflowRollingBuffer = {
      instrument: pb.instrument,
      session_id: pb.session_id,
      last_snap_ts_ms: pb.last_snap_ts_ms,
      last_best_bid: pb.last_best_bid,
      last_best_ask: pb.last_best_ask,
      last_bid_size: pb.last_bid_size,
      last_ask_size: pb.last_ask_size,
      contributions: pb.contributions.slice(),
      ofi_10s_history: pb.ofi_10s_history.slice(),
      ofi_30s_history: pb.ofi_30s_history.slice(),
      orderflow_buffer_ready: pb.orderflow_buffer_ready,
      orderflow_buffer_init_source: 'restored',
    };
    orderflowRuntimeState.set(key, buf);
    restored++;
  }
  return restored;
}

/**
 * Save orderflow buffer state to disk. Called during clean shutdown.
 */
export function persistOrderflowBuffersToDisk(runtimeDir: string): void {
  const state = serializeOrderflowBuffers();
  if (state.buffers.length === 0) return;
  const filePath = join(runtimeDir, 'orderflow_buffer_state.json');
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Load persisted orderflow buffer state from disk and restore into
 * runtime state. Returns the number of buffers restored.
 */
export function loadAndRestoreOrderflowBuffers(
  runtimeDir: string,
  maxAgeMs: number = 3_600_000,
): number {
  const filePath = join(runtimeDir, 'orderflow_buffer_state.json');
  if (!existsSync(filePath)) return 0;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const state = JSON.parse(raw) as PersistedOrderflowState;
    return restoreOrderflowBuffersFromPersisted(state, maxAgeMs);
  } catch {
    return 0;
  }
}

/** List current orderflow buffer keys (for diagnostics and tests). */
export function listOrderflowBufferKeys(): string[] {
  return Array.from(orderflowRuntimeState.keys());
}
