param(
    [switch]$DebugMode
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$serverPath = Join-Path $repoRoot "broker\server.js"

if ($DebugMode) {
    if (-not $env:AGENT_MONITOR_DEBUG) {
        $env:AGENT_MONITOR_DEBUG = "1"
    }
    node $serverPath
    exit $LASTEXITCODE
}

$existing = Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -ieq "node.exe" -and
        ($_.CommandLine -like "*broker/server.js*" -or $_.CommandLine -like "*broker\server.js*")
    } |
    Select-Object -First 1

if ($existing) {
    Write-Host "AMO broker is already running: pid $($existing.ProcessId)."
    return
}

$process = Start-Process `
    -FilePath "node" `
    -ArgumentList @($serverPath) `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -PassThru

Write-Host "Started hidden AMO broker pid $($process.Id). Use npm run broker:debug for a visible debug broker."
