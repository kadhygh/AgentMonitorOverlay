import type { ApprovalKind, FileDiff, Id, SessionItem, ToolFields, ToolKind, ToolStatus } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import type { RuntimeCore } from "../runtime.js";
import { classifyCommand, fileDiff, formatInput, head, shortPath, tail, textDiff } from "../items.js";
import { DSH_MCP_PREFIX, DSH_SHELL_TOOLS } from "./install.js";

// A DSH session's ACP updates as Studio rows (stage 17). DSH sends whole committed messages, not token deltas: an
// assistant message comes as one chunk per block (thought, text) with the message's id, a tool call as `tool_call`
// (title = the tool's name, rawInput = its arguments) and `tool_call_update` (its result), and `usage_update` after
// each model call (context in use and the window). spikes/RESULTS.md s17-00.

export interface AcpUpdate {
  sessionUpdate: string;
  messageId?: string;
  content?: unknown;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  used?: number;
  size?: number;
}

export class DshTranscript {
  private turn: { turnId: string; itemId: Id } | null = null;
  /** The message being written: later blocks of the same message (or plain text right after it) join it. */
  private last: { type: "agent" | "reasoning"; messageId: string | undefined; itemId: Id } | null = null;
  private readonly tools = new Map<string, { itemId: Id; name: string; rawInput: unknown }>();

  constructor(
    private readonly core: RuntimeCore,
    private readonly sessionId: Id,
    private readonly cwd?: string,
  ) {}

  /** `raw.turnId` for items of the running turn. */
  turnRef(): { turnId?: string } {
    return this.turn ? { turnId: this.turn.turnId } : {};
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

  /** After a Host restart: the turn that was running, its tools and its approvals are over. */
  settleAfterRestart(): void {
    const at = this.core.now().toISOString();
    for (const item of this.core.store.listUnfinishedItems(this.sessionId)) {
      if (item.type === "turn" && item.state === "running") this.core.updateItem(item.id, (it) => (it.type === "turn" ? { ...it, state: "interrupted", endedAt: at } : it));
      else if (item.type === "tool" && item.status === "running") this.core.updateItem(item.id, (it) => (it.type === "tool" ? { ...it, status: "declined" } : it));
      else if (item.type === "approval" && item.state === "pending") this.core.updateItem(item.id, (it) => (it.type === "approval" ? { ...it, state: "declined" } : it));
    }
  }

  update(u: AcpUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = blockText(u.content);
        if (!text) return;
        const type = u.sessionUpdate === "agent_message_chunk" ? "agent" : "reasoning";
        const last = this.last;
        if (last && last.type === type && (last.messageId === u.messageId || !u.messageId)) {
          this.core.updateItem(last.itemId, (it) =>
            it.type === "agent" ? { ...it, markdown: it.markdown + text } : it.type === "reasoning" ? { ...it, text: it.text + text } : it,
          );
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
        const name = u.title ?? "tool";
        const fields = describeDshTool(name, u.rawInput, this.cwd);
        const item = this.core.appendItem(this.sessionId, { type: "tool", ...fields, status: toolStatus(u.status) ?? "running" }, { method: "tool_call", itemId: u.toolCallId, ...this.turnRef() });
        this.tools.set(u.toolCallId, { itemId: item.id, name, rawInput: u.rawInput });
        return;
      }
      case "tool_call_update": {
        const t = u.toolCallId ? this.tools.get(u.toolCallId) : undefined;
        if (!t) return;
        const status = toolStatus(u.status);
        const output = toolOutput(u.content) || (u.rawOutput !== undefined ? (formatInput(u.rawOutput) ?? "") : "");
        this.core.updateItem(t.itemId, (it) =>
          it.type === "tool"
            ? {
                ...it,
                ...(u.rawInput !== undefined ? describeDshTool(t.name, u.rawInput, this.cwd) : {}),
                ...(status ? { status } : {}),
                ...(output ? { detail: tail(output) } : {}),
              }
            : it,
        );
        if (status && status !== "running") this.tools.delete(u.toolCallId!);
        return;
      }
      case "usage_update": {
        if (!this.turn || typeof u.used !== "number") return;
        const context = u.used;
        const window = typeof u.size === "number" ? u.size : undefined;
        this.core.updateItem(this.turn.itemId, (it) =>
          it.type === "turn" ? { ...it, usage: { input: 0, cachedInput: 0, output: 0, reasoning: 0, context, ...(window ? { contextWindow: window } : {}) } } : it,
        );
        return;
      }
      default:
        // config_option_update, available_commands_update, plan…: nothing to show.
        return;
    }
  }

