import type { SDKMessage, SlashCommand as SdkSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundState, Id } from "@amo-studio/protocol";
import { readChatSettings } from "../chat-settings.js";
import { localCommandText } from "./commands.js";
import type { ClaudeCore } from "./core.js";
import { QUESTION_TOOLS, type Live } from "./live.js";
import type { ClaudeSubagents } from "./subagents.js";
import { firstLine, retryReason, toolResultText } from "./tool-use.js";
import type { ClaudeTurns } from "./turns.js";
import type { ClaudeWake } from "./wake-control.js";
import { isUsageLimitText } from "./wake.js";

// What Claude Code's messages become in the conversation (stage 16 split out of claude-runtime.ts): streamed text and
// thinking, tool calls and results, the turn's end, and the system messages (tasks, compaction, retries, notices).

export interface MessageDeps {
  turns: ClaudeTurns;
  subagents: ClaudeSubagents;
  wake: ClaudeWake;
  /** A rate_limit_event of the session (the subscription's quota). */
  recordRateLimit(sessionId: Id, info: { rateLimitType?: string; utilization?: number; resetsAt?: number }): void;
  /** The CLI's init message names the skills (its command list does not tell them apart). */
  noteSkills(sessionId: Id, skills: string[]): void;
  /** The `/` command the session was last sent (names the output of a command that runs without the model). */
  lastCommand(sessionId: Id): string | undefined;
  /** The turn is over and nothing waits: the idle close starts counting. */
  scheduleIdle(sessionId: Id, live: Live): void;
}

export class ClaudeMessages {
  constructor(
    private readonly core: ClaudeCore,
    private readonly deps: MessageDeps,
  ) {}

