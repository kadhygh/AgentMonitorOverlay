param(
    [string]$VaultPath = "tmp\\obsidian-sync-back-vault"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\\..")
$vaultRoot = Join-Path $repoRoot $VaultPath
$seedRoot = Join-Path $repoRoot "examples\\obsidian\\test-vault-seed"
$pluginRoot = Join-Path $repoRoot "prototypes\\obsidian-sync-back-plugin"
$pluginTarget = Join-Path $vaultRoot ".obsidian\\plugins\\amo-sync-back-test"

New-Item -ItemType Directory -Force -Path $vaultRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $vaultRoot ".obsidian") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $vaultRoot "Notes") | Out-Null
New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null

Copy-Item -LiteralPath (Join-Path $seedRoot "Notes\\codex-task-h-test.md") -Destination (Join-Path $vaultRoot "Notes\\codex-task-h-test.md") -Force
Copy-Item -LiteralPath (Join-Path $pluginRoot "manifest.json") -Destination (Join-Path $pluginTarget "manifest.json") -Force
Copy-Item -LiteralPath (Join-Path $pluginRoot "main.js") -Destination (Join-Path $pluginTarget "main.js") -Force
Copy-Item -LiteralPath (Join-Path $pluginRoot "syncBackCore.js") -Destination (Join-Path $pluginTarget "syncBackCore.js") -Force

$pluginData = [ordered]@{
    helperScriptPath = (Join-Path $repoRoot "scripts\\obsidian\\Invoke-SyncBackBridge.ps1")
    previewRoot = "AMO/SyncBackPreviews"
    requestOutboxRoot = ".amo/sync-back/outbox"
    defaultVaultName = "obsidian-sync-back-vault"
    powershellPath = "powershell.exe"
}

$pluginData | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $pluginTarget "data.json") -Encoding UTF8
@("amo-sync-back-test") | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $vaultRoot ".obsidian\\community-plugins.json") -Encoding UTF8

Write-Output "Prepared Obsidian test vault at: $vaultRoot"
Write-Output "Plugin copied to: $pluginTarget"
