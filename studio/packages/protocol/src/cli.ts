// CLI features in the conversation (stage 12, S12-E): `/` commands, context compaction, background commands and the
// chat settings that go with them. See plans/stage-12.md, S12-E.

/**
 * Where a command comes from, as the composer's menu groups them: Studio's own, the runtime's built-in commands, its
 * skills, and commands the person or a project defined.
 */
export type SlashCommandGroup = "studio" | "runtime" | "skill" | "custom";

export const SLASH_GROUP_LABEL: Record<SlashCommandGroup, string> = {
  studio: "Studio",
  runtime: "命令",
  skill: "Skills",
  custom: "自定义命令",
};

/** One row of the `/` menu. */
export interface SlashCommand {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** What it takes after the name (e.g. "<file>"); empty when nothing. */
  argumentHint?: string;
  group: SlashCommandGroup;
  /** Other names that run the same command. */
  aliases?: string[];
  /** Handled by the UI itself instead of the Host: `open-review` opens the project's Git Review window. */
  local?: "open-review";
}

export interface SlashCommandList {
  commands: SlashCommand[];
  /** Why the runtime's own commands are missing (it could not be asked), when they are. */
  note?: string;
}

/** What running a command did: a turn started (or was queued / steered), or it finished at once. */
export interface SlashCommandResult {
  mode: "start" | "steer" | "queue" | "done";
}

/** The tail of a background command's output, read from the file the CLI writes it to. */
export interface BackgroundOutput {
  text: string;
  /** Older output was left out. */
  truncated: boolean;
  /** The CLI has not written the file (yet), or it is gone. */
  missing?: boolean;
}

/** Conversation settings kept by the Host (设置 → 界面). */
export interface ChatSettings {
  /** Claude suggests a next message after each reply (one small extra model request per turn). */
  promptSuggestions: boolean;
}

// Off by default: each suggestion is one more model request per turn, and the subscriptions have budgets.
export const DEFAULT_CHAT_SETTINGS: ChatSettings = { promptSuggestions: false };

/** Most bytes of a background command's output the Host returns. */
export const BACKGROUND_OUTPUT_LIMIT = 8_000;

/** The `/name args` a message starts with, or null when it is not a command (a path like `/usr/bin` is not one). */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1]!, args: (m[2] ?? "").trim() };
}
