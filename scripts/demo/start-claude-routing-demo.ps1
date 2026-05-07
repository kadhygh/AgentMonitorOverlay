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
$demoTitleToken = "[AMO:claude:agent-monitor-overlay:live-demo]"
$demoWindowTitle = "$demoTitleToken Claude - AgentMonitorOverlay - Live demo"

function Start-Broker {
    $existing = Get-CimInstance Win32_Process |
        Where-Object {
            $_.CommandLine -like "*AgentMonitorOverlay*broker*server.js*" -or
            $_.CommandLine -like "*broker/server.js*" -or
            $_.CommandLine -like "*broker\\server.js*"
        }

    if ($existing) {
        Write-Host "Broker appears to already be running."
        return $null
    }

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
        try {
            $health = Invoke-RestMethod -Method GET -Uri "$baseUrl/api/health"
            if ($health.ok) {
                return
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    throw "Broker did not become healthy at $baseUrl."
}

function Publish-DemoEvents {
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
                process = "WindowsTerminal.exe"
                title = $demoWindowTitle
                titleToken = $demoTitleToken
                titleContains = @("Claude", "AgentMonitorOverlay", "Live demo")
                project = "AgentMonitorOverlay"
                cwd = "G:\PROJECT\AgentMonitorOverlay"
                tool = "claude"
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
                process = "WindowsTerminal.exe"
                title = $demoWindowTitle
                titleToken = $demoTitleToken
                titleContains = @("Claude", "AgentMonitorOverlay", "Live demo")
                project = "AgentMonitorOverlay"
                cwd = "G:\PROJECT\AgentMonitorOverlay"
                tool = "claude"
            }
        }
    )

    foreach ($event in $events) {
        $json = $event | ConvertTo-Json -Depth 12
        Invoke-RestMethod -Method POST -Uri "$baseUrl/api/events" -ContentType "application/json" -Body $json | Out-Null
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

    Start-Process -FilePath "npm" `
        -ArgumentList @("run", "tauri:dev") `
        -WorkingDirectory $overlayPath `
        -PassThru
}

$brokerProcess = Start-Broker
Wait-Broker
Publish-DemoEvents
$demoWindow = Start-DemoWindow
$overlayProcess = Start-Overlay

Write-Host "Demo is ready."
Write-Host "Broker: $baseUrl"
Write-Host "Demo title token: $demoTitleToken"
Write-Host "Demo window process id: $($demoWindow.Id)"
if ($overlayProcess) {
    Write-Host "Overlay dev process id: $($overlayProcess.Id)"
}
if ($brokerProcess) {
    Write-Host "Broker process id: $($brokerProcess.Id)"
}
Write-Host "When finished, close the overlay and demo PowerShell window. Broker can be stopped from Task Manager or by closing its node process."
