import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { compareVersions, isVersion } from "./manifest.js";

// What the platform asks of Windows and of a running Studio — only reading, never changing anything.

function powershell(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
}

/** The exe paths of this user's running processes (UTF-8, so folders with Chinese names come through). */
export function runningExePaths(): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  // One line on stdin, not an encoded command (10-28: an antivirus took encoded PowerShell in AMO for a trojan).
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Where-Object { $_ } | Sort-Object -Unique\n";
  return new Promise((done) => {
    const child = spawn(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.on("error", () => done([]));
    child.on("close", () => done(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));
    child.stdin.on("error", () => undefined);
    child.stdin.end(script);
  });
}

/** Which of these folders a running process was started from (case-insensitive prefix, as Windows paths are). */
export function foldersInUse(paths: readonly string[], folders: readonly string[]): boolean[] {
  const lower = paths.map((p) => p.toLowerCase());
  return folders.map((f) => {
    const prefix = (resolve(f) + sep).toLowerCase();
    return lower.some((p) => p.startsWith(prefix));
  });
}

/** The version folders of `toolDir` that running exes are in (the tools run from their real version folder, launch.ts). */
export function runningVersions(paths: readonly string[], toolDir: string): string[] {
  const prefix = (resolve(toolDir) + sep).toLowerCase();
  const out = new Set<string>();
  for (const p of paths) {
    if (!p.toLowerCase().startsWith(prefix)) continue;
    const v = p.slice(prefix.length).split(/[\\/]/)[0] ?? "";
    if (isVersion(v)) out.add(v);
  }
  return [...out];
}

/** The first version of each tool whose running instance quits on --amo-quit (2026-10-29); an older one only comes to the front. */
export const QUIT_SINCE: Record<string, string> = { studio: "0.9.8", notes: "0.9.3", relay: "0.9.2" };

/** What a running Studio says of itself (/api/health), read only. */
export interface StudioHealth {
  /** Studio's Host answers on its data dir's host.json. */
  hostUp: boolean;
  /** Sessions running, when the Host says (/api/health → running); null when it does not. */
  sessions: number | null;
  /** The Studio version that started the Host (/api/health → version, 2026-10-29): "dev" from the sources; null when an older Host does not say. */
  version: string | null;
}

const DOWN: StudioHealth = { hostUp: false, sessions: null, version: null };

/** The data dir's host.json (a local address only) and host-token, as the shell reads them; null when there is no Host. */
function hostOf(dataDir: string): { url: string; pid: number | null; token: string } | null {
  let info: { url?: unknown; pid?: unknown };
  try {
    info = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8")) as { url?: unknown; pid?: unknown };
  } catch {
    return null;
  }
  const url = typeof info.url === "string" ? info.url.replace(/\/+$/, "") : "";
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) return null;
  let token = "";
  try {
    token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
  } catch {
    // none: /api/health does not need it
  }
  return { url, pid: typeof info.pid === "number" && Number.isInteger(info.pid) && info.pid > 0 ? info.pid : null, token };
}

/**
 * Whether Studio is running on this data dir and how many sessions it has going: the data dir's host.json (url), then
 * the Host's GET /api/health → { ok, pid, running, version } (running added 10-28, version 10-29; an older Studio
 * without them gives null, unknown). Anything that does not answer reads as "not running".
 */
export async function studioHealth(dataDir: string | null, fetchImpl: typeof fetch = fetch): Promise<StudioHealth> {
  if (!dataDir) return DOWN;
  const host = hostOf(dataDir);
  if (!host) return DOWN;
  // /api/health needs no token (10-28); an older Host may still want it, so it goes along when it is there.
  try {
    const res = await fetchImpl(`${host.url}/api/health`, { ...(host.token ? { headers: { authorization: `Bearer ${host.token}` } } : {}), signal: AbortSignal.timeout(1500) });
    if (!res.ok) return DOWN;
    const body = (await res.json().catch(() => null)) as { running?: unknown; version?: unknown } | null;
    const version = typeof body?.version === "string" && body.version.trim() ? body.version.trim().slice(0, 40) : null;
    return { hostUp: true, sessions: sessionCount(body?.running), version };
  } catch {
    return DOWN;
  }
}

/**
 * 重启 Studio on the Studio card (2026-10-29): offered when the running Host was started by an older Studio than the one
 * installed — "ready" with nothing at work, "busy" while sessions are (AGENTS.md, constraint 6: never with sessions at
 * work); "unsupported" for a Host too old to say its version (it cannot be asked to stop either); otherwise "none" (not
 * running, the same or a newer version, a development build).
 */
export function studioRestart(health: StudioHealth, installed: string | null): "none" | "ready" | "busy" | "unsupported" {
  if (!health.hostUp || !installed) return "none";
  if (health.version === null) return "unsupported";
  if (!/^\d+(\.\d+)*(-.+)?$/.test(health.version) || compareVersions(health.version, installed) >= 0) return "none";
  return health.sessions !== null && health.sessions > 0 ? "busy" : "ready";
}

export type StudioStop =
  /** Accepted: wait for these processes (the Host, and the shell from shell.json) to end. */
  | { ok: true; pids: number[] }
  | { ok: false; reason: "running"; running: number }
  | { ok: false; reason: "not-running" | "unsupported" | "failed"; message: string };

/** The Studio shell's pid from the data dir's shell.json (written by Studio since 2026-10-29), or null. */
export function studioShellPid(dataDir: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(join(dataDir, "shell.json"), "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 重启 Studio's first half: asks the Host to stop (POST /api/shutdown with the token from the data dir, read only —
 * AGENTS.md constraint 1). Never with `interrupt`: with sessions at work the Host refuses, always. A Studio shell on it
 * quits with it (it sees host-exit.json).
 */
export async function stopStudio(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<StudioStop> {
  const host = hostOf(dataDir);
  if (!host) return { ok: false, reason: "not-running", message: "Studio 的后台没在运行。" };
  if (!host.token) return { ok: false, reason: "failed", message: `读不到 ${join(dataDir, "host-token")}，没法让后台关掉。` };
  // Before asking: the shell removes its file when it quits, which may be soon after.
  const shell = studioShellPid(dataDir);
  try {
    const res = await fetchImpl(`${host.url}/api/shutdown`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
    const body = (await res.json().catch(() => null)) as { running?: unknown; error?: { message?: unknown } } | null;
    if (res.ok) return { ok: true, pids: [host.pid, shell].filter((p): p is number => p !== null && p !== process.pid) };
    const running = sessionCount(body?.running);
    if (res.status === 409 && running) return { ok: false, reason: "running", running };
    if (res.status === 404) return { ok: false, reason: "unsupported", message: "这个后台是更早的 Studio 启动的，不能从这里关掉。" };
    return { ok: false, reason: "failed", message: typeof body?.error?.message === "string" ? body.error.message : `后台回了 HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: "not-running", message: `Studio 的后台没有回应：${err instanceof Error ? err.message : String(err)}` };
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Waits for these processes to end; returns the ones still running after `timeoutMs`. */
export async function waitForExit(pids: readonly number[], timeoutMs: number, alive: (pid: number) => boolean = pidAlive): Promise<number[]> {
  for (const until = Date.now() + timeoutMs; ; ) {
    const left = pids.filter(alive);
    if (!left.length || Date.now() >= until) return left;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** /api/health → running: a count, or a list of sessions; anything else is unknown. */
export function sessionCount(running: unknown): number | null {
  if (typeof running === "number" && Number.isFinite(running) && running >= 0) return Math.floor(running);
  if (Array.isArray(running)) return running.length;
  return null;
}
