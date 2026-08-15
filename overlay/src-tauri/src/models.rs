use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivationResult {
    pub(crate) ok: bool,
    pub(crate) message: String,
    pub(crate) candidates: Vec<ActivationCandidate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowProbeRequest {
    pub(crate) session_id: String,
    pub(crate) hint: WindowHintInput,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowProbeResult {
    pub(crate) session_id: String,
    pub(crate) result: ActivationResult,
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
pub(crate) struct HarnessLabStatus {
    pub(crate) ok: bool,
    pub(crate) state: String,
    pub(crate) installed: bool,
    pub(crate) installed_version: Option<String>,
    pub(crate) recommended_version: String,
    pub(crate) remote_version: Option<String>,
    pub(crate) update_available: bool,
    pub(crate) installed_ahead: bool,
    pub(crate) running: bool,
    pub(crate) pid: Option<u32>,
    pub(crate) url: String,
    pub(crate) port: u16,
    pub(crate) executable_path: Option<String>,
    pub(crate) executable_paths: Vec<String>,
    pub(crate) multiple_installations: bool,
    pub(crate) package_root: Option<String>,
    pub(crate) npm_global_root: Option<String>,
    pub(crate) dsh_home: String,
    pub(crate) node_available: bool,
    pub(crate) node_version: Option<String>,
    pub(crate) npm_available: bool,
    pub(crate) npm_version: Option<String>,
    pub(crate) pnpm_available: bool,
    pub(crate) pnpm_version: Option<String>,
    pub(crate) install_source: Option<String>,
    pub(crate) message: String,
    pub(crate) recent_log: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCredentialStatus {
    pub(crate) ok: bool,
    pub(crate) configured_provider_ids: Vec<String>,
    pub(crate) message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCredentialResult {
    pub(crate) ok: bool,
    pub(crate) provider_id: String,
    pub(crate) configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) api_key: Option<String>,
    pub(crate) message: String,
}

impl ModelCredentialResult {
    pub(crate) fn success(provider_id: String, configured: bool, message: String) -> Self {
        Self {
            ok: true,
            provider_id,
            configured,
            api_key: None,
            message,
        }
    }

    pub(crate) fn error(provider_id: String, message: String) -> Self {
        Self {
            ok: false,
            provider_id,
            configured: false,
            api_key: None,
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScratchpadShortcutResult {
    pub(crate) ok: bool,
    pub(crate) enabled: bool,
    pub(crate) shortcut: String,
    pub(crate) message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScratchpadShortcutConfig {
    pub(crate) enabled: bool,
    pub(crate) shortcut: String,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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
