import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// 在中转里打开 (2026-11-05, plans/done/relay-round-2026-11-05.md J2/J3): from a session's 「等 X 回复（中转）」, the AMO 中转
// client shows that thread. Found the way AMO 平台 knows it (AGENTS.md rule 1): programs.json's `tools.relay` (installed
// by the platform), else the running client's own running.json (unpacked by hand). Started with `--open-thread <id>`:
// a running client takes it through its single-instance lock and goes there; one not running starts on it.

type Env = Record<string, string | undefined>;

/** The client's exe, or null when this computer has none Studio can find. */
export function findRelayExe(env: Env = process.env): string | null {
  const amoHome = env.AMO_HOME ? resolve(env.AMO_HOME) : join(env.APPDATA ?? "", "AMO");
  try {
    const programs = JSON.parse(readFileSync(join(amoHome, "programs.json"), "utf8").replace(/^﻿/, "")) as { tools?: Record<string, { dir?: unknown; exe?: unknown }> };
    const relay = programs.tools?.relay;
    if (typeof relay?.dir === "string" && typeof relay.exe === "string") {
      const exe = join(relay.dir, relay.exe);
      if (existsSync(exe)) return exe;
    }
  } catch {
    // no platform, or not this tool
  }
  const home = env.AMO_RELAY_HOME ? resolve(env.AMO_RELAY_HOME) : join(env.APPDATA ?? "", "AMO Relay");
  try {
    const running = JSON.parse(readFileSync(join(home, "running.json"), "utf8")) as { exe?: unknown };
    // A client run from the sources is electron.exe with its app as an argument: started bare, it would not be the client.
    if (typeof running.exe === "string" && existsSync(running.exe) && basename(running.exe).toLowerCase() !== "electron.exe") return running.exe;
  } catch {
    // not running, or an older client that writes no exe
  }
  return null;
}

/** Starts (or wakes) the client on the thread; false when there is none. Tests only record it. */
export function openInRelay(threadId: string, opts: { env?: Env; testMode?: boolean } = {}): boolean {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(threadId)) return false;
  const exe = findRelayExe(opts.env);
  if (opts.testMode) {
    const g = globalThis as { __amoRelayOpened?: Array<{ threadId: string; exe: string | null }> };
    (g.__amoRelayOpened ??= []).push({ threadId, exe });
    return true;
  }
  if (!exe) return false;
  spawn(exe, ["--open-thread", threadId], { detached: true, stdio: "ignore" }).unref();
  return true;
}
