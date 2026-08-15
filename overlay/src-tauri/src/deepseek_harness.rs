use crate::models::HarnessLabStatus;
use semver::Version;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RECOMMENDED_HARNESS_VERSION: &str = "0.1.0-rc.6";
const HARNESS_PACKAGE: &str = "@deepseek-ai/dsh";
const HARNESS_HOST: &str = "127.0.0.1";
const HARNESS_PORT: u16 = 3080;
const HARNESS_URL: &str = "http://127.0.0.1:3080";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
const DETACHED_PROCESS: u32 = 0x00000008;

static REMOTE_VERSION: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[derive(Clone, Copy, PartialEq, Eq)]
enum WebHealth {
    Harness,
    PortConflict,
    Unavailable,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VersionRelation {
    Older,
    Equal,
    Newer,
    Unknown,
}

pub(crate) fn harness_status() -> HarnessLabStatus {
    build_status(None, None)
}

pub(crate) fn install_harness() -> HarnessLabStatus {
    install_global_version(
        RECOMMENDED_HARNESS_VERSION,
        format!(
            "Installed {HARNESS_PACKAGE}@{RECOMMENDED_HARNESS_VERSION} globally. Use Start Web when you want the browser interface."
        ),
    )
}

pub(crate) fn start_harness_web() -> HarnessLabStatus {
    match web_health() {
        WebHealth::Harness => {
            return build_status(
                Some(true),
                Some("Global DSH Web is already running.".to_string()),
            )
        }
        WebHealth::PortConflict => {
            return build_status(
                Some(false),
                Some("Port 3080 is occupied by a service that is not DSH Web.".to_string()),
            )
        }
        WebHealth::Unavailable => {}
    }

    let installed = installed_harness();
    let Some(package_root) = installed.package_root else {
        return build_status(
            Some(false),
            Some("Install global DSH before starting its Web interface.".to_string()),
        );
    };
    let entry = package_root.join("lib").join("bin.js");
    if !entry.is_file() {
        return build_status(
            Some(false),
            Some(format!(
                "The global DSH Web entry point is missing: {}",
                entry.display()
            )),
        );
    }
    let Some(node) = find_node_command() else {
        return build_status(
            Some(false),
            Some("A system Node.js installation on PATH is required to start DSH Web.".to_string()),
        );
    };

    let stdout = match create_web_log("web.stdout.log") {
        Ok(file) => file,
        Err(message) => return build_status(Some(false), Some(message)),
    };
    let stderr = match create_web_log("web.stderr.log") {
        Ok(file) => file,
        Err(message) => return build_status(Some(false), Some(message)),
    };
    let mut command = Command::new(&node);
    command
        .arg(&entry)
        .arg("web")
        .arg("--host")
        .arg(HARNESS_HOST)
        .arg("--port")
        .arg(HARNESS_PORT.to_string())
        .current_dir(
            resolve_dsh_home()
                .parent()
                .unwrap_or_else(|| Path::new(".")),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    detach_window(&mut command);

    let spawned_pid = match command.spawn() {
        Ok(child) => child.id(),
        Err(error) => {
            return build_status(
                Some(false),
                Some(format!("Could not start global DSH Web: {error}")),
            )
        }
    };

    for _ in 0..80 {
        thread::sleep(Duration::from_millis(250));
        match web_health() {
            WebHealth::Harness => {
                return build_status(
                    Some(true),
                    Some(format!(
                        "Started global DSH Web independently of AMO (launcher PID {spawned_pid})."
                    )),
                )
            }
            WebHealth::PortConflict => {
                return build_status(
                    Some(false),
                    Some("Port 3080 became occupied, but the listener is not DSH Web.".to_string()),
                )
            }
            WebHealth::Unavailable => {}
        }
    }

    let detail = tail_file(&web_log_path("web.stderr.log"), 4_000).unwrap_or_default();
    let message = if detail.trim().is_empty() {
        "Global DSH Web did not become healthy within 20 seconds. Review the Web logs.".to_string()
    } else {
        format!("Global DSH Web did not become healthy: {}", detail.trim())
    };
    build_status(Some(false), Some(message))
}

pub(crate) fn stop_harness_web() -> HarnessLabStatus {
    match web_health() {
        WebHealth::Unavailable => {
            return build_status(
                Some(true),
                Some("Global DSH Web is already stopped.".to_string()),
            )
        }
        WebHealth::PortConflict => {
            return build_status(
                Some(false),
                Some("Refusing to stop the non-DSH service using port 3080.".to_string()),
            )
        }
        WebHealth::Harness => {}
    }

    let Some(pid) = listener_pid(HARNESS_PORT) else {
        return build_status(
            Some(false),
            Some("DSH Web is healthy, but its listening PID could not be identified.".to_string()),
        );
    };
    let installed = installed_harness();
    let Some(package_root) = installed.package_root else {
        return build_status(
            Some(false),
            Some(
                "Refusing to stop DSH Web because the global package root is unavailable."
                    .to_string(),
            ),
        );
    };
    let Some(command_line) = process_command_line(pid) else {
        return build_status(
            Some(false),
            Some(format!(
                "Refusing to stop PID {pid} because its command line could not be verified."
            )),
        );
    };
    if !is_global_dsh_web_command(&command_line, &package_root) {
        return build_status(
            Some(false),
            Some(format!(
                "Refusing to stop PID {pid} because it is not the verified global DSH Web process."
            )),
        );
    }

    let mut command = Command::new("taskkill.exe");
    command
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .stdin(Stdio::null());
    hide_window(&mut command);
    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            return build_status(
                Some(false),
                Some(format!(
                    "Could not start taskkill for DSH Web PID {pid}: {error}"
                )),
            )
        }
    };
    write_operation_log(
        "stop-web",
        Path::new("taskkill.exe"),
        &output.stdout,
        &output.stderr,
    );
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return build_status(
            Some(false),
            Some(if detail.is_empty() {
                format!("Could not stop global DSH Web PID {pid}.")
            } else {
                format!("Could not stop global DSH Web PID {pid}: {detail}")
            }),
        );
    }

    for _ in 0..40 {
        thread::sleep(Duration::from_millis(125));
        if web_health() == WebHealth::Unavailable {
            return build_status(
                Some(true),
                Some(format!(
                    "Stopped verified global DSH Web PID {pid}. The global CLI remains installed."
                )),
            );
        }
    }
    build_status(
        Some(false),
        Some(format!(
            "Stop was requested for DSH Web PID {pid}, but port 3080 is still in use."
        )),
    )
}

