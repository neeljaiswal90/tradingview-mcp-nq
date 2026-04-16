import type { IndicatorConfig } from './types.js';
import type { MlManagementConfig } from './ml/types.js';
import { DEFAULT_ML_CONFIG } from './ml/types.js';

export type MlPolicyMode = 'rules_only' | 'ml_shadow' | 'ml_canary_execute' | 'ml_primary_execute';

/** Optional explicit policy (Track B). When absent, derived from `ml_management` legacy fields. */
export interface MlPolicyConfig {
  mode?: MlPolicyMode;
  inference_enabled?: boolean;
  execution_enabled?: boolean;
  allow_actions?: string[];
  canary_percent?: number;
  model_pointer?: string;
  fallback_policy?: string;
  readiness_max_age_hours?: number;
  promotion_max_lag_without_waiver_hours?: number;
}

export interface ResolvedMlPolicy {
  mode: MlPolicyMode;
  inference_enabled: boolean;
  execution_enabled: boolean;
  allow_actions: readonly string[];
  canary_percent: number;
  model_pointer: string;
  fallback_policy: string;
  readiness_max_age_hours: number;
  promotion_max_lag_without_waiver_hours: number;
}

const DEFAULT_ALLOW: readonly string[] = ['EXIT_ALL', 'MOVE_STOP', 'MOVE_TO_BREAKEVEN'];

export function resolveMlPolicy(
  cfg: IndicatorConfig,
  _executionMode: 'shadow' | 'paper' | 'live',
): ResolvedMlPolicy {
  const ml = cfg.ml_management ?? DEFAULT_ML_CONFIG;
  const base = {
    allow_actions: DEFAULT_ALLOW as string[],
    canary_percent: 0,
    model_pointer: 'promoted',
    fallback_policy: 'rules_only',
    readiness_max_age_hours: 24,
    promotion_max_lag_without_waiver_hours: 168,
  };

  if (cfg.ml_policy == null) {
    if (!ml.enabled) {
      return {
        mode: 'rules_only',
        inference_enabled: false,
        execution_enabled: false,
        ...base,
      };
    }
    if (ml.broker_execution_enabled === false) {
      return {
        mode: 'ml_shadow',
        inference_enabled: true,
        execution_enabled: false,
        ...base,
      };
    }
    return {
      mode: 'ml_primary_execute',
      inference_enabled: true,
      execution_enabled: true,
      ...base,
    };
  }

  const raw = cfg.ml_policy;
  const mode = raw.mode ?? 'ml_shadow';
  let inference_enabled = raw.inference_enabled ?? ml.enabled;
  let execution_enabled =
    raw.execution_enabled ?? (inference_enabled && ml.broker_execution_enabled !== false);

  switch (mode) {
    case 'rules_only':
      inference_enabled = raw.inference_enabled ?? false;
      execution_enabled = raw.execution_enabled ?? false;
      break;
    case 'ml_shadow':
      inference_enabled = raw.inference_enabled ?? ml.enabled;
      execution_enabled = raw.execution_enabled ?? false;
      break;
    case 'ml_canary_execute':
    case 'ml_primary_execute':
      inference_enabled = raw.inference_enabled ?? ml.enabled;
      execution_enabled = raw.execution_enabled ?? true;
      break;
    default:
      break;
  }

  return {
    mode,
    inference_enabled,
    execution_enabled,
    allow_actions: raw.allow_actions?.length ? raw.allow_actions : base.allow_actions,
    canary_percent: typeof raw.canary_percent === 'number' ? raw.canary_percent : base.canary_percent,
    model_pointer: raw.model_pointer ?? base.model_pointer,
    fallback_policy: raw.fallback_policy ?? base.fallback_policy,
    readiness_max_age_hours: raw.readiness_max_age_hours ?? base.readiness_max_age_hours,
    promotion_max_lag_without_waiver_hours:
      raw.promotion_max_lag_without_waiver_hours ?? base.promotion_max_lag_without_waiver_hours,
  };
}
