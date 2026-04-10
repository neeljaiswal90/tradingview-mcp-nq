import type { Management } from '../types';
import { fmtUsd } from '../format';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function formatProbability(value: number | null): string {
  if (value == null) return '--';
  return `${(value * 100).toFixed(1)}%`;
}

interface Props {
  management: Management;
}

export function ManagementPanel({ management }: Props) {
  const hasManagement = management.management_state !== null
    || management.last_evaluated_at !== null
    || management.expected_value_hold_usd !== null
    || management.decision_factors.length > 0;

  if (!hasManagement) {
    return (
      <div className="panel">
        <h3 className="panel-title">Management Advisory</h3>
        <div className="empty-state">
          <p>No active management advisory</p>
        </div>
      </div>
    );
  }

  const stateClass =
    management.management_state === 'HOLD' ? 'state-hold' :
    management.management_state === 'REDUCE' ? 'state-reduce' :
    management.management_state === 'MOVE_STOP' ? 'state-move' :
    management.management_state === 'EXIT_NOW' ? 'state-exit' :
    'state-neutral';

  return (
    <div className="panel">
      <h3 className="panel-title">
        Management Advisory
        <span className={`management-state-badge ${stateClass}`}>
          {management.management_state ?? '--'}
        </span>
      </h3>
      <div className="panel-grid">
        <div className="panel-row">
          <span className="label">Reason</span>
          <span className="value">{management.management_state_reason ?? '--'}</span>
        </div>
        <div className="panel-row">
          <span className="label">PoP T1 / T2 / Runner</span>
          <span className="value">
            {formatProbability(management.pop_target1_before_stop)} / {formatProbability(management.pop_target2_before_stop)} / {formatProbability(management.pop_runner_extension)}
          </span>
        </div>
        <div className="panel-row">
          <span className="label">EV Hold / Exit / Reduce</span>
          <span className="value">
            {fmtUsd(management.expected_value_hold_usd)} / {fmtUsd(management.expected_value_exit_now_usd)} / {fmtUsd(management.expected_value_reduce_usd)}
          </span>
        </div>
        <div className="panel-row">
          <span className="label">Model</span>
          <span className="value">
            {management.model_name ?? '--'} <span className="muted">{management.model_confidence ?? 'unknown'}</span>
          </span>
        </div>
        <div className="panel-row">
          <span className="label">Last Eval</span>
          <span className="value">{timeAgo(management.last_evaluated_at)}</span>
        </div>
        <div className="panel-row">
          <span className="label">Factors</span>
          <span className="value-list">
            {management.decision_factors.length > 0
              ? management.decision_factors.map((factor) => (
                <span key={factor} className="management-factor">{factor}</span>
              ))
              : <span className="muted">None</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
