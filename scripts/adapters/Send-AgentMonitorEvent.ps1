param(
    [ValidateSet("codex", "claude")]
    [string]$Tool,

    [string]$BrokerUrl = "http://127.0.0.1:17654/api/events",

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Read-StdinText {
    $reader = [Console]::In
    return $reader.ReadToEnd()
}

function Get-EventState {
    param(
        [string]$ToolName,
        [string]$EventName,
        [object]$InputObject
    )

    $normalized = if ($EventName) { $EventName.ToLowerInvariant() } else { "" }
    $notificationType = if ($InputObject.PSObject.Properties.Name -contains "notification_type") {
        [string]$InputObject.notification_type
    } else {
        ""
    }

    switch ($normalized) {
        "sessionstart" { return "starting" }
        "agentspawn" { return "starting" }
        "userpromptsubmit" { return "running" }
        "pretooluse" { return "running" }
        "posttooluse" { return "running" }
        "posttoolusefailure" { return "running" }
        "permissionrequest" { return "waiting_permission" }
        "permissiondenied" { return "waiting_permission" }
        "elicitation" { return "waiting_user" }
        "stop" { return "idle" }
        "stopfailure" { return "failed" }
        "sessionend" { return "completed" }
        "cwdchanged" { return "unknown" }
        "notification" {
            if ($notificationType -eq "permission_prompt") { return "waiting_permission" }
            if ($notificationType -eq "idle_prompt") { return "waiting_user" }
            return "unknown"
        }
        default { return "unknown" }
    }
}

function Get-NeedsAttention {
    param(
        [string]$State,
        [string]$EventName,
        [object]$InputObject
    )

    if ($State -in @("waiting_permission", "waiting_user", "failed")) {
        return $true
    }

    if (($InputObject.PSObject.Properties.Name -contains "notification_type") -and $InputObject.notification_type) {
        return $InputObject.notification_type -in @("permission_prompt", "idle_prompt", "elicitation_dialog")
    }

    return $false
}

function Get-LastMessage {
    param(
        [string]$State,
        [object]$InputObject
    )

    foreach ($name in @("prompt", "message", "title", "error", "reason", "last_assistant_message")) {
        if (($InputObject.PSObject.Properties.Name -contains $name) -and $InputObject.$name) {
            $value = [string]$InputObject.$name
            if ($value.Length -gt 240) {
                return $value.Substring(0, 240)
            }
            return $value
        }
    }

    if (($InputObject.PSObject.Properties.Name -contains "tool_input") -and $InputObject.tool_input) {
        $toolInput = $InputObject.tool_input
        if (($toolInput.PSObject.Properties.Name -contains "description") -and $toolInput.description) {
            return [string]$toolInput.description
        }
    }

    return $State
}

function Get-WindowHint {
    param(
        [string]$ToolName,
        [string]$Cwd
    )

    $projectName = $null
    if ($Cwd) {
        try {
            $projectName = Split-Path -Leaf $Cwd
        } catch {
            $projectName = $null
        }
    }

    $titlePrefix = switch ($ToolName) {
        "codex" { "Codex" }
        "claude" { "Claude" }
        default { $ToolName }
    }

    $projectSlug = if ($projectName) {
        ($projectName.ToLowerInvariant() -replace "[^a-z0-9]+", "-").Trim("-")
    } else {
        "unknown"
    }
    $sessionSlug = if ($InputObject.PSObject.Properties.Name -contains "turn_id" -and $InputObject.turn_id) {
        ([string]$InputObject.turn_id).ToLowerInvariant() -replace "[^a-z0-9]+", "-"
    } else {
        "session"
    }

    return [ordered]@{
        process       = "WindowsTerminal.exe"
        titleToken    = "[AMO:${ToolName}:${projectSlug}:${sessionSlug}]"
        titleContains = if ($projectName) { @($titlePrefix, $projectName) } else { @($titlePrefix) }
        project       = $projectName
        cwd           = $Cwd
        tool          = $ToolName
    }
}

$stdinText = Read-StdinText
if ([string]::IsNullOrWhiteSpace($stdinText)) {
    $stdinText = "{}"
}

try {
    $inputObject = $stdinText | ConvertFrom-Json
} catch {
    $inputObject = [pscustomobject]@{
        hook_event_name = "InvalidJson"
        parse_error = $_.Exception.Message
    }
}

$eventName = if ($inputObject.PSObject.Properties.Name -contains "hook_event_name") {
    [string]$inputObject.hook_event_name
} elseif ($inputObject.PSObject.Properties.Name -contains "type") {
    [string]$inputObject.type
} else {
    "unknown"
}

$cwd = if ($inputObject.PSObject.Properties.Name -contains "cwd") { [string]$inputObject.cwd } else { $PWD.Path }
$sessionId = if ($inputObject.PSObject.Properties.Name -contains "session_id") {
    [string]$inputObject.session_id
} elseif ($inputObject.PSObject.Properties.Name -contains "sessionId") {
    [string]$inputObject.sessionId
} else {
    "$Tool-$cwd"
}

$state = Get-EventState -ToolName $Tool -EventName $eventName -InputObject $inputObject
$needsAttention = Get-NeedsAttention -State $state -EventName $eventName -InputObject $inputObject

$payload = [ordered]@{
    schemaVersion = 1
    tool = $Tool
    source = "hook"
    sessionId = $sessionId
    cwd = $cwd
    eventName = $eventName
    state = $state
    needsAttention = $needsAttention
    transcriptPath = if ($inputObject.PSObject.Properties.Name -contains "transcript_path") { $inputObject.transcript_path } else { $null }
    logPath = if ($inputObject.PSObject.Properties.Name -contains "log_path") { $inputObject.log_path } else { $null }
    turnId = if ($inputObject.PSObject.Properties.Name -contains "turn_id") { $inputObject.turn_id } else { $null }
    toolName = if ($inputObject.PSObject.Properties.Name -contains "tool_name") { $inputObject.tool_name } else { $null }
    prompt = if ($eventName -eq "UserPromptSubmit" -and ($inputObject.PSObject.Properties.Name -contains "prompt")) { $inputObject.prompt } else { $null }
    lastMessage = Get-LastMessage -State $state -InputObject $inputObject
    windowHint = Get-WindowHint -ToolName $Tool -Cwd $cwd
    raw = [ordered]@{
        redacted = $true
        eventName = $eventName
    }
    observedAt = (Get-Date).ToString("o")
}

$json = $payload | ConvertTo-Json -Depth 8 -Compress

if ($DryRun) {
    $json
    exit 0
}

try {
    Invoke-RestMethod -Method Post -Uri $BrokerUrl -ContentType "application/json" -Body $json | Out-Null
} catch {
    # Observability hooks must not block the agent if the monitor is offline.
    exit 0
}

exit 0
