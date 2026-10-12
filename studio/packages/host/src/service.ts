import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  Annotation,
  ApprovalDecision,
  HostErrorCode,
  HostEvent,
  Id,
  ModelProfile,
  NewAnnotationInput,
  NewSessionInput,
  Scratchpad,
  Session,
  SessionItem,
  StateSnapshot,
  Task,
  TerminalAttach,
  TaskColumn,
  TaskScope,
  Workspace,
} from "@amo-studio/protocol";
import { composeAnnotationMessage, TASK_COLUMNS } from "@amo-studio/protocol";
import { newId, type HostEventInput, type Store } from "./store/store.js";
import type { CodexRuntime } from "./runtime/codex/codex-runtime.js";
import type { TerminalLauncher } from "./terminal/launcher.js";

/** Env var that carries the app-server token into an attached terminal; never put the token itself on a command line. */
export const TERMINAL_TOKEN_ENV = "AMO_STUDIO_CODEX_TOKEN";

const SCRATCHPAD_KEY = "scratchpad";

// Application layer behind the Host API. HTTP handlers stay thin and call into this.

export class HostError extends Error {
  constructor(readonly code: HostErrorCode, message: string) {
    super(message);
    this.name = "HostError";
  }
}

export interface HostServiceEvents {
  event: [HostEvent];
}

export class HostService extends EventEmitter<HostServiceEvents> {
  constructor(
    readonly store: Store,
    readonly runtime: CodexRuntime,
    readonly profiles: readonly ModelProfile[],
    private readonly options: { launcher?: TerminalLauncher } = {},
  ) {
    super();
    runtime.on("event", (e) => this.emit("event", e));
  }

  snapshot(): StateSnapshot {
    return {
      workspaces: this.store.listWorkspaces(),
      tasks: this.store.listTasks(),
      sessions: this.store.listSessions(),
      profiles: [...this.profiles],
      eventSeq: this.store.lastEventSeq(),
    };
  }

  // Workspaces

  addWorkspace(input: { path: string; name?: string }): Workspace {
    if (!input.path?.trim()) throw new HostError("bad_request", "path is required");
    const path = resolve(input.path.trim());
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new HostError("bad_request", `not a directory: ${path}`);
    if (this.store.findWorkspaceByPath(path)) throw new HostError("conflict", `workspace already registered: ${path}`);
    const ws = this.store.addWorkspace({ path, name: input.name?.trim() || basename(path) || path });
    this.publish({ type: "workspace.upserted", workspace: ws });
    return ws;
  }

  removeWorkspace(id: Id): void {
    if (!this.store.getWorkspace(id)) throw new HostError("not_found", `workspace ${id} not found`);
    try {
      this.store.removeWorkspace(id);
    } catch (err) {
      throw new HostError("conflict", (err as Error).message);
    }
    this.publish({ type: "workspace.removed", workspaceId: id });
  }

  // Tasks

  async createTask(input: { title?: string; scope: TaskScope; firstSession: NewSessionInput }): Promise<{ task: Task; session: Session }> {
    const scope = this.validScope(input.scope);
    const workspace = this.sessionWorkspace(scope, input.firstSession.workspaceId);
    this.requireProfile(input.firstSession.profileId);
    const title = input.title?.trim() || input.firstSession.text?.trim().slice(0, 60) || "";
    const task = this.store.createTask({ title, scope, column: "doing" });
    this.publish({ type: "task.upserted", task });
    const session = await this.startSession(task, workspace, input.firstSession);
    return { task: this.store.getTask(task.id)!, session };
  }

  updateTask(id: Id, patch: { title?: string; column?: TaskColumn }): Task {
    this.requireTask(id);
    if (patch.column !== undefined && !TASK_COLUMNS.includes(patch.column)) throw new HostError("bad_request", `unknown column ${String(patch.column)}`);
    const clean: { title?: string; column?: TaskColumn } = {};
    if (patch.title !== undefined) clean.title = String(patch.title).trim();
    if (patch.column !== undefined) clean.column = patch.column;
    const task = this.store.updateTask(id, clean);
    this.publish({ type: "task.upserted", task });
    return task;
  }

  async addSession(taskId: Id, input: NewSessionInput): Promise<Session> {
    const task = this.requireTask(taskId);
    const workspace = this.sessionWorkspace(task.scope, input.workspaceId);
    this.requireProfile(input.profileId);
    return this.startSession(task, workspace, input);
  }

  // Sessions

  items(sessionId: Id, afterSeq = 0): SessionItem[] {
    this.requireSession(sessionId);
    return this.store.listItems(sessionId, afterSeq);
  }

