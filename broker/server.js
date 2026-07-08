const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AMO_CANVAS_MANAGER,
  AMO_CANVAS_PATH,
  AMO_CANVAS_TYPE,
  AMO_CANVASES_PATH,
  AMO_DIR,
  AMO_NOTE_INDEX_PATH,
  AMO_SCHEMA_VERSION,
  AMO_SESSION_GENERATED_PATH,
  AMO_SESSIONS_PATH,
  AMO_WORK_CANVASES_PATH,
  CANVAS_NODE_MARGIN_X,
  CANVAS_NODE_MARGIN_Y,
  OBSIDIAN_PLUGIN_ID,
  REPLY_NODE_GAP_X,
  REPLY_NODE_GAP_Y,
  REPLY_NODE_HEIGHT,
  REPLY_NODE_WIDTH,
} = require("./lib/amo-constants");
const { appendConversationNoteToCanvas, ensureCanvas, updateCanvasNoteDisplayTitle } = require("./lib/canvas-writer");
const { readConversationNoteIndex, upsertConversationNoteIndex, writePromptNote, writeReplyNote } = require("./lib/conversation-artifacts");
const { CORS_HEADERS, httpError, readJsonBody, sendEmpty, sendJson } = require("./lib/http");
const { createDebugLogStore } = require("./lib/debug");
const { resolveSessionTitle } = require("./lib/display-names");
const { normalizeInteger, normalizeText } = require("./lib/normalize");
const { createSessionStore } = require("./lib/session-store");
const {
  attachObsidianPluginHealth,
  installObsidianPlugin,
  inspectObsidianPluginHealth,
  normalizeCanvasAppendDirection,
  normalizeComparablePath,
  registerObsidianVault,
} = require("./lib/obsidian-vault");
const {
  clearWindowIdentity,
  normalizeTargetBinding,
  normalizeWindowHint,
  resolveSessionTargetBinding,
  targetBindingFromWindowHint,
  windowHintFromWindowTarget,
} = require("./lib/target-binding");
const { launchCliInTerminal, spawnDetached } = require("./lib/terminal-launch");
const { normalizeNoteDisplayTitle, sanitizeFilePart, sanitizeObsidianFileNamePart, trimMessage } = require("./lib/text-format");
const { enrollWorkspace } = require("./lib/workspace-deploy");
const { inspectWorkspaceGitExclude, resolveWorkspaceGitExcludePlan } = require("./lib/workspace-git-exclude");
const { inspectWorkspace, resolveWorkspaceVaultRoot } = require("./lib/workspace-inspect");
const {
  ensureInsideDirectory,
  readJsonFile,
  readJsonFileStrict,
  readJsonTextFile,
  resolveWorkspacePath,
  writeJsonFile,
} = require("./lib/filesystem");

const HOST = process.env.AGENT_MONITOR_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.AGENT_MONITOR_PORT || "17654", 10);
const DATA_FILE =
  process.env.AGENT_MONITOR_DATA_FILE ||
  path.join(__dirname, "data", "sessions.json");
const DEBUG_MAX_LOG_ENTRIES = 800;
const PROMPT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

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
  promptEventHandler: (payload) => handlePrompt(payload),
});
const {
  sessions,
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

    if (req.method === "POST" && url.pathname === "/api/workspaces/update-obsidian-plugin") {
      const payload = await readJsonBody(req);
      const result = updateWorkspaceObsidianPlugin(payload);
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
      recordDebugLog,
    });
  } else if (adapterId === "claude-cli") {
    launch = await launchCliInTerminal({
      workspacePath,
      title: `AMO Claude CLI - ${projectName}`,
      command: "claude",
      args: [],
      recordDebugLog,
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

function updateWorkspaceObsidianPlugin(payload) {
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const statusBefore = workspaceMaintenanceSnapshot(workspacePath);
  const workspace = readJsonFile(path.join(workspacePath, AMO_DIR, "workspace.json"), null);
  if (!workspace || !workspace.workspaceId) {
    throw httpError(400, "workspace_not_enrolled", "Selected workspace does not have AMO enrollment metadata");
  }

  const amoRoot = path.join(workspacePath, AMO_DIR);
  const vaultRoot = resolveWorkspaceVaultRoot(amoRoot, workspace, workspace.projectName || path.basename(workspacePath));
  if (!fs.existsSync(vaultRoot)) {
    throw httpError(409, "vault_missing", "AMO Obsidian vault is missing; redeploy the workspace to recreate it.");
  }
  ensureInsideDirectory(workspacePath, vaultRoot);

  const pluginInstall = installObsidianPlugin(vaultRoot, workspacePath, { bridgeUrl: baseUrl() });
  const statusAfter = workspaceMaintenanceSnapshot(workspacePath);
  recordDebugLog("broker", "workspace.obsidian_plugin.updated", {
    workspacePath,
    vaultRoot,
    before: statusBefore.pluginHealth,
    after: statusAfter.pluginHealth,
    installedFiles: pluginInstall.installedFiles,
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspacePath,
    vaultRoot,
    installedFiles: pluginInstall.installedFiles,
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
  const pluginHealth = inspectObsidianPluginHealth(vaultRoot, { expectedBridgeUrl: baseUrl() });
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

function baseUrl() {
  return `http://${HOST}:${PORT}`;
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