  /** What an approval card shows for a tool call DSH wants to run with wider permissions. */
  approvalText(toolCallId: string | undefined, toolCall?: { title?: string; rawInput?: unknown }): { kind: ApprovalKind; summary: string; detail?: string } {
    const known = toolCallId ? this.tools.get(toolCallId) : undefined;
    const item: SessionItem | undefined = known ? this.core.store.getItem(known.itemId) : undefined;
    // DSH's request names only the call; its arguments (the command, why it needs more room) came with tool_call.
    const raw = toolCall?.rawInput ?? known?.rawInput;
    const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    const tool = item?.type === "tool" ? item : undefined;
    const kind: ApprovalKind = tool?.kind === "edit" ? "fileChange" : "command";
    const summary = (tool?.kind === "command" ? tool.input : tool?.summary) || str(input?.command) || toolCall?.title || "DSH 请求批准";
    const wider = str(input?.sandbox_permissions);
    const reason = str(input?.justification);
    const why = [reason && `理由：${reason}`, wider && `要放宽到 ${wider === "danger-full-access" ? "完全访问" : wider === "workspace-write" ? "工作区可写" : wider}`].filter(Boolean).join(" · ");
    return { kind, summary, ...(why ? { detail: why } : {}) };
  }
}

const STOP_NOTES: Record<string, string> = {
  max_tokens: "回复达到了输出长度上限，没有写完",
  max_turn_requests: "这一轮的步数到了 DSH 的上限，停了下来",
  refusal: "模型拒绝了这个请求",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function blockText(content: unknown): string {
  const c = content as { type?: string; text?: string } | undefined;
  return c?.type === "text" && typeof c.text === "string" ? c.text : "";
}

function toolStatus(status: string | undefined): ToolStatus | undefined {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : status === "pending" || status === "in_progress" ? "running" : undefined;
}

/** Text of ACP tool-call content (`{ type: "content", content: { type: "text" } }`). */
function toolOutput(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "content" ? blockText((c as { content?: unknown }).content) : ""))
    .filter(Boolean)
    .join("\n");
}

/** A DSH tool call as a row: its kind, a one-line summary and its input (DSH's tool names, spikes s17-00). */
export function describeDshTool(name: string, rawInput: unknown, cwd: string | undefined): Omit<ToolFields, "status"> {
  const input = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  const path = str(input.path) || str(input.file_path) || str(input.filePath);
  const shown = path ? shortPath(path, cwd) : "";
  const asJson = formatInput(rawInput);
  if (DSH_SHELL_TOOLS.has(name)) {
    const command = str(input.command) || (typeof rawInput === "string" ? rawInput : "");
    const guess = classifyCommand(command);
    const kind: ToolKind = guess?.kind ?? "command";
    return { name: "shell", kind, summary: guess ? (guess.kind === "search" ? guess.target : shortPath(guess.target, cwd)) : str(input.description) && !command ? str(input.description) : command, input: head(command) };
  }
  if (name.startsWith(DSH_MCP_PREFIX)) {
    const [, server = "", tool = name] = name.split("__");
    return { name, kind: "mcp", summary: `${server} · ${tool}`, ...(asJson ? { input: asJson } : {}) };
  }
  if (name === "read" || name === "read_image") return { name, kind: "read", summary: shown || name, ...(asJson ? { input: asJson } : {}) };
  if (name === "glob" || name === "grep") return { name, kind: "search", summary: [str(input.pattern) || str(input.query), shown].filter(Boolean).join(" · ") || name, ...(asJson ? { input: asJson } : {}) };
  if (name === "web_search" || name === "web_fetch") return { name, kind: "web", summary: str(input.query) || str(input.url) || name, ...(asJson ? { input: asJson } : {}) };
  if (name === "todo_write") return { name, kind: "plan", summary: "更新待办", ...(asJson ? { input: asJson } : {}) };
  if (name === "write" || name === "edit" || name === "str_replace_editor") {
    const before = str(input.old_str) || str(input.old_string) || str(input.oldText);
    const after = str(input.new_str) || str(input.new_string) || str(input.newText) || str(input.content) || str(input.file_text);
    const files: FileDiff[] = shown && (before || after) ? [fileDiff(shown, name === "write" || str(input.command) === "create" ? "add" : "update", textDiff(before, after))] : [];
    return { name, kind: "edit", summary: shown || name, ...(files.length ? { files } : {}), ...(asJson ? { input: asJson } : {}) };
  }
  if (/subagent/.test(name)) return { name, kind: "subagent", summary: str(input.description) || str(input.prompt).slice(0, 80) || name, ...(asJson ? { input: asJson } : {}) };
  return { name, kind: "other", summary: shown || str(input.description) || name, ...(asJson ? { input: asJson } : {}) };
}
