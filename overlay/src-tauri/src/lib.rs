use serde::Serialize;

#[derive(Serialize)]
struct ActivationResult {
    ok: bool,
    message: String,
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
            hwnd,
        },
    )
}

#[derive(Debug)]
struct WindowHintInput {
    title: String,
    process_name: String,
    title_token: String,
    title_contains: Vec<String>,
    project: String,
    cwd: String,
    hwnd: Option<i64>,
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
            FlashWindowEx, SetForegroundWindow, ShowWindow, FLASHWINFO, FLASHW_TRAY,
            FLASHW_TIMERNOFG, SW_RESTORE,
        };

        let target_hwnd = selected.hwnd as HWND;
        ShowWindow(target_hwnd, SW_RESTORE);
        let activated = SetForegroundWindow(target_hwnd) != 0;

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
            .filter(|candidate| candidate.hwnd == hwnd as isize && candidate_matches_hint(candidate, hint))
            .cloned()
            .collect::<Vec<_>>();
        if let Some(candidate) = hwnd_matches.into_iter().next() {
            return ResolveResult::Matched(candidate);
        }
    }

    for matches in [
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
    if !hint.process_name.trim().is_empty() && !process_matches(candidate, &hint.process_name) {
        return false;
    }

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
        "{}:{} '{}'",
        candidate
            .process_name
            .as_deref()
            .unwrap_or("unknown-process"),
        candidate.process_id,
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
        .invoke_handler(tauri::generate_handler![activate_session_window])
        .run(tauri::generate_context!())
        .expect("error while running Agent Monitor Overlay");
}
