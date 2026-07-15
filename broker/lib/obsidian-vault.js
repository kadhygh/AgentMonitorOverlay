const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { OBSIDIAN_PLUGIN_ID } = require("./amo-constants");
const { httpError } = require("./http");
const { readJsonFile, readJsonFileStrict, writeJsonFile } = require("./filesystem");
const { normalizeText } = require("./normalize");

const DEFAULT_CANVAS_APPEND_DIRECTION = "down";
const CANVAS_APPEND_DIRECTIONS = new Set(["down", "right"]);

function registerObsidianVault(vaultRoot, options = {}) {
  const registryPath = options.registryPath || obsidianRegistryPath();
  if (!registryPath) {
    throw httpError(409, "obsidian_registry_unavailable", "Could not locate the Obsidian registry path for this OS");
  }

  const existingRegistry = fs.existsSync(registryPath) ? readJsonFileStrict(registryPath) : {};
  if (
    typeof existingRegistry !== "object" ||
    Array.isArray(existingRegistry) ||
    (existingRegistry.vaults && typeof existingRegistry.vaults !== "object")
  ) {
    throw httpError(409, "invalid_obsidian_registry", `${registryPath} is not a supported Obsidian registry file`);
  }

  const vaults = existingRegistry.vaults || {};
  const normalizedVaultRoot = normalizeComparablePath(vaultRoot);
  let vaultId = Object.keys(vaults).find((id) => normalizeComparablePath(vaults[id]?.path) === normalizedVaultRoot);
  const alreadyRegistered = Boolean(vaultId);

  if (!vaultId) {
    vaultId = obsidianVaultIdForPath(vaultRoot);
    while (vaults[vaultId] && normalizeComparablePath(vaults[vaultId]?.path) !== normalizedVaultRoot) {
      vaultId = crypto.randomBytes(8).toString("hex");
    }
  }

  vaults[vaultId] = {
    ...(vaults[vaultId] || {}),
    path: vaultRoot,
    ts: Date.now(),
    open: true,
  };

  writeJsonFile(registryPath, {
    ...existingRegistry,
    vaults,
  });

  const runtimeConfigPath = path.join(path.dirname(registryPath), `${vaultId}.json`);
  const runtimeConfigExists = fs.existsSync(runtimeConfigPath);
  const vaultRuntimeState = inspectObsidianVaultRuntimeState(vaultRoot);
  const runtimeReady = runtimeConfigExists || vaultRuntimeState.loaded;
  const processCounter = options.countObsidianProcesses || countObsidianProcesses;

  return {
    ok: true,
    vaultRoot,
    vaultId,
    registryPath,
    runtimeConfigPath,
    runtimeConfigExists: runtimeReady,
    runtimeConfigFileExists: runtimeConfigExists,
    vaultRuntimeState,
    obsidianProcessCount: runtimeReady ? null : processCounter(),
    alreadyRegistered,
    changed: !alreadyRegistered,
  };
}

function inspectObsidianVaultRuntimeState(vaultRoot) {
  const obsidianDir = path.join(vaultRoot, ".obsidian");
  const evidenceFiles = ["workspace.json", "app.json", "core-plugins.json"];
  const evidence = evidenceFiles.map((fileName) => {
    const filePath = path.join(obsidianDir, fileName);
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return {
        fileName,
        path: filePath,
        exists: false,
        size: null,
        mtime: null,
      };
    }

    return {
      fileName,
      path: filePath,
      exists: stat.isFile(),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  });

  return {
    loaded: evidence.some((item) => item.exists),
    evidence,
  };
}

function countObsidianProcesses() {
  if (process.platform !== "win32") {
    return null;
  }

  try {
    const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq Obsidian.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      return null;
    }

    return result.stdout
      .split(/\r?\n/u)
      .filter((line) => /^"Obsidian\.exe"/iu.test(line.trim()))
      .length;
  } catch {
    return null;
  }
}

function obsidianRegistryPath() {
  if (process.platform === "win32") {
    return process.env.APPDATA ? path.join(process.env.APPDATA, "obsidian", "obsidian.json") : null;
  }

  if (process.platform === "darwin") {
    return process.env.HOME
      ? path.join(process.env.HOME, "Library", "Application Support", "obsidian", "obsidian.json")
      : null;
  }

  const configRoot =
    process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, ".config") : null);
  return configRoot ? path.join(configRoot, "obsidian", "obsidian.json") : null;
}

