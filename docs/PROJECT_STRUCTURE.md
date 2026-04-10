# Project Structure

## Canonical Tree

```text
/
  src/                         TypeScript backend, MCP server, CLI, and trading engine
  dashboard/                   React operator dashboard
  scripts/                     Canonical launchers, cleanup tooling, and utility scripts
  docs/                        Setup, structure, ML docs, and archived audits
    audits/                    Historical audits and archived narrative reports
  config/                      Canonical runtime and strategy configuration
  tests/                       TypeScript test suite
  bookmap-addon/               Java addon source and build helpers
  python-market-data-service/  Bookmap/Rithmic market-data sidecar
  python-ml-service/           Python ML inference service source code
  data/                        Local-only datasets and schema exports
  models/                      Local-only trained model artifacts
  reports/                     Generated analysis output; not source
  logs/                        Runtime output; not source
```

## What Belongs Where

- `src/` holds the production TypeScript code for the MCP server, CLI, and trading engine.
- `dashboard/src/` holds the React frontend source. Only generated frontend output should land in `dashboard/dist/`.
- `scripts/` holds operational entrypoints. The canonical app scripts are `scripts/launch-app.ps1`, `scripts/start-full-stack.ps1`, and `scripts/stop-full-stack.ps1`.
- `docs/` holds durable human documentation. Put audits and investigation writeups under `docs/audits/`, not the repo root.
- `config/` holds user-editable runtime configuration such as `config/indicator-config.json`.
- `python-ml-service/` is source code and belongs in the repo.
- `data/` and `models/` are local-only working assets. Keep their shape documented, but do not treat their contents as committed source.
- `reports/` and `logs/` are generated output only.

## What Should Not Be Committed

- `node_modules/`, `dashboard/node_modules/`
- `dist/`, `dashboard/dist/`
- `logs/`, `screenshots/`, `tmp/`
- `.mcp.json`, `.env`
- `.claude/`, `.cursor/`
- `data/` contents other than the directory marker files
- `models/` contents other than the directory marker files
- Python cache folders and `.pytest_cache/`
- Bookmap build output under `bookmap-addon/build/` and `bookmap-addon/build-check/`
- Generated output under `reports/`

## How To Run

Default full-stack run flow:

```powershell
npm run bootstrap
npm run build
npm run dashboard:build
npm run start:full
```

The default flow assumes TradingView is already available on CDP port `9222`.

Stop:

```powershell
npm run stop:full
```

## Optional Utilities

TradingView helpers:

- `scripts\launch_tv_debug.bat`
- `powershell -ExecutionPolicy Bypass -File scripts\launch_tv_store.ps1 -Port 9222`
- `bash scripts/launch_tv_debug_mac.sh`
- `bash scripts/launch_tv_debug_linux.sh`

Lightweight engine-plus-dashboard flow:

```powershell
powershell -NoLogo -ExecutionPolicy Bypass -File scripts\launch-app.ps1
```

Shareable ZIP:

```powershell
npm run zip:shareable
```

That ZIP excludes `.env`, `.mcp.json`, dependency folders, local `data/`, local `models/`, generated `reports/`, and `.git` by default.

## How To Clean

```powershell
npm run clean:runtime
npm run clean:deep
```

- `clean:runtime` removes generated runtime output and build clutter
- `clean:deep` also removes dependency directories
