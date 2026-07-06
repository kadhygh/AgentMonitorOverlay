use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, OnceLock};
use tauri::{Emitter, Manager, PhysicalPosition};

mod broker;
mod clipboard;
mod dialogs;
mod models;

use broker::ensure_local_broker;
use clipboard::write_text_to_clipboard;
use dialogs::pick_workspace_directory;
use models::*;

const SCRATCHPAD_WINDOW_LABEL: &str = "scratchpad";
const MAIN_WINDOW_LABEL: &str = "main";
const SCRATCHPAD_WIDTH: i32 = 480;
const SCRATCHPAD_HEIGHT: i32 = 320;
const SCRATCHPAD_OFFSET: i32 = 12;
const SCRATCHPAD_BUTTON_MOUSE4: u32 = 1;
const SCRATCHPAD_BUTTON_MOUSE5: u32 = 2;

static SCRATCHPAD_ENABLED: AtomicBool = AtomicBool::new(true);
static SCRATCHPAD_BUTTON: AtomicU32 = AtomicU32::new(SCRATCHPAD_BUTTON_MOUSE4);
static SCRATCHPAD_TRIGGER_SENDER: OnceLock<mpsc::Sender<ScratchpadTrigger>> = OnceLock::new();

#[tauri::command]
fn activate_session_window(
    session_id: String,
    tool: String,
    title: String,
    process_name: String,
    title_token: String,
    title_contains: Vec<String>,
    project: String,
    cwd: String,
    pid: Option<u32>,
    hwnd: Option<i64>,
) -> ActivationResult {
    activate_external_window(
        &session_id,
        WindowHintInput {
            tool,
            title,
            process_name,
            title_token,
            title_contains,
            project,
            cwd,
            pid,
            hwnd,
        },
    )
}

#[tauri::command]
fn list_session_window_candidates(
    session_id: String,
    tool: String,
    title: String,
    process_name: String,
    title_token: String,
    title_contains: Vec<String>,
    project: String,
    cwd: String,
    pid: Option<u32>,
    hwnd: Option<i64>,
) -> ActivationResult {
    list_external_window_candidates(
        &session_id,
        WindowHintInput {
            tool,
            title,
            process_name,
            title_token,
            title_contains,
            project,
            cwd,
            pid,
            hwnd,
        },
    )
}

#[tauri::command]
fn window_candidate_at_cursor() -> ActivationResult {
    external_window_candidate_at_cursor()
}

#[tauri::command]
fn open_path(path: String) -> OpenPathResult {
    open_local_path(path)
}

#[tauri::command]
fn open_uri(uri: String) -> OpenPathResult {
    if !uri.starts_with("obsidian://") && !uri.starts_with("codex://") {
        return OpenPathResult {
            ok: false,
            message: "Only obsidian:// and codex:// URIs are supported.".to_string(),
        };
    }

    open_external_target(&uri, "Opened URI")
}

#[tauri::command]
fn write_clipboard_text(text: String) -> OpenPathResult {
    write_text_to_clipboard(&text)
}

#[tauri::command]
fn select_workspace_directory() -> FolderPickResult {
    pick_workspace_directory()
}

#[tauri::command]
fn ensure_broker() -> BrokerEnsureResult {
    ensure_local_broker()
}

#[tauri::command]
fn set_scratchpad_shortcut_config(config: ScratchpadShortcutConfig) -> ScratchpadShortcutResult {
    let _ = normalize_scratchpad_button(&config.button);
    let button = SCRATCHPAD_BUTTON_MOUSE4;
    SCRATCHPAD_ENABLED.store(config.enabled, Ordering::SeqCst);
    SCRATCHPAD_BUTTON.store(button, Ordering::SeqCst);

    ScratchpadShortcutResult {
        ok: true,
        enabled: config.enabled,
        button: scratchpad_button_label(button).to_string(),
        message: if config.enabled {
            format!(
                "Scratchpad shortcut set to Ctrl+{}.",
                scratchpad_button_label(button)
            )
        } else {
            "Scratchpad shortcut disabled.".to_string()
        },
    }
}

#[tauri::command]
fn show_scratchpad_at_cursor(app: tauri::AppHandle) -> OpenPathResult {
    show_scratchpad_at_current_cursor(&app)
}

