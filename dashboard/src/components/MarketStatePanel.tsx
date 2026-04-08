import type { MarketState } from '../types';
import { fmtPrice } from '../format';

const REGIME_COLORS: Record<string, string> = {
  trending_up: '#22c55e',
  trending_down: '#ef4444',
  range_bound: '#eab308',
  breakout_attempt: '#3b82f6',
  breakdown_attempt: '#f97316',
  compression: '#a855f7',
  high_volatility_impulse: '#ec4899',
  choppy: '#6b7280',
};

function BiasCell({ label, bias }: { label: string; bias: string | null }) {
  const cls = bias === 'bullish' ? 'bias-bull' : bias === 'bearish' ? 'bias-bear' : 'bias-neutral';
  return (
    <div className={`bias-cell ${cls}`}>
      <span className="bias-tf">{label}</span>
      <span className="bias-val">{bias ?? '\u2014'}</span>
    </div>
  );
}

interface Props {
  state: MarketState;
}

export function MarketStatePanel({ state }: Props) {
  const regimeColor = state.regime ? REGIME_COLORS[state.regime] ?? '#6b7280' : '#6b7280';

  return (
    <div className="panel">
      <h3 className="panel-title">Market State</h3>

      <div className="market-regime">
        <span className="regime-badge" style={{ borderColor: regimeColor, color: regimeColor }}>
          {state.regime?.replace(/_/g, ' ') ?? 'Unknown'}
        </span>
        {state.current_price != null && (
          <span className="current-price">{fmtPrice(state.current_price)}</span>
        )}
      </div>

      <div className="bias-strip">
        <BiasCell label="1H" bias={state.bias_1h} />
        <BiasCell label="15M" bias={state.bias_15m} />
        <BiasCell label="5M" bias={state.bias_5m} />
        <BiasCell label="1M" bias={state.bias_1m} />
      </div>

      <div className="alignment-meter">
        <span className="meter-label">Alignment</span>
        <div className="meter-bar">
          <div
            className="meter-fill"
            style={{ width: `${((state.alignment_score ?? 0) / 4) * 100}%` }}
          />
        </div>
        <span className="meter-value">{state.alignment_score ?? 0}/4</span>
      </div>

      <div className="market-details">
        <div className="detail-row">
          <span>EMA Stack</span>
          <span className={state.ema_stack === 'bullish_ordered' ? 'text-green' : state.ema_stack === 'bearish_ordered' ? 'text-red' : ''}>
            {state.ema_stack?.replace(/_/g, ' ') ?? '\u2014'}
          </span>
        </div>
        <div className="detail-row">
          <span>SuperTrend</span>
          <span className={state.supertrend_bias === 'up' ? 'text-green' : state.supertrend_bias === 'down' ? 'text-red' : ''}>
            {state.supertrend_bias ?? '\u2014'}
          </span>
        </div>
        <div className="detail-row">
          <span>VWAP</span>
          <span className={state.price_vs_vwap === 'above_vwap' ? 'text-green' : state.price_vs_vwap === 'below_vwap' ? 'text-red' : ''}>
            {state.price_vs_vwap?.replace(/_/g, ' ') ?? '\u2014'}
            {state.distance_from_vwap_pts != null ? ` (${state.distance_from_vwap_pts > 0 ? '+' : ''}${state.distance_from_vwap_pts}pts)` : ''}
          </span>
        </div>
        <div className="detail-row">
          <span>ATR (1m)</span>
          <span>{state.atr_1m ?? '\u2014'}</span>
        </div>
        {state.session && (
          <>
            <div className="detail-row">
              <span>OR Status</span>
              <span>{state.session.or_complete ? 'Complete' : 'Forming...'}</span>
            </div>
            {state.session.or_high != null && (
              <div className="detail-row">
                <span>OR Range</span>
                <span>
                  {fmtPrice(state.session.or_low)} - {fmtPrice(state.session.or_high)}
                  {state.session.or_width != null ? ` (${state.session.or_width}pts)` : ''}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
