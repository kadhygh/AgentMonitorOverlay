// Questions the agent asks the person in the conversation (stage 12, S12-B): Claude's AskUserQuestion, Codex's
// request_user_input, an MCP server's form (elicitation with a schema) and Claude's plan review (ExitPlanMode). Each is
// one `question` item; the person answers it through `POST /api/sessions/:id/questions/:itemId/answer`.

/** Where a question came from. */
export type QuestionSource = "claude-ask" | "codex-input" | "mcp-form" | "plan-review";

/**
 * - pending: waiting for the person
 * - answered: answered (here, or — without recorded answers — in an attached terminal)
 * - dismissed: the person closed it without answering (the agent is told so and carries on)
 * - cancelled: the turn ended first (interrupt, error, Host restart)
 */
export type QuestionState = "pending" | "answered" | "dismissed" | "cancelled";

export interface QuestionOption {
  label: string;
  description?: string;
  /** Claude: content shown when the option is focused (code, a mockup). */
  preview?: string;
}

/** One question of a batch. */
export interface QuestionPrompt {
  /** Codex: the question's id; Claude: its text (Claude keys answers by text). */
  id: string;
  /** Short label above the question. */
  header?: string;
  question: string;
  /** Empty: the answer is free text. */
  options: QuestionOption[];
  multiSelect?: boolean;
  /** A free-text answer ("其他") besides the options. */
  other?: boolean;
  /** The answer is a secret: typed in a password field, never stored. */
  secret?: boolean;
}

/** One field of an MCP form, read from the server's JSON schema. */
export interface FormField {
  name: string;
  kind: "text" | "number" | "integer" | "boolean" | "select" | "multi";
  title: string;
  description?: string;
  required: boolean;
  /** select / multi */
  options?: Array<{ value: string; label: string }>;
  default?: string | number | boolean | string[];
  /** number / integer: the value; text: its length; multi: how many. */
  min?: number;
  max?: number;
  /** text: email, uri, date, date-time */
  format?: string;
}

/** The person's answer to one question. A skipped question has no selection and no text. */
export interface QuestionAnswer {
  id: string;
  /** Labels of the options chosen. */
  selected: string[];
  /** Free text: "其他", or the whole answer of a question without options. Stored as SECRET_MASK for a secret. */
  other?: string;
  skipped?: boolean;
}

/** What a secret answer is stored as. */
export const SECRET_MASK = "（已隐藏）";

/** The fields of a `question` item. */
export interface QuestionFields {
  source: QuestionSource;
  state: QuestionState;
  /** The questions (claude-ask, codex-input). */
  questions?: QuestionPrompt[];
  /** mcp-form: the server's message, its fields and the server's name. */
  message?: string;
  form?: FormField[];
  serverName?: string;
  /** plan-review: the plan (Markdown). */
  plan?: string;
  /** What the person answered (absent when answered elsewhere). */
  answers?: QuestionAnswer[];
  /** mcp-form: the values submitted. */
  values?: Record<string, unknown>;
  /** plan-review: the changes asked for. */
  feedback?: string;
}

/** The person's reply to a question item. */
export type QuestionReply =
  /** claude-ask, codex-input */
  | { action: "answer"; answers: QuestionAnswer[] }
  /** mcp-form */
  | { action: "submit"; values: Record<string, unknown> }
  /** plan-review: approve and start (the session leaves plan mode) */
  | { action: "approve" }
  /** plan-review: ask for changes */
  | { action: "revise"; feedback: string }
  /** Any: close without answering. */
  | { action: "dismiss" };

// ---- answers --------------------------------------------------------------------------------------------------------

/** Whether a question has an answer (an option or some text). */
export const isAnswered = (a: QuestionAnswer | undefined): boolean => !!a && !a.skipped && (a.selected.length > 0 || !!a.other?.trim());

/** The values of one answer, in order: the options chosen, then the free text. */
export function answerValues(a: QuestionAnswer | undefined): string[] {
  if (!a || a.skipped) return [];
  const other = a.other?.trim();
  return [...a.selected, ...(other ? [other] : [])];
}

