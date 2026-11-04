import type { Id, MailMessage, Session } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { keepWhere, useLiveResource } from "../host/live.js";

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
    if (!m.fromSessionId) continue;
    // Mail for a topic or its own sessions is not on any task card.
    const taskId = m.to.kind === "task" ? m.to.taskId : m.to.kind === "session" ? taskOf.get(m.to.sessionId) : null;
    if (taskId) counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  }
  return counts;
}
