import type { ApprovalDecision, Attachment, Id, ModelOption, ModelProfile, ProfileChoices, QuestionReply, Session, SessionOptions, SlashCommand, SlashCommandList, SlashCommandResult, Workspace, AccountUsage } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { codexThreadParams } from "../profiles.js";
import { McpIdentities } from "../../mcp/identity.js";
import { codexAutoCompactConfig } from "../compact.js";
import { CODEX_DEFAULT_PERMISSION, codexPermission, codexPermissions } from "../choices.js";
import { RuntimeBase, type RuntimeEvents } from "../runtime.js";
import type { CodexServerHandle } from "./server-manager.js";
import { codexUsage, reviewTarget, STANDARD_TIER, toModelOption, type CodexModel, type CodexSkill, type GetAccountRateLimitsResponse } from "./account.js";
import { CodexAsks } from "./asks.js";
import { CodexEvents } from "./events.js";
import { newSessionState, type CodexCore, type SessionState } from "./state.js";

export { codexRetry, codexUsage, fastTier, reviewTarget } from "./account.js";
export { describePlan, describeReview, describeTool, inputQuestions } from "./describe.js";

// Drives Codex sessions through app-server and turns its events into Studio sessions and items.
// Behaviour follows studio/spikes/RESULTS.md: approvals are broadcast and first-answer-wins, forks must carry an explicit
// provider, parent/child links are only available when threads start, and subagent events arrive on the parent's
// connection.
// Stage 16 split the runtime: this file keeps the operations and the servers; what their notifications become is
// CodexEvents' (events.ts), approvals and questions CodexAsks' (asks.ts).

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
  /**
   * The AMO role card for a thread about to start (2026-10-17): its developer instructions, so a Codex session knows
   * its place from the first turn, as a Claude one does from its MCP server's instructions. `roleGiven` notes that the
   * session was told (later changes then come with its next message).
   */
  roleInstructions?: (draft: { taskId: Id | null; topicId: Id | null; workspaceId: Id }) => string | undefined;
  roleGiven?: (sessionId: Id) => void;
}

/** Every change, already persisted (except `item.delta`, which carries the last persisted seq), and log lines. */
export type CodexRuntimeEvents = RuntimeEvents;

export class CodexRuntime extends RuntimeBase {
  private readonly state = new Map<Id, SessionState>();
  private readonly attached = new WeakSet<CodexServerHandle["client"]>();
  private readonly usageCache = new Map<Id, AccountUsage>();
  private readonly modelCache = new Map<Id, { at: number; models: ModelOption[] }>();
  /** skills/list per profile and folder. */
  private readonly skillCache = new Map<string, { at: number; skills: CodexSkill[] }>();
  private readonly asks: CodexAsks;
  private readonly events: CodexEvents;

  constructor(private readonly options: CodexRuntimeOptions) {
    super(options.store, "codex", options.now);
    const core: CodexCore = {
      ...this.makeCore(),
      sessionState: (id) => this.sessionState(id),
      knownState: (id) => this.state.get(id),
      findByThread: (threadId) => this.findByThread(threadId),
      handleFor: (profileId) => this.handleFor(profileId),
      profile: (id) => this.profile(id),
    };
    this.asks = new CodexAsks(core);
    this.events = new CodexEvents(core, this.asks, (profileId, limits) => {
      const profile = this.options.profiles.find((p) => p.id === profileId);
      if (profile && profile.provider === null) this.usageCache.set(profile.id, codexUsage(profile, limits));
    });
    this.asks.cancelStale();
    // Sessions not running any more (the last Host stopped mid-turn): close what that turn left open.
    for (const s of this.store.listSessions()) {
      if (s.runtime === "codex" && s.status !== "running" && s.status !== "awaiting-approval" && s.status !== "awaiting-answer") this.settleLeftovers(s.id, false);
    }
    options.servers.on("ready", (handle) => {
      this.attach(handle);
      void this.resubscribe(handle).catch((err: unknown) => this.emit("log", `resubscribe failed: ${String(err)}`));
    });
  }

