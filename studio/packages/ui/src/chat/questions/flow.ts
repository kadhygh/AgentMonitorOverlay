import { answerValues, isAnswered, type FormField, type QuestionAnswer, type QuestionPrompt, type SessionItem } from "@amo-studio/protocol";

// The answering flow of a question card (after DSH ui-user-questions, MIT): one draft per question, a pager, single
// choices that move on, multi-select, "其他" text, skipping. Pure, so the card stays a thin view.

export type QuestionItem = Extract<SessionItem, { type: "question" }>;

export interface Draft {
  selected: string[];
  other: string;
  skipped: boolean;
}

export interface Flow {
  index: number;
  drafts: Draft[];
}

export const startFlow = (questions: readonly QuestionPrompt[]): Flow => ({ index: 0, drafts: questions.map(() => ({ selected: [], other: "", skipped: false })) });

const answeredDraft = (d: Draft | undefined) => !!d && !d.skipped && (d.selected.length > 0 || d.other.trim() !== "");
const settled = (d: Draft | undefined) => !!d && (d.skipped || answeredDraft(d));
export { answeredDraft as isDraftAnswered };

function withDraft(flow: Flow, draft: Draft, index: number): Flow {
  return { index, drafts: flow.drafts.map((d, i) => (i === flow.index ? draft : d)) };
}

/** Picks an option: a single choice replaces the draft and moves to the next question; multi-select toggles. */
export function choose(flow: Flow, questions: readonly QuestionPrompt[], label: string): Flow {
  const q = questions[flow.index]!;
  const d = flow.drafts[flow.index]!;
  if (q.multiSelect) {
    const selected = d.selected.includes(label) ? d.selected.filter((l) => l !== label) : [...d.selected, label];
    return withDraft(flow, { ...d, selected, skipped: false }, flow.index);
  }
  return withDraft(flow, { selected: [label], other: "", skipped: false }, Math.min(flow.index + 1, questions.length - 1));
}

/** Typing "其他": a single choice gives way to the text; multi-select keeps its ticks. */
export function typeOther(flow: Flow, questions: readonly QuestionPrompt[], text: string): Flow {
  const q = questions[flow.index]!;
  const d = flow.drafts[flow.index]!;
  return withDraft(flow, { selected: q.multiSelect ? d.selected : [], other: text, skipped: false }, flow.index);
}

export function skip(flow: Flow, questions: readonly QuestionPrompt[]): Flow {
  return withDraft(flow, { selected: [], other: "", skipped: true }, Math.min(flow.index + 1, questions.length - 1));
}

export const goTo = (flow: Flow, index: number): Flow => ({ ...flow, index });

/**
 * "下一题" / "提交": on an unanswered question, says so; before the last, moves on; on the last, submits unless an
 * earlier question is still open (then goes back to it).
 */
export function advance(flow: Flow, questions: readonly QuestionPrompt[]): { flow: Flow; error?: string; submit?: QuestionAnswer[] } {
  if (!settled(flow.drafts[flow.index])) return { flow, error: "选一个选项、填写答案，或者跳过这一题" };
  if (flow.index < questions.length - 1) return { flow: goTo(flow, flow.index + 1) };
  const open = flow.drafts.findIndex((d) => !settled(d));
  if (open >= 0) return { flow: goTo(flow, open), error: "还有问题没有回答" };
  return { flow, submit: toAnswers(questions, flow.drafts) };
}

/** Skipping the last question submits at once (when nothing else is open). */
export function skipAndMaybeSubmit(flow: Flow, questions: readonly QuestionPrompt[]): { flow: Flow; error?: string; submit?: QuestionAnswer[] } {
  const last = flow.index === questions.length - 1;
  const next = skip(flow, questions);
  if (!last) return { flow: next };
  return advance(next, questions);
}

export function toAnswers(questions: readonly QuestionPrompt[], drafts: readonly Draft[]): QuestionAnswer[] {
  return questions.map((q, i) => {
    const d = drafts[i]!;
    if (!answeredDraft(d)) return { id: q.id, selected: [], skipped: true };
    const other = d.other.trim();
    return { id: q.id, selected: d.selected, ...(other ? { other } : {}) };
  });
}

// ---- reading items --------------------------------------------------------------------------------------------------

/** The question the session waits on: the oldest one still pending. */
export function pendingQuestion(items: readonly SessionItem[]): QuestionItem | null {
  return (items.find((i) => i.type === "question" && i.state === "pending") as QuestionItem | undefined) ?? null;
}

/** One answer as read back: the values, or "已跳过". */
export function answerText(a: QuestionAnswer | undefined): string {
  return isAnswered(a) ? answerValues(a).join("、") : "已跳过";
}

/** The one-line summary of an answered batch. */
export function answersSummary(item: QuestionItem): string {
  if (item.source === "mcp-form") return formSummary(item.form ?? [], item.values ?? {});
  const answers = item.answers ?? [];
  if (!answers.length) return "";
  const parts = (item.questions ?? []).map((q) => answers.find((a) => a.id === q.id)).filter(isAnswered).map((a) => answerValues(a).join("、"));
  return parts.length ? parts.join(" · ") : "全部跳过";
}

/** A form value as shown: option labels, 是/否, the text. */
export function formValueText(field: FormField, value: unknown): string {
  if (value === undefined || value === null || value === "") return "（未填）";
  if (field.kind === "boolean") return value === true ? "是" : "否";
  const label = (v: unknown) => field.options?.find((o) => o.value === String(v))?.label ?? String(v);
  if (Array.isArray(value)) return value.length ? value.map(label).join("、") : "（未选）";
  return field.kind === "select" ? label(value) : String(value);
}

export function formSummary(fields: readonly FormField[], values: Record<string, unknown>): string {
  return fields
    .filter((f) => values[f.name] !== undefined)
    .map((f) => `${f.title}：${formValueText(f, values[f.name])}`)
    .join(" · ");
}

/** The plan's title: its first heading, else its first line. */
export function planTitle(plan: string): string {
  const lines = plan.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,6}\s/.test(l));
  return (heading ?? lines[0] ?? "计划").replace(/^#{1,6}\s+/, "").slice(0, 120);
}

/** Plans longer than this fold in the conversation until opened. */
export const LONG_PLAN_LINES = 14;
export const isLongPlan = (plan: string) => plan.split(/\r?\n/).length > LONG_PLAN_LINES || plan.length > 1200;
