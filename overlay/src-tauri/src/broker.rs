use crate::models::BrokerEnsureResult;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

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

    let Some((repo_root, broker_script)) = find_broker_script() else {
        return BrokerEnsureResult {
            ok: false,
            started: false,
            pid: None,
            message: "Could not find broker/server.js from the overlay process.".to_string(),
        };
    };

    let show_broker_window =
        env_flag("AGENT_MONITOR_DEBUG") || env_flag("AGENT_MONITOR_BROKER_DEBUG_WINDOW");
    let mut command = Command::new("node");
    command
        .arg(&broker_script)
        .current_dir(repo_root)
        .env("AGENT_MONITOR_HOST", "127.0.0.1")
        .env("AGENT_MONITOR_PORT", "17654");

    if !show_broker_window {
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
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

fn find_broker_script() -> Option<(PathBuf, PathBuf)> {
    let mut starts = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        starts.push(current_dir);
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }

    for start in starts {
        for ancestor in start.ancestors() {
            let candidate = ancestor.join("broker").join("server.js");
            if candidate.is_file() {
                return Some((ancestor.to_path_buf(), candidate));
            }
        }
    }

    None
}
