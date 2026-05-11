use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
struct ActivationResult {
    ok: bool,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianWindowTarget {
    hwnd: i64,
    process_id: u32,
    process_name: String,
    title: String,
}

#[derive(Clone, Debug)]
struct WindowCandidate {
    hwnd: isize,
    process_id: u32,
    process_name: Option<String>,
    title: String,
}

#[tauri::command]
fn activate_session_window(
    session_id: String,
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
fn list_obsidian_windows() -> Vec<ObsidianWindowTarget> {
    find_obsidian_windows()
}

#[tauri::command]
fn create_or_open_obsidian_note(
    vault_path: String,
    session_id: String,
    tool: String,
    cwd: String,
    project: String,
    title: String,
    state: String,
    last_event: String,
    last_message: String,
    updated_at: String,
    window_title: String,
    window_process: String,
    window_pid: Option<u32>,
    window_hwnd: Option<i64>,
    obsidian_title: String,
    obsidian_process: String,
    obsidian_pid: Option<u32>,
    obsidian_hwnd: Option<i64>,
) -> ActivationResult {
    match write_obsidian_note_request(ObsidianNoteRequestInput {
        vault_path,
        session_id,
        tool,
        cwd,
        project,
        title,
        state,
        last_event,
        last_message,
        updated_at,
        window_title,
        window_process,
        window_pid,
        window_hwnd,
        obsidian_title,
        obsidian_process,
        obsidian_pid,
        obsidian_hwnd,
    }) {
        Ok(result) => result,
        Err(message) => ActivationResult { ok: false, message },
    }
}

struct ObsidianNoteRequestInput {
    vault_path: String,
    session_id: String,
    tool: String,
    cwd: String,
    project: String,
    title: String,
    state: String,
    last_event: String,
    last_message: String,
    updated_at: String,
    window_title: String,
    window_process: String,
    window_pid: Option<u32>,
    window_hwnd: Option<i64>,
    obsidian_title: String,
    obsidian_process: String,
    obsidian_pid: Option<u32>,
    obsidian_hwnd: Option<i64>,
}

fn write_obsidian_note_request(input: ObsidianNoteRequestInput) -> Result<ActivationResult, String> {
    let vault_path = PathBuf::from(input.vault_path.trim());
    if !vault_path.exists() {
        return Err(format!(
            "Obsidian vault path does not exist: {}",
            vault_path.display()
        ));
    }
    if input.session_id.trim().is_empty() {
        return Err("Session id is required to create a linked note.".to_string());
    }

    let inbox_dir = vault_path.join(".amo").join("inbox");
    fs::create_dir_all(&inbox_dir)
        .map_err(|error| format!("Failed to create Obsidian inbox: {error}"))?;

    let project = if input.project.trim().is_empty() {
        cwd_basename(&input.cwd).unwrap_or("unknown-project").to_string()
    } else {
        input.project.clone()
    };
    let note_relative_path = format!(
        "AMO/Sessions/{}/{}-{}.md",
        safe_segment(&project),
        safe_segment(&input.tool),
        safe_segment(&input.session_id)
    );
    let request_id = format!("{}-{}", safe_segment(&input.session_id), unix_millis());
    let requested_at = iso_like_now();
    let request = json!({
        "schemaVersion": 1,
        "action": "create-linked-note",
        "requestId": request_id,
        "requestedAt": requested_at,
        "source": "agent-monitor-overlay",
        "session": {
            "sessionId": input.session_id,
            "tool": input.tool,
            "cwd": input.cwd,
            "project": project,
            "title": input.title,
            "state": input.state,
            "lastEvent": input.last_event,
            "lastMessage": input.last_message,
            "updatedAt": input.updated_at,
            "windowHint": {
                "title": input.window_title,
                "process": input.window_process,
                "pid": input.window_pid,
                "hwnd": input.window_hwnd
            }
        }
    });

    let request_path = inbox_dir.join(format!("create-linked-note-{request_id}.json"));
    let request_json = serde_json::to_string_pretty(&request)
        .map_err(|error| format!("Failed to serialize Obsidian request: {error}"))?;
    fs::write(&request_path, format!("{request_json}\n"))
        .map_err(|error| format!("Failed to write Obsidian request: {error}"))?;

    let focus_message = if let Some(target_hint) = obsidian_focus_hint(&input) {
        let result = activate_external_window("obsidian-target", target_hint);
        if result.ok {
            result.message
        } else {
            format!("Request queued, but Obsidian focus failed: {}", result.message)
        }
    } else {
        "Request queued. No Obsidian target selected yet.".to_string()
    };

    Ok(ActivationResult {
        ok: true,
        message: format!(
            "Queued Obsidian note request for {}. {} Request JSON: {}",
            note_relative_path,
            focus_message,
            request_path.display()
        ),
    })
}

#[derive(Debug)]
struct WindowHintInput {
    title: String,
    process_name: String,
    title_token: String,
    title_contains: Vec<String>,
    project: String,
    cwd: String,
    pid: Option<u32>,
    hwnd: Option<i64>,
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn iso_like_now() -> String {
    format!("unix-ms:{}", unix_millis())
}

fn safe_segment(value: &str) -> String {
    let mut output = String::new();
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            output.push(ch);
        } else {
            output.push('-');
        }
    }
    let collapsed = output
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        "unknown".to_string()
    } else {
        collapsed
    }
}