fn open_local_path(path: String) -> OpenPathResult {
    let path = PathBuf::from(path);
    if !path.exists() {
        return OpenPathResult {
            ok: false,
            message: format!("Path does not exist: {}", path.display()),
        };
    }

    let Ok(canonical_path) = path.canonicalize() else {
        return OpenPathResult {
            ok: false,
            message: format!("Could not resolve path: {}", path.display()),
        };
    };

    open_existing_path(&canonical_path)
}

fn normalize_scratchpad_button(value: &str) -> Option<u32> {
    match value.trim().to_ascii_lowercase().as_str() {
        "mouse4" | "xbutton1" | "button4" => Some(SCRATCHPAD_BUTTON_MOUSE4),
        "mouse5" | "xbutton2" | "button5" => Some(SCRATCHPAD_BUTTON_MOUSE5),
        _ => None,
    }
}

fn scratchpad_button_label(button: u32) -> &'static str {
    match button {
        SCRATCHPAD_BUTTON_MOUSE4 => "Mouse4",
        _ => "Mouse5",
    }
}

#[cfg(windows)]
fn install_scratchpad_mouse_hook(app: tauri::AppHandle) {
    let (sender, receiver) = mpsc::channel::<ScratchpadTrigger>();
    let _ = SCRATCHPAD_TRIGGER_SENDER.set(sender);

    std::thread::spawn(move || {
        while let Ok(trigger) = receiver.recv() {
            if is_scratchpad_focused(&app) {
                if let Some(window) = app.get_webview_window(SCRATCHPAD_WINDOW_LABEL) {
                    if let Err(error) = window.emit("scratchpad-copy-request", ()) {
                        eprintln!("Could not request scratchpad copy: {error}");
                    }
                }
                continue;
            }

            if let Err(message) = show_scratchpad_at(&app, trigger.x, trigger.y) {
                eprintln!("Could not show scratchpad: {message}");
            }
        }
    });

    std::thread::spawn(move || unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetMessageW, SetWindowsHookExW, WH_MOUSE_LL,
        };

        let hook = SetWindowsHookExW(
            WH_MOUSE_LL,
            Some(scratchpad_mouse_proc),
            std::ptr::null_mut(),
            0,
        );
        if hook.is_null() {
            eprintln!("Could not install AMO scratchpad mouse hook.");
            return;
        }

        let mut message = std::mem::zeroed();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {}
    });
}

#[cfg(not(windows))]
fn install_scratchpad_mouse_hook(_app: tauri::AppHandle) {}

#[cfg(windows)]
fn is_scratchpad_focused(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(SCRATCHPAD_WINDOW_LABEL)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

#[cfg(windows)]
unsafe extern "system" fn scratchpad_mouse_proc(
    code: i32,
    w_param: windows_sys::Win32::Foundation::WPARAM,
    l_param: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, MSLLHOOKSTRUCT, WM_XBUTTONDOWN,
    };

    if code >= 0
        && w_param as u32 == WM_XBUTTONDOWN
        && SCRATCHPAD_ENABLED.load(Ordering::SeqCst)
        && (GetAsyncKeyState(0x11) as u16 & 0x8000) != 0
    {
        let event = &*(l_param as *const MSLLHOOKSTRUCT);
        let button = (event.mouseData >> 16) & 0xffff;
        if button == SCRATCHPAD_BUTTON.load(Ordering::SeqCst) {
            if let Some(sender) = SCRATCHPAD_TRIGGER_SENDER.get() {
                let _ = sender.send(ScratchpadTrigger {
                    x: event.pt.x,
                    y: event.pt.y,
                });
            }
            return 1;
        }
    }

    CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param)
}

#[cfg(windows)]
fn show_scratchpad_at_current_cursor(app: &tauri::AppHandle) -> OpenPathResult {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut point) } != 0;
    if !ok {
        return OpenPathResult {
            ok: false,
            message: "Could not read cursor position.".to_string(),
        };
    }

    match show_scratchpad_at(app, point.x, point.y) {
        Ok(()) => OpenPathResult {
            ok: true,
            message: "Opened scratchpad at cursor.".to_string(),
        },
        Err(message) => OpenPathResult { ok: false, message },
    }
}

