import type { MlManagement } from '../types';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

interface Props {
  ml: MlManagement;
}

export function MlManagementPanel({ ml }: Props) {
  if (!ml.enabled) {
    return (
      <div className="panel">
        <h3 className="panel-title">ML Management</h3>
        <div className="empty-state">
          <p>Disabled</p>
        </div>
      </div>
    );
  }

  const actionColor =
    ml.latest_action === 'HOLD' ? 'action-hold' :
    ml.latest_action === 'EXIT_ALL' ? 'action-exit' :
    ml.latest_action === 'MOVE_TO_BREAKEVEN' ? 'action-move' :
    ml.latest_action === 'NO_ACTION' ? 'action-none' :
    '';

  const approvedLabel = ml.latest_approved === true
    ? 'APPROVED' : ml.latest_approved === false
    ? 'REJECTED' : '--';

  const gateClass = ml.latest_approved === true
    ? 'text-green'
    : ml.latest_approved === false
    ? 'text-red'
    : 'muted';

  return (
    <div className="panel">
      <h3 className="panel-title">ML Management</h3>
      <div className="panel-grid">
        <div className="panel-row">
          <span className="label">Model</span>
          <span className="value">{ml.model_name ?? '--'} <span className="muted">v{ml.model_version ?? '?'}</span></span>
        </div>
        <div className="panel-row">
          <span className="label">Action</span>
          <span className={`value ${actionColor}`}>{ml.latest_action ?? '--'}</span>
        </div>
        <div className="panel-row">
          <span className="label">Confidence</span>
          <span className="value">{ml.latest_confidence !== null ? (ml.latest_confidence * 100).toFixed(1) + '%' : '--'}</span>
        </div>
        <div className="panel-row">
          <span className="label">Gate</span>
          <span className={`value ${gateClass}`}>
            {approvedLabel}
          </span>
        </div>
        {ml.latest_rejection_reason && (
          <div className="panel-row">
            <span className="label">Rejection</span>
            <span className="value muted">{ml.latest_rejection_reason}</span>
          </div>
        )}
        <div className="panel-row">
          <span className="label">P(hold)</span>
          <span className="value">{ml.prob_hold !== null ? (ml.prob_hold * 100).toFixed(1) + '%' : '--'}</span>
        </div>
        <div className="panel-row">
          <span className="label">EV hold (R)</span>
          <span className="value">{ml.ev_hold_r !== null ? ml.ev_hold_r.toFixed(3) : '--'}</span>
        </div>
        <div className="panel-row">
          <span className="label">EV exit now (R)</span>
          <span className="value">{ml.ev_exit_now_r !== null ? ml.ev_exit_now_r.toFixed(3) : '--'}</span>
        </div>
        <div className="panel-row">
          <span className="label">Inference</span>
          <span className="value">{ml.inference_ms !== null ? ml.inference_ms.toFixed(1) + 'ms' : '--'}</span>
        </div>
        <div className="panel-row">
          <span className="label">Last eval</span>
          <span className="value">{timeAgo(ml.last_evaluated_at)}</span>
        </div>
        <div className="panel-row">
          <span className="label">Decisions</span>
          <span className="value">{ml.decisions_this_session} total / {ml.actions_approved_this_session} approved</span>
        </div>
        {ml.notes.length > 0 && (
          <div className="panel-row">
            <span className="label">Notes</span>
            <span className="value muted">{ml.notes[0]}</span>
          </div>
        )}
      </div>
    </div>
  );
}
