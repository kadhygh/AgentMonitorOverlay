import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { StudioHealthView } from "./view.js";

// What the platform asks of Windows and of a running Studio — only reading, never changing anything.

function powershell(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
}

/** The exe paths of this user's running processes (UTF-8, so folders with Chinese names come through). */
export function runningExePaths(): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Where-Object { $_ } | Sort-Object -Unique";
  return new Promise((done) => {
    const child = spawn(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.on("error", () => done([]));
    child.on("close", () => done(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));
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

/**
 * Whether Studio is running on this data dir and how many sessions it has going: the data dir's host.json (url) and
 * host-token, then the Host's GET /api/health. `running` there is being added (10-28); without it the count is null
 * (unknown). Anything that does not answer reads as "not running".
 */
export async function studioHealth(dataDir: string | null, fetchImpl: typeof fetch = fetch): Promise<StudioHealthView> {
  if (!dataDir) return { hostUp: false, sessions: null };
  let url: string;
  let token: string;
  try {
    url = (JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8")) as { url?: string }).url ?? "";
    token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
  } catch {
    return { hostUp: false, sessions: null };
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url.replace(/\/+$/, ""))) return { hostUp: false, sessions: null };
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/api/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { hostUp: false, sessions: null };
    const body = (await res.json().catch(() => null)) as { running?: unknown } | null;
    return { hostUp: true, sessions: sessionCount(body?.running) };
  } catch {
    return { hostUp: false, sessions: null };
  }
}

/** /api/health → running: a count, or a list of sessions; anything else is unknown. */
export function sessionCount(running: unknown): number | null {
  if (typeof running === "number" && Number.isFinite(running) && running >= 0) return Math.floor(running);
  if (Array.isArray(running)) return running.length;
  return null;
}
