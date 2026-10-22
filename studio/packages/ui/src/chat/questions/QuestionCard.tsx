import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fieldDefault, formContent, type FormField, type QuestionReply } from "@amo-studio/protocol";
import { call, type HostLink } from "../../host/client.js";
import { IconCheck, IconChevronDown, IconChevronRight, IconChevronUp, IconEdit, IconX } from "../icons.js";
import { advance, choose, goTo, isDraftAnswered, skipAndMaybeSubmit, startFlow, typeOther, type Flow, type QuestionItem } from "./flow.js";

// The card that takes the composer's seat while the agent waits for an answer (after DSH ui-user-questions, MIT):
// a pager over the questions, options with their descriptions, single choices that move on, multi-select ticks,
// "其他" free text, skipping, and submit. Closing only hides it (the transcript row opens it again); "不回答" tells
// the agent the person will not answer. MCP forms use the same frame with fields from the server's schema.

interface CardProps {
  link: HostLink;
  sessionId: string;
  item: QuestionItem;
  /** Hides the card; the session keeps waiting. */
  onClose(): void;
}

export function QuestionCard(props: CardProps) {
  return props.item.source === "mcp-form" ? <FormCard key={props.item.id} {...props} /> : <PromptCard key={props.item.id} {...props} eyebrow={SOURCE_LABEL[props.item.source]} interaction={props.item.source === "codex-async" ? "message" : "blocking"} />;
}

