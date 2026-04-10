#Requires -Version 5.1
<#
.SYNOPSIS
    Create desktop shortcuts for the canonical NQ launch scripts.

.DESCRIPTION
    Creates shortcuts on the current user's Desktop that point directly to the
    PowerShell launchers under scripts/:

      NQ Full Stack (Paper)
      NQ Trading App (Paper)
      NQ Trading App (Signal)
      NQ Stop Full Stack

    The shortcuts use the canonical PowerShell entrypoints instead of legacy
    batch wrappers so the repo has one obvious run surface.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$RepoRoot = Split-Path -Path $ScriptDir -Parent
$Desktop = [System.Environment]::GetFolderPath('Desktop')
$WshShell = New-Object -ComObject WScript.Shell
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$IconExe = if ($NodeCmd) { $NodeCmd.Source } else { $PowerShellExe }

function New-PowerShellShortcut {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ShortcutName,

        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,

        [string]$Arguments = '',
        [string]$Description = '',
        [string]$IconPath = $IconExe
    )

    $shortcutPath = Join-Path $Desktop "$ShortcutName.lnk"
    $shortcut = $WshShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $PowerShellExe
    $shortcut.Arguments = "-NoLogo -ExecutionPolicy Bypass -File `"$ScriptPath`" $Arguments".Trim()
    $shortcut.WorkingDirectory = $RepoRoot
    $shortcut.WindowStyle = 1
    $shortcut.Description = $Description
    $shortcut.IconLocation = "$IconPath,0"
    $shortcut.Save()

    Write-Host "  [OK] $shortcutPath" -ForegroundColor Green
}

$launchApp = Join-Path $ScriptDir 'launch-app.ps1'
$startFullStack = Join-Path $ScriptDir 'start-full-stack.ps1'
$stopFullStack = Join-Path $ScriptDir 'stop-full-stack.ps1'

Write-Host ''
Write-Host '  Creating Desktop shortcuts for canonical launch paths...'
Write-Host "  Repo   : $RepoRoot"
Write-Host "  Desktop: $Desktop"
Write-Host ''

New-PowerShellShortcut `
    -ShortcutName 'NQ Full Stack (Paper)' `
    -ScriptPath $startFullStack `
    -Description 'Canonical full-stack launch: market data sidecar, ML service, engine, and dashboard.'

New-PowerShellShortcut `
    -ShortcutName 'NQ Trading App (Paper)' `
    -ScriptPath $launchApp `
    -Description 'Canonical lightweight launch: engine and dashboard only.'

New-PowerShellShortcut `
    -ShortcutName 'NQ Trading App (Signal)' `
    -ScriptPath $launchApp `
    -Arguments '-Mode signal_only' `
    -Description 'Canonical lightweight launch in signal-only mode.'

New-PowerShellShortcut `
    -ShortcutName 'NQ Stop Full Stack' `
    -ScriptPath $stopFullStack `
    -Description 'Stop the local NQ full stack without closing TradingView or Bookmap.'

Write-Host ''
Write-Host '  Shortcuts refreshed. Use "NQ Full Stack (Paper)" as the default launch path.' -ForegroundColor Cyan
Write-Host ''
