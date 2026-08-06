param(
    [ValidateSet("Stable", "Source", "Portable")]
    [string]$Mode = "Stable",
    [switch]$DebugMode,
    [switch]$SkipDependencyInstall,
    [switch]$HealthOnly,
    [switch]$RestartOnly
)

$ErrorActionPreference = "Stop"
$runtimeMode = if ($DebugMode) { "debug" } elseif ($Mode -eq "Portable") { "portable" } else { $Mode.ToLowerInvariant() }
$env:VITE_AMO_RUNTIME_MODE = $runtimeMode
$repoRoot = (Resolve-Path $PSScriptRoot).Path
$overlayRoot = Join-Path $repoRoot "overlay"
$localConfigPath = Join-Path $repoRoot "amo.local.json"

if ($HealthOnly -and $RestartOnly) {
    throw "HealthOnly and RestartOnly cannot be used together."
}
if (($HealthOnly -or $RestartOnly) -and $Mode -ne "Stable") {
    throw "HealthOnly and RestartOnly are available only in Stable mode."
}

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

if ($Mode -eq "Stable") {
    $startParams = @{}
    if ($DebugMode) { $startParams.DebugMode = $true }
    if ($HealthOnly) { $startParams.HealthOnly = $true }
    if ($RestartOnly) { $startParams.RestartOnly = $true }
    & (Join-Path $repoRoot "scripts\amo\start-stable.ps1") @startParams
    exit $LASTEXITCODE
}

if ($Mode -eq "Source") {
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
    throw "DebugMode is available for Stable and Source modes. Portable mode always starts with release behavior."
}

$version = [string](Get-Content -Raw -Encoding UTF8 (Join-Path $overlayRoot "src-tauri\tauri.conf.json") | ConvertFrom-Json).version
$portableParams = @{ Version = $version }
if ($SkipDependencyInstall) { $portableParams.SkipDependencyInstall = $true }
& (Join-Path $repoRoot "scripts\amo\start-portable.ps1") @portableParams
exit $LASTEXITCODE