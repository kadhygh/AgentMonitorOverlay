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
const AMO_DIR = ".amo";
const AMO_SCHEMA_VERSION = 1;
const REPLY_NODE_WIDTH = 520;
const REPLY_NODE_HEIGHT = 360;
const REPLY_NODE_GAP_X = 620;
const REPLY_NODE_GAP_Y = 420;
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

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return sendJson(res, 200, {
        count: sessions.size,
        sessions: listSessions(),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/inspect") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, inspectWorkspace(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/enroll") {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, enrollWorkspace(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/events") {
      const payload = await readJsonBody(req);
      const session = upsertSessionFromEvent(payload);
      persistSnapshot();
      return sendJson(res, 200, { ok: true, session });
    }

    if (req.method === "POST" && url.pathname === "/api/replies") {
      const payload = await readJsonBody(req);
      const reply = handleReply(payload);
      persistSnapshot();
      return sendJson(res, 200, reply);
    }

    const heartbeatMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/heartbeat$/);
    if (req.method === "POST" && heartbeatMatch) {
      const sessionId = decodeURIComponent(heartbeatMatch[1]);
      const payload = await readJsonBody(req, { allowEmpty: true });
      const session = updateHeartbeat(sessionId, payload || {});
      persistSnapshot();
      return sendJson(res, 200, { ok: true, session });
    }

    return sendJson(res, 404, {
      ok: false,
      error: "not_found",
      message: `${req.method} ${url.pathname} is not supported`,
    });
  } catch (error) {
    const status = error.statusCode || 500;
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
  return session;
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
  const rootIndicators = [".git", "package.json", "pyproject.toml", "Cargo.toml"].filter((name) => {
    return fs.existsSync(path.join(workspacePath, name));
  });

  const evidence = [];
  if (hasAmo) evidence.push("existing .amo workspace metadata found");
  if (hasCodexDir) evidence.push("existing .codex directory found");
  if (hasCodexHooks) evidence.push("existing .codex/hooks.json found and will be merged");
  if (rootIndicators.length > 0) evidence.push(`project indicators: ${rootIndicators.join(", ")}`);
  if (writable) evidence.push("workspace is writable");

  const codexStatus = writable ? "available" : "blocked";
  const confidence = hasCodexDir || hasCodexHooks ? "high" : rootIndicators.length > 0 ? "medium" : "low";

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
        confidence,
        scope: "project-local",
        reason: writable
          ? "Codex CLI can use a project-local Stop hook adapter in this workspace."
          : "Workspace is not writable.",
        evidence,
        directoriesToCreate: [
          ".amo",
          ".amo/adapters",
          ".amo/hooks",
          ".amo/state",
          ".amo/logs",
          ".amo/backups",
          ".amo/obsidian-vault",
          ".amo/obsidian-vault/Replies",
        ],
        filesToWrite: [
          ".amo/workspace.json",
          ".amo/enrollment.json",
          ".amo/adapters/codex-cli.json",
          ".amo/hooks/codex-stop-message.mjs",
          ".amo/obsidian-vault/AgentFlow.canvas",
          ".amo/.gitignore",
        ],
        filesToMerge: [".codex/hooks.json"],
        risks: [
          "Codex may require trust/review for project-local hooks in this workspace.",
          "Codex hook payloads do not provide native HWND/PID; window routing should use title/project hints unless separately bound.",
        ],
      },
    ],
    deferredAdapters: [
      deferredAdapter("codex-app", "Codex App", "Direct Codex App integration is deferred until its local control surface is defined."),
      deferredAdapter("claude-cli", "Claude CLI", "Claude CLI reply capture is deferred; status hooks have been smoke-tested separately."),
      deferredAdapter("kiro-ide", "Kiro IDE", "Kiro IDE hook install target and payload shape still need local verification."),
    ],
  };
}

