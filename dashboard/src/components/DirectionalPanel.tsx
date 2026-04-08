import type { DirectionalAssessment, DirectionalSetupInfo } from '../types';
import { fmtPrice, fmtNum } from '../format';

function SetupCard({ label, setup, colorClass }: {
  label: string;
  setup: DirectionalSetupInfo | null;
  colorClass: string;
}) {
  if (!setup || setup.score == null) {
    return (
      <div className="setup-card">
        <div className={`setup-header ${colorClass}`}>{label}</div>
        <div className="setup-empty">No candidate</div>
      </div>
    );
  }

  return (
    <div className="setup-card">
      <div className={`setup-header ${colorClass}`}>
        {label}
        <span className={`setup-valid ${setup.valid ? 'valid' : 'invalid'}`}>
          {setup.valid ? 'VALID' : 'INVALID'}
        </span>
      </div>
      <div className="setup-body">
        <div className="setup-type">{setup.setup_type?.replace(/_/g, ' ') ?? '\u2014'}</div>
        <div className="setup-score">
          <span className="score-total">{fmtNum(setup.score)}</span>
          <span className="score-detail">
            S:{fmtNum(setup.structural_score)} C:{fmtNum(setup.context_score)} Q:{fmtNum(setup.trade_quality_score)}
          </span>
        </div>
        {setup.entry != null && (
          <div className="setup-levels">
            <span>Entry {fmtPrice(setup.entry)}</span>
            <span className="stop-value">Stop {fmtPrice(setup.stop)}</span>
            <span className="target-value">T1 {fmtPrice(setup.t1)}</span>
            <span className="target-value">T2 {fmtPrice(setup.t2)}</span>
            {setup.rr != null && <span>RR {fmtPrice(setup.rr)}</span>}
          </div>
        )}
        {setup.hard_reject_reasons?.length > 0 && (
          <div className="setup-rejects">
            {setup.hard_reject_reasons.map((r, i) => (
              <span key={i} className="reject-tag">{r}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface Props {
  assessment: DirectionalAssessment;
}

export function DirectionalPanel({ assessment }: Props) {
  const decisionClass = assessment.engine_decision?.includes('enter_long') ? 'decision-long'
    : assessment.engine_decision?.includes('enter_short') ? 'decision-short'
    : 'decision-wait';

  return (
    <div className="panel">
      <h3 className="panel-title">Directional Assessment</h3>

      <div className="setups-row">
        <SetupCard label="Best Long" setup={assessment.best_long} colorClass="setup-long" />
        <SetupCard label="Best Short" setup={assessment.best_short} colorClass="setup-short" />
      </div>

      <div className={`engine-decision ${decisionClass}`}>
        <span className="decision-label">Engine Decision</span>
        <span className="decision-value">
          {assessment.engine_decision?.replace(/_/g, ' ').toUpperCase() ?? 'WAITING'}
        </span>
        {assessment.confidence != null && (
          <span className="decision-confidence">
            {assessment.confidence.toFixed(1)}/10
          </span>
        )}
      </div>

      {assessment.skip_reasons.length > 0 && (
        <div className="skip-reasons">
          {assessment.skip_reasons.slice(0, 3).map((r, i) => (
            <span key={i} className="skip-tag">{r}</span>
          ))}
        </div>
      )}
    </div>
  );
}
