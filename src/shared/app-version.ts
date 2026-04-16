/**
 * app-version.ts — single canonical source for app-wide version metadata.
 *
 * Four version classes for the whole project:
 *   1. app       — this file (APP_VERSION + APP_BUILD_SHA + APP_BUILD_DATE)
 *   2. config    — hash of config/indicator-config.json (computed at load)
 *   3. schema    — FEATURE_SCHEMA_VERSION / ENTRY_FEATURE_SCHEMA_VERSION
 *                  (Python-owned, they encode feature contracts)
 *   4. model     — promoted pointers under models/*\/promoted.json
 *
 * APP_BUILD_DATE is injected at build/release time by scripts/stamp-build.mjs
 * (which writes build-info.json at the repo root). APP_START_TIME is
 * captured at module load time and is explicitly NOT the build date.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

// ── Resolve repo root relative to this file ────────────────────────────────
// src compiles to dist, so at runtime the module lives in dist/shared/.
// Both src/shared/app-version.ts and dist/shared/app-version.js resolve
// repoRoot the same way: two levels up.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');

// ── package.json (APP_VERSION source) ──────────────────────────────────────

function readPackageVersion(): string {
  try {
    const pkgPath = join(repoRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Generated build info (written by scripts/stamp-build.mjs) ──────────────

interface GeneratedBuildInfo {
  app_build_date?: string;
  app_build_sha?: string;
}

function readGeneratedBuildInfo(): GeneratedBuildInfo | null {
  try {
    const p = join(repoRoot, 'build-info.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as GeneratedBuildInfo;
  } catch {
    return null;
  }
}

// ── Synchronous fallbacks when generated file is absent ────────────────────

function tryGitShaSync(): string {
  if (process.env.APP_BUILD_SHA) return process.env.APP_BUILD_SHA;
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      cwd: repoRoot,
    }).trim();
  } catch {
    return 'unknown';
  }
}

function envBuildDate(): string {
  return process.env.APP_BUILD_DATE || 'unknown';
}

// ── Resolve build_date and build_sha once at module load ───────────────────

const _generated = readGeneratedBuildInfo();

export const APP_VERSION: string = readPackageVersion();
export const APP_START_TIME: string = new Date().toISOString();
export const APP_BUILD_DATE: string = _generated?.app_build_date || envBuildDate();
export const APP_BUILD_SHA: string = _generated?.app_build_sha || tryGitShaSync();

// ── Config hash ────────────────────────────────────────────────────────────

/**
 * SHA256 hash of config/indicator-config.json. Short-form (first 12 hex)
 * is used as the config_version identifier. 'unknown' if unreadable.
 */
export function computeConfigHash(): { full: string; short: string } {
  try {
    const p = join(repoRoot, 'config', 'indicator-config.json');
    const raw = readFileSync(p, 'utf8');
    const full = createHash('sha256').update(raw).digest('hex');
    return { full, short: full.slice(0, 12) };
  } catch {
    return { full: 'unknown', short: 'unknown' };
  }
}

// ── Release stamp block ────────────────────────────────────────────────────

export interface ReleaseStamp {
  app_version: string;
  build_sha: string;
  build_date: string;
  start_time: string;
  config_hash: string;
  config_hash_short: string;
}

export function getReleaseStamp(): ReleaseStamp {
  const cfg = computeConfigHash();
  return {
    app_version: APP_VERSION,
    build_sha: APP_BUILD_SHA,
    build_date: APP_BUILD_DATE,
    start_time: APP_START_TIME,
    config_hash: cfg.full,
    config_hash_short: cfg.short,
  };
}

/**
 * Write reports/release/current_release.json with the full release context,
 * including model promoted pointers and feature schema versions. This is
 * the canonical release artifact the calibration report binds to.
 */
export function writeCurrentReleaseReport(extra: {
  management_model?: unknown;
  entry_model?: unknown;
  feature_schema?: unknown;
}): string | null {
  try {
    const outDir = join(repoRoot, 'reports', 'release');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'current_release.json');
    const body = {
      ...getReleaseStamp(),
      management_model: extra.management_model ?? null,
      entry_model: extra.entry_model ?? null,
      feature_schema: extra.feature_schema ?? null,
      written_at: new Date().toISOString(),
    };
    writeFileSync(outPath, JSON.stringify(body, null, 2) + '\n', 'utf8');
    return outPath;
  } catch (err) {
    console.error('[app-version] failed to write current_release.json:', err);
    return null;
  }
}
