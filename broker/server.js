const http = require("http");
const path = require("path");
const { AMO_SCHEMA_VERSION } = require("./lib/amo-constants");
const { createConversationService } = require("./lib/conversation-service");
const { CORS_HEADERS, httpError, readJsonBody, sendEmpty, sendJson } = require("./lib/http");
const { createDebugLogStore } = require("./lib/debug");
const { normalizeInteger, normalizeText } = require("./lib/normalize");
const { createObsidianBridge } = require("./lib/obsidian-bridge");
const { createSessionStore } = require("./lib/session-store");
const { attachObsidianPluginHealth } = require("./lib/obsidian-vault");
const {
  clearWindowIdentity,
  normalizeTargetBinding,
  normalizeWindowHint,
  targetBindingFromWindowHint,
  windowHintFromWindowTarget,
} = require("./lib/target-binding");
const { enrollWorkspace } = require("./lib/workspace-deploy");
const { updateWorkspaceGitExclude } = require("./lib/workspace-git-exclude");
const { inspectWorkspace } = require("./lib/workspace-inspect");
const { launchWorkspace } = require("./lib/workspace-launch");
const {
  cleanWorkspaceVault,
  inspectWorkspaceMaintenance,
  updateWorkspaceObsidianPlugin,
} = require("./lib/workspace-maintenance");

const HOST = process.env.AGENT_MONITOR_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.AGENT_MONITOR_PORT || "17654", 10);
const DATA_FILE =
  process.env.AGENT_MONITOR_DATA_FILE ||
  path.join(__dirname, "data", "sessions.json");
const DEBUG_MAX_LOG_ENTRIES = 800;

