param(
    [switch]$DebugMode,
    [switch]$SkipBroker
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$overlayRoot = Join-Path $repoRoot "overlay"
$tauriRoot = Join-Path $overlayRoot "src-tauri"
$cargoManifest = Join-Path $tauriRoot "Cargo.toml"
$appPath = Join-Path $tauriRoot "target\debug\agent-monitor-overlay.exe"
$tmpRoot = Join-Path $repoRoot "tmp"
$viteUrl = "http://127.0.0.1:1420/"
$viteStdout = Join-Path $tmpRoot "amo-stable-vite.out.log"
$viteStderr = Join-Path $tmpRoot "amo-stable-vite.err.log"
$appStdout = Join-Path $tmpRoot "amo-stable-app.out.log"
$appStderr = Join-Path $tmpRoot "amo-stable-app.err.log"

function Wait-AmoStableUrl {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Name,
        [int]$TimeoutSeconds = 15
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    throw "$Name did not become ready at $Url."
}

if (-not (Test-Path -LiteralPath $cargoManifest)) {
    throw "Could not find Cargo manifest: $cargoManifest"
}

New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

Write-Host "Building stable AMO native executable without the Tauri watcher..."
cargo build --locked --no-default-features --manifest-path $cargoManifest
if ($LASTEXITCODE -ne 0) {
    throw "Stable Cargo build failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $appPath)) {
    throw "Stable AMO executable was not produced: $appPath"
}

$brokerParams = @{ SkipOverlay = $true }
if ($SkipBroker) { $brokerParams.SkipBroker = $true }
if ($DebugMode) { $brokerParams.DebugMode = $true }
& (Join-Path $repoRoot "scripts\amo\start.ps1") @brokerParams
if ($LASTEXITCODE -ne 0) {
    throw "AMO broker startup failed with exit code $LASTEXITCODE"
}

$viteListener = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
if ($viteListener) {
    throw "Port 1420 is already in use by pid $($viteListener.OwningProcess)."
}

Remove-Item -LiteralPath $viteStdout, $viteStderr, $appStdout, $appStderr -Force -ErrorAction SilentlyContinue

$viteParams = @{
    FilePath = "cmd.exe"
    ArgumentList = @("/c", "npm run dev")
    WorkingDirectory = $overlayRoot
    PassThru = $true
}
if (-not $DebugMode) {
    $viteParams.WindowStyle = "Hidden"
    $viteParams.RedirectStandardOutput = $viteStdout
    $viteParams.RedirectStandardError = $viteStderr
}

Write-Host "Starting AMO Vite server without the Tauri watcher..."
$viteProcess = Start-Process @viteParams
Wait-AmoStableUrl -Url $viteUrl -Name "AMO Vite server"

$appParams = @{
    FilePath = $appPath
    WorkingDirectory = $tauriRoot
    PassThru = $true
}
if (-not $DebugMode) {
    $appParams.WindowStyle = "Hidden"
    $appParams.RedirectStandardOutput = $appStdout
    $appParams.RedirectStandardError = $appStderr
}

Write-Host "Starting stable AMO native window..."
$appProcess = Start-Process @appParams
Start-Sleep -Milliseconds 800
if ($appProcess.HasExited) {
    throw "Stable AMO native process exited with code $($appProcess.ExitCode). See $appStderr"
}

Write-Host "AMO stable startup sequence complete."
Write-Host "Mode: Stable (no Tauri watcher)"
Write-Host "Broker: http://127.0.0.1:17654"
Write-Host "Overlay: $viteUrl"
Write-Host "Vite pid: $($viteProcess.Id)"
Write-Host "App pid: $($appProcess.Id)"
if (-not $DebugMode) {
    Write-Host "Vite stdout: $viteStdout"
    Write-Host "Vite stderr: $viteStderr"
    Write-Host "App stdout: $appStdout"
    Write-Host "App stderr: $appStderr"
}
