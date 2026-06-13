const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HOST = process.env.AGENT_MONITOR_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.AGENT_MONITOR_PORT || "17654", 10);
const DATA_FILE =
  process.env.AGENT_MONITOR_DATA_FILE ||
  path.join(__dirname, "data", "sessions.json");
const MAX_BODY_BYTES = 1024 * 1024;
const DEBUG_MAX_LOG_ENTRIES = 800;
const AMO_DIR = ".amo";
const AMO_SCHEMA_VERSION = 1;
const AMO_CANVAS_PATH = "AgentFlow.canvas";
const AMO_CANVAS_TYPE = "agent-flow";
const AMO_CANVAS_MANAGER = "agent-monitor-overlay";
const AMO_NOTE_INDEX_PATH = path.join("state", "note-index.json");
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
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

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
const debugState = {
  enabled: /^(1|true|yes|on)$/iu.test(process.env.AGENT_MONITOR_DEBUG || ""),
  maxEntries: DEBUG_MAX_LOG_ENTRIES,
  entries: [],
};

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
      debugState.entries = [];
      recordDebugLog("broker", "debug.clear", {}, { force: true });
      return sendJson(res, 200, debugStatus());
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return sendJson(res, 200, {
        count: sessions.size,
        sessions: listSessions(),
      });
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

function debugStatus(searchParams) {
  const limit = searchParams ? normalizeInteger(searchParams.get("limit")) : null;
  const normalizedLimit = limit && limit > 0 ? Math.min(limit, debugState.maxEntries) : debugState.entries.length;
  const entries =
    normalizedLimit >= debugState.entries.length
      ? debugState.entries
      : debugState.entries.slice(debugState.entries.length - normalizedLimit);

  return {
    ok: true,
    enabled: debugState.enabled,
    maxEntries: debugState.maxEntries,
    count: debugState.entries.length,
    entries,
  };
}

function updateDebugConfig(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Debug config payload must be a JSON object");
  }

  const previousEnabled = debugState.enabled;
  if (typeof payload.enabled === "boolean") {
    debugState.enabled = payload.enabled;
  }

  const maxEntries = normalizeInteger(payload.maxEntries || payload.max_entries);
  if (maxEntries && maxEntries >= 50 && maxEntries <= 5000) {
    debugState.maxEntries = maxEntries;
    trimDebugEntries();
  }

  recordDebugLog(
    "broker",
    "debug.config",
    {
      previousEnabled,
      enabled: debugState.enabled,
      maxEntries: debugState.maxEntries,
    },
    { force: true }
  );
  return debugStatus();
}

function handleDebugLog(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_json", "Debug log payload must be a JSON object");
  }

  const source = normalizeText(payload.source) || "unknown";
  const event = normalizeText(payload.event || payload.name || payload.message) || "log";
  const entry = recordDebugLog(source, event, payload.data || {}, {
    message: normalizeText(payload.message),
  });

  return {
    ok: true,
    enabled: debugState.enabled,
    recorded: Boolean(entry),
    count: debugState.entries.length,
    entry: entry || null,
  };
}

function recordDebugLog(source, event, data, options = {}) {
  if (!debugState.enabled && !options.force) {
    return null;
  }

  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    source: normalizeText(source) || "unknown",
    event: normalizeText(event) || "log",
    message: options.message || null,
    data: sanitizeDebugData(data),
  };

  debugState.entries.push(entry);
  trimDebugEntries();
  return entry;
}

function trimDebugEntries() {
  if (debugState.entries.length <= debugState.maxEntries) {
    return;
  }

  debugState.entries.splice(0, debugState.entries.length - debugState.maxEntries);
}

function sanitizeDebugData(value, depth = 0) {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (depth >= 5) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeDebugData(item, depth + 1));
  }

  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).slice(0, 60)) {
      result[key] = sanitizeDebugData(value[key], depth + 1);
    }
    return result;
  }

  return String(value);
}

function debugPreview(value, limit = 240) {
  const text = normalizeText(typeof value === "string" ? value : JSON.stringify(value || ""));
  if (!text) {
    return "";
  }

  return text.length > limit ? `${text.slice(0, limit)}...` : text;
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

  const session = {
    tool,
    sessionId,
    cwd: normalizeText(payload.cwd || payload.projectPath || payload.project_path) || existing?.cwd || null,
    title: normalizeText(payload.title) || existing?.title || defaultTitle(tool, sessionId),
    state,
    lastEvent: eventName || existing?.lastEvent || null,
    lastMessage: message || existing?.lastMessage || null,
    needsAttention:
      typeof payload.needsAttention === "boolean"
        ? payload.needsAttention
        : state === "waiting_permission" || state === "waiting_user",
    windowHint: normalizeWindowHint(payload.windowHint || payload.window_hint) || existing?.windowHint || null,
    updatedAt: normalizeText(payload.timestamp || payload.updatedAt || payload.updated_at) || now,
    createdAt: existing?.createdAt || now,
    heartbeatAt: existing?.heartbeatAt || null,
    eventCount: (existing?.eventCount || 0) + 1,
  };

  sessions.set(sessionId, session);
  const promptMessage = promptMessageFromEvent(payload, eventName, message);
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
  const session = {
    ...existing,
    cwd: normalizeText(payload.cwd) || existing.cwd,
    title: normalizeText(payload.title) || existing.title,
    state: nextState,
    lastMessage:
      normalizeText(payload.message || payload.lastMessage || payload.last_message) ||
      existing.lastMessage,
    needsAttention:
      typeof payload.needsAttention === "boolean"
        ? payload.needsAttention
        : nextState === "waiting_permission" || nextState === "waiting_user",
    windowHint: normalizeWindowHint(payload.windowHint || payload.window_hint) || existing.windowHint,
    heartbeatAt: now,
    updatedAt: now,
  };

  sessions.set(sessionId, session);
  return session;
}

