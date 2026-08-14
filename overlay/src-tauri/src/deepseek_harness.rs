use crate::model_credentials;
use crate::models::HarnessLabStatus;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const HARNESS_VERSION: &str = "0.1.0-rc.6";
const HARNESS_PACKAGE: &str = "@deepseek-ai/dsh";
const HARNESS_HOST: &str = "127.0.0.1";
const HARNESS_PORT: u16 = 3080;
const HARNESS_URL: &str = "http://127.0.0.1:3080";
const CREATE_NO_WINDOW: u32 = 0x08000000;

static OWNED_HARNESS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static LAST_EXIT_CODE: OnceLock<Mutex<Option<i32>>> = OnceLock::new();
static REMOTE_VERSION: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[derive(Clone)]
struct HarnessPaths {
    workspace_root: PathBuf,
    managed_runtime: PathBuf,
    bundled_runtime: PathBuf,
    data_root: PathBuf,
    dsh_home: PathBuf,
    logs_root: PathBuf,
    portable_node: Option<PathBuf>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WebHealth {
    Harness,
    PortConflict,
    Unavailable,
}

pub(crate) fn harness_status() -> HarnessLabStatus {
    let paths = harness_paths();
    build_status(&paths, None, None)
}

pub(crate) fn install_harness() -> HarnessLabStatus {
    let paths = harness_paths();
    let installed_version = read_installed_version(&active_runtime(&paths));
    let version = installed_version
        .as_deref()
        .filter(|value| valid_package_version(value))
        .unwrap_or(HARNESS_VERSION);
    let action = if installed_version.is_some() {
        "Repaired"
    } else {
        "Installed"
    };
    install_harness_version(
        &paths,
        version,
        format!("{action} {HARNESS_PACKAGE}@{version}. Future launches reuse this runtime without npm install."),
    )
}

pub(crate) fn check_remote_version() -> HarnessLabStatus {
    let paths = harness_paths();
    match fetch_remote_version(&paths) {
        Ok(version) => {
            *remote_version()
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(version.clone());
            let installed = read_installed_version(&active_runtime(&paths));
            let message = match installed.as_deref() {
                Some(local) if local == version => {
                    format!("Harness is up to date at {version}.")
                }
                Some(local) => format!("Harness update available: {local} -> {version}."),
                None => format!(
                    "Latest remote Harness version is {version}; install the runtime first."
                ),
            };
            build_status(&paths, Some(true), Some(message))
        }
        Err(message) => build_status(&paths, Some(false), Some(message)),
    }
}

pub(crate) fn update_harness() -> HarnessLabStatus {
    let paths = harness_paths();
    if !dsh_entry(&active_runtime(&paths)).is_file() {
        return build_status(
            &paths,
            Some(false),
            Some("Harness is not installed. Install the baseline runtime first.".to_string()),
        );
    }
    if web_health() != WebHealth::Unavailable {
        return build_status(
            &paths,
            Some(false),
            Some("Stop the Harness service before updating its runtime.".to_string()),
        );
    }

    let version = match fetch_remote_version(&paths) {
        Ok(version) => version,
        Err(message) => return build_status(&paths, Some(false), Some(message)),
    };
    *remote_version()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(version.clone());

    if read_installed_version(&active_runtime(&paths)).as_deref() == Some(version.as_str()) {
        return build_status(
            &paths,
            Some(true),
            Some(format!("Harness is already up to date at {version}.")),
        );
    }

    install_harness_version(
        &paths,
        &version,
        format!("Updated {HARNESS_PACKAGE} to {version}. Restart the Harness service when ready."),
    )
}

fn install_harness_version(
    paths: &HarnessPaths,
    version: &str,
    success_message: String,
) -> HarnessLabStatus {
    if web_health() != WebHealth::Unavailable {
        return build_status(
            paths,
            Some(false),
            Some(
                "Stop the service using port 3080 before installing or repairing Harness."
                    .to_string(),
            ),
        );
    }

    if let Err(error) = std::fs::create_dir_all(&paths.managed_runtime) {
        return build_status(
            paths,
            Some(false),
            Some(format!(
                "Could not create Harness runtime directory: {error}"
            )),
        );
    }
    if let Err(error) = std::fs::create_dir_all(&paths.logs_root) {
        return build_status(
            paths,
            Some(false),
            Some(format!("Could not create Harness log directory: {error}")),
        );
    }

    let Some(npm) = find_npm_command(paths) else {
        return build_status(
            paths,
            Some(false),
            Some(
                "npm was not found. The development installer needs a system Node/npm; a later Portable build will bundle the prepared Harness runtime."
                    .to_string(),
            ),
        );
    };

    let package_spec = format!("{HARNESS_PACKAGE}@{version}");
    let mut command = Command::new(npm);
    command
        .arg("install")
        .arg("--prefix")
        .arg(&paths.managed_runtime)
        .arg("--save-exact")
        .arg("--no-audit")
        .arg("--no-fund")
        .arg(package_spec)
        .current_dir(&paths.managed_runtime)
        .stdin(Stdio::null());
    hide_window(&mut command);

    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            return build_status(
                paths,
                Some(false),
                Some(format!("Could not start npm installer: {error}")),
            )
        }
    };

    let mut install_log = String::new();
    install_log.push_str(&String::from_utf8_lossy(&output.stdout));
    install_log.push_str(&String::from_utf8_lossy(&output.stderr));
    let _ = std::fs::write(paths.logs_root.join("install.log"), install_log);

    if !output.status.success() {
        return build_status(
            paths,
            Some(false),
            Some(format!(
                "Harness installation failed with exit code {}. See install.log.",
                output.status.code().unwrap_or(-1)
            )),
        );
    }

    build_status(paths, Some(true), Some(success_message))
}

