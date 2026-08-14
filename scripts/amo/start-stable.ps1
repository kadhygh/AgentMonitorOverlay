param(
    [switch]$DebugMode,
    [switch]$SkipBroker,
    [switch]$HealthOnly,
    [switch]$RestartOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$overlayRoot = Join-Path $repoRoot "overlay"
$tauriRoot = Join-Path $overlayRoot "src-tauri"
$cargoManifest = Join-Path $tauriRoot "Cargo.toml"
$frontendArtifactPath = Join-Path $overlayRoot "dist\index.html"
$appPath = Join-Path $tauriRoot "target\debug\agent-monitor-overlay.exe"
$tmpRoot = Join-Path $repoRoot "tmp"
$attemptId = [Guid]::NewGuid().ToString("N")
$buildRoot = Join-Path $tauriRoot "target\amo-stable-staging"
$builtAppPath = Join-Path $buildRoot "debug\agent-monitor-overlay.exe"
$buildFingerprintPath = Join-Path $tauriRoot "target\.amo-stable-build-fingerprint"
$backupAppPath = Join-Path $tmpRoot ("amo-stable-previous-" + $attemptId + ".exe")
$viteUrl = "http://127.0.0.1:1420/"
$brokerUrl = "http://127.0.0.1:17654"
$viteStdout = Join-Path $tmpRoot "amo-stable-vite.out.log"
$viteStderr = Join-Path $tmpRoot "amo-stable-vite.err.log"
$appStdout = Join-Path $tmpRoot "amo-stable-app.out.log"
$appStderr = Join-Path $tmpRoot "amo-stable-app.err.log"
$brokerStdout = Join-Path $tmpRoot "amo-stable-broker.out.log"
$brokerStderr = Join-Path $tmpRoot "amo-stable-broker.err.log"
$brokerServerPath = Join-Path $repoRoot "broker\server.js"
$phase = "initialization"
$viteProcess = $null
$appProcess = $null
$brokerProcess = $null
$binaryReplaced = $false
$buildRequired = $false
$currentBuildFingerprint = $null

function Test-AmoUrl {
    param([Parameter(Mandatory = $true)][string]$Url)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Get-AmoStableBuildFingerprint {
    $inputFiles = @()
    foreach ($directory in @(
        (Join-Path $overlayRoot "src"),
        (Join-Path $tauriRoot "src"),
        (Join-Path $tauriRoot "capabilities")
    )) {
        if (Test-Path -LiteralPath $directory) {
            $inputFiles += @(Get-ChildItem -LiteralPath $directory -Recurse -File)
        }
    }
    foreach ($file in @(
        (Join-Path $overlayRoot "index.html"),
        (Join-Path $overlayRoot "startup.html"),
        (Join-Path $overlayRoot "package.json"),
        (Join-Path $overlayRoot "package-lock.json"),
        (Join-Path $overlayRoot "tsconfig.json"),
        (Join-Path $overlayRoot "vite.config.ts"),
        (Join-Path $tauriRoot "build.rs"),
        (Join-Path $tauriRoot "Cargo.toml"),
        (Join-Path $tauriRoot "Cargo.lock"),
        (Join-Path $tauriRoot "tauri.conf.json")
    )) {
        if (Test-Path -LiteralPath $file) {
            $inputFiles += @(Get-Item -LiteralPath $file)
        }
    }

    $manifest = @($inputFiles | Sort-Object FullName -Unique | ForEach-Object {
        $relativePath = $_.FullName.Substring($repoRoot.Length).TrimStart('\', '/')
        $fileStream = [System.IO.File]::OpenRead($_.FullName)
        $fileHasher = [System.Security.Cryptography.SHA256]::Create()
        try {
            $fileHash = ([System.BitConverter]::ToString($fileHasher.ComputeHash($fileStream))).Replace("-", "").ToLowerInvariant()
        } finally {
            $fileHasher.Dispose()
            $fileStream.Dispose()
        }
        "$relativePath|$fileHash"
    }) -join "`n"
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($manifest)
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Wait-AmoUrl {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Name,
        [int]$TimeoutSeconds = 15
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-AmoUrl -Url $Url) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "$Name did not become ready at $Url."
}

function Test-AmoBrokerHealth {
    try {
        $health = Invoke-RestMethod -Method GET -Uri "$brokerUrl/api/health" -TimeoutSec 2
        return [bool]($health.ok -and $health.service -eq "agent-monitor-broker")
    } catch {
        return $false
    }
}

function Wait-AmoBrokerHealth {
    param([int]$TimeoutSeconds = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-AmoBrokerHealth) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "AMO Broker did not become healthy at $brokerUrl."
}

function Test-AmoInitialSessions {
    try {
        $result = Invoke-RestMethod -Method GET -Uri "$brokerUrl/api/sessions?scope=active&offset=0&limit=1&summary=1" -TimeoutSec 2
        return [bool]($result.ok -and $null -ne $result.sessions -and $null -ne $result.revision)
    } catch {
        return $false
    }
}

function Wait-AmoInitialSessions {
    param([int]$TimeoutSeconds = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-AmoInitialSessions) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "AMO initial sessions response did not become ready at $brokerUrl/api/sessions."
}

function Get-AmoStableAppProcesses {
    return @(Get-Process -Name "agent-monitor-overlay" -ErrorAction SilentlyContinue | Where-Object {
        try {
            $executablePath = [string]$_.Path
            return $executablePath -and
                $executablePath.StartsWith($tauriRoot, [StringComparison]::OrdinalIgnoreCase)
        } catch {
            return $false
        }
    })
}

function Get-AmoListeningProcessIds {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutMilliseconds = 2000
    )
    $netstatPath = Join-Path $env:SystemRoot "System32\netstat.exe"
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $netstatPath
    $startInfo.Arguments = "-ano -p TCP"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch {}
            throw "Timed out while resolving listener for port $Port."
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        return @($stdout -split "`r?`n" | ForEach-Object {
            if ($_ -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and [int]$Matches[1] -eq $Port) {
                [int]$Matches[2]
            }
        } | Sort-Object -Unique)
    } finally {
        $process.Dispose()
    }
}

function Get-AmoPortProcesses {
    param([Parameter(Mandatory = $true)][int]$Port)
    $ownerIds = @(Get-AmoListeningProcessIds -Port $Port)
    return @($ownerIds | ForEach-Object {
        Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue
    })
}

function Get-AmoStableBrokerProcesses {
    if (-not (Test-AmoBrokerHealth)) { return @() }
    return @(Get-AmoPortProcesses -Port 17654)
}
function Get-AmoStableViteProcesses {
    if (-not (Test-AmoUrl -Url $viteUrl)) { return @() }
    return @(Get-AmoPortProcesses -Port 1420)
}

function Stop-AmoProcessTree {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return }
    try { & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null } catch {}
    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ExistingStableUi {
    $targets = @()
    $targets += @(Get-AmoStableAppProcesses)
    $targets += @(Get-AmoStableViteProcesses)
    $targets += @(Get-AmoStableBrokerProcesses)
    $targets = @($targets | Group-Object Id | ForEach-Object { $_.Group[0] })
    foreach ($target in $targets) {
        Write-Host "Stopping existing Stable UI process $($target.Name) pid=$($target.Id)."
        Stop-AmoProcessTree -ProcessId ([int]$target.Id)
    }
    if ($targets.Count -gt 0) { Start-Sleep -Milliseconds 500 }
}

function Assert-StableHealth {
    $apps = @(Get-AmoStableAppProcesses)
    if ($apps.Count -eq 0) { throw "Stable native app is not running." }
    if (-not (Test-AmoUrl -Url $viteUrl)) { throw "Stable Vite server is not healthy at $viteUrl." }
    if (-not $SkipBroker) {
        if (-not (Test-AmoBrokerHealth)) { throw "AMO Broker is not healthy at $brokerUrl." }
        if (-not (Test-AmoInitialSessions)) { throw "AMO initial sessions response is not healthy." }
    }
    Write-Host "AMO Stable health check passed."
    Write-Host "Vite: $viteUrl"
    Write-Host "App pid(s): $((@($apps.Id) -join ', '))"
    if (-not $SkipBroker) { Write-Host "Broker and initial sessions: healthy" }
}

if ($HealthOnly -and $RestartOnly) { throw "HealthOnly and RestartOnly cannot be combined." }
if (-not (Test-Path -LiteralPath $cargoManifest)) { throw "Could not find Cargo manifest: $cargoManifest" }
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

if ($HealthOnly) {
    Assert-StableHealth
    exit 0
}

try {
    if (-not $RestartOnly) {
        $phase = "build fingerprint"
        $currentBuildFingerprint = Get-AmoStableBuildFingerprint
        $validatedBuildFingerprint = if (Test-Path -LiteralPath $buildFingerprintPath) {
            (Get-Content -LiteralPath $buildFingerprintPath -Raw).Trim()
        } else {
            ""
        }
        $buildRequired = -not (Test-Path -LiteralPath $appPath) -or
            -not (Test-Path -LiteralPath $frontendArtifactPath) -or
            $validatedBuildFingerprint -ne $currentBuildFingerprint

        if ($buildRequired) {
            $phase = "frontend build"
            Write-Host "Stable inputs changed; validating frontend before stopping the running UI..."
            Push-Location $overlayRoot
            try {
                npm run build
                if ($LASTEXITCODE -ne 0) { throw "Frontend build exited with code $LASTEXITCODE." }
            } finally {
                Pop-Location
            }

            $phase = "native build"
            Write-Host "Building Stable native executable in isolated target $buildRoot..."
            cargo build --locked --no-default-features --manifest-path $cargoManifest --target-dir $buildRoot
            if ($LASTEXITCODE -ne 0) { throw "Stable Cargo build exited with code $LASTEXITCODE." }
            if (-not (Test-Path -LiteralPath $builtAppPath)) { throw "Stable build did not produce $builtAppPath." }
        } else {
            Write-Host "Stable build inputs match the validated fingerprint; reusing existing artifacts."
        }
    } elseif (-not (Test-Path -LiteralPath $appPath)) {
        throw "RestartOnly requires an existing Stable executable at $appPath."
    }

    $phase = "existing UI shutdown"
    Stop-ExistingStableUi
    $listeners = @(Get-AmoPortProcesses -Port 1420)
    if ($listeners.Count -gt 0) { throw "Port 1420 remains in use by pid $((@($listeners.Id) -join ', '))." }

    if (-not $RestartOnly -and $buildRequired) {
        $phase = "native executable activation"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $appPath) | Out-Null
        if (Test-Path -LiteralPath $appPath) { Copy-Item -LiteralPath $appPath -Destination $backupAppPath -Force }
        Copy-Item -LiteralPath $builtAppPath -Destination $appPath -Force
        $binaryReplaced = $true
    }

    if ($SkipBroker) { $env:AGENT_MONITOR_SKIP_BROKER = "1" }
    else { Remove-Item Env:AGENT_MONITOR_SKIP_BROKER -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $viteStdout, $viteStderr, $appStdout, $appStderr, $brokerStdout, $brokerStderr -Force -ErrorAction SilentlyContinue

    $phase = "Vite startup"
    $viteScript = Join-Path $overlayRoot "node_modules\vite\bin\vite.js"
    if (-not (Test-Path -LiteralPath $viteScript)) { throw "Could not find Vite entry point: $viteScript" }
    $nodeCommand = Get-Command node -ErrorAction Stop
    $viteParams = @{
        FilePath = $nodeCommand.Source
        ArgumentList = @($viteScript, "preview", "--host", "127.0.0.1", "--port", "1420", "--strictPort")
        WorkingDirectory = $overlayRoot
        PassThru = $true
    }
    if (-not $DebugMode) {
        $viteParams.WindowStyle = "Hidden"
        $viteParams.RedirectStandardOutput = $viteStdout
        $viteParams.RedirectStandardError = $viteStderr
    }
    $viteProcess = Start-Process @viteParams
    Wait-AmoUrl -Url $viteUrl -Name "AMO Vite server"

    if (-not $SkipBroker) {
        $phase = "Broker startup"
        $brokerProcess = Start-Process -FilePath "node" -ArgumentList @($brokerServerPath) `
            -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $brokerStdout -RedirectStandardError $brokerStderr
        Wait-AmoBrokerHealth
        $env:AGENT_MONITOR_SKIP_BROKER = "1"
    }

    $phase = "native app startup"
    $appParams = @{
        FilePath = $appPath
        WorkingDirectory = $tauriRoot
        PassThru = $true
    }
    if (-not $DebugMode) {
        $appParams.WindowStyle = "Hidden"
        $appParams.RedirectStandardOutput = $appStdout
        $appParams.RedirectStandardError = $appStderr
    }
    $appProcess = Start-Process @appParams
    Start-Sleep -Milliseconds 900
    if ($appProcess.HasExited) { throw "Native app exited with code $($appProcess.ExitCode)." }

    if (-not $SkipBroker) {
        $phase = "Broker health"
        Wait-AmoBrokerHealth
        $phase = "initial sessions response"
        Wait-AmoInitialSessions
    }

    if (-not $RestartOnly -and $buildRequired) {
        $phase = "build fingerprint activation"
        Set-Content -LiteralPath $buildFingerprintPath -Value $currentBuildFingerprint -Encoding ASCII
    }

    $phase = "complete"
    Write-Host "AMO Stable startup passed all readiness checks."
    Write-Host "Mode: Stable (no Tauri watcher)"
    Write-Host "Vite: $viteUrl pid=$($viteProcess.Id)"
    Write-Host "App: $appPath pid=$($appProcess.Id)"
    if (-not $SkipBroker) { Write-Host "Broker: $brokerUrl pid=$($brokerProcess.Id) (health + initial sessions passed)" }
    Write-Host "Vite logs: $viteStdout | $viteStderr"
    Write-Host "App logs: $appStdout | $appStderr"
    if (-not $SkipBroker) { Write-Host "Broker logs: $brokerStdout | $brokerStderr" }
} catch {
    $failure = $_.Exception.Message
    if ($appProcess -and -not $appProcess.HasExited) { Stop-AmoProcessTree -ProcessId $appProcess.Id }
    if ($brokerProcess -and -not $brokerProcess.HasExited) { Stop-AmoProcessTree -ProcessId $brokerProcess.Id }
    if ($viteProcess -and -not $viteProcess.HasExited) { Stop-AmoProcessTree -ProcessId $viteProcess.Id }
    if ($binaryReplaced -and (Test-Path -LiteralPath $backupAppPath)) {
        Copy-Item -LiteralPath $backupAppPath -Destination $appPath -Force
    }
    throw "Stable startup failed during '$phase': $failure Vite stderr: $viteStderr Broker stderr: $brokerStderr App stderr: $appStderr"
} finally {
    if (Test-Path -LiteralPath $backupAppPath) {
        Remove-Item -LiteralPath $backupAppPath -Force -ErrorAction SilentlyContinue
    }
}
