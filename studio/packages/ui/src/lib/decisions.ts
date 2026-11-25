import type { DecisionRequest, Session } from "@amo-studio/protocol";

/**
 * The open 提问 that still count as 需要你 (2026-11-25): those whose session is there and not archived — nothing waits for
 * an answer in one put away, and the top bar counted it while Focus did not. Only a filter: the 提问 stays open in the
 * Host and counts again once its session is unarchived. Every count of them (top bar, board cards, 侧栏, Focus) uses it.
 */
export function liveDecisions<D extends Pick<DecisionRequest, "sessionId">>(open: readonly D[], sessions: readonly Pick<Session, "id" | "archivedAt">[]): D[] {
  const live = new Set(sessions.filter((s) => !s.archivedAt).map((s) => s.id));
  return open.filter((d) => live.has(d.sessionId));
}
