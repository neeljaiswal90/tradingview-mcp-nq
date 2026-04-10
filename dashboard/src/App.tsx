import { useDashboard } from './hooks/useDashboard';
import { StatusBar } from './components/StatusBar';
import { KpiCards } from './components/KpiCards';
import { ActiveTrade } from './components/ActiveTrade';
import { MarketStatePanel } from './components/MarketStatePanel';
import { DirectionalPanel } from './components/DirectionalPanel';
import { ManagementPanel } from './components/ManagementPanel';
import { MlManagementPanel } from './components/MlManagementPanel';
import { RecentTrades } from './components/RecentTrades';
import { PnlChart } from './components/PnlChart';
import { HtfZonesPanel } from './components/HtfZonesPanel';

export function App() {
  const { snapshot, connected, error, isStale } = useDashboard();

  if (!snapshot) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        <p>{error ?? 'Connecting to trading engine...'}</p>
      </div>
    );
  }

  return (
    <div className={`dashboard ${isStale ? 'dashboard-stale' : ''}`}>
      <StatusBar
        app={snapshot.app}
        connected={connected}
        isStale={isStale}
        freshness={snapshot.freshness}
      />

      {error && <div className="error-banner">{error}</div>}

      <div className="grid-main">
        <section className="grid-kpis">
          <KpiCards kpis={snapshot.kpis} />
        </section>

        <section className="grid-trade">
          <ActiveTrade trade={snapshot.active_trade} />
        </section>

        <section className="grid-market">
          <MarketStatePanel state={snapshot.market_state} />
        </section>

        <section className="grid-htf">
          <HtfZonesPanel
            htfContext={snapshot.htf_context}
            htfEvalLong={snapshot.directional.htf_eval_long}
            htfEvalShort={snapshot.directional.htf_eval_short}
          />
        </section>

        <section className="grid-directional">
          <DirectionalPanel assessment={snapshot.directional} />
        </section>

        <section className="grid-management">
          <ManagementPanel management={snapshot.management} />
        </section>

        <section className="grid-ml">
          <MlManagementPanel ml={snapshot.ml_management} />
        </section>

        <section className="grid-chart">
          <PnlChart points={snapshot.pnl_history} />
        </section>

        <section className="grid-trades">
          <RecentTrades trades={snapshot.recent_trades} />
        </section>
      </div>
    </div>
  );
}
