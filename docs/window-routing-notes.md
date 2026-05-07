# Window Routing Notes

Task: Task A Window Routing Spike
Date: 2026-05-07
Scope: Windows-first discovery and activation path for Codex / Claude / Kiro windows.

## Goal

Phase 1 needs to prove that the overlay can map a broker session to an existing desktop window and activate it after the user clicks a session row. This note focuses on the routing contract, not on broker, adapter, or overlay implementation.

## Current Local Observation

Command used:

```powershell
Get-Process |
  Where-Object { $_.MainWindowTitle } |
  Select-Object Id,ProcessName,MainWindowHandle,MainWindowTitle |
  Sort-Object ProcessName,Id |
  Format-Table -AutoSize
```

Relevant windows observed on this machine:

| Tool / app | Process | Title observed | Routing value |
| --- | --- | --- | --- |
| Codex | `Codex` | `Codex` | Process is visible, but title is too generic for multi-session routing. Needs explicit terminal/tab title convention. |
| Kiro | `Kiro` | `prefab-guide.md - project_mining - Kiro` | Title includes project name and app name. It is usable for project-level matching. |
| Windows Terminal | `WindowsTerminal` | `⠧ AgentMonitorOverlay` | Terminal title can carry the project/session label. This is the best first target for CLI sessions. |
| Rider | `rider64` | `UnityProject - MainChapterModeTDBattleSubViewModule.cs` | IDE title is project/file based and useful as an alternate project-level target. |
| Unity | `Unity` | `UnityProject - GameLauncher - Windows, Mac, Linux - Unity 2022.3.62f2 <DX11>` | Project-level title matching is possible, but not agent-session specific. |

Takeaway: the OS-level fields we can rely on in Phase 1 are `HWND`, process name, process id, main window title, and optionally executable path. Generic titles such as `Codex` are not enough when several sessions of the same tool are open.

The verification script uses `EnumWindows`, not only `Get-Process.MainWindowHandle`. This matters because some apps expose multiple visible top-level windows under one process. On this machine, `WindowsTerminal` had both `project_mining` and `AgentMonitorOverlay` top-level windows under the same process id, while `Get-Process.MainWindowTitle` only reports one main title.

## Matching Scheme Comparison

| Scheme | Match keys | Strengths | Failure modes | Fit for MVP |
| --- | --- | --- | --- | --- |
| A. Exact or prefix title token | `MainWindowTitle` contains a managed token such as `[AMO:codex:mecho:task-a]` | Simple, explainable, works across Windows Terminal, WezTerm, PowerShell, Kiro titles, and most IDE windows. It does not require invasive hooks. | Breaks when a terminal/app overwrites the title, when users rename tabs manually, or when the title token is not unique. | Best default. Make title token the primary route key. |
| B. Process + project/title fallback | `ProcessName` + normalized project name in title, for example `Kiro` + `project_mining` | Handles Kiro/IDE windows where the app controls the title. Useful when exact session token cannot be injected. | Project-level only. If there are multiple Kiro windows or multiple terminals under the same project, it may choose the wrong window. | Good fallback, especially for Kiro and IDE windows. |
| C. PID/HWND captured at session start | Stored `processId` and `hwnd` from adapter or launcher | Most precise while the window stays alive. Good for sessions started by a controlled launcher or broker-managed terminal. | `HWND` can become stale after app restart, tab detach, window recreation, or terminal process reuse. PID can point to the terminal host rather than the CLI child. | Useful as a fast path only after validation. Do not make it the only key. |
| D. Shell AppUserModelID / executable path | App identity, executable path, installed app metadata | Helps distinguish Windows Terminal, Kiro, Rider, Unity, Edge, etc. | Not session-specific and needs more Windows-specific plumbing. | Secondary diagnostic field, not primary routing. |
| E. External launcher/search tool fallback | Fluent Search, PowerToys Workspaces, manual Windows search | Useful when native activation fails or user wants a familiar fallback. | Not automatable enough for core product behavior. | Manual fallback only. |

## Recommended Strategy

Use a layered resolver. The broker session should carry a `windowHint` with stable, explicit fields:

```json
{
  "process": "WindowsTerminal.exe",
  "titleToken": "[AMO:codex:AgentMonitorOverlay:task-a]",
  "titleContains": ["AgentMonitorOverlay", "Codex"],
  "project": "AgentMonitorOverlay",
  "cwd": "G:\\PROJECT\\AgentMonitorOverlay",
  "tool": "codex",
  "pid": null,
  "hwnd": null
}
```

