import type { AppMeta, FreshnessMetadata } from '../types';

const MODE_LABELS: Record<string, string> = {
  live: 'LIVE',
  paper: 'PAPER',
  signal_only: 'SIGNAL',
};

const BUCKET_LABELS: Record<string, string> = {
  premarket: 'Pre-Market',
  rth_open: 'RTH Open',
  midday: 'Midday',
  power_hour: 'Power Hour',
  postmarket: 'Post-Market',
  closed: 'Closed',
  unknown: 'Unknown',
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

interface Props {
  app: AppMeta;
  connected: boolean;
  isStale: boolean;
  freshness?: FreshnessMetadata;
}

export function StatusBar({ app, connected, isStale, freshness }: Props) {
  const modeClass = app.mode === 'live' ? 'mode-live' : app.mode === 'paper' ? 'mode-paper' : 'mode-signal';

  // Show strategy bucket if available, fall back to legacy
  const sessionLabel = app.strategy_bucket && app.strategy_bucket !== 'UNKNOWN'
    ? app.strategy_bucket.replace(/_/g, ' ')
    : (BUCKET_LABELS[app.session_bucket] ?? app.session_bucket);

  // Build freshness tooltip
  const freshnessTitle = freshness
    ? `v${freshness.snapshot_version} | gather: ${freshness.data_gather_duration_ms ?? '?'}ms | analysis: ${freshness.last_analysis_duration_ms}ms | HTF cache: ${freshness.htf_cache_hits.join(',') || 'none'}`
    : '';

  return (
    <header className="status-bar">
      <div className="status-left">
        <span className="symbol">{app.symbol}</span>
        <span className={`mode-badge ${modeClass}`}>
          {MODE_LABELS[app.mode] ?? app.mode}
        </span>
        <span className="session-badge">
          {sessionLabel}
        </span>
        {app.exchange_state && (
          <span className="exchange-state-badge">
            {app.exchange_state}
          </span>
        )}
      </div>
      <div className="status-center">
        <span className="title">NQ Trading Dashboard</span>
      </div>
      <div className="status-right">
        <span className="cycle" title={freshnessTitle}>
          Cycle #{app.cycle_count}
        </span>
        {freshness && (
          <span className="gather-time" title="Data gather duration">
            {freshness.data_gather_duration_ms ?? '?'}ms
          </span>
        )}
        <span className="updated">Updated {timeAgo(app.last_updated_iso)}</span>
        {isStale && (
          <span className="stale-badge" title="No update received in 15+ seconds">
            STALE
          </span>
        )}
        <span className={`conn-dot ${connected ? (isStale ? 'conn-warn' : 'conn-ok') : 'conn-err'}`} />
        <span className={`conn-label ${connected ? '' : 'conn-err-text'}`}>
          {connected ? (isStale ? 'Stale' : 'Live') : 'Disconnected'}
        </span>
      </div>
    </header>
  );
}
