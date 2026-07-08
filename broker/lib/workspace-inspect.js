const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AMO_CANVAS_PATH,
  AMO_CANVASES_PATH,
  AMO_DEPLOYMENT_VERSION,
  AMO_DIR,
  AMO_HOOK_PROTOCOL_VERSION,
  AMO_SCHEMA_VERSION,
  AMO_SESSIONS_PATH,
  AMO_VAULT_NAME_PREFIX,
  AMO_WORK_CANVASES_PATH,
  OBSIDIAN_PLUGIN_ID,
} = require("./amo-constants");
const { isWritableDirectory, readDirectoryNames, readJsonFile, resolveWorkspacePath } = require("./filesystem");
const { normalizeText, normalizeTextArray, normalizeVersionNumber } = require("./normalize");
const { inspectWorkspaceGitExclude } = require("./workspace-git-exclude");
const { CODEX_HOOK_EVENTS } = require("../hooks/codex");
const { CLAUDE_HOOK_EVENTS } = require("../hooks/claude");

function amoVaultDirectoryName(projectName) {
  const cleaned = (normalizeText(projectName) || "workspace")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  const safeName = cleaned || "workspace";
  const maxProjectNameLength = 54;
  return `${AMO_VAULT_NAME_PREFIX}${safeName.slice(0, maxProjectNameLength)}`;
}

function defaultWorkspaceVaultRoot(amoRoot, projectName) {
  return path.join(amoRoot, amoVaultDirectoryName(projectName));
}

function resolveWorkspaceVaultRoot(amoRoot, workspace, projectName) {
  const configured = normalizeText(workspace?.vaultRoot || workspace?.vault_root);
  if (configured) {
    return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(amoRoot, configured);
  }

  return defaultWorkspaceVaultRoot(amoRoot, normalizeText(workspace?.projectName) || projectName);
}

function workspaceRelativePath(workspacePath, targetPath) {
  return path.relative(workspacePath, targetPath).split(path.sep).join("/");
}

function adapterConfigPath(amoRoot, adapterId) {
  return path.join(amoRoot, "adapters", `${adapterId}.json`);
}

function inspectHookConfigCoverage(workspacePath, relativePath, expectedEvents, hookMarker) {
  const configPath = path.join(workspacePath, relativePath);
  if (!fs.existsSync(configPath)) {
    return {
      hookConfigPath: relativePath,
      configuredHookEvents: [],
      missingHookEvents: [...expectedEvents],
      issues: [`${relativePath} is missing`],
    };
  }

  const config = readJsonFile(configPath, null);
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.hooks || typeof config.hooks !== "object") {
    return {
      hookConfigPath: relativePath,
      configuredHookEvents: [],
      missingHookEvents: [...expectedEvents],
      issues: [`${relativePath} does not contain a valid hooks object`],
    };
  }

  const configuredHookEvents = [];
  const missingHookEvents = [];
  for (const eventName of expectedEvents) {
    const hooksForEvent = config.hooks[eventName];
    if (Array.isArray(hooksForEvent) && JSON.stringify(hooksForEvent).includes(hookMarker)) {
      configuredHookEvents.push(eventName);
    } else {
      missingHookEvents.push(eventName);
    }
  }

  return {
    hookConfigPath: relativePath,
    configuredHookEvents,
    missingHookEvents,
    issues: missingHookEvents.length > 0 ? [`${relativePath} is missing AMO hook event(s): ${missingHookEvents.join(", ")}`] : [],
  };
}