  /** Approvals waiting in the session (their request ids). */
  pendingApprovals(sessionId: Id): string[] {
    return this.asks.pendingApprovals(sessionId);
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  /** Creates a main session in a task and starts its Codex thread; sends `text` as the first turn when given. */
  async startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }): Promise<Session> {
    const profile = this.profile(input.profileId);
    const handle = await this.handleFor(profile.id);
    const token = this.options.identities?.issue();
    const options = input.options ?? {};
    const developerInstructions = token ? this.options.roleInstructions?.({ taskId: input.taskId, topicId: input.topicId, workspaceId: input.workspace.id }) : undefined;
    const started = await handle.client.request("thread/start", {
      cwd: input.workspace.path,
      ...this.permissions(options),
      ...this.threadParams(profile, token),
      ...(options.model ? { model: options.model } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
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
    if (developerInstructions) this.options.roleGiven?.(session.id);
    if (input.text) await this.sendMessage(session.id, input.text);
    return this.store.getSession(session.id)!;
  }

  /** Starts a turn, or steers the running one; images go as `localImage` input (app-server reads the file). */
  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], extra: ReadonlyArray<Record<string, unknown>> = []): Promise<{ mode: "start" | "steer" }> {
    const session = this.writable(sessionId);
    const handle = await this.handleFor(session.profileId);
    const st = this.sessionState(sessionId);
    const input = [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...images.map((a) => ({ type: "localImage", path: a.path })), ...extra];
    if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
    // The person's next message is the answer to request_user_input_async (the card, or typed by hand).
    this.asks.closeAsync(sessionId);
    if (st.activeTurnId) {
      await handle.client.request("turn/steer", { threadId: session.runtimeRef!, expectedTurnId: st.activeTurnId, input } as never);
      // An async question answered while its turn still runs: the session runs again (unless something else waits).
      if (this.store.getSession(sessionId)?.status === "awaiting-answer") this.asks.afterAnswer(sessionId);
      return { mode: "steer" };
    }
    // Status and the active turn come from turn/started and turn/completed: a short turn can finish before this
    // response arrives, so setting them here would leave the session stuck in "running".
    await handle.client.request("turn/start", { threadId: session.runtimeRef!, input, ...this.turnOptions(session.options), ...(await this.serviceTier(session)) } as never);
    return { mode: "start" };
  }

  /** Switches model, effort or permissions; Codex applies them from the next turn (a running turn keeps its own). */
  async setOptions(sessionId: Id, options: SessionOptions): Promise<Session> {
    this.requireSession(sessionId);
    return this.updateSession(sessionId, { options });
  }

  /**
   * The ChatGPT login's quota (the profile with no provider of its own): `account/rateLimits/read`, kept up to date by
   * `account/rateLimits/updated`. Without `refresh` only what was read before (no app-server is started for it).
   */
  async usage(profileId: Id, refresh: boolean): Promise<AccountUsage | null> {
    const profile = this.profile(profileId);
    if (profile.provider !== null) return null;
    if (refresh) {
      try {
        const handle = await this.handleFor(profileId);
        const r = (await handle.client.request("account/rateLimits/read", { excludeResetCreditDetails: true } as never)) as unknown as GetAccountRateLimitsResponse;
        this.usageCache.set(profileId, codexUsage(profile, r.rateLimits));
      } catch (err) {
        this.usageCache.set(profileId, { profileId, label: profile.label, windows: [], note: `读不到用量：${String((err as Error).message ?? err)}`, updatedAt: new Date().toISOString() });
      }
    }
    return this.usageCache.get(profileId) ?? { profileId, label: profile.label, windows: [], note: "展开刷新后显示", updatedAt: null };
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
    this.asks.cancelQuestionsOf(sessionId);
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
    const fork = this.findByThread(r.thread.id) ?? this.events.adoptThread(r.thread, parent, "fork", parent.profileId);
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
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    return this.asks.respondApproval(sessionId, approvalId, decision);
  }

  /** Answers request_user_input or an MCP form (see CodexAsks). */
  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    return this.asks.answerQuestion(sessionId, itemId, reply);
  }

  // ---- CLI features (stage 12, S12-E) -------------------------------------------------------------------------------

  /**
   * Codex has no command line in app-server: its `/` commands are requests. Offered: review mode (review/start) and the
   * project's skills (skills/list); `compact` is Studio's own and maps to thread/compact/start.
   */
  async listCommands(sessionId: Id): Promise<SlashCommandList> {
    const session = this.requireSession(sessionId);
    const commands: SlashCommand[] = [
      {
        name: "code-review",
        description: "让 Codex 审查改动：默认审查未提交的改动，也可以写 base <分支>、commit <提交> 或你的审查要求",
        argumentHint: "[base <分支> | commit <提交> | 要求]",
        group: "runtime",
      },
    ];
    try {
      for (const skill of await this.skills(session)) {
        commands.push({ name: skill.name, description: (skill.shortDescription || skill.description).replace(/\s+/g, " ").trim(), group: "skill" });
      }
      return { commands };
    } catch (err) {
      this.emit("log", `skills/list failed for ${sessionId}: ${String(err)}`);
      return { commands, note: `读不到 Codex 的 skills：${String((err as Error).message ?? err)}` };
    }
  }

  private async skills(session: Session): Promise<CodexSkill[]> {
    const cwd = this.store.getWorkspace(session.workspaceId)?.path;
    if (!cwd) return [];
    const key = `${session.profileId}|${cwd}`;
    const cached = this.skillCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.skills;
    const handle = await this.handleFor(session.profileId);
    const r = (await handle.client.request("skills/list", { cwds: [cwd] } as never)) as unknown as { data: Array<{ skills: CodexSkill[] }> };
    const skills = r.data.flatMap((e) => e.skills).filter((s) => s.enabled !== false);
    this.skillCache.set(key, { at: Date.now(), skills });
    return skills;
  }

  /**
   * `compact` → thread/compact/start, `code-review` → review/start (inline), a skill → a turn with the `skill` input
   * (the text says `$name args`, as the Codex TUI writes it). Compaction and review start turns of their own, so they
   * wait for the running turn to end.
   */
  async runCommand(sessionId: Id, name: string, args: string): Promise<SlashCommandResult> {
    const session = this.writable(sessionId);
    const st = this.sessionState(sessionId);
    if (name === "compact" || name === "code-review") {
      if (st.activeTurnId) throw Object.assign(new Error("回复还在生成，这一轮结束后再运行这个命令"), { code: "conflict" });
      const handle = await this.handleFor(session.profileId);
      // The person's command opens the turn in the conversation (Codex writes no message of its own for it).
      this.appendItem(sessionId, { type: "user", text: `/${name}${args ? ` ${args}` : ""}` }, { method: "command" });
      if (name === "compact") {
        await handle.client.request("thread/compact/start", { threadId: session.runtimeRef! } as never);
      } else {
        const r = (await handle.client.request("review/start", { threadId: session.runtimeRef!, target: reviewTarget(args), delivery: "inline" } as never)) as unknown as { turn: { id: string } };
        st.reviewTurns.add(r.turn.id);
      }
      return { mode: "start" };
    }
    const skill = (await this.skills(session)).find((s) => s.name === name);
    if (!skill) throw Object.assign(new Error(`Codex 没有 /${name} 这个命令`), { code: "bad_request" });
    const sent = await this.sendMessage(sessionId, `$${skill.name}${args ? ` ${args}` : ""}`, [], [{ type: "skill", name: skill.name, path: skill.path }]);
    return { mode: sent.mode };
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

  /**
   * The thread is not running (any more): a turn the last Host saw start, and its streaming text and running tools,
   * are over. `notify` adds a line saying the reply was cut off.
   */
  private settleLeftovers(sessionId: Id, notify: boolean): void {
    let cut = false;
    const at = this.now().toISOString();
    for (const item of this.store.listItems(sessionId)) {
      if (item.type === "turn" && item.state === "running") {
        cut = true;
        this.updateItem(item.id, (it) => (it.type === "turn" && it.state === "running" ? { ...it, state: "interrupted", endedAt: at } : it));
      } else if (item.type === "agent" && item.streaming) this.updateItem(item.id, (it) => (it.type === "agent" ? { ...it, streaming: false } : it));
      else if (item.type === "reasoning" && item.streaming) this.updateItem(item.id, (it) => (it.type === "reasoning" ? { ...it, streaming: false } : it));
      else if (item.type === "tool" && item.status === "running") this.updateItem(item.id, (it) => (it.type === "tool" ? { ...it, status: "failed" } : it));
      else if (item.type === "compaction" && item.state === "running") this.updateItem(item.id, (it) => (it.type === "compaction" ? { ...it, state: "failed" } : it));
    }
    if (cut && notify) this.appendItem(sessionId, { type: "notice", level: "warning", message: "这一轮回复被中断了（Host 或 Codex 重启）。发一条消息即可接着对话。" });
  }

  // ---- server events ----------------------------------------------------------------------------------------------

  private attach(handle: CodexServerHandle): void {
    if (this.attached.has(handle.client)) return;
    this.attached.add(handle.client);
    // One message Studio cannot handle stays a line in its session (and the log); the server and other sessions go on.
    handle.client.on("notification", (n) => {
      try {
        this.events.onNotification(handle, n);
      } catch (err) {
        this.events.handlerFailed(n.method, (n.params as { threadId?: string } | undefined)?.threadId, err);
      }
    });
    handle.client.on("request", (r) => {
      try {
        this.asks.onServerRequest(handle, r);
      } catch (err) {
        this.events.handlerFailed(r.method, (r.params as { threadId?: string } | undefined)?.threadId, err);
        // Unanswered, the turn would wait for ever.
        handle.client.respondError(r.id, -32603, `AMO Studio could not handle ${r.method}`);
      }
    });
    handle.client.once("close", () => this.asks.onConnectionLost(handle.profileId));
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
        if (!active) {
          st.activeTurnId = null;
          this.settleLeftovers(s.id, true);
        }
        const current = this.store.getSession(s.id)!.status;
        if (active && current !== "awaiting-approval" && current !== "awaiting-answer") this.setStatus(s.id, "running");
        if (!active && (current === "running" || current === "awaiting-approval" || current === "awaiting-answer")) this.setStatus(s.id, "idle");
      } catch (err) {
        this.emit("log", `thread/resume failed for ${s.id}: ${String(err)}`);
      }
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

  /**
   * The `serviceTier` for turn/start (stage 13, 「Fast」): the model's fast tier when the session asks for it and the
   * model has one; "default" (standard speed) when Fast was turned off, or the model has none. Nothing when Fast was
   * never chosen (the person's own Codex config, `service_tier`, applies), and nothing on a profile with no fast tier
   * at all (DeepSeek and other providers never hear of speed tiers).
   */
  private async serviceTier(session: Session): Promise<{ serviceTier?: string }> {
    if (session.options.fast === undefined) return {};
    let models: ModelOption[];
    try {
      models = (await this.choices(session.profileId)).models;
    } catch {
      return {};
    }
    if (!models.some((m) => m.fast)) return {};
    const model = models.find((m) => m.id === session.options.model) ?? models.find((m) => m.isDefault);
    return { serviceTier: (session.options.fast && model?.fast?.tier) || STANDARD_TIER };
  }

  /**
   * thread/start and thread/fork parameters: explicit provider and model, the AMO MCP identity header, and the
   * 自动压缩点 (设置 → 模型).
   */
  private threadParams(profile: ModelProfile, token: string | undefined) {
    const base = codexThreadParams(profile);
    return { ...base, config: { ...(base.config ?? {}), ...codexAutoCompactConfig(this.store, profile.id), ...(token ? McpIdentities.threadConfig(token) : {}) } };
  }

  /** For thread/resume: the session's identity header (takes effect when the server loads the thread again). */
  /** thread/resume's config: the AMO MCP identity header and the 自动压缩点. */
  private identityConfig(sessionId: Id): { config: Record<string, unknown> } {
    const ids = this.options.identities;
    return { config: { ...codexAutoCompactConfig(this.store, this.store.getSession(sessionId)?.profileId), ...(ids ? McpIdentities.threadConfig(ids.tokenFor(sessionId)) : {}) } };
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
      st = newSessionState();
      this.state.set(id, st);
    }
    return st;
  }

}


