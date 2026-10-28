import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_START_FAILED, type HostStartFailedMessage } from "@amo-studio/protocol";

// Finds a running Host for the data dir, or starts one with Electron's own Node (ELECTRON_RUN_AS_NODE).
// The Host is a resident process: in normal use it keeps running after the window closes so sessions continue.

export interface HostConnection {
  url: string;
  token: string;
  /** Present when this shell started the Host. */
  child: ChildProcess | null;
  /** The Host's process (host.json), to tell it was asked to stop (stoppedOnPurpose) and to wait for it to end. */
  pid?: number;
}

export interface HostLinkOptions {
  dataDir: string;
  hostBin: string;
  uiDir?: string;
  port?: number;
  /** Tests: keep the Host attached so it can be stopped with the app. */
  attached?: boolean;
  /** Studio's version, handed to a Host this shell starts (its /api/health says it, for the AMO platform). */
  version?: string;
  timeoutMs?: number;
}

/**
 * The Host did not start. `forPerson` is set when the Host said why in words for the person (e.g. the data was migrated
 * by a newer Studio, 2026-10-28): the shell shows it as it is.
 */
export class HostStartError extends Error {
  constructor(message: string, readonly forPerson: string | null = null) {
    super(message);
    this.name = "HostStartError";
  }
}

const isStartFailed = (msg: unknown): msg is HostStartFailedMessage =>
  !!msg && typeof msg === "object" && (msg as { type?: unknown }).type === HOST_START_FAILED && typeof (msg as { message?: unknown }).message === "string";

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Whether the Host answers. 2026-10-27: /api/health (was /api/state, the whole state) with a longer wait: a Host busy
 * for a moment (just started, resuming sessions) was taken for a dead one.
 */
async function ping(url: string, token: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Whether a process still runs (a busy Host is not a dead one). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function current(dataDir: string): { url: string; token: string; pid: number } | null {
  const info = readJson<{ url: string; pid: number }>(join(dataDir, "host.json"));
  const tokenFile = join(dataDir, "host-token");
  if (!info || !existsSync(tokenFile)) return null;
  return { url: info.url, pid: info.pid, token: readFileSync(tokenFile, "utf8").trim() };
}

export async function connectHost(options: HostLinkOptions): Promise<HostConnection> {
  mkdirSync(options.dataDir, { recursive: true });
  const existing = current(options.dataDir);
  if (existing && (await ping(existing.url, existing.token))) return { url: existing.url, token: existing.token, child: null, pid: existing.pid };

  const log = openSync(join(options.dataDir, "host.log"), "a");
  const child = spawn(process.execPath, [options.hostBin], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AMO_STUDIO_DATA_DIR: options.dataDir,
      ...(options.uiDir ? { AMO_STUDIO_UI_DIR: options.uiDir } : {}),
      ...(options.port !== undefined ? { AMO_STUDIO_PORT: String(options.port) } : {}),
      ...(options.version ? { AMO_STUDIO_VERSION: options.version } : {}),
    },
    detached: !options.attached,
    stdio: ["ignore", log, log, "ipc"],
    windowsHide: true,
  });
  if (!options.attached) {
    child.unref();
    child.channel?.unref();
  }
  const refusal: { message: string | null } = { message: null };
  child.on("message", (msg) => {
    if (isStartFailed(msg)) refusal.message = msg.message;
  });

  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      // Exit code 3: another Host owns the data dir (started concurrently); use it.
      const other = current(options.dataDir);
      if (other && (await ping(other.url, other.token))) return { url: other.url, token: other.token, child: null, pid: other.pid };
      // Its message is sent before it exits, but may be read just after the exit is seen.
      for (let i = 0; i < 10 && refusal.message === null; i++) await new Promise((r) => setTimeout(r, 50));
      if (refusal.message !== null) throw new HostStartError(refusal.message, refusal.message);
      throw new HostStartError(`Host exited with code ${child.exitCode}; see ${join(options.dataDir, "host.log")}`);
    }
    const info = current(options.dataDir);
    if (info && info.pid === child.pid && (await ping(info.url, info.token))) return { url: info.url, token: info.token, child, pid: info.pid };
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new HostStartError("Host did not start in time");
}

export interface KeepAliveOptions {
  link: HostLinkOptions;
  current(): HostConnection;
  /** A new Host answers (same port and token, so the windows reconnect by themselves). */
  onRestarted(conn: HostConnection): void;
  log(line: string): void;
  intervalMs?: number;
  /** Missed answers in a row before the Host counts as gone (default 3). */
  misses?: number;
  /** How long one answer may take (default 5 s). */
  answerMs?: number;
  /** Tests: whether the Host's process still runs (default: by its pid in host.json). */
  isAlive?(): boolean;
  /** Restarts allowed within `windowMs`; past that the shell stops trying (something keeps killing it). */
  maxRestarts?: number;
  windowMs?: number;
  /**
   * The Host went quiet because it was asked to stop (POST /api/shutdown: the tray's 完全退出, or the platform's 重启
   * Studio, 2026-10-29): not started again; this is called instead, and the keepalive ends. Default check: host-exit.json
   * names the Host's pid (stoppedOnPurpose).
   */
  onStopped?(): void;
  stoppedOnPurpose?(conn: HostConnection): boolean;
}

