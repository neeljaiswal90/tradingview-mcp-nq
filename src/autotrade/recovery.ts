/**
 * Recovery — startup recovery logic, report generation, and replay helpers.
 *
 * Evaluates multiple signals (shutdown_clean, heartbeat staleness, open trade state,
 * journal orphans, file corruption) with deterministic precedence to decide whether
 * the engine can start safely.
 *
 * Precedence (highest severity wins):
 *   1. File corruption (runtime or trade state)
 *   2. Dirty shutdown (shutdown_clean === false)
 *   3. Stale heartbeat (shutdown_clean but heartbeat expired)
 */

import { existsSync } from 'fs';
import type { Position, ExecutionMode } from './types.js';
import type { RestartMode } from './types.js';
import type { RuntimeState, OpenTradeStateFile, RuntimeStateManager } from './runtime-state.js';
import type { TradeJournal, TradeJournalEntry } from './trade-journal.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type RecoveryOutcome =
  | 'clean_start'
  | 'dirty_restart_no_open_trade'
  | 'dirty_restart_open_trade_cleared_dev'
  | 'dirty_restart_blocked_prod'
  | 'stale_heartbeat_no_open_trade'
  | 'stale_heartbeat_open_trade_cleared_dev'
  | 'stale_heartbeat_blocked_prod'
  | 'corrupted_state_no_open_trade'
  | 'corrupted_state_cleared_dev'
  | 'corrupted_state_blocked_prod';

export interface RecoveryReport {
  outcome: RecoveryOutcome;
  blocking_reason_code: string | null;
  operator_message: string;
  previous_session_id: string | null;
  previous_shutdown_clean: boolean;
  heartbeat_stale: boolean;
  heartbeat_age_ms: number | null;
  open_trade_detected: boolean;
  open_trade_id: string | null;
  open_trade_side: string | null;
  open_trade_qty_remaining: number | null;
  journal_orphan_detected: boolean;
  journal_orphan_trade_id: string | null;
  runtime_file_corrupt: boolean;
  trade_state_file_corrupt: boolean;
  stale_tmp_files_found: string[];
  action_taken: string;
  timestamp: string;
}

export interface OpenTradeEvidence {
  has_evidence: boolean;
  trade_id: string | null;
  last_known_position: Position | null;
  last_journal_event: TradeJournalEntry | null;
  sources: string[];
}

export interface RecoveryArtifacts {
  runtime: RuntimeState | null;
  openTrade: OpenTradeStateFile | null;
  journalOrphan: { tradeId: string; lastEvent: TradeJournalEntry } | null;
  staleTmpFiles: string[];
  runtimeCorrupt: boolean;
  tradeStateCorrupt: boolean;
}

// ── Artifact collection ──────────────────────────────────────────────────

/**
 * Gather all recovery-relevant artifacts from disk.
 * Detects corruption by attempting reads and tracking failures.
 */
export function readRecoveryArtifacts(
  runtimeState: RuntimeStateManager,
  journal: TradeJournal,
): RecoveryArtifacts {
  // Read runtime state — null means missing, corrupt, or schema mismatch
  const runtime = runtimeState.readPrevious();

  // Read open trade state
  const openTrade = runtimeState.readOpenTradeState();

  // Detect corruption: if file exists but read returned null, it's corrupt
  const runtimeCorrupt = existsSync(runtimeState.getRuntimeStatePath()) && runtime === null;
  const tradeStateCorrupt = existsSync(runtimeState.getOpenTradeStatePath()) && openTrade === null;

  // Check journal for orphaned trades
  let journalOrphan: { tradeId: string; lastEvent: TradeJournalEntry } | null = null;
  try {
    journalOrphan = journal.getLatestUnclosedTrade();
  } catch {
    // Journal read failure is not a blocking corruption — journal may not exist yet
  }

  // Cleanup stale .tmp files
  const staleTmpFiles = runtimeState.cleanupStaleTmpFiles();

  return { runtime, openTrade, journalOrphan, staleTmpFiles, runtimeCorrupt, tradeStateCorrupt };
}

// ── Open trade evidence merging ──────────────────────────────────────────

/**
 * Merge all available signals to determine if an open trade was in flight.
 * This is the foundation for future Rithmic reconciliation.
 */
