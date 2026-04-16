import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ResolvedMlPolicy } from '../ml-policy.js';

const DEFAULT_MODEL_FAMILY = 'management_catboost';

export interface ReadinessGateContext {
  repoRoot: string;
  processStartedAtMs: number;
  /** Feature key hash from runtime vs model artifact (when both known). */
  featureSchemaHashRuntime?: string | null;
  featureSchemaHashModel?: string | null;
  requiredLiveFeatureGroupOk?: boolean;
  /** App / runner build SHA for optional comparison to `training_meta.code_sha`. */
  runtimeCodeSha?: string | null;
  /** `ml_management.model_version` from indicator config (optional cross-check vs promoted). */
  mlConfigModelVersion?: string | null;
  /** Subdirectory under `models/` (default `management_catboost`). */
  modelFamily?: string;
}

export interface ReadinessGateResult {
  mlExecutionAllowed: boolean;
  /** Hard blocks — ML broker execution must stay off while any remain. */
  reasons: string[];
  /** Soft signals — logged for operators; do not alone disable execution. */
  warnings: string[];
  /** Full provenance snapshot used for this gate decision. */
  provenance: ReadinessGateProvenance;
}

export interface ReadinessGateProvenance {
  generated_at: string;
  repo_root: string;
  model_family: string;
  promoted_pointer_path: string;
  promoted_version: string | null;
  artifact_dir: string | null;
  training_meta_path: string | null;
  dataset_manifest_path: string;
  dataset_manifest_present: boolean;
  runtime_code_sha: string | null;
  runtime_feature_schema_hash: string | null;
  model_feature_schema_hash: string | null;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolves `models/<family>/promoted.json` and verifies artifact layout expected
 * for fail-closed ML broker execution.
 */
function evaluatePromotionArtifactGate(
  repoRoot: string,
  modelFamily: string,
  ctx: ReadinessGateContext,
): {
  reasons: string[];
  warnings: string[];
  featureSchemaHashFromArtifact: string | null;
  provenance: Omit<ReadinessGateProvenance, 'generated_at'>;
} {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let featureSchemaHashFromArtifact: string | null = null;
  const promotedPath = join(repoRoot, 'models', modelFamily, 'promoted.json');
  const datasetManifestPath = join(repoRoot, 'data', 'management_dataset_manifest.json');
  const provenance: Omit<ReadinessGateProvenance, 'generated_at'> = {
    repo_root: repoRoot,
    model_family: modelFamily,
    promoted_pointer_path: promotedPath,
    promoted_version: null,
    artifact_dir: null,
    training_meta_path: null,
    dataset_manifest_path: datasetManifestPath,
    dataset_manifest_present: false,
    runtime_code_sha: ctx.runtimeCodeSha?.trim() || null,
    runtime_feature_schema_hash: ctx.featureSchemaHashRuntime?.trim() || null,
    model_feature_schema_hash: null,
  };

  if (!existsSync(promotedPath)) {
    reasons.push('promoted_pointer_missing');
    return { reasons, warnings, featureSchemaHashFromArtifact, provenance };
  }

  const pointer = readJsonFile(promotedPath);
  if (!pointer) {
    reasons.push('promoted_pointer_unreadable');
    return { reasons, warnings, featureSchemaHashFromArtifact, provenance };
  }

  const artifactDirRaw = pointer.artifact_dir;
  provenance.promoted_version = String(pointer.version ?? '').trim() || null;
  if (typeof artifactDirRaw !== 'string' || !artifactDirRaw.trim()) {
    reasons.push('promoted_artifact_dir_missing_in_pointer');
    return { reasons, warnings, featureSchemaHashFromArtifact, provenance };
  }

  const artifactDir = artifactDirRaw.trim();
  provenance.artifact_dir = artifactDir;
  if (!existsSync(artifactDir)) {
    reasons.push('promoted_artifact_dir_not_found');
    return { reasons, warnings, featureSchemaHashFromArtifact, provenance };
  }

  const metaFromPointer = pointer.training_meta_path;
  const metaPath =
    typeof metaFromPointer === 'string' && metaFromPointer.trim() && existsSync(metaFromPointer.trim())
      ? metaFromPointer.trim()
      : join(artifactDir, 'training_meta.json');
  provenance.training_meta_path = metaPath;

  const trainingMeta = existsSync(metaPath) ? readJsonFile(metaPath) : null;
  if (!trainingMeta) {
    reasons.push('training_meta_missing');
  } else {
    const metaCodeSha = trainingMeta.code_sha;
    if (
      typeof metaCodeSha === 'string' &&
      metaCodeSha.trim() &&
      ctx.runtimeCodeSha &&
      metaCodeSha.trim() !== ctx.runtimeCodeSha.trim()
    ) {
      reasons.push('training_meta_code_sha_mismatch');
    }

    const metaFeatHash = trainingMeta.feature_schema_hash;
    if (
      typeof metaFeatHash === 'string' &&
      metaFeatHash.trim() &&
      ctx.featureSchemaHashRuntime &&
      metaFeatHash.trim() !== ctx.featureSchemaHashRuntime.trim()
    ) {
      reasons.push('training_meta_feature_schema_hash_mismatch');
    }
  }

  const hashFile = join(artifactDir, 'feature_schema_hash.txt');
  if (existsSync(hashFile)) {
    try {
      featureSchemaHashFromArtifact = readFileSync(hashFile, 'utf8').trim() || null;
    } catch {
      warnings.push('feature_schema_hash_file_unreadable');
    }
    if (
      featureSchemaHashFromArtifact &&
      ctx.featureSchemaHashRuntime &&
      featureSchemaHashFromArtifact !== ctx.featureSchemaHashRuntime.trim()
    ) {
      reasons.push('artifact_feature_schema_hash_txt_mismatch');
    }
  }
  provenance.model_feature_schema_hash = featureSchemaHashFromArtifact;

  const pv = String(pointer.version ?? '').trim();
  const cv = String(ctx.mlConfigModelVersion ?? '').trim();
  if (pv && cv && pv !== cv) {
    warnings.push(`promoted_version_differs_from_config:${pv}_vs_${cv}`);
  }

  if (!existsSync(datasetManifestPath)) {
    reasons.push('training_dataset_manifest_missing');
  } else {
    provenance.dataset_manifest_present = true;
    const manifest = readJsonFile(datasetManifestPath);
    if (!manifest) {
      reasons.push('training_dataset_manifest_unreadable');
    } else {
      const rowCount = Number(manifest.row_count ?? NaN);
      const tradeCount = Number(manifest.trade_count ?? NaN);
      if (!Number.isFinite(rowCount) || rowCount <= 0) {
        reasons.push('training_dataset_manifest_row_count_invalid');
      }
      if (!Number.isFinite(tradeCount) || tradeCount <= 0) {
        reasons.push('training_dataset_manifest_trade_count_invalid');
      }

      const manifestContract = String(manifest.log_contract_required ?? '').trim();
      if (manifestContract && manifestContract !== 'contract_v2') {
        reasons.push('training_dataset_manifest_log_contract_not_v2');
      }
      const manifestFeatureHash = String(manifest.feature_schema_hash ?? '').trim();
      if (
        manifestFeatureHash &&
        ctx.featureSchemaHashRuntime &&
        manifestFeatureHash !== ctx.featureSchemaHashRuntime.trim()
      ) {
        reasons.push('training_dataset_manifest_feature_schema_hash_mismatch');
      }
    }
  }

  return { reasons, warnings, featureSchemaHashFromArtifact, provenance };
}

/**
 * Central fail-closed checks before ML mutates positions or calls the broker.
 * Hard-risk lane must never consult this module.
 */
export function evaluateMlExecutionReadinessGate(
  policy: ResolvedMlPolicy,
  ctx: ReadinessGateContext,
): ReadinessGateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const modelFamily = ctx.modelFamily ?? DEFAULT_MODEL_FAMILY;
  const baseProvenance: ReadinessGateProvenance = {
    generated_at: new Date().toISOString(),
    repo_root: ctx.repoRoot,
    model_family: modelFamily,
    promoted_pointer_path: join(ctx.repoRoot, 'models', modelFamily, 'promoted.json'),
    promoted_version: null,
    artifact_dir: null,
    training_meta_path: null,
    dataset_manifest_path: join(ctx.repoRoot, 'data', 'management_dataset_manifest.json'),
    dataset_manifest_present: false,
    runtime_code_sha: ctx.runtimeCodeSha?.trim() || null,
    runtime_feature_schema_hash: ctx.featureSchemaHashRuntime?.trim() || null,
    model_feature_schema_hash: ctx.featureSchemaHashModel?.trim() || null,
  };

