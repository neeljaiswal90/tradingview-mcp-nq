/**
 * lob-client.ts — HTTP client for the Python market-data sidecar.
 *
 * Fetches BBO + full feature snapshots and manages trade/signal context
 * for the Bookmap/Rithmic LOB bridge.
 */

export interface LobHealthResult {
  status: string;
  source_connected: boolean;
  bbo_fresh: boolean;
  bbo_age_ms: number;
  update_count: number;
  trade_count: number;
  depth_levels_bid: number;
  depth_levels_ask: number;
  // MBO capability + freshness (from sidecar health endpoint)
  mbo_events_buffered: number;       // rolling 60s window count
  mbo_total_count?: number;          // lifetime event count (optional for old sidecars)
  mbo_status?: string;               // "idle" | "active" | "stale" (optional for old sidecars)
  mbo_age_ms?: number;               // ms since last MBO event (optional for old sidecars)
  mbo_adv_event_count?: number;      // advanced analyzer window count (optional for old sidecars)
  // Context
  active_trade_id: string | null;
  active_signal_id: string | null;
  recording_context: string;
  uptime_sec: number;
}

export interface LobSnapshot {
  timestamp_ms: number;
  bbo_age_ms: number;
  data_quality: 'full_depth' | 'bbo_only' | 'stale' | 'unavailable';
  recording_context: string;
  // BBO
  bid: number | null;
  ask: number | null;
  mid: number | null;
  bid_size: number | null;
  ask_size: number | null;
  spread_pts: number | null;
  spread_ticks: number | null;
  // Depth
  depth_imbalance_5: number | null;
  depth_imbalance_10: number | null;
  total_bid_depth_10lvl: number | null;
  total_ask_depth_10lvl: number | null;
  large_bid_within_5pts: boolean | null;
  large_ask_within_5pts: boolean | null;
  // Trade flow
  cumulative_delta_10s: number | null;
  cumulative_delta_30s: number | null;
  cumulative_delta_60s: number | null;
  trade_flow_imbalance_10s: number | null;
  trade_flow_imbalance_30s: number | null;
  // MBO aggregates
  cancel_add_ratio_10s: number | null;
  replenishment_rate_10s: number | null;
  absorption_rate_10s: number | null;
  mean_order_lifetime_top_book: number | null;
  aggressor_penetration_10s: number | null;
  sweep_count_10s: number | null;
  // Advanced MBO (populated when AdvancedMboAnalyzer is active)
  adv_cancel_replace_ratio_10s: number | null;
  adv_modify_rate_10s: number | null;
  adv_iceberg_suspicion_30s: number | null;
  adv_queue_deterioration_bid_10s: number | null;
  adv_queue_deterioration_ask_10s: number | null;
  adv_pull_cascade_count_10s: number | null;
  adv_lifetime_p50_ms: number | null;
  // Microstructure: Absorption
  absorption_score_10s: number | null;
  absorption_bid_score_10s: number | null;
  absorption_ask_score_10s: number | null;
  strongest_absorption_price: number | null;
  // Microstructure: Sweeps
  sweep_volume_10s: number | null;
  max_sweep_levels_10s: number | null;
  last_sweep_side: string | null;
  // Microstructure: Footprint
  footprint_delta_30s: number | null;
  footprint_delta_5s: number | null;
  footprint_imbalance_ratio_30s: number | null;
  footprint_stacked_imbalance_count_30s: number | null;
  dominant_aggressor_side: string | null;
  // Microstructure: Large Trades
  large_trade_count_10s: number | null;
  large_trade_volume_10s: number | null;
  largest_trade_size_30s: number | null;
  large_trade_buy_sell_imbalance_30s: number | null;
  // Microstructure: Volume Profile
  session_vpoc: number | null;
  session_vah: number | null;
  session_val: number | null;
  distance_to_vpoc: number | null;
  inside_value_area: boolean | null;
  // Correlation
  trade_id: string | null;
  signal_id: string | null;
}

/** Lightweight BBO-only response from /lob/bbo — no feature computation. */
export interface LobBbo {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread_pts: number | null;
  bbo_age_ms: number;
  timestamp_ms: number;
  source_connected: boolean;
  update_count: number;
  is_fresh: boolean;
  last_bbo_ts_ms: number;
}

export class LobClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 1000,
  ) {}

  async getHealth(): Promise<LobHealthResult> {
    const res = await fetch(`${this.baseUrl}/lob/health`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LOB health returned ${res.status}`);
    return await res.json() as LobHealthResult;
  }

  /** Lightweight BBO fetch — no full feature computation on sidecar. */
  async getBbo(): Promise<LobBbo> {
    const res = await fetch(`${this.baseUrl}/lob/bbo`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LOB bbo returned ${res.status}`);
    return await res.json() as LobBbo;
  }

  async getSnapshot(): Promise<LobSnapshot> {
    const res = await fetch(`${this.baseUrl}/lob/snapshot`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LOB snapshot returned ${res.status}`);
    return await res.json() as LobSnapshot;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const h = await this.getHealth();
      return h.status === 'ok' && h.source_connected && h.bbo_fresh;
    } catch {
      return false;
    }
  }

  // ── Context management ─────────────────────────────────────────────────

  async startTradeContext(tradeId: string, side?: string, entryPrice?: number): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/trade_context/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_id: tradeId, side, entry_price: entryPrice }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Non-fatal: sidecar may not be running
    }
  }

  async endTradeContext(tradeId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/trade_context/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_id: tradeId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Non-fatal
    }
  }

  async startSignalContext(signalId: string, direction?: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/signal_context/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal_id: signalId, direction }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Non-fatal
    }
  }

  async endSignalContext(signalId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/signal_context/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal_id: signalId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Non-fatal
    }
  }
}
