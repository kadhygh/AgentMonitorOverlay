const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { CORS_HEADERS, httpError, readJsonBody, sendEmpty, sendJson } = require("./lib/http");
const { createDebugLogStore } = require("./lib/debug");
const { refreshSessionTitle, resolveSessionTitle } = require("./lib/display-names");
const {
  ensureInsideDirectory,
  findNearestGitRoot,
  isSameOrDescendantPath,
  isWritableDirectory,
  readDirectoryNames,
  readJsonFile,
  readJsonFileStrict,
  readJsonTextFile,
  resolveDirectoryPath,
  resolveGitDirectoryPath,
  resolveWorkspacePath,
  writeJsonFile,
  writeTextFile,
} = require("./lib/filesystem");
const { CODEX_HOOK_EVENTS, codexReplyHookScript } = require("./hooks/codex");
const { CLAUDE_HOOK_EVENTS, claudeMessageHookScript } = require("./hooks/claude");

const HOST = process.env.AGENT_MONITOR_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.AGENT_MONITOR_PORT || "17654", 10);
const DATA_FILE =
  process.env.AGENT_MONITOR_DATA_FILE ||
  path.join(__dirname, "data", "sessions.json");
const DEBUG_MAX_LOG_ENTRIES = 800;
const AMO_DIR = ".amo";
const AMO_SCHEMA_VERSION = 1;
const AMO_DEPLOYMENT_VERSION = 2;
const AMO_LAYOUT_VERSION = 2;
const AMO_HOOK_PROTOCOL_VERSION = 2;
const AMO_SESSIONS_PATH = "Sessions";
const AMO_SESSION_GENERATED_PATH = "turns/generated";
const AMO_CANVASES_PATH = "Canvases";
const AMO_WORK_CANVASES_PATH = "Canvases/Work";
const AMO_CANVAS_PATH = "Canvases/AgentFlow.base.canvas";
const AMO_CANVAS_TYPE = "agent-flow-base";
const AMO_CANVAS_MANAGER = "agent-monitor-overlay";
const AMO_NOTE_INDEX_PATH = path.join("state", "note-index.json");
const AMO_VAULT_NAME_PREFIX = "AMO - ";
const OBSIDIAN_PLUGIN_ID = "md-anno-tools";
const REPLY_NODE_WIDTH = 520;
const REPLY_NODE_HEIGHT = 360;
const REPLY_NODE_GAP_X = 620;
const REPLY_NODE_GAP_Y = 420;
const CANVAS_NODE_MARGIN_X = Math.max(80, REPLY_NODE_GAP_X - REPLY_NODE_WIDTH);
const CANVAS_NODE_MARGIN_Y = Math.max(60, REPLY_NODE_GAP_Y - REPLY_NODE_HEIGHT);
const DEFAULT_CANVAS_APPEND_DIRECTION = "down";
const CANVAS_APPEND_DIRECTIONS = new Set(["down", "right"]);
const PROMPT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
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

