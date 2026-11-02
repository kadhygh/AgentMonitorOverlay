param([string[]]$Tasks = @(':app:assembleDebug'))
$ErrorActionPreference = 'Stop'
$oldJava = $env:JAVA_HOME
$oldAndroid = $env:ANDROID_HOME
$oldPriority = [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass
try {
    $candidates = @($env:JAVA_HOME, 'C:/DEVELOP/UnityEditor/6000.3.11f1/Editor/Data/PlaybackEngines/AndroidPlayer/OpenJDK')
    $selected = $null
    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        $javaExe = Join-Path $candidate 'bin/java.exe'
        if (-not (Test-Path -LiteralPath $javaExe)) { continue }
        $probe = New-Object System.Diagnostics.Process
        $probe.StartInfo.FileName = $javaExe
        $probe.StartInfo.Arguments = '-version'
        $probe.StartInfo.UseShellExecute = $false
        $probe.StartInfo.CreateNoWindow = $true
        $probe.StartInfo.RedirectStandardError = $true
        $null = $probe.Start()
        $version = $probe.StandardError.ReadToEnd()
        $probe.WaitForExit()
        $probe.Dispose()
        if ($version -match 'version "(\d+)' -and [int]$Matches[1] -ge 17) { $selected = $candidate; break }
    }
    if (-not $selected) { throw 'Set JAVA_HOME to a JDK 17 or newer before building.' }
    $env:JAVA_HOME = $selected
    if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
    if (-not (Test-Path -LiteralPath $env:ANDROID_HOME)) { throw 'Set ANDROID_HOME to the Android SDK directory.' }
    [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
    Push-Location $PSScriptRoot
    try { & './gradlew.bat' --no-daemon --max-workers=4 @Tasks; $buildExit = $LASTEXITCODE }
    finally { Pop-Location }
    if ($buildExit -ne 0) { throw "Gradle exited with code $buildExit" }
} finally {
    $env:JAVA_HOME = $oldJava
    $env:ANDROID_HOME = $oldAndroid
    [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = $oldPriority
}
