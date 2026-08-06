const {
  inspectObsidianPluginHealth,
  normalizeComparablePath,
} = require("./obsidian-vault");

function createObsidianPluginHealthCache({
  inspect = inspectObsidianPluginHealth,
  recordDebugLog = () => {},
  onChanged = () => {},
  ttlMs = 45_000,
  errorTtlMs = 7_500,
  now = () => Date.now(),
  schedule = (callback) => setImmediate(callback),
} = {}) {
  const entries = new Map();

  function get(vaultRoot, options = {}, fallback = null) {
    const key = cacheKey(vaultRoot, options);
    if (!key) return fallback;
    let entry = entries.get(key);
    if (!entry && fallback) {
      entry = {
        value: fallback,
        checkedAtMs: parsedCheckedAt(fallback) || 0,
        refreshing: false,
      };
      entries.set(key, entry);
    }

    const currentTime = now();
    const lifetime = entry?.value?.ok === false ? errorTtlMs : ttlMs;
    const fresh = entry && currentTime - entry.checkedAtMs < lifetime;
    if (!fresh) refresh(vaultRoot, options, key, entry);
    return entry?.value || fallback;
  }

  function refresh(vaultRoot, options = {}, knownKey = null, knownEntry = null) {
    const key = knownKey || cacheKey(vaultRoot, options);
    if (!key) return;
    const entry = knownEntry || entries.get(key) || { value: null, checkedAtMs: 0, refreshing: false };
    if (entry.refreshing) return;
    entry.refreshing = true;
    entries.set(key, entry);

    schedule(() => {
      const startedAt = now();
      try {
        const nextValue = inspect(vaultRoot, options);
        const previousValue = entry.value;
        entry.value = nextValue;
        entry.checkedAtMs = now();
        entry.refreshing = false;
        recordDebugLog("broker", "obsidian.health_cache_refreshed", {
          vaultRoot,
          durationMs: now() - startedAt,
          ok: nextValue?.ok ?? null,
        });
        if (!sameHealth(previousValue, nextValue)) {
          onChanged({ vaultRoot, health: nextValue });
        }
      } catch (error) {
        entry.checkedAtMs = now();
        entry.refreshing = false;
        recordDebugLog("broker", "obsidian.health_cache_error", {
          vaultRoot,
          durationMs: now() - startedAt,
          code: error?.code || null,
          message: error?.message || String(error),
        });
      }
    });
  }

  function invalidate(vaultRoot = null) {
    if (!vaultRoot) {
      entries.clear();
      return;
    }
    const prefix = `${normalizeComparablePath(vaultRoot)}\u0000`;
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
  }

  function prime(vaultRoot, health, options = {}) {
    const key = cacheKey(vaultRoot, options);
    if (!key || !health) return;
    entries.set(key, {
      value: health,
      checkedAtMs: parsedCheckedAt(health) || 0,
      refreshing: false,
    });
  }

  function status() {
    return {
      size: entries.size,
      refreshing: Array.from(entries.values()).filter((entry) => entry.refreshing).length,
    };
  }

  return {
    get,
    invalidate,
    prime,
    refresh,
    status,
  };
}

function cacheKey(vaultRoot, options) {
  const root = normalizeComparablePath(vaultRoot);
  if (!root) return "";
  const bridgeUrl = String(options.expectedBridgeUrl || options.bridgeUrl || "").trim().toLowerCase();
  const pluginId = String(options.pluginId || "").trim().toLowerCase();
  return `${root}\u0000${bridgeUrl}\u0000${pluginId}`;
}

function parsedCheckedAt(health) {
  const value = Date.parse(health?.checkedAt || "");
  return Number.isFinite(value) ? value : 0;
}

function sameHealth(left, right) {
  if (!left || !right) return left === right;
  const fields = [
    "ok",
    "status",
    "installed",
    "enabled",
    "expectedVersion",
    "installedVersion",
    "expectedBridgeUrl",
    "dataBridgeUrl",
    "mainJsExists",
  ];
  return fields.every((field) => left[field] === right[field]) &&
    JSON.stringify(left.issues || []) === JSON.stringify(right.issues || []);
}

module.exports = {
  createObsidianPluginHealthCache,
};