const sessions = new Map();
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
      return sendJson(res, 200, enrollWorkspace(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/git-exclude") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, updateWorkspaceGitExclude(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/launch") {
      const payload = await readJsonBody(req);
      const result = await launchWorkspace(payload);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/status") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, inspectWorkspaceMaintenance(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/clean-vault") {
      const payload = await readJsonBody(req);
      const result = cleanWorkspaceVault(payload);
      persistSnapshot();
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
      const reply = handleReply(payload);
      persistSnapshot();
      publishSessionChanged("reply", reply.session);
      return sendJson(res, 200, reply);
    }

    if (req.method === "POST" && url.pathname === "/api/prompts") {
      const payload = await readJsonBody(req);
      const prompt = handlePrompt(payload);
      persistSnapshot();
      publishSessionChanged("prompt", prompt.session);
      return sendJson(res, 200, prompt);
    }

    if (req.method === "POST" && url.pathname === "/api/obsidian/annotations") {
      const payload = await readJsonBody(req);
      const result = handleObsidianAnnotations(payload);
      persistSnapshot();
      publishSessionChanged("obsidian-annotations", result.session);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/obsidian/note-title") {
      const payload = await readJsonBody(req);
      const result = handleObsidianNoteTitle(payload);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/obsidian/register-vault") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, handleRegisterObsidianVault(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/sync-back") {
      const payload = await readJsonBody(req);
      const result = handleSyncBack(payload);
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
  const decoratedSession = session ? attachObsidianPluginHealth(session, new Map()) : null;
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
      const promptResult = handlePrompt({
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

function amoVaultDirectoryName(projectName) {
  const cleaned = (normalizeText(projectName) || "workspace")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  const safeName = cleaned || "workspace";
  const maxProjectNameLength = 54;
  return `${AMO_VAULT_NAME_PREFIX}${safeName.slice(0, maxProjectNameLength)}`;
}

function defaultWorkspaceVaultRoot(amoRoot, projectName) {
  return path.join(amoRoot, amoVaultDirectoryName(projectName));
}

function resolveWorkspaceVaultRoot(amoRoot, workspace, projectName) {
  const configured = normalizeText(workspace?.vaultRoot || workspace?.vault_root);
  if (configured) {
    return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(amoRoot, configured);
  }

  return defaultWorkspaceVaultRoot(amoRoot, normalizeText(workspace?.projectName) || projectName);
}

function workspaceRelativePath(workspacePath, targetPath) {
  return path.relative(workspacePath, targetPath).split(path.sep).join("/");
}

function normalizeVersionNumber(value) {
  if (Number.isInteger(value)) return value;
  const parsed = Number.parseInt(normalizeText(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function adapterConfigPath(amoRoot, adapterId) {
  return path.join(amoRoot, "adapters", `${adapterId}.json`);
}

function inspectHookConfigCoverage(workspacePath, relativePath, expectedEvents, hookMarker) {
  const configPath = path.join(workspacePath, relativePath);
  if (!fs.existsSync(configPath)) {
    return {
      hookConfigPath: relativePath,
      configuredHookEvents: [],
      missingHookEvents: [...expectedEvents],
      issues: [`${relativePath} is missing`],
    };
  }

  const config = readJsonFile(configPath, null);
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.hooks || typeof config.hooks !== "object") {
    return {
      hookConfigPath: relativePath,
      configuredHookEvents: [],
      missingHookEvents: [...expectedEvents],
      issues: [`${relativePath} does not contain a valid hooks object`],
    };
  }

  const configuredHookEvents = [];
  const missingHookEvents = [];
  for (const eventName of expectedEvents) {
    const hooksForEvent = config.hooks[eventName];
    if (Array.isArray(hooksForEvent) && JSON.stringify(hooksForEvent).includes(hookMarker)) {
      configuredHookEvents.push(eventName);
    } else {
      missingHookEvents.push(eventName);
    }
  }

  return {
    hookConfigPath: relativePath,
    configuredHookEvents,
    missingHookEvents,
    issues: missingHookEvents.length > 0 ? [`${relativePath} is missing AMO hook event(s): ${missingHookEvents.join(", ")}`] : [],
  };
}

function inspectAdapterDeployment(workspacePath, amoRoot, options) {
  const { adapterId, hookConfigPath, hookMarker, expectedHookEvents } = options;
  const config = readJsonFile(adapterConfigPath(amoRoot, adapterId), null);
  if (!config) {
    return {
      installed: false,
      deploymentStatus: "undeployed",
      expectedDeploymentVersion: AMO_DEPLOYMENT_VERSION,
      expectedHookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      expectedHookEvents: [...expectedHookEvents],
      installedDeploymentVersion: null,
      installedHookProtocolVersion: null,
      configuredHookEvents: [],
      missingHookEvents: [],
      deploymentIssues: [],
    };
  }

  const installedDeploymentVersion = normalizeVersionNumber(config.deploymentVersion);
  const installedHookProtocolVersion = normalizeVersionNumber(config.hookProtocolVersion);
  const metadataHookEvents = normalizeTextArray(config.hookEvents);
  const metadataMissingHookEvents = expectedHookEvents.filter((eventName) => !metadataHookEvents.includes(eventName));
  const coverage = inspectHookConfigCoverage(workspacePath, hookConfigPath, expectedHookEvents, hookMarker);
  const issues = [];

  if (installedDeploymentVersion !== AMO_DEPLOYMENT_VERSION) {
    issues.push(`deployment version is ${installedDeploymentVersion ?? "missing"}, expected ${AMO_DEPLOYMENT_VERSION}`);
  }
  if (installedHookProtocolVersion !== AMO_HOOK_PROTOCOL_VERSION) {
    issues.push(`hook protocol is ${installedHookProtocolVersion ?? "missing"}, expected ${AMO_HOOK_PROTOCOL_VERSION}`);
  }
  if (metadataMissingHookEvents.length > 0) {
    issues.push(`adapter metadata is missing hook event(s): ${metadataMissingHookEvents.join(", ")}`);
  }
  issues.push(...coverage.issues);

  return {
    installed: true,
    deploymentStatus: issues.length > 0 ? "needs-update" : "deployed",
    expectedDeploymentVersion: AMO_DEPLOYMENT_VERSION,
    expectedHookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
    expectedHookEvents: [...expectedHookEvents],
    installedDeploymentVersion,
    installedHookProtocolVersion,
    configuredHookEvents: coverage.configuredHookEvents,
    missingHookEvents: Array.from(new Set([...metadataMissingHookEvents, ...coverage.missingHookEvents])),
    deploymentIssues: issues,
  };
}

function inspectWorkspace(payload) {
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const writable = isWritableDirectory(workspacePath);
  const workspaceId = workspaceIdFor(workspacePath);
  const projectName = path.basename(workspacePath);
  const amoRoot = path.join(workspacePath, AMO_DIR);
  const workspaceFile = path.join(amoRoot, "workspace.json");
  const existingWorkspace = readJsonFile(workspaceFile, null);
  const hasAmo = fs.existsSync(workspaceFile);
  const plannedVaultRoot = resolveWorkspaceVaultRoot(amoRoot, existingWorkspace, projectName);
  const plannedVaultRelativePath = workspaceRelativePath(workspacePath, plannedVaultRoot);
  const hasCodexDir = fs.existsSync(path.join(workspacePath, ".codex"));
  const hasCodexHooks = fs.existsSync(path.join(workspacePath, ".codex", "hooks.json"));
  const hasClaudeDir = fs.existsSync(path.join(workspacePath, ".claude"));
  const hasClaudeLocalSettings = fs.existsSync(path.join(workspacePath, ".claude", "settings.local.json"));
  const hasClaudeProjectSettings = fs.existsSync(path.join(workspacePath, ".claude", "settings.json"));
  const codexDeployment = inspectAdapterDeployment(workspacePath, amoRoot, {
    adapterId: "codex-cli",
    hookConfigPath: ".codex/hooks.json",
    hookMarker: "codex-stop-message.mjs",
    expectedHookEvents: CODEX_HOOK_EVENTS,
  });
  const claudeDeployment = inspectAdapterDeployment(workspacePath, amoRoot, {
    adapterId: "claude-cli",
    hookConfigPath: ".claude/settings.local.json",
    hookMarker: "claude-message.mjs",
    expectedHookEvents: CLAUDE_HOOK_EVENTS,
  });
  const hasCodexAdapter = codexDeployment.installed;
  const hasClaudeAdapter = claudeDeployment.installed;
  const gitExclude = inspectWorkspaceGitExclude(
    workspacePath,
    payload?.gitRootPath || payload?.git_root_path,
    Boolean(payload?.includeClaudeSettingsLocal || payload?.include_claude_settings_local)
  );
  const rootIndicators = [".git", "package.json", "pyproject.toml", "Cargo.toml"].filter((name) => {
    return fs.existsSync(path.join(workspacePath, name));
  });
  const workspaceEntries = readDirectoryNames(workspacePath);
  const isEmptyWorkspace = workspaceEntries.length === 0;
  const workspaceState = isEmptyWorkspace ? "empty" : rootIndicators.length > 0 ? "project" : "folder";

  const evidence = [];
  if (hasAmo) evidence.push("existing .amo workspace metadata found");
  if (hasCodexAdapter) evidence.push("existing Codex CLI adapter metadata found");
  if (hasClaudeAdapter) evidence.push("existing Claude CLI adapter metadata found");
  if (hasCodexDir) evidence.push("existing .codex directory found");
  if (hasCodexHooks) evidence.push("existing .codex/hooks.json found and will be merged");
  if (hasClaudeDir) evidence.push("existing .claude directory found");
  if (hasClaudeLocalSettings) evidence.push("existing .claude/settings.local.json found and will be merged");
  if (hasClaudeProjectSettings) evidence.push("existing .claude/settings.json found");
  if (rootIndicators.length > 0) evidence.push(`project indicators: ${rootIndicators.join(", ")}`);
  if (isEmptyWorkspace) evidence.push("workspace folder is empty");
  if (writable) evidence.push("workspace is writable");

  const codexStatus = writable ? "available" : "blocked";
  const claudeStatus = writable ? "available" : "blocked";
  const codexConfidence = hasCodexDir || hasCodexHooks ? "configured" : rootIndicators.length > 0 ? "project" : workspaceState;
  const claudeConfidence =
    hasClaudeDir || hasClaudeLocalSettings || hasClaudeProjectSettings ? "configured" : rootIndicators.length > 0 ? "project" : workspaceState;
  const codexDeploymentStatus = codexDeployment.deploymentStatus;
  const claudeDeploymentStatus = claudeDeployment.deploymentStatus;
  const recommended = !isEmptyWorkspace;
  const commonDirectoriesToCreate = [
    ".amo",
    ".amo/adapters",
    ".amo/hooks",
    ".amo/state",
    ".amo/logs",
    ".amo/backups",
    plannedVaultRelativePath,
    `${plannedVaultRelativePath}/${AMO_SESSIONS_PATH}`,
    `${plannedVaultRelativePath}/${AMO_CANVASES_PATH}`,
    `${plannedVaultRelativePath}/${AMO_WORK_CANVASES_PATH}`,
    `${plannedVaultRelativePath}/.obsidian`,
    `${plannedVaultRelativePath}/.obsidian/plugins`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}`,
  ];
  const commonFilesToWrite = [
    ".amo/workspace.json",
    ".amo/enrollment.json",
    `${plannedVaultRelativePath}/${AMO_CANVAS_PATH}`,
    `${plannedVaultRelativePath}/.obsidian/community-plugins.json`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/manifest.json`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/main.js`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/styles.css`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/data.json`,
    ".amo/.gitignore",
  ];

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    deploymentVersion: AMO_DEPLOYMENT_VERSION,
    hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
    workspaceId,
    workspacePath,
    projectName,
    existingEnrollment: hasAmo,
    deploymentRoot: AMO_DIR,
    gitExclude,
    supportedAdapters: [
      {
        id: "codex-cli",
        label: "Codex CLI",
        status: codexStatus,
        deploymentStatus: codexDeploymentStatus,
        workspaceState,
        deployable: writable,
        recommended,
        confidence: codexConfidence,
        scope: "project-local",
        installedDeploymentVersion: codexDeployment.installedDeploymentVersion,
        expectedDeploymentVersion: codexDeployment.expectedDeploymentVersion,
        installedHookProtocolVersion: codexDeployment.installedHookProtocolVersion,
        expectedHookProtocolVersion: codexDeployment.expectedHookProtocolVersion,
        expectedHookEvents: codexDeployment.expectedHookEvents,
        configuredHookEvents: codexDeployment.configuredHookEvents,
        missingHookEvents: codexDeployment.missingHookEvents,
        deploymentIssues: codexDeployment.deploymentIssues,
        reason: adapterDeploymentReason({
          writable,
          installed: hasCodexAdapter,
          deploymentStatus: codexDeploymentStatus,
          deploymentIssues: codexDeployment.deploymentIssues,
          empty: isEmptyWorkspace,
          label: "Codex CLI",
          hookDescription: "project-local lifecycle hook adapter",
        }),
        evidence,
        directoriesToCreate: [...commonDirectoriesToCreate, ".codex"],
        filesToWrite: [
          ".amo/adapters/codex-cli.json",
          ".amo/hooks/codex-stop-message.mjs",
          ...commonFilesToWrite,
        ],
        filesToMerge: [".codex/hooks.json"],
        risks: [
          "Codex may require trust/review for project-local hooks in this workspace.",
          "Codex hook payloads do not provide native HWND/PID; window routing should use title/project hints unless separately bound.",
        ],
      },
      {
        id: "claude-cli",
        label: "Claude CLI",
        status: claudeStatus,
        deploymentStatus: claudeDeploymentStatus,
        workspaceState,
        deployable: writable,
        recommended,
        confidence: claudeConfidence,
        scope: "project-local",
        installedDeploymentVersion: claudeDeployment.installedDeploymentVersion,
        expectedDeploymentVersion: claudeDeployment.expectedDeploymentVersion,
        installedHookProtocolVersion: claudeDeployment.installedHookProtocolVersion,
        expectedHookProtocolVersion: claudeDeployment.expectedHookProtocolVersion,
        expectedHookEvents: claudeDeployment.expectedHookEvents,
        configuredHookEvents: claudeDeployment.configuredHookEvents,
        missingHookEvents: claudeDeployment.missingHookEvents,
        deploymentIssues: claudeDeployment.deploymentIssues,
        reason: adapterDeploymentReason({
          writable,
          installed: hasClaudeAdapter,
          deploymentStatus: claudeDeploymentStatus,
          deploymentIssues: claudeDeployment.deploymentIssues,
          empty: isEmptyWorkspace,
          label: "Claude CLI",
          hookDescription: ".claude/settings.local.json hooks for prompt/reply capture",
        }),
        evidence,
        directoriesToCreate: [...commonDirectoriesToCreate, ".claude"],
        filesToWrite: [
          ".amo/adapters/claude-cli.json",
          ".amo/hooks/claude-message.mjs",
          ...commonFilesToWrite,
        ],
        filesToMerge: [".claude/settings.local.json"],
        risks: [
          "Claude Code may require reviewing hooks with /hooks before first use.",
          "Claude hook payloads do not provide native HWND/PID; window routing should use title/project hints unless separately bound.",
          "AMO writes only .claude/settings.local.json so the hook stays local to this machine.",
        ],
      },
    ],
    deferredAdapters: [
      deferredAdapter("codex-app", "Codex App", "Direct Codex App integration is deferred until its local control surface is defined."),
      deferredAdapter("kiro-ide", "Kiro IDE", "Kiro IDE hook install target and payload shape still need local verification."),
    ],
  };
}

function enrollWorkspace(payload) {
  const requestedAdapters = normalizeAdapterIds(payload?.adapters || payload?.adapterIds || payload?.adapter_ids);
  const supportedAdapterIds = new Set(["codex-cli", "claude-cli"]);
  const unsupported = requestedAdapters.filter((id) => !supportedAdapterIds.has(id));
  if (unsupported.length > 0) {
    throw httpError(400, "unsupported_adapter", `Unsupported MVP adapter(s): ${unsupported.join(", ")}`);
  }

  const inspection = inspectWorkspace(payload);
  const requestedPlans = requestedAdapters.map((id) => inspection.supportedAdapters.find((adapter) => adapter.id === id));
  const unavailablePlan = requestedPlans.find((plan) => !plan || !isDeployableAdapterPlan(plan));
  if (unavailablePlan) {
    throw httpError(
      400,
      "workspace_not_writable",
      `Workspace cannot be enrolled for ${unavailablePlan?.id || "requested adapter"} because it is not deployable.`
    );
  }

  const workspacePath = inspection.workspacePath;
  const now = new Date().toISOString();
  const amoRoot = path.join(workspacePath, AMO_DIR);
  const installedFiles = [];
  const mergedFiles = [];
  const backups = [];
  const installedAdapters = [];
  const enrollmentAdapters = [];

  const directoriesToCreate = new Set();
  for (const plan of requestedPlans) {
    for (const dir of plan?.directoriesToCreate || []) {
      directoriesToCreate.add(dir);
    }
  }
  for (const dir of directoriesToCreate) {
    fs.mkdirSync(path.join(workspacePath, dir), { recursive: true });
  }

  const workspaceFile = path.join(amoRoot, "workspace.json");
  const enrollmentFile = path.join(amoRoot, "enrollment.json");
  const existingWorkspace = readJsonFile(workspaceFile, null);
  const existingEnrollment = readJsonFile(enrollmentFile, null);
  const vaultRoot = resolveWorkspaceVaultRoot(amoRoot, existingWorkspace, inspection.projectName);
  writeJsonFile(workspaceFile, {
    schemaVersion: AMO_SCHEMA_VERSION,
    deploymentVersion: AMO_DEPLOYMENT_VERSION,
    hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
    workspaceId: inspection.workspaceId,
    workspacePath,
    projectName: inspection.projectName,
    createdAt: existingWorkspace?.createdAt || now,
    updatedAt: now,
    layoutVersion: AMO_LAYOUT_VERSION,
    amoRoot,
    vaultRoot,
    defaultCanvasPath: AMO_CANVAS_PATH,
    sessionsPath: AMO_SESSIONS_PATH,
    generatedTurnsPath: `${AMO_SESSIONS_PATH}/<session-id>/${AMO_SESSION_GENERATED_PATH}`,
    canvasesPath: AMO_CANVASES_PATH,
    workCanvasesPath: AMO_WORK_CANVASES_PATH,
  });
  installedFiles.push(".amo/workspace.json");

  if (requestedAdapters.includes("codex-cli")) {
    const adapterFile = path.join(amoRoot, "adapters", "codex-cli.json");
    const hookScriptPath = path.join(amoRoot, "hooks", "codex-stop-message.mjs");
    writeJsonFile(adapterFile, {
      schemaVersion: AMO_SCHEMA_VERSION,
      id: "codex-cli",
      label: "Codex CLI",
      status: "installed",
      deploymentVersion: AMO_DEPLOYMENT_VERSION,
      hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      hookEvents: CODEX_HOOK_EVENTS,
      installedAt: now,
      bridgeEventsUrl: `${baseUrl()}/api/events`,
      bridgeRepliesUrl: `${baseUrl()}/api/replies`,
      bridgePromptsUrl: `${baseUrl()}/api/prompts`,
      hookScriptPath,
      cacheFallbackPath: path.join(workspacePath, ".codex", "cache"),
    });
    installedFiles.push(".amo/adapters/codex-cli.json");

    writeTextFile(
      hookScriptPath,
      codexReplyHookScript({
        deploymentVersion: AMO_DEPLOYMENT_VERSION,
        hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      }),
    );
    installedFiles.push(".amo/hooks/codex-stop-message.mjs");

    const mergeResult = mergeCodexHooks(workspacePath, hookScriptPath, amoRoot);
    if (mergeResult.changed) {
      mergedFiles.push(".codex/hooks.json");
    }
    backups.push(...mergeResult.backups);
    installedAdapters.push("codex-cli");
    enrollmentAdapters.push({
      id: "codex-cli",
      status: "installed",
      deploymentVersion: AMO_DEPLOYMENT_VERSION,
      hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      hookEvents: CODEX_HOOK_EVENTS,
      installedAt: now,
      hookScriptPath,
      mergedFiles: [".codex/hooks.json"],
    });
  }

  if (requestedAdapters.includes("claude-cli")) {
    const adapterFile = path.join(amoRoot, "adapters", "claude-cli.json");
    const hookScriptPath = path.join(amoRoot, "hooks", "claude-message.mjs");
    writeJsonFile(adapterFile, {
      schemaVersion: AMO_SCHEMA_VERSION,
      id: "claude-cli",
      label: "Claude CLI",
      status: "installed",
      deploymentVersion: AMO_DEPLOYMENT_VERSION,
      hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      hookEvents: CLAUDE_HOOK_EVENTS,
      installedAt: now,
      bridgeEventsUrl: `${baseUrl()}/api/events`,
      bridgeRepliesUrl: `${baseUrl()}/api/replies`,
      bridgePromptsUrl: `${baseUrl()}/api/prompts`,
      hookScriptPath,
      cacheFallbackPath: path.join(amoRoot, "logs", "claude-cache"),
    });
    installedFiles.push(".amo/adapters/claude-cli.json");

    writeTextFile(
      hookScriptPath,
      claudeMessageHookScript({
        deploymentVersion: AMO_DEPLOYMENT_VERSION,
        hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      }),
    );
    installedFiles.push(".amo/hooks/claude-message.mjs");

    const mergeResult = mergeClaudeSettings(workspacePath, hookScriptPath, amoRoot);
    if (mergeResult.changed) {
      mergedFiles.push(".claude/settings.local.json");
    }
    backups.push(...mergeResult.backups);
    installedAdapters.push("claude-cli");
    enrollmentAdapters.push({
      id: "claude-cli",
      status: "installed",
      deploymentVersion: AMO_DEPLOYMENT_VERSION,
      hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      hookEvents: CLAUDE_HOOK_EVENTS,
      installedAt: now,
      hookScriptPath,
      mergedFiles: [".claude/settings.local.json"],
    });
  }

  writeTextFile(path.join(amoRoot, ".gitignore"), amoGitignore());
  installedFiles.push(".amo/.gitignore");

  ensureCanvas(path.join(vaultRoot, AMO_CANVAS_PATH), {
    workspaceId: inspection.workspaceId,
    workspacePath,
    projectName: inspection.projectName,
    createdAt: existingWorkspace?.createdAt || now,
    updatedAt: now,
  });
  installedFiles.push(workspaceRelativePath(workspacePath, path.join(vaultRoot, AMO_CANVAS_PATH)));

  const pluginInstall = installObsidianPlugin(vaultRoot, workspacePath);
  installedFiles.push(...pluginInstall.installedFiles);

  const requestedAdapterIds = new Set(requestedAdapters);
  const preservedEnrollmentAdapters = Array.isArray(existingEnrollment?.adapters)
    ? existingEnrollment.adapters.filter((adapter) => !requestedAdapterIds.has(normalizeText(adapter?.id)))
    : [];

  writeJsonFile(enrollmentFile, {
    schemaVersion: AMO_SCHEMA_VERSION,
    deploymentVersion: AMO_DEPLOYMENT_VERSION,
    hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
    workspaceId: inspection.workspaceId,
    workspacePath,
    updatedAt: now,
    adapters: [...preservedEnrollmentAdapters, ...enrollmentAdapters],
    deferredAdapters: inspection.deferredAdapters,
  });
  installedFiles.push(".amo/enrollment.json");

  recordDebugLog("broker", "workspace.enrolled", {
    workspaceId: inspection.workspaceId,
    workspacePath,
    vaultRoot,
    installedFiles: installedFiles.length,
    mergedFiles,
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    deploymentVersion: AMO_DEPLOYMENT_VERSION,
    hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
    workspaceId: inspection.workspaceId,
    workspacePath,
    deploymentRoot: AMO_DIR,
    installedAdapters,
    installedFiles,
    mergedFiles,
    backups,
    vaultRoot,
    canvasPath: AMO_CANVAS_PATH,
    deferredAdapters: inspection.deferredAdapters,
  };
}

function updateWorkspaceGitExclude(payload) {
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const includeClaudeSettingsLocal = Boolean(payload?.includeClaudeSettingsLocal || payload?.include_claude_settings_local);
  const plan = resolveWorkspaceGitExcludePlan(workspacePath, payload?.gitRootPath || payload?.git_root_path, {
    includeClaudeSettingsLocal,
  });
  const excludeFile = plan.excludeFilePath;
  const rawBefore = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  const lineSet = new Set(
    rawBefore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  );

  const addedEntries = [];
  const existingEntries = [];
  for (const entry of plan.entries) {
    if (lineSet.has(entry.pattern)) {
      existingEntries.push(entry);
    } else {
      addedEntries.push(entry);
    }
  }

  if (addedEntries.length > 0) {
    const needsSeparator = rawBefore.length > 0 && !rawBefore.endsWith("\n");
    const lines = [];
    if (needsSeparator) lines.push("");
    if (!rawBefore.includes("# AMO local deployment artifacts")) {
      lines.push("# AMO local deployment artifacts");
    }
    for (const entry of addedEntries) {
      lines.push(entry.pattern);
    }
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `${lines.join("\n")}\n`, "utf8");
  }

  const status = inspectWorkspaceGitExclude(workspacePath, plan.gitRootPath, includeClaudeSettingsLocal);
  recordDebugLog("broker", "workspace.git_exclude.updated", {
    workspacePath,
    gitRootPath: plan.gitRootPath,
    excludeFilePath: excludeFile,
    addedEntries: addedEntries.map((entry) => entry.pattern),
    existingEntries: existingEntries.map((entry) => entry.pattern),
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    changed: addedEntries.length > 0,
    workspacePath,
    gitRootPath: plan.gitRootPath,
    gitDirPath: plan.gitDirPath,
    excludeFilePath: excludeFile,
    workspaceRelativePath: plan.workspaceRelativePath,
    entries: plan.entries,
    addedEntries,
    existingEntries,
    includeClaudeSettingsLocal,
    status,
  };
}

async function launchWorkspace(payload) {
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const adapterId = normalizeText(payload?.adapterId || payload?.adapter_id || payload?.adapter);
  const resumeSessionId = normalizeText(payload?.sessionId || payload?.session_id || payload?.resumeSessionId || payload?.resume_session_id);
  const supportedLaunchIds = new Set(["codex-cli", "claude-cli", "codex-app"]);
  if (!supportedLaunchIds.has(adapterId)) {
    throw httpError(400, "unsupported_launch_adapter", `Unsupported launch adapter: ${adapterId || "missing"}`);
  }

  const amoRoot = path.join(workspacePath, AMO_DIR);
  const workspace = readJsonFile(path.join(amoRoot, "workspace.json"), null);
  if (!workspace || !workspace.workspaceId) {
    throw httpError(400, "workspace_not_enrolled", "Selected workspace does not have AMO enrollment metadata");
  }

  if (adapterId !== "codex-app") {
    const enrollment = readJsonFile(path.join(amoRoot, "enrollment.json"), null);
    const installedAdapters = Array.isArray(enrollment?.adapters) ? enrollment.adapters : [];
    const installed = installedAdapters.some((adapter) => normalizeText(adapter?.id) === adapterId);
    if (!installed) {
      throw httpError(400, "adapter_not_installed", `${adapterId} is not deployed in this workspace`);
    }
  }

  const projectName = path.basename(workspacePath);
  const startedAt = new Date().toISOString();
  const codexLaunchRoute =
    adapterId === "codex-cli" && resumeSessionId
      ? codexCliLaunchRoute({ workspacePath, projectName, sessionId: resumeSessionId })
      : null;
  let launch;
  if (adapterId === "codex-cli") {
    launch = await launchCliInTerminal({
      workspacePath,
      title: codexLaunchRoute?.title || `AMO Codex CLI - ${projectName}`,
      command: "codex",
      args: resumeSessionId ? ["resume", resumeSessionId] : [],
    });
  } else if (adapterId === "claude-cli") {
    launch = await launchCliInTerminal({
      workspacePath,
      title: `AMO Claude CLI - ${projectName}`,
      command: "claude",
      args: [],
    });
  } else {
    launch = await spawnDetached("codex", ["app", workspacePath], workspacePath);
  }

  recordDebugLog("broker", "workspace.launch", {
    workspacePath,
    adapterId,
    projectName,
    pid: launch.pid || null,
    command: launch.command,
    args: launch.args,
    resumeSessionId: resumeSessionId || null,
    titleToken: codexLaunchRoute?.windowHint.titleToken || null,
  });

  const launchedSession =
    codexLaunchRoute
      ? bindLaunchedCodexCliTarget({
          sessionId: resumeSessionId,
          workspacePath,
          projectName,
          windowHint: codexLaunchRoute.windowHint,
          launchedAt: startedAt,
          launch,
        })
      : null;

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    workspacePath,
    adapterId,
    projectName,
    launchedAt: startedAt,
    pid: launch.pid || null,
    command: launch.command,
    args: launch.args,
    windowHint: launchedSession?.windowHint || codexLaunchRoute?.windowHint || null,
    targetBinding: launchedSession?.targetBinding || null,
    session: launchedSession,
    message:
      adapterId === "codex-app"
        ? `Opened Codex App for ${projectName}.`
        : resumeSessionId && adapterId === "codex-cli"
        ? `Launched Codex CLI resume for ${projectName}.`
        : `Launched ${adapterId === "codex-cli" ? "Codex CLI" : "Claude CLI"} for ${projectName}.`,
  };
}

function codexCliLaunchRoute({ workspacePath, projectName, sessionId }) {
  const projectSlug = sanitizeFilePart(projectName).toLowerCase();
  const sessionSlug = crypto.createHash("sha1").update(sessionId).digest("hex").slice(0, 10);
  const titleToken = `[AMO:codex:${projectSlug}:${sessionSlug}]`;
  const title = `${titleToken} Codex CLI - ${projectName}`;

  return {
    title,
    windowHint: {
      process: null,
      title,
      titleToken,
      titleContains: ["Codex", projectName, sessionId],
      project: projectName,
      cwd: workspacePath,
      tool: "codex",
      pid: null,
      hwnd: null,
      boundAt: null,
      boundBy: "workspace-launch",
      boundLabel: title,
    },
  };
}

function bindLaunchedCodexCliTarget({ sessionId, workspacePath, projectName, windowHint, launchedAt, launch }) {
  const existing = sessions.get(sessionId);
  if (!existing) {
    return null;
  }

  const boundHint = {
    ...(existing.windowHint || {}),
    ...windowHint,
    pid: null,
    hwnd: null,
    boundAt: launchedAt,
    boundBy: "workspace-launch",
    boundLabel: windowHint.boundLabel || windowHint.title || `Codex CLI - ${projectName}`,
  };
  const targetBinding = normalizeTargetBinding(
    {
      type: "codex-cli-session",
      label: "Codex CLI",
      sessionId,
      workspacePath,
      boundAt: launchedAt,
      boundBy: "workspace-launch",
    },
    sessionId,
    launchedAt
  );
  const session = {
    ...existing,
    cwd: existing.cwd || workspacePath,
    workspacePath: existing.workspacePath || workspacePath,
    windowHint: boundHint,
    targetBinding,
    lastEvent: "TargetLaunched",
    lastMessage: `Launched Codex CLI target for ${projectName}.`,
    updatedAt: launchedAt,
    eventCount: (existing.eventCount || 0) + 1,
    processInfo: {
      ...(existing.processInfo || {}),
      launchedPid: launch?.pid || null,
      launchedCommand: launch?.command || null,
      launchedArgs: Array.isArray(launch?.args) ? launch.args : [],
      launchedAt,
    },
  };

  sessions.set(sessionId, session);
  recordDebugLog("broker", "workspace.launch.target_bound", {
    sessionId,
    workspacePath,
    titleToken: boundHint.titleToken || null,
    launchedPid: launch?.pid || null,
  });

  return session;
}

async function launchCliInTerminal({ workspacePath, title, command, args = [] }) {
  const cliArgs = args.map(powershellSingleQuoted).join(" ");
  const commandLine = `$Host.UI.RawUI.WindowTitle = ${powershellSingleQuoted(title)}; Set-Location -LiteralPath ${powershellSingleQuoted(workspacePath)}; & ${command}${cliArgs ? ` ${cliArgs}` : ""}`;
  const powershellArgs = powershellNoExitEncodedArgs(commandLine);
  if (process.platform === "win32") {
    const wtArgs = [
      "-w",
      "new",
      "new-tab",
      "--title",
      title,
      "-d",
      workspacePath,
      "powershell.exe",
      ...powershellArgs,
    ];
    try {
      return await spawnDetached("wt.exe", wtArgs, workspacePath);
    } catch (error) {
      recordDebugLog("broker", "workspace.launch.wt_failed", {
        workspacePath,
        title,
        message: error.message || String(error),
      });
    }

    return spawnDetached(
      "powershell.exe",
      powershellArgs,
      workspacePath
    );
  }

  return spawnDetached(command, [], workspacePath);
}

function powershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function powershellNoExitEncodedArgs(commandLine) {
  return [
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(commandLine, "utf16le").toString("base64"),
  ];
}

function spawnDetached(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: options.windowsHide ?? false,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    child.once("error", (error) => {
      finish(reject, error);
    });
    child.once("spawn", () => {
      child.unref();
      finish(resolve, {
        pid: child.pid || null,
        command,
        args,
      });
    });
  });
}

function inspectWorkspaceMaintenance(payload) {
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const status = workspaceMaintenanceSnapshot(workspacePath);
  recordDebugLog("broker", "workspace.maintenance.status", {
    workspacePath,
    issueCount: status.issues.length,
    replyNotes: status.counts.replyNotes,
    promptNotes: status.counts.promptNotes,
  });
  return status;
}

function cleanWorkspaceVault(payload) {
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const statusBefore = workspaceMaintenanceSnapshot(workspacePath);
  const workspace = readJsonFile(path.join(workspacePath, AMO_DIR, "workspace.json"), null);
  if (!workspace || !workspace.workspaceId) {
    throw httpError(400, "workspace_not_enrolled", "Selected workspace does not have AMO enrollment metadata");
  }

  const amoRoot = path.join(workspacePath, AMO_DIR);
  const vaultRoot = resolveWorkspaceVaultRoot(amoRoot, workspace, workspace.projectName || path.basename(workspacePath));
  const sessionsPath = path.join(vaultRoot, AMO_SESSIONS_PATH);
  const canvasesPath = path.join(vaultRoot, AMO_CANVASES_PATH);
  const canvasPath = path.join(vaultRoot, AMO_CANVAS_PATH);
  const legacyRepliesPath = path.join(vaultRoot, "Replies");
  const legacyPromptsPath = path.join(vaultRoot, "Prompts");
  const legacyCanvasPath = path.join(vaultRoot, "AgentFlow.canvas");
  ensureInsideDirectory(vaultRoot, sessionsPath);
  ensureInsideDirectory(vaultRoot, canvasesPath);
  ensureInsideDirectory(vaultRoot, canvasPath);
  ensureInsideDirectory(vaultRoot, legacyRepliesPath);
  ensureInsideDirectory(vaultRoot, legacyPromptsPath);
  ensureInsideDirectory(vaultRoot, legacyCanvasPath);

  fs.rmSync(sessionsPath, { recursive: true, force: true });
  fs.rmSync(legacyRepliesPath, { recursive: true, force: true });
  fs.rmSync(legacyPromptsPath, { recursive: true, force: true });
  fs.rmSync(legacyCanvasPath, { force: true });
  fs.mkdirSync(sessionsPath, { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, AMO_WORK_CANVASES_PATH), { recursive: true });
  ensureCanvas(canvasPath, {
    workspaceId: workspace.workspaceId,
    workspacePath,
    projectName: workspace.projectName || path.basename(workspacePath),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reset: true,
  });
  resetWorkspaceCanvasBindings(amoRoot);
  resetWorkspaceNoteIndex(amoRoot);

  const clearedSessions = clearWorkspaceBridgeState(workspacePath, vaultRoot);
  const statusAfter = workspaceMaintenanceSnapshot(workspacePath);
  recordDebugLog("broker", "workspace.maintenance.cleaned", {
    workspacePath,
    clearedSessions,
    before: statusBefore.counts,
    after: statusAfter.counts,
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspacePath,
    vaultRoot,
    clearedSessions,
    before: statusBefore,
    after: statusAfter,
  };
}

function workspaceMaintenanceSnapshot(workspacePath) {
  const amoRoot = path.join(workspacePath, AMO_DIR);
  const workspaceFile = path.join(amoRoot, "workspace.json");
  const workspace = readJsonFile(workspaceFile, null);
  if (!workspace || !workspace.workspaceId) {
    throw httpError(400, "workspace_not_enrolled", "Selected workspace does not have AMO enrollment metadata");
  }

  const vaultRoot = resolveWorkspaceVaultRoot(amoRoot, workspace, path.basename(workspacePath));
  const sessionsPath = path.join(vaultRoot, AMO_SESSIONS_PATH);
  const generatedPath = path.join(sessionsPath, "*", ...AMO_SESSION_GENERATED_PATH.split("/"));
  const workCanvasesPath = path.join(vaultRoot, AMO_WORK_CANVASES_PATH);
  const canvasPath = path.join(vaultRoot, AMO_CANVAS_PATH);
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", OBSIDIAN_PLUGIN_ID);
  const canvasInfo = inspectCanvasFile(canvasPath);
  const pluginHealth = inspectObsidianPluginHealth(vaultRoot);
  const generatedCounts = countConversationGeneratedNotes(sessionsPath);
  const issues = [];

  if (!fs.existsSync(amoRoot)) issues.push(".amo directory is missing");
  if (!fs.existsSync(workspaceFile)) issues.push(".amo/workspace.json is missing");
  if (!fs.existsSync(vaultRoot)) issues.push("obsidian vault is missing");
  if (!fs.existsSync(sessionsPath)) issues.push("Sessions folder is missing");
  if (!fs.existsSync(path.dirname(canvasPath))) issues.push("Canvases folder is missing");
  if (!canvasInfo.exists) {
    issues.push("AgentFlow.base.canvas is missing");
  } else if (!canvasInfo.readable) {
    issues.push("AgentFlow.base.canvas is not valid JSON");
  } else if (!canvasInfo.amoManaged) {
    issues.push("AgentFlow.base.canvas is missing AMO managed marker");
  }
  if (pluginHealth.issues?.length) {
    issues.push(...pluginHealth.issues);
  }

  return {
    ok: issues.length === 0,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    workspacePath,
    projectName: normalizeText(workspace.projectName) || path.basename(workspacePath),
    amoRoot,
    vaultRoot,
    paths: {
      workspace: workspacePath,
      amoRoot,
      vaultRoot,
      sessions: sessionsPath,
      generated: generatedPath,
      workCanvases: workCanvasesPath,
      canvas: canvasPath,
      replies: path.join(vaultRoot, "Replies"),
      prompts: path.join(vaultRoot, "Prompts"),
      plugin: pluginDir,
    },
    exists: {
      amoRoot: fs.existsSync(amoRoot),
      workspaceJson: fs.existsSync(workspaceFile),
      vaultRoot: fs.existsSync(vaultRoot),
      sessions: fs.existsSync(sessionsPath),
      generated: fs.existsSync(sessionsPath),
      workCanvases: fs.existsSync(workCanvasesPath),
      canvas: canvasInfo.exists,
      replies: fs.existsSync(path.join(vaultRoot, "Replies")),
      prompts: fs.existsSync(path.join(vaultRoot, "Prompts")),
      plugin: fs.existsSync(pluginDir),
    },
    counts: {
      replyNotes: generatedCounts.replyNotes,
      promptNotes: generatedCounts.promptNotes,
      generatedNotes: generatedCounts.totalNotes,
      sessionFolders: generatedCounts.sessionFolders,
      canvasNodes: canvasInfo.nodeCount,
      canvasEdges: canvasInfo.edgeCount,
    },
    canvas: canvasInfo,
    pluginHealth,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

function inspectCanvasFile(canvasPath) {
  if (!fs.existsSync(canvasPath)) {
    return {
      exists: false,
      readable: false,
      amoManaged: false,
      nodeCount: 0,
      edgeCount: 0,
      marker: null,
    };
  }

  const canvas = readJsonFile(canvasPath, null);
  if (!canvas || typeof canvas !== "object" || Array.isArray(canvas)) {
    return {
      exists: true,
      readable: false,
      amoManaged: false,
      nodeCount: 0,
      edgeCount: 0,
      marker: null,
    };
  }

  const marker = canvas.amo && typeof canvas.amo === "object" && !Array.isArray(canvas.amo) ? canvas.amo : null;
  return {
    exists: true,
    readable: true,
    amoManaged: Boolean(marker && marker.managedBy === AMO_CANVAS_MANAGER && marker.canvasType === AMO_CANVAS_TYPE),
    nodeCount: Array.isArray(canvas.nodes) ? canvas.nodes.length : 0,
    edgeCount: Array.isArray(canvas.edges) ? canvas.edges.length : 0,
    marker: marker
      ? {
          schemaVersion: marker.schemaVersion ?? null,
          canvasType: normalizeText(marker.canvasType),
          managedBy: normalizeText(marker.managedBy),
          workspaceId: normalizeText(marker.workspaceId),
          labelMode: normalizeText(marker.display?.labelMode),
          hidePropertiesByDefault:
            typeof marker.display?.hidePropertiesByDefault === "boolean"
              ? marker.display.hidePropertiesByDefault
              : null,
        }
      : null,
  };
}

function countFilesByExtension(root, extension) {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      count += countFilesByExtension(entryPath, extension);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension.toLowerCase())) {
      count += 1;
    }
  }
  return count;
}

function countConversationGeneratedNotes(sessionsPath) {
  const result = {
    replyNotes: 0,
    promptNotes: 0,
    totalNotes: 0,
    sessionFolders: 0,
  };
  if (!fs.existsSync(sessionsPath)) return result;

  for (const sessionEntry of fs.readdirSync(sessionsPath, { withFileTypes: true })) {
    if (!sessionEntry.isDirectory()) continue;
    result.sessionFolders += 1;
    const generatedDir = path.join(sessionsPath, sessionEntry.name, ...AMO_SESSION_GENERATED_PATH.split("/"));
    if (!fs.existsSync(generatedDir)) continue;
    for (const entry of fs.readdirSync(generatedDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      result.totalNotes += 1;
      if (/^(?:\d+ reply|reply \d+)\.md$/iu.test(entry.name)) {
        result.replyNotes += 1;
      } else if (/^(?:\d+ prompt|prompt \d+)\.md$/iu.test(entry.name)) {
        result.promptNotes += 1;
      }
    }
  }

  return result;
}

function clearWorkspaceBridgeState(workspacePath, vaultRoot) {
  const workspaceKey = normalizeComparablePath(workspacePath);
  const vaultKey = normalizeComparablePath(vaultRoot);
  let cleared = 0;
  const now = new Date().toISOString();

  for (const [sessionId, session] of sessions.entries()) {
    const sessionWorkspaceKey = normalizeComparablePath(session.workspacePath || session.cwd);
    const sessionVaultKey = normalizeComparablePath(session.vaultRoot);
    if (sessionWorkspaceKey !== workspaceKey && sessionVaultKey !== vaultKey) {
      continue;
    }

    const nextSession = {
      ...session,
      lastReplyAt: null,
      lastReplyNote: null,
      lastReplyNoteAbsolutePath: null,
      lastPromptAt: null,
      lastPromptNote: null,
      lastPromptNoteAbsolutePath: null,
      lastPromptCanvasNodeId: null,
      lastPromptHash: null,
      lastPromptPendingPromptId: null,
      lastPromptSource: null,
      sentPromptId: null,
      sentPromptNote: null,
      sentPromptNoteAbsolutePath: null,
      sentPromptCanvasNodeId: null,
      sentPromptRecordedAt: null,
      canvasPath: AMO_CANVAS_PATH,
      canvasAbsolutePath: path.join(vaultRoot, AMO_CANVAS_PATH),
      canvasNodeId: null,
      pendingPromptId: null,
      pendingPrompt: null,
      pendingPromptCreatedAt: null,
      pendingPromptCopiedAt: null,
      pendingAnnotationCount: null,
      pendingAnnotationSource: null,
      updatedAt: now,
    };
    sessions.set(sessionId, nextSession);
    publishSessionChanged("workspace-clean", nextSession);
    cleared += 1;
  }

  return cleared;
}

function resetWorkspaceCanvasBindings(amoRoot) {
  const bindingsPath = path.join(amoRoot, "state", "bindings.json");
  fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
  writeJsonFile(bindingsPath, {
    schemaVersion: AMO_SCHEMA_VERSION,
    sessions: {},
  });
}

function resetWorkspaceNoteIndex(amoRoot) {
  const noteIndexPath = path.join(amoRoot, AMO_NOTE_INDEX_PATH);
  fs.mkdirSync(path.dirname(noteIndexPath), { recursive: true });
  writeJsonFile(noteIndexPath, {
    schemaVersion: AMO_SCHEMA_VERSION,
    notes: {},
    byPath: {},
  });
}

function handleReply(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Reply payload must be a JSON object");
  }

  const message = normalizeText(payload.message || payload.last_assistant_message);
  if (!message) {
    throw httpError(400, "missing_message", "Reply payload must include message or last_assistant_message");
  }

  const sessionId = normalizeText(payload.sessionId || payload.session_id);
  if (!sessionId) {
    throw httpError(400, "missing_session_id", "Reply payload must include sessionId");
  }

  const workspaceRoot = findEnrolledWorkspace(payload.workspacePath || payload.workspace_path || payload.cwd);
  const amoRoot = path.join(workspaceRoot, AMO_DIR);
  const workspace = readJsonFile(path.join(amoRoot, "workspace.json"), null);
  if (!workspace || !workspace.workspaceId) {
    throw httpError(400, "workspace_not_enrolled", "Selected workspace does not have AMO enrollment metadata");
  }

  const tool = normalizeText(payload.tool) || "codex";
  const now = new Date().toISOString();
  const capturedAt = normalizeText(payload.capturedAt || payload.captured_at || payload.timestamp) || now;
  const turnId = normalizeText(payload.turnId || payload.turn_id) || "unknown-turn";
  const source = normalizeText(payload.source) || "codex-stop-hook";
  const hookEventName = normalizeText(payload.hookEventName || payload.hook_event_name) || "Stop";
  const cwd = normalizeText(payload.cwd) || workspaceRoot;
  const transcriptPath = normalizeText(payload.transcriptPath || payload.transcript_path);
  const existing = sessions.get(sessionId);
  const title = resolveSessionTitle(tool, sessionId, payload.title, existing?.title);
  const taskTitle = normalizeText(payload.taskTitle || payload.task_title) || existing?.taskTitle || null;
  const windowHint = normalizeWindowHint(payload.windowHint || payload.window_hint) || existing?.windowHint || null;
  const targetBinding = resolveSessionTargetBinding({ payload, existing, sessionId, tool, cwd, boundAt: capturedAt, windowHint });
  const record = {
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    workspacePath: workspaceRoot,
    tool,
    source,
    sessionId,
    turnId,
    cwd,
    title,
    taskTitle,
    model: normalizeText(payload.model),
    hookEventName,
    transcriptPath,
    capturedAt,
    message,
  };

  const vaultRoot = resolveWorkspaceVaultRoot(amoRoot, workspace, path.basename(workspaceRoot));
  const note = writeReplyNote(amoRoot, vaultRoot, record);
  const canvas = appendConversationNoteToCanvas(amoRoot, vaultRoot, record, note);

  const session = reviveArchivedSession({
    tool,
    sessionId,
    cwd,
    title,
    taskTitle,
    state: "idle",
    lastEvent: hookEventName,
    lastMessage: trimMessage(message, 240),
    needsAttention: false,
    windowHint,
    targetBinding,
    updatedAt: capturedAt,
    createdAt: existing?.createdAt || now,
    heartbeatAt: existing?.heartbeatAt || null,
    eventCount: (existing?.eventCount || 0) + 1,
    workspaceId: workspace.workspaceId,
    workspacePath: workspaceRoot,
    vaultRoot,
    lastReplyAt: capturedAt,
    lastReplyNote: note.notePath,
    lastReplyNoteAbsolutePath: note.noteAbsolutePath,
    reviewRequired: true,
    reviewStatus: "pending",
    reviewRequestedAt: capturedAt,
    reviewedAt: null,
    reviewedBy: null,
    reviewAction: null,
    reviewTurnId: turnId,
    reviewNote: note.notePath,
    reviewCanvasNodeId: canvas.canvasNodeId,
    lastPromptAt: existing?.lastPromptAt || null,
    lastPromptNote: existing?.lastPromptNote || null,
    lastPromptNoteAbsolutePath: existing?.lastPromptNoteAbsolutePath || null,
    lastPromptCanvasNodeId: existing?.lastPromptCanvasNodeId || null,
    lastPromptHash: existing?.lastPromptHash || null,
    lastPromptPendingPromptId: existing?.lastPromptPendingPromptId || null,
    lastPromptSource: existing?.lastPromptSource || null,
    canvasPath: canvas.canvasPath,
    canvasAbsolutePath: canvas.canvasAbsolutePath,
    canvasNodeId: canvas.canvasNodeId,
  }, "reply", existing);
  sessions.set(sessionId, session);

  recordDebugLog("broker", "reply.created", {
    sessionId,
    turnId,
    source,
    cwd,
    notePath: note.notePath,
    canvasPath: canvas.canvasPath,
    canvasNodeId: canvas.canvasNodeId,
    messagePreview: debugPreview(message),
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    sessionId,
    turnId,
    notePath: note.notePath,
    noteAbsolutePath: note.noteAbsolutePath,
    canvasPath: canvas.canvasPath,
    canvasAbsolutePath: canvas.canvasAbsolutePath,
    canvasNodeId: canvas.canvasNodeId,
    session,
  };
}

function handlePrompt(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Prompt payload must be a JSON object");
  }

  const message = normalizeText(payload.message || payload.prompt || payload.userPrompt || payload.user_prompt);
  if (!message) {
    throw httpError(400, "missing_message", "Prompt payload must include message or prompt");
  }

  const sessionId = normalizeText(payload.sessionId || payload.session_id);
  if (!sessionId) {
    throw httpError(400, "missing_session_id", "Prompt payload must include sessionId");
  }

  const existing = sessions.get(sessionId);
  const workspaceRoot = resolvePromptWorkspace(payload, existing);
  const amoRoot = path.join(workspaceRoot, AMO_DIR);
  const workspace = readJsonFile(path.join(amoRoot, "workspace.json"), null);
  if (!workspace || !workspace.workspaceId) {
    throw httpError(400, "workspace_not_enrolled", "Selected workspace does not have AMO enrollment metadata");
  }

  const tool = normalizeText(payload.tool) || existing?.tool || "codex";
  const now = new Date().toISOString();
  const capturedAt = normalizeText(payload.capturedAt || payload.captured_at || payload.timestamp) || now;
  const pendingPromptId = normalizeText(payload.pendingPromptId || payload.pending_prompt_id);
  const turnId =
    normalizeText(payload.turnId || payload.turn_id) ||
    pendingPromptId ||
    `prompt-${crypto.createHash("sha1").update(`${sessionId}:${capturedAt}:${message}`).digest("hex").slice(0, 12)}`;
  const source = normalizeText(payload.source) || "user-prompt";
  const hookEventName = normalizeText(payload.hookEventName || payload.hook_event_name) || "UserPromptSubmit";
  const cwd = normalizeText(payload.cwd) || existing?.cwd || workspaceRoot;
  const title = resolveSessionTitle(tool, sessionId, payload.title, existing?.title);
  const taskTitle = normalizeText(payload.taskTitle || payload.task_title) || existing?.taskTitle || null;
  const windowHint = normalizeWindowHint(payload.windowHint || payload.window_hint) || existing?.windowHint || null;
  const targetBinding = resolveSessionTargetBinding({ payload, existing, sessionId, tool, cwd, boundAt: capturedAt, windowHint });
  const promptHash = promptContentHash(message);
  const duplicate = findDuplicatePrompt(existing, {
    message,
    promptHash,
    pendingPromptId,
    source,
    capturedAt,
  });
  if (duplicate) {
    const duplicateSession = reviveArchivedSession(clearSessionAttentionFields(
      {
        ...(existing || {}),
        tool,
        sessionId,
        cwd,
        title,
        taskTitle,
        state: normalizeState(payload.state) || "running",
        lastEvent: hookEventName,
        lastMessage: trimMessage(`User: ${message}`, 240),
        updatedAt: capturedAt,
        createdAt: existing?.createdAt || now,
        heartbeatAt: existing?.heartbeatAt || null,
        eventCount: (existing?.eventCount || 0) + 1,
        workspaceId: existing?.workspaceId || workspace.workspaceId,
        workspacePath: existing?.workspacePath || workspaceRoot,
        windowHint,
        targetBinding,
      },
      "auto-cleared-by-duplicate-prompt"
    ), "duplicate-prompt", existing);
    sessions.set(sessionId, duplicateSession);
    if (sessionHasAttentionState(existing)) {
      recordDebugLog("broker", "session.attention_auto_cleared", {
        sessionId,
        reason: "duplicate-prompt",
        eventName: hookEventName,
        state: duplicateSession.state,
      });
    }
    recordDebugLog("broker", "prompt.duplicate_skipped", {
      sessionId,
      pendingPromptId: pendingPromptId || null,
      source,
      notePath: duplicate.notePath || null,
      messagePreview: debugPreview(message),
    });
    return {
      ok: true,
      schemaVersion: AMO_SCHEMA_VERSION,
      workspaceId: workspace.workspaceId,
      sessionId,
      turnId,
      duplicate: true,
      notePath: duplicate.notePath || null,
      noteAbsolutePath: duplicate.noteAbsolutePath || null,
      canvasPath: existing?.canvasPath || null,
      canvasAbsolutePath: existing?.canvasAbsolutePath || null,
      canvasNodeId: duplicate.canvasNodeId || null,
      session: duplicateSession,
    };
  }

  const record = {
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    workspacePath: workspaceRoot,
    role: "user",
    tool,
    source,
    sessionId,
    turnId,
    cwd,
    title,
    taskTitle,
    model: normalizeText(payload.model),
    hookEventName,
    transcriptPath: normalizeText(payload.transcriptPath || payload.transcript_path),
    capturedAt,
    pendingPromptId: pendingPromptId || null,
    message,
  };

  const vaultRoot = resolveWorkspaceVaultRoot(amoRoot, workspace, path.basename(workspaceRoot));
  const note = writePromptNote(amoRoot, vaultRoot, record);
  const canvas = appendConversationNoteToCanvas(amoRoot, vaultRoot, record, note);

  const session = reviveArchivedSession({
    ...(existing || {}),
    tool,
    sessionId,
    cwd,
    title,
    taskTitle,
    state: normalizeState(payload.state) || "running",
    lastEvent: hookEventName,
    lastMessage: trimMessage(`User: ${message}`, 240),
    needsAttention: false,
    windowHint,
    targetBinding,
    updatedAt: capturedAt,
    createdAt: existing?.createdAt || now,
    heartbeatAt: existing?.heartbeatAt || null,
    eventCount: (existing?.eventCount || 0) + 1,
    workspaceId: workspace.workspaceId,
    workspacePath: workspaceRoot,
    vaultRoot,
    reviewRequired: false,
    reviewStatus: null,
    reviewRequestedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewAction: null,
    reviewTurnId: null,
    reviewNote: null,
    reviewCanvasNodeId: null,
    lastPromptAt: capturedAt,
    lastPromptNote: note.notePath,
    lastPromptNoteAbsolutePath: note.noteAbsolutePath,
    lastPromptCanvasNodeId: canvas.canvasNodeId,
    lastPromptHash: promptHash,
    lastPromptPendingPromptId: pendingPromptId || null,
    lastPromptSource: source,
    canvasPath: canvas.canvasPath,
    canvasAbsolutePath: canvas.canvasAbsolutePath,
    canvasNodeId: canvas.canvasNodeId,
  }, "prompt", existing);
  sessions.set(sessionId, session);

  recordDebugLog("broker", "prompt.created", {
    sessionId,
    turnId,
    source,
    cwd,
    pendingPromptId: pendingPromptId || null,
    notePath: note.notePath,
    canvasPath: canvas.canvasPath,
    canvasNodeId: canvas.canvasNodeId,
    messagePreview: debugPreview(message),
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    sessionId,
    turnId,
    notePath: note.notePath,
    noteAbsolutePath: note.noteAbsolutePath,
    canvasPath: canvas.canvasPath,
    canvasAbsolutePath: canvas.canvasAbsolutePath,
    canvasNodeId: canvas.canvasNodeId,
    session,
  };
}

function handleObsidianAnnotations(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Annotation payload must be a JSON object");
  }

  const sessionId = normalizeText(payload.sessionId || payload.session_id);
  if (!sessionId) {
    throw httpError(400, "missing_session_id", "Annotation payload must include sessionId");
  }

  recordDebugLog("broker", "obsidian.annotations.received", {
    sessionId,
    source: normalizeText(payload.source) || "unknown",
    vaultRoot: normalizeText(payload.vaultRoot || payload.vault_root),
    notePath: normalizeText(payload.notePath || payload.note_path),
    turnId: normalizeText(payload.turnId || payload.turn_id),
    annotationCount: Array.isArray(payload.annotations) ? payload.annotations.length : 0,
    promptPreview: debugPreview(payload.prompt),
  });

  const existing = sessions.get(sessionId) || recoverSessionFromAnnotationPayload(payload, sessionId);
  if (!existing) {
    recordDebugLog("broker", "obsidian.annotations.session_missing", {
      sessionId,
      vaultRoot: normalizeText(payload.vaultRoot || payload.vault_root),
      notePath: normalizeText(payload.notePath || payload.note_path),
    });
    throw httpError(404, "session_not_found", `Session not found for annotation payload: ${sessionId}`);
  }

  const annotations = normalizeAnnotations(payload.annotations);
  const summary = normalizeText(payload.summary);
  if (annotations.length === 0 && !summary) {
    throw httpError(400, "missing_annotations", "Annotation payload must include annotations or summary");
  }

  const now = new Date().toISOString();
  const pendingPromptId =
    normalizeText(payload.pendingPromptId || payload.pending_prompt_id) || `prompt-${crypto.randomUUID()}`;
  const prompt = normalizeText(payload.prompt) || renderPendingPrompt({ ...payload, sessionId }, annotations, summary);
  const annotationCount = annotations.length || 1;
  const notePath = normalizeText(payload.notePath || payload.note_path);
  const vaultRoot = normalizeText(payload.vaultRoot || payload.vault_root);
  const turnId = normalizeText(payload.turnId || payload.turn_id);
  const source = normalizeText(payload.source) || "obsidian-plugin";

  const session = {
    ...existing,
    state: "waiting_user",
    lastEvent: "ObsidianAnnotations",
    lastMessage: `${annotationCount} annotation${annotationCount === 1 ? "" : "s"} ready for sync-back`,
    needsAttention: true,
    updatedAt: now,
    eventCount: (existing.eventCount || 0) + 1,
    pendingPromptId,
    pendingPrompt: prompt,
    pendingPromptCreatedAt: now,
    pendingPromptCopiedAt: null,
    pendingAnnotationCount: annotationCount,
    pendingAnnotationSource: {
      source,
      vaultRoot: vaultRoot || null,
      notePath: notePath || null,
      turnId: turnId || null,
    },
  };

  sessions.set(sessionId, session);

  recordDebugLog("broker", "obsidian.annotations.accepted", {
    sessionId,
    pendingPromptId,
    annotationCount,
    source,
    notePath,
    turnId,
    promptPreview: debugPreview(prompt),
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    sessionId,
    pendingPromptId,
    prompt,
    annotationCount,
    session,
  };
}

function handleObsidianNoteTitle(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Note title payload must be a JSON object");
  }

  const vaultRootText = normalizeText(payload.vaultRoot || payload.vault_root);
  const notePath = normalizeText(payload.notePath || payload.note_path);
  const displayTitle = normalizeNoteDisplayTitle(payload.displayTitle || payload.display_title || payload.title);
  if (!vaultRootText) {
    throw httpError(400, "missing_vault_root", "Note title payload must include vaultRoot");
  }
  if (!notePath) {
    throw httpError(400, "missing_note_path", "Note title payload must include notePath");
  }
  const vaultRoot = path.resolve(vaultRootText);
  const amoRoot = path.dirname(vaultRoot);
  const workspaceRoot = path.dirname(amoRoot);
  const workspace = readJsonFile(path.join(amoRoot, "workspace.json"), null);
  if (!workspace || !workspace.workspaceId || !fs.existsSync(vaultRoot)) {
    throw httpError(400, "workspace_not_enrolled", "Vault root does not belong to an enrolled AMO workspace");
  }

  const noteId = normalizeText(payload.noteId || payload.note_id);
  const updatedAt = new Date().toISOString();
  const noteIndex = readConversationNoteIndex(amoRoot);
  const existingNoteId = noteId || noteIndex.byPath?.[notePath] || "";
  const existingRecord = existingNoteId ? noteIndex.notes?.[existingNoteId] : null;
  const effectiveNoteId =
    existingNoteId ||
    `note_${crypto.createHash("sha1").update(`${workspace.workspaceId}:${notePath}`).digest("hex").slice(0, 16)}`;

  upsertConversationNoteIndex(amoRoot, {
    ...(existingRecord || {}),
    schemaVersion: AMO_SCHEMA_VERSION,
    noteId: effectiveNoteId,
    workspaceId: workspace.workspaceId,
    workspacePath: normalizeText(workspace.workspacePath) || workspaceRoot,
    notePath,
    displayTitle,
    updatedAt,
  });

  updateCanvasNoteDisplayTitle(vaultRoot, {
    noteId: effectiveNoteId,
    notePath,
    displayTitle,
    updatedAt,
  });

  recordDebugLog("broker", "obsidian.note_title.updated", {
    workspaceId: workspace.workspaceId,
    notePath,
    noteId: effectiveNoteId,
    displayTitle,
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    noteId: effectiveNoteId,
    notePath,
    displayTitle,
  };
}

function recoverSessionFromAnnotationPayload(payload, sessionId) {
  const vaultRootText = normalizeText(payload.vaultRoot || payload.vault_root);
  if (!vaultRootText) {
    return null;
  }

  const vaultRoot = path.resolve(vaultRootText);
  const amoRoot = path.dirname(vaultRoot);
  const workspaceRoot = path.dirname(amoRoot);
  const workspace = readJsonFile(path.join(amoRoot, "workspace.json"), null);
  if (!workspace || !workspace.workspaceId || !fs.existsSync(vaultRoot)) {
    return null;
  }

  const notePath = normalizeText(payload.notePath || payload.note_path);
  const now = new Date().toISOString();
  const workspacePath = normalizeText(workspace.workspacePath) || workspaceRoot;
  const projectName = normalizeText(workspace.projectName) || path.basename(workspacePath);

  return {
    tool: "codex",
    sessionId,
    cwd: workspacePath,
    title: resolveSessionTitle("codex", sessionId, payload.title, null),
    taskTitle: normalizeText(payload.taskTitle || payload.task_title) || null,
    state: "idle",
    lastEvent: "RecoveredFromObsidianNote",
    lastMessage: notePath ? `Recovered from Obsidian note: ${notePath}` : "Recovered from Obsidian note",
    needsAttention: false,
    windowHint: {
      titleContains: [projectName, "Codex"],
      project: projectName,
      cwd: workspacePath,
      tool: "codex",
      pid: null,
      hwnd: null,
    },
    updatedAt: now,
    createdAt: now,
    heartbeatAt: null,
    eventCount: 0,
    workspaceId: workspace.workspaceId,
    workspacePath,
    vaultRoot,
    lastReplyAt: null,
    lastReplyNote: notePath || null,
    lastReplyNoteAbsolutePath: notePath ? path.join(vaultRoot, notePath.replace(/[\\/]+/g, path.sep)) : null,
    canvasPath: AMO_CANVAS_PATH,
    canvasAbsolutePath: path.join(vaultRoot, AMO_CANVAS_PATH),
    canvasNodeId: null,
  };
}

function handleRegisterObsidianVault(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Vault registration payload must be a JSON object");
  }

  const rawVaultRoot = normalizeText(payload.vaultRoot || payload.vault_root);
  if (!rawVaultRoot) {
    throw httpError(400, "missing_vault_root", "Vault registration requires vaultRoot");
  }

  const vaultRoot = path.resolve(rawVaultRoot);
  let stat;
  try {
    stat = fs.statSync(vaultRoot);
  } catch {
    throw httpError(404, "vault_not_found", `Obsidian vault root does not exist: ${vaultRoot}`);
  }

  if (!stat.isDirectory()) {
    throw httpError(400, "vault_not_directory", `Obsidian vault root must be a directory: ${vaultRoot}`);
  }

  fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
  const result = registerObsidianVault(vaultRoot);
  recordDebugLog("broker", "obsidian.vault.registered", {
    vaultRoot,
    vaultId: result.vaultId,
    changed: result.changed,
  });
  return result;
}

function registerObsidianVault(vaultRoot) {
  const registryPath = obsidianRegistryPath();
  if (!registryPath) {
    throw httpError(409, "obsidian_registry_unavailable", "Could not locate the Obsidian registry path for this OS");
  }

  const existingRegistry = fs.existsSync(registryPath) ? readJsonFileStrict(registryPath) : {};
  if (
    typeof existingRegistry !== "object" ||
    Array.isArray(existingRegistry) ||
    (existingRegistry.vaults && typeof existingRegistry.vaults !== "object")
  ) {
    throw httpError(409, "invalid_obsidian_registry", `${registryPath} is not a supported Obsidian registry file`);
  }

  const vaults = existingRegistry.vaults || {};
  const normalizedVaultRoot = normalizeComparablePath(vaultRoot);
  let vaultId = Object.keys(vaults).find((id) => normalizeComparablePath(vaults[id]?.path) === normalizedVaultRoot);
  const alreadyRegistered = Boolean(vaultId);

  if (!vaultId) {
    vaultId = obsidianVaultIdForPath(vaultRoot);
    while (vaults[vaultId] && normalizeComparablePath(vaults[vaultId]?.path) !== normalizedVaultRoot) {
      vaultId = crypto.randomBytes(8).toString("hex");
    }
  }

  vaults[vaultId] = {
    ...(vaults[vaultId] || {}),
    path: vaultRoot,
    ts: Date.now(),
    open: true,
  };

  writeJsonFile(registryPath, {
    ...existingRegistry,
    vaults,
  });

  const runtimeConfigPath = path.join(path.dirname(registryPath), `${vaultId}.json`);
  const runtimeConfigExists = fs.existsSync(runtimeConfigPath);
  const vaultRuntimeState = inspectObsidianVaultRuntimeState(vaultRoot);

  return {
    ok: true,
    vaultRoot,
    vaultId,
    registryPath,
    runtimeConfigPath,
    runtimeConfigExists: runtimeConfigExists || vaultRuntimeState.loaded,
    runtimeConfigFileExists: runtimeConfigExists,
    vaultRuntimeState,
    obsidianProcessCount: countObsidianProcesses(),
    alreadyRegistered,
    changed: !alreadyRegistered,
  };
}

function inspectObsidianVaultRuntimeState(vaultRoot) {
  const obsidianDir = path.join(vaultRoot, ".obsidian");
  const evidenceFiles = ["workspace.json", "app.json", "core-plugins.json"];
  const evidence = evidenceFiles.map((fileName) => {
    const filePath = path.join(obsidianDir, fileName);
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return {
        fileName,
        path: filePath,
        exists: false,
        size: null,
        mtime: null,
      };
    }

    return {
      fileName,
      path: filePath,
      exists: stat.isFile(),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  });

  return {
    loaded: evidence.some((item) => item.exists),
    evidence,
  };
}

function countObsidianProcesses() {
  if (process.platform !== "win32") {
    return null;
  }

  try {
    const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq Obsidian.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      return null;
    }

    return result.stdout
      .split(/\r?\n/u)
      .filter((line) => /^"Obsidian\.exe"/iu.test(line.trim()))
      .length;
  } catch {
    return null;
  }
}

function obsidianRegistryPath() {
  if (process.platform === "win32") {
    return process.env.APPDATA ? path.join(process.env.APPDATA, "obsidian", "obsidian.json") : null;
  }

  if (process.platform === "darwin") {
    return process.env.HOME
      ? path.join(process.env.HOME, "Library", "Application Support", "obsidian", "obsidian.json")
      : null;
  }

  const configRoot =
    process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, ".config") : null);
  return configRoot ? path.join(configRoot, "obsidian", "obsidian.json") : null;
}

function obsidianVaultIdForPath(vaultRoot) {
  return crypto.createHash("sha256").update(normalizeComparablePath(vaultRoot)).digest("hex").slice(0, 16);
}

function normalizeComparablePath(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function handleSyncBack(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Sync-back payload must be a JSON object");
  }

  const sessionId = normalizeText(payload.sessionId || payload.session_id);
  if (!sessionId) {
    throw httpError(400, "missing_session_id", "Sync-back payload must include sessionId");
  }

  recordDebugLog("broker", "sync_back.received", {
    sessionId,
    pendingPromptId: normalizeText(payload.pendingPromptId || payload.pending_prompt_id),
    action: normalizeText(payload.action),
  });

  const existing = sessions.get(sessionId);
  if (!existing) {
    recordDebugLog("broker", "sync_back.session_missing", { sessionId });
    throw httpError(404, "session_not_found", `Session not found for sync-back payload: ${sessionId}`);
  }

  const pendingPromptId = normalizeText(payload.pendingPromptId || payload.pending_prompt_id);
  if (pendingPromptId && existing.pendingPromptId && pendingPromptId !== existing.pendingPromptId) {
    throw httpError(409, "pending_prompt_mismatch", "Sync-back pendingPromptId does not match current session");
  }

  const now = new Date().toISOString();
  let promptRecord = null;
  let promptSessionBase = existing;
  if (existing.pendingPrompt) {
    promptRecord = handlePrompt({
      schemaVersion: AMO_SCHEMA_VERSION,
      tool: existing.tool,
      source: "amo-sync-back",
      sessionId,
      cwd: existing.cwd || existing.workspacePath,
      workspacePath: existing.workspacePath,
      message: existing.pendingPrompt,
      pendingPromptId: existing.pendingPromptId || pendingPromptId || null,
      turnId: existing.pendingPromptId || pendingPromptId || null,
      hookEventName: "AmoSyncBack",
      capturedAt: now,
    });
    promptSessionBase = promptRecord.session || existing;
  }

  const session = {
    ...promptSessionBase,
    lastEvent: "SyncBackCopied",
    lastMessage: "Pending prompt copied; paste it manually into the target",
    needsAttention: false,
    updatedAt: now,
    eventCount: (promptSessionBase.eventCount || 0) + 1,
    pendingPromptCopiedAt: now,
    sentPromptId: promptRecord?.turnId || promptSessionBase.sentPromptId || null,
    sentPromptNote: promptRecord?.notePath || promptSessionBase.sentPromptNote || null,
    sentPromptNoteAbsolutePath: promptRecord?.noteAbsolutePath || promptSessionBase.sentPromptNoteAbsolutePath || null,
    sentPromptCanvasNodeId: promptRecord?.canvasNodeId || promptSessionBase.sentPromptCanvasNodeId || null,
    sentPromptRecordedAt: promptRecord ? now : promptSessionBase.sentPromptRecordedAt || null,
  };

  sessions.set(sessionId, session);

  recordDebugLog("broker", "sync_back.accepted", {
    sessionId,
    pendingPromptId: session.pendingPromptId || null,
    copiedAt: now,
    promptNotePath: promptRecord?.notePath || null,
    promptCanvasNodeId: promptRecord?.canvasNodeId || null,
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    sessionId,
    pendingPromptId: session.pendingPromptId || null,
    copiedAt: now,
    promptNotePath: promptRecord?.notePath || null,
    promptCanvasNodeId: promptRecord?.canvasNodeId || null,
    session,
  };
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

function clearWindowIdentity(currentHint, existing) {
  const resetHint =
    currentHint.boundBy === "overlay-candidate-menu" || currentHint.boundBy === "overlay-target-menu"
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
  return normalizeWindowHint(resetHint);
}

function deferredAdapter(id, label, reason) {
  return {
    id,
    label,
    status: "deferred",
    reason,
  };
}

function adapterDeploymentReason({ writable, installed, deploymentStatus, deploymentIssues = [], empty, label, hookDescription }) {
  if (!writable) {
    return "Workspace is not writable.";
  }
  if (installed && deploymentStatus === "needs-update") {
    const issue = deploymentIssues[0] ? ` ${deploymentIssues[0]}.` : "";
    return `${label} adapter is installed but needs hook update.${issue}`;
  }
  if (installed) {
    return `${label} adapter is already deployed in this workspace.`;
  }
  if (empty) {
    return `Workspace folder is empty; ${label} adapter has not been deployed here yet.`;
  }
  return `${label} can deploy ${hookDescription} in this workspace.`;
}

function isDeployableAdapterPlan(plan) {
  if (typeof plan?.deployable === "boolean") {
    return plan.deployable;
  }
  return plan?.status === "available";
}

function normalizeAdapterIds(value) {
  if (Array.isArray(value)) {
    const ids = value.map(normalizeText).filter(Boolean);
    return ids.length > 0 ? ids : ["codex-cli"];
  }

  const id = normalizeText(value);
  return id ? [id] : ["codex-cli"];
}

function inspectWorkspaceGitExclude(workspacePath, requestedGitRootPath = "", includeClaudeSettingsLocal = false) {
  try {
    const plan = resolveWorkspaceGitExcludePlan(workspacePath, requestedGitRootPath, {
      allowMissing: true,
      includeClaudeSettingsLocal,
    });
    if (!plan.gitRootPath) {
      return {
        ok: false,
        status: "not-found",
        gitRootPath: "",
        gitDirPath: "",
        excludeFilePath: "",
        workspaceRelativePath: "",
        entries: defaultWorkspaceGitExcludeEntries("", includeClaudeSettingsLocal),
        missingEntries: [],
        existingEntries: [],
        trackedEntries: [],
        message: "No parent Git repository was detected for this workspace.",
      };
    }

    const excludeText = fs.existsSync(plan.excludeFilePath) ? fs.readFileSync(plan.excludeFilePath, "utf8") : "";
    const lineSet = new Set(
      excludeText
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    );
    const existingEntries = plan.entries.filter((entry) => lineSet.has(entry.pattern));
    const missingEntries = plan.entries.filter((entry) => !lineSet.has(entry.pattern));
    const trackedEntries = trackedWorkspaceGitExcludeEntries(plan);
    const status = missingEntries.length > 0 ? "missing" : trackedEntries.length > 0 ? "tracked" : "covered";
    return {
      ok: true,
      status,
      gitRootPath: plan.gitRootPath,
      gitDirPath: plan.gitDirPath,
      excludeFilePath: plan.excludeFilePath,
      workspaceRelativePath: plan.workspaceRelativePath,
      entries: plan.entries,
      missingEntries,
      existingEntries,
      trackedEntries,
      includeClaudeSettingsLocal,
      message:
        missingEntries.length > 0
          ? `${missingEntries.length} AMO Git exclude pattern(s) can be added.`
          : trackedEntries.length > 0
          ? `${trackedEntries.length} covered pattern(s) still match tracked Git files. Remove them from the index if they should disappear from status.`
          : "AMO local artifacts are already covered by Git exclude.",
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      gitRootPath: normalizeText(requestedGitRootPath) || "",
      gitDirPath: "",
      excludeFilePath: "",
      workspaceRelativePath: "",
      entries: [],
      missingEntries: [],
      existingEntries: [],
      trackedEntries: [],
      includeClaudeSettingsLocal,
      message: error?.message || "Could not inspect Git exclude.",
    };
  }
}

function resolveWorkspaceGitExcludePlan(workspacePath, requestedGitRootPath = "", options = {}) {
  const explicitRoot = normalizeText(requestedGitRootPath);
  const gitRootPath = explicitRoot
    ? resolveDirectoryPath(explicitRoot, "gitRootPath", "git_root_path")
    : findNearestGitRoot(workspacePath);

  if (!gitRootPath) {
    if (options.allowMissing) {
      return {
        gitRootPath: "",
        gitDirPath: "",
        excludeFilePath: "",
        workspaceRelativePath: "",
        entries: [],
      };
    }
    throw httpError(404, "git_root_not_found", "No parent Git repository was detected for this workspace.");
  }

  const gitDirPath = resolveGitDirectoryPath(gitRootPath);
  if (!gitDirPath) {
    throw httpError(400, "not_git_root", `Selected Git root does not contain a .git directory or gitdir file: ${gitRootPath}`);
  }

  if (!isSameOrDescendantPath(gitRootPath, workspacePath)) {
    throw httpError(
      400,
      "workspace_outside_git_root",
      `Workspace path must be inside the selected Git root. Git root: ${gitRootPath}; workspace: ${workspacePath}`
    );
  }

  const workspaceRelativePath = path.relative(gitRootPath, workspacePath).split(path.sep).join("/");
  return {
    gitRootPath,
    gitDirPath,
    excludeFilePath: path.join(gitDirPath, "info", "exclude"),
    workspaceRelativePath,
    entries: defaultWorkspaceGitExcludeEntries(workspaceRelativePath, Boolean(options.includeClaudeSettingsLocal)),
  };
}

function defaultWorkspaceGitExcludeEntries(workspaceRelativePath, includeClaudeSettingsLocal = false) {
  const prefix = normalizeGitExcludePrefix(workspaceRelativePath);
  const entries = [
    {
      pattern: gitExcludePattern(prefix, ".amo/"),
      reason: "AMO workspace metadata, vault, hooks, logs, and generated notes",
    },
    {
      pattern: gitExcludePattern(prefix, ".codex/cache/"),
      reason: "Codex hook fallback cache for prompts, replies, and hook errors",
    },
    {
      pattern: gitExcludePattern(prefix, ".codex/hooks.json"),
      reason: "project-local AMO Codex hook registration",
    },
  ];

  if (includeClaudeSettingsLocal) {
    entries.push({
      pattern: gitExcludePattern(prefix, ".claude/settings.local.json"),
      reason: "machine-local Claude hook registration",
    });
  }

  return entries;
}

function normalizeGitExcludePrefix(value) {
  return (normalizeText(value) || "")
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
}

function gitExcludePattern(prefix, relativePath) {
  const directoryPattern = /[\\/]$/u.test(String(relativePath || ""));
  const normalizedRelativePath = normalizeGitExcludePrefix(relativePath);
  const body = [prefix, normalizedRelativePath].filter(Boolean).join("/");
  return `/${body}${directoryPattern ? "/" : ""}`;
}

function trackedWorkspaceGitExcludeEntries(plan) {
  if (!plan?.gitRootPath || !Array.isArray(plan.entries) || plan.entries.length === 0) return [];

  const trackedEntries = [];
  for (const entry of plan.entries) {
    const repoRelativePath = gitExcludePatternToRepoPath(entry.pattern);
    if (!repoRelativePath) continue;

    const result = spawnSync("git", ["-C", plan.gitRootPath, "ls-files", "--", repoRelativePath], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) continue;

    const trackedPaths = (normalizeText(result.stdout) || "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (trackedPaths.length === 0) continue;

    trackedEntries.push({
      ...entry,
      trackedPath: trackedPaths[0],
      trackedPaths,
    });
  }

  return trackedEntries;
}

function gitExcludePatternToRepoPath(pattern) {
  return normalizeGitExcludePrefix(pattern);
}

function workspaceIdFor(workspacePath) {
  const digest = crypto.createHash("sha256").update(workspacePath.toLowerCase()).digest("hex").slice(0, 12);
  return `ws_${digest}`;
}

function baseUrl() {
  return `http://${HOST}:${PORT}`;
}

function ensureCanvas(canvasPath, metadata = {}) {
  const existingCanvas = fs.existsSync(canvasPath) ? readJsonFile(canvasPath, null) : null;
  const canvas =
    existingCanvas && typeof existingCanvas === "object" && !Array.isArray(existingCanvas)
      ? existingCanvas
      : { nodes: [], edges: [] };

  if (!Array.isArray(canvas.nodes)) canvas.nodes = [];
  if (!Array.isArray(canvas.edges)) canvas.edges = [];
  if (metadata.reset) {
    canvas.nodes = [];
    canvas.edges = [];
  }
  applyAmoCanvasMetadata(canvas, metadata);
  normalizeCanvasEdges(canvas);
  writeJsonFile(canvasPath, canvas);
}

function applyAmoCanvasMetadata(canvas, metadata = {}) {
  const existingAmo = canvas.amo && typeof canvas.amo === "object" && !Array.isArray(canvas.amo) ? canvas.amo : {};
  const existingDisplay =
    existingAmo.display && typeof existingAmo.display === "object" && !Array.isArray(existingAmo.display)
      ? existingAmo.display
      : {};
  const now = new Date().toISOString();

  canvas.amo = {
    ...existingAmo,
    schemaVersion: AMO_SCHEMA_VERSION,
    layoutVersion: AMO_LAYOUT_VERSION,
    canvasType: AMO_CANVAS_TYPE,
    canvasRole: "base-flow",
    managedBy: AMO_CANVAS_MANAGER,
    workspaceId: normalizeText(metadata.workspaceId || existingAmo.workspaceId),
    workspacePath: normalizeText(metadata.workspacePath || existingAmo.workspacePath),
    projectName: normalizeText(metadata.projectName || existingAmo.projectName),
    createdAt: normalizeText(existingAmo.createdAt || metadata.createdAt || now),
    updatedAt: normalizeText(metadata.updatedAt || now),
    display: {
      ...existingDisplay,
      labelMode: "short",
      hidePropertiesByDefault:
        typeof existingDisplay.hidePropertiesByDefault === "boolean" ? existingDisplay.hidePropertiesByDefault : true,
    },
  };
}

function normalizeCanvasEdges(canvas) {
  if (!canvas || !Array.isArray(canvas.edges)) return;

  for (const edge of canvas.edges) {
    if (!edge || typeof edge !== "object") continue;
    if (!edge.fromEnd) edge.fromEnd = "none";
    if (!edge.toEnd) edge.toEnd = "arrow";
  }
}

function installObsidianPlugin(vaultRoot, workspacePath) {
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", OBSIDIAN_PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });

  copyObsidianPluginAsset("manifest.json", pluginDir);
  copyObsidianPluginAsset("main.js", pluginDir);
  copyObsidianPluginAsset("styles.css", pluginDir);
  const pluginDataPath = path.join(pluginDir, "data.json");
  const existingPluginData = readJsonFile(pluginDataPath, {});
  writeJsonFile(path.join(pluginDir, "data.json"), {
    ...existingPluginData,
    bridgeUrl: baseUrl(),
    numberAnnotationsInPrompt: Boolean(existingPluginData.numberAnnotationsInPrompt),
    canvasAppendDirection: normalizeCanvasAppendDirection(existingPluginData.canvasAppendDirection),
    hideAmoNoteProperties: existingPluginData.hideAmoNoteProperties !== false,
    interceptLocalCodeLinks: existingPluginData.interceptLocalCodeLinks !== false,
    localCodeLinkEditor: normalizeLocalCodeLinkEditor(existingPluginData.localCodeLinkEditor),
    localCodeLinkUrlTemplate:
      normalizeText(existingPluginData.localCodeLinkUrlTemplate) || "vscode://file/{path}:{line}",
    zedCommand: normalizeText(existingPluginData.zedCommand) || "zed",
  });

  enableObsidianPlugin(vaultRoot, OBSIDIAN_PLUGIN_ID);

  return {
    installedFiles: [
      workspaceRelativePath(workspacePath, path.join(vaultRoot, ".obsidian", "community-plugins.json")),
      workspaceRelativePath(workspacePath, path.join(pluginDir, "manifest.json")),
      workspaceRelativePath(workspacePath, path.join(pluginDir, "main.js")),
      workspaceRelativePath(workspacePath, path.join(pluginDir, "styles.css")),
      workspaceRelativePath(workspacePath, path.join(pluginDir, "data.json")),
    ],
  };
}

function copyObsidianPluginAsset(fileName, pluginDir) {
  const sourcePath = path.join(__dirname, "assets", "obsidian", OBSIDIAN_PLUGIN_ID, fileName);
  if (!fs.existsSync(sourcePath)) {
    throw httpError(500, "missing_obsidian_plugin_asset", `Missing Obsidian plugin asset: ${sourcePath}`);
  }

  fs.copyFileSync(sourcePath, path.join(pluginDir, fileName));
}

function enableObsidianPlugin(vaultRoot, pluginId) {
  const communityPluginsPath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
  let enabledPlugins = [];
  if (fs.existsSync(communityPluginsPath)) {
    enabledPlugins = readJsonFileStrict(communityPluginsPath);
    if (!Array.isArray(enabledPlugins)) {
      throw httpError(409, "invalid_obsidian_plugin_config", `${communityPluginsPath} must be a JSON array`);
    }
  }

  if (!enabledPlugins.includes(pluginId)) {
    enabledPlugins.push(pluginId);
  }

  writeJsonFile(communityPluginsPath, enabledPlugins);
}

function mergeCodexHooks(workspacePath, hookScriptPath, amoRoot) {
  const codexDir = path.join(workspacePath, ".codex");
  const hookConfigPath = path.join(codexDir, "hooks.json");
  const command = `node "${hookScriptPath}"`;
  const hookEntry = {
    hooks: [
      {
        type: "command",
        command,
        timeout: 10,
        statusMessage: "AMO capture Codex lifecycle",
      },
    ],
  };

  fs.mkdirSync(codexDir, { recursive: true });

  const existed = fs.existsSync(hookConfigPath);
  const rawBefore = existed ? fs.readFileSync(hookConfigPath, "utf8") : "";
  const config = existed ? readJsonFileStrict(hookConfigPath) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw httpError(409, "invalid_codex_hooks", ".codex/hooks.json must be a JSON object");
  }

  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  for (const eventName of CODEX_HOOK_EVENTS) {
    if (!Array.isArray(config.hooks[eventName])) {
      config.hooks[eventName] = [];
    }
    if (!JSON.stringify(config.hooks[eventName]).includes("codex-stop-message.mjs")) {
      config.hooks[eventName].push(hookEntry);
    }
  }

  const nextRaw = `${JSON.stringify(config, null, 2)}\n`;
  if (rawBefore === nextRaw) {
    return { changed: false, backups: [] };
  }

  const backups = [];
  if (existed) {
    const backupName = `codex-hooks-${fileSafeTimestamp(new Date().toISOString())}.json`;
    const backupPath = path.join(amoRoot, "backups", backupName);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(hookConfigPath, backupPath);
    backups.push(path.join(".amo", "backups", backupName));
  }

  writeTextFile(hookConfigPath, nextRaw);
  return { changed: true, backups };
}

function mergeClaudeSettings(workspacePath, hookScriptPath, amoRoot) {
  const claudeDir = path.join(workspacePath, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  const command = `node "${hookScriptPath}"`;
  const hookEntry = {
    hooks: [
      {
        type: "command",
        command,
        timeout: 10,
      },
    ],
  };
  const permissionHookEntry = {
    matcher: "*",
    hooks: hookEntry.hooks,
  };

  fs.mkdirSync(claudeDir, { recursive: true });

  const existed = fs.existsSync(settingsPath);
  const rawBefore = existed ? fs.readFileSync(settingsPath, "utf8") : "";
  const config = existed ? readJsonFileStrict(settingsPath) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw httpError(409, "invalid_claude_settings", ".claude/settings.local.json must be a JSON object");
  }

  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  for (const eventName of CLAUDE_HOOK_EVENTS) {
    if (!Array.isArray(config.hooks[eventName])) {
      config.hooks[eventName] = [];
    }
  }

  if (!JSON.stringify(config.hooks.UserPromptSubmit).includes("claude-message.mjs")) {
    config.hooks.UserPromptSubmit.push(hookEntry);
  }
  if (!JSON.stringify(config.hooks.Stop).includes("claude-message.mjs")) {
    config.hooks.Stop.push(hookEntry);
  }
  if (!JSON.stringify(config.hooks.PermissionRequest).includes("claude-message.mjs")) {
    config.hooks.PermissionRequest.push(permissionHookEntry);
  }
  for (const eventName of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    if (!JSON.stringify(config.hooks[eventName]).includes("claude-message.mjs")) {
      config.hooks[eventName].push(permissionHookEntry);
    }
  }

  const nextRaw = `${JSON.stringify(config, null, 2)}\n`;
  if (rawBefore === nextRaw) {
    return { changed: false, backups: [] };
  }

  const backups = [];
  if (existed) {
    const backupName = `claude-settings-local-${fileSafeTimestamp(new Date().toISOString())}.json`;
    const backupPath = path.join(amoRoot, "backups", backupName);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(settingsPath, backupPath);
    backups.push(path.join(".amo", "backups", backupName));
  }

  writeTextFile(settingsPath, nextRaw);
  return { changed: true, backups };
}

function amoGitignore() {
  return [
    "state/",
    "logs/",
    "AMO - */Sessions/",
    "AMO - */Canvases/AgentFlow.base.canvas",
    "AMO - */Replies/",
    "AMO - */Prompts/",
    "AMO - */AgentFlow.canvas",
    "AMO - */.obsidian/workspace*.json",
    "",
  ].join("\n");
}

function findEnrolledWorkspace(value) {
  const rawPath = normalizeText(value);
  if (!rawPath) {
    throw httpError(400, "missing_workspace_path", "Reply payload must include cwd or workspacePath");
  }

  let current = path.resolve(rawPath);
  if (!fs.existsSync(current)) {
    throw httpError(404, "workspace_not_found", `Reply cwd/workspacePath does not exist: ${current}`);
  }

  if (!fs.statSync(current).isDirectory()) {
    current = path.dirname(current);
  }

  while (true) {
    if (fs.existsSync(path.join(current, AMO_DIR, "workspace.json"))) {
      return fs.realpathSync(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw httpError(400, "workspace_not_enrolled", "No .amo/workspace.json found for reply cwd/workspacePath");
    }
    current = parent;
  }
}

function resolvePromptWorkspace(payload, existing) {
  const directPath = normalizeText(
    payload.workspacePath || payload.workspace_path || payload.cwd || existing?.workspacePath || existing?.cwd
  );
  if (directPath) {
    return findEnrolledWorkspace(directPath);
  }

  const vaultRoot = normalizeText(payload.vaultRoot || payload.vault_root || existing?.vaultRoot);
  if (vaultRoot) {
    const resolvedVault = path.resolve(vaultRoot);
    const amoRoot = path.dirname(resolvedVault);
    const workspaceRoot = path.dirname(amoRoot);
    if (fs.existsSync(path.join(workspaceRoot, AMO_DIR, "workspace.json"))) {
      return fs.realpathSync(workspaceRoot);
    }
  }

  throw httpError(
    400,
    "workspace_not_enrolled",
    "Prompt payload must include cwd, workspacePath, or a session with workspace metadata"
  );
}

function writeReplyNote(amoRoot, vaultRoot, record) {
  const noteIdentity = nextConversationNoteIdentity(vaultRoot, record, "reply");
  const notePath = toVaultRelativePath(vaultRoot, noteIdentity.noteAbsolutePath);
  const noteMetadata = conversationNoteMetadata({
    record,
    noteIdentity,
    notePath,
    role: "assistant",
    kind: "reply",
  });
  const body = [
    renderAmoNoteMarker(noteMetadata),
    "",
    record.message,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  writeTextFile(noteIdentity.noteAbsolutePath, body);
  upsertConversationNoteIndex(amoRoot, noteMetadata);
  writeConversationSessionManifest(vaultRoot, record, noteMetadata);
  return { ...noteIdentity, ...noteMetadata, notePath };
}

function writePromptNote(amoRoot, vaultRoot, record) {
  const noteIdentity = nextConversationNoteIdentity(vaultRoot, record, "prompt");
  const notePath = toVaultRelativePath(vaultRoot, noteIdentity.noteAbsolutePath);
  const noteMetadata = conversationNoteMetadata({
    record,
    noteIdentity,
    notePath,
    role: "user",
    kind: "prompt",
  });
  const body = [
    renderAmoNoteMarker(noteMetadata),
    "",
    record.message,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  writeTextFile(noteIdentity.noteAbsolutePath, body);
  upsertConversationNoteIndex(amoRoot, noteMetadata);
  writeConversationSessionManifest(vaultRoot, record, noteMetadata);
  return { ...noteIdentity, ...noteMetadata, notePath };
}

function conversationNoteMetadata({ record, noteIdentity, notePath, role, kind }) {
  const displayTitle = normalizeNoteDisplayTitle(record.displayTitle || record.display_title);
  const noteId = `note_${crypto
    .createHash("sha1")
    .update(`${record.workspaceId}:${record.sessionId}:${record.turnId}:${kind}:${noteIdentity.sequence}:${record.capturedAt}`)
    .digest("hex")
    .slice(0, 16)}`;

  return {
    schemaVersion: AMO_SCHEMA_VERSION,
    noteId,
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath,
    notePath,
    tool: record.tool,
    role,
    kind,
    sequence: noteIdentity.sequence,
    displayName: noteIdentity.displayName,
    displayTitle,
    sessionId: record.sessionId,
    turnId: record.turnId,
    cwd: record.cwd,
    source: record.source,
    capturedAt: record.capturedAt,
    pendingPromptId: record.pendingPromptId || null,
    transcriptPath: record.transcriptPath || null,
    model: record.model || null,
    updatedAt: record.capturedAt,
  };
}

function renderAmoNoteMarker(metadata) {
  const marker = {
    schemaVersion: AMO_SCHEMA_VERSION,
    noteId: metadata.noteId,
    workspaceId: metadata.workspaceId,
    kind: metadata.kind,
    role: metadata.role,
    sequence: metadata.sequence,
    displayName: metadata.displayName,
    displayTitle: metadata.displayTitle,
    sessionId: metadata.sessionId,
    turnId: metadata.turnId,
    tool: metadata.tool,
  };
  const json = JSON.stringify(compactObject(marker)).replace(/--/g, "-\\u002d");
  return `<!-- amo: ${json} -->`;
}

function readConversationNoteIndex(amoRoot) {
  const indexPath = path.join(amoRoot, AMO_NOTE_INDEX_PATH);
  const index = readJsonFile(indexPath, null);
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    return { schemaVersion: AMO_SCHEMA_VERSION, notes: {}, byPath: {} };
  }
  if (!index.notes || typeof index.notes !== "object" || Array.isArray(index.notes)) {
    index.notes = {};
  }
  if (!index.byPath || typeof index.byPath !== "object" || Array.isArray(index.byPath)) {
    index.byPath = {};
  }
  index.schemaVersion = index.schemaVersion || AMO_SCHEMA_VERSION;
  return index;
}

function upsertConversationNoteIndex(amoRoot, metadata) {
  const noteId = normalizeText(metadata.noteId);
  const notePath = normalizeText(metadata.notePath);
  if (!noteId || !notePath) return null;

  const index = readConversationNoteIndex(amoRoot);
  const previous = index.notes[noteId] || {};
  const nextRecord = compactObject({
    ...previous,
    ...metadata,
    schemaVersion: AMO_SCHEMA_VERSION,
    noteId,
    notePath,
    updatedAt: normalizeText(metadata.updatedAt) || new Date().toISOString(),
  });
  index.notes[noteId] = nextRecord;
  index.byPath[notePath] = noteId;
  writeJsonFile(path.join(amoRoot, AMO_NOTE_INDEX_PATH), index);
  return nextRecord;
}

function updateCanvasNoteDisplayTitle(vaultRoot, { noteId, notePath, displayTitle, updatedAt }) {
  const canvasPath = path.join(vaultRoot, AMO_CANVAS_PATH);
  if (!fs.existsSync(canvasPath)) return false;

  const canvas = readJsonFile(canvasPath, null);
  if (!canvas || !Array.isArray(canvas.nodes)) return false;

  let changed = false;
  for (const node of canvas.nodes) {
    if (!node || node.type !== "file") continue;
    const nodeFile = normalizeText(node.file);
    const nodeNoteId = normalizeText(node.amo && node.amo.noteId);
    if (nodeFile !== notePath && (!noteId || nodeNoteId !== noteId)) continue;
    if (!node.amo || typeof node.amo !== "object" || Array.isArray(node.amo)) node.amo = {};
    node.amo.noteId = noteId || node.amo.noteId || null;
    if (displayTitle) {
      node.amo.displayTitle = displayTitle;
    } else {
      delete node.amo.displayTitle;
    }
    node.amo.updatedAt = updatedAt;
    changed = true;
  }

  if (changed) writeJsonFile(canvasPath, canvas);
  return changed;
}

function compactObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === null || item === undefined || item === "") continue;
    result[key] = item;
  }
  return result;
}

function vaultRelativePath(...parts) {
  return parts
    .flatMap((part) => String(part || "").split(/[\\/]+/u))
    .filter(Boolean)
    .join("/");
}

function vaultRelativeToAbsolutePath(vaultRoot, relativePath) {
  return path.join(vaultRoot, ...String(relativePath || "").split(/[\\/]+/u).filter(Boolean));
}

function conversationSessionFolderName(record) {
  return sanitizeFilePart(record?.sessionId || "unknown-session");
}

function conversationSessionRootPath(record) {
  return vaultRelativePath(AMO_SESSIONS_PATH, conversationSessionFolderName(record));
}

function conversationGeneratedNotesPath(record) {
  return vaultRelativePath(conversationSessionRootPath(record), AMO_SESSION_GENERATED_PATH);
}

function writeConversationSessionManifest(vaultRoot, record, noteMetadata) {
  const sessionRoot = conversationSessionRootPath(record);
  const manifestPath = vaultRelativePath(sessionRoot, "session.json");
  const manifestAbsolutePath = vaultRelativeToAbsolutePath(vaultRoot, manifestPath);
  const existing = readJsonFile(manifestAbsolutePath, null);
  const existingNotes = Array.isArray(existing?.notes) ? existing.notes : [];
  const nextNotes = existingNotes.filter((item) => normalizeText(item?.noteId) !== noteMetadata.noteId);
  nextNotes.push({
    noteId: noteMetadata.noteId,
    notePath: noteMetadata.notePath,
    kind: noteMetadata.kind,
    role: noteMetadata.role,
    sequence: noteMetadata.sequence,
    displayName: noteMetadata.displayName,
    turnId: noteMetadata.turnId,
    source: noteMetadata.source,
    capturedAt: noteMetadata.capturedAt,
  });

  writeJsonFile(manifestAbsolutePath, {
    schemaVersion: AMO_SCHEMA_VERSION,
    layoutVersion: AMO_LAYOUT_VERSION,
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath,
    sessionId: record.sessionId,
    tool: record.tool,
    cwd: record.cwd,
    generatedPath: conversationGeneratedNotesPath(record),
    baseCanvasPath: AMO_CANVAS_PATH,
    createdAt: normalizeText(existing?.createdAt) || record.capturedAt || new Date().toISOString(),
    updatedAt: record.capturedAt || new Date().toISOString(),
    notes: nextNotes,
  });
}

function nextConversationNoteIdentity(vaultRoot, record, kind) {
  const noteKind = kind === "prompt" ? "prompt" : "reply";
  const noteDir = vaultRelativeToAbsolutePath(vaultRoot, conversationGeneratedNotesPath(record));
  fs.mkdirSync(noteDir, { recursive: true });

  const sequence = nextConversationNoteSequence(noteDir);
  const displayName = conversationNoteDisplayName(sequence, noteKind, record);
  const noteAbsolutePath = path.join(noteDir, `${displayName}.md`);
  return {
    kind: noteKind,
    role: noteKind === "prompt" ? "user" : "assistant",
    sequence,
    displayName,
    noteAbsolutePath,
  };
}

function conversationNoteDisplayName(sequence, noteKind, record) {
  const baseName = `${formatConversationNoteSequence(sequence)} ${noteKind}`;
  const titleSuffix = conversationNoteTitleSuffix(record);
  return titleSuffix ? `${baseName} - ${titleSuffix}` : baseName;
}

function conversationNoteTitleSuffix(record) {
  const title = normalizeNoteDisplayTitle(record?.taskTitle || record?.displayTitle || record?.title);
  if (!title) return "";
  return sanitizeObsidianFileNamePart(title).slice(0, 60).trim();
}

function nextConversationNoteSequence(noteDir) {
  const orderedNoteNamePattern = /^(\d+) (prompt|reply)(?: - .+)?\.md$/iu;
  const legacyNoteNamePattern = /^(prompt|reply) (\d+)(?: - .+)?\.md$/iu;
  let maxSequence = 0;
  let generatedNoteCount = 0;

  for (const entry of fs.readdirSync(noteDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const orderedMatch = entry.name.match(orderedNoteNamePattern);
    const legacyMatch = entry.name.match(legacyNoteNamePattern);
    if (!orderedMatch && !legacyMatch) continue;

    generatedNoteCount += 1;
    const sequence = Number.parseInt(orderedMatch?.[1] || legacyMatch?.[2] || "", 10);
    if (Number.isSafeInteger(sequence) && sequence > maxSequence) {
      maxSequence = sequence;
    }
  }

  let nextSequence = Math.max(maxSequence, generatedNoteCount) + 1;
  while (
    fs.existsSync(path.join(noteDir, `${formatConversationNoteSequence(nextSequence)} prompt.md`)) ||
    fs.existsSync(path.join(noteDir, `${formatConversationNoteSequence(nextSequence)} reply.md`))
  ) {
    nextSequence += 1;
  }
  return nextSequence;
}

function formatConversationNoteSequence(sequence) {
  return String(sequence).padStart(3, "0");
}

function appendConversationNoteToCanvas(amoRoot, vaultRoot, record, note) {
  const canvasPath = AMO_CANVAS_PATH;
  const canvasAbsolutePath = path.join(vaultRoot, canvasPath);
  const bindingsPath = path.join(amoRoot, "state", "bindings.json");
  const appendDirection = readCanvasAppendDirection(vaultRoot);
  const canvas = fs.existsSync(canvasAbsolutePath)
    ? readJsonFileStrict(canvasAbsolutePath)
    : { nodes: [], edges: [] };
  if (!Array.isArray(canvas.nodes)) canvas.nodes = [];
  if (!Array.isArray(canvas.edges)) canvas.edges = [];
  applyAmoCanvasMetadata(canvas, {
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath || record.cwd,
    updatedAt: record.capturedAt,
  });
  normalizeCanvasEdges(canvas);

  const bindings = readJsonFile(bindingsPath, { schemaVersion: AMO_SCHEMA_VERSION, sessions: {} });
  if (!bindings.sessions || typeof bindings.sessions !== "object" || Array.isArray(bindings.sessions)) {
    bindings.sessions = {};
  }

  const existingBinding = bindings.sessions[record.sessionId] || {};
  const sessionNodes = canvas.nodes.filter((node) => {
    return node && node.amo && normalizeText(node.amo.sessionId) === record.sessionId;
  });
  const canvasSessionIds = new Set(
    canvas.nodes
      .map((node) => normalizeText(node && node.amo && node.amo.sessionId))
      .filter(Boolean)
  );
  const sessionIndex =
    Number.isSafeInteger(existingBinding.sessionIndex) && sessionNodes.length > 0
      ? existingBinding.sessionIndex
      : canvasSessionIds.size;
  let canvasNodeId = `amo-${crypto
    .createHash("sha1")
    .update(`${record.sessionId}:${record.turnId}:${record.capturedAt}`)
    .digest("hex")
    .slice(0, 12)}`;
  let suffix = 1;
  while (canvas.nodes.some((node) => node.id === canvasNodeId)) {
    suffix += 1;
    canvasNodeId = `${canvasNodeId}-${suffix}`;
  }

  const boundPreviousNode = existingBinding.lastCanvasNodeId
    ? canvas.nodes.find((node) => {
        return (
          node &&
          node.id === existingBinding.lastCanvasNodeId &&
          node.amo &&
          normalizeText(node.amo.sessionId) === record.sessionId
        );
      })
    : null;
  const previousNode = boundPreviousNode || sessionNodes[sessionNodes.length - 1] || null;
  const nodeCount = previousNode
    ? boundPreviousNode && Number.isSafeInteger(existingBinding.nodeCount)
      ? existingBinding.nodeCount
      : sessionNodes.length
    : sessionNodes.length;
  const nodePosition = nextConversationCanvasNodePosition({
    previousNode,
    direction: appendDirection,
    nodeCount,
    sessionIndex,
  });

  canvas.nodes.push({
    id: canvasNodeId,
    type: "file",
    file: note.notePath,
    x: nodePosition.x,
    y: nodePosition.y,
    width: REPLY_NODE_WIDTH,
    height: REPLY_NODE_HEIGHT,
    amo: {
      schemaVersion: AMO_SCHEMA_VERSION,
      noteId: note.noteId || null,
      kind: note.kind || (record.source === "obsidian-annotations" ? "prompt" : "reply"),
      role: note.role || null,
      sequence: Number.isSafeInteger(note.sequence) ? note.sequence : null,
      displayName: note.displayName || null,
      displayTitle: note.displayTitle || null,
      workspaceId: record.workspaceId,
      tool: record.tool,
      sessionId: record.sessionId,
      turnId: record.turnId,
      source: record.source,
      capturedAt: record.capturedAt,
    },
  });

  if (previousNode) {
    const edgeSides = canvasEdgeSidesForDirection(appendDirection);
    canvas.edges.push({
      id: `edge-${previousNode.id}-${canvasNodeId}`,
      fromNode: previousNode.id,
      fromSide: edgeSides.fromSide,
      fromEnd: "none",
      toNode: canvasNodeId,
      toSide: edgeSides.toSide,
      toEnd: "arrow",
    });
  }

  bindings.sessions[record.sessionId] = {
    sessionId: record.sessionId,
    workCanvasId: "base",
    canvasRole: "base-flow",
    canvasPath,
    lastCanvasNodeId: canvasNodeId,
    nodeCount: nodeCount + 1,
    sessionIndex,
    canvasAppendDirection: appendDirection,
    updatedAt: record.capturedAt,
  };

  writeJsonFile(canvasAbsolutePath, canvas);
  writeJsonFile(bindingsPath, bindings);

  return { canvasPath, canvasAbsolutePath, canvasNodeId };
}

function readCanvasAppendDirection(vaultRoot) {
  const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", OBSIDIAN_PLUGIN_ID, "data.json");
  const pluginData = readJsonFile(pluginDataPath, {});
  return normalizeCanvasAppendDirection(pluginData?.canvasAppendDirection);
}

function normalizeCanvasAppendDirection(value) {
  const direction = normalizeText(value);
  if (!direction) {
    return DEFAULT_CANVAS_APPEND_DIRECTION;
  }
  const normalized = direction.toLowerCase();
  return CANVAS_APPEND_DIRECTIONS.has(normalized) ? normalized : DEFAULT_CANVAS_APPEND_DIRECTION;
}

function normalizeLocalCodeLinkEditor(value) {
  const editor = normalizeText(value);
  return editor === "zed" || editor === "custom-url" ? editor : "vscode";
}

function nextConversationCanvasNodePosition({ previousNode, direction, nodeCount, sessionIndex }) {
  const fallback = initialConversationCanvasNodePosition(direction, nodeCount, sessionIndex);
  if (!previousNode) {
    return fallback;
  }

  const x = finiteCanvasNumber(previousNode.x, fallback.x);
  const y = finiteCanvasNumber(previousNode.y, fallback.y);
  const width = finiteCanvasNumber(previousNode.width, REPLY_NODE_WIDTH);
  const height = finiteCanvasNumber(previousNode.height, REPLY_NODE_HEIGHT);

  if (direction === "right") {
    return {
      x: x + width + CANVAS_NODE_MARGIN_X,
      y,
    };
  }

  return {
    x,
    y: y + height + CANVAS_NODE_MARGIN_Y,
  };
}

function initialConversationCanvasNodePosition(direction, nodeCount, sessionIndex) {
  if (direction === "right") {
    return {
      x: nodeCount * REPLY_NODE_GAP_X,
      y: sessionIndex * REPLY_NODE_GAP_Y,
    };
  }

  return {
    x: sessionIndex * REPLY_NODE_GAP_X,
    y: nodeCount * REPLY_NODE_GAP_Y,
  };
}

function canvasEdgeSidesForDirection(direction) {
  if (direction === "right") {
    return { fromSide: "right", toSide: "left" };
  }

  return { fromSide: "bottom", toSide: "top" };
}

function finiteCanvasNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function uniquePath(dir, stem, ext) {
  let candidate = path.join(dir, `${stem}${ext}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

function toVaultRelativePath(vaultRoot, absolutePath) {
  return path.relative(vaultRoot, absolutePath).split(path.sep).join("/");
}

function yamlString(value) {
  return JSON.stringify(value == null ? "" : String(value));
}

function normalizeNoteDisplayTitle(value) {
  return String(normalizeText(value) || "")
    .replace(/\s+/g, " ")
    .replace(/^#+\s*/u, "")
    .trim()
    .slice(0, 120);
}

function sanitizeFilePart(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function sanitizeObsidianFileNamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

function fileSafeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function trimMessage(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? text.slice(0, maxLength) : text;
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

function codexAppThreadUri(threadId) {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function resolveSessionTargetBinding({ payload, existing, sessionId, tool, cwd, boundAt, windowHint }) {
  const explicitTarget = normalizeTargetBinding(payload?.targetBinding || payload?.target_binding, sessionId, boundAt);
  if (explicitTarget) {
    return explicitTarget;
  }

  if (existing?.targetBinding) {
    return existing.targetBinding;
  }

  const windowTarget = targetBindingFromWindowHint(windowHint, boundAt);
  if (windowTarget) {
    return windowTarget;
  }

  return defaultHookTargetBinding({ payload, sessionId, tool, cwd, boundAt });
}

function defaultHookTargetBinding({ payload, sessionId, tool, cwd, boundAt }) {
  if (!sessionId || !isHookPayload(payload)) {
    return null;
  }

  const normalizedTool = (normalizeText(tool) || "").toLowerCase();
  if (normalizedTool.includes("codex")) {
    return normalizeTargetBinding(
      {
        type: "codex-cli-session",
        label: "Codex CLI",
        sessionId,
        workspacePath: normalizeText(payload.workspacePath || payload.workspace_path || payload.cwd) || cwd || null,
        boundAt,
        boundBy: "hook-default-target",
      },
      sessionId,
      boundAt
    );
  }

  return null;
}

function isHookPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const source = (normalizeText(payload.source) || "").toLowerCase();
  if (source.includes("hook")) {
    return true;
  }

  const hookEventName = (normalizeText(payload.hookEventName || payload.hook_event_name) || "").toLowerCase();
  return [
    "stop",
    "userpromptsubmit",
    "permissionrequest",
    "pretooluse",
    "posttooluse",
    "posttoolusefailure",
    "notification",
  ].includes(hookEventName);
}

function normalizeTargetBinding(value, sessionId, boundAt) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const rawType = normalizeText(value.type || value.targetType || value.target_type);
  if (!rawType) {
    return null;
  }

  const type = rawType.toLowerCase().replace(/[\s_]+/g, "-");
  const now = boundAt || normalizeText(value.boundAt || value.bound_at) || new Date().toISOString();

  if (type === "codex-app" || type === "codex-app-thread") {
    const threadId = normalizeText(value.threadId || value.thread_id || value.sessionId || value.session_id) || sessionId;
    if (!threadId) {
      return null;
    }

    const uri = normalizeText(value.uri) || codexAppThreadUri(threadId);
    if (!uri.startsWith("codex://threads/")) {
      throw httpError(400, "invalid_codex_app_uri", "Codex App target URI must start with codex://threads/");
    }

    return {
      type: "codex-app-thread",
      label: normalizeText(value.label) || "Codex App",
      threadId,
      uri,
      boundAt: now,
      boundBy: normalizeText(value.boundBy || value.bound_by) || "overlay-target-menu",
    };
  }

  if (type === "codex-cli" || type === "codex-cli-session") {
    const targetSessionId = normalizeText(value.sessionId || value.session_id || value.threadId || value.thread_id) || sessionId;
    if (!targetSessionId) {
      return null;
    }

    return {
      type: "codex-cli-session",
      label: normalizeText(value.label) || "Codex CLI",
      sessionId: targetSessionId,
      workspacePath: normalizeText(value.workspacePath || value.workspace_path || value.cwd) || null,
      boundAt: now,
      boundBy: normalizeText(value.boundBy || value.bound_by) || "overlay-target-menu",
    };
  }

  if (type === "window" || type === "cli-window") {
    const hwnd = normalizeInteger(value.hwnd || value.hWnd || value.windowHandle || value.window_handle);
    const processId = normalizeInteger(value.processId || value.process_id || value.pid);
    if (hwnd === null && processId === null) {
      throw httpError(400, "missing_window_identity", "Window target must include hwnd or processId");
    }

    const processName = normalizeText(value.processName || value.process_name || value.process);
    const title = normalizeText(value.title || value.windowTitle || value.window_title);
    const label = normalizeText(value.label) || title || processName || "Window";
    return {
      type: "window",
      label,
      hwnd,
      processId,
      processName: processName || null,
      title: title || null,
      boundAt: now,
      boundBy: normalizeText(value.boundBy || value.bound_by) || "overlay-target-menu",
    };
  }

  throw httpError(400, "unsupported_target_type", `Target type '${rawType}' is not supported`);
}

function targetBindingFromWindowHint(windowHint, boundAt) {
  if (!windowHint || (windowHint.hwnd === null && windowHint.pid === null)) {
    return null;
  }

  return {
    type: "window",
    label: windowHint.boundLabel || windowHint.title || windowHint.process || "Window",
    hwnd: windowHint.hwnd ?? null,
    processId: windowHint.pid ?? null,
    processName: windowHint.process || null,
    title: windowHint.title || null,
    boundAt: boundAt || windowHint.boundAt || new Date().toISOString(),
    boundBy: windowHint.boundBy || "overlay-candidate-menu",
  };
}

function windowHintFromWindowTarget(existing, targetBinding) {
  const baseHint = existing.windowHint || {};
  return {
    process: targetBinding.processName || baseHint.process || null,
    title: targetBinding.title || baseHint.title || existing.title || null,
    titleToken: baseHint.titleToken || null,
    titleContains: Array.isArray(baseHint.titleContains) ? baseHint.titleContains : [],
    project: baseHint.project || path.basename(existing.cwd || "") || null,
    cwd: baseHint.cwd || existing.cwd || null,
    tool: baseHint.tool || existing.tool || null,
    pid: targetBinding.processId ?? null,
    hwnd: targetBinding.hwnd ?? null,
    boundAt: targetBinding.boundAt || new Date().toISOString(),
    boundBy: targetBinding.boundBy || "overlay-target-menu",
    boundLabel: targetBinding.label || targetBinding.title || targetBinding.processName || null,
  };
}

function normalizeWindowHint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const processName = normalizeText(value.process || value.processName || value.process_name);
  const title = normalizeText(value.title || value.windowTitle || value.window_title);
  const titleToken = normalizeText(value.titleToken || value.title_token);
  const project = normalizeText(value.project);
  const cwd = normalizeText(value.cwd);
  const tool = normalizeText(value.tool);
  const titleContains = normalizeTextArray(
    value.titleContains || value.title_contains || value.titleIncludes || value.title_includes
  );
  const pid = normalizeInteger(value.pid || value.processId || value.process_id);
  const hwnd = normalizeInteger(value.hwnd || value.hWnd || value.windowHandle || value.window_handle);
  const boundAt = normalizeText(value.boundAt || value.bound_at);
  const boundBy = normalizeText(value.boundBy || value.bound_by);
  const boundLabel = normalizeText(value.boundLabel || value.bound_label || value.label);

  if (
    !processName &&
    !title &&
    !titleToken &&
    titleContains.length === 0 &&
    !project &&
    !cwd &&
    !tool &&
    pid === null &&
    hwnd === null &&
    !boundAt &&
    !boundBy &&
    !boundLabel
  ) {
    return null;
  }

  return {
    process: processName || null,
    title: title || null,
    titleToken: titleToken || null,
    titleContains,
    project: project || null,
    cwd: cwd || null,
    tool: tool || null,
    pid,
    hwnd,
    boundAt: boundAt || null,
    boundBy: boundBy || null,
    boundLabel: boundLabel || null,
  };
}

function normalizeAnnotations(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        const content = normalizeText(item);
        return content ? { index: index + 1, content } : null;
      }

      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const content = normalizeText(item.content || item.text || item.body || item.annotation);
      if (!content) {
        return null;
      }

      return {
        index: normalizeInteger(item.index) || index + 1,
        content,
      };
    })
    .filter(Boolean);
}

function renderPendingPrompt(payload, annotations, summary) {
  const lines = [];
  const cleanSummary = normalizeText(summary);
  if (cleanSummary) {
    lines.push(cleanSummary);
  }

  const numberAnnotations = shouldNumberAnnotations(payload);
  for (const annotation of annotations) {
    lines.push(numberAnnotations ? `${annotation.index}. ${annotation.content}` : annotation.content);
  }

  return `${lines.join("\n\n")}\n`;
}

function shouldNumberAnnotations(payload) {
  const options = payload && typeof payload.promptOptions === "object" ? payload.promptOptions : {};
  if (typeof options.numberAnnotations === "boolean") return options.numberAnnotations;
  if (typeof options.number_annotations === "boolean") return options.number_annotations;
  if (typeof payload?.numberAnnotations === "boolean") return payload.numberAnnotations;
  if (typeof payload?.number_annotations === "boolean") return payload.number_annotations;
  if (typeof payload?.includeAnnotationNumbers === "boolean") return payload.includeAnnotationNumbers;
  if (typeof payload?.include_annotation_numbers === "boolean") return payload.include_annotation_numbers;
  return false;
}

function promptContentHash(value) {
  return crypto.createHash("sha1").update(normalizeText(value)).digest("hex");
}

function findDuplicatePrompt(existing, record) {
  if (!existing || existing.lastPromptHash !== record.promptHash) {
    return null;
  }

  if (
    record.pendingPromptId &&
    existing.lastPromptPendingPromptId &&
    record.pendingPromptId === existing.lastPromptPendingPromptId
  ) {
    return {
      notePath: existing.lastPromptNote,
      noteAbsolutePath: existing.lastPromptNoteAbsolutePath,
      canvasNodeId: existing.lastPromptCanvasNodeId,
    };
  }

  const existingAt = Date.parse(existing.lastPromptAt || "");
  const nextAt = Date.parse(record.capturedAt || "");
  const closeEnough =
    Number.isFinite(existingAt) &&
    Number.isFinite(nextAt) &&
    Math.abs(nextAt - existingAt) <= PROMPT_DUPLICATE_WINDOW_MS;
  if (closeEnough && existing.lastPromptSource === "amo-sync-back" && record.source !== "amo-sync-back") {
    return {
      notePath: existing.lastPromptNote,
      noteAbsolutePath: existing.lastPromptNoteAbsolutePath,
      canvasNodeId: existing.lastPromptCanvasNodeId,
    };
  }

  return null;
}

function listSessions() {
  const healthCache = new Map();
  return Array.from(sessions.values()).map((session) => {
    const refreshedSession = refreshSessionTitle(session);
    if (refreshedSession !== session) {
      sessions.set(refreshedSession.sessionId, refreshedSession);
    }
    return attachObsidianPluginHealth(refreshedSession, healthCache);
  }).sort((a, b) => {
    return `${b.updatedAt}`.localeCompare(`${a.updatedAt}`);
  });
}

function attachObsidianPluginHealth(session, healthCache) {
  const vaultRoot = normalizeText(session.vaultRoot || session.pendingAnnotationSource?.vaultRoot);
  if (!vaultRoot) {
    return session;
  }

  const cacheKey = normalizeComparablePath(vaultRoot);
  if (!healthCache.has(cacheKey)) {
    healthCache.set(cacheKey, inspectObsidianPluginHealth(vaultRoot));
  }

  return {
    ...session,
    obsidianPluginHealth: healthCache.get(cacheKey),
  };
}

function inspectObsidianPluginHealth(vaultRoot) {
  const checkedAt = new Date().toISOString();
  const expectedBridgeUrl = baseUrl();
  const expectedVersion = expectedObsidianPluginVersion();
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", OBSIDIAN_PLUGIN_ID);
  const manifestPath = path.join(pluginDir, "manifest.json");
  const mainPath = path.join(pluginDir, "main.js");
  const dataPath = path.join(pluginDir, "data.json");
  const communityPluginsPath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
  const issues = [];

  const vaultExists = fs.existsSync(vaultRoot);
  const installed = fs.existsSync(pluginDir);
  const manifest = readJsonFile(manifestPath, null);
  const installedVersion = normalizeText(manifest?.version);
  const communityPlugins = readJsonFile(communityPluginsPath, null);
  const enabled = Array.isArray(communityPlugins) && communityPlugins.includes(OBSIDIAN_PLUGIN_ID);
  const pluginData = readJsonFile(dataPath, null);
  const dataBridgeUrl = normalizeText(pluginData?.bridgeUrl);
  const mainJsExists = fs.existsSync(mainPath);

  if (!vaultExists) issues.push("vault root is missing");
  if (!installed) issues.push("plugin directory is missing");
  if (!manifest) issues.push("manifest.json is missing or invalid");
  if (expectedVersion && installedVersion !== expectedVersion) {
    issues.push(`plugin version is ${installedVersion || "missing"}, expected ${expectedVersion}`);
  }
  if (!enabled) issues.push("plugin is not enabled in community-plugins.json");
  if (!mainJsExists) issues.push("main.js is missing");
  if (dataBridgeUrl !== expectedBridgeUrl) {
    issues.push(`bridge URL is ${dataBridgeUrl || "missing"}, expected ${expectedBridgeUrl}`);
  }

  const ok = issues.length === 0;
  const status = ok ? "ok" : installed ? "warning" : "missing";
  return {
    ok,
    status,
    pluginId: OBSIDIAN_PLUGIN_ID,
    vaultRoot,
    installed,
    enabled,
    expectedVersion: expectedVersion || null,
    installedVersion: installedVersion || null,
    expectedBridgeUrl,
    dataBridgeUrl: dataBridgeUrl || null,
    mainJsExists,
    issues,
    checkedAt,
  };
}

function expectedObsidianPluginVersion() {
  const manifest = readJsonFile(path.join(__dirname, "assets", "obsidian", OBSIDIAN_PLUGIN_ID, "manifest.json"), {});
  return normalizeText(manifest.version);
}

function loadSnapshot() {
  if (!fs.existsSync(DATA_FILE)) {
    return;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
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
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const snapshot = {
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    sessions: listSessions(),
  };
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  fs.renameSync(tmpFile, DATA_FILE);
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizeText).filter(Boolean);
}

function normalizeInteger(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}
