import { useEffect, useState } from "react";
import type { DecisionRequest, Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { mergeFirstLoad, onHostEvent, onHostReconnect } from "../host/events.js";

/** Open decision requests across all tasks, kept live. */
export function useOpenDecisions(link: HostLink) {
  const [open, setOpen] = useState<readonly DecisionRequest[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = (first = false) =>
      call(link, "GET /api/decisions", {}, undefined, { state: "open" })
        .then((list) => !cancelled && setOpen((cur) => (first ? mergeFirstLoad(list, cur) : list)))
        .catch(() => undefined);
    const off = onHostEvent((e) => {
      if (e.type !== "decision.upserted") return;
      setOpen((cur) => {
        const rest = cur.filter((d) => d.id !== e.decision.id);
        return e.decision.state === "open" ? [...rest, e.decision] : rest;
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
  return open;
}

/**
 * One question from an agent: pick an option or write an answer. The answer goes back to the asking session as mail.
 * Options are whole rows that wrap (agents write long ones). Without `sessionTitle` the card sits in that session's
 * own conversation. `onWriteElsewhere`: the Focus window cannot take keyboard focus, so instead of a text field it
 * offers to answer in the workbench.
 */
export function DecisionCard({
  link,
  decision,
  sessionTitle,
  className = "decision-card",
  onWriteElsewhere,
}: {
  link: HostLink;
  decision: DecisionRequest;
  sessionTitle?: string;
  className?: string;
  onWriteElsewhere?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/decisions/:id/answer", { id: decision.id }, { answer: value.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className={className} data-testid="decision-card">
      <div className="decision-head">
        <span className="decision-from">{sessionTitle ? `${sessionTitle} 在等你决定` : "等你决定"}</span>
        <span className="decision-hint">回答会作为留言发回</span>
      </div>
      <div className="decision-question">{decision.question}</div>
      {decision.options.length > 0 && (
        <div className="decision-options" role="group" aria-label="选项">
          {decision.options.map((o, i) => (
            <button key={o} type="button" className="decision-option" aria-label={o} title={o} disabled={busy} onClick={() => void answer(o)}>
              <span className="decision-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="decision-option-text">{o}</span>
            </button>
          ))}
        </div>
      )}
      {onWriteElsewhere ? (
        <button type="button" className="focus-btn" onClick={onWriteElsewhere}>
          在工作台回答
        </button>
      ) : (
      <form
        className="decision-answer"
        onSubmit={(e) => {
          e.preventDefault();
          void answer(text);
        }}
      >
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="或者写下你的决定" aria-label="决定" disabled={busy} />
        <button type="submit" className="btn-ghost small" disabled={busy || !text.trim()}>
          回答
        </button>
      </form>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** The open decisions of one session, above its conversation (pinned: they stay in sight while it scrolls). */
export function SessionDecisions({ link, decisions }: { link: HostLink; decisions: readonly DecisionRequest[] }) {
  if (!decisions.length) return null;
  return (
    <section className="thread-decisions" aria-label="待决策" data-testid="thread-decisions">
      {decisions.map((d) => (
        <DecisionCard key={d.id} link={link} decision={d} />
      ))}
    </section>
  );
}

/**
 * Decisions other sessions of this task wait on (task page, right column): a line each that opens the session, where
 * the card itself sits above the conversation.
 */
export function DecisionPanel({ decisions, task, current, sessionTitle, onOpen }: { decisions: readonly DecisionRequest[]; task: Task; current: string | null; sessionTitle(id: string): string; onOpen(sessionId: string): void }) {
  const others = decisions.filter((d) => d.taskId === task.id && d.sessionId !== current);
  if (!others.length) return null;
  return (
    <section className="mail-panel" aria-label="其他会话待决策">
      <div className="anno-head">
        <span className="anno-title">其他会话待决策</span>
        <span className="anno-count" data-testid="decision-count">
          {others.length}
        </span>
      </div>
      {others.map((d) => (
        <div key={d.id} className="decision-elsewhere" data-testid="decision-elsewhere">
          <span className="decision-from">{sessionTitle(d.sessionId)} 在等你决定</span>
          <span className="decision-elsewhere-q">{d.question}</span>
          <button type="button" className="btn-ghost small" onClick={() => onOpen(d.sessionId)}>
            去回答
          </button>
        </div>
      ))}
    </section>
  );
}
