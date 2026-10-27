import type { SlashCommand as SdkSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { SlashCommand } from "@amo-studio/protocol";

/**
 * Claude Code commands left out of the `/` menu (stage 12, S12-E): they would change what Studio keeps for the session
 * (its conversation, model, effort, name) behind its back, only make sense in the terminal UI, or are internal.
 * `compact` is offered as Studio's own. The ones in BLOCKED_COMMANDS are refused when typed.
 */
const HIDDEN_COMMANDS = new Set(["compact", "clear", "model", "effort", "fast", "rename", "config", "color", "focus", "heapdump", "auto-mode-setup", "autocompact", "resume", "exit", "quit", "login", "logout", "workflow-launch-exec"]);
export const BLOCKED_COMMANDS: Record<string, string> = {
  clear: "Studio 里不能用 /clear 清空会话：请新建一个会话。",
  reset: "Studio 里不能用 /reset 清空会话：请新建一个会话。",
  new: "Studio 里不能用 /new：请新建一个会话。",
  model: "请用输入框左下角的「型号」切换模型。",
  effort: "请用输入框左下角切换思考强度。",
  rename: "请在会话标题上改名。",
  resume: "Studio 里不能切换到别的 Claude 会话。",
  exit: "Studio 里不需要 /exit。",
  quit: "Studio 里不需要 /quit。",
  login: "Studio 里不能用 /login：在终端运行 claude 登录，Studio 用的就是那份登录。",
  logout: "Studio 里不能用 /logout：请在终端的 claude 里退出。",
};

/**
 * The runtime's rows of the `/` menu from Claude Code's command list: commands that would undo what Studio keeps for
 * the session are left out (HIDDEN_COMMANDS), removed and internal ones too; skills are told apart by name.
 */
export function claudeCommands(list: readonly SdkSlashCommand[], skills: ReadonlySet<string> = new Set()): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();
  for (const c of list) {
    const name = c.name.trim();
    if (!name || name.startsWith("_") || HIDDEN_COMMANDS.has(name) || /^\(removed\)/.test(c.description ?? "")) continue;
    // Rows can share a name: Claude Code's own wins (it is the one /name runs).
    if (seen.has(name) && !c.builtin) continue;
    const description = (c.description ?? "").replace(/\s+/g, " ").trim();
    seen.set(name, {
      name,
      description,
      ...(c.argumentHint?.trim() ? { argumentHint: c.argumentHint.trim() } : {}),
      group: skills.has(name) ? "skill" : c.builtin ? "runtime" : "custom",
      ...(c.aliases?.length ? { aliases: c.aliases.filter((a) => !HIDDEN_COMMANDS.has(a)) } : {}),
    });
  }
  return [...seen.values()];
}

/** A local command's output without the CLI's stdout/stderr tags. */
export function localCommandText(text: string): string {
  return text.replace(/<\/?local-command-(?:stdout|stderr)>/g, "").trim();
}
