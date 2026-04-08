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
  }

  writeTradePathPoint(point: unknown): void {
    this.appendLine(this.tradePathPath, point);
  }

  /** Write a structured management event (PT1, PT2, trail ratchet, etc.) to trade_path.jsonl. */
  writeManagementEvent(event: ManagementEvent): void {
    this.appendLine(this.tradePathPath, event);
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
    this.appendLine(this.tradesPath, trade);
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
    this.appendLine(this.sessionsPath, { _type: 'session_update', session_id: sessionId, ...updates, timestamp: new Date().toISOString() });
  }


  /** Write an ML management decision to structured log. */
  writeMlManagementAction(record: unknown): void {
    this.appendLine(join(this.logDir, 'ml_management_actions.jsonl'), record);
  }

  /** Write a candidate entry signal to the canonical candidate log. */
  writeCandidateSignal(record: unknown): void {
    this.appendLine(join(this.logDir, 'candidate_signals.jsonl'), record);
  }

  private appendLine(filePath: string, record: unknown): void {
    try {
      appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      console.error(`[LOG] Failed to write to ${filePath}:`, err);
    }
  }
}