function inspectAdapterDeployment(workspacePath, amoRoot, options) {
  const { adapterId, hookConfigPath, hookMarker, expectedHookEvents } = options;
  const config = readJsonFile(adapterConfigPath(amoRoot, adapterId), null);
  if (!config) {
    return {
      installed: false,
      deploymentStatus: "undeployed",
      expectedDeploymentVersion: AMO_DEPLOYMENT_VERSION,
      expectedHookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
      expectedHookEvents: [...expectedHookEvents],
      installedDeploymentVersion: null,
      installedHookProtocolVersion: null,
      configuredHookEvents: [],
      missingHookEvents: [],
      deploymentIssues: [],
    };
  }

  const installedDeploymentVersion = normalizeVersionNumber(config.deploymentVersion);
  const installedHookProtocolVersion = normalizeVersionNumber(config.hookProtocolVersion);
  const metadataHookEvents = normalizeTextArray(config.hookEvents);
  const metadataMissingHookEvents = expectedHookEvents.filter((eventName) => !metadataHookEvents.includes(eventName));
  const coverage = inspectHookConfigCoverage(workspacePath, hookConfigPath, expectedHookEvents, hookMarker);
  const issues = [];

  if (installedDeploymentVersion !== AMO_DEPLOYMENT_VERSION) {
    issues.push(`deployment version is ${installedDeploymentVersion ?? "missing"}, expected ${AMO_DEPLOYMENT_VERSION}`);
  }
  if (installedHookProtocolVersion !== AMO_HOOK_PROTOCOL_VERSION) {
    issues.push(`hook protocol is ${installedHookProtocolVersion ?? "missing"}, expected ${AMO_HOOK_PROTOCOL_VERSION}`);
  }
  if (metadataMissingHookEvents.length > 0) {
    issues.push(`adapter metadata is missing hook event(s): ${metadataMissingHookEvents.join(", ")}`);
  }
  issues.push(...coverage.issues);

  return {
    installed: true,
    deploymentStatus: issues.length > 0 ? "needs-update" : "deployed",
    expectedDeploymentVersion: AMO_DEPLOYMENT_VERSION,
    expectedHookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
    expectedHookEvents: [...expectedHookEvents],
    installedDeploymentVersion,
    installedHookProtocolVersion,
    configuredHookEvents: coverage.configuredHookEvents,
    missingHookEvents: Array.from(new Set([...metadataMissingHookEvents, ...coverage.missingHookEvents])),
    deploymentIssues: issues,
  };
}

