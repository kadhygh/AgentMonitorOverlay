const crypto = require("crypto");
const { normalizeText } = require("./normalize");

const DEFAULT_PERMISSION_GRACE_MS = 6000;
const RESOLVING_EVENTS = new Set([
  "pretooluse",
  "posttooluse",
  "posttoolusefailure",
  "userpromptsubmit",
  "stop",
]);

function createPermissionGate({
  sessions,
  upsertSessionFromEvent,
  persistSnapshot,
  publishSessionChanged,
  recordDebugLog = () => {},
  graceMs = DEFAULT_PERMISSION_GRACE_MS,
} = {}) {
  const pendingBySession = new Map();
  const delayMs = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : DEFAULT_PERMISSION_GRACE_MS;

  function handleEvent(payload) {
    const sessionId = eventSessionId(payload);
    const eventName = eventNameFromPayload(payload);
    const tool = normalizeText(payload?.tool || payload?.sourceTool || payload?.adapter)?.toLowerCase() || "";

    if (tool === "codex" && eventName === "permissionrequest" && sessionId) {
      startProvisional(sessionId, payload);
      return {
        provisional: true,
        session: sessions instanceof Map ? sessions.get(sessionId) || null : null,
      };
    }

    if (sessionId && RESOLVING_EVENTS.has(eventName)) {
      resolveProvisional(sessionId, eventName);
    }

    return {
      provisional: false,
      session: upsertSessionFromEvent(payload),
    };
  }

  function startProvisional(sessionId, payload) {
    const previous = pendingBySession.get(sessionId);
    if (previous) clearTimeout(previous.timer);

    const requestId = permissionRequestId(payload);
    const startedAt = new Date().toISOString();
    const timer = setTimeout(() => promote(sessionId, requestId), delayMs);
    timer.unref?.();
    pendingBySession.set(sessionId, { payload, requestId, startedAt, timer });
    recordDebugLog("broker", "permission.provisional_started", {
      sessionId,
      requestId,
      graceMs: delayMs,
      replacedRequestId: previous?.requestId || null,
    });
  }

  function resolveProvisional(sessionId, eventName) {
    const pending = pendingBySession.get(sessionId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    pendingBySession.delete(sessionId);
    recordDebugLog("broker", "permission.auto_resolved", {
      sessionId,
      requestId: pending.requestId,
      resolvedByEvent: eventName,
      elapsedMs: Date.now() - Date.parse(pending.startedAt),
    });
    return true;
  }

  function promote(sessionId, requestId) {
    const pending = pendingBySession.get(sessionId);
    if (!pending || pending.requestId !== requestId) return;

    pendingBySession.delete(sessionId);
    const session = upsertSessionFromEvent(pending.payload);
    persistSnapshot();
    publishSessionChanged("permission-promoted", session);
    recordDebugLog("broker", "permission.promoted_to_attention", {
      sessionId,
      requestId,
      elapsedMs: Date.now() - Date.parse(pending.startedAt),
    });
  }

  function dispose() {
    for (const pending of pendingBySession.values()) clearTimeout(pending.timer);
    pendingBySession.clear();
  }

  return {
    dispose,
    handleEvent,
    pendingCount: () => pendingBySession.size,
  };
}

function eventSessionId(payload) {
  return normalizeText(
    payload?.sessionId ||
      payload?.session_id ||
      payload?.conversationId ||
      payload?.conversation_id ||
      payload?.threadId ||
      payload?.thread_id
  );
}

function eventNameFromPayload(payload) {
  return (
    normalizeText(
      payload?.event ||
        payload?.eventName ||
        payload?.hookEventName ||
        payload?.hook_event_name ||
        payload?.type
    ) || ""
  ).toLowerCase();
}

function permissionRequestId(payload) {
  const source = JSON.stringify({
    sessionId: eventSessionId(payload),
    turnId: payload?.turnId || payload?.turn_id || null,
    toolName: payload?.toolName || payload?.tool_name || null,
    toolInput: payload?.toolInput || payload?.tool_input || null,
  });
  return crypto.createHash("sha1").update(source).digest("hex").slice(0, 16);
}

module.exports = {
  DEFAULT_PERMISSION_GRACE_MS,
  createPermissionGate,
  eventNameFromPayload,
  eventSessionId,
};
