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

  /** Monotonic sequence counter for all records in trade_path.jsonl. */
  private tradePathSeq = 0;

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
  }

  writeTradePathPoint(point: unknown): void {
    const record = typeof point === 'object' && point !== null
      ? { ...point, seq: this.tradePathSeq++ }
      : point;
    this.appendLine(this.tradePathPath, record);
  }

  /** Write a structured management event (PT1, PT2, trail ratchet, etc.) to trade_path.jsonl. */
  writeManagementEvent(event: ManagementEvent): void {
    this.appendLine(this.tradePathPath, { ...event, seq: this.tradePathSeq++ });
  }

  /** Write periodic lane scheduler metrics. */
  writeLaneMetrics(record: unknown): void {
    this.appendLine(this.laneMetricsPath, record);
  }

  /** Write a structured execution lifecycle event (entry/exit submitted, filled, closed). */
  writeExecutionIntent(record: {
    event: 'trade_entry_submitted' | 'trade_entry_filled' | 'trade_exit_submitted' | 'trade_exit_filled' | 'trade_closed';
    timestamp: string;
    trade_id: string;
    side: 'long' | 'short';
    source: string;
    reason?: string;
    price?: number;
    quantity?: number;
    slippage_pts?: number;
    fee_usd?: number;
    order_id?: string;
    pnl_realized?: number;
    r_multiple?: number;
    outcome_class?: string;
  }): void {
    this.appendLineImmediate(this.executionIntentsPath, record);
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
    this.appendLineImmediate(this.tradesPath, trade);
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
    this.appendLine(join(this.logDir, 'ml_management_actions.jsonl'), record);
  }

  /**
   * Write exact ML management feature payload + response to a dedicated log.
   * Logs the exact serialized request/response bodies for reproducibility.
   * Uses day-based rotation: ml_management_features_YYYYMMDD.jsonl
   */
  writeMlManagementFeatures(record: unknown): void {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    this.appendLine(join(this.logDir, `ml_management_features_${date}.jsonl`), record);
  }

  /** Write a candidate entry signal to the canonical candidate log. */
  writeCandidateSignal(record: unknown): void {
    this.appendLine(join(this.logDir, 'candidate_signals.jsonl'), record);
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
      console.error(`[LOG] Failed to write to ${filePath}:`, err);
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
