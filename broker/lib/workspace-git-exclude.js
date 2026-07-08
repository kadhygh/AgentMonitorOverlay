const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { AMO_SCHEMA_VERSION } = require("./amo-constants");
const { httpError } = require("./http");
const {
  findNearestGitRoot,
  isSameOrDescendantPath,
  resolveDirectoryPath,
  resolveGitDirectoryPath,
  resolveWorkspacePath,
} = require("./filesystem");
const { normalizeText } = require("./normalize");

function updateWorkspaceGitExclude(payload, options = {}) {
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const includeClaudeSettingsLocal = Boolean(payload?.includeClaudeSettingsLocal || payload?.include_claude_settings_local);
  const plan = resolveWorkspaceGitExcludePlan(workspacePath, payload?.gitRootPath || payload?.git_root_path, {
    includeClaudeSettingsLocal,
  });
  const excludeFile = plan.excludeFilePath;
  const rawBefore = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  const lineSet = new Set(
    rawBefore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  );

  const addedEntries = [];
  const existingEntries = [];
  for (const entry of plan.entries) {
    if (lineSet.has(entry.pattern)) {
      existingEntries.push(entry);
    } else {
      addedEntries.push(entry);
    }
  }

  if (addedEntries.length > 0) {
    const needsSeparator = rawBefore.length > 0 && !rawBefore.endsWith("\n");
    const lines = [];
    if (needsSeparator) lines.push("");
    if (!rawBefore.includes("# AMO local deployment artifacts")) {
      lines.push("# AMO local deployment artifacts");
    }
    for (const entry of addedEntries) {
      lines.push(entry.pattern);
    }
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `${lines.join("\n")}\n`, "utf8");
  }

  const status = inspectWorkspaceGitExclude(workspacePath, plan.gitRootPath, includeClaudeSettingsLocal);
  recordDebugLog("broker", "workspace.git_exclude.updated", {
    workspacePath,
    gitRootPath: plan.gitRootPath,
    excludeFilePath: excludeFile,
    addedEntries: addedEntries.map((entry) => entry.pattern),
    existingEntries: existingEntries.map((entry) => entry.pattern),
  });

  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    changed: addedEntries.length > 0,
    workspacePath,
    gitRootPath: plan.gitRootPath,
    gitDirPath: plan.gitDirPath,
    excludeFilePath: excludeFile,
    workspaceRelativePath: plan.workspaceRelativePath,
    entries: plan.entries,
    addedEntries,
    existingEntries,
    includeClaudeSettingsLocal,
    status,
  };
}

function inspectWorkspaceGitExclude(workspacePath, requestedGitRootPath = "", includeClaudeSettingsLocal = false) {
  try {
    const plan = resolveWorkspaceGitExcludePlan(workspacePath, requestedGitRootPath, {
      allowMissing: true,
      includeClaudeSettingsLocal,
    });
    if (!plan.gitRootPath) {
      return {
        ok: false,
        status: "not-found",
        gitRootPath: "",
        gitDirPath: "",
        excludeFilePath: "",
        workspaceRelativePath: "",
        entries: defaultWorkspaceGitExcludeEntries("", includeClaudeSettingsLocal),
        missingEntries: [],
        existingEntries: [],
        trackedEntries: [],
        message: "No parent Git repository was detected for this workspace.",
      };
    }

    const excludeText = fs.existsSync(plan.excludeFilePath) ? fs.readFileSync(plan.excludeFilePath, "utf8") : "";
    const lineSet = new Set(
      excludeText
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    );
    const existingEntries = plan.entries.filter((entry) => lineSet.has(entry.pattern));
    const missingEntries = plan.entries.filter((entry) => !lineSet.has(entry.pattern));
    const trackedEntries = trackedWorkspaceGitExcludeEntries(plan);
    const status = missingEntries.length > 0 ? "missing" : trackedEntries.length > 0 ? "tracked" : "covered";
    return {
      ok: true,
      status,
      gitRootPath: plan.gitRootPath,
      gitDirPath: plan.gitDirPath,
      excludeFilePath: plan.excludeFilePath,
      workspaceRelativePath: plan.workspaceRelativePath,
      entries: plan.entries,
      missingEntries,
      existingEntries,
      trackedEntries,
      includeClaudeSettingsLocal,
      message:
        missingEntries.length > 0
          ? `${missingEntries.length} AMO Git exclude pattern(s) can be added.`
          : trackedEntries.length > 0
          ? `${trackedEntries.length} covered pattern(s) still match tracked Git files. Remove them from the index if they should disappear from status.`
          : "AMO local artifacts are already covered by Git exclude.",
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      gitRootPath: normalizeText(requestedGitRootPath) || "",
      gitDirPath: "",
      excludeFilePath: "",
      workspaceRelativePath: "",
      entries: [],
      missingEntries: [],
      existingEntries: [],
      trackedEntries: [],
      includeClaudeSettingsLocal,
      message: error?.message || "Could not inspect Git exclude.",
    };
  }
}

