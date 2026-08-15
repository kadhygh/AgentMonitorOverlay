mod broker;
mod clipboard;
mod deepseek_harness;
mod dialogs;
mod model_credentials;
mod models;
mod opener;
mod scratchpad;
mod startup;
mod startup_diagnostics;
mod tray;
mod windows;

use broker::{ensure_local_broker, stop_owned_broker};
use clipboard::write_text_to_clipboard;
use dialogs::pick_workspace_directory;
use models::*;
use opener::{open_external_target, open_local_path, open_workspace_in_vscode};
use startup_diagnostics::{StartupDiagnostics, StartupDiagnosticsSnapshot};
use tauri::{Manager, State};
use tauri_plugin_notification::NotificationExt;
use windows::{
    activate_external_window, external_window_candidate_at_cursor, list_external_window_candidates,
    probe_external_window, probe_external_windows,
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
async fn open_vscode(path: String) -> OpenPathResult {
    tauri::async_runtime::spawn_blocking(move || open_workspace_in_vscode(path))
        .await
        .unwrap_or_else(|error| OpenPathResult {
            ok: false,
            message: format!("VS Code open task failed: {error}"),
        })
}

#[tauri::command]
fn open_uri(uri: String) -> OpenPathResult {
    if !uri.starts_with("obsidian://") && !uri.starts_with("codex://") {
        return OpenPathResult {
            ok: false,
            message: "Only obsidian:// and codex:// URIs are supported.".to_string(),
        };
    }

    open_external_target(&uri, "Dispatched URI")
}

#[tauri::command]
fn write_clipboard_text(text: String) -> OpenPathResult {
    write_text_to_clipboard(&text)
}

#[tauri::command]
async fn harness_lab_status() -> HarnessLabStatus {
    tauri::async_runtime::spawn_blocking(deepseek_harness::harness_status)
        .await
        .unwrap_or_else(|error| HarnessLabStatus {
            ok: false,
            state: "error".to_string(),
            installed: false,
            installed_version: None,
            recommended_version: "0.1.0-rc.6".to_string(),
            remote_version: None,
            update_available: false,
            installed_ahead: false,
            running: false,
            pid: None,
            url: "http://127.0.0.1:3080".to_string(),
            port: 3080,
            executable_path: None,
            executable_paths: Vec::new(),
            multiple_installations: false,
            package_root: None,
            npm_global_root: None,
            dsh_home: String::new(),
            node_available: false,
            node_version: None,
            npm_available: false,
            npm_version: None,
            pnpm_available: false,
            pnpm_version: None,
            install_source: None,
            message: format!("Harness status task failed: {error}"),
            recent_log: String::new(),
        })
}

#[tauri::command]
async fn install_global_harness() -> HarnessLabStatus {
    tauri::async_runtime::spawn_blocking(deepseek_harness::install_harness)
        .await
        .unwrap_or_else(|error| {
            let mut result = deepseek_harness::harness_status();
            result.ok = false;
            result.message = format!("Harness install task failed: {error}");
            result
        })
}

#[tauri::command]
async fn start_global_harness_web() -> HarnessLabStatus {
    tauri::async_runtime::spawn_blocking(deepseek_harness::start_harness_web)
        .await
        .unwrap_or_else(|error| {
            let mut result = deepseek_harness::harness_status();
            result.ok = false;
            result.message = format!("Harness Web start task failed: {error}");
            result
        })
}

#[tauri::command]
async fn stop_global_harness_web() -> HarnessLabStatus {
    tauri::async_runtime::spawn_blocking(deepseek_harness::stop_harness_web)
        .await
        .unwrap_or_else(|error| {
            let mut result = deepseek_harness::harness_status();
            result.ok = false;
            result.message = format!("Harness Web stop task failed: {error}");
            result
        })
}

#[tauri::command]
async fn check_harness_remote_version() -> HarnessLabStatus {
    tauri::async_runtime::spawn_blocking(deepseek_harness::check_remote_version)
        .await
        .unwrap_or_else(|error| {
            let mut result = deepseek_harness::harness_status();
            result.ok = false;
            result.message = format!("Harness version check task failed: {error}");
            result
        })
}

#[tauri::command]
async fn update_global_harness() -> HarnessLabStatus {
    tauri::async_runtime::spawn_blocking(deepseek_harness::update_harness)
        .await
        .unwrap_or_else(|error| {
            let mut result = deepseek_harness::harness_status();
            result.ok = false;
            result.message = format!("Harness update task failed: {error}");
            result
        })
}

#[tauri::command]
fn open_harness_lab_web() -> OpenPathResult {
    open_external_target("http://127.0.0.1:3080", "Opened DeepSeek Harness")
}

#[tauri::command]
fn select_workspace_directory() -> FolderPickResult {
    pick_workspace_directory()
}

#[tauri::command]
async fn ensure_broker() -> BrokerEnsureResult {
    if std::env::var("AGENT_MONITOR_SKIP_BROKER")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
    {
        return BrokerEnsureResult {
            ok: false,
            started: false,
            pid: None,
            message: "Broker startup is disabled for this run.".to_string(),
        };
    }
    tauri::async_runtime::spawn_blocking(ensure_local_broker)
        .await
        .unwrap_or_else(|error| BrokerEnsureResult {
            ok: false,
            started: false,
            pid: None,
            message: format!("Broker startup task failed: {error}"),
        })
}

#[tauri::command]
async fn model_credential_status(provider_ids: Vec<String>) -> ModelCredentialStatus {
    tauri::async_runtime::spawn_blocking(move || model_credentials::credential_status(provider_ids))
        .await
        .unwrap_or_else(|error| ModelCredentialStatus {
            ok: false,
            configured_provider_ids: Vec::new(),
            message: format!("Credential status task failed: {error}"),
        })
}

#[tauri::command]
async fn save_model_credential(provider_id: String, api_key: String) -> ModelCredentialResult {
    let fallback_provider_id = provider_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        model_credentials::save_credential(provider_id, api_key)
    })
    .await
    .unwrap_or_else(|error| ModelCredentialResult {
        ok: false,
        provider_id: fallback_provider_id,
        configured: false,
        api_key: None,
        message: format!("Credential save task failed: {error}"),
    })
}

