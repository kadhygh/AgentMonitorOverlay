import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { programsFile, readJsonFile, type Env } from "@amo-studio/account";

// 从 Studio 打开中转客户端 (2026-11-23, 中转迭代讨论 — the user: 「反向跳转也一起做」): a session's 协作 line opens that 协作 in the
// AMO 中转 client on this computer. The Host starts it (the UI asks), detached, with `--open=cowork:<id>` (or thread:<id>):
// a client already open takes it through its single-instance lock and goes there; one not open starts on it. The client
// side (relay-app) is 「协作·服务」's. Found the way AMO 平台 knows it (AGENTS.md rule 1, files only read here):
//   1. the client's own running.json in its home (%APPDATA%\AMO Relay, or AMO_RELAY_HOME): { pid, exe, startedAt },
//      written while it runs — first, because a second copy started from another folder makes the open one quit (a
//      platform update's way: relay-app main.ts second-instance), so the one open is the one to wake;
//   2. else AMO 平台's %APPDATA%\AMO\programs.json, tools.relay: { version, dir, exe } (exe relative to dir).
// An older client that does not know --open= still opens, only not at that 协作: Studio cannot tell, the client says so.

/** What may follow --open=: a 协作 or a thread of 中转. */
const TARGET = /^(cowork|thread):[A-Za-z0-9_-]{1,80}$/;

export function relayTarget(value: unknown): string | null {
  return typeof value === "string" && TARGET.test(value.trim()) ? value.trim() : null;
}

/** Where the client was found: its exe, and which file said so. */
export interface RelayClientFound {
  exe: string;
  from: "running.json" | "programs.json";
}

/** The 中转 client's home (where it writes running.json), as relay-app and AMO 平台 (platform/src/running.ts) have it. */
export function relayHome(env: Env): string | null {
  if (env.AMO_RELAY_HOME) return resolve(env.AMO_RELAY_HOME);
  return env.APPDATA ? join(env.APPDATA, "AMO Relay") : null;
}

/** The 中转 client's exe, or null when this computer has none Studio can find. */
export function findRelayClient(env: Env = process.env): RelayClientFound | null {
  const home = relayHome(env);
  const running = home ? readJsonFile<{ exe?: unknown }>(join(home, "running.json")) : null;
  // A client run from the sources is electron.exe with its app as an argument: started bare it would not be the client.
  if (typeof running?.exe === "string" && existsSync(running.exe) && basename(running.exe).toLowerCase() !== "electron.exe") return { exe: running.exe, from: "running.json" };
  const relay = readJsonFile<{ tools?: Record<string, { dir?: unknown; exe?: unknown }> }>(programsFile(env))?.tools?.relay;
  if (typeof relay?.dir === "string" && typeof relay.exe === "string") {
    const exe = join(relay.dir, relay.exe);
    if (existsSync(exe)) return { exe, from: "programs.json" };
  }
  return null;
}

/**
 * The environment the client starts with: the Host's, without what is the Host's own or Studio's agents' — Electron's
 * Node switch (the client would start as plain Node), AMO_STUDIO_* (the data dir, UI, port: AGENTS.md says not to hand
 * them on), the model CLIs' and their keys (credentials never go by environment, AGENTS.md rule 7) and a tool shell's
 * colour switches.
 */
const NOT_FOR_RELAY = /^(ELECTRON_.*|AMO_STUDIO_.*|AMO_MCP_.*|CLAUDE.*|ANTHROPIC_.*|CODEX_.*|OPENAI_.*|DEEPSEEK_.*|DSH_.*|NODE_OPTIONS|NO_COLOR|FORCE_COLOR|COLOR|CLICOLOR|CLICOLOR_FORCE|TERM)$/i;

export function relayClientEnv(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string" && !NOT_FOR_RELAY.test(e[0])));
}

/** A start of the client, recorded instead of run in test mode. */
export interface RelayClientLaunch {
  exe: string;
  args: string[];
  env: Record<string, string>;
}

export function relayClientLaunch(found: RelayClientFound, target: string, env: Env): RelayClientLaunch {
  return { exe: found.exe, args: [`--open=${target}`], env: relayClientEnv(env) };
}

export function startRelayClient(launch: RelayClientLaunch): void {
  spawn(launch.exe, launch.args, { detached: true, stdio: "ignore", env: launch.env, windowsHide: false }).unref();
}