pub(crate) fn start_harness() -> HarnessLabStatus {
    let paths = harness_paths();
    *last_exit_code()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
    match web_health() {
        WebHealth::Harness => {
            return build_status(
                &paths,
                Some(true),
                Some("DeepSeek Harness is already running.".to_string()),
            )
        }
        WebHealth::PortConflict => {
            return build_status(
                &paths,
                Some(false),
                Some(
                    "Port 3080 is occupied by a service that is not DeepSeek Harness.".to_string(),
                ),
            )
        }
        WebHealth::Unavailable => {}
    }

    let runtime = active_runtime(&paths);
    let entry = dsh_entry(&runtime);
    if !entry.is_file() {
        return build_status(
            &paths,
            Some(false),
            Some(
                "Harness is not installed. Use Install / Repair test runtime once first."
                    .to_string(),
            ),
        );
    }

    let Some(node) = find_node_command(&paths) else {
        return build_status(
            &paths,
            Some(false),
            Some("Node.js was not found. Harness requires Node 22.19+ or Node 24+.".to_string()),
        );
    };

    if let Err(error) = prepare_managed_home(&paths) {
        return build_status(&paths, Some(false), Some(error));
    }

    let stdout = match create_log(paths.logs_root.join("harness.out.log")) {
        Ok(file) => file,
        Err(error) => {
            return build_status(
                &paths,
                Some(false),
                Some(format!("Could not create Harness stdout log: {error}")),
            )
        }
    };
    let stderr = match create_log(paths.logs_root.join("harness.err.log")) {
        Ok(file) => file,
        Err(error) => {
            return build_status(
                &paths,
                Some(false),
                Some(format!("Could not create Harness stderr log: {error}")),
            )
        }
    };

    let deepseek_key = model_credentials::resolved_secret("deepseek-v4")
        .ok()
        .flatten();
    let glm_key = model_credentials::resolved_secret("glm-coding")
        .ok()
        .flatten();

    let mut command = Command::new(node);
    command
        .arg(entry)
        .arg("web")
        .arg("--host")
        .arg(HARNESS_HOST)
        .arg("--port")
        .arg(HARNESS_PORT.to_string())
        .current_dir(&paths.workspace_root)
        .env("DSH_HOME", &paths.dsh_home)
        .env("DSH_TELEMETRY_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(key) = deepseek_key {
        command.env("DEEPSEEK_API_KEY", key);
    }
    if let Some(key) = glm_key {
        command.env("AMO_GLM_API_KEY", key);
    }
    hide_window(&mut command);

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return build_status(
                &paths,
                Some(false),
                Some(format!("Could not start DeepSeek Harness: {error}")),
            )
        }
    };
    let pid = child.id();
    *owned_harness()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(child);

    for _ in 0..60 {
        std::thread::sleep(Duration::from_millis(200));
        match web_health() {
            WebHealth::Harness => {
                return build_status(
                    &paths,
                    Some(true),
                    Some(format!(
                        "DeepSeek Harness started on {HARNESS_URL} (pid {pid})."
                    )),
                )
            }
            WebHealth::PortConflict => {
                return build_status(
                    &paths,
                    Some(false),
                    Some(
                        "Port 3080 became occupied by another service during startup.".to_string(),
                    ),
                )
            }
            WebHealth::Unavailable => {}
        }
    }

    build_status(
        &paths,
        Some(true),
        Some(format!(
            "Harness process started (pid {pid}); the Web UI is still warming up."
        )),
    )
}

