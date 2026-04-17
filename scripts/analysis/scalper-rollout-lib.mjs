import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const EXPECTED_COEFS_FILES = [
  'long_1s_coefs.json',
  'long_3s_coefs.json',
  'long_5s_coefs.json',
  'short_1s_coefs.json',
  'short_3s_coefs.json',
  'short_5s_coefs.json',
];

function parseJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isFinitePositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function resolveRepoRoot(explicitRepoRoot = null) {
  return explicitRepoRoot ? resolve(explicitRepoRoot) : process.cwd();
}

export function resolveScalperModelArtifacts(repoRoot) {
  const envDir = process.env['LOB_MBO_SCALP_MODEL_DIR'];
  if (envDir) {
    const candidate = resolve(repoRoot, envDir);
    return inspectModelDir(candidate, 'env');
  }

  const promotedPath = join(repoRoot, 'models', 'lob_mbo_scalp', 'promoted.json');
  if (existsSync(promotedPath)) {
    try {
      const promoted = parseJsonFile(promotedPath);
      if (typeof promoted?.version === 'string' && promoted.version.length > 0) {
        const candidate = join(repoRoot, 'models', 'lob_mbo_scalp', 'versions', promoted.version);
        return inspectModelDir(candidate, 'promoted');
      }
    } catch {
      // Fall through to latest-version resolution.
    }
  }

  const versionsDir = join(repoRoot, 'models', 'lob_mbo_scalp', 'versions');
  if (existsSync(versionsDir) && statSync(versionsDir).isDirectory()) {
    const entries = readdirSync(versionsDir)
      .filter((name) => {
        try {
          return statSync(join(versionsDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    if (entries.length > 0) {
      return inspectModelDir(join(versionsDir, entries.at(-1)), 'latest_version');
    }
  }

  return {
    status: 'missing',
    source: 'missing',
    model_dir: null,
    present_files: [],
    missing_files: [...EXPECTED_COEFS_FILES],
  };
}

function inspectModelDir(modelDir, source) {
  if (!modelDir || !existsSync(modelDir) || !statSync(modelDir).isDirectory()) {
    return {
      status: 'missing',
      source,
      model_dir: modelDir ?? null,
      present_files: [],
      missing_files: [...EXPECTED_COEFS_FILES],
    };
  }

  const presentFiles = [];
  const missingFiles = [];
  for (const fileName of EXPECTED_COEFS_FILES) {
    const filePath = join(modelDir, fileName);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      presentFiles.push(fileName);
    } else {
      missingFiles.push(fileName);
    }
  }

  return {
    status: missingFiles.length === 0 ? 'ready' : 'incomplete',
    source,
    model_dir: modelDir,
    present_files: presentFiles,
    missing_files: missingFiles,
  };
}

export function resolveScalperExpectancyArtifact(repoRoot) {
  const indicatorConfigPath = join(repoRoot, 'config', 'indicator-config.json');
  const out = {
    configured_path: null,
    resolved_path: null,
    status: 'missing_config',
  };

  if (!existsSync(indicatorConfigPath)) {
    return out;
  }

  try {
    const indicatorConfig = parseJsonFile(indicatorConfigPath);
    const configuredPath = indicatorConfig?.lob_mbo_scalp?.expectancy_bucket_table_path ?? null;
    out.configured_path = configuredPath;
    if (typeof configuredPath !== 'string' || configuredPath.length === 0) {
      out.status = 'missing_path';
      return out;
    }
    const resolvedPath = resolve(repoRoot, configuredPath);
    out.resolved_path = resolvedPath;
    out.status = existsSync(resolvedPath) && statSync(resolvedPath).isFile() ? 'ready' : 'missing_file';
    return out;
  } catch {
    out.status = 'invalid_config';
    return out;
  }
}

export function readScalperCandidateRows(targetPath) {
  const resolvedTarget = resolve(targetPath);
  const candidateFiles = findCandidateFiles(resolvedTarget);
  const rows = [];
  for (const filePath of candidateFiles) {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      if (payload.meta === true) continue;
      rows.push({ file_path: filePath, payload });
    }
  }
  return { target: resolvedTarget, files: candidateFiles, rows };
}

function findCandidateFiles(targetPath) {
  if (!existsSync(targetPath)) {
    throw new Error(`Path not found: ${targetPath}`);
  }

  const stat = statSync(targetPath);
  if (stat.isFile()) {
    return targetPath.endsWith('lob_mbo_scalp_candidates.jsonl') ? [targetPath] : [];
  }

  const found = [];
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === 'lob_mbo_scalp_candidates.jsonl') {
        found.push(fullPath);
      }
    }
  }
  found.sort();
  return found;
}

