#Requires -Version 5.1
<#
.SYNOPSIS
    Launch the NQ Trading App (backend + dashboard) in one click.

.DESCRIPTION
    Starts the autonomous NQ/MNQ trading engine, which also serves the
    operator dashboard at http://localhost:3900.

    Assumes TradingView Desktop is already running with the CDP debug port
    enabled (port 9222). The engine will warn and retry if TradingView is
    not reachable, but this launcher does not block on that condition.

    Duplicate-launch protection: if port 3900 is already in use the script
    opens the browser to the existing instance and exits without starting a
    second backend process.

.PARAMETER Mode
    Execution mode: paper | signal_only
    Default: paper (simulated fills, no real orders).

.PARAMETER NoBrowser
    Suppress automatic browser launch.

.PARAMETER DashboardPort
    Dashboard HTTP port. Default: 3900. Override with DASHBOARD_PORT env var
    or this parameter.

.EXAMPLE
    .\scripts\launch-app.ps1
    .\scripts\launch-app.ps1 -Mode signal_only
    .\scripts\launch-app.ps1 -NoBrowser
#>

[CmdletBinding()]
param(
    [ValidateSet('paper', 'signal_only')]
    [string]$Mode = 'paper',

    [switch]$NoBrowser,

    [int]$DashboardPort = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Resolve absolute paths --------------------------------------------------
$ScriptDir = $PSScriptRoot                      # ...\tradingview-mcp-nq\scripts
$RepoRoot  = Split-Path $ScriptDir -Parent      # ...\tradingview-mcp-nq

# Dashboard port: param > env var > default 3900
if ($DashboardPort -eq 0) {
    if ($env:DASHBOARD_PORT) {
        $DashboardPort = [int]$env:DASHBOARD_PORT
    } else {
        $DashboardPort = 3900
    }
}

$DashboardUrl  = "http://localhost:$DashboardPort"
$SnapshotUrl   = "$DashboardUrl/api/dashboard/snapshot"
$RunnerJsPath  = Join-Path $RepoRoot 'dist\autotrade\runner.js'
$FrontendIndex = Join-Path $RepoRoot 'dashboard\dist\index.html'
$EnvFile       = Join-Path $RepoRoot '.env'
$EnvExample    = Join-Path $RepoRoot '.env.example'

# --- Window title ------------------------------------------------------------
$host.UI.RawUI.WindowTitle = "NQ Trading - $($Mode.ToUpper())"

# --- Banner ------------------------------------------------------------------
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   NQ / MNQ Autonomous Trading Engine  +  Operator Dashboard" -ForegroundColor Cyan
Write-Host "   Mode: $($Mode.ToUpper())" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""

# --- Helpers -----------------------------------------------------------------
function Write-Step { param($msg) Write-Host "  [>>] $msg" -ForegroundColor White }
function Write-OK   { param($msg) Write-Host "  [ OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red }

function Test-PortOpen {
    param([int]$Port)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $ar  = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok  = $ar.AsyncWaitHandle.WaitOne(300, $false)
        $tcp.Close()
        return $ok
    } catch {
        return $false
    }
}

# --- Prereq: Node.js ---------------------------------------------------------
Write-Step "Checking Node.js..."
try {
    $nodeVer = & node --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "non-zero exit" }
    Write-OK "Node.js $nodeVer"
} catch {
    Write-Fail "Node.js not found on PATH."
    Write-Host "         Install Node.js 18+ from https://nodejs.org and re-run." -ForegroundColor Red
    Write-Host ""
    pause
    exit 1
}

# --- Prereq: compiled backend ------------------------------------------------
Write-Step "Checking backend build artifact..."
if (-not (Test-Path $RunnerJsPath)) {
    Write-Fail "dist\autotrade\runner.js not found."
    Write-Host "         Run the following from the repo root, then try again:" -ForegroundColor Red
    Write-Host ""
    Write-Host "           cd `"$RepoRoot`"" -ForegroundColor Yellow
    Write-Host "           npm run build" -ForegroundColor Yellow
    Write-Host ""
    pause
    exit 1
}
Write-OK "Backend artifact found."

# --- Prereq: built dashboard frontend ----------------------------------------
Write-Step "Checking dashboard frontend build..."
if (-not (Test-Path $FrontendIndex)) {
    Write-Warn "dashboard\dist\index.html not found - dashboard UI will not be served."
    Write-Host "         To build the frontend, run from the repo root:" -ForegroundColor Yellow
    Write-Host "           npm run dashboard:build" -ForegroundColor Yellow
    Write-Host "         Continuing without pre-built frontend..." -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-OK "Dashboard frontend found."
}

# --- Prereq: .env file -------------------------------------------------------
if (-not (Test-Path $EnvFile)) {
    if (Test-Path $EnvExample) {
        Copy-Item $EnvExample $EnvFile
        Write-Warn ".env created from .env.example - edit it to set ANTHROPIC_API_KEY etc."
    } else {
        Write-Warn ".env not found and no .env.example to copy. Defaults will be used."
    }
} else {
    Write-OK ".env found."
}

# --- TradingView CDP check (soft - does not block) ---------------------------
Write-Step "Checking TradingView CDP on port 9222..."
if (Test-PortOpen -Port 9222) {
    Write-OK "TradingView CDP detected at port 9222."
} else {
    Write-Warn "TradingView CDP not detected on port 9222."
    Write-Host "         TradingView is assumed to already be running." -ForegroundColor Yellow
    Write-Host "         If the engine fails to connect, start TradingView with:" -ForegroundColor Yellow
    Write-Host "           scripts\launch_tv_debug.bat" -ForegroundColor Yellow
    Write-Host ""
}

# --- Duplicate-launch protection ---------------------------------------------
Write-Step "Checking if backend is already running on port $DashboardPort..."
if (Test-PortOpen -Port $DashboardPort) {
    Write-Warn "Port $DashboardPort is already in use - backend appears to be running."
    Write-Host "         Opening dashboard in browser and exiting launcher." -ForegroundColor Yellow
    Write-Host ""
    if (-not $NoBrowser) {
        Start-Process $DashboardUrl
    }
    Write-Host "  Dashboard: $DashboardUrl" -ForegroundColor Cyan
    Write-Host ""
    Start-Sleep 2
    exit 0
}
Write-OK "Port $DashboardPort is free - starting fresh instance."

# --- Schedule browser open (fires after backend warms up) --------------------
if (-not $NoBrowser) {
    Write-Step "Browser will open at $DashboardUrl once the backend is ready..."
    $browserJob = Start-Job -ScriptBlock {
        param($url, $snapshotUrl)
        # Poll until the dashboard responds (max 30 seconds)
        $deadline = (Get-Date).AddSeconds(30)
        $ready    = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep 2
            try {
                $r = Invoke-WebRequest -Uri $snapshotUrl -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
                if ($r.StatusCode -eq 200) { $ready = $true; break }
            } catch { }
        }
        Start-Process $url
    } -ArgumentList $DashboardUrl, $SnapshotUrl
}

# --- Launch backend (blocks until Ctrl+C / process exit) ---------------------
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   Starting engine...  Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "   Dashboard will open at: $DashboardUrl" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $RepoRoot

$env:MODE                 = $Mode
$env:LIVE_TRADING_ENABLED = 'false'
$env:DASHBOARD_PORT       = $DashboardPort.ToString()

try {
    & node "$RunnerJsPath"
} finally {
    if (-not $NoBrowser) {
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
}

# --- Exit --------------------------------------------------------------------
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "  Engine exited." -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""
pause
