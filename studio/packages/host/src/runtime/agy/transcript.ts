import type { ApprovalKind, FileDiff, Id, SessionItem, ToolFields, ToolKind, ToolStatus } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import type { RuntimeCore } from "../runtime.js";
import { classifyCommand, fileDiff, formatInput, head, shortPath, tail, textDiff } from "../items.js";

// An agy session's ACP updates as Studio rows (plans/agy.md, 2026-11-24). Unlike DSH's (whole blocks per message), agy
// is taken to stream text as deltas (t3code's driver merges them; not seen here yet — the account was not verified, so
// no turn ran): chunks of one kind join the row being written until something else comes between. Tool calls are read
// from ACP's own fields (kind, title, locations, content with `diff` blocks), not from tool names, which are agy's own
// and unknown until a real turn runs.

export interface AcpUpdate {
  sessionUpdate: string;
  messageId?: string;
  content?: unknown;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: Array<{ path?: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
  used?: number;
  size?: number;
  currentModeId?: string;
}

export class AgyTranscript {
  private turn: { turnId: string; itemId: Id } | null = null;
  /** The row being written: more text of the same kind (and message, when agy names one) joins it. */
  private last: { type: "agent" | "reasoning"; messageId: string | undefined; itemId: Id } | null = null;
  private readonly tools = new Map<string, { itemId: Id; fields: Omit<ToolFields, "status">; rawInput: unknown }>();

  constructor(
    private readonly core: RuntimeCore,
    private readonly sessionId: Id,
    private readonly cwd?: string,
  ) {}

  turnRef(): { turnId?: string } {
    return this.turn ? { turnId: this.turn.turnId } : {};
  }

  turnItemId(): Id | null {
    return this.turn?.itemId ?? null;
  }

  openTurn(): void {
    const turnId = newId("t");
    const item = this.core.appendItem(this.sessionId, { type: "turn", turnId, state: "running", startedAt: this.core.now().toISOString() }, { method: "session/prompt", turnId });
    this.turn = { turnId, itemId: item.id };
    this.last = null;
  }

  /** The prompt settled: its stop reason (or the error) ends the turn; tools still running were cut off. */
  closeTurn(stopReason: string, error?: string): void {
    const turn = this.turn;
    this.turn = null;
    this.last = null;
    if (!turn) return;
    const state = error ? "failed" : stopReason === "cancelled" ? "interrupted" : "completed";
    const endedAt = this.core.now().toISOString();
    this.core.updateItem(turn.itemId, (it) => (it.type === "turn" ? { ...it, state, endedAt, ...(error ? { error } : {}) } : it));
    for (const [callId, t] of this.tools) {
      this.core.updateItem(t.itemId, (it) => (it.type === "tool" && it.status === "running" ? { ...it, status: "declined" } : it));
      this.tools.delete(callId);
    }
    const note = STOP_NOTES[stopReason];
    if (note && !error) this.core.appendItem(this.sessionId, { type: "notice", level: "warning", message: note }, { method: "session/prompt", turnId: turn.turnId });
  }

