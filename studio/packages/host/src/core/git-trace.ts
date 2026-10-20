import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// Git trace (2026-10-20, opening a prefab of the big Unity project in the viewer made the disk, and Windows with it,
// stall): every git command the Host runs, how long it took, how many ran at once, how much it printed and which
// request asked for it; and requests that took a second or more. Written to <data>/logs/git-trace.log, started by
// bin.ts outside tests; AMO_STUDIO_TRACE_GIT=0 turns it off.

const MAX_BYTES = 4 * 1024 * 1024;
const SLOW_REQUEST_MS = 1000;

const requests = new AsyncLocalStorage<string>();
let file: string | null = null;
let running = 0;

const stamp = () => new Date().toLocaleString("sv-SE").slice(11) + `.${String(Date.now() % 1000).padStart(3, "0")}`;

function write(line: string): void {
  if (!file) return;
  try {
    // One older file is kept.
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.old`);
    appendFileSync(file, `${line}\n`);
  } catch {
    // A trace never breaks the Host.
  }
}

export function startGitTrace(dataDir: string): void {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  file = join(dir, "git-trace.log");
  write(`--- start ${new Date().toLocaleString("sv-SE")} (local times; "running" counts this command)`);
}

/** Runs `fn` as the request `tag` ("GET /api/…"): git commands under it name it, and it is logged when slow. */
export async function tracedRequest<T>(tag: string, fn: () => T | Promise<T>): Promise<T> {
  if (!file) return fn();
  const started = Date.now();
  try {
    return await requests.run(tag, fn);
  } finally {
    const ms = Date.now() - started;
    if (ms >= SLOW_REQUEST_MS) write(`${stamp()} slow request ${ms}ms ${tag}`);
  }
}

/** A git command starting in `cwd`; call what it returns when it ends, with the size of its output or the error. */
export function traceGit(cwd: string, args: readonly string[]): (end: { bytes?: number; error?: string }) => void {
  if (!file) return () => undefined;
  const started = Date.now();
  const at = ++running;
  const tag = requests.getStore() ?? "(no request)";
  return ({ bytes, error }) => {
    running--;
    const shown = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
    write(`${stamp()} ${String(Date.now() - started).padStart(5)}ms running=${at} [${basename(cwd)}] git ${shown.length > 240 ? `${shown.slice(0, 240)}…` : shown} → ${error ? `error: ${error.slice(0, 120)}` : `${bytes ?? 0}B`} · ${tag}`);
  };
}