function obsidianVaultIdForPath(vaultRoot) {
  return crypto.createHash("sha256").update(normalizeComparablePath(vaultRoot)).digest("hex").slice(0, 16);
}

function normalizeComparablePath(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function installObsidianPlugin(vaultRoot, workspacePath, options = {}) {
  const pluginId = normalizeText(options.pluginId) || OBSIDIAN_PLUGIN_ID;
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });

  copyObsidianPluginAsset(pluginId, "manifest.json", pluginDir);
  copyObsidianPluginAsset(pluginId, "main.js", pluginDir);
  copyObsidianPluginAsset(pluginId, "styles.css", pluginDir);
  const pluginDataPath = path.join(pluginDir, "data.json");
  const existingPluginData = readJsonFile(pluginDataPath, {});
  const personalShortcutProfile = normalizeText(process.env.AGENT_MONITOR_SHORTCUT_PROFILE) === "kadhygh";
  writeJsonFile(path.join(pluginDir, "data.json"), {
    ...existingPluginData,
    bridgeUrl: normalizeText(options.bridgeUrl) || "",
    numberAnnotationsInPrompt: Boolean(existingPluginData.numberAnnotationsInPrompt),
    contextMouseShortcutEnabled:
      typeof existingPluginData.contextMouseShortcutEnabled === "boolean"
        ? existingPluginData.contextMouseShortcutEnabled
        : personalShortcutProfile,
    contextMouseShortcutButton:
      existingPluginData.contextMouseShortcutButton === "mouse4" ? "mouse4" : "mouse5",
    contextMouseShortcutRequireCtrl:
      typeof existingPluginData.contextMouseShortcutRequireCtrl === "boolean"
        ? existingPluginData.contextMouseShortcutRequireCtrl
        : true,
    canvasAppendDirection: normalizeCanvasAppendDirection(existingPluginData.canvasAppendDirection),
    hideAmoNoteProperties: existingPluginData.hideAmoNoteProperties !== false,
    interceptLocalCodeLinks: existingPluginData.interceptLocalCodeLinks !== false,
    localCodeLinkEditor: normalizeLocalCodeLinkEditor(existingPluginData.localCodeLinkEditor),
    localCodeLinkUrlTemplate:
      normalizeText(existingPluginData.localCodeLinkUrlTemplate) || "vscode://file/{path}:{line}",
    zedCommand: normalizeText(existingPluginData.zedCommand) || "zed",
  });

  enableObsidianPlugin(vaultRoot, pluginId);

  return {
    installedFiles: [
      workspaceRelativePath(workspacePath, path.join(vaultRoot, ".obsidian", "community-plugins.json")),
      workspaceRelativePath(workspacePath, path.join(pluginDir, "manifest.json")),
      workspaceRelativePath(workspacePath, path.join(pluginDir, "main.js")),
      workspaceRelativePath(workspacePath, path.join(pluginDir, "styles.css")),
      workspaceRelativePath(workspacePath, path.join(pluginDir, "data.json")),
    ],
  };
}

function copyObsidianPluginAsset(pluginId, fileName, pluginDir) {
  const sourcePath = path.join(__dirname, "..", "assets", "obsidian", pluginId, fileName);
  if (!fs.existsSync(sourcePath)) {
    throw httpError(500, "missing_obsidian_plugin_asset", `Missing Obsidian plugin asset: ${sourcePath}`);
  }

  fs.copyFileSync(sourcePath, path.join(pluginDir, fileName));
}

function enableObsidianPlugin(vaultRoot, pluginId = OBSIDIAN_PLUGIN_ID) {
  const communityPluginsPath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
  let enabledPlugins = [];
  if (fs.existsSync(communityPluginsPath)) {
    enabledPlugins = readJsonFileStrict(communityPluginsPath);
    if (!Array.isArray(enabledPlugins)) {
      throw httpError(409, "invalid_obsidian_plugin_config", `${communityPluginsPath} must be a JSON array`);
    }
  }

  if (!enabledPlugins.includes(pluginId)) {
    enabledPlugins.push(pluginId);
  }

  writeJsonFile(communityPluginsPath, enabledPlugins);
}

