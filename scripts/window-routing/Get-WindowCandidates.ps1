param(
    [string]$TitleContains,
    [string]$ProcessName,
    [switch]$ActivateFirst
)

$ErrorActionPreference = "Stop"

$signature = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WindowRoutingNative
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

$windows = New-Object System.Collections.Generic.List[object]

[WindowRoutingNative+EnumWindowsProc]$callback = {
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if (-not [WindowRoutingNative]::IsWindowVisible($hWnd)) {
        return $true
    }

    $builder = New-Object System.Text.StringBuilder 1024
    [void][WindowRoutingNative]::GetWindowTextW($hWnd, $builder, $builder.Capacity)
    $title = $builder.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) {
        return $true
    }

    [uint32]$processIdValue = 0
    [void][WindowRoutingNative]::GetWindowThreadProcessId($hWnd, [ref]$processIdValue)

    try {
        $proc = Get-Process -Id ([int]$processIdValue) -ErrorAction Stop
        $procName = $proc.ProcessName
        $path = $proc.Path
    } catch {
        $procName = ""
        $path = ""
    }

    $windows.Add([pscustomobject]@{
        Hwnd = ("0x{0:X}" -f $hWnd.ToInt64())
        HwndInt = $hWnd.ToInt64()
        ProcessId = [int]$processIdValue
        ProcessName = $procName
        Title = $title
        Path = $path
    })

    return $true
}

[void][WindowRoutingNative]::EnumWindows($callback, [IntPtr]::Zero)

$result = $windows

if ($TitleContains) {
    $result = $result | Where-Object {
        $_.Title.IndexOf($TitleContains, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    }
}

if ($ProcessName) {
    $result = $result | Where-Object {
        $_.ProcessName -ieq $ProcessName -or $_.ProcessName -ieq ($ProcessName -replace "\.exe$", "")
    }
}

$result = @($result | Sort-Object ProcessName, ProcessId, Title)

if ($ActivateFirst) {
    if ($result.Count -eq 0) {
        Write-Error "No matching window found."
    }

    $target = $result[0]
    $hwnd = [IntPtr]::new([int64]$target.HwndInt)

    # SW_RESTORE = 9. This restores a minimized window before foreground activation.
    [void][WindowRoutingNative]::ShowWindow($hwnd, 9)
    $activated = [WindowRoutingNative]::SetForegroundWindow($hwnd)

    [pscustomobject]@{
        Activated = $activated
        Hwnd = $target.Hwnd
        ProcessId = $target.ProcessId
        ProcessName = $target.ProcessName
        Title = $target.Title
    } | Format-List

    if (-not $activated) {
        Write-Warning "SetForegroundWindow returned false. Windows may have blocked focus transfer."
    }

    exit 0
}

$result |
    Select-Object Hwnd,ProcessId,ProcessName,Title,Path |
    Format-Table -AutoSize -Wrap
