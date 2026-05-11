param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath,
    [string]$BrokerUrl = "http://127.0.0.1:17654",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$signature = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class AmoSyncBackNative
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

Add-Type -TypeDefinition $signature

function New-Result {
    param(
        [bool]$Ok,
        [string]$Stage,
        [string]$Error,
        [string]$Message,
        $Window = $null,
        $Session = $null,
        [bool]$Activated = $false
    )

    return [ordered]@{
        ok = $Ok
        stage = $Stage
        error = $Error
        message = $Message
        activated = $Activated
        manualSendRequired = $true
        session = $Session
        window = $Window
    }
}

function Get-VisibleWindows {
    $windows = New-Object System.Collections.Generic.List[object]

    [AmoSyncBackNative+EnumWindowsProc]$callback = {
        param([IntPtr]$hWnd, [IntPtr]$lParam)

        if (-not [AmoSyncBackNative]::IsWindowVisible($hWnd)) {
            return $true
        }

        $builder = New-Object System.Text.StringBuilder 1024
        [void][AmoSyncBackNative]::GetWindowTextW($hWnd, $builder, $builder.Capacity)
        $title = $builder.ToString()
        if ([string]::IsNullOrWhiteSpace($title)) {
            return $true
        }

        [uint32]$processIdValue = 0
        [void][AmoSyncBackNative]::GetWindowThreadProcessId($hWnd, [ref]$processIdValue)

        try {
            $proc = Get-Process -Id ([int]$processIdValue) -ErrorAction Stop
            $processName = $proc.ProcessName
        } catch {
            $processName = ""
        }

        $windows.Add([pscustomobject]@{
            Hwnd = ("0x{0:X}" -f $hWnd.ToInt64())
            HwndInt = $hWnd.ToInt64()
            ProcessId = [int]$processIdValue
            ProcessName = $processName
            Title = $title
        })

        return $true
    }

    [void][AmoSyncBackNative]::EnumWindows($callback, [IntPtr]::Zero)
    return $windows.ToArray()
}

function Normalize-Session {
    param($Session)

    if (-not $Session) {
        return $null
    }

    return [ordered]@{
        sessionId = $Session.sessionId
        tool = $Session.tool
        cwd = $Session.cwd
        project = $Session.project
        updatedAt = $Session.updatedAt
        windowHint = $Session.windowHint
    }
}

function Normalize-WindowHint {
    param($Hint)

    if (-not $Hint) {
        return [ordered]@{
            titleToken = $null
            process = $null
            titleContains = @()
            project = $null
            cwd = $null
            pid = $null
            hwnd = $null
        }
    }

    $titleContains = @()
    if ($Hint.titleContains -is [System.Collections.IEnumerable] -and -not ($Hint.titleContains -is [string])) {
        foreach ($item in $Hint.titleContains) {
            if ($item) {
                $titleContains += [string]$item
            }
        }
    }

    return [ordered]@{
        titleToken = if ($Hint.titleToken) { [string]$Hint.titleToken } else { $null }
        process = if ($Hint.process) { [string]$Hint.process } else { $null }
        titleContains = $titleContains
        project = if ($Hint.project) { [string]$Hint.project } else { $null }
        cwd = if ($Hint.cwd) { [string]$Hint.cwd } else { $null }
        pid = if ($Hint.pid -ne $null) { [int]$Hint.pid } else { $null }
        hwnd = if ($Hint.hwnd -ne $null) { [int64]$Hint.hwnd } else { $null }
    }
}

function Get-BrokerSessions {
    param([string]$Url)

    try {
        $response = Invoke-RestMethod "$Url/api/sessions" -Method Get -TimeoutSec 2
        if ($response.sessions) {
            return @($response.sessions)
        }
    } catch {
        return @()
    }

    return @()
}

function Test-TitleContains {
    param([string]$Title, [string[]]$Needles)

    foreach ($needle in $Needles) {
        if ([string]::IsNullOrWhiteSpace($needle)) {
            continue
        }

        if ($Title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            return $false
        }
    }

    return $true
}

function Match-Process {
    param($Window, [string]$ProcessName)

    if ([string]::IsNullOrWhiteSpace($ProcessName)) {
        return $true
    }

    return (
        $Window.ProcessName -ieq $ProcessName -or
        $Window.ProcessName -ieq ($ProcessName -replace "\.exe$", "")
    )
}

function Basename-FromPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    return ($Path -split "[\\/]" | Where-Object { $_ } | Select-Object -Last 1)
}

