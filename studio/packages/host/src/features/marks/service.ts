import { statSync } from "node:fs";
import { sep } from "node:path";
import { CHAT_MARK_QUOTE_MAX, FILE_MARK_NOTE_MAX, isCommon, type Bookmark, type ChatMark, type FileMark, type FileMarkPatch, type Id, type NewChatMark, type NewFileMark, type Workspace } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Windows paths compare without case. */
const CASELESS = process.platform === "win32";

/** A path in the form marks compare by: no trailing separator (except a root), lowercase on Windows. */
export function pathKey(path: string): string {
  const trimmed = path.length > 3 ? path.replace(/[\\/]+$/, "") : path;
  return CASELESS ? trimmed.toLowerCase() : trimmed;
}

/** Whether `path` is `folder` or lies inside it (both absolute and normalised). */
export function isInside(path: string, folder: string): boolean {
  const p = pathKey(path);
  const f = pathKey(folder);
  return p === f || p.startsWith(f.endsWith(sep) ? f : f + sep);
}

/**
 * The project a path belongs to: the registered project whose folder holds it (the innermost when folders nest).
 * The common space is not a project the person sees, so files there count as 其他 (null).
 */
export function projectOf(path: string, workspaces: readonly Workspace[]): Id | null {
  let best: Workspace | null = null;
  for (const ws of workspaces) {
    if (isCommon(ws) || !isInside(path, ws.path)) continue;
    if (!best || ws.path.length > best.path.length) best = ws;
  }
  return best?.id ?? null;
}

/**
 * File marks (stage 12, S12-D): files and folders the person marked with a note, grouped by the project their path
 * lies in. Every change publishes `marks.changed`, so the marks window and the composers' @ lists follow.
 * 书签 (2026-10-19): marks are kept under a topic (null: 未归专题), and passages of conversations are bookmarked too;
 * the same file (and range) or passage can be under two topics, once each.
 */
export class MarksFeature extends Feature {
  /** All marks, a project's, or (`"other"`) those outside every project; with whether each still exists. */
  list(workspace?: unknown): FileMark[] {
    this.rehome();
    let marks: FileMark[];
    if (workspace === undefined || workspace === null || workspace === "") marks = this.store.listFileMarks();
    else if (workspace === "other") marks = this.store.listFileMarks(null);
    else if (typeof workspace === "string") marks = this.store.listFileMarks(this.requireWorkspace(workspace).id);
    else throw new HostError("bad_request", "workspace must be a project id or other");
    return marks.map(withDisk);
  }

  create(input: Partial<NewFileMark> | undefined): { mark: FileMark; created: boolean } {
    const path = this.f.openIn.resolve(unquote(input?.path), input?.workspaceId);
    const disk = withDisk({ path } as FileMark);
    if (!disk.exists) throw new HostError("not_found", `文件不存在：${path}`);
    const { startLine, endLine } = this.range(input?.startLine ?? null, input?.endLine ?? null);
    if (disk.folder && startLine) throw new HostError("bad_request", "folders cannot have a line range");
    const topicId = this.topicFor(input?.topicId, input?.sessionId);
    const key = pathKey(path);
    const same = this.store.listFileMarks().find((m) => m.topicId === topicId && pathKey(m.path) === key && m.startLine === startLine && m.endLine === endLine);
    if (same) return { mark: withDisk(same), created: false };
    const workspaceId = projectOf(path, this.store.listWorkspaces());
    const at = new Date().toISOString();
    const mark: FileMark = {
      kind: "file",
      id: newId("mark"),
      topicId,
      path,
      workspaceId,
      startLine,
      endLine,
      note: this.note(input?.note ?? ""),
      // New bookmarks go on top of their topic.
      order: this.topOf(topicId),
      createdAt: at,
      updatedAt: at,
      exists: disk.exists,
      folder: disk.folder,
    };
    this.store.putFileMark(mark);
    this.changed(mark);
    return { mark, created: true };
  }

