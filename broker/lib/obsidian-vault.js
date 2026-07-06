const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { httpError } = require("./http");
const { readJsonFileStrict, writeJsonFile } = require("./filesystem");

function registerObsidianVault(vaultRoot) {
  const registryPath = obsidianRegistryPath();
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

  return {
    ok: true,
    vaultRoot,
    vaultId,
    registryPath,
    runtimeConfigPath,
    runtimeConfigExists: runtimeConfigExists || vaultRuntimeState.loaded,
    runtimeConfigFileExists: runtimeConfigExists,
    vaultRuntimeState,
    obsidianProcessCount: countObsidianProcesses(),
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

module.exports = {
  inspectObsidianVaultRuntimeState,
  normalizeComparablePath,
  obsidianRegistryPath,
  obsidianVaultIdForPath,
  registerObsidianVault,
};
