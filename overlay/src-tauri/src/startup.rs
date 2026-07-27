use std::path::PathBuf;

use tauri::{window::Color, AppHandle, Manager};

use crate::models::OpenPathResult;

const STARTUP_THEME_FILE: &str = "startup-theme.txt";

fn normalize_theme(theme: &str) -> &'static str {
    if theme.trim().eq_ignore_ascii_case("light") {
        "light"
    } else {
        "dark"
    }
}

fn startup_theme_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|directory| directory.join(STARTUP_THEME_FILE))
}

fn load_startup_theme(app: &AppHandle) -> &'static str {
    let Some(path) = startup_theme_path(app) else {
        return "dark";
    };
    std::fs::read_to_string(path)
        .ok()
        .map(|theme| normalize_theme(&theme))
        .unwrap_or("dark")
}

fn theme_color(theme: &str) -> Color {
    if normalize_theme(theme) == "light" {
        Color(244, 248, 246, 255)
    } else {
        Color(20, 28, 32, 255)
    }
}

pub fn show_startup_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("startup") else {
        return Err("Startup window is not available.".to_string());
    };
    window
        .set_background_color(Some(theme_color(load_startup_theme(app))))
        .map_err(|error| format!("Could not set startup background: {error}"))?;
    window
        .show()
        .map_err(|error| format!("Could not show startup window: {error}"))
}

#[tauri::command]
pub fn set_startup_theme(app: AppHandle, theme: String) -> OpenPathResult {
    let theme = normalize_theme(&theme);
    let Some(path) = startup_theme_path(&app) else {
        return OpenPathResult {
            ok: false,
            message: "Could not resolve the AMO theme cache path.".to_string(),
        };
    };

    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return OpenPathResult {
                ok: false,
                message: format!("Could not create the AMO theme cache directory: {error}"),
            };
        }
    }
    if let Err(error) = std::fs::write(path, theme) {
        return OpenPathResult {
            ok: false,
            message: format!("Could not save the AMO startup theme: {error}"),
        };
    }

    if let Some(window) = app.get_webview_window("startup") {
        let _ = window.set_background_color(Some(theme_color(theme)));
    }
    OpenPathResult {
        ok: true,
        message: format!("AMO startup theme set to {theme}."),
    }
}