function inspectWorkspace(payload) {
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const writable = isWritableDirectory(workspacePath);
  const workspaceId = workspaceIdFor(workspacePath);
  const projectName = path.basename(workspacePath);
  const amoRoot = path.join(workspacePath, AMO_DIR);
  const workspaceFile = path.join(amoRoot, "workspace.json");
  const existingWorkspace = readJsonFile(workspaceFile, null);
  const hasAmo = fs.existsSync(workspaceFile);
  const plannedVaultRoot = resolveWorkspaceVaultRoot(amoRoot, existingWorkspace, projectName);
  const plannedVaultRelativePath = workspaceRelativePath(workspacePath, plannedVaultRoot);
  const hasCodexDir = fs.existsSync(path.join(workspacePath, ".codex"));
  const hasCodexHooks = fs.existsSync(path.join(workspacePath, ".codex", "hooks.json"));
  const hasClaudeDir = fs.existsSync(path.join(workspacePath, ".claude"));
  const hasClaudeLocalSettings = fs.existsSync(path.join(workspacePath, ".claude", "settings.local.json"));
  const hasClaudeProjectSettings = fs.existsSync(path.join(workspacePath, ".claude", "settings.json"));
  const codexDeployment = inspectAdapterDeployment(workspacePath, amoRoot, {
    adapterId: "codex-cli",
    hookConfigPath: ".codex/hooks.json",
    hookMarker: "codex-stop-message.mjs",
    expectedHookEvents: CODEX_HOOK_EVENTS,
  });
  const claudeDeployment = inspectAdapterDeployment(workspacePath, amoRoot, {
    adapterId: "claude-cli",
    hookConfigPath: ".claude/settings.local.json",
    hookMarker: "claude-message.mjs",
    expectedHookEvents: CLAUDE_HOOK_EVENTS,
  });
  const hasCodexAdapter = codexDeployment.installed;
  const hasClaudeAdapter = claudeDeployment.installed;
  const gitExclude = inspectWorkspaceGitExclude(
    workspacePath,
    payload?.gitRootPath || payload?.git_root_path,
    Boolean(payload?.includeClaudeSettingsLocal || payload?.include_claude_settings_local)
  );
  const rootIndicators = [".git", "package.json", "pyproject.toml", "Cargo.toml"].filter((name) => {
    return fs.existsSync(path.join(workspacePath, name));
  });
  const workspaceEntries = readDirectoryNames(workspacePath);
  const isEmptyWorkspace = workspaceEntries.length === 0;
  const workspaceState = isEmptyWorkspace ? "empty" : rootIndicators.length > 0 ? "project" : "folder";

  const evidence = [];
  if (hasAmo) evidence.push("existing .amo workspace metadata found");
  if (hasCodexAdapter) evidence.push("existing Codex CLI adapter metadata found");
  if (hasClaudeAdapter) evidence.push("existing Claude CLI adapter metadata found");
  if (hasCodexDir) evidence.push("existing .codex directory found");
  if (hasCodexHooks) evidence.push("existing .codex/hooks.json found and will be merged");
  if (hasClaudeDir) evidence.push("existing .claude directory found");
  if (hasClaudeLocalSettings) evidence.push("existing .claude/settings.local.json found and will be merged");
  if (hasClaudeProjectSettings) evidence.push("existing .claude/settings.json found");
  if (rootIndicators.length > 0) evidence.push(`project indicators: ${rootIndicators.join(", ")}`);
  if (isEmptyWorkspace) evidence.push("workspace folder is empty");
  if (writable) evidence.push("workspace is writable");

  const codexStatus = writable ? "available" : "blocked";
  const claudeStatus = writable ? "available" : "blocked";
  const codexConfidence = hasCodexDir || hasCodexHooks ? "configured" : rootIndicators.length > 0 ? "project" : workspaceState;
  const claudeConfidence =
    hasClaudeDir || hasClaudeLocalSettings || hasClaudeProjectSettings ? "configured" : rootIndicators.length > 0 ? "project" : workspaceState;
  const codexDeploymentStatus = codexDeployment.deploymentStatus;
  const claudeDeploymentStatus = claudeDeployment.deploymentStatus;
  const recommended = !isEmptyWorkspace;
  const commonDirectoriesToCreate = [
    ".amo",
    ".amo/adapters",
    ".amo/hooks",
    ".amo/state",
    ".amo/logs",
    ".amo/backups",
    plannedVaultRelativePath,
    `${plannedVaultRelativePath}/${AMO_SESSIONS_PATH}`,
    `${plannedVaultRelativePath}/${AMO_CANVASES_PATH}`,
    `${plannedVaultRelativePath}/${AMO_WORK_CANVASES_PATH}`,
    `${plannedVaultRelativePath}/.obsidian`,
    `${plannedVaultRelativePath}/.obsidian/plugins`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}`,
  ];
  const commonFilesToWrite = [
    ".amo/workspace.json",
    ".amo/enrollment.json",
    `${plannedVaultRelativePath}/${AMO_CANVAS_PATH}`,
    `${plannedVaultRelativePath}/.obsidian/community-plugins.json`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/manifest.json`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/main.js`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/styles.css`,
    `${plannedVaultRelativePath}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/data.json`,
    ".amo/.gitignore",
  ];

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    deploymentVersion: AMO_DEPLOYMENT_VERSION,
    hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
    workspaceId,
    workspacePath,
    projectName,
    existingEnrollment: hasAmo,
    deploymentRoot: AMO_DIR,
    gitExclude,
    supportedAdapters: [
      {
        id: "codex-cli",
        label: "Codex CLI",
        status: codexStatus,
        deploymentStatus: codexDeploymentStatus,
        workspaceState,
        deployable: writable,
        recommended,
        confidence: codexConfidence,
        scope: "project-local",
        installedDeploymentVersion: codexDeployment.installedDeploymentVersion,
        expectedDeploymentVersion: codexDeployment.expectedDeploymentVersion,
        installedHookProtocolVersion: codexDeployment.installedHookProtocolVersion,
        expectedHookProtocolVersion: codexDeployment.expectedHookProtocolVersion,
        expectedHookEvents: codexDeployment.expectedHookEvents,
        configuredHookEvents: codexDeployment.configuredHookEvents,
        missingHookEvents: codexDeployment.missingHookEvents,
        deploymentIssues: codexDeployment.deploymentIssues,
        reason: adapterDeploymentReason({
          writable,
          installed: hasCodexAdapter,
          deploymentStatus: codexDeploymentStatus,
          deploymentIssues: codexDeployment.deploymentIssues,
          empty: isEmptyWorkspace,
          label: "Codex CLI",
          hookDescription: "project-local lifecycle hook adapter",
        }),
        evidence,
        directoriesToCreate: [...commonDirectoriesToCreate, ".codex"],
        filesToWrite: [
          ".amo/adapters/codex-cli.json",
          ".amo/hooks/codex-stop-message.mjs",
          ...commonFilesToWrite,
        ],
        filesToMerge: [".codex/hooks.json"],
        risks: [
          "Codex may require trust/review for project-local hooks in this workspace.",
          "Codex hook payloads do not provide native HWND/PID; window routing should use title/project hints unless separately bound.",
        ],
      },
      {
        id: "claude-cli",
        label: "Claude CLI",
        status: claudeStatus,
        deploymentStatus: claudeDeploymentStatus,
        workspaceState,
        deployable: writable,
        recommended,
        confidence: claudeConfidence,
        scope: "project-local",
        installedDeploymentVersion: claudeDeployment.installedDeploymentVersion,
        expectedDeploymentVersion: claudeDeployment.expectedDeploymentVersion,
        installedHookProtocolVersion: claudeDeployment.installedHookProtocolVersion,
        expectedHookProtocolVersion: claudeDeployment.expectedHookProtocolVersion,
        expectedHookEvents: claudeDeployment.expectedHookEvents,
        configuredHookEvents: claudeDeployment.configuredHookEvents,
        missingHookEvents: claudeDeployment.missingHookEvents,
        deploymentIssues: claudeDeployment.deploymentIssues,
        reason: adapterDeploymentReason({
          writable,
          installed: hasClaudeAdapter,
          deploymentStatus: claudeDeploymentStatus,
          deploymentIssues: claudeDeployment.deploymentIssues,
          empty: isEmptyWorkspace,
          label: "Claude CLI",
          hookDescription: ".claude/settings.local.json hooks for prompt/reply capture",
        }),
        evidence,
        directoriesToCreate: [...commonDirectoriesToCreate, ".claude"],
        filesToWrite: [
          ".amo/adapters/claude-cli.json",
          ".amo/hooks/claude-message.mjs",
          ...commonFilesToWrite,
        ],
        filesToMerge: [".claude/settings.local.json"],
        risks: [
          "Claude Code may require reviewing hooks with /hooks before first use.",
          "Claude hook payloads do not provide native HWND/PID; window routing should use title/project hints unless separately bound.",
          "AMO writes only .claude/settings.local.json so the hook stays local to this machine.",
        ],
      },
    ],
    deferredAdapters: [
      deferredAdapter("codex-app", "Codex App", "Direct Codex App integration is deferred until its local control surface is defined."),
      deferredAdapter("kiro-ide", "Kiro IDE", "Kiro IDE hook install target and payload shape still need local verification."),
    ],
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