Resolver order:

1. If `hwnd` is present, validate it still exists, is visible, and still matches expected process/title. Use it only if validation passes.
2. Match exact `titleToken` in all visible top-level windows.
3. Match `process` plus `titleToken`.
4. Match `process` plus normalized `project` / `cwd` basename in title.
5. Match known IDE/app fallback for the project, for example `Kiro` + `project_mining`.
6. If multiple candidates remain, show a small disambiguation list in overlay instead of silently choosing.
7. If no candidate is found, expose fallback actions: copy session cwd, open project folder, or show the last known title/process.

Important detail: title matching should be case-insensitive and normalize whitespace, full-width separators, and common path separators. It should not depend on localized app suffixes such as `文件资源管理器`.

## Session Title Naming Standard

Use one explicit machine-readable token plus one human-readable label.

Format:

```text
[AMO:<tool>:<project-slug>:<session-slug>] <Tool> - <Project> - <Short task>
```

Examples:

```text
[AMO:codex:agent-monitor-overlay:window-routing] Codex - AgentMonitorOverlay - Window routing
[AMO:claude:project-mining:roguelite-ui] Claude - project_mining - Roguelite UI
[AMO:kiro:mecho:agent-docs] Kiro - Mecho - Agent docs
```

Rules:

- `tool`: lowercase stable id, initially `codex`, `claude`, `kiro`.
- `project-slug`: lowercase repo/project name, spaces converted to `-`.
- `session-slug`: short owner/task id, for example `task-a`, `broker-mvp`, `overlay-ui`.
- Keep the full title under roughly 120 characters so it remains visible in terminal and task switchers.
- The token must be unique among active sessions. If two sessions share the same task, append a short counter or date, for example `window-routing-2`.
- Human-readable label should start with the tool and project because users see that portion in task switchers even if the token is clipped.

Suggested startup commands:

```powershell
$Host.UI.RawUI.WindowTitle = "[AMO:codex:agent-monitor-overlay:window-routing] Codex - AgentMonitorOverlay - Window routing"
```

For Windows Terminal, prefer setting the tab title through terminal UI/settings when persistent titles are needed. For ad hoc PowerShell sessions, `$Host.UI.RawUI.WindowTitle` is enough for a low-code spike.

## Tauri / Win32 Activation Path

Phase 3 should implement activation as a Tauri command in Rust, not as frontend JavaScript only.

Recommended flow:

1. Frontend row click calls a Tauri command such as `activate_session_window(sessionId)`.
2. Rust backend asks the broker for `windowHint` or receives the hint in the click payload.
3. Rust enumerates visible top-level windows with Win32 APIs.
4. Resolver picks one candidate using the layered strategy above.
5. If minimized, restore it using `ShowWindow(hwnd, SW_RESTORE)`.
6. Bring it forward with `SetForegroundWindow(hwnd)`.
7. If `SetForegroundWindow` returns false or focus does not move, call a fallback such as `FlashWindowEx` and show an overlay message like `Window found but Windows blocked focus transfer`.

Win32 APIs expected:

- `EnumWindows`
- `IsWindowVisible`
- `GetWindowTextW`
- `GetWindowThreadProcessId`
- `ShowWindow` with `SW_RESTORE`
- `SetForegroundWindow`
- Optional fallback: `FlashWindowEx`

Windows imposes foreground activation restrictions. `SetForegroundWindow` can fail even when the target `HWND` is valid, especially when Windows decides the background process should not steal focus. Because the overlay click is user input, the MVP path should usually be allowed, but the implementation must treat activation failure as a normal recoverable outcome.

Tauri-side note: Tauri window APIs support app-window actions such as `unminimize()` and focus operations for Tauri-managed windows, but activating arbitrary external windows requires native Win32 calls from the Rust side.

## Verification Method

### Read-only enumeration

Use the included script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\window-routing\Get-WindowCandidates.ps1
```

Filter examples:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\window-routing\Get-WindowCandidates.ps1 -TitleContains AgentMonitorOverlay
powershell -ExecutionPolicy Bypass -File .\scripts\window-routing\Get-WindowCandidates.ps1 -ProcessName Kiro
```

Expected pass condition:

