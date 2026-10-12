import { useEffect, useState } from "react";
import type { Session, TaskNote } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";
import { relativeTime } from "../lib/status.js";

/** Progress notes and handoff summaries of a task, kept live. */
export function useTaskNotes(link: HostLink, taskId: string) {
  const [notes, setNotes] = useState<readonly TaskNote[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      call(link, "GET /api/tasks/:id/notes", { id: taskId })
        .then((list) => !cancelled && setNotes(list))
        .catch(() => undefined);
    const off = onHostEvent((e) => {
      if (e.type === "task.note.added" && e.note.taskId === taskId) setNotes((cur) => (cur.some((n) => n.id === e.note.id) ? cur : [...cur, e.note]));
    });
    const offReconnect = onHostReconnect(() => void load());
    void load();
    return () => {
      cancelled = true;
      off();
      offReconnect();
    };
  }, [link, taskId]);
  return notes;
}

const SHOWN = 5;

/**
 * "进度": what sessions (and the person) recorded on the task. The latest handoff summary stays on top because it is
 * what the next session needs; progress notes follow, newest first.
 */
export function NotesPanel({ link, taskId, notes, sessions }: { link: HostLink; taskId: string; notes: readonly TaskNote[]; sessions: readonly Session[] }) {
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  const author = (n: TaskNote) => (n.sessionId ? sessions.find((s) => s.id === n.sessionId)?.title || "会话" : "我");
  const handoff = [...notes].reverse().find((n) => n.kind === "handoff");
  const rest = [...notes].reverse().filter((n) => n !== handoff);
  const shown = all ? rest : rest.slice(0, SHOWN);
  const add = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    void call(link, "POST /api/tasks/:id/notes", { id: taskId }, { text: value }).catch(() => setText(value));
  };
  return (
    <section className="mail-panel" aria-label="进度">
      <div className="anno-head">
        <span className="anno-title">进度</span>
        <span className="anno-count" data-testid="note-count">
          {notes.length}
        </span>
      </div>
      {handoff && (
        <div className="note-card handoff" data-testid="handoff-note">
          <span className="mail-route">
            交接摘要 · {author(handoff)} · {relativeTime(handoff.createdAt)}
          </span>
          <span className="mail-text">{handoff.text}</span>
        </div>
      )}
      {shown.map((n) => (
        <div key={n.id} className={n.kind === "handoff" ? "note-card handoff old" : "note-card"} data-testid="task-note">
          <span className="mail-route">
            {n.kind === "handoff" ? "较早的交接 · " : ""}
            {author(n)} · {relativeTime(n.createdAt)}
          </span>
          <span className="mail-text">{n.text}</span>
        </div>
      ))}
      {rest.length > SHOWN && (
        <button type="button" className="link-btn" onClick={() => setAll(!all)}>
          {all ? "收起" : `还有 ${rest.length - SHOWN} 条`}
        </button>
      )}
      <form
        className="decision-answer"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="记一笔进度" aria-label="记一笔进度" />
        <button type="submit" className="btn-ghost small" disabled={!text.trim()}>
          记下
        </button>
      </form>
    </section>
  );
}