function inspectWorkspace(payload) {
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const writable = isWritableDirectory(workspacePath);
  const workspaceId = workspaceIdFor(workspacePath);
  const projectName = path.basename(workspacePath);
  const amoRoot = path.join(workspacePath, AMO_DIR);
  const hasAmo = fs.existsSync(path.join(amoRoot, "workspace.json"));
  const hasCodexDir = fs.existsSync(path.join(workspacePath, ".codex"));
  const hasCodexHooks = fs.existsSync(path.join(workspacePath, ".codex", "hooks.json"));
  const hasClaudeDir = fs.existsSync(path.join(workspacePath, ".claude"));
  const hasClaudeLocalSettings = fs.existsSync(path.join(workspacePath, ".claude", "settings.local.json"));
  const hasClaudeProjectSettings = fs.existsSync(path.join(workspacePath, ".claude", "settings.json"));
  const rootIndicators = [".git", "package.json", "pyproject.toml", "Cargo.toml"].filter((name) => {
    return fs.existsSync(path.join(workspacePath, name));
  });

  const evidence = [];
  if (hasAmo) evidence.push("existing .amo workspace metadata found");
  if (hasCodexDir) evidence.push("existing .codex directory found");
  if (hasCodexHooks) evidence.push("existing .codex/hooks.json found and will be merged");
  if (hasClaudeDir) evidence.push("existing .claude directory found");
  if (hasClaudeLocalSettings) evidence.push("existing .claude/settings.local.json found and will be merged");
  if (hasClaudeProjectSettings) evidence.push("existing .claude/settings.json found");
  if (rootIndicators.length > 0) evidence.push(`project indicators: ${rootIndicators.join(", ")}`);
  if (writable) evidence.push("workspace is writable");

  const codexStatus = writable ? "available" : "blocked";
  const claudeStatus = writable ? "available" : "blocked";
  const codexConfidence = hasCodexDir || hasCodexHooks ? "high" : rootIndicators.length > 0 ? "medium" : "low";
  const claudeConfidence =
    hasClaudeDir || hasClaudeLocalSettings || hasClaudeProjectSettings ? "high" : rootIndicators.length > 0 ? "medium" : "low";
  const commonDirectoriesToCreate = [
    ".amo",
    ".amo/adapters",
    ".amo/hooks",
    ".amo/state",
    ".amo/logs",
    ".amo/backups",
    ".amo/obsidian-vault",
    ".amo/obsidian-vault/Replies",
    ".amo/obsidian-vault/Prompts",
    ".amo/obsidian-vault/.obsidian",
    ".amo/obsidian-vault/.obsidian/plugins",
    `.amo/obsidian-vault/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}`,
  ];
  const commonFilesToWrite = [
    ".amo/workspace.json",
    ".amo/enrollment.json",
    `.amo/obsidian-vault/${AMO_CANVAS_PATH}`,
    ".amo/obsidian-vault/.obsidian/community-plugins.json",
    `.amo/obsidian-vault/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/manifest.json`,
    `.amo/obsidian-vault/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/main.js`,
    `.amo/obsidian-vault/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/styles.css`,
    `.amo/obsidian-vault/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/data.json`,
    ".amo/.gitignore",
  ];

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId,
    workspacePath,
    projectName,
    existingEnrollment: hasAmo,
    deploymentRoot: AMO_DIR,
    supportedAdapters: [
      {
        id: "codex-cli",
        label: "Codex CLI",
        status: codexStatus,
        confidence: codexConfidence,
        scope: "project-local",
        reason: writable
          ? "Codex CLI can use a project-local Stop hook adapter in this workspace."
          : "Workspace is not writable.",
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
        confidence: claudeConfidence,
        scope: "project-local",
        reason: writable
          ? "Claude CLI can use project-local .claude/settings.local.json hooks for prompt/reply capture."
          : "Workspace is not writable.",
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
  const unavailablePlan = requestedPlans.find((plan) => !plan || plan.status !== "available");
  if (unavailablePlan) {
    throw httpError(
      400,
      "workspace_not_writable",
      `Workspace cannot be enrolled for ${unavailablePlan?.id || "requested adapter"} because it is not available.`
    );
  }

  const workspacePath = inspection.workspacePath;
  const now = new Date().toISOString();
  const amoRoot = path.join(workspacePath, AMO_DIR);
  const vaultRoot = path.join(amoRoot, "obsidian-vault");
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
  const existingWorkspace = readJsonFile(workspaceFile, null);
  writeJsonFile(workspaceFile, {
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: inspection.workspaceId,
    workspacePath,
    projectName: inspection.projectName,
    createdAt: existingWorkspace?.createdAt || now,
    updatedAt: now,
    amoRoot,
    vaultRoot,
    defaultCanvasPath: AMO_CANVAS_PATH,
    repliesPath: "Replies",
    promptsPath: "Prompts",
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
      installedAt: now,
      bridgeEventsUrl: `${baseUrl()}/api/events`,
      bridgeRepliesUrl: `${baseUrl()}/api/replies`,
      bridgePromptsUrl: `${baseUrl()}/api/prompts`,
      hookScriptPath,
      cacheFallbackPath: path.join(workspacePath, ".codex", "cache"),
    });
    installedFiles.push(".amo/adapters/codex-cli.json");

    writeTextFile(hookScriptPath, codexReplyHookScript());
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
      installedAt: now,
      bridgeEventsUrl: `${baseUrl()}/api/events`,
      bridgeRepliesUrl: `${baseUrl()}/api/replies`,
      bridgePromptsUrl: `${baseUrl()}/api/prompts`,
      hookScriptPath,
      cacheFallbackPath: path.join(amoRoot, "logs", "claude-cache"),
    });
    installedFiles.push(".amo/adapters/claude-cli.json");

    writeTextFile(hookScriptPath, claudeMessageHookScript());
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
  installedFiles.push(`.amo/obsidian-vault/${AMO_CANVAS_PATH}`);

  const pluginInstall = installObsidianPlugin(vaultRoot);
  installedFiles.push(...pluginInstall.installedFiles);

  writeJsonFile(path.join(amoRoot, "enrollment.json"), {
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: inspection.workspaceId,
    workspacePath,
    updatedAt: now,
    adapters: enrollmentAdapters,
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
  const vaultRoot = path.join(workspacePath, AMO_DIR, "obsidian-vault");
  const repliesPath = path.join(vaultRoot, "Replies");
  const promptsPath = path.join(vaultRoot, "Prompts");
  const canvasPath = path.join(vaultRoot, AMO_CANVAS_PATH);
  ensureInsideDirectory(vaultRoot, repliesPath);
  ensureInsideDirectory(vaultRoot, promptsPath);
  ensureInsideDirectory(vaultRoot, canvasPath);

  fs.rmSync(repliesPath, { recursive: true, force: true });
  fs.rmSync(promptsPath, { recursive: true, force: true });
  fs.mkdirSync(repliesPath, { recursive: true });
  fs.mkdirSync(promptsPath, { recursive: true });
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

  const vaultRoot = normalizeText(workspace.vaultRoot) || path.join(amoRoot, "obsidian-vault");
  const repliesPath = path.join(vaultRoot, "Replies");
  const promptsPath = path.join(vaultRoot, "Prompts");
  const canvasPath = path.join(vaultRoot, AMO_CANVAS_PATH);
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", OBSIDIAN_PLUGIN_ID);
  const canvasInfo = inspectCanvasFile(canvasPath);
  const pluginHealth = inspectObsidianPluginHealth(vaultRoot);
  const issues = [];

  if (!fs.existsSync(amoRoot)) issues.push(".amo directory is missing");
  if (!fs.existsSync(workspaceFile)) issues.push(".amo/workspace.json is missing");
  if (!fs.existsSync(vaultRoot)) issues.push("obsidian vault is missing");
  if (!fs.existsSync(repliesPath)) issues.push("Replies folder is missing");
  if (!fs.existsSync(promptsPath)) issues.push("Prompts folder is missing");
  if (!canvasInfo.exists) {
    issues.push("AgentFlow.canvas is missing");
  } else if (!canvasInfo.readable) {
    issues.push("AgentFlow.canvas is not valid JSON");
  } else if (!canvasInfo.amoManaged) {
    issues.push("AgentFlow.canvas is missing AMO managed marker");
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
      replies: repliesPath,
      prompts: promptsPath,
      canvas: canvasPath,
      plugin: pluginDir,
    },
    exists: {
      amoRoot: fs.existsSync(amoRoot),
      workspaceJson: fs.existsSync(workspaceFile),
      vaultRoot: fs.existsSync(vaultRoot),
      replies: fs.existsSync(repliesPath),
      prompts: fs.existsSync(promptsPath),
      canvas: canvasInfo.exists,
      plugin: fs.existsSync(pluginDir),
    },
    counts: {
      replyNotes: countFilesByExtension(repliesPath, ".md"),
      promptNotes: countFilesByExtension(promptsPath, ".md"),
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

function ensureInsideDirectory(root, target) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const rootWithSeparator = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(rootWithSeparator)) {
    throw httpError(400, "unsafe_path", `Refusing to clean path outside vault: ${normalizedTarget}`);
  }
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
  const record = {
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    workspacePath: workspaceRoot,
    tool,
    source,
    sessionId,
    turnId,
    cwd,
    model: normalizeText(payload.model),
    hookEventName,
    transcriptPath,
    capturedAt,
    message,
  };

  const vaultRoot = path.join(amoRoot, "obsidian-vault");
  const note = writeReplyNote(amoRoot, vaultRoot, record);
  const canvas = appendConversationNoteToCanvas(amoRoot, vaultRoot, record, note);

  const existing = sessions.get(sessionId);
  const session = {
    tool,
    sessionId,
    cwd,
    title: existing?.title || defaultTitle(tool, sessionId),
    state: "idle",
    lastEvent: hookEventName,
    lastMessage: trimMessage(message, 240),
    needsAttention: false,
    windowHint: normalizeWindowHint(payload.windowHint || payload.window_hint) || existing?.windowHint || null,
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
  };
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
  const promptHash = promptContentHash(message);
  const duplicate = findDuplicatePrompt(existing, {
    message,
    promptHash,
    pendingPromptId,
    source,
    capturedAt,
  });
  if (duplicate) {
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
      session: existing,
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
    model: normalizeText(payload.model),
    hookEventName,
    transcriptPath: normalizeText(payload.transcriptPath || payload.transcript_path),
    capturedAt,
    pendingPromptId: pendingPromptId || null,
    message,
  };

  const vaultRoot = path.join(amoRoot, "obsidian-vault");
  const note = writePromptNote(amoRoot, vaultRoot, record);
  const canvas = appendConversationNoteToCanvas(amoRoot, vaultRoot, record, note);

  const session = {
    ...(existing || {}),
    tool,
    sessionId,
    cwd,
    title: existing?.title || defaultTitle(tool, sessionId),
    state: normalizeState(payload.state) || "running",
    lastEvent: hookEventName,
    lastMessage: trimMessage(`User: ${message}`, 240),
    needsAttention: false,
    windowHint: normalizeWindowHint(payload.windowHint || payload.window_hint) || existing?.windowHint || null,
    updatedAt: capturedAt,
    createdAt: existing?.createdAt || now,
    heartbeatAt: existing?.heartbeatAt || null,
    eventCount: (existing?.eventCount || 0) + 1,
    workspaceId: workspace.workspaceId,
    workspacePath: workspaceRoot,
    vaultRoot,
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
  };
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
    title: defaultTitle("codex", sessionId),
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

  return {
    ok: true,
    vaultRoot,
    vaultId,
    registryPath,
    alreadyRegistered,
    changed: !alreadyRegistered,
  };
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
    lastMessage: "Pending prompt copied; paste it manually into the target CLI",
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
  const session = {
    ...existing,
    windowHint,
    lastEvent: "WindowBound",
    lastMessage: `Window bound to ${windowHint.boundLabel || "selected window"}`,
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
    label: windowHint.boundLabel,
  });
  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    sessionId,
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
    session,
  };
}

