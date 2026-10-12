import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  ApprovalDecision,
  HostErrorCode,
  HostEvent,
  Id,
  ModelProfile,
  NewSessionInput,
  Session,
  SessionItem,
  StateSnapshot,
  Task,
  TaskColumn,
  TaskScope,
  Workspace,
} from "@amo-studio/protocol";
import { TASK_COLUMNS } from "@amo-studio/protocol";
import type { HostEventInput, Store } from "./store/store.js";
import type { CodexRuntime } from "./runtime/codex/codex-runtime.js";

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
