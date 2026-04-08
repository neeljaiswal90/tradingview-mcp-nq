/**
 * ml-entry/index.ts — Public API for ML entry confirmation.
 */

export { buildEntryFeatures } from './feature-builder.js';
export { getEntryMlDecision } from './decision-engine.js';
export type {
  EntryMlConfig,
  EntryMlMode,
  EntryFeatureVector,
  EntryMlResponse,
  EntryMlDecision,
} from './types.js';
export { DEFAULT_ENTRY_ML_CONFIG } from './types.js';
