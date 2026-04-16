import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import type {
  Signal,
  TradeRecord,
  SessionRecord,
  IndicatorChangeRecord,
  PerformanceStats,
  ManagementEvent,
} from './types.js';
import type { ExecutionIntentRecord } from './execution-intent-types.js';

const LOG_CONTRACT_V2 = 'contract_v2' as const;

function withLogContract<T extends object>(record: T): T & { log_contract: typeof LOG_CONTRACT_V2 } {
  return { ...record, log_contract: LOG_CONTRACT_V2 };
}

export class LogWriter {
  private readonly logDir: string;
  private readonly signalsPath: string;
  private readonly tradesPath: string;
  private readonly sessionsPath: string;
  private readonly indicatorChangesPath: string;
  private readonly perfPath: string;

  private readonly tradePathPath: string;
  private readonly rejectedSignalsPath: string;
  private readonly laneMetricsPath: string;
  private readonly executionIntentsPath: string;
  private readonly lobMboScalpCandidatesPath: string;

  /** Monotonic sequence counter for all records in trade_path.jsonl. */
  private tradePathSeq = 0;

  /** Optional callback invoked when appendLineImmediate (critical-path write) fails. */
  private onCriticalDiskError?: (filePath: string, err: unknown) => void;

  constructor(logDir: string) {
    this.logDir = logDir;
    // Ensure log directory exists
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    this.signalsPath = join(logDir, 'signals.jsonl');
    this.tradesPath = join(logDir, 'trades.jsonl');
    this.sessionsPath = join(logDir, 'sessions.jsonl');
    this.indicatorChangesPath = join(logDir, 'indicator_changes.jsonl');
    this.perfPath = join(logDir, 'performance.json');
    this.tradePathPath = join(logDir, 'trade_path.jsonl');
    this.rejectedSignalsPath = join(logDir, 'rejected_signals.jsonl');
    this.laneMetricsPath = join(logDir, 'lane_metrics.jsonl');
    this.executionIntentsPath = join(logDir, 'execution_intents.jsonl');
    this.lobMboScalpCandidatesPath = join(logDir, 'lob_mbo_scalp_candidates.jsonl');
  }

  /** Register a callback for critical-path disk write failures (trade fills, execution intents). */
  setOnCriticalDiskError(cb: (filePath: string, err: unknown) => void): void {
    this.onCriticalDiskError = cb;
  }

  writeTradePathPoint(point: unknown): void {
    const record = typeof point === 'object' && point !== null
      ? withLogContract({ ...point, seq: this.tradePathSeq++ })
      : point;
    this.appendLine(this.tradePathPath, record);
  }

  /** Write a structured management event (PT1, PT2, trail ratchet, etc.) to trade_path.jsonl. */
  writeManagementEvent(event: ManagementEvent): void {
    this.appendLine(this.tradePathPath, withLogContract({ ...event, seq: this.tradePathSeq++ }));
  }

  /** Write periodic lane scheduler metrics. */
  writeLaneMetrics(record: unknown): void {
    this.appendLine(this.laneMetricsPath, record);
  }

  /** Write a structured execution lifecycle event (entry/exit submitted, filled, closed). */
  writeExecutionIntent(record: ExecutionIntentRecord): void {
    this.appendLineImmediate(this.executionIntentsPath, withLogContract({ ...record }));
  }

  writeRejectedSignal(record: unknown): void {
    this.appendLine(this.rejectedSignalsPath, record);
  }

