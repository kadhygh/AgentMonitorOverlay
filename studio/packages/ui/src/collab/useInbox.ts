import type { HostEvent, Id, LocalPendingView, MailMessage, Session, Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { keepWhere, upsertById, useLiveResource } from "../host/live.js";

/** Unread mail across the workbench, kept live (board hints). */
export function useUnreadMail(link: HostLink) {
  const [unread] = useLiveResource<readonly MailMessage[]>(
    {
      load: () => call(link, "GET /api/mail", {}, undefined, { state: "unread" }),
      initial: [],
      onEvent: (cur, e) => (e.type === "mail.upserted" ? keepWhere(cur, e.mail, e.mail.state === "unread") : cur),
    },
    [link],
  );
  return unread;
}

/**
 * Unread mail per task: mail left for the task itself or for any of its sessions. Mail the person wrote (decision
 * answers) is left out: it is for the agent, and the person already knows what it says.
 */
export function mailByTask(unread: readonly MailMessage[], sessions: readonly Session[]): Map<Id, number> {
  const taskOf = new Map(sessions.map((s) => [s.id, s.taskId]));
  const counts = new Map<Id, number>();
  for (const m of unread) {
    if (!m.fromSessionId || m.withdrawnAt !== undefined || m.via === "background") continue;
    // Mail for a topic or its own sessions is not on any task card.
    const taskId = m.to.kind === "task" ? m.to.taskId : m.to.kind === "session" ? taskOf.get(m.to.sessionId) : null;
    if (taskId) counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  }
  return counts;
}

/** Mail left for a task or any of its sessions, kept live (the session rows count what is unread). */
export function useTaskMail(link: HostLink, task: Task, sessions: readonly Session[]) {
  const sessionIds = sessions.filter((s) => s.taskId === task.id).map((s) => s.id).join(",");
  const mine = new Set(sessionIds.split(",").filter(Boolean));
  const forThisTask = (m: MailMessage) => (m.to.kind === "task" ? m.to.taskId === task.id : m.to.kind === "session" && mine.has(m.to.sessionId));
  const [mail] = useLiveResource<readonly MailMessage[]>(
    {
      load: () => call(link, "GET /api/mail", {}, undefined, { forTask: task.id }),
      initial: [],
      onEvent: (cur, e) => (e.type === "mail.upserted" && forThisTask(e.mail) ? upsertById(cur, e.mail) : cur),
    },
    [link, task.id, sessionIds],
  );
  return mail;
}

export const NO_PENDING: LocalPendingView = { asks: [], threads: [], pending: [] };

const touchesPending = (e: HostEvent) => e.type === "mail.upserted" || e.type === "matter.upserted" || e.type === "relay.upserted";

/**
 * 待我处理, the Host's part (2026-11-25, 本机的事项): read again whenever a message, a 事项 or a 传话 changes (a turn
 * moves several at once, so the reloads are coalesced). `taskId`: only what concerns that task (its side panel).
 */
export function useLocalPending(link: HostLink, taskId?: Id): LocalPendingView {
  const [view] = useLiveResource<LocalPendingView>(
    {
      load: () => call(link, "GET /api/local-pending", {}, undefined, taskId ? { taskId } : undefined),
      initial: NO_PENDING,
      reloadOn: touchesPending,
      reloadDelay: 150,
    },
    [link, taskId ?? ""],
  );
  return view;
}
