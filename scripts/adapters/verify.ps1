param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 17654
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$serverPath = Join-Path $repoRoot "broker\server.js"
$adapterPath = Join-Path $repoRoot "scripts\adapters\Send-AgentMonitorEvent.ps1"
$dataFile = Join-Path $repoRoot "broker\data\adapter-verify-sessions.json"
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
        [Parameter(Mandatory = $true)][string]$Path
    )

    Invoke-RestMethod -Method $Method -Uri "$baseUrl$Path"
}

function Wait-Broker {
    param([int]$TimeoutSeconds = 10)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-BrokerJson -Method GET -Path "/api/health"
            if ($health.ok) {
                return
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

function Send-HookEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Tool,
        [Parameter(Mandatory = $true)][hashtable]$Payload
    )

    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    $json |
        powershell -NoProfile -ExecutionPolicy Bypass -File $adapterPath `
            -Tool $Tool `
            -BrokerUrl "$baseUrl/api/events"
}

function Assert-SessionState {
    param(
        [Parameter(Mandatory = $true)][object]$Sessions,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$ExpectedState,
        [bool]$ExpectedNeedsAttention
    )

    $match = @($Sessions.sessions | Where-Object { $_.sessionId -eq $SessionId })
    if ($match.Count -ne 1) {
        throw "Expected one session '$SessionId', got $($match.Count)."
    }

    if ($match[0].state -ne $ExpectedState) {
        throw "Session '$SessionId' expected state '$ExpectedState', got '$($match[0].state)'."
    }

    if ([bool]$match[0].needsAttention -ne $ExpectedNeedsAttention) {
        throw "Session '$SessionId' expected needsAttention=$ExpectedNeedsAttention, got $($match[0].needsAttention)."
    }
}

function Wait-SessionCount {
    param([int]$ExpectedCount, [int]$TimeoutSeconds = 10)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $sessions = Invoke-BrokerJson -Method GET -Path "/api/sessions"
        if ($sessions.count -eq $ExpectedCount) {
            return $sessions
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    throw "Expected exactly $ExpectedCount adapter verification sessions, got $($sessions.count)."
}

Write-Host "Starting broker at $baseUrl for adapter verification."
Assert-PortAvailable
Clear-VerificationData
$broker = Start-Broker

try {
    Wait-Broker

    Send-HookEvent -Tool codex -Payload @{
        hook_event_name = "PermissionRequest"
        session_id = "verify-codex-permission"
        cwd = "G:\PROJECT\AgentMonitorOverlay"
        transcript_path = $null
        turn_id = "turn-verify-1"
        message = "approval needed"
    }

    Send-HookEvent -Tool claude -Payload @{
        hook_event_name = "Notification"
        notification_type = "idle_prompt"
        session_id = "verify-claude-idle"
        cwd = "G:\PROJECT\AgentMonitorOverlay"
        transcript_path = $null
        message = "Claude is waiting for user input"
    }

    # Codex permission events use the production provisional-review grace period.
    $sessions = Wait-SessionCount -ExpectedCount 2

    Assert-SessionState -Sessions $sessions -SessionId "verify-codex-permission" -ExpectedState "waiting_permission" -ExpectedNeedsAttention $true
    Assert-SessionState -Sessions $sessions -SessionId "verify-claude-idle" -ExpectedState "waiting_user" -ExpectedNeedsAttention $true
    Write-Host "Adapter verification OK:"
    $sessions.sessions |
        Select-Object tool, sessionId, state, needsAttention, lastEvent |
        Format-Table -AutoSize
}
finally {
    if ($broker -and -not $broker.HasExited) {
        Stop-Process -Id $broker.Id -Force
        $broker.WaitForExit()
    }
}