  readAllTrades(): TradeRecord[] {
    try {
      if (!existsSync(this.tradesPath)) return [];
      const raw = readFileSync(this.tradesPath, 'utf8');
      const trades: TradeRecord[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          trades.push(JSON.parse(trimmed) as TradeRecord);
        } catch {
          // skip corrupt lines
        }
      }
      return trades;
    } catch {
      return [];
    }
  }

  writeSignal(signal: Signal): void {
    this.appendLine(this.signalsPath, signal);
  }

  writeTrade(trade: TradeRecord): void {
    this.appendLineImmediate(this.tradesPath, withLogContract({ ...trade }));
  }

  writeSession(session: SessionRecord): void {
    this.appendLine(this.sessionsPath, session);
  }

  writeIndicatorChange(change: IndicatorChangeRecord): void {
    this.appendLine(this.indicatorChangesPath, change);
  }

  writePerformance(stats: PerformanceStats): void {
    try {
      writeFileSync(this.perfPath, JSON.stringify(stats, null, 2), 'utf8');
    } catch (err) {
      console.error('[LOG] Failed to write performance.json:', err);
    }
  }

  readPerformance(): PerformanceStats | null {
    try {
      if (!existsSync(this.perfPath)) return null;
      const raw = readFileSync(this.perfPath, 'utf8');
      return JSON.parse(raw) as PerformanceStats;
    } catch {
      return null;
    }
  }

  updateSessionEnd(sessionId: string, updates: Partial<SessionRecord>): void {
    // Sessions are append-only JSONL — append an update record with _type=update
    // Use immediate write: this is a critical shutdown record
    this.appendLineImmediate(this.sessionsPath, { _type: 'session_update', session_id: sessionId, ...updates, timestamp: new Date().toISOString() });
  }


  /** Write an ML management decision to structured log. */
  writeMlManagementAction(record: unknown): void {
    const row = typeof record === 'object' && record !== null
      ? withLogContract({ ...(record as object) })
      : record;
    this.appendLine(join(this.logDir, 'ml_management_actions.jsonl'), row);
  }

  /**
   * Write exact ML management feature payload + response to a dedicated log.
   * Logs the exact serialized request/response bodies for reproducibility.
   * Uses day-based rotation: ml_management_features_YYYYMMDD.jsonl
   */
  writeMlManagementFeatures(record: unknown): void {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const row = typeof record === 'object' && record !== null
      ? withLogContract({ ...(record as object) })
      : record;
    this.appendLine(join(this.logDir, `ml_management_features_${date}.jsonl`), row);
  }

  /**
   * Write exact entry-ML request/response payloads for train/serve parity.
   * Uses day-based rotation: entry_ml_features_YYYYMMDD.jsonl
   */
  writeEntryMlFeatures(record: unknown): void {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    this.appendLine(join(this.logDir, `entry_ml_features_${date}.jsonl`), record);
  }

  /** Write a candidate entry signal to the canonical candidate log. */
  writeCandidateSignal(record: unknown): void {
    this.appendLine(join(this.logDir, 'candidate_signals.jsonl'), record);
  }

  /** Isolated hypothetical / shadow replay rows — never mixed into execution_intents. */
  appendManagementShadowReplay(record: unknown): void {
    const row = typeof record === 'object' && record !== null
      ? withLogContract({ ...(record as object) })
      : record;
    this.appendLine(join(this.logDir, 'management_shadow_replay.jsonl'), row);
  }

  /**
   * Append one raw row to lob_mbo_scalp_candidates.jsonl.
   *
   * This is the low-level instance method. External callers should use the
   * module-level `writeLobMboScalpCandidate` wrapper below, which handles
   * the metadata header row and rejection-sampling bookkeeping. This
   * method is public only so the wrapper can reach through without a
   * friend-access pattern.
   */
  appendLobMboScalpCandidateLine(record: unknown): void {
    this.appendLine(this.lobMboScalpCandidatesPath, record);
  }

  /**
   * Write one row to the Phase 3 candidate score telemetry log.
   *
   * Contract: exactly ONE row per candidate evaluation event. Callers
   * must only invoke this at the primary candidate event site (not at
   * follow-up rejection events). The row carries a stable `candidate_id`
   * that joins 1:1 with `executed_trades.parent_signal_id`, and a
   * `candidate_replay_key` that is deterministic across replays.
   */
  writeCandidateScoreV2(record: unknown): void {
    this.appendLine(join(this.logDir, 'candidate_scores_v2.jsonl'), record);
  }

  // ── Buffered write infrastructure ─────────────────────────────────────────

  private writeBuffers: Map<string, string[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly FLUSH_THRESHOLD = 20;

  /** Start the periodic flush timer. Call once after construction. */
  startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flushAll(), LogWriter.FLUSH_INTERVAL_MS);
  }

  /**
   * Buffered write — enqueues to in-memory buffer, flushed periodically or at threshold.
   * Up to 500ms of data at risk on hard crash — acceptable for telemetry.
   * Do NOT use for critical records (trade fills, execution intents).
   */
  private appendLine(filePath: string, record: unknown): void {
    try {
      const line = JSON.stringify(record) + '\n';
      let buf = this.writeBuffers.get(filePath);
      if (!buf) {
        buf = [];
        this.writeBuffers.set(filePath, buf);
      }
      buf.push(line);
      if (buf.length >= LogWriter.FLUSH_THRESHOLD) {
        this.flushFile(filePath);
      }
    } catch (err) {
      console.error(`[LOG] Failed to buffer for ${filePath}:`, err);
    }
  }

  /**
   * Immediate write — bypasses buffer entirely, writes directly to disk.
   * Reserved for infrequent critical records only (~1-5 per trade lifecycle):
   * trade fills, execution intents, position close records.
   */
  private appendLineImmediate(filePath: string, record: unknown): void {
    try {
      appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      console.error(`[LOG] [CRITICAL] Failed to write to ${filePath}:`, err);
      if (this.onCriticalDiskError) {
        try { this.onCriticalDiskError(filePath, err); } catch { /* callback must not throw */ }
      }
    }
  }

  private flushFile(filePath: string): void {
    const buf = this.writeBuffers.get(filePath);
    if (!buf || buf.length === 0) return;
    try {
      appendFileSync(filePath, buf.join(''), 'utf8');
      this.writeBuffers.set(filePath, []);
    } catch (err) {
      console.error(`[LOG] Flush failed for ${filePath}:`, err);
    }
  }

  /** Flush all buffered writes to disk. */
  flushAll(): void {
    for (const filePath of this.writeBuffers.keys()) {
      this.flushFile(filePath);
    }
  }

  /** Stop flush timer and flush remaining data. Call on shutdown. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAll();
  }
}

// ─── Scalper candidate log (module-level API) ───────────────────────────────
//
// The scalper generator in src/autotrade/strategies/lob-mbo-scalp.ts runs
// inside the pure `(snap, config, lobSnapshot) => StrategyGeneratorEvaluation`
// contract and does not have a reference to the runner's LogWriter instance.
// To avoid threading the writer through every generator signature, the
// runner calls `registerScalperLogWriter(this.logWriter)` once at startup
// and the generator imports the module-level `writeLobMboScalpCandidate`
// function below.
//
// The module-level wrapper owns three responsibilities the instance method
// does NOT handle:
//
//   1. Emit a `{"meta": true, ...}` header row exactly once per registration.
//      Every reader of lob_mbo_scalp_candidates.jsonl (see
//      scripts/_scalper-exclusion.mjs and mirrors) already skips meta rows.
//
//   2. Deterministic 1:N rejection sampling. Default rate is 1 (no
//      sampling) so early shadow data is unbiased — the user can raise
//      it later when log volume becomes a concern.
//
//   3. `sample_weight` bookkeeping. Passes are always weight 1. Unsampled
//      rejects are dropped entirely. Sampled rejects carry `weight = N`
//      so the Phase 4.4 trainer can apply `sample_weight=N` in the loss
//      and recover an unbiased population estimate.
//
// No-op when no writer has been registered — unit tests that don't need
// writer integration simply never register, and the generator's call
// becomes a silent no-op.

let _scalperLogWriter: LogWriter | null = null;
let _scalperLogHeaderWritten: boolean = false;
let _scalperRejectionSampleRate: number = 1;
let _scalperRejectCounter: number = 0;

/**
 * Phase 7: optional dashboard observer. The runner registers one
 * callback at startup that forwards every scalper candidate row into
 * the `DashboardStateManager` family-metrics path. Registration is
 * separate from the LogWriter registration because the two concerns
 * live in different modules and have different lifetimes during
 * tests. A missing observer is a silent no-op — the log writer
 * continues to write JSONL rows unaffected.
 */
