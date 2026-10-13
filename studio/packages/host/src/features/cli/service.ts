import { open, stat } from "node:fs/promises";
import { BACKGROUND_OUTPUT_LIMIT, type BackgroundOutput, type ChatSettings, type Id, type SlashCommand, type SlashCommandList, type SlashCommandResult } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { readChatSettings, writeChatSettings } from "../../runtime/chat-settings.js";

/** Studio's own `/` commands, offered for every session (before the runtime's). */
const STUDIO_COMMANDS: readonly SlashCommand[] = [
  { name: "compact", description: "压缩上下文：把之前的对话总结成摘要，腾出上下文空间", argumentHint: "[总结时要保留的重点]", group: "studio" },
];
const REVIEW_COMMAND: SlashCommand = { name: "review", description: "打开这个项目的 Git Review 窗口，看改动、逐行批注", group: "studio", local: "open-review" };

/**
 * CLI features in the conversation (stage 12, S12-E): the `/` menu (Studio's commands plus the runtime's), running a
 * command, background commands (stop, output) and the conversation settings.
 */
export class CliFeature extends Feature {
  async listCommands(sessionId: Id): Promise<SlashCommandList> {
    const session = this.requireSession(sessionId);
    const [runtime, repo] = await Promise.all([
      this.wrap(() => this.runtime.listCommands?.(sessionId) ?? Promise.resolve({ commands: [] })),
      this.f.gitReview.status(session.workspaceId).then((s) => s.repo, () => false),
    ]);
    const studio = [...STUDIO_COMMANDS, ...(repo ? [REVIEW_COMMAND] : [])];
    const taken = new Set(studio.map((c) => c.name));
    return { ...runtime, commands: [...studio, ...runtime.commands.filter((c) => !taken.has(c.name))] };
  }

  async runCommand(sessionId: Id, body: unknown): Promise<SlashCommandResult> {
    const session = this.requireSession(sessionId);
    if (session.archivedAt) throw new HostError("read_only", "archived sessions cannot run commands");
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const name = typeof b.name === "string" ? b.name.trim().replace(/^\//, "") : "";
    if (!/^[A-Za-z0-9][\w:.-]*$/.test(name)) throw new HostError("bad_request", "name must be a command name");
    if (b.args !== undefined && typeof b.args !== "string") throw new HostError("bad_request", "args must be text");
    const args = typeof b.args === "string" ? b.args.trim() : "";
    if (args.length > 20_000) throw new HostError("bad_request", "args are too long");
    if (name === REVIEW_COMMAND.name) throw new HostError("bad_request", "/review opens the Git Review window in the UI");
    if (!this.runtime.runCommand) throw new HostError("bad_request", "this Host cannot run commands");
    return this.wrap(() => this.runtime.runCommand!(sessionId, name, args), "conflict");
  }

  async stopBackground(sessionId: Id, taskId: string): Promise<void> {
    this.requireSession(sessionId);
    if (!this.runtime.stopBackground) throw new HostError("bad_request", "this Host has no background commands");
    await this.wrap(() => this.runtime.stopBackground!(sessionId, taskId));
  }

  /** The tail of what a background command wrote (the CLI keeps it in a file of its own). */
  async backgroundOutput(sessionId: Id, taskId: string): Promise<BackgroundOutput> {
    this.requireSession(sessionId);
    const item = this.store.listItems(sessionId).find((i) => i.type === "background" && i.taskId === taskId);
    if (!item || item.type !== "background") throw new HostError("not_found", `background command ${taskId} not found`);
    if (!item.outputFile) return { text: "", truncated: false, missing: true };
    const info = await stat(item.outputFile).catch(() => null);
    if (!info?.isFile()) return { text: "", truncated: false, missing: true };
    const start = Math.max(0, info.size - BACKGROUND_OUTPUT_LIMIT);
    const file = await open(item.outputFile, "r");
    try {
      const buf = Buffer.alloc(info.size - start);
      await file.read(buf, 0, buf.length, start);
      // Starting mid-file may cut a line (or a character) in two: drop the partial first line.
      let text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      return { text, truncated: start > 0 };
    } finally {
      await file.close();
    }
  }

  chatSettings(): ChatSettings {
    return readChatSettings(this.store);
  }

  updateChatSettings(body: unknown): ChatSettings {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const next = { ...this.chatSettings() };
    if (b.promptSuggestions !== undefined) {
      if (typeof b.promptSuggestions !== "boolean") throw new HostError("bad_request", "promptSuggestions must be true or false");
      next.promptSuggestions = b.promptSuggestions;
    }
    writeChatSettings(this.store, next);
    this.runtime.applyChatSettings?.(next);
    return next;
  }
}
