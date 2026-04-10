# Setup Guide

## Prerequisites

1. Node.js 18 or newer
2. TradingView Desktop
3. Python 3.12+ if you plan to use the full stack launcher
4. Bookmap/Rithmic only if you plan to use the Bookmap market-data sidecar

## 1. Default Run Flow

```powershell
npm run bootstrap
npm run build
npm run dashboard:build
npm run start:full
```

That starts:

1. `python-market-data-service/app.py` on port `5010`
2. `python-ml-service/app.py` on port `5001`
3. the Node trading engine and dashboard on port `3900`

The default flow assumes TradingView Desktop is already running with CDP enabled on port `9222`. If it is not, use one of the helper launchers in the optional utilities section below.

Stop it with:

```powershell
npm run stop:full
```

## 2. Optional Utilities

### TradingView Helpers

TradingView Desktop must be running with the remote debugging port enabled.

Windows desktop install:

```powershell
scripts\launch_tv_debug.bat
```

Windows Store / MSIX install:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\launch_tv_store.ps1 -Port 9222
```

macOS:

```bash
bash scripts/launch_tv_debug_mac.sh
```

Linux:

```bash
bash scripts/launch_tv_debug_linux.sh
```

### Lightweight Launchers

Lightweight launch when you only want the engine and dashboard:

```powershell
powershell -NoLogo -ExecutionPolicy Bypass -File scripts\launch-app.ps1
```

Signal-only lightweight launch:

```powershell
powershell -NoLogo -ExecutionPolicy Bypass -File scripts\launch-app.ps1 -Mode signal_only
```

Desktop shortcuts for the canonical launchers:

```powershell
npm run shortcuts
```

Clean shareable ZIP without secrets, dependency folders, or runtime clutter:

```powershell
npm run zip:shareable
```

The ZIP excludes `.env`, `.mcp.json`, `node_modules/`, `dashboard/node_modules/`, local `data/`, local `models/`, generated `reports/`, and `.git` by default. Pass `-IncludeGit` or `-IncludeLocalAssets` directly to `scripts/create-shareable-zip.ps1` only when you intentionally want those included.

## 3. Configure MCP

Start from `.mcp.json.example` and replace the placeholder path with your local absolute path to `dist/server.js`.

Example:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["C:/path/to/tradingview-mcp-nq/dist/server.js"]
    }
  }
}
```

## 4. Verify

MCP/CLI verification:

```powershell
npx tv status
```

Full-stack verification:

- dashboard responds at `http://localhost:3900`
- market-data sidecar responds at `http://127.0.0.1:5010/lob/health`
- ML service responds at `http://127.0.0.1:5001/health`

## 5. Cleanup

```powershell
npm run clean:runtime
npm run clean:deep
```

- `clean:runtime` removes generated runtime clutter while preserving source and local working assets such as `data/`, `models/`, and `python-ml-service/`
- `clean:deep` also removes both `node_modules` directories
