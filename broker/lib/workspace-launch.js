const path = require("path");
const { AMO_DIR, AMO_SCHEMA_VERSION } = require("./amo-constants");
const { readJsonFile, resolveWorkspacePath } = require("./filesystem");
const { httpError } = require("./http");
const { normalizeText } = require("./normalize");
const { launchCliInTerminal, spawnDetached } = require("./terminal-launch");

async function launchWorkspace(payload, options = {}) {
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};
  const launchStore = options.launchStore || null;
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const adapterId = normalizeText(payload?.adapterId || payload?.adapter_id || payload?.adapter);
  const resumeSessionId = normalizeText(payload?.sessionId || payload?.session_id || payload?.resumeSessionId || payload?.resume_session_id);
  const shellPreference = normalizeText(payload?.shellPreference || payload?.shell_preference) === "powershell7"
    ? "powershell7"
    : "windows-powershell";
  const supportedLaunchIds = new Set(["codex-cli", "claude-cli", "codex-app"]);
  if (!supportedLaunchIds.has(adapterId)) {
    throw httpError(400, "unsupported_launch_adapter", `Unsupported launch adapter: ${adapterId || "missing"}`);
  }
  if (adapterId !== "codex-app" && !launchStore) {
    throw httpError(503, "managed_launch_unavailable", "AMO cannot launch a CLI without its managed launch store");
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
  const managedLaunch = adapterId === "codex-app"
    ? null
    : launchStore.create({
        workspaceId: workspace.workspaceId,
        workspacePath,
        adapterId,
        mode: resumeSessionId ? "resume" : "new",
        requestedSessionId: resumeSessionId,
        sourceCardSessionId: normalizeText(payload?.sourceCardSessionId || payload?.source_card_session_id),
      });
  const title = managedLaunch
    ? `${managedLaunch.titleToken} ${adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} - ${projectName}`
    : `AMO ${adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} - ${projectName}`;
  const environment = managedLaunch
    ? {
        AMO_LAUNCH_ID: managedLaunch.launchId,
        AMO_WORKSPACE_ID: managedLaunch.workspaceId,
        AMO_WORKSPACE_PATH: managedLaunch.workspacePath,
        AMO_REQUESTED_SESSION_ID: resumeSessionId,
      }
    : {};
  let launch;
  try {
    if (managedLaunch) launchStore.update(managedLaunch.launchId, { state: "spawning" });
    if (adapterId === "codex-cli") {
      launch = await launchCliInTerminal({
        workspacePath,
        title,
        command: "codex",
        args: resumeSessionId ? ["resume", resumeSessionId, "-C", workspacePath] : [],
        environment,
        shellPreference,
        recordDebugLog,
      });
    } else if (adapterId === "claude-cli") {
      launch = await launchCliInTerminal({
        workspacePath,
        title,
        command: "claude",
        args: resumeSessionId ? ["--resume", resumeSessionId] : [],
        environment,
        shellPreference,
        recordDebugLog,
      });
    } else {
      launch = await spawnDetached("codex", ["app", workspacePath], workspacePath);
    }
    if (managedLaunch) launchStore.update(managedLaunch.launchId, { state: "waiting_hook", launchedPid: launch.pid || null });
  } catch (error) {
    if (managedLaunch) launchStore.update(managedLaunch.launchId, { state: "failed", error: error.message || String(error) });
    throw error;
  }

  recordDebugLog("broker", "workspace.launch", {
    workspacePath,
    adapterId,
    projectName,
    pid: launch.pid || null,
    command: launch.command,
    args: launch.args,
    resumeSessionId: resumeSessionId || null,
    launchId: managedLaunch?.launchId || null,
    titleToken: managedLaunch?.titleToken || null,
    shell: launch.shell || null,
    shellFallback: Boolean(launch.shellFallback),
  });

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
    shell: launch.shell || null,
    shellFallback: Boolean(launch.shellFallback),
    launch: managedLaunch ? launchStore.list().find((item) => item.launchId === managedLaunch.launchId) : null,
    windowHint: managedLaunch ? {
      title,
      titleToken: managedLaunch.titleToken,
      titleContains: [managedLaunch.titleToken],
      project: projectName,
      cwd: workspacePath,
      tool: adapterId === "claude-cli" ? "claude" : "codex",
      boundBy: "managed-launch",
    } : null,
    targetBinding: null,
    session: null,
    message:
      adapterId === "codex-app"
        ? `Opened Codex App for ${projectName}.`
        : resumeSessionId && adapterId === "codex-cli"
        ? `Launched Codex CLI resume for ${projectName}.`
        : `Launched ${adapterId === "codex-cli" ? "Codex CLI" : "Claude CLI"} for ${projectName}.`,
  };
}

module.exports = {
  launchWorkspace,
};
