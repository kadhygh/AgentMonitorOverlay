use crate::models::OpenPathResult;
use crate::windows::focus_vscode_workspace;
use std::path::{Path, PathBuf};

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

pub(crate) fn open_workspace_in_vscode(path: String) -> OpenPathResult {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return OpenPathResult {
            ok: false,
            message: format!("Workspace folder does not exist: {}", path.display()),
        };
    }

    let Ok(canonical_path) = path.canonicalize() else {
        return OpenPathResult {
            ok: false,
            message: format!("Could not resolve workspace folder: {}", path.display()),
        };
    };

    open_vscode_workspace(&canonical_path)
}

#[cfg(windows)]
fn open_vscode_workspace(path: &Path) -> OpenPathResult {
    use std::process::Command;

    let project_names = vscode_project_names(path);
    if let Some(result) = focus_vscode_workspace(&project_names) {
        return result;
    }

    let launch_result = if let Some(executable) = find_vscode_executable() {
        match Command::new(&executable).arg(path).spawn() {
            Ok(_) => OpenPathResult {
                ok: true,
                message: format!("Opened {} in VS Code.", path.display()),
            },
            Err(error) => OpenPathResult {
                ok: false,
                message: format!(
                    "Could not start VS Code at {}: {error}",
                    executable.display()
                ),
            },
        }
    } else {
        let uri = vscode_folder_uri(path);
        let result = open_external_target(&uri, "Dispatched VS Code workspace");
        if result.ok {
            OpenPathResult {
                ok: true,
                message: format!("Opened {} in VS Code.", path.display()),
            }
        } else {
            OpenPathResult {
                ok: false,
                message: format!(
                    "VS Code could not be found. Install VS Code or register its vscode:// URL handler. {}",
                    result.message
                ),
            }
        }
    };

    if !launch_result.ok {
        return launch_result;
    }

    for _ in 0..12 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Some(result) = focus_vscode_workspace(&project_names) {
            return result;
        }
    }

    launch_result
}

#[cfg(windows)]
fn vscode_project_names(path: &Path) -> Vec<String> {
    let mut names = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .map(|name| vec![name.to_string()])
        .unwrap_or_default();

    let Some(repository_identity) = git_repository_identity(path) else {
        return names;
    };
    let Some(parent) = path.parent() else {
        return names;
    };

    let mut sibling_names = std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let sibling = entry.path();
            if sibling == path || !sibling.is_dir() {
                return None;
            }
            if git_repository_identity(&sibling).as_deref() != Some(repository_identity.as_str()) {
                return None;
            }
            sibling
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .collect::<Vec<_>>();

    sibling_names.sort_by_key(|name| (name.len(), name.to_ascii_lowercase()));
    names.extend(sibling_names);
    names
}

#[cfg(windows)]
fn git_repository_identity(workspace_path: &Path) -> Option<String> {
    let git_path = workspace_path.join(".git");
    let config_path = if git_path.is_dir() {
        git_path.join("config")
    } else {
        let git_file = std::fs::read_to_string(&git_path).ok()?;
        let git_dir = git_file.trim().strip_prefix("gitdir:")?.trim();
        let git_dir = if Path::new(git_dir).is_absolute() {
            PathBuf::from(git_dir)
        } else {
            workspace_path.join(git_dir)
        };
        let common_dir = std::fs::read_to_string(git_dir.join("commondir"))
            .ok()
            .map(|value| git_dir.join(value.trim()))
            .unwrap_or(git_dir);
        common_dir.join("config")
    };

    let config = std::fs::read_to_string(config_path).ok()?;
    git_remote_url(&config).map(normalize_git_remote)
}

fn git_remote_url(config: &str) -> Option<&str> {
    let mut in_origin = false;
    let mut fallback = None;

    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_origin = trimmed.eq_ignore_ascii_case("[remote \"origin\"]");
            continue;
        }

        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("url") {
            continue;
        }

        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if in_origin {
            return Some(value);
        }
        fallback.get_or_insert(value);
    }

    fallback
}

fn normalize_git_remote(remote: &str) -> String {
    remote
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn find_vscode_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(configured) = std::env::var_os("VSCODE_EXECUTABLE_PATH") {
        candidates.push(PathBuf::from(configured));
    }

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(local_app_data).join("Programs");
        candidates.push(root.join("Microsoft VS Code").join("Code.exe"));
        candidates.push(
            root.join("Microsoft VS Code Insiders")
                .join("Code - Insiders.exe"),
        );
    }

    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(program_files) = std::env::var_os(variable) {
            let root = PathBuf::from(program_files);
            candidates.push(root.join("Microsoft VS Code").join("Code.exe"));
            candidates.push(
                root.join("Microsoft VS Code Insiders")
                    .join("Code - Insiders.exe"),
            );
        }
    }

    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        candidates.push(
            PathBuf::from(user_profile)
                .join("scoop")
                .join("apps")
                .join("vscode")
                .join("current")
                .join("Code.exe"),
        );
    }

    if let Some(path_value) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path_value) {
            candidates.push(directory.join("Code.exe"));
            candidates.push(directory.join("code.exe"));
            if directory
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
            {
                if let Some(parent) = directory.parent() {
                    candidates.push(parent.join("Code.exe"));
                    candidates.push(parent.join("Code - Insiders.exe"));
                }
            }
        }
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn vscode_folder_uri(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let encoded = percent_encode_uri_path(&normalized);
    format!("vscode://file/{encoded}")
}

fn percent_encode_uri_path(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~' | b'/' | b':')
        {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(not(windows))]
fn open_vscode_workspace(path: &Path) -> OpenPathResult {
    OpenPathResult {
        ok: false,
        message: format!(
            "Opening VS Code workspaces is only implemented on Windows for {}.",
            path.display()
        ),
    }
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

#[cfg(test)]
mod tests {
    use super::{git_remote_url, normalize_git_remote, percent_encode_uri_path, vscode_folder_uri};
    use std::path::Path;

    #[test]
    fn vscode_uri_preserves_path_separators_and_encodes_reserved_characters() {
        assert_eq!(
            vscode_folder_uri(Path::new(r"C:\My Project\foo#bar")),
            "vscode://file/C:/My%20Project/foo%23bar"
        );
    }

    #[test]
    fn vscode_uri_encodes_unicode_as_utf8() {
        assert_eq!(percent_encode_uri_path("C:/工程"), "C:/%E5%B7%A5%E7%A8%8B");
    }

    #[test]
    fn git_remote_identity_prefers_origin_and_normalizes_clone_urls() {
        let config = r#"
[remote "backup"]
    url = ssh://git@example.com/team/backup.git
[remote "origin"]
    url = https://GitLab.example.com/Team/Project.git/
"#;

        assert_eq!(
            git_remote_url(config).map(normalize_git_remote),
            Some("https://gitlab.example.com/team/project".to_string())
        );
    }
}
