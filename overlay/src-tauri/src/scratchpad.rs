use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, OnceLock};

use tauri::{Emitter, Manager, PhysicalPosition};

use crate::models::{
    OpenPathResult, ScratchpadShortcutConfig, ScratchpadShortcutResult, ScratchpadTrigger,
};

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

pub(crate) fn set_scratchpad_shortcut_config(
    config: ScratchpadShortcutConfig,
) -> ScratchpadShortcutResult {
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
pub(crate) fn install_scratchpad_mouse_hook(app: tauri::AppHandle) {
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
pub(crate) fn install_scratchpad_mouse_hook(_app: tauri::AppHandle) {}

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
pub(crate) fn show_scratchpad_at_current_cursor(app: &tauri::AppHandle) -> OpenPathResult {
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
pub(crate) fn show_scratchpad_at_current_cursor(_app: &tauri::AppHandle) -> OpenPathResult {
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