let _scalperDashboardObserver: ((record: Record<string, unknown>) => void) | null = null;

/**
 * Register a dashboard observer callback. The runner calls this once
 * at startup after constructing its DashboardStateManager. Passing
 * null unregisters. The observer fires AFTER the writer has
 * persisted the row, so a failed disk write never blocks dashboard
 * telemetry and vice versa.
 */
export function registerScalperDashboardObserver(
  observer: ((record: Record<string, unknown>) => void) | null,
): void {
  _scalperDashboardObserver = observer;
}

/**
 * Register a LogWriter instance as the destination for scalper candidate
 * rows. Runner calls this once during startup after constructing its
 * LogWriter. Passing null unregisters (shutdown path).
 *
 * Registration resets the header-written flag so a fresh session always
 * emits a new header row with the current sample rate.
 */
export function registerScalperLogWriter(writer: LogWriter | null): void {
  _scalperLogWriter = writer;
  _scalperLogHeaderWritten = false;
  _scalperRejectCounter = 0;
}

/**
 * Set the rejection sampling rate. Rate >= 1, integer. A rate of 1 means
 * "log every reject" (no sampling). Rate of N > 1 means "log every Nth
 * reject with sample_weight = N".
 *
 * Does NOT reset the header-written flag — the header row reflects the
 * rate at the moment of the first write. Callers who want the log file
 * to advertise a new rate should unregister + re-register.
 */
