// What the 环境 page shows (platform:call → environment). Types only: the page (packages/ui/src/platform) imports them
// too, so nothing here may need Node.

export type EnvItemId = "claude" | "dsh" | "codex" | "git";

export interface EnvItemView {
  id: EnvItemId;
  name: string;
  /** ok = found and answers; attention = found, but something to look at; missing = not found. */
  state: "ok" | "attention" | "missing";
  /** The exe found (also when it does not answer), or null. */
  path: string | null;
  version: string | null;
  /** One line: what to look at, or where it was looked for. */
  note: string | null;
  /** Which AMO features need it. */
  uses: string;
  /** The official page 去下载 opens (the platform's own list), or null when there is none yet. */
  download: string | null;
  /** A command to paste into PowerShell instead (Claude Code), with a 复制 button. */
  installCommand: string | null;
}

export interface EnvironmentView {
  /** When this check ran (ISO time). */
  checkedAt: string;
  items: EnvItemView[];
}
