@echo off
::  ─────────────────────────────────────────────────────────────────────────
::  launch-app.bat — thin wrapper that calls launch-app.ps1 from anywhere.
::
::  This file exists so that:
::    • Windows shortcuts can point to a .bat (which Windows handles natively)
::    • The PowerShell execution-policy bypass is applied automatically
::    • The working directory is always set to the repo root
::
::  Do NOT run this file directly from a PowerShell session; use
::  launch-app.ps1 directly instead.
::  ─────────────────────────────────────────────────────────────────────────

title NQ Trading App — starting...
cd /d "%~dp0.."

powershell.exe -NoLogo -ExecutionPolicy Bypass -File "%~dp0launch-app.ps1" %*

:: If PowerShell exits non-zero, keep the window open so the user can read
:: any error messages (the PS1 itself ends with pause on errors, but this
:: catches the case where powershell.exe itself could not launch).
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] launch-app.ps1 exited with code %errorlevel%.
    pause
)
