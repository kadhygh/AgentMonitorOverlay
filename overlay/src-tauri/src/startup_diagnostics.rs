use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::Instant,
};

use serde::Serialize;

const STARTUP_MILESTONES: &[&str] = &[
    "processSetup",
    "startupVisible",
    "mainHtmlReady",
    "shellCommitted",
    "mainVisible",
    "firstVisibleFrame",
    "brokerReady",
    "snapshotReady",
    "interactive",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupMilestone {
    pub name: String,
    pub elapsed_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupDiagnosticsSnapshot {
    pub milestones: Vec<StartupMilestone>,
    pub total_elapsed_ms: u64,
}

pub struct StartupDiagnostics {
    started_at: Instant,
    milestones: Mutex<BTreeMap<String, u64>>,
}

impl StartupDiagnostics {
    pub fn new() -> Self {
        let diagnostics = Self {
            started_at: Instant::now(),
            milestones: Mutex::new(BTreeMap::new()),
        };
        diagnostics.record("processSetup");
        diagnostics
    }

    pub fn record(&self, name: &str) -> bool {
        if !STARTUP_MILESTONES.contains(&name) {
            return false;
        }
        let elapsed_ms = self.started_at.elapsed().as_millis() as u64;
        let mut milestones = self.milestones.lock().unwrap_or_else(|error| error.into_inner());
        if milestones.contains_key(name) {
            return true;
        }
        milestones.insert(name.to_string(), elapsed_ms);
        eprintln!("AMO startup milestone: {name}={elapsed_ms}ms");
        true
    }

    pub fn snapshot(&self) -> StartupDiagnosticsSnapshot {
        let milestones = self.milestones.lock().unwrap_or_else(|error| error.into_inner());
        let mut entries = milestones
            .iter()
            .map(|(name, elapsed_ms)| StartupMilestone {
                name: name.clone(),
                elapsed_ms: *elapsed_ms,
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.elapsed_ms);
        StartupDiagnosticsSnapshot {
            milestones: entries,
            total_elapsed_ms: self.started_at.elapsed().as_millis() as u64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StartupDiagnostics;

    #[test]
    fn milestones_are_idempotent_and_keep_the_first_timestamp() {
        let diagnostics = StartupDiagnostics::new();
        assert!(diagnostics.record("shellCommitted"));
        let first = diagnostics.snapshot();
        assert!(diagnostics.record("shellCommitted"));
        let second = diagnostics.snapshot();
        assert_eq!(first.milestones.len(), second.milestones.len());
        assert_eq!(
            first
                .milestones
                .iter()
                .find(|entry| entry.name == "shellCommitted")
                .map(|entry| entry.elapsed_ms),
            second
                .milestones
                .iter()
                .find(|entry| entry.name == "shellCommitted")
                .map(|entry| entry.elapsed_ms),
        );
    }

    #[test]
    fn unknown_milestones_are_rejected() {
        let diagnostics = StartupDiagnostics::new();
        assert!(!diagnostics.record("arbitrary-client-value"));
        assert!(diagnostics
            .snapshot()
            .milestones
            .iter()
            .all(|entry| entry.name != "arbitrary-client-value"));
    }
}
