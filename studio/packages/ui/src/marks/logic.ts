import { FILE_MARK_MIME, lineSuffix, type Bookmark, type ChatMark, type FileMark, type FileMarkDrag, type Topic } from "@amo-studio/protocol";

// Pure logic of the marks window (文件标记, S12-D; 书签 since 2026-10-19): its address, grouping by topic and search, and
// what a dragged bookmark carries.

export interface MarksTarget {
  /** The topic shown first, where new bookmarks go ("none": 未归专题). */
  topicId?: string;
  /** The project "+ 文件" picks from first, and the one 「当前项目」 shows. */
  workspaceId?: string;
  /** The task it was opened from: its 显示范围 is remembered for it (2026-10-22). */
  taskId?: string;
  /** The mark to scroll to and flash (stage 13: the 标记 button of a file already marked). */
  markId?: string;
  /** With `markId`: put the cursor in its note (a mark just made from the 标记 button). */
  edit?: boolean;
  /** Changes on every open, so opening the same mark twice still moves the window. */
  nonce?: string;
}

/** The window's address: `#marks?topic=…&workspace=…&mark=…&edit=1&n=…`. */
export function marksHash(t: MarksTarget = {}): string {
  const q = new URLSearchParams();
  if (t.topicId) q.set("topic", t.topicId);
  if (t.workspaceId) q.set("workspace", t.workspaceId);
  if (t.taskId) q.set("task", t.taskId);
  if (t.markId) q.set("mark", t.markId);
  if (t.markId && t.edit) q.set("edit", "1");
  if (t.nonce) q.set("n", t.nonce);
  const s = q.toString();
  return s ? `#marks?${s}` : "#marks";
}

