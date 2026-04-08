import type { ActiveTrade as ActiveTradeType } from '../types';
import { fmtPrice, fmtUsd, pnlClass } from '../format';

function formatTime(seconds: number | null | undefined): string {
  if (seconds == null) return '\u2014';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${s}s`;
}

interface Props {
  trade: ActiveTradeType;
}

export function ActiveTrade({ trade }: Props) {
  if (!trade.is_open) {
    return (
      <div className="panel">
        <h3 className="panel-title">Active Trade</h3>
        <div className="empty-state">
          <div className="empty-icon">--</div>
          <p>No open position</p>
        </div>
      </div>
    );
  }

  const sideClass = trade.side === 'long' ? 'side-long' : 'side-short';
  const pnlCls = pnlClass(trade.unrealized_pnl_usd);

  return (
    <div className={`panel trade-panel ${sideClass}-border`}>
      <h3 className="panel-title">
        Active Trade
        <span className={`side-badge ${sideClass}`}>
          {trade.side?.toUpperCase()}
        </span>
      </h3>
      <div className="trade-grid">
        <div className="trade-row">
          <span className="trade-label">Setup</span>
          <span className="trade-value">{trade.setup_type ?? '\u2014'}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Entry</span>
          <span className="trade-value">{fmtPrice(trade.entry_price)}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Current</span>
          <span className="trade-value">{fmtPrice(trade.current_price)}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Stop Loss</span>
          <span className="trade-value stop-value">{fmtPrice(trade.stop_loss)}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Target 1</span>
          <span className="trade-value target-value">{fmtPrice(trade.target_1)}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Target 2</span>
          <span className="trade-value target-value">{fmtPrice(trade.target_2)}</span>
        </div>
        {trade.target_3 != null && (
          <div className="trade-row">
            <span className="trade-label">Target 3</span>
            <span className="trade-value target-value">{fmtPrice(trade.target_3)}</span>
          </div>
        )}
        <div className="trade-row">
          <span className="trade-label">Open P&L</span>
          <span className={`trade-value ${pnlCls}`}>
            {fmtUsd(trade.unrealized_pnl_usd)}
          </span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Open R</span>
          <span className={`trade-value ${pnlCls}`}>
            {trade.unrealized_r != null ? `${trade.unrealized_r}R` : '\u2014'}
          </span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Hold Time</span>
          <span className="trade-value">{formatTime(trade.hold_time_seconds)}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">MFE / MAE</span>
          <span className="trade-value">
            {trade.mfe_pts != null ? `+${trade.mfe_pts}` : '\u2014'} / {trade.mae_pts != null ? `-${trade.mae_pts}` : '\u2014'} pts
          </span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Size</span>
          <span className="trade-value">
            {trade.quantity_remaining ?? '\u2014'} / {trade.quantity ?? '\u2014'} ct
          </span>
        </div>
      </div>
      <div className="trade-flags">
        {trade.breakeven_armed && <span className="flag flag-be">BE Armed</span>}
        {trade.trailing_armed && <span className="flag flag-trail">Trail {trade.trailing_ticks}tk</span>}
      </div>
    </div>
  );
}