function deferredAdapter(id, label, reason) {
  return {
    id,
    label,
    status: "deferred",
    reason,
  };
}

function normalizeAdapterIds(value) {
  if (Array.isArray(value)) {
    const ids = value.map(normalizeText).filter(Boolean);
    return ids.length > 0 ? ids : ["codex-cli"];
  }

  const id = normalizeText(value);
  return id ? [id] : ["codex-cli"];
}

function resolveWorkspacePath(value) {
  const rawPath = normalizeText(value);
  if (!rawPath) {
    throw httpError(400, "missing_workspace_path", "Payload must include workspacePath");
  }

  const workspacePath = path.resolve(rawPath);
  let stat;
  try {
    stat = fs.statSync(workspacePath);
  } catch {
    throw httpError(404, "workspace_not_found", `Workspace path does not exist: ${workspacePath}`);
  }

  if (!stat.isDirectory()) {
    throw httpError(400, "workspace_not_directory", `Workspace path must be a directory: ${workspacePath}`);
  }

  return fs.realpathSync(workspacePath);
}

function isWritableDirectory(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function workspaceIdFor(workspacePath) {
  const digest = crypto.createHash("sha256").update(workspacePath.toLowerCase()).digest("hex").slice(0, 12);
  return `ws_${digest}`;
}

function baseUrl() {
  return `http://${HOST}:${PORT}`;
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(readJsonTextFile(filePath));
  } catch {
    return fallback;
  }
}