function enrollWorkspace(payload) {
  const requestedAdapters = normalizeAdapterIds(payload?.adapters || payload?.adapterIds || payload?.adapter_ids);
  const unsupported = requestedAdapters.filter((id) => id !== "codex-cli");
  if (unsupported.length > 0) {
    throw httpError(400, "unsupported_adapter", `Unsupported MVP adapter(s): ${unsupported.join(", ")}`);
  }

  const inspection = inspectWorkspace(payload);
  const codexPlan = inspection.supportedAdapters.find((adapter) => adapter.id === "codex-cli");
  if (!codexPlan || codexPlan.status !== "available") {
    throw httpError(400, "workspace_not_writable", "Workspace cannot be enrolled because it is not writable.");
  }

  const workspacePath = inspection.workspacePath;
  const now = new Date().toISOString();
  const amoRoot = path.join(workspacePath, AMO_DIR);
  const vaultRoot = path.join(amoRoot, "obsidian-vault");
  const installedFiles = [];
  const mergedFiles = [];
  const backups = [];

  for (const dir of codexPlan.directoriesToCreate) {
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
    defaultCanvasPath: "AgentFlow.canvas",
    repliesPath: "Replies",
  });
  installedFiles.push(".amo/workspace.json");

  const adapterFile = path.join(amoRoot, "adapters", "codex-cli.json");
  const hookScriptPath = path.join(amoRoot, "hooks", "codex-stop-message.mjs");
  writeJsonFile(adapterFile, {
    schemaVersion: AMO_SCHEMA_VERSION,
    id: "codex-cli",
    label: "Codex CLI",
    status: "installed",
    installedAt: now,
    bridgeRepliesUrl: `${baseUrl()}/api/replies`,
    hookScriptPath,
    cacheFallbackPath: path.join(workspacePath, ".codex", "cache"),
  });
  installedFiles.push(".amo/adapters/codex-cli.json");

  writeTextFile(hookScriptPath, codexReplyHookScript());
  installedFiles.push(".amo/hooks/codex-stop-message.mjs");

  writeTextFile(path.join(amoRoot, ".gitignore"), amoGitignore());
  installedFiles.push(".amo/.gitignore");

  ensureCanvas(path.join(vaultRoot, "AgentFlow.canvas"));
  installedFiles.push(".amo/obsidian-vault/AgentFlow.canvas");

  const mergeResult = mergeCodexHooks(workspacePath, hookScriptPath, amoRoot);
  if (mergeResult.changed) {
    mergedFiles.push(".codex/hooks.json");
  }
  backups.push(...mergeResult.backups);

  writeJsonFile(path.join(amoRoot, "enrollment.json"), {
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: inspection.workspaceId,
    workspacePath,
    updatedAt: now,
    adapters: [
      {
        id: "codex-cli",
        status: "installed",
        installedAt: now,
        hookScriptPath,
        mergedFiles,
      },
    ],
    deferredAdapters: inspection.deferredAdapters,
  });
  installedFiles.push(".amo/enrollment.json");

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: inspection.workspaceId,
    workspacePath,
    deploymentRoot: AMO_DIR,
    installedAdapters: ["codex-cli"],
    installedFiles,
    mergedFiles,
    backups,
    vaultRoot,
    canvasPath: "AgentFlow.canvas",
    deferredAdapters: inspection.deferredAdapters,
  };
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
  const note = writeReplyNote(vaultRoot, record);
  const canvas = appendReplyToCanvas(amoRoot, vaultRoot, record, note);

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
    lastReplyAt: capturedAt,
    lastReplyNote: note.notePath,
    canvasPath: canvas.canvasPath,
    canvasNodeId: canvas.canvasNodeId,
  };
  sessions.set(sessionId, session);

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    sessionId,
    turnId,
    notePath: note.notePath,
    noteAbsolutePath: note.noteAbsolutePath,
    canvasPath: canvas.canvasPath,
    canvasNodeId: canvas.canvasNodeId,
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
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonFileStrict(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw httpError(409, "invalid_existing_json", `${filePath} is not valid JSON: ${error.message}`);
  }
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

