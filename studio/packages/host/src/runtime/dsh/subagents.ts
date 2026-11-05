import { readFileSync, statSync } from "node:fs";
import type { Id, Session, SessionStatus, TurnUsage } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import type { RuntimeCore } from "../runtime.js";
import { tail } from "../items.js";
import { dshLogFile, dshTurnStats, zstdFramesFrom } from "./session-log.js";
import { describeDshTool } from "./transcript.js";
import { DSH_SEND_MESSAGE, DSH_SUBAGENT_TOOLS } from "./install.js";

// DSH's own subagents (2026-11-06, the user: a DeepSeek session that started one with DSH's `subagent` tool showed one
// row, 完成 at once, and nothing of what the agent did). DSH's `subagent` / `subagent_fork` start an agent in the
// background and return its id at once ("started subagent <id>"); ACP sends nothing of the agent (DSH's bridge only
// forwards the sessions it opened), nor the message it sends back to its parent. Its whole run is in its own session
// log in DSH's home (`sessions/<cwd>/<id>/session.v4.jsonl.zstd`, `origin: "subagent"`), written as it goes. So, as
// for Claude's subagents: each call gets a child session ("sub") and a ▸ row in the parent, and the child session is
// filled from that log, read again every second or so while the parent's process runs. It takes no messages itself:
// its parent talks to it with DSH's `send_message`.

const POLL_MS = 1000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface DshSubagentsOptions {
  core: RuntimeCore;
  /** DSH's home (DSH_HOME): its sessions' logs. */
  home: string;
  /** The running turn of a main session (its process's transcript), for rows put into it. */
  turnRef(sessionId: Id): { turnId?: string };
  pollMs?: number;
}

/** A subagent call whose agent id has not come back yet. */
interface Pending {
  childId: Id;
  rowId: Id;
}

/** A subagent whose log is being read. */
interface Watch {
  childId: Id;
  /** DSH's id of the agent (its session, its log). */
  dshId: string;
  /** The session the ▸ row is in, and DSH's id of that agent (whom `send_message` back goes to). */
  parentId: Id;
  parentDshId: string;
  /** The main session whose process runs it: the watch ends with that process. */
  rootId: Id;
  rowId: Id | null;
  label: string;
  cwd: string | undefined;
  file: string | null;
  /** Bytes read (a frame boundary for zstd), the last stat, a line not ended yet. */
  offset: number;
  size: number;
  mtime: number;
  carry: string;
  turn: { turnId: string; itemId: Id } | null;
  tools: Map<string, Id>;
  usage: { input: number; cachedInput: number; output: number };
}

interface LogEvent {
  type?: string;
  time?: number;
  data?: Record<string, unknown>;
}

