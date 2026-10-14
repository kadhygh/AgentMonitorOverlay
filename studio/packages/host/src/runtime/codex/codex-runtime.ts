import { EventEmitter } from "node:events";
import { asyncPrompts, codexAnswers, elicitationForm, formContent, storedAnswers, type ApprovalDecision, type Attachment, type HostEvent, type Id, type ModelOption, type ModelProfile, type ProfileChoices, type QuestionPrompt, type QuestionReply, type Session, type SessionItem, type SessionOptions, type SessionStatus, type SlashCommand, type SlashCommandList, type SlashCommandResult, type ToolFields, type ToolKind, type ToolStatus, type TurnRetry, type TurnState, type TurnUsage, type Workspace, type AccountUsage } from "@amo-studio/protocol";
import { newId, type HostEventInput, type SessionItemInput, type Store } from "../../store/store.js";
import { codexThreadParams } from "../profiles.js";
import { studioInstructions } from "../studio-prompt.js";
import { McpIdentities } from "../../mcp/identity.js";
import { CODEX_DEFAULT_PERMISSION, codexPermission, codexPermissions } from "../choices.js";
import { classifyCommand, contentText, messageImage, unwrapShell, fileDiff, formatInput, shortPath, tail } from "../items.js";
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
  /**
   * Turns in review mode (review/start). Their items carry the review's own turn id, which is also what turn/completed
   * names, while turn/started names another one with it as `rootTurnId` (Codex 0.162; spikes/s12-e-codex-cli.mjs).
   */
  reviewTurns: Set<string>;
  /** notice key -> its item, for the turn in progress (repeats update the row) */
  notices: Map<string, Id>;
  /** The turn whose item shows a retry (cleared when the model answers). */
  retrying: string | null;
  /**
   * When the model call streaming now gave its first output (a reasoning or message item, or their text): its end is
   * the token usage it reports; the time between, with its output tokens, is the turn's speed (as DSH measures it).
   */
  callFirstAt: number | null;
}

interface PendingApproval {
  /** `elicitation`: an MCP server asking before a tool runs (answered with an action, not a decision). */
  kind: "approval" | "elicitation";
  sessionId: Id;
  itemId: Id;
  profileId: string;
  requestId: ServerRequest["id"];
}

/** request_user_input or an MCP form waiting for the person (a `question` item). */
interface PendingQuestion {
  kind: "input" | "form";
  sessionId: Id;
  itemId: Id;
  profileId: string;
  requestId: ServerRequest["id"];
  questions: QuestionPrompt[];
}

type ThreadLike = { id: string; forkedFromId?: string | null; parentThreadId?: string | null; modelProvider?: string };

