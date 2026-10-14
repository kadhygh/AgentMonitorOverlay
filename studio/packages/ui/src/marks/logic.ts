import { FILE_MARK_MIME, isCommon, lineSuffix, type FileMark, type FileMarkDrag, type Workspace } from "@amo-studio/protocol";

// Pure logic of the marks window (文件标记, S12-D): its address, grouping and search, and what a dragged mark carries.

export interface MarksTarget {
  /** The project shown first (and the one "+ 标记文件" picks from); none opens on all projects. */
  workspaceId?: string;
  /** The mark to scroll to and flash (stage 13: the 标记 button of a file already marked). */
  markId?: string;
  /** With `markId`: put the cursor in its note (a mark just made from the 标记 button). */
  edit?: boolean;
  /** Changes on every open, so opening the same mark twice still moves the window. */
  nonce?: string;
}

/** The window's address: `#marks?workspace=…&mark=…&edit=1&n=…`. */
export function marksHash(t: MarksTarget = {}): string {
  const q = new URLSearchParams();
  if (t.workspaceId) q.set("workspace", t.workspaceId);
  if (t.markId) q.set("mark", t.markId);
  if (t.markId && t.edit) q.set("edit", "1");
  if (t.nonce) q.set("n", t.nonce);
  const s = q.toString();
  return s ? `#marks?${s}` : "#marks";
}

export function parseMarksHash(hash: string): MarksTarget | null {
  if (!hash.startsWith("#marks")) return null;
  const q = new URLSearchParams(hash.slice("#marks".length).replace(/^\?/, ""));
  const workspaceId = q.get("workspace");
  const markId = q.get("mark");
  const nonce = q.get("n");
  return {
    ...(workspaceId ? { workspaceId } : {}),
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

export interface MarkGroup {
  /** null: 其他 (outside every project). */
  workspaceId: string | null;
  name: string;
  /** The project's folder, "" for 其他. */
  path: string;
  marks: FileMark[];
}

/**
 * Marks by project: the current project first (shown even when it has none, so it can be added to), then the other
 * projects with marks in the order Studio lists them, then 其他. Within a group, the Host's order.
 */
export function groupMarks(marks: readonly FileMark[], workspaces: readonly Workspace[], currentId: string | null): MarkGroup[] {
  const projects = workspaces.filter((w) => !isCommon(w));
  const groups: MarkGroup[] = [];
  const current = projects.find((w) => w.id === currentId);
  const ordered = current ? [current, ...projects.filter((w) => w !== current)] : projects;
  for (const ws of ordered) {
    const mine = marks.filter((m) => m.workspaceId === ws.id);
    if (mine.length || ws === current) groups.push({ workspaceId: ws.id, name: ws.name, path: ws.path, marks: mine });
  }
  // Marks of a project that is gone (not listed yet) read as 其他 rather than vanish.
  const known = new Set(projects.map((w) => w.id));
  const other = marks.filter((m) => !m.workspaceId || !known.has(m.workspaceId));
  if (other.length) groups.push({ workspaceId: null, name: "其他", path: "", marks: other });
  return groups;
}

/** Search over path and note: every space-separated word must appear (case does not matter). */
export function matchMark(mark: FileMark, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${mark.path}\n${mark.note}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function filterGroups(groups: readonly MarkGroup[], query: string): MarkGroup[] {
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