/** Sends a reply; resolves to an error message, or null when it went through. */
async function reply(link: HostLink, sessionId: string, itemId: string, body: QuestionReply): Promise<string | null> {
  try {
    await call(link, "POST /api/sessions/:id/questions/:itemId/answer", { id: sessionId, itemId }, body);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const SOURCE_LABEL: Record<QuestionItem["source"], string> = { "claude-ask": "Claude 在问你", "codex-input": "Codex 在问你", "codex-async": "Codex 在问你 · 回答会作为你的下一条消息", "mcp-form": "需要填写", "plan-review": "计划待审" };

/** Drafts survive closing the card (it opens again from the conversation) and are dropped once sent. */
const savedFlows = new Map<string, Flow>();
const savedValues = new Map<string, Record<string, unknown>>();

function useSender(link: HostLink, sessionId: string, itemId: string, onReply?: (body: QuestionReply) => Promise<string | null>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (body: QuestionReply) => {
    setBusy(true);
    setError(null);
    const failed = onReply ? await onReply(body) : await reply(link, sessionId, itemId, body);
    // On success the item stops being pending and the card goes away; keep it disabled until then.
    if (failed) {
      setBusy(false);
      setError(failed);
    } else {
      savedFlows.delete(itemId);
      savedValues.delete(itemId);
    }
  };
  return { busy, error, setError, send };
}

/** Source and waiting semantics are independent: an MCP form can block while an AMO decision does not. */
type Interaction = "blocking" | "mail" | "message";
const INTERACTION = {
  blocking: { label: "阻断式 · 等待回答", hint: "本次提问等待你回答后才会继续；关闭弹窗只隐藏问题。" },
  mail: { label: "非阻断 · 留言返回", hint: "提问不会阻断当前回合；答案作为 AMO 留言返回给发起会话。" },
  message: { label: "非阻断 · 下一条消息返回", hint: "提问不会阻断当前回合；答案作为你的下一条消息发回会话。" },
} as const;

function CardHead({ eyebrow, title, minimized, onMinimize, onClose, busy, interaction = "blocking", origin }: { eyebrow: string; title: string; minimized: boolean; onMinimize(): void; onClose(): void; busy: boolean; interaction?: Interaction; origin?: string }) {
  return (
    <header className="qc-head">
      <div className="qc-heading">
        <div className="qc-eyebrow">{eyebrow}</div>
        <div className="qc-tags" aria-label="提问类型">
          {origin && <span className="qc-kind" data-testid="question-origin">{origin}</span>}
          <span className="qc-kind" data-testid="question-kind" data-kind={interaction} title={INTERACTION[interaction].hint}>{INTERACTION[interaction].label}</span>
        </div>
        <h2 className="qc-title">{title}</h2>
      </div>
      <div className="qc-head-actions">
        <button type="button" className="icon-btn" aria-label={minimized ? "展开问题卡片" : "收起问题卡片"} title={minimized ? "展开" : "收起"} aria-expanded={!minimized} onClick={onMinimize}>
          {minimized ? <IconChevronUp /> : <IconChevronDown />}
        </button>
        <button type="button" className="icon-btn" aria-label="关闭问题卡片" title="关闭（之后可以在对话里重新打开）" disabled={busy} onClick={onClose}>
          <IconX />
        </button>
      </div>
    </header>
  );
}

// ---- questions --------------------------------------------------------------------------------------------------

/** Shared question UI: runtime questions and AMO decisions keep their own answer transport. */
export function PromptCard({ link, sessionId, item, onClose, eyebrow, onReply, allowSkip = true, interaction = "blocking", origin }: Omit<CardProps, "item"> & {
  item: Pick<QuestionItem, "id" | "questions">;
  eyebrow: string;
  onReply?: (body: QuestionReply) => Promise<string | null>;
  allowSkip?: boolean;
  interaction?: Interaction;
  origin?: string;
}) {
  const questions = item.questions ?? [];
  const [flow, setFlow] = useState<Flow>(() => savedFlows.get(item.id) ?? startFlow(questions));
  useEffect(() => {
    savedFlows.set(item.id, flow);
  }, [item.id, flow]);
  const [minimized, setMinimized] = useState(false);
  const { busy, error, setError, send } = useSender(link, sessionId, item.id, onReply);
  const card = useRef<HTMLElement>(null);
  const q = questions[flow.index];
  const draft = flow.drafts[flow.index];

  // The card holds the keys while it is open: focus it so Enter / Escape / 1-9 work at once.
  useEffect(() => {
    if (!card.current?.contains(document.activeElement)) card.current?.querySelector<HTMLElement>(".qc-other textarea, .qc-other input, .qc-option")?.focus();
  }, [flow.index]);

  if (!q || !draft) return null;
  const last = flow.index === questions.length - 1;

  const update = (next: Flow) => {
    setFlow(next);
    setError(null);
  };
  const run = (result: { flow: Flow; error?: string; submit?: ReturnType<typeof advance>["submit"] }) => {
    setFlow(result.flow);
    setError(result.error ?? null);
    if (result.submit) void send({ action: "answer", answers: result.submit });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const inText = (e.target as HTMLElement).matches("textarea, input");
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && !e.shiftKey && !busy) {
      e.preventDefault();
      run(advance(flow, questions));
    } else if (!inText && /^[1-9]$/.test(e.key) && !busy) {
      const option = q.options[Number(e.key) - 1];
      if (option) {
        e.preventDefault();
        update(choose(flow, questions, option.label));
      }
    }
  };

  return (
    <section className="qc" ref={card} data-testid="question-card" data-minimized={minimized || undefined} aria-label="回答问题" onKeyDown={onKey}>
      <CardHead
        interaction={interaction}
        origin={origin}
        eyebrow={[eyebrow, q.header].filter(Boolean).join(" · ")}
        title={q.question}
        minimized={minimized}
        onMinimize={() => setMinimized((v) => !v)}
        onClose={onClose}
        busy={busy}
      />
      {!minimized && (
        <>
          <div className="qc-body">
            <div className="qc-options" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
              {q.options.map((o, i) => {
                const on = draft.selected.includes(o.label);
                return (
                  <button
                    type="button"
                    key={`${o.label}-${i}`}
                    className={`qc-option${on ? " on" : ""}`}
                    role={q.multiSelect ? "checkbox" : "radio"}
                    aria-checked={on}
                    disabled={busy}
                    onClick={() => update(choose(flow, questions, o.label))}
                  >
                    {q.multiSelect ? (
                      <span className={`qc-check${on ? " on" : ""}`} aria-hidden="true">
                        {on && <IconCheck />}
                      </span>
                    ) : (
                      <span className="qc-num" aria-hidden="true">
                        {i + 1}
                      </span>
                    )}
                    <span className="qc-option-copy">
                      <span className="qc-option-label">{o.label}</span>
                      {o.description && <span className="qc-option-desc">{o.description}</span>}
                      {o.preview && on && <pre className="qc-preview">{o.preview}</pre>}
                    </span>
                  </button>
                );
              })}
              {(q.other || !q.options.length) && (
                <label className={`qc-other${q.options.length ? " inline" : " block"}${draft.other.trim() ? " on" : ""}`}>
                  {q.options.length > 0 && (
                    <span className={q.multiSelect ? `qc-check${draft.other.trim() ? " on" : ""}` : "qc-num"} aria-hidden="true">
                      {q.multiSelect ? draft.other.trim() && <IconCheck /> : <IconEdit />}
                    </span>
                  )}
                  <span className="sr-only">{q.options.length ? "其他答案" : "你的答案"}</span>
                  {q.secret ? (
                    <input
                      type="password"
                      autoComplete="off"
                      value={draft.other}
                      disabled={busy}
                      placeholder="输入后回车（不会保存在对话里）"
                      onChange={(e) => update(typeOther(flow, questions, e.target.value))}
                    />
                  ) : (
                    <textarea
                      rows={1}
                      value={draft.other}
                      disabled={busy}
                      placeholder={q.options.length ? "其他：写下你的答案" : "写下你的答案，回车继续，Shift+回车换行"}
                      onChange={(e) => update(typeOther(flow, questions, e.target.value))}
                    />
                  )}
                </label>
              )}
            </div>
          </div>
          <footer className="qc-foot">
            {questions.length > 1 && (
              <div className="qc-pager">
                <button type="button" className="icon-btn qc-back" aria-label="上一题" disabled={flow.index === 0 || busy} onClick={() => update(goTo(flow, flow.index - 1))}>
                  <IconChevronRight />
                </button>
                <span className="qc-progress">
                  {flow.index + 1} / {questions.length}
                </span>
                <button type="button" className="icon-btn" aria-label="下一题" disabled={last || busy} onClick={() => update(goTo(flow, flow.index + 1))}>
                  <IconChevronRight />
                </button>
              </div>
            )}
            <span className="qc-error" role="status">
              {error}
            </span>
            {allowSkip && <button type="button" className="btn-ghost small dim" disabled={busy} title="告诉 agent 你不回答，它会接着做" onClick={() => void send({ action: "dismiss" })}>
              不回答
            </button>}
            {allowSkip && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => run(skipAndMaybeSubmit(flow, questions))}>
              跳过
            </button>}
            <button type="button" className="btn-primary small" disabled={busy || !isDraftAnswered(draft)} onClick={() => run(advance(flow, questions))}>
              {busy ? "提交中…" : last ? "提交" : "下一题"}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

// ---- MCP forms --------------------------------------------------------------------------------------------------

function FormCard({ link, sessionId, item, onClose }: CardProps) {
  const fields = item.form ?? [];
  const [values, setValues] = useState<Record<string, unknown>>(() => savedValues.get(item.id) ?? Object.fromEntries(fields.map((f) => [f.name, fieldDefault(f)])));
  useEffect(() => {
    savedValues.set(item.id, values);
  }, [item.id, values]);
  const [bad, setBad] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const { busy, error, setError, send } = useSender(link, sessionId, item.id);
  const set = (name: string, v: unknown) => {
    setValues((cur) => ({ ...cur, [name]: v }));
    setBad(null);
    setError(null);
  };
  const submit = () => {
    const checked = formContent(fields, values);
    if ("error" in checked) {
      setBad(checked.field);
      setError(checked.error);
      return;
    }
    void send({ action: "submit", values });
  };
  return (
    <section
      className="qc"
      data-testid="question-card"
      data-minimized={minimized || undefined}
      aria-label="填写表单"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !(e.target as HTMLElement).matches("textarea, button")) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <CardHead eyebrow={[SOURCE_LABEL[item.source], item.serverName ? `MCP：${item.serverName}` : ""].filter(Boolean).join(" · ")} title={item.message || "请填写"} interaction="blocking" origin="跨工具请求 · MCP" minimized={minimized} onMinimize={() => setMinimized((v) => !v)} onClose={onClose} busy={busy} />
      {!minimized && (
        <>
          <div className="qc-body qc-form">
            {fields.map((f) => (
              <FieldRow key={f.name} field={f} value={values[f.name]} invalid={bad === f.name} disabled={busy} onChange={(v) => set(f.name, v)} />
            ))}
          </div>
          <footer className="qc-foot">
            <span className="qc-error" role="status">
              {error}
            </span>
            <button type="button" className="btn-ghost small dim" disabled={busy} onClick={() => void send({ action: "dismiss" })}>
              拒绝
            </button>
            <button type="button" className="btn-primary small" disabled={busy} onClick={submit}>
              {busy ? "提交中…" : "提交"}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

const INPUT_TYPE: Record<string, string> = { email: "email", uri: "url", date: "date", "date-time": "datetime-local" };

function FieldRow({ field: f, value, invalid, disabled, onChange }: { field: FormField; value: unknown; invalid: boolean; disabled: boolean; onChange(v: unknown): void }) {
  const label = (
    <span className="qc-field-label">
      {f.title}
      {f.required && <span className="qc-required"> *</span>}
    </span>
  );
  const desc = f.description ? <span className="qc-field-desc">{f.description}</span> : null;
  if (f.kind === "boolean") {
    return (
      <label className="qc-field qc-field-switch" data-invalid={invalid || undefined}>
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="qc-field-copy">
          {label}
          {desc}
        </span>
      </label>
    );
  }
  if (f.kind === "select" || f.kind === "multi") {
    const list = Array.isArray(value) ? value.map(String) : [];
    return (
      <fieldset className="qc-field" data-invalid={invalid || undefined}>
        <legend className="qc-field-copy">
          {label}
          {desc}
        </legend>
        <div className="qc-chips" role={f.kind === "multi" ? "group" : "radiogroup"}>
          {(f.options ?? []).map((o) => {
            const on = f.kind === "multi" ? list.includes(o.value) : value === o.value;
            return (
              <button
                type="button"
                key={o.value}
                className={`qc-chip${on ? " on" : ""}`}
                role={f.kind === "multi" ? "checkbox" : "radio"}
                aria-checked={on}
                disabled={disabled}
                onClick={() => onChange(f.kind === "multi" ? (on ? list.filter((v) => v !== o.value) : [...list, o.value]) : on && !f.required ? "" : o.value)}
              >
                {on && <IconCheck />}
                {o.label}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }
  return (
    <label className="qc-field" data-invalid={invalid || undefined}>
      <span className="qc-field-copy">
        {label}
        {desc}
      </span>
      <input
        className="qc-input"
        type={f.kind === "number" || f.kind === "integer" ? "number" : (INPUT_TYPE[f.format ?? ""] ?? "text")}
        {...(f.kind === "integer" ? { step: 1 } : f.kind === "number" ? { step: "any" } : {})}
        {...(f.kind !== "text" && f.min !== undefined ? { min: f.min } : {})}
        {...(f.kind !== "text" && f.max !== undefined ? { max: f.max } : {})}
        value={typeof value === "string" || typeof value === "number" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