const startedAt = new Date();
const eventClients = new Set();
let eventSequence = 0;
const debugLogStore = createDebugLogStore({
  enabled: /^(1|true|yes|on)$/iu.test(process.env.AGENT_MONITOR_DEBUG || ""),
  maxEntries: DEBUG_MAX_LOG_ENTRIES,
});
const debugStatus = debugLogStore.status;
const updateDebugConfig = debugLogStore.updateConfig;
const handleDebugLog = debugLogStore.handleLog;
const recordDebugLog = debugLogStore.record;
const debugPreview = debugLogStore.preview;
const sessionStore = createSessionStore({
  dataFile: DATA_FILE,
  expectedBridgeUrl: baseUrl,
  recordDebugLog,
});
const {
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
} = sessionStore;
const conversationService = createConversationService({
  sessions,
  recordDebugLog,
  debugPreview,
  reviveArchivedSession,
  clearSessionAttentionFields,
  sessionHasAttentionState,
  normalizeState,
});
setPromptEventHandler((payload) => conversationService.handlePrompt(payload));
const obsidianBridge = createObsidianBridge({
  sessions,
  recordDebugLog,
  debugPreview,
  handlePrompt: (payload) => conversationService.handlePrompt(payload),
});
loadSnapshot();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      return sendEmpty(res, 204);
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "agent-monitor-broker",
        host: HOST,
        port: PORT,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        sessionCount: sessions.size,
        storage: DATA_FILE,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/debug") {
      return sendJson(res, 200, debugStatus(url.searchParams));
    }

    if (req.method === "POST" && url.pathname === "/api/debug") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, updateDebugConfig(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/debug/logs") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, handleDebugLog(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/debug/clear") {
      debugLogStore.clear();
      recordDebugLog("broker", "debug.clear", {}, { force: true });
      return sendJson(res, 200, debugStatus());
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return sendJson(res, 200, {
        count: sessions.size,
        sessions: listSessions(),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/dismiss-all") {
      const payload = await readJsonBody(req, { allowEmpty: true });
      const result = dismissAllSessions(payload || {});
      persistSnapshot();
      publishSessionChanged("dismiss-all", null);
      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/api/session-events") {
      return openSessionEventStream(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/inspect") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, inspectWorkspace(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/enroll") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, enrollWorkspace(payload, { baseUrl, recordDebugLog }));
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/git-exclude") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, updateWorkspaceGitExclude(payload, { recordDebugLog }));
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/launch") {
      const payload = await readJsonBody(req);
      const result = await launchWorkspace(payload, { sessions, recordDebugLog });
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/status") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, inspectWorkspaceMaintenance(payload, { baseUrl, recordDebugLog }));
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/clean-vault") {
      const payload = await readJsonBody(req);
      const result = cleanWorkspaceVault(payload, { baseUrl, sessions, publishSessionChanged, recordDebugLog });
      persistSnapshot();
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/update-obsidian-plugin") {
      const payload = await readJsonBody(req);
      const result = updateWorkspaceObsidianPlugin(payload, { baseUrl, recordDebugLog });
      persistSnapshot();
      publishSessionChanged("obsidian-plugin-update", null);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/events") {
      const payload = await readJsonBody(req);
      const session = upsertSessionFromEvent(payload);
      persistSnapshot();
      publishSessionChanged("event", session);
      return sendJson(res, 200, { ok: true, session });
    }

    if (req.method === "POST" && url.pathname === "/api/replies") {
      const payload = await readJsonBody(req);
      const reply = conversationService.handleReply(payload);
      persistSnapshot();
      publishSessionChanged("reply", reply.session);
      return sendJson(res, 200, reply);
    }

    if (req.method === "POST" && url.pathname === "/api/prompts") {
      const payload = await readJsonBody(req);
      const prompt = conversationService.handlePrompt(payload);
      persistSnapshot();
      publishSessionChanged("prompt", prompt.session);
      return sendJson(res, 200, prompt);
    }

    if (req.method === "POST" && url.pathname === "/api/obsidian/annotations") {
      const payload = await readJsonBody(req);
      const result = obsidianBridge.handleObsidianAnnotations(payload);
      persistSnapshot();
      publishSessionChanged("obsidian-annotations", result.session);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/obsidian/note-title") {
      const payload = await readJsonBody(req);
      const result = obsidianBridge.handleObsidianNoteTitle(payload);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/obsidian/register-vault") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, obsidianBridge.handleRegisterObsidianVault(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/sync-back") {
      const payload = await readJsonBody(req);
      const result = obsidianBridge.handleSyncBack(payload);
      persistSnapshot();
      publishSessionChanged("sync-back", result.session);
      return sendJson(res, 200, result);
    }

    const windowBindingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/window-binding$/);
    if (req.method === "POST" && windowBindingMatch) {
      const sessionId = decodeURIComponent(windowBindingMatch[1]);
      const payload = await readJsonBody(req);
      const result = bindSessionWindow(sessionId, payload);
      persistSnapshot();
      publishSessionChanged("window-bind", result.session);
      return sendJson(res, 200, result);
    }

    const clearWindowBindingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/window-binding\/clear$/);
    if (req.method === "POST" && clearWindowBindingMatch) {
      const sessionId = decodeURIComponent(clearWindowBindingMatch[1]);
      const result = clearSessionWindowBinding(sessionId);
      persistSnapshot();
      publishSessionChanged("window-unbind", result.session);
      return sendJson(res, 200, result);
    }

    const targetBindingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/target-binding$/);
    if (req.method === "POST" && targetBindingMatch) {
      const sessionId = decodeURIComponent(targetBindingMatch[1]);
      const payload = await readJsonBody(req);
      const result = bindSessionTarget(sessionId, payload);
      persistSnapshot();
      publishSessionChanged("target-bind", result.session);
      return sendJson(res, 200, result);
    }

    const clearTargetBindingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/target-binding\/clear$/);
    if (req.method === "POST" && clearTargetBindingMatch) {
      const sessionId = decodeURIComponent(clearTargetBindingMatch[1]);
      const result = clearSessionTargetBinding(sessionId);
      persistSnapshot();
      publishSessionChanged("target-unbind", result.session);
      return sendJson(res, 200, result);
    }

    const taskTitleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/task-title$/);
    if (req.method === "POST" && taskTitleMatch) {
      const sessionId = decodeURIComponent(taskTitleMatch[1]);
      const payload = await readJsonBody(req, { allowEmpty: true });
      const result = updateSessionTaskTitle(sessionId, payload || {});
      persistSnapshot();
      publishSessionChanged("task-title", result.session);
      return sendJson(res, 200, result);
    }

    const reviewMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reviewed$/);
    if (req.method === "POST" && reviewMatch) {
      const sessionId = decodeURIComponent(reviewMatch[1]);
      const payload = await readJsonBody(req, { allowEmpty: true });
      const result = markSessionReviewed(sessionId, payload || {});
      persistSnapshot();
      publishSessionChanged("reviewed", result.session);
      return sendJson(res, 200, result);
    }

    const attentionClearMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attention-cleared$/);
    if (req.method === "POST" && attentionClearMatch) {
      const sessionId = decodeURIComponent(attentionClearMatch[1]);
      const payload = await readJsonBody(req, { allowEmpty: true });
      const result = clearSessionAttention(sessionId, payload || {});
      persistSnapshot();
      publishSessionChanged("attention-cleared", result.session);
      return sendJson(res, 200, result);
    }

    const dismissMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dismiss$/);
    if (req.method === "POST" && dismissMatch) {
      const sessionId = decodeURIComponent(dismissMatch[1]);
      const payload = await readJsonBody(req, { allowEmpty: true });
      const result = dismissSession(sessionId, payload || {});
      persistSnapshot();
      publishSessionChanged("dismiss", result.session);
      return sendJson(res, 200, result);
    }

    const archiveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
    if (req.method === "POST" && archiveMatch) {
      const sessionId = decodeURIComponent(archiveMatch[1]);
      const payload = await readJsonBody(req, { allowEmpty: true });
      const result = archiveSession(sessionId, payload || {});
      persistSnapshot();
      publishSessionChanged("archive", result.session);
      return sendJson(res, 200, result);
    }

    const heartbeatMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/heartbeat$/);
    if (req.method === "POST" && heartbeatMatch) {
      const sessionId = decodeURIComponent(heartbeatMatch[1]);
      const payload = await readJsonBody(req, { allowEmpty: true });
      const session = updateHeartbeat(sessionId, payload || {});
      persistSnapshot();
      publishSessionChanged("heartbeat", session);
      return sendJson(res, 200, { ok: true, session });
    }

    return sendJson(res, 404, {
      ok: false,
      error: "not_found",
      message: `${req.method} ${url.pathname} is not supported`,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    recordDebugLog("broker", "request.error", {
      method: req.method,
      url: req.url,
      status,
      code: error.code || "internal_error",
      message: error.message || "Unexpected broker error",
    });
    return sendJson(res, status, {
      ok: false,
      error: error.code || "internal_error",
      message: error.message || "Unexpected broker error",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`agent-monitor-broker listening at http://${HOST}:${PORT}`);
  console.log(`session snapshot: ${DATA_FILE}`);
});

function openSessionEventStream(req, res) {
  res.writeHead(200, {
    ...CORS_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`event: broker.ready\ndata: ${JSON.stringify({ ok: true, startedAt: startedAt.toISOString() })}\n\n`);

  const client = { res };
  eventClients.add(client);
  recordDebugLog("broker", "session_event.client_open", {
    clientCount: eventClients.size,
  });
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      eventClients.delete(client);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(client);
    recordDebugLog("broker", "session_event.client_close", {
      clientCount: eventClients.size,
    });
  });
}