export function getLatestOpenTradeEvidence(
  runtime: RuntimeState | null,
  openTrade: OpenTradeStateFile | null,
  journal: TradeJournal,
): OpenTradeEvidence {
  const sources: string[] = [];
  let tradeId: string | null = null;
  let lastPosition: Position | null = null;
  let lastJournalEvent: TradeJournalEntry | null = null;

  // Signal 1: runtime_state.json says a trade was open
  if (runtime?.open_trade_id) {
    sources.push('runtime_state');
    tradeId = tradeId ?? runtime.open_trade_id;
  }

  // Signal 2: open_trade_state.json has a non-null position
  if (openTrade?.position) {
    sources.push('open_trade_state');
    tradeId = tradeId ?? openTrade.trade_id;
    lastPosition = openTrade.position;
  }

  // Signal 3: journal has an unmatched trade_opened
  const orphan = journal.getLatestUnclosedTrade();
  if (orphan) {
    sources.push('trade_journal');
    tradeId = tradeId ?? orphan.tradeId;
    lastJournalEvent = orphan.lastEvent;
    // Use journal snapshot if we don't have one from open_trade_state
    if (!lastPosition && orphan.lastEvent.position_snapshot) {
      lastPosition = orphan.lastEvent.position_snapshot;
    }
  }

  return {
    has_evidence: sources.length > 0,
    trade_id: tradeId,
    last_known_position: lastPosition,
    last_journal_event: lastJournalEvent,
    sources,
  };
}

/**
 * Reconstruct the last known position state from journal.
 * Simple "latest valid snapshot wins" — NOT full event-sourced replay.
 */
export function reconstructLastTradeState(
  journal: TradeJournal,
  tradeId: string,
): Position | null {
  const events = journal.getTradeEvents(tradeId);
  // Walk backwards to find the most recent entry with a position snapshot
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i]!;
    if (entry.position_snapshot) {
      return entry.position_snapshot;
    }
  }
  return null;
}

// ── Recovery evaluation ──────────────────────────────────────────────────

/**
 * Build a full RecoveryReport from artifacts.
 * Deterministic precedence: corruption > dirty > stale.
 */
