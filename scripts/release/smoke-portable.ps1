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
$baseUrl = "http://127.0.0.1:17654"
$appProcess = $null
$brokerProcess = $null

foreach ($required in @($appPath, $expectedBrokerScript, $expectedNode)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Portable smoke missing required file: $required" }
}

$listener = Get-NetTCPConnection -LocalPort 17654 -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Portable cold smoke requires port 17654 to be free." }

try {
    $env:AGENT_MONITOR_SMOKE_EXIT_AFTER_MS = "7000"
    try {
        $appProcess = Start-Process -FilePath $appPath -WorkingDirectory $root -PassThru
    } finally {
        Remove-Item Env:\AGENT_MONITOR_SMOKE_EXIT_AFTER_MS -ErrorAction SilentlyContinue
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

    $brokerProcess = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq "node.exe" -and
        $_.ExecutablePath -ieq $expectedNode -and
        $_.CommandLine -like "*$expectedBrokerScript*"
    } | Select-Object -First 1
    if (-not $brokerProcess) { throw "Healthy Broker was not started from the Portable runtime." }
    if (-not [System.IO.Path]::GetFullPath([string]$health.storage).Equals([System.IO.Path]::GetFullPath($expectedDataFile), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Portable Broker storage mismatch. Expected $expectedDataFile, got $($health.storage)"
    }

    $workspaceResult = Invoke-RestMethod -Method GET -Uri "$baseUrl/api/workspaces" -TimeoutSec 3
    if (-not $workspaceResult.ok) { throw "Portable Workspace Registry endpoint failed." }

    [pscustomobject]@{
        Ok = $true
        AppPid = $appProcess.Id
        BrokerPid = $brokerProcess.ProcessId
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
    $remainingBroker = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq "node.exe" -and $_.ExecutablePath -ieq $expectedNode
    } | Select-Object -First 1
    if ($remainingBroker) {
        Stop-Process -Id $remainingBroker.ProcessId -Force -ErrorAction SilentlyContinue
        throw "Portable app exit left its owned Broker running (pid $($remainingBroker.ProcessId))."
    }
}
