param(
    [string]$TitleToken = "[AMO:claude:agent-monitor-overlay:live-demo]",
    [switch]$Activate
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "Get-WindowCandidates.ps1"
$args = @("-ExecutionPolicy", "Bypass", "-File", $scriptPath, "-TitleContains", $TitleToken)
if ($Activate) {
    $args += "-ActivateFirst"
}

powershell @args