function Resolve-Window {
    param(
        [object[]]$Windows,
        $Hint
    )

    if ($Hint.hwnd -ne $null) {
        $match = @($Windows | Where-Object { $_.HwndInt -eq $Hint.hwnd })
        if ($match.Count -eq 1) {
            return [ordered]@{ stage = "hwnd"; window = $match[0] }
        }
    }

    if ($Hint.pid -ne $null) {
        $match = @($Windows | Where-Object { $_.ProcessId -eq $Hint.pid })
        if ($Hint.process) {
            $match = @($match | Where-Object { Match-Process $_ $Hint.process })
        }
        if ($match.Count -eq 1) {
            return [ordered]@{ stage = "pid"; window = $match[0] }
        }
    }

    if ($Hint.titleToken) {
        $match = @($Windows | Where-Object {
            $_.Title.IndexOf($Hint.titleToken, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        if ($Hint.process) {
            $match = @($match | Where-Object { Match-Process $_ $Hint.process })
        }
        if ($match.Count -eq 1) {
            return [ordered]@{ stage = "titleToken"; window = $match[0] }
        }
        if ($match.Count -gt 1) {
            return [ordered]@{ stage = "titleToken"; error = "ambiguous_target"; candidates = $match }
        }
    }

    if ($Hint.process -and $Hint.titleContains.Count -gt 0) {
        $match = @($Windows | Where-Object {
            Match-Process $_ $Hint.process
        } | Where-Object {
            Test-TitleContains $_.Title $Hint.titleContains
        })
        if ($match.Count -eq 1) {
            return [ordered]@{ stage = "process_titleContains"; window = $match[0] }
        }
        if ($match.Count -gt 1) {
            return [ordered]@{ stage = "process_titleContains"; error = "ambiguous_target"; candidates = $match }
        }
    }

    $projectToken = if ($Hint.project) { $Hint.project } else { Basename-FromPath $Hint.cwd }
    if ($Hint.process -and $projectToken) {
        $match = @($Windows | Where-Object {
            Match-Process $_ $Hint.process
        } | Where-Object {
            $_.Title.IndexOf($projectToken, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        if ($match.Count -eq 1) {
            return [ordered]@{ stage = "process_project"; window = $match[0] }
        }
        if ($match.Count -gt 1) {
            return [ordered]@{ stage = "process_project"; error = "ambiguous_target"; candidates = $match }
        }
    }

    return [ordered]@{ stage = "none"; error = "window_not_found" }
}

if (-not (Test-Path -LiteralPath $RequestPath)) {
    $result = New-Result $false "request" "request_not_found" "Request file not found: $RequestPath"
    $result | ConvertTo-Json -Depth 8
    exit 2
}

$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$sessionId = $request.target.sessionId
$expectedTool = $request.target.expectedTool
$liveSessions = Get-BrokerSessions -Url $BrokerUrl
$liveSession = $liveSessions | Where-Object { $_.sessionId -eq $sessionId } | Select-Object -First 1

$requestHint = Normalize-WindowHint $request.target.windowHint
$liveHint = Normalize-WindowHint $(if ($liveSession) { $liveSession.windowHint } else { $null })
$hint = [ordered]@{
    titleToken = if ($liveHint.titleToken) { $liveHint.titleToken } else { $requestHint.titleToken }
    process = if ($liveHint.process) { $liveHint.process } else { $requestHint.process }
    titleContains = if ($liveHint.titleContains.Count -gt 0) { $liveHint.titleContains } else { $requestHint.titleContains }
    project = if ($liveHint.project) { $liveHint.project } else { $request.target.project }
    cwd = if ($liveHint.cwd) { $liveHint.cwd } else { $request.target.cwd }
    pid = if ($liveHint.pid -ne $null) { $liveHint.pid } else { $requestHint.pid }
    hwnd = if ($liveHint.hwnd -ne $null) { $liveHint.hwnd } else { $requestHint.hwnd }
}

if ($liveSession -and $expectedTool -and $liveSession.tool -and ($liveSession.tool -ne $expectedTool)) {
    $result = New-Result $false "session" "tool_mismatch" "Live session tool does not match expected tool." $null (Normalize-Session $liveSession)
    $result | ConvertTo-Json -Depth 8
    exit 3
}

$windows = Get-VisibleWindows
$resolved = Resolve-Window -Windows $windows -Hint $hint

if ($resolved.error) {
    $result = New-Result $false $resolved.stage $resolved.error "No unique target window was resolved." $null (Normalize-Session $liveSession)
    if ($resolved.candidates) {
        $result["candidates"] = @($resolved.candidates | Select-Object Hwnd, ProcessId, ProcessName, Title)
    }
    $result | ConvertTo-Json -Depth 8
    exit 4
}

$window = $resolved.window
$windowPayload = [ordered]@{
    hwnd = $window.Hwnd
    processId = $window.ProcessId
    processName = $window.ProcessName
    title = $window.Title
}

if ($DryRun) {
    $result = New-Result $true $resolved.stage $null "Dry run resolved a unique target window." $windowPayload (Normalize-Session $liveSession) $false
    $result | ConvertTo-Json -Depth 8
    exit 0
}

$hwnd = [IntPtr]::new([int64]$window.HwndInt)
[void][AmoSyncBackNative]::ShowWindow($hwnd, 9)
$activated = [AmoSyncBackNative]::SetForegroundWindow($hwnd)

if (-not $activated) {
    $result = New-Result $false $resolved.stage "focus_blocked" "SetForegroundWindow returned false." $windowPayload (Normalize-Session $liveSession) $false
    $result | ConvertTo-Json -Depth 8
    exit 5
}

$result = New-Result $true $resolved.stage $null "Target window focused. Manual paste/send is still required." $windowPayload (Normalize-Session $liveSession) $true
$result | ConvertTo-Json -Depth 8
exit 0