function attachObsidianPluginHealth(session, healthCache, options = {}) {
  const vaultRoot = normalizeText(session.vaultRoot || session.pendingAnnotationSource?.vaultRoot);
  if (!vaultRoot) {
    return session;
  }

  const cacheKey = normalizeComparablePath(vaultRoot);
  if (!healthCache.has(cacheKey)) {
    healthCache.set(cacheKey, inspectObsidianPluginHealth(vaultRoot, options));
  }

  return {
    ...session,
    obsidianPluginHealth: healthCache.get(cacheKey),
  };
}

function inspectObsidianPluginHealth(vaultRoot, options = {}) {
  const pluginId = normalizeText(options.pluginId) || OBSIDIAN_PLUGIN_ID;
  const checkedAt = new Date().toISOString();
  const expectedBridgeUrl = normalizeText(options.expectedBridgeUrl || options.bridgeUrl) || "";
  const expectedVersion = expectedObsidianPluginVersion(pluginId);
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", pluginId);
  const manifestPath = path.join(pluginDir, "manifest.json");
  const mainPath = path.join(pluginDir, "main.js");
  const dataPath = path.join(pluginDir, "data.json");
  const communityPluginsPath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
  const issues = [];

  const vaultExists = fs.existsSync(vaultRoot);
  const installed = fs.existsSync(pluginDir);
  const manifest = readJsonFile(manifestPath, null);
  const installedVersion = normalizeText(manifest?.version);
  const communityPlugins = readJsonFile(communityPluginsPath, null);
  const enabled = Array.isArray(communityPlugins) && communityPlugins.includes(pluginId);
  const pluginData = readJsonFile(dataPath, null);
  const dataBridgeUrl = normalizeText(pluginData?.bridgeUrl);
  const mainJsExists = fs.existsSync(mainPath);

  if (!vaultExists) issues.push("vault root is missing");
  if (!installed) issues.push("plugin directory is missing");
  if (!manifest) issues.push("manifest.json is missing or invalid");
  if (expectedVersion && installedVersion !== expectedVersion) {
    issues.push(`plugin version is ${installedVersion || "missing"}, expected ${expectedVersion}`);
  }
  if (!enabled) issues.push("plugin is not enabled in community-plugins.json");
  if (!mainJsExists) issues.push("main.js is missing");
  if (dataBridgeUrl !== expectedBridgeUrl) {
    issues.push(`bridge URL is ${dataBridgeUrl || "missing"}, expected ${expectedBridgeUrl}`);
  }

  const ok = issues.length === 0;
  const status = ok ? "ok" : installed ? "warning" : "missing";
  return {
    ok,
    status,
    pluginId,
    vaultRoot,
    installed,
    enabled,
    expectedVersion: expectedVersion || null,
    installedVersion: installedVersion || null,
    expectedBridgeUrl,
    dataBridgeUrl: dataBridgeUrl || null,
    mainJsExists,
    issues,
    checkedAt,
  };
}

function expectedObsidianPluginVersion(pluginId = OBSIDIAN_PLUGIN_ID) {
  const manifest = readJsonFile(path.join(__dirname, "..", "assets", "obsidian", pluginId, "manifest.json"), {});
  return normalizeText(manifest.version);
}

function normalizeCanvasAppendDirection(value) {
  const direction = normalizeText(value);
  if (!direction) {
    return DEFAULT_CANVAS_APPEND_DIRECTION;
  }
  const normalized = direction.toLowerCase();
  return CANVAS_APPEND_DIRECTIONS.has(normalized) ? normalized : DEFAULT_CANVAS_APPEND_DIRECTION;
}

function normalizeLocalCodeLinkEditor(value) {
  const editor = normalizeText(value);
  return editor === "zed" || editor === "custom-url" ? editor : "vscode";
}

function workspaceRelativePath(workspacePath, targetPath) {
  return path.relative(workspacePath, targetPath).split(path.sep).join("/");
}

module.exports = {
  attachObsidianPluginHealth,
  installObsidianPlugin,
  inspectObsidianVaultRuntimeState,
  inspectObsidianPluginHealth,
  normalizeComparablePath,
  normalizeCanvasAppendDirection,
  normalizeLocalCodeLinkEditor,
  obsidianRegistryPath,
  obsidianVaultIdForPath,
  registerObsidianVault,
};
