import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Finds a running Host for the data dir, or starts one with Electron's own Node (ELECTRON_RUN_AS_NODE).
// The Host is a resident process: in normal use it keeps running after the window closes so sessions continue.

export interface HostConnection {
  url: string;
  token: string;
  /** Present when this shell started the Host. */
  child: ChildProcess | null;
}

export interface HostLinkOptions {
  dataDir: string;
  hostBin: string;
  uiDir?: string;
  port?: number;
  /** Tests: keep the Host attached so it can be stopped with the app. */
  attached?: boolean;
  timeoutMs?: number;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function ping(url: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/state`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
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
  if (existing && (await ping(existing.url, existing.token))) return { url: existing.url, token: existing.token, child: null };

  const log = openSync(join(options.dataDir, "host.log"), "a");
  const child = spawn(process.execPath, [options.hostBin], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AMO_STUDIO_DATA_DIR: options.dataDir,
      ...(options.uiDir ? { AMO_STUDIO_UI_DIR: options.uiDir } : {}),
      ...(options.port !== undefined ? { AMO_STUDIO_PORT: String(options.port) } : {}),
    },
    detached: !options.attached,
    stdio: ["ignore", log, log, "ipc"],
    windowsHide: true,
  });
  if (!options.attached) {
    child.unref();
    child.channel?.unref();
  }

  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      // Exit code 3: another Host owns the data dir (started concurrently); use it.
      const other = current(options.dataDir);
      if (other && (await ping(other.url, other.token))) return { url: other.url, token: other.token, child: null };
      throw new Error(`Host exited with code ${child.exitCode}; see ${join(options.dataDir, "host.log")}`);
    }
    const info = current(options.dataDir);
    if (info && info.pid === child.pid && (await ping(info.url, info.token))) return { url: info.url, token: info.token, child };
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error("Host did not start in time");
}

export interface KeepAliveOptions {
  link: HostLinkOptions;
  current(): HostConnection;
  /** A new Host answers (same port and token, so the windows reconnect by themselves). */
  onRestarted(conn: HostConnection): void;
  log(line: string): void;
  intervalMs?: number;
  /** Restarts allowed within `windowMs`; past that the shell stops trying (something keeps killing it). */
  maxRestarts?: number;
  windowMs?: number;
}

/**
 * Keeps the Host running: when it stops answering twice in a row (it crashed or was killed), starts it again on the
 * same port. Codex app-servers outlive the Host and are adopted again, so their sessions keep going. Returns stop().
 */
export function keepHostAlive(options: KeepAliveOptions): () => void {
  const every = options.intervalMs ?? 3000;
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
      if (await ping(conn.url, conn.token)) {
        misses = 0;
        return;
      }
      if (++misses < 2 || stopped) return;
      const now = Date.now();
      while (restarts.length && now - restarts[0]! > windowMs) restarts.shift();
      if (restarts.length >= max) {
        if (restarts.length === max) options.log(`Host stopped ${max} times in ${Math.round(windowMs / 60_000)} minutes; not restarting it again`);
        restarts.push(now);
        return;
      }
      restarts.push(now);
      options.log("Host is not answering; starting it again");
      const port = Number(new URL(conn.url).port);
      const next = await connectHost({ ...options.link, ...(port ? { port } : {}) });
      misses = 0;
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
