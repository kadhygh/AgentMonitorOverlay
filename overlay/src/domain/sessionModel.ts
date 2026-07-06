import type { AgentSession } from "../types";

export const ATTENTION_VISUAL_ACTIVE_MS = 10_000;

export type SessionFilter = "all" | "attention" | "idle" | "archive";

export const sessionFilterLabels: Record<SessionFilter, string> = {
  all: "All",
  attention: "Attention",
  idle: "Idle",
  archive: "Archive",
};

export function normalizeSessions(value: unknown): AgentSession[] | null {
  if (Array.isArray(value)) {
    return value as AgentSession[];
  }

  if (value && typeof value === "object" && "sessions" in value) {
    const sessions = (value as { sessions?: unknown }).sessions;
    return Array.isArray(sessions) ? (sessions as AgentSession[]) : null;
  }

  return null;
}

export function mergeSessionOrder(previousOrder: string[], nextSessions: AgentSession[]) {
  const nextIds = nextSessions.map((session) => session.sessionId);
  const keptIds = previousOrder.filter((sessionId) => nextIds.includes(sessionId));
  const addedIds = nextIds.filter((sessionId) => !keptIds.includes(sessionId));
  return [...keptIds, ...addedIds];
}

export function applySessionOrder(sessions: AgentSession[], order: string[]) {
  const indexed = new Map(order.map((sessionId, index) => [sessionId, index]));
  return [...sessions].sort((a, b) => {
    const aIndex = indexed.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = indexed.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }

    return `${b.updatedAt}`.localeCompare(`${a.updatedAt}`);
  });
}

export function mergeChangedSession(previousSessions: AgentSession[], changedSession: AgentSession) {
  const index = previousSessions.findIndex((session) => session.sessionId === changedSession.sessionId);
  if (index >= 0) {
    const nextSessions = [...previousSessions];
    nextSessions[index] = changedSession;
    return nextSessions;
  }

  return [changedSession, ...previousSessions];
}

export function sessionNeedsReview(session: AgentSession) {
  return Boolean(session.reviewRequired && session.reviewStatus !== "reviewed" && !session.reviewedAt);
}

export function sessionNeedsManualAttentionClear(session: AgentSession) {
  return Boolean(
    !sessionNeedsReview(session) &&
      session.needsAttention &&
      (session.state === "waiting_permission" || session.state === "waiting_user"),
  );
}

export function sessionHasAttentionSignal(session: AgentSession) {
  return Boolean(session.needsAttention || sessionNeedsReview(session));
}

export function sessionArchived(session: AgentSession) {
  return Boolean(session.archivedAt);
}

export function sessionAttentionKey(session: AgentSession) {
  return [
    session.sessionId,
    session.updatedAt,
    session.state,
    session.lastEvent,
    session.lastMessage,
    session.needsAttention ? "attention" : "quiet",
    session.lastReplyAt ?? "",
    session.lastPromptAt ?? "",
    session.pendingPromptId ?? "",
    session.reviewStatus ?? "",
    session.reviewRequestedAt ?? "",
    session.reviewedAt ?? "",
  ].join("|");
}

function sessionAttentionTime(session: AgentSession) {
  const timestamp =
    session.reviewRequestedAt ||
    session.updatedAt ||
    session.lastReplyAt ||
    session.lastPromptAt ||
    session.pendingPromptCreatedAt ||
    session.sentPromptRecordedAt;
  if (!timestamp) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sessionAttentionVisualActive(session: AgentSession, visuallySeen: boolean, now: number) {
  if (!sessionHasAttentionSignal(session) || visuallySeen) {
    return false;
  }

  const timestamp = sessionAttentionTime(session);
  if (timestamp === null) {
    return true;
  }

  const age = now - timestamp;
  return age <= ATTENTION_VISUAL_ACTIVE_MS && age >= -ATTENTION_VISUAL_ACTIVE_MS;
}

export function sessionMatchesFilter(session: AgentSession, filter: SessionFilter) {
  const archived = sessionArchived(session);
  if (filter === "archive") {
    return archived;
  }
  if (archived) {
    return false;
  }
  if (filter === "attention") {
    return sessionHasAttentionSignal(session);
  }
  if (filter === "idle") {
    return session.state === "idle";
  }
  return true;
}
