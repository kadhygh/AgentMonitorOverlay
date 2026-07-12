param(
    [switch]$DebugMode,
    [switch]$SkipBroker,
    [switch]$SkipOverlay,
    [switch]$KeepExistingOverlay
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$overlayPath = Join-Path $repoRoot "overlay"
$serverPath = Join-Path $repoRoot "broker\server.js"
$tmpRoot = Join-Path $repoRoot "tmp"
$brokerPort = 17654
$overlayPort = 1420
$brokerBaseUrl = "http://127.0.0.1:$brokerPort"
$brokerStdout = Join-Path $tmpRoot "amo-broker.out.log"
$brokerStderr = Join-Path $tmpRoot "amo-broker.err.log"
$overlayStdout = Join-Path $tmpRoot "amo-overlay.out.log"
$overlayStderr = Join-Path $tmpRoot "amo-overlay.err.log"

function Get-PortOwners {
    param([Parameter(Mandatory = $true)][int]$Port)

    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if ($process) {
            [pscustomobject]@{
                ProcessId = [int]$process.ProcessId
                Name = $process.Name
                CommandLine = $process.CommandLine
            }
        } else {
            [pscustomobject]@{
                ProcessId = [int]$listener.OwningProcess
                Name = "unknown"
                CommandLine = ""
            }
        }
    }
}

function Format-PortOwners {
    param([object[]]$Owners)

    if (-not $Owners -or $Owners.Count -eq 0) {
        return "no listener"
    }

    return (($Owners | ForEach-Object { "$($_.Name) pid=$($_.ProcessId)" }) -join "; ")
}

function Test-AmoBrokerHealthy {
    try {
        $health = Invoke-RestMethod -Method GET -Uri "$brokerBaseUrl/api/health" -TimeoutSec 2
        return [bool]($health.ok -and $health.service -eq "agent-monitor-broker")
    } catch {
        return $false
    }
}

function Test-AmoBrokerProcess {
    param([object]$Owner)

    $commandLine = [string]$Owner.CommandLine
    return $Owner.Name -ieq "node.exe" -and
        ($commandLine -like "*broker/server.js*" -or $commandLine -like "*broker\server.js*")
}

function Stop-StaleAmoBrokerOnPort {
    $owners = @(Get-PortOwners -Port $brokerPort)
    if ($owners.Count -eq 0) {
        return
    }

    foreach ($owner in $owners) {
        if (Test-AmoBrokerProcess -Owner $owner) {
            Write-Host "Stopping stale AMO broker pid $($owner.ProcessId) on port $brokerPort."
            Stop-Process -Id $owner.ProcessId -Force
            continue
        }

        throw "Port $brokerPort is in use by $($owner.Name) pid=$($owner.ProcessId), not an AMO broker."
    }
}

function Stop-OverlayDevProcesses {
    $targets = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $commandLine = [string]$_.CommandLine
            $executablePath = [string]$_.ExecutablePath
            $isOverlayProcess =
                $commandLine -like "*AgentMonitorOverlay*overlay*" -or
                ($executablePath -and $executablePath.StartsWith($overlayPath, [System.StringComparison]::OrdinalIgnoreCase))

            $isOverlayProcess -and (
                $commandLine -like "*vite\bin\vite.js*" -or
                $commandLine -like "*@tauri-apps\cli\tauri.js*dev*" -or
                $commandLine -like "*npm run dev*" -or
                $commandLine -like "*npm run tauri:dev*" -or
                $commandLine -like "*cargo*run*" -or
                $commandLine -like "*target\debug\agent-monitor-overlay.exe*" -or
                $_.Name -ieq "agent-monitor-overlay.exe"
            )
        })

    foreach ($target in $targets) {
        Write-Host "Stopping existing AMO overlay dev process $($target.ProcessId)."
        Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Assert-OverlayPortReady {
    $owners = @(Get-PortOwners -Port $overlayPort)
    if ($owners.Count -eq 0) {
        return
    }

    if ($KeepExistingOverlay) {
        throw "Port $overlayPort is already in use ($((Format-PortOwners -Owners $owners))). Close it or rerun without -KeepExistingOverlay."
    }

    Stop-OverlayDevProcesses
    Start-Sleep -Milliseconds 500

    $remainingOwners = @(Get-PortOwners -Port $overlayPort)
    if ($remainingOwners.Count -gt 0) {
        throw "Port $overlayPort is still in use ($((Format-PortOwners -Owners $remainingOwners)))."
    }
}

function Wait-AmoBroker {
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline) {
        if (Test-AmoBrokerHealthy) {
            return
        }

        Start-Sleep -Milliseconds 250
    }

    throw "AMO broker did not become healthy at $brokerBaseUrl."
}

