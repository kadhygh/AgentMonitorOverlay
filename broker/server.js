const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.AGENT_MONITOR_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.AGENT_MONITOR_PORT || "17654", 10);
const DATA_FILE =
  process.env.AGENT_MONITOR_DATA_FILE ||
  path.join(__dirname, "data", "sessions.json");
const MAX_BODY_BYTES = 1024 * 1024;

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

    if (req.method === "POST" && url.pathname === "/api/events") {
      const payload = await readJsonBody(req);
      const session = upsertSessionFromEvent(payload);
      persistSnapshot();
      return sendJson(res, 200, { ok: true, session });
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
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
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
