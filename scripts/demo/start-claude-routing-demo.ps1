param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 17654,
    [switch]$SkipOverlay
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$baseUrl = "http://${HostName}:${Port}"
$brokerData = Join-Path $repoRoot "broker\data\demo-sessions.json"
$serverPath = Join-Path $repoRoot "broker\server.js"
$overlayPath = Join-Path $repoRoot "overlay"
$overlayStdout = Join-Path $repoRoot "tmp\overlay-demo.out.log"
$overlayStderr = Join-Path $repoRoot "tmp\overlay-demo.err.log"
$demoTitleToken = "[AMO:claude:agent-monitor-overlay:live-demo]"
$demoWindowTitle = "$demoTitleToken Claude - AgentMonitorOverlay - Live demo"

function Test-BrokerHealthy {
    try {
        $health = Invoke-RestMethod -Method GET -Uri "$baseUrl/api/health" -TimeoutSec 2
        return [bool]($health.ok -and $health.service -eq "agent-monitor-broker")
    } catch {
        return $false
    }
}

function Stop-BrokerOnPort {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $process) {
            continue
        }

        if ($process.Name -ieq "node.exe" -or $process.CommandLine -like "*broker/server.js*" -or $process.CommandLine -like "*broker\server.js*") {
            Stop-Process -Id $process.ProcessId -Force
        } else {
            throw "Port $Port is already used by PID $($process.ProcessId): $($process.Name)."
        }
    }
}

function Stop-OverlayDevProcesses {
    $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.CommandLine -like "*AgentMonitorOverlay\overlay*" -and $_.CommandLine -like "*vite\bin\vite.js*") -or
            ($_.CommandLine -like "*AgentMonitorOverlay\overlay*" -and $_.CommandLine -like "*@tauri-apps\cli\tauri.js* dev*") -or
            ($_.CommandLine -like "*AgentMonitorOverlay\overlay*" -and $_.CommandLine -like "*npm run dev*") -or
            ($_.CommandLine -like "*AgentMonitorOverlay\overlay*" -and $_.CommandLine -like "*npm run tauri:dev*") -or
            ($_.CommandLine -like "*AgentMonitorOverlay\overlay\src-tauri*" -and $_.CommandLine -like "*cargo* run*") -or
            ($_.CommandLine -like "*target\debug\agent-monitor-overlay.exe*")
        }

    foreach ($target in $targets) {
        try {
            Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Warning "Failed to stop overlay dev process $($target.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Stop-DemoWindows {
    $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -ieq "powershell.exe" -and
            ($_.CommandLine -like "*agent-monitor-overlay:live-demo*" -or
                $_.CommandLine -like "*Agent Monitor Overlay routing demo*")
        }

    foreach ($target in $targets) {
        try {
            Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Warning "Failed to stop demo window process $($target.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Start-Broker {
    Stop-BrokerOnPort
    Start-Sleep -Milliseconds 300

    $env:AGENT_MONITOR_HOST = $HostName
    $env:AGENT_MONITOR_PORT = [string]$Port
    $env:AGENT_MONITOR_DATA_FILE = $brokerData

    Start-Process -FilePath "node" `
        -ArgumentList @($serverPath) `
        -WorkingDirectory $repoRoot `
        -PassThru `
        -WindowStyle Hidden
}

function Wait-Broker {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (Test-BrokerHealthy) {
            return
        }

        Start-Sleep -Milliseconds 250
    }

    throw "Broker did not become healthy at $baseUrl."
}

function Publish-DemoEvents {
    param(
        [Parameter(Mandatory = $true)][string]$RouteProcessName,
        [Parameter(Mandatory = $true)][int]$RoutePid,
        [object]$DemoHwnd = $null
    )

    $events = @(
        [ordered]@{
            tool = "claude"
            sessionId = "claude-live-demo"
            cwd = "G:\PROJECT\AgentMonitorOverlay"
            title = "Claude - AgentMonitorOverlay Live Demo"
            event = "UserPromptSubmit"
            state = "running"
            message = "Claude live hook smoke reached broker; click this row to route to the demo window."
            needsAttention = $false
            windowHint = [ordered]@{
                process = $RouteProcessName
                title = $demoWindowTitle
                titleToken = $demoTitleToken
                titleContains = @("Claude", "AgentMonitorOverlay", "Live demo")
                project = "AgentMonitorOverlay"
                cwd = "G:\PROJECT\AgentMonitorOverlay"
                tool = "claude"
                pid = $RoutePid
                hwnd = $DemoHwnd
            }
        },
        [ordered]@{
            tool = "claude"
            sessionId = "claude-permission-demo"
            cwd = "G:\PROJECT\AgentMonitorOverlay"
            title = "Claude - Permission Demo"
            event = "PermissionRequest"
            state = "waiting_permission"
            message = "Demo waiting-permission state for overlay attention styling."
            needsAttention = $true
            windowHint = [ordered]@{
                process = $RouteProcessName
                title = $demoWindowTitle
                titleToken = $demoTitleToken
                titleContains = @("Claude", "AgentMonitorOverlay", "Live demo")
                project = "AgentMonitorOverlay"
                cwd = "G:\PROJECT\AgentMonitorOverlay"
                tool = "claude"
                pid = $RoutePid
                hwnd = $DemoHwnd
            }
        }
    )

    foreach ($event in $events) {
        $json = $event | ConvertTo-Json -Depth 12
        Invoke-RestMethod -Method POST -Uri "$baseUrl/api/events" -ContentType "application/json" -Body $json | Out-Null
    }
}

function Get-DemoRouteTarget {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process
    )

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $consoleHost = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($Process.Id)" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ieq "conhost.exe" } |
            Select-Object -First 1

        if ($consoleHost) {
            return [pscustomobject]@{
                ProcessName = "conhost.exe"
                Pid = [int]$consoleHost.ProcessId
                Hwnd = $null
            }
        }

        Start-Sleep -Milliseconds 200
    }

    $Process.Refresh()
    $hwnd = if ($Process.MainWindowHandle -ne [IntPtr]::Zero) {
        $Process.MainWindowHandle.ToInt64()
    } else {
        $null
    }

    return [pscustomobject]@{
        ProcessName = "powershell.exe"
        Pid = [int]$Process.Id
        Hwnd = $hwnd
    }
}

