/**
 * Tests for TradeJournal — append-only JSONL journal for crash recovery.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { TradeJournal } from '../../src/autotrade/trade-journal.js';

const TEST_DIR = join(process.cwd(), 'tests', '_tmp_trade_journal');

describe('TradeJournal', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── Basic operations ─────────────────────────────────────────────────

  it('appends and reads entries', () => {
    const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
    journal.append('trade_opened', 'TRADE_1', 'runner', 'entry_signal', null);
    journal.append('final_close', 'TRADE_1', 'runner', 'stop_loss', null);
    const all = journal.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.event).toBe('trade_opened');
    expect(all[1]!.event).toBe('final_close');
  });

  it('assigns sequential global_seq and seq', () => {
    const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
    journal.append('trade_opened', 'TRADE_1', 'runner', null, null);
    journal.append('stop_moved', 'TRADE_1', 'runner', 'breakeven', null);
    const all = journal.readAll();
    expect(all[0]!.global_seq).toBe(0);
    expect(all[0]!.seq).toBe(0);
    expect(all[1]!.global_seq).toBe(1);
    expect(all[1]!.seq).toBe(1);
  });

  it('generates unique event_ids', () => {
    const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
    journal.append('trade_opened', 'TRADE_1', 'runner', null, null);
    journal.append('final_close', 'TRADE_1', 'runner', null, null);
    const all = journal.readAll();
    expect(all[0]!.event_id).toBe('SESSION_1_J0');
    expect(all[1]!.event_id).toBe('SESSION_1_J1');
  });

  // ── global_seq cross-session ──────────────────────────────────────────

  it('continues global_seq across sessions', () => {
    const j1 = new TradeJournal(TEST_DIR, 'SESSION_1');
    j1.append('trade_opened', 'TRADE_1', 'runner', null, null);
    j1.append('final_close', 'TRADE_1', 'runner', null, null);
    // global_seq 0, 1 written

    const j2 = new TradeJournal(TEST_DIR, 'SESSION_2');
    j2.append('trade_opened', 'TRADE_2', 'runner', null, null);
    const all = j2.readAll();
    const last = all[all.length - 1]!;
    expect(last.global_seq).toBe(2);
    expect(last.session_id).toBe('SESSION_2');
  });

  it('initializes global_seq from last valid line, skipping corrupted trailing lines', () => {
    // Write valid entries then corrupt trailing line
    const j1 = new TradeJournal(TEST_DIR, 'SESSION_1');
    j1.append('trade_opened', 'TRADE_1', 'runner', null, null); // global_seq=0
    // Append corrupt line directly
    appendFileSync(join(TEST_DIR, 'trade_journal.jsonl'), 'corrupted-line\n');

    const j2 = new TradeJournal(TEST_DIR, 'SESSION_2');
    j2.append('trade_opened', 'TRADE_2', 'runner', null, null);
    const all = j2.readAll();
    // Should skip corrupt line and continue from global_seq=1
    const valid = all.filter(e => e.event === 'trade_opened');
    expect(valid).toHaveLength(2);
    expect(valid[1]!.global_seq).toBe(1);
  });

  // ── Unclosed trade detection ──────────────────────────────────────────

  describe('getLatestUnclosedTrade', () => {
    it('returns null when no entries', () => {
      const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
      expect(journal.getLatestUnclosedTrade()).toBeNull();
    });

    it('returns null when all trades closed', () => {
      const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
      journal.append('trade_opened', 'TRADE_1', 'runner', null, null);
      journal.append('final_close', 'TRADE_1', 'runner', null, null);
      expect(journal.getLatestUnclosedTrade()).toBeNull();
    });

    it('detects unclosed trade', () => {
      const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
      journal.append('trade_opened', 'TRADE_1', 'runner', null, null);
      journal.append('stop_moved', 'TRADE_1', 'runner', 'breakeven', null);
      const unclosed = journal.getLatestUnclosedTrade();
      expect(unclosed).not.toBeNull();
      expect(unclosed!.tradeId).toBe('TRADE_1');
      expect(unclosed!.lastEvent.event).toBe('stop_moved');
    });

    it('returns only the unclosed trade when mixed', () => {
      const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
      journal.append('trade_opened', 'TRADE_1', 'runner', null, null);
      journal.append('final_close', 'TRADE_1', 'runner', null, null);
      journal.append('trade_opened', 'TRADE_2', 'runner', null, null);
      const unclosed = journal.getLatestUnclosedTrade();
      expect(unclosed!.tradeId).toBe('TRADE_2');
    });
  });

  // ── hasUnmatchedOpen ──────────────────────────────────────────────────

  describe('hasUnmatchedOpen', () => {
    it('returns false for empty journal', () => {
      const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
      expect(journal.hasUnmatchedOpen()).toBe(false);
    });

    it('returns true for open trade', () => {
      const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
      journal.append('trade_opened', 'TRADE_1', 'runner', null, null);
      expect(journal.hasUnmatchedOpen()).toBe(true);
      expect(journal.hasUnmatchedOpen('TRADE_1')).toBe(true);
    });

    it('returns false for closed trade', () => {
      const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
      journal.append('trade_opened', 'TRADE_1', 'runner', null, null);
      journal.append('final_close', 'TRADE_1', 'runner', null, null);
      expect(journal.hasUnmatchedOpen('TRADE_1')).toBe(false);
    });
  });

  // ── Corruption handling ──────────────────────────────────────────────

  describe('corruption handling', () => {
    it('skips malformed lines and reads valid ones', () => {
      const filePath = join(TEST_DIR, 'trade_journal.jsonl');
      const valid = JSON.stringify({
        global_seq: 0, seq: 0, event_id: 'S_J0', event: 'trade_opened',
        timestamp: new Date().toISOString(), trade_id: 'T1', session_id: 'S',
        source: 'runner', reason: null, position_snapshot: null,
      });
      writeFileSync(filePath, valid + '\nnot-json\n' + valid.replace('"global_seq": 0', '"global_seq": 1') + '\n');

      const journal = new TradeJournal(TEST_DIR, 'SESSION_2');
      const all = journal.readAll();
      // Should have 2 valid entries (corrupt line skipped)
      expect(all).toHaveLength(2);
    });

    it('handles empty journal file', () => {
      writeFileSync(join(TEST_DIR, 'trade_journal.jsonl'), '');
      const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
      expect(journal.readAll()).toEqual([]);
    });

    it('handles missing journal file', () => {
      const journal = new TradeJournal(TEST_DIR, 'SESSION_1');
      expect(journal.readAll()).toEqual([]);
    });
  });
});
