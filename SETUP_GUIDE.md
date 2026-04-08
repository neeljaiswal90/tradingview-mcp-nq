# TradingView MCP — Setup Guide

## Prerequisites

1. **Node.js 18+** — [Download](https://nodejs.org/)
2. **TradingView Desktop** — [Download](https://www.tradingview.com/desktop/)
3. **An MCP client** — Claude Desktop, Cursor, or any MCP-compatible client

## Step 1: Launch TradingView with CDP

TradingView Desktop must be started with remote debugging enabled.

### Windows

```bat
scripts\launch_tv_debug.bat
```

Or manually (standalone install):

```bat
"%LOCALAPPDATA%\TradingView\TradingView.exe" --remote-debugging-port=9222
```

#### Microsoft Store / MSIX Install

If you installed TradingView from the Microsoft Store, the exe is inside the
protected `WindowsApps` directory and can't be launched directly. The launch
script detects this automatically and uses `IApplicationActivationManager` COM
API to activate the app with the CDP flag. You can also invoke it directly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\launch_tv_store.ps1 -Port 9222
```

### macOS

```bash
bash scripts/launch_tv_debug_mac.sh
```

Or manually:

```bash
/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222
```

### Linux

```bash
bash scripts/launch_tv_debug_linux.sh
```

## Step 2: Build the Server

```bash
cd c:\tradingview-mcp
npm install
npm run build
```

## Step 3: Configure Your MCP Client

Copy `.mcp.json.example` to your client's configuration location:

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["c:/tradingview-mcp/dist/server.js"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["c:/tradingview-mcp/dist/server.js"]
    }
  }
}
```

## Step 4: Verify

Open your MCP client and ask it to run `tv_health_check`. You should see:

```json
{
  "success": true,
  "cdp_connected": true,
  "chart_symbol": "AAPL",
  "chart_resolution": "D"
}
```

## CLI Usage

The `tv` CLI provides direct access to all functionality:

```bash
npx tv status          # Health check
npx tv symbol AAPL     # Change symbol
npx tv timeframe 15    # Change timeframe
npx tv pine get        # Get Pine Script source
npx tv --help          # See all commands
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TV_CDP_HOST` | `127.0.0.1` | CDP host |
| `TV_CDP_PORT` | `9222` | CDP port |
| `TV_LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `TV_MAX_RETRIES` | `5` | Connection retry count |
| `TV_SCREENSHOT_DIR` | `./screenshots` | Screenshot save directory |

## Operator Dashboard

The autonomous trading engine includes a built-in operator dashboard served at
`http://localhost:3900`.  It shows live KPIs, the active trade, market state,
Claude advisory, and a PnL chart.

### One-click Desktop Shortcut (Windows)

Run once to create the shortcuts on your Desktop:

```powershell
powershell -ExecutionPolicy Bypass -File create-shortcuts.ps1
```

This creates two NQ Trading App shortcuts:

| Shortcut | Mode |
|----------|------|
| `NQ Trading App (Paper)` | Paper mode — simulated fills, no real orders |
| `NQ Trading App (Signal)` | Signal-only — logs setups, no execution |

**Double-clicking a shortcut:**
1. Checks Node.js and build artifacts
2. Warns if TradingView CDP is not detected on port 9222 (continues anyway)
3. Skips starting a second instance if port 3900 is already in use
4. Opens the engine in a titled terminal window (`NQ Trading — PAPER`)
5. Opens `http://localhost:3900` in your browser once the backend is ready

### Manual launch (without shortcut)

```powershell
# From repo root
powershell -ExecutionPolicy Bypass -File scripts\launch-app.ps1
# Signal-only mode
powershell -ExecutionPolicy Bypass -File scripts\launch-app.ps1 -Mode signal_only
# Suppress browser auto-open
powershell -ExecutionPolicy Bypass -File scripts\launch-app.ps1 -NoBrowser
```

### Rebuild the frontend

The dashboard UI is a React app built separately from the backend.  Rebuild it
whenever you pull frontend changes:

```bash
npm run dashboard:build
```

The built files land in `dashboard/dist/` and are served by the backend at port 3900.

### Dashboard environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3900` | HTTP port for the dashboard server |

### Recreate the Desktop shortcut

If you move the repo or the shortcut is deleted, re-run:

```powershell
powershell -ExecutionPolicy Bypass -File create-shortcuts.ps1
```

## Troubleshooting

### "No TradingView chart target found"

- Ensure TradingView Desktop is running with `--remote-debugging-port=9222`
- Open a chart in TradingView (not just the launcher)
- Check `http://localhost:9222/json/list` in your browser

### "CDP connection failed after 5 attempts"

- TradingView may still be loading — wait and retry
- Check if another app is using port 9222
- Try `tv_launch` to auto-detect and restart TradingView
