import { EventEmitter } from "node:events";
import type { ApprovalDecision, HostEvent, Id, ModelProfile, Session, SessionItem, SessionStatus, Workspace } from "@amo-studio/protocol";
import { newId, type HostEventInput, type SessionItemInput, type Store } from "../../store/store.js";
import { codexThreadParams } from "../profiles.js";
import type { ServerNotification, ServerRequest } from "./rpc-client.js";
import type { CodexServerHandle } from "./server-manager.js";

// Drives Codex sessions through app-server and turns its events into Studio sessions and items.
// Behaviour follows studio/spikes/RESULTS.md: approvals are broadcast and first-answer-wins, forks must carry an explicit
// provider, parent/child links are only available when threads start, and subagent events arrive on the parent's
// connection.

/** What the runtime needs from the server manager; CodexServerManager satisfies it, tests can fake it. */
export interface CodexServers {
  ensure(profileId: string): Promise<CodexServerHandle>;
  on(event: "ready", listener: (handle: CodexServerHandle) => void): unknown;
}

export interface CodexRuntimeOptions {
  store: Store;
  servers: CodexServers;
  profiles: readonly ModelProfile[];
  now?: () => Date;
  /** Thread defaults for new sessions. */
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface CodexRuntimeEvents {
  /** Every change, already persisted (except `item.delta`, which carries the last persisted seq). */
  event: [HostEvent];
  log: [string];
}

interface SessionState {
  activeTurnId: string | null;
  /** codex item id -> our item id */
  items: Map<string, Id>;
  /** streaming text per codex agentMessage id */
  text: Map<string, string>;
}

interface PendingApproval {
  sessionId: Id;
  itemId: Id;
  profileId: string;
  requestId: ServerRequest["id"];
}

type ThreadLike = { id: string; forkedFromId?: string | null; parentThreadId?: string | null; modelProvider?: string };

const isApprovalMethod = (method: string) => method.endsWith("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval";

export class CodexRuntime extends EventEmitter<CodexRuntimeEvents> {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly state = new Map<Id, SessionState>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly attached = new WeakSet<CodexServerHandle["client"]>();

  constructor(private readonly options: CodexRuntimeOptions) {
    super();
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    options.servers.on("ready", (handle) => {
      this.attach(handle);
      void this.resubscribe(handle).catch((err: unknown) => this.emit("log", `resubscribe failed: ${String(err)}`));
    });
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  /** Creates a main session in a task and starts its Codex thread; sends `text` as the first turn when given. */
  async startSession(input: { taskId: Id; profileId: Id; workspace: Workspace; title?: string; text?: string }): Promise<Session> {
    const profile = this.profile(input.profileId);
    const handle = await this.handleFor(profile.id);
    const started = await handle.client.request("thread/start", {
      cwd: input.workspace.path,
      approvalPolicy: this.options.approvalPolicy ?? "on-request",
      sandbox: this.options.sandbox ?? "workspace-write",
      ...codexThreadParams(profile),
    } as never);
    const session = this.findByThread(started.thread.id) ?? this.createSession({
      taskId: input.taskId,
      parentId: null,
      kind: "main",
      profileId: profile.id,
      workspaceId: input.workspace.id,
      title: input.title ?? "",
      runtimeRef: started.thread.id,
    });
    if (input.text) await this.sendMessage(session.id, input.text);
    return this.store.getSession(session.id)!;
  }

  /** Starts a turn, or steers the running one. */
  async sendMessage(sessionId: Id, text: string): Promise<{ mode: "start" | "steer" }> {
    const session = this.writable(sessionId);
    const handle = await this.handleFor(session.profileId);
    const st = this.sessionState(sessionId);
    const input = [{ type: "text", text, text_elements: [] }];
    if (!session.title) this.updateSession(sessionId, { title: text.slice(0, 60) });
    if (st.activeTurnId) {
      await handle.client.request("turn/steer", { threadId: session.runtimeRef!, expectedTurnId: st.activeTurnId, input } as never);
      return { mode: "steer" };
    }
    // Status and the active turn come from turn/started and turn/completed: a short turn can finish before this
    // response arrives, so setting them here would leave the session stuck in "running".
    await handle.client.request("turn/start", { threadId: session.runtimeRef!, input } as never);
    return { mode: "start" };
  }

  async interrupt(sessionId: Id): Promise<void> {
    const session = this.requireSession(sessionId);
    const st = this.sessionState(sessionId);
    if (!st.activeTurnId || !session.runtimeRef) return;
    const handle = await this.handleFor(session.profileId);
    await handle.client.request("turn/interrupt", { threadId: session.runtimeRef, turnId: st.activeTurnId } as never);
  }

  /** Forks with an explicit provider so the fork never falls back to the server default. */
  async fork(sessionId: Id, profileId?: Id): Promise<Session> {
    const parent = this.requireSession(sessionId);
    if (!parent.runtimeRef) throw new Error(`session ${sessionId} has no thread yet`);
    const profile = this.profile(profileId ?? parent.profileId);
    const handle = await this.handleFor(parent.profileId);
    const r = await handle.client.request("thread/fork", { threadId: parent.runtimeRef, ...codexThreadParams(profile) } as never);
    // thread/started for the fork may already have created the session.
    return this.findByThread(r.thread.id) ?? this.adoptThread(r.thread, parent, "fork", parent.profileId);
  }

  /** Archives the session with its forks and subagents, and archives their threads. */
  async archive(sessionId: Id): Promise<Session[]> {
    const changed = this.store.archiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    for (const s of changed) {
      if (!s.runtimeRef || s.kind === "sub") continue;
      try {
        const handle = await this.handleFor(s.profileId);
        await handle.client.request("thread/archive", { threadId: s.runtimeRef } as never);
      } catch (err) {
        this.emit("log", `thread/archive failed for ${s.id}: ${String(err)}`);
      }
    }
    return changed;
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    const changed = this.store.unarchiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    for (const s of changed) {
      if (!s.runtimeRef || s.kind === "sub") continue;
      try {
        const handle = await this.handleFor(s.profileId);
        await handle.client.request("thread/unarchive", { threadId: s.runtimeRef } as never);
        await handle.client.request("thread/resume", { threadId: s.runtimeRef } as never);
      } catch (err) {
        this.emit("log", `thread/unarchive failed for ${s.id}: ${String(err)}`);
      }
    }
    return changed;
  }

  /** Answers a pending approval. Throws if it was already answered here or elsewhere. */
  async respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.approvals.get(approvalKey(sessionId, approvalId));
    if (!pending) throw new Error(`approval ${approvalId} is not pending`);
    const handle = await this.handleFor(pending.profileId);
    handle.client.respond(pending.requestId, { decision });
    this.approvals.delete(approvalKey(sessionId, approvalId));
    this.updateItem(pending.itemId, (item) => (item.type === "approval" ? { ...item, state: decision === "accept" ? "accepted" : "declined" } : item));
    if (this.sessionState(sessionId).activeTurnId) this.setStatus(sessionId, "running");
  }

  /** Where an attached terminal should connect. The token must only travel through an env var. */
  async attachInfo(sessionId: Id): Promise<{ url: string; token: string; threadId: string }> {
    const s = this.requireSession(sessionId);
    if (!s.runtimeRef) throw new Error(`session ${sessionId} has no thread yet`);
    const handle = await this.handleFor(s.profileId);
    // Make sure the thread is loaded on this server so `codex --remote … resume` finds it.
    await handle.client.request("thread/resume", { threadId: s.runtimeRef } as never).catch(() => undefined);
    return { url: handle.url, token: handle.token, threadId: s.runtimeRef };
  }

  /** Records who may write; used by terminal attach and reclaim. */
  setWriter(sessionId: Id, writer: Session["writer"]): Session {
    return this.updateSession(sessionId, { writer });
  }

  pendingApprovals(sessionId: Id): string[] {
    return [...this.approvals.values()].filter((a) => a.sessionId === sessionId).map((a) => String(a.requestId));
  }

  // ---- server events ----------------------------------------------------------------------------------------------

  private attach(handle: CodexServerHandle): void {
    if (this.attached.has(handle.client)) return;
    this.attached.add(handle.client);
    handle.client.on("notification", (n) => {
      try {
        this.onNotification(handle, n);
      } catch (err) {
        this.emit("log", `failed to handle ${n.method}: ${String(err)}`);
      }
    });
    handle.client.on("request", (r) => this.onServerRequest(handle, r));
  }

  /** After a (re)connect, subscribe again to every live thread served by this profile's server. */
  private async resubscribe(handle: CodexServerHandle): Promise<void> {
    for (const s of this.store.listSessions()) {
      if (s.profileId !== handle.profileId || !s.runtimeRef || s.archivedAt || s.kind === "sub") continue;
      try {
        await handle.client.request("thread/resume", { threadId: s.runtimeRef } as never);
      } catch (err) {
        this.emit("log", `thread/resume failed for ${s.id}: ${String(err)}`);
      }
    }
  }

  private onNotification(handle: CodexServerHandle, n: ServerNotification): void {
    switch (n.method) {
      case "thread/started":
        return this.onThreadStarted(handle, n.params.thread);
      case "turn/started": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        this.sessionState(s.id).activeTurnId = n.params.turn.id;
        this.setStatus(s.id, "running");
        return;
      }
      case "turn/completed": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.sessionState(s.id);
        if (st.activeTurnId === n.params.turn.id) st.activeTurnId = null;
        const turn = n.params.turn as { status: string; error?: { message: string } | null };
        if (turn.status === "failed") {
          this.appendItem(s.id, { type: "error", message: turn.error?.message ?? "turn failed" }, { method: n.method, turnId: n.params.turn.id });
          this.setStatus(s.id, "error");
        } else {
          this.setStatus(s.id, s.kind === "sub" ? "completed" : "idle");
        }
        return;
      }
      case "item/started":
      case "item/completed":
        return this.onItem(n.method, n.params.threadId, n.params.turnId, n.params.item as unknown as CodexItem);
      case "item/agentMessage/delta": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.sessionState(s.id);
        const itemId = this.ensureAgentItem(s.id, n.params.itemId, n.params.turnId);
        st.text.set(n.params.itemId, (st.text.get(n.params.itemId) ?? "") + n.params.delta);
        this.emitTransient({ type: "item.delta", sessionId: s.id, itemId, append: n.params.delta });
        return;
      }
      case "serverRequest/resolved": {
        for (const [key, a] of this.approvals) {
          if (a.profileId !== handle.profileId || String(a.requestId) !== String(n.params.requestId)) continue;
          this.approvals.delete(key);
          this.updateItem(a.itemId, (item) => (item.type === "approval" && item.state === "pending" ? { ...item, state: "resolved-elsewhere" } : item));
          if (this.sessionState(a.sessionId).activeTurnId) this.setStatus(a.sessionId, "running");
        }
        return;
      }
      case "error": {
        const s = this.findByThread(n.params.threadId);
        if (s && !n.params.willRetry) this.appendItem(s.id, { type: "error", message: n.params.error.message }, { method: n.method, turnId: n.params.turnId });
        return;
      }
      default:
        return;
    }
  }

  private onThreadStarted(handle: CodexServerHandle, thread: ThreadLike): void {
    if (this.findByThread(thread.id)) return;
    if (thread.forkedFromId) {
      const parent = this.findByThread(thread.forkedFromId);
      if (parent) this.adoptThread(thread, parent, "fork", handle.profileId);
    } else if (thread.parentThreadId) {
      const parent = this.findByThread(thread.parentThreadId);
      if (parent) this.adoptThread(thread, parent, "sub", handle.profileId);
    }
  }

  /** Records a fork or subagent thread as a child session, warns on provider drift, and follows its events. */
  private adoptThread(thread: ThreadLike, parent: Session, kind: "fork" | "sub", profileId: Id): Session {
    const existing = this.findByThread(thread.id);
    if (existing) return existing;
    const session = this.createSession({
      taskId: parent.taskId,
      parentId: parent.id,
      kind,
      profileId,
      workspaceId: parent.workspaceId,
      title: kind === "sub" ? "子 agent" : `${parent.title || "会话"} · 分支`,
      runtimeRef: thread.id,
    });
    const expected = this.profile(parent.profileId).provider;
    if (expected && thread.modelProvider && thread.modelProvider !== expected) {
      this.appendItem(session.id, {
        type: "notice",
        level: "warning",
        message: `这个${kind === "fork" ? "分支" : "子 agent"}用的模型提供方是 ${thread.modelProvider}，与父会话的 ${expected} 不一致。`,
      });
    }
    if (kind === "fork") {
      void this.handleFor(profileId)
        .then((h) => h.client.request("thread/resume", { threadId: thread.id } as never))
        .catch((err: unknown) => this.emit("log", `could not follow fork ${thread.id}: ${String(err)}`));
    }
    return session;
  }

  private onServerRequest(handle: CodexServerHandle, r: ServerRequest): void {
    if (!isApprovalMethod(r.method)) return;
    const params = r.params as { threadId?: string; turnId?: string; itemId?: string; command?: string | null; reason?: string | null; cwd?: string };
    const s = params.threadId ? this.findByThread(params.threadId) : undefined;
    if (!s) return;
    const key = approvalKey(s.id, String(r.id));
    if (this.approvals.has(key)) return; // replayed on resubscribe
    const kind = r.method.includes("fileChange") || r.method === "applyPatchApproval" ? "fileChange" : r.method.includes("permissions") ? "permissions" : "command";
    const item = this.appendItem(s.id, {
      type: "approval",
      approvalId: String(r.id),
      kind,
      summary: params.command ?? params.reason ?? r.method,
      detail: params.cwd,
      state: "pending",
    }, { method: r.method, itemId: params.itemId, turnId: params.turnId });
    this.approvals.set(key, { sessionId: s.id, itemId: item.id, profileId: handle.profileId, requestId: r.id });
    this.setStatus(s.id, "awaiting-approval");
  }

  private onItem(method: "item/started" | "item/completed", threadId: string, turnId: string, item: CodexItem): void {
    const s = this.findByThread(threadId);
    if (!s) return;
    const st = this.sessionState(s.id);
    const raw = { method, itemId: item.id, turnId };
    const done = method === "item/completed";
    switch (item.type) {
      case "userMessage": {
        if (!done) return;
        const text = (item.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
        this.appendItem(s.id, { type: "user", text }, raw);
        return;
      }
      case "agentMessage": {
        const itemId = this.ensureAgentItem(s.id, item.id, turnId);
        if (done) {
          this.updateItem(itemId, (it) => (it.type === "agent" ? { ...it, markdown: item.text ?? st.text.get(item.id) ?? "", streaming: false } : it));
          st.text.delete(item.id);
        }
        return;
      }
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "webSearch": {
        const tool = describeTool(item);
        const existing = st.items.get(item.id);
        if (!existing) {
          const created = this.appendItem(s.id, { type: "tool", ...tool }, raw);
          st.items.set(item.id, created.id);
        } else {
          this.updateItem(existing, (it) => (it.type === "tool" ? { ...it, ...tool } : it));
        }
        return;
      }
      case "subAgentActivity": {
        if (item.kind !== "started" || st.items.has(`sub:${item.agentThreadId}`)) return;
        const child = this.findByThread(item.agentThreadId!);
        if (!child) return;
        const created = this.appendItem(s.id, { type: "subagent", childSessionId: child.id, summary: item.agentPath ?? "子 agent" }, raw);
        st.items.set(`sub:${item.agentThreadId}`, created.id);
        return;
      }
      default:
        return;
    }
  }

  private ensureAgentItem(sessionId: Id, codexItemId: string, turnId: string): Id {
    const st = this.sessionState(sessionId);
    const known = st.items.get(codexItemId);
    if (known) return known;
    const created = this.appendItem(sessionId, { type: "agent", markdown: "", streaming: true }, { method: "item/started", itemId: codexItemId, turnId });
    st.items.set(codexItemId, created.id);
    return created.id;
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  private async handleFor(profileId: Id): Promise<CodexServerHandle> {
    const handle = await this.options.servers.ensure(profileId);
    this.attach(handle);
    return handle;
  }

  private profile(id: Id): ModelProfile {
    const p = this.options.profiles.find((x) => x.id === id);
    if (!p || p.runtime !== "codex") throw new Error(`unknown Codex profile ${id}`);
    return p;
  }

  private requireSession(id: Id): Session {
    const s = this.store.getSession(id);
    if (!s) throw new Error(`session ${id} not found`);
    return s;
  }

  private writable(id: Id): Session {
    const s = this.requireSession(id);
    if (s.writer === "archived" || s.writer === "terminal-handoff") throw Object.assign(new Error(`session ${id} is read-only (${s.writer})`), { code: "read_only" });
    if (!s.runtimeRef) throw new Error(`session ${id} has no thread yet`);
    return s;
  }

  private findByThread(threadId: string): Session | undefined {
    return this.store.findSessionByRuntimeRef("codex", threadId);
  }

  private sessionState(id: Id): SessionState {
    let st = this.state.get(id);
    if (!st) {
      st = { activeTurnId: null, items: new Map(), text: new Map() };
      this.state.set(id, st);
    }
    return st;
  }

  private createSession(input: { taskId: Id; parentId: Id | null; kind: Session["kind"]; profileId: Id; workspaceId: Id; title: string; runtimeRef: string }): Session {
    const s = this.store.createSession({ ...input, runtime: "codex", status: "idle", writer: "workbench" });
    this.publish({ type: "session.upserted", session: s });
    return s;
  }

  private updateSession(id: Id, patch: Parameters<Store["updateSession"]>[1]): Session {
    const s = this.store.updateSession(id, patch);
    this.publish({ type: "session.upserted", session: s });
    return s;
  }

  private setStatus(id: Id, status: SessionStatus): void {
    const s = this.store.getSession(id);
    if (s && s.status !== status) this.updateSession(id, { status });
  }

  private appendItem(sessionId: Id, body: DistributiveOmit<SessionItemInput, "id" | "sessionId" | "createdAt">, raw?: { method: string; itemId?: string; turnId?: string }): SessionItem {
    const item = this.store.appendItem({
      ...body,
      id: newId("i"),
      sessionId,
      createdAt: this.now().toISOString(),
      ...(raw ? { raw: { runtime: "codex" as const, ...raw } } : {}),
    } as SessionItemInput);
    this.publish({ type: "item.appended", item });
    return item;
  }

  private updateItem(itemId: Id, fn: (item: SessionItem) => SessionItem): void {
    const current = this.store.getItem(itemId);
    if (!current) return;
    const next = fn(current);
    if (next === current) return;
    this.publish({ type: "item.updated", item: this.store.replaceItem(next) });
  }

  private publish(event: HostEventInput): HostEvent {
    const persisted = this.store.appendEvent(event);
    this.emit("event", persisted);
    return persisted;
  }

  private emitTransient(event: HostEventInput): void {
    this.emit("event", { ...event, seq: this.store.lastEventSeq() } as HostEvent);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const approvalKey = (sessionId: Id, approvalId: string) => `${sessionId}:${approvalId}`;

/** The subset of Codex ThreadItem fields the runtime reads. */
interface CodexItem {
  type: string;
  id: string;
  text?: string;
  content?: Array<{ text?: unknown }>;
  command?: string;
  status?: string;
  aggregatedOutput?: string | null;
  changes?: Array<{ path: string }>;
  server?: string;
  tool?: string;
  query?: string;
  kind?: string;
  agentThreadId?: string;
  agentPath?: string;
}

function describeTool(item: CodexItem): { name: string; summary: string; detail?: string; status: "running" | "completed" | "failed" | "declined" } {
  const status = item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : item.status === "declined" ? "declined" : "running";
  switch (item.type) {
    case "commandExecution":
      return { name: "shell", summary: item.command ?? "", ...(item.aggregatedOutput ? { detail: item.aggregatedOutput.slice(-4000) } : {}), status };
    case "fileChange":
      return { name: "edit", summary: (item.changes ?? []).map((c) => c.path).join(", "), status };
    case "mcpToolCall":
      return { name: `${item.server ?? "mcp"}.${item.tool ?? ""}`, summary: item.tool ?? "", status };
    case "webSearch":
      return { name: "web_search", summary: item.query ?? "", status };
    default:
      return { name: item.tool ?? item.type, summary: "", status };
  }
}
