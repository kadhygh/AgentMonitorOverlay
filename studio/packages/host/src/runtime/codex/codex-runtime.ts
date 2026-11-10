import { randomUUID } from "node:crypto";
import { inTurn, type ApprovalDecision, type Attachment, type Id, type ModelOption, type ModelProfile, type ProfileChoices, type QuestionReply, type Session, type SessionOptions, type SlashCommand, type SlashCommandList, type SlashCommandResult, type UserDelivery, type Workspace, type AccountUsage, type codex } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { codexThreadParams, profileGone, type CodexConfig } from "../profiles.js";
import { McpIdentities } from "../../mcp/identity.js";
import { codexAutoCompactConfig } from "../compact.js";
import { CODEX_DEFAULT_PERMISSION, codexPermission, codexPermissions } from "../choices.js";
import { RuntimeBase, STOP_GRACE_MS, type ForkSpec, type RuntimeEvents, type SendOptions } from "../runtime.js";
import { withDelivery } from "../items.js";
import type { CodexServerHandle } from "./server-manager.js";
import { codexUsage, isTokenExpired, reviewTarget, STANDARD_TIER, toModelOption, type CodexModel, type CodexSkill, type GetAccountRateLimitsResponse } from "./account.js";
import { CodexAsks } from "./asks.js";
import { CodexEvents } from "./events.js";
import { newSessionState, type CodexCore, type SessionState } from "./state.js";
import { mcpSkippedNotice } from "../mcp-launch.js";

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
  /** Studio's MCP servers that are on but Codex cannot take (server-manager.ts). */
  unsupportedMcp?(): Array<{ name: string; type: string }>;
}

export interface CodexRuntimeOptions {
  store: Store;
  servers: CodexServers;
  profiles: readonly ModelProfile[];
  now?: () => Date;
  /** 停止 not answered by the app-server this long: Studio takes the turn as stopped (default STOP_GRACE_MS). */
  stopGraceMs?: number;
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
  private readonly listingModels = new Map<string, Promise<ModelOption[]>>();
  /** skills/list per profile and folder. */
  private readonly skillCache = new Map<string, { at: number; skills: CodexSkill[] }>();
  private readonly asks: CodexAsks;
  private readonly events: CodexEvents;

  constructor(private readonly options: CodexRuntimeOptions) {
    super(options.store, "codex", options.now, options.profiles);
    const core: CodexCore = {
      ...this.makeCore(),
      sessionState: (id) => this.sessionState(id),
      knownState: (id) => this.state.get(id),
      findByThread: (threadId) => this.findByThread(threadId),
      handleFor: (profileId) => this.handleFor(profileId),
      profile: (id) => this.profile(id),
    };
    this.asks = new CodexAsks(core);
    this.events = new CodexEvents(
      core,
      this.asks,
      (profileId, limits) => {
        const profile = this.options.profiles.find((p) => p.id === profileId);
        if (profile && profile.provider === null) this.usageCache.set(profile.id, codexUsage(profile, limits));
      },
      (sessionId) => void this.afterTurn(sessionId),
    );
    this.asks.cancelStale();
    // Sessions not running any more (the last Host stopped mid-turn): close what that turn left open.
    for (const s of this.store.listSessions()) {
      if (s.runtime === "codex" && !inTurn(s.status)) this.settleTurn(s.id, false);
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
    });
    const existing = this.findByThread(started.thread.id);
    const session = existing ?? this.createSession({
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
    // MCP servers that are on but Codex cannot take (SSE) are left out of its config: say so instead of nothing (2026-11-09).
    const skipped = existing ? [] : (this.options.servers.unsupportedMcp?.() ?? []);
    if (skipped.length) this.appendItem(session.id, { type: "notice", level: "warning", message: mcpSkippedNotice(skipped, "Codex") });
    if (input.text) await this.sendMessage(session.id, input.text);
    return this.store.getSession(session.id)!;
  }

  /**
   * Starts a turn, or steers the running one; images go as `localImage` input (app-server reads the file). A steered
   * message shows at once as `waiting` (2026-11-02: before, it showed only once read, and a 停止 before that lost it
   * unseen); `now` (立即发送) then makes the turn give way to it.
   */
  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: "start" | "steer" }> {
    return this.send(sessionId, text, images, [], options);
  }