const ELICITATION = "mcpServer/elicitation/request";
const USER_INPUT = "item/tool/requestUserInput";
const isApprovalMethod = (method: string) => method.endsWith("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval" || method === ELICITATION;

export class CodexRuntime extends EventEmitter<CodexRuntimeEvents> {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly state = new Map<Id, SessionState>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** question item id -> the server request waiting for its answer */
  private readonly questions = new Map<Id, PendingQuestion>();
  private readonly attached = new WeakSet<CodexServerHandle["client"]>();
  private readonly usageCache = new Map<Id, AccountUsage>();
  private readonly modelCache = new Map<Id, { at: number; models: ModelOption[] }>();
  /** Notices a server sent for no thread (config warnings, deprecations, MCP start-up): shown in the next turn. */
  private readonly serverNotices = new Map<Id, Array<{ level: "info" | "warning"; message: string; key: string }>>();
  /** skills/list per profile and folder. */
  private readonly skillCache = new Map<string, { at: number; skills: CodexSkill[] }>();

  constructor(private readonly options: CodexRuntimeOptions) {
    super();
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.cancelStaleQuestions();
    // Sessions not running any more (the last Host stopped mid-turn): close what that turn left open.
    for (const s of this.store.listSessions()) {
      if (s.runtime === "codex" && s.status !== "running" && s.status !== "awaiting-approval" && s.status !== "awaiting-answer") this.settleLeftovers(s.id, false);
    }
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

  /** Starts a turn, or steers the running one; images go as `localImage` input (app-server reads the file). */
  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], extra: ReadonlyArray<Record<string, unknown>> = []): Promise<{ mode: "start" | "steer" }> {
    const session = this.writable(sessionId);
    const handle = await this.handleFor(session.profileId);
    const st = this.sessionState(sessionId);
    const input = [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...images.map((a) => ({ type: "localImage", path: a.path })), ...extra];
    if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
    // The person's next message is the answer to request_user_input_async (the card, or typed by hand).
    this.closeAsyncQuestions(sessionId);
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
    for (const q of [...this.questions.values()]) if (q.sessionId === sessionId) this.closeQuestion(q, "cancelled");
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
    this.afterAnswer(sessionId);
  }

  /**
   * Answers request_user_input (answers by question id; dismissing answers none) or an MCP form (accept with the
   * values, or decline). Secret answers go to Codex only; the item keeps them masked.
   */
  async answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    const asked = this.store.getItem(itemId);
    if (asked?.type === "question" && asked.source === "codex-async" && asked.sessionId === sessionId) {
      // Nothing waits on Codex's side: the item records the answer, the sessions service sends it as a message.
      if (reply.action !== "answer" && reply.action !== "dismiss") throw new Error(`questions take an answer, not ${reply.action}`);
      this.updateItem(itemId, (it) =>
        it.type === "question" && it.state === "pending"
          ? { ...it, state: reply.action === "answer" ? "answered" : "dismissed", ...(reply.action === "answer" ? { answers: storedAnswers(it.questions ?? [], reply.answers) } : {}) }
          : it,
      );
      if (reply.action === "dismiss" && this.store.getSession(sessionId)?.status === "awaiting-answer" && !this.sessionState(sessionId).activeTurnId) this.setStatus(sessionId, "idle");
      return;
    }
    const pending = this.questions.get(itemId);
    if (!pending || pending.sessionId !== sessionId) throw new Error(`question ${itemId} is not pending`);
    const handle = await this.handleFor(pending.profileId);
    const item = this.store.getItem(itemId);
    if (pending.kind === "input") {
      if (reply.action !== "answer" && reply.action !== "dismiss") throw new Error(`questions take an answer, not ${reply.action}`);
      const answers = reply.action === "answer" ? reply.answers : [];
      handle.client.respond(pending.requestId, codexAnswers(pending.questions, answers));
      this.closeQuestion(pending, reply.action === "answer" ? "answered" : "dismissed", reply.action === "answer" ? { answers: storedAnswers(pending.questions, answers) } : {});
    } else {
      if (reply.action === "submit") {
        const form = item?.type === "question" ? (item.form ?? []) : [];
        const checked = formContent(form, reply.values);
        if ("error" in checked) throw new Error(checked.error);
        handle.client.respond(pending.requestId, { action: "accept", content: checked.content, _meta: null });
        this.closeQuestion(pending, "answered", { values: checked.content });
      } else if (reply.action === "dismiss") {
        handle.client.respond(pending.requestId, { action: "decline", content: null, _meta: null });
        this.closeQuestion(pending, "dismissed");
      } else throw new Error(`a form takes its values, not ${reply.action}`);
    }
    this.afterAnswer(sessionId);
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

  /** A notice row; the same key again in this turn updates that row (with a count) instead of adding another. */
  private notice(sessionId: Id, level: "info" | "warning", message: string, key: string, turnId?: string): void {
    const st = this.sessionState(sessionId);
    const known = st.notices.get(key);
    const current = known ? this.store.getItem(known) : undefined;
    if (current?.type === "notice") {
      this.updateItem(current.id, (it) => (it.type === "notice" ? { ...it, level, message, count: (it.count ?? 1) + 1 } : it));
      return;
    }
    st.notices.set(key, this.appendItem(sessionId, { type: "notice", level, message, key }, { method: "notice", ...(turnId ? { turnId } : {}) }).id);
  }

  /** A notice for no thread: into the profile's sessions that are working now, or the next one that starts a turn. */
  private serverNotice(profileId: Id, level: "info" | "warning", message: string, key: string): void {
    const running = this.store.listSessions().filter((s) => s.profileId === profileId && s.runtime === "codex" && this.state.get(s.id)?.activeTurnId);
    if (running.length) {
      for (const s of running) this.notice(s.id, level, message, key, this.state.get(s.id)!.activeTurnId!);
      return;
    }
    const queued = this.serverNotices.get(profileId) ?? [];
    if (!queued.some((n) => n.key === key)) queued.push({ level, message, key });
    this.serverNotices.set(profileId, queued);
  }

  private setRetry(sessionId: Id, turnId: string, retry: TurnRetry | null): void {
    const st = this.sessionState(sessionId);
    if (!retry && st.retrying !== turnId) return;
    const id = this.turnItemId(sessionId, turnId);
    if (!id) return;
    st.retrying = retry ? turnId : null;
    this.updateItem(id, (it) => {
      if (it.type !== "turn") return it;
      if (retry) return { ...it, retry };
      if (!it.retry) return it;
      const { retry: _gone, ...rest } = it;
      return rest;
    });
  }

  /** The context the session had before compacting: what its latest turn left. */
  private lastContext(sessionId: Id): number | undefined {
    const turns = this.store.listItems(sessionId).filter((i) => i.type === "turn" && i.usage?.context);
    const last = turns.at(-1);
    return last?.type === "turn" ? last.usage?.context : undefined;
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

  /** After an answer: still waiting for another question or approval, or back to running. */
  private afterAnswer(sessionId: Id): void {
    if ([...this.questions.values()].some((q) => q.sessionId === sessionId)) this.setStatus(sessionId, "awaiting-answer");
    else if ([...this.approvals.values()].some((a) => a.sessionId === sessionId)) this.setStatus(sessionId, "awaiting-approval");
    else if (this.sessionState(sessionId).activeTurnId) this.setStatus(sessionId, "running");
  }

  private closeQuestion(q: PendingQuestion, state: "answered" | "dismissed" | "cancelled", patch: Partial<Extract<SessionItem, { type: "question" }>> = {}): void {
    this.questions.delete(q.itemId);
    this.updateItem(q.itemId, (it) => (it.type === "question" && it.state === "pending" ? { ...it, ...patch, state } : it));
  }

  /** At start-up no request is waiting yet: questions left pending by the last Host are over (servers replay live ones). */
  private cancelStaleQuestions(): void {
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "codex") continue;
      for (const item of this.store.listItems(s.id)) {
        if (item.type === "question" && item.state === "pending" && item.source !== "codex-async") this.updateItem(item.id, (it) => (it.type === "question" ? { ...it, state: "cancelled" } : it));
      }
    }
  }

  /** request_user_input_async questions still open in a session. */
  private openAsyncQuestions(sessionId: Id): SessionItem[] {
    return this.store.listItems(sessionId).filter((it) => it.type === "question" && it.source === "codex-async" && it.state === "pending");
  }

  /** The person wrote: open async questions count as answered by that message. */
  private closeAsyncQuestions(sessionId: Id): void {
    for (const q of this.openAsyncQuestions(sessionId)) this.updateItem(q.id, (it) => (it.type === "question" && it.state === "pending" ? { ...it, state: "answered" } : it));
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

  pendingApprovals(sessionId: Id): string[] {
    return [...this.approvals.values()].filter((a) => a.sessionId === sessionId).map((a) => String(a.requestId));
  }

  // ---- server events ----------------------------------------------------------------------------------------------

  private attach(handle: CodexServerHandle): void {
    if (this.attached.has(handle.client)) return;
    this.attached.add(handle.client);
    // One message Studio cannot handle stays a line in its session (and the log); the server and other sessions go on.
    handle.client.on("notification", (n) => {
      try {
        this.onNotification(handle, n);
      } catch (err) {
        this.handlerFailed(n.method, (n.params as { threadId?: string } | undefined)?.threadId, err);
      }
    });
    handle.client.on("request", (r) => {
      try {
        this.onServerRequest(handle, r);
      } catch (err) {
        this.handlerFailed(r.method, (r.params as { threadId?: string } | undefined)?.threadId, err);
        // Unanswered, the turn would wait for ever.
        handle.client.respondError(r.id, -32603, `AMO Studio could not handle ${r.method}`);
      }
    });
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
    for (const q of [...this.questions.values()]) if (q.profileId === handle.profileId) this.closeQuestion(q, "cancelled");
  }

  private handlerFailed(method: string, threadId: string | undefined, err: unknown): void {
    this.emit("log", `failed to handle ${method}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    const s = threadId ? this.findByThread(threadId) : undefined;
    if (s) this.notice(s.id, "warning", `Studio 处理 Codex 的一条消息（${method}）时出错，这条可能没显示出来：${firstLineOf(err instanceof Error ? err.message : String(err))}。详情在 host.log。`, `handler-error:${method}`);
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

  private onNotification(handle: CodexServerHandle, n: ServerNotification): void {
    switch (n.method) {
      case "thread/started":
        return this.onThreadStarted(handle, n.params.thread);
      case "account/rateLimits/updated": {
        const profile = this.options.profiles.find((p) => p.id === handle.profileId);
        if (profile && profile.provider === null) this.usageCache.set(profile.id, codexUsage(profile, n.params.rateLimits));
        return;
      }
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
        const st = this.sessionState(s.id);
        const turnId = turnKey(st, n.params.turn as { id: string; rootTurnId?: string | null });
        st.activeTurnId = turnId;
        st.notices.clear();
        st.callFirstAt = null;
        this.openTurn(s.id, turnId, n.params.turn.startedAt);
        this.setStatus(s.id, "running");
        const queued = this.serverNotices.get(handle.profileId);
        if (queued?.length) {
          this.serverNotices.delete(handle.profileId);
          for (const q of queued) this.notice(s.id, q.level, q.message, q.key, turnId);
        }
        return;
      }
      case "turn/completed": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.sessionState(s.id);
        const turnId = turnKey(st, n.params.turn as { id: string; rootTurnId?: string | null });
        if (st.activeTurnId === turnId || st.activeTurnId === n.params.turn.id) st.activeTurnId = null;
        this.setRetry(s.id, turnId, null);
        st.reviewTurns.delete(turnId);
        const turn = { ...(n.params.turn as { id: string; status: string; error?: { message: string } | null; startedAt?: number | null; completedAt?: number | null }), id: turnId };
        for (const q of [...this.questions.values()]) if (q.sessionId === s.id) this.closeQuestion(q, "cancelled");
        this.closeTurn(s.id, turn);
        if (turn.status === "failed") {
          this.appendItem(s.id, { type: "error", message: turn.error?.message ?? "turn failed" }, { method: n.method, turnId });
          this.setStatus(s.id, "error");
        } else if (s.kind !== "sub" && this.openAsyncQuestions(s.id).length) {
          this.setStatus(s.id, "awaiting-answer");
        } else {
          this.setStatus(s.id, s.kind === "sub" ? "completed" : "idle");
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        const type = (n.params.item as { type?: string }).type;
        if (n.method === "item/started" && (type === "reasoning" || type === "agentMessage")) this.callOutput(n.params.threadId);
        return this.onItem(n.method, n.params.threadId, n.params.turnId, n.params.item as unknown as CodexItem);
      }
      case "item/agentMessage/delta": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.sessionState(s.id);
        this.callOutput(n.params.threadId);
        // A review's own messages are its raw findings; exitedReviewMode brings the review as written for people.
        if (st.reviewTurns.has(n.params.turnId)) return;
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
        this.callOutput(n.params.threadId);
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
        const st = this.sessionState(s.id);
        const firstAt = st.callFirstAt;
        st.callFirstAt = null;
        const ms = firstAt === null ? 0 : Date.now() - firstAt;
        this.updateItem(id, (it) =>
          it.type === "turn"
            ? {
                ...it,
                usage: addUsage(it.usage, last, modelContextWindow),
                ...(firstAt !== null && last.outputTokens > 0 ? { decode: { ms: (it.decode?.ms ?? 0) + ms, tokens: (it.decode?.tokens ?? 0) + last.outputTokens } } : {}),
              }
            : it,
        );
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
        for (const q of [...this.questions.values()]) {
          if (q.profileId !== handle.profileId || String(q.requestId) !== String(n.params.requestId)) continue;
          // Answered in an attached terminal: what it answered is not known here.
          this.closeQuestion(q, "answered");
          this.afterAnswer(q.sessionId);
        }
        return;
      }
      case "error": {
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        // A retry shows in the running status line (and goes away when the model answers), not as a row.
        if (n.params.willRetry) this.setRetry(s.id, n.params.turnId, codexRetry(n.params.error as CodexTurnError));
        else this.appendItem(s.id, { type: "error", message: n.params.error.message }, { method: n.method, turnId: n.params.turnId });
        return;
      }
      case "thread/compacted": {
        // Deprecated in favour of the contextCompaction item (Codex 0.162 sends only the item); kept for older servers.
        const s = this.findByThread(n.params.threadId);
        if (!s) return;
        if (this.store.listItems(s.id).some((i) => i.type === "compaction" && i.raw?.turnId === n.params.turnId)) return;
        const before = this.lastContext(s.id);
        this.appendItem(s.id, { type: "compaction", state: "completed", ...(before ? { beforeTokens: before } : {}) }, { method: n.method, turnId: n.params.turnId });
        return;
      }
      case "model/rerouted": {
        const s = this.findByThread(n.params.threadId);
        const why = n.params.reason === "highRiskCyberActivity" ? "（涉及高风险网络安全内容）" : "";
        if (s) this.notice(s.id, "warning", `这一轮改用了 ${n.params.toModel}，不是 ${n.params.fromModel}${why}。`, "rerouted", n.params.turnId);
        return;
      }
      case "warning":
      case "guardianWarning": {
        const p = n.params as { threadId: string | null; message: string };
        const s = p.threadId ? this.findByThread(p.threadId) : undefined;
        const level = n.method === "guardianWarning" ? "warning" : "info";
        if (s) this.notice(s.id, level, p.message, `${n.method}:${p.message}`, this.state.get(s.id)?.activeTurnId ?? undefined);
        else if (!p.threadId) this.serverNotice(handle.profileId, level, p.message, `${n.method}:${p.message}`);
        return;
      }
      case "configWarning": {
        const p = n.params as { summary: string; details: string | null; path?: string };
        const message = `Codex 配置有问题：${p.summary}${p.details ? `（${p.details}）` : ""}${p.path ? ` · ${p.path}` : ""}`;
        this.serverNotice(handle.profileId, "warning", message, `${n.method}:${p.summary}`);
        return;
      }
      case "deprecationNotice": {
        // About how Studio calls app-server (e.g. full-history thread/resume in 0.162), not about the person's work.
        const p = n.params as { summary: string; details: string | null };
        this.emit("log", `codex deprecation (${handle.profileId}): ${p.summary}${p.details ? ` (${p.details})` : ""}`);
        return;
      }
      case "mcpServer/startupStatus/updated": {
        const p = n.params as { threadId: string | null; name: string; status: string; error: string | null; failureReason: string | null };
        if (p.status !== "failed") return;
        const message = `MCP 服务 ${p.name} 没能启动${p.failureReason === "reauthenticationRequired" ? "：需要重新登录" : p.error ? `：${firstLineOf(p.error)}` : "。"}`;
        const s = p.threadId ? this.findByThread(p.threadId) : undefined;
        if (s) this.notice(s.id, "warning", message, `mcp:${p.name}`, this.state.get(s.id)?.activeTurnId ?? undefined);
        else this.serverNotice(handle.profileId, "warning", message, `mcp:${p.name}`);
        return;
      }
      case "hook/completed": {
        // Hooks only show when they fail or block.
        const p = n.params as { threadId: string; turnId: string | null; run: { eventName: string; status: string; statusMessage: string | null; sourcePath: string; entries: Array<{ text: string }> } };
        if (p.run.status !== "failed" && p.run.status !== "blocked") return;
        const s = this.findByThread(p.threadId);
        const detail = p.run.statusMessage || p.run.entries.map((e) => e.text).find(Boolean) || "";
        const name = p.run.sourcePath.split(/[\\/]/).at(-1) || p.run.eventName;
        if (s) this.notice(s.id, "warning", `Hook ${name}（${p.run.eventName}）${p.run.status === "blocked" ? "拦截了这一步" : "运行失败"}${detail ? `：${firstLineOf(detail)}` : "。"}`, `hook:${name}`, p.turnId ?? undefined);
        return;
      }
      case "item/mcpToolCall/progress":
      case "item/commandExecution/terminalInteraction": {
        const p = n.params as { threadId: string; itemId: string; message?: string; stdin?: string };
        const s = this.findByThread(p.threadId);
        const itemId = s ? this.sessionState(s.id).items.get(p.itemId) : undefined;
        // Input the agent typed into a running command; an empty write only reads its output.
        const progress = n.method === "item/mcpToolCall/progress" ? p.message?.trim() : p.stdin?.trim() ? `已向命令输入：${p.stdin.trim().slice(0, 200)}` : "";
        if (itemId && progress) this.updateItem(itemId, (it) => (it.type === "tool" ? { ...it, progress } : it));
        return;
      }
      default:
        // Not shown: turn/diff/updated (the turn's changed files come from its edit items), item/fileChange/outputDelta
        // (no longer sent), process/* and command/exec/* (only for processes a client starts), realtime, account
        // and login, fuzzy file search, thread metadata.
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
    if (r.method === USER_INPUT || (r.method === ELICITATION && elicitationForm((r.params as { requestedSchema?: unknown }).requestedSchema))) return this.onQuestion(handle, r);
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

  /** request_user_input, or an MCP form with fields to fill in: a question item instead of an approval. */
  private onQuestion(handle: CodexServerHandle, r: ServerRequest): void {
    const params = r.params as { threadId?: string; turnId?: string | null; itemId?: string; questions?: unknown; message?: string; serverName?: string; requestedSchema?: unknown };
    const s = params.threadId ? this.findByThread(params.threadId) : undefined;
    if (!s) return;
    // Replayed on resubscribe: the item already stands for it.
    if ([...this.questions.values()].some((q) => q.profileId === handle.profileId && String(q.requestId) === String(r.id))) return;
    const raw = { method: r.method, ...(params.itemId ? { itemId: params.itemId } : {}), ...(params.turnId ? { turnId: params.turnId } : {}) };
    const questions = r.method === USER_INPUT ? inputQuestions(params.questions) : [];
    const item =
      r.method === USER_INPUT
        ? this.appendItem(s.id, { type: "question", source: "codex-input", questions, state: "pending" }, raw)
        : this.appendItem(
            s.id,
            { type: "question", source: "mcp-form", message: params.message ?? "", form: elicitationForm(params.requestedSchema)!, ...(params.serverName ? { serverName: params.serverName } : {}), state: "pending" },
            raw,
          );
    this.questions.set(item.id, { kind: r.method === USER_INPUT ? "input" : "form", sessionId: s.id, itemId: item.id, profileId: handle.profileId, requestId: r.id, questions });
    this.setStatus(s.id, "awaiting-answer");
  }

  private onItem(method: "item/started" | "item/completed", threadId: string, turnId: string, item: CodexItem): void {
    const s = this.findByThread(threadId);
    if (!s) return;
    const st = this.sessionState(s.id);
    const raw = { method, itemId: item.id, turnId };
    const done = method === "item/completed";
    const review = st.reviewTurns.has(turnId);
    // The model answered: a retry it was making is over.
    if (item.type !== "userMessage" && st.retrying === turnId) this.setRetry(s.id, turnId, null);
    switch (item.type) {
      case "userMessage": {
        // In review mode the message is Codex's own review prompt (the person's /code-review opened the turn).
        if (!done || review) return;
        const content = (item.content ?? []) as Array<{ type?: string; text?: unknown; path?: unknown }>;
        const text = content.map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : "")).join("");
        const images = content.filter((c) => c?.type === "localImage" && typeof c.path === "string").map((c) => messageImage(c.path as string));
        this.appendItem(s.id, { type: "user", text, ...(images.length ? { images } : {}) }, raw);
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
        if (review) return;
        // request_user_input_async: the model asks and carries on; the questions become a card, the answer a message.
        const asked = item.delivery === "async" ? asyncPrompts(item.questions) : [];
        if (asked.length) {
          if (!st.items.has(item.id)) st.items.set(item.id, this.appendItem(s.id, { type: "question", source: "codex-async", state: "pending", questions: asked }, raw).id);
          return;
        }
        const itemId = this.ensureAgentItem(s.id, item.id, turnId);
        if (done) {
          this.updateItem(itemId, (it) => (it.type === "agent" ? { ...it, markdown: item.text ?? st.text.get(item.id) ?? "", streaming: false } : it));
          st.text.delete(item.id);
        }
        return;
      }
      case "contextCompaction": {
        const existing = st.items.get(item.id);
        if (!existing) {
          const before = this.lastContext(s.id);
          st.items.set(item.id, this.appendItem(s.id, { type: "compaction", state: done ? "completed" : "running", ...(before ? { beforeTokens: before } : {}) }, raw).id);
        } else if (done) {
          this.updateItem(existing, (it) => (it.type === "compaction" ? { ...it, state: "completed" } : it));
        }
        return;
      }
      case "enteredReviewMode": {
        st.reviewTurns.add(turnId);
        if (!done || st.items.has(item.id)) return;
        this.openTurn(s.id, turnId, null);
        const what = item.review && item.review !== "current changes" ? item.review : "当前未提交的改动";
        st.items.set(item.id, this.appendItem(s.id, { type: "notice", level: "info", message: `Codex 开始审查：${what}` }, raw).id);
        return;
      }
      case "exitedReviewMode": {
        // The review as written for people: the turn's answer.
        if (!done || st.items.has(item.id)) return;
        st.items.set(item.id, this.appendItem(s.id, { type: "agent", markdown: item.review?.trim() || "（审查没有给出结论）", streaming: false }, raw).id);
        return;
      }
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "webSearch":
      case "imageView":
      case "imageGeneration":
      case "hookPrompt":
      case "collabAgentToolCall":
      case "sleep":
      case "functionCallOutput": {
        const tool = describeTool(item, this.store.getWorkspace(s.workspaceId)?.path, done);
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
        // userMessage aside, the remaining types (plan text, reasoning) are handled above or by their own events.
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
  /** A new or forked thread: the profile's provider and model, what Studio tells every session, the AMO identity. */
  private threadParams(profile: ModelProfile, token: string | undefined) {
    const base = { ...codexThreadParams(profile), developerInstructions: studioInstructions("codex") };
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

  /** The model call streaming in this thread gave output: its first one starts its generation time. */
  private callOutput(threadId: string): void {
    const s = this.findByThread(threadId);
    if (!s) return;
    const st = this.sessionState(s.id);
    if (st.callFirstAt === null) st.callFirstAt = Date.now();
  }

  private sessionState(id: Id): SessionState {
    let st = this.state.get(id);
    if (!st) {
      st = { activeTurnId: null, items: new Map(), text: new Map(), turns: new Map(), reasoning: new Map(), reviewTurns: new Set(), notices: new Map(), retrying: null, callFirstAt: null };
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

/** request_user_input's questions as Studio shows them: free text when there are no options, or `isOther`. */
export function inputQuestions(list: unknown): QuestionPrompt[] {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return (Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [])
    .filter((q) => q && typeof q === "object" && str(q.id))
    .map((q) => {
      const options = (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [])
        .filter((o) => o && typeof o === "object" && str(o.label))
        .map((o) => ({ label: str(o.label), ...(str(o.description) ? { description: str(o.description) } : {}) }));
      return {
        id: str(q.id),
        question: str(q.question) || str(q.header) || str(q.id),
        ...(str(q.header) ? { header: str(q.header) } : {}),
        options,
        ...(q.isOther === true || !options.length ? { other: true } : {}),
        ...(q.isSecret === true ? { secret: true } : {}),
      };
    });
}

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
  /** agentMessage from request_user_input_async: "async", with the questions asked. */
  delivery?: string | null;
  questions?: unknown;
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
  // stage 12, S12-E: the remaining item types
  path?: string;
  savedPath?: string;
  revisedPrompt?: string | null;
  failure?: { type: string } | null;
  fragments?: Array<{ text: string }>;
  receiverThreadIds?: string[];
  prompt?: string | null;
  name?: string;
  output?: unknown;
  review?: string;
}

type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

function toolStatus(status: string | undefined): ToolStatus {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : status === "declined" ? "declined" : "running";
}

/**
 * Row fields for a Codex item; `workspace` is the session's folder (paths inside it are shown relative). `done`: the
 * item is complete (items without a status of their own are then completed).
 */
export function describeTool(item: CodexItem, workspace?: string, done = true): ToolFields {
  const status = item.status === undefined ? (done ? "completed" : "running") : toolStatus(item.status);
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
    case "imageView": {
      const path = item.path ?? "";
      return { name: "view_image", kind: "read", summary: shortPath(path, base), ...(path ? { images: [{ id: null, path }] } : {}), status: done ? "completed" : "running" };
    }
    case "imageGeneration": {
      // `result` is the image itself (base64); only a saved file is shown.
      const failed = !!item.failure;
      return {
        name: "image_generation",
        kind: "other",
        summary: item.revisedPrompt?.trim() || "生成图片",
        ...(item.savedPath ? { images: [{ id: null, path: item.savedPath }] } : {}),
        ...(failed ? { detail: item.failure!.type === "usageLimitExceeded" ? "生成图片的额度用完了" : item.failure!.type } : {}),
        status: failed ? "failed" : done ? "completed" : "running",
      };
    }
    case "hookPrompt": {
      const text = (item.fragments ?? []).map((f) => f.text).filter(Boolean).join("\n\n");
      return { name: "hook_prompt", kind: "other", summary: "Hook 补充了提示", ...(text ? { detail: tail(text) } : {}), status: "completed" };
    }
    case "collabAgentToolCall": {
      const receivers = item.receiverThreadIds?.length ?? 0;
      const summary = item.prompt?.trim().split("\n")[0]?.slice(0, 120) || (receivers ? `${receivers} 个子 agent` : "");
      const s = item.status === "inProgress" ? "running" : item.status === "failed" ? "failed" : item.status === "interrupted" ? "declined" : done ? "completed" : "running";
      return { name: `collab.${item.tool ?? ""}`, kind: "subagent", summary, ...(item.prompt ? { input: item.prompt } : {}), status: s };
    }
    case "sleep":
      return { name: "sleep", kind: "other", summary: `等待 ${Math.max(1, Math.round((item.durationMs ?? 0) / 1000))} 秒`, ...timing, status: done ? "completed" : "running" };
    case "functionCallOutput": {
      const output = typeof item.output === "string" ? item.output : contentText(item.output);
      return { name: [item.namespace, item.name].filter(Boolean).join(".") || "function", kind: "other", summary: "", ...(output ? { detail: tail(output) } : {}), status: "completed" };
    }
    default:
      return { name: item.tool ?? item.type, kind: "other", summary: "", status };
  }
}

/** The turn a turn event belongs to: a review's follow-up turn counts as the review's own (see reviewTurns). */
function turnKey(st: { reviewTurns: Set<string> }, turn: { id: string; rootTurnId?: string | null }): string {
  return turn.rootTurnId && turn.rootTurnId !== turn.id && st.reviewTurns.has(turn.rootTurnId) ? turn.rootTurnId : turn.id;
}

/** A skill as skills/list describes it (the fields the runtime reads). */
interface CodexSkill {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  enabled?: boolean;
}

/** `/code-review` arguments: nothing (uncommitted changes), `base <branch>`, `commit <sha>`, or review instructions. */
export function reviewTarget(args: string): Record<string, unknown> {
  const text = args.trim();
  const base = /^base\s+(\S+)$/i.exec(text);
  if (base) return { type: "baseBranch", branch: base[1] };
  const commit = /^commit\s+([0-9a-f]{4,40})$/i.exec(text);
  if (commit) return { type: "commit", sha: commit[1], title: null };
  return text ? { type: "custom", instructions: text } : { type: "uncommittedChanges" };
}

interface CodexTurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

const RETRY_REASONS: Record<string, string> = {
  responseStreamDisconnected: "连接中断",
  responseStreamConnectionFailed: "连接失败",
  httpConnectionFailed: "连接失败",
  serverOverloaded: "服务繁忙",
  rateLimitExceeded: "触发限流",
  internalServerError: "服务出错",
};

/** An `error` with willRetry: "Reconnecting... 2/5" and why. */
export function codexRetry(error: CodexTurnError): TurnRetry {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(error.message);
  const info = error.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  const reason = (code && RETRY_REASONS[code]) || firstLineOf(error.additionalDetails || error.message);
  return { attempt: m ? Number(m[1]) : 1, ...(m ? { max: Number(m[2]) } : {}), reason };
}

const firstLineOf = (text: string) => text.split(/\r?\n/)[0]!.trim().slice(0, 200);

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

/** Adds one model call (`last`) to the turn's usage; the context is what that call left in it. */
function addUsage(prev: TurnUsage | undefined, last: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens?: number }, window: number | null): TurnUsage {
  return {
    input: (prev?.input ?? 0) + last.inputTokens,
    cachedInput: (prev?.cachedInput ?? 0) + last.cachedInputTokens,
    output: (prev?.output ?? 0) + last.outputTokens,
    reasoning: (prev?.reasoning ?? 0) + last.reasoningOutputTokens,
    // A compaction's call reports no input or output, only the size of what it left.
    context: last.inputTokens + last.outputTokens || (last.totalTokens ?? 0),
    ...(window ? { contextWindow: window } : {}),
  };
}

type CodexRateWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
type GetAccountRateLimitsResponse = { rateLimits: { primary: CodexRateWindow; secondary: CodexRateWindow } };

const windowLabel = (mins: number | null) =>
  mins === null ? "额度" : mins === 300 ? "5 小时" : mins === 10080 ? "每周" : mins === 1440 ? "每天" : mins % 60 === 0 ? `${mins / 60} 小时` : `${mins} 分钟`;

/** A Codex rate-limit snapshot as the windows Studio shows (resetsAt comes in epoch seconds). */
export function codexUsage(profile: ModelProfile, limits: { primary: CodexRateWindow; secondary: CodexRateWindow }): AccountUsage {
  const windows = [limits.primary, limits.secondary]
    .filter((w): w is NonNullable<CodexRateWindow> => !!w)
    .map((w) => ({ label: windowLabel(w.windowDurationMins), usedPercent: w.usedPercent, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }));
  return { profileId: profile.id, label: profile.label, windows, note: windows.length ? null : "这个账号没有用量限制", updatedAt: new Date().toISOString() };
}