#[cfg(not(windows))]
fn show_scratchpad_at_current_cursor(_app: &tauri::AppHandle) -> OpenPathResult {
    OpenPathResult {
        ok: false,
        message: "Scratchpad shortcut is only implemented on Windows.".to_string(),
    }
}

#[cfg(windows)]
fn show_scratchpad_at(app: &tauri::AppHandle, cursor_x: i32, cursor_y: i32) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    let Some(window) = app.get_webview_window(SCRATCHPAD_WINDOW_LABEL) else {
        return Err("Scratchpad window is not available.".to_string());
    };
    if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = main_window.unminimize();
        let _ = main_window.show();
    }

    let virtual_left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let virtual_top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let virtual_width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let virtual_height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    let virtual_right = virtual_left + virtual_width;
    let virtual_bottom = virtual_top + virtual_height;

    let mut x = cursor_x + SCRATCHPAD_OFFSET;
    let mut y = cursor_y + SCRATCHPAD_OFFSET;
    if x + SCRATCHPAD_WIDTH > virtual_right {
        x = cursor_x - SCRATCHPAD_WIDTH - SCRATCHPAD_OFFSET;
    }
    if y + SCRATCHPAD_HEIGHT > virtual_bottom {
        y = cursor_y - SCRATCHPAD_HEIGHT - SCRATCHPAD_OFFSET;
    }
    x = x.clamp(virtual_left, virtual_right - SCRATCHPAD_WIDTH);
    y = y.clamp(virtual_top, virtual_bottom - SCRATCHPAD_HEIGHT);

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("Could not position scratchpad: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("Could not unminimize scratchpad: {error}"))?;
    window
        .show()
        .map_err(|error| format!("Could not show scratchpad: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Could not focus scratchpad: {error}"))?;
    Ok(())
}

#[cfg(windows)]
fn open_existing_path(path: &std::path::Path) -> OpenPathResult {
    open_external_target(&path.display().to_string(), "Opened")
}

#[cfg(windows)]
fn open_external_target(target: &str, success_prefix: &str) -> OpenPathResult {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation = wide_null("open");
    let file = wide_null(target);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;

    if result > 32 {
        OpenPathResult {
            ok: true,
            message: format!("{success_prefix} {target}"),
        }
    } else {
        OpenPathResult {
            ok: false,
            message: format!("Windows could not open {target} (ShellExecuteW code {result})."),
        }
    }
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

#[cfg(not(windows))]
fn open_existing_path(path: &std::path::Path) -> OpenPathResult {
    OpenPathResult {
        ok: false,
        message: format!(
            "Opening local files is only implemented on Windows for {}.",
            path.display()
        ),
    }
}

#[cfg(not(windows))]
fn open_external_target(target: &str, _success_prefix: &str) -> OpenPathResult {
    OpenPathResult {
        ok: false,
        message: format!("Opening external targets is only implemented on Windows for {target}."),
    }
}

#[derive(Debug)]
#[cfg(not(windows))]
fn activate_external_window(session_id: &str, _hint: WindowHintInput) -> ActivationResult {
    ActivationResult {
        ok: false,
        message: format!("Window activation is only implemented on Windows for {session_id}."),
        candidates: Vec::new(),
    }
}

#[cfg(not(windows))]
fn list_external_window_candidates(session_id: &str, _hint: WindowHintInput) -> ActivationResult {
    ActivationResult {
        ok: false,
        message: format!(
            "Window candidate listing is only implemented on Windows for {session_id}."
        ),
        candidates: Vec::new(),
    }
}

#[cfg(not(windows))]
fn external_window_candidate_at_cursor() -> ActivationResult {
    ActivationResult {
        ok: false,
        message: "Picking a window from the cursor is only implemented on Windows.".to_string(),
        candidates: Vec::new(),
    }
}

#[cfg(windows)]
fn activate_external_window(session_id: &str, hint: WindowHintInput) -> ActivationResult {
    let candidates = enumerate_windows();
    if candidates.is_empty() {
        return ActivationResult {
            ok: false,
            message: "No visible top-level windows were found.".to_string(),
            candidates: Vec::new(),
        };
    }

    let selected = match resolve_candidate(&candidates, &hint) {
        ResolveResult::Matched(candidate) => candidate,
        ResolveResult::NoMatch => {
            let fallback_candidates = fallback_activation_candidates(&candidates, &hint);
            return ActivationResult {
                ok: false,
                message: format!("No matching window found for {session_id}."),
                candidates: fallback_candidates,
            };
        }
        ResolveResult::Ambiguous(matches) => {
            let labels = matches
                .iter()
                .take(3)
                .map(|candidate| format_candidate(candidate))
                .collect::<Vec<_>>()
                .join("; ");
            return ActivationResult {
                ok: false,
                message: format!(
                    "{} matching windows for {session_id}; choose manually. {labels}",
                    matches.len()
                ),
                candidates: matches.iter().map(activation_candidate).collect(),
            };
        }
    };

    unsafe {
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            FlashWindowEx, FLASHWINFO, FLASHW_TIMERNOFG, FLASHW_TRAY,
        };

        let target_hwnd = selected.hwnd as HWND;
        let activated = focus_window(target_hwnd);

        if activated {
            ActivationResult {
                ok: true,
                message: format!("Activated {}", format_candidate(&selected)),
                candidates: Vec::new(),
            }
        } else {
            let mut flash = FLASHWINFO {
                cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
                hwnd: target_hwnd,
                dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG,
                uCount: 3,
                dwTimeout: 0,
            };
            FlashWindowEx(&mut flash);

            ActivationResult {
                ok: false,
                message: format!(
                    "Window found but Windows blocked focus transfer: {}",
                    format_candidate(&selected)
                ),
                candidates: Vec::new(),
            }
        }
    }
}

