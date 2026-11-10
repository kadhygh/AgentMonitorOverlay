import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "./json.js";
import { platformFile, type Env } from "./paths.js";

// 崩溃转储 (2026-11-10, the user's call): Studio's main process died five times (10-31..11-10, 0x80000003) and left
// nothing behind but a WER line, so each AMO program (Studio, 平台, 便签, 中转, Reviewer) keeps a Crashpad minidump
// of a crash in its own userData\Crashpad — never uploaded. On by default on the platform's test channel, off on the
// stable one and without the platform; Studio's 设置 → 维护 can turn it on or off for itself (the other programs get a
// switch later, if needed). Crashpad costs a small idle handler process and nothing on the main thread; a dump is
// written only when a process crashes. Only the newest KEEP_CRASH_DUMPS stay. A dump holds part of the process's
// memory (conversation text, paths): it stays on this machine.

export const KEEP_CRASH_DUMPS = 5;

export type CrashDumpsWhy = "env" | "setting" | "test-channel" | "stable-channel" | "no-platform";

export interface CrashDumpsChoice {
  on: boolean;
  why: CrashDumpsWhy;
}

/** The AMO platform's 更新通道 (platform.json), or null when the platform has not been set up on this machine. */
export function platformChannel(env: Env = process.env): "test" | "stable" | null {
  const p = readJsonFile<{ channel?: unknown }>(platformFile(env));
  if (!p) return null;
  return p.channel === "test" ? "test" : "stable";
}

/** AMO_CRASH_DUMPS=1/0 first (tests, a one-off run), then the program's own setting (null: none), then the channel. */
export function crashDumpsChoice(setting: boolean | null, env: Env = process.env): CrashDumpsChoice {
  if (env.AMO_CRASH_DUMPS === "1" || env.AMO_CRASH_DUMPS === "0") return { on: env.AMO_CRASH_DUMPS === "1", why: "env" };
  if (typeof setting === "boolean") return { on: setting, why: "setting" };
  const channel = platformChannel(env);
  if (channel === null) return { on: false, why: "no-platform" };
  return channel === "test" ? { on: true, why: "test-channel" } : { on: false, why: "stable-channel" };
}

export interface CrashDump {
  path: string;
  mtimeMs: number;
  size: number;
}

/** The minidumps under a Crashpad folder (reports\, and pending\ / completed\ where Crashpad puts them), newest first. */
export function listCrashDumps(dir: string): CrashDump[] {
  const out: CrashDump[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      try {
        const s = statSync(p);
        if (s.isDirectory()) {
          if (depth < 2) walk(p, depth + 1);
        } else if (name.toLowerCase().endsWith(".dmp")) out.push({ path: p, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // gone meanwhile
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Deletes all but the newest `keep` minidumps; returns how many went. */
export function pruneCrashDumps(dir: string, keep = KEEP_CRASH_DUMPS): number {
  let removed = 0;
  for (const dump of listCrashDumps(dir).slice(keep)) {
    try {
      rmSync(dump.path, { force: true });
      removed++;
    } catch {
      // in use, or not ours to delete: left for next time
    }
  }
  return removed;
}

/** The parts of Electron's `app` and `crashReporter` used here (this package does not depend on Electron). */
export interface CrashDumpsElectron {
  app: { getPath(name: "crashDumps"): string };
  crashReporter: { start(options: { productName?: string; uploadToServer: boolean; compress?: boolean }): void };
}

export interface CrashDumpsState extends CrashDumpsChoice {
  /** Where the dumps go (userData\Crashpad), also when off: older ones may be there. */
  dir: string;
  /** Crashpad was started in this run. */
  started: boolean;
}

/**
 * Call in a program's main process right after it set its userData (before app ready, so every child process it
 * starts is covered too). Prunes old dumps either way; starts Crashpad, without uploading, when the choice says so.
 * Never throws: a crash reporter that cannot start must not keep the program from starting.
 * A test run (`testMode`, the program's *_TEST=1) never starts it unless AMO_CRASH_DUMPS=1: not every e2e run moves
 * AMO_HOME, and this machine's platform.json may say test channel. The choice itself is left as it is, for 设置 to show.
 */
export function startCrashDumps(electron: CrashDumpsElectron, productName: string, choice: CrashDumpsChoice, testMode = false, env: Env = process.env): CrashDumpsState {
  let dir = "";
  let started = false;
  try {
    // userData\Crashpad, as the program set its userData. Never app.setPath("crashDumps"): with Electron 44 on Windows
    // the crashpad handler then never starts and no dump is written, even when it is set to the same folder (tried
    // 2026-11-10 with process.crash()).
    dir = electron.app.getPath("crashDumps");
    pruneCrashDumps(dir);
    if (choice.on && (!testMode || env.AMO_CRASH_DUMPS === "1")) {
      electron.crashReporter.start({ productName, uploadToServer: false, compress: false });
      started = true;
    }
  } catch (err) {
    console.error(`crash dumps not started: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ...choice, dir, started };
}