function publishSessionChanged(reason, session) {
  if (eventClients.size === 0) {
    recordDebugLog("broker", "session_event.no_clients", {
      reason,
      sessionId: session?.sessionId || null,
    });
    return;
  }

  const sequence = ++eventSequence;
  const publishStartedAtMs = Date.now();
  const decoratedSession = session
    ? attachObsidianPluginHealth(session, new Map(), { expectedBridgeUrl: baseUrl() })
    : null;
  const payload = JSON.stringify({
    ok: true,
    sequence,
    event: "sessions.changed",
    reason,
    sessionId: session?.sessionId || null,
    session: decoratedSession,
    brokerPublishedAtMs: publishStartedAtMs,
    updatedAt: new Date().toISOString(),
  });
  const chunk = `id: ${sequence}\nevent: sessions.changed\ndata: ${payload}\n\n`;

  let deliveredCount = 0;
  let failedCount = 0;
  for (const client of Array.from(eventClients)) {
    try {
      client.res.write(chunk);
      deliveredCount += 1;
    } catch {
      failedCount += 1;
      eventClients.delete(client);
    }
  }

  recordDebugLog("broker", "session_event.published", {
    reason,
    sequence,
    sessionId: session?.sessionId || null,
    sessionState: session?.state || null,
    pendingPromptId: session?.pendingPromptId || null,
    clientCount: eventClients.size,
    deliveredCount,
    failedCount,
    durationMs: Date.now() - publishStartedAtMs,
  });
}

