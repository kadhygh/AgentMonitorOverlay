import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  collectSubtreeIds,
  type Annotation,
  type CanvasDoc,
  type HostEvent,
  type Id,
  type Session,
  type SessionItem,
  type Task,
  type TaskColumn,
  type TodoItem,
  type TaskNote,
  type ChecklistItem,
  type MailMessage,
  type DecisionRequest,
  type Workspace,
} from "@amo-studio/protocol";
import { MIGRATIONS } from "./migrations.js";

/** A HostEvent before the store assigns its sequence number. */
export type HostEventInput = HostEvent extends infer E ? (E extends HostEvent ? Omit<E, "seq"> : never) : never;
/** A SessionItem before the store assigns its sequence number. */
export type SessionItemInput = SessionItem extends infer I ? (I extends SessionItem ? Omit<I, "seq"> : never) : never;

export function newId(prefix: string): Id {
  return `${prefix}-${randomUUID()}`;
}

type Row = Record<string, SQLInputValue>;

const str = (v: SQLInputValue | undefined): string => v as string;
const strOrNull = (v: SQLInputValue | undefined): string | null => (v === null || v === undefined ? null : (v as string));

function toWorkspace(r: Row): Workspace {
  return { id: str(r.id), name: str(r.name), path: str(r.path), createdAt: str(r.created_at) };
}

