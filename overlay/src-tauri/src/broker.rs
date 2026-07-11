use crate::models::BrokerEnsureResult;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

static OWNED_BROKER: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

struct BrokerRuntime {
    working_dir: PathBuf,
    broker_script: PathBuf,
    node_command: PathBuf,
    data_dir: Option<PathBuf>,
}

pub(crate) fn ensure_local_broker() -> BrokerEnsureResult {
    match broker_health() {
        BrokerHealth::Healthy => {
            return BrokerEnsureResult {
                ok: true,
                started: false,
                pid: None,
                message: "Broker is already running.".to_string(),
            };
        }
        BrokerHealth::UnexpectedResponse => {
            return BrokerEnsureResult {
                ok: false,
                started: false,
                pid: None,
                message: "Port 17654 is responding, but it is not the AMO broker.".to_string(),
            };
        }
        BrokerHealth::Unavailable => {}
    }

    let Some(runtime) = find_broker_runtime() else {
        return BrokerEnsureResult {
            ok: false,
            started: false,
            pid: None,
            message: "Could not find a development or portable AMO broker runtime.".to_string(),
        };
    };

    let show_broker_window =
        env_flag("AGENT_MONITOR_DEBUG") || env_flag("AGENT_MONITOR_BROKER_DEBUG_WINDOW");
    let mut command = Command::new(&runtime.node_command);
    command
        .arg(&runtime.broker_script)
        .current_dir(&runtime.working_dir)
        .env("AGENT_MONITOR_HOST", "127.0.0.1")
        .env("AGENT_MONITOR_PORT", "17654");

    if let Some(data_dir) = &runtime.data_dir {
        if let Err(error) = std::fs::create_dir_all(data_dir) {
            return BrokerEnsureResult {
                ok: false,
                started: false,
                pid: None,
                message: format!("Could not create portable AMO data directory: {error}"),
            };
        }
        command
            .env("AGENT_MONITOR_DATA_FILE", data_dir.join("sessions.json"))
            .env(
                "AGENT_MONITOR_WORKSPACE_DATA_FILE",
                data_dir.join("workspaces.json"),
            )
            .env(
                "AGENT_MONITOR_LAUNCH_DATA_FILE",
                data_dir.join("launches.json"),
            )
            .env("AGENT_MONITOR_PORTABLE_ROOT", &runtime.working_dir);
    }

    if !show_broker_window {
        command.stdin(std::process::Stdio::null());
        if let Some(data_dir) = &runtime.data_dir {
            let stdout = create_log_file(data_dir.join("broker.out.log"));
            let stderr = create_log_file(data_dir.join("broker.err.log"));
            match (stdout, stderr) {
                (Ok(stdout), Ok(stderr)) => {
                    command
                        .stdout(std::process::Stdio::from(stdout))
                        .stderr(std::process::Stdio::from(stderr));
                }
                _ => {
                    command
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null());
                }
            }
        } else {
            command
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if !show_broker_window {
            command.creation_flags(0x08000000);
        }
    }

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return BrokerEnsureResult {
                ok: false,
                started: false,
                pid: None,
                message: format!("Could not start broker with node: {error}"),
            };
        }
    };
    let pid = child.id();
    *owned_broker()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(child);

    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(150));
        if matches!(broker_health(), BrokerHealth::Healthy) {
            return BrokerEnsureResult {
                ok: true,
                started: true,
                pid: Some(pid),
                message: format!("Started AMO broker on 127.0.0.1:17654 (pid {pid})."),
            };
        }
    }

    BrokerEnsureResult {
        ok: false,
        started: true,
        pid: Some(pid),
        message: format!("Broker process started (pid {pid}), but health check did not pass yet."),
    }
}

pub(crate) fn stop_owned_broker() {
    let Some(mut child) = owned_broker()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    else {
        return;
    };

    let _ = child.kill();
    let _ = child.wait();
}

fn owned_broker() -> &'static Mutex<Option<Child>> {
    OWNED_BROKER.get_or_init(|| Mutex::new(None))
}

fn create_log_file(path: PathBuf) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

enum BrokerHealth {
    Healthy,
    UnexpectedResponse,
    Unavailable,
}

fn broker_health() -> BrokerHealth {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &"127.0.0.1:17654"
            .parse()
            .expect("hardcoded broker address is valid"),
        Duration::from_millis(300),
    ) else {
        return BrokerHealth::Unavailable;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    if stream
        .write_all(
            b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:17654\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return BrokerHealth::Unavailable;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return BrokerHealth::Unavailable;
    }

    if response.starts_with("HTTP/1.1 200") && response.contains("agent-monitor-broker") {
        BrokerHealth::Healthy
    } else {
        BrokerHealth::UnexpectedResponse
    }
}

fn find_broker_runtime() -> Option<BrokerRuntime> {
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
        let portable_root = if start.is_file() {
            start.parent().map(PathBuf::from)
        } else {
            Some(start.clone())
        }?;
        let broker_script = portable_root.join("app").join("broker").join("server.js");
        let node_command = portable_root.join("runtime").join("node.exe");
        if broker_script.is_file() && node_command.is_file() {
            return Some(BrokerRuntime {
                working_dir: portable_root.clone(),
                broker_script,
                node_command,
                data_dir: Some(portable_root.join("data")),
            });
        }
    }

    for start in starts {
        for ancestor in start.ancestors() {
            let candidate = ancestor.join("broker").join("server.js");
            if candidate.is_file() {
                return Some(BrokerRuntime {
                    working_dir: ancestor.to_path_buf(),
                    broker_script: candidate,
                    node_command: PathBuf::from("node"),
                    data_dir: None,
                });
            }
        }
    }

    None
}
