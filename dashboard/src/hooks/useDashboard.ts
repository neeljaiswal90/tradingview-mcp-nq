import { useState, useEffect, useRef, useCallback } from 'react';
import type { DashboardSnapshot } from '../types';

const API_BASE = import.meta.env.DEV ? '' : '';

/** Seconds after which we consider the snapshot stale. */
const STALE_THRESHOLD_S = 15;

export function useDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  /** When the frontend last received any update from the backend. */
  const [lastReceivedAt, setLastReceivedAt] = useState<number>(0);
  /** Whether the snapshot appears stale (no update in STALE_THRESHOLD_S). */
  const [isStale, setIsStale] = useState<boolean>(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const staleCheckTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`${API_BASE}/api/dashboard/stream`);
    eventSourceRef.current = es;

    es.addEventListener('snapshot', (event) => {
      try {
        const data = JSON.parse(event.data) as DashboardSnapshot;
        setSnapshot(data);
        setConnected(true);
        setError(null);
        setLastReceivedAt(Date.now());
        setIsStale(false);
      } catch (err) {
        console.error('Failed to parse snapshot:', err);
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
      // Reconnect after 2 seconds (reduced from 3s)
      reconnectTimer.current = setTimeout(connect, 2000);
    };
  }, []);

  useEffect(() => {
    connect();

    // Periodic staleness check — runs every 3 seconds
    staleCheckTimer.current = setInterval(() => {
      setLastReceivedAt(prev => {
        if (prev > 0 && Date.now() - prev > STALE_THRESHOLD_S * 1000) {
          setIsStale(true);
        }
        return prev;
      });
    }, 3000);

    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (staleCheckTimer.current) clearInterval(staleCheckTimer.current);
    };
  }, [connect]);

  return { snapshot, connected, error, lastReceivedAt, isStale };
}
