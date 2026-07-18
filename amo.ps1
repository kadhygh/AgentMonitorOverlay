param(
    [ValidateSet("Stable", "Source", "Portable")]
    [string]$Mode = "Stable",
    [switch]$DebugMode,
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path $PSScriptRoot).Path
$overlayRoot = Join-Path $repoRoot "overlay"
$localConfigPath = Join-Path $repoRoot "amo.local.json"

# Some managed shells inject both Path and PATH. Start-Process treats those as
# duplicate dictionary keys, so normalize them before launching child processes.
$processPath = [string][Environment]::GetEnvironmentVariable("Path", "Process")
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $processPath, "Process")

Remove-Item Env:AGENT_MONITOR_SHORTCUT_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:VITE_AMO_SHORTCUT_PROFILE -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $localConfigPath) {
    $localConfig = Get-Content -Raw -Encoding UTF8 $localConfigPath | ConvertFrom-Json
    $shortcutProfile = [string]$localConfig.shortcutProfile
    if ($shortcutProfile) {
        $env:AGENT_MONITOR_SHORTCUT_PROFILE = $shortcutProfile
        $env:VITE_AMO_SHORTCUT_PROFILE = $shortcutProfile
    }
}

if ($Mode -in @("Stable", "Source")) {
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
    $startScript = if ($Mode -eq "Stable") {
        Join-Path $repoRoot "scripts\amo\start-stable.ps1"
    } else {
        Join-Path $repoRoot "scripts\amo\start.ps1"
    }
    & $startScript @startParams
    exit $LASTEXITCODE
}

if ($DebugMode) {
    throw "DebugMode is available for Stable and Source modes. Portable mode always starts with release behavior."
}

$version = [string](Get-Content -Raw -Encoding UTF8 (Join-Path $overlayRoot "src-tauri\tauri.conf.json") | ConvertFrom-Json).version
$portableParams = @{ Version = $version }
if ($SkipDependencyInstall) { $portableParams.SkipDependencyInstall = $true }
& (Join-Path $repoRoot "scripts\amo\start-portable.ps1") @portableParams
exit $LASTEXITCODE
