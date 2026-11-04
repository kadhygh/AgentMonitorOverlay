import { EventEmitter } from "node:events";
import type { ApprovalDecision, Attachment, ChatSettings, HostEvent, Id, ModelProfile, ProfileChoices, QuestionReply, Session, SessionItem, SessionOptions, SessionRuntime, SessionStatus, SlashCommandList, SlashCommandResult, Workspace, AccountUsage, McpApply } from "@amo-studio/protocol";
import { newId, type HostEventInput, type SessionItemInput, type Store } from "../store/store.js";
import { withDelivery } from "./items.js";
import { profileGone } from "./profiles.js";

// What HostService needs from a runtime, and a router that sends each call to the runtime a session (or profile)
// belongs to. Codex and Claude implement the same operations; a few are runtime-specific (see the comments).

export type SendMode = "start" | "steer" | "queue";

/** `now` (立即发送, 2026-11-02): while a turn runs, the model reads the message at once (the turn's step gives way). */
export interface SendOptions {
  now?: boolean;
}

export interface RuntimeEvents {
  /** Every change, already persisted (except `item.delta`, which carries the last persisted seq). */
  event: [HostEvent];
  log: [string];
}

export interface SessionRuntimeApi {
  startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }): Promise<Session>;
  /** Models (with efforts) and permission settings the profile's CLI offers. */
  choices(profileId: Id): Promise<ProfileChoices>;
  /** Switches the session's model, effort or permissions (Claude: at once; Codex: from the next turn). */
  setOptions(sessionId: Id, options: SessionOptions): Promise<Session>;
  /**
   * Renames the session in its runtime (Codex thread name, Claude session title), so the CLI's own resume lists show
   * it too; the stored title follows.
   */
  rename(sessionId: Id, title: string): Promise<Session>;
  /**
   * Starts a turn; while one runs, Codex steers it and Claude queues the message for the next turn. `images` go along
   * (Codex reads them from their path, Claude gets them as image blocks); `text` may be empty when there are some.
   */
  sendMessage(sessionId: Id, text: string, images?: readonly Attachment[], options?: SendOptions): Promise<{ mode: SendMode }>;
  interrupt(sessionId: Id): Promise<void>;
  /**
   * 立即发送 (2026-11-02, Claude and Codex): a message still waiting (`delivery: "waiting"`) is read by the model now —
   * the running turn gives way, as the CLIs' Send now does. Nothing when it is not waiting any more.
   */
  sendNow?(sessionId: Id, itemId: Id): Promise<void>;
  /** 重新发送 a message its process never read (`delivery: "unsent"`): the same item goes again, with its `images`. */
  resend?(sessionId: Id, itemId: Id, images: readonly Attachment[]): Promise<{ mode: SendMode }>;
  fork(sessionId: Id, profileId?: Id): Promise<Session>;
  archive(sessionId: Id): Promise<Session[]>;
  unarchive(sessionId: Id): Promise<Session[]>;
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void>;
  /** Answers a pending `question` item (stage 12): the reply must fit its source (see QuestionReply). */
  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void>;
  /** A subscription's quota use, for profiles that have one; null otherwise. `refresh`: ask the account now. */
  usage?(profileId: Id, refresh: boolean): Promise<AccountUsage | AccountUsage[] | null>;
  /** Codex only: where an attached TUI connects. */
  attachInfo(sessionId: Id): Promise<{ url: string; token: string; threadId: string }>;
  setWriter(sessionId: Id, writer: Session["writer"]): Session;
  /** Claude only: hand the session to `claude --resume` in a terminal (Studio read-only meanwhile). */
  handoff?(sessionId: Id): Promise<{ command: string; cwd: string; env: Record<string, string> }>;
  /** Claude only: take a handed-off session back, importing what the terminal added. */
  reclaim?(sessionId: Id): Promise<Session>;
  /** The runtime's own `/` commands and skills for the session (stage 12, S12-E); Studio's are added by the Host. */
  listCommands?(sessionId: Id): Promise<SlashCommandList>;
  /** Runs one (`compact` included); see `POST /api/sessions/:id/commands`. */
  runCommand?(sessionId: Id, name: string, args: string): Promise<SlashCommandResult>;
  /** Stops a background command (Claude only). */
  stopBackground?(sessionId: Id, taskId: string): Promise<void>;
  /** Claude only (stage 15): stop the session's loop, or switch going on by itself after a usage limit. */
  setWakeChoice?(sessionId: Id, choice: { stopLoop?: boolean; autoContinue?: boolean }): Promise<Session>;
  /** The conversation settings changed: running sessions follow where the runtime can. */
  applyChatSettings?(settings: ChatSettings): void;
  /**
   * MCP 设置 (2026-11-04): the session's MCP may have changed (its own choices, its project's, the global ones or a
   * server's): a running process takes it as the runtime can (see McpApply). Claude and DSH.
   */
  refreshMcp?(sessionId: Id): Promise<McpApply>;
  /** Claude: the MCP servers of the session's running process as it reports them now; null when none runs. */
  mcpStatus?(sessionId: Id): Promise<Array<{ name: string; status: string; error?: string; source?: string }> | null>;
  on(event: "event", listener: (e: HostEvent) => void): unknown;
  on(event: "log", listener: (line: string) => void): unknown;
}