  update(u: AcpUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = blockText(u.content);
        if (!text) return;
        const type = u.sessionUpdate === "agent_message_chunk" ? "agent" : "reasoning";
        const last = this.last;
        if (last && last.type === type && (!u.messageId || !last.messageId || last.messageId === u.messageId)) {
          this.core.updateItem(last.itemId, (it) => (it.type === "agent" ? { ...it, markdown: it.markdown + text } : it.type === "reasoning" ? { ...it, text: it.text + text } : it));
          return;
        }
        const body = type === "agent" ? { type: "agent" as const, markdown: text, streaming: false } : { type: "reasoning" as const, text, streaming: false };
        const item = this.core.appendItem(this.sessionId, body, { method: u.sessionUpdate, ...(u.messageId ? { itemId: u.messageId } : {}), ...this.turnRef() });
        this.last = { type, messageId: u.messageId, itemId: item.id };
        return;
      }
      case "tool_call": {
        if (!u.toolCallId) return;
        this.last = null;
        // agy may send a call again with more in it (as tool_call, not only tool_call_update): one row per call.
        if (this.tools.has(u.toolCallId)) return this.update({ ...u, sessionUpdate: "tool_call_update" });
        const fields = describeAcpTool(u, this.cwd);
        const item = this.core.appendItem(this.sessionId, { type: "tool", ...fields, status: toolStatus(u.status) ?? "running" }, { method: "tool_call", itemId: u.toolCallId, ...this.turnRef() });
        this.tools.set(u.toolCallId, { itemId: item.id, fields, rawInput: u.rawInput });
        return;
      }
      case "tool_call_update": {
        const t = u.toolCallId ? this.tools.get(u.toolCallId) : undefined;
        if (!t) return;
        const status = toolStatus(u.status);
        const output = toolOutput(u.content) || (u.rawOutput !== undefined ? (formatInput(u.rawOutput) ?? "") : "");
        // A fuller description (a diff, the command) when the update brings one; what it leaves out stays.
        const more = u.kind !== undefined || u.title !== undefined || u.rawInput !== undefined || hasDiff(u.content) ? describeAcpTool({ ...u, kind: u.kind ?? t.fields.kind, title: u.title ?? t.fields.summary, rawInput: u.rawInput ?? t.rawInput }, this.cwd) : null;
        if (more) t.fields = { ...t.fields, ...more, ...(more.files || !t.fields.files ? {} : { files: t.fields.files }) };
        if (u.rawInput !== undefined) t.rawInput = u.rawInput;
        this.core.updateItem(t.itemId, (it) => (it.type === "tool" ? { ...it, ...(more ? t.fields : {}), ...(status ? { status } : {}), ...(output ? { detail: tail(output) } : {}) } : it));
        if (status && status !== "running") this.tools.delete(u.toolCallId!);
        return;
      }
      case "usage_update": {
        if (!this.turn || typeof u.used !== "number") return;
        const context = u.used;
        const window = typeof u.size === "number" ? u.size : undefined;
        this.core.updateItem(this.turn.itemId, (it) =>
          it.type === "turn" ? { ...it, usage: { input: it.usage?.input ?? 0, cachedInput: it.usage?.cachedInput ?? 0, output: it.usage?.output ?? 0, reasoning: 0, context, ...(window ? { contextWindow: window } : {}) } } : it,
        );
        return;
      }
      default:
        // config_option_update, current_mode_update, available_commands_update, plan…: nothing to show.
        return;
    }
  }

  /** What an approval card shows for a tool call agy asks about. */
  approvalText(toolCallId: string | undefined, toolCall?: AcpUpdate): { kind: ApprovalKind; summary: string; detail?: string } {
    const known = toolCallId ? this.tools.get(toolCallId) : undefined;
    const item: SessionItem | undefined = known ? this.core.store.getItem(known.itemId) : undefined;
    const fields = toolCall && (toolCall.kind || toolCall.title || toolCall.rawInput !== undefined) ? describeAcpTool(toolCall, this.cwd) : known?.fields;
    const tool = item?.type === "tool" ? item : undefined;
    const kind: ApprovalKind = (fields?.kind ?? tool?.kind) === "edit" ? "fileChange" : "command";
    // A command is asked about as the command itself, even one read as a listing or a search (`dir` → "."): the person
    // approves what runs.
    const summary = (fields?.name === "shell" ? fields.input : fields?.summary) || tool?.summary || toolCall?.title || "agy 请求批准";
    return { kind, summary };
  }
}

const STOP_NOTES: Record<string, string> = {
  max_tokens: "回复达到了输出长度上限，没有写完",
  max_turn_requests: "这一轮的步数到了 agy 的上限，停了下来",
  refusal: "模型拒绝了这个请求",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function blockText(content: unknown): string {
  const c = content as { type?: string; text?: string } | undefined;
  return c?.type === "text" && typeof c.text === "string" ? c.text : "";
}

function toolStatus(status: string | undefined): ToolStatus | undefined {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : status === "pending" || status === "in_progress" ? "running" : undefined;
}

/** Text of ACP tool-call content (`{ type: "content", content: { type: "text" } }`). */
export function toolOutput(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "content" ? blockText((c as { content?: unknown }).content) : ""))
    .filter(Boolean)
    .join("\n");
}

