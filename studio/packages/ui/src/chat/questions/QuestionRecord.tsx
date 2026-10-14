import { createContext, useContext, useState } from "react";
import { IconChevronDown, IconChevronRight, IconSparkle } from "../icons.js";
import { answersSummary, answerText, formValueText, type QuestionItem } from "./flow.js";
import { PlanCard } from "./PlanReview.js";

// A question in the conversation. While pending: a row that says the agent waits, with "回答" to open its card again
// over the conversation. Once answered: a compact reply (after DSH's question-reply bubble, MIT) that opens to show
// each question and its answer.

/** What the composer offers the transcript: whether a question's card is showing, and showing it again. */
export interface QuestionSeat {
  isOpen(itemId: string): boolean;
  reopen(itemId: string): void;
}
export const QuestionSeatContext = createContext<QuestionSeat | null>(null);

export function QuestionRecord({ item }: { item: QuestionItem }) {
  if (item.source === "plan-review") return <PlanCard item={item} />;
  if (item.state === "pending") return <PendingRow item={item} />;
  return <SettledRecord item={item} />;
}

function PendingRow({ item }: { item: QuestionItem }) {
  const seat = useContext(QuestionSeatContext);
  const open = seat?.isOpen(item.id) ?? false;
  const count = item.source === "mcp-form" ? 0 : (item.questions?.length ?? 0);
  return (
    <div className="q-pending" data-testid="question-record" data-state="pending">
      <IconSparkle />
      <span className="q-pending-text">
        {item.source === "mcp-form" ? `等你填写：${item.message || "表单"}` : `等你回答${count > 1 ? ` ${count} 个问题` : ""}：${item.questions?.[0]?.question ?? ""}`}
      </span>
      {open ? (
        <span className="q-pending-hint">在弹出的卡片里回答</span>
      ) : (
        <button type="button" className="btn-ghost small" onClick={() => seat?.reopen(item.id)}>
          回答
        </button>
      )}
    </div>
  );
}

const SETTLED_LABEL: Record<Exclude<QuestionItem["state"], "pending">, string> = { answered: "已回答", dismissed: "没有回答", cancelled: "提问已取消" };

function SettledRecord({ item }: { item: QuestionItem }) {
  const [open, setOpen] = useState(false);
  const elsewhere = item.state === "answered" && !item.answers && !item.values;
  // Codex's async questions are also answered by whatever the person writes next.
  const label = elsewhere ? (item.source === "codex-async" ? "已用你的下一条消息回答" : "已在别处回答") : SETTLED_LABEL[item.state as Exclude<QuestionItem["state"], "pending">];
  const summary = item.state === "answered" ? answersSummary(item) : item.state === "dismissed" ? "你关闭了提问，agent 已接着做" : "这一轮结束时还没有回答";
  return (
    <div className="q-reply-row" data-testid="question-record" data-state={item.state}>
      <div className={`q-reply${item.state === "answered" ? "" : " muted"}`}>
        <button type="button" className="q-reply-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="q-reply-caret" aria-hidden="true">
            {open ? <IconChevronDown /> : <IconChevronRight />}
          </span>
          <span className="q-reply-label">{label}</span>
          {!open && summary && <span className="q-reply-summary">{summary}</span>}
        </button>
        {open && (
          <dl className="q-reply-details">
            {item.source === "mcp-form"
              ? (item.form ?? []).map((f) => (
                  <div key={f.name}>
                    <dt>{f.title}</dt>
                    <dd>{item.values ? formValueText(f, item.values[f.name]) : "—"}</dd>
                  </div>
                ))
              : (item.questions ?? []).map((q) => (
                  <div key={q.id}>
                    <dt>
                      {q.header && <span className="q-reply-header">{q.header}</span>}
                      {q.question}
                    </dt>
                    <dd>{item.answers ? answerText(item.answers.find((a) => a.id === q.id)) : "—"}</dd>
                  </div>
                ))}
          </dl>
        )}
      </div>
    </div>
  );
}
