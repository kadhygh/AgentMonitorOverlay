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
  type SessionOptions,
  type Task,
  type TaskColumn,
  type Topic,
  type TodoItem,
  type TaskNote,
  type ChecklistItem,
  type ScheduleProposal,
  type MailMessage,
  type DecisionRequest,
  type GitReviewComment,
  type FileMark,
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
const ATTACHMENT_ID = /att-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const strOrNull = (v: SQLInputValue | undefined): string | null => (v === null || v === undefined ? null : (v as string));

function toWorkspace(r: Row): Workspace {
  return {
    id: str(r.id),
    name: str(r.name),
    path: str(r.path),
    ...(r.builtin === "common" ? { builtin: "common" as const } : {}),
    createdAt: str(r.created_at),
    ...(typeof r.archived_at === "string" ? { archivedAt: r.archived_at } : {}),
    ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
  };
}

function toTask(r: Row): Task {
  return {
    id: str(r.id),
    title: str(r.title),
    // NULL only for tasks of the old cross-workspace area until the Host resolves them at start-up.
    workspaceId: strOrNull(r.workspace_id) ?? "",
    topicId: strOrNull(r.topic_id),
    column: str(r.column_name) as TaskColumn,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    archivedAt: strOrNull(r.archived_at),
  };
}

function toTopic(r: Row): Topic {
  let workspaceIds: Id[] = [];
  try {
    const parsed = JSON.parse(str(r.workspace_ids)) as unknown;
    if (Array.isArray(parsed)) workspaceIds = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // a damaged list reads as empty
  }
  return {
    id: str(r.id),
    title: str(r.title),
    workspaceIds,
    ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    archivedAt: strOrNull(r.archived_at),
  };
}

function toSession(r: Row): Session {
  return {
    id: str(r.id),
    taskId: strOrNull(r.task_id),
    topicId: strOrNull(r.topic_id),
    parentId: strOrNull(r.parent_id),
    kind: str(r.kind) as Session["kind"],
    runtime: str(r.runtime) as Session["runtime"],
    profileId: str(r.profile_id),
    workspaceId: str(r.workspace_id),
    title: str(r.title),
    status: str(r.status) as Session["status"],
    writer: str(r.writer) as Session["writer"],
    runtimeRef: strOrNull(r.runtime_ref),
    options: parseOptions(r.options),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    archivedAt: strOrNull(r.archived_at),
  };
}

