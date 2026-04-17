import { existsSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';

import type { ContractRoot } from './contracts.js';

export const PAPER_ARTIFACT_BOOTSTRAP_PREFIX =
  'npm run bootstrap:paper-artifacts -- --symbol';

export interface RepoLocalArtifactPath {
  label: string;
  relativePath: string;
  absolutePath: string;
}

function toPortableRelativePath(pathValue: string): string {
  return pathValue.split(sep).join('/');
}

export function getRepoRoot(cwd = process.cwd()): string {
  return resolve(cwd);
}

export function isPathInsideRepoRoot(repoRoot: string, absolutePath: string): boolean {
  const relativePath = relative(repoRoot, absolutePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

export function resolveRepoLocalPath(
  repoRoot: string,
  pathValue: string,
  label: string,
): RepoLocalArtifactPath {
  const absolutePath = resolve(repoRoot, pathValue);
  if (!isPathInsideRepoRoot(repoRoot, absolutePath)) {
    throw new Error(
      `[ARTIFACTS] ${label} must stay inside repo root ${repoRoot}: ${pathValue}`,
    );
  }

  const relativePath = relative(repoRoot, absolutePath);
  return {
    label,
    absolutePath,
    relativePath: relativePath === ''
      ? '.'
      : toPortableRelativePath(relativePath),
  };
}

export function getSymbolExpectancyBucketTablePath(
  repoRoot: string,
  symbol: ContractRoot,
): RepoLocalArtifactPath {
  return resolveRepoLocalPath(
    repoRoot,
    `data/expectancy_bucket_table_${symbol}.json`,
    'expectancy_bucket_table',
  );
}

export function getSymbolFailureExitCurvesPath(
  repoRoot: string,
  symbol: ContractRoot,
): RepoLocalArtifactPath {
  return resolveRepoLocalPath(
    repoRoot,
    `config/failure_exit_curves_${symbol}.json`,
    'failure_exit_curves',
  );
}

export function getRequiredPaperArtifacts(
  repoRoot: string,
  symbol: ContractRoot,
): RepoLocalArtifactPath[] {
  return [
    getSymbolExpectancyBucketTablePath(repoRoot, symbol),
    getSymbolFailureExitCurvesPath(repoRoot, symbol),
  ];
}

export function findMissingPaperArtifacts(
  repoRoot: string,
  symbol: ContractRoot,
): RepoLocalArtifactPath[] {
  return getRequiredPaperArtifacts(repoRoot, symbol)
    .filter(pathSpec => !existsSync(pathSpec.absolutePath));
}

export function resolveExpectancyBucketTablePath(
  repoRoot: string,
  symbol: ContractRoot,
  configuredPath: string,
): { path: RepoLocalArtifactPath; fallbackUsed: boolean } {
  const symbolScopedPath = getSymbolExpectancyBucketTablePath(repoRoot, symbol);
  if (existsSync(symbolScopedPath.absolutePath)) {
    return { path: symbolScopedPath, fallbackUsed: false };
  }
  return {
    path: resolveRepoLocalPath(
      repoRoot,
      configuredPath,
      'expectancy_bucket_table_fallback',
    ),
    fallbackUsed: true,
  };
}

export function resolveFailureExitCurvesPath(
  repoRoot: string,
  symbol: ContractRoot,
  configuredPath = 'config/failure_exit_curves.json',
): { path: RepoLocalArtifactPath; fallbackUsed: boolean } {
  const symbolScopedPath = getSymbolFailureExitCurvesPath(repoRoot, symbol);
  if (existsSync(symbolScopedPath.absolutePath)) {
    return { path: symbolScopedPath, fallbackUsed: false };
  }
  return {
    path: resolveRepoLocalPath(
      repoRoot,
      configuredPath,
      'failure_exit_curves_fallback',
    ),
    fallbackUsed: true,
  };
}

export function formatMissingPaperArtifactsMessage(
  mode: string,
  repoRoot: string,
  symbol: ContractRoot,
  missingArtifacts: RepoLocalArtifactPath[],
): string {
  return (
    `[STARTUP] Refusing to start in ${mode} mode - required symbol-scoped ` +
    `paper artifacts are missing under repo root ${repoRoot}:\n` +
    missingArtifacts.map(pathSpec => `  - ${pathSpec.relativePath}`).join('\n') +
    '\nGeneric fallbacks and cross-worktree borrowing are not allowed for ' +
    `${mode} mode.\nBootstrap the repo-local artifacts first:\n` +
    `  ${PAPER_ARTIFACT_BOOTSTRAP_PREFIX} ${symbol}\n` +
    'Or run in shadow/signal_only mode until the repo-local artifacts are available.'
  );
}
