param(
    [Parameter(Mandatory = $true)][string]$PortableRoot,
    [int]$TimeoutSeconds = 25
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $PortableRoot).Path
$appPath = Join-Path $root "AMO.exe"
$expectedBrokerScript = Join-Path $root "app\broker\server.js"
$expectedNode = Join-Path $root "runtime\node.exe"
$expectedDataFile = Join-Path $root "data\sessions.json"
$frontendReadyFile = Join-Path $root "data\smoke-frontend-ready"
$baseUrl = "http://127.0.0.1:17654"
$appProcess = $null
$brokerProcess = $null
function Get-ListeningProcessId {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutMilliseconds = 2000
    )
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Join-Path $env:SystemRoot "System32\netstat.exe"
    $startInfo.Arguments = "-ano -p TCP"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch {}
            throw "Timed out while resolving listener for port $Port."
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        $ownerIds = @($stdout -split "`r?`n" | ForEach-Object {
            if ($_ -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and [int]$Matches[1] -eq $Port) {
                [int]$Matches[2]
            }
        } | Sort-Object -Unique)
        if ($ownerIds.Count -gt 1) { throw "Multiple listeners reported for port ${Port}: $($ownerIds -join ', ')" }
        return $ownerIds | Select-Object -First 1
    } finally {
        $process.Dispose()
    }
}

foreach ($required in @($appPath, $expectedBrokerScript, $expectedNode)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Portable smoke missing required file: $required" }
}

$listenerPid = Get-ListeningProcessId -Port 17654
if ($listenerPid) { throw "Portable cold smoke requires port 17654 to be free (listener pid $listenerPid)." }

try {
    Remove-Item -LiteralPath $frontendReadyFile -Force -ErrorAction SilentlyContinue
    $env:AGENT_MONITOR_SMOKE_EXIT_AFTER_MS = "10000"
    $env:AGENT_MONITOR_SMOKE_FRONTEND_READY_FILE = $frontendReadyFile
    try {
        $appProcess = Start-Process -FilePath $appPath -WorkingDirectory $root -PassThru
    } finally {
        Remove-Item Env:\AGENT_MONITOR_SMOKE_EXIT_AFTER_MS -ErrorAction SilentlyContinue
        Remove-Item Env:\AGENT_MONITOR_SMOKE_FRONTEND_READY_FILE -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $health = $null
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Method GET -Uri "$baseUrl/api/health" -TimeoutSec 2
            if ($health.ok -and $health.service -eq "agent-monitor-broker") { break }
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not $health -or -not $health.ok) { throw "Portable Broker did not become healthy within $TimeoutSeconds seconds." }

    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $frontendReadyFile)) {
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-Path -LiteralPath $frontendReadyFile)) {
        throw "Portable frontend did not mount within $TimeoutSeconds seconds. The release may still be using the development URL."
    }

    $brokerPid = Get-ListeningProcessId -Port 17654
    $brokerProcess = if ($brokerPid) { Get-Process -Id $brokerPid -ErrorAction SilentlyContinue } else { $null }
    if (-not $brokerProcess -or -not ([string]$brokerProcess.Path).Equals($expectedNode, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Healthy Broker was not started from the Portable runtime."
    }
    if (-not [System.IO.Path]::GetFullPath([string]$health.storage).Equals([System.IO.Path]::GetFullPath($expectedDataFile), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Portable Broker storage mismatch. Expected $expectedDataFile, got $($health.storage)"
    }

    $workspaceResult = Invoke-RestMethod -Method GET -Uri "$baseUrl/api/workspaces" -TimeoutSec 3
    if (-not $workspaceResult.ok) { throw "Portable Workspace Registry endpoint failed." }

    [pscustomobject]@{
        Ok = $true
        AppPid = $appProcess.Id
        BrokerPid = $brokerProcess.Id
        FrontendReady = $true
        Storage = $health.storage
        WorkspaceCount = $workspaceResult.count
    }

    if (-not $appProcess.WaitForExit(12000)) {
        throw "Portable app did not execute its controlled smoke exit."
    }
} finally {
    if ($appProcess -and -not $appProcess.HasExited) {
        $null = $appProcess.CloseMainWindow()
        if (-not $appProcess.WaitForExit(5000)) {
            Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 800
    $remainingBroker = if ($brokerProcess) { Get-Process -Id $brokerProcess.Id -ErrorAction SilentlyContinue } else { $null }
    if ($remainingBroker) {
        Stop-Process -Id $remainingBroker.Id -Force -ErrorAction SilentlyContinue
        throw "Portable app exit left its owned Broker running (pid $($remainingBroker.Id))."
    }
    Remove-Item -LiteralPath $frontendReadyFile -Force -ErrorAction SilentlyContinue
}
