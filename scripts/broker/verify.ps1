param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 17654
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$serverPath = Join-Path $repoRoot "broker\server.js"
$dataFile = Join-Path $repoRoot "tmp\broker-verify-data\sessions-$Port.json"
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

    $debugInitial = Invoke-BrokerJson -Method GET -Path "/api/debug"
    if (-not $debugInitial.ok -or $debugInitial.enabled) {
        throw "Debug endpoint should start disabled by default."
    }
    $debugOn = Invoke-BrokerJson -Method POST -Path "/api/debug" -Body @{
        enabled = $true
    }
    if (-not $debugOn.enabled) {
        throw "Debug endpoint did not enable logging."
    }
    $debugLog = Invoke-BrokerJson -Method POST -Path "/api/debug/logs" -Body @{
        source = "verify"
        event = "debug-smoke"
        data = @{
            workspaceRoot = $workspaceRoot
        }
    }
    if (-not $debugLog.recorded) {
        throw "Debug log endpoint did not record while enabled."
    }
    $debugAfterLog = Invoke-BrokerJson -Method GET -Path "/api/debug?limit=5"
    $verifyEntry = @($debugAfterLog.entries | Where-Object { $_.source -eq "verify" -and $_.event -eq "debug-smoke" })[0]
    if (-not $verifyEntry) {
        throw "Debug log endpoint did not return the verify entry."
    }
    Invoke-BrokerJson -Method POST -Path "/api/debug/clear" -Body @{} | Out-Null
    $debugOff = Invoke-BrokerJson -Method POST -Path "/api/debug" -Body @{
        enabled = $false
    }
    if ($debugOff.enabled) {
        throw "Debug endpoint did not disable logging."
    }
    Write-Host "Debug endpoint OK"

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
            ".amo\obsidian-vault\.obsidian\community-plugins.json",
            ".amo\obsidian-vault\.obsidian\plugins\md-anno-tools\manifest.json",
            ".amo\obsidian-vault\.obsidian\plugins\md-anno-tools\main.js",
            ".amo\obsidian-vault\.obsidian\plugins\md-anno-tools\styles.css",
            ".amo\obsidian-vault\.obsidian\plugins\md-anno-tools\data.json",
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

    $pluginList = Get-Content -Raw -Encoding UTF8 (Join-Path $workspaceRoot ".amo\obsidian-vault\.obsidian\community-plugins.json") | ConvertFrom-Json
    if (@($pluginList) -notcontains "md-anno-tools") {
        throw "Obsidian community plugin list does not enable md-anno-tools."
    }
    $pluginData = Get-Content -Raw -Encoding UTF8 (Join-Path $workspaceRoot ".amo\obsidian-vault\.obsidian\plugins\md-anno-tools\data.json") | ConvertFrom-Json
    if ($pluginData.bridgeUrl -ne $baseUrl) {
        throw "Obsidian plugin bridgeUrl mismatch. Expected $baseUrl, got $($pluginData.bridgeUrl)."
    }
    $pluginMain = Get-Content -Raw -Encoding UTF8 (Join-Path $workspaceRoot ".amo\obsidian-vault\.obsidian\plugins\md-anno-tools\main.js")
    if ($pluginMain -notmatch "/api/obsidian/annotations") {
        throw "Obsidian plugin main.js does not reference the AMO annotation endpoint."
    }
    if ($pluginMain -notmatch "/api/debug/logs" -or $pluginMain -notmatch "debugLog") {
        throw "Obsidian plugin main.js does not include AMO debug logging."
    }
    if ($pluginMain -notmatch "registerObsidianProtocolHandler" -or $pluginMain -notmatch "amo-open") {
        throw "Obsidian plugin main.js does not register the AMO tab-reuse open protocol."
    }
    if ($pluginMain -notmatch "Quote selection into \[!anno\]" -or $pluginMain -notmatch "formatMarkdownQuote") {
        throw "Obsidian plugin main.js does not include quote-style annotation insertion."
    }
    if ($pluginMain -notmatch "getSelectedCanvasMarkdownFile" -or $pluginMain -notmatch "Canvas selection") {
        throw "Obsidian plugin main.js does not include canvas-selected note targeting."
    }
    if ($pluginMain -notmatch "ensureCanvasTargetTracking" -or $pluginMain -notmatch "canvasFilePathFromEventTarget") {
        throw "Obsidian plugin main.js does not include canvas click target tracking."
    }
    if ($pluginMain -notmatch "MarkdownRenderChild" -or $pluginMain -notmatch "renderNestedMarkdown" -or $pluginMain -notmatch "getSectionInfo") {
        throw "Obsidian plugin annotation rendering does not use Obsidian-managed markdown render children."
    }
    if ($pluginMain -notmatch "render\.legacy_section" -or $pluginMain -notmatch "parseLegacyAnnotationBlocks" -or $pluginMain -notmatch "LegacyAnnotationHiddenSectionRenderChild") {
        throw "Obsidian plugin annotation rendering does not include source-backed legacy annotation section rendering."
    }
    if ($pluginMain -notmatch "CanvasNoteTargetModal" -or $pluginMain -notmatch "chooseCanvasMarkdownFile") {
        throw "Obsidian plugin main.js does not include explicit canvas note fallback selection."
    }
    if ($pluginMain -notmatch "allowRemembered: false") {
        throw "Obsidian plugin main.js does not prefer current canvas selection before remembered targets."
    }
    if ($pluginMain -notmatch "lastCanvasView" -or $pluginMain -notmatch "isActiveLeafAmoPanel") {
        throw "Obsidian plugin main.js does not preserve canvas target context while the AMO panel is active."
    }
    if ($pluginMain -notmatch "panel.copy.clicked" -or $pluginMain -notmatch "copyAnnotationsFromFile\(info\.file\)") {
        throw "Obsidian plugin panel copy action does not use the currently displayed note."
    }
    if ($pluginMain -notmatch "schedulePanelRefresh" -or $pluginMain -notmatch "refreshPanels: false") {
        throw "Obsidian plugin panel refresh is not guarded against canvas-selection render recursion."
    }
    if ($pluginMain -notmatch "data-amo-annotation" -or $pluginMain -notmatch "createAnnotationRichShell") {
        throw "Obsidian plugin annotation rendering does not create plugin-owned rich annotation shells."
    }
    $pluginStyles = Get-Content -Raw -Encoding UTF8 (Join-Path $workspaceRoot ".amo\obsidian-vault\.obsidian\plugins\md-anno-tools\styles.css")
    if ($pluginStyles -notmatch "anno-token-rich" -or $pluginStyles -notmatch "amo-canvas-note-list") {
        throw "Obsidian plugin styles.css does not include rich annotation block styles."
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
    $firstCanvasNode = @($canvas.nodes | Where-Object { $_.id -eq $reply.canvasNodeId })[0]
    if (-not $firstCanvasNode) {
        throw "Canvas is missing the first reply node id: $($reply.canvasNodeId)"
    }
    if (@($canvas.edges).Count -ne 0) {
        throw "First reply should not create a canvas edge."
    }

    $reply2 = Invoke-BrokerJson -Method POST -Path "/api/replies" -Body @{
        schemaVersion = 1
        tool = "codex"
        source = "codex-stop-hook"
        sessionId = "codex-reply-verify"
        turnId = "turn-reply-verify-2"
        cwd = $workspaceRoot
        model = "verify-model"
        hookEventName = "Stop"
        capturedAt = "2026-05-16T00:01:00.000Z"
        message = "Second verification assistant reply."
    }
    if (-not $reply2.ok) {
        throw "Second reply endpoint failed."
    }

    $canvasAfterSecondReply = Get-Content -Raw -Encoding UTF8 $canvasPath | ConvertFrom-Json
    if (@($canvasAfterSecondReply.nodes).Count -ne 2) {
        throw "Expected exactly 2 canvas nodes after two replies, got $(@($canvasAfterSecondReply.nodes).Count)."
    }
    $secondCanvasNode = @($canvasAfterSecondReply.nodes | Where-Object { $_.id -eq $reply2.canvasNodeId })[0]
    if (-not $secondCanvasNode) {
        throw "Canvas is missing the second reply node id: $($reply2.canvasNodeId)"
    }
    if ([int]$secondCanvasNode.y -ne [int]$firstCanvasNode.y -or [int]$secondCanvasNode.x -le [int]$firstCanvasNode.x) {
        throw "Second reply node should be placed to the right on the same session row."
    }
    $chainEdge = @($canvasAfterSecondReply.edges | Where-Object { $_.fromNode -eq $reply.canvasNodeId -and $_.toNode -eq $reply2.canvasNodeId })[0]
    if (-not $chainEdge) {
        throw "Canvas did not create an edge from first reply node to second reply node."
    }
    $bindings = Get-Content -Raw -Encoding UTF8 (Join-Path $workspaceRoot ".amo\state\bindings.json") | ConvertFrom-Json
    $replyBinding = $bindings.sessions.PSObject.Properties["codex-reply-verify"].Value
    if (-not $replyBinding -or $replyBinding.lastCanvasNodeId -ne $reply2.canvasNodeId -or [int]$replyBinding.nodeCount -ne 2) {
        throw "Session canvas binding was not updated to the second reply node."
    }
    Write-Host "Reply canvas chain OK -> $($reply.canvasNodeId) -> $($reply2.canvasNodeId)"

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
    if (-not $replySession.obsidianPluginHealth -or -not $replySession.obsidianPluginHealth.ok) {
        $issues = @($replySession.obsidianPluginHealth.issues) -join "; "
        throw "Reply session Obsidian plugin health is not OK: $issues"
    }
    Write-Host "Reply bridge OK -> $($reply.notePath)"

    $annotationResult = Invoke-BrokerJson -Method POST -Path "/api/obsidian/annotations" -Body @{
        schemaVersion = 1
        source = "verify-obsidian-plugin"
        vaultRoot = $vaultRoot
        notePath = $reply2.notePath
        sessionId = "codex-reply-verify"
        turnId = "turn-reply-verify-2"
        annotations = @(
            @{
                index = 1
                content = "Please continue from this verification note."
            }
        )
    }
    if (-not $annotationResult.ok -or -not $annotationResult.pendingPromptId -or -not $annotationResult.prompt) {
        throw "Annotation endpoint did not return a pending prompt."
    }
    $expectedPrompt = "1. Please continue from this verification note.`n"
    if ($annotationResult.prompt -ne $expectedPrompt) {
        throw "Annotation prompt included unexpected broker-added text. Expected '$expectedPrompt', got '$($annotationResult.prompt)'."
    }

    $syncBack = Invoke-BrokerJson -Method POST -Path "/api/sync-back" -Body @{
        sessionId = "codex-reply-verify"
        pendingPromptId = $annotationResult.pendingPromptId
        action = "copy-focus"
    }
    if (-not $syncBack.ok -or -not $syncBack.copiedAt) {
        throw "Sync-back endpoint did not mark the prompt as copied."
    }
    Write-Host "Annotation sync-back OK -> $($annotationResult.pendingPromptId)"

    $windowBinding = Invoke-BrokerJson -Method POST -Path "/api/sessions/codex-reply-verify/window-binding" -Body @{
        hwnd = 123456
        processId = 654321
        processName = "WindowsTerminal"
        title = "Verify Codex"
        label = "WindowsTerminal - Verify Codex"
    }
    if (-not $windowBinding.ok -or $windowBinding.session.windowHint.hwnd -ne 123456 -or $windowBinding.session.windowHint.pid -ne 654321) {
        throw "Window binding endpoint did not persist hwnd/processId."
    }

    $windowUnbind = Invoke-BrokerJson -Method POST -Path "/api/sessions/codex-reply-verify/window-binding/clear" -Body @{}
    if (-not $windowUnbind.ok -or $null -ne $windowUnbind.session.windowHint.hwnd -or $null -ne $windowUnbind.session.windowHint.pid) {
        throw "Window binding clear endpoint did not remove exact hwnd/processId hints."
    }
    Write-Host "Window binding OK -> bind/clear"

    $recoveredAnnotation = Invoke-BrokerJson -Method POST -Path "/api/obsidian/annotations" -Body @{
        schemaVersion = 1
        source = "verify-obsidian-plugin"
        vaultRoot = $vaultRoot
        notePath = $reply.notePath
        sessionId = "codex-recovered-from-note-verify"
        turnId = "turn-recovered-from-note"
        annotations = @(
            @{
                index = 1
                content = "Recover a missing broker session from the AMO note metadata."
            }
        )
    }
    if (-not $recoveredAnnotation.ok -or -not $recoveredAnnotation.session -or -not $recoveredAnnotation.session.lastReplyNote) {
        throw "Annotation endpoint did not recover a missing session from note metadata."
    }
    Write-Host "Recovered annotation session OK -> $($recoveredAnnotation.sessionId)"
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
    if ($sessionsAfterRestart.count -ne 5) {
        throw "Persistence check failed. Expected exactly 5 sessions after restart, got $($sessionsAfterRestart.count)."
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
