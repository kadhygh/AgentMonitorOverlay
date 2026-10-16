import { randomUUID } from "node:crypto";
import type { BackgroundState, Id, TurnRetry, TurnState } from "@amo-studio/protocol";
import { tail } from "../items.js";
import type { ClaudeCore } from "./core.js";
import { waitingStatus, type Live } from "./live.js";
import { describeToolUse, hasImageBlock, toolResultText } from "./tool-use.js";

// The rows a turn leaves in the conversation (stage 16 split out of claude-runtime.ts): the turn itself (state, usage,
// speed, retries), tool cards, background commands and notices.

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

export class ClaudeTurns {
  constructor(
    private readonly core: ClaudeCore,
    /** A turn started (the wake: a usage limit it waited for is over). */
    private readonly onTurnStart: (sessionId: Id, live: Live, by: "cli" | "person") => void,
  ) {}

  /** `by`: a message sent from Studio started it, or the CLI did (a wakeup, a task notification, a queued message). */
  started(sessionId: Id, live: Live, by: "cli" | "person" = "cli"): void {
    if (!live.turn) {
      live.notices.clear();
      const turnId = randomUUID();
      const item = this.core.appendItem(sessionId, { type: "turn", turnId, state: "running", startedAt: this.core.now().toISOString() }, { method: "turn/start", turnId });
      live.turn = { id: turnId, itemId: item.id };
      this.onTurnStart(sessionId, live, by);
    }
    live.running = true;
    this.core.clearIdle(live);
    this.core.setStatus(sessionId, waitingStatus(live));
  }

  end(live: Live, state: TurnState, usage?: Usage, contextWindow?: number): void {
    const turn = live.turn;
    if (!turn) return;
    live.turn = null;
    const read = usage?.cache_read_input_tokens ?? 0;
    const input = (usage?.input_tokens ?? 0) + read + (usage?.cache_creation_input_tokens ?? 0);
    this.core.updateItem(turn.itemId, (it) =>
      it.type === "turn"
        ? {
            ...it,
            state,
            endedAt: this.core.now().toISOString(),
            ...(usage
              ? {
                  usage: {
                    input,
                    cachedInput: read,
                    output: usage.output_tokens ?? 0,
                    reasoning: 0,
                    ...(live.context ? { context: live.context } : {}),
                    ...(contextWindow ? { contextWindow } : {}),
                  },
                }
              : {}),
          }
        : it,
    );
  }

  addDecode(turnItemId: Id, ms: number, tokens: number): void {
    this.core.updateItem(turnItemId, (it) => (it.type === "turn" ? { ...it, decode: { ms: (it.decode?.ms ?? 0) + Math.max(0, ms), tokens: (it.decode?.tokens ?? 0) + tokens } } : it));
  }

  setRetry(live: Live, retry: TurnRetry): void {
    if (!live.turn) return;
    live.retrying = true;
    this.core.updateItem(live.turn.itemId, (it) => (it.type === "turn" ? { ...it, retry } : it));
  }

  clearRetry(live: Live): void {
    if (!live.retrying || !live.turn) return;
    live.retrying = false;
    this.core.updateItem(live.turn.itemId, (it) => {
      if (it.type !== "turn" || !it.retry) return it;
      const { retry: _gone, ...rest } = it;
      return rest;
    });
  }

  /** A notice row; the same key again in this turn updates that row (with a count) instead of adding another. */
  notice(sessionId: Id, live: Live, level: "info" | "warning", message: string, key: string): void {
    const known = live.notices.get(key);
    const current = known ? this.core.store.getItem(known) : undefined;
    if (current?.type === "notice") {
      this.core.updateItem(current.id, (it) => (it.type === "notice" ? { ...it, level, message, count: (it.count ?? 1) + 1 } : it));
      return;
    }
    live.notices.set(key, this.core.appendItem(sessionId, { type: "notice", level, message, key }, { method: "notice" }).id);
  }

  addToolCard(sessionId: Id, live: Live, toolUseId: string, name: string, input: Record<string, unknown>): void {
    const created = this.core.appendItem(sessionId, { type: "tool", ...describeToolUse(name, input, this.core.cwdOf(sessionId)), status: "running" }, { method: "tool_use", itemId: toolUseId });
    live.tools.set(toolUseId, created.id);
    live.calls.set(toolUseId, { name, input, itemId: created.id });
    live.toolStarted.set(toolUseId, this.core.now().getTime());
  }

  settleToolCard(live: Live, toolUseId: string, content: unknown, isError: boolean): void {
    const itemId = live.tools.get(toolUseId);
    if (!itemId) return;
    live.tools.delete(toolUseId);
    const declined = live.declinedTools.delete(toolUseId);
    const detail = toolResultText(content);
    const started = live.toolStarted.get(toolUseId);
    live.toolStarted.delete(toolUseId);
    // An image file read comes back as an image block: the row shows the file (the block itself is not kept).
    const call = live.calls.get(toolUseId);
    const path = call && typeof call.input.file_path === "string" ? call.input.file_path : "";
    const images = path && hasImageBlock(content) ? [{ id: null, path }] : [];
    this.core.updateItem(itemId, (it) =>
      it.type === "tool"
        ? {
            ...it,
            status: declined ? "declined" : isError ? "failed" : "completed",
            ...(detail ? { detail: tail(detail) } : {}),
            ...(started ? { durationMs: this.core.now().getTime() - started } : {}),
            ...(images.length ? { images } : {}),
          }
        : it,
    );
  }

  /** A background command: a `background` item the composer lists until it ends. */
  startBackground(sessionId: Id, live: Live, taskId: string): void {
    const task = live.tasks.get(taskId);
    // Subagents sent to the background stay in the session tree; only commands are listed.
    if (!task || (task.type && task.type !== "local_bash") || (task.toolUseId && live.subs.has(task.toolUseId))) return;
    const call = task.toolUseId ? live.calls.get(task.toolUseId) : undefined;
    const command = typeof call?.input.command === "string" ? call.input.command : task.description;
    const item = this.core.appendItem(
      sessionId,
      { type: "background", taskId, command, ...(task.description && task.description !== command ? { description: task.description } : {}), state: "running", startedAt: this.core.now().toISOString() },
      { method: "task_started", ...(task.toolUseId ? { itemId: task.toolUseId } : {}) },
    );
    live.bgItems.set(taskId, item.id);
  }

  settleBackground(itemId: Id, state: BackgroundState, summary?: string): void {
    this.core.updateItem(itemId, (it) => (it.type === "background" && it.state === "running" ? { ...it, state, endedAt: this.core.now().toISOString(), ...(summary ? { summary } : {}) } : it));
  }
}