  async sendMessage(sessionId: Id, text: string): Promise<{ mode: "start" | "steer" }> {
    this.requireSession(sessionId);
    if (!text?.trim()) throw new HostError("bad_request", "text is required");
    return this.wrap(() => this.runtime.sendMessage(sessionId, text));
  }

  async interrupt(sessionId: Id): Promise<void> {
    this.requireSession(sessionId);
    await this.wrap(() => this.runtime.interrupt(sessionId));
  }

  async fork(sessionId: Id, profileId?: Id): Promise<Session> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be forked");
    if (profileId) this.requireProfile(profileId);
    return this.wrap(() => this.runtime.fork(sessionId, profileId));
  }

  async archive(sessionId: Id): Promise<Session[]> {
    this.requireSession(sessionId);
    return this.wrap(() => this.runtime.archive(sessionId));
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    this.requireSession(sessionId);
    return this.wrap(() => this.runtime.unarchive(sessionId));
  }

  async respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    this.requireSession(sessionId);
    if (decision !== "accept" && decision !== "decline") throw new HostError("bad_request", `unknown decision ${String(decision)}`);
    await this.wrap(() => this.runtime.respondApproval(sessionId, approvalId, decision), "conflict");
  }

  /**
   * Codex: opens the real TUI on the same app-server (`codex --remote … resume`). Both sides keep writing, so the
   * session becomes "terminal-shared". With `launch: false` only the command is returned (tests, copy to clipboard).
   */
  async terminal(sessionId: Id, launch: boolean): Promise<TerminalAttach> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be opened in a terminal");
    if (s.runtime !== "codex") throw new HostError("bad_request", "only Codex sessions can be attached in stage 1");
    const info = await this.wrap(() => this.runtime.attachInfo(sessionId));
    const command = `codex --remote ${info.url} --remote-auth-token-env ${TERMINAL_TOKEN_ENV} resume ${info.threadId}`;
    if (launch) {
      if (!this.options.launcher) throw new HostError("bad_request", "no terminal launcher configured");
      const ws = this.store.getWorkspace(s.workspaceId);
      this.options.launcher.launch({
        command,
        cwd: ws?.path ?? process.cwd(),
        env: { [TERMINAL_TOKEN_ENV]: info.token },
        title: `AMO Studio · ${s.title || "会话"}`,
      });
      this.runtime.setWriter(sessionId, "terminal-shared");
    }
    return { command, envVar: TERMINAL_TOKEN_ENV, launched: launch };
  }

  /** Back to workbench-only writing (after closing the terminal, or taking a Claude handoff back in stage 4). */
  reclaim(sessionId: Id): Session {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be reclaimed");
    return this.runtime.setWriter(sessionId, "workbench");
  }

  // Scratchpad (global)

  scratchpad(): Scratchpad {
    const kv = this.store.getKv(SCRATCHPAD_KEY);
    return { text: kv?.value ?? "", updatedAt: kv?.updatedAt ?? null };
  }

  saveScratchpad(text: unknown): Scratchpad {
    if (typeof text !== "string") throw new HostError("bad_request", "text must be a string");
    if (text.length > 200_000) throw new HostError("bad_request", "scratchpad is limited to 200000 characters");
    const kv = this.store.setKv(SCRATCHPAD_KEY, text);
    const scratchpad = { text: kv.value, updatedAt: kv.updatedAt };
    this.publish({ type: "scratchpad.updated", scratchpad });
    return scratchpad;
  }

  // Annotations (stage 2 review loop)

  annotations(sessionId: Id): Annotation[] {
    this.requireSession(sessionId);
    return this.store.listAnnotations(sessionId);
  }

  addAnnotation(sessionId: Id, input: NewAnnotationInput): Annotation {
    this.requireSession(sessionId);
    const item = this.store.getItem(String(input?.itemId ?? ""));
    if (!item || item.sessionId !== sessionId) throw new HostError("bad_request", "itemId must be an item of this session");
    if (item.type !== "agent") throw new HostError("bad_request", "only agent replies can be annotated");
    const quote = typeof input.quote === "string" ? input.quote : "";
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!quote.trim()) throw new HostError("bad_request", "quote is required");
    if (!note) throw new HostError("bad_request", "note is required");
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) throw new HostError("bad_request", "start/end must be a non-empty range");
    const annotation: Annotation = {
      id: newId("an"),
      sessionId,
      itemId: item.id,
      quote,
      start,
      end,
      prefix: typeof input.prefix === "string" ? input.prefix.slice(-24) : "",
      suffix: typeof input.suffix === "string" ? input.suffix.slice(0, 24) : "",
      note,
      createdAt: new Date().toISOString(),
      sentAt: null,
    };
    this.store.putAnnotation(annotation);
    this.publish({ type: "annotation.upserted", annotation });
    return annotation;
  }

  updateAnnotation(id: Id, note: string): Annotation {
    const current = this.requireAnnotation(id);
    if (current.sentAt) throw new HostError("conflict", "sent annotations cannot be edited");
    const trimmed = typeof note === "string" ? note.trim() : "";
    if (!trimmed) throw new HostError("bad_request", "note is required");
    const next = { ...current, note: trimmed };
    this.store.putAnnotation(next);
    this.publish({ type: "annotation.upserted", annotation: next });
    return next;
  }

  deleteAnnotation(id: Id): void {
    const current = this.requireAnnotation(id);
    this.store.deleteAnnotation(id);
    this.publish({ type: "annotation.removed", sessionId: current.sessionId, annotationId: id });
  }

  /** Sends all unsent annotations as one message (reply order, then position in the reply) and marks them sent. */
  async sendAnnotations(sessionId: Id): Promise<{ mode: "start" | "steer"; sent: Annotation[] }> {
    const pending = this.annotations(sessionId).filter((a) => !a.sentAt);
    if (!pending.length) throw new HostError("bad_request", "no annotations to send");
    const seq = (a: Annotation) => this.store.getItem(a.itemId)?.seq ?? Number.MAX_SAFE_INTEGER;
    pending.sort((a, b) => seq(a) - seq(b) || a.start - b.start);
    const result = await this.sendMessage(sessionId, composeAnnotationMessage(pending));
    const at = new Date().toISOString();
    const sent = pending.map((a) => {
      const next = { ...a, sentAt: at };
      this.store.putAnnotation(next);
      this.publish({ type: "annotation.upserted", annotation: next });
      return next;
    });
    return { mode: result.mode, sent };
  }

  private requireAnnotation(id: Id): Annotation {
    const a = this.store.getAnnotation(id);
    if (!a) throw new HostError("not_found", `annotation ${id} not found`);
    return a;
  }

  // Helpers

  private async startSession(task: Task, workspace: Workspace, input: NewSessionInput): Promise<Session> {
    const session = await this.wrap(() =>
      this.runtime.startSession({ taskId: task.id, profileId: input.profileId, workspace, ...(input.text ? { text: input.text } : {}) }),
    );
    // The task's updatedAt moves with its sessions so the board can sort by activity.
    this.publish({ type: "task.upserted", task: this.store.updateTask(task.id, {}) });
    return session;
  }

  private validScope(scope: TaskScope | undefined): TaskScope {
    if (scope?.kind === "area") return { kind: "area" };
    if (scope?.kind === "workspace") {
      if (!this.store.getWorkspace(scope.workspaceId)) throw new HostError("bad_request", `workspace ${scope.workspaceId} not found`);
      return { kind: "workspace", workspaceId: scope.workspaceId };
    }
    throw new HostError("bad_request", "scope must be a workspace or the cross-workspace area");
  }

  /** Workspace tasks always use their workspace; cross-workspace tasks need one per session. */
  private sessionWorkspace(scope: TaskScope, requested: Id | undefined): Workspace {
    const id = scope.kind === "workspace" ? scope.workspaceId : requested;
    if (!id) throw new HostError("bad_request", "cross-workspace sessions need a workspaceId");
    if (scope.kind === "workspace" && requested && requested !== scope.workspaceId) {
      throw new HostError("bad_request", "sessions of a workspace task stay in that workspace");
    }
    const ws = this.store.getWorkspace(id);
    if (!ws) throw new HostError("bad_request", `workspace ${id} not found`);
    return ws;
  }

  private requireProfile(id: Id): ModelProfile {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) throw new HostError("bad_request", `unknown model profile ${id}`);
    return p;
  }

  private requireTask(id: Id): Task {
    const t = this.store.getTask(id);
    if (!t) throw new HostError("not_found", `task ${id} not found`);
    return t;
  }

  requireSession(id: Id): Session {
    const s = this.store.getSession(id);
    if (!s) throw new HostError("not_found", `session ${id} not found`);
    return s;
  }

  private async wrap<T>(fn: () => Promise<T>, fallback: HostErrorCode = "runtime_error"): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HostError) throw err;
      const e = err as { code?: string; message?: string };
      throw new HostError(e.code === "read_only" ? "read_only" : fallback, e.message ?? String(err));
    }
  }

  publish(event: HostEventInput): HostEvent {
    const persisted = this.store.appendEvent(event);
    this.emit("event", persisted);
    return persisted;
  }
}
