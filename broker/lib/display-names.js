const fs = require("fs");
const os = require("os");
const path = require("path");

const codexThreadNameCache = {
  indexPath: null,
  mtimeMs: null,
  names: new Map(),
};

const claudeSessionNameCache = {
  sessionsSignature: null,
  projectIndexesSignature: null,
  names: new Map(),
};

function resolveSessionTitle(tool, sessionId, explicitTitle, existingTitle) {
  const payloadTitle = normalizeText(explicitTitle);
  if (payloadTitle) {
    return payloadTitle;
  }

  const sessionDisplayName = lookupSessionDisplayName(tool, sessionId);
  if (sessionDisplayName) {
    return sessionDisplayName;
  }

  return normalizeText(existingTitle) || defaultTitle(tool, sessionId);
}

function refreshSessionTitle(session) {
  if (!session || !session.sessionId) {
    return session;
  }

  const title = resolveSessionTitle(session.tool, session.sessionId, null, session.title);
  return title && title !== session.title ? { ...session, title } : session;
}

function lookupSessionDisplayName(tool, sessionId) {
  return lookupCodexThreadName(tool, sessionId) || lookupClaudeSessionName(tool, sessionId);
}

function lookupCodexThreadName(tool, sessionId) {
  const normalizedTool = normalizeText(tool);
  if (!normalizedTool || !normalizedTool.toLowerCase().startsWith("codex")) {
    return null;
  }

  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  return loadCodexThreadNameIndex().get(normalizedSessionId) || null;
}

function loadCodexThreadNameIndex() {
  const indexPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "session_index.jsonl");
  let stat;
  try {
    stat = fs.statSync(indexPath);
  } catch {
    codexThreadNameCache.indexPath = indexPath;
    codexThreadNameCache.mtimeMs = null;
    codexThreadNameCache.names = new Map();
    return codexThreadNameCache.names;
  }

  if (codexThreadNameCache.indexPath === indexPath && codexThreadNameCache.mtimeMs === stat.mtimeMs) {
    return codexThreadNameCache.names;
  }

  const names = new Map();
  const updatedAtById = new Map();
  const lines = fs.readFileSync(indexPath, "utf8").replace(/^\uFEFF/u, "").split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const id = normalizeText(record.id || record.sessionId || record.session_id);
    const threadName = normalizeText(record.thread_name || record.threadName || record.title || record.name);
    if (!id || !threadName) {
      continue;
    }

    const updatedAtText = normalizeText(record.updated_at || record.updatedAt);
    const updatedAt = updatedAtText ? Date.parse(updatedAtText) : 0;
    const previousUpdatedAt = updatedAtById.get(id) ?? -1;
    if (!names.has(id) || updatedAt >= previousUpdatedAt) {
      names.set(id, threadName);
      updatedAtById.set(id, Number.isNaN(updatedAt) ? 0 : updatedAt);
    }
  }

  codexThreadNameCache.indexPath = indexPath;
  codexThreadNameCache.mtimeMs = stat.mtimeMs;
  codexThreadNameCache.names = names;
  return names;
}

function lookupClaudeSessionName(tool, sessionId) {
  const normalizedTool = normalizeText(tool);
  if (!normalizedTool || !normalizedTool.toLowerCase().startsWith("claude")) {
    return null;
  }

  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  return loadClaudeSessionNameIndex().get(normalizedSessionId) || null;
}

function loadClaudeSessionNameIndex() {
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const sessionsDir = path.join(claudeRoot, "sessions");
  const projectsDir = path.join(claudeRoot, "projects");
  const sessionsSignature = claudeSessionFilesSignature(sessionsDir);
  const projectIndexesSignature = claudeProjectIndexesSignature(projectsDir);

  if (
    claudeSessionNameCache.sessionsSignature === sessionsSignature &&
    claudeSessionNameCache.projectIndexesSignature === projectIndexesSignature
  ) {
    return claudeSessionNameCache.names;
  }

  const names = new Map();
  const updatedAtById = new Map();
  const priorityById = new Map();

  for (const filePath of listClaudeSessionFiles(sessionsDir)) {
    const stat = statFileSafe(filePath);
    const record = readJsonFile(filePath, null);
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }

    const id = normalizeText(record.sessionId || record.session_id);
    const title = normalizeClaudeSessionDisplayName(
      record.name || record.displayName || record.display_name || record.title
    );
    if (!id || !title) {
      continue;
    }

    addSessionDisplayName(names, updatedAtById, priorityById, {
      id,
      title,
      updatedAt: timestampMs(
        record.updatedAt || record.updated_at || record.statusUpdatedAt || record.status_updated_at,
        stat?.mtimeMs
      ),
      priority: 2,
    });
  }

  for (const filePath of listClaudeProjectIndexFiles(projectsDir)) {
    const index = readJsonFile(filePath, null);
    const entries = Array.isArray(index?.entries) ? index.entries : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const id = normalizeText(entry.sessionId || entry.session_id || entry.id);
      const title = normalizeClaudeSessionDisplayName(
        entry.name || entry.displayName || entry.display_name || entry.title || entry.summary
      );
      if (!id || !title) {
        continue;
      }

      addSessionDisplayName(names, updatedAtById, priorityById, {
        id,
        title,
        updatedAt: timestampMs(
          entry.modified || entry.updatedAt || entry.updated_at || entry.fileMtime || entry.created
        ),
        priority: 1,
      });
    }
  }

  claudeSessionNameCache.sessionsSignature = sessionsSignature;
  claudeSessionNameCache.projectIndexesSignature = projectIndexesSignature;
  claudeSessionNameCache.names = names;
  return names;
}

function addSessionDisplayName(names, updatedAtById, priorityById, { id, title, updatedAt, priority }) {
  const previousPriority = priorityById.get(id) ?? -1;
  const previousUpdatedAt = updatedAtById.get(id) ?? -1;
  if (
    !names.has(id) ||
    priority > previousPriority ||
    (priority === previousPriority && updatedAt >= previousUpdatedAt)
  ) {
    names.set(id, title);
    updatedAtById.set(id, updatedAt);
    priorityById.set(id, priority);
  }
}

function normalizeClaudeSessionDisplayName(value) {
  const title = normalizeText(value);
  if (!title) {
    return null;
  }

  const normalized = title.toLowerCase();
  if (normalized === "new conversation" || normalized === "untitled") {
    return null;
  }

  return title;
}

function listClaudeSessionFiles(sessionsDir) {
  try {
    return fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(sessionsDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function listClaudeProjectIndexFiles(projectsDir) {
  try {
    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsDir, entry.name, "sessions-index.json"))
      .filter((filePath) => fs.existsSync(filePath))
      .sort();
  } catch {
    return [];
  }
}

function claudeSessionFilesSignature(sessionsDir) {
  return listClaudeSessionFiles(sessionsDir).map(fileSignature).join("|");
}

function claudeProjectIndexesSignature(projectsDir) {
  return listClaudeProjectIndexFiles(projectsDir).map(fileSignature).join("|");
}

function fileSignature(filePath) {
  const stat = statFileSafe(filePath);
  return stat ? `${filePath}:${stat.size}:${stat.mtimeMs}` : `${filePath}:missing`;
}

function statFileSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function timestampMs(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const text = normalizeText(value);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.isFinite(fallback) ? fallback : 0;
}

function readJsonFile(filePath, fallback) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultTitle(tool, sessionId) {
  return `${tool} - ${sessionId}`;
}

module.exports = {
  refreshSessionTitle,
  resolveSessionTitle,
};
