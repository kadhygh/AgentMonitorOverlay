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
   * Claude Code (not installed, or from its own installer) and Codex (not installed, or from npm) are installed here by
   * the platform (2026-11-03, plans/done/claude-code-mirror.md): the two places to fetch from, side by side. Null for the
   * others, a Claude Code from npm (npm updates it) and anything from another installer.
   */
  install: EnvInstallView | null;
}

export type EnvFrom = "server" | "official";

/** 安装 / 更新's places (the user, 2026-11-03: the team server's block when it has a version ready, the official one always; the person picks). */
export interface EnvInstallView {
  /** The team server's newest ready version for this machine, with the download's size; null: none there. */
  server: { version: string; size: number } | null;
  /** The maker's latest; null: not reached. */
  official: { version: string } | null;
  /** The team server is getting a newer version ready (「团队服务器正在准备 2.1.317（45%）…」). */
  preparing: string | null;
  /** Why the buttons cannot be used here (Codex without npm), with the page that helps; null: they can. */
  blocked: { text: string; page: string; pageName: string } | null;
}

/** 安装 / 更新 Claude Code or Codex under way (PlatformView.envTask): what it does now and how far it is. */
export interface EnvTaskView {
  id: EnvItemId;
  version: string;
  from: EnvFrom;
  phase: "manifest" | "downloading" | "unpacking" | "verifying" | "installing";
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
