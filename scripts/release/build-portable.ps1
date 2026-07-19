param(
    [string]$Version = "0.1.3",
    [string]$NodeVersion = "24.13.0",
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$overlayRoot = Join-Path $repoRoot "overlay"
$cargoManifest = Join-Path $overlayRoot "src-tauri\Cargo.toml"
$sourceVersion = [string](Get-Content -Raw -Encoding UTF8 (Join-Path $overlayRoot "src-tauri\tauri.conf.json") | ConvertFrom-Json).version
$amoConstantsPath = Join-Path $repoRoot "broker\lib\amo-constants.js"
$amoProtocolJson = & node -e 'const c = require(process.argv[1]); process.stdout.write(JSON.stringify({ deploymentVersion: c.AMO_DEPLOYMENT_VERSION, hookProtocolVersion: c.AMO_HOOK_PROTOCOL_VERSION }));' $amoConstantsPath
if ($LASTEXITCODE -ne 0) { throw "Could not read AMO protocol constants from $amoConstantsPath" }
$amoProtocol = $amoProtocolJson | ConvertFrom-Json
$releaseExe = Join-Path $overlayRoot "src-tauri\target\release\agent-monitor-overlay.exe"
$portableOutput = Join-Path $repoRoot "dist\portable"
$packageName = "AMO-v$Version-win-x64"
$stageRoot = Join-Path $portableOutput $packageName
$zipPath = Join-Path $portableOutput "$packageName.zip"
$checksumPath = "$zipPath.sha256"
$cacheRoot = Join-Path $repoRoot "tmp\release-cache\node-v$NodeVersion-win-x64"
$nodeArchive = Join-Path $cacheRoot "node-v$NodeVersion-win-x64.zip"
$nodeExtractRoot = Join-Path $cacheRoot "extracted"
$nodeDistributionRoot = Join-Path $nodeExtractRoot "node-v$NodeVersion-win-x64"

function Invoke-PortableBuild {
Assert-SemanticVersion $Version
if ($Version -ne $sourceVersion) {
    throw "Portable version $Version does not match source version $sourceVersion in overlay/src-tauri/tauri.conf.json"
}
Assert-SafeOutputPath $repoRoot $portableOutput

if (-not $SkipDependencyInstall -and -not (Test-Path -LiteralPath (Join-Path $overlayRoot "node_modules"))) {
    Push-Location $overlayRoot
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

Push-Location $overlayRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

cargo build --release --locked --manifest-path $cargoManifest
if ($LASTEXITCODE -ne 0) { throw "Cargo release build failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $releaseExe)) { throw "Release executable was not produced: $releaseExe" }

New-Item -ItemType Directory -Force -Path $portableOutput | Out-Null
Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath, $checksumPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $stageRoot "AMO.exe")
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $stageRoot "LICENSE.txt")
Copy-Item -LiteralPath (Join-Path $repoRoot "THIRD_PARTY_NOTICES.md") -Destination (Join-Path $stageRoot "THIRD_PARTY_NOTICES.md")
Copy-BrokerRuntime -RepoRoot $repoRoot -DestinationRoot (Join-Path $stageRoot "app\broker")
Copy-NodeRuntime -Version $NodeVersion -ArchivePath $nodeArchive -ExtractRoot $nodeExtractRoot -DistributionRoot $nodeDistributionRoot -DestinationRoot (Join-Path $stageRoot "runtime")
New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "data") | Out-Null

$pluginManifest = Get-Content -Raw -Encoding UTF8 (Join-Path $repoRoot "broker\assets\obsidian\md-anno-tools\manifest.json") | ConvertFrom-Json
$versionInfo = [ordered]@{
    schemaVersion = 1
    appVersion = $Version
    brokerVersion = $Version
    deploymentVersion = [int]$amoProtocol.deploymentVersion
    hookProtocolVersion = [int]$amoProtocol.hookProtocolVersion
    obsidianPluginVersion = [string]$pluginManifest.version
    bundledNodeVersion = $NodeVersion
    platform = "windows-x64"
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
    sourceCommit = (git -C $repoRoot rev-parse HEAD).Trim()
}
$versionInfo | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stageRoot "version.json") -Encoding UTF8

