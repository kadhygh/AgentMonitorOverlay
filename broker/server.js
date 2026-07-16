const http = require("http");
const path = require("path");
const { AMO_SCHEMA_VERSION } = require("./lib/amo-constants");
const { createConversationService } = require("./lib/conversation-service");
const { detectCliEnvironments } = require("./lib/cli-environments");
const { CORS_HEADERS, httpError, sendEmpty, sendJson } = require("./lib/http");
const { createDebugLogStore } = require("./lib/debug");
const { normalizeInteger, normalizeText } = require("./lib/normalize");
const { createObsidianBridge } = require("./lib/obsidian-bridge");
const { createPermissionGate } = require("./lib/permission-gate");
const { createLaunchStore } = require("./lib/launch-store");
const { createSessionStore } = require("./lib/session-store");
const { createTranscriptMonitor } = require("./lib/transcript-monitor");
const { attachObsidianPluginHealth } = require("./lib/obsidian-vault");
const {
  clearTargetBindingState,
  clearWindowIdentity,
  isManagedLaunchWindowTarget,
  normalizeTargetBinding,
  normalizeWindowHint,
  targetBindingFromWindowHint,
  windowHintFromWindowTarget,
} = require("./lib/target-binding");
const { enrollWorkspace } = require("./lib/workspace-deploy");
const { updateWorkspaceGitExclude } = require("./lib/workspace-git-exclude");
const { updateWorkspaceDocumentMapping } = require("./lib/workspace-document-mappings");
const { inspectWorkspace } = require("./lib/workspace-inspect");
const { launchWorkspace } = require("./lib/workspace-launch");
const { createWorkspaceRegistry } = require("./lib/workspace-registry");
const {
  cleanWorkspaceVault,
  inspectWorkspaceMaintenance,
  updateWorkspaceObsidianPlugin,
} = require("./lib/workspace-maintenance");
const { handleConfigRoutes } = require("./routes/config");
const { handleObsidianRoutes } = require("./routes/obsidian");
const { handleSessionRoutes } = require("./routes/sessions");
const { handleWorkspaceRoutes } = require("./routes/workspaces");

const HOST = process.env.AGENT_MONITOR_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.AGENT_MONITOR_PORT || "17654", 10);
const DATA_FILE =
  process.env.AGENT_MONITOR_DATA_FILE ||
  path.join(__dirname, "data", "sessions.json");
const WORKSPACE_DATA_FILE =
  process.env.AGENT_MONITOR_WORKSPACE_DATA_FILE ||
  path.join(path.dirname(DATA_FILE), "workspaces.json");
const LAUNCH_DATA_FILE =
  process.env.AGENT_MONITOR_LAUNCH_DATA_FILE ||
  path.join(path.dirname(DATA_FILE), "launches.json");
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
const workspaceRegistry = createWorkspaceRegistry({ dataFile: WORKSPACE_DATA_FILE, recordDebugLog });
const launchStore = createLaunchStore({ dataFile: LAUNCH_DATA_FILE, recordDebugLog });
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
  markSessionCancelledFromTranscript,
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
const reconciledManagedSessions = launchStore.reconcileSessions(sessions);
if (reconciledManagedSessions.length > 0) persistSnapshot();
const permissionGate = createPermissionGate({
  sessions,
  upsertSessionFromEvent,
  persistSnapshot,
  publishSessionChanged,
  recordDebugLog,
  graceMs: Number.parseInt(process.env.AGENT_MONITOR_PERMISSION_GRACE_MS || "6000", 10),
});
const transcriptMonitor = createTranscriptMonitor({
  recordDebugLog,
  onTurnAborted: (event) => {
    permissionGate.resolveSession(event.sessionId, "turn_aborted");
    const session = markSessionCancelledFromTranscript(event);
    if (!session) return;
    persistSnapshot();
    publishSessionChanged("transcript-turn-aborted", session);
  },
});
for (const session of sessions.values()) transcriptMonitor.track({}, session);

const routeContext = {
  host: HOST,
  port: PORT,
  dataFile: DATA_FILE,
  startedAt,
  sessions,
  debugLogStore,
  debugStatus,
  updateDebugConfig,
  handleDebugLog,
  recordDebugLog,
  listSessions,
  dismissAllSessions,
  persistSnapshot,
  publishSessionChanged,
  openSessionEventStream,
  bindSessionWindow,
  clearSessionWindowBinding,
  bindSessionTarget,
  clearSessionTargetBinding,
  updateSessionTaskTitle,
  markSessionReviewed,
  clearSessionAttention,
  dismissSession,
  archiveSession,
  updateHeartbeat,
  inspectWorkspace,
  enrollWorkspace,
  updateWorkspaceGitExclude,
  updateWorkspaceDocumentMapping,
  launchWorkspace,
  inspectWorkspaceMaintenance,
  cleanWorkspaceVault,
  updateWorkspaceObsidianPlugin,
  baseUrl,
  upsertSessionFromEvent,
  permissionGate,
  transcriptMonitor,
  workspaceRegistry,
  launchStore,
  conversationService,
  obsidianBridge,
  detectCliEnvironments,
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      return sendEmpty(res, 204);
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    const handled =
      (await handleConfigRoutes(req, res, url, routeContext)) ||
      (await handleSessionRoutes(req, res, url, routeContext)) ||
      (await handleWorkspaceRoutes(req, res, url, routeContext)) ||
      (await handleObsidianRoutes(req, res, url, routeContext));
    if (handled) return;
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
server.on("close", () => {
  permissionGate.dispose();
  transcriptMonitor.dispose();
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
  const managedWindowHint = currentHint.boundBy === "managed-launch";
  const nextHint = managedWindowHint ? currentHint : clearWindowIdentity(currentHint, existing);
  const now = new Date().toISOString();
  const session = {
    ...existing,
    windowHint: nextHint,
    targetBinding: isManagedLaunchWindowTarget(existing.targetBinding)
      ? null
      : existing.targetBinding?.type === "window"
        ? null
        : existing.targetBinding || null,
    lastEvent: managedWindowHint ? existing.lastEvent : "WindowUnbound",
    lastMessage: managedWindowHint
      ? existing.lastMessage
      : "Window binding cleared; AMO will ask again if routing is ambiguous",
    updatedAt: now,
    eventCount: (existing.eventCount || 0) + (managedWindowHint ? 0 : 1),
  };

  sessions.set(sessionId, session);
  recordDebugLog("broker", managedWindowHint ? "window.unbind_ignored" : "window.unbind", {
    sessionId,
    previousHwnd: currentHint.hwnd || null,
    previousPid: currentHint.pid || null,
    reason: managedWindowHint ? "managed-launch" : null,
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
  const cleared = clearTargetBindingState(existing);
  const nextHint = cleared.windowHint;
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
    clearedWindow: cleared.clearedWindow,
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