export class DshSubagents {
  private readonly pending = new Map<string, Pending>();
  private readonly watched = new Map<Id, Watch>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: DshSubagentsOptions) {}

  private get core(): RuntimeCore {
    return this.options.core;
  }

  /** A subagent call in `sessionId` (its ACP stream, or a subagent's log): a child session and a ▸ row for it. */
  begin(sessionId: Id, callId: string, rawInput: unknown, raw: { turnId?: string }): void {
    const key = `${sessionId}:${callId}`;
    if (this.pending.has(key)) return;
    const parent = this.core.store.getSession(sessionId);
    if (!parent) return;
    const input = record(rawInput);
    const label = labelOf(input);
    const child = this.core.createSession({
      taskId: parent.taskId,
      topicId: parent.topicId,
      parentId: parent.id,
      kind: "sub",
      profileId: parent.profileId,
      workspaceId: parent.workspaceId,
      title: label,
      // DSH's id of the agent once the call returns it.
      runtimeRef: `${parent.runtimeRef}/subagent/${callId}`,
      options: parent.options,
    });
    this.core.setStatus(child.id, "running");
    const row = this.core.appendItem(sessionId, { type: "subagent", childSessionId: child.id, summary: label }, { method: "dsh/subagent", itemId: callId, ...raw });
    this.pending.set(key, { childId: child.id, rowId: row.id });
  }

  /** The call's arguments, when DSH sends them after the call (tool_call_update). */
  describe(sessionId: Id, callId: string, rawInput: unknown): void {
    const p = this.pending.get(`${sessionId}:${callId}`);
    const label = labelOf(record(rawInput));
    if (!p || label === "子 agent") return;
    this.core.updateSession(p.childId, { title: label });
    this.core.updateItem(p.rowId, (it) => (it.type === "subagent" ? { ...it, summary: label } : it));
  }

  /** The call came back: the agent's id (its log is read from now on), or why it did not start. */
  settle(sessionId: Id, callId: string, ok: boolean, output: string): void {
    const key = `${sessionId}:${callId}`;
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    const dshId = ok ? (/started subagent\s+(\S+)/i.exec(output)?.[1] ?? UUID.exec(output)?.[0]) : undefined;
    if (!dshId) {
      if (output.trim()) this.core.appendItem(p.childId, { type: "notice", level: "warning", message: `子 agent 没有开起来：${tail(output.trim(), 600)}` }, { method: "dsh/subagent" });
      this.core.setStatus(p.childId, "error");
      return;
    }
    this.core.updateSession(p.childId, { runtimeRef: dshId });
    const child = this.core.store.getSession(p.childId);
    if (child) this.watch(child, p.rowId, 0);
  }

  /**
   * `send_message` from `sessionId` to one of its subagents: one that finished (its watch ended with an earlier
   * process, or the Host) runs again in this process; its log is read again from where it is now.
   */
  messageTo(sessionId: Id, rawInput: unknown): void {
    const to = str(record(rawInput).agent_id);
    if (!to) return;
    const child = this.core.store.findSessionByRuntimeRef("dsh", to);
    if (!child || child.kind !== "sub" || child.parentId !== sessionId || child.archivedAt || this.watched.has(child.id)) return;
    const row = this.core.store.findItems(sessionId, "subagent", { childSessionId: child.id }, { limit: 1 })[0];
    this.watch(child, row?.id ?? null, null);
  }

  /** The process of main session `rootId` ended: what its agents last wrote is read, those still running stopped. */
  stopTree(rootId: Id): void {
    for (const [key, p] of this.pending) {
      if (this.rootOf(p.childId) !== rootId) continue;
      this.pending.delete(key);
      this.core.setStatus(p.childId, "interrupted");
    }
    for (const w of [...this.watched.values()]) {
      if (w.rootId !== rootId) continue;
      this.read(w);
      if (w.turn) this.endTurn(w, "interrupted");
      if (this.core.store.getSession(w.childId)?.status === "running") this.core.setStatus(w.childId, "interrupted");
      this.watched.delete(w.childId);
    }
    this.arm();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watched.clear();
    this.pending.clear();
  }

  /** Reads every watched log once (the timer; tests). */
  poll(): void {
    for (const w of [...this.watched.values()]) {
      try {
        this.read(w);
      } catch (err) {
        this.core.log(`dsh subagent ${w.dshId}: reading its log failed: ${String(err)}`);
      }
    }
  }

  // ---- reading a log ----------------------------------------------------------------------------------------------

  /** `from`: the byte to read on from (0: all of it), null: from where the log is now. */
  private watch(child: Session, rowId: Id | null, from: number | null): void {
    const parent = child.parentId ? this.core.store.getSession(child.parentId) : undefined;
    if (!parent?.runtimeRef || !child.runtimeRef) return;
    const w: Watch = {
      childId: child.id,
      dshId: child.runtimeRef,
      parentId: parent.id,
      parentDshId: parent.runtimeRef,
      rootId: this.rootOf(child.id),
      rowId,
      label: child.title || "子 agent",
      cwd: this.core.store.getWorkspace(child.workspaceId)?.path,
      file: null,
      offset: from ?? 0,
      size: -1,
      mtime: -1,
      carry: "",
      turn: null,
      tools: new Map(),
      usage: { input: 0, cachedInput: 0, output: 0 },
    };
    if (from === null) {
      w.file = dshLogFile(this.options.home, w.dshId);
      try {
        if (w.file) w.offset = statSync(w.file).size;
      } catch {
        w.offset = 0;
      }
    }
    const row = rowId ? this.core.store.getItem(rowId) : undefined;
    if (row?.type === "subagent" && row.usage) w.usage = { input: row.usage.input, cachedInput: row.usage.cachedInput, output: row.usage.output };
    this.watched.set(child.id, w);
    this.read(w);
    this.arm();
  }

  private arm(): void {
    if (this.watched.size && !this.timer) {
      this.timer = setInterval(() => this.poll(), this.options.pollMs ?? POLL_MS);
      this.timer.unref?.();
    } else if (!this.watched.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private read(w: Watch): void {
    w.file ??= dshLogFile(this.options.home, w.dshId);
    if (!w.file) return;
    let size: number;
    let mtime: number;
    try {
      const st = statSync(w.file);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      return;
    }
    if (size === w.size && mtime === w.mtime) return;
    w.size = size;
    w.mtime = mtime;
    let raw: Buffer;
    try {
      raw = readFileSync(w.file);
    } catch {
      return;
    }
    let text: string;
    if (w.file.endsWith(".zstd")) {
      try {
        const r = zstdFramesFrom(raw, w.offset);
        text = r.text;
        w.offset = r.end;
      } catch {
        // Its first frame is still being written.
        return;
      }
    } else {
      text = raw.subarray(w.offset).toString("utf8");
      w.offset = raw.length;
    }
    const lines = (w.carry + text).split("\n");
    w.carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let e: LogEvent;
      try {
        e = JSON.parse(line) as LogEvent;
      } catch {
        continue;
      }
      this.apply(w, e);
    }
  }

  /** One event of the agent's log as rows of its child session. */
  private apply(w: Watch, e: LogEvent): void {
    const d = e.data ?? {};
    const ref = () => (w.turn ? { turnId: w.turn.turnId } : {});
    switch (e.type) {
      case "turn/start": {
        if (w.turn) this.endTurn(w, "completed");
        const turnId = newId("t");
        const at = typeof e.time === "number" ? new Date(e.time) : this.core.now();
        const item = this.core.appendItem(w.childId, { type: "turn", turnId, state: "running", startedAt: at.toISOString() }, { method: "dsh-log/turn", turnId });
        w.turn = { turnId, itemId: item.id };
        this.core.setStatus(w.childId, "running");
        return;
      }
      case "turn/end": {
        const reason = record(d.reason);
        const kind = str(reason.kind);
        const error = kind === "error" ? str(record(reason.error).message) || "出错了" : undefined;
        this.endTurn(w, kind === "completed" ? "completed" : error ? "failed" : "interrupted", error);
        return;
      }
      case "agent/inbox/spliced": {
        for (const entry of Array.isArray(d.inserted) ? d.inserted : []) {
          const m = record(entry);
          const source = str(record(m.source).kind);
          if (source !== "user" && source !== "agent-message") continue;
          const text = texts(m.content)
            .filter((t) => !/^Your parent agent id is /.test(t) && !/^Agent \S+ sent a message:\s*$/.test(t))
            .join("\n")
            .trim();
          if (text) this.core.appendItem(w.childId, { type: "user", text }, { method: "dsh-log/inbox", ...ref() });
        }
        return;
      }
      case "assistant/message": {
        const content = record(d.message).content;
        for (const block of Array.isArray(content) ? content : []) {
          const b = record(block);
          const text = str(b.text);
          if (!text) continue;
          if (b.type === "reasoning") this.core.appendItem(w.childId, { type: "reasoning", text, streaming: false }, { method: "dsh-log/assistant", ...ref() });
          else if (b.type === "text") this.core.appendItem(w.childId, { type: "agent", markdown: text, streaming: false }, { method: "dsh-log/assistant", ...ref() });
        }
        return;
      }
      case "tool/call": {
        const callId = str(d.callId);
        const name = str(d.name);
        if (!callId || !name) return;
        const input = parseArgs(d.arguments);
        if (DSH_SUBAGENT_TOOLS.has(name)) return this.begin(w.childId, callId, input, ref());
        if (name === DSH_SEND_MESSAGE) {
          const args = record(input);
          const message = str(args.message).trim();
          // To its parent: what it reports, kept whole as its reply (as Claude's SubagentHandback), and a line in
          // the parent, where DSH hands it to the agent without telling ACP.
          if (str(args.agent_id) === w.parentDshId && message) {
            this.core.appendItem(w.childId, { type: "agent", markdown: message, streaming: false }, { method: "dsh-log/send_message", itemId: callId, ...ref() });
            this.core.appendItem(w.parentId, { type: "notice", level: "info", message: `子 agent「${w.label}」发回了消息：${oneLine(message, 200)}` }, { method: "dsh/subagent-message", itemId: callId, ...this.turnOf(w.parentId) });
            return;
          }
          this.messageTo(w.childId, input);
        }
        const fields = describeDshTool(name, input, w.cwd);
        const item = this.core.appendItem(w.childId, { type: "tool", ...fields, status: "running" }, { method: "dsh-log/tool", itemId: callId, ...ref() });
        w.tools.set(callId, item.id);
        return;
      }
      case "tool/result": {
        const m = record(d.message);
        const callId = str(m.toolCallId);
        if (!callId) return;
        const output = texts(m.content).join("\n");
        const failed = m.isError === true;
        if (this.pending.has(`${w.childId}:${callId}`)) return this.settle(w.childId, callId, !failed, output);
        const itemId = w.tools.get(callId);
        if (!itemId) return;
        w.tools.delete(callId);
        this.core.updateItem(itemId, (it) => (it.type === "tool" ? { ...it, status: failed ? "failed" : "completed", ...(output ? { detail: tail(output) } : {}) } : it));
        return;
      }
      default:
        return;
    }
  }

  /** The agent's turn ended: its child session settles, with its tokens and speed (the parent's row adds them up). */
  private endTurn(w: Watch, state: "completed" | "failed" | "interrupted", error?: string): void {
    const turn = w.turn;
    w.turn = null;
    for (const itemId of w.tools.values()) this.core.updateItem(itemId, (it) => (it.type === "tool" && it.status === "running" ? { ...it, status: "declined" } : it));
    w.tools.clear();
    if (turn) {
      const stats = (() => {
        try {
          return dshTurnStats(this.options.home, w.dshId);
        } catch {
          return null;
        }
      })();
      this.core.updateItem(turn.itemId, (it) => {
        if (it.type !== "turn") return it;
        const fresh = stats && stats.startedAt >= Date.parse(it.startedAt) - 5000 ? stats : null;
        return {
          ...it,
          state,
          endedAt: this.core.now().toISOString(),
          ...(error ? { error } : {}),
          ...(fresh ? { usage: { input: fresh.input, cachedInput: fresh.cachedInput, output: fresh.output, reasoning: 0 }, ...(fresh.decode ? { decode: fresh.decode } : {}) } : {}),
        };
      });
      const item = this.core.store.getItem(turn.itemId);
      if (item?.type === "turn" && item.usage && w.rowId) {
        w.usage = { input: w.usage.input + item.usage.input, cachedInput: w.usage.cachedInput + item.usage.cachedInput, output: w.usage.output + item.usage.output };
        const usage: TurnUsage = { ...w.usage, reasoning: 0 };
        this.core.updateItem(w.rowId, (it) => (it.type === "subagent" ? { ...it, usage } : it));
      }
    }
    const status: SessionStatus = state === "completed" ? "completed" : state === "failed" ? "error" : "interrupted";
    this.core.setStatus(w.childId, status);
  }

  /** The running turn of a session: a main session's process, or a subagent's log. */
  private turnOf(sessionId: Id): { turnId?: string } {
    const w = this.watched.get(sessionId);
    if (w) return w.turn ? { turnId: w.turn.turnId } : {};
    return this.options.turnRef(sessionId);
  }

  /** The main session a subagent's session hangs under (its process runs the agent). */
  private rootOf(sessionId: Id): Id {
    let s = this.core.store.getSession(sessionId);
    while (s && s.kind === "sub" && s.parentId) {
      const up = this.core.store.getSession(s.parentId);
      if (!up) break;
      s = up;
    }
    return s?.id ?? sessionId;
  }
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function labelOf(input: Record<string, unknown>): string {
  return str(input.description).trim() || oneLine(str(input.prompt), 60) || "子 agent";
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The text blocks of a log message's content. */
function texts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.map((c) => record(c)).filter((c) => c.type === "text" && typeof c.text === "string" && c.text).map((c) => c.text as string);
}

/** A tool call's arguments as logged (a JSON string), as an object when they parse. */
function parseArgs(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