function bindSessionWindow(sessionId, payload) {
  if (!sessionId) {
    throw httpError(400, "missing_session_id", "Window binding URL must include session id");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Window binding payload must be a JSON object");
  }

  const existing = sessions.get(sessionId);
  if (!existing) {
    throw httpError(404, "session_not_found", `Session not found for window binding: ${sessionId}`);
  }

  const hwnd = normalizeInteger(payload.hwnd || payload.windowHandle || payload.window_handle);
  const pid = normalizeInteger(payload.pid || payload.processId || payload.process_id);
  if (hwnd === null && pid === null) {
    throw httpError(400, "missing_window_identity", "Window binding payload must include hwnd or processId");
  }

  const processName = normalizeText(payload.processName || payload.process_name || payload.process);
  const title = normalizeText(payload.title);
  const label = normalizeText(payload.label);
  const now = new Date().toISOString();
  const baseHint = existing.windowHint || {};
  const windowHint = {
    process: processName || baseHint.process || null,
    title: title || baseHint.title || existing.title || null,
    titleToken: baseHint.titleToken || null,
    titleContains: Array.isArray(baseHint.titleContains) ? baseHint.titleContains : [],
    project: baseHint.project || path.basename(existing.cwd || "") || null,
    cwd: baseHint.cwd || existing.cwd || null,
    tool: baseHint.tool || existing.tool || null,
    pid,
    hwnd,
    boundAt: now,
    boundBy: "overlay-candidate-menu",
    boundLabel: label || title || processName || null,
  };
  const targetBinding = targetBindingFromWindowHint(windowHint, now);
  const session = {
    ...existing,
    windowHint,
    targetBinding,
    lastEvent: "WindowBound",
    lastMessage: `Target bound to ${targetBinding.label || "selected window"}`,
    needsAttention: false,
    updatedAt: now,
    eventCount: (existing.eventCount || 0) + 1,
  };

  sessions.set(sessionId, session);
  recordDebugLog("broker", "window.bind", {
    sessionId,
    hwnd,
    pid,
    processName,
    title,
    label: targetBinding.label,
  });
  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    sessionId,
    windowHint,
    targetBinding,
    session,
  };
}

