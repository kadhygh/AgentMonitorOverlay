# AMO 中转's service on this Windows machine (2026-10-26): runs release/relay/amo-relay.mjs in the background, data in
# %APPDATA%\AMO Relay\server, logs next to it. A client update needs no restart (npm run relay:release); a change to the
# service itself does.
#   powershell -File scripts/relay-service.ps1 start|stop|restart|status [-Passphrase <邀请口令>] [-Name <服务名>]
param(
  [Parameter(Position = 0)][ValidateSet("start", "stop", "restart", "status")][string]$Action = "status",
  [string]$Passphrase = "",
  [string]$Name = "",
  [int]$Port = 47120
)

$script = Join-Path $PSScriptRoot "..\release\relay\amo-relay.mjs" | Resolve-Path -ErrorAction SilentlyContinue
$data = Join-Path $env:APPDATA "AMO Relay\server"

function Get-Service {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*amo-relay.mjs*serve*" }
}

function Stop-Relay {
  foreach ($p in Get-Service) { Stop-Process -Id $p.ProcessId -Force; "stopped $($p.ProcessId)" }
}

function Start-Relay {
  if (Get-Service) { "already running"; return }
  if (-not $script) { throw "release/relay/amo-relay.mjs is missing: run npm run relay:release first" }
  New-Item -ItemType Directory -Force $data | Out-Null
  $argv = @("`"$script`"", "serve", "--port", "$Port")
  if ($Name) { $argv += @("--name", "`"$Name`"") }
  if ($Passphrase) { $argv += @("--passphrase", "`"$Passphrase`"") }
  $node = (Get-Command node).Source
  $p = Start-Process -FilePath $node -ArgumentList $argv -WorkingDirectory $data -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $data "serve.log") -RedirectStandardError (Join-Path $data "serve.err.log")
  Start-Sleep -Seconds 2
  "started $($p.Id)"
  Get-Content (Join-Path $data "serve.log")
  Get-Content (Join-Path $data "serve.err.log")
}

switch ($Action) {
  "start" { Start-Relay }
  "stop" { Stop-Relay }
  "restart" { Stop-Relay; Start-Relay }
  "status" {
    $s = Get-Service
    if ($s) { "running: $($s.ProcessId)"; (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health").Content } else { "not running" }
  }
}
