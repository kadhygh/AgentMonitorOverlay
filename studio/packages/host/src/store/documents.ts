import type { DatabaseSync } from "node:sqlite";
import type { Annotation, CanvasDoc, ChatMark, ChecklistItem, DecisionRequest, FileMark, GitReviewComment, Id, MailMessage, ScheduleProposal, Relay, TaskNote, TaskPlan, TodoItem, TopicDoc } from "@amo-studio/protocol";
import { str, type Row } from "./rows.js";

/**
 * The features' document tables (stage 16 split out of store.ts): each row keeps the whole entity as JSON in `body`,
 * with the columns it is looked up by beside it. Store extends this; callers keep using `store.putAnnotation(…)`.
 */
export abstract class DocumentStore {
  abstract readonly db: DatabaseSync;

  // Topics' documents (stage 16)

  putTopicDoc(d: TopicDoc): void {
    this.db
      .prepare("INSERT INTO topic_docs (id, topic_id, created_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body")
      .run(d.id, d.topicId, d.createdAt, JSON.stringify(d));
  }

  getTopicDoc(id: Id): TopicDoc | undefined {
    const r = this.db.prepare("SELECT body FROM topic_docs WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as TopicDoc);
  }

  listTopicDocs(topicId: Id): TopicDoc[] {
    return (this.db.prepare("SELECT body FROM topic_docs WHERE topic_id = ? ORDER BY created_at, id").all(topicId) as Row[]).map((r) => JSON.parse(str(r.body)) as TopicDoc);
  }

  deleteTopicDoc(id: Id): void {
    this.db.prepare("DELETE FROM topic_docs WHERE id = ?").run(id);
  }

  // 主控's proposals (stage 16)

  putTaskPlan(p: TaskPlan): void {
    this.db
      .prepare("INSERT INTO task_plans (id, state, created_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, body = excluded.body")
      .run(p.id, p.state, p.createdAt, JSON.stringify(p));
  }

  getTaskPlan(id: Id): TaskPlan | undefined {
    const r = this.db.prepare("SELECT body FROM task_plans WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as TaskPlan);
  }

  listTaskPlans(): TaskPlan[] {
    return (this.db.prepare("SELECT body FROM task_plans ORDER BY created_at, id").all() as Row[]).map((r) => JSON.parse(str(r.body)) as TaskPlan);
  }

  // 传话 (stage 16)

  putRelay(r: Relay): void {
    this.db
      .prepare("INSERT INTO relays (id, state, created_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, body = excluded.body")
      .run(r.id, r.state, r.createdAt, JSON.stringify(r));
  }

  getRelay(id: Id): Relay | undefined {
    const r = this.db.prepare("SELECT body FROM relays WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as Relay);
  }

  listRelays(): Relay[] {
    return (this.db.prepare("SELECT body FROM relays ORDER BY created_at, id").all() as Row[]).map((r) => JSON.parse(str(r.body)) as Relay);
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
        "INSERT INTO file_marks (id, workspace_id, topic_id, path, position, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, topic_id = excluded.topic_id, path = excluded.path, position = excluded.position, body = excluded.body",
      )
      .run(m.id, m.workspaceId, m.topicId ?? null, m.path, m.order, m.createdAt, JSON.stringify(m));
  }

  getFileMark(id: Id): FileMark | undefined {
    const r = this.db.prepare("SELECT body FROM file_marks WHERE id = ?").get(id) as Row | undefined;
    return r && fileMark(r);
  }

  /** All marks (`undefined`), a project's, or those outside every project (`null`); in their order. */
  listFileMarks(workspaceId?: Id | null): FileMark[] {
    const rows =
      workspaceId === undefined
        ? this.db.prepare("SELECT body FROM file_marks ORDER BY position, created_at DESC, id").all()
        : workspaceId === null
          ? this.db.prepare("SELECT body FROM file_marks WHERE workspace_id IS NULL ORDER BY position, created_at DESC, id").all()
          : this.db.prepare("SELECT body FROM file_marks WHERE workspace_id = ? ORDER BY position, created_at DESC, id").all(workspaceId);
    return (rows as Row[]).map(fileMark);
  }

  deleteFileMark(id: Id): void {
    this.db.prepare("DELETE FROM file_marks WHERE id = ?").run(id);
  }

  // Bookmarked passages of conversations (2026-10-19). The body keeps what was marked; where the session is now is
  // read when they are listed.

  putChatMark(m: ChatMark): void {
    const { taskId: _t, workspaceId: _w, sessionTitle: _s, exists: _e, ...kept } = m;
    this.db
      .prepare(
        "INSERT INTO chat_marks (id, topic_id, session_id, position, created_at, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET topic_id = excluded.topic_id, position = excluded.position, body = excluded.body",
      )
      .run(m.id, m.topicId, m.sessionId, m.order, m.createdAt, JSON.stringify(kept));
  }

  getChatMark(id: Id): ChatMark | undefined {
    const r = this.db.prepare("SELECT body FROM chat_marks WHERE id = ?").get(id) as Row | undefined;
    return r && (JSON.parse(str(r.body)) as ChatMark);
  }

  listChatMarks(): ChatMark[] {
    return (this.db.prepare("SELECT body FROM chat_marks ORDER BY position, created_at DESC, id").all() as Row[]).map((r) => JSON.parse(str(r.body)) as ChatMark);
  }

  deleteChatMark(id: Id): void {
    this.db.prepare("DELETE FROM chat_marks WHERE id = ?").run(id);
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

/** A file mark from before 书签 has no kind or topic. */
function fileMark(r: Row): FileMark {
  const m = JSON.parse(str(r.body)) as FileMark;
  return { ...m, kind: "file", topicId: m.topicId ?? null };
}
