/**
 * Discriminated union for execution_intents.jsonl lifecycle rows.
 * Entry events omit exit reason; exit fills and closes require reason; closes require exit provenance.
 */

export type PositionFinalState = 'flat';

/** Semantic lane that produced the terminal close (distinct from broker `source` when needed). */
export type ExecutionExitSource =
  | 'hard_risk'
  | 'management'
  | 'target_position'
  | 'ml_management';

export type ExecutionIntentBase = {
  trade_id: string;
  side: 'long' | 'short';
  /** Legacy attribution field; prefer exit_source on trade_closed. */
  source: string;
  /** High-level ML / rules policy stamp (Track B may refine). */
  policy_mode?: string;
  /** Dataset / audit contract generation (post lifecycle fix = v2). */
  log_contract?: 'legacy_untrusted' | 'contract_v2';
};

export type ExecutionIntentTradeEntrySubmitted = ExecutionIntentBase & {
  event: 'trade_entry_submitted';
  timestamp: string;
  price?: number;
  quantity?: number;
  order_id?: string;
};

export type ExecutionIntentTradeEntryFilled = ExecutionIntentBase & {
  event: 'trade_entry_filled';
  timestamp: string;
  price?: number;
  quantity?: number;
  slippage_pts?: number;
  fee_usd?: number;
  order_id?: string;
};

export type ExecutionIntentTradeExitSubmitted = ExecutionIntentBase & {
  event: 'trade_exit_submitted';
  timestamp: string;
  reason?: string;
  price?: number;
  quantity?: number;
};

export type ExecutionIntentTradeExitFilled = ExecutionIntentBase & {
  event: 'trade_exit_filled';
  timestamp: string;
  /** Required: exit path / fill attribution. */
  reason: string;
  price?: number;
  quantity?: number;
  slippage_pts?: number;
  fee_usd?: number;
  order_id?: string;
};

export type ExecutionIntentTradeClosed = ExecutionIntentBase & {
  event: 'trade_closed';
  timestamp: string;
  /** Required: same family as exit fill (stop_loss, ml_exit_all, …). */
  reason: string;
  /** Required: which subsystem owned the terminal close. */
  exit_source: ExecutionExitSource;
  /** Required: terminal book state after close. */
  position_final_state: PositionFinalState;
  price?: number;
  pnl_realized?: number;
  r_multiple?: number;
  outcome_class?: string;
};

export type ExecutionIntentRecord =
  | ExecutionIntentTradeEntrySubmitted
  | ExecutionIntentTradeEntryFilled
  | ExecutionIntentTradeExitSubmitted
  | ExecutionIntentTradeExitFilled
  | ExecutionIntentTradeClosed;