function toTask(r: Row): Task {
  return {
    id: str(r.id),
    title: str(r.title),
    scope: r.scope_kind === "area" ? { kind: "area" } : { kind: "workspace", workspaceId: str(r.workspace_id) },
    column: str(r.column_name) as TaskColumn,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function toSession(r: Row): Session {
  return {
    id: str(r.id),
    taskId: str(r.task_id),
    parentId: strOrNull(r.parent_id),
    kind: str(r.kind) as Session["kind"],
    runtime: str(r.runtime) as Session["runtime"],
    profileId: str(r.profile_id),
    workspaceId: str(r.workspace_id),
    title: str(r.title),
    status: str(r.status) as Session["status"],
    writer: str(r.writer) as Session["writer"],
    runtimeRef: strOrNull(r.runtime_ref),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    archivedAt: strOrNull(r.archived_at),
  };
}

function toItem(r: Row): SessionItem {
  return { ...(JSON.parse(str(r.body)) as object), seq: Number(r.seq) } as SessionItem;
}

/**
 * SQLite-backed store (node:sqlite, works in Node 24 and Electron 44's Node). Single writer: only the Host opens it.
 * All methods are synchronous; callers emit HostEvents through `appendEvent` alongside each change they publish.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(readonly path: string, private readonly now: () => Date = () => new Date()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /** Runs `fn` in a transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as Row | undefined;
    const current = Number(row?.v ?? 0);
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (version <= current) return;
      this.transaction(() => {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, this.timestamp());
      });
    });
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as Row;
    return Number(row.v ?? 0);
  }

  // Workspaces

  addWorkspace(input: { path: string; name: string }): Workspace {
    const ws: Workspace = { id: newId("ws"), name: input.name, path: input.path, createdAt: this.timestamp() };
    this.db.prepare("INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(ws.id, ws.name, ws.path, ws.createdAt);
    return ws;
  }

  getWorkspace(id: Id): Workspace | undefined {
    const r = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Row | undefined;
    return r && toWorkspace(r);
  }

  findWorkspaceByPath(path: string): Workspace | undefined {
    const r = this.db.prepare("SELECT * FROM workspaces WHERE path = ?").get(path) as Row | undefined;
    return r && toWorkspace(r);
  }

  listWorkspaces(): Workspace[] {
    return (this.db.prepare("SELECT * FROM workspaces ORDER BY created_at, id").all() as Row[]).map(toWorkspace);
  }

  /** Only workspaces without tasks or sessions can be removed. */
  removeWorkspace(id: Id): void {
    const used = this.db.prepare("SELECT 1 FROM tasks WHERE workspace_id = ? UNION SELECT 1 FROM sessions WHERE workspace_id = ? LIMIT 1").get(id, id);
    if (used) throw new Error(`workspace ${id} is still used by tasks or sessions`);
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  // Tasks

  createTask(input: { title: string; scope: Task["scope"]; column?: TaskColumn }): Task {
    const at = this.timestamp();
    const task: Task = { id: newId("task"), title: input.title, scope: input.scope, column: input.column ?? "todo", createdAt: at, updatedAt: at };
    this.db
      .prepare("INSERT INTO tasks (id, title, scope_kind, workspace_id, column_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.title, task.scope.kind, task.scope.kind === "workspace" ? task.scope.workspaceId : null, task.column, at, at);
    return task;
  }

  getTask(id: Id): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return r && toTask(r);
  }

  listTasks(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at, id").all() as Row[]).map(toTask);
  }

  updateTask(id: Id, patch: { title?: string; column?: TaskColumn }): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    const next: Task = { ...task, ...patch, updatedAt: this.timestamp() };
    this.db.prepare("UPDATE tasks SET title = ?, column_name = ?, updated_at = ? WHERE id = ?").run(next.title, next.column, next.updatedAt, id);
    return next;
  }

  // Sessions

  createSession(input: Omit<Session, "id" | "createdAt" | "updatedAt" | "archivedAt"> & { id?: Id }): Session {
    const at = this.timestamp();
    const s: Session = { ...input, id: input.id ?? newId("s"), createdAt: at, updatedAt: at, archivedAt: null };
    this.db
      .prepare(
        `INSERT INTO sessions (id, task_id, parent_id, kind, runtime, profile_id, workspace_id, title, status, writer, runtime_ref, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(s.id, s.taskId, s.parentId, s.kind, s.runtime, s.profileId, s.workspaceId, s.title, s.status, s.writer, s.runtimeRef, at, at);
    return s;
  }

  getSession(id: Id): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r && toSession(r);
  }

  findSessionByRuntimeRef(runtime: Session["runtime"], runtimeRef: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE runtime = ? AND runtime_ref = ?").get(runtime, runtimeRef) as Row | undefined;
    return r && toSession(r);
  }

  listSessions(filter: { taskId?: Id } = {}): Session[] {
    const rows = filter.taskId
      ? this.db.prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at, id").all(filter.taskId)
      : this.db.prepare("SELECT * FROM sessions ORDER BY created_at, id").all();
    return (rows as Row[]).map(toSession);
  }

  updateSession(id: Id, patch: Partial<Pick<Session, "title" | "status" | "writer" | "runtimeRef" | "profileId">>): Session {
    const s = this.getSession(id);
    if (!s) throw new Error(`session ${id} not found`);
    const next: Session = { ...s, ...patch, updatedAt: this.timestamp() };
    this.db
      .prepare("UPDATE sessions SET title = ?, status = ?, writer = ?, runtime_ref = ?, profile_id = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.status, next.writer, next.runtimeRef, next.profileId, next.updatedAt, id);
    return next;
  }

  /** Archives the session with all its forks and subagents. Returns the sessions that changed. */
  archiveSubtree(rootId: Id): Session[] {
    return this.transaction(() => {
      const root = this.getSession(rootId);
      if (!root) throw new Error(`session ${rootId} not found`);
      const ids = collectSubtreeIds(this.listSessions({ taskId: root.taskId }), rootId);
      const at = this.timestamp();
      const changed: Session[] = [];
      for (const id of ids) {
        const s = this.getSession(id)!;
        if (s.archivedAt) continue;
        this.db.prepare("UPDATE sessions SET archived_at = ?, writer = 'archived', updated_at = ? WHERE id = ?").run(at, at, id);
        changed.push({ ...s, archivedAt: at, writer: "archived", updatedAt: at });
      }
      return changed;
    });
  }

  /** Restores the session with all its forks and subagents to workbench writing. */
  unarchiveSubtree(rootId: Id): Session[] {
    return this.transaction(() => {
      const root = this.getSession(rootId);
      if (!root) throw new Error(`session ${rootId} not found`);
      const ids = collectSubtreeIds(this.listSessions({ taskId: root.taskId }), rootId);
      const at = this.timestamp();
      const changed: Session[] = [];
      for (const id of ids) {
        const s = this.getSession(id)!;
        if (!s.archivedAt) continue;
        this.db.prepare("UPDATE sessions SET archived_at = NULL, writer = 'workbench', updated_at = ? WHERE id = ?").run(at, id);
        changed.push({ ...s, archivedAt: null, writer: "workbench", updatedAt: at });
      }
      return changed;
    });
  }

  // Items

  /** Appends an item with the next seq for its session. */
  appendItem(input: SessionItemInput): SessionItem {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM items WHERE session_id = ?").get(input.sessionId) as Row;
      const item = { ...input, seq: Number(row.m) + 1 } as SessionItem;
      const { seq: _seq, ...body } = item;
      this.db
        .prepare("INSERT INTO items (session_id, seq, id, type, created_at, body) VALUES (?, ?, ?, ?, ?, ?)")
        .run(item.sessionId, item.seq, item.id, item.type, item.createdAt, JSON.stringify(body));
      return item;
    });
  }

  getItem(id: Id): SessionItem | undefined {
    const r = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return r && toItem(r);
  }

  /** Replaces an item's body in place; id, session, seq and type stay fixed. */
  replaceItem(item: SessionItem): SessionItem {
    const current = this.getItem(item.id);
    if (!current) throw new Error(`item ${item.id} not found`);
    if (current.sessionId !== item.sessionId || current.type !== item.type) throw new Error(`item ${item.id} cannot change session or type`);
    const next = { ...item, seq: current.seq } as SessionItem;
    const { seq: _seq, ...body } = next;
    this.db.prepare("UPDATE items SET body = ? WHERE id = ?").run(JSON.stringify(body), item.id);
    return next;
  }

  listItems(sessionId: Id, afterSeq = 0): SessionItem[] {
    return (this.db.prepare("SELECT * FROM items WHERE session_id = ? AND seq > ? ORDER BY seq").all(sessionId, afterSeq) as Row[]).map(toItem);
  }

  // Events

  appendEvent(event: HostEventInput): HostEvent {
    const result = this.db
      .prepare("INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)")
      .run(event.type, JSON.stringify(event), this.timestamp());
    return { ...event, seq: Number(result.lastInsertRowid) } as HostEvent;
  }

  listEvents(sinceSeq: number, limit = 1000): HostEvent[] {
    const rows = this.db.prepare("SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(sinceSeq, limit) as Row[];
    return rows.map((r) => ({ ...(JSON.parse(str(r.payload)) as object), seq: Number(r.seq) }) as HostEvent);
  }

  lastEventSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as Row;
    return Number(row.m);
  }

  // Key/value settings

  getKv(key: string): { value: string; updatedAt: string } | undefined {
    const r = this.db.prepare("SELECT value, updated_at FROM kv WHERE key = ?").get(key) as Row | undefined;
    return r && { value: str(r.value), updatedAt: str(r.updated_at) };
  }

  setKv(key: string, value: string): { value: string; updatedAt: string } {
    const updatedAt = this.timestamp();
    this.db
      .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, updatedAt);
    return { value, updatedAt };
  }

  // Annotations, canvas and todos: structure only in stage 1, UI comes later.

  putAnnotation(a: Annotation): void {
    this.db
      .prepare("INSERT INTO annotations (id, session_id, item_id, body, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body")
      .run(a.id, a.sessionId, a.itemId, JSON.stringify(a), a.createdAt);
  }

  getAnnotation(id: Id): Annotation | undefined {
    const r = this.db.prepare("SELECT body FROM annotations WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as Annotation);
  }

  deleteAnnotation(id: Id): void {
    this.db.prepare("DELETE FROM annotations WHERE id = ?").run(id);
  }

  listAnnotations(sessionId: Id): Annotation[] {
    return (this.db.prepare("SELECT body FROM annotations WHERE session_id = ? ORDER BY created_at, id").all(sessionId) as Row[]).map(
      (r) => JSON.parse(str(r.body)) as Annotation,
    );
  }

  putCanvas(doc: CanvasDoc): void {
    this.db
      .prepare("INSERT INTO canvas_docs (id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
      .run(doc.id, JSON.stringify(doc), doc.updatedAt);
  }

  getCanvas(id: Id): CanvasDoc | undefined {
    const r = this.db.prepare("SELECT body FROM canvas_docs WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as CanvasDoc);
  }

  putTodo(todo: TodoItem): void {
    this.db
      .prepare("INSERT INTO todos (id, body, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body")
      .run(todo.id, JSON.stringify(todo), todo.createdAt);
  }

  getTodo(id: Id): TodoItem | undefined {
    const r = this.db.prepare("SELECT body FROM todos WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as TodoItem);
  }

  deleteTodo(id: Id): void {
    this.db.prepare("DELETE FROM todos WHERE id = ?").run(id);
  }

  listTodos(): TodoItem[] {
    return (this.db.prepare("SELECT body FROM todos ORDER BY created_at, id").all() as Row[]).map((r) => JSON.parse(str(r.body)) as TodoItem);
  }

  // Collaboration (stage 5)

  addTaskNote(note: TaskNote): void {
    this.db.prepare("INSERT INTO task_notes (id, task_id, body, created_at) VALUES (?, ?, ?, ?)").run(note.id, note.taskId, JSON.stringify(note), note.createdAt);
  }

  listTaskNotes(taskId: Id): TaskNote[] {
    return (this.db.prepare("SELECT body FROM task_notes WHERE task_id = ? ORDER BY created_at, id").all(taskId) as Row[]).map((r) => JSON.parse(str(r.body)) as TaskNote);
  }

  putChecklistItem(item: ChecklistItem): void {
    this.db
      .prepare("INSERT INTO checklist_items (id, task_id, position, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body")
      .run(item.id, item.taskId, item.position, JSON.stringify(item));
  }

  getChecklistItem(id: Id): ChecklistItem | undefined {
    const r = this.db.prepare("SELECT body FROM checklist_items WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as ChecklistItem);
  }

  listChecklist(taskId?: Id): ChecklistItem[] {
    const rows = taskId
      ? this.db.prepare("SELECT body FROM checklist_items WHERE task_id = ? ORDER BY position").all(taskId)
      : this.db.prepare("SELECT body FROM checklist_items ORDER BY task_id, position").all();
    return (rows as Row[]).map((r) => JSON.parse(str(r.body)) as ChecklistItem);
  }

  putMail(m: MailMessage): void {
    this.db
      .prepare("INSERT INTO mail (id, to_session, to_task, state, body, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, body = excluded.body")
      .run(m.id, m.to.kind === "session" ? m.to.sessionId : null, m.to.kind === "task" ? m.to.taskId : null, m.state, JSON.stringify(m), m.createdAt);
  }

  getMail(id: Id): MailMessage | undefined {
    const r = this.db.prepare("SELECT body FROM mail WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as MailMessage);
  }

  /** Mail for a session and/or task (either matches), optionally only in some states; oldest first. */
  listMail(filter: { sessionId?: Id; taskId?: Id; states?: readonly MailMessage["state"][] } = {}): MailMessage[] {
    const where: string[] = [];
    const args: string[] = [];
    const to: string[] = [];
    if (filter.sessionId) (to.push("to_session = ?"), args.push(filter.sessionId));
    if (filter.taskId) (to.push("to_task = ?"), args.push(filter.taskId));
    if (to.length) where.push(`(${to.join(" OR ")})`);
    if (filter.states?.length) (where.push(`state IN (${filter.states.map(() => "?").join(", ")})`), args.push(...filter.states));
    const sql = `SELECT body FROM mail${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => JSON.parse(str(r.body)) as MailMessage);
  }

  putDecision(d: DecisionRequest): void {
    this.db
      .prepare("INSERT INTO decisions (id, session_id, task_id, state, body, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, body = excluded.body")
      .run(d.id, d.sessionId, d.taskId, d.state, JSON.stringify(d), d.createdAt);
  }

  getDecision(id: Id): DecisionRequest | undefined {
    const r = this.db.prepare("SELECT body FROM decisions WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as DecisionRequest);
  }

  listDecisions(filter: { state?: DecisionRequest["state"] } = {}): DecisionRequest[] {
    const rows = filter.state
      ? this.db.prepare("SELECT body FROM decisions WHERE state = ? ORDER BY created_at, id").all(filter.state)
      : this.db.prepare("SELECT body FROM decisions ORDER BY created_at, id").all();
    return (rows as Row[]).map((r) => JSON.parse(str(r.body)) as DecisionRequest);
  }
}
