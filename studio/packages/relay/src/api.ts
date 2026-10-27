import type { FileNote, Health, Member, Message, NewMessage, NewRequest, NewTask, RelayFile, SessionAction, Task, TaskEvent, TaskStatus, TaskView, TeamSettings, Thread, ThreadView, Via } from "./protocol.js";

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
  /** 编辑资料: nickname, picture (data: URL, null to remove), what I do. */
  setProfile(p: { nick?: string; avatar?: string | null; role?: string }): Promise<{ ok: true }> {
    return this.call("PATCH", "/api/me", p);
  }
  /** @-ing people into a chat: a direct chat or topic becomes a group. */
  async addMembers(threadId: string, names: string[]): Promise<Thread> {
    return (await this.call<{ thread: Thread }>("POST", `/api/threads/${encodeURIComponent(threadId)}/members`, { add: names })).thread;
  }
  async leave(threadId: string): Promise<void> {
    await this.call("POST", `/api/threads/${encodeURIComponent(threadId)}/leave`, {});
  }
  async rename(threadId: string, title: string): Promise<Thread> {
    return (await this.call<{ thread: Thread }>("PATCH", `/api/threads/${encodeURIComponent(threadId)}`, { title })).thread;
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
  // ---- files and notes (stages 2c, 2d)
  /** Uploads into a task or a session; the same name there makes a new version. */
  async upload(where: { taskId?: string; threadId?: string }, name: string, data: Blob | ArrayBuffer | Uint8Array, type = "", opts: { ai?: boolean } = {}): Promise<RelayFile> {
    const q = new URLSearchParams({ name });
    if (where.taskId) q.set("task", where.taskId);
    if (where.threadId) q.set("thread", where.threadId);
    if (type) q.set("type", type);
    if (opts.ai) q.set("via", "ai");
    const headers: Record<string, string> = { "content-type": type || "application/octet-stream" };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    let res: Response;
    try {
      res = await fetch(`${this.server}/api/files?${q}`, { method: "POST", headers, body: data as unknown as RequestInit["body"] });
    } catch (err) {
      throw new RelayClientError(0, "unreachable", `连不上中转服务 ${this.server}：${err instanceof Error ? err.message : String(err)}`);
    }
    const out = (await res.json().catch(() => ({}))) as { file?: RelayFile; error?: string; message?: string };
    if (!res.ok || !out.file) throw new RelayClientError(res.status, out.error ?? "error", out.message ?? `HTTP ${res.status}`);
    return out.file;
  }
  async files(where: { taskId?: string; threadId?: string }): Promise<RelayFile[]> {
    const q = where.taskId ? `task=${encodeURIComponent(where.taskId)}` : `thread=${encodeURIComponent(where.threadId ?? "")}`;
    return (await this.call<{ files: RelayFile[] }>("GET", `/api/files?${q}`)).files;
  }
  async versions(fileId: string): Promise<RelayFile[]> {
    return (await this.call<{ files: RelayFile[] }>("GET", `/api/files/${encodeURIComponent(fileId)}/versions`)).files;
  }
  /** A file's bytes. */
  async fileData(fileId: string): Promise<Blob> {
    const res = await fetch(this.fileUrl(fileId), { headers: this.key ? { authorization: `Bearer ${this.key}` } : {} });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new RelayClientError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`);
    }
    return res.blob();
  }
  /** Where a file can be fetched or downloaded (the key rides along for a link). */
  fileUrl(fileId: string, opts: { download?: boolean; withKey?: boolean } = {}): string {
    const q = new URLSearchParams();
    if (opts.download) q.set("download", "1");
    if (opts.withKey && this.key) q.set("key", this.key);
    const qs = q.toString();
    return `${this.server}/api/files/${encodeURIComponent(fileId)}${qs ? `?${qs}` : ""}`;
  }
  async notes(fileId: string): Promise<FileNote[]> {
    return (await this.call<{ notes: FileNote[] }>("GET", `/api/files/${encodeURIComponent(fileId)}/notes`)).notes;
  }
  async addNote(fileId: string, n: { quote: string; prefix?: string; suffix?: string; body: string }): Promise<FileNote> {
    return (await this.call<{ note: FileNote }>("POST", `/api/files/${encodeURIComponent(fileId)}/notes`, n)).note;
  }
  async deleteNote(noteId: string): Promise<void> {
    await this.call("DELETE", `/api/notes/${encodeURIComponent(noteId)}`);
  }

  // ---- team tasks (stage 2b)
  async tasks(): Promise<TaskView[]> {
    return (await this.call<{ tasks: TaskView[] }>("GET", "/api/tasks")).tasks;
  }
  task(id: string): Promise<{ task: TaskView; events: TaskEvent[] }> {
    return this.call("GET", `/api/tasks/${encodeURIComponent(id)}`);
  }
  async createTask(t: NewTask): Promise<TaskView> {
    return (await this.call<{ task: TaskView }>("POST", "/api/tasks", t)).task;
  }
  async updateTask(id: string, patch: { title?: string; description?: string; status?: TaskStatus; via?: Via }): Promise<TaskView> {
    return (await this.call<{ task: TaskView }>("PATCH", `/api/tasks/${encodeURIComponent(id)}`, patch)).task;
  }
  /** 流转; from a session (threadId), that session is answered or closed too unless closeSession is false. */
  async transferTask(id: string, t: { to: string; status?: TaskStatus; reason?: string; threadId?: string; closeSession?: boolean; via?: Via }): Promise<TaskView> {
    return (await this.call<{ task: TaskView }>("POST", `/api/tasks/${encodeURIComponent(id)}/transfer`, t)).task;
  }
  async archiveTask(id: string, archived = true): Promise<Task> {
    return (await this.call<{ task: TaskView }>("POST", `/api/tasks/${encodeURIComponent(id)}/archive`, { archived })).task;
  }
  async seenTask(id: string): Promise<void> {
    await this.call("POST", `/api/tasks/${encodeURIComponent(id)}/seen`, {});
  }
  async settings(): Promise<TeamSettings> {
    return (await this.call<{ settings: TeamSettings }>("GET", "/api/settings")).settings;
  }
  async saveSettings(patch: Partial<TeamSettings>): Promise<TeamSettings> {
    return (await this.call<{ settings: TeamSettings }>("PUT", "/api/settings", patch)).settings;
  }

  /** Messages from others after `after` (in one thread, or any of mine); waits up to `timeoutMs` for the first. */
  async wait(opts: { threadId?: string; after?: number; timeoutMs?: number; signal?: AbortSignal; ai?: boolean }): Promise<Message[]> {
    const q = new URLSearchParams({ after: String(opts.after ?? 0), timeout: String(opts.timeoutMs ?? 60_000) });
    if (opts.threadId) q.set("thread", opts.threadId);
    if (opts.ai) q.set("via", "ai");
    return (await this.call<{ messages: Message[] }>("GET", `/api/wait?${q}`, undefined, opts.signal)).messages;
  }
}