fn obsidian_focus_hint(input: &ObsidianNoteRequestInput) -> Option<WindowHintInput> {
    if input.obsidian_hwnd.is_none()
        && input.obsidian_pid.is_none()
        && input.obsidian_title.trim().is_empty()
        && input.obsidian_process.trim().is_empty()
    {
        return None;
    }

    Some(WindowHintInput {
        title: input.obsidian_title.clone(),
        process_name: input.obsidian_process.clone(),
        title_token: String::new(),
        title_contains: Vec::new(),
        project: String::new(),
        cwd: String::new(),
        pid: input.obsidian_pid,
        hwnd: input.obsidian_hwnd,
    })
}

#[cfg(not(windows))]
fn find_obsidian_windows() -> Vec<ObsidianWindowTarget> {
    Vec::new()
}

#[cfg(windows)]
fn find_obsidian_windows() -> Vec<ObsidianWindowTarget> {
    let mut targets = enumerate_windows()
        .into_iter()
        .filter(|candidate| process_matches(candidate, "Obsidian.exe"))
        .map(|candidate| ObsidianWindowTarget {
            hwnd: candidate.hwnd as i64,
            process_id: candidate.process_id,
            process_name: candidate
                .process_name
                .unwrap_or_else(|| "Obsidian.exe".to_string()),
            title: candidate.title,
        })
        .collect::<Vec<_>>();

    targets.sort_by(|left, right| left.title.to_lowercase().cmp(&right.title.to_lowercase()));
    targets
}

#[cfg(not(windows))]
fn activate_external_window(session_id: &str, _hint: WindowHintInput) -> ActivationResult {
    ActivationResult {
        ok: false,
        message: format!("Window activation is only implemented on Windows for {session_id}."),
    }
}

#[cfg(windows)]
fn activate_external_window(session_id: &str, hint: WindowHintInput) -> ActivationResult {
    let candidates = enumerate_windows();
    if candidates.is_empty() {
        return ActivationResult {
            ok: false,
            message: "No visible top-level windows were found.".to_string(),
        };
    }

    let selected = match resolve_candidate(&candidates, &hint) {
        ResolveResult::Matched(candidate) => candidate,
        ResolveResult::NoMatch => {
            return ActivationResult {
                ok: false,
                message: format!("No matching window found for {session_id}."),
            }
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
            };
        }
    };

    unsafe {
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            FlashWindowEx, FLASHWINFO, FLASHW_TRAY, FLASHW_TIMERNOFG,
        };

        let target_hwnd = selected.hwnd as HWND;
        let activated = focus_window(target_hwnd);

        if activated {
            ActivationResult {
                ok: true,
                message: format!("Activated {}", format_candidate(&selected)),
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
            }
        }
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
            .filter(|candidate| candidate.hwnd == hwnd as isize && candidate_matches_explicit_hwnd(candidate, hint))
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
fn matches_by_title_token(candidates: &[WindowCandidate], hint: &WindowHintInput) -> Vec<WindowCandidate> {
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
fn matches_by_process_and_title(candidates: &[WindowCandidate], hint: &WindowHintInput) -> Vec<WindowCandidate> {
    let title = normalized(&hint.title);
    if title.is_empty() {
        return Vec::new();
    }

    candidates
        .iter()
        .filter(|candidate| process_matches(candidate, &hint.process_name))
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
        .filter(|candidate| process_matches(candidate, &hint.process_name))
        .filter(|candidate| {
            let title = normalized(&candidate.title);
            parts.iter().all(|part| title.contains(part))
        })
        .cloned()
        .collect()
}

#[cfg(windows)]
fn matches_by_project_or_cwd(candidates: &[WindowCandidate], hint: &WindowHintInput) -> Vec<WindowCandidate> {
    let project = normalized(&hint.project);
    let cwd_basename = normalized(cwd_basename(&hint.cwd).unwrap_or_default());
    let target = if !project.is_empty() { project } else { cwd_basename };
    if target.is_empty() {
        return Vec::new();
    }

    candidates
        .iter()
        .filter(|candidate| {
            hint.process_name.trim().is_empty() || process_matches(candidate, &hint.process_name)
        })
        .filter(|candidate| normalized(&candidate.title).contains(&target))
        .cloned()
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
        .map(|actual| actual.trim_end_matches(".exe").eq_ignore_ascii_case(expected))
        .unwrap_or(false)
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
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }

            let title_len = GetWindowTextLengthW(hwnd);
            if title_len <= 0 {
                return 1;
            }

            let mut title_buffer = vec![0u16; title_len as usize + 1];
            let copied = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
            if copied <= 0 {
                return 1;
            }
            title_buffer.truncate(copied as usize);
            let title = String::from_utf16_lossy(&title_buffer);
            if title.trim().is_empty() {
                return 1;
            }

            let mut process_id = 0u32;
            GetWindowThreadProcessId(hwnd, &mut process_id);

            let candidates = &mut *(lparam as *mut Vec<WindowCandidate>);
            candidates.push(WindowCandidate {
                hwnd: hwnd as isize,
                process_id,
                process_name: process_name_for_pid(process_id),
                title,
            });

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
        .invoke_handler(tauri::generate_handler![
            activate_session_window,
            create_or_open_obsidian_note,
            list_obsidian_windows
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agent Monitor Overlay");
}
