const { httpError } = require("./http");
const { normalizeText } = require("./normalize");
const { normalizeComparablePath } = require("./obsidian-vault");

const SUCCESS_STATUSES = new Set(["opened", "focused"]);
const FINAL_STATUSES = new Set(["opened", "focused", "not_found", "rejected", "error"]);

function createObsidianRuntimeStore({
  now = () => Date.now(),
  runtimeTtlMs = 45_000,
  resultTtlMs = 120_000,
  recordDebugLog = () => {},
} = {}) {
  const runtimes = new Map();
  const openResults = new Map();

  function heartbeat(payload = {}) {
    cleanup();
    const vaultRoot = normalizeText(payload.vaultRoot || payload.vault_root);
    const vaultId = normalizeText(payload.vaultId || payload.vault_id);
    if (!vaultRoot && !vaultId) {
      throw httpError(400, "missing_vault_identity", "Obsidian runtime heartbeat requires vaultRoot or vaultId");
    }
    const receivedAtMs = now();
    const entry = {
      ok: true,
      active: true,
      vaultRoot: vaultRoot || null,
      vaultId: vaultId || null,
      pluginId: normalizeText(payload.pluginId || payload.plugin_id) || null,
      pluginVersion: normalizeText(payload.pluginVersion || payload.plugin_version) || null,
      capabilities: normalizeCapabilities(payload.capabilities),
      startedAt: normalizeText(payload.startedAt || payload.started_at) || null,
      heartbeatAt: new Date(receivedAtMs).toISOString(),
      receivedAtMs,
    };
    for (const key of runtimeKeys(entry)) runtimes.set(key, entry);
    recordDebugLog("broker", "obsidian.runtime.heartbeat", {
      vaultRoot: entry.vaultRoot,
      vaultId: entry.vaultId,
      pluginVersion: entry.pluginVersion,
      capabilities: entry.capabilities,
    });
    return presentRuntime(entry);
  }

  function getRuntime(identity = {}) {
    cleanup();
    const keys = runtimeKeys(identity);
    const entry = keys.map((key) => runtimes.get(key)).find(Boolean);
    return entry ? presentRuntime(entry) : null;
  }

  function recordOpenResult(payload = {}) {
    cleanup();
    const openRequestId = normalizeText(payload.openRequestId || payload.open_request_id);
    if (!openRequestId) throw httpError(400, "missing_open_request_id", "Open result requires openRequestId");
    const status = (normalizeText(payload.status) || "").toLowerCase();
    if (!FINAL_STATUSES.has(status)) {
      throw httpError(400, "invalid_open_status", `Unsupported Obsidian open status: ${status || "missing"}`);
    }
    const existing = openResults.get(openRequestId);
    if (existing && SUCCESS_STATUSES.has(existing.status)) {
      return { ...presentOpenResult(existing), duplicate: true };
    }
    const receivedAtMs = now();
    const entry = {
      ok: SUCCESS_STATUSES.has(status),
      openRequestId,
      status,
      vaultRoot: normalizeText(payload.vaultRoot || payload.vault_root) || null,
      vaultId: normalizeText(payload.vaultId || payload.vault_id) || null,
      targetPath: normalizeText(payload.targetPath || payload.target_path) || null,
      kind: normalizeText(payload.kind) || null,
      reusedLeaf: payload.reusedLeaf === true || payload.reused_leaf === true,
      message: normalizeText(payload.message) || null,
      timings: payload.timings && typeof payload.timings === "object" ? payload.timings : {},
      pluginVersion: normalizeText(payload.pluginVersion || payload.plugin_version) || null,
      completedAt: normalizeText(payload.completedAt || payload.completed_at) || new Date(receivedAtMs).toISOString(),
      receivedAtMs,
    };
    openResults.set(openRequestId, entry);
    recordDebugLog("broker", "obsidian.open.ack.received", {
      openRequestId,
      status,
      targetPath: entry.targetPath,
      kind: entry.kind,
      reusedLeaf: entry.reusedLeaf,
      timings: entry.timings,
    });
    return presentOpenResult(entry);
  }

  function getOpenResult(openRequestId) {
    cleanup();
    const entry = openResults.get(normalizeText(openRequestId));
    return entry ? presentOpenResult(entry) : null;
  }

  function cleanup() {
    const currentTime = now();
    for (const [key, entry] of runtimes) {
      if (currentTime - entry.receivedAtMs > runtimeTtlMs) runtimes.delete(key);
    }
    for (const [key, entry] of openResults) {
      if (currentTime - entry.receivedAtMs > resultTtlMs) openResults.delete(key);
    }
  }

  function status() {
    cleanup();
    return { runtimes: new Set(runtimes.values()).size, openResults: openResults.size };
  }

  function presentRuntime(entry) {
    return {
      ok: true,
      active: now() - entry.receivedAtMs <= runtimeTtlMs,
      vaultRoot: entry.vaultRoot,
      vaultId: entry.vaultId,
      pluginId: entry.pluginId,
      pluginVersion: entry.pluginVersion,
      capabilities: entry.capabilities,
      startedAt: entry.startedAt,
      heartbeatAt: entry.heartbeatAt,
      ageMs: Math.max(0, now() - entry.receivedAtMs),
    };
  }

  return { getOpenResult, getRuntime, heartbeat, recordOpenResult, status };
}

function runtimeKeys(identity) {
  const keys = [];
  const vaultId = normalizeText(identity.vaultId || identity.vault_id);
  const vaultRoot = normalizeComparablePath(identity.vaultRoot || identity.vault_root);
  if (vaultId) keys.push(`id:${vaultId}`);
  if (vaultRoot) keys.push(`root:${vaultRoot}`);
  return keys;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeText).filter(Boolean))];
}

function presentOpenResult(entry) {
  const { receivedAtMs: _receivedAtMs, ...result } = entry;
  return result;
}

module.exports = { createObsidianRuntimeStore };
