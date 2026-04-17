#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Skip corrupt lines so the report stays usable on partial logs.
    }
  }
  return rows;
}

function summarizeSignals(rows) {
  const scalperRejectReasons = {};
  let signalsWithDiagnostics = 0;
  let scalperDiagnosticsCount = 0;
  let scalperAcceptedCount = 0;

  for (const row of rows) {
    const diags = Array.isArray(row?.candidate_diagnostics) ? row.candidate_diagnostics : [];
    if (diags.length > 0) {
      signalsWithDiagnostics += 1;
    }
    for (const diag of diags) {
      if (diag?.setup_family !== 'lob_mbo_scalp') continue;
      scalperDiagnosticsCount += 1;
      if (diag.accepted === true) {
        scalperAcceptedCount += 1;
      }
      const reason = typeof diag.rejection_reason_primary === 'string'
        ? diag.rejection_reason_primary
        : diag.accepted === true
          ? 'accepted'
          : 'unknown';
      scalperRejectReasons[reason] = (scalperRejectReasons[reason] ?? 0) + 1;
    }
  }

  return {
    signal_count: rows.length,
    signals_with_candidate_diagnostics: signalsWithDiagnostics,
    scalper_diagnostics_count: scalperDiagnosticsCount,
    scalper_accepted_count: scalperAcceptedCount,
    scalper_rejection_reasons: scalperRejectReasons,
  };
}

function summarizeSnapshotCoverage(rows) {
  let withScalpState = 0;
  let withoutScalpState = 0;
  let lastDataQuality = null;
  let lastRecordingContext = null;

  for (const row of rows) {
    const scalpState = row?.scalp_state ?? null;
    if (scalpState && typeof scalpState === 'object') {
      withScalpState += 1;
    } else {
      withoutScalpState += 1;
    }
    lastDataQuality = typeof row?.data_quality === 'string' ? row.data_quality : lastDataQuality;
    lastRecordingContext = typeof row?.recording_context === 'string' ? row.recording_context : lastRecordingContext;
  }

  return {
    snapshot_count: rows.length,
    snapshots_with_scalp_state: withScalpState,
    snapshots_without_scalp_state: withoutScalpState,
    last_data_quality: lastDataQuality,
    last_recording_context: lastRecordingContext,
  };
}

function topReason(reasonCounts) {
  let bestReason = null;
  let bestCount = -1;
  for (const [reason, count] of Object.entries(reasonCounts)) {
    if (count > bestCount) {
      bestReason = reason;
      bestCount = count;
    }
  }
  return bestReason;
}

function deriveLikelyBlocker({ candidateRows, signalSummary, snapshotSummary }) {
  if (candidateRows > 0) return 'candidate_log_present';
  if (signalSummary.scalper_diagnostics_count > 0) {
    return `scalper_generator:${topReason(signalSummary.scalper_rejection_reasons) ?? 'unknown'}`;
  }
  if (
    snapshotSummary.snapshot_count > 0 &&
    snapshotSummary.snapshots_with_scalp_state === 0
  ) {
    return 'sidecar_snapshot_missing_scalp_state';
  }
  if (snapshotSummary.snapshot_count === 0) {
    return 'no_lob_session_snapshots';
  }
  return 'candidate_generation_blocker_unknown';
}

const targetPath = resolve(process.argv[2] ?? '.');
const signalsPath = join(targetPath, 'signals.jsonl');
const candidatesPath = join(targetPath, 'lob_mbo_scalp_candidates.jsonl');
const snapshotsPath = join(targetPath, 'lob_session_snapshots.jsonl');
const topOfBookPath = join(targetPath, 'lob_top_of_book.jsonl');
const marketDataHealthPath = join(targetPath, 'startup_market_data_health.json');

try {
  const signals = readJsonl(signalsPath);
  const candidates = readJsonl(candidatesPath);
  const snapshots = readJsonl(snapshotsPath);
  const marketDataHealth = readJson(marketDataHealthPath);

  const signalSummary = summarizeSignals(signals);
  const snapshotSummary = summarizeSnapshotCoverage(snapshots);
  const candidateRows = candidates.filter((row) => !(row && row.meta === true)).length;

  const report = {
    target_path: targetPath,
    files: {
      signals_jsonl: existsSync(signalsPath),
      lob_mbo_scalp_candidates_jsonl: existsSync(candidatesPath),
      lob_session_snapshots_jsonl: existsSync(snapshotsPath),
      lob_top_of_book_jsonl: existsSync(topOfBookPath),
    },
    byte_sizes: {
      signals_jsonl: existsSync(signalsPath) ? statSync(signalsPath).size : 0,
      lob_mbo_scalp_candidates_jsonl: existsSync(candidatesPath) ? statSync(candidatesPath).size : 0,
      lob_session_snapshots_jsonl: existsSync(snapshotsPath) ? statSync(snapshotsPath).size : 0,
      lob_top_of_book_jsonl: existsSync(topOfBookPath) ? statSync(topOfBookPath).size : 0,
    },
    market_data_startup: marketDataHealth
      ? {
          instrument: marketDataHealth.instrument ?? null,
          selected_source: marketDataHealth.market_data_source_selected ?? null,
          health_state: marketDataHealth.lob_health_state ?? null,
          fallback_reason: marketDataHealth.fallback_reason ?? null,
        }
      : null,
    signal_summary: signalSummary,
    candidate_log_summary: {
      row_count: candidateRows,
      meta_row_present: candidates.some((row) => row && row.meta === true),
    },
    snapshot_summary: snapshotSummary,
  };

  report.likely_blocker = deriveLikelyBlocker({
    candidateRows,
    signalSummary,
    snapshotSummary,
  });

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
