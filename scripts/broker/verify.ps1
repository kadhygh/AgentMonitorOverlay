param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 17654
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$serverPath = Join-Path $repoRoot "broker\server.js"
$dataFile = Join-Path $repoRoot "broker\data\sessions.json"
$baseUrl = "http://${HostName}:${Port}"

function Assert-PortAvailable {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        return
    }

    $owners = foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if ($process) {
            "$($process.Name) pid=$($process.ProcessId)"
        } else {
            "pid=$($listener.OwningProcess)"
        }
    }

    throw "Port $Port is already in use ($($owners -join '; ')). Stop that process or run this script with -Port <free port>."
}

function Clear-VerificationData {
    $dataDir = Split-Path -Parent $dataFile
    $dataName = Split-Path -Leaf $dataFile

    Remove-Item -LiteralPath $dataFile -Force -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $dataDir) {
        Get-ChildItem -LiteralPath $dataDir -Filter "$dataName.*.tmp" -File -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-BrokerJson {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [object]$Body = $null
    )

    $params = @{
        Method = $Method
        Uri = "$baseUrl$Path"
    }

    if ($null -ne $Body) {
        $params.ContentType = "application/json; charset=utf-8"
        $params.Body = ($Body | ConvertTo-Json -Depth 12)
    }

    Invoke-RestMethod @params
}

function Wait-Broker {
    param([int]$TimeoutSeconds = 10)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-BrokerJson -Method GET -Path "/api/health"
            if ($health.ok) {
                return $health
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    throw "Broker did not become healthy at $baseUrl within $TimeoutSeconds seconds."
}

function Start-Broker {
    $env:AGENT_MONITOR_HOST = $HostName
    $env:AGENT_MONITOR_PORT = [string]$Port
    $env:AGENT_MONITOR_DATA_FILE = $dataFile

    Start-Process -FilePath "node" `
        -ArgumentList @($serverPath) `
        -WorkingDirectory $repoRoot `
        -PassThru `
        -WindowStyle Hidden
}

Write-Host "Starting broker at $baseUrl"
Assert-PortAvailable
Clear-VerificationData
$broker = Start-Broker

try {
    $health = Wait-Broker
    Write-Host "Health OK. Storage: $($health.storage)"

    $eventFiles = @(
        "examples\events\codex-post-tool-use.json",
        "examples\events\claude-permission.json",
        "examples\events\kiro-agent-request.json"
    )

    foreach ($relativePath in $eventFiles) {
        $eventPath = Join-Path $repoRoot $relativePath
        $event = Get-Content -Raw -Encoding UTF8 $eventPath | ConvertFrom-Json
        $result = Invoke-BrokerJson -Method POST -Path "/api/events" -Body $event
        Write-Host "Posted $relativePath -> $($result.session.sessionId) [$($result.session.state)]"
    }

    $heartbeat = Invoke-BrokerJson `
        -Method POST `
        -Path "/api/sessions/codex-demo-001/heartbeat" `
        -Body @{ message = "Heartbeat from verification script"; state = "running" }
    Write-Host "Heartbeat OK -> $($heartbeat.session.sessionId) at $($heartbeat.session.heartbeatAt)"

    $sessions = Invoke-BrokerJson -Method GET -Path "/api/sessions"
    if ($sessions.count -ne 3) {
        throw "Expected exactly 3 sessions, got $($sessions.count)."
    }

    $tools = @($sessions.sessions | ForEach-Object { $_.tool })
    foreach ($tool in @("codex", "claude", "kiro")) {
        if ($tools -notcontains $tool) {
            throw "Missing expected tool session: $tool"
        }
    }

    Write-Host "Session list OK:"
    $sessions.sessions | Select-Object tool, sessionId, state, lastEvent, needsAttention, updatedAt | Format-Table -AutoSize
}
finally {
    if ($broker -and -not $broker.HasExited) {
        Stop-Process -Id $broker.Id -Force
        $broker.WaitForExit()
    }
}

Write-Host "Restarting broker to verify persisted last-known state."
$broker = Start-Broker

try {
    Wait-Broker | Out-Null
    $sessionsAfterRestart = Invoke-BrokerJson -Method GET -Path "/api/sessions"
    if ($sessionsAfterRestart.count -ne 3) {
        throw "Persistence check failed. Expected exactly 3 sessions after restart, got $($sessionsAfterRestart.count)."
    }

    Write-Host "Persistence OK. Sessions after restart: $($sessionsAfterRestart.count)"
}
finally {
    if ($broker -and -not $broker.HasExited) {
        Stop-Process -Id $broker.Id -Force
        $broker.WaitForExit()
    }
}

Write-Host "Broker verification completed."
