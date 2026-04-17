#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';

const CANDIDATE_FILE = 'lob_mbo_scalp_candidates.jsonl';
const TICKS_FILE = 'lob_top_of_book.jsonl';

function fail(message, exitCode = 1) {
  console.error(`[SCALPER-CORPUS] ${message}`);
  process.exit(exitCode);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathInsideRepoRoot(repoRoot, absolutePath) {
  const relativePath = relative(repoRoot, absolutePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function toPortableRelativePath(pathValue) {
  return pathValue.split(sep).join('/');
}

function resolveOutputPath(repoRoot, pathValue) {
  const absolutePath = resolve(repoRoot, pathValue);
  if (!isPathInsideRepoRoot(repoRoot, absolutePath)) {
    fail(`output path must stay inside repo root ${repoRoot}: ${pathValue}`);
  }
  return {
    absolutePath,
    relativePath: toPortableRelativePath(relative(repoRoot, absolutePath)),
  };
}

function readJsonl(path) {
  const rows = [];
  if (!existsSync(path)) return rows;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Skip corrupt rows so one bad line does not kill the corpus build.
    }
  }
  return rows;
}

function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(path, body + (rows.length > 0 ? '\n' : ''), 'utf8');
}

function parseArgs(argv) {
  const parsed = {
    repoRoot: process.cwd(),
    searchRoots: ['.runtime'],
    instrument: null,
    outDir: '.runtime/scalper-corpus/latest',
    allowEmpty: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1] ?? null;
    if (current === '--repo-root') {
      parsed.repoRoot = next ?? fail('missing value for --repo-root');
      index += 1;
    } else if (current === '--search-root') {
      parsed.searchRoots.push(next ?? fail('missing value for --search-root'));
      index += 1;
    } else if (current === '--instrument') {
      parsed.instrument = (next ?? fail('missing value for --instrument')).toUpperCase();
      index += 1;
    } else if (current === '--out-dir') {
      parsed.outDir = next ?? fail('missing value for --out-dir');
      index += 1;
    } else if (current === '--allow-empty') {
      parsed.allowEmpty = true;
    } else if (current === '--help' || current === '-h') {
      console.log(
        'Usage: node scripts/analysis/aggregate-scalper-shadow-corpus.mjs ' +
        '[--repo-root DIR] [--search-root DIR ...] [--instrument MNQ|MES|NQ|ES] ' +
        '[--out-dir DIR] [--allow-empty]',
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${current}`);
    }
  }

  if (parsed.searchRoots.length > 1 && parsed.searchRoots[0] === '.runtime') {
    parsed.searchRoots = parsed.searchRoots.slice(1);
  }

  return parsed;
}

function inferInstrumentFromPath(pathValue) {
  const normalized = pathValue.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/logs-mnq/') || normalized.endsWith('/logs-mnq')) return 'MNQ';
  if (normalized.includes('/logs-mes/') || normalized.endsWith('/logs-mes')) return 'MES';
  if (normalized.includes('/logs-nq/') || normalized.endsWith('/logs-nq')) return 'NQ';
  if (normalized.includes('/logs-es/') || normalized.endsWith('/logs-es')) return 'ES';
  return null;
}

function discoverPairedSessions(searchRoot, instrumentFilter) {
  const paired = [];
  const unpaired = [];
  if (!existsSync(searchRoot)) {
    return { paired, unpaired };
  }

  const stack = [resolve(searchRoot)];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    const hasCandidate = entries.some((entry) => entry.isFile() && entry.name === CANDIDATE_FILE);
    const hasTicks = entries.some((entry) => entry.isFile() && entry.name === TICKS_FILE);
    if (hasCandidate) {
      const inferredInstrument = inferInstrumentFromPath(current);
      if (!instrumentFilter || inferredInstrument === instrumentFilter) {
        const candidatePath = join(current, CANDIDATE_FILE);
        const ticksPath = join(current, TICKS_FILE);
        if (hasTicks) {
          paired.push({
            dir: current,
            instrument: inferredInstrument,
            candidatePath,
            ticksPath,
          });
        } else {
          unpaired.push({
            dir: current,
            instrument: inferredInstrument,
            candidatePath,
          });
        }
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(join(current, entry.name));
      }
    }
  }

  paired.sort((a, b) => a.dir.localeCompare(b.dir));
  unpaired.sort((a, b) => a.dir.localeCompare(b.dir));
  return { paired, unpaired };
}

function numericTs(row) {
  if (!isPlainObject(row)) return Number.NaN;
  if (typeof row.ts_ms === 'number' && Number.isFinite(row.ts_ms)) return row.ts_ms;
  if (typeof row.timestamp_ms === 'number' && Number.isFinite(row.timestamp_ms)) return row.timestamp_ms;
  if (typeof row.ts === 'number' && Number.isFinite(row.ts)) return row.ts;
  return Number.NaN;
}

function buildAggregatedMetaRow(firstMeta, pairedSessions) {
  const base = isPlainObject(firstMeta) ? { ...firstMeta } : {};
  return {
    meta: true,
    schema_version: typeof base.schema_version === 'string' ? base.schema_version : '1.0',
    rejection_sample_rate: typeof base.rejection_sample_rate === 'number' ? base.rejection_sample_rate : 1,
    aggregated: true,
    aggregated_at: new Date().toISOString(),
    aggregated_session_count: pairedSessions.length,
    aggregated_source_dirs: pairedSessions.map((session) => session.dir),
  };
}

function aggregateCorpus(repoRoot, pairedSessions, outDir) {
  let firstMeta = null;
  const candidateRows = [];
  const tickRows = [];
  const sessionSummaries = [];

  for (const session of pairedSessions) {
    const rawCandidates = readJsonl(session.candidatePath);
    const rawTicks = readJsonl(session.ticksPath);
    const dataCandidates = [];
    const dataTicks = [];

    for (const row of rawCandidates) {
      if (isPlainObject(row) && row.meta === true) {
        if (!firstMeta) firstMeta = row;
        continue;
      }
      if (!isPlainObject(row)) continue;
      const ts = numericTs(row);
      if (!Number.isFinite(ts)) continue;
      dataCandidates.push(row);
      candidateRows.push(row);
    }

    for (const row of rawTicks) {
      if (!isPlainObject(row) || row.meta === true) continue;
      const ts = numericTs(row);
      if (!Number.isFinite(ts)) continue;
      const bid = row.bid;
      const ask = row.ask;
      if (typeof bid !== 'number' || !Number.isFinite(bid)) continue;
      if (typeof ask !== 'number' || !Number.isFinite(ask)) continue;
      dataTicks.push(row);
      tickRows.push(row);
    }

    sessionSummaries.push({
      dir: toPortableRelativePath(relative(repoRoot, session.dir)),
      instrument: session.instrument,
      candidate_rows: dataCandidates.length,
      tick_rows: dataTicks.length,
    });
  }

  candidateRows.sort((a, b) => numericTs(a) - numericTs(b));
  tickRows.sort((a, b) => numericTs(a) - numericTs(b));

  const outCandidates = resolveOutputPath(repoRoot, join(outDir, CANDIDATE_FILE));
  const outTicks = resolveOutputPath(repoRoot, join(outDir, TICKS_FILE));
  const outManifest = resolveOutputPath(repoRoot, join(outDir, 'corpus_manifest.json'));

  writeJsonl(outCandidates.absolutePath, [buildAggregatedMetaRow(firstMeta, pairedSessions), ...candidateRows]);
  writeJsonl(outTicks.absolutePath, tickRows);

  const manifest = {
    generated_at: new Date().toISOString(),
    repo_root: repoRoot,
    paired_session_count: pairedSessions.length,
    candidate_rows: candidateRows.length,
    tick_rows: tickRows.length,
    out_dir: resolveOutputPath(repoRoot, outDir).relativePath,
    candidates_out: outCandidates.relativePath,
    ticks_out: outTicks.relativePath,
    sessions: sessionSummaries,
  };
  writeFileSync(outManifest.absolutePath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(args.repoRoot);
  const searchRoots = args.searchRoots.map((root) => resolve(repoRoot, root));
  const discoveredPaired = [];
  const discoveredUnpaired = [];

  for (const root of searchRoots) {
    const discovered = discoverPairedSessions(root, args.instrument);
    discoveredPaired.push(...discovered.paired);
    discoveredUnpaired.push(...discovered.unpaired);
  }

  const pairedByDir = new Map();
  for (const session of discoveredPaired) {
    pairedByDir.set(session.dir, session);
  }
  const pairedSessions = [...pairedByDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));

  if (pairedSessions.length === 0 && !args.allowEmpty) {
    fail(
      `no paired scalper sessions found under ${searchRoots.join(', ')} ` +
      `(expected sibling ${CANDIDATE_FILE} + ${TICKS_FILE})`,
    );
  }

  const manifest = aggregateCorpus(repoRoot, pairedSessions, args.outDir);
  const summary = {
    ...manifest,
    instrument_filter: args.instrument,
    search_roots: searchRoots.map((root) => toPortableRelativePath(relative(repoRoot, root))),
    skipped_unpaired_candidate_dirs: discoveredUnpaired.map((session) => ({
      dir: toPortableRelativePath(relative(repoRoot, session.dir)),
      instrument: session.instrument,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
