const fs = require("fs");
const path = require("path");
const {
  AMO_CANVAS_PATH,
  AMO_CANVASES_PATH,
  AMO_DEPLOYMENT_VERSION,
  AMO_DIR,
  AMO_HOOK_PROTOCOL_VERSION,
  AMO_LAYOUT_VERSION,
  AMO_PROJECT_DOCS_PATH,
  AMO_SCHEMA_VERSION,
  AMO_SESSION_GENERATED_PATH,
  AMO_SESSIONS_PATH,
  AMO_WORK_CANVASES_PATH,
} = require("./amo-constants");
const { ensureCanvas } = require("./canvas-writer");
const { readJsonFile, writeJsonFile, writeTextFile } = require("./filesystem");
const { httpError } = require("./http");
const { normalizeText } = require("./normalize");
const { installObsidianPlugin } = require("./obsidian-vault");
const {
  inspectWorkspace,
  isDeployableAdapterPlan,
  normalizeAdapterIds,
  resolveWorkspaceVaultRoot,
  workspaceRelativePath,
} = require("./workspace-inspect");
const { CODEX_HOOK_EVENTS, codexReplyHookScript, mergeCodexHooks } = require("../hooks/codex");
const { CLAUDE_HOOK_EVENTS, claudeMessageHookScript, mergeClaudeSettings } = require("../hooks/claude");

