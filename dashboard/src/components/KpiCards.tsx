import type { Kpis } from '../types';
import { fmtUsd, pnlClass } from '../format';

interface Props {
  kpis: Kpis;
}

export function KpiCards({ kpis }: Props) {
  return (
    <div className="kpi-grid">
      <div className="kpi-card">
        <div className="kpi-label">Entries / Closed</div>
        <div className="kpi-value">{kpis.entries_today} / {kpis.closed_trades}</div>
      </div>

      <div className="kpi-card">
        <div className="kpi-label">Total P&L</div>
        <div className={`kpi-value ${pnlClass(kpis.total_pnl_usd)}`}>
          {fmtUsd(kpis.total_pnl_usd)}
        </div>
      </div>

      <div className="kpi-card">
        <div className="kpi-label">Realized</div>
        <div className={`kpi-value ${pnlClass(kpis.realized_pnl_usd)}`}>
          {fmtUsd(kpis.realized_pnl_usd)}
        </div>
      </div>

      <div className="kpi-card">
        <div className="kpi-label">Unrealized</div>
        <div className={`kpi-value ${pnlClass(kpis.unrealized_pnl_usd)}`}>
          {fmtUsd(kpis.unrealized_pnl_usd)}
        </div>
      </div>

      <div className="kpi-card">
        <div className="kpi-label">Win Rate</div>
        <div className="kpi-value">
          {kpis.win_rate_pct != null ? `${kpis.win_rate_pct}%` : '\u2014'}
        </div>
      </div>

      <div className="kpi-card">
        <div className="kpi-label">Open Positions</div>
        <div className="kpi-value">{kpis.open_positions}</div>
      </div>

      <div className="kpi-card">
        <div className="kpi-label">Loss Budget Left</div>
        <div className={`kpi-value ${kpis.remaining_daily_loss_budget != null && kpis.remaining_daily_loss_budget < 50 ? 'pnl-neg' : ''}`}>
          {fmtUsd(kpis.remaining_daily_loss_budget)}
        </div>
      </div>

      <div className="kpi-card">
        <div className="kpi-label">Avg R</div>
        <div className={`kpi-value ${pnlClass(kpis.avg_r)}`}>
          {kpis.avg_r != null ? `${kpis.avg_r}R` : '\u2014'}
        </div>
      </div>
    </div>
  );
}