  update(id: Id, patch: Partial<FileMarkPatch> | undefined): FileMark {
    const current = this.require(id);
    const p = patch ?? {};
    let next: FileMark = { ...current };
    if (p.note !== undefined) next.note = this.note(p.note);
    if (p.topicId !== undefined) {
      const topicId = this.topicFor(p.topicId, undefined);
      if (topicId !== current.topicId) next = { ...next, topicId, order: this.topOf(topicId) };
    }
    if (p.startLine !== undefined || p.endLine !== undefined || p.topicId !== undefined) {
      const range = this.range(p.startLine === undefined ? current.startLine : p.startLine, p.endLine === undefined ? (p.startLine === null ? null : current.endLine) : p.endLine);
      if (range.startLine && withDisk(current).folder) throw new HostError("bad_request", "folders cannot have a line range");
      const key = pathKey(current.path);
      if (this.store.listFileMarks().some((m) => m.id !== id && m.topicId === next.topicId && pathKey(m.path) === key && m.startLine === range.startLine && m.endLine === range.endLine)) {
        throw new HostError("conflict", "this file and range is marked already");
      }
      next = { ...next, ...range };
    }
    if (p.order !== undefined) {
      if (typeof p.order !== "number" || !Number.isFinite(p.order)) throw new HostError("bad_request", "order must be a number");
      next.order = Math.round(p.order);
    }
    next.updatedAt = new Date().toISOString();
    this.store.putFileMark(next);
    this.changed(next);
    return withDisk(next);
  }

  remove(id: Id): void {
    const mark = this.require(id);
    this.store.deleteFileMark(id);
    this.changed(mark);
  }

  /** Every bookmark (files and passages), or one topic's (`"none"`: 未归专题); in their order. */
  bookmarks(topic?: unknown): Bookmark[] {
    if (topic !== undefined && topic !== null && topic !== "" && typeof topic !== "string") throw new HostError("bad_request", "topic must be a topic id or none");
    const wanted = topic === undefined || topic === null || topic === "" ? undefined : topic === "none" ? null : topic;
    const all: Bookmark[] = [...this.list(), ...this.store.listChatMarks().map((m) => this.withSession(m))];
    return all
      .filter((m) => wanted === undefined || m.topicId === wanted)
      .sort((a, b) => a.order - b.order || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  /** Bookmarks a passage of a reply (2026-10-19). */
  createChat(input: Partial<NewChatMark> | undefined): { mark: ChatMark; created: boolean } {
    const session = typeof input?.sessionId === "string" ? this.store.getSession(input.sessionId) : undefined;
    if (!session) throw new HostError("not_found", `session ${String(input?.sessionId)} not found`);
    const item = typeof input?.itemId === "string" ? this.store.getItem(input.itemId) : undefined;
    if (!item || item.sessionId !== session.id) throw new HostError("not_found", `reply ${String(input?.itemId)} is not in this session`);
    const start = input?.start;
    const end = input?.end;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      throw new HostError("bad_request", "start and end must give a range in the reply");
    }
    const quote = typeof input?.quote === "string" ? input.quote.trim() : "";
    if (!quote) throw new HostError("bad_request", "quote is required");
    if (quote.length > CHAT_MARK_QUOTE_MAX) throw new HostError("bad_request", `a bookmarked passage is limited to ${CHAT_MARK_QUOTE_MAX} characters`);
    const topicId = this.topicFor(input?.topicId, session.id);
    const same = this.store.listChatMarks().find((m) => m.topicId === topicId && m.itemId === item.id && m.start === start && m.end === end);
    if (same) return { mark: this.withSession(same), created: false };
    const at = new Date().toISOString();
    const around = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : "");
    const mark: ChatMark = {
      kind: "chat",
      id: newId("mark"),
      topicId,
      sessionId: session.id,
      itemId: item.id,
      start,
      end,
      quote,
      prefix: around(input?.prefix),
      suffix: around(input?.suffix),
      note: this.note(input?.note ?? ""),
      order: this.topOf(topicId),
      createdAt: at,
      updatedAt: at,
      taskId: null,
      workspaceId: null,
      sessionTitle: "",
      exists: true,
    };
    this.store.putChatMark(mark);
    this.changed(mark);
    return { mark: this.withSession(mark), created: true };
  }

  /** Note, topic or order of either kind; a line range only for a file. */
  updateBookmark(id: Id, patch: Partial<FileMarkPatch> | undefined): Bookmark {
    if (this.store.getFileMark(id)) return this.update(id, patch);
    const current = this.store.getChatMark(id);
    if (!current) throw new HostError("not_found", `bookmark ${id} not found`);
    const p = patch ?? {};
    if (p.startLine !== undefined || p.endLine !== undefined) throw new HostError("bad_request", "a passage has no line range");
    let next: ChatMark = { ...current };
    if (p.note !== undefined) next.note = this.note(p.note);
    if (p.topicId !== undefined) {
      const topicId = this.topicFor(p.topicId, undefined);
      if (this.store.listChatMarks().some((m) => m.id !== id && m.topicId === topicId && m.itemId === current.itemId && m.start === current.start && m.end === current.end)) {
        throw new HostError("conflict", "this passage is bookmarked under that topic already");
      }
      if (topicId !== current.topicId) next = { ...next, topicId, order: this.topOf(topicId) };
    }
    if (p.order !== undefined) {
      if (typeof p.order !== "number" || !Number.isFinite(p.order)) throw new HostError("bad_request", "order must be a number");
      next.order = Math.round(p.order);
    }
    next.updatedAt = new Date().toISOString();
    this.store.putChatMark(next);
    this.changed(next);
    return this.withSession(next);
  }

