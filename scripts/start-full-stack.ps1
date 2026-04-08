#Requires -Version 5.1
<#
.SYNOPSIS
    Launch the full NQ Trading stack with Bookmap/Rithmic integration.

.DESCRIPTION
    Starts all services in the correct order with health-check polling:
      1. Python market-data sidecar     (port 5010)
      2. Python ML inference service    (port 5001)
      3. TradingView CDP check          (port 9222)
      4. Node trading engine            (port 3900)
      5. Browser auto-open to dashboard

    Bookmap must be manually launched and connected to NQM6.CME@RITHMIC
    BEFORE running this script. The script does NOT log into Bookmap or
    Rithmic. Credentials stay inside the Bookmap desktop app.

.PARAMETER Mode
    Execution mode: paper | signal_only.  Default: paper.

.PARAMETER NoBrowser
    Suppress automatic browser launch.

.PARAMETER SkipPython
    Skip starting Python services (useful if they are already running).

.EXAMPLE
    .\scripts\start-full-stack.ps1
    .\scripts\start-full-stack.ps1 -Mode signal_only
    .\scripts\start-full-stack.ps1 -SkipPython
#>

[CmdletBinding()]
param(
    [ValidateSet('paper', 'signal_only')]
    [string]$Mode = 'paper',
    [switch]$NoBrowser,
    [switch]$SkipPython,
    [int]$DashboardPort = 3900
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Paths -------------------------------------------------------------------
$ScriptDir = $PSScriptRoot
$RepoRoot  = Split-Path $ScriptDir -Parent

$RunnerJs         = Join-Path $RepoRoot 'dist\autotrade\runner.js'
$MktDataService   = Join-Path $RepoRoot 'python-market-data-service\app.py'
$MlService        = Join-Path $RepoRoot 'python-ml-service\app.py'
$FrontendIndex    = Join-Path $RepoRoot 'dashboard\dist\index.html'
$DashboardUrl     = "http://localhost:$DashboardPort"
$SnapshotUrl      = "$DashboardUrl/api/dashboard/snapshot"

# Python: find the working Python (where catboost/fastapi are installed)
$PythonPaths = @(
    "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python314\python.exe",
    "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python313\python.exe",
    "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python312\python.exe",
    "python.exe",
    "python3.exe"
)
$Python = $null
foreach ($p in $PythonPaths) {
    if (Test-Path $p -ErrorAction SilentlyContinue) { $Python = $p; break }
    try { $found = Get-Command $p -ErrorAction Stop; $Python = $found.Source; break } catch {}
}

$host.UI.RawUI.WindowTitle = "NQ Full Stack - $($Mode.ToUpper())"

# --- Helpers -----------------------------------------------------------------
function Write-Step  { param($msg) Write-Host "  [>>] $msg" -ForegroundColor White }
function Write-OK    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "  [XX] $msg" -ForegroundColor Red }

function Test-PortOpen {
    param([int]$Port)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $ar  = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok  = $ar.AsyncWaitHandle.WaitOne(500, $false)
        $tcp.Close()
        return $ok
    } catch { return $false }
}

function Wait-ForHealth {
    param([string]$Url, [string]$Name, [int]$TimeoutSec = 20)
    Write-Step "Waiting for $Name at $Url..."
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
            if ($r.StatusCode -eq 200) {
                Write-OK "$Name is healthy."
                return $true
            }
        } catch { }
        Start-Sleep 1
    }
    Write-Err "$Name did not become healthy within ${TimeoutSec}s."
    return $false
}

# --- Banner ------------------------------------------------------------------
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   NQ / MNQ Full-Stack Launch" -ForegroundColor Cyan
Write-Host "   Mode: $($Mode.ToUpper())   Dashboard: $DashboardUrl" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Stack:" -ForegroundColor DarkGray
Write-Host "    1. Market-data sidecar  (Bookmap/Rithmic)  :5010" -ForegroundColor DarkGray
Write-Host "    2. ML inference service (CatBoost)         :5001" -ForegroundColor DarkGray
Write-Host "    3. TradingView CDP                         :9222" -ForegroundColor DarkGray
Write-Host "    4. Trading engine + dashboard              :$DashboardPort" -ForegroundColor DarkGray
Write-Host ""

# --- Bookmap Reminder --------------------------------------------------------
Write-Host "  +----------------------------------------------------------+" -ForegroundColor Magenta
Write-Host "  |  BOOKMAP: Must be running and connected to:              |" -ForegroundColor Magenta
Write-Host "  |           NQM6.CME@RITHMIC                               |" -ForegroundColor Magenta
Write-Host "  |  This script does NOT log into Bookmap or Rithmic.      |" -ForegroundColor Magenta
Write-Host "  +----------------------------------------------------------+" -ForegroundColor Magenta
Write-Host ""

# --- Prereqs -----------------------------------------------------------------
Write-Step "Checking Node.js..."
try {
    $nodeVer = & node --version 2>&1
    Write-OK "Node.js $nodeVer"
} catch {
    Write-Err "Node.js not found. Install Node.js 18+ and retry."
    pause; exit 1
}

Write-Step "Checking backend build..."
if (-not (Test-Path $RunnerJs)) {
    Write-Err "dist\autotrade\runner.js not found. Run: npm run build"
    pause; exit 1
}
Write-OK "Backend build OK."

