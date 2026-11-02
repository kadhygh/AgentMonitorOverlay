param(
    [Parameter(Mandatory=$true)][string]$FixtureReady,
    [string]$Serial = 'emulator-5580',
    [string]$Classes = 'RepositoryIntegrationTest,UiFlowTest,FilePolicyTest,ReliabilityIntegrationTest',
    [string]$LogName = 'instrumentation'
)
$ErrorActionPreference = 'Stop'
$fixture = Get-Content -LiteralPath $FixtureReady -Raw -Encoding utf8 | ConvertFrom-Json
if ($fixture.modelMode -eq 'real-dxx' -and $Classes -ne 'RepositoryIntegrationTest') { throw 'Real-model fixture only permits RepositoryIntegrationTest.' }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$adb = Join-Path $sdk 'platform-tools/adb.exe'
$studioRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
Push-Location $studioRoot
try {
    node scripts/android-provision.mjs $FixtureReady $Serial
    if ($LASTEXITCODE -ne 0) { throw 'Fixture provisioning failed.' }
    & $adb -s $Serial install -r (Join-Path $PSScriptRoot 'app/build/outputs/apk/debug/app-debug.apk')
    if ($LASTEXITCODE -ne 0) { throw 'App installation failed.' }
    & $adb -s $Serial install -r (Join-Path $PSScriptRoot 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')
    if ($LASTEXITCODE -ne 0) { throw 'Test installation failed.' }
    $qualified = ($Classes.Split(',') | ForEach-Object { 'dev.amo.studio.' + $_.Trim() }) -join ','
    $result = & $adb -s $Serial shell am instrument -w -e class $qualified dev.amo.studio.test/androidx.test.runner.AndroidJUnitRunner | Out-String
    $result | Set-Content -LiteralPath (Join-Path $outDir ($LogName + '.txt')) -Encoding utf8
    Write-Output $result
    if ($result -notmatch 'OK \(\d+ tests?\)' -or $result -match 'FAILURES!!!|INSTRUMENTATION_FAILED') { throw 'Instrumentation did not pass; see the test log.' }
} finally {
    & $adb -s $Serial shell rm -f /data/local/tmp/amo-android-test.json
    Pop-Location
}
