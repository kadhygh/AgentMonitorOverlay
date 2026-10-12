import { useEffect, useState } from "react";
import type { MailMessage, Session, Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { mergeFirstLoad, onHostEvent, onHostReconnect } from "../host/events.js";

/** Mail left for a task or any of its sessions, kept live. */
export function useTaskMail(link: HostLink, task: Task, sessions: readonly Session[]) {
  const [mail, setMail] = useState<readonly MailMessage[]>([]);
  const sessionIds = sessions.filter((s) => s.taskId === task.id).map((s) => s.id).join(",");

  useEffect(() => {
    let cancelled = false;
    const mine = new Set(sessionIds.split(",").filter(Boolean));
    const forThisTask = (m: MailMessage) => (m.to.kind === "task" ? m.to.taskId === task.id : mine.has(m.to.sessionId));
    const load = (first = false) =>
      call(link, "GET /api/mail", {}, undefined, { forTask: task.id })
        .then((list) => !cancelled && setMail((cur) => (first ? mergeFirstLoad(list, cur) : list)))
        .catch(() => undefined);
    const off = onHostEvent((e) => {
      if (e.type !== "mail.upserted" || !forThisTask(e.mail)) return;
      setMail((cur) => (cur.some((m) => m.id === e.mail.id) ? cur.map((m) => (m.id === e.mail.id ? e.mail : m)) : [...cur, e.mail]));
    });
    const offReconnect = onHostReconnect(() => void load());
    void load(true);
    return () => {
      cancelled = true;
      off();
      offReconnect();
    };
  }, [link, task.id, sessionIds]);

  return mail;
}

interface MailPanelProps {
  mail: readonly MailMessage[];
  sessions: readonly Session[];
  tasks: readonly Task[];
  /** The session in view: task mail is forwarded into it. */
  current: Session | null;
  busy: boolean;
  onForward(mail: MailMessage, sessionId: string): void;
  onDismiss(mail: MailMessage): void;
}

/**
 * Messages agents left for this task or its sessions. Nothing enters a conversation until the person forwards it
 * ("转进对话"); "忽略" files it away.
 */
export function MailPanel({ mail, sessions, tasks, current, busy, onForward, onDismiss }: MailPanelProps) {
  const open = mail.filter((m) => m.state === "unread" || m.state === "read");
  if (!open.length) return null;
  const sessionTitle = (id: string) => sessions.find((s) => s.id === id)?.title || "会话";
  const from = (m: MailMessage) => {
    if (!m.fromSessionId) return "我";
    const task = tasks.find((t) => t.id === m.fromTaskId);
    return `${task?.title || "未命名任务"} · ${sessionTitle(m.fromSessionId)}`;
  };
  return (
    <section className="mail-panel" aria-label="留言">
      <div className="anno-head">
        <span className="anno-title">留言</span>
        <span className="anno-count" data-testid="mail-count">
          {open.length}
        </span>
      </div>
      {open.map((m) => {
        const target = m.to.kind === "session" ? m.to.sessionId : current && !current.archivedAt ? current.id : null;
        return (
          <div key={m.id} className={m.state === "unread" ? "mail-card unread" : "mail-card"} data-testid="mail-card">
            <span className="mail-route">
              来自 {from(m)} → {m.to.kind === "session" ? sessionTitle(m.to.sessionId) : "本任务"}
            </span>
            <span className="mail-text">{m.text}</span>
            <div className="mail-actions">
              <button
                type="button"
                className="btn-ghost small"
                disabled={busy || !target}
                title={target ? "作为一条消息发进会话" : "先选中这个任务里的一个会话"}
                onClick={() => target && onForward(m, target)}
              >
                转进{m.to.kind === "session" ? "对话" : "当前会话"}
              </button>
              <button type="button" className="link-btn" disabled={busy} onClick={() => onDismiss(m)}>
                忽略
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