function ensureCanvas(canvasPath) {
  if (fs.existsSync(canvasPath)) {
    return;
  }
  writeJsonFile(canvasPath, { nodes: [], edges: [] });
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
        statusMessage: "AMO capture Codex reply",
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

  const alreadyInstalled = JSON.stringify(config.hooks.Stop).includes("codex-stop-message.mjs");
  if (!alreadyInstalled) {
    config.hooks.Stop.push(hookEntry);
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
    "const archiveRoot = path.join(cacheRoot, 'assistant-turns');",
    "const latestFile = path.join(cacheRoot, 'latest-assistant-message.md');",
    "const latestJsonFile = path.join(cacheRoot, 'latest-assistant-message.json');",
    "const errorLogFile = path.join(cacheRoot, 'assistant-turn-errors.log');",
    "",
    "try {",
    "  const rawInput = await readStdin();",
    "  const payload = rawInput.trim().length > 0 ? JSON.parse(rawInput) : {};",
    "  const message = normalizeMessage(payload.last_assistant_message);",
    "",
    "  if (message) {",
    "    await fs.mkdir(archiveRoot, { recursive: true });",
    "    const capturedAt = new Date().toISOString();",
    "    const record = {",
    "      schemaVersion: 1,",
    "      tool: 'codex',",
    "      source: 'codex-stop-hook',",
    "      capturedAt,",
    "      sessionId: typeof payload.session_id === 'string' ? payload.session_id : 'unknown-session',",
    "      turnId: typeof payload.turn_id === 'string' ? payload.turn_id : 'unknown-turn',",
    "      model: typeof payload.model === 'string' ? payload.model : null,",
    "      hookEventName: payload.hook_event_name ?? 'Stop',",
    "      cwd: typeof payload.cwd === 'string' ? payload.cwd : projectRoot,",
    "      transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : null,",
    "      stopHookActive: Boolean(payload.stop_hook_active),",
    "      message,",
    "    };",
    "",
    "    const archiveStem = `${fileSafeTimestamp(capturedAt)}-${sanitizeFilePart(record.turnId)}`;",
    "    await Promise.all([",
    "      fs.writeFile(path.join(archiveRoot, `${archiveStem}.md`), renderMarkdown(record), 'utf8'),",
    "      fs.writeFile(path.join(archiveRoot, `${archiveStem}.json`), `${JSON.stringify(record, null, 2)}\\n`, 'utf8'),",
    "      fs.writeFile(latestFile, renderMarkdown(record), 'utf8'),",
    "      fs.writeFile(latestJsonFile, `${JSON.stringify(record, null, 2)}\\n`, 'utf8'),",
    "    ]);",
    "    await postToBridge(record);",
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
    "async function postToBridge(record) {",
    "  try {",
    "    const config = JSON.parse(await fs.readFile(adapterConfigFile, 'utf8'));",
    "    const url = typeof config.bridgeRepliesUrl === 'string' ? config.bridgeRepliesUrl : null;",
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
    "    '# Cached Codex Reply',",
    "    '',",
    "    `- captured_at: ${record.capturedAt}`,",
    "    `- session_id: ${record.sessionId}`,",
    "    `- turn_id: ${record.turnId}`,",
    "    `- model: ${record.model ?? 'unknown-model'}`,",
    "    `- hook_event_name: ${record.hookEventName}`,",
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

function writeReplyNote(vaultRoot, record) {
  const month = record.capturedAt.slice(0, 7) || "unknown-month";
  const replyDir = path.join(vaultRoot, "Replies", month);
  fs.mkdirSync(replyDir, { recursive: true });

  const stem = `${fileSafeTimestamp(record.capturedAt)}_${sanitizeFilePart(record.tool)}_${sanitizeFilePart(record.turnId)}_reply`;
  const noteAbsolutePath = uniquePath(replyDir, stem, ".md");
  const notePath = toVaultRelativePath(vaultRoot, noteAbsolutePath);
  const body = [
    "---",
    "amo:",
    `  schemaVersion: ${AMO_SCHEMA_VERSION}`,
    `  workspaceId: ${yamlString(record.workspaceId)}`,
    `  tool: ${yamlString(record.tool)}`,
    `  sessionId: ${yamlString(record.sessionId)}`,
    `  turnId: ${yamlString(record.turnId)}`,
    `  cwd: ${yamlString(record.cwd)}`,
    `  source: ${yamlString(record.source)}`,
    `  capturedAt: ${yamlString(record.capturedAt)}`,
    record.transcriptPath ? `  transcriptPath: ${yamlString(record.transcriptPath)}` : null,
    "---",
    "",
    `# ${record.tool} Reply`,
    "",
    record.message,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  writeTextFile(noteAbsolutePath, body);
  return { notePath, noteAbsolutePath };
}

function appendReplyToCanvas(amoRoot, vaultRoot, record, note) {
  const canvasPath = "AgentFlow.canvas";
  const canvasAbsolutePath = path.join(vaultRoot, canvasPath);
  const bindingsPath = path.join(amoRoot, "state", "bindings.json");
  const canvas = readJsonFile(canvasAbsolutePath, { nodes: [], edges: [] });
  if (!Array.isArray(canvas.nodes)) canvas.nodes = [];
  if (!Array.isArray(canvas.edges)) canvas.edges = [];

  const bindings = readJsonFile(bindingsPath, { schemaVersion: AMO_SCHEMA_VERSION, sessions: {} });
  if (!bindings.sessions || typeof bindings.sessions !== "object" || Array.isArray(bindings.sessions)) {
    bindings.sessions = {};
  }

  const existingBinding = bindings.sessions[record.sessionId] || {};
  const sessionIndex =
    Number.isSafeInteger(existingBinding.sessionIndex)
      ? existingBinding.sessionIndex
      : Object.keys(bindings.sessions).length;
  const nodeCount = Number.isSafeInteger(existingBinding.nodeCount) ? existingBinding.nodeCount : 0;
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

  canvas.nodes.push({
    id: canvasNodeId,
    type: "file",
    file: note.notePath,
    x: nodeCount * REPLY_NODE_GAP_X,
    y: sessionIndex * REPLY_NODE_GAP_Y,
    width: REPLY_NODE_WIDTH,
    height: REPLY_NODE_HEIGHT,
  });

  if (existingBinding.lastCanvasNodeId) {
    canvas.edges.push({
      id: `edge-${existingBinding.lastCanvasNodeId}-${canvasNodeId}`,
      fromNode: existingBinding.lastCanvasNodeId,
      toNode: canvasNodeId,
    });
  }

  bindings.sessions[record.sessionId] = {
    sessionId: record.sessionId,
    workCanvasId: "default",
    canvasPath,
    lastCanvasNodeId: canvasNodeId,
    nodeCount: nodeCount + 1,
    sessionIndex,
    updatedAt: record.capturedAt,
  };

  writeJsonFile(canvasAbsolutePath, canvas);
  writeJsonFile(bindingsPath, bindings);

  return { canvasPath, canvasNodeId };
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

function listSessions() {
  return Array.from(sessions.values()).sort((a, b) => {
    return `${b.updatedAt}`.localeCompare(`${a.updatedAt}`);
  });
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