function bindSessionTarget(sessionId, payload) {
  if (!sessionId) {
    throw httpError(400, "missing_session_id", "Target binding URL must include session id");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Target binding payload must be a JSON object");
  }

  const existing = sessions.get(sessionId);
  if (!existing) {
    throw httpError(404, "session_not_found", `Session not found for target binding: ${sessionId}`);
  }

  const now = new Date().toISOString();
  const targetBinding = normalizeTargetBinding(payload.targetBinding || payload.target_binding || payload, sessionId, now);
  if (!targetBinding) {
    throw httpError(400, "invalid_target_binding", "Target binding payload must include a supported target type");
  }

  let windowHint = existing.windowHint || null;
  if (targetBinding.type === "window") {
    windowHint = windowHintFromWindowTarget(existing, targetBinding);
  }

  const session = {
    ...existing,
    windowHint,
    targetBinding,
    lastEvent: "TargetBound",
    lastMessage: `Target bound to ${targetBinding.label || targetBinding.type}`,
    needsAttention: false,
    updatedAt: now,
    eventCount: (existing.eventCount || 0) + 1,
  };

  sessions.set(sessionId, session);
  recordDebugLog("broker", "target.bind", {
    sessionId,
    type: targetBinding.type,
    label: targetBinding.label || null,
    threadId: targetBinding.threadId || null,
    hwnd: targetBinding.hwnd || null,
    processId: targetBinding.processId || null,
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    sessionId,
    targetBinding,
    windowHint,
    session,
  };
}

function clearSessionWindowBinding(sessionId) {
  if (!sessionId) {
    throw httpError(400, "missing_session_id", "Window binding URL must include session id");
  }

  const existing = sessions.get(sessionId);
  if (!existing) {
    throw httpError(404, "session_not_found", `Session not found for window binding: ${sessionId}`);
  }

  const currentHint = existing.windowHint || {};
  const resetHint =
    currentHint.boundBy === "overlay-candidate-menu"
      ? {
          titleToken: currentHint.titleToken || null,
          titleContains: Array.isArray(currentHint.titleContains) ? currentHint.titleContains : [],
          project: currentHint.project || path.basename(existing.cwd || "") || null,
          cwd: currentHint.cwd || existing.cwd || null,
          tool: currentHint.tool || existing.tool || null,
          pid: null,
          hwnd: null,
        }
      : {
          ...currentHint,
          pid: null,
          hwnd: null,
        };
  const nextHint = normalizeWindowHint(resetHint);
  const now = new Date().toISOString();
  const session = {
    ...existing,
    windowHint: nextHint,
    targetBinding: existing.targetBinding?.type === "window" ? null : existing.targetBinding || null,
    lastEvent: "WindowUnbound",
    lastMessage: "Window binding cleared; AMO will ask again if routing is ambiguous",
    updatedAt: now,
    eventCount: (existing.eventCount || 0) + 1,
  };

  sessions.set(sessionId, session);
  recordDebugLog("broker", "window.unbind", {
    sessionId,
    previousHwnd: currentHint.hwnd || null,
    previousPid: currentHint.pid || null,
  });
  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    sessionId,
    windowHint: nextHint,
    targetBinding: session.targetBinding,
    session,
  };
}

function clearSessionTargetBinding(sessionId) {
  if (!sessionId) {
    throw httpError(400, "missing_session_id", "Target binding URL must include session id");
  }

  const existing = sessions.get(sessionId);
  if (!existing) {
    throw httpError(404, "session_not_found", `Session not found for target binding: ${sessionId}`);
  }

  const currentTarget = existing.targetBinding || null;
  const overlayBoundWindow =
    existing.windowHint?.boundBy === "overlay-candidate-menu" ||
    existing.windowHint?.boundBy === "overlay-target-menu";
  const shouldClearWindow =
    currentTarget?.type === "window" ||
    overlayBoundWindow ||
    (!currentTarget && Boolean(existing.windowHint?.hwnd || existing.windowHint?.pid));
  const nextHint = shouldClearWindow ? clearWindowIdentity(existing.windowHint || {}, existing) : existing.windowHint || null;
  const now = new Date().toISOString();
  const session = {
    ...existing,
    windowHint: nextHint,
    targetBinding: null,
    lastEvent: "TargetUnbound",
    lastMessage: "Target binding cleared; AMO will ask again if routing is ambiguous",
    updatedAt: now,
    eventCount: (existing.eventCount || 0) + 1,
  };

  sessions.set(sessionId, session);
  recordDebugLog("broker", "target.unbind", {
    sessionId,
    previousType: currentTarget?.type || null,
    previousLabel: currentTarget?.label || null,
    clearedWindow: shouldClearWindow,
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    sessionId,
    targetBinding: null,
    windowHint: nextHint,
    session,
  };
}

function baseUrl() {
  return `http://${HOST}:${PORT}`;
}
