param(
    [string]$VaultPath = "..\AgentMonitorOverlay-obsidian-test-vault",
    [string]$SessionId = "manual-demo-session",
    [string]$Tool = "codex",
    [string]$Cwd = "D:\Projects\commonproject\AgentMonitorOverlay-obsidian-spike",
    [string]$Project = "AgentMonitorOverlay",
    [string]$Title = "Codex - AgentMonitorOverlay Obsidian Spike",
    [string]$State = "running",
    [string]$LastEvent = "manual-request",
    [string]$LastMessage = "Manual disposable request from scripts/obsidian.",
    [switch]$OpenObsidian
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$resolvedVaultPath = Resolve-Path -Path (Join-Path $repoRoot $VaultPath)
$inboxDir = Join-Path $resolvedVaultPath ".amo\inbox"
New-Item -ItemType Directory -Force -Path $inboxDir | Out-Null

$requestId = "manual-{0}" -f ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$now = (Get-Date).ToUniversalTime().ToString("o")
$request = [ordered]@{
    schemaVersion = 1
    action = "create-linked-note"
    requestId = $requestId
    requestedAt = $now
    source = "agent-monitor-overlay"
    session = [ordered]@{
        sessionId = $SessionId
        tool = $Tool
        cwd = $Cwd
        project = $Project
        title = $Title
        state = $State
        lastEvent = $LastEvent
        lastMessage = $LastMessage
        updatedAt = $now
        windowHint = [ordered]@{
            title = $Title
            process = "WindowsTerminal.exe"
            pid = $null
            hwnd = $null
        }
    }
}

$requestPath = Join-Path $inboxDir ("create-linked-note-{0}.json" -f $requestId)
$request | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $requestPath -Encoding UTF8

Write-Output "Wrote AMO request: $requestPath"

if ($OpenObsidian) {
    Start-Process ("obsidian://amo-create-note?requestId={0}" -f [uri]::EscapeDataString($requestId))
}