#[tauri::command]
async fn delete_model_credential(provider_id: String) -> ModelCredentialResult {
    let fallback_provider_id = provider_id.clone();
    tauri::async_runtime::spawn_blocking(move || model_credentials::delete_credential(provider_id))
        .await
        .unwrap_or_else(|error| ModelCredentialResult {
            ok: false,
            provider_id: fallback_provider_id,
            configured: false,
            api_key: None,
            message: format!("Credential removal task failed: {error}"),
        })
}

#[tauri::command]
async fn resolve_model_credential(provider_id: String) -> ModelCredentialResult {
    let fallback_provider_id = provider_id.clone();
    tauri::async_runtime::spawn_blocking(move || model_credentials::resolve_credential(provider_id))
        .await
        .unwrap_or_else(|error| ModelCredentialResult {
            ok: false,
            provider_id: fallback_provider_id,
            configured: false,
            api_key: None,
            message: format!("Credential read task failed: {error}"),
        })
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
fn probe_session_windows(requests: Vec<WindowProbeRequest>) -> Vec<WindowProbeResult> {
    probe_external_windows(requests)
}

#[tauri::command]
fn signal_frontend_ready(diagnostics: State<'_, StartupDiagnostics>) -> OpenPathResult {
    diagnostics.record("firstVisibleFrame");
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
fn complete_startup(
    app: tauri::AppHandle,
    diagnostics: State<'_, StartupDiagnostics>,
) -> OpenPathResult {
    diagnostics.record("shellCommitted");
    let Some(main_window) = app.get_webview_window("main") else {
        return OpenPathResult {
            ok: false,
            message: "Main window is not available.".to_string(),
        };
    };

    if let Err(error) = main_window.show() {
        return OpenPathResult {
            ok: false,
            message: format!("Could not show main window: {error}"),
        };
    }
    let _ = main_window.unminimize();
    let _ = main_window.set_focus();
    diagnostics.record("mainVisible");

    if let Some(startup_window) = app.get_webview_window("startup") {
        let _ = startup_window.close();
    }

    OpenPathResult {
        ok: true,
        message: "Startup window replaced by main window.".to_string(),
    }
}

#[tauri::command]
fn record_startup_milestone(
    diagnostics: State<'_, StartupDiagnostics>,
    name: String,
) -> StartupDiagnosticsSnapshot {
    diagnostics.record(&name);
    diagnostics.snapshot()
}

#[tauri::command]
fn get_startup_diagnostics(
    diagnostics: State<'_, StartupDiagnostics>,
) -> StartupDiagnosticsSnapshot {
    diagnostics.snapshot()
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
        .manage(StartupDiagnostics::new())
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
            if let Err(error) = startup::show_startup_window(app.handle()) {
                eprintln!("AMO startup window warning: {error}");
            } else {
                app.state::<StartupDiagnostics>().record("startupVisible");
            }
            scratchpad::install_scratchpad_mouse_hook(app.handle().clone());
            tray::install(app)?;
            schedule_smoke_exit(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            activate_session_window,
            ensure_broker,
            model_credential_status,
            save_model_credential,
            delete_model_credential,
            resolve_model_credential,
            list_session_window_candidates,
            probe_session_window,
            probe_session_windows,
            window_candidate_at_cursor,
            open_path,
            harness_lab_status,
            install_global_harness,
            start_global_harness_web,
            stop_global_harness_web,
            check_harness_remote_version,
            update_global_harness,
            open_harness_lab_web,
            open_vscode,
            select_workspace_directory,
            set_scratchpad_shortcut_config,
            signal_frontend_ready,
            complete_startup,
            record_startup_milestone,
            get_startup_diagnostics,
            startup::set_startup_theme,
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
