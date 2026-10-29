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
  /** The newest version published (npm's latest; Claude Code and Codex, 2026-10-29), or null when not asked or not reached. */
  latest: string | null;
  /** How 更新 runs here (the command, for the button's title); null when it cannot (not installed, or installed in a way the
   *  platform does not update). */
  updater: string | null;
}

/** 更新 (2026-10-29, the user: like cc-switch, only on this page, only when clicked). */
export type EnvUpdateResult = { ok: true; message: string; view: EnvironmentView } | { ok: false; message: string; view: EnvironmentView | null };

export interface EnvironmentView {
  /** When this check ran (ISO time). */
  checkedAt: string;
  items: EnvItemView[];
}
