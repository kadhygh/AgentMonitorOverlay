import type { Health, Member, Message, NewMessage, NewRequest, SessionAction, Thread, ThreadView, Via } from "./protocol.js";

// The relay's HTTP API as a class, with fetch only: the Node side (MCP, command line, desktop shell) and the client's
// pages in a browser use the same one.

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
  register(name: string, password: string, opts: { role?: string; passphrase?: string } = {}): Promise<{ name: string; role: string; key: string }> {
    return this.call("POST", "/api/register", { name, password, role: opts.role ?? "", passphrase: opts.passphrase });
  }
  login(name: string, password: string): Promise<{ name: string; role: string; key: string }> {
    return this.call("POST", "/api/login", { name, password });
  }
  logout(): Promise<{ ok: true }> {
    return this.call("POST", "/api/logout");
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

  /** Another chat with `other`, about one thing. */
  async topic(other: string, title: string): Promise<Thread> {
    return (await this.call<{ thread: Thread }>("POST", "/api/threads/topic", { with: other, title })).thread;
  }

  /** Archives a thread in my list (or brings it back with false). */
  async archive(threadId: string, archived = true): Promise<void> {
    await this.call("POST", `/api/threads/${encodeURIComponent(threadId)}/archive`, { archived });
  }
  ask(req: NewRequest): Promise<{ thread: Thread; message: Message }> {
    return this.call("POST", "/api/requests", req);
  }
  send(threadId: string, msg: NewMessage): Promise<{ thread: Thread; message: Message }> {
    return this.call("POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, msg);
  }
  /** `ai`: the asking side's AI reads it — a session that came back counts as fetched (「AI 已取回」). */
  messages(threadId: string, after = 0, opts: { ai?: boolean } = {}): Promise<{ thread: Thread; messages: Message[] }> {
    return this.call("GET", `/api/threads/${encodeURIComponent(threadId)}/messages?after=${after}${opts.ai ? "&via=ai" : ""}`);
  }
  /** 标记完成, 重新打开, 我来处理, 交还给 AI, or (an AI) handing it to its person. */
  session(threadId: string, action: SessionAction, opts: { note?: string; via?: Via } = {}): Promise<{ thread: Thread; message: Message }> {
    return this.call("POST", `/api/threads/${encodeURIComponent(threadId)}/session`, { action, ...opts });
  }
  read(threadId: string, seq?: number): Promise<{ readSeq: number }> {
    return this.call("POST", `/api/threads/${encodeURIComponent(threadId)}/read`, seq === undefined ? {} : { seq });
  }
  /** Messages from others after `after` (in one thread, or any of mine); waits up to `timeoutMs` for the first. */
  async wait(opts: { threadId?: string; after?: number; timeoutMs?: number; signal?: AbortSignal; ai?: boolean }): Promise<Message[]> {
    const q = new URLSearchParams({ after: String(opts.after ?? 0), timeout: String(opts.timeoutMs ?? 60_000) });
    if (opts.threadId) q.set("thread", opts.threadId);
    if (opts.ai) q.set("via", "ai");
    return (await this.call<{ messages: Message[] }>("GET", `/api/wait?${q}`, undefined, opts.signal)).messages;
  }
}