function Start-AmoBroker {
    if ($SkipBroker) {
        Write-Host "Skipping broker startup."
        return $null
    }

    if (Test-AmoBrokerHealthy) {
        Write-Host "AMO broker is already healthy at $brokerBaseUrl."
        return $null
    }

    Stop-StaleAmoBrokerOnPort
    New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
    Remove-Item -LiteralPath $brokerStdout, $brokerStderr -Force -ErrorAction SilentlyContinue

    $env:AGENT_MONITOR_HOST = "127.0.0.1"
    $env:AGENT_MONITOR_PORT = [string]$brokerPort
    if ($DebugMode -and -not $env:AGENT_MONITOR_DEBUG) {
        $env:AGENT_MONITOR_DEBUG = "1"
    }

    if ($DebugMode) {
        $debugCommand = "title AMO Broker Debug && node `"$serverPath`""
        $startParams = @{
            FilePath = "cmd.exe"
            ArgumentList = @("/c", $debugCommand)
            WorkingDirectory = $repoRoot
            PassThru = $true
        }
        Write-Host "Starting AMO broker in a dedicated debug console..."
    } else {
        $startParams = @{
            FilePath = "node"
            ArgumentList = @($serverPath)
            WorkingDirectory = $repoRoot
            PassThru = $true
        }
        $startParams.WindowStyle = "Hidden"
        $startParams.RedirectStandardOutput = $brokerStdout
        $startParams.RedirectStandardError = $brokerStderr
        Write-Host "Starting hidden AMO broker..."
    }

    $process = Start-Process @startParams
    Wait-AmoBroker
    Write-Host "AMO broker ready at $brokerBaseUrl."
    return $process
}

function Start-AmoOverlay {
    if ($SkipOverlay) {
        Write-Host "Skipping overlay startup."
        return $null
    }

    if (-not $KeepExistingOverlay) {
        Stop-OverlayDevProcesses
        Start-Sleep -Milliseconds 500
    }
    Assert-OverlayPortReady
    New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
    Remove-Item -LiteralPath $overlayStdout, $overlayStderr -Force -ErrorAction SilentlyContinue

    $startParams = @{
        FilePath = "cmd.exe"
        ArgumentList = if ($DebugMode) { @("/k", "npm run tauri:dev") } else { @("/c", "npm run tauri:dev") }
        WorkingDirectory = $overlayPath
        PassThru = $true
    }

    if ($DebugMode) {
        Write-Host "Starting visible AMO overlay dev process..."
    } else {
        $startParams.WindowStyle = "Hidden"
        $startParams.RedirectStandardOutput = $overlayStdout
        $startParams.RedirectStandardError = $overlayStderr
        Write-Host "Starting hidden AMO overlay dev process..."
    }

    return Start-Process @startParams
}

if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "Could not find broker server: $serverPath"
}

if (-not (Test-Path -LiteralPath $overlayPath)) {
    throw "Could not find overlay folder: $overlayPath"
}

$brokerProcess = Start-AmoBroker
$overlayProcess = Start-AmoOverlay

Write-Host "AMO startup sequence complete."
Write-Host "Broker: $brokerBaseUrl"
if ($brokerProcess) {
    Write-Host "Broker pid: $($brokerProcess.Id)"
}
if ($overlayProcess) {
    Write-Host "Overlay dev pid: $($overlayProcess.Id)"
}
if (-not $DebugMode) {
    Write-Host "Broker stdout: $brokerStdout"
    Write-Host "Broker stderr: $brokerStderr"
    Write-Host "Overlay stdout: $overlayStdout"
    Write-Host "Overlay stderr: $overlayStderr"
}
