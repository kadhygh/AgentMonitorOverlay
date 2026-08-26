const { renameCodexThreadName } = require("./codex-app-server");
const { normalizeText } = require("./normalize");

const MAX_SESSION_NAME_LENGTH = 64;
const FRESH_SESSION_START_SOURCES = new Set(["startup", "new"]);

function createSessionNamingService(options = {}) {
  const sessions = options.sessions instanceof Map ? options.sessions : new Map();
  const renameCodexThread = options.renameCodexThread || renameCodexThreadName;
  const scheduleSnapshotPersist = typeof options.scheduleSnapshotPersist === "function" ? options.scheduleSnapshotPersist : () => {};
  const publishSessionChanged = typeof options.publishSessionChanged === "function" ? options.publishSessionChanged : () => {};
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};
  let codexQueue = Promise.resolve();

  function onPromptCaptured({ session, workspace, message, firstPrompt = false, duplicate = false } = {}) {
    if (!session || !firstPrompt || duplicate || session.sessionNaming?.attemptedAt) return session;
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
    const isCodex = /^codex(?:-cli)?$/iu.test(normalizeText(session.tool) || "");
    const nextSession = {
      ...session,
      title: requestedName,
      sessionNaming: {
        status: isCodex ? "pending" : "display-only",
        requestedName,
        workspaceLabel,
        attemptedAt: now,
        completedAt: isCodex ? null : now,
        providerSynced: false,
        error: null,
      },
    };
    sessions.set(session.sessionId, nextSession);
    scheduleSnapshotPersist("session-auto-name");
    publishSessionChanged("session-auto-name", nextSession);

    if (!isCodex) {
      recordDebugLog("broker", "session.auto_name.display_only", {
        sessionId: session.sessionId,
        tool: session.tool,
        requestedName,
      });
      return nextSession;
    }

    enqueueCodexRename(session.sessionId, requestedName);
    return nextSession;
  }

  function recoverPending() {
    for (const session of sessions.values()) {
      const requestedName = normalizeText(session?.sessionNaming?.requestedName);
      if (session?.sessionNaming?.status !== "pending" || !requestedName || !/^codex(?:-cli)?$/iu.test(session.tool || "")) continue;
      sessions.set(session.sessionId, { ...session, title: requestedName });
      enqueueCodexRename(session.sessionId, requestedName);
    }
  }

  function enqueueCodexRename(sessionId, requestedName) {
    codexQueue = codexQueue.then(
      () => completeCodexRename(sessionId, requestedName),
      () => completeCodexRename(sessionId, requestedName),
    );
  }

  async function completeCodexRename(sessionId, requestedName) {
    try {
      await renameCodexThread(sessionId, requestedName);
      updateNamingResult(sessionId, requestedName, {
        status: "renamed",
        providerSynced: true,
        error: null,
      });
      recordDebugLog("broker", "session.auto_name.renamed", { sessionId, requestedName });
    } catch (error) {
      updateNamingResult(sessionId, requestedName, {
        status: "failed",
        providerSynced: false,
        error: trimError(error),
      });
      recordDebugLog("broker", "session.auto_name.failed", {
        sessionId,
        requestedName,
        message: trimError(error),
      });
    }
  }

  function updateNamingResult(sessionId, requestedName, result) {
    const current = sessions.get(sessionId);
    if (!current || current.sessionNaming?.requestedName !== requestedName) return;
    const nextSession = {
      ...current,
      title: requestedName,
      sessionNaming: {
        ...current.sessionNaming,
        ...result,
        completedAt: new Date().toISOString(),
      },
    };
    sessions.set(sessionId, nextSession);
    scheduleSnapshotPersist("session-auto-name-result");
    publishSessionChanged("session-auto-name-result", nextSession);
  }

  return { onPromptCaptured, recoverPending, flush: () => codexQueue };
}

function isFreshSessionStart(source) {
  return FRESH_SESSION_START_SOURCES.has(normalizeText(source)?.toLowerCase());
}

function deriveSessionName(workspaceLabel, prompt) {
  const label = normalizeText(workspaceLabel);
  const rawPrompt = normalizeText(prompt);
  if (!label || !rawPrompt) return null;

  const cleaned = rawPrompt
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/giu, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/[\r\n]+/gu, "。")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;

  const clauses = cleaned.split(/[。！？!?;；]+/gu).map(cleanTitleClause).filter(Boolean);
  const meaningful = clauses.find((clause) => !isProceduralClause(clause)) || clauses[0];
  if (!meaningful) return null;

  const labelLength = Array.from(label).length;
  const bodyBudget = Math.max(8, Math.min(36, MAX_SESSION_NAME_LENGTH - labelLength - 1));
  const body = truncateText(meaningful, bodyBudget).replace(/[\s,，、:：.!！?？;；。-]+$/gu, "");
  return body ? `${label}-${body}` : null;
}

function cleanTitleClause(value) {
  let result = `${value || ""}`.trim();
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