  /** `extra`: more input (a skill); `again`: the row of a message sent again (重新发送), reused instead of a new one. */
  private async send(sessionId: Id, text: string, images: readonly Attachment[], extra: readonly codex.v2.UserInput[], options: SendOptions = {}, again?: Id): Promise<{ mode: "start" | "steer" }> {
    const session = this.writable(sessionId);
    const handle = await this.handleFor(session.profileId);
    const st = this.sessionState(sessionId);
    const input: codex.v2.UserInput[] = [...(text ? [{ type: "text" as const, text, text_elements: [] }] : []), ...images.map((a) => ({ type: "localImage" as const, path: a.path })), ...extra];
    if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
    // The person's next message is the answer to request_user_input_async (the card, or typed by hand).
    this.asks.closeAsync(sessionId);
    const setDelivery = (itemId: Id, delivery: UserDelivery | undefined) => this.updateItem(itemId, (it) => (it.type === "user" ? withDelivery(it, delivery) : it));
    let row = again;
    if (st.activeTurnId) {
      // Studio's row from the start; Codex echoes the id back with the message once it read it (events.ts).
      const clientId = randomUUID();
      if (row) setDelivery(row, "waiting");
      else {
        const pictures = images.map((a) => ({ id: a.id, path: a.path }));
        row = this.appendItem(sessionId, { type: "user", text, ...(pictures.length ? { images: pictures } : {}), delivery: "waiting" }, { method: "user/steer", turnId: st.activeTurnId }).id;
      }
      const entry = { itemId: row, kind: "steer" as const, input };
      st.sent.set(clientId, entry);
      try {
        await handle.client.request("turn/steer", { threadId: session.runtimeRef!, expectedTurnId: st.activeTurnId, input, clientUserMessageId: clientId });
        // An async question answered while its turn still runs: the session runs again (unless something else waits).
        if (this.store.getSession(sessionId)?.status === "awaiting-answer") this.asks.afterAnswer(sessionId);
        if (options.now) await this.sendNow(sessionId, row);
        return { mode: "steer" };
      } catch (err) {
        // The turn ended meanwhile and afterTurn took the message on to the next turn: it is on its way.
        if (st.sent.get(clientId) !== entry) return { mode: "start" };
        st.sent.delete(clientId);
        // The turn ended as the message went out (its turn/completed not handled yet): it starts the next turn instead
        // of failing (2026-10-21: "turn/steer: no active turn to steer").
        if (!/no active turn/i.test(err instanceof Error ? err.message : String(err))) {
          setDelivery(row, "unsent");
          throw err;
        }
      }
    }
    // A row shown already goes with an id, so its echo settles it rather than adding another.
    const clientId = row ? randomUUID() : undefined;
    if (row && clientId) {
      setDelivery(row, undefined);
      st.sent.set(clientId, { itemId: row, kind: "start", input });
    }
    // Status and the active turn come from turn/started and turn/completed: a short turn can finish before this
    // response arrives, so setting them here would leave the session stuck in "running".
    try {
      await handle.client.request("turn/start", { threadId: session.runtimeRef!, input, ...(clientId ? { clientUserMessageId: clientId } : {}), ...this.turnOptions(session.options), ...(await this.serviceTier(session)) });
    } catch (err) {
      if (row && clientId) {
        st.sent.delete(clientId);
        setDelivery(row, "unsent");
      }
      throw err;
    }
    return { mode: "start" };
  }

