import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// @amo-studio/locate: where AMO looks for the programs it runs on — Claude Code, the DeepSeek Harness desktop app, Codex,
// git. Only file checks, nothing started. Moved out of the Host (2026-10-28) so AMO 平台's 环境 page looks in exactly the
// places Studio does without pulling in the Host and its SDKs; the Host imports these and behaves as before. Starting the
// programs (for `--version`) stays with each side: the Host asks synchronously, the platform asynchronously with a timeout.

type Env = Record<string, string | undefined>;

/** The first of `names` in PATH order (in each folder in the order given), as a terminal would find the command. */
export function firstOnPath(names: readonly string[], env: Env = process.env): string | null {
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const exe = join(dir, name);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

/** The first version-looking part of a program's `--version` ("2.1.309 (Claude Code)" → "2.1.309"), or null. */
export function versionIn(text: string): string | null {
  return /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null;
}

/** Whether `a` is an older version than `b` (dotted numbers). */
export function olderVersion(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

// ---- Claude Code ------------------------------------------------------------------------------------------------

/**
 * The person's own Claude Code, the first `claude` on PATH (native install `claude.exe`, or npm's `claude.cmd`), for
 * 设置 → 维护: it updates itself and may be newer than the SDK's. Null when there is none.
 */
export function claudeOnPath(env: Env = process.env): string | null {
  return firstOnPath(["claude.exe", "claude.cmd"], env);
}

/**
 * The exes of the person's own Claude Code that exist, in the order to try them: `claude` on PATH, else where its
 * installers put it (a program's PATH is the one it started with, so a Claude Code installed since is found there too).
 * npm's `claude.cmd` cannot be started without a shell; the native exe it wraps stands in for it. The first that starts
 * and says its version is the one (a broken install on PATH must not hide a good one).
 */
export function claudeCodeCandidates(env: Env = process.env): string[] {
  const home = env.USERPROFILE ?? homedir();
  const npm = env.APPDATA ? join(env.APPDATA, "npm") : null;
  const found: string[] = [];
  for (const exe of [claudeOnPath(env), join(home, ".local", "bin", "claude.exe"), npm && join(npm, "claude.cmd")]) {
    if (!exe || !existsSync(exe)) continue;
    const native = exe.toLowerCase().endsWith(".cmd") ? join(dirname(exe), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : exe;
    if (existsSync(native)) found.push(native);
  }
  return found;
}

// ---- DeepSeek Harness desktop app -------------------------------------------------------------------------------

/** The app's exe in its folder. */
export const DSH_DESKTOP_EXE = "DeepSeek Harness.exe";
/** Its own command line, as its resources/runtime/cli/bin/dsh.cmd runs it: the app's Electron as Node on this script. */
export const DSH_DESKTOP_CLI = ["resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"] as const;
export const DSH_DESKTOP_ARGS = ["--expose-internals"] as const;

/** Where the desktop app installs (per user); AMO_STUDIO_DSH_DESKTOP points elsewhere ("" = none). */
export function dshDesktopDir(env: Env = process.env): string | null {
  if (env.AMO_STUDIO_DSH_DESKTOP !== undefined) return env.AMO_STUDIO_DSH_DESKTOP || null;
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "DeepSeek Harness") : null;
}

/**
 * The app in `dir` when it is installed there: its exe and the CLI inside app.asar (which only Electron can read, so the
 * exe and the archive are what can be checked). Null when either is missing.
 */
export function dshDesktopIn(dir: string): { exe: string; cli: string } | null {
  const exe = join(dir, DSH_DESKTOP_EXE);
  if (!existsSync(exe) || !existsSync(join(dir, "resources", "app.asar"))) return null;
  return { exe, cli: join(dir, ...DSH_DESKTOP_CLI) };
}

// ---- Codex, git -------------------------------------------------------------------------------------------------

/** The person's own `codex`, the first on PATH, as their terminal finds it (not the copy the Codex desktop app bundles). */
export function codexOnPath(env: Env = process.env): string | null {
  return firstOnPath(["codex.exe", "codex.cmd"], env);
}

/** `git` as Studio runs it (execFile, no shell): git.exe on PATH. */
export function gitOnPath(env: Env = process.env): string | null {
  return firstOnPath(["git.exe"], env);
}
