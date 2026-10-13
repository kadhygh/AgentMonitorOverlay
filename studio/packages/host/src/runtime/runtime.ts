import { EventEmitter } from "node:events";
import type { ApprovalDecision, HostEvent, Id, ModelProfile, ProfileChoices, Session, SessionItem, SessionOptions, SessionRuntime, SessionStatus, Workspace } from "@amo-studio/protocol";
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
  startSession(input: { taskId: Id; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }): Promise<Session>;
  /** Models (with efforts) and permission settings the profile's CLI offers. */
  choices(profileId: Id): Promise<ProfileChoices>;
  /** Switches the session's model, effort or permissions (Claude: at once; Codex: from the next turn). */
  setOptions(sessionId: Id, options: SessionOptions): Promise<Session>;
  /** Starts a turn; while one runs, Codex steers it and Claude queues the message for the next turn. */
  sendMessage(sessionId: Id, text: string): Promise<{ mode: SendMode }>;
  interrupt(sessionId: Id): Promise<void>;
  fork(sessionId: Id, profileId?: Id): Promise<Session>;
  archive(sessionId: Id): Promise<Session[]>;
  unarchive(sessionId: Id): Promise<Session[]>;
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void>;
  /** Codex only: where an attached TUI connects. */
  attachInfo(sessionId: Id): Promise<{ url: string; token: string; threadId: string }>;
  setWriter(sessionId: Id, writer: Session["writer"]): Session;
  /** Claude only: hand the session to `claude --resume` in a terminal (Studio read-only meanwhile). */
  handoff?(sessionId: Id): Promise<{ command: string; cwd: string; env: Record<string, string> }>;
  /** Claude only: take a handed-off session back, importing what the terminal added. */
  reclaim?(sessionId: Id): Promise<Session>;
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
  sendMessage(sessionId: Id, text: string) {
    return this.forSession(sessionId).sendMessage(sessionId, text);
  }
  choices(profileId: Id) {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`unknown profile ${profileId}`);
    return this.byRuntime(profile.runtime).choices(profileId);
  }
  setOptions(sessionId: Id, options: SessionOptions) {
    return this.forSession(sessionId).setOptions(sessionId, options);
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

  protected createSession(input: { taskId: Id; parentId: Id | null; kind: Session["kind"]; profileId: Id; workspaceId: Id; title: string; runtimeRef: string; options?: SessionOptions }): Session {
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
