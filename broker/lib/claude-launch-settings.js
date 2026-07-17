const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const SETTINGS_SUFFIX = ".settings.json";

function defaultClaudeLaunchSettingsRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "AgentMonitorOverlay", "runtime", "claude-launches");
}

function createClaudeLaunchSettings({
  launchId,
  provider,
  rootDir = defaultClaudeLaunchSettingsRoot(),
  now = Date.now(),
} = {}) {
  if (!provider?.environment || provider.id === "anthropic-default") return null;

  const safeLaunchId = sanitizeLaunchId(launchId);
  cleanupStaleClaudeLaunchSettings({ rootDir, now });
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });

  const filePath = path.join(rootDir, `${safeLaunchId}${SETTINGS_SUFFIX}`);
  const payload = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    env: provider.environment,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  return {
    filePath,
    rootDir,
  };
}

function cleanupClaudeLaunchSettings(filePath, rootDir = defaultClaudeLaunchSettingsRoot()) {
  if (!filePath || !isInsideRoot(rootDir, filePath)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function cleanupStaleClaudeLaunchSettings({
  rootDir = defaultClaudeLaunchSettingsRoot(),
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
} = {}) {
  if (!fs.existsSync(rootDir)) return 0;

  let removed = 0;
  for (const name of fs.readdirSync(rootDir)) {
    if (!name.endsWith(SETTINGS_SUFFIX)) continue;
    const filePath = path.join(rootDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || now - stat.mtimeMs < staleMs) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Stale cleanup is best-effort and must never prevent a CLI launch.
      }
    }
  }
  return removed;
}

function sanitizeLaunchId(value) {
  const launchId = String(value || "").trim();
  if (!launchId || !/^[A-Za-z0-9_-]+$/u.test(launchId)) {
    throw new Error("Claude launch settings require a safe launchId");
  }
  return launchId;
}

function isInsideRoot(rootDir, filePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

module.exports = {
  DEFAULT_STALE_MS,
  cleanupClaudeLaunchSettings,
  cleanupStaleClaudeLaunchSettings,
  createClaudeLaunchSettings,
  defaultClaudeLaunchSettingsRoot,
};
