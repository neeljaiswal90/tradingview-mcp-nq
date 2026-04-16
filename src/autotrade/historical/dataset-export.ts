/**
 * ML-ready dataset exporters.
 *
 * Reads the JSONL logs emitted by the historical runner and writes wide CSV
 * files suitable for downstream analysis / ML work. Parquet is intentionally
 * not used here — the repo has no parquet dependency, and CSV is the most
 * portable format for future tooling (pandas, polars, DuckDB).
 *
 * Two datasets:
 *   - signal dataset: one row per strategy decision point (executed or not)
 *   - trade dataset: one row per closed trade
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { filterScalperRows } from '../../shared/scalper-exclusion.js';

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt */ }
  }
  return out;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v).replace(/"/g, '""');
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(path: string, rows: Array<Record<string, unknown>>, columns: string[]): void {
  const out: string[] = [];
  out.push(columns.join(','));
  for (const r of rows) {
    out.push(columns.map(c => {
      const val = r[c];
      // Handle escaped quotes around JSON objects
      const esc = csvEscape(val);
      if (typeof val === 'object' && val !== null) return `"${esc}"`;
      return esc;
    }).join(','));
  }
  writeFileSync(path, out.join('\n'), 'utf8');
}

const SIGNAL_COLUMNS = [
  'signal_id', 'session_id', 'timestamp', 'unix_ts', 'symbol',
  'run_mode', 'bar_index',
  'market_regime', 'current_price',
  'confidence', 'trade_allowed', 'execution_occurred', 'no_trade',
  'reason_for_skip',
  'htf_available_5m', 'htf_available_15m', 'htf_available_60m',
  'setup_type', 'direction', 'entry_low', 'entry_high',
  'stop', 'target_1', 'target_2', 'target_3',
  'rr_t1', 'rr_t2', 'risk_pts',
  'target_1_direction_valid', 'target_2_direction_valid', 'target_ordering_valid',
  'alignment_score', 'htf_alignment',
  // HTF zone features (from ml_features)
  'htf_study_present', 'htf_inside_resistance', 'htf_inside_support',
  'htf_nearest_res_tf', 'htf_nearest_sup_tf',
  'htf_nearest_obstacle_tf', 'htf_nearest_obstacle_kind',
  'htf_distance_res_pts', 'htf_distance_sup_pts',
  'htf_distance_res_atr', 'htf_distance_sup_atr',
  'htf_first_obstacle_rr', 'htf_location_quality',
  'htf_veto_reason', 'htf_breakout_accepted',
  // Phase 4 parallel quant reward contract
  'stop_quant', 'target_1_quant', 'target_2_quant',
  'risk_pts_quant', 'rr_t1_quant', 'rr_t2_quant',
  'bucket_source_quant',
  // Phase 6 expectancy fields
  'expected_r_30s_quant', 'win_prob_30s_quant', 'quality_band_quant',
  'bucket_id_quant', 'bucket_sample_count_quant',
  'quant_shadow_reject_reason',
  // Phase 1 frozen entry state vector (JSON-serialized)
  'entry_state_vector_json', 'entry_state_vector_schema_version',
  // Phase 7 telemetry
  'entry_state_vector_hash',
  'quant_shadow_combined_verdict', 'quant_shadow_combined_reason',
  'quant_shadow_expectancy_verdict', 'quant_shadow_expectancy_reason',
  'quant_shadow_entry_ml_verdict', 'quant_shadow_entry_ml_reason',
  'quant_shadow_gate_active',
  'quant_shadow_flag_enabled', 'quant_shadow_flag_hybrid_gate',
  // Phase 5 forward-return labels (written by the backfill labeler)
  'fwd_return_10s_pts', 'fwd_return_30s_pts', 'fwd_return_60s_pts',
  'mfe_10s_pts', 'mfe_30s_pts', 'mfe_60s_pts',
  'mae_10s_pts', 'mae_30s_pts', 'mae_60s_pts',
  'did_tp1_before_sl', 'time_to_tp1_ms',
  'fwd_label_source', 'fwd_label_horizon_coverage',
];

const TRADE_COLUMNS = [
  'trade_id', 'parent_signal_id', 'session_id', 'symbol', 'venue',
  'run_mode', 'bar_index', 'entry_bar_index', 'fill_model', 'ambiguity_policy',
  'side', 'setup_type', 'market_regime', 'confidence_score', 'confidence_bucket',
  'timestamp_entry', 'timestamp_exit', 'hold_time_seconds',
  'entry_price_filled', 'stop_price_initial', 'stop_price_final',
  'target_1', 'target_2', 'target_3',
  'exit_price_planned', 'exit_price_actual', 'exit_slippage_vs_plan_pts',
  'quantity', 'notional_value',
  'pnl_realized', 'r_multiple', 'max_unrealized_r', 'max_drawdown_r',
  'mfe', 'mae',
  'exit_reason', 'exit_reason_detailed', 'outcome_class',
  'hit_target_1', 'hit_target_2', 'stopped_out', 'exited_on_time_stop',
  'ambiguous_exit', 'slippage_actual',
  // Partial-exit & trailing-stop state (patch P1/P2/P3)
  'post_t1_exit', 'trailing_active', 'trail_distance_ticks',
  'qty_partial', 'qty_remaining', 'partial_exit_done',
];

export function exportSignalDataset(signalsJsonlPath: string, outCsv: string, filterSession?: string): number {
  // Contamination firewall: drop lob_mbo_scalp rows and any metadata rows
  // before the exporter touches them. The scalper has its own export path
  // in src/autotrade/historical/lob-mbo-scalp-dataset-export.ts (Phase 7).
  // This filter keeps the legacy trend CSV free of scalper contamination.
  const rows = filterScalperRows(readJsonl(signalsJsonlPath))
    .filter(r => !filterSession || r['session_id'] === filterSession);
  const flat: Array<Record<string, unknown>> = rows.map(r => {
    const cs = (r['candidate_setup'] ?? {}) as Record<string, unknown>;
    const bias = (r['higher_timeframe_bias'] ?? {}) as Record<string, unknown>;
    const mlf = (r['ml_features'] ?? {}) as Record<string, unknown>;
    const esv = (cs['entry_state_vector'] ?? null) as Record<string, unknown> | null;
    // Forward-return labels may be written onto the signal row either at
    // the top level (by the Phase 5 backfill labeler) or not at all (raw
    // live logs). Fall through to null gracefully.
    const fwd = (r['forward_return_labels'] ?? {}) as Record<string, unknown>;
    return {
      ...r,
      setup_type: cs['setup_type'] ?? null,
      direction: cs['direction'] ?? null,
      entry_low: cs['entry_low'] ?? null,
      entry_high: cs['entry_high'] ?? null,
      stop: cs['stop'] ?? null,
      target_1: cs['target_1'] ?? null,
      target_2: cs['target_2'] ?? null,
      target_3: cs['target_3'] ?? null,
      rr_t1: cs['rr_t1'] ?? null,
      rr_t2: cs['rr_t2'] ?? null,
      risk_pts: cs['risk_pts'] ?? null,
      target_1_direction_valid: cs['target_1_direction_valid'] ?? null,
      target_2_direction_valid: cs['target_2_direction_valid'] ?? null,
      target_ordering_valid: cs['target_ordering_valid'] ?? null,
      alignment_score: bias['alignment_score'] ?? null,
      htf_alignment: bias['1h'] ?? null,
      // HTF zone features (from ml_features)
      htf_study_present: mlf['htf_study_present'] ?? null,
      htf_inside_resistance: mlf['htf_inside_resistance'] ?? null,
      htf_inside_support: mlf['htf_inside_support'] ?? null,
      htf_nearest_res_tf: mlf['htf_nearest_res_tf'] ?? null,
      htf_nearest_sup_tf: mlf['htf_nearest_sup_tf'] ?? null,
      htf_nearest_obstacle_tf: mlf['htf_nearest_obstacle_tf'] ?? null,
      htf_nearest_obstacle_kind: mlf['htf_nearest_obstacle_kind'] ?? null,
      htf_distance_res_pts: mlf['htf_distance_res_pts'] ?? null,
      htf_distance_sup_pts: mlf['htf_distance_sup_pts'] ?? null,
      htf_distance_res_atr: mlf['htf_distance_res_atr'] ?? null,
      htf_distance_sup_atr: mlf['htf_distance_sup_atr'] ?? null,
      htf_first_obstacle_rr: mlf['htf_first_obstacle_rr'] ?? null,
      htf_location_quality: mlf['htf_location_quality'] ?? null,
      htf_veto_reason: mlf['htf_veto_reason'] ?? null,
      htf_breakout_accepted: mlf['htf_breakout_accepted'] ?? null,
      // Phase 4 parallel quant reward contract (populated by
      // generateSignal() via hydrateQuantRewardContract when the setup
      // is trend_pullback_long/short and a ContractSpec is available).
      stop_quant: cs['stop_quant'] ?? null,
      target_1_quant: cs['target_1_quant'] ?? null,
      target_2_quant: cs['target_2_quant'] ?? null,
      risk_pts_quant: cs['risk_pts_quant'] ?? null,
      rr_t1_quant: cs['rr_t1_quant'] ?? null,
      rr_t2_quant: cs['rr_t2_quant'] ?? null,
      bucket_source_quant: cs['bucket_source_quant'] ?? null,
      // Phase 6 expectancy fields
      expected_r_30s_quant: cs['expected_r_30s_quant'] ?? null,
      win_prob_30s_quant: cs['win_prob_30s_quant'] ?? null,
      quality_band_quant: cs['quality_band_quant'] ?? null,
      bucket_id_quant: cs['bucket_id_quant'] ?? null,
      bucket_sample_count_quant: cs['bucket_sample_count_quant'] ?? null,
      quant_shadow_reject_reason: cs['quant_shadow_reject_reason'] ?? null,
      // Phase 1 frozen entry state vector — serialized as JSON so the
      // full object travels through CSV without flattening every field.
      entry_state_vector_json: esv ? JSON.stringify(esv) : null,
      entry_state_vector_schema_version: esv ? (esv['schema_version'] ?? null) : null,
      // Phase 7 telemetry. `quant_shadow_decision` is a nested object;
      // we flatten the interesting fields into dedicated columns so
      // standard CSV consumers can filter/group on per-gate verdicts.
      entry_state_vector_hash: cs['entry_state_vector_hash'] ?? null,
      ...(() => {
        const qsd = (cs['quant_shadow_decision'] ?? null) as Record<string, unknown> | null;
        if (!qsd) {
          return {
            quant_shadow_combined_verdict: null,
            quant_shadow_combined_reason: null,
            quant_shadow_expectancy_verdict: null,
            quant_shadow_expectancy_reason: null,
            quant_shadow_entry_ml_verdict: null,
            quant_shadow_entry_ml_reason: null,
            quant_shadow_gate_active: null,
            quant_shadow_flag_enabled: null,
            quant_shadow_flag_hybrid_gate: null,
          };
        }
        const expectancy = (qsd['expectancy'] ?? {}) as Record<string, unknown>;
        const entryMl = (qsd['entry_ml'] ?? {}) as Record<string, unknown>;
        const flags = (qsd['flags'] ?? {}) as Record<string, unknown>;
        return {
          quant_shadow_combined_verdict: qsd['combined_verdict'] ?? null,
          quant_shadow_combined_reason: qsd['combined_reason'] ?? null,
          quant_shadow_expectancy_verdict: expectancy['verdict'] ?? null,
          quant_shadow_expectancy_reason: expectancy['reason'] ?? null,
          quant_shadow_entry_ml_verdict: entryMl['verdict'] ?? null,
          quant_shadow_entry_ml_reason: entryMl['reason'] ?? null,
          quant_shadow_gate_active: qsd['gate_active'] ?? null,
          quant_shadow_flag_enabled: flags['enabled'] ?? null,
          quant_shadow_flag_hybrid_gate: flags['hybrid_gate'] ?? null,
        };
      })(),
      // Phase 5 forward-return labels. These are populated by the
      // scripts/backfill-forward-labels.mjs backfill CLI; raw signal
      // rows from the live runner will have nulls here.
      fwd_return_10s_pts: fwd['fwd_return_10s_pts'] ?? null,
      fwd_return_30s_pts: fwd['fwd_return_30s_pts'] ?? null,
      fwd_return_60s_pts: fwd['fwd_return_60s_pts'] ?? null,
      mfe_10s_pts: fwd['mfe_10s_pts'] ?? null,
      mfe_30s_pts: fwd['mfe_30s_pts'] ?? null,
      mfe_60s_pts: fwd['mfe_60s_pts'] ?? null,
      mae_10s_pts: fwd['mae_10s_pts'] ?? null,
      mae_30s_pts: fwd['mae_30s_pts'] ?? null,
      mae_60s_pts: fwd['mae_60s_pts'] ?? null,
      did_tp1_before_sl: fwd['did_tp1_before_sl'] ?? null,
      time_to_tp1_ms: fwd['time_to_tp1_ms'] ?? null,
      fwd_label_source: fwd['source'] ?? null,
      fwd_label_horizon_coverage: fwd['horizon_coverage_sec'] ?? null,
    };
  });
  writeCsv(outCsv, flat, SIGNAL_COLUMNS);
  return flat.length;
}

export function exportTradeDataset(tradesJsonlPath: string, outCsv: string, filterSession?: string): number {
  // Contamination firewall: drop lob_mbo_scalp rows. trades.jsonl carries
  // setup_type at the top level and can include scalper trades once the
  // family is promoted out of shadow — this filter guarantees the legacy
  // trend trade CSV stays trend-only regardless of execution mode.
  const rows = filterScalperRows(readJsonl(tradesJsonlPath))
    .filter(r => !filterSession || r['session_id'] === filterSession);
  writeCsv(outCsv, rows, TRADE_COLUMNS);
  return rows.length;
}
