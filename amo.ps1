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
$machineLauncherConfigPath = Join-Path $env:LOCALAPPDATA "AgentMonitorOverlay\launcher.json"

if ($Mode -eq "Source" -and (Test-Path -LiteralPath $machineLauncherConfigPath)) {
    $machineLauncherConfig = Get-Content -Raw -Encoding UTF8 $machineLauncherConfigPath | ConvertFrom-Json
    $configuredSourceRoot = [string]$machineLauncherConfig.sourceRoot
    if ($configuredSourceRoot) {
        if (-not (Test-Path -LiteralPath $configuredSourceRoot -PathType Container)) {
            throw "Configured canonical AMO Source root does not exist: $configuredSourceRoot"
        }

        $canonicalSourceRoot = (Resolve-Path -LiteralPath $configuredSourceRoot).Path
        if (-not $repoRoot.Equals($canonicalSourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $canonicalEntryPoint = Join-Path $canonicalSourceRoot "amo.ps1"
            if (-not (Test-Path -LiteralPath $canonicalEntryPoint -PathType Leaf)) {
                throw "Configured canonical AMO Source entry point does not exist: $canonicalEntryPoint"
            }

            Write-Host "Delegating AMO Source startup to canonical repository: $canonicalSourceRoot"
            $delegateParams = @{ Mode = "Source" }
            if ($DebugMode) { $delegateParams.DebugMode = $true }
            if ($SkipDependencyInstall) { $delegateParams.SkipDependencyInstall = $true }
            & $canonicalEntryPoint @delegateParams
            exit $LASTEXITCODE
        }
    }
}

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
