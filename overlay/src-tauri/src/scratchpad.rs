use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};

use tauri::{Emitter, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

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
static SCRATCHPAD_CTRL_REQUIRED: AtomicBool = AtomicBool::new(true);
static SCRATCHPAD_TRIGGER_SENDER: OnceLock<mpsc::Sender<ScratchpadTrigger>> = OnceLock::new();
static SCRATCHPAD_KEYBOARD_SHORTCUT: OnceLock<Mutex<Option<String>>> = OnceLock::new();

pub(crate) fn set_scratchpad_shortcut_config(
    app: &tauri::AppHandle,
    config: ScratchpadShortcutConfig,
) -> ScratchpadShortcutResult {
    let shortcut = normalize_scratchpad_shortcut(&config.shortcut);
    let Some(shortcut) = shortcut else {
        return ScratchpadShortcutResult {
            ok: false,
            enabled: false,
            shortcut: config.shortcut,
            message: "Unsupported scratchpad shortcut.".to_string(),
        };
    };

    let keyboard_slot = SCRATCHPAD_KEYBOARD_SHORTCUT.get_or_init(|| Mutex::new(None));
    let mut registered_keyboard = keyboard_slot.lock().unwrap_or_else(|error| error.into_inner());
    if !config.enabled {
        if let Some(previous) = registered_keyboard.take() {
            let _ = app.global_shortcut().unregister(previous.as_str());
        }
        SCRATCHPAD_ENABLED.store(false, Ordering::SeqCst);
    } else {
        match shortcut {
            NormalizedScratchpadShortcut::Mouse { button, ctrl_required } => {
                if let Some(previous) = registered_keyboard.take() {
                    let _ = app.global_shortcut().unregister(previous.as_str());
                }
                SCRATCHPAD_BUTTON.store(button, Ordering::SeqCst);
                SCRATCHPAD_CTRL_REQUIRED.store(ctrl_required, Ordering::SeqCst);
                SCRATCHPAD_ENABLED.store(true, Ordering::SeqCst);
            }
            NormalizedScratchpadShortcut::Keyboard(accelerator) => {
                let already_registered = registered_keyboard.as_deref() == Some(accelerator);
                if !already_registered {
                    if let Err(error) = app.global_shortcut().register(accelerator) {
                        return ScratchpadShortcutResult {
                            ok: false,
                            enabled: true,
                            shortcut: config.shortcut,
                            message: format!("Could not register {accelerator}: {error}. Previous shortcut remains active."),
                        };
                    }
                    if let Some(previous) = registered_keyboard.replace(accelerator.to_string()) {
                        let _ = app.global_shortcut().unregister(previous.as_str());
                    }
                }
                SCRATCHPAD_ENABLED.store(false, Ordering::SeqCst);
            }
        }
    }

    ScratchpadShortcutResult {
        ok: true,
        enabled: config.enabled,
        shortcut: config.shortcut.clone(),
        message: if config.enabled {
            format!("Scratchpad shortcut set to {}.", shortcut_label(&config.shortcut))
        } else {
            "Scratchpad shortcut disabled.".to_string()
        },
    }
}

#[derive(Clone, Copy)]
enum NormalizedScratchpadShortcut {
    Mouse { button: u32, ctrl_required: bool },
    Keyboard(&'static str),
}

fn normalize_scratchpad_shortcut(value: &str) -> Option<NormalizedScratchpadShortcut> {
    match value.trim().to_ascii_lowercase().as_str() {
        "ctrl+mouse4" => Some(NormalizedScratchpadShortcut::Mouse {
            button: SCRATCHPAD_BUTTON_MOUSE4,
            ctrl_required: true,
        }),
        "mouse4" => Some(NormalizedScratchpadShortcut::Mouse {
            button: SCRATCHPAD_BUTTON_MOUSE4,
            ctrl_required: false,
        }),
        "ctrl+mouse5" => Some(NormalizedScratchpadShortcut::Mouse {
            button: SCRATCHPAD_BUTTON_MOUSE5,
            ctrl_required: true,
        }),
        "mouse5" => Some(NormalizedScratchpadShortcut::Mouse {
            button: SCRATCHPAD_BUTTON_MOUSE5,
            ctrl_required: false,
        }),
        "ctrl+alt+z" => Some(NormalizedScratchpadShortcut::Keyboard("Ctrl+Alt+Z")),
        "ctrl+alt+space" => Some(NormalizedScratchpadShortcut::Keyboard("Ctrl+Alt+Space")),
        _ => None,
    }
}

fn shortcut_label(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(|part| match part {
            "ctrl" => "Ctrl",
            "alt" => "Alt",
            "z" => "Z",
            "space" => "Space",
            "mouse4" => "Mouse4",
            "mouse5" => "Mouse5",
            other => other,
        })
        .collect::<Vec<_>>()
        .join("+")
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
    {
        let event = &*(l_param as *const MSLLHOOKSTRUCT);
        let button = (event.mouseData >> 16) & 0xffff;
        let ctrl_pressed = (GetAsyncKeyState(0x11) as u16 & 0x8000) != 0;
        let ctrl_matches = !SCRATCHPAD_CTRL_REQUIRED.load(Ordering::SeqCst) || ctrl_pressed;
        if button == SCRATCHPAD_BUTTON.load(Ordering::SeqCst) && ctrl_matches {
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
