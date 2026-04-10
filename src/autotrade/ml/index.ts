/**
 * ml/index.ts — Public API for ML management integration.
 */

export { buildMlFeatures } from './feature-builder.js';
export { evaluateMlGate } from './execution-gate.js';
export { getMlDecision, checkMlHealth } from './decision-engine.js';
export type {
  MlManagementConfig,
  MlFeatureVector,
  MlServiceResponse,
  MlAction,
  MlGateResult,
  MlGateCheck,
  MlDecision,
  MlDecisionResult,
} from './types.js';
export { DEFAULT_ML_CONFIG } from './types.js';
