param(
    [string]$VaultPath = "..\AgentMonitorOverlay-obsidian-test-vault"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$pluginRoot = Join-Path $repoRoot "obsidian-plugin"
$resolvedVaultPath = Resolve-Path -Path (Join-Path $repoRoot $VaultPath)
$targetDir = Join-Path $resolvedVaultPath ".obsidian\plugins\agent-monitor-overlay"

Push-Location $pluginRoot
try {
    if (-not (Test-Path "node_modules")) {
        npm install
    }

    npm run build
}
finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

Copy-Item -LiteralPath (Join-Path $pluginRoot "manifest.json") -Destination (Join-Path $targetDir "manifest.json") -Force
Copy-Item -LiteralPath (Join-Path $pluginRoot "styles.css") -Destination (Join-Path $targetDir "styles.css") -Force
Copy-Item -LiteralPath (Join-Path $pluginRoot "dist\main.js") -Destination (Join-Path $targetDir "main.js") -Force

Write-Output "Deployed AMO Obsidian plugin to: $targetDir"
