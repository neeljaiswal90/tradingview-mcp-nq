@echo off
title NQ Stack — stopping...
cd /d "%~dp0.."
powershell.exe -NoLogo -ExecutionPolicy Bypass -File "%~dp0stop-full-stack.ps1"
pause
