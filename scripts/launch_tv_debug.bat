@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Kill existing TradingView instances
taskkill /F /IM TradingView.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM Auto-detect TradingView install location
set "TV_EXE="

REM Check common install locations
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM Check MSIX / Windows Store installs
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('dir /s /b "%PROGRAMFILES%\WindowsApps\TradingView*\TradingView.exe" 2^>nul') do set "TV_EXE=%%i"
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

if not "%TV_EXE%"=="" goto :launch_exe

echo Traditional TradingView install not found. Checking for Store/MSIX app...
powershell -ExecutionPolicy Bypass -File "%~dp0launch_tv_store.ps1" -Port %PORT%
if %errorlevel% neq 0 (
    echo.
    echo Error: TradingView not found anywhere.
    echo Checked: %%LOCALAPPDATA%%\TradingView, %%PROGRAMFILES%%\TradingView, WindowsApps, Store apps
    echo.
    echo If installed elsewhere, run manually:
    echo   "C:\path\to\TradingView.exe" --remote-debugging-port=%PORT%
    exit /b 1
)
echo Launched TradingView Store app via IApplicationActivationManager
goto :waitcdp

:launch_exe

echo Found TradingView at: %TV_EXE%
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%

:waitcdp
echo Waiting for CDP to become available...
timeout /t 5 /nobreak >nul

:check
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% neq 0 (
    echo Still waiting...
    timeout /t 2 /nobreak >nul
    goto check
)

echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.
