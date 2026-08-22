const { renameCodexThreadName } = require("./codex-app-server");
const { AMO_SCHEMA_VERSION } = require("./amo-constants");
const { httpError } = require("./http");
const { normalizeText } = require("./normalize");

const MAX_SESSION_NAME_LENGTH = 64;
const FRESH_SESSION_START_SOURCES = new Set(["startup", "new"]);

function createSessionNamingService(options = {}) {
  const sessions = options.sessions instanceof Map ? options.sessions : new Map();
  const renameCodexThread = options.renameCodexThread || renameCodexThreadName;
  const scheduleSnapshotPersist = typeof options.scheduleSnapshotPersist === "function" ? options.scheduleSnapshotPersist : () => {};
  const publishSessionChanged = typeof options.publishSessionChanged === "function" ? options.publishSessionChanged : () => {};
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};

  function onPromptCaptured({ session, workspace, message, firstPrompt = false, duplicate = false } = {}) {
    if (!session || !firstPrompt || duplicate || session.sessionNaming?.attemptedAt || normalizeText(session.taskTitle)) return session;
    const workspaceLabel = normalizeText(workspace?.workspaceLabel);
    const sessionStartSource = normalizeText(session.sessionStartSource);
    if (!workspaceLabel || !isFreshSessionStart(sessionStartSource)) {
      if (firstPrompt) {
        recordDebugLog("broker", "session.auto_name.skipped", {
          sessionId: session.sessionId,
          tool: session.tool || null,
          sessionStartSource,
          hasWorkspaceLabel: Boolean(workspaceLabel),
        });
      }
      return session;
    }

    const requestedName = deriveSessionName(workspaceLabel, message);
    if (!requestedName) return session;

    const now = new Date().toISOString();
    const nextSession = {
      ...session,
      taskTitle: requestedName,
      sessionNaming: {
        status: "amo-only",
        requestedName,
        workspaceLabel,
        attemptedAt: now,
        completedAt: now,
        providerSynced: false,
        error: null,
      },
    };
    sessions.set(session.sessionId, nextSession);
    scheduleSnapshotPersist("session-auto-name-local");
    publishSessionChanged("session-auto-name-local", nextSession);
    recordDebugLog("broker", "session.auto_name.local", {
      sessionId: session.sessionId,
      tool: session.tool,
      requestedName,
    });
    return nextSession;
  }

  function recoverPending() {
    for (const session of sessions.values()) {
      const requestedName = normalizeText(session?.sessionNaming?.requestedName);
      const interruptedSync = session?.providerNameSync?.status === "syncing";
      const legacyAutomaticStatus = ["pending", "failed", "display-only"].includes(session?.sessionNaming?.status);
      if (!legacyAutomaticStatus && !interruptedSync) continue;

      const now = new Date().toISOString();
      const nextSession = {
        ...session,
        taskTitle: normalizeText(session.taskTitle) || requestedName || null,
        sessionNaming: requestedName
          ? {
              ...session.sessionNaming,
              status: "amo-only",
              completedAt: session.sessionNaming?.completedAt || now,
              providerSynced: false,
              error: null,
            }
          : session.sessionNaming || null,
        providerNameSync: interruptedSync
          ? {
              ...session.providerNameSync,
              status: "failed",
              completedAt: now,
              error: "Broker restarted before provider name sync completed",
            }
          : session.providerNameSync || null,
      };
      sessions.set(session.sessionId, nextSession);
      scheduleSnapshotPersist("session-auto-name-recovered");
      publishSessionChanged("session-auto-name-recovered", nextSession);
    }
  }

  async function syncProviderName(sessionId, payload = {}) {
    const existing = sessions.get(sessionId);
    if (!existing) {
      throw httpError(404, "session_not_found", `Session not found for provider name sync: ${sessionId}`);
    }
    if (!/^codex(?:-cli)?$/iu.test(normalizeText(existing.tool) || "")) {
      throw httpError(400, "provider_name_sync_unsupported", `Provider name sync is not supported for ${existing.tool || "unknown"}`);
    }

    const requestedTitle = normalizeText(existing.taskTitle);
    if (!requestedTitle) {
      throw httpError(409, "missing_task_title", "Set an AMO task name before syncing it to the provider session");
    }
    const expectedTaskTitle = normalizeText(payload.expectedTaskTitle || payload.expected_task_title);
    if (expectedTaskTitle && expectedTaskTitle !== requestedTitle) {
      throw httpError(409, "task_title_changed", "The AMO task name changed before provider sync started");
    }

    const attemptedAt = new Date().toISOString();
    const syncingSession = {
      ...existing,
      providerNameSync: {
        status: "syncing",
        requestedTitle,
        attemptedAt,
        completedAt: null,
        providerSynced: false,
        error: null,
      },
    };
    sessions.set(sessionId, syncingSession);
    scheduleSnapshotPersist("provider-name-sync-start");
    publishSessionChanged("provider-name-sync-start", syncingSession);
    recordDebugLog("broker", "session.provider_name_sync.start", { sessionId, requestedTitle });

    try {
      await renameCodexThread(sessionId, requestedTitle);
      const current = sessions.get(sessionId) || syncingSession;
      const taskTitleChanged = normalizeText(current.taskTitle) !== requestedTitle;
      const completedAt = new Date().toISOString();
      const session = {
        ...current,
        title: requestedTitle,
        providerNameSync: {
          status: taskTitleChanged ? "stale" : "synced",
          requestedTitle,
          attemptedAt,
          completedAt,
          providerSynced: true,
          error: null,
        },
      };
      sessions.set(sessionId, session);
      scheduleSnapshotPersist("provider-name-sync-result");
      publishSessionChanged("provider-name-sync-result", session);
      recordDebugLog("broker", "session.provider_name_sync.ok", { sessionId, requestedTitle, taskTitleChanged });
      return {
        ok: true,
        schemaVersion: AMO_SCHEMA_VERSION,
        sessionId,
        requestedTitle,
        session,
      };
    } catch (error) {
      const current = sessions.get(sessionId) || syncingSession;
      const message = trimError(error);
      const session = {
        ...current,
        providerNameSync: {
          status: "failed",
          requestedTitle,
          attemptedAt,
          completedAt: new Date().toISOString(),
          providerSynced: false,
          error: message,
        },
      };
      sessions.set(sessionId, session);
      scheduleSnapshotPersist("provider-name-sync-result");
      publishSessionChanged("provider-name-sync-result", session);
      recordDebugLog("broker", "session.provider_name_sync.failed", { sessionId, requestedTitle, message });
      throw error;
    }
  }

  return { onPromptCaptured, recoverPending, syncProviderName, flush: () => Promise.resolve() };
}