/** Claude Code joins multi-select labels with ", ", quoting a label that has ", " or a quote in it. */
const claudeJoin = (values: string[]) => values.map((v) => (v.includes(", ") || v.includes('"') ? JSON.stringify(v) : v)).join(", ");

/**
 * AskUserQuestion's `answers` and `annotations`, as Claude Code's own permission dialog fills them: keyed by question
 * text; a single choice is its label, several are joined with ", "; free text is the answer itself. A skipped question
 * has no entry. The preview of a chosen option goes into the annotations (the CLI echoes it back to the model).
 */
export function claudeAnswers(questions: readonly QuestionPrompt[], answers: readonly QuestionAnswer[]): { answers: Record<string, string>; annotations?: Record<string, { preview?: string }> } {
  const out: Record<string, string> = {};
  const notes: Record<string, { preview?: string }> = {};
  for (const q of questions) {
    const a = answers.find((x) => x.id === q.id);
    const values = answerValues(a);
    if (!values.length) continue;
    out[q.question] = q.multiSelect ? claudeJoin(values) : (a!.other?.trim() || values[0]!);
    const preview = q.options.find((o) => a!.selected.includes(o.label) && o.preview)?.preview;
    if (preview) notes[q.question] = { preview };
  }
  return Object.keys(notes).length ? { answers: out, annotations: notes } : { answers: out };
}

/** request_user_input's response: answers by question id; a skipped question has none. */
export function codexAnswers(questions: readonly QuestionPrompt[], answers: readonly QuestionAnswer[]): { answers: Record<string, { answers: string[] }> } {
  const out: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    const values = answerValues(answers.find((x) => x.id === q.id));
    if (values.length) out[q.id] = { answers: values };
  }
  return { answers: out };
}

/** Answers as they are kept on the item: only known questions, secrets masked. */
export function storedAnswers(questions: readonly QuestionPrompt[], answers: readonly QuestionAnswer[]): QuestionAnswer[] {
  return questions.map((q) => {
    const a = answers.find((x) => x.id === q.id);
    if (!isAnswered(a)) return { id: q.id, selected: [], skipped: true };
    const other = a!.other?.trim();
    return {
      id: q.id,
      selected: q.secret ? [] : a!.selected.filter((l) => q.options.some((o) => o.label === l)),
      ...(other || (q.secret && a!.selected.length) ? { other: q.secret ? SECRET_MASK : other } : {}),
    };
  });
}

// ---- MCP forms ------------------------------------------------------------------------------------------------------

type Schema = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** One property of an elicitation schema as a field; null for shapes Studio does not know. */
function fieldOf(name: string, p: Schema, required: boolean): FormField | null {
  const base = { name, title: text(p.title) ?? name, ...(text(p.description) ? { description: text(p.description)! } : {}), required };
  const options = (list: unknown, names?: unknown): FormField["options"] =>
    Array.isArray(list) ? list.map((v, i) => ({ value: String(v), label: Array.isArray(names) && typeof names[i] === "string" ? names[i] : String(v) })) : undefined;
  const titled = (list: unknown): FormField["options"] =>
    Array.isArray(list) ? list.filter((o) => o && typeof o === "object").map((o) => ({ value: String((o as Schema).const), label: text((o as Schema).title) ?? String((o as Schema).const) })) : undefined;
  if (p.type === "string" && (Array.isArray(p.enum) || Array.isArray(p.oneOf))) {
    const opts = Array.isArray(p.oneOf) ? titled(p.oneOf) : options(p.enum, p.enumNames);
    return { ...base, kind: "select", options: opts ?? [], ...(typeof p.default === "string" ? { default: p.default } : {}) };
  }
  if (p.type === "array" && p.items && typeof p.items === "object") {
    const items = p.items as Schema;
    const opts = Array.isArray(items.anyOf) ? titled(items.anyOf) : options(items.enum);
    if (!opts) return null;
    return {
      ...base,
      kind: "multi",
      options: opts,
      ...(Array.isArray(p.default) ? { default: p.default.map(String) } : {}),
      ...(num(p.minItems) !== undefined ? { min: num(p.minItems)! } : {}),
      ...(num(p.maxItems) !== undefined ? { max: num(p.maxItems)! } : {}),
    };
  }
  if (p.type === "string") {
    return {
      ...base,
      kind: "text",
      ...(typeof p.default === "string" ? { default: p.default } : {}),
      ...(num(p.minLength) !== undefined ? { min: num(p.minLength)! } : {}),
      ...(num(p.maxLength) !== undefined ? { max: num(p.maxLength)! } : {}),
      ...(text(p.format) ? { format: text(p.format)! } : {}),
    };
  }
  if (p.type === "number" || p.type === "integer") {
    return {
      ...base,
      kind: p.type,
      ...(typeof p.default === "number" ? { default: p.default } : {}),
      ...(num(p.minimum) !== undefined ? { min: num(p.minimum)! } : {}),
      ...(num(p.maximum) !== undefined ? { max: num(p.maximum)! } : {}),
    };
  }
  if (p.type === "boolean") return { ...base, kind: "boolean", ...(typeof p.default === "boolean" ? { default: p.default } : {}) };
  return null;
}