  onMessage(sessionId: Id, live: Live, m: SDKMessage): void {
    const { turns, subagents, wake } = this.deps;
    const parentToolUse = "parent_tool_use_id" in m ? m.parent_tool_use_id : null;
    if (parentToolUse) return subagents.onMessage(sessionId, live, parentToolUse, m);
    switch (m.type) {
      case "rate_limit_event": {
        const info = (m as { rate_limit_info: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number } }).rate_limit_info;
        this.deps.recordRateLimit(sessionId, info);
        if (info.status === "rejected") live.refused = { ...(info.resetsAt ? { resetsAt: info.resetsAt } : {}), ...(info.rateLimitType ? { type: info.rateLimitType } : {}) };
        return;
      }
      case "stream_event": {
        const e = m.event as { type: string; index?: number; content_block?: { type: string }; delta?: { type: string; text?: string; thinking?: string }; usage?: { output_tokens?: number } };
        // The speed: each model call from its first output (any block) to its end, with its output tokens.
        if (e.type === "message_start") live.call = { firstAt: null, tokens: 0 };
        else if (live.call && live.call.firstAt === null && (e.type === "content_block_start" || e.type === "content_block_delta")) live.call.firstAt = this.core.now().getTime();
        else if (live.call && e.type === "message_delta" && typeof e.usage?.output_tokens === "number") live.call.tokens = e.usage.output_tokens;
        else if (live.call && e.type === "message_stop") {
          const call = live.call;
          live.call = null;
          if (call.firstAt !== null && call.tokens > 0 && live.turn) turns.addDecode(live.turn.itemId, this.core.now().getTime() - call.firstAt, call.tokens);
        }
        if (e.type === "message_start") {
          if (!live.running) turns.started(sessionId, live);
          turns.clearRetry(live);
          live.blocks.clear();
        } else if (e.type === "content_block_start" && e.content_block?.type === "text") {
          const item = this.core.appendItem(sessionId, { type: "agent", markdown: "", streaming: true }, { method: "stream/text" });
          live.blocks.set(e.index ?? 0, item.id);
          live.streaming.push(item.id);
        } else if (e.type === "content_block_start" && e.content_block?.type === "thinking") {
          const item = this.core.appendItem(sessionId, { type: "reasoning", text: "", streaming: true }, { method: "stream/thinking" });
          live.blocks.set(e.index ?? 0, item.id);
          live.thinking.push({ itemId: item.id, startedAt: this.core.now().getTime() });
        } else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) {
          const itemId = live.blocks.get(e.index ?? 0);
          if (!itemId) return;
          live.text.set(itemId, (live.text.get(itemId) ?? "") + e.delta.thinking);
          this.core.emitTransient({ type: "item.delta", sessionId, itemId, append: e.delta.thinking });
        } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
          const itemId = live.blocks.get(e.index ?? 0);
          if (!itemId) return;
          live.text.set(itemId, (live.text.get(itemId) ?? "") + e.delta.text);
          this.core.emitTransient({ type: "item.delta", sessionId, itemId, append: e.delta.text });
        }
        return;
      }
      case "assistant": {
        if (!live.running) turns.started(sessionId, live);
        turns.clearRetry(live);
        // A command that runs without the model (/cost, /context…): its output comes as an assistant message marked
        // with the stdout it was made from (CLI 2.1.296; spikes/s12-e-claude-cli.mjs).
        if ((m as { local_command_source?: unknown }).local_command_source !== undefined) {
          const output = m.message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
          const name = this.deps.lastCommand(sessionId) ?? "";
          this.core.appendItem(sessionId, { type: "command", name, output: localCommandText(output) }, { method: "local_command" });
          return;
        }
        const used = (m.message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }).usage;
        if (used) live.context = (used.input_tokens ?? 0) + (used.cache_read_input_tokens ?? 0) + (used.cache_creation_input_tokens ?? 0) + (used.output_tokens ?? 0);
        for (const block of m.message.content) {
          if (block.type === "thinking") {
            // Settles the oldest thinking item still streaming, like text below.
            const t = live.thinking.shift();
            const text = block.thinking;
            if (t) {
              live.text.delete(t.itemId);
              this.core.updateItem(t.itemId, (it) => (it.type === "reasoning" ? { ...it, text, streaming: false, durationMs: this.core.now().getTime() - t.startedAt } : it));
            } else if (text.trim()) {
              this.core.appendItem(sessionId, { type: "reasoning", text, streaming: false }, { method: "assistant" });
            }
          } else if (block.type === "text") {
            // The CLI's own message when a usage limit stops the turn (a synthetic assistant message, no stream).
            if ((m as { error?: string }).error === "rate_limit" || isUsageLimitText(block.text)) live.limitText = block.text.trim();
            // One assistant message per completed block; it settles the oldest text item still streaming.
            const itemId = live.streaming.shift();
            if (itemId) {
              live.text.delete(itemId);
              this.core.updateItem(itemId, (it) => (it.type === "agent" ? { ...it, markdown: block.text, streaming: false } : it));
            } else {
              this.core.appendItem(sessionId, { type: "agent", markdown: block.text, streaming: false }, { method: "assistant" });
            }
          } else if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            live.calls.set(block.id, { name: block.name, input });
            if (block.name === "Agent" || block.name === "Task") subagents.start(sessionId, live, block.id, input);
            // The question item stands for these calls; a row is added only if they never reach the person.
            else if (QUESTION_TOOLS.has(block.name)) live.questionTools.set(block.id, { name: block.name, input });
            else {
              turns.addToolCard(sessionId, live, block.id, block.name, input);
              if (block.name === "SendMessage") subagents.messageTo(sessionId, live, input);
            }
          }
        }
        return;
      }
      case "user": {
        const content = m.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const child = live.subs.get(block.tool_use_id);
          if (child) {
            // A foreground subagent's final reply is not streamed: it only comes back in the Agent call's result.
            const result = (m as { tool_use_result?: { status?: string; content?: unknown } }).tool_use_result;
            const reply = result?.status === "completed" ? toolResultText(result.content).trim() : "";
            const shown = this.core.store.listItems(child).some((i) => i.type === "agent" && i.markdown.trim() === reply);
            if (reply && !shown) this.core.appendItem(child, { type: "agent", markdown: reply, streaming: false }, { method: "agent/result", itemId: block.tool_use_id });
            // A background subagent's result only says it was launched; its task notification ends it.
            if (!live.backgroundSubs.has(block.tool_use_id) || result?.status === "completed") subagents.end(live, child, block.is_error ? "error" : "completed");
            continue;
          }
          const asked = live.questionTools.get(block.tool_use_id);
          if (asked) {
            live.questionTools.delete(block.tool_use_id);
            if (live.askedTools.delete(block.tool_use_id)) continue;
            // Rejected before it reached the person (bad input, not in plan mode…): show the call and its error.
            turns.addToolCard(sessionId, live, block.tool_use_id, asked.name, asked.input);
          }
          turns.settleToolCard(live, block.tool_use_id, block.content, block.is_error === true);
          const call = live.calls.get(block.tool_use_id);
          const toolResult = (m as { tool_use_result?: unknown }).tool_use_result;
          if (call?.name === "ScheduleWakeup" && block.is_error !== true) wake.onScheduleWakeup(sessionId, live, call.input, toolResult);
          if (call?.name === "SendMessage" && block.is_error !== true) subagents.onResumed(sessionId, live, block.tool_use_id, toolResult);
          // A command sent to the background: its result names the file its output goes to.
          const bg = [...live.tasks].find(([, t]) => t.toolUseId === block.tool_use_id);
          const bgItem = bg ? live.bgItems.get(bg[0]) : undefined;
          const outputFile = /Output is being written to:\s*(\S.*?\.output)\b/.exec(toolResultText(block.content))?.[1];
          if (bgItem && outputFile) this.core.updateItem(bgItem, (it) => (it.type === "background" && !it.outputFile ? { ...it, outputFile } : it));
        }
        return;
      }
      case "system":
        return this.onSystem(sessionId, live, m);
      case "prompt_suggestion": {
        const text = (m as { suggestion?: string }).suggestion?.trim();
        if (text && readChatSettings(this.core.store).promptSuggestions) this.core.appendItem(sessionId, { type: "suggestion", text: text.slice(0, 500) }, { method: "prompt_suggestion" });
        return;
      }
      case "tool_use_summary": {
        // The CLI's one-line summary of the calls before it: shown on the last of them.
        const ids = (m as { preceding_tool_use_ids?: string[] }).preceding_tool_use_ids ?? [];
        const summary = (m as { summary?: string }).summary?.trim();
        const itemId = [...ids].reverse().map((id) => live.calls.get(id)?.itemId).find(Boolean);
        if (summary && itemId) this.core.updateItem(itemId, (it) => (it.type === "tool" ? { ...it, progress: summary } : it));
        return;
      }
      case "result":
        return this.onResult(sessionId, live, m);
      default:
        // Not shown: tool_progress (a running row shows its own elapsed time), auth_status, hook_progress,
        // thinking-token counts, conversation_reset (/clear is refused), worker_shutting_down.
        return;
    }
  }

  /** The turn's end: settle what still streams, its usage, the session's status, the wake, then the idle close. */
  private onResult(sessionId: Id, live: Live, m: Extract<SDKMessage, { type: "result" }>): void {
    const { turns } = this.deps;
    live.running = false;
    turns.clearRetry(live);
    // A stream the CLI never completed (a refused response is withheld) ends with the turn.
    for (const id of live.streaming.splice(0)) {
      const text = live.text.get(id) ?? "";
      live.text.delete(id);
      this.core.updateItem(id, (it) => (it.type === "agent" ? { ...it, markdown: it.markdown || text, streaming: false } : it));
    }
    for (const t of live.thinking.splice(0)) {
      const text = live.text.get(t.itemId) ?? "";
      live.text.delete(t.itemId);
      this.core.updateItem(t.itemId, (it) => (it.type === "reasoning" ? { ...it, text: it.text || text, streaming: false } : it));
    }
    const usage = (m as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }).usage;
    // The largest context among the models the turn used (subagents may use smaller ones).
    const windows = Object.values((m as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage ?? {}).map((u) => u.contextWindow ?? 0);
    const contextWindow = windows.length ? Math.max(...windows) : 0;
    turns.end(live, live.interrupted ? "interrupted" : m.is_error ? "failed" : "completed", usage, contextWindow || undefined);
    const limited = live.limitText !== null;
    if (live.interrupted) {
      live.interrupted = false;
      this.core.setStatus(sessionId, "idle");
    } else if (limited) {
      // A usage limit: the CLI has said so in the conversation; the wake bar shows when it resets.
      this.core.setStatus(sessionId, "idle");
    } else if (m.is_error) {
      const errors = (m as { errors?: string[] }).errors;
      // A refusal has said so already (its notices and the CLI's own message).
      const refused = (m as { stop_reason?: string | null }).stop_reason === "refusal";
      if (!refused || errors?.length) this.core.appendItem(sessionId, { type: "error", message: errors?.join("\n") || `回合出错（${m.subtype}）` }, { method: "result" });
      this.core.setStatus(sessionId, "error");
    } else {
      this.core.setStatus(sessionId, "idle");
    }
    this.deps.wake.afterTurn(sessionId, live);
    if (live.stopLoopAtEnd) {
      void this.core.close(sessionId);
      return;
    }
    this.deps.scheduleIdle(sessionId, live);
  }

  /** System messages: tasks (subagents, background commands), compaction, retries, notices, the command list. */
  private onSystem(sessionId: Id, live: Live, m: SDKMessage): void {
    const { turns, subagents } = this.deps;
    const s = m as unknown as Record<string, unknown> & { subtype: string };
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    switch (s.subtype) {
      case "init": {
        if (Array.isArray(s.skills)) this.deps.noteSkills(sessionId, (s.skills as unknown[]).filter((x): x is string => typeof x === "string"));
        return;
      }
      case "commands_changed": {
        if (Array.isArray(s.commands)) live.commands = s.commands as SdkSlashCommand[];
        return;
      }
      case "task_started": {
        const taskId = str(s.task_id);
        if (!taskId) return;
        const toolUseId = str(s.tool_use_id) || undefined;
        live.background.add(taskId);
        live.tasks.set(taskId, { ...(toolUseId ? { toolUseId } : {}), description: str(s.description), ...(str(s.task_type) ? { type: str(s.task_type) } : {}) });
        if (toolUseId && live.subs.has(toolUseId)) {
          live.backgroundSubs.add(toolUseId);
          live.agents.set(taskId, toolUseId);
        }
        // An agent resumed with SendMessage starts again under the same task id.
        const resumed = (toolUseId ? live.resumes.get(toolUseId) : undefined) ?? subagents.child(live, taskId);
        if (resumed) this.core.setStatus(resumed, "running");
        if (s.is_backgrounded === true) turns.startBackground(sessionId, live, taskId);
        return;
      }
      case "task_updated": {
        const taskId = str(s.task_id);
        const patch = (s.patch ?? {}) as { status?: string; is_backgrounded?: boolean; error?: string };
        // A foreground command sent to the background while it ran.
        if (patch.is_backgrounded === true && !live.bgItems.has(taskId)) turns.startBackground(sessionId, live, taskId);
        const itemId = live.bgItems.get(taskId);
        const state: BackgroundState | null = patch.status === "completed" ? "completed" : patch.status === "failed" ? "failed" : patch.status === "killed" ? "stopped" : null;
        if (itemId && state) turns.settleBackground(itemId, state, patch.error);
        return;
      }
      case "task_notification": {
        const taskId = str(s.task_id);
        if (!taskId) return;
        live.background.delete(taskId);
        const toolUseId = str(s.tool_use_id);
        // A resumed agent's notification names the SendMessage call that resumed it.
        const child = (toolUseId ? (live.subs.get(toolUseId) ?? live.resumes.get(toolUseId)) : undefined) ?? subagents.child(live, taskId);
        if (child) subagents.end(live, child, s.status === "completed" ? "completed" : s.status === "stopped" ? "idle" : "error");
        const itemId = live.bgItems.get(taskId);
        if (itemId) {
          const state: BackgroundState = s.status === "completed" ? "completed" : s.status === "stopped" ? "stopped" : "failed";
          // task_updated may have ended it already; the notification still brings the summary and the output file.
          this.core.updateItem(itemId, (it) =>
            it.type === "background"
              ? {
                  ...it,
                  ...(it.state === "running" ? { state, endedAt: this.core.now().toISOString() } : {}),
                  ...(str(s.summary) ? { summary: str(s.summary) } : {}),
                  ...(str(s.output_file) && !it.outputFile ? { outputFile: str(s.output_file) } : {}),
                }
              : it,
          );
          live.bgItems.delete(taskId);
        }
        live.tasks.delete(taskId);
        return;
      }
      case "status": {
        if (s.status === "compacting" && !live.compaction) {
          if (!live.running) turns.started(sessionId, live);
          live.compaction = this.core.appendItem(sessionId, { type: "compaction", state: "running" }, { method: "status/compacting" }).id;
        } else if (s.compact_result === "failed") {
          const error = str(s.compact_error);
          const failed = { state: "failed" as const, ...(error ? { error } : {}) };
          if (live.compaction) this.core.updateItem(live.compaction, (it) => (it.type === "compaction" ? { ...it, ...failed } : it));
          else this.core.appendItem(sessionId, { type: "compaction", ...failed }, { method: "status/compact_failed" });
          live.compaction = null;
        }
        return;
      }
      case "compact_boundary": {
        const meta = (s.compact_metadata ?? {}) as { trigger?: "manual" | "auto"; pre_tokens?: number; post_tokens?: number };
        const fields = {
          state: "completed" as const,
          ...(meta.trigger ? { trigger: meta.trigger } : {}),
          ...(typeof meta.pre_tokens === "number" ? { beforeTokens: meta.pre_tokens } : {}),
          ...(typeof meta.post_tokens === "number" ? { afterTokens: meta.post_tokens } : {}),
        };
        if (live.compaction) this.core.updateItem(live.compaction, (it) => (it.type === "compaction" ? { ...it, ...fields } : it));
        else this.core.appendItem(sessionId, { type: "compaction", ...fields }, { method: "compact_boundary" });
        live.compaction = null;
        // The context readout follows what is left after compacting.
        if (typeof meta.post_tokens === "number") live.context = meta.post_tokens;
        return;
      }
      case "api_retry": {
        const reason = retryReason(str(s.error), typeof s.error_status === "number" ? s.error_status : null);
        turns.setRetry(live, { attempt: Number(s.attempt) || 1, ...(typeof s.max_retries === "number" ? { max: s.max_retries } : {}), reason });
        return;
      }
      case "model_refusal_fallback":
        return turns.notice(sessionId, live, "warning", `模型 ${str(s.original_model)} 拒绝了这次请求，已改用 ${str(s.fallback_model)}。`, "refusal");
      case "model_refusal_no_fallback": {
        const why = str(s.api_refusal_explanation);
        return turns.notice(sessionId, live, "warning", `模型 ${str(s.original_model)} 拒绝了这次请求${why ? `：${why}` : "。"}`, "refusal");
      }
      case "permission_denied": {
        if (live.declinedByPerson.has(str(s.tool_use_id))) return;
        const message = str(s.message) || str(s.decision_reason);
        return turns.notice(sessionId, live, "warning", `${str(s.tool_name)} 没有获准运行${message ? `：${message}` : "。"}`, `denied:${str(s.tool_name)}`);
      }
      case "notification": {
        // Low-priority ones are the terminal UI's hints.
        if (s.priority === "low" || !str(s.text)) return;
        return turns.notice(sessionId, live, s.priority === "high" || s.priority === "immediate" ? "warning" : "info", str(s.text), `notification:${str(s.key)}`);
      }
      case "informational": {
        if (s.level === "suggestion" || !str(s.content)) return;
        return turns.notice(sessionId, live, s.level === "warning" ? "warning" : "info", str(s.content), `informational:${str(s.tag) || str(s.content)}`);
      }
      case "hook_response": {
        // Hooks only show when they fail or block (exit code 2).
        const blocked = s.exit_code === 2;
        if (s.outcome !== "error" && !blocked) return;
        const detail = firstLine(str(s.stderr) || str(s.output) || str(s.stdout));
        return turns.notice(sessionId, live, "warning", `Hook ${str(s.hook_name)}（${str(s.hook_event)}）${blocked ? "拦截了这一步" : "运行失败"}${detail ? `：${detail}` : "。"}`, `hook:${str(s.hook_name)}`);
      }
      default:
        // hook_started, session_state_changed, files_persisted, memory_recall, mirror_error… are not shown.
        return;
    }
  }
}
