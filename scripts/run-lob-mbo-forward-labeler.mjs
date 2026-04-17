#!/usr/bin/env node
/**
 * run-lob-mbo-forward-labeler.mjs — CLI driver for the Phase 4.2 labeler.
 *
 * Reads logs/lob_mbo_scalp_candidates.jsonl (from Phase 4.1 writer) and
 * logs/lob_top_of_book.jsonl (from the Python sidecar tick stream),
 * computes forward labels via the pure functions in
 * lob-mbo-forward-labeler.mjs, and writes
 * logs/lob_mbo_scalp_candidates_labeled.jsonl with the meta header
 * row + one labeled row per input candidate.
 *
 * Usage:
 *   node scripts/run-lob-mbo-forward-labeler.mjs \
 *        [--candidates logs/lob_mbo_scalp_candidates.jsonl] \
 *        [--ticks logs/lob_top_of_book.jsonl] \
 *        [--out logs/lob_mbo_scalp_candidates_labeled.jsonl]
 *
 * Exit codes:
 *   0 — success
 *   1 — missing input file
 *   2 — unexpected error during labeling / write
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  buildMidPriceTrack,
  labelCandidates,
  buildOutputMetaRow,
} from './lob-mbo-forward-labeler.mjs';

// ─── File I/O helpers (CLI-local; pure functions live in the labeler) ─────

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip corrupt lines — label what we can.
    }
  }
  return out;
}

function writeJsonl(path, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
  writeFileSync(path, body, 'utf8');
}

function parseArgs(argv) {
  const args = {
    candidates: 'logs/lob_mbo_scalp_candidates.jsonl',
    ticks: 'logs/lob_top_of_book.jsonl',
    out: 'logs/lob_mbo_scalp_candidates_labeled.jsonl',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--candidates' && i + 1 < argv.length) args.candidates = argv[++i];
    else if (a === '--ticks' && i + 1 < argv.length) args.ticks = argv[++i];
    else if (a === '--out' && i + 1 < argv.length) args.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/run-lob-mbo-forward-labeler.mjs \\\n' +
        '         [--candidates logs/lob_mbo_scalp_candidates.jsonl] \\\n' +
        '         [--ticks logs/lob_top_of_book.jsonl] \\\n' +
        '         [--out logs/lob_mbo_scalp_candidates_labeled.jsonl]\n' +
        '\n' +
        'Builds a sub-second forward-return labeled dataset by joining\n' +
        'Phase 4.1 scalper candidates against the Phase 1 top-of-book tick\n' +
        'stream. Horizons: 1s, 3s, 5s. Trailing coverage tolerance: 250 ms.\n',
      );
      process.exit(0);
    }
  }
  return args;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidatesPath = resolve(args.candidates);
  const ticksPath = resolve(args.ticks);
  const outPath = resolve(args.out);

  if (!existsSync(candidatesPath)) {
    console.error(`[LABELER] Candidates file not found: ${candidatesPath}`);
    process.exit(1);
  }
  if (!existsSync(ticksPath)) {
    console.error(`[LABELER] Ticks file not found: ${ticksPath}`);
    process.exit(1);
  }

  let labeledRows;
  let stats;
  let candidatesMeta = null;

  try {
    const rawCandidates = readJsonl(candidatesPath);
    const rawTicks = readJsonl(ticksPath);

    // Meta-row extraction: take the first meta row from the candidates file
    // so we can carry forward rejection_sample_rate into the output header.
    // The labeler itself skips meta rows at ingest — this is purely for the
    // output metadata propagation.
    candidatesMeta = rawCandidates.find((r) => r && typeof r === 'object' && r.meta === true) ?? null;

    const track = buildMidPriceTrack(rawTicks);
    console.log(`[LABELER] Candidates loaded: ${rawCandidates.length} (meta: ${candidatesMeta ? 'yes' : 'no'})`);
    console.log(`[LABELER] Tick track built:  ${track.length} samples`);

    const result = labelCandidates({ candidates: rawCandidates, track });
    labeledRows = result.labeledRows;
    stats = result.stats;

    const metaRow = buildOutputMetaRow({ candidatesMeta });
    const outRows = [metaRow, ...labeledRows];
    writeJsonl(outPath, outRows);

    console.log(`[LABELER] Output written:    ${outPath} (${outRows.length} rows, 1 meta + ${labeledRows.length} data)`);
    console.log('[LABELER] Stats:');
    console.log(`  total_candidates:   ${stats.total_candidates}`);
    console.log(`  skipped_meta_rows:  ${stats.skipped_meta_rows}`);
    console.log(`  skipped_invalid:    ${stats.skipped_invalid_rows}`);
    console.log(`  labeled_rows:       ${stats.labeled_rows}`);
    for (const [h, count] of Object.entries(stats.covered_by_horizon)) {
      const pct = stats.labeled_rows > 0 ? ((count / stats.labeled_rows) * 100).toFixed(1) : '0.0';
      console.log(`  covered_${h}:  ${count} (${pct}%)`);
    }
  } catch (err) {
    console.error(`[LABELER] Unexpected error: ${err?.message ?? err}`);
    process.exit(2);
  }
}

main();
