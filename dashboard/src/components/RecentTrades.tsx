import type { RecentTrade } from '../types';
import { fmtPrice, fmtPnlUsd, pnlClass } from '../format';

function formatTime(seconds: number | null | undefined): string {
  if (seconds == null) return '\u2014';
  const m = Math.floor(seconds / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

interface Props {
  trades: RecentTrade[];
}

export function RecentTrades({ trades }: Props) {
  if (trades.length === 0) {
    return (
      <div className="panel">
        <h3 className="panel-title">Recent Trades</h3>
        <div className="empty-state">
          <p>No trades yet this session</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3 className="panel-title">Recent Trades</h3>
      <div className="trades-table-wrap">
        <table className="trades-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th>Setup</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>P&L</th>
              <th>R</th>
              <th>Exit Reason</th>
              <th>Hold</th>
            </tr>
          </thead>
          <tbody>
            {trades.map(t => {
              const outcomeClass = t.outcome === 'winner' ? 'row-win' : t.outcome === 'loser' ? 'row-loss' : 'row-scratch';
              return (
                <tr key={t.trade_id} className={outcomeClass}>
                  <td>{formatTimestamp(t.time)}</td>
                  <td className={t.side === 'long' ? 'text-green' : 'text-red'}>
                    {t.side?.toUpperCase() ?? '\u2014'}
                  </td>
                  <td>{t.setup_type?.replace(/_/g, ' ') ?? '\u2014'}</td>
                  <td>{fmtPrice(t.entry)}</td>
                  <td>{fmtPrice(t.exit)}</td>
                  <td className={pnlClass(t.pnl_usd)}>
                    {fmtPnlUsd(t.pnl_usd)}
                  </td>
                  <td className={pnlClass(t.r_multiple)}>
                    {t.r_multiple != null ? `${t.r_multiple}R` : '\u2014'}
                  </td>
                  <td>{t.exit_reason?.replace(/_/g, ' ') ?? '\u2014'}</td>
                  <td>{formatTime(t.hold_time_seconds)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
