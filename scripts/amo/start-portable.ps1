param(
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$portableOutput = Join-Path $repoRoot "dist\portable"
$targetRoot = Join-Path $portableOutput "AMO-v$Version-win-x64"
$targetApp = Join-Path $targetRoot "AMO.exe"
$tmpRoot = Join-Path $repoRoot "tmp"
$brokerUrl = "http://127.0.0.1:17654"

function Get-AmoProcesses {
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $executablePath = [string]$_.ExecutablePath
        $commandLine = [string]$_.CommandLine
        ($executablePath -and $executablePath.StartsWith($portableOutput, [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($executablePath -and $executablePath.StartsWith((Join-Path $repoRoot "overlay\src-tauri\target"), [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($_.Name -ieq "node.exe" -and $commandLine -like "*$repoRoot*broker*server.js*") -or
        ($commandLine -like "*$repoRoot*overlay*" -and ($commandLine -like "*tauri*dev*" -or $commandLine -like "*vite*")) -or
        ($_.Name -ieq "cmd.exe" -and $commandLine -like "*AMO Broker Debug*")
    })
}

function Get-RunningPortableRoot {
    $process = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq "AMO.exe" -and
        $_.ExecutablePath -and
        ([string]$_.ExecutablePath).StartsWith($portableOutput, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if ($process) { return Split-Path -Parent ([string]$process.ExecutablePath) }
    return $null
}

function Stop-AmoProcesses {
    foreach ($process in @(Get-AmoProcesses)) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800

    $listener = Get-NetTCPConnection -LocalPort 17654 -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        throw "Port 17654 is still owned by $($owner.Name) pid=$($listener.OwningProcess). Stop it before starting Portable AMO."
    }
}

function Wait-PortableBroker {
    param([Parameter(Mandatory = $true)][string]$ExpectedDataRoot)

    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Method GET -Uri "$brokerUrl/api/health" -TimeoutSec 2
            if ($health.ok) {
                $storage = [string]$health.storage
                if (-not $storage.StartsWith($ExpectedDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw "Portable Broker started with unexpected storage: $storage"
                }
                return $health
            }
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    throw "Portable Broker did not become healthy at $brokerUrl."
}

$sourceRoot = Get-RunningPortableRoot
if (-not $sourceRoot -and (Test-Path -LiteralPath (Join-Path $targetRoot "data"))) {
    $sourceRoot = $targetRoot
}
if (-not $sourceRoot -and (Test-Path -LiteralPath $portableOutput)) {
    $sourceRoot = Get-ChildItem -LiteralPath $portableOutput -Directory -Filter "AMO-v*-win-x64" |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "data") } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}

Stop-AmoProcesses

$backupRoot = $null
if ($sourceRoot -and (Test-Path -LiteralPath (Join-Path $sourceRoot "data"))) {
    New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
    $backupRoot = Join-Path $tmpRoot ("portable-live-data-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
    New-Item -ItemType Directory -Path $backupRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot "data") -Destination $backupRoot -Recurse
    Write-Host "Portable data backed up from $sourceRoot to $backupRoot."
}

$buildParams = @{ Version = $Version }
if ($SkipDependencyInstall) { $buildParams.SkipDependencyInstall = $true }
& (Join-Path $repoRoot "scripts\release\build-portable.ps1") @buildParams
if ($LASTEXITCODE -ne 0) { throw "Portable build failed with exit code $LASTEXITCODE" }

if ($backupRoot) {
    $targetData = Join-Path $targetRoot "data"
    if (-not $targetData.StartsWith($targetRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe Portable data target: $targetData"
    }
    Remove-Item -LiteralPath $targetData -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $backupRoot "data") -Destination $targetData -Recurse
    Write-Host "Portable data restored to $targetData."
}

if (-not (Test-Path -LiteralPath $targetApp)) { throw "Portable app was not built: $targetApp" }
$app = Start-Process -FilePath $targetApp -WorkingDirectory $targetRoot -WindowStyle Hidden -PassThru
$health = Wait-PortableBroker -ExpectedDataRoot (Join-Path $targetRoot "data")

Write-Host "Portable AMO v$Version started."
Write-Host "App pid: $($app.Id)"
Write-Host "Broker: $brokerUrl"
Write-Host "Storage: $($health.storage)"