function enrollWorkspace(payload, options = {}) {
  const bridgeBaseUrl = resolveBridgeBaseUrl(options.baseUrl);
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};
  const requestedAdapters = normalizeAdapterIds(payload?.adapters || payload?.adapterIds || payload?.adapter_ids);
  const supportedAdapterIds = new Set(["codex-cli", "claude-cli"]);
  const unsupported = requestedAdapters.filter((id) => !supportedAdapterIds.has(id));
  if (unsupported.length > 0) {
    throw httpError(400, "unsupported_adapter", `Unsupported MVP adapter(s): ${unsupported.join(", ")}`);
  }

  const inspection = inspectWorkspace(payload);
  const requestedPlans = requestedAdapters.map((id) => inspection.supportedAdapters.find((adapter) => adapter.id === id));
  const unavailablePlan = requestedPlans.find((plan) => !plan || !isDeployableAdapterPlan(plan));
  if (unavailablePlan) {
    throw httpError(
      400,
      "workspace_not_writable",
      `Workspace cannot be enrolled for ${unavailablePlan?.id || "requested adapter"} because it is not deployable.`
    );
  }

  const workspacePath = inspection.workspacePath;
  const now = new Date().toISOString();
  const amoRoot = path.join(workspacePath, AMO_DIR);
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
  const enrollmentFile = path.join(amoRoot, "enrollment.json");
  const existingWorkspace = readJsonFile(workspaceFile, null);
  const existingEnrollment = readJsonFile(enrollmentFile, null);
  const vaultRoot = resolveWorkspaceVaultRoot(amoRoot, existingWorkspace, inspection.projectName);
  writeJsonFile(workspaceFile, {
    schemaVersion: AMO_SCHEMA_VERSION,
    deploymentVersion: AMO_DEPLOYMENT_VERSION,
    hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
    workspaceId: inspection.workspaceId,
    workspacePath,
    projectName: inspection.projectName,
    createdAt: existingWorkspace?.createdAt || now,
    updatedAt: now,
    layoutVersion: AMO_LAYOUT_VERSION,
    amoRoot,
    vaultRoot,
    defaultCanvasPath: AMO_CANVAS_PATH,
    sessionsPath: AMO_SESSIONS_PATH,
    generatedTurnsPath: `${AMO_SESSIONS_PATH}/<session-id>/${AMO_SESSION_GENERATED_PATH}`,
    canvasesPath: AMO_CANVASES_PATH,
    workCanvasesPath: AMO_WORK_CANVASES_PATH,
    projectDocsPath: AMO_PROJECT_DOCS_PATH,
    documentMappings: Array.isArray(existingWorkspace?.documentMappings) ? existingWorkspace.documentMappings : [],
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
      deploymentVersion: AMO_DEPLOYMENT_VERSION,
      hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      hookEvents: CODEX_HOOK_EVENTS,
      installedAt: now,
      bridgeEventsUrl: `${bridgeBaseUrl}/api/events`,
      bridgeRepliesUrl: `${bridgeBaseUrl}/api/replies`,
      bridgePromptsUrl: `${bridgeBaseUrl}/api/prompts`,
      hookScriptPath,
      cacheFallbackPath: path.join(workspacePath, ".codex", "cache"),
    });
    installedFiles.push(".amo/adapters/codex-cli.json");

    writeTextFile(
      hookScriptPath,
      codexReplyHookScript({
        deploymentVersion: AMO_DEPLOYMENT_VERSION,
        hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      }),
    );
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
      deploymentVersion: AMO_DEPLOYMENT_VERSION,
      hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      hookEvents: CODEX_HOOK_EVENTS,
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
      deploymentVersion: AMO_DEPLOYMENT_VERSION,
      hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      hookEvents: CLAUDE_HOOK_EVENTS,
      installedAt: now,
      bridgeEventsUrl: `${bridgeBaseUrl}/api/events`,
      bridgeRepliesUrl: `${bridgeBaseUrl}/api/replies`,
      bridgePromptsUrl: `${bridgeBaseUrl}/api/prompts`,
      hookScriptPath,
      cacheFallbackPath: path.join(amoRoot, "logs", "claude-cache"),
    });
    installedFiles.push(".amo/adapters/claude-cli.json");

    writeTextFile(
      hookScriptPath,
      claudeMessageHookScript({
        deploymentVersion: AMO_DEPLOYMENT_VERSION,
        hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      }),
    );
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
      deploymentVersion: AMO_DEPLOYMENT_VERSION,
      hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      hookEvents: CLAUDE_HOOK_EVENTS,
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
  installedFiles.push(workspaceRelativePath(workspacePath, path.join(vaultRoot, AMO_CANVAS_PATH)));

  const pluginInstall = installObsidianPlugin(vaultRoot, workspacePath, { bridgeUrl: bridgeBaseUrl });
  installedFiles.push(...pluginInstall.installedFiles);

  const requestedAdapterIds = new Set(requestedAdapters);
  const preservedEnrollmentAdapters = Array.isArray(existingEnrollment?.adapters)
    ? existingEnrollment.adapters.filter((adapter) => !requestedAdapterIds.has(normalizeText(adapter?.id)))
    : [];

  writeJsonFile(enrollmentFile, {
    schemaVersion: AMO_SCHEMA_VERSION,
    deploymentVersion: AMO_DEPLOYMENT_VERSION,
    hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
    workspaceId: inspection.workspaceId,
    workspacePath,
    updatedAt: now,
    adapters: [...preservedEnrollmentAdapters, ...enrollmentAdapters],
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
    deploymentVersion: AMO_DEPLOYMENT_VERSION,
    hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
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

function resolveBridgeBaseUrl(baseUrl) {
  const value = typeof baseUrl === "function" ? baseUrl() : baseUrl;
  const normalized = normalizeText(value);
  if (!normalized) {
    throw httpError(500, "missing_bridge_url", "Workspace enrollment requires a broker bridge URL");
  }
  return normalized.replace(/\/+$/u, "");
}

function amoGitignore() {
  return [
    "state/",
    "logs/",
    "AMO - */Sessions/",
    "AMO - */Canvases/AgentFlow.base.canvas",
    "AMO - */Project/",
    "AMO - */Replies/",
    "AMO - */Prompts/",
    "AMO - */AgentFlow.canvas",
    "AMO - */.obsidian/workspace*.json",
    "",
  ].join("\n");
}

module.exports = {
  amoGitignore,
  enrollWorkspace,
  resolveBridgeBaseUrl,
};