pub(crate) fn check_remote_version() -> HarnessLabStatus {
    match fetch_remote_version() {
        Ok(version) => {
            *remote_version()
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(version.clone());
            let installed = installed_harness().installed_version;
            let message = match installed.as_deref() {
                Some(local) => match compare_versions(local, &version) {
                    VersionRelation::Older => {
                        format!("Global DSH update available: {local} -> {version}.")
                    }
                    VersionRelation::Equal => format!("Global DSH is up to date at {version}."),
                    VersionRelation::Newer => {
                        format!("Global DSH {local} is newer than the registry version {version}.")
                    }
                    VersionRelation::Unknown => format!(
                        "Remote DSH version is {version}; the installed version {local} could not be compared."
                    ),
                },
                None => format!(
                    "Remote DSH version is {version}; install the recommended global version when ready."
                ),
            };
            build_status(Some(true), Some(message))
        }
        Err(message) => build_status(Some(false), Some(message)),
    }
}

pub(crate) fn update_harness() -> HarnessLabStatus {
    if web_health() != WebHealth::Unavailable {
        return build_status(
            Some(false),
            Some(
                "Stop the independently running DSH service before updating the global CLI."
                    .to_string(),
            ),
        );
    }

    let version = match fetch_remote_version() {
        Ok(version) => version,
        Err(message) => return build_status(Some(false), Some(message)),
    };
    *remote_version()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(version.clone());

    if installed_harness().installed_version.as_deref() == Some(version.as_str()) {
        return build_status(
            Some(true),
            Some(format!("Global DSH is already up to date at {version}.")),
        );
    }

    install_global_version(
        &version,
        format!(
            "Updated the global {HARNESS_PACKAGE} installation to the explicit version {version}."
        ),
    )
}