/**
 * The fields of an elicitation's `requestedSchema` (MCP 2025-11-25 form mode: an object of primitive properties).
 * Null when there is nothing to fill in (no properties, or a shape Studio cannot show): the request is then a plain
 * accept / decline.
 */
export function elicitationForm(schema: unknown): FormField[] | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Schema;
  const props = s.properties && typeof s.properties === "object" ? (s.properties as Record<string, Schema>) : {};
  const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
  const fields: FormField[] = [];
  for (const [name, p] of Object.entries(props)) {
    if (!p || typeof p !== "object") return null;
    const f = fieldOf(name, p, required.has(name));
    if (!f) return null;
    fields.push(f);
  }
  return fields.length ? fields : null;
}

/** A field's starting value: its default, else empty. */
export function fieldDefault(f: FormField): unknown {
  if (f.default !== undefined) return f.default;
  return f.kind === "boolean" ? false : f.kind === "multi" ? [] : "";
}

/**
 * The `content` of an accepted elicitation from what was typed (numbers parsed, empty optional fields left out), or
 * the first problem found, in Chinese for the form.
 */
export function formContent(fields: readonly FormField[], raw: Record<string, unknown>): { content: Record<string, unknown> } | { error: string; field: string } {
  const content: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.name];
    const fail = (error: string) => ({ error: `${f.title}：${error}`, field: f.name });
    switch (f.kind) {
      case "boolean":
        content[f.name] = v === true;
        break;
      case "multi": {
        const list = Array.isArray(v) ? v.map(String).filter((x) => f.options?.some((o) => o.value === x)) : [];
        if (f.required && !list.length) return fail("至少选一项");
        if (f.min !== undefined && list.length < f.min && (list.length || f.required)) return fail(`至少选 ${f.min} 项`);
        if (f.max !== undefined && list.length > f.max) return fail(`最多选 ${f.max} 项`);
        if (list.length || f.required) content[f.name] = list;
        break;
      }
      case "number":
      case "integer": {
        const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
        if (!s) {
          if (f.required) return fail("必填");
          break;
        }
        const n = Number(s);
        if (!Number.isFinite(n)) return fail("要填数字");
        if (f.kind === "integer" && !Number.isInteger(n)) return fail("要填整数");
        if (f.min !== undefined && n < f.min) return fail(`不能小于 ${f.min}`);
        if (f.max !== undefined && n > f.max) return fail(`不能大于 ${f.max}`);
        content[f.name] = n;
        break;
      }
      default: {
        const s = typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
        if (!s.trim()) {
          if (f.required) return fail(f.kind === "select" ? "请选一项" : "必填");
          break;
        }
        if (f.kind === "select" && !f.options?.some((o) => o.value === s)) return fail("请选一项");
        if (f.kind === "text" && f.min !== undefined && s.length < f.min) return fail(`至少 ${f.min} 个字`);
        if (f.kind === "text" && f.max !== undefined && s.length > f.max) return fail(`最多 ${f.max} 个字`);
        content[f.name] = s;
      }
    }
  }
  return { content };
}
