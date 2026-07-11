export const BROKER_SESSIONS_URL = "http://127.0.0.1:17654/api/sessions";
export const BROKER_SESSION_EVENTS_URL = "http://127.0.0.1:17654/api/session-events";
export const BROKER_OBSIDIAN_REGISTER_VAULT_URL = "http://127.0.0.1:17654/api/obsidian/register-vault";
export const BROKER_SYNC_BACK_URL = "http://127.0.0.1:17654/api/sync-back";
export const BROKER_WORKSPACE_INSPECT_URL = "http://127.0.0.1:17654/api/workspaces/inspect";
export const BROKER_WORKSPACES_URL = "http://127.0.0.1:17654/api/workspaces";
export const BROKER_WORKSPACE_FORGET_URL = "http://127.0.0.1:17654/api/workspaces/forget";
export const BROKER_WORKSPACE_ENROLL_URL = "http://127.0.0.1:17654/api/workspaces/enroll";
export const BROKER_WORKSPACE_GIT_EXCLUDE_URL = "http://127.0.0.1:17654/api/workspaces/git-exclude";
export const BROKER_WORKSPACE_LAUNCH_URL = "http://127.0.0.1:17654/api/workspaces/launch";
export const BROKER_WORKSPACE_STATUS_URL = "http://127.0.0.1:17654/api/workspaces/status";
export const BROKER_WORKSPACE_CLEAN_VAULT_URL = "http://127.0.0.1:17654/api/workspaces/clean-vault";
export const BROKER_WORKSPACE_UPDATE_OBSIDIAN_PLUGIN_URL =
  "http://127.0.0.1:17654/api/workspaces/update-obsidian-plugin";
export const BROKER_DEBUG_URL = "http://127.0.0.1:17654/api/debug";
export const BROKER_DEBUG_LOGS_URL = "http://127.0.0.1:17654/api/debug/logs";

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

export function brokerSessionResumeUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/resume`;
}

export function brokerSessionManagedOfflineUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/managed-launch/offline`;
}

export async function postBrokerJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? `broker returned ${response.status}`);
  }

  return payload as T;
}

export async function getBrokerJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? `broker returned ${response.status}`);
  }
  return payload as T;
}