function readJsonFileStrict(filePath) {
  try {
    return JSON.parse(readJsonTextFile(filePath));
  } catch (error) {
    throw httpError(409, "invalid_existing_json", `${filePath} is not valid JSON: ${error.message}`);
  }
}

function readJsonTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
}

function writeJsonFile(filePath, payload) {
  writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, content, "utf8");
  fs.renameSync(tmpFile, filePath);
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
    canvasType: AMO_CANVAS_TYPE,
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

function installObsidianPlugin(vaultRoot) {
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
  });

  enableObsidianPlugin(vaultRoot, OBSIDIAN_PLUGIN_ID);

  return {
    installedFiles: [
      ".amo/obsidian-vault/.obsidian/community-plugins.json",
      `.amo/obsidian-vault/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/manifest.json`,
      `.amo/obsidian-vault/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/main.js`,
      `.amo/obsidian-vault/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/styles.css`,
      `.amo/obsidian-vault/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/data.json`,
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
        statusMessage: "AMO capture Codex prompt/reply",
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
  if (!Array.isArray(config.hooks.Stop)) {
    config.hooks.Stop = [];
  }
  if (!Array.isArray(config.hooks.UserPromptSubmit)) {
    config.hooks.UserPromptSubmit = [];
  }
  if (!Array.isArray(config.hooks.PermissionRequest)) {
    config.hooks.PermissionRequest = [];
  }

  const alreadyInstalled = JSON.stringify(config.hooks.Stop).includes("codex-stop-message.mjs");
  if (!alreadyInstalled) {
    config.hooks.Stop.push(hookEntry);
  }
  const promptAlreadyInstalled = JSON.stringify(config.hooks.UserPromptSubmit).includes("codex-stop-message.mjs");
  if (!promptAlreadyInstalled) {
    config.hooks.UserPromptSubmit.push(hookEntry);
  }
  const permissionAlreadyInstalled = JSON.stringify(config.hooks.PermissionRequest).includes("codex-stop-message.mjs");
  if (!permissionAlreadyInstalled) {
    config.hooks.PermissionRequest.push(hookEntry);
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
  for (const eventName of ["UserPromptSubmit", "Stop", "PermissionRequest"]) {
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

function codexReplyHookScript() {
  return [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "",
    "const __filename = fileURLToPath(import.meta.url);",
    "const __dirname = path.dirname(__filename);",
    "const amoRoot = path.resolve(__dirname, '..');",
    "const projectRoot = path.resolve(amoRoot, '..');",
    "const adapterConfigFile = path.join(amoRoot, 'adapters', 'codex-cli.json');",
    "const cacheRoot = path.join(projectRoot, '.codex', 'cache');",
    "const assistantArchiveRoot = path.join(cacheRoot, 'assistant-turns');",
    "const userArchiveRoot = path.join(cacheRoot, 'user-prompts');",
    "const latestAssistantFile = path.join(cacheRoot, 'latest-assistant-message.md');",
    "const latestAssistantJsonFile = path.join(cacheRoot, 'latest-assistant-message.json');",
    "const latestUserPromptFile = path.join(cacheRoot, 'latest-user-prompt.md');",
    "const latestUserPromptJsonFile = path.join(cacheRoot, 'latest-user-prompt.json');",
    "const errorLogFile = path.join(cacheRoot, 'assistant-turn-errors.log');",
    "",
    "try {",
    "  const rawInput = await readStdin();",
    "  const inputText = rawInput.replace(/^\\uFEFF/u, '');",
    "  const payload = inputText.trim().length > 0 ? JSON.parse(inputText) : {};",
    "  const eventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'unknown';",
    "  const lowerEventName = eventName.toLowerCase();",
    "  const isPromptEvent = lowerEventName === 'userpromptsubmit';",
    "  const isReplyEvent = lowerEventName === 'stop';",
    "  const isEventOnly = !isPromptEvent && !isReplyEvent;",
    "  const message = normalizeMessage(",
    "    isPromptEvent",
    "      ? payload.prompt ?? payload.message",
    "      : isReplyEvent",
    "        ? payload.last_assistant_message",
    "        : payload.message ?? payload.reason ?? payload.title ?? payload.error ?? payload.tool_name ?? eventName",
    "  );",
    "",
    "  if (message || isEventOnly) {",
    "    const capturedAt = new Date().toISOString();",
    "    const record = {",
    "      schemaVersion: 1,",
    "      tool: 'codex',",
    "      role: isPromptEvent ? 'user' : isReplyEvent ? 'assistant' : 'event',",
    "      source: isPromptEvent ? 'codex-user-prompt-hook' : isReplyEvent ? 'codex-stop-hook' : 'codex-event-hook',",
    "      capturedAt,",
    "      sessionId: typeof payload.session_id === 'string' ? payload.session_id : 'unknown-session',",
    "      turnId: typeof payload.turn_id === 'string' ? payload.turn_id : 'unknown-turn',",
    "      model: typeof payload.model === 'string' ? payload.model : null,",
    "      hookEventName: eventName,",
    "      cwd: typeof payload.cwd === 'string' ? payload.cwd : projectRoot,",
    "      transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : null,",
    "      stopHookActive: Boolean(payload.stop_hook_active),",
    "      message,",
    "    };",
    "",
    "    if (!isEventOnly) {",
    "      const archiveRoot = isPromptEvent ? userArchiveRoot : assistantArchiveRoot;",
    "      const latestFile = isPromptEvent ? latestUserPromptFile : latestAssistantFile;",
    "      const latestJsonFile = isPromptEvent ? latestUserPromptJsonFile : latestAssistantJsonFile;",
    "      const archiveStem = `${fileSafeTimestamp(capturedAt)}-${sanitizeFilePart(record.turnId)}`;",
    "      await fs.mkdir(archiveRoot, { recursive: true });",
    "      await Promise.all([",
    "        fs.writeFile(path.join(archiveRoot, `${archiveStem}.md`), renderMarkdown(record), 'utf8'),",
    "        fs.writeFile(path.join(archiveRoot, `${archiveStem}.json`), `${JSON.stringify(record, null, 2)}\\n`, 'utf8'),",
    "        fs.writeFile(latestFile, renderMarkdown(record), 'utf8'),",
    "        fs.writeFile(latestJsonFile, `${JSON.stringify(record, null, 2)}\\n`, 'utf8'),",
    "      ]);",
    "    }",
    "    await postToBridge(record, isPromptEvent, isEventOnly);",
    "  }",
    "",
    "  process.stdout.write('{\"continue\":true}\\n');",
    "} catch (error) {",
    "  await fs.mkdir(cacheRoot, { recursive: true });",
    "  const errorText = error instanceof Error ? `${error.stack ?? error.message}` : String(error);",
    "  await fs.appendFile(errorLogFile, `[${new Date().toISOString()}] ${errorText}\\n`, 'utf8');",
    "  process.stdout.write('{\"continue\":true}\\n');",
    "}",
    "",
    "function readStdin() {",
    "  return new Promise((resolve, reject) => {",
    "    let data = '';",
    "    process.stdin.setEncoding('utf8');",
    "    process.stdin.on('data', (chunk) => { data += chunk; });",
    "    process.stdin.on('end', () => resolve(data));",
    "    process.stdin.on('error', reject);",
    "  });",
    "}",
    "",
    "async function postToBridge(record, isPromptEvent, isEventOnly) {",
    "  try {",
    "    const config = JSON.parse(await fs.readFile(adapterConfigFile, 'utf8'));",
    "    let url = null;",
    "    if (isEventOnly && typeof config.bridgeEventsUrl === 'string') url = config.bridgeEventsUrl;",
    "    if (!url && isPromptEvent && typeof config.bridgePromptsUrl === 'string') url = config.bridgePromptsUrl;",
    "    if (!url && !isPromptEvent && !isEventOnly && typeof config.bridgeRepliesUrl === 'string') url = config.bridgeRepliesUrl;",
    "    if (!url && isPromptEvent && typeof config.bridgeRepliesUrl === 'string') url = config.bridgeRepliesUrl.replace(/\\/api\\/replies$/u, '/api/prompts');",
    "    if (!url && isEventOnly && typeof config.bridgeRepliesUrl === 'string') url = config.bridgeRepliesUrl.replace(/\\/api\\/replies$/u, '/api/events');",
    "    if (!url || typeof fetch !== 'function') return;",
    "    const controller = new AbortController();",
    "    const timeout = setTimeout(() => controller.abort(), 2000);",
    "    try {",
    "      await fetch(url, {",
    "        method: 'POST',",
    "        headers: { 'content-type': 'application/json' },",
    "        body: JSON.stringify(record),",
    "        signal: controller.signal,",
    "      });",
    "    } finally {",
    "      clearTimeout(timeout);",
    "    }",
    "  } catch {",
    "    // Bridge delivery is best-effort; the local cache above is the fallback.",
    "  }",
    "}",
    "",
    "function normalizeMessage(value) {",
    "  return typeof value === 'string' ? value.replace(/\\r\\n?/g, '\\n').trim() : '';",
    "}",
    "",
    "function fileSafeTimestamp(value) {",
    "  return value.replace(/[:.]/g, '-');",
    "}",
    "",
    "function sanitizeFilePart(value) {",
    "  return String(value || 'turn').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'turn';",
    "}",
    "",
  "function renderMarkdown(record) {",
  "  const lines = [",
  "    `- captured_at: ${record.capturedAt}`,",
    "    `- session_id: ${record.sessionId}`,",
    "    `- turn_id: ${record.turnId}`,",
    "    `- model: ${record.model ?? 'unknown-model'}`,",
    "    `- hook_event_name: ${record.hookEventName}`,",
    "    `- role: ${record.role}`,",
    "    `- stop_hook_active: ${record.stopHookActive}`,",
    "  ];",
    "  if (record.cwd) lines.push(`- cwd: ${record.cwd}`);",
    "  if (record.transcriptPath) lines.push(`- transcript_path: ${record.transcriptPath}`);",
    "  lines.push('', '---', '', record.message, '');",
    "  return lines.join('\\n');",
    "}",
    "",
  ].join("\n");
}

function claudeMessageHookScript() {
  return [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "",
    "const __filename = fileURLToPath(import.meta.url);",
    "const __dirname = path.dirname(__filename);",
    "const amoRoot = path.resolve(__dirname, '..');",
    "const projectRoot = path.resolve(amoRoot, '..');",
    "const adapterConfigFile = path.join(amoRoot, 'adapters', 'claude-cli.json');",
    "const cacheRoot = path.join(amoRoot, 'logs', 'claude-cache');",
    "const assistantArchiveRoot = path.join(cacheRoot, 'assistant-turns');",
    "const userArchiveRoot = path.join(cacheRoot, 'user-prompts');",
    "const latestAssistantFile = path.join(cacheRoot, 'latest-assistant-message.md');",
    "const latestAssistantJsonFile = path.join(cacheRoot, 'latest-assistant-message.json');",
    "const latestUserPromptFile = path.join(cacheRoot, 'latest-user-prompt.md');",
    "const latestUserPromptJsonFile = path.join(cacheRoot, 'latest-user-prompt.json');",
    "const errorLogFile = path.join(cacheRoot, 'claude-hook-errors.log');",
    "",
    "try {",
    "  const rawInput = await readStdin();",
    "  const inputText = rawInput.replace(/^\\uFEFF/u, '');",
    "  const payload = inputText.trim().length > 0 ? JSON.parse(inputText) : {};",
    "  const eventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'unknown';",
    "  const lowerEventName = eventName.toLowerCase();",
    "  const isPromptEvent = lowerEventName === 'userpromptsubmit';",
    "  const isReplyEvent = lowerEventName === 'stop';",
    "  const isEventOnly = !isPromptEvent && !isReplyEvent;",
    "  const message = normalizeMessage(",
    "    isPromptEvent",
    "      ? payload.prompt ?? payload.message",
    "      : isReplyEvent",
    "        ? payload.last_assistant_message",
    "        : fallbackEventMessage(payload, eventName)",
    "  );",
    "",
    "  if (message || isEventOnly) {",
    "    const capturedAt = new Date().toISOString();",
    "    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : projectRoot;",
    "    const turnId = typeof payload.turn_id === 'string' && payload.turn_id",
    "      ? payload.turn_id",
    "      : `${lowerEventName || 'event'}-${fileSafeTimestamp(capturedAt)}`;",
    "    const record = {",
    "      schemaVersion: 1,",
    "      tool: 'claude',",
    "      role: isPromptEvent ? 'user' : isReplyEvent ? 'assistant' : 'event',",
    "      source: isPromptEvent ? 'claude-user-prompt-hook' : isReplyEvent ? 'claude-stop-hook' : 'claude-event-hook',",
    "      capturedAt,",
    "      sessionId: typeof payload.session_id === 'string' ? payload.session_id : 'unknown-session',",
    "      turnId,",
    "      model: typeof payload.model === 'string' ? payload.model : null,",
    "      hookEventName: eventName,",
    "      cwd,",
    "      transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : null,",
    "      permissionMode: typeof payload.permission_mode === 'string' ? payload.permission_mode : null,",
    "      stopHookActive: Boolean(payload.stop_hook_active),",
    "      message,",
    "      windowHint: buildWindowHint(cwd, turnId),",
    "    };",
    "",
    "    if (!isEventOnly) {",
    "      const archiveRoot = isPromptEvent ? userArchiveRoot : assistantArchiveRoot;",
    "      const latestFile = isPromptEvent ? latestUserPromptFile : latestAssistantFile;",
    "      const latestJsonFile = isPromptEvent ? latestUserPromptJsonFile : latestAssistantJsonFile;",
    "      const archiveStem = `${fileSafeTimestamp(capturedAt)}-${sanitizeFilePart(record.turnId)}`;",
    "      await fs.mkdir(archiveRoot, { recursive: true });",
    "      await Promise.all([",
    "        fs.writeFile(path.join(archiveRoot, `${archiveStem}.md`), renderMarkdown(record), 'utf8'),",
    "        fs.writeFile(path.join(archiveRoot, `${archiveStem}.json`), `${JSON.stringify(record, null, 2)}\\n`, 'utf8'),",
    "        fs.writeFile(latestFile, renderMarkdown(record), 'utf8'),",
    "        fs.writeFile(latestJsonFile, `${JSON.stringify(record, null, 2)}\\n`, 'utf8'),",
    "      ]);",
    "    }",
    "    await postToBridge(record, isPromptEvent, isEventOnly);",
    "  }",
    "",
    "  process.stdout.write('{\"continue\":true,\"suppressOutput\":true}\\n');",
    "} catch (error) {",
    "  await fs.mkdir(cacheRoot, { recursive: true });",
    "  const errorText = error instanceof Error ? `${error.stack ?? error.message}` : String(error);",
    "  await fs.appendFile(errorLogFile, `[${new Date().toISOString()}] ${errorText}\\n`, 'utf8');",
    "  process.stdout.write('{\"continue\":true,\"suppressOutput\":true}\\n');",
    "}",
    "",
    "function readStdin() {",
    "  return new Promise((resolve, reject) => {",
    "    let data = '';",
    "    process.stdin.setEncoding('utf8');",
    "    process.stdin.on('data', (chunk) => { data += chunk; });",
    "    process.stdin.on('end', () => resolve(data));",
    "    process.stdin.on('error', reject);",
    "  });",
    "}",
    "",
    "async function postToBridge(record, isPromptEvent, isEventOnly) {",
    "  try {",
    "    const config = JSON.parse(await fs.readFile(adapterConfigFile, 'utf8'));",
    "    let url = null;",
    "    if (isEventOnly && typeof config.bridgeEventsUrl === 'string') url = config.bridgeEventsUrl;",
    "    if (!url && isPromptEvent && typeof config.bridgePromptsUrl === 'string') url = config.bridgePromptsUrl;",
    "    if (!url && !isPromptEvent && !isEventOnly && typeof config.bridgeRepliesUrl === 'string') url = config.bridgeRepliesUrl;",
    "    if (!url && isPromptEvent && typeof config.bridgeRepliesUrl === 'string') url = config.bridgeRepliesUrl.replace(/\\/api\\/replies$/u, '/api/prompts');",
    "    if (!url && isEventOnly && typeof config.bridgeRepliesUrl === 'string') url = config.bridgeRepliesUrl.replace(/\\/api\\/replies$/u, '/api/events');",
    "    if (!url || typeof fetch !== 'function') return;",
    "    const controller = new AbortController();",
    "    const timeout = setTimeout(() => controller.abort(), 2000);",
    "    try {",
    "      await fetch(url, {",
    "        method: 'POST',",
    "        headers: { 'content-type': 'application/json' },",
    "        body: JSON.stringify(record),",
    "        signal: controller.signal,",
    "      });",
    "    } finally {",
    "      clearTimeout(timeout);",
    "    }",
    "  } catch {",
    "    // Bridge delivery is best-effort; the local cache above is the fallback.",
    "  }",
    "}",
    "",
    "function fallbackEventMessage(payload, eventName) {",
    "  if (typeof payload.message === 'string') return payload.message;",
    "  if (typeof payload.title === 'string') return payload.title;",
    "  if (typeof payload.error === 'string') return payload.error;",
    "  if (typeof payload.reason === 'string') return payload.reason;",
    "  if (typeof payload.tool_name === 'string') {",
    "    const description = payload.tool_input && typeof payload.tool_input.description === 'string' ? payload.tool_input.description : '';",
    "    return description ? `${payload.tool_name}: ${description}` : payload.tool_name;",
    "  }",
    "  if (typeof payload.notification_type === 'string') return payload.notification_type;",
    "  return eventName;",
    "}",
    "",
    "function buildWindowHint(cwd, turnId) {",
    "  const projectName = path.basename(cwd || projectRoot);",
    "  const projectSlug = sanitizeFilePart(projectName).toLowerCase();",
    "  const sessionSlug = sanitizeFilePart(turnId).toLowerCase();",
    "  return {",
    "    process: 'WindowsTerminal.exe',",
    "    titleToken: `[AMO:claude:${projectSlug}:${sessionSlug}]`,",
    "    titleContains: ['Claude', projectName],",
    "    project: projectName,",
    "    cwd,",
    "    tool: 'claude',",
    "  };",
    "}",
    "",
    "function normalizeMessage(value) {",
    "  return typeof value === 'string' ? value.replace(/\\r\\n?/g, '\\n').trim() : '';",
    "}",
    "",
    "function fileSafeTimestamp(value) {",
    "  return String(value || new Date().toISOString()).replace(/[:.]/g, '-');",
    "}",
    "",
    "function sanitizeFilePart(value) {",
    "  return String(value || 'turn').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'turn';",
    "}",
    "",
    "function renderMarkdown(record) {",
    "  const lines = [",
    "    `- captured_at: ${record.capturedAt}`,",
    "    `- session_id: ${record.sessionId}`,",
    "    `- turn_id: ${record.turnId}`,",
    "    `- model: ${record.model ?? 'unknown-model'}`,",
    "    `- hook_event_name: ${record.hookEventName}`,",
    "    `- role: ${record.role}`,",
    "    `- stop_hook_active: ${record.stopHookActive}`,",
    "  ];",
    "  if (record.cwd) lines.push(`- cwd: ${record.cwd}`);",
    "  if (record.transcriptPath) lines.push(`- transcript_path: ${record.transcriptPath}`);",
    "  lines.push('', '---', '', record.message, '');",
    "  return lines.join('\\n');",
    "}",
    "",
  ].join("\n");
}

function amoGitignore() {
  return [
    "state/",
    "logs/",
    "obsidian-vault/Replies/",
    "obsidian-vault/Prompts/",
    "obsidian-vault/AgentFlow.canvas",
    "obsidian-vault/.obsidian/workspace*.json",
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
  const noteIdentity = nextConversationNoteIdentity(vaultRoot, "reply");
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
  return { ...noteIdentity, ...noteMetadata, notePath };
}

function writePromptNote(amoRoot, vaultRoot, record) {
  const noteIdentity = nextConversationNoteIdentity(vaultRoot, "prompt");
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

function nextConversationNoteIdentity(vaultRoot, kind) {
  const noteKind = kind === "prompt" ? "prompt" : "reply";
  const directoryName = noteKind === "prompt" ? "Prompts" : "Replies";
  const noteDir = path.join(vaultRoot, directoryName);
  fs.mkdirSync(noteDir, { recursive: true });

  const sequence = nextConversationNoteSequence(noteDir, noteKind);
  const displayName = `${noteKind} ${formatConversationNoteSequence(sequence)}`;
  const noteAbsolutePath = path.join(noteDir, `${displayName}.md`);
  return {
    kind: noteKind,
    role: noteKind === "prompt" ? "user" : "assistant",
    sequence,
    displayName,
    noteAbsolutePath,
  };
}

function nextConversationNoteSequence(noteDir, kind) {
  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const noteNamePattern = new RegExp(`^${escapedKind} (\\d+)\\.md$`, "iu");
  let maxSequence = 0;

  for (const entry of fs.readdirSync(noteDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(noteNamePattern);
    if (!match) continue;
    const sequence = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(sequence) && sequence > maxSequence) {
      maxSequence = sequence;
    }
  }

  let nextSequence = maxSequence + 1;
  while (fs.existsSync(path.join(noteDir, `${kind} ${formatConversationNoteSequence(nextSequence)}.md`))) {
    nextSequence += 1;
  }
  return nextSequence;
}

function formatConversationNoteSequence(sequence) {
  return String(sequence).padStart(2, "0");
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
    workspacePath: record.cwd,
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
    workCanvasId: "default",
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

  if (combined.includes("permission") || combined.includes("approval")) {
    return "waiting_permission";
  }
  if (combined.includes("waiting_user") || combined.includes("user_prompt") || combined.includes("input")) {
    return "waiting_user";
  }
  if (combined.includes("fail") || combined.includes("error")) {
    return "failed";
  }
  if (combined.includes("cancel")) {
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

  if (
    !processName &&
    !title &&
    !titleToken &&
    titleContains.length === 0 &&
    !project &&
    !cwd &&
    !tool &&
    pid === null &&
    hwnd === null
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
    return attachObsidianPluginHealth(session, healthCache);
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
        sessions.set(session.sessionId, session);
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

function readJsonBody(req, options = {}) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(httpError(413, "body_too_large", "Request body is too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw && options.allowEmpty) {
        resolve({});
        return;
      }
      if (!raw) {
        reject(httpError(400, "empty_body", "Request body must be JSON"));
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(httpError(400, "invalid_json", `Invalid JSON: ${error.message}`));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendEmpty(res, statusCode) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "cache-control": "no-store",
    "content-length": "0",
  });
  res.end();
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
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

function defaultTitle(tool, sessionId) {
  return `${tool} - ${sessionId}`;
}
