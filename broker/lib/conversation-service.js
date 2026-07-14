const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AMO_DIR, AMO_SCHEMA_VERSION } = require("./amo-constants");
const { appendConversationNoteToCanvas } = require("./canvas-writer");
const { writePromptNote, writeReplyNote } = require("./conversation-artifacts");
const { resolveSessionTitle } = require("./display-names");
const { readJsonFile } = require("./filesystem");
const { httpError } = require("./http");
const { normalizeInteger, normalizeText } = require("./normalize");
const {
  findDuplicatePrompt,
  promptContentHash,
} = require("./pending-prompts");
const { normalizeWindowHint, resolveSessionTargetBinding } = require("./target-binding");
const { trimMessage } = require("./text-format");
const { resolveWorkspaceVaultRoot } = require("./workspace-inspect");

function createConversationService(options = {}) {
  const context = {
    sessions: options.sessions instanceof Map ? options.sessions : new Map(),
    recordDebugLog: typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {},
    debugPreview: typeof options.debugPreview === "function" ? options.debugPreview : (value) => normalizeText(value),
    reviveArchivedSession:
      typeof options.reviveArchivedSession === "function" ? options.reviveArchivedSession : (session) => session,
    clearSessionAttentionFields:
      typeof options.clearSessionAttentionFields === "function" ? options.clearSessionAttentionFields : (session) => session,
    sessionHasAttentionState:
      typeof options.sessionHasAttentionState === "function" ? options.sessionHasAttentionState : () => false,
    normalizeState: typeof options.normalizeState === "function" ? options.normalizeState : (state) => normalizeText(state),
    promptDuplicateWindowMs: options.promptDuplicateWindowMs,
  };

  return {
    handlePrompt: (payload) => handlePrompt(payload, context),
    handleReply: (payload) => handleReply(payload, context),
  };
}

function handleReply(payload, context) {
  const { sessions, recordDebugLog, debugPreview, reviveArchivedSession } = context;
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
    ...(existing || {}),
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
    launchId: normalizeText(payload.launchId || payload.launch_id) || existing?.launchId || null,
    launchState: normalizeText(payload.launchState || payload.launch_state) || existing?.launchState || null,
    launchRevision:
      normalizeInteger(payload.launchRevision || payload.launch_revision) ?? existing?.launchRevision ?? null,
    activeTurnId: turnId,
    transcriptPath,
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

function handlePrompt(payload, context) {
  const {
    sessions,
    recordDebugLog,
    debugPreview,
    reviveArchivedSession,
    clearSessionAttentionFields,
    sessionHasAttentionState,
    normalizeState,
    promptDuplicateWindowMs,
  } = context;
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
  const transcriptPath = normalizeText(payload.transcriptPath || payload.transcript_path);
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
  }, promptDuplicateWindowMs);
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
        activeTurnId: turnId,
        transcriptPath: transcriptPath || existing?.transcriptPath || null,
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
    transcriptPath,
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
    launchId: normalizeText(payload.launchId || payload.launch_id) || existing?.launchId || null,
    launchState: normalizeText(payload.launchState || payload.launch_state) || existing?.launchState || null,
    launchRevision:
      normalizeInteger(payload.launchRevision || payload.launch_revision) ?? existing?.launchRevision ?? null,
    activeTurnId: turnId,
    transcriptPath: transcriptPath || existing?.transcriptPath || null,
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

module.exports = {
  createConversationService,
  findEnrolledWorkspace,
  handlePrompt,
  handleReply,
  resolvePromptWorkspace,
};