/** Routes calls to the runtime of the session, or of the profile for new sessions. */
export class RuntimeRouter extends EventEmitter<RuntimeEvents> implements SessionRuntimeApi {
  constructor(
    private readonly store: Store,
    private readonly profiles: readonly ModelProfile[],
    private readonly runtimes: Partial<Record<SessionRuntime, SessionRuntimeApi>>,
  ) {
    super();
    for (const r of Object.values(runtimes)) {
      r.on("event", (e) => this.emit("event", e));
      r.on("log", (line) => this.emit("log", line));
    }
  }

  private byRuntime(runtime: SessionRuntime): SessionRuntimeApi {
    const r = this.runtimes[runtime];
    if (!r) throw new Error(`the ${runtime} runtime is not available in this Host`);
    return r;
  }

  private forSession(sessionId: Id): SessionRuntimeApi {
    const s = this.store.getSession(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);
    return this.byRuntime(s.runtime);
  }

  startSession(input: Parameters<SessionRuntimeApi["startSession"]>[0]) {
    const profile = this.profiles.find((p) => p.id === input.profileId);
    if (!profile) throw new Error(`unknown profile ${input.profileId}`);
    return this.byRuntime(profile.runtime).startSession(input);
  }
  sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], options: SendOptions = {}) {
    return this.forSession(sessionId).sendMessage(sessionId, text, images, options);
  }
  sendNow(sessionId: Id, itemId: Id): Promise<void> {
    const r = this.forSession(sessionId);
    if (!r.sendNow) throw Object.assign(new Error("这种会话不能立即发送：消息会在这一轮结束后发出"), { code: "bad_request" });
    return r.sendNow(sessionId, itemId);
  }
  resend(sessionId: Id, itemId: Id, images: readonly Attachment[] = []): Promise<{ mode: SendMode }> {
    const r = this.forSession(sessionId);
    if (!r.resend) throw Object.assign(new Error("这种会话不能重新发送消息"), { code: "bad_request" });
    return r.resend(sessionId, itemId, images);
  }
  choices(profileId: Id) {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`unknown profile ${profileId}`);
    return this.byRuntime(profile.runtime).choices(profileId);
  }
  setOptions(sessionId: Id, options: SessionOptions) {
    return this.forSession(sessionId).setOptions(sessionId, options);
  }
  async usage(profileId: Id, refresh: boolean): Promise<AccountUsage | AccountUsage[] | null> {
    const profile = this.profiles.find((p) => p.id === profileId);
    const r = profile ? this.runtimes[profile.runtime] : undefined;
    return r?.usage ? r.usage(profileId, refresh) : null;
  }
  rename(sessionId: Id, title: string) {
    return this.forSession(sessionId).rename(sessionId, title);
  }
  interrupt(sessionId: Id) {
    return this.forSession(sessionId).interrupt(sessionId);
  }
  fork(sessionId: Id, profileId?: Id) {
    return this.forSession(sessionId).fork(sessionId, profileId);
  }
  archive(sessionId: Id) {
    return this.forSession(sessionId).archive(sessionId);
  }
  unarchive(sessionId: Id) {
    return this.forSession(sessionId).unarchive(sessionId);
  }
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision) {
    return this.forSession(sessionId).respondApproval(sessionId, approvalId, decision);
  }
  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply) {
    return this.forSession(sessionId).answerQuestion(sessionId, itemId, reply);
  }
  attachInfo(sessionId: Id) {
    return this.forSession(sessionId).attachInfo(sessionId);
  }
  setWriter(sessionId: Id, writer: Session["writer"]) {
    return this.forSession(sessionId).setWriter(sessionId, writer);
  }
  handoff(sessionId: Id) {
    const r = this.forSession(sessionId);
    if (!r.handoff) throw new Error("this runtime does not hand sessions to a terminal");
    return r.handoff(sessionId);
  }
  async reclaim(sessionId: Id): Promise<Session> {
    const r = this.forSession(sessionId);
    return r.reclaim ? r.reclaim(sessionId) : r.setWriter(sessionId, "workbench");
  }
  async listCommands(sessionId: Id): Promise<SlashCommandList> {
    const r = this.forSession(sessionId);
    return r.listCommands ? r.listCommands(sessionId) : { commands: [] };
  }
  runCommand(sessionId: Id, name: string, args: string): Promise<SlashCommandResult> {
    const r = this.forSession(sessionId);
    if (!r.runCommand) throw new Error("this runtime has no commands");
    return r.runCommand(sessionId, name, args);
  }
  stopBackground(sessionId: Id, taskId: string): Promise<void> {
    const r = this.forSession(sessionId);
    if (!r.stopBackground) throw new Error("this runtime has no background commands");
    return r.stopBackground(sessionId, taskId);
  }
  setWakeChoice(sessionId: Id, choice: { stopLoop?: boolean; autoContinue?: boolean }): Promise<Session> {
    const r = this.forSession(sessionId);
    if (!r.setWakeChoice) throw new Error("this runtime has no loop");
    return r.setWakeChoice(sessionId, choice);
  }
  applyChatSettings(settings: ChatSettings): void {
    for (const r of Object.values(this.runtimes)) r.applyChatSettings?.(settings);
  }
  async refreshMcp(sessionId: Id): Promise<McpApply> {
    const r = this.forSession(sessionId);
    return r.refreshMcp ? r.refreshMcp(sessionId) : "codex-restart";
  }
  async mcpStatus(sessionId: Id): Promise<Array<{ name: string; status: string; error?: string; source?: string }> | null> {
    const r = this.forSession(sessionId);
    return r.mcpStatus ? r.mcpStatus(sessionId) : null;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewItemBody = DistributiveOmit<SessionItemInput, "id" | "sessionId" | "createdAt">;

export interface NewSessionInput {
  taskId: Id | null;
  topicId: Id | null;
  parentId: Id | null;
  kind: Session["kind"];
  profileId: Id;
  workspaceId: Id;
  title: string;
  runtimeRef: string;
  options?: SessionOptions;
}

/**
 * A runtime's persistence helpers, bound, for the parts it is split into (stage 16): they write through the runtime, so
 * every change is still stored, published and emitted the same way.
 */
export interface RuntimeCore {
  readonly store: Store;
  now(): Date;
  log(line: string): void;
  requireSession(id: Id): Session;
  createSession(input: NewSessionInput): Session;
  updateSession(id: Id, patch: Parameters<Store["updateSession"]>[1]): Session;
  setStatus(id: Id, status: SessionStatus): void;
  appendItem(sessionId: Id, body: NewItemBody, raw?: { method: string; itemId?: string; turnId?: string }): SessionItem;
  updateItem(itemId: Id, fn: (item: SessionItem) => SessionItem): void;
  emitTransient(event: HostEventInput): void;
}

/** How long 停止 waits on the runtime before Studio stops waiting (each runtime's own way; see armStopGrace). */
export const STOP_GRACE_MS = 15_000;

/**
 * Shared persistence helpers (every change is stored, turned into a Host event and emitted), and what every runtime
 * does the same way (2026-11-04, plans/message-delivery.md: each had its own copy, a little different): whether a
 * session takes messages, archiving, settling what a cut-off turn left open, and the 停止 fallback.
 */
export abstract class RuntimeBase extends EventEmitter<RuntimeEvents> {
  protected constructor(
    protected readonly store: Store,
    protected readonly runtimeName: SessionRuntime,
    protected readonly now: () => Date = () => new Date(),
    private readonly knownProfiles: readonly ModelProfile[] = [],
  ) {
    super();
  }

  /**
   * The session, when it can take a message: not archived, not handed to a terminal (Claude's 在终端打开), its model
   * channel still there (profileGone says why not), started in its runtime.
   */
  protected writable(id: Id): Session {
    const s = this.requireSession(id);
    if (s.archivedAt || s.writer === "archived") throw Object.assign(new Error("这个会话已归档，不能再发消息"), { code: "read_only" });
    if (s.writer === "terminal-handoff") throw Object.assign(new Error("这个会话交给终端了（在终端打开）：收回到 Studio 后才能在这里发消息"), { code: "read_only" });
    if (!this.knownProfiles.some((p) => p.id === s.profileId)) throw profileGone(s.profileId);
    if (!s.runtimeRef) throw new Error(`session ${id} has no ${this.runtimeName} session yet`);
    return s;
  }

  /** Archives the session with what hangs under it (branches, subagents); each runtime then closes its own. */
  protected archiveTree(sessionId: Id): Session[] {
    const changed = this.store.archiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    return changed;
  }

  protected unarchiveTree(sessionId: Id): Session[] {
    const changed = this.store.unarchiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    return changed;
  }

  /**
   * What a turn cut off from outside (a Host restart, the runtime's process gone) left open, closed: the turn
   * (interrupted), streaming text, tools (failed — they may have run part way, so not 「未执行」), background commands,
   * compaction, messages the model never read (unsent: 重新发送), and with `approvals` the ones still pending
   * (resolved-elsewhere: the person did not decline them). Messages held in Studio's inbox stay: they are Studio's to
   * send. Returns whether a running turn was cut off.
   */
  protected settleLeftovers(sessionId: Id, opts: { approvals?: boolean } = {}): boolean {
    let cut = false;
    const at = this.now().toISOString();
    for (const item of this.store.listUnfinishedItems(sessionId)) {
      if (item.type === "turn" && item.state === "running") {
        cut = true;
        this.updateItem(item.id, (it) => (it.type === "turn" && it.state === "running" ? { ...it, state: "interrupted", endedAt: at } : it));
      } else if (item.type === "agent" && item.streaming) this.updateItem(item.id, (it) => (it.type === "agent" ? { ...it, streaming: false } : it));
      else if (item.type === "reasoning" && item.streaming) this.updateItem(item.id, (it) => (it.type === "reasoning" ? { ...it, streaming: false } : it));
      else if (item.type === "tool" && item.status === "running") this.updateItem(item.id, (it) => (it.type === "tool" ? { ...it, status: "failed" } : it));
      else if (item.type === "background" && item.state === "running") this.updateItem(item.id, (it) => (it.type === "background" ? { ...it, state: "stopped" } : it));
      else if (item.type === "compaction" && item.state === "running") this.updateItem(item.id, (it) => (it.type === "compaction" ? { ...it, state: "failed" } : it));
      else if (item.type === "user" && item.delivery === "waiting") this.updateItem(item.id, (it) => (it.type === "user" ? withDelivery(it, "unsent") : it));
      else if (opts.approvals && item.type === "approval" && item.state === "pending") this.updateItem(item.id, (it) => (it.type === "approval" ? { ...it, state: "resolved-elsewhere" } : it));
    }
    return cut;
  }

  /**
   * 停止's fallback (2026-11-01 for Claude, 2026-11-04 for all): when the runtime has not ended the turn `ms` after
   * 停止 (`stillRunning`), `giveUp` ends it Studio's way (closing a process, or settling the turn here) and the session
   * says so — it is not left 正在工作 until a restart.
   */
  protected armStopGrace(sessionId: Id, ms: number, stillRunning: () => boolean, giveUp: () => void, what: string): void {
    setTimeout(() => {
      if (!stillRunning()) return;
      this.emit("log", `${sessionId}: the ${this.runtimeName} turn did not stop within ${ms} ms; ${what}`);
      giveUp();
    }, ms).unref?.();
  }

  /** The helpers for the runtime's parts; overrides (an appendItem that adds the turn) apply. */
  protected makeCore(): RuntimeCore {
    return {
      store: this.store,
      now: () => this.now(),
      log: (line) => this.emit("log", line),
      requireSession: (id) => this.requireSession(id),
      createSession: (input) => this.createSession(input),
      updateSession: (id, patch) => this.updateSession(id, patch),
      setStatus: (id, status) => this.setStatus(id, status),
      appendItem: (sessionId, body, raw) => this.appendItem(sessionId, body, raw),
      updateItem: (itemId, fn) => this.updateItem(itemId, fn),
      emitTransient: (event) => this.emitTransient(event),
    };
  }

  protected requireSession(id: Id): Session {
    const s = this.store.getSession(id);
    if (!s) throw new Error(`session ${id} not found`);
    return s;
  }

  protected createSession(input: NewSessionInput): Session {
    const s = this.store.createSession({ ...input, runtime: this.runtimeName, status: "idle", writer: "workbench" });
    this.publish({ type: "session.upserted", session: s });
    return s;
  }

  protected updateSession(id: Id, patch: Parameters<Store["updateSession"]>[1]): Session {
    const s = this.store.updateSession(id, patch);
    this.publish({ type: "session.upserted", session: s });
    return s;
  }

  protected setStatus(id: Id, status: SessionStatus): void {
    const s = this.store.getSession(id);
    if (s && s.status !== status) this.updateSession(id, { status });
  }

  protected appendItem(sessionId: Id, body: NewItemBody, raw?: { method: string; itemId?: string; turnId?: string }): SessionItem {
    const item = this.store.appendItem({
      ...body,
      id: newId("i"),
      sessionId,
      createdAt: this.now().toISOString(),
      ...(raw ? { raw: { runtime: this.runtimeName, ...raw } } : {}),
    } as SessionItemInput);
    this.publish({ type: "item.appended", item });
    return item;
  }

  protected updateItem(itemId: Id, fn: (item: SessionItem) => SessionItem): void {
    const current = this.store.getItem(itemId);
    if (!current) return;
    const next = fn(current);
    if (next === current) return;
    this.publish({ type: "item.updated", item: this.store.replaceItem(next) });
  }

  protected publish(event: HostEventInput): HostEvent {
    const persisted = this.store.appendEvent(event);
    this.emit("event", persisted);
    return persisted;
  }

  protected emitTransient(event: HostEventInput): void {
    this.emit("event", { ...event, seq: this.store.lastEventSeq() } as HostEvent);
  }
}
