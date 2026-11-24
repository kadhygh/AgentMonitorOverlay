import type { Issue, IssueBuildReport, IssueImage, IssueList, IssueRelease, IssuePatch, NewIssue, NewIssueEntry } from "./issues-protocol.js";
import type { NewTransfer, RelayDevice, Transfer, TransferFile } from "./transfer-protocol.js";
import type {
  AgentReport,
  BoardLock,
  BoardOp,
  BoardOpRecord,
  BoardOpsResult,
  BoardPresence,
  BoardSnapshot,
  Cowork,
  CoworkAgent,
  CoworkAskResult,
  CoworkDelivery,
  CoworkDetail,
  CoworkDraft,
  CoworkEvent,
  CoworkGoalVersion,
  CoworkInbox,
  CoworkListItem,
  CoworkPatch,
  CoworkPost,
  CoworkPostResult,
  DraftDecision,
  NewCowork,
  NewCoworkEvent,
  NewCoworkSession,
  AgentRole,
  CoworkMarkRequest,
  CoworkMarkResult,
  CoworkMatterPatch,
  CoworkMatterResult,
  CoworkMessageRewrite,
  CoworkPending,
  CoworkPendingQuery,
  Matter,
  NewCoworkMatter,
} from "./cowork-protocol.js";
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
  /** `tellAi` with `take` (已接手): the note goes to the asking AI. */
  session(threadId: string, action: SessionAction, opts: { note?: string; via?: Via; tellAi?: boolean } = {}): Promise<{ thread: Thread; message: Message }> {
    return this.call("POST", `/api/threads/${encodeURIComponent(threadId)}/session`, { action, ...opts });
  }
  read(threadId: string, seq?: number): Promise<{ readSeq: number }> {
    return this.call("POST", `/api/threads/${encodeURIComponent(threadId)}/read`, seq === undefined ? {} : { seq });
  }
  // ---- files and notes (stages 2c, 2d)
  /** Uploads into a task or a session; the same name there makes a new version. */
  async upload(where: { taskId?: string; threadId?: string; slot?: "flow" }, name: string, data: Blob | ArrayBuffer | Uint8Array, type = "", opts: { ai?: boolean } = {}): Promise<RelayFile> {
    const q = new URLSearchParams({ name });
    if (where.taskId) q.set("task", where.taskId);
    if (where.threadId) q.set("thread", where.threadId);
    if (where.slot) q.set("slot", where.slot);
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
  /**
   * A file's bytes, read no further than `maxBytes` (2026-11-12, relay_file_download: an AI saving an attachment never
   * takes in more than the limit, whatever the service sends).
   */
  async fileBytes(fileId: string, maxBytes: number): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await fetch(this.fileUrl(fileId), { headers: this.key ? { authorization: `Bearer ${this.key}` } : {} });
    } catch (err) {
      throw new RelayClientError(0, "unreachable", `连不上中转服务 ${this.server}：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new RelayClientError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`);
    }
    const tooLarge = () => new RelayClientError(413, "too_large", `文件超过 ${maxBytes} 字节的上限，没有下载`);
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
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
  // ---- 问题页 (2026-10-31, plans/issues.md): Studio's issue tools read and answer them as the person.
  issues(after?: number): Promise<IssueList> {
    return this.call("GET", `/api/issues${after ? `?after=${after}` : ""}`);
  }
  async issue(number: number): Promise<Issue> {
    return (await this.call<{ issue: Issue }>("GET", `/api/issues/${number}`)).issue;
  }
  async createIssue(n: NewIssue): Promise<Issue> {
    return (await this.call<{ issue: Issue }>("POST", "/api/issues", n)).issue;
  }
  async addIssueEntry(number: number, e: NewIssueEntry): Promise<Issue> {
    return (await this.call<{ issue: Issue }>("POST", `/api/issues/${number}/entries`, e)).issue;
  }
  async updateIssue(number: number, patch: IssuePatch & { ai?: boolean }): Promise<Issue> {
    return (await this.call<{ issue: Issue }>("PATCH", `/api/issues/${number}`, patch)).issue;
  }
  /** 发布打包 (on=false takes it back). */
  async requestIssueRelease(on = true): Promise<IssueRelease> {
    return (await this.call<{ release: IssueRelease }>("POST", "/api/issues/release", { on })).release;
  }
  issueReleased(version: string, numbers: number[]): Promise<IssueList> {
    return this.call("POST", "/api/issues/release/done", { version, numbers });
  }
  /** Where a test build is (npm run release): start, a step, the end. */
  async reportIssueBuild(report: IssueBuildReport): Promise<IssueRelease> {
    return (await this.call<{ release: IssueRelease }>("POST", "/api/issues/release/build", report)).release;
  }
  /** A screenshot for an issue entry (pictures only). */
  async uploadIssueImage(name: string, data: Blob | ArrayBuffer | Uint8Array, type: string): Promise<IssueImage> {
    const headers: Record<string, string> = { "content-type": type };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    let res: Response;
    try {
      res = await fetch(`${this.server}/api/issues/images?${new URLSearchParams({ name, type })}`, { method: "POST", headers, body: data as unknown as RequestInit["body"] });
    } catch (err) {
      throw new RelayClientError(0, "unreachable", `连不上中转服务 ${this.server}：${err instanceof Error ? err.message : String(err)}`);
    }
    const out = (await res.json().catch(() => ({}))) as { image?: IssueImage; error?: string; message?: string };
    if (!res.ok || !out.image) throw new RelayClientError(res.status, out.error ?? "error", out.message ?? `HTTP ${res.status}`);
    return out.image;
  }
  async issueImageData(id: string): Promise<Uint8Array> {
    const res = await fetch(`${this.server}/api/issues/images/${encodeURIComponent(id)}`, { headers: this.key ? { authorization: `Bearer ${this.key}` } : {} });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new RelayClientError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async wait(opts: { threadId?: string; after?: number; timeoutMs?: number; signal?: AbortSignal; ai?: boolean }): Promise<Message[]> {
    const q = new URLSearchParams({ after: String(opts.after ?? 0), timeout: String(opts.timeoutMs ?? 60_000) });
    if (opts.threadId) q.set("thread", opts.threadId);
    if (opts.ai) q.set("via", "ai");
    return (await this.call<{ messages: Message[] }>("GET", `/api/wait?${q}`, undefined, opts.signal)).messages;
  }
  // ---- 传文件 (2026-11-23, transfer-protocol.ts)
  async transferDevices(): Promise<RelayDevice[]> {
    return (await this.call<{ devices: RelayDevice[] }>("GET", "/api/transfer-devices")).devices;
  }
  async transfers(): Promise<Transfer[]> {
    return (await this.call<{ transfers: Transfer[] }>("GET", "/api/transfers")).transfers;
  }
  async transfer(id: string): Promise<Transfer> {
    return (await this.call<{ transfer: Transfer }>("GET", `/api/transfers/${encodeURIComponent(id)}`)).transfer;
  }
  async createTransfer(t: NewTransfer): Promise<Transfer> {
    return (await this.call<{ transfer: Transfer }>("POST", "/api/transfers", t)).transfer;
  }
  async answerTransfer(id: string, device: string, accept: boolean): Promise<Transfer> {
    return (await this.call<{ transfer: Transfer }>("POST", `/api/transfers/${encodeURIComponent(id)}/answer`, { device, accept })).transfer;
  }
  async transferProgress(id: string, device: string, got: number, done = false): Promise<Transfer> {
    return (await this.call<{ transfer: Transfer }>("POST", `/api/transfers/${encodeURIComponent(id)}/progress`, { device, got, done })).transfer;
  }
  async cancelTransfer(id: string): Promise<Transfer> {
    return (await this.call<{ transfer: Transfer }>("POST", `/api/transfers/${encodeURIComponent(id)}/cancel`, {})).transfer;
  }
  /** A piece of a file, at the offset the service is at; `sha256` is the whole file's. */
  async putTransferPiece(id: string, index: number, q: { device: string; offset: number; sha256: string }, data: Uint8Array, signal?: AbortSignal): Promise<TransferFile> {
    const headers: Record<string, string> = { "content-type": "application/octet-stream" };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    const query = new URLSearchParams({ device: q.device, offset: String(q.offset), sha256: q.sha256 });
    let res: Response;
    try {
      res = await fetch(`${this.server}/api/transfers/${encodeURIComponent(id)}/files/${index}?${query}`, { method: "PUT", headers, body: data as unknown as RequestInit["body"], signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new RelayClientError(0, "unreachable", `连不上中转服务 ${this.server}：${err instanceof Error ? err.message : String(err)}`);
    }
    const out = (await res.json().catch(() => ({}))) as { file?: TransferFile; error?: string; message?: string };
    if (!res.ok || !out.file) throw new RelayClientError(res.status, out.error ?? "error", out.message ?? `HTTP ${res.status}`);
    return out.file;
  }
  /** Bytes start..end (inclusive) of a complete file, for a device of mine that accepted the send. */
  async transferPiece(id: string, index: number, device: string, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    const headers: Record<string, string> = { range: `bytes=${start}-${end}` };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    let res: Response;
    try {
      res = await fetch(`${this.server}/api/transfers/${encodeURIComponent(id)}/files/${index}?device=${encodeURIComponent(device)}`, { headers, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new RelayClientError(0, "unreachable", `连不上中转服务 ${this.server}：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new RelayClientError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---- 协作 (2026-11-23, cowork-protocol.ts). Every call needs me in the cowork. An agent's call (Studio's cowork_* tools)
  // passes `via: { kind: "ai", conv: <its mark> }`; the mark must be one of my agents in that cowork.

  /** The coworks I am in, latest first, with what I have not read of their 群聊. */
  async coworks(): Promise<CoworkListItem[]> {
    return (await this.call<{ coworks: CoworkListItem[] }>("GET", "/api/cowork")).coworks;
  }
  /** 发起协作: title, goal, repository and branch, the people to bring in, options (「AI 发起 @ 和提问」 off by default). */
  async createCowork(n: NewCowork): Promise<Cowork> {
    return (await this.call<{ cowork: Cowork }>("POST", "/api/cowork", n)).cowork;
  }
  /** The cowork with its latest events (已定的事 = kind "decision"), deliveries (每条消息的去向) and my agents' drafts. */
  cowork(id: string): Promise<CoworkDetail> {
    return this.call("GET", `/api/cowork/${encodeURIComponent(id)}`);
  }
  /** 改标题、目标（留历史）、仓库分支、选项；`ended: true` 结束，`false` 重新打开. */
  async updateCowork(id: string, patch: CoworkPatch): Promise<Cowork> {
    return (await this.call<{ cowork: Cowork }>("PATCH", `/api/cowork/${encodeURIComponent(id)}`, patch)).cowork;
  }
  /** Every version of the goal, oldest first. */
  async coworkGoals(id: string): Promise<CoworkGoalVersion[]> {
    return (await this.call<{ goals: CoworkGoalVersion[] }>("GET", `/api/cowork/${encodeURIComponent(id)}/goals`)).goals;
  }
  async coworkEvents(id: string, after = 0): Promise<CoworkEvent[]> {
    return (await this.call<{ events: CoworkEvent[] }>("GET", `/api/cowork/${encodeURIComponent(id)}/events?after=${after}`)).events;
  }
  /** Records a commit pushed (its files mark board cards citing an older commit of them 已过时) or a note (cowork_note). */
  addCoworkEvent(id: string, e: NewCoworkEvent): Promise<{ event: CoworkEvent; board: BoardOpsResult | null }> {
    return this.call("POST", `/api/cowork/${encodeURIComponent(id)}/events`, e);
  }
  /** 拉人 (into the 群聊 and every 子会话; they see what came before). */
  async addCoworkMembers(id: string, names: string[]): Promise<Cowork> {
    return (await this.call<{ cowork: Cowork }>("POST", `/api/cowork/${encodeURIComponent(id)}/members`, { add: names })).cowork;
  }
  /** 退出 (my agents in it leave too). */
  async leaveCowork(id: string): Promise<void> {
    await this.call("POST", `/api/cowork/${encodeURIComponent(id)}/leave`, {});
  }
  /**
   * 拉进协作: one of my sessions by its mark (`studio:<设备号>:<会话 id>`), shown as 「<me> 的 AI · <label>」 — as my side's
   * 主控 (the default; one per side, a second is refused saying who holds it) or an 执行 of one 事项 (`matter`).
   */
  joinCoworkAgent(id: string, mark: string, label: string, role?: { role: AgentRole; matter?: string }): Promise<{ cowork: Cowork; agent: CoworkAgent }> {
    return this.call("POST", `/api/cowork/${encodeURIComponent(id)}/agents`, { mark, label, ...(role ?? {}) });
  }
  /** 改角色: my agent becomes 主控 or an 执行 of a 事项 (in person, or through my side's 主控 with `via`). */
  setCoworkAgentRole(id: string, mark: string, role: AgentRole, matter?: string | null, via?: Via): Promise<{ cowork: Cowork; agent: CoworkAgent }> {
    return this.call("POST", `/api/cowork/${encodeURIComponent(id)}/agents/role`, { mark, role, matter, via });
  }
  async leaveCoworkAgent(id: string, mark: string): Promise<Cowork> {
    return (await this.call<{ cowork: Cowork }>("POST", `/api/cowork/${encodeURIComponent(id)}/agents/leave`, { mark })).cowork;
  }
  /**
   * Studio: how my agents are (待命 idle / 处理中 busy / 等主人 owner; offline when Studio closes). Send it at least every
   * AGENT_REPORT_MS and whenever one changes; no report for AGENT_STALE_MS shows them 不在线.
   */
  async reportCoworkAgents(agents: AgentReport[]): Promise<Array<{ coworkId: string; agent: CoworkAgent }>> {
    return (await this.call<{ agents: Array<{ coworkId: string; agent: CoworkAgent }> }>("POST", "/api/cowork/agents/status", { agents })).agents;
  }
  /**
   * Studio: the deliveries queued for my agents whose marks start with `prefix` (this Studio's `studio:<设备号>:`), and
   * what they have not read. `waitMs`: when nothing is queued, wait (at most COWORK_INBOX_MAX_WAIT) until something is.
   * Then ackCowork the ones put into their sessions.
   */
  coworkInbox(prefix: string, opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<CoworkInbox> {
    const q = new URLSearchParams({ prefix });
    if (opts.waitMs) q.set("wait", String(opts.waitMs));
    return this.call("GET", `/api/cowork-inbox?${q}`, undefined, opts.signal);
  }
  /** Studio put these deliveries into their sessions: 已送达. */
  async ackCowork(ids: string[]): Promise<CoworkDelivery[]> {
    return (await this.call<{ deliveries: CoworkDelivery[] }>("POST", "/api/cowork-inbox/ack", { ids })).deliveries;
  }
  /**
   * Messages of the 群聊 and its 子会话 after `after` (an agent's cowork_read). With `agent` (my agent's mark): it has read
   * them, so the inbox's unread count starts from there.
   */
  coworkFeed(id: string, after = 0, agent?: string): Promise<{ messages: Message[]; lastSeq: number }> {
    const q = new URLSearchParams({ after: String(after) });
    if (agent) q.set("agent", agent);
    return this.call("GET", `/api/cowork/${encodeURIComponent(id)}/feed?${q}`);
  }
  /**
   * A message in the 群聊, or (threadId) in one of its 子会话: `agentMentions` @-s agents (each gets a delivery), `replyTo`
   * quotes what it answers. An agent's message @-ing anyone comes back as `{ draft }` while 「AI 发起 @ 和提问」 is off.
   * (The thread's own send() does the same for these threads.)
   */
  postCowork(id: string, p: CoworkPost & { threadId?: string }): Promise<CoworkPostResult> {
    return this.call("POST", `/api/cowork/${encodeURIComponent(id)}/messages`, p);
  }
  /** A new 子会话 asked of a person in the cowork (its card goes into the 群聊); an agent's is a draft while the option is off. */
  askCowork(id: string, n: NewCoworkSession): Promise<CoworkAskResult> {
    return this.call("POST", `/api/cowork/${encodeURIComponent(id)}/sessions`, n);
  }
  /** 定下结论: the 子会话 is done, its conclusion goes into 已定的事. Its asker or the person asked (or their agents). */
  concludeCowork(id: string, threadId: string, conclusion: string, via?: Via): Promise<{ thread: Thread; event: CoworkEvent }> {
    return this.call("POST", `/api/cowork/${encodeURIComponent(id)}/sessions/${encodeURIComponent(threadId)}/conclude`, { conclusion, via });
  }
  /** My agents' drafts waiting for me. */
  async coworkDrafts(id: string): Promise<CoworkDraft[]> {
    return (await this.call<{ drafts: CoworkDraft[] }>("GET", `/api/cowork/${encodeURIComponent(id)}/drafts`)).drafts;
  }
  /** 发出 / 改一下再发 (`edit`) / 不发 — the owner, in person. */
  async decideCoworkDraft(id: string, draftId: string, d: DraftDecision): Promise<CoworkDraft> {
    return (await this.call<{ draft: CoworkDraft }>("POST", `/api/cowork/${encodeURIComponent(id)}/drafts/${encodeURIComponent(draftId)}`, d)).draft;
  }
  /** The board: operations after `after`, or every card (after 0, or too far back); with the text locks now. Read for my
   * agent (`agent`, its mark): an 执行 gets its 事项's card only. */
  coworkBoard(id: string, after = 0, agent?: string): Promise<BoardSnapshot> {
    return this.call("GET", `/api/cowork/${encodeURIComponent(id)}/board?after=${after}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`);
  }

  // ---- 事项、回执、待我处理 (2026-11-24, cowork-protocol.ts「事项」)

  /** 开事项 (a 主控 or a person): its thread, first message and card in the 群聊; a card on the board in its side's group. */
  openMatter(id: string, n: NewCoworkMatter): Promise<CoworkMatterResult> {
    return this.call("POST", `/api/cowork/${encodeURIComponent(id)}/matters`, n);
  }
  /** 改事项 (a 主控 or a person): `base` is the version read; an older one is refused (409). */
  async patchMatter(id: string, matterId: string, patch: CoworkMatterPatch): Promise<Matter> {
    return (await this.call<{ matter: Matter }>("PATCH", `/api/cowork/${encodeURIComponent(id)}/matters/${encodeURIComponent(matterId)}`, patch)).matter;
  }
  /** 看过 / 处理了: by seq, or a 事项's messages up to `upTo`. */
  markCowork(id: string, m: CoworkMarkRequest): Promise<CoworkMarkResult> {
    return this.call("POST", `/api/cowork/${encodeURIComponent(id)}/marks`, m);
  }
  /** 原地改 my message while nobody has seen it (409 after: post a new one with `supersedes`). */
  async rewriteCoworkMessage(id: string, seq: number, r: CoworkMessageRewrite): Promise<Message> {
    return (await this.call<{ message: Message }>("PATCH", `/api/cowork/${encodeURIComponent(id)}/messages/${seq}`, r)).message;
  }
  /** 撤回 my message while nobody has seen it. */
  async withdrawCoworkMessage(id: string, seq: number, via?: Via): Promise<Message> {
    return (await this.call<{ message: Message }>("POST", `/api/cowork/${encodeURIComponent(id)}/messages/${seq}/withdraw`, { via })).message;
  }
  /**
   * 待我处理: mine, or my agent's (`party: agent:<mark>`), in one cowork or all. `since` (the `version` I have) with `waitMs`:
   * wait until it changes. What an agent's list holds counts as 送到 for it.
   */
  coworkPending(q: CoworkPendingQuery = {}, opts: { signal?: AbortSignal } = {}): Promise<CoworkPending> {
    const p = new URLSearchParams();
    if (q.coworkId) p.set("coworkId", q.coworkId);
    if (q.party) p.set("party", q.party);
    if (q.since !== undefined) p.set("since", String(q.since));
    if (q.wait) p.set("wait", String(q.wait));
    return this.call("GET", `/api/cowork/pending?${p}`, undefined, opts.signal);
  }
  /** Operations in order (cowork-protocol.ts BoardOp); each with an opId so a repeat after a break does nothing twice. */
  coworkBoardOps(id: string, ops: BoardOp[], via?: Via): Promise<BoardOpsResult> {
    return this.call("POST", `/api/cowork/${encodeURIComponent(id)}/board/ops`, { ops, via });
  }
  /** I start (or go on, every few seconds while typing) writing a card's text, or stop (`on: false`). 409 when someone else is. */
  async coworkBoardLock(id: string, card: string, on: boolean): Promise<BoardLock | null> {
    return (await this.call<{ lock: BoardLock | null }>("POST", `/api/cowork/${encodeURIComponent(id)}/board/lock`, { card, on })).lock;
  }
  /** What I show on the open board (also as a /ws frame, CoworkClientFrame); `open: false` when I close it. */
  async coworkBoardPresence(id: string, p: { selected?: string[]; dragging?: { id: string; x: number; y: number } | null; open?: boolean }): Promise<BoardPresence[]> {
    return (await this.call<{ presence: BoardPresence[] }>("POST", `/api/cowork/${encodeURIComponent(id)}/board/presence`, p)).presence;
  }
  /** A card's history, newest first. */
  async coworkBoardHistory(id: string, card: string): Promise<BoardOpRecord[]> {
    return (await this.call<{ ops: BoardOpRecord[] }>("GET", `/api/cowork/${encodeURIComponent(id)}/board/history?card=${encodeURIComponent(card)}`)).ops;
  }
}
