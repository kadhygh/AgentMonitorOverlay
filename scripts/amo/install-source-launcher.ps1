param(
    [string]$LauncherPath = (Join-Path ([Environment]::GetFolderPath("Desktop")) "AMO Stable.cmd")
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
    throw "The AMO desktop launcher installer supports Windows only."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$entryPoint = Join-Path $repoRoot "amo.ps1"
$launcherFullPath = [System.IO.Path]::GetFullPath($LauncherPath)
$launcherDirectory = Split-Path -Parent $launcherFullPath

if ([System.IO.Path]::GetExtension($launcherFullPath) -ine ".cmd") {
    throw "LauncherPath must end in .cmd: $launcherFullPath"
}
if (-not (Test-Path -LiteralPath $entryPoint)) {
    throw "Could not find the AMO entry point: $entryPoint"
}

New-Item -ItemType Directory -Force -Path $launcherDirectory | Out-Null

$launcherContent = @"
@echo off
chcp 65001 >nul
setlocal
cd /d "$repoRoot"
powershell.exe -NoProfile -File "$entryPoint" -Mode Stable
if errorlevel 1 (
  echo.
  echo AMO Stable failed to start. Review the output above and the logs under:
  echo $repoRoot\tmp
  pause
)
"@

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($launcherFullPath, $launcherContent, $utf8WithoutBom)

if (-not (Test-Path -LiteralPath $launcherFullPath)) {
    throw "Desktop launcher was not created: $launcherFullPath"
}

Write-Host "AMO Stable desktop launcher installed."
Write-Host "Launcher: $launcherFullPath"
Write-Host "Repository: $repoRoot"
Write-Host "The launcher is a readable CMD file and does not hide PowerShell or bypass execution policy."
