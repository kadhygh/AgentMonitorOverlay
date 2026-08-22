export const BROKER_SESSIONS_URL = "http://127.0.0.1:17654/api/sessions";
export const BROKER_REFRESH_SESSION_TITLES_URL = "http://127.0.0.1:17654/api/sessions/refresh-titles";
export const BROKER_SESSION_EVENTS_URL = "http://127.0.0.1:17654/api/session-events";
export const BROKER_DISMISS_ARCHIVED_URL = "http://127.0.0.1:17654/api/sessions/dismiss-archived";
export const BROKER_SESSION_PRIORITIES_URL = "http://127.0.0.1:17654/api/sessions/priorities";
export const BROKER_SESSION_DISPLAY_ORDER_URL = "http://127.0.0.1:17654/api/sessions/display-order";
export const BROKER_OBSIDIAN_REGISTER_VAULT_URL = "http://127.0.0.1:17654/api/obsidian/register-vault";
export const BROKER_OBSIDIAN_RUNTIME_URL = "http://127.0.0.1:17654/api/obsidian/runtime";
export const BROKER_OBSIDIAN_OPEN_RESULTS_URL = "http://127.0.0.1:17654/api/obsidian/open-results";
export const BROKER_SYNC_BACK_URL = "http://127.0.0.1:17654/api/sync-back";
export const BROKER_WORKSPACE_INSPECT_URL = "http://127.0.0.1:17654/api/workspaces/inspect";
export const BROKER_WORKSPACES_URL = "http://127.0.0.1:17654/api/workspaces";
export const BROKER_WORKSPACE_FORGET_URL = "http://127.0.0.1:17654/api/workspaces/forget";
export const BROKER_WORKSPACE_LABEL_URL = "http://127.0.0.1:17654/api/workspaces/label";
export const BROKER_WORKSPACE_ENROLL_URL = "http://127.0.0.1:17654/api/workspaces/enroll";
export const BROKER_WORKSPACE_GIT_EXCLUDE_URL = "http://127.0.0.1:17654/api/workspaces/git-exclude";
export const BROKER_WORKSPACE_DOCUMENT_MAPPINGS_URL =
  "http://127.0.0.1:17654/api/workspaces/document-mappings";
export const BROKER_WORKSPACE_LAUNCH_URL = "http://127.0.0.1:17654/api/workspaces/launch";
export const BROKER_WORKSPACE_STATUS_URL = "http://127.0.0.1:17654/api/workspaces/status";
export const BROKER_WORKSPACE_CLEAN_VAULT_URL = "http://127.0.0.1:17654/api/workspaces/clean-vault";
export const BROKER_WORKSPACE_UPDATE_OBSIDIAN_PLUGIN_URL =
  "http://127.0.0.1:17654/api/workspaces/update-obsidian-plugin";
export const BROKER_DEBUG_URL = "http://127.0.0.1:17654/api/debug";
export const BROKER_DEBUG_LOGS_URL = "http://127.0.0.1:17654/api/debug/logs";
export const BROKER_CLI_ENVIRONMENTS_URL = "http://127.0.0.1:17654/api/cli-environments";

export function brokerSessionTargetBindingUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/target-binding`;
}

export function brokerSessionTargetBindingClearUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/target-binding/clear`;
}

export function brokerSessionReviewedUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/reviewed`;
}

export function brokerSessionAttentionClearedUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/attention-cleared`;
}

export function brokerSessionHeartbeatUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`;
}

export function brokerSessionDismissUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/dismiss`;
}

export function brokerSessionArchiveUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/archive`;
}

export function brokerSessionTaskTitleUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/task-title`;
}

export function brokerSessionProviderNameSyncUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/provider-name-sync`;
}

export function brokerSessionResumeUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/resume`;
}

export function brokerSessionManagedOfflineUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/managed-launch/offline`;
}

export function brokerSessionManagedWindowUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/managed-launch/window`;
}

export interface BrokerRequestOptions {
  timeoutMs?: number;
}

export function brokerObsidianOpenResultUrl(openRequestId: string) {
  return `${BROKER_OBSIDIAN_OPEN_RESULTS_URL}/${encodeURIComponent(openRequestId)}`;
}

export function brokerObsidianRuntimeUrl(vaultId?: string | null, vaultRoot?: string | null) {
  const query = new URLSearchParams();
  if (vaultId) query.set("vaultId", vaultId);
  if (vaultRoot) query.set("vaultRoot", vaultRoot);
  return `${BROKER_OBSIDIAN_RUNTIME_URL}?${query.toString()}`;
}

export async function postBrokerJson<T>(url: string, body: unknown, options: BrokerRequestOptions = {}): Promise<T> {
  return brokerFetchJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, options);
}

export async function getBrokerJson<T>(url: string, options: BrokerRequestOptions = {}): Promise<T> {
  return brokerFetchJson<T>(url, {}, options);
}

async function brokerFetchJson<T>(url: string, init: RequestInit, options: BrokerRequestOptions): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timeoutId = window.setTimeout(() => controller.abort("broker request timed out"), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message ?? `broker returned ${response.status}`);
    return payload as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`broker request timed out after ${timeoutMs} ms`);
    if (error instanceof TypeError) {
      throw new Error("AMO Broker is unavailable at 127.0.0.1:17654. Restart AMO and try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
