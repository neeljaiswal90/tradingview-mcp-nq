@echo off
::  ─────────────────────────────────────────────────────────────────────────
::  start-full-stack.bat — Thin wrapper for start-full-stack.ps1.
::
::  Points: Windows shortcut -> this .bat -> start-full-stack.ps1
::
::  Launches the full stack:
::    1. Market-data sidecar (Bookmap/Rithmic)
::    2. ML inference service
::    3. TradingView check
::    4. Trading engine + dashboard
::  ─────────────────────────────────────────────────────────────────────────

title NQ Full Stack — starting...
cd /d "%~dp0.."

powershell.exe -NoLogo -ExecutionPolicy Bypass -File "%~dp0start-full-stack.ps1" %*

if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] start-full-stack.ps1 exited with code %errorlevel%.
    pause
)
