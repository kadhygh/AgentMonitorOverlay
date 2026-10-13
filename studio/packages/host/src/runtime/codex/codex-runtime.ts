import { EventEmitter } from "node:events";
import type { ApprovalDecision, HostEvent, Id, ModelOption, ModelProfile, ProfileChoices, Session, SessionItem, SessionOptions, SessionStatus, ToolFields, ToolKind, ToolStatus, TurnState, TurnUsage, Workspace } from "@amo-studio/protocol";
import { newId, type HostEventInput, type SessionItemInput, type Store } from "../../store/store.js";
import { codexThreadParams } from "../profiles.js";
import { McpIdentities } from "../../mcp/identity.js";
import { CODEX_DEFAULT_PERMISSION, codexPermission, codexPermissions } from "../choices.js";
import { classifyCommand, contentText, unwrapShell, fileDiff, formatInput, shortPath, tail } from "../items.js";
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
  /**
   * Tests only: fixed approval policy and sandbox for every session. Otherwise each session's permission option
   * decides (choices.ts; default "ask": outside the Windows sandbox, every command except known-safe reads waits for
   * the person — user decision 2026-10-13, spikes/RESULTS.md s9-02). Applied at thread start, on resume and on every
   * turn, so older threads and switched options follow it.
   */
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Set when app-servers have the AMO MCP: every thread then names its session to it (spikes/RESULTS.md section j). */
  identities?: McpIdentities;
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
  /** streaming text per codex item id (agent messages, reasoning) */
  text: Map<string, string>;
  /** codex turn id -> our turn item id */
  turns: Map<string, Id>;
  /** reasoning items: which stream they show (summary or raw content) and when they started */
  reasoning: Map<string, { channel?: "summary" | "content"; startedAt: number }>;
}

interface PendingApproval {
  /** `elicitation`: an MCP server asking before a tool runs (answered with an action, not a decision). */
  kind: "approval" | "elicitation";
  sessionId: Id;
  itemId: Id;
  profileId: string;
  requestId: ServerRequest["id"];
}

type ThreadLike = { id: string; forkedFromId?: string | null; parentThreadId?: string | null; modelProvider?: string };