fn install_global_version(version: &str, success_message: String) -> HarnessLabStatus {
    if !valid_package_version(version) {
        return build_status(
            Some(false),
            Some("Refusing to install an invalid DSH package version.".to_string()),
        );
    }
    if web_health() != WebHealth::Unavailable {
        return build_status(
            Some(false),
            Some(
                "Stop the service using port 3080 before changing the global DSH installation."
                    .to_string(),
            ),
        );
    }

    let Some(npm) = find_npm_command() else {
        return build_status(
            Some(false),
            Some(
                "A system npm installation on PATH is required to install DSH globally."
                    .to_string(),
            ),
        );
    };
    let package_spec = format!("{HARNESS_PACKAGE}@{version}");
    let mut command = Command::new(&npm);
    command
        .arg("install")
        .arg("--global")
        .arg("--no-audit")
        .arg("--no-fund")
        .arg(package_spec)
        .stdin(Stdio::null());
    hide_window(&mut command);

    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            return build_status(
                Some(false),
                Some(format!("Could not start the global npm installer: {error}")),
            )
        }
    };
    write_operation_log("global-install", &npm, &output.stdout, &output.stderr);
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if detail.is_empty() {
            format!(
                "Global DSH installation failed with exit code {}. Review the installation log.",
                output.status.code().unwrap_or(-1)
            )
        } else {
            format!("Global DSH installation failed: {detail}")
        };
        return build_status(Some(false), Some(message));
    }

    build_status(Some(true), Some(success_message))
}

#[derive(Default)]
struct InstalledHarness {
    installed_version: Option<String>,
    package_root: Option<PathBuf>,
    npm_global_root: Option<PathBuf>,
    executable_paths: Vec<PathBuf>,
}

fn installed_harness() -> InstalledHarness {
    let npm_global_root = find_npm_command().and_then(|npm| npm_global_root(&npm));
    let package_root = npm_global_root
        .as_ref()
        .map(|root| root.join("@deepseek-ai").join("dsh"));
    let package_version = package_root
        .as_ref()
        .and_then(|root| read_package_version(root));
    let executable_paths = find_all_on_path("dsh.cmd")
        .into_iter()
        .chain(find_all_on_path("dsh.exe"))
        .chain(find_all_on_path("dsh"))
        .fold(Vec::<PathBuf>::new(), |mut paths, path| {
            if !paths.contains(&path) {
                paths.push(path);
            }
            paths
        });
    let executable_version = executable_paths
        .first()
        .and_then(|path| command_version(path, "--version"))
        .filter(|value| valid_package_version(value));

    InstalledHarness {
        installed_version: package_version.or(executable_version),
        package_root: package_root.filter(|root| root.is_dir()),
        npm_global_root,
        executable_paths,
    }
}

fn build_status(ok_override: Option<bool>, message_override: Option<String>) -> HarnessLabStatus {
    let installed = installed_harness();
    let installed_version = installed.installed_version.clone();
    let has_executable = !installed.executable_paths.is_empty();
    let is_installed = installed_version.is_some() || has_executable;
    let installation_broken = is_installed && (installed_version.is_none() || !has_executable);
    let remote_version = remote_version()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let relation = match (&installed_version, &remote_version) {
        (Some(local), Some(remote)) => compare_versions(local, remote),
        _ => VersionRelation::Unknown,
    };
    let update_available = relation == VersionRelation::Older;
    let installed_ahead = relation == VersionRelation::Newer;
    let health = web_health();
    let pid = listener_pid(HARNESS_PORT);

    let (state, running, default_ok, default_message) = match health {
        WebHealth::Harness => (
            "running",
            true,
            !installation_broken,
            "DeepSeek Harness is running independently of AMO.".to_string(),
        ),
        WebHealth::PortConflict => (
            "portConflict",
            false,
            false,
            "Port 3080 is occupied by a service that is not DeepSeek Harness.".to_string(),
        ),
        WebHealth::Unavailable if installation_broken => (
            "installationBroken",
            false,
            false,
            "A partial or conflicting DSH installation was detected. Review the executable and npm package paths."
                .to_string(),
        ),
        WebHealth::Unavailable if is_installed => (
            "stopped",
            false,
            true,
            "Global DSH is installed and its Web service is stopped.".to_string(),
        ),
        WebHealth::Unavailable => (
            "notInstalled",
            false,
            true,
            "Global DSH is not installed. AMO will not create a private runtime.".to_string(),
        ),
    };

    let node = find_node_command();
    let npm = find_npm_command();
    let pnpm = find_pnpm_command();
    let executable_path = installed.executable_paths.first().cloned();
    let executable_paths = installed
        .executable_paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();

    HarnessLabStatus {
        ok: ok_override.unwrap_or(default_ok),
        state: state.to_string(),
        installed: is_installed,
        installed_version,
        recommended_version: RECOMMENDED_HARNESS_VERSION.to_string(),
        remote_version,
        update_available,
        installed_ahead,
        running,
        pid,
        url: HARNESS_URL.to_string(),
        port: HARNESS_PORT,
        executable_path: executable_path.map(|path| path.display().to_string()),
        executable_paths,
        multiple_installations: distinct_executable_locations(&installed.executable_paths) > 1,
        package_root: installed
            .package_root
            .map(|path| path.display().to_string()),
        npm_global_root: installed
            .npm_global_root
            .map(|path| path.display().to_string()),
        dsh_home: resolve_dsh_home().display().to_string(),
        node_available: node.is_some(),
        node_version: node
            .as_ref()
            .and_then(|command| command_version(command, "--version")),
        npm_available: npm.is_some(),
        npm_version: npm
            .as_ref()
            .and_then(|command| command_version(command, "--version")),
        pnpm_available: pnpm.is_some(),
        pnpm_version: pnpm
            .as_ref()
            .and_then(|command| command_version(command, "--version")),
        install_source: is_installed.then(|| "global-cli".to_string()),
        message: message_override.unwrap_or(default_message),
        recent_log: recent_operation_log(),
    }
}

