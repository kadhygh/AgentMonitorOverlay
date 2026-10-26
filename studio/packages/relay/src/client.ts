import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Health, Member, Message, NewMessage, NewRequest, Thread, ThreadView } from "./protocol.js";

// A relay client for Node (the MCP, the command line; the tray program later), and this machine's relay settings:
// which service, and who I am there. The settings file is the person's, shared by everything on the machine, so an
// AI's MCP speaks as the person who set it up.

export interface RelaySettings {
  /** The service, e.g. http://192.168.1.20:47120 */
  server: string;
  name: string;
  key: string;
}

/** %APPDATA%\AMO Relay (AMO_RELAY_HOME overrides, for tests and a second identity on one machine). */
export function relayHome(): string {
  if (process.env.AMO_RELAY_HOME) return process.env.AMO_RELAY_HOME;
  const appData = process.env.APPDATA ?? (process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".config"));
  return join(appData, "AMO Relay");
}

export const settingsPath = (home = relayHome()) => join(home, "settings.json");

export function readSettings(home = relayHome()): RelaySettings | null {
  const path = settingsPath(home);
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<RelaySettings>;
    return s.server && s.name && s.key ? { server: s.server, name: s.name, key: s.key } : null;
  } catch {
    return null;
  }
}

export function writeSettings(settings: RelaySettings, home = relayHome()): void {
  const path = settingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export class RelayClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const normalizeServer = (server: string) => {
  const s = server.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : `http://${s}`;
};

export class RelayClient {
  readonly server: string;

  constructor(
    server: string,
    readonly key: string | null = null,
  ) {
    this.server = normalizeServer(server);
  }

  static fromSettings(s: RelaySettings): RelayClient {
    return new RelayClient(s.server, s.key);
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${this.server}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new RelayClientError(0, "unreachable", `连不上中转服务 ${this.server}：${err instanceof Error ? err.message : String(err)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new RelayClientError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`);
    return data as T;
  }

  health(): Promise<Health> {
    return this.call("GET", "/api/health");
  }
  join(name: string, passphrase: string, role = ""): Promise<{ name: string; role: string; key: string }> {
    return this.call("POST", "/api/join", { name, passphrase, role });
  }
  me(): Promise<{ name: string; service: string; role: string }> {
    return this.call("GET", "/api/me");
  }
  setRole(role: string): Promise<{ ok: true }> {
    return this.call("PATCH", "/api/me", { role });
  }
  async members(): Promise<Member[]> {
    return (await this.call<{ members: Member[] }>("GET", "/api/members")).members;
  }
  async threads(): Promise<ThreadView[]> {
    return (await this.call<{ threads: ThreadView[] }>("GET", "/api/threads")).threads;
  }
  async direct(other: string): Promise<Thread> {
    return (await this.call<{ thread: Thread }>("POST", "/api/threads/direct", { with: other })).thread;
  }
  ask(req: NewRequest): Promise<{ thread: Thread; message: Message }> {
    return this.call("POST", "/api/requests", req);
  }
  send(threadId: string, msg: NewMessage): Promise<{ thread: Thread; message: Message }> {
    return this.call("POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, msg);
  }
  messages(threadId: string, after = 0): Promise<{ thread: Thread; messages: Message[] }> {
    return this.call("GET", `/api/threads/${encodeURIComponent(threadId)}/messages?after=${after}`);
  }
  read(threadId: string, seq?: number): Promise<{ readSeq: number }> {
    return this.call("POST", `/api/threads/${encodeURIComponent(threadId)}/read`, seq === undefined ? {} : { seq });
  }
  /** Messages from others after `after` (in one thread, or any of mine); waits up to `timeoutMs` for the first. */
  async wait(opts: { threadId?: string; after?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Message[]> {
    const q = new URLSearchParams({ after: String(opts.after ?? 0), timeout: String(opts.timeoutMs ?? 60_000) });
    if (opts.threadId) q.set("thread", opts.threadId);
    return (await this.call<{ messages: Message[] }>("GET", `/api/wait?${q}`, undefined, opts.signal)).messages;
  }
}