export function parseMarksHash(hash: string): MarksTarget | null {
  if (!hash.startsWith("#marks")) return null;
  const q = new URLSearchParams(hash.slice("#marks".length).replace(/^\?/, ""));
  const topicId = q.get("topic");
  const workspaceId = q.get("workspace");
  const taskId = q.get("task");
  const markId = q.get("mark");
  const nonce = q.get("n");
  return {
    ...(topicId ? { topicId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(markId ? { markId, ...(q.get("edit") === "1" ? { edit: true } : {}) } : {}),
    ...(nonce ? { nonce } : {}),
  };
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * The mark for a file shown elsewhere (quick look, Review), or null. `path` is absolute, or relative to the project
 * `workspaceId` names (marks are always absolute, so a relative path matches the end of a mark in that project). A
 * mark at `line` wins over one for the whole file, which wins over another range.
 */
export function findMark(marks: readonly FileMark[], file: { path: string; workspaceId?: string | null }, line?: number | null): FileMark | null {
  const want = norm(file.path).replace(/^\.\//, "");
  const absolute = /^[a-z]:\//.test(want) || want.startsWith("/");
  const same = marks.filter((m) => {
    const have = norm(m.path);
    if (absolute) return have === want;
    return (!file.workspaceId || m.workspaceId === file.workspaceId) && have.endsWith(`/${want}`);
  });
  return same.find((m) => line && m.startLine === line) ?? same.find((m) => m.startLine === null) ?? same[0] ?? null;
}

export interface BookmarkGroup {
  /** null: 未归专题. */
  topicId: string | null;
  name: string;
  archived: boolean;
  marks: Bookmark[];
}

export const NO_TOPIC = "未归专题";

/**
 * Bookmarks by topic: the current one first (shown even when it has none, so it can be added to; "none" is
 * 未归专题), then the other topics with bookmarks in the order Studio lists them, then 未归专题. A bookmark of a topic
 * that is gone reads as 未归专题. Within a group, the Host's order.
 */
export function groupBookmarks(marks: readonly Bookmark[], topics: readonly Topic[], current?: string | null): BookmarkGroup[] {
  const known = new Set(topics.map((t) => t.id));
  const topicOf = (m: Bookmark) => (m.topicId && known.has(m.topicId) ? m.topicId : null);
  const loose: BookmarkGroup = { topicId: null, name: NO_TOPIC, archived: false, marks: marks.filter((m) => topicOf(m) === null) };
  const first = current === "none" ? loose : topics.find((t) => t.id === current);
  const groups: BookmarkGroup[] = [];
  if (first === loose) groups.push(loose);
  for (const t of first && first !== loose ? [first as Topic, ...topics.filter((x) => x !== first)] : topics) {
    const mine = marks.filter((m) => topicOf(m) === t.id);
    if (mine.length || t === first) groups.push({ topicId: t.id, name: t.title, archived: !!t.archivedAt, marks: mine });
  }
  if (first !== loose && loose.marks.length) groups.push(loose);
  return groups;
}

/** Search over a file's path and note, or a passage's text, session and note: every word must appear (any case). */
export function matchMark(mark: Bookmark, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = (mark.kind === "chat" ? `${mark.quote}\n${mark.sessionTitle}\n${mark.note}` : `${mark.path}\n${mark.note}`).toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** 显示范围 (2026-10-22): the topic in front, the project in front, or everything. */
export type MarksScope = "topic" | "project" | "all";

/** Which scopes the window can offer: 当前专题 needs a topic in front ("none" counts), 当前项目 a project. */
export function scopesFor(target: MarksTarget): Record<MarksScope, boolean> {
  return { topic: !!target.topicId, project: !!target.workspaceId, all: true };
}

/** Where a scope choice is remembered: per task, else per topic or project it was opened at, else one for the rest. */
export function scopeKey(target: MarksTarget): string {
  if (target.taskId) return `task:${target.taskId}`;
  if (target.topicId) return `topic:${target.topicId}`;
  if (target.workspaceId) return `workspace:${target.workspaceId}`;
  return "all";
}

/**
 * The groups a scope shows: 当前专题 only the topic in front (`current`, null for 未归专题); 当前项目 the bookmarks in
 * the project in front, by topic, without empty groups; 全部 everything, the topic in front first.
 */
export function scopedGroups(marks: readonly Bookmark[], topics: readonly Topic[], target: MarksTarget, current: string | null, scope: MarksScope): BookmarkGroup[] {
  const first = target.topicId ? (current ?? "none") : undefined;
  if (scope === "project" && target.workspaceId) {
    return groupBookmarks(
      marks.filter((m) => m.workspaceId === target.workspaceId),
      topics,
      first,
    ).filter((g) => g.marks.length);
  }
  const groups = groupBookmarks(marks, topics, first);
  return scope === "topic" && target.topicId ? groups.filter((g) => g.topicId === current) : groups;
}

export function filterGroups(groups: readonly BookmarkGroup[], query: string): BookmarkGroup[] {
  if (!query.trim()) return [...groups];
  return groups.map((g) => ({ ...g, marks: g.marks.filter((m) => matchMark(m, query)) })).filter((g) => g.marks.length);
}

/** The path relative to its project's folder for display ("" when outside it). */
export function relativeTo(path: string, folder: string): string {
  if (!folder) return "";
  const f = folder.replace(/[\\/]+$/, "");
  if (path.length <= f.length || path.slice(0, f.length).toLowerCase() !== f.toLowerCase() || !"\\/".includes(path[f.length]!)) return "";
  return path.slice(f.length + 1);
}

/**
 * What a dragged passage carries: plain text, so a composer takes it where it is dropped: the passage quoted, where
 * it came from, and the note.
 */
export function chatDragText(mark: ChatMark, from: string): string {
  const quoted = mark.quote.split("\n").map((l) => `> ${l}`).join("\n");
  return `${quoted}\n\n（${from}）${mark.note ? `\n${mark.note}` : ""}\n`;
}

/** What a dragged mark carries: the mark as JSON under FILE_MARK_MIME, and the path (with its lines) as plain text. */
export function markDragData(mark: FileMark): Record<string, string> {
  const drag: FileMarkDrag = { id: mark.id, path: mark.path, note: mark.note, startLine: mark.startLine, endLine: mark.endLine };
  return { [FILE_MARK_MIME]: JSON.stringify(drag), "text/plain": `${mark.path}${lineSuffix(mark.startLine, mark.endLine)}` };
}

/**
 * Paths in pasted text: one per line, quotes from Explorer's "复制文件地址" removed, and only absolute ones (a drive,
 * a UNC share, or "/"); anything else is not a path to mark.
 */
export function pastedPaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^"(.*)"$/, "$1").trim())
    .filter((l) => /^([a-zA-Z]:[\\/]|\\\\[^\\]|\/)/.test(l));
}

/** "第 12–30 行" style range typed in a field: "12", "12-30", "12–30"; null for an empty field, undefined when invalid. */
export function parseRange(text: string): { startLine: number | null; endLine: number | null } | undefined {
  const t = text.trim();
  if (!t) return { startLine: null, endLine: null };
  const m = /^(\d+)\s*(?:[-–~～]\s*(\d+))?$/.exec(t);
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : null;
  if (start < 1 || (end !== null && end < start)) return undefined;
  return { startLine: start, endLine: end === start ? null : end };
}

export const rangeText = (m: Pick<FileMark, "startLine" | "endLine">) => lineSuffix(m.startLine, m.endLine).slice(1);
