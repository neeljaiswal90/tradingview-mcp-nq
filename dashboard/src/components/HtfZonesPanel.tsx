import type { HtfContext, HtfZone, HtfSetupEval } from '../types';
import { fmtPrice } from '../format';

const TF_LABELS: Record<string, string> = { '15': '15M', '60': '1H', '240': '4H' };

const QUALITY_COLORS: Record<string, string> = {
  good: '#22c55e',
  warning: '#eab308',
  poor: '#ef4444',
};

function ZoneRow({ zone }: { zone: HtfZone }) {
  const tfLabel = TF_LABELS[zone.timeframe] ?? zone.timeframe;
  const kindCls = zone.kind === 'RES' ? 'zone-res' : 'zone-sup';

  return (
    <tr className={`zone-row ${kindCls}`}>
      <td className="zone-tf">{tfLabel}</td>
      <td className="zone-kind">{zone.kind}</td>
      <td className="zone-level">{fmtPrice(zone.level)}</td>
      <td className="zone-range">
        {fmtPrice(zone.bottom)}&ndash;{fmtPrice(zone.top)}
      </td>
      <td className="zone-dist">
        {zone.distance_pts != null ? `${zone.distance_pts > 0 ? '+' : ''}${zone.distance_pts.toFixed(1)}` : '\u2014'}
      </td>
      <td className="zone-dist-atr">
        {zone.distance_atr != null ? `${zone.distance_atr.toFixed(2)} ATR` : '\u2014'}
      </td>
      <td>
        {zone.contains_price && <span className="badge badge-inside">INSIDE</span>}
      </td>
    </tr>
  );
}

function SetupEvalBlock({ label, eval: ev }: { label: string; eval: HtfSetupEval | null }) {
  if (!ev) return null;

  const rrColor = ev.first_obstacle_rr == null
    ? '#6b7280'
    : ev.first_obstacle_rr >= 1.5 ? '#22c55e'
    : ev.first_obstacle_rr >= 0.8 ? '#eab308'
    : '#ef4444';

  const qualityColor = ev.location_quality ? QUALITY_COLORS[ev.location_quality] ?? '#6b7280' : '#6b7280';

  return (
    <div className="htf-eval-block">
      <span className="eval-label">{label}</span>
      <div className="eval-metrics">
        <span className="eval-metric">
          1st Obstacle RR:{' '}
          <strong style={{ color: rrColor }}>
            {ev.first_obstacle_rr != null ? ev.first_obstacle_rr.toFixed(2) : '\u2014'}
          </strong>
        </span>
        <span className="eval-metric">
          Location:{' '}
          <span className="badge" style={{ borderColor: qualityColor, color: qualityColor }}>
            {ev.location_quality ?? 'N/A'}
          </span>
        </span>
        {ev.score_adjustment !== 0 && (
          <span className="eval-metric">
            Score adj: <strong>{ev.score_adjustment > 0 ? '+' : ''}{ev.score_adjustment.toFixed(2)}</strong>
          </span>
        )}
        {ev.vetoed && (
          <span className="badge badge-veto">VETO: {ev.veto_reason}</span>
        )}
        {ev.breakout_accepted && (
          <span className="badge badge-breakout">Breakout Accepted</span>
        )}
      </div>
    </div>
  );
}

interface Props {
  htfContext: HtfContext | null;
  htfEvalLong: HtfSetupEval | null;
  htfEvalShort: HtfSetupEval | null;
}

export function HtfZonesPanel({ htfContext, htfEvalLong, htfEvalShort }: Props) {
  if (!htfContext || !htfContext.study_present) {
    return (
      <div className="panel panel-muted">
        <h3 className="panel-title">HTF Zones</h3>
        <p className="panel-empty">Study not present</p>
      </div>
    );
  }

  const allZones = [
    ...htfContext.resistance_zones,
    ...htfContext.support_zones,
  ].sort((a, b) => (b.distance_pts ?? 0) - (a.distance_pts ?? 0));

  return (
    <div className="panel">
      <h3 className="panel-title">
        HTF Zones
        {htfContext.inside_resistance_zone && (
          <span className="badge badge-inside-res">Inside RES</span>
        )}
        {htfContext.inside_support_zone && (
          <span className="badge badge-inside-sup">Inside SUP</span>
        )}
      </h3>

      {allZones.length > 0 ? (
        <table className="htf-zone-table">
          <thead>
            <tr>
              <th>TF</th>
              <th>Kind</th>
              <th>Level</th>
              <th>Range</th>
              <th>Dist</th>
              <th>ATR</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {allZones.map(z => <ZoneRow key={z.timeframe + z.kind + z.level} zone={z} />)}
          </tbody>
        </table>
      ) : (
        <p className="panel-empty">No zones detected</p>
      )}

      {(htfEvalLong || htfEvalShort) && (
        <div className="htf-eval-section">
          <SetupEvalBlock label="Long" eval={htfEvalLong} />
          <SetupEvalBlock label="Short" eval={htfEvalShort} />
        </div>
      )}
    </div>
  );
}
