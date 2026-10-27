import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ARCHIVABLE,
  DEFAULT_SETTINGS,
  TASK_STATUSES,
  VERDICT_LABEL,
  type Answer,
  type FileNote,
  type Message,
  type MessageKind,
  type NewMessage,
  type NewRequest,
  type NewTask,
  type Question,
  type RelayFile,
  type ReplyNote,
  type SessionAction,
  type SessionState,
  type Task,
  type TaskEvent,
  type TaskEventKind,
  type TaskStatus,
  type TaskView,
  type TeamSettings,
  type Thread,
  type ThreadKind,
  type ThreadView,
  type Verdict,
  type Via,
} from "./protocol.js";

// The relay's records (node:sqlite, one file): members (name + password), the keys a login hands out (one per device,
// only their hash kept), threads (the direct chat per pair of people, topics between the same two, one per request), the
// messages in one global order, and per member how far they have read each thread and whether they archived it. Only
// the service opens it. Who is online is the service's, not stored.

export class RelayError extends Error {
  constructor(
    readonly code: "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

const LIMITS = { password: 128, name: 32, role: 60, title: 200, body: 200_000, questions: 30, question: 2_000, options: 12, option: 200, answer: 20_000 };
const VERDICTS = new Set<Verdict>(["agree", "change", "question"]);

type Row = Record<string, unknown>;

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, "hex"), want.length), want);
}

function checkPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 4) throw new RelayError("bad_request", "密码至少 4 位");
  if (value.length > LIMITS.password) throw new RelayError("bad_request", "密码太长");
  return value;
}
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
const directKey = (a: string, b: string) => [a, b].sort().join("\n");

function text(value: unknown, what: string, max: number, required = true): string {
  if (value === undefined || value === null) {
    if (required) throw new RelayError("bad_request", `${what} 不能为空`);
    return "";
  }
  if (typeof value !== "string") throw new RelayError("bad_request", `${what} 必须是文字`);
  const v = value.trim();
  if (required && !v) throw new RelayError("bad_request", `${what} 不能为空`);
  if (v.length > max) throw new RelayError("bad_request", `${what} 太长（最多 ${max} 字）`);
  return v;
}

/** A display name: printable, no line breaks, at most 32 characters. */
export function checkName(value: unknown): string {
  const name = text(value, "名字", LIMITS.name);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new RelayError("bad_request", "名字里不能有控制字符");
  return name;
}

function checkVia(value: unknown): Via {
  if (!value || typeof value !== "object") return { kind: "person" };
  const v = value as { kind?: unknown; client?: unknown };
  if (v.kind !== "ai") return { kind: "person" };
  return typeof v.client === "string" && v.client.trim() ? { kind: "ai", client: v.client.trim().slice(0, 60) } : { kind: "ai" };
}

function checkQuestions(value: NewRequest["questions"]): Question[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RelayError("bad_request", "questions 必须是列表");
  if (value.length > LIMITS.questions) throw new RelayError("bad_request", `问题太多（最多 ${LIMITS.questions} 个）`);
  const ids = new Set<string>();
  return value.map((q, i) => {
    if (!q || typeof q !== "object") throw new RelayError("bad_request", `第 ${i + 1} 个问题格式不对`);
    const id = q.id === undefined || q.id === null || q.id === "" ? `q${i + 1}` : text(q.id, "问题 id", 40);
    if (ids.has(id)) throw new RelayError("bad_request", `问题 id 重复：${id}`);
    ids.add(id);
    const out: Question = { id, text: text(q.text, `第 ${i + 1} 个问题`, LIMITS.question) };
    if (q.options !== undefined && q.options !== null) {
      if (!Array.isArray(q.options) || q.options.length > LIMITS.options) throw new RelayError("bad_request", `第 ${i + 1} 个问题的选项不对（最多 ${LIMITS.options} 个）`);
      const options = q.options.map((o) => text(o, "选项", LIMITS.option));
      if (options.length) out.options = options;
    }
    return out;
  });
}

function checkAnswers(value: unknown, questions: Question[]): Answer[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RelayError("bad_request", "answers 必须是列表");
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const out: Answer[] = [];
  for (const a of value as Array<Partial<Answer>>) {
    if (!a || typeof a !== "object") throw new RelayError("bad_request", "回答格式不对");
    const q = byId.get(String(a.questionId));
    if (!q) throw new RelayError("bad_request", `没有这个问题：${String(a.questionId)}`);
    if (seen.has(q.id)) throw new RelayError("bad_request", `问题 ${q.id} 回答了两次`);
    seen.add(q.id);
    const answer: Answer = { questionId: q.id };
    const choice = text(a.choice, "选项", LIMITS.option, false);
    if (choice) {
      if (!q.options?.includes(choice)) throw new RelayError("bad_request", `问题 ${q.id} 没有选项「${choice}」`);
      answer.choice = choice;
    }
    const t = text(a.text, "回答", LIMITS.answer, false);
    if (t) answer.text = t;
    if (!answer.choice && !answer.text) continue;
    out.push(answer);
  }
  return out;
}

