# Starts the AMO Studio development build on this machine (Windows).
#   start-studio.cmd             install what is missing, build, open Studio
#   start-studio.cmd -Install    reinstall dependencies first (npm ci)
#   start-studio.cmd -Stop       stop the resident Host (ends live sessions)
# Data lives in studio\.data (created on first start). Node is only used to install and build; the Host runs on
# Electron's own Node.
param(
  [switch]$Install,
  [switch]$Stop
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Fail([string]$message) {
  Write-Host ""
  Write-Host "[AMO Studio] $message" -ForegroundColor Red
  exit 1
}

function Note([string]$message) {
  Write-Host "[AMO Studio] $message" -ForegroundColor Cyan
}

function Warn([string]$message) {
  Write-Host "[AMO Studio] $message" -ForegroundColor Yellow
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js is not installed. Install Node 24 LTS from https://nodejs.org and run this again."
}
$nodeVersion = (node -v).Trim()
$major = [int]($nodeVersion.TrimStart("v").Split(".")[0])
if ($major -lt 22) {
  Fail "Node $nodeVersion is too old; Studio needs Node 22 or newer (24 LTS recommended)."
}

if ($Stop) {
  npm run host:stop
  exit $LASTEXITCODE
}

# Dependencies: install when node_modules is missing or package-lock.json changed since the last install.
$sha = [System.Security.Cryptography.SHA256]::Create()
$lockHash = [System.BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot "package-lock.json")))).Replace("-", "")
$stamp = Join-Path $PSScriptRoot "node_modules\.amo-lock.sha256"
$installed = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { "" }
if ($Install -or $installed -ne $lockHash) {
  # npm ci removes node_modules first: with Studio or the notes window running from it, a file in use stops it halfway
  # and leaves Studio unable to start (2026-10-26, twice). Installed already, npm install brings it up to date in place.
  $fresh = $Install -or -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules\electron"))
  if ($fresh) {
    Note "Installing dependencies (npm ci, Node $nodeVersion)..."
    npm ci
  } else {
    Note "Updating dependencies (npm install, Node $nodeVersion)..."
    npm install --no-audit --no-fund
  }
  if ($LASTEXITCODE -ne 0) {
    Fail ("Installing the dependencies failed. Close AMO Studio and its notes window, then retry. If the Electron download timed out, use a mirror (in cmd):`n" +
      "    set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`n    start-studio.cmd -Install")
  }
  # Electron's own program is downloaded by its install script; an interrupted install can leave it out.
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules\electron\dist\electron.exe"))) {
    Note "Downloading Electron..."
    node (Join-Path $PSScriptRoot "node_modules\electron\install.js")
    if ($LASTEXITCODE -ne 0) { Fail "Downloading Electron failed; see above." }
  }
  Set-Content -LiteralPath $stamp -Value $lockHash -Encoding ascii
}

# What the models need on this machine. Studio opens without them; the matching models just do not work yet.
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  Warn "codex is not on PATH; Codex models need it:  npm i -g @openai/codex"
}
Note "Keys are entered in Studio: Settings > Models (Claude subscription token from 'claude setup-token'; API keys on the channels)."

if (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".data\host.json")) {
  Note "A Host from an earlier start may still be running; the window will reuse it (start-studio.cmd -Stop ends it)."
}

Note "Building and opening Studio (data in $PSScriptRoot\.data)..."
npm start
exit $LASTEXITCODE
