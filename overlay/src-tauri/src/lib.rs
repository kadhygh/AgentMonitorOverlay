mod broker;
mod clipboard;
mod dialogs;
mod models;
mod opener;
mod scratchpad;
mod tray;
mod windows;

use broker::{ensure_local_broker, stop_owned_broker};
use clipboard::write_text_to_clipboard;
use dialogs::pick_workspace_directory;
use models::*;
use opener::{open_external_target, open_local_path};
use tauri_plugin_notification::NotificationExt;
use windows::{
    activate_external_window, external_window_candidate_at_cursor, list_external_window_candidates,
    probe_external_window,
};

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
fn probe_session_window(
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
    probe_external_window(
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
fn signal_frontend_ready() -> OpenPathResult {
    let Ok(path) = std::env::var("AGENT_MONITOR_SMOKE_FRONTEND_READY_FILE") else {
        return OpenPathResult {
            ok: true,
            message: "Frontend ready.".to_string(),
        };
    };

    match std::fs::write(path, "ready\n") {
        Ok(()) => OpenPathResult {
            ok: true,
            message: "Frontend smoke marker written.".to_string(),
        },
        Err(error) => OpenPathResult {
            ok: false,
            message: format!("Frontend smoke marker failed: {error}"),
        },
    }
}

#[tauri::command]
fn show_windows_notification(app: tauri::AppHandle, title: String, body: String) -> OpenPathResult {
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => OpenPathResult {
            ok: true,
            message: "Windows notification sent.".to_string(),
        },
        Err(error) => OpenPathResult {
            ok: false,
            message: format!("Windows notification failed: {error}"),
        },
    }
}

#[tauri::command]
fn set_scratchpad_shortcut_config(
    app: tauri::AppHandle,
    config: ScratchpadShortcutConfig,
) -> ScratchpadShortcutResult {
    scratchpad::set_scratchpad_shortcut_config(&app, config)
}

#[tauri::command]
fn show_scratchpad_at_cursor(app: tauri::AppHandle) -> OpenPathResult {
    scratchpad::show_scratchpad_at_current_cursor(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = scratchpad::show_scratchpad_at_current_cursor(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let broker = ensure_local_broker();
            if !broker.ok {
                eprintln!("AMO Broker startup failed: {}", broker.message);
            }
            scratchpad::install_scratchpad_mouse_hook(app.handle().clone());
            tray::install(app)?;
            schedule_smoke_exit(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            activate_session_window,
            ensure_broker,
            list_session_window_candidates,
            probe_session_window,
            window_candidate_at_cursor,
            open_path,
            select_workspace_directory,
            set_scratchpad_shortcut_config,
            signal_frontend_ready,
            show_windows_notification,
            tray::set_tray_attention_state,
            show_scratchpad_at_cursor,
            open_uri,
            write_clipboard_text
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agent Monitor Overlay");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            stop_owned_broker();
            tray::stop_worker(app_handle);
        }
    });
}

fn schedule_smoke_exit(app: tauri::AppHandle) {
    let delay_ms = std::env::var("AGENT_MONITOR_SMOKE_EXIT_AFTER_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0);
    let Some(delay_ms) = delay_ms else {
        return;
    };

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        app.exit(0);
    });
}
