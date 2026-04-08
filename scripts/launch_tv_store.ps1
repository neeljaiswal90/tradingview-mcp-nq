# Launch TradingView MSIX/Store app via IApplicationActivationManager COM API.
# This allows passing command-line arguments (like --remote-debugging-port) to
# packaged apps that can't be invoked directly from their WindowsApps path.
#
# Usage: powershell -ExecutionPolicy Bypass -File launch_tv_store.ps1 [-Port 9222]

param(
    [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'

# --- Resolve the App User Model ID (AUMID) dynamically ---
$pkg = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction SilentlyContinue
if (-not $pkg) {
    $pkg = Get-AppxPackage | Where-Object { $_.Name -like '*TradingView*' } |
           Select-Object -First 1
}
if (-not $pkg) {
    Write-Error 'TradingView Store/MSIX app not installed.'
    exit 1
}

$manifest = Get-AppxPackageManifest -Package $pkg
$appId    = $manifest.Package.Applications.Application.Id
$aumid    = "$($pkg.PackageFamilyName)!$appId"

# --- Define COM interop for IApplicationActivationManager ---
Add-Type -TypeDefinition @"
using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

[ComImport,
 Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager
{
    IntPtr ActivateApplication(
        [In] string appUserModelId,
        [In] string arguments,
        [In] uint options,
        [Out] out uint processId);
}

[ComImport,
 Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"),
 ClassInterface(ClassInterfaceType.None)]
public class ApplicationActivationManager : IApplicationActivationManager
{
    [MethodImpl(MethodImplOptions.InternalCall,
                MethodCodeType = MethodCodeType.Runtime)]
    public extern IntPtr ActivateApplication(
        [In] string appUserModelId,
        [In] string arguments,
        [In] uint options,
        [Out] out uint processId);
}
"@

# --- Activate the app with the CDP flag ---
$arguments = "--remote-debugging-port=$Port"
$mgr = New-Object ApplicationActivationManager
[uint32]$processId = 0
$hr = $mgr.ActivateApplication($aumid, $arguments, 0, [ref]$processId)

if ($processId -eq 0) {
    Write-Error "ActivateApplication returned HRESULT $hr - launch may have failed."
    exit 1
}

# Output JSON so callers (bat, Node) can parse results easily
$result = @{
    success   = $true
    aumid     = $aumid
    pid       = $processId
    arguments = $arguments
    package   = $pkg.PackageFullName
} | ConvertTo-Json -Compress

Write-Output $result
