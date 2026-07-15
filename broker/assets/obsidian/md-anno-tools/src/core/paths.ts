export function normalizeVaultFilePath(value) {
  return String(value || "")
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .trim();
}

export function toVaultRelativeProtocolPath(value, vaultRoot = "") {
  const rawPath = decodeProtocolPathValue(value);
  if (!rawPath) return "";

  const normalizedPath = rawPath.replace(/\\/gu, "/");
  if (!vaultRoot) return normalizedPath;

  const normalizedRoot = String(vaultRoot || "").replace(/\\/gu, "/").replace(/\/+$/u, "");
  const rootPrefix = normalizedRoot + "/";
  if (normalizedPath.toLowerCase() === normalizedRoot.toLowerCase()) return "";
  if (normalizedPath.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    return normalizedPath.slice(rootPrefix.length);
  }

  return normalizedPath;
}

export function protocolPathBelongsToVault(value, vaultRoot = "") {
  const rawPath = decodeProtocolPathValue(value);
  if (!rawPath || !vaultRoot) return true;

  const normalizedPath = rawPath.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const normalizedRoot = String(vaultRoot || "").replace(/\\/gu, "/").replace(/\/+$/u, "");
  const isWindowsPath = /^[A-Za-z]:\//u.test(normalizedPath);
  const isAbsolutePath = isWindowsPath || normalizedPath.startsWith("/");
  if (!isAbsolutePath) return true;

  const comparablePath = isWindowsPath ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableRoot = isWindowsPath ? normalizedRoot.toLowerCase() : normalizedRoot;
  return comparablePath === comparableRoot || comparablePath.startsWith(comparableRoot + "/");
}

export function decodeProtocolPathValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    // Obsidian already decodes protocol query values before invoking the handler.
    // Keep literal plus signs intact because they are valid note filename characters.
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function normalizeOpenKind(value, filePath = "") {
  const kind = String(value || "").trim().toLowerCase();
  if (kind === "canvas" || kind === "note") return kind;
  return String(filePath || "").toLowerCase().endsWith(".canvas") ? "canvas" : "note";
}
