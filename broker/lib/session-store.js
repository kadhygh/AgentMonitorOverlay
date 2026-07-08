const fs = require("fs");
const path = require("path");

const { AMO_SCHEMA_VERSION } = require("./amo-constants");
const { httpError } = require("./http");
const { refreshSessionTitle, resolveSessionTitle } = require("./display-names");
const { normalizeText, normalizeTextArray, normalizeVersionNumber } = require("./normalize");
const { attachObsidianPluginHealth } = require("./obsidian-vault");
const { normalizeWindowHint, resolveSessionTargetBinding } = require("./target-binding");

const VALID_STATES = new Set([
  "starting",
  "running",
  "waiting_permission",
  "waiting_user",
  "idle",
  "completed",
  "failed",
  "cancelled",
]);

function createSessionStore({
  dataFile,
  expectedBridgeUrl = "",
  recordDebugLog = () => {},
  promptEventHandler = null,
} = {}) {
  if (!dataFile) {
    throw new Error("createSessionStore requires dataFile");
  }

  const sessions = new Map();
  let currentPromptEventHandler = promptEventHandler;
  const bridgeUrl = typeof expectedBridgeUrl === "function" ? expectedBridgeUrl : () => expectedBridgeUrl;

  function setPromptEventHandler(handler) {
    currentPromptEventHandler = typeof handler === "function" ? handler : null;
  }

  function sessionHasAttentionState(session) {
    return Boolean(
      session?.needsAttention ||
        session?.reviewRequired ||
        session?.reviewStatus ||
        session?.reviewRequestedAt ||
        session?.reviewedAt
    );
  }

  function shouldClearAttentionForActivity({ eventName, state, promptMessage }) {
    const normalizedEvent = (normalizeText(eventName) || "").toLowerCase();
    if (promptMessage || normalizedEvent === "userpromptsubmit") {
      return true;
    }

    return state === "running";
  }

  function clearSessionAttentionFields(session, action = "auto-cleared-by-activity") {
    return {
      ...session,
      needsAttention: false,
      reviewRequired: false,
      reviewStatus: null,
      reviewRequestedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewAction: action,
      reviewTurnId: null,
      reviewNote: null,
      reviewCanvasNodeId: null,
    };
  }

  function reviveArchivedSession(session, reason, existing = session) {
    if (!existing?.archivedAt && !session?.archivedAt) {
      return session;
    }

    recordDebugLog("broker", "session.archive_auto_cleared", {
      sessionId: session.sessionId || existing?.sessionId || null,
      reason,
      archivedAt: existing?.archivedAt || session.archivedAt || null,
    });

    return {
      ...session,
      archivedAt: null,
      archiveReason: null,
    };
  }

  function upsertSessionFromEvent(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw httpError(400, "invalid_json", "Event payload must be a JSON object");
    }

    const tool = normalizeText(payload.tool || payload.sourceTool || payload.adapter);
    if (!tool) {
      throw httpError(400, "missing_tool", "Event payload must include tool");
    }

    const sessionId = normalizeText(
      payload.sessionId ||
        payload.session_id ||
        payload.conversationId ||
        payload.conversation_id ||
        payload.threadId ||
        payload.thread_id
    );
    if (!sessionId) {
      throw httpError(400, "missing_session_id", "Event payload must include sessionId");
    }

    const now = new Date().toISOString();
    const existing = sessions.get(sessionId);
    const eventName = normalizeText(
      payload.event ||
        payload.eventName ||
        payload.hookEventName ||
        payload.hook_event_name ||
        payload.type
    );
    const state = normalizeState(payload.state) || inferState(tool, eventName, payload);
    const message = normalizeText(
      payload.message || payload.summary || payload.lastMessage || payload.last_message
    );
    const promptMessage = promptMessageFromEvent(payload, eventName, message);
    const cwd = normalizeText(payload.cwd || payload.projectPath || payload.project_path) || existing?.cwd || null;
    const windowHint = normalizeWindowHint(payload.windowHint || payload.window_hint) || existing?.windowHint || null;
    const shouldClearAttention = shouldClearAttentionForActivity({
      eventName,
      state,
      promptMessage,
    });

    let session = {
      ...(existing || {}),
      tool,
      sessionId,
      cwd,
      title: resolveSessionTitle(tool, sessionId, payload.title, existing?.title),
      taskTitle: normalizeText(payload.taskTitle || payload.task_title) || existing?.taskTitle || null,
      state,
      lastEvent: eventName || existing?.lastEvent || null,
      lastMessage: message || existing?.lastMessage || null,
      needsAttention:
        shouldClearAttention
          ? false
          : typeof payload.needsAttention === "boolean"
          ? payload.needsAttention
          : state === "waiting_permission" || state === "waiting_user",
      windowHint,
      targetBinding: resolveSessionTargetBinding({ payload, existing, sessionId, tool, cwd, boundAt: now, windowHint }),
      updatedAt: normalizeText(payload.timestamp || payload.updatedAt || payload.updated_at) || now,
      createdAt: existing?.createdAt || now,
      heartbeatAt: existing?.heartbeatAt || null,
      eventCount: (existing?.eventCount || 0) + 1,
      deploymentVersion:
        normalizeVersionNumber(payload.amoDeploymentVersion || payload.deploymentVersion || payload.deployment_version) ||
        existing?.deploymentVersion ||
        null,
      hookProtocolVersion:
        normalizeVersionNumber(payload.amoHookProtocolVersion || payload.hookProtocolVersion || payload.hook_protocol_version) ||
        existing?.hookProtocolVersion ||
        null,
      hookEvents: normalizeTextArray(payload.amoHookEvents || payload.hookEvents || payload.hook_events).length
        ? normalizeTextArray(payload.amoHookEvents || payload.hookEvents || payload.hook_events)
        : existing?.hookEvents || [],
    };
    if (shouldClearAttention) {
      const hadAttention = sessionHasAttentionState(existing) || Boolean(payload.needsAttention);
      session = clearSessionAttentionFields(session);
      if (hadAttention) {
        recordDebugLog("broker", "session.attention_auto_cleared", {
          sessionId,
          reason: promptMessage ? "prompt" : "activity",
          eventName: eventName || null,
          state,
        });
      }
    }
    session = reviveArchivedSession(session, "event", existing);

    sessions.set(sessionId, session);
    if (promptMessage) {
      try {
        if (typeof currentPromptEventHandler !== "function") {
          throw new Error("Prompt event handler is not configured");
        }
        const promptResult = currentPromptEventHandler({
          ...payload,
          tool,
          source: normalizeText(payload.source) === "hook" ? `${tool}-user-prompt-hook` : normalizeText(payload.source),
          sessionId,
          cwd: session.cwd,
          workspacePath: session.workspacePath,
          message: promptMessage,
          hookEventName: eventName || "UserPromptSubmit",
          capturedAt: normalizeText(payload.timestamp || payload.updatedAt || payload.updated_at || payload.observedAt || payload.observed_at),
        });
        return promptResult.session || sessions.get(sessionId) || session;
      } catch (error) {
        recordDebugLog("broker", "prompt.event_record_failed", {
          sessionId,
          eventName,
          message: error.message || String(error),
        });
      }
    }

    return sessions.get(sessionId) || session;
  }

  function updateHeartbeat(sessionId, payload) {
    if (!sessionId) {
      throw httpError(400, "missing_session_id", "Heartbeat URL must include session id");
    }

    const now = new Date().toISOString();
    const existing = sessions.get(sessionId);
    if (!existing) {
      throw httpError(404, "unknown_session", `Session '${sessionId}' does not exist`);
    }

    const nextState = normalizeState(payload.state) || existing.state;
    const eventName = normalizeText(payload.event || payload.eventName || payload.hookEventName || payload.hook_event_name || payload.type);
    const windowHint = normalizeWindowHint(payload.windowHint || payload.window_hint) || existing.windowHint || null;
    const cwd = normalizeText(payload.cwd) || existing.cwd;
    const shouldClearAttention = shouldClearAttentionForActivity({
      eventName,
      state: nextState,
      promptMessage: "",
    });
    let session = {
      ...existing,
      cwd,
      title: resolveSessionTitle(existing.tool || payload.tool, sessionId, payload.title, existing.title),
      taskTitle: normalizeText(payload.taskTitle || payload.task_title) || existing.taskTitle || null,
      state: nextState,
      lastEvent: eventName || existing.lastEvent,
      lastMessage:
        normalizeText(payload.message || payload.lastMessage || payload.last_message) ||
        existing.lastMessage,
      needsAttention:
        shouldClearAttention
          ? false
          : typeof payload.needsAttention === "boolean"
          ? payload.needsAttention
          : nextState === "waiting_permission" || nextState === "waiting_user",
      windowHint,
      targetBinding: resolveSessionTargetBinding({
        payload,
        existing,
        sessionId,
        tool: existing.tool || payload.tool,
        cwd,
        boundAt: now,
        windowHint,
      }),
      reviewRequired: existing.reviewRequired || false,
      reviewStatus: existing.reviewStatus || null,
      reviewRequestedAt: existing.reviewRequestedAt || null,
      reviewedAt: existing.reviewedAt || null,
      reviewedBy: existing.reviewedBy || null,
      reviewAction: existing.reviewAction || null,
      reviewTurnId: existing.reviewTurnId || null,
      reviewNote: existing.reviewNote || null,
      reviewCanvasNodeId: existing.reviewCanvasNodeId || null,
      heartbeatAt: now,
      updatedAt: now,
    };
    if (shouldClearAttention) {
      const hadAttention = sessionHasAttentionState(existing) || Boolean(payload.needsAttention);
      session = clearSessionAttentionFields(session);
      if (hadAttention) {
        recordDebugLog("broker", "session.attention_auto_cleared", {
          sessionId,
          reason: "heartbeat",
          eventName: eventName || null,
          state: nextState,
        });
      }
    }
    if (eventName) {
      session = reviveArchivedSession(session, "heartbeat-event", existing);
    }

    sessions.set(sessionId, session);
    return session;
  }

  function markSessionReviewed(sessionId, payload = {}) {
    if (!sessionId) {
      throw httpError(400, "missing_session_id", "Reviewed URL must include session id");
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      throw httpError(404, "session_not_found", `Session not found for review: ${sessionId}`);
    }

    const now = new Date().toISOString();
    const action = normalizeText(payload.action) || "manual";
    const session = {
      ...existing,
      reviewRequired: false,
      reviewStatus: "reviewed",
      reviewedAt: now,
      reviewedBy: normalizeText(payload.by) || "overlay",
      reviewAction: action,
    };

    sessions.set(sessionId, session);
    recordDebugLog("broker", "session.reviewed", {
      sessionId,
      action,
      reviewTurnId: existing.reviewTurnId || null,
      reviewNote: existing.reviewNote || existing.lastReplyNote || null,
    });

    return {
      ok: true,
      schemaVersion: AMO_SCHEMA_VERSION,
      sessionId,
      reviewedAt: now,
      session,
    };
  }

  function clearSessionAttention(sessionId, payload = {}) {
    if (!sessionId) {
      throw httpError(400, "missing_session_id", "Attention clear URL must include session id");
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      throw httpError(404, "session_not_found", `Session not found for attention clear: ${sessionId}`);
    }

    const now = new Date().toISOString();
    const action = normalizeText(payload.action) || "manual";
    const requestedState = normalizeState(payload.state);
    const shouldResumeState = existing.state === "waiting_permission" || existing.state === "waiting_user";
    const nextState = requestedState || (shouldResumeState ? "running" : existing.state);
    const message =
      normalizeText(payload.message) ||
      (shouldResumeState
        ? "Attention cleared after returning to target"
        : existing.lastMessage);
    const session = {
      ...existing,
      state: nextState,
      needsAttention: false,
      lastEvent: normalizeText(payload.eventName || payload.event || payload.hookEventName || payload.hook_event_name) || "AttentionCleared",
      lastMessage: message,
      attentionClearedAt: now,
      attentionClearAction: action,
      updatedAt: now,
      eventCount: (existing.eventCount || 0) + 1,
    };

    sessions.set(sessionId, session);
    recordDebugLog("broker", "session.attention_cleared", {
      sessionId,
      action,
      previousState: existing.state || null,
      nextState,
      previousNeedsAttention: Boolean(existing.needsAttention),
    });

    return {
      ok: true,
      schemaVersion: AMO_SCHEMA_VERSION,
      sessionId,
      attentionClearedAt: now,
      session,
    };
  }

  function updateSessionTaskTitle(sessionId, payload = {}) {
    if (!sessionId) {
      throw httpError(400, "missing_session_id", "Task title URL must include session id");
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      throw httpError(404, "session_not_found", `Session not found for task title: ${sessionId}`);
    }

    const taskTitle = normalizeText(payload.taskTitle || payload.task_title || payload.title);
    const now = new Date().toISOString();
    const session = {
      ...existing,
      taskTitle: taskTitle || null,
      updatedAt: now,
    };

    sessions.set(sessionId, session);
    recordDebugLog("broker", "session.task_title.updated", {
      sessionId,
      hasTaskTitle: Boolean(taskTitle),
    });

    return {
      ok: true,
      schemaVersion: AMO_SCHEMA_VERSION,
      sessionId,
      taskTitle: session.taskTitle,
      session,
    };
  }

  function archiveSession(sessionId, payload = {}) {
    if (!sessionId) {
      throw httpError(400, "missing_session_id", "Archive URL must include session id");
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      throw httpError(404, "session_not_found", `Session not found for archive: ${sessionId}`);
    }

    const now = new Date().toISOString();
    const reason = normalizeText(payload.reason) || "user";
    const session = {
      ...existing,
      archivedAt: now,
      archiveReason: reason,
      updatedAt: now,
    };

    sessions.set(sessionId, session);
    recordDebugLog("broker", "session.archived", {
      sessionId,
      reason,
    });

    return {
      ok: true,
      schemaVersion: AMO_SCHEMA_VERSION,
      sessionId,
      archivedAt: now,
      session,
    };
  }

  function dismissSession(sessionId, payload = {}) {
    if (!sessionId) {
      throw httpError(400, "missing_session_id", "Dismiss URL must include session id");
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      throw httpError(404, "session_not_found", `Session not found for dismiss: ${sessionId}`);
    }

    const now = new Date().toISOString();
    const reason = normalizeText(payload.reason) || "user";
    const session = {
      ...existing,
      dismissedAt: now,
      dismissReason: reason,
      updatedAt: now,
    };

    sessions.delete(sessionId);
    recordDebugLog("broker", "session.dismissed", {
      sessionId,
      reason,
      remainingSessionCount: sessions.size,
    });

    return {
      ok: true,
      schemaVersion: AMO_SCHEMA_VERSION,
      sessionId,
      dismissedAt: now,
      session,
    };
  }

  function dismissAllSessions(payload = {}) {
    const now = new Date().toISOString();
    const reason = normalizeText(payload.reason) || "user-clear";
    const count = sessions.size;
    sessions.clear();
    recordDebugLog("broker", "session.dismissed_all", {
      count,
      reason,
    });

    return {
      ok: true,
      schemaVersion: AMO_SCHEMA_VERSION,
      dismissedAt: now,
      reason,
      count,
    };
  }

  function listSessions() {
    const healthCache = new Map();
    return Array.from(sessions.values()).map((session) => {
      const refreshedSession = refreshSessionTitle(session);
      if (refreshedSession !== session) {
        sessions.set(refreshedSession.sessionId, refreshedSession);
      }
      return attachObsidianPluginHealth(refreshedSession, healthCache, { expectedBridgeUrl: bridgeUrl() });
    }).sort((a, b) => {
      return `${b.updatedAt}`.localeCompare(`${a.updatedAt}`);
    });
  }

  function loadSnapshot() {
    if (!fs.existsSync(dataFile)) {
      return;
    }

    try {
      const raw = fs.readFileSync(dataFile, "utf8");
      const snapshot = JSON.parse(raw);
      if (!snapshot || !Array.isArray(snapshot.sessions)) {
        return;
      }

      for (const session of snapshot.sessions) {
        if (session && session.sessionId) {
          sessions.set(session.sessionId, refreshSessionTitle(session));
        }
      }
    } catch (error) {
      console.warn(`Failed to load session snapshot: ${error.message}`);
    }
  }

  function persistSnapshot() {
    const dir = path.dirname(dataFile);
    fs.mkdirSync(dir, { recursive: true });

    const snapshot = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      sessions: listSessions(),
    };
    const tmpFile = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    fs.renameSync(tmpFile, dataFile);
  }

  return {
    sessions,
    setPromptEventHandler,
    sessionHasAttentionState,
    clearSessionAttentionFields,
    reviveArchivedSession,
    upsertSessionFromEvent,
    updateHeartbeat,
    markSessionReviewed,
    clearSessionAttention,
    updateSessionTaskTitle,
    archiveSession,
    dismissSession,
    dismissAllSessions,
    listSessions,
    loadSnapshot,
    persistSnapshot,
    normalizeState,
  };
}