#[cfg(windows)]
fn list_external_window_candidates(session_id: &str, hint: WindowHintInput) -> ActivationResult {
    let candidates = enumerate_windows();
    if candidates.is_empty() {
        return ActivationResult {
            ok: false,
            message: "No visible top-level windows were found.".to_string(),
            candidates: Vec::new(),
        };
    }

    let matches = match resolve_candidate(&candidates, &hint) {
        ResolveResult::Matched(candidate) => vec![activation_candidate(&candidate)],
        ResolveResult::Ambiguous(matches) => matches.iter().map(activation_candidate).collect(),
        ResolveResult::NoMatch => fallback_activation_candidates(&candidates, &hint),
    };

    ActivationResult {
        ok: !matches.is_empty(),
        message: if matches.is_empty() {
            format!("No candidate windows found for {session_id}.")
        } else {
            format!(
                "{} candidate window(s) found for {session_id}.",
                matches.len()
            )
        },
        candidates: matches,
    }
}

#[cfg(windows)]
fn external_window_candidate_at_cursor() -> ActivationResult {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, WindowFromPoint};

    let mut point = POINT { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut point) } != 0;
    if !ok {
        return ActivationResult {
            ok: false,
            message: "Could not read cursor position.".to_string(),
            candidates: Vec::new(),
        };
    }

    let hwnd = unsafe { WindowFromPoint(point) };
    let Some(candidate) = window_candidate_from_hwnd(hwnd) else {
        return ActivationResult {
            ok: false,
            message: "No visible window found under cursor.".to_string(),
            candidates: Vec::new(),
        };
    };

    if candidate.process_id == std::process::id() {
        return ActivationResult {
            ok: false,
            message: "Release over an external CLI or app window, not AMO.".to_string(),
            candidates: Vec::new(),
        };
    }

    ActivationResult {
        ok: true,
        message: format!("Selected {}", format_candidate(&candidate)),
        candidates: vec![activation_candidate(&candidate)],
    }
}

