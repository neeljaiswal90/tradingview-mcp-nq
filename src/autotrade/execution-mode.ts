import type { IndicatorConfig, ExecutionMode } from './types.js';

export type ResolvedExecutionMode = 'shadow' | 'paper' | 'live';

export function normalizeExecutionMode(
  config: Pick<IndicatorConfig, 'execution_mode'>,
): ResolvedExecutionMode {
  return config.execution_mode ?? 'paper';
}

export function shouldRequireStrictSymbolArtifacts(
  envMode: ExecutionMode,
  executionMode: ResolvedExecutionMode,
): boolean {
  return executionMode !== 'shadow' && (envMode === 'paper' || envMode === 'live');
}

export function shouldAllowExecutionSideEffects(
  executionMode: ResolvedExecutionMode,
): boolean {
  return executionMode !== 'shadow';
}
