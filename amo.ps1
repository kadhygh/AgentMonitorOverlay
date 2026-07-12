param(
    [ValidateSet("Source", "Portable")]
    [string]$Mode = "Source",
    [switch]$DebugMode,
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path $PSScriptRoot).Path
$overlayRoot = Join-Path $repoRoot "overlay"

if ($Mode -eq "Source") {
    $portableRoot = Join-Path $repoRoot "dist\portable"
    $tauriTargetRoot = Join-Path $overlayRoot "src-tauri\target"
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $executablePath = [string]$_.ExecutablePath
        $commandLine = [string]$_.CommandLine
        ($executablePath -and $executablePath.StartsWith($portableRoot, [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($executablePath -and $executablePath.StartsWith($tauriTargetRoot, [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($_.Name -ieq "node.exe" -and $commandLine -like "*$repoRoot*broker*server.js*") -or
        ($commandLine -like "*$overlayRoot*" -and ($commandLine -like "*tauri*dev*" -or $commandLine -like "*vite*")) -or
        ($_.Name -ieq "cmd.exe" -and $commandLine -like "*AMO Broker Debug*")
    })) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 700

    Push-Location $overlayRoot
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $startParams = @{}
    if ($DebugMode) { $startParams.DebugMode = $true }
    & (Join-Path $repoRoot "scripts\amo\start.ps1") @startParams
    exit $LASTEXITCODE
}

if ($DebugMode) {
    throw "DebugMode is available for Source mode. Portable mode always starts with release behavior."
}

$version = [string](Get-Content -Raw -Encoding UTF8 (Join-Path $overlayRoot "src-tauri\tauri.conf.json") | ConvertFrom-Json).version
$portableParams = @{ Version = $version }
if ($SkipDependencyInstall) { $portableParams.SkipDependencyInstall = $true }
& (Join-Path $repoRoot "scripts\amo\start-portable.ps1") @portableParams
exit $LASTEXITCODE
