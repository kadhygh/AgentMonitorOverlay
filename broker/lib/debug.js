const crypto = require("crypto");
const { httpError } = require("./http");

function createDebugLogStore(options = {}) {
  const state = {
    enabled: Boolean(options.enabled),
    maxEntries: options.maxEntries || 800,
    entries: [],
  };

  function status(searchParams) {
    const limit = searchParams ? normalizeInteger(searchParams.get("limit")) : null;
    const normalizedLimit = limit && limit > 0 ? Math.min(limit, state.maxEntries) : state.entries.length;
    const entries =
      normalizedLimit >= state.entries.length
        ? state.entries
        : state.entries.slice(state.entries.length - normalizedLimit);

    return {
      ok: true,
      enabled: state.enabled,
      maxEntries: state.maxEntries,
      count: state.entries.length,
      entries,
    };
  }

  function updateConfig(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw httpError(400, "invalid_json", "Debug config payload must be a JSON object");
    }

    const previousEnabled = state.enabled;
    if (typeof payload.enabled === "boolean") {
      state.enabled = payload.enabled;
    }

    const maxEntries = normalizeInteger(payload.maxEntries || payload.max_entries);
    if (maxEntries && maxEntries >= 50 && maxEntries <= 5000) {
      state.maxEntries = maxEntries;
      trimEntries();
    }

    record(
      "broker",
      "debug.config",
      {
        previousEnabled,
        enabled: state.enabled,
        maxEntries: state.maxEntries,
      },
      { force: true }
    );
    return status();
  }

  function handleLog(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw httpError(400, "invalid_json", "Debug log payload must be a JSON object");
    }

    const source = normalizeText(payload.source) || "unknown";
    const event = normalizeText(payload.event || payload.name || payload.message) || "log";
    const entry = record(source, event, payload.data || {}, {
      message: normalizeText(payload.message),
    });

    return {
      ok: true,
      enabled: state.enabled,
      recorded: Boolean(entry),
      count: state.entries.length,
      entry: entry || null,
    };
  }

  function clear() {
    state.entries = [];
  }

  function record(source, event, data, options = {}) {
    if (!state.enabled && !options.force) {
      return null;
    }

    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      source: normalizeText(source) || "unknown",
      event: normalizeText(event) || "log",
      message: options.message || null,
      data: sanitizeData(data),
    };

    state.entries.push(entry);
    trimEntries();
    return entry;
  }

  function trimEntries() {
    if (state.entries.length <= state.maxEntries) {
      return;
    }

    state.entries.splice(0, state.entries.length - state.maxEntries);
  }

  return {
    clear,
    handleLog,
    preview: debugPreview,
    record,
    state,
    status,
    updateConfig,
  };
}

function sanitizeData(value, depth = 0) {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (depth >= 5) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeData(item, depth + 1));
  }

  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).slice(0, 60)) {
      result[key] = sanitizeData(value[key], depth + 1);
    }
    return result;
  }

  return String(value);
}

function debugPreview(value, limit = 240) {
  const text = normalizeText(typeof value === "string" ? value : JSON.stringify(value || ""));
  if (!text) {
    return "";
  }

  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeInteger(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}

module.exports = {
  createDebugLogStore,
};
