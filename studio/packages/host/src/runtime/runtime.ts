import { EventEmitter } from "node:events";
import type { ApprovalDecision, Attachment, ChatSettings, HostEvent, Id, ModelProfile, ProfileChoices, QuestionReply, Session, SessionItem, SessionOptions, SessionRuntime, SessionStatus, SlashCommandList, SlashCommandResult, Workspace, AccountUsage } from "@amo-studio/protocol";
import { newId, type HostEventInput, type SessionItemInput, type Store } from "../store/store.js";

// What HostService needs from a runtime, and a router that sends each call to the runtime a session (or profile)
// belongs to. Codex and Claude implement the same operations; a few are runtime-specific (see the comments).

export type SendMode = "start" | "steer" | "queue";

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
  sendMessage(sessionId: Id, text: string, images?: readonly Attachment[]): Promise<{ mode: SendMode }>;
  interrupt(sessionId: Id): Promise<void>;
  fork(sessionId: Id, profileId?: Id): Promise<Session>;
  archive(sessionId: Id): Promise<Session[]>;
  unarchive(sessionId: Id): Promise<Session[]>;
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void>;
  /** Answers a pending `question` item (stage 12): the reply must fit its source (see QuestionReply). */
  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void>;
  /** A subscription's quota use, for profiles that have one; null otherwise. `refresh`: ask the account now. */
  usage?(profileId: Id, refresh: boolean): Promise<AccountUsage | null>;
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
  /** The conversation settings changed: running sessions follow where the runtime can. */
  applyChatSettings?(settings: ChatSettings): void;
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
  sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = []) {
    return this.forSession(sessionId).sendMessage(sessionId, text, images);
  }
  choices(profileId: Id) {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`unknown profile ${profileId}`);
    return this.byRuntime(profile.runtime).choices(profileId);
  }
  setOptions(sessionId: Id, options: SessionOptions) {
    return this.forSession(sessionId).setOptions(sessionId, options);
  }
  async usage(profileId: Id, refresh: boolean): Promise<AccountUsage | null> {
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
  applyChatSettings(settings: ChatSettings): void {
    for (const r of Object.values(this.runtimes)) r.applyChatSettings?.(settings);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewItemBody = DistributiveOmit<SessionItemInput, "id" | "sessionId" | "createdAt">;

/** Shared persistence helpers: every change is stored, turned into a Host event and emitted. */
export abstract class RuntimeBase extends EventEmitter<RuntimeEvents> {
  protected constructor(
    protected readonly store: Store,
    protected readonly runtimeName: SessionRuntime,
    protected readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  protected requireSession(id: Id): Session {
    const s = this.store.getSession(id);
    if (!s) throw new Error(`session ${id} not found`);
    return s;
  }

  protected createSession(input: { taskId: Id | null; topicId: Id | null; parentId: Id | null; kind: Session["kind"]; profileId: Id; workspaceId: Id; title: string; runtimeRef: string; options?: SessionOptions }): Session {
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
