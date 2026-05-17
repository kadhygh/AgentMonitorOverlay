param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 17654
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$serverPath = Join-Path $repoRoot "broker\server.js"
$dataFile = Join-Path $repoRoot "broker\data\sessions.json"
$workspaceRoot = Join-Path $repoRoot "tmp\broker-verify-workspace"
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

function Reset-VerificationWorkspace {
    $tmpRoot = Join-Path $repoRoot "tmp"
    New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null

    if (Test-Path -LiteralPath $workspaceRoot) {
        $resolvedTmp = (Resolve-Path -LiteralPath $tmpRoot).Path
        $resolvedWorkspace = (Resolve-Path -LiteralPath $workspaceRoot).Path
        if (-not $resolvedWorkspace.StartsWith($resolvedTmp, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove workspace outside tmp: $resolvedWorkspace"
        }
        Remove-Item -LiteralPath $resolvedWorkspace -Recurse -Force
    }

    New-Item -ItemType Directory -Path $workspaceRoot -Force | Out-Null
    Set-Content -Path (Join-Path $workspaceRoot "package.json") -Value "{}" -Encoding UTF8
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
Reset-VerificationWorkspace
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

    $inspect = Invoke-BrokerJson -Method POST -Path "/api/workspaces/inspect" -Body @{
        workspacePath = $workspaceRoot
    }
    if (-not $inspect.ok) {
        throw "Workspace inspect failed."
    }
    if (Test-Path -LiteralPath (Join-Path $workspaceRoot ".amo")) {
        throw "Workspace inspect should not write .amo."
    }
    $codexPlan = @($inspect.supportedAdapters | Where-Object { $_.id -eq "codex-cli" })[0]
    if (-not $codexPlan -or $codexPlan.status -ne "available") {
        throw "Expected codex-cli inspect plan to be available."
    }
    Write-Host "Workspace inspect OK -> $($inspect.workspacePath)"

    $enroll = Invoke-BrokerJson -Method POST -Path "/api/workspaces/enroll" -Body @{
        workspacePath = $workspaceRoot
        adapters = @("codex-cli")
    }
    if (-not $enroll.ok) {
        throw "Workspace enroll failed."
    }

    foreach ($relativePath in @(
            ".amo\workspace.json",
            ".amo\enrollment.json",
            ".amo\adapters\codex-cli.json",
            ".amo\hooks\codex-stop-message.mjs",
            ".amo\obsidian-vault\AgentFlow.canvas",
            ".codex\hooks.json"
        )) {
        $targetPath = Join-Path $workspaceRoot $relativePath
        if (-not (Test-Path -LiteralPath $targetPath)) {
            throw "Expected enrolled file missing: $relativePath"
        }
    }

    $codexHooksText = Get-Content -Raw -Encoding UTF8 (Join-Path $workspaceRoot ".codex\hooks.json")
    if ($codexHooksText -notmatch "codex-stop-message\.mjs") {
        throw "Codex hooks config does not reference AMO hook script."
    }
    Write-Host "Workspace enroll OK -> $($enroll.workspaceId)"

    $reply = Invoke-BrokerJson -Method POST -Path "/api/replies" -Body @{
        schemaVersion = 1
        tool = "codex"
        source = "codex-stop-hook"
        sessionId = "codex-reply-verify"
        turnId = "turn-reply-verify"
        cwd = $workspaceRoot
        model = "verify-model"
        hookEventName = "Stop"
        capturedAt = "2026-05-16T00:00:00.000Z"
        message = "Verification assistant reply."
    }
    if (-not $reply.ok) {
        throw "Reply endpoint failed."
    }

    $vaultRoot = Join-Path $workspaceRoot ".amo\obsidian-vault"
    $noteRelative = $reply.notePath -replace "/", [System.IO.Path]::DirectorySeparatorChar
    $notePath = Join-Path $vaultRoot $noteRelative
    if (-not (Test-Path -LiteralPath $notePath)) {
        throw "Reply note was not created: $notePath"
    }
    $canvasPath = Join-Path $vaultRoot "AgentFlow.canvas"
    $canvas = Get-Content -Raw -Encoding UTF8 $canvasPath | ConvertFrom-Json
    if (@($canvas.nodes).Count -lt 1) {
        throw "Canvas did not receive a reply file node."
    }

    $sessionsAfterReply = Invoke-BrokerJson -Method GET -Path "/api/sessions"
    if ($sessionsAfterReply.count -ne 4) {
        throw "Expected 4 sessions after reply, got $($sessionsAfterReply.count)."
    }
    $replySession = @($sessionsAfterReply.sessions | Where-Object { $_.sessionId -eq "codex-reply-verify" })[0]
    if (-not $replySession.lastReplyNote -or -not $replySession.canvasPath) {
        throw "Reply session is missing lastReplyNote or canvasPath."
    }
    if (-not $replySession.lastReplyNoteAbsolutePath -or -not $replySession.canvasAbsolutePath) {
        throw "Reply session is missing absolute note/canvas paths for overlay open actions."
    }
    Write-Host "Reply bridge OK -> $($reply.notePath)"
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
    if ($sessionsAfterRestart.count -ne 4) {
        throw "Persistence check failed. Expected exactly 4 sessions after restart, got $($sessionsAfterRestart.count)."
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