function inferState(tool, eventName, payload) {
  const lowerEvent = `${eventName || ""}`.toLowerCase();
  const lowerMessage = `${payload.message || payload.summary || ""}`.toLowerCase();
  const combined = `${lowerEvent} ${lowerMessage}`;

  if (lowerEvent === "pretooluse" || lowerEvent === "posttooluse" || lowerEvent === "posttoolusefailure") {
    return "running";
  }
  if (combined.includes("permission") || combined.includes("approval")) {
    return "waiting_permission";
  }
  if (combined.includes("waiting_user") || combined.includes("user_prompt") || combined.includes("input")) {
    return "waiting_user";
  }
  if (combined.includes("fail") || combined.includes("error")) {
    return "failed";
  }
  if (combined.includes("cancel") || combined.includes("interrupt") || combined.includes("abort")) {
    return "cancelled";
  }
  if (combined.includes("complete") || combined.includes("stop") || combined.includes("done")) {
    return "completed";
  }
  if (combined.includes("idle")) {
    return "idle";
  }
  if (combined.includes("start") || combined.includes("sessioncreated")) {
    return "starting";
  }

  if (tool === "claude" && lowerEvent.includes("notification")) {
    return "waiting_user";
  }
  if (tool === "kiro" && lowerEvent.includes("agent_request")) {
    return "running";
  }

  return "running";
}

function promptMessageFromEvent(payload, eventName, fallbackMessage) {
  if (`${eventName || ""}`.toLowerCase() !== "userpromptsubmit") {
    return "";
  }

  return normalizeText(
    payload.prompt ||
      payload.userPrompt ||
      payload.user_prompt ||
      payload.message ||
      payload.summary ||
      payload.lastMessage ||
      payload.last_message ||
      fallbackMessage
  );
}

function normalizeState(value) {
  const state = normalizeText(value);
  if (!state) return null;

  const normalized = state.toLowerCase().replace(/[\s-]+/g, "_");
  if (VALID_STATES.has(normalized)) {
    return normalized;
  }

  throw httpError(
    400,
    "invalid_state",
    `State '${value}' is not supported. Expected one of: ${Array.from(VALID_STATES).join(", ")}`
  );
}

module.exports = {
  createSessionStore,
};