function adapterDeploymentReason({ writable, installed, deploymentStatus, deploymentIssues = [], empty, label, hookDescription }) {
  if (!writable) {
    return "Workspace is not writable.";
  }
  if (installed && deploymentStatus === "needs-update") {
    const issue = deploymentIssues[0] ? ` ${deploymentIssues[0]}.` : "";
    return `${label} adapter is installed but needs hook update.${issue}`;
  }
  if (installed) {
    return `${label} adapter is already deployed in this workspace.`;
  }
  if (empty) {
    return `Workspace folder is empty; ${label} adapter has not been deployed here yet.`;
  }
  return `${label} can deploy ${hookDescription} in this workspace.`;
}

function isDeployableAdapterPlan(plan) {
  if (typeof plan?.deployable === "boolean") {
    return plan.deployable;
  }
  return plan?.status === "available";
}

function normalizeAdapterIds(value) {
  if (Array.isArray(value)) {
    const ids = value.map(normalizeText).filter(Boolean);
    return ids.length > 0 ? ids : ["codex-cli"];
  }

  const id = normalizeText(value);
  return id ? [id] : ["codex-cli"];
}

function workspaceIdFor(workspacePath) {
  const digest = crypto.createHash("sha256").update(workspacePath.toLowerCase()).digest("hex").slice(0, 12);
  return `ws_${digest}`;
}

module.exports = {
  adapterConfigPath,
  adapterDeploymentReason,
  amoVaultDirectoryName,
  defaultWorkspaceVaultRoot,
  deferredAdapter,
  inspectAdapterDeployment,
  inspectHookConfigCoverage,
  inspectWorkspace,
  isDeployableAdapterPlan,
  normalizeAdapterIds,
  resolveWorkspaceVaultRoot,
  workspaceIdFor,
  workspaceRelativePath,
};