function parseOptions(v: unknown): SessionOptions {
  if (typeof v !== "string" || !v) return {};
  try {
    const o = JSON.parse(v) as Record<string, unknown>;
    const out: SessionOptions = {};
    for (const k of ["model", "effort", "permission"] as const) if (typeof o[k] === "string" && o[k]) out[k] = o[k] as string;
    if (typeof o.fast === "boolean") out.fast = o.fast;
    return out;
  } catch {
    return {};
  }
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
    MIGRATIONS.forEach((migration, index) => {
      const version = index + 1;
      if (version <= current) return;
      const sql = typeof migration === "string" ? migration : migration.sql;
      const fkOff = typeof migration !== "string" && migration.foreignKeysOff;
      // The pragma has no effect inside a transaction, so it is switched around it.
      if (fkOff) this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.db.exec(sql);
          if (fkOff) {
            const broken = this.db.prepare("PRAGMA foreign_key_check").all();
            if (broken.length) throw new Error(`migration ${version} broke ${broken.length} foreign keys`);
          }
          this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, this.timestamp());
        });
      } finally {
        if (fkOff) this.db.exec("PRAGMA foreign_keys = ON");
      }
    });
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as Row;
    return Number(row.v ?? 0);
  }

  // Workspaces

  addWorkspace(input: { path: string; name: string; builtin?: "common" }): Workspace {
    const ws: Workspace = { id: newId("ws"), name: input.name, path: input.path, ...(input.builtin ? { builtin: input.builtin } : {}), createdAt: this.timestamp() };
    this.db.prepare("INSERT INTO workspaces (id, name, path, builtin, created_at) VALUES (?, ?, ?, ?, ?)").run(ws.id, ws.name, ws.path, ws.builtin ?? null, ws.createdAt);
    return ws;
  }

  /** Marks the common space (only one workspace is it at a time). */
  setCommonWorkspace(id: Id): Workspace {
    this.transaction(() => {
      this.db.prepare("UPDATE workspaces SET builtin = NULL WHERE builtin = 'common' AND id <> ?").run(id);
      this.db.prepare("UPDATE workspaces SET builtin = 'common' WHERE id = ?").run(id);
    });
    return this.getWorkspace(id)!;
  }

  setWorkspacePath(id: Id, path: string): Workspace {
    this.db.prepare("UPDATE workspaces SET path = ? WHERE id = ?").run(path, id);
    return this.getWorkspace(id)!;
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

  /** 编辑项目: its name in Studio (the folder keeps its own) and its note. */
  updateWorkspace(id: Id, patch: { name?: string; description?: string }): Workspace {
    if (patch.name !== undefined) this.db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(patch.name, id);
    if (patch.description !== undefined) this.db.prepare("UPDATE workspaces SET description = ? WHERE id = ?").run(patch.description || null, id);
    return this.getWorkspace(id)!;
  }

  setWorkspaceArchived(id: Id, archivedAt: string | null): Workspace {
    this.db.prepare("UPDATE workspaces SET archived_at = ? WHERE id = ?").run(archivedAt, id);
    return this.getWorkspace(id)!;
  }

  /** Only workspaces without tasks or sessions can be removed. */
  removeWorkspace(id: Id): void {
    const used = this.db.prepare("SELECT 1 FROM tasks WHERE workspace_id = ? UNION SELECT 1 FROM sessions WHERE workspace_id = ? LIMIT 1").get(id, id);
    if (used) throw new Error(`workspace ${id} is still used by tasks or sessions`);
    // Git Review comments belong to the project and go with it.
    this.db.prepare("DELETE FROM review_comments WHERE workspace_id = ?").run(id);
    // So do its file marks (S12-D).
    this.db.prepare("DELETE FROM file_marks WHERE workspace_id = ?").run(id);
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  // Tasks

  createTask(input: { title: string; workspaceId: Id; topicId?: Id | null; column?: TaskColumn }): Task {
    const at = this.timestamp();
    const task: Task = { id: newId("task"), title: input.title, workspaceId: input.workspaceId, topicId: input.topicId ?? null, column: input.column ?? "todo", createdAt: at, updatedAt: at, archivedAt: null };
    this.db
      .prepare("INSERT INTO tasks (id, title, workspace_id, topic_id, column_name, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(task.id, task.title, task.workspaceId, task.topicId, task.column, at, at);
    return task;
  }

  /** Tasks from the old cross-workspace area that still have no workspace (resolved at Host start-up). */
  listTasksWithoutWorkspace(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE workspace_id IS NULL ORDER BY created_at, id").all() as Row[]).map(toTask);
  }

  getTask(id: Id): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return r && toTask(r);
  }

  listTasks(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at, id").all() as Row[]).map(toTask);
  }

  updateTask(id: Id, patch: Partial<Pick<Task, "title" | "column" | "workspaceId" | "topicId" | "archivedAt">>): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    const next: Task = { ...task, ...patch, updatedAt: this.timestamp() };
    this.db
      .prepare("UPDATE tasks SET title = ?, column_name = ?, workspace_id = ?, topic_id = ?, archived_at = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.column, next.workspaceId || null, next.topicId, next.archivedAt, next.updatedAt, id);
    return next;
  }

  // Topics

  createTopic(input: { title: string; workspaceIds?: Id[] }): Topic {
    const at = this.timestamp();
    const topic: Topic = { id: newId("tp"), title: input.title, workspaceIds: input.workspaceIds ?? [], createdAt: at, updatedAt: at, archivedAt: null };
    this.db
      .prepare("INSERT INTO topics (id, title, workspace_ids, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)")
      .run(topic.id, topic.title, JSON.stringify(topic.workspaceIds), at, at);
    return topic;
  }

  getTopic(id: Id): Topic | undefined {
    const r = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Row | undefined;
    return r && toTopic(r);
  }

  listTopics(): Topic[] {
    return (this.db.prepare("SELECT * FROM topics ORDER BY created_at, id").all() as Row[]).map(toTopic);
  }

  updateTopic(id: Id, patch: Partial<Pick<Topic, "title" | "workspaceIds" | "archivedAt" | "description">>): Topic {
    const topic = this.getTopic(id);
    if (!topic) throw new Error(`topic ${id} not found`);
    const next: Topic = { ...topic, ...patch, updatedAt: this.timestamp() };
    if (!next.description) delete next.description;
    this.db
      .prepare("UPDATE topics SET title = ?, workspace_ids = ?, archived_at = ?, description = ?, updated_at = ? WHERE id = ?")
      .run(next.title, JSON.stringify(next.workspaceIds), next.archivedAt, next.description ?? null, next.updatedAt, id);
    return next;
  }

  // Sessions

  createSession(input: Omit<Session, "id" | "createdAt" | "updatedAt" | "archivedAt" | "options"> & { id?: Id; options?: SessionOptions }): Session {
    const at = this.timestamp();
    const s: Session = { ...input, options: input.options ?? {}, id: input.id ?? newId("s"), createdAt: at, updatedAt: at, archivedAt: null };
    this.db
      .prepare(
        `INSERT INTO sessions (id, task_id, topic_id, parent_id, kind, runtime, profile_id, workspace_id, title, status, writer, runtime_ref, options, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(s.id, s.taskId, s.topicId, s.parentId, s.kind, s.runtime, s.profileId, s.workspaceId, s.title, s.status, s.writer, s.runtimeRef, JSON.stringify(s.options), at, at);
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

  /** All sessions, or one owner's (a task's or a topic's). */
  listSessions(filter: { taskId?: Id; topicId?: Id } = {}): Session[] {
    const rows = filter.taskId
      ? this.db.prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at, id").all(filter.taskId)
      : filter.topicId
        ? this.db.prepare("SELECT * FROM sessions WHERE topic_id = ? ORDER BY created_at, id").all(filter.topicId)
        : this.db.prepare("SELECT * FROM sessions ORDER BY created_at, id").all();
    return (rows as Row[]).map(toSession);
  }

  /** The sessions sharing this session's owner. */
  private ownerSessions(s: Session): Session[] {
    return s.taskId ? this.listSessions({ taskId: s.taskId }) : this.listSessions({ topicId: s.topicId! });
  }

  /**
   * Moves whole session trees to a topic. Only for resolving tasks from the old cross-workspace area at start-up;
   * otherwise a session's owner never changes.
   */
  moveSessionTreeToTopic(rootId: Id, topicId: Id): void {
    const root = this.getSession(rootId);
    if (!root) throw new Error(`session ${rootId} not found`);
    for (const id of collectSubtreeIds(this.ownerSessions(root), rootId)) {
      this.db.prepare("UPDATE sessions SET task_id = NULL, topic_id = ? WHERE id = ?").run(topicId, id);
    }
  }

  updateSession(id: Id, patch: Partial<Pick<Session, "title" | "status" | "writer" | "runtimeRef" | "profileId" | "options">>): Session {
    const s = this.getSession(id);
    if (!s) throw new Error(`session ${id} not found`);
    const next: Session = { ...s, ...patch, updatedAt: this.timestamp() };
    this.db
      .prepare("UPDATE sessions SET title = ?, status = ?, writer = ?, runtime_ref = ?, profile_id = ?, options = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.status, next.writer, next.runtimeRef, next.profileId, JSON.stringify(next.options), next.updatedAt, id);
    return next;
  }

  /** Archives the session with all its forks and subagents. Returns the sessions that changed. */
  archiveSubtree(rootId: Id): Session[] {
    return this.transaction(() => {
      const root = this.getSession(rootId);
      if (!root) throw new Error(`session ${rootId} not found`);
      const ids = collectSubtreeIds(this.ownerSessions(root), rootId);
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
      const ids = collectSubtreeIds(this.ownerSessions(root), rootId);
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

  // Permanent deletion (数据管理, 2026-10-14)

  /**
   * How much a deletion takes with it: messages (items) of the sessions and the attachment ids they mention. The
   * caller has already gathered the sessions and tasks.
   */
  countItems(sessionIds: readonly Id[]): { items: number; attachmentIds: string[] } {
    let items = 0;
    const attachments = new Set<string>();
    for (const id of sessionIds) {
      for (const r of this.db.prepare("SELECT body FROM items WHERE session_id = ?").all(id) as Row[]) {
        items++;
        for (const m of str(r.body).matchAll(ATTACHMENT_ID)) attachments.add(m[0]);
      }
    }
    return { items, attachmentIds: [...attachments] };
  }

  /**
   * Deletes sessions, tasks, topics and workspaces for good, with everything that belongs only to them: items,
   * annotations, decisions, task notes, checklists, mail to them, scheduler proposals about them, their topics'
   * canvases, their cards and dependencies on other canvases, and the events that carried them. Mail they sent to
   * others stays with the recipient; todos keep their text and lose the link. One transaction: all or nothing.
   */
  purge(ids: { sessionIds: readonly Id[]; taskIds: readonly Id[]; topicIds: readonly Id[]; workspaceIds: readonly Id[] }): void {
    const sessions = new Set(ids.sessionIds);
    const tasks = new Set(ids.taskIds);
    const topics = new Set(ids.topicIds);
    const each = (list: Iterable<Id>, sql: string) => {
      const stmt = this.db.prepare(sql);
      for (const id of list) stmt.run(id);
    };
    this.transaction(() => {
      each(sessions, "DELETE FROM items WHERE session_id = ?");
      each(sessions, "DELETE FROM annotations WHERE session_id = ?");
      each(sessions, "DELETE FROM decisions WHERE session_id = ?");
      each(tasks, "DELETE FROM decisions WHERE task_id = ?");
      each(sessions, "DELETE FROM mail WHERE to_session = ?");
      each(tasks, "DELETE FROM mail WHERE to_task = ?");
      each(topics, "DELETE FROM mail WHERE to_topic = ?");
      each(tasks, "DELETE FROM task_notes WHERE task_id = ?");
      each(tasks, "DELETE FROM checklist_items WHERE task_id = ?");
      for (const p of this.listProposals()) if ((p.taskId && tasks.has(p.taskId)) || (p.sessionId && sessions.has(p.sessionId))) this.db.prepare("DELETE FROM proposals WHERE id = ?").run(p.id);
      for (const t of this.listTodos()) if (t.taskId && tasks.has(t.taskId)) this.putTodo({ ...t, taskId: null });
      // Forks point at their parents: one statement per owner set is checked at its end, so order does not matter.
      if (sessions.size) this.db.prepare(`DELETE FROM sessions WHERE id IN (${[...sessions].map(() => "?").join(", ")})`).run(...sessions);
      each(tasks, "DELETE FROM tasks WHERE id = ?");
      each(topics, "DELETE FROM canvas_docs WHERE id = ?");
      // Cards and dependencies of the deleted tasks on the canvases that stay.
      for (const r of this.db.prepare("SELECT body FROM canvas_docs").all() as Row[]) {
        const doc = JSON.parse(str(r.body)) as CanvasDoc;
        if (!doc.nodes.some((n) => n.kind !== "note" && tasks.has(n.taskId))) continue;
        this.putCanvas({
          ...doc,
          version: doc.version + 1,
          nodes: doc.nodes.filter((n) => n.kind === "note" || !tasks.has(n.taskId)),
          edges: doc.edges.filter((e) => !tasks.has(e.from) && !tasks.has(e.to)),
          updatedAt: this.timestamp(),
        });
      }
      each(topics, "DELETE FROM topics WHERE id = ?");
      for (const id of ids.workspaceIds) this.removeWorkspace(id);
      // The event log is only for catching up after a reconnect; events about what is gone would bring it back.
      const gone = [...sessions, ...tasks, ...topics];
      for (let i = 0; i < gone.length; i += 50) {
        const chunk = gone.slice(i, i + 50);
        this.db.prepare(`DELETE FROM events WHERE ${chunk.map(() => "instr(payload, ?) > 0").join(" OR ")}`).run(...chunk);
      }
    });
  }

  /** Whether any item or kv value (the scratchpad) still mentions this attachment. */
  attachmentInUse(id: string): boolean {
    return !!(
      this.db.prepare("SELECT 1 FROM items WHERE instr(body, ?) > 0 LIMIT 1").get(id) ?? this.db.prepare("SELECT 1 FROM kv WHERE instr(value, ?) > 0 LIMIT 1").get(id)
    );
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

  // Git Review line comments (S11-D)

  putReviewComment(c: GitReviewComment): void {
    this.db
      .prepare(
        "INSERT INTO review_comments (id, workspace_id, path, state, created_at, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, body = excluded.body",
      )
      .run(c.id, c.workspaceId, c.path, c.state, c.createdAt, JSON.stringify(c));
  }

  getReviewComment(id: Id): GitReviewComment | undefined {
    const r = this.db.prepare("SELECT body FROM review_comments WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as GitReviewComment);
  }

  listReviewComments(workspaceId: Id): GitReviewComment[] {
    return (this.db.prepare("SELECT body FROM review_comments WHERE workspace_id = ? ORDER BY created_at, id").all(workspaceId) as Row[]).map(
      (r) => JSON.parse(str(r.body)) as GitReviewComment,
    );
  }

  deleteReviewComment(id: Id): void {
    this.db.prepare("DELETE FROM review_comments WHERE id = ?").run(id);
  }

  // File marks (S12-D)

  putFileMark(m: FileMark): void {
    this.db
      .prepare(
        "INSERT INTO file_marks (id, workspace_id, path, position, created_at, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, path = excluded.path, position = excluded.position, body = excluded.body",
      )
      .run(m.id, m.workspaceId, m.path, m.order, m.createdAt, JSON.stringify(m));
  }

  getFileMark(id: Id): FileMark | undefined {
    const r = this.db.prepare("SELECT body FROM file_marks WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as FileMark);
  }

  /** All marks (`undefined`), a project's, or those outside every project (`null`); in their order. */
  listFileMarks(workspaceId?: Id | null): FileMark[] {
    const rows =
      workspaceId === undefined
        ? this.db.prepare("SELECT body FROM file_marks ORDER BY position, created_at DESC, id").all()
        : workspaceId === null
          ? this.db.prepare("SELECT body FROM file_marks WHERE workspace_id IS NULL ORDER BY position, created_at DESC, id").all()
          : this.db.prepare("SELECT body FROM file_marks WHERE workspace_id = ? ORDER BY position, created_at DESC, id").all(workspaceId);
    return (rows as Row[]).map((r) => JSON.parse(str(r.body)) as FileMark);
  }

  deleteFileMark(id: Id): void {
    this.db.prepare("DELETE FROM file_marks WHERE id = ?").run(id);
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

  deleteCanvas(id: Id): void {
    this.db.prepare("DELETE FROM canvas_docs WHERE id = ?").run(id);
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

  putProposal(p: ScheduleProposal): void {
    this.db
      .prepare("INSERT INTO proposals (id, todo_id, state, body, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, body = excluded.body")
      .run(p.id, p.todoId, p.state, JSON.stringify(p), p.createdAt);
  }

  getProposal(id: Id): ScheduleProposal | undefined {
    const r = this.db.prepare("SELECT body FROM proposals WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as ScheduleProposal);
  }

  listProposals(filter: { state?: ScheduleProposal["state"]; todoId?: Id } = {}): ScheduleProposal[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.state) (where.push("state = ?"), args.push(filter.state));
    if (filter.todoId) (where.push("todo_id = ?"), args.push(filter.todoId));
    const sql = `SELECT body FROM proposals${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => JSON.parse(str(r.body)) as ScheduleProposal);
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
      .prepare("INSERT INTO mail (id, to_session, to_task, to_topic, state, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, body = excluded.body")
      .run(
        m.id,
        m.to.kind === "session" ? m.to.sessionId : null,
        m.to.kind === "task" ? m.to.taskId : null,
        m.to.kind === "topic" ? m.to.topicId : null,
        m.state,
        JSON.stringify(m),
        m.createdAt,
      );
  }

  getMail(id: Id): MailMessage | undefined {
    const r = this.db.prepare("SELECT body FROM mail WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as MailMessage);
  }

  /** Mail for a session, task and/or topic (any matches), optionally only in some states; oldest first. */
  listMail(filter: { sessionId?: Id; taskId?: Id; topicId?: Id; states?: readonly MailMessage["state"][] } = {}): MailMessage[] {
    const where: string[] = [];
    const args: string[] = [];
    const to: string[] = [];
    if (filter.sessionId) (to.push("to_session = ?"), args.push(filter.sessionId));
    if (filter.taskId) (to.push("to_task = ?"), args.push(filter.taskId));
    if (filter.topicId) (to.push("to_topic = ?"), args.push(filter.topicId));
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
