use crate::models::OpenPathResult;
use std::path::PathBuf;

pub(crate) fn open_local_path(path: String) -> OpenPathResult {
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

#[cfg(windows)]
fn open_existing_path(path: &std::path::Path) -> OpenPathResult {
    open_external_target(&path.display().to_string(), "Opened")
}

#[cfg(windows)]
pub(crate) fn open_external_target(target: &str, success_prefix: &str) -> OpenPathResult {
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
pub(crate) fn open_external_target(target: &str, _success_prefix: &str) -> OpenPathResult {
    OpenPathResult {
        ok: false,
        message: format!("Opening external targets is only implemented on Windows for {target}."),
    }
}