function hasDiff(content: unknown): boolean {
  return Array.isArray(content) && content.some((c) => c && typeof c === "object" && (c as { type?: string }).type === "diff");
}

/** ACP `diff` content blocks as Studio's file diffs. */
function diffs(content: unknown, cwd: string | undefined): FileDiff[] {
  if (!Array.isArray(content)) return [];
  const out: FileDiff[] = [];
  for (const c of content as Array<{ type?: string; path?: string; oldText?: string | null; newText?: string }>) {
    if (c?.type !== "diff" || !c.path) continue;
    const before = c.oldText ?? "";
    const after = c.newText ?? "";
    out.push(fileDiff(shortPath(c.path, cwd), c.oldText == null ? "add" : !after && before ? "delete" : "update", textDiff(before, after)));
  }
  return out;
}

/** The command of an `execute` call: agy's own argument name is not known yet (no real turn ran), so the usual ones. */
function commandOf(input: Record<string, unknown>, title: string): string {
  return str(input.command) || str(input.CommandLine) || str(input.commandLine) || str(input.cmd) || (Array.isArray(input.command) ? (input.command as unknown[]).map(String).join(" ") : "") || title.replace(/^(Running|Run)\s+/i, "");
}

/** An ACP tool call as a row, from ACP's standard fields (kind, title, locations, content), whatever the tool's name. */
export function describeAcpTool(u: Pick<AcpUpdate, "kind" | "title" | "locations" | "content" | "rawInput">, cwd: string | undefined): Omit<ToolFields, "status"> {
  const input = u.rawInput && typeof u.rawInput === "object" ? (u.rawInput as Record<string, unknown>) : {};
  const title = u.title ?? "";
  const path = u.locations?.find((l) => l?.path)?.path || str(input.path) || str(input.file_path) || str(input.filePath) || str(input.AbsolutePath) || str(input.TargetFile);
  const shown = path ? shortPath(path, cwd) : "";
  const asJson = formatInput(u.rawInput);
  const name = title || u.kind || "tool";
  const withInput = asJson ? { input: asJson } : {};
  switch (u.kind) {
    case "execute": {
      const command = commandOf(input, title);
      const guess = classifyCommand(command);
      const kind: ToolKind = guess?.kind ?? "command";
      return { name: "shell", kind, summary: guess ? (guess.kind === "search" ? guess.target : shortPath(guess.target, cwd)) : command || title, input: head(command) };
    }
    case "read":
      return { name, kind: "read", summary: shown || title || "读取", ...withInput };
    case "search":
      return { name, kind: "search", summary: [str(input.pattern) || str(input.query) || str(input.Query), shown].filter(Boolean).join(" · ") || title || "搜索", ...withInput };
    case "fetch":
      return { name, kind: "web", summary: str(input.url) || str(input.Url) || str(input.query) || title || "网页", ...withInput };
    case "edit":
    case "delete":
    case "move": {
      const files = diffs(u.content, cwd);
      return { name, kind: "edit", summary: shown || files[0]?.path || title || "改文件", ...(files.length ? { files } : {}), ...withInput };
    }
    case "think":
      return { name, kind: "plan", summary: title || "思考", ...withInput };
    default: {
      // An MCP tool: agy's title names it (`server/tool`, `mcp__server__tool` or "Running <tool>"; seen only in t3code's notes).
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(title) ?? /^([\w.-]+)[/:]([\w.-]+)$/.exec(title);
      if (mcp) return { name: title, kind: "mcp", summary: `${mcp[1]} · ${mcp[2]}`, ...withInput };
      return { name, kind: "other", summary: shown || title || "工具", ...withInput };
    }
  }
}