- At least three relevant windows are listed with non-zero `Hwnd`, `ProcessName`, `ProcessId`, and `Title`.
- For this local machine, the current observed candidates already include `Codex`, `Kiro`, and `WindowsTerminal`.

### Manual activation validation

Because activation changes desktop focus, run it manually during Phase 1 validation:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\window-routing\Get-WindowCandidates.ps1 -TitleContains AgentMonitorOverlay -ActivateFirst
```

Pass condition:

- The selected window is restored if minimized.
- The selected window becomes foreground, or Windows blocks it and the script reports `SetForegroundWindow returned false`.

### Three-window test plan

1. Open a Codex or PowerShell session for this repo and set title to:
   `[AMO:codex:agent-monitor-overlay:window-routing] Codex - AgentMonitorOverlay - Window routing`
2. Open Kiro on a known project and confirm a title like:
   `prefab-guide.md - project_mining - Kiro`
3. Open another terminal or IDE window for a second project, for example:
   `[AMO:claude:project-mining:hook-spike] Claude - project_mining - Hook spike`
4. Enumerate windows and confirm each has a unique match under the recommended resolver.
5. Activate each match by exact `titleToken`.
6. Rename one window to remove the token and confirm fallback matching either finds the project-level candidate or asks for disambiguation.

## Actual Verification Performed

Performed on 2026-05-07 in `G:\PROJECT\AgentMonitorOverlay`:

- Read the required context: `PROJECT_PLAN.md`, `USER_SESSION_MANUAL.md`, and `docs/tasks/task-a-window-routing-spike.md`.
- Enumerated current visible top-level windows using `Get-Process` with `MainWindowTitle`.
- Added and ran `scripts/window-routing/Get-WindowCandidates.ps1`, which enumerates visible top-level windows through Win32 `EnumWindows`.
- Verified title filtering:
  - Command: `powershell -ExecutionPolicy Bypass -File .\scripts\window-routing\Get-WindowCandidates.ps1 -TitleContains AgentMonitorOverlay`
  - Result: found `WindowsTerminal`, title `AgentMonitorOverlay`, non-zero `HWND`.
- Verified process filtering:
  - Command: `powershell -ExecutionPolicy Bypass -File .\scripts\window-routing\Get-WindowCandidates.ps1 -ProcessName Kiro`
  - Result: found `Kiro`, title `Preview prefab-guide.md - project_mining - Kiro`, non-zero `HWND`.
- Verified full enumeration included multiple relevant windows and showed that one process can expose multiple top-level windows:
  - `WindowsTerminal`, titles `project_mining` and `AgentMonitorOverlay`, same process id
  - `Kiro`, title `Preview prefab-guide.md - project_mining - Kiro`
  - `Codex`, title `Codex`
- Confirmed OS-visible candidate fields for at least these windows:
  - `Codex`, title `Codex`
  - `Kiro`, title `prefab-guide.md - project_mining - Kiro`
  - `WindowsTerminal`, title `⠧ AgentMonitorOverlay`
  - additional project windows such as Rider and Unity

Not yet performed:

- No active focus-switch test was run during this worker pass, to avoid disrupting the current session.
- No Codex / Claude / Kiro startup hook was modified to set title automatically.

## Remaining Questions

- Should the product require users or adapters to set the `[AMO:...]` title token for every monitored CLI session? This is the strongest routing strategy, but it introduces one visible naming convention.
- Should Kiro routing be project-level in MVP, or should the Kiro adapter later provide a more specific session/window hint?
- Should the overlay show a disambiguation list when multiple windows match, or should it jump to the most recently active candidate? Recommendation: show disambiguation; silent wrong-window jumps are worse than one extra click.
- Should the MVP include `FlashWindowEx` as a visible fallback when Windows blocks foreground focus? Recommendation: yes.

## Decision Needed

Supervisor/user should confirm whether the visible title-token convention is acceptable:

```text
[AMO:<tool>:<project-slug>:<session-slug>] <Tool> - <Project> - <Short task>
```

If accepted, Task B/C can treat `windowHint.titleToken` as the primary route key and only use process/project matching as fallback.

## References

- Microsoft Learn: `SetForegroundWindow` brings a window to foreground but Windows restricts which processes may do this, so failure must be handled.
  https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setforegroundwindow
- Tauri v2 window API documents Tauri-managed window focus/minimize operations; external app activation still needs native platform APIs.
  https://v2.tauri.app/reference/javascript/api/namespacewindow/
