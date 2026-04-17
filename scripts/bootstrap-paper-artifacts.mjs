#!/usr/bin/env node

import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

function fail(message) {
  console.error(`[BOOTSTRAP:paper-artifacts] ${message}`);
  process.exit(1);
}

function toPortableRelativePath(pathValue) {
  return pathValue.split(sep).join('/');
}

function isPathInsideRepoRoot(repoRoot, absolutePath) {
  const relativePath = relative(repoRoot, absolutePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function resolveInsideRepoRoot(repoRoot, pathValue, label) {
  const absolutePath = resolve(repoRoot, pathValue);
  if (!isPathInsideRepoRoot(repoRoot, absolutePath)) {
    fail(`${label} must stay inside repo root ${repoRoot}: ${pathValue}`);
  }
  const relativePath = relative(repoRoot, absolutePath);
  return {
    absolutePath,
    relativePath: relativePath === ''
      ? '.'
      : toPortableRelativePath(relativePath),
  };
}

function sha256File(pathValue) {
  return createHash('sha256')
    .update(readFileSync(pathValue))
    .digest('hex')
    .toUpperCase();
}

function parseArgs(argv) {
  let symbol = null;
  let repoRoot = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--symbol') {
      symbol = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--repo-root') {
      repoRoot = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }

  if (!symbol) {
    fail('missing required --symbol argument');
  }

  return {
    symbol: symbol.toUpperCase(),
    repoRoot,
  };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const args = parseArgs(process.argv.slice(2));
const repoRoot = args.repoRoot ? resolve(args.repoRoot) : defaultRepoRoot;
const manifestPath = resolveInsideRepoRoot(
  repoRoot,
  'bootstrap/paper-artifacts/manifest.json',
  'manifest',
);

if (!existsSync(manifestPath.absolutePath)) {
  fail(`manifest not found: ${manifestPath.relativePath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath.absolutePath, 'utf8'));
const symbolEntry = manifest.symbols?.[args.symbol];

if (!symbolEntry) {
  fail(`no paper artifact manifest entry found for symbol ${args.symbol}`);
}

const artifacts = Array.isArray(symbolEntry.artifacts) ? symbolEntry.artifacts : [];
if (artifacts.length === 0) {
  fail(`manifest entry for ${args.symbol} has no artifacts`);
}

for (const artifact of artifacts) {
  if (typeof artifact.source !== 'string' || typeof artifact.target !== 'string') {
    fail(`invalid manifest entry for ${args.symbol}`);
  }

  const source = resolveInsideRepoRoot(
    repoRoot,
    artifact.source,
    `source path for ${artifact.target}`,
  );
  const target = resolveInsideRepoRoot(
    repoRoot,
    artifact.target,
    `target path for ${artifact.source}`,
  );

  if (!existsSync(source.absolutePath)) {
    fail(`source artifact missing: ${source.relativePath}`);
  }

  const sourceHash = sha256File(source.absolutePath);
  const manifestHash = typeof artifact.sha256 === 'string'
    ? artifact.sha256.toUpperCase()
    : null;
  if (manifestHash && sourceHash !== manifestHash) {
    fail(
      `manifest hash mismatch for ${source.relativePath}: expected ${manifestHash}, got ${sourceHash}`,
    );
  }

  mkdirSync(dirname(target.absolutePath), { recursive: true });

  let action = 'copied';
  if (existsSync(target.absolutePath)) {
    const targetHash = sha256File(target.absolutePath);
    if (targetHash === sourceHash) {
      action = 'up-to-date';
    } else {
      copyFileSync(source.absolutePath, target.absolutePath);
      action = 'refreshed';
    }
  } else {
    copyFileSync(source.absolutePath, target.absolutePath);
  }

  const finalHash = sha256File(target.absolutePath);
  if (finalHash !== sourceHash) {
    fail(`post-copy verification failed for ${target.relativePath}`);
  }

  console.log(
    `[BOOTSTRAP:paper-artifacts] ${args.symbol} ${action}: ${target.relativePath} <= ${source.relativePath}`,
  );
}

console.log(`[BOOTSTRAP:paper-artifacts] repo_root=${repoRoot}`);
console.log(
  `[BOOTSTRAP:paper-artifacts] completed symbol=${args.symbol} artifacts=${artifacts.length}`,
);