pub(crate) fn stop_harness() -> HarnessLabStatus {
    let paths = harness_paths();
    let child = owned_harness()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    let Some(mut child) = child else {
        return build_status(
            &paths,
            Some(false),
            Some(
                "The running service is not owned by this AMO process, so it was not terminated."
                    .to_string(),
            ),
        );
    };

    let pid = child.id();
    let _ = child.kill();
    let _ = child.wait();
    *last_exit_code()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
    for _ in 0..20 {
        if web_health() == WebHealth::Unavailable {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    build_status(
        &paths,
        Some(true),
        Some(format!(
            "Stopped the AMO-owned Harness process (pid {pid})."
        )),
    )
}

pub(crate) fn stop_owned_harness() {
    let Some(mut child) = owned_harness()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    else {
        return;
    };
    let _ = child.kill();
    let _ = child.wait();
}

fn build_status(
    paths: &HarnessPaths,
    ok_override: Option<bool>,
    message_override: Option<String>,
) -> HarnessLabStatus {
    let runtime = active_runtime(paths);
    let entry = dsh_entry(&runtime);
    let installed = entry.is_file();
    let installed_version = installed
        .then(|| read_installed_version(&runtime))
        .flatten();
    let remote_version = remote_version()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let update_available = matches!(
        (&installed_version, &remote_version),
        (Some(installed), Some(remote)) if installed != remote
    );
    let health = web_health();
    let mut owned_guard = owned_harness()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut exited = None;
    if let Some(child) = owned_guard.as_mut() {
        if let Ok(Some(status)) = child.try_wait() {
            exited = Some(status.code().unwrap_or(-1));
        }
    }
    if exited.is_some() {
        *owned_guard = None;
        *last_exit_code()
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = exited;
    }
    let owned = owned_guard.is_some();
    let pid = owned_guard.as_ref().map(Child::id);
    drop(owned_guard);
    let remembered_exit = *last_exit_code()
        .lock()
        .unwrap_or_else(|error| error.into_inner());

    let (state, running, default_ok, default_message) = match health {
        WebHealth::Harness => (
            "running",
            true,
            true,
            if owned {
                "DeepSeek Harness is running and owned by this AMO process.".to_string()
            } else {
                "DeepSeek Harness is already running outside this AMO process.".to_string()
            },
        ),
        WebHealth::PortConflict => (
            "portConflict",
            false,
            false,
            "Port 3080 is occupied by a service that is not DeepSeek Harness.".to_string(),
        ),
        WebHealth::Unavailable if owned => (
            "starting",
            false,
            true,
            "Harness process is running; waiting for the Web UI.".to_string(),
        ),
        WebHealth::Unavailable if remembered_exit.is_some() => (
            "error",
            false,
            false,
            format!(
                "Harness exited with code {}. Review the recent logs before restarting.",
                remembered_exit.unwrap_or(-1)
            ),
        ),
        WebHealth::Unavailable if installed => (
            "stopped",
            false,
            true,
            "Harness is installed and stopped.".to_string(),
        ),
        WebHealth::Unavailable => (
            "notInstalled",
            false,
            true,
            "Harness test runtime has not been installed yet.".to_string(),
        ),
    };

    let node = find_node_command(paths);
    let node_version = node
        .as_ref()
        .and_then(|command| command_version(command, "--version"));
    let glm_provider_configured = glm_provider_is_configured(&paths.dsh_home);
    let deepseek_key_configured = model_credentials::resolved_secret("deepseek-v4")
        .map(|value| value.is_some())
        .unwrap_or(false);
    let glm_key_configured = model_credentials::resolved_secret("glm-coding")
        .map(|value| value.is_some())
        .unwrap_or(false);

    HarnessLabStatus {
        ok: ok_override.unwrap_or(default_ok),
        state: state.to_string(),
        installed,
        installed_version,
        expected_version: HARNESS_VERSION.to_string(),
        remote_version,
        update_available,
        running,
        owned,
        pid,
        url: HARNESS_URL.to_string(),
        port: HARNESS_PORT,
        runtime_path: runtime.display().to_string(),
        data_path: paths.data_root.display().to_string(),
        dsh_home: paths.dsh_home.display().to_string(),
        node_available: node.is_some(),
        node_version,
        npm_available: find_npm_command(paths).is_some(),
        deepseek_key_configured,
        glm_key_configured,
        glm_provider_configured,
        message: message_override.unwrap_or(default_message),
        recent_log: recent_logs(&paths.logs_root),
    }
}

fn harness_paths() -> HarnessPaths {
    let mut starts = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        starts.push(current_dir);
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }

    for start in &starts {
        for ancestor in start.ancestors() {
            if ancestor
                .join("app")
                .join("broker")
                .join("server.js")
                .is_file()
                && ancestor.join("runtime").join("node.exe").is_file()
            {
                let data_root = ancestor.join("data").join("deepseek-harness");
                return HarnessPaths {
                    workspace_root: ancestor.to_path_buf(),
                    managed_runtime: data_root.join("runtime"),
                    bundled_runtime: ancestor.join("app").join("deepseek-harness"),
                    dsh_home: data_root.join("home"),
                    logs_root: data_root.join("logs"),
                    data_root,
                    portable_node: Some(ancestor.join("runtime").join("node.exe")),
                };
            }
        }
    }

    for start in starts {
        for ancestor in start.ancestors() {
            if ancestor.join("broker").join("server.js").is_file() {
                let data_root = ancestor.join("tmp").join("deepseek-harness-lab");
                return HarnessPaths {
                    workspace_root: ancestor.to_path_buf(),
                    managed_runtime: data_root.join("runtime"),
                    bundled_runtime: ancestor.join("runtime").join("deepseek-harness"),
                    dsh_home: data_root.join("home"),
                    logs_root: data_root.join("logs"),
                    data_root,
                    portable_node: None,
                };
            }
        }
    }

    let fallback = std::env::temp_dir().join("amo-deepseek-harness-lab");
    HarnessPaths {
        workspace_root: std::env::current_dir().unwrap_or_else(|_| fallback.clone()),
        managed_runtime: fallback.join("runtime"),
        bundled_runtime: fallback.join("bundled-runtime"),
        dsh_home: fallback.join("home"),
        logs_root: fallback.join("logs"),
        data_root: fallback,
        portable_node: None,
    }
}

fn active_runtime(paths: &HarnessPaths) -> PathBuf {
    if dsh_entry(&paths.managed_runtime).is_file() {
        paths.managed_runtime.clone()
    } else {
        paths.bundled_runtime.clone()
    }
}

fn fetch_remote_version(paths: &HarnessPaths) -> Result<String, String> {
    let Some(npm) = find_npm_command(paths) else {
        return Err(
            "npm was not found, so the remote Harness version cannot be checked.".to_string(),
        );
    };
    let mut command = Command::new(npm);
    command
        .arg("view")
        .arg(HARNESS_PACKAGE)
        .arg("version")
        .stdin(Stdio::null());
    hide_window(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("Could not start the npm version check: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!(
                "Remote Harness version check failed with exit code {}.",
                output.status.code().unwrap_or(-1)
            )
        } else {
            format!("Remote Harness version check failed: {detail}")
        });
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !valid_package_version(&version) {
        return Err("The npm registry returned an invalid Harness version.".to_string());
    }
    Ok(version)
}