fn fetch_remote_version() -> Result<String, String> {
    let Some(npm) = find_npm_command() else {
        return Err("npm was not found, so the remote DSH version cannot be checked.".to_string());
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
                "Remote DSH version check failed with exit code {}.",
                output.status.code().unwrap_or(-1)
            )
        } else {
            format!("Remote DSH version check failed: {detail}")
        });
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !valid_package_version(&version) || Version::parse(&version).is_err() {
        return Err("The npm registry returned an invalid DSH version.".to_string());
    }
    Ok(version)
}

fn compare_versions(local: &str, remote: &str) -> VersionRelation {
    let (Ok(local), Ok(remote)) = (Version::parse(local), Version::parse(remote)) else {
        return VersionRelation::Unknown;
    };
    match local.cmp(&remote) {
        std::cmp::Ordering::Less => VersionRelation::Older,
        std::cmp::Ordering::Equal => VersionRelation::Equal,
        std::cmp::Ordering::Greater => VersionRelation::Newer,
    }
}

fn valid_package_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+' | '_')
        })
}

fn read_package_version(package_root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(package_root.join("package.json")).ok()?;
    let marker = "\"version\"";
    let after_marker = raw.split_once(marker)?.1;
    let after_colon = after_marker.split_once(':')?.1.trim_start();
    let value = after_colon.strip_prefix('"')?.split_once('"')?.0;
    Some(value.to_string())
}

fn find_node_command() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("AMO_NODE_PATH") {
        let candidate = PathBuf::from(value);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    find_on_path("node.exe").or_else(|| find_on_path("node"))
}

fn find_npm_command() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("AMO_NPM_PATH") {
        let candidate = PathBuf::from(value);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    find_on_path("npm.cmd").or_else(|| find_on_path("npm"))
}

fn find_pnpm_command() -> Option<PathBuf> {
    find_on_path("pnpm.cmd").or_else(|| find_on_path("pnpm"))
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    find_all_on_path(command).into_iter().next()
}

fn find_all_on_path(command: &str) -> Vec<PathBuf> {
    let mut probe = Command::new("where.exe");
    probe.arg(command).stdin(Stdio::null());
    hide_window(&mut probe);
    let Ok(output) = probe.output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .collect()
}

fn distinct_executable_locations(paths: &[PathBuf]) -> usize {
    paths
        .iter()
        .map(|path| {
            path.parent()
                .unwrap_or(path)
                .to_string_lossy()
                .to_lowercase()
        })
        .fold(Vec::<String>::new(), |mut locations, location| {
            if !locations.contains(&location) {
                locations.push(location);
            }
            locations
        })
        .len()
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

fn npm_global_root(npm: &Path) -> Option<PathBuf> {
    let mut probe = Command::new(npm);
    probe.arg("root").arg("--global").stdin(Stdio::null());
    hide_window(&mut probe);
    let output = probe.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then(|| PathBuf::from(value))
}

fn resolve_dsh_home() -> PathBuf {
    if let Ok(value) = std::env::var("DSH_HOME") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".dsh")
}

fn operation_log_path() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("AgentMonitorOverlay")
        .join("logs")
        .join("dsh-global-install.log")
}

fn web_log_path(file_name: &str) -> PathBuf {
    resolve_dsh_home().join("logs").join(file_name)
}

fn create_web_log(file_name: &str) -> Result<File, String> {
    let path = web_log_path(file_name);
    let Some(parent) = path.parent() else {
        return Err("Could not resolve the global DSH Web log directory.".to_string());
    };
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    File::create(&path).map_err(|error| format!("Could not create {}: {error}", path.display()))
}

