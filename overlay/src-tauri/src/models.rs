use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivationResult {
    pub(crate) ok: bool,
    pub(crate) message: String,
    pub(crate) candidates: Vec<ActivationCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivationCandidate {
    pub(crate) hwnd: i64,
    pub(crate) process_id: u32,
    pub(crate) process_name: Option<String>,
    pub(crate) title: String,
    pub(crate) label: String,
}

#[derive(Serialize)]
pub(crate) struct OpenPathResult {
    pub(crate) ok: bool,
    pub(crate) message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderPickResult {
    pub(crate) ok: bool,
    pub(crate) cancelled: bool,
    pub(crate) path: Option<String>,
    pub(crate) message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrokerEnsureResult {
    pub(crate) ok: bool,
    pub(crate) started: bool,
    pub(crate) pid: Option<u32>,
    pub(crate) message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScratchpadShortcutResult {
    pub(crate) ok: bool,
    pub(crate) enabled: bool,
    pub(crate) button: String,
    pub(crate) message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScratchpadShortcutConfig {
    pub(crate) enabled: bool,
    pub(crate) button: String,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ScratchpadTrigger {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

#[derive(Clone, Debug)]
pub(crate) struct WindowCandidate {
    pub(crate) hwnd: isize,
    pub(crate) process_id: u32,
    pub(crate) process_name: Option<String>,
    pub(crate) title: String,
}

pub(crate) struct WindowHintInput {
    pub(crate) tool: String,
    pub(crate) title: String,
    pub(crate) process_name: String,
    pub(crate) title_token: String,
    pub(crate) title_contains: Vec<String>,
    pub(crate) project: String,
    pub(crate) cwd: String,
    pub(crate) pid: Option<u32>,
    pub(crate) hwnd: Option<i64>,
}
