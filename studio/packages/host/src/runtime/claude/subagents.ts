import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Id } from "@amo-studio/protocol";
import type { ClaudeCore } from "./core.js";
import type { Live } from "./live.js";
import type { ClaudeTurns } from "./turns.js";
import { agentToolUseId } from "./wake.js";

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
      for (const block of m.message.content) {
        if (block.type === "text" && block.text) this.core.appendItem(child, { type: "agent", markdown: block.text, streaming: false }, { method: "assistant" });
        else if (block.type === "tool_use") this.turns.addToolCard(child, live, block.id, block.name, block.input as Record<string, unknown>);
      }
    } else if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === "tool_result") this.turns.settleToolCard(live, block.tool_use_id, block.content, block.is_error === true);
      }
    }
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

  /** The process ended: its agents stopped with it. */
  endAll(live: Live, failed: boolean): void {
    for (const childId of live.subs.values()) {
      if (this.core.store.getSession(childId)?.status === "running") this.core.setStatus(childId, failed ? "error" : "idle");
    }
  }
}