fn write_operation_log(label: &str, command: &Path, stdout: &[u8], stderr: &[u8]) {
    let path = operation_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let mut content = format!(
        "time={timestamp}\naction={label}\ncommand={}\n\n[stdout]\n{}\n\n[stderr]\n{}\n",
        command.display(),
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr),
    );
    if content.len() > 64_000 {
        content.truncate(64_000);
    }
    let _ = std::fs::write(path, content);
}

fn recent_operation_log() -> String {
    tail_file(&operation_log_path(), 12_000).unwrap_or_default()
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
    if response.starts_with("HTTP/1.1 200") && response.contains("DeepSeek Harness") {
        WebHealth::Harness
    } else {
        WebHealth::PortConflict
    }
}

fn listener_pid(port: u16) -> Option<u32> {
    let mut command = Command::new("netstat.exe");
    command
        .arg("-ano")
        .arg("-p")
        .arg("tcp")
        .stdin(Stdio::null());
    hide_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_listener_pid(&String::from_utf8_lossy(&output.stdout), port)
}

fn parse_listener_pid(output: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    output.lines().find_map(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 5
            || !fields[0].eq_ignore_ascii_case("TCP")
            || !fields[1].ends_with(&suffix)
            || !fields[3].eq_ignore_ascii_case("LISTENING")
        {
            return None;
        }
        fields[4].parse::<u32>().ok()
    })
}

fn process_command_line(pid: u32) -> Option<String> {
    let script = format!(
        "$process = Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; if ($null -ne $process) {{ [Console]::Out.Write($process.CommandLine) }}"
    );
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::null());
    hide_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn is_global_dsh_web_command(command_line: &str, package_root: &Path) -> bool {
    let command_line = command_line.replace('/', "\\").to_lowercase();
    let package_root = package_root
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    command_line.contains(&package_root)
        && command_line.contains("\\lib\\bin.js web ")
        && command_line.contains("--port 3080")
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

fn detach_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_version_reads_package_json() {
        let root =
            std::env::temp_dir().join(format!("amo-harness-version-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("package.json"), r#"{"version":"1.2.3"}"#).unwrap();
        assert_eq!(read_package_version(&root).as_deref(), Some("1.2.3"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn detected_npm_batch_command_is_spawnable() {
        if let Some(npm) = find_npm_command() {
            assert!(command_version(&npm, "--version").is_some());
        }
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
    fn semantic_version_comparison_handles_release_candidates() {
        assert!(matches!(
            compare_versions("0.1.0-rc.9", "0.1.0-rc.10"),
            VersionRelation::Older
        ));
        assert!(matches!(
            compare_versions("0.1.0", "0.1.0-rc.10"),
            VersionRelation::Newer
        ));
        assert!(matches!(
            compare_versions("0.1.0-rc.6", "0.1.0-rc.6"),
            VersionRelation::Equal
        ));
    }

    #[test]
    fn netstat_parser_finds_ipv4_and_ipv6_listeners() {
        let output = "\n  TCP    127.0.0.1:3080       0.0.0.0:0      LISTENING       4242\n";
        assert_eq!(parse_listener_pid(output, 3080), Some(4242));
        let ipv6 = "\n  TCP    [::1]:3080           [::]:0         LISTENING       5151\n";
        assert_eq!(parse_listener_pid(ipv6, 3080), Some(5151));
    }

    #[test]
    fn npm_shims_in_one_directory_are_one_installation() {
        let same_root = vec![
            PathBuf::from(r"C:\Users\test\AppData\Roaming\npm\dsh"),
            PathBuf::from(r"C:\Users\test\AppData\Roaming\npm\dsh.cmd"),
        ];
        assert_eq!(distinct_executable_locations(&same_root), 1);

        let second_root = PathBuf::from(r"C:\tools\npm\dsh.cmd");
        assert_eq!(
            distinct_executable_locations(&[same_root[0].clone(), second_root]),
            2
        );
    }

    #[test]
    fn stop_validation_accepts_only_the_global_web_entry() {
        let root = Path::new(r"C:\Users\test\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh");
        let valid = r#""C:\Program Files\nodejs\node.exe" C:\Users\test\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js web --host 127.0.0.1 --port 3080"#;
        assert!(is_global_dsh_web_command(valid, root));
        assert!(!is_global_dsh_web_command(
            r#"node.exe C:\other\dsh\lib\bin.js web --port 3080"#,
            root
        ));
        assert!(!is_global_dsh_web_command(
            r#"node.exe C:\Users\test\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js headless --port 3080"#,
            root
        ));
        assert!(!is_global_dsh_web_command(
            r#"node.exe C:\Users\test\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js web --port 9999"#,
            root
        ));
    }
}
