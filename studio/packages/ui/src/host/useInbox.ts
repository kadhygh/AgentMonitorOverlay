import { useEffect, useState } from "react";
import type { Id, MailMessage, Session } from "@amo-studio/protocol";
import { call, type HostLink } from "./client.js";
import { mergeFirstLoad, onHostEvent, onHostReconnect } from "./events.js";

/** Unread mail across the workbench, kept live (board hints). */
export function useUnreadMail(link: HostLink) {
  const [unread, setUnread] = useState<readonly MailMessage[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = (first = false) =>
      call(link, "GET /api/mail", {}, undefined, { state: "unread" })
        .then((list) => !cancelled && setUnread((cur) => (first ? mergeFirstLoad(list, cur) : list)))
        .catch(() => undefined);
    const off = onHostEvent((e) => {
      if (e.type !== "mail.upserted") return;
      setUnread((cur) => {
        const rest = cur.filter((m) => m.id !== e.mail.id);
        return e.mail.state === "unread" ? [...rest, e.mail] : rest;
      });
    });
    const offReconnect = onHostReconnect(() => void load());
    void load(true);
    return () => {
      cancelled = true;
      off();
      offReconnect();
    };
  }, [link]);
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