function isFreshSessionStart(source) {
  return FRESH_SESSION_START_SOURCES.has(normalizeText(source)?.toLowerCase());
}

function deriveSessionName(workspaceLabel, prompt) {
  const label = normalizeText(workspaceLabel);
  const rawPrompt = normalizeText(prompt);
  if (!label || !rawPrompt) return null;

  const cleaned = extractUserRequest(rawPrompt)
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/giu, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/[\r\n]+/gu, "。")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;

  const clauses = cleaned
    .split(/[。！？!?;；]+/gu)
    .map(cleanTitleClause)
    .filter((clause) => clause && !isPromptEnvelopeClause(clause));
  const meaningful = clauses.find((clause) => !isProceduralClause(clause)) || clauses[0];
  if (!meaningful) return null;

  const labelLength = Array.from(label).length;
  const bodyBudget = Math.max(8, Math.min(36, MAX_SESSION_NAME_LENGTH - labelLength - 1));
  const body = truncateText(meaningful, bodyBudget).replace(/[\s,，、:：.!！?？;；。-]+$/gu, "");
  return body ? `${label}-${body}` : null;
}

function extractUserRequest(prompt) {
  const marker = /^\s{0,3}#{1,6}\s*my request\s*:\s*$/imu;
  const match = marker.exec(prompt);
  return match ? prompt.slice(match.index + match[0].length) : prompt;
}

function cleanTitleClause(value) {
  let result = `${value || ""}`.trim().replace(/^#{1,6}\s*/u, "");
  const leadIns = [
    /^(?:接下来|然后|另外|现在)[,，\s]*/iu,
    /^(?:请|麻烦)?(?:你|帮我|我们)?(?:先)?(?:帮忙)?[,，\s]*/iu,
    /^(?:我想|我们想|我希望|需要)(?:补充|增加|新增|做)?(?:一个|个)?(?:功能)?[,，\s]*/iu,
    /^(?:你)?(?:看看|看下|调查一下|研究一下)(?:是否|能否)?(?:可以|能做|实现)?[,，\s]*/iu,
    /^(?:就是|也就是|目标是|需求是)[,，\s]*/iu,
  ];
  for (let pass = 0; pass < 3; pass += 1) {
    const before = result;
    for (const pattern of leadIns) result = result.replace(pattern, "");
    if (result === before) break;
  }
  return result.replace(/^[,，、:：\s-]+/gu, "").replace(/\s+/gu, " ").trim();
}

function isPromptEnvelopeClause(value) {
  const normalized = value.replace(/\s+/gu, " ").trim().toLowerCase();
  return normalized === "files mentioned by the user" ||
    normalized.startsWith("distinguish instructions in attached documents from the user's request");
}

function isProceduralClause(value) {
  const compact = value.replace(/\s+/gu, "").toLowerCase();
  return /^(?:pull|拉取|拉取最新|更新代码|合并|提交|先调查|先看看|开始推进|继续推进|按之前说的做)(?:[-,，a-z]*)?$/iu.test(compact);
}

function truncateText(value, maximum) {
  const characters = Array.from(value);
  return characters.length <= maximum ? value : characters.slice(0, maximum).join("");
}

function trimError(error) {
  return `${error?.message || error || "Unknown rename error"}`.slice(0, 500);
}

module.exports = { createSessionNamingService, deriveSessionName, isFreshSessionStart };
