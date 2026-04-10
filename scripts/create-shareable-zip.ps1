#Requires -Version 5.1
<#
.SYNOPSIS
    Create a clean shareable ZIP without local secrets, dependency folders, or runtime clutter.

.DESCRIPTION
    Builds a staging copy of the repository and zips it without touching the live workspace.
    By default the archive excludes:
      - node_modules/ and dashboard/node_modules/
      - .env and .mcp.json
      - .git
      - build/runtime clutter such as dist/, logs/, tmp/, screenshots/, and caches
      - reports/ (generated output)
      - data/ and models/ (local-only ML assets)

    Use -IncludeGit to keep .git in the archive.
    Use -IncludeLocalAssets to keep data/ and models/ in the archive.
#>

[CmdletBinding()]
param(
    [string]$OutputPath,
    [switch]$IncludeGit,
    [switch]$IncludeLocalAssets
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$RepoRoot = Split-Path $ScriptDir -Parent
$RepoName = Split-Path $RepoRoot -Leaf
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not $OutputPath) {
    $OutputPath = Join-Path $RepoRoot "artifacts\$RepoName-shareable-$Timestamp.zip"
}

$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$OutputDir = Split-Path $OutputPath -Parent
$StagingDir = Join-Path ([System.IO.Path]::GetTempPath()) "$RepoName-shareable-$Timestamp"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$ExcludeDirs = @(
    (Join-Path $RepoRoot 'artifacts'),
    (Join-Path $RepoRoot 'node_modules'),
    (Join-Path $RepoRoot 'dashboard\node_modules'),
    (Join-Path $RepoRoot 'dist'),
    (Join-Path $RepoRoot 'dashboard\dist'),
    (Join-Path $RepoRoot 'logs'),
    (Join-Path $RepoRoot 'screenshots'),
    (Join-Path $RepoRoot 'tmp'),
    (Join-Path $RepoRoot '.pytest_cache'),
    (Join-Path $RepoRoot 'catboost_info'),
    (Join-Path $RepoRoot '.claude'),
    (Join-Path $RepoRoot '.cursor'),
    (Join-Path $RepoRoot 'bookmap-addon\build'),
    (Join-Path $RepoRoot 'bookmap-addon\build-check'),
    (Join-Path $RepoRoot 'reports')
)

if (-not $IncludeGit) {
    $ExcludeDirs += Join-Path $RepoRoot '.git'
}

if (-not $IncludeLocalAssets) {
    $ExcludeDirs += @(
        (Join-Path $RepoRoot 'data'),
        (Join-Path $RepoRoot 'models')
    )
}

$ExcludeFiles = @(
    '.env',
    '.mcp.json',
    'debug-*.log',
    '*.pyc',
    '*.pyo',
    '*.tsbuildinfo'
)

function Remove-StagingPath {
    if (Test-Path -LiteralPath $StagingDir) {
        Remove-Item -LiteralPath $StagingDir -Recurse -Force
    }
}

try {
    Remove-StagingPath
    New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

    Write-Host "[shareable-zip] Repo root: $RepoRoot"
    Write-Host "[shareable-zip] Output: $OutputPath"
    Write-Host "[shareable-zip] Include .git: $($IncludeGit.IsPresent)"
    Write-Host "[shareable-zip] Include local data/models: $($IncludeLocalAssets.IsPresent)"

    $RobocopyArgs = @(
        $RepoRoot,
        $StagingDir,
        '/E',
        '/R:1',
        '/W:1',
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/NP',
        '/XD'
    ) + $ExcludeDirs + @('/XF') + $ExcludeFiles

    & robocopy @RobocopyArgs | Out-Host
    $RobocopyExitCode = $LASTEXITCODE
    if ($RobocopyExitCode -gt 7) {
        throw "robocopy failed with exit code $RobocopyExitCode"
    }

    Get-ChildItem -Path $StagingDir -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in @('__pycache__', '.pytest_cache') } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    Get-ChildItem -Path $StagingDir -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -like 'debug-*.log' -or
            $_.Extension -in @('.pyc', '.pyo', '.tsbuildinfo')
        } |
        Remove-Item -Force -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $OutputPath) {
        Remove-Item -LiteralPath $OutputPath -Force
    }

    Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $StagingDir,
        $OutputPath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    Write-Host "[shareable-zip] Created shareable ZIP successfully."
} finally {
    Remove-StagingPath
}
