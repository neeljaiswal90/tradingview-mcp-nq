import { useState, useEffect, useRef, useCallback } from 'react';
import type { DashboardSnapshot, DashboardDeltaEvent, DashboardDeltaBatch } from '../types';

const API_BASE = import.meta.env.DEV ? '' : '';

/** Seconds after which we consider the snapshot stale. */
const STALE_THRESHOLD_S = 15;
/** Secondary recovery path — can be relaxed once server-side 15s reconcile proves reliable. */
const RECONCILE_INTERVAL_MS = 20_000;

/**
 * Apply a single typed delta event to the current snapshot.
 * Returns a new snapshot with the changed panels merged in.
 */
function applyDelta(prev: DashboardSnapshot, event: DashboardDeltaEvent): DashboardSnapshot {
  switch (event.type) {
    case 'price_tick':
      return {
        ...prev,
        market_state: { ...prev.market_state, current_price: event.price },
        active_trade: prev.active_trade.is_open
          ? { ...prev.active_trade, current_price: event.price }
          : prev.active_trade,
      };

    case 'position_opened':
      return { ...prev, active_trade: event.active_trade, kpis: event.kpis };

    case 'position_cleared':
      return { ...prev, active_trade: event.active_trade, kpis: event.kpis };

    case 'position_updated':
      return { ...prev, active_trade: event.active_trade };

    case 'management_update':
      return { ...prev, management: event.management, active_trade: event.active_trade };

    case 'ml_decision':
      return { ...prev, ml_management: event.ml_management };

    case 'trade_closed':
    case 'recent_trade_added':
      return { ...prev, recent_trades: event.recent_trades, pnl_history: event.pnl_history, kpis: event.kpis };

    case 'market_update':
      return { ...prev, market_state: event.market_state, directional: event.directional };

    case 'app_update':
      return { ...prev, app: event.app };

    case 'resync':
      // Handled separately — triggers a full snapshot refetch
      return prev;

    default:
      return prev;
  }
}

/**
 * Apply a batch of delta events to the snapshot.
 * Events are applied in order (lifecycle events first, then coalesced).
 */
function applyBatch(prev: DashboardSnapshot, batch: DashboardDeltaBatch): DashboardSnapshot {
  let snap = prev;
  for (const event of batch.events) {
    snap = applyDelta(snap, event);
  }
  return snap;
}

export function useDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReceivedAt, setLastReceivedAt] = useState<number>(0);
  const [isStale, setIsStale] = useState<boolean>(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const staleCheckTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const reconcileTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const serverInstanceIdRef = useRef<string | null>(null);
  /** Track last seen publish_seq for gap detection. */
  const lastSeenSeqRef = useRef<number>(0);

  /** Fetch full snapshot via REST for bootstrap/reconciliation. */
  const fetchSnapshot = useCallback(async (): Promise<DashboardSnapshot | null> => {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/snapshot`);
      if (!res.ok) return null;
      return await res.json() as DashboardSnapshot;
    } catch {
      return null;
    }
  }, []);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // Bootstrap: fetch full snapshot via REST first
    fetchSnapshot().then(initial => {
      if (initial) {
        setSnapshot(initial);
        serverInstanceIdRef.current = initial.freshness.server_instance_id;
        lastSeenSeqRef.current = initial.freshness.publish_seq;
        setConnected(true);
        setError(null);
        setLastReceivedAt(Date.now());
        setIsStale(false);
      }
    });

    const es = new EventSource(`${API_BASE}/api/dashboard/stream`);
    eventSourceRef.current = es;

    // Full snapshot events (initial connection + periodic 15s reconciliation from server)
    es.addEventListener('snapshot', (event) => {
      try {
        const data = JSON.parse(event.data) as DashboardSnapshot;

        // Detect server restart via instance ID mismatch
        const newInstanceId = data.freshness.server_instance_id;
        if (serverInstanceIdRef.current && newInstanceId !== serverInstanceIdRef.current) {
          console.log('[DASHBOARD] Server restart detected — full resync');
        }
        serverInstanceIdRef.current = newInstanceId;
        lastSeenSeqRef.current = data.freshness.publish_seq;

        setSnapshot(data);
        setConnected(true);
        setError(null);
        setLastReceivedAt(Date.now());
        setIsStale(false);
      } catch (err) {
        console.error('Failed to parse snapshot:', err);
      }
    });

    // Typed delta batch events
    es.addEventListener('delta', (event) => {
      try {
        const batch = JSON.parse(event.data) as DashboardDeltaBatch;

        // Duplicate/out-of-order protection
        if (batch.publish_seq <= lastSeenSeqRef.current) return;

        // Gap detection — if we missed a sequence, refetch full snapshot
        if (batch.publish_seq > lastSeenSeqRef.current + 1) {
          console.log(`[DASHBOARD] Gap detected: expected ${lastSeenSeqRef.current + 1}, got ${batch.publish_seq} — resyncing`);
          lastSeenSeqRef.current = batch.publish_seq;
          fetchSnapshot().then(full => {
            if (full) {
              setSnapshot(full);
              lastSeenSeqRef.current = full.freshness.publish_seq;
            }
          });
          return;
        }

        lastSeenSeqRef.current = batch.publish_seq;

        setSnapshot(prev => {
          if (!prev) return prev;
          return applyBatch(prev, batch);
        });
        setLastReceivedAt(Date.now());
        setIsStale(false);

        // Handle resync events within the batch
        if (batch.events.some(e => e.type === 'resync')) {
          fetchSnapshot().then(full => {
            if (full) {
              setSnapshot(full);
              lastSeenSeqRef.current = full.freshness.publish_seq;
            }
          });
        }
      } catch (err) {
        console.error('Failed to parse delta batch:', err);
      }
    });

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.onerror = () => {
      setConnected(false);
      setError('Connection lost. Reconnecting...');
      es.close();
      reconnectTimer.current = setTimeout(connect, 2000);
    };
  }, [fetchSnapshot]);

  useEffect(() => {
    connect();

    // Periodic staleness check
    staleCheckTimer.current = setInterval(() => {
      setLastReceivedAt(prev => {
        if (prev > 0 && Date.now() - prev > STALE_THRESHOLD_S * 1000) {
          setIsStale(true);
        }
        return prev;
      });
    }, 3000);

    // Secondary recovery path — lightweight snapshot refresh every 20s
    reconcileTimer.current = setInterval(() => {
      fetchSnapshot().then(full => {
        if (!full) return;
        setSnapshot(prev => {
          if (!prev) return full;
          if (full.freshness.publish_seq > lastSeenSeqRef.current) {
            lastSeenSeqRef.current = full.freshness.publish_seq;
            return full;
          }
          return prev;
        });
      });
    }, RECONCILE_INTERVAL_MS);

    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (staleCheckTimer.current) clearInterval(staleCheckTimer.current);
      if (reconcileTimer.current) clearInterval(reconcileTimer.current);
    };
  }, [connect, fetchSnapshot]);

  return { snapshot, connected, error, lastReceivedAt, isStale };
}