#[cfg(windows)]
unsafe fn focus_window(target_hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        ShowWindow, SW_RESTORE,
    };

    ShowWindow(target_hwnd, SW_RESTORE);

    let current_thread = GetCurrentThreadId();
    let mut target_pid = 0u32;
    let target_thread = GetWindowThreadProcessId(target_hwnd, &mut target_pid);

    let foreground_hwnd: HWND = GetForegroundWindow();
    let mut foreground_pid = 0u32;
    let foreground_thread = if foreground_hwnd.is_null() {
        0
    } else {
        GetWindowThreadProcessId(foreground_hwnd, &mut foreground_pid)
    };

    let attach_target = target_thread != 0 && target_thread != current_thread;
    let attach_foreground = foreground_thread != 0 && foreground_thread != current_thread;

    if attach_target {
        AttachThreadInput(current_thread, target_thread, 1);
    }
    if attach_foreground {
        AttachThreadInput(current_thread, foreground_thread, 1);
    }

    BringWindowToTop(target_hwnd);
    let activated = SetForegroundWindow(target_hwnd) != 0;

    if attach_foreground {
        AttachThreadInput(current_thread, foreground_thread, 0);
    }
    if attach_target {
        AttachThreadInput(current_thread, target_thread, 0);
    }

    activated
}

#[cfg(windows)]
enum ResolveResult {
    Matched(WindowCandidate),
    Ambiguous(Vec<WindowCandidate>),
    NoMatch,
}

#[cfg(windows)]
fn resolve_candidate(candidates: &[WindowCandidate], hint: &WindowHintInput) -> ResolveResult {
    if let Some(hwnd) = hint.hwnd {
        let hwnd_matches = candidates
            .iter()
            .filter(|candidate| {
                candidate.hwnd == hwnd as isize && candidate_matches_explicit_hwnd(candidate, hint)
            })
            .cloned()
            .collect::<Vec<_>>();
        if let Some(candidate) = hwnd_matches.into_iter().next() {
            return ResolveResult::Matched(candidate);
        }
    }

    for matches in [
        matches_by_pid(candidates, hint),
        matches_by_title_token(candidates, hint),
        matches_by_process_and_title(candidates, hint),
        matches_by_process_and_title_contains(candidates, hint),
        matches_by_project_or_cwd(candidates, hint),
        matches_by_tool_title(candidates, hint),
    ] {
        match matches.len() {
            0 => {}
            1 => return ResolveResult::Matched(matches[0].clone()),
            _ => return ResolveResult::Ambiguous(matches),
        }
    }

    ResolveResult::NoMatch
}

#[cfg(windows)]
fn matches_by_pid(candidates: &[WindowCandidate], hint: &WindowHintInput) -> Vec<WindowCandidate> {
    let Some(pid) = hint.pid else {
        return Vec::new();
    };

    candidates
        .iter()
        .filter(|candidate| candidate.process_id == pid)
        .cloned()
        .collect()
}

#[cfg(windows)]
fn matches_by_title_token(
    candidates: &[WindowCandidate],
    hint: &WindowHintInput,
) -> Vec<WindowCandidate> {
    let token = normalized(&hint.title_token);
    if token.is_empty() {
        return Vec::new();
    }

    candidates
        .iter()
        .filter(|candidate| normalized(&candidate.title).contains(&token))
        .cloned()
        .collect()
}

#[cfg(windows)]
fn matches_by_process_and_title(
    candidates: &[WindowCandidate],
    hint: &WindowHintInput,
) -> Vec<WindowCandidate> {
    let title = normalized(&hint.title);
    if title.is_empty() {
        return Vec::new();
    }

    candidates
        .iter()
        .filter(|candidate| candidate_process_matches_hint(candidate, hint))
        .filter(|candidate| normalized(&candidate.title).contains(&title))
        .cloned()
        .collect()
}

#[cfg(windows)]
fn matches_by_process_and_title_contains(
    candidates: &[WindowCandidate],
    hint: &WindowHintInput,
) -> Vec<WindowCandidate> {
    let parts = hint
        .title_contains
        .iter()
        .map(|part| normalized(part))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return Vec::new();
    }

    candidates
        .iter()
        .filter(|candidate| candidate_process_matches_hint(candidate, hint))
        .filter(|candidate| {
            let title = normalized(&candidate.title);
            parts.iter().all(|part| title.contains(part))
        })
        .cloned()
        .collect()
}