fn valid_package_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+' | '_')
        })
}

fn dsh_entry(runtime: &Path) -> PathBuf {
    runtime
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

fn read_installed_version(runtime: &Path) -> Option<String> {
    let package_path = runtime
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let raw = std::fs::read_to_string(package_path).ok()?;
    let marker = "\"version\"";
    let after_marker = raw.split_once(marker)?.1;
    let after_colon = after_marker.split_once(':')?.1.trim_start();
    let value = after_colon.strip_prefix('"')?.split_once('"')?.0;
    Some(value.to_string())
}

fn find_node_command(paths: &HarnessPaths) -> Option<PathBuf> {
    if let Some(node) = &paths.portable_node {
        if node.is_file() {
            return Some(node.clone());
        }
    }
    if let Ok(value) = std::env::var("AMO_NODE_PATH") {
        let candidate = PathBuf::from(value);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    find_on_path("node.exe").or_else(|| find_on_path("node"))
}

fn find_npm_command(paths: &HarnessPaths) -> Option<PathBuf> {
    if let Some(node) = &paths.portable_node {
        if let Some(runtime_root) = node.parent() {
            let bundled_npm = runtime_root.join("npm.cmd");
            if bundled_npm.is_file() {
                return Some(bundled_npm);
            }
        }
    }
    if let Ok(value) = std::env::var("AMO_NPM_PATH") {
        let candidate = PathBuf::from(value);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    find_on_path("npm.cmd").or_else(|| find_on_path("npm"))
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let mut probe = Command::new("where.exe");
    probe.arg(command).stdin(Stdio::null());
    hide_window(&mut probe);
    let output = probe.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

fn command_version(command: &Path, argument: &str) -> Option<String> {
    let mut probe = Command::new(command);
    probe.arg(argument).stdin(Stdio::null());
    hide_window(&mut probe);
    let output = probe.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn prepare_managed_home(paths: &HarnessPaths) -> Result<(), String> {
    std::fs::create_dir_all(&paths.dsh_home)
        .map_err(|error| format!("Could not create DSH_HOME: {error}"))?;
    std::fs::create_dir_all(&paths.logs_root)
        .map_err(|error| format!("Could not create Harness log directory: {error}"))?;

    let settings_path = paths.dsh_home.join("settings.yaml");
    let existing = std::fs::read_to_string(&settings_path).unwrap_or_default();
    if existing.contains("amo-glm:") {
        let upgraded = upgrade_managed_glm_provider(&existing);
        if upgraded != existing {
            std::fs::write(settings_path, upgraded)
                .map_err(|error| format!("Could not upgrade the GLM provider: {error}"))?;
        }
        return Ok(());
    }
    if existing.contains("llm-pi-ai:") {
        return Ok(());
    }

    let block = r#"# Initialized by AMO Harness Lab. The API key remains in Windows Credential Manager.
llm-pi-ai:
  providers:
    amo-glm:
      displayName: GLM-5.3 (AMO)
      apiKeyEnv: AMO_GLM_API_KEY
      api: anthropic-messages
      baseURL: https://open.bigmodel.cn/api/anthropic
      models:
        - id: glm-5.3[1m]
          name: GLM-5.3 1M
          contextWindow: 1000000
"#;
    let content = if existing.trim().is_empty() {
        block.to_string()
    } else {
        format!("{}\n\n{block}", existing.trim_end())
    };
    std::fs::write(settings_path, content)
        .map_err(|error| format!("Could not initialize the GLM provider: {error}"))
}

fn upgrade_managed_glm_provider(value: &str) -> String {
    value
        .replace("GLM-5.2 (AMO)", "GLM-5.3 (AMO)")
        .replace("glm-5.2[1m]", "glm-5.3[1m]")
        .replace("GLM-5.2 1M", "GLM-5.3 1M")
}

fn glm_provider_is_configured(dsh_home: &Path) -> bool {
    std::fs::read_to_string(dsh_home.join("settings.yaml"))
        .map(|value| value.contains("amo-glm:"))
        .unwrap_or(false)
}

fn create_log(path: PathBuf) -> std::io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
}

fn recent_logs(root: &Path) -> String {
    let files = [
        ("stderr", root.join("harness.err.log")),
        ("stdout", root.join("harness.out.log")),
        ("install", root.join("install.log")),
    ];
    let mut output = String::new();
    for (label, path) in files {
        let Some(content) = tail_file(&path, 8_000) else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        if !output.is_empty() {
            output.push_str("\n\n");
        }
        output.push_str(&format!("[{label}]\n{}", content.trim_end()));
    }
    output
}

fn tail_file(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn web_health() -> WebHealth {
    let address = format!("{HARNESS_HOST}:{HARNESS_PORT}");
    let Ok(socket_address) = address.parse() else {
        return WebHealth::Unavailable;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&socket_address, Duration::from_millis(250))
    else {
        return WebHealth::Unavailable;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1:3080\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return WebHealth::PortConflict;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return WebHealth::PortConflict;
    }
    if response.starts_with("HTTP/1.1 200") && response.contains("<title>DeepSeek Harness</title>")
    {
        WebHealth::Harness
    } else {
        WebHealth::PortConflict
    }
}

fn owned_harness() -> &'static Mutex<Option<Child>> {
    OWNED_HARNESS.get_or_init(|| Mutex::new(None))
}

fn last_exit_code() -> &'static Mutex<Option<i32>> {
    LAST_EXIT_CODE.get_or_init(|| Mutex::new(None))
}

fn remote_version() -> &'static Mutex<Option<String>> {
    REMOTE_VERSION.get_or_init(|| Mutex::new(None))
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsh_entry_is_package_scoped() {
        assert_eq!(
            dsh_entry(Path::new(r"C:\runtime")),
            PathBuf::from(r"C:\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js")
        );
    }

    #[test]
    fn installed_version_reads_package_json() {
        let root =
            std::env::temp_dir().join(format!("amo-harness-version-test-{}", std::process::id()));
        let package = root.join("node_modules").join("@deepseek-ai").join("dsh");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("package.json"), r#"{"version":"1.2.3"}"#).unwrap();
        assert_eq!(read_installed_version(&root).as_deref(), Some("1.2.3"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn detected_npm_batch_command_is_spawnable() {
        if let Some(npm) = find_npm_command(&harness_paths()) {
            assert!(command_version(&npm, "--version").is_some());
        }
    }

    #[test]
    fn portable_runtime_npm_is_preferred_without_a_system_install() {
        let root =
            std::env::temp_dir().join(format!("amo-harness-portable-npm-{}", std::process::id()));
        let runtime = root.join("runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let node = runtime.join("node.exe");
        let npm = runtime.join("npm.cmd");
        std::fs::write(&node, b"").unwrap();
        std::fs::write(&npm, b"").unwrap();
        let paths = HarnessPaths {
            workspace_root: root.clone(),
            managed_runtime: root.join("data/runtime"),
            bundled_runtime: root.join("app/deepseek-harness"),
            data_root: root.join("data"),
            dsh_home: root.join("data/home"),
            logs_root: root.join("data/logs"),
            portable_node: Some(node),
        };

        assert_eq!(find_npm_command(&paths).as_deref(), Some(npm.as_path()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn package_version_validation_rejects_command_like_values() {
        assert!(valid_package_version("0.1.0-rc.7"));
        assert!(valid_package_version("1.2.3+build.4"));
        assert!(!valid_package_version(""));
        assert!(!valid_package_version("latest --force"));
        assert!(!valid_package_version("1.2.3;whoami"));
    }

    #[test]
    fn managed_glm_provider_is_upgraded_without_rewriting_other_settings() {
        let existing = r#"theme: dark
amo-glm:
  displayName: GLM-5.2 (AMO)
  models:
    - id: glm-5.2[1m]
      name: GLM-5.2 1M
custom: retained
"#;

        let upgraded = upgrade_managed_glm_provider(existing);
        assert!(upgraded.contains("GLM-5.3 (AMO)"));
        assert!(upgraded.contains("glm-5.3[1m]"));
        assert!(upgraded.contains("GLM-5.3 1M"));
        assert!(upgraded.contains("custom: retained"));
    }
}
