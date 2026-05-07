param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 17654
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$testRoot = Join-Path $repoRoot "tmp\hook-live-test\codex"
$codexDir = Join-Path $testRoot ".codex"
$brokerData = Join-Path $repoRoot "broker\data\codex-live-smoke-sessions.json"
$serverPath = Join-Path $repoRoot "broker\server.js"
$baseUrl = "http://${HostName}:${Port}"

New-Item -ItemType Directory -Force -Path $codexDir | Out-Null

@"
[features]
codex_hooks = true
"@ | Set-Content -Encoding UTF8 -Path (Join-Path $codexDir "config.toml")

$hookCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$repoRoot\scripts\adapters\Send-AgentMonitorEvent.ps1`" -Tool codex -BrokerUrl `"$baseUrl/api/events`""

$hooks = [ordered]@{
    hooks = [ordered]@{
        SessionStart = @(@{ hooks = @(@{ type = "command"; command = $hookCommand; timeout = 10 }) })
        UserPromptSubmit = @(@{ hooks = @(@{ type = "command"; command = $hookCommand; timeout = 10 }) })
        Stop = @(@{ hooks = @(@{ type = "command"; command = $hookCommand; timeout = 10 }) })
    }
}
$hooks | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -Path (Join-Path $codexDir "hooks.json")

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

    $outputFile = Join-Path $testRoot "codex-output.txt"
    $prompt = "Reply with exactly: amo-codex-hook-smoke"
    $codexArgs = @(
        "exec",
        "--cd", $testRoot,
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--enable", "codex_hooks",
        "--sandbox", "read-only",
        "--output-last-message", $outputFile,
        $prompt
    )

    Write-Host "Running Codex live hook smoke in $testRoot"
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $codexOutput = & codex @codexArgs 2>&1
        $codexExit = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($codexOutput) {
        $codexOutput | ForEach-Object { Write-Host $_ }
    }
    if ($codexExit -ne 0) {
        throw "codex exec failed with exit code $codexExit"
    }

    Start-Sleep -Seconds 1
    $sessions = Invoke-BrokerJson -Path "/api/sessions"
    $codexSessions = @($sessions.sessions | Where-Object { $_.tool -eq "codex" })
    if ($codexSessions.Count -eq 0) {
        throw "No Codex sessions reached broker. Hook may not have loaded."
    }

    Write-Host "Codex live hook smoke OK:"
    $codexSessions | Select-Object tool, sessionId, state, lastEvent, needsAttention | Format-Table -AutoSize
}
finally {
    if ($broker -and -not $broker.HasExited) {
        Stop-Process -Id $broker.Id -Force
        $broker.WaitForExit()
    }
}
