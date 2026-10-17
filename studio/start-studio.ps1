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
$lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath "package-lock.json").Hash
$stamp = Join-Path $PSScriptRoot "node_modules\.amo-lock.sha256"
$installed = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { "" }
if ($Install -or $installed -ne $lockHash) {
  Note "Installing dependencies (npm ci, Node $nodeVersion)..."
  npm ci
  if ($LASTEXITCODE -ne 0) {
    Fail ("npm ci failed. If the Electron download timed out, set a mirror and retry:`n" +
      '    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"; .\start-studio.ps1 -Install')
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