export function buildRecoveryReport(
  artifacts: RecoveryArtifacts,
  journal: TradeJournal,
  restartMode: RestartMode,
  executionMode: ExecutionMode,
  heartbeatStaleMs: number,
): RecoveryReport {
  const now = new Date().toISOString();
  const { runtime, openTrade, journalOrphan, staleTmpFiles, runtimeCorrupt, tradeStateCorrupt } = artifacts;

  // Gather open trade evidence
  const evidence = getLatestOpenTradeEvidence(runtime, openTrade, journal);
  const hasOpenTrade = evidence.has_evidence;

  // Compute heartbeat staleness
  let heartbeatStale = false;
  let heartbeatAgeMs: number | null = null;
  if (runtime?.last_heartbeat_at) {
    heartbeatAgeMs = Date.now() - new Date(runtime.last_heartbeat_at).getTime();
    heartbeatStale = heartbeatAgeMs > heartbeatStaleMs;
  }

  // Determine problem type (precedence: corruption > dirty > stale)
  const isCorrupt = runtimeCorrupt || tradeStateCorrupt;
  const isDirty = runtime !== null && !runtime.shutdown_clean;
  const isStale = !isCorrupt && !isDirty && heartbeatStale;
  const hasProblem = isCorrupt || isDirty || isStale;

  // Helper to check if dev auto-clear is allowed
  const canAutoClear = restartMode === 'dev' && executionMode === 'paper';

  // Determine outcome
  let outcome: RecoveryOutcome;
  let blockingReasonCode: string | null = null;
  let operatorMessage: string;
  let actionTaken: string;

  if (!hasProblem && !hasOpenTrade) {
    // Clean start — no previous state or previous was clean + no open trade
    outcome = 'clean_start';
    operatorMessage = 'Clean start — no recovery needed.';
    actionTaken = 'none';
  } else if (isCorrupt && !hasOpenTrade) {
    outcome = 'corrupted_state_no_open_trade';
    operatorMessage = `Corrupted state files detected (runtime=${runtimeCorrupt}, trade=${tradeStateCorrupt}). No open trade. Proceeding with warning.`;
    actionTaken = 'warned_corrupted_no_trade';
  } else if (isCorrupt && hasOpenTrade) {
    if (canAutoClear) {
      outcome = 'corrupted_state_cleared_dev';
      operatorMessage = `Corrupted state files + open trade ${evidence.trade_id}. Dev+paper: auto-clearing.`;
      actionTaken = 'cleared_paper_state';
    } else {
      outcome = 'corrupted_state_blocked_prod';
      blockingReasonCode = 'corrupt_state_with_trade';
      operatorMessage = `BLOCKED: Corrupted state files + open trade ${evidence.trade_id}. Manual recovery required.`;
      actionTaken = 'blocked';
    }
  } else if (isDirty && !hasOpenTrade) {
    outcome = 'dirty_restart_no_open_trade';
    operatorMessage = `Dirty shutdown detected (session: ${runtime!.session_id}). No open trade. Proceeding.`;
    actionTaken = 'warned_dirty_no_trade';
  } else if (isDirty && hasOpenTrade) {
    if (canAutoClear) {
      outcome = 'dirty_restart_open_trade_cleared_dev';
      operatorMessage = `Dirty shutdown + open trade ${evidence.trade_id}. Dev+paper: auto-clearing.`;
      actionTaken = 'cleared_paper_state';
    } else {
      outcome = 'dirty_restart_blocked_prod';
      blockingReasonCode = 'dirty_shutdown_open_trade';
      operatorMessage = `BLOCKED: Dirty shutdown + open trade ${evidence.trade_id} was in flight. Manual recovery required.`;
      actionTaken = 'blocked';
    }
  } else if (isStale && !hasOpenTrade) {
    outcome = 'stale_heartbeat_no_open_trade';
    operatorMessage = `Stale heartbeat detected (age: ${Math.round((heartbeatAgeMs ?? 0) / 1000)}s). No open trade. Proceeding.`;
    actionTaken = 'warned_stale_no_trade';
  } else if (isStale && hasOpenTrade) {
    if (canAutoClear) {
      outcome = 'stale_heartbeat_open_trade_cleared_dev';
      operatorMessage = `Stale heartbeat + open trade ${evidence.trade_id}. Dev+paper: auto-clearing.`;
      actionTaken = 'cleared_paper_state';
    } else {
      outcome = 'stale_heartbeat_blocked_prod';
      blockingReasonCode = 'stale_heartbeat_open_trade';
      operatorMessage = `BLOCKED: Stale heartbeat + open trade ${evidence.trade_id}. Manual recovery required.`;
      actionTaken = 'blocked';
    }
  } else {
    // Fallback: has open trade but no classified problem — treat as dirty
    if (canAutoClear) {
      outcome = 'dirty_restart_open_trade_cleared_dev';
      operatorMessage = `Open trade ${evidence.trade_id} detected without classified problem. Dev+paper: auto-clearing.`;
      actionTaken = 'cleared_paper_state';
    } else {
      outcome = 'dirty_restart_blocked_prod';
      blockingReasonCode = 'open_trade_unreconciled';
      operatorMessage = `BLOCKED: Open trade ${evidence.trade_id} detected. Manual recovery required.`;
      actionTaken = 'blocked';
    }
  }

  return {
    outcome,
    blocking_reason_code: blockingReasonCode,
    operator_message: operatorMessage,
    previous_session_id: runtime?.session_id ?? null,
    previous_shutdown_clean: runtime?.shutdown_clean ?? false,
    heartbeat_stale: heartbeatStale,
    heartbeat_age_ms: heartbeatAgeMs,
    open_trade_detected: hasOpenTrade,
    open_trade_id: evidence.trade_id,
    open_trade_side: evidence.last_known_position?.side ?? null,
    open_trade_qty_remaining: evidence.last_known_position?.quantity_remaining ?? null,
    journal_orphan_detected: journalOrphan !== null,
    journal_orphan_trade_id: journalOrphan?.tradeId ?? null,
    runtime_file_corrupt: runtimeCorrupt,
    trade_state_file_corrupt: tradeStateCorrupt,
    stale_tmp_files_found: staleTmpFiles,
    action_taken: actionTaken,
    timestamp: now,
  };
}

/**
 * Evaluate whether a recovery report blocks startup.
 */
export function isRecoveryBlocked(report: RecoveryReport): boolean {
  return report.outcome.endsWith('_blocked_prod');
}