export function setScalperRejectionSampleRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 1) {
    throw new Error(
      `scalper rejection_sample_rate must be a finite number >= 1, got ${rate}`,
    );
  }
  _scalperRejectionSampleRate = Math.floor(rate);
  _scalperRejectCounter = 0;
}

/** Read the current rate (for diagnostics and header emission). */
export function getScalperRejectionSampleRate(): number {
  return _scalperRejectionSampleRate;
}

/**
 * Decide whether a reject row should be logged under the current rate.
 *
 * Rate 1  → { sample: true, weight: 1 }  every call
 * Rate N>1:
 *   - Counter increments on each call.
 *   - Every Nth call returns { sample: true, weight: N } and resets the counter.
 *   - All other calls return { sample: false, weight: 0 } (caller drops the row).
 *
 * Mutates the module-level counter. Called by the scalper generator on
 * every reject; passes (emission canary) do NOT go through this — they
 * are logged with weight 1 unconditionally.
 */
export function shouldSampleScalperReject(): { sample: boolean; weight: number } {
  if (_scalperRejectionSampleRate <= 1) {
    return { sample: true, weight: 1 };
  }
  _scalperRejectCounter += 1;
  if (_scalperRejectCounter >= _scalperRejectionSampleRate) {
    _scalperRejectCounter = 0;
    return { sample: true, weight: _scalperRejectionSampleRate };
  }
  return { sample: false, weight: 0 };
}

/**
 * Main scalper log API. Called by the generator in
 * src/autotrade/strategies/lob-mbo-scalp.ts on every evaluation that
 * should be recorded.
 *
 * No-ops when no writer has been registered. On the first call after
 * registration, emits a metadata header row capturing the current
 * rejection sample rate — downstream readers skip rows where
 * `row.meta === true` via the contamination-firewall helper.
 *
 * The caller is responsible for deciding whether a given row should be
 * written at all — this function unconditionally writes whatever it
 * receives. Use `shouldSampleScalperReject()` to honor the sampling
 * rate for rejects, and always write passes with `sample_weight: 1`.
 */
export function writeLobMboScalpCandidate(record: Record<string, unknown>): void {
  const writer = _scalperLogWriter;
  if (writer === null) return;

  if (!_scalperLogHeaderWritten) {
    writer.appendLobMboScalpCandidateLine({
      meta: true,
      schema_version: '1.0',
      rejection_sample_rate: _scalperRejectionSampleRate,
      written_at: new Date().toISOString(),
    });
    _scalperLogHeaderWritten = true;
  }

  writer.appendLobMboScalpCandidateLine(record);

  // Phase 7: forward to the dashboard observer AFTER the disk write,
  // never blocking the write path. The observer is expected to be
  // synchronous and never throw; if it does, we swallow the error so a
  // buggy dashboard cannot corrupt the training log pipeline.
  const observer = _scalperDashboardObserver;
  if (observer !== null) {
    try {
      observer(record);
    } catch (err) {
      // Observer errors must never propagate back into the generator.
      console.warn(
        `[SCALPER_LOG] Dashboard observer threw on record ts_ms=${record['ts_ms']}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Test-only: reset ALL module-level scalper log state. Vitest suites call
 * this in `beforeEach` to isolate cases — otherwise module state leaks
 * between tests because the module is evaluated once per worker.
 */
export function _resetScalperLogModuleStateForTests(): void {
  _scalperLogWriter = null;
  _scalperLogHeaderWritten = false;
  _scalperRejectionSampleRate = 1;
  _scalperRejectCounter = 0;
  _scalperDashboardObserver = null;
}
