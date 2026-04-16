export { computeFailureExitState } from './state.js';
export type { FailureExitState } from './state.js';

export { loadCurves, queryCurve } from './curves.js';
export type {
  FailureExitBucket,
  FailureExitCurves,
  FailureExitCurvesFile,
} from './curves.js';

export { evaluateFailureExit } from './evaluator.js';
export type {
  FailureExitLane,
  FailureExitLaneTrigger,
  FailureExitDecision,
} from './evaluator.js';
