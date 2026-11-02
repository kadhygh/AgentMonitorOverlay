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
  /**
   * Claude Code not installed, or installed by its own installer (2026-11-03, plans/claude-code-mirror.md): what 安装 /
   * 更新 fetches — the version, from the team server's mirror or Anthropic, the .zst's size when known. Null for the
   * others, and for a Claude Code from npm (npm updates it) or another installer.
   */
  install: { version: string; from: "server" | "official"; size: number | null } | null;
  /** The team server is getting a newer version ready (「团队服务器正在准备 2.1.317（45%）…」). */
  preparing: string | null;
}

/** 安装 / 更新 Claude Code under way (PlatformView.envTask): what it does now and how far it is. */
export interface EnvTaskView {
  id: EnvItemId;
  version: string;
  from: "server" | "official";
  phase: "manifest" | "downloading" | "unpacking" | "installing";
  done: number;
  total: number | null;
  /** Over the last few seconds, while downloading. */
  bytesPerSec: number;
}

/** 更新 (2026-10-29, the user: like cc-switch, only on this page, only when clicked). */
export type EnvUpdateResult = { ok: true; message: string; view: EnvironmentView } | { ok: false; message: string; view: EnvironmentView | null };

export interface EnvironmentView {
  /** When this check ran (ISO time). */
  checkedAt: string;
  items: EnvItemView[];
}
