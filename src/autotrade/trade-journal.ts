/**
 * TradeJournal — append-only JSONL journal for crash recovery.
 *
 * Intentionally sparse: 5 event types, ~3-8 writes per trade lifecycle.
 * Each write is fsync'd for durability. NOT a telemetry stream.
 *
 * File: trade_journal.jsonl in LOG_DIR.
 */

import {
  appendFileSync,
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import type { Position } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type TradeJournalEventType =
  | 'trade_opened'
  | 'entry_filled'
  | 'stop_moved'
  | 'partial_exit'
  | 'final_close';

export interface TradeJournalEntry {
  global_seq: number;
  seq: number;
  event_id: string;
  event: TradeJournalEventType;
  timestamp: string;
  trade_id: string;
  session_id: string;
  source: string;
  reason: string | null;
  position_snapshot: Position | null;
  details?: Record<string, unknown>;
}

// ── TradeJournal ──────────────────────────────────────────────────────────

export class TradeJournal {
  private readonly filePath: string;
  private globalSeq: number;
  private sessionSeq: number;
  private readonly sessionId: string;

  constructor(logDir: string, sessionId: string) {
    this.filePath = join(logDir, 'trade_journal.jsonl');
    this.sessionId = sessionId;
    this.sessionSeq = 0;
    this.globalSeq = this.initGlobalSeq();
  }

  /**
   * Initialize global_seq from the last valid line in the journal file.
   * Handles corrupted trailing lines from dirty termination.
   */
  private initGlobalSeq(): number {
    if (!existsSync(this.filePath)) return 0;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      // Walk backwards to find last valid line
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]!);
          if (typeof parsed.global_seq === 'number') {
            return parsed.global_seq + 1;
          }
        } catch {
          // Malformed line — skip, try previous
        }
      }
      return 0;
    } catch {
      return 0;
    }
  }

  nextGlobalSeq(): number {
    return this.globalSeq++;
  }

  nextSeq(): number {
    return this.sessionSeq++;
  }

  /**
   * Append a journal entry. Immediate write with fsync.
   */
  append(
    event: TradeJournalEventType,
    tradeId: string,
    source: string,
    reason: string | null,
    positionSnapshot: Position | null,
    details?: Record<string, unknown>,
  ): void {
    const seq = this.nextSeq();
    const globalSeq = this.nextGlobalSeq();
    const entry: TradeJournalEntry = {
      global_seq: globalSeq,
      seq,
      event_id: `${this.sessionId}_J${seq}`,
      event,
      timestamp: new Date().toISOString(),
      trade_id: tradeId,
      session_id: this.sessionId,
      source,
      reason,
      position_snapshot: positionSnapshot,
      details,
    };

    const line = JSON.stringify(entry) + '\n';
    const fd = openSync(this.filePath, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Read all valid entries. Skips malformed lines with warning.
   */
  readAll(): TradeJournalEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const entries: TradeJournalEntry[] = [];
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          console.warn(`[TRADE-JOURNAL] Skipping malformed line ${i + 1}`);
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  getTradeEvents(tradeId: string): TradeJournalEntry[] {
    return this.readAll().filter(e => e.trade_id === tradeId);
  }

  getLastEventForTrade(tradeId: string): TradeJournalEntry | null {
    const events = this.getTradeEvents(tradeId);
    return events.length > 0 ? events[events.length - 1]! : null;
  }

  /**
   * Find the most recent trade_opened without a matching final_close.
   * Returns null if all trades are closed or journal is empty.
   */
  getLatestUnclosedTrade(): { tradeId: string; lastEvent: TradeJournalEntry } | null {
    const all = this.readAll();
    // Collect all trade IDs that have been opened
    const openedTrades = new Map<string, TradeJournalEntry>();
    const closedTrades = new Set<string>();

    for (const entry of all) {
      if (entry.event === 'trade_opened') {
        openedTrades.set(entry.trade_id, entry);
      }
      if (entry.event === 'final_close') {
        closedTrades.add(entry.trade_id);
      }
    }

    // Find unclosed trades (opened but not closed)
    let latest: { tradeId: string; lastEvent: TradeJournalEntry } | null = null;
    for (const [tradeId, openEntry] of openedTrades) {
      if (!closedTrades.has(tradeId)) {
        // Get the last event for this trade
        const tradeEvents = all.filter(e => e.trade_id === tradeId);
        const lastEvent = tradeEvents[tradeEvents.length - 1]!;
        if (!latest || lastEvent.global_seq > latest.lastEvent.global_seq) {
          latest = { tradeId, lastEvent };
        }
      }
    }

    return latest;
  }

  /**
   * Check if there is a trade_opened without matching final_close.
   * This is ONE recovery signal among many — not definitive truth.
   */
  hasUnmatchedOpen(tradeId?: string): boolean {
    if (tradeId) {
      const events = this.getTradeEvents(tradeId);
      const hasOpen = events.some(e => e.event === 'trade_opened');
      const hasClose = events.some(e => e.event === 'final_close');
      return hasOpen && !hasClose;
    }
    return this.getLatestUnclosedTrade() !== null;
  }

  getFilePath(): string {
    return this.filePath;
  }
}