  removeBookmark(id: Id): void {
    if (this.store.getFileMark(id)) return this.remove(id);
    const mark = this.store.getChatMark(id);
    if (!mark) throw new HostError("not_found", `bookmark ${id} not found`);
    this.store.deleteChatMark(id);
    this.changed(mark);
  }

  private changed(mark: Bookmark): void {
    this.publish({ type: "marks.changed", markId: mark.id, workspaceId: mark.kind === "file" ? mark.workspaceId : null, topicId: mark.topicId });
  }

  /** The topic asked for (null: 未归专题), else the session's (its task's, or its own for a topic's session), else none. */
  private topicFor(explicit: unknown, sessionId: unknown): Id | null {
    if (explicit === null) return null;
    if (explicit !== undefined) {
      if (typeof explicit !== "string" || !this.store.getTopic(explicit)) throw new HostError("not_found", `topic ${String(explicit)} not found`);
      return explicit;
    }
    const session = typeof sessionId === "string" ? this.store.getSession(sessionId) : undefined;
    if (!session) return null;
    const task = session.taskId ? this.store.getTask(session.taskId) : undefined;
    return task?.topicId ?? session.topicId ?? null;
  }

  /** The order that puts a bookmark on top of its topic. */
  private topOf(topicId: Id | null): number {
    const orders = [...this.store.listFileMarks(), ...this.store.listChatMarks()].filter((m) => (m.topicId ?? null) === topicId).map((m) => m.order);
    return orders.length ? Math.min(...orders) - 1 : 0;
  }

  /** A passage with where its session is now. */
  private withSession(mark: ChatMark): ChatMark {
    const session = this.store.getSession(mark.sessionId);
    const item = session ? this.store.getItem(mark.itemId) : undefined;
    return { ...mark, taskId: session?.taskId ?? null, workspaceId: session?.workspaceId ?? null, sessionTitle: session?.title ?? "", exists: !!item };
  }

  /** Marks of 其他 whose path a project added since now holds move into it. */
  private rehome(): void {
    const workspaces = this.store.listWorkspaces();
    for (const m of this.store.listFileMarks(null)) {
      const ws = projectOf(m.path, workspaces);
      if (ws) this.store.putFileMark({ ...m, workspaceId: ws });
    }
  }

  private require(id: Id): FileMark {
    const m = this.store.getFileMark(id);
    if (!m) throw new HostError("not_found", `file mark ${id} not found`);
    return m;
  }

  private note(v: unknown): string {
    if (typeof v !== "string") throw new HostError("bad_request", "note must be text");
    const note = v.trim();
    if (note.length > FILE_MARK_NOTE_MAX) throw new HostError("bad_request", `note is limited to ${FILE_MARK_NOTE_MAX} characters`);
    return note;
  }

  /** A line range: none, one line (`endLine` null or equal), or start ≤ end. */
  private range(start: unknown, end: unknown): { startLine: number | null; endLine: number | null } {
    const line = (v: unknown, name: string) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new HostError("bad_request", `${name} must be a line number`);
      return v;
    };
    const s = line(start, "startLine");
    const e = line(end, "endLine");
    if (!s) {
      if (e) throw new HostError("bad_request", "endLine needs startLine");
      return { startLine: null, endLine: null };
    }
    if (e !== null && e < s) throw new HostError("bad_request", "endLine is before startLine");
    return { startLine: s, endLine: e === s ? null : e };
  }
}

/** Pasted paths ("Copy as path" in Explorer quotes them). */
function unquote(v: unknown): unknown {
  return typeof v === "string" ? v.trim().replace(/^"(.*)"$/, "$1") : v;
}

function withDisk(mark: FileMark): FileMark {
  try {
    const info = statSync(mark.path);
    return { ...mark, exists: true, folder: info.isDirectory() };
  } catch {
    return { ...mark, exists: false, folder: !!mark.folder };
  }
}
