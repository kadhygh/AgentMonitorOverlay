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
  OBSIDIAN_PLUGIN_ID,
} = require("./amo-constants");
const { ensureCanvas } = require("./canvas-writer");
const { ensureInsideDirectory, readJsonFile, resolveWorkspacePath, writeJsonFile } = require("./filesystem");
const { httpError } = require("./http");
const { normalizeText } = require("./normalize");
const { installObsidianPlugin, inspectObsidianPluginHealth, normalizeComparablePath } = require("./obsidian-vault");
const { resolveWorkspaceVaultRoot } = require("./workspace-inspect");

function inspectWorkspaceMaintenance(payload, options = {}) {
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const status = workspaceMaintenanceSnapshot(workspacePath, options);
  recordDebugLog("broker", "workspace.maintenance.status", {
    workspacePath,
    issueCount: status.issues.length,
    replyNotes: status.counts.replyNotes,
    promptNotes: status.counts.promptNotes,
  });
  return status;
}

function cleanWorkspaceVault(payload, options = {}) {
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const statusBefore = workspaceMaintenanceSnapshot(workspacePath, options);
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

  const clearedSessions = clearWorkspaceBridgeState(workspacePath, vaultRoot, options);
  const statusAfter = workspaceMaintenanceSnapshot(workspacePath, options);
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

function updateWorkspaceObsidianPlugin(payload, options = {}) {
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const statusBefore = workspaceMaintenanceSnapshot(workspacePath, options);
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

  const pluginInstall = installObsidianPlugin(vaultRoot, workspacePath, { bridgeUrl: expectedBridgeUrl(options.baseUrl) });
  const statusAfter = workspaceMaintenanceSnapshot(workspacePath, options);
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

function workspaceMaintenanceSnapshot(workspacePath, options = {}) {
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
  const pluginHealth = inspectObsidianPluginHealth(vaultRoot, { expectedBridgeUrl: expectedBridgeUrl(options.baseUrl) });
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

function clearWorkspaceBridgeState(workspacePath, vaultRoot, options = {}) {
  const sessions = options.sessions instanceof Map ? options.sessions : new Map();
  const publishSessionChanged = typeof options.publishSessionChanged === "function" ? options.publishSessionChanged : () => {};
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

function expectedBridgeUrl(baseUrl) {
  return typeof baseUrl === "function" ? baseUrl() : baseUrl;
}

module.exports = {
  cleanWorkspaceVault,
  clearWorkspaceBridgeState,
  countConversationGeneratedNotes,
  countFilesByExtension,
  inspectCanvasFile,
  inspectWorkspaceMaintenance,
  resetWorkspaceCanvasBindings,
  resetWorkspaceNoteIndex,
  updateWorkspaceObsidianPlugin,
  workspaceMaintenanceSnapshot,
};
