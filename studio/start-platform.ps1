# Starts AMO Platform (the platform) from this source checkout (Windows); plans/amo-lan-platform.md, way 2 of developing.
#   start-platform.cmd           install what is missing, build, open the platform (it stays in the tray)
#   start-platform.cmd -Test     the same on the test channel (--channel test): the tools you publish with
#                                `npm run relay:mac -- publish <tool>` before you promote them
#   start-platform.cmd -Install  reinstall dependencies first (npm ci)
# The platform keeps its settings and login in %APPDATA%\AMO and the tools it installs in %LOCALAPPDATA%\AMO\apps, not
# in this folder. Already running, the platform just comes to the front.
param(
  [switch]$Test,
  [switch]$Install
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Fail([string]$message) {
  Write-Host ""
  Write-Host "[AMO Platform] $message" -ForegroundColor Red
  exit 1
}

function Note([string]$message) {
  Write-Host "[AMO Platform] $message" -ForegroundColor Cyan
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js is not installed. Install Node 24 LTS from https://nodejs.org and run this again."
}
$nodeVersion = (node -v).Trim()
$major = [int]($nodeVersion.TrimStart("v").Split(".")[0])
if ($major -lt 22) {
  Fail "Node $nodeVersion is too old; the platform needs Node 22 or newer (24 LTS recommended)."
}

# Dependencies: as start-studio.ps1 (the same stamp), install when node_modules is missing or package-lock.json changed.
$sha = [System.Security.Cryptography.SHA256]::Create()
$lockHash = [System.BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot "package-lock.json")))).Replace("-", "")
$stamp = Join-Path $PSScriptRoot "node_modules\.amo-lock.sha256"
$installed = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { "" }
if ($Install -or $installed -ne $lockHash) {
  # Not npm ci when installed already: with Studio or the notes window running from node_modules, it stops halfway.
  $fresh = $Install -or -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules\electron"))
  if ($fresh) {
    Note "Installing dependencies (npm ci, Node $nodeVersion)..."
    npm ci
  } else {
    Note "Updating dependencies (npm install, Node $nodeVersion)..."
    npm install --no-audit --no-fund
  }
  if ($LASTEXITCODE -ne 0) {
    Fail "Installing the dependencies failed. Close AMO Studio and its notes window started from this folder, then retry."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules\electron\dist\electron.exe"))) {
    Note "Downloading Electron..."
    node (Join-Path $PSScriptRoot "node_modules\electron\install.js")
    if ($LASTEXITCODE -ne 0) { Fail "Downloading Electron failed; see above." }
  }
  Set-Content -LiteralPath $stamp -Value $lockHash -Encoding ascii
}

Note "Building..."
npm run build
if ($LASTEXITCODE -ne 0) { Fail "The build failed; see above." }

# What a Claude Code or Codex shell set here must not reach the platform and the tools it opens (they pass their
# environment on); started detached so closing this window leaves the platform running.
Get-ChildItem Env: | Where-Object { $_.Name -match '^(CLAUDE|ANTHROPIC_|AMO_|ELECTRON_RUN_AS_NODE$|NO_COLOR$|FORCE_COLOR$)' } | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$electron = Join-Path $PSScriptRoot "node_modules\electron\dist\electron.exe"
$arguments = @("packages/platform")
if ($Test) { $arguments += @("--channel", "test") }
Note ("Opening AMO Platform" + $(if ($Test) { " (test channel)" } else { "" }) + "; it stays in the tray.")
Start-Process -FilePath $electron -ArgumentList $arguments -WorkingDirectory $PSScriptRoot
