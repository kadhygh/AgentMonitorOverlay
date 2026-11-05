import { useMemo, useState } from "react";
import { answerValues, type DecisionRequest, type QuestionReply, type Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { keepWhere, useLiveResource } from "../host/live.js";
import { PromptCard } from "../chat/questions/QuestionCard.js";

/** Open decision requests across all tasks, kept live. */
export function useOpenDecisions(link: HostLink) {
  const [open] = useLiveResource<readonly DecisionRequest[]>(
    {
      load: () => call(link, "GET /api/decisions", {}, undefined, { state: "open" }),
      initial: [],
      onEvent: (cur, e) => (e.type === "decision.upserted" ? keepWhere(cur, e.decision, e.decision.state === "open") : cur),
    },
    [link],
  );
  return open;
}

/**
 * One question from an agent: pick an option or write an answer. The answer goes back to the asking session as mail,
 * or as a message once its turn is over (collab/service.ts deliverAnswer, 2026-11-05).
 * Options are whole rows that wrap (agents write long ones). The workbench uses DecisionPrompt below instead.
 * `onWriteElsewhere`: the Focus window cannot take keyboard focus, so instead of a text field it
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
        <span className="decision-kind">AMO MCP · 非阻断</span>
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

/** AMO's nonblocking decision uses the same popup as runtime questions, sending its answer as mail (or a message after the turn). */
export function DecisionPrompt({ link, decision, onClose }: { link: HostLink; decision: DecisionRequest; onClose(): void }) {
  const item = useMemo(() => ({
    id: decision.id,
    questions: [{ id: decision.id, question: decision.question, options: decision.options.map((label) => ({ label })), other: true }],
  }), [decision]);
  const answer = async (body: QuestionReply): Promise<string | null> => {
    if (body.action !== "answer") return "请选择选项或填写你的决定";
    const value = answerValues(body.answers[0]).join("、").trim();
    if (!value) return "请选择选项或填写你的决定";
    try {
      await call(link, "POST /api/decisions/:id/answer", { id: decision.id }, { answer: value });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  return <PromptCard key={decision.id} link={link} sessionId={decision.sessionId} item={item} eyebrow="等你决定" origin="跨工具请求 · AMO MCP" interaction="mail" onClose={onClose} onReply={answer} allowSkip={false} />;
}

/** Compact rows reopen a decision's popup; options no longer take space from the conversation. */
export function SessionDecisions({ decisions, openId, onOpen }: { decisions: readonly DecisionRequest[]; openId: string | null; onOpen?: (id: string) => void }) {
  if (!decisions.length) return null;
  return (
    <section className="thread-decisions" aria-label="待决策" data-testid="thread-decisions">
      {decisions.map((d) => (
        <div className="q-pending" key={d.id} data-testid="decision-record">
          <span className="decision-kind">AMO MCP · 非阻断</span>
          <span className="q-pending-text" title={d.question}>等你决定：{d.question}</span>
          {openId === d.id ? <span className="q-pending-hint">在弹出的卡片里回答</span> : <button type="button" className="btn-ghost small" disabled={!onOpen} onClick={() => onOpen?.(d.id)}>回答</button>}
        </div>
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
