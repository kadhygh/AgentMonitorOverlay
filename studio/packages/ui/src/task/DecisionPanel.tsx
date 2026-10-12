import { useEffect, useState } from "react";
import type { DecisionRequest, Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

/** Open decision requests across all tasks, kept live. */
export function useOpenDecisions(link: HostLink) {
  const [open, setOpen] = useState<readonly DecisionRequest[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      call(link, "GET /api/decisions", {}, undefined, { state: "open" })
        .then((list) => !cancelled && setOpen(list))
        .catch(() => undefined);
    const off = onHostEvent((e) => {
      if (e.type !== "decision.upserted") return;
      setOpen((cur) => {
        const rest = cur.filter((d) => d.id !== e.decision.id);
        return e.decision.state === "open" ? [...rest, e.decision] : rest;
      });
    });
    const offReconnect = onHostReconnect(() => void load());
    void load();
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
 * `onWriteElsewhere`: the Focus window cannot take keyboard focus, so instead of a text field it offers to answer in
 * the workbench.
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
  sessionTitle: string;
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
      <span className="decision-from">{sessionTitle} 在问</span>
      <span className="decision-question">{decision.question}</span>
      {decision.options.length > 0 && (
        <div className="decision-options">
          {decision.options.map((o) => (
            <button key={o} type="button" className="btn-outline-attention small" disabled={busy} onClick={() => void answer(o)}>
              {o}
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

/** Decisions waiting on the person for this task (task page, right column). */
export function DecisionPanel({ link, decisions, task, sessionTitle }: { link: HostLink; decisions: readonly DecisionRequest[]; task: Task; sessionTitle(id: string): string }) {
  const mine = decisions.filter((d) => d.taskId === task.id);
  if (!mine.length) return null;
  return (
    <section className="mail-panel" aria-label="待决策">
      <div className="anno-head">
        <span className="anno-title">待决策</span>
        <span className="anno-count" data-testid="decision-count">
          {mine.length}
        </span>
      </div>
      {mine.map((d) => (
        <DecisionCard key={d.id} link={link} decision={d} sessionTitle={sessionTitle(d.sessionId)} />
      ))}
    </section>
  );
}
