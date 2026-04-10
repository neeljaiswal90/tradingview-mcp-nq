# Cleanup Audit - 2026-04-08

## Summary

This cleanup focused on repository hygiene, launcher consolidation, runtime bloat removal, and documentation clarity without changing core trading behavior.

The repo now has one clear default run flow:

1. `npm run bootstrap`
2. `npm run build`
3. `npm run dashboard:build`
4. `npm run start:full`

Stop with `npm run stop:full`.

TradingView helper launchers remain available, but they are now documented as optional utilities instead of part of the default run flow.

## What Was Found

- The largest bloat was generated output, not source code. Before cleanup, `logs/` was about 699 MB and `debug-239244.log` was about 357 MB.
- The repo had multiple competing app launchers: legacy root `.bat` files, script-level `.bat` wrappers, and the canonical PowerShell launchers.
- The repo root had accumulated audit and report markdown that belonged under `docs/`.
- `hard_risk_fallback_interval_ms` was declared in config/types but not read by runtime code.
- `hard_risk_quote_timeout_bbo_ms` is active and is still used by `src/autotrade/runner.ts`.
- The ML service source lived alongside local-only `data/` and `models/` areas without clear in-tree markers explaining which parts were source, local-only, or generated.

## Actual Entrypoints

- Full app run flow: `scripts/start-full-stack.ps1`
- Lightweight app run flow: `scripts/launch-app.ps1`
- Stop flow: `scripts/stop-full-stack.ps1`
- MCP server: `src/server.ts`
- CLI: `src/cli/index.ts`
- Market-data sidecar: `python-market-data-service/app.py`
- ML sidecar: `python-ml-service/app.py`

## Deleted

### Legacy and Duplicate Launchers

- `launch-paper.bat`
- `launch-signal.bat`
- `launch-live.bat`
- `scripts/launch-app.bat`
- `scripts/start-full-stack.bat`
- `scripts/stop-full-stack.bat`

### Generated and Runtime Clutter

Removed by `npm run clean:deep` on April 8, 2026:

- `.pytest_cache/`
- `dist/`
- `dashboard/dist/`
- `logs/`
- `screenshots/`
- `tmp/`
- `catboost_info/`
- `bookmap-addon/build/`
- `bookmap-addon/build-check/`
- `dashboard/tsconfig.tsbuildinfo`
- `node_modules/`
- `dashboard/node_modules/`
- `debug-239244.log`
- Python `__pycache__/` and `.pytest_cache/` folders
- Generated report artifacts under `reports/`

## Moved

- `SETUP_GUIDE.md` -> `docs/SETUP_GUIDE.md`
- `create-shortcuts.ps1` -> `scripts/create-shortcuts.ps1`
- `.mcp.json` -> `.mcp.json.example`
- Root audit markdown -> `docs/audits/`
- Narrative report markdown from `reports/` and `reports/ml/` -> `docs/audits/reports/`
- `reports/sensitivity/SWEEP_REPORT.md` -> `docs/audits/reports/sensitivity/SWEEP_REPORT.md`

## Kept Intentionally

- `python-ml-service/`
- `python-market-data-service/`
- `data/`
- `models/`
- `.claude/`
- `.cursor/`
- `agents/`
- `skills/`
- `scripts/launch_tv_debug.bat`
- `scripts/launch_tv_debug_mac.sh`
- `scripts/launch_tv_debug_linux.sh`
- `scripts/launch_tv_store.ps1`
- `bookmap-addon/src/` and Bookmap build helper scripts

These were preserved because they are active source, local working assets, or distinct utilities rather than stale launch duplication.

## Follow-up Normalization

- Added a shareable ZIP helper at `scripts/create-shareable-zip.ps1`
- Added a package script: `npm run zip:shareable`
- The shareable ZIP excludes `.env`, `.mcp.json`, `node_modules/`, `dashboard/node_modules/`, local `data/`, local `models/`, generated `reports/`, and `.git` by default
- Added directory marker files to clarify:
  - `python-ml-service/` is source
  - `data/` is local-only
  - `models/` is local-only
  - `reports/` is generated output only
- Removed the empty stale `python-ml-service/models/` directory, which had no references and was not used by the service

## Dead Surface Removed

- Removed unused helpers from `src/autotrade/env.ts`
- Removed unused type imports from `src/autotrade/dashboard/types.ts`
- Removed the duplicate config-change log line from `src/autotrade/indicator-config-manager.ts`
- Removed `hard_risk_fallback_interval_ms` from:
  - `config/indicator-config.json`
  - `src/autotrade/types.ts`

`hard_risk_quote_timeout_bbo_ms` was kept because it is read by the v2 hard-risk lane in `src/autotrade/runner.ts`.

## Validation

Executed after the cleanup:

- `npm run clean:deep`
- `npm run bootstrap`
- `npm run typecheck`
- `npm run test:unit`
- `npm run dashboard:build`
- `python -m compileall python-market-data-service python-ml-service`
- `npm run shortcuts`
- `npm run zip:shareable`

Results:

- TypeScript typecheck passed
- Unit tests passed: 48 files, 995 tests
- Dashboard production build passed
- Python compile pass completed for both sidecars
- Desktop shortcuts were recreated successfully using the canonical PowerShell launchers
- The shareable ZIP helper executed successfully and produced a clean archive without secrets, dependency folders, or local ML assets
- No remaining references were found to removed launchers or the removed `hard_risk_fallback_interval_ms` field
- `npm run clean:runtime` was run again after validation so generated build output and Python caches were not left behind

## Remaining Ambiguity and Tech Debt

- `python-ml-service/` is still an active source area that is not yet tracked in git.
- `data/` and `models/` remain local-only working assets; this cleanup clarified that boundary but did not attempt to convert them into committed source.
- `reports/` remains as a generated-output area and should continue to stay out of the root workflow.
- The working tree still contains unrelated pre-existing source changes outside this cleanup scope; they were intentionally preserved.
