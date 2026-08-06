const { httpError } = require("./http");

const DEFAULT_ACTIVE_LIMIT = 200;
const DEFAULT_ARCHIVE_LIMIT = 50;
const MAX_LIMIT = 200;
const SUMMARY_OMIT_FIELDS = new Set([
  "activeTurnId",
  "transcriptPath",
  "hookEvents",
  "lastPromptHash",
  "lastPromptPendingPromptId",
  "lastPromptSource",
]);

function querySessions(allSessions, searchParams = new URLSearchParams()) {
  const scope = String(searchParams.get("scope") || "active").toLowerCase();
  if (!new Set(["active", "archived", "all"]).has(scope)) {
    throw httpError(400, "invalid_session_scope", `Unsupported session scope: ${scope}`);
  }
  const active = allSessions.filter((session) => !session.archivedAt);
  const archived = allSessions.filter((session) => Boolean(session.archivedAt));
  const scoped = scope === "active" ? active : scope === "archived" ? archived : allSessions;
  const offset = boundedInteger(searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0);
  const defaultLimit = scope === "archived" ? DEFAULT_ARCHIVE_LIMIT : DEFAULT_ACTIVE_LIMIT;
  const limit = boundedInteger(searchParams.get("limit"), 1, MAX_LIMIT, defaultLimit);
  const summary = searchParams.get("summary") !== "0";
  const page = scoped.slice(offset, offset + limit);

  return {
    scope,
    summary,
    offset,
    limit,
    count: page.length,
    total: scoped.length,
    counts: { active: active.length, archived: archived.length, total: allSessions.length },
    hasMore: offset + page.length < scoped.length,
    sessions: summary ? page.map(createSessionSummary) : page,
  };
}

function createSessionSummary(session) {
  const summary = {};
  for (const [key, value] of Object.entries(session || {})) {
    if (!SUMMARY_OMIT_FIELDS.has(key)) summary[key] = value;
  }
  return summary;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

module.exports = { createSessionSummary, querySessions };
