import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { MlManagementConfig } from './types.js';
import { probeMlManagementHealth } from './decision-engine.js';

export interface MlManagementStartupGateResult {
  /** When true, ML must not call broker or mutate position (inference may still run). */
  executionBlockedByMismatch: boolean;
  reasons: string[];
  health: { ok: boolean; model_loaded: boolean; model_version: string; status: string } | null;
}

/**
 * Fail-closed ML **broker** execution if health is bad or model_version disagrees with config.
 * Writes `startup_ml_execution_gate.json` into the session log directory.
 */
export async function evaluateMlManagementStartupGate(
  mlConfig: MlManagementConfig,
  logDir: string,
  opts?: { skipHealthProbe?: boolean },
): Promise<MlManagementStartupGateResult> {
  const reasons: string[] = [];
  let health: MlManagementStartupGateResult['health'] = null;

  if (!mlConfig.enabled) {
    writeGateArtifact(logDir, {
      ok: true,
      skipped: true,
      reason: 'ml_management_disabled',
      timestamp: new Date().toISOString(),
    });
    return { executionBlockedByMismatch: false, reasons, health };
  }

  if (opts?.skipHealthProbe) {
    writeGateArtifact(logDir, {
      ok: true,
      skipped: true,
      reason: 'ml_inference_disabled_by_policy',
      timestamp: new Date().toISOString(),
    });
    return { executionBlockedByMismatch: false, reasons, health };
  }

  health = await probeMlManagementHealth(mlConfig.service_url, mlConfig.timeout_ms ?? 3000);
  if (!health.ok) {
    reasons.push(`health_not_ok:${health.status}`);
  }
  if (!health.model_loaded) {
    reasons.push('model_not_loaded');
  }

  const want = (mlConfig.model_version ?? '').trim();
  const got = (health.model_version ?? '').trim();
  if (want && got && want !== got) {
    reasons.push(`model_version_mismatch:config=${want}:service=${got}`);
  }

  const executionBlockedByMismatch = reasons.length > 0;
  writeGateArtifact(logDir, {
    ok: !executionBlockedByMismatch,
    execution_blocked_by_mismatch: executionBlockedByMismatch,
    reasons,
    config_model_version: want || null,
    service_health: health,
    timestamp: new Date().toISOString(),
  });

  if (executionBlockedByMismatch) {
    console.warn(
      `[ML] startup_ml_execution_gate: broker execution DISABLED (${reasons.join('; ')})`,
    );
  }

  return { executionBlockedByMismatch, reasons, health };
}

function writeGateArtifact(logDir: string, body: unknown): void {
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'startup_ml_execution_gate.json'), JSON.stringify(body, null, 2), 'utf8');
  } catch (e) {
    console.error('[ML] Failed to write startup_ml_execution_gate.json', e);
  }
}
