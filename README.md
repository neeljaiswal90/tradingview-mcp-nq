# TradingView MCP + NQ Trading Stack

This repository combines three things in one workspace:

- a TradingView MCP server and CLI
- an autonomous NQ/MNQ trading engine with an operator dashboard
- local Python sidecars for market data and ML-assisted management

## Quick Start

```powershell
npm run bootstrap
npm run build
npm run dashboard:build
npm run start:full
```

Use `npm run stop:full` to stop the local stack. If TradingView is not already running with CDP enabled on port `9222`, use the optional helper launchers below first.

The canonical launch scripts are:

- `scripts/launch-app.ps1`
- `scripts/start-full-stack.ps1`
- `scripts/stop-full-stack.ps1`

`npm run start:full` is the default, single obvious way to run the app. Use `scripts/launch-app.ps1` only when you explicitly want the lightweight engine-plus-dashboard flow without auto-starting the Python sidecars.

## Optional Utilities

TradingView helpers:

- Windows desktop install: `scripts\launch_tv_debug.bat`
- Windows Store / MSIX install: `powershell -ExecutionPolicy Bypass -File scripts\launch_tv_store.ps1 -Port 9222`
- macOS: `bash scripts/launch_tv_debug_mac.sh`
- Linux: `bash scripts/launch_tv_debug_linux.sh`

Other utilities:

- Lightweight app launch: `powershell -NoLogo -ExecutionPolicy Bypass -File scripts\launch-app.ps1`
- Recreate desktop shortcuts: `npm run shortcuts`
- Create a clean shareable ZIP: `npm run zip:shareable`

The shareable ZIP excludes `.env`, `.mcp.json`, `node_modules/`, `dashboard/node_modules/`, local `data/`, local `models/`, runtime/build clutter, generated `reports/`, and `.git` by default.

## MCP and CLI

Build the TypeScript server first:

```powershell
npm run build
node dist/server.js
```

CLI examples:

```powershell
npx tv status
npx tv symbol AAPL
npx tv pine get
```

Start from `.mcp.json.example` when wiring the MCP server into Claude Desktop, Cursor, or another MCP client.

## Repo Guides

- `docs/SETUP_GUIDE.md` - setup, launch, MCP configuration, and verification
- `docs/PROJECT_STRUCTURE.md` - canonical folder layout and commit rules
- `docs/ML_MANAGEMENT_GUIDE.md` - ML sidecar and dataset/model workflow
- `docs/audits/` - archived audits, implementation reviews, and cleanup reports

## Cleanup and Maintenance

```powershell
npm run clean:runtime
npm run clean:deep
npm run shortcuts
npm run zip:shareable
```

- `clean:runtime` removes generated runtime clutter such as logs, screenshots, caches, report artifacts, and build output
- `clean:deep` also removes `node_modules` and `dashboard/node_modules`
- `shortcuts` recreates desktop shortcuts for the canonical PowerShell launchers
- `zip:shareable` creates a clean ZIP snapshot without secrets, dependency folders, or generated clutter

Runtime output belongs in `logs/` and generated analysis output belongs in `reports/`. Neither should be treated as source.