/**
 * Keeps the Host running: when it stops answering several times in a row and its process is gone (it crashed or was
 * killed), starts it again on the same port. Codex app-servers outlive the Host and are adopted again, so their
 * sessions keep going. A Host whose process still runs is only busy: it is logged, never replaced (2026-10-27: a busy
 * one was restarted 30 s after a start, cutting the sessions it was resuming). Returns stop().
 */
export function keepHostAlive(options: KeepAliveOptions): () => void {
  const every = options.intervalMs ?? 3000;
  const needed = options.misses ?? 3;
  const answerMs = options.answerMs ?? 5000;
  const isAlive = options.isAlive ?? (() => {
    const pid = current(options.link.dataDir)?.pid;
    return typeof pid === "number" && alive(pid);
  });
  let busySince: number | null = null;
  const max = options.maxRestarts ?? 5;
  const windowMs = options.windowMs ?? 10 * 60_000;
  const restarts: number[] = [];
  let misses = 0;
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const conn = options.current();
      if (await ping(conn.url, conn.token, answerMs)) {
        if (busySince !== null) options.log(`Host answers again after ${Math.round((Date.now() - busySince) / 1000)} s`);
        busySince = null;
        misses = 0;
        return;
      }
      // Asked to stop: at the first missed answer, without waiting for more.
      if (options.onStopped && (options.stoppedOnPurpose ?? ((c) => stoppedOnPurpose(options.link.dataDir, c.pid)))(conn)) {
        stopped = true;
        clearInterval(timer);
        options.log("Host was asked to stop (host-exit.json); not starting it again");
        options.onStopped();
        return;
      }
      if (++misses < needed || stopped) return;
      if (isAlive()) {
        if (busySince === null) {
          busySince = Date.now();
          options.log(`Host has not answered ${misses} times in a row but its process runs: busy, left alone`);
        }
        return;
      }
      const now = Date.now();
      while (restarts.length && now - restarts[0]! > windowMs) restarts.shift();
      if (restarts.length >= max) {
        if (restarts.length === max) options.log(`Host stopped ${max} times in ${Math.round(windowMs / 60_000)} minutes; not restarting it again`);
        restarts.push(now);
        return;
      }
      restarts.push(now);
      options.log(`Host is not answering and its process is gone; starting it again`);
      const port = Number(new URL(conn.url).port);
      const next = await connectHost({ ...options.link, ...(port ? { port } : {}) });
      misses = 0;
      busySince = null;
      options.log("Host started again");
      if (!stopped) options.onRestarted(next);
    } catch (err) {
      options.log(`restarting the Host failed: ${String(err)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), every);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Whether the Host with this pid was asked to stop: POST /api/shutdown wrote host-exit.json naming it (a crash does not). */
export function stoppedOnPurpose(dataDir: string, pid: number | undefined): boolean {
  if (!pid) return false;
  return readJson<{ pid?: unknown }>(join(dataDir, "host-exit.json"))?.pid === pid;
}

export type ShutdownAnswer =
  | { ok: true; running: number }
  /** Sessions are at work and `interrupt` was not given. */
  | { ok: false; reason: "running"; running: number }
  /** A Host from before 2026-10-29: it has no such route. */
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "failed"; message: string };

/** POST /api/shutdown (完全退出): `interrupt` only after the person agreed to cut the sessions at work. */
export async function requestShutdown(conn: HostConnection, interrupt: boolean, timeoutMs = 5000): Promise<ShutdownAnswer> {
  try {
    const res = await fetch(`${conn.url}/api/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
      body: JSON.stringify(interrupt ? { interrupt: true } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { running?: unknown; error?: { message?: unknown } } | null;
    const running = typeof body?.running === "number" ? body.running : 0;
    if (res.ok) return { ok: true, running };
    if (res.status === 409 && running > 0) return { ok: false, reason: "running", running };
    if (res.status === 404) return { ok: false, reason: "unsupported" };
    return { ok: false, reason: "failed", message: typeof body?.error?.message === "string" ? body.error.message : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Waits until the process ends; false when it still runs after `timeoutMs`. */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  for (const until = Date.now() + timeoutMs; Date.now() < until; ) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return !alive(pid);
}

/** Asks a Host started by this shell to stop (tests, or an explicit "quit Studio"). */
export function stopHost(conn: HostConnection): Promise<void> {
  const child = conn.child;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.send?.("shutdown");
  });
}
