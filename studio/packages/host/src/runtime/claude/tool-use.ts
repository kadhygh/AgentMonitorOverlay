import type { QuestionPrompt, ToolFields } from "@amo-studio/protocol";
import { classifyCommand, fileDiff, formatInput, shortPath, textDiff } from "../items.js";

// Reading Claude Code's tool calls and results into Studio's rows (stage 16 split out of claude-runtime.ts).

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("");
}

/** Whether a tool result carries an image block (Read of an image file). */
export function hasImageBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "image");
}

/** Row fields for a Claude tool call (everything but its status and result). */
export function describeToolUse(name: string, input: Record<string, unknown>, cwd?: string): Omit<ToolFields, "status"> {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const path = shortPath(str(input.file_path ?? input.notebook_path ?? input.path), cwd);
  switch (name) {
    case "Bash":
    case "PowerShell": {
      const command = str(input.command);
      const guess = classifyCommand(command);
      const summary = guess ? (guess.kind === "search" ? guess.target : shortPath(guess.target, cwd)) : command;
      return { name: "shell", kind: guess?.kind ?? "command", summary, input: command, ...(cwd ? { cwd } : {}) };
    }
    case "Edit": {
      const diff = textDiff(str(input.old_string), str(input.new_string));
      return { name: "edit", kind: "edit", summary: path, files: [fileDiff(path, "update", diff)] };
    }
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
      const diff = edits.map((e) => textDiff(str(e.old_string), str(e.new_string))).join("\n");
      return { name: "edit", kind: "edit", summary: path, files: [fileDiff(path, "update", diff)] };
    }
    case "Write":
      return { name: "write", kind: "edit", summary: path, files: [fileDiff(path, "add", textDiff("", str(input.content)))] };
    case "NotebookEdit":
      return { name: "edit", kind: "edit", summary: path, files: [fileDiff(path, "update", textDiff("", str(input.new_source)))] };
    case "Read":
      return { name: "read", kind: "read", summary: path };
    case "LS":
      return { name: "ls", kind: "list", summary: path || "." };
    case "Grep":
    case "Glob":
      return { name: name.toLowerCase(), kind: "search", summary: [str(input.pattern), path].filter(Boolean).join(" · "), ...(formatInput(input) ? { input: formatInput(input)! } : {}) };
    case "WebSearch":
      return { name: "web_search", kind: "web", summary: str(input.query) };
    case "WebFetch":
      return { name: "web_fetch", kind: "web", summary: str(input.url) };
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
      const done = todos.filter((t) => t.status === "completed").length;
      const mark = (st: unknown) => (st === "completed" ? "✓" : st === "in_progress" ? "→" : "○");
      return { name: "update_plan", kind: "plan", summary: `${done}/${todos.length} 已完成`, input: todos.map((t) => `${mark(t.status)} ${str(t.content)}`).join("\n") };
    }
    case "Agent":
    case "Task":
      return { name: "agent", kind: "subagent", summary: str(input.description) };
    default: {
      const args = formatInput(input);
      return { name, kind: name.startsWith("mcp__") ? "mcp" : "other", summary: str(input.description), ...(args ? { input: args } : {}) };
    }
  }
}

/** AskUserQuestion's questions (keyed by their text, as Claude keys the answers); malformed entries are left out. */
export function askedQuestions(input: Record<string, unknown>): QuestionPrompt[] {
  const list = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return list
    .filter((q) => q && typeof q === "object" && str(q.question))
    .map((q) => ({
      id: str(q.question),
      question: str(q.question),
      ...(str(q.header) ? { header: str(q.header) } : {}),
      options: (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [])
        .filter((o) => o && typeof o === "object" && str(o.label))
        .map((o) => ({ label: str(o.label), ...(str(o.description) ? { description: str(o.description) } : {}), ...(str(o.preview) ? { preview: str(o.preview) } : {}) })),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      // Claude Code's own dialog always offers "Other" (free text).
      other: true,
    }));
}

const RETRY_REASONS: Record<string, string> = {
  rate_limit: "触发限流",
  overloaded: "服务繁忙",
  server_error: "服务出错",
  authentication_failed: "认证失败",
  billing_error: "账户额度不足",
  invalid_request: "请求无效",
  model_not_found: "找不到模型",
  max_output_tokens: "输出超长",
  unknown: "请求失败",
};

/** Why Claude Code retries a model request, as the running status line says it ("服务繁忙（529）"). */
export function retryReason(error: string, status: number | null): string {
  const what = RETRY_REASONS[error] ?? (error || "请求失败");
  return status ? `${what}（${status}）` : what;
}

export const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split(/\r?\n/)[0]!.slice(0, 300);