@"
AMO Portable v$Version

Run AMO.exe. The bundled Broker and Node runtime start automatically.

Portable data is stored in the data folder beside AMO.exe. Keep that folder when updating.
Codex CLI, Claude CLI, Obsidian, Windows Terminal, and WebView2 are external prerequisites when their features are used.

Normal startup does not show a Broker console. Enable Debug in AMO Settings for diagnostic logging.
"@ | Set-Content -LiteralPath (Join-Path $stageRoot "README.txt") -Encoding UTF8

Assert-PortableLayout $stageRoot
Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $([System.IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath $checksumPath -Encoding ASCII

[pscustomobject]@{
    Version = $Version
    StageRoot = $stageRoot
    ZipPath = $zipPath
    ChecksumPath = $checksumPath
    Sha256 = $hash
    SizeBytes = (Get-Item -LiteralPath $zipPath).Length
}
}

function Assert-SemanticVersion {
    param([string]$Value)
    if ($Value -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw "Version must be semantic, for example 0.1.0: $Value"
    }
}

function Assert-SafeOutputPath {
    param([string]$Root, [string]$Output)
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $resolvedOutput = [System.IO.Path]::GetFullPath($Output)
    if (-not $resolvedOutput.StartsWith("$resolvedRoot\dist\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Portable output must stay inside the repository dist directory: $resolvedOutput"
    }
}

function Copy-BrokerRuntime {
    param([string]$RepoRoot, [string]$DestinationRoot)
    New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot "broker\server.js") -Destination $DestinationRoot
    foreach ($directory in @("hooks", "lib", "routes")) {
        Copy-Item -LiteralPath (Join-Path $RepoRoot "broker\$directory") -Destination $DestinationRoot -Recurse
    }
    $pluginSource = Join-Path $RepoRoot "broker\assets\obsidian\md-anno-tools"
    $pluginDestination = Join-Path $DestinationRoot "assets\obsidian\md-anno-tools"
    New-Item -ItemType Directory -Force -Path $pluginDestination | Out-Null
    foreach ($fileName in @("main.js", "manifest.json", "styles.css")) {
        Copy-Item -LiteralPath (Join-Path $pluginSource $fileName) -Destination $pluginDestination
    }
}

function Copy-NodeRuntime {
    param(
        [string]$Version,
        [string]$ArchivePath,
        [string]$ExtractRoot,
        [string]$DistributionRoot,
        [string]$DestinationRoot
    )
    $archiveName = "node-v$Version-win-x64.zip"
    $baseUrl = "https://nodejs.org/dist/v$Version"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ArchivePath) | Out-Null
    $checksumsPath = Join-Path (Split-Path -Parent $ArchivePath) "SHASUMS256.txt"
    if (-not (Test-Path -LiteralPath $ArchivePath)) {
        Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $ArchivePath
    }
    Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $checksumsPath
    $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+$([regex]::Escape($archiveName))$" } | Select-Object -First 1
    if (-not $checksumLine) { throw "Node checksum entry not found for $archiveName" }
    $expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw "Node archive checksum mismatch. Expected $expectedHash, got $actualHash" }

    Remove-Item -LiteralPath $ExtractRoot -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot
    New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $DistributionRoot "node.exe") -Destination $DestinationRoot
    Copy-Item -LiteralPath (Join-Path $DistributionRoot "LICENSE") -Destination (Join-Path $DestinationRoot "NODE-LICENSE.txt")
}

function Assert-PortableLayout {
    param([string]$Root)
    foreach ($relativePath in @(
        "AMO.exe",
        "LICENSE.txt",
        "THIRD_PARTY_NOTICES.md",
        "runtime\node.exe",
        "runtime\NODE-LICENSE.txt",
        "app\broker\server.js",
        "app\broker\lib\workspace-deploy.js",
        "app\broker\hooks\codex.js",
        "app\broker\assets\obsidian\md-anno-tools\main.js",
        "app\broker\assets\obsidian\md-anno-tools\manifest.json",
        "version.json",
        "README.txt",
        "data"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relativePath))) {
            throw "Portable package is missing required path: $relativePath"
        }
    }
}

Invoke-PortableBuild
