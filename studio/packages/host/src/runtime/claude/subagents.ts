import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Id, Session, TurnUsage } from "@amo-studio/protocol";
import type { ClaudeCore } from "./core.js";
import type { Live } from "./live.js";
import type { ClaudeTurns } from "./turns.js";
import { agentToolUseId } from "./wake.js";
import { subagentLogFile, subagentStatsOf } from "./subagent-log.js";

type CallUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

// Subagents (stage 16 split out of claude-runtime.ts). A subagent has no session of its own in Claude: its messages
// carry parent_tool_use_id. Studio still gives each Agent call a child session ("sub") so the tree and "查看" work as
// for Codex; it cannot take messages itself. An agent can be resumed with SendMessage, even by a later process.

export class ClaudeSubagents {
  constructor(
    private readonly core: ClaudeCore,
    private readonly turns: ClaudeTurns,
  ) {}

  /** An Agent call: a child session in the tree and a summary line in the parent, instead of a tool card. */
  start(sessionId: Id, live: Live, toolUseId: string, input: Record<string, unknown>): void {
    const parent = this.core.requireSession(sessionId);
    const name = String(input.description ?? input.subagent_type ?? "子 agent");
    const child = this.core.createSession({
      taskId: parent.taskId,
      topicId: parent.topicId,
      parentId: parent.id,
      kind: "sub",
      profileId: parent.profileId,
      workspaceId: parent.workspaceId,
      title: name,
      runtimeRef: `${parent.runtimeRef}/agent/${toolUseId}`,
      options: parent.options,
    });
    this.core.setStatus(child.id, "running");
    if (typeof input.prompt === "string" && input.prompt) this.core.appendItem(child.id, { type: "user", text: input.prompt }, { method: "agent/prompt", itemId: toolUseId });
    live.subs.set(toolUseId, child.id);
    this.core.appendItem(sessionId, { type: "subagent", childSessionId: child.id, summary: name }, { method: "tool_use", itemId: toolUseId });
  }

