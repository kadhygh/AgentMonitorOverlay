mod broker;
mod clipboard;
mod dialogs;
mod models;
mod opener;
mod scratchpad;
mod tray;
mod windows;

use broker::ensure_local_broker;
use clipboard::write_text_to_clipboard;
use dialogs::pick_workspace_directory;
use models::*;
use opener::{open_external_target, open_local_path};
use windows::{
    activate_external_window, external_window_candidate_at_cursor, list_external_window_candidates,
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
fn set_scratchpad_shortcut_config(config: ScratchpadShortcutConfig) -> ScratchpadShortcutResult {
    scratchpad::set_scratchpad_shortcut_config(config)
}

#[tauri::command]
fn show_scratchpad_at_cursor(app: tauri::AppHandle) -> OpenPathResult {
    scratchpad::show_scratchpad_at_current_cursor(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            scratchpad::install_scratchpad_mouse_hook(app.handle().clone());
            tray::install(app)?;
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
            tray::set_tray_attention_state,
            show_scratchpad_at_cursor,
            open_uri,
            write_clipboard_text
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agent Monitor Overlay");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            tray::stop_worker(app_handle);
        }
    });
}