#[cfg(windows)]
fn matches_by_project_or_cwd(
    candidates: &[WindowCandidate],
    hint: &WindowHintInput,
) -> Vec<WindowCandidate> {
    let project = normalized(&hint.project);
    let cwd_basename = normalized(cwd_basename(&hint.cwd).unwrap_or_default());
    let target = if !project.is_empty() {
        project
    } else {
        cwd_basename
    };
    if target.is_empty() {
        return Vec::new();
    }

    candidates
        .iter()
        .filter(|candidate| candidate_process_matches_hint(candidate, hint))
        .filter(|candidate| normalized(&candidate.title).contains(&target))
        .cloned()
        .collect()
}

#[cfg(windows)]
fn matches_by_tool_title(
    candidates: &[WindowCandidate],
    hint: &WindowHintInput,
) -> Vec<WindowCandidate> {
    let tokens = fallback_tool_title_tokens(&hint.tool);
    if tokens.is_empty() {
        return Vec::new();
    }

    candidates
        .iter()
        .filter(|candidate| {
            tool_process_matches(candidate, &hint.tool) || candidate.process_name.is_none()
        })
        .filter(|candidate| {
            let title = normalized(&candidate.title);
            tokens.iter().any(|token| title.contains(token))
        })
        .cloned()
        .collect()
}

#[cfg(windows)]
fn fallback_tool_title_tokens(tool: &str) -> Vec<String> {
    let tool = normalized(tool);
    if tool.starts_with("claude") {
        return vec!["claude".to_string()];
    }
    if tool.starts_with("codex") {
        return vec!["codex".to_string()];
    }
    Vec::new()
}

#[cfg(windows)]
fn fallback_activation_candidates(
    candidates: &[WindowCandidate],
    hint: &WindowHintInput,
) -> Vec<ActivationCandidate> {
    let title_matches = matches_by_tool_title(candidates, hint);
    if !title_matches.is_empty() {
        return title_matches.iter().map(activation_candidate).collect();
    }

    candidates
        .iter()
        .filter(|candidate| {
            candidate_process_matches_hint(candidate, hint)
                || tool_process_matches(candidate, &hint.tool)
                || candidate.process_name.is_none()
        })
        .take(8)
        .map(activation_candidate)
        .collect()
}

#[cfg(windows)]
fn candidate_matches_hint(candidate: &WindowCandidate, hint: &WindowHintInput) -> bool {
    let title = normalized(&candidate.title);
    let token = normalized(&hint.title_token);
    if !token.is_empty() && title.contains(&token) {
        return true;
    }

    let expected_title = normalized(&hint.title);
    if !expected_title.is_empty() && title.contains(&expected_title) {
        return true;
    }

    let project = normalized(&hint.project);
    !project.is_empty() && title.contains(&project)
}

#[cfg(windows)]
fn candidate_matches_explicit_hwnd(candidate: &WindowCandidate, hint: &WindowHintInput) -> bool {
    if let Some(pid) = hint.pid {
        return candidate.process_id == pid;
    }

    if !hint.process_name.trim().is_empty() && process_matches(candidate, &hint.process_name) {
        return true;
    }

    if candidate_matches_hint(candidate, hint) {
        return true;
    }

    hint.process_name.trim().is_empty()
        && hint.title_token.trim().is_empty()
        && hint.title.trim().is_empty()
        && hint.project.trim().is_empty()
}

#[cfg(windows)]
fn process_matches(candidate: &WindowCandidate, expected: &str) -> bool {
    let expected = expected.trim().trim_end_matches(".exe");
    if expected.is_empty() {
        return true;
    }

    candidate
        .process_name
        .as_deref()
        .map(|actual| {
            actual
                .trim_end_matches(".exe")
                .eq_ignore_ascii_case(expected)
        })
        .unwrap_or(false)
}

#[cfg(windows)]
fn candidate_process_matches_hint(candidate: &WindowCandidate, hint: &WindowHintInput) -> bool {
    if !hint.process_name.trim().is_empty() {
        return process_matches(candidate, &hint.process_name);
    }

    tool_process_matches(candidate, &hint.tool)
}

