const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AMO_CANVAS_PATH, AMO_DIR, AMO_SCHEMA_VERSION } = require("./amo-constants");
const { updateCanvasNoteDisplayTitle } = require("./canvas-writer");
const { readConversationNoteIndex, upsertConversationNoteIndex } = require("./conversation-artifacts");
const { resolveSessionTitle } = require("./display-names");
const { httpError } = require("./http");
const { normalizeText } = require("./normalize");
const { registerObsidianVault } = require("./obsidian-vault");
const { normalizeAnnotations, renderPendingPrompt } = require("./pending-prompts");
const { normalizeNoteDisplayTitle } = require("./text-format");
const { readJsonFile } = require("./filesystem");

function createObsidianBridge({ sessions = new Map(), recordDebugLog = () => {}, debugPreview = normalizeText, handlePrompt = null } = {}) {
  const context = {
    sessions: sessions instanceof Map ? sessions : new Map(),
    recordDebugLog,
    debugPreview,
    handlePrompt,
  };
  return {
    handleObsidianAnnotations: (payload) => handleObsidianAnnotations(payload, context),
    handleObsidianNoteTitle: (payload) => handleObsidianNoteTitle(payload, { recordDebugLog }),
    handleRegisterObsidianVault: (payload) => handleRegisterObsidianVault(payload, { recordDebugLog }),
    handleSyncBack: (payload) => handleSyncBack(payload, context),
    recoverSessionFromAnnotationPayload,
  };
}

function handleObsidianAnnotations(payload, { sessions, recordDebugLog = () => {}, debugPreview = normalizeText } = {}) {
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

function handleObsidianNoteTitle(payload, { recordDebugLog = () => {} } = {}) {
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

function handleSyncBack(payload, { sessions, recordDebugLog = () => {}, handlePrompt = null } = {}) {
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
    if (typeof handlePrompt !== "function") {
      throw httpError(500, "missing_prompt_handler", "Sync-back requires a prompt handler");
    }
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

function handleRegisterObsidianVault(payload, { recordDebugLog = () => {} } = {}) {
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

module.exports = {
  createObsidianBridge,
  handleObsidianAnnotations,
  handleObsidianNoteTitle,
  handleRegisterObsidianVault,
  handleSyncBack,
  recoverSessionFromAnnotationPayload,
};