function Start-DemoWindow {
    $command = @"
`$Host.UI.RawUI.WindowTitle = '$demoWindowTitle'
Write-Host 'Agent Monitor Overlay routing demo window'
Write-Host '$demoWindowTitle'
Write-Host ''
Write-Host 'Leave this window open. Click the Claude demo row in the overlay to route back here.'
while (`$true) { Start-Sleep -Seconds 60 }
"@

    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
        -WorkingDirectory $repoRoot `
        -PassThru
}

function Start-Overlay {
    if ($SkipOverlay) {
        return $null
    }

    Stop-OverlayDevProcesses
    Start-Sleep -Milliseconds 300

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $overlayStdout) | Out-Null
    Remove-Item -LiteralPath $overlayStdout, $overlayStderr -Force -ErrorAction SilentlyContinue

    Start-Process -FilePath "cmd.exe" `
        -ArgumentList @("/c", "npm", "run", "tauri:dev") `
        -WorkingDirectory $overlayPath `
        -RedirectStandardOutput $overlayStdout `
        -RedirectStandardError $overlayStderr `
        -WindowStyle Hidden `
        -PassThru
}

Stop-DemoWindows
Remove-Item -LiteralPath $brokerData -Force -ErrorAction SilentlyContinue
$brokerProcess = Start-Broker
Wait-Broker
$demoWindow = Start-DemoWindow
$routeTarget = Get-DemoRouteTarget -Process $demoWindow
Publish-DemoEvents -RouteProcessName $routeTarget.ProcessName -RoutePid $routeTarget.Pid -DemoHwnd $routeTarget.Hwnd
$overlayProcess = Start-Overlay

Write-Host "Demo is ready."
Write-Host "Broker: $baseUrl"
Write-Host "Demo title token: $demoTitleToken"
Write-Host "Demo window process id: $($demoWindow.Id)"
Write-Host "Demo route process: $($routeTarget.ProcessName) pid=$($routeTarget.Pid)"
if ($routeTarget.Hwnd) {
    Write-Host ("Demo window handle: 0x{0:X}" -f $routeTarget.Hwnd)
}
if ($overlayProcess) {
    Write-Host "Overlay dev process id: $($overlayProcess.Id)"
    Write-Host "Overlay stdout log: $overlayStdout"
    Write-Host "Overlay stderr log: $overlayStderr"
}
if ($brokerProcess) {
    Write-Host "Broker process id: $($brokerProcess.Id)"
}
Write-Host "When finished, close the overlay and demo PowerShell window. Broker can be stopped from Task Manager or by closing its node process."