  /**
   * Messages of a subagent (parent_tool_use_id set) go into its child session. Its partial stream is not shown. An agent
   * started by an earlier Claude Code process of this session (resumed with SendMessage after an idle close or a usage
   * limit) still finds its child session, by the Agent call in the child's runtimeRef.
   */
  onMessage(sessionId: Id, live: Live, parentToolUse: string, m: SDKMessage): void {
    const child = live.subs.get(parentToolUse) ?? this.adopt(sessionId, live, parentToolUse);
    if (!child) return;
    if (m.type === "assistant" || m.type === "user") {
      const s = this.core.store.getSession(child);
      if (s && s.status !== "running") this.core.setStatus(child, "running");
    }
    if (m.type === "assistant") {
      this.count(child, live, m.message as { id?: string; usage?: CallUsage });
      for (const block of m.message.content) {
        // Its thinking and text too since 2026-10-27 (forwardSubagentText): before, only its tool calls came.
        if (block.type === "thinking" && block.thinking) this.core.appendItem(child, { type: "reasoning", text: block.thinking, streaming: false }, { method: "assistant" });
        else if (block.type === "text" && block.text) this.core.appendItem(child, { type: "agent", markdown: block.text, streaming: false }, { method: "assistant" });
        else if (block.type === "tool_use") this.turns.addToolCard(child, live, block.id, block.name, block.input as Record<string, unknown>);
      }
    } else if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === "tool_result") this.turns.settleToolCard(live, block.tool_use_id, block.content, block.is_error === true);
      }
    }
  }

  /**
   * The agent's own tokens (2026-10-17), from each of its model calls, into a turn item of its child session: the tree
   * and the usage readouts then show what a subagent spent. A call comes as one message per content block, each with
   * its id and usage; only what a later one adds is counted. Its input (the context it read, nearly all of the cost) is
   * exact; its output is not: Claude Code sends a subagent's messages before the call's final output count, and not
   * its stream (CLI 2.1.x, checked against the mock 2026-10-17), so output shows as the count at the call's start.
   */
  private count(child: Id, live: Live, message: { id?: string; usage?: CallUsage }): void {
    const used = message.usage;
    if (!used || !message.id) return;
    let run = live.subUsage.get(child);
    if (!run) {
      const item = this.core.appendItem(child, { type: "turn", turnId: randomUUID(), state: "running", startedAt: this.core.now().toISOString() }, { method: "agent/usage" });
      // The parent's row for the agent shows its total too.
      const parentId = this.core.store.getSession(child)?.parentId;
      const row = parentId ? this.core.store.findItems(parentId, "subagent", { childSessionId: child }, { limit: 1 })[0] : undefined;
      run = { itemId: item.id, ...(row ? { rowId: row.id } : {}), calls: new Map() };
      live.subUsage.set(child, run);
    }
    const cached = used.cache_read_input_tokens ?? 0;
    const call = { input: (used.input_tokens ?? 0) + cached + (used.cache_creation_input_tokens ?? 0), cached, output: used.output_tokens ?? 0 };
    const before = run.calls.get(message.id) ?? { input: 0, cached: 0, output: 0 };
    const now = { input: Math.max(before.input, call.input), cached: Math.max(before.cached, call.cached), output: Math.max(before.output, call.output) };
    run.calls.set(message.id, now);
    const add = { input: now.input - before.input, cached: now.cached - before.cached, output: now.output - before.output };
    if (!add.input && !add.cached && !add.output) return;
    const plus = (u: TurnUsage | undefined): TurnUsage => ({
      input: (u?.input ?? 0) + add.input,
      cachedInput: (u?.cachedInput ?? 0) + add.cached,
      output: (u?.output ?? 0) + add.output,
      reasoning: 0,
      context: now.input + now.output,
    });
    this.core.updateItem(run.itemId, (it) => (it.type === "turn" ? { ...it, usage: plus(it.usage) } : it));
    if (run.rowId) this.core.updateItem(run.rowId, (it) => (it.type === "subagent" ? { ...it, usage: plus(it.usage) } : it));
  }

  /** The agent stopped (finished, failed, stopped, or its process ended): its child session and its usage turn settle. */
  end(live: Live, child: Id, status: "completed" | "error" | "interrupted"): void {
    this.core.setStatus(child, status);
    const run = live.subUsage.get(child);
    if (run) {
      live.subUsage.delete(child);
      const state = status === "error" ? "failed" : status;
      this.core.updateItem(run.itemId, (it) => (it.type === "turn" && it.state === "running" ? { ...it, state, endedAt: this.core.now().toISOString() } : it));
    }
    // Its real output and a speed from its transcript; again shortly, in case its last lines were still being written.
    const session = this.core.store.getSession(child);
    if (!session) return;
    this.fillFromLog(session);
    setTimeout(() => this.fillFromLog(session), 2000).unref?.();
  }

  /**
   * A finished subagent's tokens and speed from the transcript Claude Code keeps for it (subagent-log.ts), into its
   * usage turn and the parent's row for it. False when there is no transcript to read. No model is called.
   */
  fillFromLog(child: Session): boolean {
    const parent = child.parentId ? this.core.store.getSession(child.parentId) : undefined;
    const toolUseId = child.runtimeRef?.split("/agent/")[1];
    if (!parent?.runtimeRef || !toolUseId) return false;
    const file = subagentLogFile(this.core.homeOf(parent.id).dir, parent.runtimeRef, toolUseId);
    const stats = file ? subagentStatsOf(file) : null;
    if (!stats) return false;
    const usage = (u: TurnUsage | undefined): TurnUsage => ({ ...u, input: stats.input, cachedInput: stats.cachedInput, output: stats.output, reasoning: 0, context: u?.context ?? 0 });
    // Its usage turn came with its first counted call (none: only the parent's row; one made now would land after its
    // reply and split its conversation).
    const turn = this.core.store.findItems(child.id, "turn", {}, { newest: true, limit: 1 })[0];
    if (turn) this.core.updateItem(turn.id, (it) => (it.type === "turn" ? { ...it, usage: usage(it.usage), ...(stats.decode ? { decode: stats.decode } : {}) } : it));
    const row = this.core.store.findItems(parent.id, "subagent", { childSessionId: child.id }, { limit: 1 })[0];
    if (row) this.core.updateItem(row.id, (it) => (it.type === "subagent" ? { ...it, usage: usage(it.usage) } : it));
    return true;
  }

  /** The child session an earlier process of this session made for this Agent call; registered with this process. */
  private adopt(sessionId: Id, live: Live, toolUseId: string): Id | undefined {
    const parent = this.core.store.getSession(sessionId);
    if (!parent?.runtimeRef) return undefined;
    const child = this.core.store.findSessionByRuntimeRef("claude", `${parent.runtimeRef}/agent/${toolUseId}`);
    if (!child || child.parentId !== sessionId) return undefined;
    live.subs.set(toolUseId, child.id);
    live.backgroundSubs.add(toolUseId);
    return child.id;
  }

  /** A background agent's child session, by its agent id (the CLI's task id). */
  child(live: Live, agentId: string, sessionId?: Id): Id | undefined {
    let toolUseId = live.agents.get(agentId);
    if (!toolUseId && sessionId) {
      const ref = this.core.store.getSession(sessionId)?.runtimeRef;
      toolUseId = ref ? (agentToolUseId(this.core.homeOf(sessionId).dir, ref, agentId) ?? undefined) : undefined;
      if (toolUseId) live.agents.set(agentId, toolUseId);
    }
    if (!toolUseId) return undefined;
    return live.subs.get(toolUseId) ?? (sessionId ? this.adopt(sessionId, live, toolUseId) : undefined);
  }

  /** SendMessage to one of the session's agents: the message shows in the agent's child session, as its next prompt. */
  messageTo(sessionId: Id, live: Live, input: Record<string, unknown>): void {
    const to = typeof input.to === "string" ? input.to : "";
    const text = typeof input.message === "string" ? input.message : "";
    if (!to || !text) return;
    const child = this.child(live, to, sessionId);
    if (child) this.core.appendItem(child, { type: "user", text }, { method: "agent/message" });
  }

  /** SendMessage resumed a stopped agent: its child session runs again, and the agent's next notification ends it. */
  onResumed(sessionId: Id, live: Live, toolUseId: string, result: unknown): void {
    const agentId = (result as { resumedAgentId?: unknown } | null | undefined)?.resumedAgentId;
    if (typeof agentId !== "string") return;
    const child = this.child(live, agentId, sessionId);
    if (!child) return;
    live.resumes.set(toolUseId, child);
    this.core.setStatus(child, "running");
  }

  /** A background agent's task ended (task_updated): its child session settles, unless already settled. */
  settled(sessionId: Id, live: Live, agentId: string, status: "completed" | "error" | "interrupted"): void {
    const child = this.child(live, agentId, sessionId);
    if (child && this.core.store.getSession(child)?.status === "running") this.end(live, child, status);
  }

  /**
   * TaskStop on one of the session's agents (2026-10-22): the CLI may send no task_notification for a stopped agent,
   * so its child session would show running until Studio restarted. The call's own success ends it.
   */
  onStopped(sessionId: Id, live: Live, input: Record<string, unknown>, result: unknown): void {
    let r = result;
    if (typeof r === "string") {
      try {
        r = JSON.parse(r);
      } catch {
        r = null;
      }
    }
    const fromResult = (r as { task_id?: unknown } | null | undefined)?.task_id;
    const agentId = typeof fromResult === "string" ? fromResult : typeof input.task_id === "string" ? input.task_id : typeof input.shell_id === "string" ? input.shell_id : "";
    if (agentId) this.settled(sessionId, live, agentId, "interrupted");
  }

  /** The process ended: its agents stopped with it. */
  endAll(live: Live, failed: boolean): void {
    for (const childId of live.subs.values()) {
      if (this.core.store.getSession(childId)?.status === "running") this.end(live, childId, failed ? "error" : "interrupted");
    }
  }
}
