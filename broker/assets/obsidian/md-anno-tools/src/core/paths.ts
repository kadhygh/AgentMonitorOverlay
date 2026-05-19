export function normalizeVaultFilePath(value) {
  return String(value || "")
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .trim();
}

export function toVaultRelativeProtocolPath(value, vaultRoot = "") {
  const rawPath = String(value || "").trim();
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

export function normalizeOpenKind(value, filePath = "") {
  const kind = String(value || "").trim().toLowerCase();
  if (kind === "canvas" || kind === "note") return kind;
  return String(filePath || "").toLowerCase().endsWith(".canvas") ? "canvas" : "note";
}
