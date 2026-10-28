import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Which build this shell runs in (2026-10-28, the user: AMO 中转's desktop client installs and updates through AMO 平台
// too; AGENTS.md constraint 3). scripts/package-portable.mjs writes `amoBuild: { mode, runtime }` into
// resources/app/package.json:
//   portable  the zip people unpacked themselves: 更新桌面程序 swaps its own files from the service's zip, as before.
//   platform  a version folder of the platform (%LOCALAPPDATA%\AMO\apps\relay\<version>\): never rewritten by itself —
//             the platform hard-links Electron's files between the tools it installs, so changing one here would change
//             them in the others — and a newer shell comes from the platform. The content still updates from the service.
// A dev build (electron packages/relay-app) has no amoBuild: it behaves as portable without a build stamp (no updates).

export type BuildMode = "platform" | "portable" | "dev";

/** resources/app/package.json, seen from packages/relay-app/dist (the layout package-portable.mjs keeps). */
export function appPackageFile(distDir: string): string {
  return join(distDir, "..", "..", "..", "package.json");
}

/** The build mode written next to the program: "dev" when there is none (the sources, or a folder from before 10-29). */
export function readBuildMode(distDir: string): BuildMode {
  try {
    const mode = (JSON.parse(readFileSync(appPackageFile(distDir), "utf8")) as { amoBuild?: { mode?: unknown } }).amoBuild?.mode;
    return mode === "platform" || mode === "portable" ? mode : "dev";
  } catch {
    return "dev";
  }
}

/** The exe the MCP configs and amo-relay.cmd point at. A platform install runs from apps\relay\<version>\, which goes
 * once two newer versions are in (the platform keeps 2): configs pasted into Claude Code or Codex would then point at
 * nothing. `current` (the junction the platform keeps on the version in use) stays; running as Node (ELECTRON_RUN_AS_NODE)
 * through it is safe even while the platform switches it, unlike the window, which loads its files as it goes. */
export function stableExe(execPath: string, mode: BuildMode): string {
  if (mode !== "platform") return execPath;
  const viaCurrent = join(dirname(dirname(execPath)), "current", basename(execPath));
  return existsSync(viaCurrent) ? viaCurrent : execPath;
}

/** What the shell tells the content and its own pages when the content needs a newer desktop program. */
export function newShellText(mode: BuildMode): string {
  return mode === "platform" ? "要新的桌面程序：在 AMO 平台的「工具」里更新 AMO 中转。" : "需要重新下载客户端。";
}
