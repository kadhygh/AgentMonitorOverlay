import type { Session, Task } from "@amo-studio/protocol";
import { needsPerson } from "../lib/status.js";

// Focus 置顶 (2026-10-21): tasks the person keeps at the top of Focus, one line on what their session does; its detail
// opens only while it waits for the person (10-22: always open said too much). And which sessions show their running
// subagents (方案 D: folded to「▸ N」 until opened). Both per machine in localStorage (lib/storedIds.ts), like where
// Focus sits.

export const PINNED_KEY = "amo.focusPinned";
export const SUBS_OPEN_KEY = "amo.focusSubsOpen";

/**
 * The session a pinned task shows, of its live ones that are not subagents: one waiting for the person (an approval, a
 * question, a plan) first, then one that runs, then the latest (10-22: the task's other sessions are not listed apart).
 */
export function pinnedSession(task: Pick<Task, "id">, sessions: readonly Session[]): Session | undefined {
  const rank = (s: Session) => (needsPerson(s.status) ? 0 : s.status === "running" ? 1 : 2);
  return sessions
    .filter((s) => s.taskId === task.id && s.kind !== "sub" && !s.archivedAt)
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** 「已跑 5 分钟」: how long a subagent has been running, from when it started. */
export function ranFor(since: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (s < 60) return `已跑 ${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `已跑 ${m} 分钟`;
  return `已跑 ${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
