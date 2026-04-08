#Requires -Version 5.1
<#
.SYNOPSIS
    Stop the local NQ Trading stack (Python services + Node engine).

.DESCRIPTION
    Stops:
      - python-market-data-service (port 5010)
      - python-ml-service (port 5001)
      - Node trading engine (runner.js)

    Does NOT stop Bookmap or TradingView.
#>

Set-StrictMode -Version Latest

function Write-Step { param($msg) Write-Host "  [>>] $msg" -ForegroundColor White }
function Write-OK   { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }

Write-Host ""
Write-Host "  Stopping NQ Trading Stack..." -ForegroundColor Yellow
Write-Host ""

# Stop Node engine
$nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match 'runner\.js' -or $_.MainWindowTitle -match 'NQ'
}
if ($nodeProcs) {
    foreach ($p in $nodeProcs) {
        Write-Step "Stopping Node PID $($p.Id)..."
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
    Write-OK "Node engine stopped."
} else {
    Write-OK "No Node engine process found."
}

# Stop Python processes on known ports
foreach ($port in @(5010, 5001)) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($c in $conns) {
            $pid = $c.OwningProcess
            Write-Step "Stopping PID $pid on port $port..."
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
        Write-OK "Port $port freed."
    } else {
        Write-OK "Port $port already free."
    }
}

Write-Host ""
Write-Host "  Stack stopped. Bookmap and TradingView are unchanged." -ForegroundColor Green
Write-Host ""