const ELICITATION = "mcpServer/elicitation/request";
const isApprovalMethod = (method: string) => method.endsWith("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval" || method === ELICITATION;

export class CodexRuntime extends EventEmitter<CodexRuntimeEvents> {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly state = new Map<Id, SessionState>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly attached = new WeakSet<CodexServerHandle["client"]>();
  private readonly modelCache = new Map<Id, { at: number; models: ModelOption[] }>();

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
  async startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }): Promise<Session> {
    const profile = this.profile(input.profileId);
    const handle = await this.handleFor(profile.id);
    const token = this.options.identities?.issue();
    const options = input.options ?? {};
    const started = await handle.client.request("thread/start", {
      cwd: input.workspace.path,
      ...this.permissions(options),
      ...this.threadParams(profile, token),
      ...(options.model ? { model: options.model } : {}),
    } as never);
    const session = this.findByThread(started.thread.id) ?? this.createSession({
      taskId: input.taskId,
      topicId: input.topicId,
      parentId: null,
      kind: "main",
      profileId: profile.id,
      workspaceId: input.workspace.id,
      title: input.title ?? "",
      runtimeRef: started.thread.id,
      options,
    });
    if (token) this.options.identities!.bind(token, session.id);
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
    await handle.client.request("turn/start", { threadId: session.runtimeRef!, input, ...this.turnOptions(session.options) } as never);
    return { mode: "start" };
  }

  /** Switches model, effort or permissions; Codex applies them from the next turn (a running turn keeps its own). */
  async setOptions(sessionId: Id, options: SessionOptions): Promise<Session> {
    this.requireSession(sessionId);
    return this.updateSession(sessionId, { options });
  }

  /** `thread/name/set`: the name the TUI and `codex resume` show as well. */
  async rename(sessionId: Id, title: string): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.runtimeRef) {
      const handle = await this.handleFor(session.profileId);
      await handle.client.request("thread/name/set", { threadId: session.runtimeRef, name: title } as never);
    }
    return this.updateSession(sessionId, { title });
  }

  /** Models (from the profile's app-server, `model/list`) and permission settings. */
  async choices(profileId: Id): Promise<ProfileChoices> {
    const profile = this.profile(profileId);
    const cached = this.modelCache.get(profileId);
    let models = cached && Date.now() - cached.at < 10 * 60_000 ? cached.models : null;
    if (!models) {
      const handle = await this.handleFor(profileId);
      const r = (await handle.client.request("model/list", { includeHidden: false } as never)) as unknown as { data: CodexModel[] };
      models = r.data.map((m) => toModelOption(m, profile));
      // A profile pinned to a model the list does not show (hidden, or a custom catalog) still offers it.
      if (profile.model && !models.some((m) => m.id === profile.model)) models.unshift({ id: profile.model, label: profile.model, efforts: [], isDefault: true });
      this.modelCache.set(profileId, { at: Date.now(), models });
    }
    return { profileId, models, permissions: codexPermissions(), defaultPermission: CODEX_DEFAULT_PERMISSION, source: "cli" };
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
    const token = this.options.identities?.issue();
    const r = await handle.client.request("thread/fork", { threadId: parent.runtimeRef, ...this.threadParams(profile, token) } as never);
    // thread/started for the fork may already have created the session.
    const fork = this.findByThread(r.thread.id) ?? this.adoptThread(r.thread, parent, "fork", parent.profileId);
    if (token) this.options.identities!.bind(token, fork.id);
    return fork;
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
        await handle.client.request("thread/resume", { threadId: s.runtimeRef, ...this.identityConfig(s.id), ...this.permissions(s.options) } as never);
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
    handle.client.respond(
      pending.requestId,
      pending.kind === "elicitation" ? { action: decision === "accept" ? "accept" : "decline", content: decision === "accept" ? {} : null, _meta: null } : { decision },
    );
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
    await handle.client.request("thread/resume", { threadId: s.runtimeRef, ...this.identityConfig(s.id), ...this.permissions(s.options) } as never).catch(() => undefined);
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
    handle.client.once("close", () => this.onConnectionLost(handle));
  }

  /**
   * The connection to a server dropped (crash or restart). Answers can no longer reach pending approvals, so they are
   * closed here; if the turn is still waiting, the server replays the request after resubscribing.
   */
  private onConnectionLost(handle: CodexServerHandle): void {
    for (const [key, a] of this.approvals) {
      if (a.profileId !== handle.profileId) continue;
      this.approvals.delete(key);
      this.updateItem(a.itemId, (item) => (item.type === "approval" && item.state === "pending" ? { ...item, state: "resolved-elsewhere" } : item));
    }
  }

  /** After a (re)connect, subscribe again to every live thread served by this profile's server. */
  private async resubscribe(handle: CodexServerHandle): Promise<void> {
    for (const s of this.store.listSessions()) {
      if (s.profileId !== handle.profileId || !s.runtimeRef || s.archivedAt || s.kind === "sub") continue;
      try {
        // A restarted app-server loads the thread again; only then does the identity header need setting again.
        const r = await handle.client.request("thread/resume", { threadId: s.runtimeRef, ...this.identityConfig(s.id), ...this.permissions(s.options) } as never);
        // Turn events may have been missed while disconnected; take the status from the server's view.
        const active = (r.thread as { status?: { type?: string } }).status?.type === "active";
        const st = this.sessionState(s.id);
        if (!active) st.activeTurnId = null;
        const current = this.store.getSession(s.id)!.status;
        if (active && current !== "awaiting-approval") this.setStatus(s.id, "running");
        if (!active && (current === "running" || current === "awaiting-approval")) this.setStatus(s.id, "idle");
      } catch (err) {
        this.emit("log", `thread/resume failed for ${s.id}: ${String(err)}`);
      }
    }
  }

  private onNotification(handle: CodexServerHandle, n: ServerNotification): void {
    switch (n.method) {
      case "thread/started":
        return this.onThreadStarted(handle, n.params.thread);
      case "thread/name/updated": {
        // Renamed here or in an attached TUI: the session follows its thread's name.
        const s = this.findByThread(n.params.threadId);
        const name = n.params.threadName?.trim();
        if (s && name && name !== s.title) this.updateSession(s.id, { title: name });
        return;
      }
      case "turn/started": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        this.sessionState(s.id).activeTurnId = n.params.turn.id;
        this.openTurn(s.id, n.params.turn.id, n.params.turn.startedAt);
        this.setStatus(s.id, "running");
        return;
      }
      case "turn/completed": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.sessionState(s.id);
        if (st.activeTurnId === n.params.turn.id) st.activeTurnId = null;
        const turn = n.params.turn as { id: string; status: string; error?: { message: string } | null; startedAt?: number | null; completedAt?: number | null };
        this.closeTurn(s.id, turn);
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
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryPartAdded": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.sessionState(s.id);
        const channel = n.method === "item/reasoning/textDelta" ? "content" : "summary";
        const itemId = this.ensureReasoningItem(s.id, n.params.itemId, n.params.turnId);
        const r = st.reasoning.get(n.params.itemId)!;
        // Show one stream: whichever arrives first (raw thinking from DeepSeek-style models, or OpenAI's summaries).
        if (r.channel && r.channel !== channel) return;
        r.channel = channel;
        const sofar = st.text.get(n.params.itemId) ?? "";
        const append = n.method === "item/reasoning/summaryPartAdded" ? (sofar ? "\n\n" : "") : n.params.delta;
        if (!append) return;
        st.text.set(n.params.itemId, sofar + append);
        this.emitTransient({ type: "item.delta", sessionId: s.id, itemId, append });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        const itemId = this.sessionState(s.id).items.get(n.params.itemId);
        if (itemId && n.params.delta) this.emitTransient({ type: "item.delta", sessionId: s.id, itemId, append: n.params.delta });
        return;
      }
      case "thread/tokenUsage/updated": {
        const s = this.findByThread(n.params.threadId);
        const id = s && this.turnItemId(s.id, n.params.turnId);
        if (!id) return;
        const { last, modelContextWindow } = n.params.tokenUsage;
        this.updateItem(id, (it) => (it.type === "turn" ? { ...it, usage: addUsage(it.usage, last, modelContextWindow) } : it));
        return;
      }
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        // "Approve for me": Codex's review agent decides an approval request. Shown as a row in the work.
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.sessionState(s.id);
        const key = `review:${n.params.reviewId}`;
        const row = describeReview(n.params as unknown as CodexReview, this.store.getWorkspace(s.workspaceId)?.path);
        const existing = st.items.get(key);
        if (existing) this.updateItem(existing, (it) => (it.type === "tool" ? { ...it, ...row } : it));
        else st.items.set(key, this.appendItem(s.id, { type: "tool", ...row }, { method: n.method, turnId: n.params.turnId, itemId: n.params.reviewId }).id);
        return;
      }
      case "turn/plan/updated": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.sessionState(s.id);
        const key = `plan:${n.params.turnId}`;
        const plan = describePlan(n.params.plan, n.params.explanation);
        const existing = st.items.get(key);
        if (existing) this.updateItem(existing, (it) => (it.type === "tool" ? { ...it, ...plan } : it));
        else st.items.set(key, this.appendItem(s.id, { type: "tool", ...plan }, { method: n.method, turnId: n.params.turnId }).id);
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
  private adoptThread(thread: ThreadLike, parent: Session, kind: "fork" | "sub", profileId: Id, title?: string): Session {
    const existing = this.findByThread(thread.id);
    if (existing) return existing;
    const session = this.createSession({
      taskId: parent.taskId,
      topicId: parent.topicId,
      parentId: parent.id,
      kind,
      profileId,
      workspaceId: parent.workspaceId,
      title: title ?? (kind === "sub" ? "子 agent" : `${parent.title || "会话"} · 分支`),
      runtimeRef: thread.id,
      // Forks and subagents start with the parent's model, effort and permissions.
      options: parent.options,
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
    const params = r.params as { threadId?: string; turnId?: string; itemId?: string; command?: string | null; reason?: string | null; cwd?: string; message?: string; serverName?: string };
    const s = params.threadId ? this.findByThread(params.threadId) : undefined;
    if (!s) return;
    const key = approvalKey(s.id, String(r.id));
    if (this.approvals.has(key)) return; // replayed on resubscribe
    const elicitation = r.method === ELICITATION;
    const kind = elicitation ? "permissions" : r.method.includes("fileChange") || r.method === "applyPatchApproval" ? "fileChange" : r.method.includes("permissions") ? "permissions" : "command";
    // The tool row the approval is for already has a readable summary (the command without its shell wrapper, the files).
    const toolItemId = params.itemId ? this.sessionState(s.id).items.get(params.itemId) : undefined;
    const tool = toolItemId ? this.store.getItem(toolItemId) : undefined;
    const toolSummary = tool?.type === "tool" ? (kind === "command" ? tool.input : tool.summary) || undefined : undefined;
    const item = this.appendItem(s.id, {
      type: "approval",
      approvalId: String(r.id),
      kind,
      summary: elicitation ? (params.message ?? `MCP 服务 ${params.serverName ?? ""} 请求批准`) : (toolSummary ?? params.command ?? params.reason ?? r.method),
      ...(elicitation ? (params.serverName ? { detail: `MCP：${params.serverName}` } : {}) : params.cwd ? { detail: params.cwd } : {}),
      state: "pending",
    }, { method: r.method, ...(params.itemId ? { itemId: params.itemId } : {}), ...(params.turnId ? { turnId: params.turnId } : {}) });
    this.approvals.set(key, { kind: elicitation ? "elicitation" : "approval", sessionId: s.id, itemId: item.id, profileId: handle.profileId, requestId: r.id });
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
        const text = (item.content ?? []).map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
        this.appendItem(s.id, { type: "user", text }, raw);
        return;
      }
      case "reasoning": {
        const itemId = this.ensureReasoningItem(s.id, item.id, turnId);
        if (done) {
          const join = (parts: unknown[] | undefined) => (parts ?? []).filter((p): p is string => typeof p === "string" && p.trim() !== "").join("\n\n");
          const text = join(item.content) || join(item.summary) || (st.text.get(item.id) ?? "");
          const startedAt = st.reasoning.get(item.id)?.startedAt;
          this.updateItem(itemId, (it) =>
            it.type === "reasoning" ? { ...it, text, streaming: false, ...(startedAt ? { durationMs: this.now().getTime() - startedAt } : {}) } : it,
          );
          st.text.delete(item.id);
          st.reasoning.delete(item.id);
        }
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
        const tool = describeTool(item, this.store.getWorkspace(s.workspaceId)?.path);
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
        if (!item.agentThreadId) return;
        // Codex 0.161 announces subagents only through this item (no thread/started), so this is where the child
        // session is created; its own turn events follow on the same connection.
        const name = item.agentPath?.split("/").filter(Boolean).at(-1) ?? "子 agent";
        const child = this.findByThread(item.agentThreadId) ?? this.adoptThread({ id: item.agentThreadId, parentThreadId: threadId }, s, "sub", s.profileId, name);
        if (item.kind !== "started" || st.items.has(`sub:${item.agentThreadId}`)) return;
        const created = this.appendItem(s.id, { type: "subagent", childSessionId: child.id, summary: item.agentPath ?? name }, raw);
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

  private ensureReasoningItem(sessionId: Id, codexItemId: string, turnId: string): Id {
    const st = this.sessionState(sessionId);
    if (!st.reasoning.has(codexItemId)) st.reasoning.set(codexItemId, { startedAt: this.now().getTime() });
    const known = st.items.get(codexItemId);
    if (known) return known;
    const created = this.appendItem(sessionId, { type: "reasoning", text: "", streaming: true }, { method: "item/started", itemId: codexItemId, turnId });
    st.items.set(codexItemId, created.id);
    return created.id;
  }

  /** The turn item of a Codex turn: known in memory, or (after a Host restart) found among the session's items. */
  private turnItemId(sessionId: Id, turnId: string): Id | undefined {
    const st = this.sessionState(sessionId);
    const known = st.turns.get(turnId);
    if (known) return known;
    const found = this.store.listItems(sessionId).find((i) => i.type === "turn" && i.turnId === turnId);
    if (found) st.turns.set(turnId, found.id);
    return found?.id;
  }

  private openTurn(sessionId: Id, turnId: string, startedAt: number | null | undefined): Id {
    const existing = this.turnItemId(sessionId, turnId);
    if (existing) return existing;
    const started = startedAt ? new Date(startedAt * 1000) : this.now();
    const item = this.appendItem(sessionId, { type: "turn", turnId, state: "running", startedAt: started.toISOString() }, { method: "turn/started", turnId });
    this.sessionState(sessionId).turns.set(turnId, item.id);
    return item.id;
  }

  private closeTurn(sessionId: Id, turn: { id: string; status: string; error?: { message: string } | null; startedAt?: number | null; completedAt?: number | null }): void {
    const id = this.openTurn(sessionId, turn.id, turn.startedAt);
    const state: TurnState = turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "interrupted" : "completed";
    const endedAt = (turn.completedAt ? new Date(turn.completedAt * 1000) : this.now()).toISOString();
    this.updateItem(id, (it) => (it.type === "turn" ? { ...it, state, endedAt, ...(turn.error?.message ? { error: turn.error.message } : {}) } : it));
    // Tools still running when the turn ends were cut off; streaming thinking stops with the turn.
    const from = (this.store.getItem(id)?.seq ?? 1) - 1;
    for (const item of this.store.listItems(sessionId, from)) {
      if (item.raw?.turnId !== turn.id) continue;
      if (item.type === "tool" && item.status === "running") this.updateItem(item.id, (it) => (it.type === "tool" ? { ...it, status: "declined" } : it));
      if (item.type === "reasoning" && item.streaming) this.updateItem(item.id, (it) => (it.type === "reasoning" ? { ...it, streaming: false } : it));
    }
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  /**
   * Who answers approvals and how commands run, for thread/start and thread/resume. Approvals always go to the person,
   * whatever `approvals_reviewer` their own Codex config sets (an automatic reviewer would answer instead).
   */
  private permissions(options: SessionOptions) {
    const p = this.permissionOf(options);
    return { approvalPolicy: p.approvalPolicy, approvalsReviewer: p.reviewer, sandbox: p.sandbox };
  }

  private permissionOf(options: SessionOptions) {
    const p = codexPermission(options.permission);
    return { approvalPolicy: this.options.approvalPolicy ?? p.approvalPolicy, sandbox: this.options.sandbox ?? p.sandbox, reviewer: p.reviewer };
  }

  /**
   * turn/start overrides: permissions (a turn takes a sandbox policy object rather than a mode), the chosen model and
   * effort (they stick for later turns too), and reasoning summaries — models that keep their thinking private (GPT)
   * still show what they thought about.
   */
  private turnOptions(options: SessionOptions) {
    const { approvalPolicy, sandbox, reviewer } = this.permissionOf(options);
    const sandboxPolicy =
      sandbox === "danger-full-access"
        ? { type: "dangerFullAccess" }
        : sandbox === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    return {
      approvalPolicy,
      approvalsReviewer: reviewer,
      sandboxPolicy,
      summary: "auto",
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    };
  }

  /** thread/start and thread/fork parameters: explicit provider and model, plus the AMO MCP identity header. */
  private threadParams(profile: ModelProfile, token: string | undefined) {
    const base = codexThreadParams(profile);
    if (!token) return base;
    return { ...base, config: { ...(base.config ?? {}), ...McpIdentities.threadConfig(token) } };
  }

  /** For thread/resume: the session's identity header (takes effect when the server loads the thread again). */
  private identityConfig(sessionId: Id): { config?: Record<string, unknown> } {
    const ids = this.options.identities;
    return ids ? { config: McpIdentities.threadConfig(ids.tokenFor(sessionId)) } : {};
  }

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
      st = { activeTurnId: null, items: new Map(), text: new Map(), turns: new Map(), reasoning: new Map() };
      this.state.set(id, st);
    }
    return st;
  }

  private createSession(input: { taskId: Id | null; topicId: Id | null; parentId: Id | null; kind: Session["kind"]; profileId: Id; workspaceId: Id; title: string; runtimeRef: string; options?: SessionOptions }): Session {
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

/** The fields of a `model/list` entry the runtime reads. */
interface CodexModel {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
}

function toModelOption(m: CodexModel, profile: ModelProfile): ModelOption {
  return {
    id: m.model,
    label: m.displayName || m.model,
    ...(m.description ? { description: m.description } : {}),
    efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    defaultEffort: m.model === profile.model && profile.reasoningEffort ? profile.reasoningEffort : m.defaultReasoningEffort,
    ...((profile.model ? m.model === profile.model : m.isDefault) ? { isDefault: true } : {}),
  };
}

/** The subset of Codex ThreadItem fields the runtime reads. */
interface CodexItem {
  type: string;
  id: string;
  text?: string;
  content?: unknown[];
  summary?: string[];
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  commandActions?: CommandAction[];
  changes?: Array<{ path: string; kind?: { type: string; move_path?: string | null }; diff?: string }>;
  server?: string;
  namespace?: string | null;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown } | null;
  error?: { message?: string } | null;
  contentItems?: unknown;
  success?: boolean | null;
  query?: string;
  action?: { type: string; query?: string | null; url?: string | null; pattern?: string | null } | null;
  kind?: string;
  agentThreadId?: string;
  agentPath?: string;
}

type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

function toolStatus(status: string | undefined): ToolStatus {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : status === "declined" ? "declined" : "running";
}

/** Row fields for a Codex item; `workspace` is the session's folder (paths inside it are shown relative). */
export function describeTool(item: CodexItem, workspace?: string): ToolFields {
  const status = toolStatus(item.status);
  const base = item.cwd ?? workspace;
  const timing = item.durationMs != null ? { durationMs: item.durationMs } : {};
  switch (item.type) {
    case "commandExecution": {
      const actions = item.commandActions ?? [];
      const only = actions.length === 1 ? actions[0]! : undefined;
      const inner = only?.command ?? item.command ?? "";
      // Codex classifies Unix commands itself; on Windows they come back "unknown", so look at the command.
      const guess = !only || only.type === "unknown" ? classifyCommand(inner) : null;
      const kind: ToolKind =
        only?.type === "read" || guess?.kind === "read" ? "read" : only?.type === "search" || guess?.kind === "search" ? "search" : only?.type === "listFiles" || guess?.kind === "list" ? "list" : "command";
      const summary =
        only?.type === "read"
          ? shortPath(only.path, base)
          : only?.type === "search"
            ? [only.query, only.path ? shortPath(only.path, base) : null].filter(Boolean).join(" · ") || only.command
            : only?.type === "listFiles"
              ? only.path ? shortPath(only.path, base) : "."
              : guess
                ? guess.kind === "search" ? guess.target : shortPath(guess.target, base)
                : inner;
      return {
        name: "shell",
        kind,
        summary,
        input: inner,
        ...(item.aggregatedOutput ? { detail: tail(item.aggregatedOutput) } : {}),
        ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
        ...(item.cwd ? { cwd: item.cwd } : {}),
        ...timing,
        status,
      };
    }
    case "fileChange": {
      const files = (item.changes ?? []).map((c) =>
        fileDiff(shortPath(c.path, base), c.kind?.type === "add" ? "add" : c.kind?.type === "delete" ? "delete" : "update", c.diff),
      );
      return { name: "edit", kind: "edit", summary: files.map((f) => f.path).join(", "), files, status };
    }
    case "mcpToolCall": {
      const output = item.error?.message ?? contentText(item.result?.content);
      const input = formatInput(item.arguments);
      return {
        name: `${item.server ?? "mcp"}.${item.tool ?? ""}`,
        kind: "mcp",
        summary: item.tool ?? "",
        ...(input ? { input } : {}),
        ...(output ? { detail: tail(output) } : {}),
        ...timing,
        status,
      };
    }
    case "dynamicToolCall": {
      const output = contentText(item.contentItems);
      const input = formatInput(item.arguments);
      return {
        name: [item.namespace, item.tool].filter(Boolean).join("."),
        kind: "other",
        summary: item.tool ?? "",
        ...(input ? { input } : {}),
        ...(output ? { detail: tail(output) } : {}),
        ...timing,
        status: item.success === false ? "failed" : status,
      };
    }
    case "webSearch": {
      const a = item.action;
      const summary = a?.type === "openPage" || a?.type === "findInPage" ? (a.url ?? item.query ?? "") : (a?.query ?? item.query ?? "");
      // Web search items carry no status: started means running, completed means done.
      return { name: a?.type === "openPage" ? "web_fetch" : "web_search", kind: "web", summary, status: item.status ? status : "running" };
    }
    default:
      return { name: item.tool ?? item.type, kind: "other", summary: "", status };
  }
}

interface CodexReview {
  startedAtMs: number;
  completedAtMs?: number;
  review: { status: string; riskLevel: string | null; rationale: string | null };
  action: { type: string; command?: string; program?: string; argv?: string[]; files?: string[]; target?: string; server?: string; toolName?: string; reason?: string | null };
}

const RISK: Record<string, string> = { low: "低风险", medium: "中风险", high: "高风险", critical: "极高风险" };
const VERDICT: Record<string, string> = { inProgress: "审查中", approved: "已批准", denied: "已拒绝", timedOut: "超时", aborted: "已中止" };

/** One automatic review: what it looked at, its verdict and risk, and its reasons. */
export function describeReview(r: CodexReview, workspace?: string): ToolFields {
  const a = r.action;
  const what =
    a.type === "command"
      ? unwrapShell(a.command ?? "")
      : a.type === "execve"
        ? [a.program, ...(a.argv ?? []).slice(1)].filter(Boolean).join(" ")
        : a.type === "applyPatch"
          ? (a.files ?? []).map((f) => shortPath(f, workspace)).join(", ")
          : a.type === "networkAccess"
            ? (a.target ?? "")
            : a.type === "mcpToolCall"
              ? `${a.server ?? ""}.${a.toolName ?? ""}`
              : (a.reason ?? a.type);
  const status = r.review.status;
  const verdict = [VERDICT[status] ?? status, r.review.riskLevel ? RISK[r.review.riskLevel] ?? r.review.riskLevel : null].filter(Boolean).join(" · ");
  return {
    name: "auto_review",
    kind: "review",
    summary: what ? `${verdict} · ${what}` : verdict,
    input: what,
    ...(r.review.rationale ? { detail: r.review.rationale } : {}),
    ...(r.completedAtMs ? { durationMs: r.completedAtMs - r.startedAtMs } : {}),
    status: status === "inProgress" ? "running" : status === "approved" ? "completed" : status === "denied" ? "declined" : "failed",
  };
}

/** A plan update (Codex's update_plan) as one tool row per turn. */
export function describePlan(plan: Array<{ step: string; status: string }>, explanation: string | null): ToolFields {
  const done = plan.filter((p) => p.status === "completed").length;
  const mark = (s: string) => (s === "completed" ? "✓" : s === "inProgress" ? "→" : "○");
  const lines = plan.map((p) => `${mark(p.status)} ${p.step}`);
  return {
    name: "update_plan",
    kind: "plan",
    summary: `${done}/${plan.length} 已完成`,
    detail: [explanation, ...lines].filter(Boolean).join("\n"),
    status: "completed",
  };
}

function addUsage(prev: TurnUsage | undefined, last: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }, window: number | null): TurnUsage {
  return {
    input: (prev?.input ?? 0) + last.inputTokens,
    cachedInput: (prev?.cachedInput ?? 0) + last.cachedInputTokens,
    output: (prev?.output ?? 0) + last.outputTokens,
    reasoning: (prev?.reasoning ?? 0) + last.reasoningOutputTokens,
    ...(window ? { contextWindow: window } : {}),
  };
}