  /**
   * 立即发送 (2026-11-02): Codex reads a steered message at its next step — while a command runs, only once it is done.
   * As the TUI's "press esc to interrupt and send immediately": the turn is interrupted, and the messages it did not
   * read go on as the next turn (afterTurn).
   */
  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    const session = this.writable(sessionId);
    const st = this.sessionState(sessionId);
    const waiting = [...st.sent.values()].some((m) => m.itemId === itemId && m.kind === "steer");
    if (!waiting || !st.activeTurnId || !session.runtimeRef) return;
    const handle = await this.handleFor(session.profileId);
    await handle.client.request("turn/interrupt", { threadId: session.runtimeRef, turnId: st.activeTurnId });
  }

  /** 重新发送 (2026-11-02): a message Codex never read goes again, as the same row; also a held one of Studio's inbox. */
  async resend(sessionId: Id, itemId: Id, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: "start" | "steer" }> {
    this.writable(sessionId);
    const item = this.store.getItem(itemId);
    if (item?.type !== "user" || item.sessionId !== sessionId) throw Object.assign(new Error(`message ${itemId} not found`), { code: "not_found" });
    if (item.delivery !== "unsent" && item.delivery !== "held") return { mode: this.sessionState(sessionId).activeTurnId ? "steer" : "start" };
    return this.send(sessionId, item.text, images, [], options, itemId);
  }

  /**
   * A turn ended with steered messages it never read (stopped, given way to 立即发送, or ended as they came): Codex has
   * dropped them, so they go on as the next turn, as the TUI does — the first starts it, the rest are steered into it.
   * 2026-11-02, the user: a message waiting when 停止 is pressed is sent, not lost (as the Claude Code CLI does too).
   */
  private async afterTurn(sessionId: Id): Promise<void> {
    const st = this.sessionState(sessionId);
    const left = [...st.sent].filter(([, m]) => m.kind === "steer");
    if (!left.length) return;
    for (const [clientId] of left) st.sent.delete(clientId);
    const lost = (from: number) => {
      for (const [, m] of left.slice(from)) this.updateItem(m.itemId, (it) => (it.type === "user" ? withDelivery(it, "unsent") : it));
    };
    const session = this.store.getSession(sessionId);
    if (!session?.runtimeRef || session.archivedAt || session.writer !== "workbench") return lost(0);
    const [firstId, first] = left[0]!;
    // The rest stay waiting (fresh entries, so a later afterTurn taking them on is seen): steered into the new turn
    // below, or on to the one after it when that turn ends first (its afterTurn).
    const rest = left.slice(1).map(([clientId, m]) => [clientId, { ...m }] as const);
    st.sent.set(firstId, { ...first, kind: "start" });
    for (const [clientId, m] of rest) st.sent.set(clientId, m);
    this.updateItem(first.itemId, (it) => (it.type === "user" ? withDelivery(it, undefined) : it));
    let handle: CodexServerHandle;
    try {
      handle = await this.handleFor(session.profileId);
      await handle.client.request("turn/start", { threadId: session.runtimeRef, input: first.input, clientUserMessageId: firstId, ...this.turnOptions(session.options), ...(await this.serviceTier(session)) });
    } catch (err) {
      this.emit("log", `could not send the unread messages of ${sessionId}: ${String(err)}`);
      for (const [clientId] of left) st.sent.delete(clientId);
      return lost(0);
    }
    for (const [clientId, m] of rest) {
      if (st.sent.get(clientId) !== m) continue;
      // The new turn is over already (a short one): what is left starts the next.
      if (!st.activeTurnId) return void this.afterTurn(sessionId);
      try {
        await handle.client.request("turn/steer", { threadId: session.runtimeRef, expectedTurnId: st.activeTurnId, input: m.input, clientUserMessageId: clientId });
      } catch {
        if (!st.activeTurnId && st.sent.get(clientId) === m) void this.afterTurn(sessionId);
        return;
      }
    }
  }

  /** Switches model, effort or permissions; Codex applies them from the next turn (a running turn keeps its own). */
  /** Options go with the next turn; 完全访问 also accepts what the running turn is waiting for (asks.ts). */
  async setOptions(sessionId: Id, options: SessionOptions): Promise<Session> {
    this.requireSession(sessionId);
    const updated = this.updateSession(sessionId, { options });
    if (options.permission === "full-auto") await this.asks.acceptAll(sessionId);
    return updated;
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
        const read = async () => (await handle.client.request("account/rateLimits/read", { excludeResetCreditDetails: true })) as unknown as GetAccountRateLimitsResponse;
        let r: GetAccountRateLimitsResponse;
        try {
          r = await read();
        } catch (err) {
          // 问题 #18 (2026-11-09): a long-running app-server answers the quota read with 401 token_expired instead of
          // renewing the ChatGPT token first. `account/read` with refreshToken renews it (Codex's own login, as its
          // protocol says), then the quota is read once more; another failure shows as before.
          if (!isTokenExpired(err)) throw err;
          await handle.client.request("account/read", { refreshToken: true });
          r = await read();
        }
        this.usageCache.set(profileId, codexUsage(profile, r.rateLimits));
      } catch (err) {
        this.usageCache.set(profileId, { profileId, label: profile.label, windows: [], note: `读不到用量：${String((err as Error).message ?? err)}`, updatedAt: new Date().toISOString() });
      }
    }
    return this.usageCache.get(profileId) ?? { profileId, label: profile.label, windows: [], note: "展开刷新后显示", updatedAt: null };
  }

  /** 远程额度 (2026-11-06): only what was read before (account/rateLimits/updated, or a refresh). */
  cachedUsage(profileId: Id): AccountUsage | null {
    return this.usageCache.get(profileId) ?? null;
  }

  /** `thread/name/set`: the name the TUI and `codex resume` show as well. */
  async rename(sessionId: Id, title: string): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.runtimeRef) {
      const handle = await this.handleFor(session.profileId);
      await handle.client.request("thread/name/set", { threadId: session.runtimeRef, name: title });
    }
    return this.updateSession(sessionId, { title });
  }

  /** Models (from the profile's app-server, `model/list`) and permission settings. */
  async choices(profileId: Id): Promise<ProfileChoices> {
    const profile = this.profile(profileId);
    // Keyed by the profile's own model too: a channel's model changed in 设置 → 模型 is the default at once.
    const cacheKey = `${profileId}|${profile.model ?? ""}`;
    const cached = this.modelCache.get(cacheKey);
    // An older list is answered at once and asked again behind it (2026-10-23: 开始 and 新会话 waited for it).
    if (cached && Date.now() - cached.at >= 10 * 60_000) this.listModels(profile, cacheKey).catch((err: unknown) => this.emit("log", `could not list the models of ${profileId}: ${String(err)}`));
    const models = cached ? cached.models : await this.listModels(profile, cacheKey);
    return { profileId, models, permissions: codexPermissions(), defaultPermission: CODEX_DEFAULT_PERMISSION, source: "cli" };
  }

  /** The profile's models from its app-server (`model/list`) into the cache; one ask at a time per key. */
  private listModels(profile: ModelProfile, cacheKey: string): Promise<ModelOption[]> {
    let asking = this.listingModels.get(cacheKey);
    if (!asking) {
      asking = (async () => {
        const handle = await this.handleFor(profile.id);
        const r = (await handle.client.request("model/list", { includeHidden: false })) as unknown as { data: CodexModel[] };
        const models = r.data.map((m) => toModelOption(m, profile));
        // A profile pinned to a model the list does not show (hidden, or a custom catalog) still offers it.
        if (profile.model && !models.some((m) => m.id === profile.model)) models.unshift({ id: profile.model, label: profile.model, efforts: [], isDefault: true });
        this.modelCache.set(cacheKey, { at: Date.now(), models });
        return models;
      })().finally(() => this.listingModels.delete(cacheKey));
      this.listingModels.set(cacheKey, asking);
    }
    return asking;
  }

  async interrupt(sessionId: Id): Promise<void> {
    const session = this.requireSession(sessionId);
    const st = this.sessionState(sessionId);
    if (!st.activeTurnId || !session.runtimeRef) return;
    this.asks.cancelQuestionsOf(sessionId);
    // 停止's fallback (2026-11-04, plans/done/message-delivery.md): the app-server is shared by the channel's sessions, so it
    // is not closed; the turn is taken as stopped here, and what the turn had not read becomes 没送到.
    const turnId = st.activeTurnId;
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    this.armStopGrace(sessionId, grace, () => this.state.get(sessionId)?.activeTurnId === turnId, () => {
      st.activeTurnId = null;
      this.settleTurn(sessionId, false);
      this.appendItem(sessionId, { type: "notice", level: "warning", message: `点了停止 ${Math.round(grace / 1000)} 秒后 Codex 还没停下，Studio 不再等它，把这一轮记成已停止。发一条消息即可接着对话；还不行的话重启 Studio。` });
      this.setStatus(sessionId, "idle");
    }, "taking it as stopped");
    const handle = await this.handleFor(session.profileId);
    await handle.client.request("turn/interrupt", { threadId: session.runtimeRef, turnId });
  }

  /**
   * Forks with an explicit provider so the fork never falls back to the server default. `through`: only up to that turn
   * (thread/fork's lastTurnId, 2026-11-10).
   */
  async fork(sessionId: Id, spec: ForkSpec = {}): Promise<Session> {
    const parent = this.requireSession(sessionId);
    if (!parent.runtimeRef) throw new Error(`session ${sessionId} has no thread yet`);
    const profile = this.profile(spec.profileId ?? parent.profileId);
    const handle = await this.handleFor(parent.profileId);
    const token = this.options.identities?.issue();
    const r = await handle.client.request("thread/fork", { threadId: parent.runtimeRef, ...(spec.through ? { lastTurnId: spec.through.turnId } : {}), ...this.threadParams(profile, token) });
    // thread/started for the fork may already have created the session (as a fork under the parent).
    let fork = this.findByThread(r.thread.id) ?? this.events.adoptThread(r.thread, parent, "fork", parent.profileId, spec.title);
    if (token) this.options.identities!.bind(token, fork.id);
    if (spec.peer) fork = this.store.setSessionPlacement(fork.id, "main", null);
    if (spec.options) fork = this.updateSession(fork.id, { options: spec.options });
    if (spec.title && fork.title !== spec.title) fork = await this.rename(fork.id, spec.title);
    return fork;
  }

  /** Archives the session with its forks and subagents, and archives their threads. */
  async archive(sessionId: Id): Promise<Session[]> {
    const changed = this.archiveTree(sessionId);
    for (const s of changed) {
      if (!s.runtimeRef || s.kind === "sub") continue;
      try {
        const handle = await this.handleFor(s.profileId);
        await handle.client.request("thread/archive", { threadId: s.runtimeRef });
      } catch (err) {
        this.emit("log", `thread/archive failed for ${s.id}: ${String(err)}`);
      }
    }
    return changed;
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    const changed = this.unarchiveTree(sessionId);
    for (const s of changed) {
      if (!s.runtimeRef || s.kind === "sub") continue;
      try {
        const handle = await this.handleFor(s.profileId);
        await handle.client.request("thread/unarchive", { threadId: s.runtimeRef });
        await handle.client.request("thread/resume", { threadId: s.runtimeRef, ...this.identityConfig(s.id), ...this.permissions(s.options) });
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
    const r = (await handle.client.request("skills/list", { cwds: [cwd] })) as unknown as { data: Array<{ skills: CodexSkill[] }> };
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
        await handle.client.request("thread/compact/start", { threadId: session.runtimeRef! });
      } else {
        const r = (await handle.client.request("review/start", { threadId: session.runtimeRef!, target: reviewTarget(args), delivery: "inline" })) as unknown as { turn: { id: string } };
        st.reviewTurns.add(r.turn.id);
      }
      return { mode: "start" };
    }
    const skill = (await this.skills(session)).find((s) => s.name === name);
    if (!skill) throw Object.assign(new Error(`Codex 没有 /${name} 这个命令`), { code: "bad_request" });
    const sent = await this.send(sessionId, `$${skill.name}${args ? ` ${args}` : ""}`, [], [{ type: "skill", name: skill.name, path: skill.path }]);
    return { mode: sent.mode };
  }

  /** Where an attached terminal should connect. The token must only travel through an env var. */
  async attachInfo(sessionId: Id): Promise<{ url: string; token: string; threadId: string }> {
    const s = this.requireSession(sessionId);
    if (!s.runtimeRef) throw new Error(`session ${sessionId} has no thread yet`);
    const handle = await this.handleFor(s.profileId);
    // Make sure the thread is loaded on this server so `codex --remote … resume` finds it.
    await handle.client.request("thread/resume", { threadId: s.runtimeRef, ...this.identityConfig(s.id), ...this.permissions(s.options) }).catch(() => undefined);
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
  private settleTurn(sessionId: Id, notify: boolean): void {
    // Approvals are not settled here: the app-server replays the ones still wanted after resubscribing (asks.ts).
    const cut = this.settleLeftovers(sessionId);
    // Steered and never read (now unsent): the turn (and Codex's copy of it) is gone.
    this.state.get(sessionId)?.sent.clear();
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
    handle.client.once("close", () => {
      this.asks.onConnectionLost(handle.profileId);
      // Steered messages the app-server had not read went with it (2026-11-02).
      for (const [id, st] of this.state) {
        if (!st.sent.size || this.store.getSession(id)?.profileId !== handle.profileId) continue;
        for (const m of st.sent.values()) this.updateItem(m.itemId, (it) => (it.type === "user" && it.delivery === "waiting" ? withDelivery(it, "unsent") : it));
        st.sent.clear();
      }
    });
  }

  /** After a (re)connect, subscribe again to every live thread served by this profile's server. */
  private async resubscribe(handle: CodexServerHandle): Promise<void> {
    for (const s of this.store.listSessions()) {
      if (s.profileId !== handle.profileId || !s.runtimeRef || s.archivedAt || s.kind === "sub") continue;
      try {
        // A restarted app-server loads the thread again; only then does the identity header need setting again.
        const r = await handle.client.request("thread/resume", { threadId: s.runtimeRef, ...this.identityConfig(s.id), ...this.permissions(s.options) });
        // Turn events may have been missed while disconnected; take the status from the server's view.
        const active = (r.thread as { status?: { type?: string } }).status?.type === "active";
        const st = this.sessionState(s.id);
        if (!active) {
          st.activeTurnId = null;
          this.settleTurn(s.id, true);
        }
        const current = this.store.getSession(s.id)!.status;
        if (active && !inTurn(current)) this.setStatus(s.id, "running");
        // Cut off from outside (the Host or the app-server went down mid-turn): red until a message carries it on.
        if (!active && inTurn(current)) this.setStatus(s.id, "interrupted");
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
    const sandboxPolicy: codex.v2.SandboxPolicy =
      sandbox === "danger-full-access"
        ? { type: "dangerFullAccess" }
        : sandbox === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    return {
      approvalPolicy,
      approvalsReviewer: reviewer,
      sandboxPolicy,
      summary: "auto" as const,
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
  private identityConfig(sessionId: Id): { config: CodexConfig } {
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
    if (!p) throw profileGone(id);
    if (p.runtime !== "codex") throw new Error(`unknown Codex profile ${id}`);
    return p;
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


