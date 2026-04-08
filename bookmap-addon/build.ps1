# Build the Bookmap BBO Forwarder addon JAR.
# Requires: javac (JDK 11+) on PATH, Bookmap installed at default location.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AddonDir = $PSScriptRoot
$BuildDir = Join-Path $AddonDir 'build'
$SourceFile = Join-Path $AddonDir 'src\main\java\com\nqtrader\bookmap\BboForwarder.java'
$JarFile = Join-Path $AddonDir 'nq-bbo-forwarder.jar'
$BmLib = 'C:\Program Files\Bookmap\lib'

if (-not (Test-Path $SourceFile)) {
    Write-Host "[ERROR] Source not found: $SourceFile" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "$BmLib\bm-l1api.jar")) {
    Write-Host "[ERROR] Bookmap API jar not found at $BmLib" -ForegroundColor Red
    exit 1
}

# Clean + compile
if (Test-Path $BuildDir) { Remove-Item $BuildDir -Recurse -Force }
New-Item -ItemType Directory $BuildDir | Out-Null

$cp = "$BmLib\bm-l1api.jar;$BmLib\bm-simplified-api-wrapper.jar"
Write-Host "Compiling..." -ForegroundColor Cyan
& javac -cp $cp -d $BuildDir $SourceFile

if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAILED] Compilation errors." -ForegroundColor Red
    exit 1
}

# Package JAR
Set-Location $BuildDir
& jar cf $JarFile com
Set-Location $AddonDir

Write-Host "[OK] Built: $JarFile ($(Get-Item $JarFile | Select-Object -Expand Length) bytes)" -ForegroundColor Green
Write-Host ""
Write-Host "Install in Bookmap:" -ForegroundColor Yellow
Write-Host "  Settings > API plugins configuration > Add > $JarFile" -ForegroundColor Yellow
