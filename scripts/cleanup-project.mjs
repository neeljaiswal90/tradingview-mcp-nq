#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const args = new Set(process.argv.slice(2));

const dryRun = args.has('--dry-run');
const deep = args.has('--deep');

const directTargets = [
  '.pytest_cache',
  'dist',
  'dashboard/dist',
  'logs',
  'screenshots',
  'tmp',
  'catboost_info',
  'bookmap-addon/build',
  'bookmap-addon/build-check',
  'dashboard/tsconfig.tsbuildinfo',
];

if (deep) {
  directTargets.push('node_modules', 'dashboard/node_modules');
}

const removed = [];
const directTargetSet = new Set(directTargets.map((entry) => entry.replace(/\\/g, '/')));
const noRecurseDirs = new Set([
  '.git',
  'node_modules',
  'dashboard/node_modules',
  '.pytest_cache',
  'dist',
  'dashboard/dist',
  'logs',
  'screenshots',
  'tmp',
  'catboost_info',
  'bookmap-addon/build',
  'bookmap-addon/build-check',
]);

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeRelativePath(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!(await pathExists(absolutePath))) {
    return;
  }

  if (dryRun) {
    removed.push({ relativePath, mode: 'dry-run' });
    return;
  }

  await fs.rm(absolutePath, { recursive: true, force: true });
  removed.push({ relativePath, mode: 'removed' });
}

async function walk(relativeDir) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  if (!(await pathExists(absoluteDir))) {
    return [];
  }

  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    results.push(relativePath);
    if (entry.isDirectory()) {
      const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (entry.name === '__pycache__' || entry.name === '.pytest_cache' || noRecurseDirs.has(normalized)) {
        continue;
      }
      results.push(...(await walk(relativePath)));
    }
  }

  return results;
}

function isGeneratedReport(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized.startsWith('reports/')) return false;

  return (
    normalized.endsWith('.csv') ||
    normalized.endsWith('.json') ||
    normalized.endsWith('.log') ||
    normalized.endsWith('/.sweep_done') ||
    normalized.endsWith('/.sweep_v2_done')
  );
}

function isDynamicCleanupTarget(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const baseName = path.basename(normalized);

  return (
    baseName.endsWith('.pyc') ||
    baseName.endsWith('.pyo') ||
    baseName.endsWith('.tsbuildinfo') ||
    /^debug-.*\.log$/i.test(baseName) ||
    normalized.endsWith('/__pycache__') ||
    normalized.endsWith('/.pytest_cache') ||
    isGeneratedReport(normalized)
  );
}

async function removeDynamicTargets() {
  const allPaths = await walk('.');
  const dynamicTargets = new Set();

  for (const relativePath of allPaths) {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (directTargetSet.has(normalized)) {
      continue;
    }

    if (isDynamicCleanupTarget(normalized)) {
      dynamicTargets.add(normalized);
    }
  }

  const reportsDir = path.join(repoRoot, 'reports');
  if (await pathExists(reportsDir)) {
    const reportEntries = await fs.readdir(reportsDir, { withFileTypes: true });
    for (const entry of reportEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'sensitivity' || entry.name === 'test_lib_check' || entry.name.startsWith('today_')) {
        dynamicTargets.add(path.posix.join('reports', entry.name));
      }
    }
  }

  for (const relativePath of [...dynamicTargets].sort()) {
    await removeRelativePath(relativePath);
  }
}

async function main() {
  console.log(`[cleanup] Repo root: ${repoRoot}`);
  console.log(`[cleanup] Mode: ${deep ? 'deep' : 'runtime'}${dryRun ? ' (dry-run)' : ''}`);

  for (const relativePath of directTargets) {
    await removeRelativePath(relativePath);
  }

  await removeDynamicTargets();

  if (removed.length === 0) {
    console.log('[cleanup] Nothing to remove.');
    return;
  }

  for (const entry of removed) {
    const verb = entry.mode === 'dry-run' ? 'would remove' : 'removed';
    console.log(`[cleanup] ${verb}: ${entry.relativePath}`);
  }

  console.log(`[cleanup] ${dryRun ? 'Matched' : 'Removed'} ${removed.length} target(s).`);
}

main().catch((error) => {
  console.error(`[cleanup] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