function resolveWorkspaceGitExcludePlan(workspacePath, requestedGitRootPath = "", options = {}) {
  const explicitRoot = normalizeText(requestedGitRootPath);
  const gitRootPath = explicitRoot
    ? resolveDirectoryPath(explicitRoot, "gitRootPath", "git_root_path")
    : findNearestGitRoot(workspacePath);

  if (!gitRootPath) {
    if (options.allowMissing) {
      return {
        gitRootPath: "",
        gitDirPath: "",
        excludeFilePath: "",
        workspaceRelativePath: "",
        entries: [],
      };
    }
    throw httpError(404, "git_root_not_found", "No parent Git repository was detected for this workspace.");
  }

  const gitDirPath = resolveGitDirectoryPath(gitRootPath);
  if (!gitDirPath) {
    throw httpError(400, "not_git_root", `Selected Git root does not contain a .git directory or gitdir file: ${gitRootPath}`);
  }

  if (!isSameOrDescendantPath(gitRootPath, workspacePath)) {
    throw httpError(
      400,
      "workspace_outside_git_root",
      `Workspace path must be inside the selected Git root. Git root: ${gitRootPath}; workspace: ${workspacePath}`
    );
  }

  const workspaceRelativePath = path.relative(gitRootPath, workspacePath).split(path.sep).join("/");
  return {
    gitRootPath,
    gitDirPath,
    excludeFilePath: path.join(gitDirPath, "info", "exclude"),
    workspaceRelativePath,
    entries: defaultWorkspaceGitExcludeEntries(workspaceRelativePath, Boolean(options.includeClaudeSettingsLocal)),
  };
}

function defaultWorkspaceGitExcludeEntries(workspaceRelativePath, includeClaudeSettingsLocal = false) {
  const prefix = normalizeGitExcludePrefix(workspaceRelativePath);
  const entries = [
    {
      pattern: gitExcludePattern(prefix, ".amo/"),
      reason: "AMO workspace metadata, vault, hooks, logs, and generated notes",
    },
    {
      pattern: gitExcludePattern(prefix, ".codex/cache/"),
      reason: "Codex hook fallback cache for prompts, replies, and hook errors",
    },
    {
      pattern: gitExcludePattern(prefix, ".codex/hooks.json"),
      reason: "project-local AMO Codex hook registration",
    },
  ];

  if (includeClaudeSettingsLocal) {
    entries.push({
      pattern: gitExcludePattern(prefix, ".claude/settings.local.json"),
      reason: "machine-local Claude hook registration",
    });
  }

  return entries;
}

function normalizeGitExcludePrefix(value) {
  return (normalizeText(value) || "")
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
}

function gitExcludePattern(prefix, relativePath) {
  const directoryPattern = /[\\/]$/u.test(String(relativePath || ""));
  const normalizedRelativePath = normalizeGitExcludePrefix(relativePath);
  const body = [prefix, normalizedRelativePath].filter(Boolean).join("/");
  return `/${body}${directoryPattern ? "/" : ""}`;
}

function trackedWorkspaceGitExcludeEntries(plan) {
  if (!plan?.gitRootPath || !Array.isArray(plan.entries) || plan.entries.length === 0) return [];

  const trackedEntries = [];
  for (const entry of plan.entries) {
    const repoRelativePath = gitExcludePatternToRepoPath(entry.pattern);
    if (!repoRelativePath) continue;

    const result = spawnSync("git", ["-C", plan.gitRootPath, "ls-files", "--", repoRelativePath], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) continue;

    const trackedPaths = (normalizeText(result.stdout) || "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (trackedPaths.length === 0) continue;

    trackedEntries.push({
      ...entry,
      trackedPath: trackedPaths[0],
      trackedPaths,
    });
  }

  return trackedEntries;
}

function gitExcludePatternToRepoPath(pattern) {
  return normalizeGitExcludePrefix(pattern);
}

module.exports = {
  inspectWorkspaceGitExclude,
  resolveWorkspaceGitExcludePlan,
  updateWorkspaceGitExclude,
};
