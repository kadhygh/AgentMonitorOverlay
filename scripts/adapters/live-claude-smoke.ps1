param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 17654
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$testRoot = Join-Path $repoRoot "tmp\hook-live-test\claude"
$settingsPath = Join-Path $testRoot "claude-settings.local.json"
$brokerData = Join-Path $repoRoot "broker\data\claude-live-smoke-sessions.json"
$serverPath = Join-Path $repoRoot "broker\server.js"
$baseUrl = "http://${HostName}:${Port}"

New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

$hookCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$repoRoot\scripts\adapters\Send-AgentMonitorEvent.ps1`" -Tool claude -BrokerUrl `"$baseUrl/api/events`""
$settings = [ordered]@{
    hooks = [ordered]@{
        SessionStart = @(@{ hooks = @(@{ type = "command"; command = $hookCommand; timeout = 10 }) })
        UserPromptSubmit = @(@{ hooks = @(@{ type = "command"; command = $hookCommand; timeout = 10 }) })
        Stop = @(@{ hooks = @(@{ type = "command"; command = $hookCommand; timeout = 10 }) })
    }
}
$settings | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -Path $settingsPath

function Invoke-BrokerJson {
    param([string]$Path)
    Invoke-RestMethod -Method GET -Uri "$baseUrl$Path"
}

function Wait-Broker {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-BrokerJson -Path "/api/health"
            if ($health.ok) { return }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    throw "Broker did not become healthy at $baseUrl."
}

$env:AGENT_MONITOR_HOST = $HostName
$env:AGENT_MONITOR_PORT = [string]$Port
$env:AGENT_MONITOR_DATA_FILE = $brokerData
$broker = Start-Process -FilePath "node" -ArgumentList @($serverPath) -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden

try {
    Wait-Broker

    Write-Host "Running Claude live hook smoke in $testRoot"
    Push-Location $testRoot
    try {
        $claudeOutput = & claude -p "Reply with exactly: amo-claude-hook-smoke" `
            --settings $settingsPath `
            --output-format text `
            --permission-mode dontAsk 2>&1
        $claudeExit = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($claudeExit -ne 0) {
        Write-Warning "claude -p failed. Re-run manually for full provider output if needed."
        throw "claude -p failed with exit code $claudeExit"
    }

    Start-Sleep -Seconds 1
    $sessions = Invoke-BrokerJson -Path "/api/sessions"
    $claudeSessions = @($sessions.sessions | Where-Object { $_.tool -eq "claude" })
    if ($claudeSessions.Count -eq 0) {
        throw "No Claude sessions reached broker. Hook may not have loaded."
    }

    Write-Host "Claude live hook smoke OK:"
    $claudeSessions | Select-Object tool, sessionId, state, lastEvent, needsAttention | Format-Table -AutoSize
}
finally {
    if ($broker -and -not $broker.HasExited) {
        Stop-Process -Id $broker.Id -Force
        $broker.WaitForExit()
    }
}