if (-not $Python) {
    Write-Warn "Python not found. Python services will not be started."
    Write-Host "         The engine will still work using TradingView fallback." -ForegroundColor Yellow
    $SkipPython = $true
} else {
    Write-OK "Python: $Python"
}

# --- Dashboard frontend check ------------------------------------------------
if (-not (Test-Path $FrontendIndex)) {
    Write-Warn "dashboard/dist/index.html not found. Run: npm run dashboard:build"
}

# --- Duplicate-launch check --------------------------------------------------
if (Test-PortOpen -Port $DashboardPort) {
    Write-Warn "Port $DashboardPort in use. Engine already running."
    if (-not $NoBrowser) { Start-Process $DashboardUrl }
    Start-Sleep 2; exit 0
}

# --- Clean stale processes on known ports -------------------------------------
function Clear-StalePort {
    param([int]$Port)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            foreach ($c in $conns) {
                $pid = $c.OwningProcess
                Write-Warn "Killing stale process PID $pid on port $Port..."
                Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                Start-Sleep 1
            }
        }
    } catch { }
}

# --- Start Python services ---------------------------------------------------
$pyJobs = @()

if (-not $SkipPython) {
    # 1. Market-data sidecar
    Write-Step "Starting market-data sidecar on :5010..."
    if (Test-PortOpen -Port 5010) {
        Write-OK "Market-data sidecar already running on :5010."
    } else {
        Clear-StalePort -Port 5010
        $mktJob = Start-Process -FilePath $Python -ArgumentList "`"$MktDataService`"" `
            -WorkingDirectory $RepoRoot -PassThru -WindowStyle Minimized
        $pyJobs += $mktJob
        $mktOk = Wait-ForHealth -Url "http://127.0.0.1:5010/lob/health" -Name "Market-data sidecar" -TimeoutSec 15
        if (-not $mktOk) {
            Write-Warn "Sidecar did not start. Engine will use TradingView fallback."
        }
    }

    # 2. ML inference service
    Write-Step "Starting ML service on :5001..."
    if (Test-PortOpen -Port 5001) {
        Write-OK "ML service already running on :5001."
    } else {
        Clear-StalePort -Port 5001
        $mlJob = Start-Process -FilePath $Python -ArgumentList "`"$MlService`"" `
            -WorkingDirectory $RepoRoot -PassThru -WindowStyle Minimized
        $pyJobs += $mlJob
        $mlOk = Wait-ForHealth -Url "http://127.0.0.1:5001/health" -Name "ML service" -TimeoutSec 15
        if (-not $mlOk) {
            Write-Warn "ML service did not start. ML management will be disabled."
        }
    }

    # 3. Check Bookmap data flow
    Write-Step "Checking Bookmap data flow..."
    try {
        $lobHealth = Invoke-RestMethod -Uri "http://127.0.0.1:5010/lob/health" -TimeoutSec 3 -ErrorAction Stop
        if ($lobHealth.source_connected -eq $true -and $lobHealth.bbo_fresh -eq $true) {
            Write-OK "Bookmap data flowing. BBO fresh, primary quote authority active."
        } elseif ($lobHealth.source_connected -eq $true) {
            Write-Warn "Bookmap connected but BBO stale (age: $($lobHealth.bbo_age_ms)ms)."
            Write-Host "         Check that NQM6.CME@RITHMIC is subscribed in Bookmap." -ForegroundColor Yellow
        } else {
            Write-Warn "Sidecar running but Bookmap NOT connected."
            Write-Host "         Open Bookmap, connect to Rithmic, subscribe NQM6.CME@RITHMIC." -ForegroundColor Yellow
            Write-Host "         Engine will use TradingView fallback until Bookmap connects." -ForegroundColor Yellow
        }
    } catch {
        Write-Warn "Could not reach sidecar health. Bookmap features will be unavailable."
    }
}

# --- TradingView CDP ---------------------------------------------------------
Write-Step "Checking TradingView CDP on :9222..."
if (Test-PortOpen -Port 9222) {
    Write-OK "TradingView CDP reachable at :9222."
} else {
    Write-Warn "TradingView CDP not detected on :9222."
    Write-Host "         Start TradingView with: scripts\launch_tv_debug.bat" -ForegroundColor Yellow
    Write-Host "         The engine will retry on startup." -ForegroundColor Yellow
}

# --- Browser auto-open -------------------------------------------------------
if (-not $NoBrowser) {
    $browserJob = Start-Job -ScriptBlock {
        param($url, $snapshotUrl)
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep 2
            try {
                $r = Invoke-WebRequest -Uri $snapshotUrl -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
                if ($r.StatusCode -eq 200) { break }
            } catch { }
        }
        Start-Process $url
    } -ArgumentList $DashboardUrl, $SnapshotUrl
}

# --- Start engine ------------------------------------------------------------
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   Starting trading engine...  Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "   Dashboard: $DashboardUrl" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $RepoRoot
$env:MODE                 = $Mode
$env:LIVE_TRADING_ENABLED = 'false'
$env:DASHBOARD_PORT       = $DashboardPort.ToString()

try {
    & node "$RunnerJs"
} finally {
    Write-Host ""
    Write-Host "  Engine exited. Cleaning up..." -ForegroundColor Yellow
    foreach ($job in $pyJobs) {
        if (-not $job.HasExited) {
            Write-Step "Stopping PID $($job.Id)..."
            Stop-Process -Id $job.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not $NoBrowser) {
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "  Full stack stopped." -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""
pause