  if (!policy.execution_enabled) {
    return { mlExecutionAllowed: true, reasons: [], warnings: [], provenance: baseProvenance };
  }

  const promo = evaluatePromotionArtifactGate(ctx.repoRoot, modelFamily, ctx);
  reasons.push(...promo.reasons);
  warnings.push(...promo.warnings);
  const provenance: ReadinessGateProvenance = {
    generated_at: new Date().toISOString(),
    ...promo.provenance,
  };

  if (!ctx.featureSchemaHashRuntime || !ctx.featureSchemaHashRuntime.trim()) {
    reasons.push('runtime_feature_schema_hash_missing');
  }

  const readinessPath = join(ctx.repoRoot, 'reports', 'ml', 'readiness', 'latest_readiness.json');
  if (!existsSync(readinessPath)) {
    reasons.push('readiness_missing');
  } else {
    try {
      const raw = JSON.parse(readFileSync(readinessPath, 'utf8')) as { generated_at?: string };
      const gen = raw.generated_at ? Date.parse(raw.generated_at) : NaN;
      if (Number.isNaN(gen)) {
        reasons.push('readiness_generated_at_invalid');
      } else {
        const maxAgeMs = policy.readiness_max_age_hours * 3600_000;
        if (Date.now() - gen > maxAgeMs) {
          reasons.push(`readiness_stale_max_age_${policy.readiness_max_age_hours}h`);
        }
        if (gen < ctx.processStartedAtMs) {
          reasons.push('readiness_before_process_start');
        }
      }
    } catch {
      reasons.push('readiness_unreadable');
    }
  }

  const modelHash =
    ctx.featureSchemaHashModel ??
    promo.featureSchemaHashFromArtifact ??
    null;
  provenance.model_feature_schema_hash = modelHash;

  if (
    ctx.featureSchemaHashRuntime &&
    modelHash &&
    ctx.featureSchemaHashRuntime !== modelHash
  ) {
    reasons.push('feature_schema_hash_mismatch');
  }

  if (ctx.requiredLiveFeatureGroupOk === false) {
    reasons.push('required_live_feature_group_failed');
  }

  return {
    mlExecutionAllowed: reasons.length === 0,
    reasons,
    warnings,
    provenance,
  };
}

/**
 * ML stop moves must not widen risk vs current stop (same or tighter only).
 */
export function mlStopMoveWidensRisk(
  side: 'long' | 'short',
  stopCurrent: number,
  proposedStop: number,
): boolean {
  if (side === 'long') {
    return proposedStop < stopCurrent;
  }
  return proposedStop > stopCurrent;
}
