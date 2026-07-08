const crypto = require("crypto");
const path = require("path");
const { AMO_DIR, AMO_SCHEMA_VERSION } = require("./amo-constants");
const { readJsonFile, resolveWorkspacePath } = require("./filesystem");
const { httpError } = require("./http");
const { normalizeText } = require("./normalize");
const { normalizeTargetBinding } = require("./target-binding");
const { launchCliInTerminal, spawnDetached } = require("./terminal-launch");
const { sanitizeFilePart } = require("./text-format");

async function launchWorkspace(payload, options = {}) {
  const sessions = options.sessions instanceof Map ? options.sessions : new Map();
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const adapterId = normalizeText(payload?.adapterId || payload?.adapter_id || payload?.adapter);
  const resumeSessionId = normalizeText(payload?.sessionId || payload?.session_id || payload?.resumeSessionId || payload?.resume_session_id);
  const supportedLaunchIds = new Set(["codex-cli", "claude-cli", "codex-app"]);
  if (!supportedLaunchIds.has(adapterId)) {
    throw httpError(400, "unsupported_launch_adapter", `Unsupported launch adapter: ${adapterId || "missing"}`);
  }

  const amoRoot = path.join(workspacePath, AMO_DIR);
  const workspace = readJsonFile(path.join(amoRoot, "workspace.json"), null);
  if (!workspace || !workspace.workspaceId) {
    throw httpError(400, "workspace_not_enrolled", "Selected workspace does not have AMO enrollment metadata");
  }

  if (adapterId !== "codex-app") {
    const enrollment = readJsonFile(path.join(amoRoot, "enrollment.json"), null);
    const installedAdapters = Array.isArray(enrollment?.adapters) ? enrollment.adapters : [];
    const installed = installedAdapters.some((adapter) => normalizeText(adapter?.id) === adapterId);
    if (!installed) {
      throw httpError(400, "adapter_not_installed", `${adapterId} is not deployed in this workspace`);
    }
  }

  const projectName = path.basename(workspacePath);
  const startedAt = new Date().toISOString();
  const codexLaunchRoute =
    adapterId === "codex-cli" && resumeSessionId
      ? codexCliLaunchRoute({ workspacePath, projectName, sessionId: resumeSessionId })
      : null;
  let launch;
  if (adapterId === "codex-cli") {
    launch = await launchCliInTerminal({
      workspacePath,
      title: codexLaunchRoute?.title || `AMO Codex CLI - ${projectName}`,
      command: "codex",
      args: resumeSessionId ? ["resume", resumeSessionId] : [],
      recordDebugLog,
    });
  } else if (adapterId === "claude-cli") {
    launch = await launchCliInTerminal({
      workspacePath,
      title: `AMO Claude CLI - ${projectName}`,
      command: "claude",
      args: [],
      recordDebugLog,
    });
  } else {
    launch = await spawnDetached("codex", ["app", workspacePath], workspacePath);
  }

  recordDebugLog("broker", "workspace.launch", {
    workspacePath,
    adapterId,
    projectName,
    pid: launch.pid || null,
    command: launch.command,
    args: launch.args,
    resumeSessionId: resumeSessionId || null,
    titleToken: codexLaunchRoute?.windowHint.titleToken || null,
  });

  const launchedSession =
    codexLaunchRoute
      ? bindLaunchedCodexCliTarget({
          sessions,
          recordDebugLog,
          sessionId: resumeSessionId,
          workspacePath,
          projectName,
          windowHint: codexLaunchRoute.windowHint,
          launchedAt: startedAt,
          launch,
        })
      : null;

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    workspaceId: workspace.workspaceId,
    workspacePath,
    adapterId,
    projectName,
    launchedAt: startedAt,
    pid: launch.pid || null,
    command: launch.command,
    args: launch.args,
    windowHint: launchedSession?.windowHint || codexLaunchRoute?.windowHint || null,
    targetBinding: launchedSession?.targetBinding || null,
    session: launchedSession,
    message:
      adapterId === "codex-app"
        ? `Opened Codex App for ${projectName}.`
        : resumeSessionId && adapterId === "codex-cli"
        ? `Launched Codex CLI resume for ${projectName}.`
        : `Launched ${adapterId === "codex-cli" ? "Codex CLI" : "Claude CLI"} for ${projectName}.`,
  };
}

function codexCliLaunchRoute({ workspacePath, projectName, sessionId }) {
  const projectSlug = sanitizeFilePart(projectName).toLowerCase();
  const sessionSlug = crypto.createHash("sha1").update(sessionId).digest("hex").slice(0, 10);
  const titleToken = `[AMO:codex:${projectSlug}:${sessionSlug}]`;
  const title = `${titleToken} Codex CLI - ${projectName}`;

  return {
    title,
    windowHint: {
      process: null,
      title,
      titleToken,
      titleContains: ["Codex", projectName, sessionId],
      project: projectName,
      cwd: workspacePath,
      tool: "codex",
      pid: null,
      hwnd: null,
      boundAt: null,
      boundBy: "workspace-launch",
      boundLabel: title,
    },
  };
}

function bindLaunchedCodexCliTarget({ sessions, recordDebugLog, sessionId, workspacePath, projectName, windowHint, launchedAt, launch }) {
  const existing = sessions.get(sessionId);
  if (!existing) {
    return null;
  }

  const boundHint = {
    ...(existing.windowHint || {}),
    ...windowHint,
    pid: null,
    hwnd: null,
    boundAt: launchedAt,
    boundBy: "workspace-launch",
    boundLabel: windowHint.boundLabel || windowHint.title || `Codex CLI - ${projectName}`,
  };
  const targetBinding = normalizeTargetBinding(
    {
      type: "codex-cli-session",
      label: "Codex CLI",
      sessionId,
      workspacePath,
      boundAt: launchedAt,
      boundBy: "workspace-launch",
    },
    sessionId,
    launchedAt
  );
  const session = {
    ...existing,
    cwd: existing.cwd || workspacePath,
    workspacePath: existing.workspacePath || workspacePath,
    windowHint: boundHint,
    targetBinding,
    lastEvent: "TargetLaunched",
    lastMessage: `Launched Codex CLI target for ${projectName}.`,
    updatedAt: launchedAt,
    eventCount: (existing.eventCount || 0) + 1,
    processInfo: {
      ...(existing.processInfo || {}),
      launchedPid: launch?.pid || null,
      launchedCommand: launch?.command || null,
      launchedArgs: Array.isArray(launch?.args) ? launch.args : [],
      launchedAt,
    },
  };

  sessions.set(sessionId, session);
  recordDebugLog("broker", "workspace.launch.target_bound", {
    sessionId,
    workspacePath,
    titleToken: boundHint.titleToken || null,
    launchedPid: launch?.pid || null,
  });

  return session;
}

module.exports = {
  bindLaunchedCodexCliTarget,
  codexCliLaunchRoute,
  launchWorkspace,
};