export class RelayStore {
  readonly db: DatabaseSync;

  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS members (
        name TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT '', password TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS keys (
        key_hash TEXT PRIMARY KEY, name TEXT NOT NULL REFERENCES members(name), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
        direct_key TEXT UNIQUE,
        req_from TEXT, req_to TEXT, req_status TEXT, req_verdict TEXT, req_seq INTEGER
      );
      CREATE TABLE IF NOT EXISTS thread_members (
        thread_id TEXT NOT NULL REFERENCES threads(id), name TEXT NOT NULL REFERENCES members(name),
        read_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread_id, name)
      );
      CREATE INDEX IF NOT EXISTS thread_members_name ON thread_members(name);
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES threads(id),
        author TEXT NOT NULL, via TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, extra TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, seq);
    `);
    // Added after the first deployment (2026-10-27).
    const columns = (this.db.prepare("PRAGMA table_info(thread_members)").all() as Row[]).map((r) => String(r.name));
    if (!columns.includes("archived")) this.db.exec("ALTER TABLE thread_members ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    this.migrateSessions();
    this.migrateTasks();
    this.migrateFiles();
  }

  /** Stage 2a (2026-10-27): a request is a session — who acts next, who handles the asking side, must it be replied. */
  private migrateSessions(): void {
    const columns = (this.db.prepare("PRAGMA table_info(threads)").all() as Row[]).map((r) => String(r.name));
    if (columns.includes("s_state")) return;
    this.db.exec(`
      ALTER TABLE threads ADD COLUMN s_state TEXT;
      ALTER TABLE threads ADD COLUMN s_waiting TEXT;
      ALTER TABLE threads ADD COLUMN s_handler TEXT;
      ALTER TABLE threads ADD COLUMN s_needs INTEGER;
      ALTER TABLE threads ADD COLUMN s_returned INTEGER;
      ALTER TABLE threads ADD COLUMN s_picked INTEGER;
    `);
    // Answered ones go back to whoever asked, to look at and mark done; who sent the request decides the handler.
    this.db.exec(`
      UPDATE threads SET
        s_state = CASE WHEN req_status = 'answered' THEN 'returned' ELSE 'open' END,
        s_waiting = CASE WHEN req_status = 'answered' THEN req_from ELSE req_to END,
        s_returned = CASE WHEN req_status = 'answered' THEN updated_at ELSE NULL END,
        s_needs = 1,
        s_handler = CASE WHEN (SELECT json_extract(m.via, '$.kind') FROM messages m WHERE m.seq = threads.req_seq) = 'ai' THEN 'ai' ELSE 'person' END
      WHERE kind = 'request';
    `);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = run();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- members

  /** A new member, logged in: the key is returned once and only its hash is kept. */
  register(nameValue: unknown, passwordValue: unknown, roleValue?: unknown): { name: string; role: string; key: string } {
    const name = checkName(nameValue);
    const password = checkPassword(passwordValue);
    const role = text(roleValue, "角色", LIMITS.role, false);
    if (this.db.prepare("SELECT 1 FROM members WHERE name = ?").get(name)) throw new RelayError("conflict", `名字「${name}」已经有人用了`);
    this.db.prepare("INSERT INTO members (name, role, password, created_at) VALUES (?, ?, ?, ?)").run(name, role, hashPassword(password), this.now());
    return { name, role, key: this.newKey(name) };
  }

  /** A new key for this device when the password matches. */
  login(nameValue: unknown, passwordValue: unknown): { name: string; role: string; key: string } {
    const name = typeof nameValue === "string" ? nameValue.trim() : "";
    const row = this.db.prepare("SELECT role, password FROM members WHERE name = ?").get(name) as Row | undefined;
    if (!row || typeof passwordValue !== "string" || !passwordMatches(passwordValue, String(row.password))) throw new RelayError("unauthorized", "名字或密码不对");
    return { name, role: String(row.role), key: this.newKey(name) };
  }

  logout(key: string): void {
    this.db.prepare("DELETE FROM keys WHERE key_hash = ?").run(hashKey(key));
  }

  /** Sets a password (the service machine's `amo-relay passwd`); the member's keys stop working. */
  setPassword(nameValue: unknown, passwordValue: unknown): void {
    const name = checkName(nameValue);
    this.requireMember(name);
    this.db.prepare("UPDATE members SET password = ? WHERE name = ?").run(hashPassword(checkPassword(passwordValue)), name);
    this.db.prepare("DELETE FROM keys WHERE name = ?").run(name);
  }

  private newKey(name: string): string {
    const key = randomBytes(24).toString("base64url");
    this.db.prepare("INSERT INTO keys (key_hash, name, created_at) VALUES (?, ?, ?)").run(hashKey(key), name, this.now());
    return key;
  }

  memberByKey(key: string): string | null {
    const row = this.db.prepare("SELECT name FROM keys WHERE key_hash = ?").get(hashKey(key)) as Row | undefined;
    return row ? String(row.name) : null;
  }

  setRole(name: string, roleValue: unknown): void {
    this.db.prepare("UPDATE members SET role = ? WHERE name = ?").run(text(roleValue, "角色", LIMITS.role, false), name);
  }

  members(): Array<{ name: string; role: string }> {
    return (this.db.prepare("SELECT name, role FROM members ORDER BY rowid").all() as Row[]).map((r) => ({ name: String(r.name), role: String(r.role) }));
  }

  private requireMember(name: string): void {
    if (!this.db.prepare("SELECT 1 FROM members WHERE name = ?").get(name)) throw new RelayError("not_found", `没有这个人：${name}`);
  }

  // ---- threads

  private threadRow(id: string): Row {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new RelayError("not_found", `没有这个对话：${id}`);
    return row;
  }

  private toThread(row: Row): Thread {
    const id = String(row.id);
    const members = (this.db.prepare("SELECT name FROM thread_members WHERE thread_id = ? ORDER BY rowid").all(id) as Row[]).map((r) => String(r.name));
    const thread: Thread = {
      id,
      kind: String(row.kind) as ThreadKind,
      title: String(row.title),
      members,
      createdBy: String(row.created_by),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastSeq: Number(row.last_seq),
    };
    if (thread.kind === "request") {
      thread.request = {
        from: String(row.req_from),
        to: String(row.req_to),
        status: row.req_status === "answered" ? "answered" : "open",
        verdict: row.req_verdict ? (String(row.req_verdict) as Verdict) : null,
        requestSeq: Number(row.req_seq),
        taskId: row.task_id == null ? null : String(row.task_id),
        byAi: (this.db.prepare("SELECT json_extract(via, '$.kind') AS k FROM messages WHERE seq = ?").get(Number(row.req_seq)) as Row | undefined)?.k === "ai",
        state: (row.s_state as SessionState | null) ?? "open",
        waitingOn: row.s_waiting == null ? null : String(row.s_waiting),
        handler: row.s_handler === "ai" ? "ai" : "person",
        needsReply: Number(row.s_needs ?? 1) === 1,
        returnedAt: row.s_returned == null ? null : Number(row.s_returned),
        pickedAt: row.s_picked == null ? null : Number(row.s_picked),
      };
    }
    return thread;
  }

  /** The thread, when `name` is in it. */
  thread(id: string, name: string): Thread {
    const thread = this.toThread(this.threadRow(id));
    if (!thread.members.includes(name)) throw new RelayError("forbidden", "你不在这个对话里");
    return thread;
  }

  threadMembers(threadId: string): string[] {
    return (this.db.prepare("SELECT name FROM thread_members WHERE thread_id = ? ORDER BY rowid").all(threadId) as Row[]).map((r) => String(r.name));
  }

  /** The direct chat between two people, made on first use. */
  direct(me: string, otherValue: unknown): Thread {
    const other = checkName(otherValue);
    if (other === me) throw new RelayError("bad_request", "不能和自己聊天");
    this.requireMember(other);
    const key = directKey(me, other);
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM threads WHERE direct_key = ?").get(key) as Row | undefined;
      if (row) return this.toThread(row);
      const id = newId("t");
      const at = this.now();
      this.db.prepare("INSERT INTO threads (id, kind, title, created_by, created_at, updated_at, direct_key) VALUES (?, 'direct', '', ?, ?, ?, ?)").run(id, me, at, at, key);
      for (const n of [me, other]) this.db.prepare("INSERT INTO thread_members (thread_id, name) VALUES (?, ?)").run(id, n);
      return this.toThread(this.threadRow(id));
    });
  }

  /** Another chat between the same two, about one thing. */
  createTopic(me: string, otherValue: unknown, titleValue: unknown): Thread {
    const other = checkName(otherValue);
    if (other === me) throw new RelayError("bad_request", "不能和自己聊天");
    this.requireMember(other);
    const title = text(titleValue, "话题", LIMITS.title);
    return this.tx(() => {
      const id = newId("t");
      const at = this.now();
      this.db.prepare("INSERT INTO threads (id, kind, title, created_by, created_at, updated_at) VALUES (?, 'topic', ?, ?, ?, ?)").run(id, title, me, at, at);
      for (const n of [me, other]) this.db.prepare("INSERT INTO thread_members (thread_id, name) VALUES (?, ?)").run(id, n);
      return this.toThread(this.threadRow(id));
    });
  }

  /** Archives a thread in `name`'s list, or brings it back. The direct chat stays. */
  setArchived(threadId: string, name: string, archived: boolean): void {
    const thread = this.thread(threadId, name);
    if (thread.kind === "direct" && archived) throw new RelayError("bad_request", "普通聊天不能归档");
    this.db.prepare("UPDATE thread_members SET archived = ? WHERE thread_id = ? AND name = ?").run(archived ? 1 : 0, threadId, name);
  }

  /** The threads `name` is in, latest first. */
  threadsFor(name: string): ThreadView[] {
    const rows = this.db
      .prepare("SELECT t.*, tm.read_seq AS read_seq, tm.archived AS archived FROM threads t JOIN thread_members tm ON tm.thread_id = t.id WHERE tm.name = ? ORDER BY t.updated_at DESC, t.last_seq DESC")
      .all(name) as Row[];
    return rows.map((row) => {
      const thread = this.toThread(row);
      const readSeq = Number(row.read_seq);
      const unread = Number((this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND seq > ? AND author <> ?").get(thread.id, readSeq, name) as Row).n);
      const lastRow = this.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1").get(thread.id) as Row | undefined;
      return { ...thread, readSeq, unread, last: lastRow ? this.toMessage(lastRow) : null, archived: Number(row.archived) === 1 };
    });
  }

  // ---- messages

  private toMessage(row: Row): Message {
    const extra = row.extra ? (JSON.parse(String(row.extra)) as Partial<Message>) : {};
    const m: Message = {
      id: String(row.id),
      threadId: String(row.thread_id),
      seq: Number(row.seq),
      author: String(row.author),
      via: JSON.parse(String(row.via)) as Via,
      kind: String(row.kind) as MessageKind,
      body: String(row.body),
      createdAt: Number(row.created_at),
    };
    if (extra.questions) m.questions = extra.questions;
    if (extra.answers) m.answers = extra.answers;
    if (extra.verdict) m.verdict = extra.verdict;
    if (extra.notes) m.notes = extra.notes;
    return m;
  }

  private insertMessage(threadId: string, author: string, via: Via, kind: MessageKind, body: string, extra: Partial<Message> | null): Message {
    const at = this.now();
    const id = newId("m");
    const res = this.db
      .prepare("INSERT INTO messages (id, thread_id, author, via, kind, body, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, threadId, author, JSON.stringify(via), kind, body, extra ? JSON.stringify(extra) : null, at);
    const seq = Number(res.lastInsertRowid);
    this.db.prepare("UPDATE threads SET last_seq = ?, updated_at = ? WHERE id = ?").run(seq, at, threadId);
    // The author has read what they wrote; a new message brings an archived thread back for everyone.
    this.db.prepare("UPDATE thread_members SET read_seq = ? WHERE thread_id = ? AND name = ?").run(seq, threadId, author);
    this.db.prepare("UPDATE thread_members SET archived = 0 WHERE thread_id = ?").run(threadId);
    return this.toMessage(this.db.prepare("SELECT * FROM messages WHERE seq = ?").get(seq) as Row);
  }

  /** A request from `from` to a person: its own thread, opened by the request message. */
  createRequest(from: string, req: NewRequest): { thread: Thread; message: Message } {
    const to = checkName(req?.to);
    // An AI speaks as its person, so this is the AI asking its own person: not what sessions are for (it would ask
    // them in its own chat). Said plainly, so an agent stops looking for a way round it.
    if (to === from) throw new RelayError("bad_request", `不能给自己发会话：你（AI）用的就是 ${from} 本人的身份。要问 ${from} 本人，直接在当前对话里问；要测试，请让对方用另一个账号（比如在浏览器里另注册一个）当收件人。`);
    this.requireMember(to);
    const title = text(req.title, "标题", LIMITS.title);
    const body = text(req.body, "正文", LIMITS.body);
    const questions = checkQuestions(req.questions);
    const via = checkVia(req.via);
    const needs = via.kind === "ai" || req.needsReply !== false;
    const taskId = req.taskId ? String(req.taskId) : null;
    if (taskId) this.taskRow(taskId);
    const attach = this.checkAttach(from, req.files);
    return this.tx(() => {
      const id = newId("t");
      const at = this.now();
      this.db
        .prepare(
          "INSERT INTO threads (id, kind, title, created_by, created_at, updated_at, req_from, req_to, req_status, s_state, s_waiting, s_handler, s_needs) VALUES (?, 'request', ?, ?, ?, ?, ?, ?, 'open', 'open', ?, ?, ?)",
        )
        .run(id, title, from, at, at, from, to, to, via.kind === "ai" ? "ai" : "person", needs ? 1 : 0);
      for (const n of [from, to]) this.db.prepare("INSERT INTO thread_members (thread_id, name) VALUES (?, ?)").run(id, n);
      const message = this.insertMessage(id, from, via, "request", body, questions.length ? { questions } : null);
      this.db.prepare("UPDATE threads SET req_seq = ?, task_id = ?, s_files = ? WHERE id = ?").run(message.seq, taskId, attach.length ? JSON.stringify(attach) : null, id);
      if (taskId) this.addTaskEvent(taskId, from, via, "session", `${via.kind === "ai" ? "的 AI " : ""}发起会话「${title}」→ ${to}`, { threadId: id, to });
      return { thread: this.toThread(this.threadRow(id)), message };
    });
  }

  /** A text or a reply in a thread `author` is in. Only the person asked replies to a request. */
  addMessage(threadId: string, author: string, msg: NewMessage): { thread: Thread; message: Message } {
    const thread = this.thread(threadId, author);
    const kind = msg?.kind ?? "text";
    const via = checkVia(msg?.via);
    if (kind === "text") {
      const body = text(msg.body, "内容", LIMITS.body);
      const pass = !!msg.pass && !!thread.request;
      if (pass) this.checkPass(thread, author, via);
      return this.tx(() => {
        const message = this.insertMessage(threadId, author, via, "text", body, null);
        if (pass) {
          const r = thread.request!;
          if (author === r.from) this.setSession(threadId, { s_state: "open", s_waiting: r.to });
          else this.setSession(threadId, { s_state: "returned", s_waiting: r.from, s_returned: this.now(), s_picked: null });
        }
        return { thread: this.toThread(this.threadRow(threadId)), message };
      });
    }
    if (kind !== "reply") throw new RelayError("bad_request", `不认识的消息类型：${String(kind)}`);
    const req = thread.request;
    if (!req) throw new RelayError("bad_request", "只有请求可以回复");
    if (author !== req.to) throw new RelayError("forbidden", `这条请求是发给 ${req.to} 的`);
    const requestRow = this.db.prepare("SELECT * FROM messages WHERE seq = ?").get(req.requestSeq) as Row;
    const questions = this.toMessage(requestRow).questions ?? [];
    const answers = checkAnswers(msg.answers, questions);
    const body = text(msg.body, "补充说明", LIMITS.body, false);
    const verdict = msg.verdict ?? undefined;
    if (verdict !== undefined && !VERDICTS.has(verdict)) throw new RelayError("bad_request", `不认识的结论：${String(verdict)}`);
    const notes = this.notesForReply(author, msg.notes);
    if (!answers.length && !body && !verdict && !notes.length) throw new RelayError("bad_request", "回复是空的");
    return this.tx(() => {
      const extra: Partial<Message> = {};
      if (answers.length) extra.answers = answers;
      if (verdict) extra.verdict = verdict;
      if (notes.length) extra.notes = notes;
      const message = this.insertMessage(threadId, author, via, "reply", body, Object.keys(extra).length ? extra : null);
      this.db.prepare("UPDATE threads SET req_status = 'answered', req_verdict = COALESCE(?, req_verdict) WHERE id = ?").run(verdict ?? null, threadId);
      this.recordDecision(thread, author, answers, verdict, questions);
      // A reply hands the session back to whoever asked.
      this.setSession(threadId, { s_state: "returned", s_waiting: req.from, s_returned: this.now(), s_picked: null });
      return { thread: this.toThread(this.threadRow(threadId)), message };
    });
  }

  private setSession(threadId: string, cols: Record<string, string | number | null>): void {
    const keys = Object.keys(cols);
    this.db.prepare(`UPDATE threads SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => cols[k]!), threadId);
  }

  /** Handing a session over is for whoever it waits on; an AI keeps out once its person took it over. */
  private checkPass(thread: Thread, author: string, via: Via): void {
    const r = thread.request!;
    if (r.state === "done") throw new RelayError("conflict", "这个会话已经完成了；要继续就先重新打开");
    if (r.waitingOn !== author) throw new RelayError("conflict", `这个会话现在在 ${r.waitingOn} 手里，等对方处理完再说`);
    if (via.kind === "ai" && author === r.from && r.handler === "person") throw new RelayError("conflict", `这个会话已由 ${r.from} 本人接手处理，AI 不要再操作；需要的话请他点「交还给 AI」`);
  }

  /**
   * 标记完成 / 重新打开 / 我来处理 (the asker takes it from their AI) / 交还给 AI / handoff (the AI gives it to its
   * person). Each writes an event message saying what happened.
   */
  sessionAction(threadId: string, actor: string, action: SessionAction, opts: { via?: Via; note?: unknown } = {}): { thread: Thread; message: Message } {
    const thread = this.thread(threadId, actor);
    const r = thread.request;
    if (!r) throw new RelayError("bad_request", "只有会话有这些操作");
    const via = checkVia(opts.via);
    const note = text(opts.note, "说明", LIMITS.body, false);
    const asker = actor === r.from;
    const aiOfAsker = asker && via.kind === "ai";
    if (aiOfAsker && r.handler === "person" && action !== "handoff") throw new RelayError("conflict", `这个会话已由 ${r.from} 本人接手处理，AI 不要再操作`);
    let cols: Record<string, string | number | null>;
    let what: string;
    switch (action) {
      case "done":
        if (!asker && r.needsReply) throw new RelayError("forbidden", "这个会话需要你回复，只有发起方能标记完成");
        if (r.state === "done") throw new RelayError("conflict", "已经完成了");
        cols = { s_state: "done", s_waiting: null };
        what = "标记完成";
        break;
      case "reopen":
        if (r.state !== "done") throw new RelayError("conflict", "会话还没完成");
        cols = { s_state: "open", s_waiting: r.to };
        what = "重新打开";
        break;
      case "handle":
        if (!asker || via.kind === "ai") throw new RelayError("forbidden", "只有发起人本人能从 AI 手里接手");
        cols = { s_handler: "person" };
        what = "从 AI 手里接手了这个会话";
        break;
      case "toAi":
        if (!asker || via.kind === "ai") throw new RelayError("forbidden", "只有发起人本人能交还给 AI");
        cols = { s_handler: "ai", s_picked: null };
        what = "把会话交还给 AI";
        break;
      case "handoff":
        if (!aiOfAsker) throw new RelayError("forbidden", "只有发起人的 AI 能把会话交给本人");
        cols = { s_handler: "person" };
        what = "AI 把会话交给本人处理";
        break;
      default:
        throw new RelayError("bad_request", `不认识的操作：${String(action)}`);
    }
    return this.tx(() => {
      this.setSession(threadId, cols);
      const message = this.insertMessage(threadId, actor, via, "event", note ? `${what}：${note}` : what, null);
      if (r.taskId && (action === "done" || action === "reopen")) this.addTaskEvent(r.taskId, actor, via, "session", `会话「${thread.title}」${what}`, { threadId });
      return { thread: this.toThread(this.threadRow(threadId)), message };
    });
  }

  /** The asking side's AI read a session that came back: it has it now (shown as 「AI 已取回」). True when that is new. */
  markPicked(threadId: string, name: string): boolean {
    const r = this.thread(threadId, name).request;
    if (!r || r.from !== name || r.state !== "returned" || r.handler !== "ai" || r.pickedAt !== null) return false;
    this.setSession(threadId, { s_picked: this.now() });
    return true;
  }

  /** Messages of a thread after a seq, oldest first. */
  messages(threadId: string, name: string, after = 0, limit = 200): Message[] {
    this.thread(threadId, name);
    const rows = this.db.prepare("SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(threadId, after, Math.max(1, Math.min(limit, 1000))) as Row[];
    return rows.map((r) => this.toMessage(r));
  }

  /** Read up to `seq` (never moves back); returns the read position. */
  markRead(threadId: string, name: string, seq?: number): number {
    const thread = this.thread(threadId, name);
    const to = Math.min(seq ?? thread.lastSeq, thread.lastSeq);
    this.db.prepare("UPDATE thread_members SET read_seq = MAX(read_seq, ?) WHERE thread_id = ? AND name = ?").run(to, threadId, name);
    return Number((this.db.prepare("SELECT read_seq FROM thread_members WHERE thread_id = ? AND name = ?").get(threadId, name) as Row).read_seq);
  }

  // ---- team tasks (stage 2b, plans/relay-tasks.md)

  /** Stage 2b (2026-10-27): tasks, their 记录, who has looked at a hand-over, the team's settings; sessions under a task. */
  private migrateTasks(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        holder TEXT NOT NULL, creator TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL,
        actor TEXT NOT NULL, via TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT
      );
      CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
      CREATE TABLE IF NOT EXISTS task_seen (task_id TEXT NOT NULL, name TEXT NOT NULL, event_id INTEGER NOT NULL, PRIMARY KEY (task_id, name));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const columns = (this.db.prepare("PRAGMA table_info(threads)").all() as Row[]).map((r) => String(r.name));
    if (!columns.includes("task_id")) this.db.exec("ALTER TABLE threads ADD COLUMN task_id TEXT; CREATE INDEX IF NOT EXISTS threads_task ON threads(task_id);");
  }

  private taskRow(id: string): Row {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new RelayError("not_found", `没有这个任务：${id}`);
    return row;
  }

  private toTask(row: Row): Task {
    const id = String(row.id);
    const sessions = (this.db.prepare("SELECT * FROM threads WHERE task_id = ? ORDER BY created_at").all(id) as Row[]).map((r) => {
      const t = this.toThread(r);
      const q = t.request!;
      return { id: t.id, title: t.title, from: q.from, to: q.to, byAi: q.byAi, state: q.state, waitingOn: q.waitingOn, updatedAt: t.updatedAt };
    });
    const last = this.db.prepare("SELECT * FROM task_events WHERE task_id = ? AND kind = 'transfer' ORDER BY id DESC LIMIT 1").get(id) as Row | undefined;
    const ev = last ? this.toTaskEvent(last) : null;
    return {
      id,
      title: String(row.title),
      description: String(row.description),
      status: String(row.status) as TaskStatus,
      holder: String(row.holder),
      creator: String(row.creator),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      archived: Number(row.archived) === 1,
      sessions,
      files: this.filesOf({ taskId: id }, ""),
      handoff: ev ? { eventId: ev.id, from: ev.data?.from ?? ev.actor, to: ev.data?.to ?? "", by: ev.actor, at: ev.at, status: ev.data?.status ?? (String(row.status) as TaskStatus), reason: ev.data?.reason ?? "" } : null,
    };
  }

  private toTaskEvent(row: Row): TaskEvent {
    const e: TaskEvent = { id: Number(row.id), taskId: String(row.task_id), at: Number(row.at), actor: String(row.actor), via: JSON.parse(String(row.via)) as Via, kind: String(row.kind) as TaskEventKind, text: String(row.text) };
    if (row.data) e.data = JSON.parse(String(row.data)) as TaskEvent["data"];
    return e;
  }

  private addTaskEvent(taskId: string, actor: string, via: Via, kind: TaskEventKind, text: string, data?: TaskEvent["data"]): TaskEvent {
    const at = this.now();
    const res = this.db.prepare("INSERT INTO task_events (task_id, at, actor, via, kind, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(taskId, at, actor, JSON.stringify(via), kind, text, data ? JSON.stringify(data) : null);
    this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, taskId);
    return this.toTaskEvent(this.db.prepare("SELECT * FROM task_events WHERE id = ?").get(Number(res.lastInsertRowid)) as Row);
  }

  task(id: string): Task {
    return this.toTask(this.taskRow(id));
  }

  /** As `name` sees it: whether the last hand-over was to them and they have not opened it since. */
  taskView(id: string, name: string): TaskView {
    const task = this.task(id);
    const seen = (this.db.prepare("SELECT event_id FROM task_seen WHERE task_id = ? AND name = ?").get(id, name) as Row | undefined)?.event_id;
    const h = task.handoff;
    return { ...task, unseen: !!h && h.to === name && h.by !== name && h.eventId > Number(seen ?? 0) };
  }

  /** Every task (the team sees them all), latest first. */
  tasksFor(name: string): TaskView[] {
    return (this.db.prepare("SELECT id FROM tasks ORDER BY updated_at DESC, rowid DESC").all() as Row[]).map((r) => this.taskView(String(r.id), name));
  }

  taskEvents(id: string): TaskEvent[] {
    this.taskRow(id);
    return (this.db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(id) as Row[]).map((r) => this.toTaskEvent(r));
  }

  markTaskSeen(id: string, name: string): void {
    const h = this.task(id).handoff;
    if (!h) return;
    this.db.prepare("INSERT INTO task_seen (task_id, name, event_id) VALUES (?, ?, ?) ON CONFLICT(task_id, name) DO UPDATE SET event_id = MAX(event_id, excluded.event_id)").run(id, name, h.eventId);
  }

  private checkStatus(value: unknown, fallback?: TaskStatus): TaskStatus {
    if (value === undefined || value === null || value === "") {
      if (fallback) return fallback;
      throw new RelayError("bad_request", "要选一个状态");
    }
    if (!(TASK_STATUSES as readonly string[]).includes(String(value))) throw new RelayError("bad_request", `状态只能是 ${TASK_STATUSES.join(" / ")}`);
    return value as TaskStatus;
  }

  createTask(actor: string, t: NewTask): Task {
    const title = text(t?.title, "标题", LIMITS.title);
    const description = text(t.description, "说明", LIMITS.body, false);
    const holder = t.holder ? checkName(t.holder) : actor;
    this.requireMember(holder);
    const status = this.checkStatus(t.status, "开发中");
    const via = checkVia(t.via);
    return this.tx(() => {
      const id = newId("k");
      const at = this.now();
      this.db.prepare("INSERT INTO tasks (id, title, description, status, holder, creator, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, title, description, status, holder, actor, at, at);
      this.addTaskEvent(id, actor, via, "created", `新建任务 · ${status}`);
      if (holder !== actor) this.addTaskEvent(id, actor, via, "transfer", `交给 ${holder} · ${status}`, { from: actor, to: holder, status, reason: "" });
      return this.task(id);
    });
  }

  updateTask(actor: string, id: string, patch: { title?: unknown; description?: unknown; status?: unknown; via?: Via }): Task {
    const row = this.taskRow(id);
    const via = checkVia(patch.via);
    return this.tx(() => {
      if (patch.title !== undefined || patch.description !== undefined) {
        const title = patch.title === undefined ? String(row.title) : text(patch.title, "标题", LIMITS.title);
        const description = patch.description === undefined ? String(row.description) : text(patch.description, "说明", LIMITS.body, false);
        this.db.prepare("UPDATE tasks SET title = ?, description = ? WHERE id = ?").run(title, description, id);
        this.addTaskEvent(id, actor, via, "edited", patch.title !== undefined && title !== String(row.title) ? `改了标题：${title}` : "改了说明");
      }
      if (patch.status !== undefined) {
        const status = this.checkStatus(patch.status);
        if (status !== String(row.status)) {
          this.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
          this.addTaskEvent(id, actor, via, "status", `状态改为 ${status}`, { status });
        }
      }
      return this.task(id);
    });
  }

  /** 流转: someone else (or me) has it now, in this state, for this reason. Anyone may; it is all in 记录. */
  transferTask(actor: string, id: string, t: { to?: unknown; status?: unknown; reason?: unknown; via?: Via }): Task {
    const row = this.taskRow(id);
    const to = checkName(t.to);
    this.requireMember(to);
    const status = this.checkStatus(t.status, String(row.status) as TaskStatus);
    const reason = text(t.reason, "原因", LIMITS.answer, false);
    const via = checkVia(t.via);
    return this.tx(() => {
      this.db.prepare("UPDATE tasks SET holder = ?, status = ? WHERE id = ?").run(to, status, id);
      const from = String(row.holder);
      const what = to === actor && from !== actor ? `接手任务 · ${status}` : `流转给 ${to} · ${status}`;
      this.addTaskEvent(id, actor, via, "transfer", reason ? `${what} · 原因：${reason}` : what, { from, to, status, reason });
      return this.task(id);
    });
  }

  archiveTask(actor: string, id: string, archived: boolean): Task {
    const row = this.taskRow(id);
    if (archived && !ARCHIVABLE.includes(String(row.status) as TaskStatus)) throw new RelayError("bad_request", `只有${ARCHIVABLE.join("或")}的任务能归档`);
    return this.tx(() => {
      this.db.prepare("UPDATE tasks SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
      this.addTaskEvent(id, actor, { kind: "person" }, archived ? "archived" : "unarchived", archived ? "归档" : "放回列表");
      return this.task(id);
    });
  }

  /** What a session's reply settled, as a line in its task's 记录. */
  private recordDecision(thread: Thread, author: string, answers: Answer[], verdict: Verdict | undefined, questions: Question[]): void {
    const taskId = thread.request?.taskId;
    if (!taskId || (!answers.length && !verdict)) return;
    const byId = new Map(questions.map((q) => [q.id, q.text]));
    const parts = answers.map((a) => `${byId.get(a.questionId) ?? a.questionId}：${[a.choice, a.text].filter(Boolean).join("，")}`);
    if (verdict) parts.push(`结论：${VERDICT_LABEL[verdict]}`);
    this.addTaskEvent(taskId, author, { kind: "person" }, "decision", `${parts.join("；")}（来自会话「${thread.title}」）`, { threadId: thread.id });
  }

  settings(): TeamSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Row[];
    const got = Object.fromEntries(rows.map((r) => [String(r.key), JSON.parse(String(r.value)) as unknown]));
    return { ...DEFAULT_SETTINGS, ...got } as TeamSettings;
  }

  saveSettings(patch: Partial<Record<keyof TeamSettings, unknown>>): TeamSettings {
    const out: Partial<TeamSettings> = {};
    if (patch.flow !== undefined) out.flow = text(patch.flow, "团队流程", LIMITS.body, false);
    if (patch.keywords !== undefined) {
      if (!Array.isArray(patch.keywords)) throw new RelayError("bad_request", "关键词必须是列表");
      out.keywords = patch.keywords.map((k) => text(k, "关键词", LIMITS.answer)).slice(0, 50);
    }
    for (const k of ["aiLateMinutes", "aiStuckMinutes"] as const) {
      if (patch[k] === undefined) continue;
      const n = Number(patch[k]);
      if (!Number.isFinite(n) || n < 1 || n > 24 * 60) throw new RelayError("bad_request", "提醒时间要在 1 到 1440 分钟之间");
      out[k] = Math.round(n);
    }
    for (const [k, v] of Object.entries(out)) this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, JSON.stringify(v));
    return this.settings();
  }

  // ---- files (stage 2c): a task's or a session's attachments, kept by version; the bytes are the service's (files/)

  private migrateFiles(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, task_id TEXT, thread_id TEXT, name TEXT NOT NULL, version INTEGER NOT NULL,
        size INTEGER NOT NULL, type TEXT NOT NULL, sha256 TEXT NOT NULL, by_name TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_task ON files(task_id, name, version);
      CREATE INDEX IF NOT EXISTS files_thread ON files(thread_id, name, version);
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), author TEXT NOT NULL, quote TEXT NOT NULL,
        prefix TEXT NOT NULL DEFAULT '', suffix TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_file ON notes(file_id);
    `);
    const columns = (this.db.prepare("PRAGMA table_info(threads)").all() as Row[]).map((r) => String(r.name));
    if (!columns.includes("s_files")) this.db.exec("ALTER TABLE threads ADD COLUMN s_files TEXT");
  }

  private toFile(row: Row): RelayFile {
    const scope = row.task_id != null ? "task_id = ?" : "thread_id = ?";
    const versions = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${scope} AND name = ?`).get(String(row.task_id ?? row.thread_id), String(row.name)) as Row).n);
    return {
      id: String(row.id),
      name: String(row.name),
      version: Number(row.version),
      versions,
      size: Number(row.size),
      type: String(row.type),
      sha256: String(row.sha256),
      by: String(row.by_name),
      at: Number(row.at),
      taskId: row.task_id == null ? null : String(row.task_id),
      threadId: row.thread_id == null ? null : String(row.thread_id),
      notes: this.noteCount(String(row.id)),
    };
  }

  /** A task's files are the team's; a session's, its two people's. */
  file(id: string, name: string): RelayFile {
    const row = this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new RelayError("not_found", `没有这个文件：${id}`);
    if (row.thread_id != null) this.thread(String(row.thread_id), name);
    return this.toFile(row);
  }

  /** A new file, or a new version of the one with the same name in the same place. */
  addFile(actor: string, f: { taskId?: string | null; threadId?: string | null; name: unknown; size: number; type?: string; sha256: string; id: string; via?: Via }): RelayFile {
    const name = text(f.name, "文件名", 200).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
    if (!f.taskId === !f.threadId) throw new RelayError("bad_request", "文件要放在一个任务或一个会话里");
    if (f.taskId) this.taskRow(f.taskId);
    if (f.threadId) this.thread(f.threadId, actor);
    const scope = f.taskId ? "task_id = ?" : "thread_id = ?";
    const key = (f.taskId ?? f.threadId)!;
    return this.tx(() => {
      const version = Number((this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM files WHERE ${scope} AND name = ?`).get(key, name) as Row).v) + 1;
      const at = this.now();
      this.db
        .prepare("INSERT INTO files (id, task_id, thread_id, name, version, size, type, sha256, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(f.id, f.taskId ?? null, f.threadId ?? null, name, version, f.size, f.type || "application/octet-stream", f.sha256, actor, at);
      if (f.taskId) this.addTaskEvent(f.taskId, actor, checkVia(f.via), "file", `上传 ${name} v${version}`, { fileId: f.id });
      if (f.threadId) this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(at, f.threadId);
      return this.file(f.id, actor);
    });
  }

  /** The latest version of each file in a task or a session (with what the session was given from its task). */
  filesOf(where: { taskId?: string; threadId?: string }, name: string): RelayFile[] {
    const latest = (scope: string, key: string) =>
      (this.db.prepare(`SELECT f.* FROM files f WHERE f.${scope} = ? AND f.version = (SELECT MAX(version) FROM files g WHERE g.${scope} = f.${scope} AND g.name = f.name) ORDER BY f.at`).all(key) as Row[]).map((r) => this.toFile(r));
    if (where.taskId) {
      this.taskRow(where.taskId);
      return latest("task_id", where.taskId);
    }
    const thread = this.thread(where.threadId!, name);
    const attached = this.attachedTo(thread.id).map((id) => this.file(id, name));
    return [...attached, ...latest("thread_id", thread.id)];
  }

  /** Every version of a file, newest first. */
  versionsOf(id: string, name: string): RelayFile[] {
    const f = this.file(id, name);
    const scope = f.taskId ? "task_id = ?" : "thread_id = ?";
    return (this.db.prepare(`SELECT * FROM files WHERE ${scope} AND name = ? ORDER BY version DESC`).all(f.taskId ?? f.threadId, f.name) as Row[]).map((r) => this.toFile(r));
  }

  private attachedTo(threadId: string): string[] {
    const raw = (this.db.prepare("SELECT s_files FROM threads WHERE id = ?").get(threadId) as Row | undefined)?.s_files;
    return raw ? (JSON.parse(String(raw)) as string[]) : [];
  }

  /** Files a new session takes along (its task's, or the asker's other sessions'). */
  private checkAttach(from: string, ids: unknown): string[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new RelayError("bad_request", "files 必须是文件 id 的列表");
    return [...new Set(ids.map((id) => this.file(String(id), from).id))].slice(0, 30);
  }

  private noteCount(fileId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE file_id = ?").get(fileId) as Row).n);
  }

  // ---- notes (stage 2d): a passage of a file and what someone thinks of it, anchored by its words and their context

  private toNote(row: Row): FileNote {
    return { id: String(row.id), fileId: String(row.file_id), version: Number(row.version), author: String(row.author), quote: String(row.quote), prefix: String(row.prefix), suffix: String(row.suffix), body: String(row.body), at: Number(row.at) };
  }

  /** The notes on every version of a file (oldest first; a client carries them to the version it shows). */
  notesOf(fileId: string, name: string): FileNote[] {
    const ids = this.versionsOf(fileId, name).map((f) => f.id);
    return (this.db.prepare(`SELECT n.*, f.version AS version FROM notes n JOIN files f ON f.id = n.file_id WHERE n.file_id IN (${ids.map(() => "?").join(",")}) ORDER BY n.at`).all(...ids) as Row[]).map((r) => this.toNote(r));
  }

  addNote(actor: string, fileId: string, n: { quote?: unknown; prefix?: unknown; suffix?: unknown; body?: unknown }): FileNote {
    this.file(fileId, actor);
    const quote = text(n.quote, "引文", LIMITS.answer);
    const body = text(n.body, "批注", LIMITS.answer);
    const prefix = text(n.prefix, "前文", 200, false);
    const suffix = text(n.suffix, "后文", 200, false);
    const id = newId("n");
    this.db.prepare("INSERT INTO notes (id, file_id, author, quote, prefix, suffix, body, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, fileId, actor, quote, prefix, suffix, body, this.now());
    return this.toNote(this.db.prepare("SELECT n.*, f.version AS version FROM notes n JOIN files f ON f.id = n.file_id WHERE n.id = ?").get(id) as Row);
  }

  /** Only its author removes a note. */
  deleteNote(actor: string, id: string): FileNote {
    const row = this.db.prepare("SELECT n.*, f.version AS version FROM notes n JOIN files f ON f.id = n.file_id WHERE n.id = ?").get(id) as Row | undefined;
    if (!row) throw new RelayError("not_found", "没有这条批注");
    this.file(String(row.file_id), actor);
    if (String(row.author) !== actor) throw new RelayError("forbidden", "只能删自己的批注");
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    return this.toNote(row);
  }

  /** Notes put into a reply: copied in, so the reply keeps them even if they are deleted later. */
  private notesForReply(actor: string, ids: unknown): ReplyNote[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new RelayError("bad_request", "notes 必须是批注 id 的列表");
    return ids.slice(0, 100).map((id) => {
      const row = this.db.prepare("SELECT n.*, f.version AS version, f.name AS fname FROM notes n JOIN files f ON f.id = n.file_id WHERE n.id = ?").get(String(id)) as Row | undefined;
      if (!row) throw new RelayError("not_found", `没有这条批注：${String(id)}`);
      this.file(String(row.file_id), actor);
      return { noteId: String(row.id), fileId: String(row.file_id), file: String(row.fname), version: Number(row.version), author: String(row.author), quote: String(row.quote), body: String(row.body) };
    });
  }
}