export function summarizeScalperRows(rowEntries) {
  const summary = {
    files: {},
    totals: {
      rows_raw: 0,
      rows_weighted: 0,
      allowed_raw: 0,
      allowed_weighted: 0,
      rejected_raw: 0,
      rejected_weighted: 0,
      expectancy_ready_raw: 0,
      ml_ready_raw: 0,
    },
    by_direction: {},
    by_reject_stage: {},
    top_reject_reasons: {},
  };

  for (const { file_path, payload } of rowEntries) {
    const sampleWeight = isFinitePositiveNumber(payload.sample_weight) ? payload.sample_weight : 1;
    const direction = typeof payload.direction === 'string' ? payload.direction : 'unknown';
    const rejectStage = typeof payload.reject_stage === 'string' ? payload.reject_stage : 'unknown';
    const rejectReason = typeof payload.reject_reason === 'string' ? payload.reject_reason : 'unknown';
    const allowed = payload.all_gates_passed === true;

    summary.totals.rows_raw += 1;
    summary.totals.rows_weighted += sampleWeight;
    if (payload.expectancy_ready === true) summary.totals.expectancy_ready_raw += 1;
    if (payload.ml_ready === true) summary.totals.ml_ready_raw += 1;
    if (allowed) {
      summary.totals.allowed_raw += 1;
      summary.totals.allowed_weighted += sampleWeight;
    } else {
      summary.totals.rejected_raw += 1;
      summary.totals.rejected_weighted += sampleWeight;
      summary.by_reject_stage[rejectStage] = (summary.by_reject_stage[rejectStage] ?? 0) + sampleWeight;
      summary.top_reject_reasons[rejectReason] = (summary.top_reject_reasons[rejectReason] ?? 0) + sampleWeight;
    }

    if (!summary.by_direction[direction]) {
      summary.by_direction[direction] = {
        rows_raw: 0,
        rows_weighted: 0,
        allowed_raw: 0,
        rejected_raw: 0,
      };
    }
    summary.by_direction[direction].rows_raw += 1;
    summary.by_direction[direction].rows_weighted += sampleWeight;
    if (allowed) {
      summary.by_direction[direction].allowed_raw += 1;
    } else {
      summary.by_direction[direction].rejected_raw += 1;
    }

    if (!summary.files[file_path]) {
      summary.files[file_path] = {
        rows_raw: 0,
        rows_weighted: 0,
        allowed_raw: 0,
        rejected_raw: 0,
      };
    }
    summary.files[file_path].rows_raw += 1;
    summary.files[file_path].rows_weighted += sampleWeight;
    if (allowed) {
      summary.files[file_path].allowed_raw += 1;
    } else {
      summary.files[file_path].rejected_raw += 1;
    }
  }

  return summary;
}

export function buildScalperHealthReport({ targetPath, repoRoot }) {
  const scan = readScalperCandidateRows(targetPath);
  const summary = summarizeScalperRows(scan.rows);
  const expectancyArtifact = resolveScalperExpectancyArtifact(repoRoot);
  const modelArtifacts = resolveScalperModelArtifacts(repoRoot);

  return {
    source: 'lob_mbo_scalp_candidates',
    target: scan.target,
    repo_root: repoRoot,
    files_found: scan.files.length,
    artifact_health: {
      expectancy_bucket_table: expectancyArtifact,
      model_artifacts: modelArtifacts,
    },
    summary,
  };
}

export function assessScalperRolloutGate(report, thresholds = {}) {
  const effectiveThresholds = {
    minRowsRaw: Number.isFinite(thresholds.minRowsRaw) ? thresholds.minRowsRaw : 1000,
    minExpectancyReadyRaw: Number.isFinite(thresholds.minExpectancyReadyRaw) ? thresholds.minExpectancyReadyRaw : 100,
    minMlReadyRaw: Number.isFinite(thresholds.minMlReadyRaw) ? thresholds.minMlReadyRaw : 100,
    minAllowedRaw: Number.isFinite(thresholds.minAllowedRaw) ? thresholds.minAllowedRaw : 20,
  };

  const reasons = [];
  const totals = report.summary.totals;
  if (report.artifact_health.expectancy_bucket_table.status !== 'ready') {
    reasons.push(`expectancy_bucket_table:${report.artifact_health.expectancy_bucket_table.status}`);
  }
  if (report.artifact_health.model_artifacts.status !== 'ready') {
    reasons.push(`model_artifacts:${report.artifact_health.model_artifacts.status}`);
  }
  if (totals.rows_raw < effectiveThresholds.minRowsRaw) {
    reasons.push(`rows_raw_below_threshold:${totals.rows_raw}<${effectiveThresholds.minRowsRaw}`);
  }
  if (totals.expectancy_ready_raw < effectiveThresholds.minExpectancyReadyRaw) {
    reasons.push(
      `expectancy_ready_below_threshold:${totals.expectancy_ready_raw}<${effectiveThresholds.minExpectancyReadyRaw}`,
    );
  }
  if (totals.ml_ready_raw < effectiveThresholds.minMlReadyRaw) {
    reasons.push(`ml_ready_below_threshold:${totals.ml_ready_raw}<${effectiveThresholds.minMlReadyRaw}`);
  }
  if (totals.allowed_raw < effectiveThresholds.minAllowedRaw) {
    reasons.push(`allowed_below_threshold:${totals.allowed_raw}<${effectiveThresholds.minAllowedRaw}`);
  }

  return {
    stage_a_to_b_eligible: reasons.length === 0,
    thresholds: effectiveThresholds,
    reasons,
  };
}