#[cfg(windows)]
fn tool_process_matches(candidate: &WindowCandidate, tool: &str) -> bool {
    let tool = normalized(tool);
    if tool.is_empty() {
        return true;
    }

    let Some(actual) = candidate.process_name.as_deref() else {
        return false;
    };
    let process = actual.trim_end_matches(".exe").to_lowercase();

    match tool.as_str() {
        value if value.starts_with("codex") => {
            matches!(
                process.as_str(),
                "windowsterminal" | "powershell" | "pwsh" | "cmd" | "conhost" | "codex"
            )
        }
        value if value.starts_with("claude") => {
            matches!(
                process.as_str(),
                "windowsterminal" | "powershell" | "pwsh" | "cmd" | "conhost" | "claude"
            )
        }
        value if value.starts_with("kiro") => process == "kiro",
        _ => true,
    }
}

#[cfg(windows)]
fn normalized(value: &str) -> String {
    value
        .to_lowercase()
        .replace('\\', "/")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
fn cwd_basename(cwd: &str) -> Option<&str> {
    cwd.rsplit(['\\', '/']).find(|part| !part.trim().is_empty())
}

#[cfg(windows)]
fn format_candidate(candidate: &WindowCandidate) -> String {
    format!(
        "{}:{} hwnd=0x{:X} '{}'",
        candidate
            .process_name
            .as_deref()
            .unwrap_or("unknown-process"),
        candidate.process_id,
        candidate.hwnd,
        candidate.title
    )
}

#[cfg(windows)]
fn enumerate_windows() -> Vec<WindowCandidate> {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows;

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            if let Some(candidate) = window_candidate_from_hwnd(hwnd) {
                let candidates = &mut *(lparam as *mut Vec<WindowCandidate>);
                candidates.push(candidate);
            }

            1
        }
    }

    let mut candidates = Vec::new();
    unsafe {
        EnumWindows(Some(enum_proc), &mut candidates as *mut _ as LPARAM);
    }
    candidates
}

#[cfg(windows)]
fn window_candidate_from_hwnd(
    hwnd: windows_sys::Win32::Foundation::HWND,
) -> Option<WindowCandidate> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, GA_ROOT,
    };

    unsafe {
        if hwnd.is_null() {
            return None;
        }

        let root = GetAncestor(hwnd, GA_ROOT);
        let target_hwnd = if root.is_null() { hwnd } else { root };

        if IsWindowVisible(target_hwnd) == 0 {
            return None;
        }

        let title_len = GetWindowTextLengthW(target_hwnd);
        if title_len <= 0 {
            return None;
        }

        let mut title_buffer = vec![0u16; title_len as usize + 1];
        let copied = GetWindowTextW(
            target_hwnd,
            title_buffer.as_mut_ptr(),
            title_buffer.len() as i32,
        );
        if copied <= 0 {
            return None;
        }

        title_buffer.truncate(copied as usize);
        let title = String::from_utf16_lossy(&title_buffer);
        if title.trim().is_empty() {
            return None;
        }

        let mut process_id = 0u32;
        GetWindowThreadProcessId(target_hwnd, &mut process_id);

        Some(WindowCandidate {
            hwnd: target_hwnd as isize,
            process_id,
            process_name: process_name_for_pid(process_id),
            title,
        })
    }
}

#[cfg(windows)]
fn process_name_for_pid(process_id: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if handle.is_null() {
            return None;
        }

        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) != 0;
        CloseHandle(handle);

        if !ok || size == 0 {
            return None;
        }

        buffer.truncate(size as usize);
        let full_path = String::from_utf16_lossy(&buffer);
        let file_name = full_path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(full_path.as_str())
            .to_string();
        Some(file_name)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            install_scratchpad_mouse_hook(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            activate_session_window,
            ensure_broker,
            list_session_window_candidates,
            window_candidate_at_cursor,
            open_path,
            select_workspace_directory,
            set_scratchpad_shortcut_config,
            show_scratchpad_at_cursor,
            open_uri,
            write_clipboard_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agent Monitor Overlay");
}

#[cfg(windows)]
fn activation_candidate(candidate: &WindowCandidate) -> ActivationCandidate {
    ActivationCandidate {
        hwnd: candidate.hwnd as i64,
        process_id: candidate.process_id,
        process_name: candidate.process_name.clone(),
        title: candidate.title.clone(),
        label: format_candidate(candidate),
    }
}
